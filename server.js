import express from "express";
import pkg from "pg";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "25mb" })); // raise limit: OCR requests carry page images

// ---------- Database ----------
if (!process.env.DATABASE_URL) {
  console.warn(
    "⚠️  DATABASE_URL lama helin. Ku dar Postgres plugin Railway-ga oo ku xidh variable-ka DATABASE_URL adeeggan."
  );
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.warn(
    "⚠️  ANTHROPIC_API_KEY lama helin. Ku dar Variables-ka Railway si samaynta imtixaanka iyo OCR-ku ay u shaqeeyaan."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS exams (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL DEFAULT '',
    class_name TEXT NOT NULL DEFAULT '',
    total_marks INT NOT NULL DEFAULT 0,
    duration TEXT DEFAULT '',
    sources TEXT DEFAULT '',
    data JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  // OCR cache: boggag kasta (buug + bog) mar keliya ayaa la akhriyaa, kadibna waa la keydiyaa.
  await pool.query(`CREATE TABLE IF NOT EXISTS ocr_pages (
    doc_hash TEXT NOT NULL,
    page INT NOT NULL,
    doc_name TEXT NOT NULL DEFAULT '',
    text TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (doc_hash, page)
  )`);
  console.log("✅ Database ready");
}
initDb().catch((e) => console.error("DB init error:", e));

// ---------- Admin auth (same pattern as the evaluation app) ----------
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD lama dejin server-ka." });
  }
  const pw = req.header("x-admin-password");
  if (pw !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD lama dejin server-ka." });
  }
  if (password === process.env.ADMIN_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// ---------- Claude API helper ----------
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

async function callClaude({ system, messages, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY lama dejin server-ka.");
    err.code = "no_api_key";
    throw err;
  }
  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens || 4096, messages };
  if (system) body.system = system;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error((json && json.error && json.error.message) || "Claude API error");
    err.code = "upstream_error";
    throw err;
  }
  const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const u = json.usage || {};
  console.log(`[claude] stop=${json.stop_reason} in=${u.input_tokens} out=${u.output_tokens}`);
  return { text, stop: json.stop_reason };
}

function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.search(/[{[]/);
  const end = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (start === -1 || end === -1) throw new Error("no JSON found in reply");
  return JSON.parse(t.slice(start, end + 1));
}

// Waxay u dirtaa Claude qayb yar; haddii JSON-ku xumaado mar keliya ayay dib u tijaabisaa.
async function askJson(prompt, maxTokens, label) {
  let last = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await callClaude({ messages: [{ role: "user", content: prompt }], maxTokens });
    try {
      return extractJson(r.text);
    } catch (e) {
      last = r.stop;
      console.error(`[${label}] attempt ${attempt + 1} failed (stop=${r.stop}): ${e.message}`);
    }
  }
  throw new Error(`Qayb ka mid ah imtixaanka (${label}) ma dhammaystirmin (${last}). Isku day mar kale.`);
}

function distribute(total, count) {
  if (count <= 0) return [];
  const base = Math.floor(total / count);
  const extra = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i >= count - extra ? 1 : 0));
}

function splitCounts(n, per) {
  const batches = Math.ceil(n / per);
  return distribute(n, batches);
}

function splitText(text, n) {
  if (n <= 1) return [text];
  const paras = text.split(/\n\s*\n/);
  const target = Math.ceil(text.length / n);
  const out = [];
  let cur = "";
  for (const p of paras) {
    if (cur.length >= target && out.length < n - 1) { out.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + p;
  }
  if (cur) out.push(cur);
  while (out.length < n) out.push(out[out.length - 1] || text);
  return out;
}

const MAX_SOURCE_CHARS = 90000; // ~ xadka qoraalka la dirayo (si lacagta loo ilaaliyo)

// ---------- Luqadda: la-socoshada luqadda casharka ----------
const LANG_NAMES = { so: "Somali (Af-Soomaali)", en: "English", ar: "Arabic (العربية)" };

const LABELS = {
  so: {
    mcqName: "QAYBTA 1-aad: Ikhtiyaar Sax ah",
    mcqInstr: "Dooro jawaabta saxda ah ee su'aal kasta. Su'aal kastaa waxay leedahay dhibcaha ka horreeya.",
    structName: "QAYBTA 2-aad: Su'aalo Qaab-dhismeed ah",
    structInstr: "Ka jawaab dhammaan su'aalaha. Si buuxda u qor jawaabahaaga.",
    defSubject: "Maadada", defClass: "Fasalka", defDuration: "2 saac", defSchool: "Imtixaanka Maadada",
    titleTemplate: "Imtixaanka {subject} — {class}",
    totalMarks: "Wadarta Dhibcaha", time: "Waqtiga", studentName: "Magaca Ardayga", klass: "Fasalka", date: "Taariikhda",
    source: "Isha", marksWord: "dhibcood", answerKey: "🔑 Furaha Jawaabaha (macalinka kaliya)",
    pageWord: "Bogga", unnamed: "Cashar aan magac lahayn", lessonWord: "Cashar",
    bloom: { Remember: "Xusuusnaan", Understand: "Fahamka", Apply: "Dabaqid", Analyze: "Falanqayn", Evaluate: "Qiimeyn", Create: "Abuur" },
  },
  en: {
    mcqName: "SECTION A: Multiple Choice",
    mcqInstr: "Choose the correct answer for each question. The marks for each question are shown in brackets.",
    structName: "SECTION B: Structured Questions",
    structInstr: "Answer all questions. Write your answers in full.",
    defSubject: "Subject", defClass: "Class", defDuration: "2 hours", defSchool: "Subject Examination",
    titleTemplate: "{subject} Examination — {class}",
    totalMarks: "Total Marks", time: "Time", studentName: "Student's Name", klass: "Class", date: "Date",
    source: "Source", marksWord: "marks", answerKey: "🔑 Answer Key (teacher only)",
    pageWord: "Page", unnamed: "Untitled lesson", lessonWord: "Lesson",
    bloom: { Remember: "Remember", Understand: "Understand", Apply: "Apply", Analyze: "Analyze", Evaluate: "Evaluate", Create: "Create" },
  },
  ar: {
    mcqName: "القسم الأول: الاختيار من متعدد",
    mcqInstr: "اختر الإجابة الصحيحة لكل سؤال. درجة كل سؤال مكتوبة بين قوسين.",
    structName: "القسم الثاني: الأسئلة المقالية",
    structInstr: "أجب عن جميع الأسئلة. اكتب إجاباتك كاملة.",
    defSubject: "المادة", defClass: "الصف", defDuration: "ساعتان", defSchool: "امتحان المادة",
    titleTemplate: "امتحان {subject} — {class}",
    totalMarks: "المجموع الكلي للدرجات", time: "الزمن", studentName: "اسم الطالب", klass: "الصف", date: "التاريخ",
    source: "المصدر", marksWord: "درجة", answerKey: "🔑 مفتاح الإجابات (للمعلم فقط)",
    pageWord: "صفحة", unnamed: "درس بدون عنوان", lessonWord: "درس",
    bloom: { Remember: "التذكر", Understand: "الفهم", Apply: "التطبيق", Analyze: "التحليل", Evaluate: "التقييم", Create: "الإبداع" },
  },
};

const STOP_EN = new Set("the and of is are that with for this which by as from be an it can has have was were or not its their these those when where what how because into also than then there each such".split(" "));
const STOP_SO = new Set("waa oo iyo ee ka ku uu ay waxa waxaa waxay ah sida kala kuwa loo aad ugu jiray leh ayaa ayuu lagu markii haddii laakiin sidoo kale dhammaan kasta isku kuwaas halka maxay yihiin yahay oo ayaa soo sii lahaa karo ama sababtoo".split(" "));

// Waxay u eegtaa qoraalka: Carabi (far), Soomaali, ama Ingiriisi.
function detectLang(text) {
  const sample = String(text || "").slice(0, 30000);
  const letters = (sample.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  const arabic = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  if (letters && arabic / letters > 0.4) return "ar";
  const words = sample.toLowerCase().match(/[a-z']+/g) || [];
  let en = 0, so = 0;
  for (const w of words) {
    if (STOP_EN.has(w)) en++;
    if (STOP_SO.has(w)) so++;
  }
  if (!en && !so) return "so";
  return so > en ? "so" : "en";
}

// Tirada su'aalaha otomaatig: waxay ku salaysan tahay dherer qoraalka iyo wadarta dhibcaha.
function autoCounts({ chars, total, givenM, givenS, needM, needS }) {
  const N = Math.min(36, Math.max(8, Math.round(chars / 1800)));
  const autoM = Math.round(N * 0.6);
  const autoS = N - autoM;
  let m = needM ? autoM : givenM;
  let s = needS ? autoS : givenS;
  if (needM) {
    if (s === 0) m = Math.min(60, Math.max(N, Math.min(total, 20)));
    else m = Math.min(m, Math.max(1, Math.round(total * 0.4))); // MCQ kasta ugu yaraan 1 dhibic
  }
  if (needS) {
    s = Math.max(s, Math.ceil(Math.max(0, total - m) / 15)); // qaab-dhismeed kasta ≤ ~15 dhibcood
    s = Math.min(30, s);
  }
  return { m: Math.min(60, m), s: Math.min(30, s) };
}

function batchPrompt({ kind, n, marksList, textSlice, subject, klass, diagrams, diagramTopics, part, parts, langName, forced }) {
  const bloom = kind === "mcq"
    ? "Remember, Understand, Apply (lower and middle levels)"
    : "Apply, Analyze, Evaluate, Create (higher levels); mix short and long questions";
  const diag = diagrams > 0
    ? `EXACTLY ${diagrams} question(s) must include an "svg" diagram (simple, clear SVG: <svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg">...</svg>, lines and short labels written in ${langName}; national-exam style: graph, diagram, geometry, circuit, etc.). All other questions have "svg": null.${diagramTopics ? " Preferred diagram topics: " + diagramTopics + "." : ""}`
    : `All "svg" values must be null.`;
  const langRule = forced
    ? `LANGUAGE (critical): Write EVERYTHING (question text, options, answers, diagram labels) in ${langName}, even if the lesson text is in another language.`
    : `LANGUAGE (critical): The lesson text below is written in ${langName}. Write EVERYTHING (question text, options, answers, diagram labels) in ${langName}, exactly the language of the lesson. Do NOT translate into any other language. Keep technical terms as they appear in the lesson.`;
  const shape = kind === "mcq"
    ? `{"questions":[{"text":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"B) ...","bloom":"Remember","svg":null}]}`
    : `{"questions":[{"text":"... (add parts a), b), c) when appropriate)","answer":"Short model answer + marking points","bloom":"Analyze","svg":null}]}`;
  const marksLine = kind === "struct" ? `\nMarks per question (in order): ${marksList.join(", ")}. Questions with more marks must be longer / more demanding.` : "";
  return `You are an expert exam writer for national-standard school exams in Somalia (Ministry of Education / National exam style). Write ${n} ${kind === "mcq" ? "multiple-choice questions (4 options A-D, exactly one correct answer, plausible distractors)" : "structured questions"} about ${subject} (${klass}).
Bloom's levels: ${bloom}.${marksLine}
${langRule}
Every question must be based ONLY on the lesson text below and must not repeat each other. The text is part ${part}/${parts} of the lessons; make the questions cover this part well.
${diag}

LESSON TEXT:
"""
${textSlice}
"""

Return ONLY JSON (no commentary, no code fences). The number of questions must be ${n}. The "bloom" field must always be one of these English keys: Remember, Understand, Apply, Analyze, Evaluate, Create (it is translated later). Format:
${shape}`;
}

// ---------- Generate an exam from pasted/extracted lesson text ----------
app.post("/api/generate-exam", requireAdmin, async (req, res) => {
  try {
    const {
      subject = "",
      klass = "",
      mcqN = null,
      structN = null,
      totalMarks = 100,
      duration = "",
      school = "",
      diagramCount = 0,
      diagramTopics = "",
      lang = "auto",
      lessons = [],
    } = req.body || {};

    const isBlank = (v) => v === null || v === undefined || String(v).trim() === "" || isNaN(parseInt(v, 10));
    const needM = isBlank(mcqN);
    const needS = isBlank(structN);
    const givenM = needM ? 0 : Math.max(0, Math.min(60, parseInt(mcqN, 10)));
    const givenS = needS ? 0 : Math.max(0, Math.min(30, parseInt(structN, 10)));
    const total = Math.max(1, parseInt(totalMarks, 10) || 100);
    if (!needM && !needS && givenM + givenS === 0) return res.status(400).json({ error: "questions required" });
    const dCount = Math.max(0, Math.min(10, parseInt(diagramCount, 10) || 0));
    const dTopics = String(diagramTopics || "").trim();

    const cleanLessons = (Array.isArray(lessons) ? lessons : []).filter((l) => l && l.text && l.text.trim());
    if (!cleanLessons.length) return res.status(400).json({ error: "lessons required" });

    // Luqadda imtixaanka: haddii la doorto waa la raacayaa, haddii kale waxay raacaysaa luqadda casharka.
    const forced = LANG_NAMES[lang] ? lang : null;
    const rawText = cleanLessons.map((l) => l.text).join("\n\n");
    const examLang = forced || detectLang(rawText);
    const L = LABELS[examLang];
    const langName = LANG_NAMES[examLang];

    const subjectF = String(subject).trim() || L.defSubject;
    const klassF = String(klass).trim() || L.defClass;
    const durationF = String(duration).trim() || L.defDuration;

    const sourcesLabel = cleanLessons
      .map((l) => [l.chapter, l.pages ? L.pageWord + " " + l.pages : ""].filter(Boolean).join(" — ") || L.unnamed)
      .join(" | ");

    let allText = cleanLessons
      .map((l, i) => {
        const tag = [l.chapter || L.lessonWord + " " + (i + 1), l.pages ? L.pageWord + " " + l.pages : ""].filter(Boolean).join(" — ");
        return `### ${tag}\n${l.text.trim()}`;
      })
      .join("\n\n");
    if (allText.length > MAX_SOURCE_CHARS) allText = allText.slice(0, MAX_SOURCE_CHARS);

    // Tirada su'aalaha: haddii aan la qorin, si otomaatig ah ayaa loo doortaa.
    const { m: mN, s: sN } = autoCounts({ chars: allText.length, total, givenM, givenS, needM, needS });
    if (mN + sN === 0) return res.status(400).json({ error: "questions required" });

    // Dhibcaha: MCQ ~40% (su'aal kasta ugu yaraan 1 dhibic), inta kale qaab-dhismeed
    let mcqTotal = 0;
    if (mN === 0) mcqTotal = 0;
    else if (sN === 0) mcqTotal = total;
    else {
      mcqTotal = Math.min(mN, Math.round(total * 0.4));
      mcqTotal = Math.max(mcqTotal, Math.min(mN, total - sN)); // ha jirin su'aal 0 dhibic ah
      mcqTotal = Math.max(1, mcqTotal);
    }
    const structTotal = total - mcqTotal;
    const mcqMarks = distribute(mcqTotal, mN);
    const structMarks = distribute(structTotal, sN);

    const mcqCounts = splitCounts(mN, 10);
    const structCounts = splitCounts(sN, 4);

    // Sawirrada ku qaybi qaybaha qaab-dhismeedka (haddii aysan jirin, MCQ)
    const diagTargets = structCounts.length ? structCounts : mcqCounts;
    const diagAlloc = diagTargets.map(() => 0);
    for (let i = 0; i < dCount; i++) diagAlloc[i % diagTargets.length]++;

    const jobs = [];
    let offset = 0;
    const mcqSlices = splitText(allText, mcqCounts.length);
    mcqCounts.forEach((n, i) => {
      const d = structCounts.length ? 0 : diagAlloc[i];
      jobs.push({ kind: "mcq", marks: mcqMarks.slice(offset, offset + n), p: batchPrompt({ kind: "mcq", n, marksList: [], textSlice: mcqSlices[i], subject: subjectF, klass: klassF, diagrams: d, diagramTopics: dTopics, part: i + 1, parts: mcqCounts.length, langName, forced: !!forced }), max: d ? 6000 : 4000, label: "MCQ " + (i + 1) });
      offset += n;
    });
    offset = 0;
    const structSlices = splitText(allText, structCounts.length);
    structCounts.forEach((n, i) => {
      const ml = structMarks.slice(offset, offset + n);
      const d = diagAlloc[i];
      jobs.push({ kind: "struct", marks: ml, p: batchPrompt({ kind: "struct", n, marksList: ml, textSlice: structSlices[i], subject: subjectF, klass: klassF, diagrams: d, diagramTopics: dTopics, part: i + 1, parts: structCounts.length, langName, forced: !!forced }), max: d ? 7000 : 5000, label: "Struct " + (i + 1) });
      offset += n;
    });

    const results = await Promise.all(jobs.map((j) => askJson(j.p, j.max, j.label)));

    const mkSection = (kind, name, instructions) => {
      const qs = [];
      results.forEach((r, i) => {
        if (jobs[i].kind !== kind) return;
        (r.questions || []).slice(0, jobs[i].marks.length).forEach((q, k) => qs.push({ ...q, marks: jobs[i].marks[k] }));
      });
      return { name, instructions, qs };
    };
    const s1 = mkSection("mcq", L.mcqName, L.mcqInstr);
    const s2 = mkSection("struct", L.structName, L.structInstr);

    let n = 1;
    const answerKey = [];
    const sections = [s1, s2]
      .filter((s) => s.qs.length)
      .map((s) => ({
        name: s.name,
        instructions: s.instructions,
        marks: s.qs.reduce((a, q) => a + q.marks, 0),
        questions: s.qs.map((q) => {
          const number = n++;
          answerKey.push({ number, answer: q.answer || "" });
          return { number, text: q.text, marks: q.marks, bloom: q.bloom || "", options: q.options || null, svg: q.svg || null };
        }),
      }));
    const data = { sections, answerKey };
    const counts = { mcq: s1.qs.length, struct: s2.qs.length, autoMcq: needM, autoStruct: needS };
    const meta = { subject: subjectF, klass: klassF, totalMarks: total, duration: durationF, school, sourcesLabel, lang: examLang, labels: L, counts };

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO exams (id, subject, class_name, total_marks, duration, sources, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, subjectF, klassF, total, durationF, sourcesLabel, JSON.stringify({ ...data, meta })]
    );

    res.json({ id, exam: data, meta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ---------- OCR cache (page kasta mar keliya ayaa la akhriyaa) ----------
// Soo hel boggagga hore loo akhriyay buug (docHash = SHA-256 ee faylka).
app.post("/api/ocr-cache", requireAdmin, async (req, res) => {
  try {
    const { docHash = "", pages = [] } = req.body || {};
    const nums = (Array.isArray(pages) ? pages : []).map((n) => parseInt(n, 10)).filter((n) => n >= 1);
    if (!docHash || !nums.length) return res.json({ pages: {} });
    const { rows } = await pool.query(
      "SELECT page, text FROM ocr_pages WHERE doc_hash=$1 AND page = ANY($2::int[])",
      [String(docHash), nums]
    );
    const out = {};
    rows.forEach((r) => { out[r.page] = r.text; });
    res.json({ pages: out });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

async function ocrOnePage(b64, mediaType) {
  const content = [
    {
      type: "text",
      text:
        "Transcribe the text on this textbook page image EXACTLY as written. " +
        "Keep the original language (Somali, English or Arabic) — do NOT translate, summarise or add commentary. " +
        "Keep formulas, units, numbering and headings; write tables as plain text rows. " +
        "For a picture/diagram, write only a short bracketed note like [Diagram: ...] in the page's own language. " +
        "Output the transcription only. If the page has no text, output nothing.",
    },
    { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
  ];
  const r = await callClaude({ messages: [{ role: "user", content }], maxTokens: 4096 });
  return (r.text || "").trim();
}

// OCR boggag scan ah. Boggagga hore loo akhriyay waa laga qaadayaa keydka, kuwa cusub oo keliya ayaa la akhriyaa.
app.post("/api/ocr-pages", requireAdmin, async (req, res) => {
  try {
    const { docHash = "", docName = "", pages = [], mediaType = "image/png" } = req.body || {};
    if (!Array.isArray(pages) || !pages.length) return res.status(400).json({ error: "pages required" });
    if (pages.length > 8) return res.status(400).json({ error: "too many pages in one call (max 8)" });
    const items = pages
      .map((p) => ({ num: parseInt(p && p.num, 10), image: p && p.image }))
      .filter((p) => p.num >= 1);
    if (!items.length) return res.status(400).json({ error: "pages required" });

    const out = {};
    const fromCache = [];
    const fresh = [];

    let cached = {};
    if (docHash) {
      const { rows } = await pool.query(
        "SELECT page, text FROM ocr_pages WHERE doc_hash=$1 AND page = ANY($2::int[])",
        [String(docHash), items.map((p) => p.num)]
      );
      rows.forEach((r) => { cached[r.page] = r.text; });
    }

    const todo = [];
    for (const p of items) {
      if (cached[p.num] !== undefined) { out[p.num] = cached[p.num]; fromCache.push(p.num); }
      else if (p.image) todo.push(p);
    }

    await Promise.all(
      todo.map(async (p) => {
        const text = await ocrOnePage(p.image, mediaType);
        out[p.num] = text;
        fresh.push(p.num);
        // Keydi kaliya haddii qoraal la helay (bog madhan dib ayaa loo isku dayi karaa)
        if (docHash && text) {
          await pool.query(
            `INSERT INTO ocr_pages (doc_hash, page, doc_name, text) VALUES ($1,$2,$3,$4)
             ON CONFLICT (doc_hash, page) DO UPDATE SET text=EXCLUDED.text, doc_name=EXCLUDED.doc_name, created_at=now()`,
            [String(docHash), p.num, String(docName).slice(0, 200), text]
          );
        }
      })
    );

    res.json({ pages: out, fromCache, fresh });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ---------- Saved exams ----------
app.get("/api/exams", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, subject, class_name, total_marks, duration, sources, created_at FROM exams ORDER BY created_at DESC LIMIT 100"
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.get("/api/exams/:id", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM exams WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

app.delete("/api/exams/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM exams WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ---------- Lesson Plan + Lesson Note ----------
pool.query(`CREATE TABLE IF NOT EXISTS lesson_plans (
  id TEXT PRIMARY KEY, teacher TEXT DEFAULT '', subject TEXT DEFAULT '', class_name TEXT DEFAULT '',
  title TEXT DEFAULT '', data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT now())`
).catch((e) => console.error("LP DB init error:", e));

app.post("/api/generate-lesson-plan", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const f = (k) => String(b[k] || "").trim();
    const meta = { teacher: f("teacher"), klass: f("klass"), subject: f("subject"), unit: f("unit"), lesson: f("lesson"),
      date: f("date"), day: f("day"), session: f("session"), weekly: f("weekly"), duration: f("duration") || "40 min" };
    if (!meta.unit && !meta.lesson) return res.status(400).json({ error: "Fadlan geli cutubka ama cinwaanka casharka." });
    const src = f("text").slice(0, 30000);
    const nObj = Math.min(6, Math.max(2, parseInt(b.numObjectives, 10) || 4));
    const lang = LANG_NAMES[b.lang] ? b.lang : src ? detectLang(src) : "en";
    meta.lang = lang;
    const prompt = `You are an experienced teacher in a Somali secondary school writing a STANDARD lesson plan and its matching LESSON NOTE.
Subject: ${meta.subject || "-"}; Class: ${meta.klass || "-"}; Unit/Chapter: ${meta.unit || "-"}; Lesson title: ${meta.lesson || "-"}; Duration: ${meta.duration}.
Write everything in ${LANG_NAMES[lang]}.${src ? " Base the content ONLY on the lesson text below." : ""}
Rules:
- "objectives": exactly ${nObj} measurable objectives, each starting with an action verb (define, explain, list, apply, compare...) completing "the learner should be able to ...". Do not repeat the lead-in phrase.
- "introduction": 2-3 sentences linking the unit "${meta.unit}" to the lesson "${meta.lesson}".
- "methods": 3-4 suitable teaching methods, comma separated. "aids": learning aids, comma separated.
- "evaluation": exactly 8 short questions/tasks, covering the objectives in order.
- "note": the LESSON NOTE = a concise summary built from the objectives, the unit and the lesson title. One section per objective in the same order (heading "h" = the key idea of that objective, "p" = 2-4 short lines separated by \\n, with definitions/examples/formulas), then a final section with heading "Summary". Use the same terms as the plan; it must be consistent with it and answer the evaluation items. About 250-400 words.
${src ? `\nLESSON TEXT:\n"""\n${src}\n"""\n` : ""}
Return ONLY JSON (no code fences): {"introduction":"","objectives":[""],"methods":"","aids":"","evaluation":[""],"note":[{"h":"","p":""}]}`;
    const plan = await askJson(prompt, 5000, "lesson-plan");
    plan.objectives = (plan.objectives || []).slice(0, 6);
    plan.evaluation = (plan.evaluation || []).slice(0, 8);
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO lesson_plans (id, teacher, subject, class_name, title, data) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, meta.teacher, meta.subject, meta.klass, [meta.unit, meta.lesson].filter(Boolean).join(" — "), JSON.stringify({ meta, plan })]
    );
    res.json({ id, meta, plan });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

app.get("/api/lesson-plans", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, teacher, subject, class_name, title, created_at FROM lesson_plans ORDER BY created_at DESC LIMIT 100");
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
app.get("/api/lesson-plans/:id", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT data FROM lesson_plans WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "not found" });
    res.json(rows[0].data);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
app.delete("/api/lesson-plans/:id", requireAdmin, async (req, res) => {
  try { await pool.query("DELETE FROM lesson_plans WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// ---------- Static ----------
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    },
  })
);
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server wuxuu ku shaqeynayaa port ${PORT}`));
