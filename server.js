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
  // Kharashka API: call kasta waa la diiwaangeliyaa (token + doolar)
  await pool.query(`CREATE TABLE IF NOT EXISTS api_usage (
    id SERIAL PRIMARY KEY,
    model TEXT NOT NULL DEFAULT '',
    label TEXT NOT NULL DEFAULT '',
    input_tokens INT NOT NULL DEFAULT 0,
    output_tokens INT NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now()
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

// ---------- Kharashka & hadhaaga lacagta ----------
// Qiimaha halkii 1 milyan token (doolar). Hubi qiimaha rasmiga ah ee https://claude.com/pricing
// oo hagaaji Variables-ka Railway haddii uu is beddelo.
const PRICE_IN = parseFloat(process.env.PRICE_INPUT_PER_MTOK || "3");
const PRICE_OUT = parseFloat(process.env.PRICE_OUTPUT_PER_MTOK || "15");
// Lacagta aad ku shubtay console.anthropic.com (doolar)
const CREDIT_START = parseFloat(process.env.CREDIT_START_USD || "5");

async function recordUsage(u, label) {
  try {
    const inT = u.input_tokens || 0;
    const outT = u.output_tokens || 0;
    const cost = (inT * PRICE_IN + outT * PRICE_OUT) / 1e6;
    await pool.query(
      "INSERT INTO api_usage (model, label, input_tokens, output_tokens, cost_usd) VALUES ($1,$2,$3,$4,$5)",
      [CLAUDE_MODEL, label || "", inT, outT, cost]
    );
  } catch (e) {
    console.error("usage log error:", e.message);
  }
}

app.get("/api/usage", requireAdmin, async (req, res) => {
  try {
    const tot = await pool.query(
      "SELECT COALESCE(SUM(cost_usd),0)::float AS spent, COUNT(*)::int AS calls, COALESCE(SUM(input_tokens),0)::int AS inp, COALESCE(SUM(output_tokens),0)::int AS outp FROM api_usage"
    );
    const last = await pool.query(
      "SELECT label, input_tokens, output_tokens, cost_usd::float AS cost, created_at FROM api_usage ORDER BY id DESC LIMIT 10"
    );
    const t = tot.rows[0];
    res.json({
      start: CREDIT_START,
      spent: t.spent,
      remaining: Math.max(0, CREDIT_START - t.spent),
      calls: t.calls,
      input_tokens: t.inp,
      output_tokens: t.outp,
      last: last.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Claude API helper ----------
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

async function callClaude({ system, messages, maxTokens, label }) {
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
  await recordUsage(u, label);
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
    const r = await callClaude({ messages: [{ role: "user", content: prompt }], maxTokens, label });
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

    // Dhibcaha: saamiga 40:60 — Multiple Choice = 40%, Structure = 60% wadarta dhibcaha.
    // Su'aal kastaa waa inay ugu yaraan 1 dhibic hesho (kaliya haddii wadarta aanay ogolayn ayaa saamigu xoogaa is-beddelaa).
    let mcqTotal = 0;
    if (mN === 0) mcqTotal = 0;
    else if (sN === 0) mcqTotal = total;
    else {
      mcqTotal = Math.round(total * 0.4);
      mcqTotal = Math.max(mcqTotal, mN);          // MCQ kasta >= 1
      mcqTotal = Math.min(mcqTotal, total - sN);  // structure kasta >= 1
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
  const r = await callClaude({ messages: [{ role: "user", content }], maxTokens: 4096, label: "ocr" });
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
    const nGiven = parseInt(b.numObjectives, 10);
    const nObj = nGiven >= 1 ? Math.min(12, nGiven) : 0; // 0 = otomaatig: raac objectives-ka buugga/manhajka
    const lang = LANG_NAMES[b.lang] ? b.lang : src ? detectLang(src) : "en";
    meta.lang = lang;
    const prompt = `You are an experienced teacher in a Somali secondary school writing a STANDARD lesson plan and its matching LESSON NOTE.
Subject: ${meta.subject || "-"}; Class: ${meta.klass || "-"}; Unit/Chapter: ${meta.unit || "-"}; Lesson title: ${meta.lesson || "-"}; Duration: ${meta.duration}.
Write everything in ${LANG_NAMES[lang]}.${src ? " Base the content ONLY on the lesson text below." : ""}
Rules:
- "objectives": ${nObj
  ? `exactly ${nObj} measurable objectives chosen by the teacher.`
  : `AUTOMATIC COUNT. ${src ? "First look in the lesson text for the objectives that the textbook/curriculum itself states for this unit/lesson (e.g. 'Objectives', 'By the end of this unit/lesson you should be able to', 'Learning outcomes'). If found, copy ALL of them, in the same order and the same meaning, without dropping or merging any. If the text states none, " : ""}Use the objectives of the Somali national curriculum for this unit/lesson; if you do not know them, write as many as the lesson genuinely needs (usually 3-8). Do not add filler objectives and do not cut real ones.`} Each starts with an action verb (define, explain, list, apply, compare...) completing "the learner should be able to ...". Do not repeat the lead-in phrase.
- "introduction": 2-3 sentences linking the unit "${meta.unit}" to the lesson "${meta.lesson}".
- "methods": 3-4 suitable teaching methods, comma separated. "aids": learning aids, comma separated.
- "evaluation": NOT a fixed number. Write as many short questions/tasks as this lesson needs (normally at least one per objective, usually 4-12), covering ALL objectives in order, no padding.
- "note": the LESSON NOTE = a complete summary built from the objectives, the unit and the lesson title. It MUST contain EVERY objective: one section per objective, in the same order and with no objective left out or merged (heading "h" = the key idea of that objective, "p" = 3-6 short lines separated by \\n, with definitions/explanations/examples/formulas that fully let the learner achieve that objective), then a final section with heading "Summary". Use the same terms as the plan; it must be consistent with it and answer the evaluation items. Length follows the number of objectives (about 80-120 words per objective).
${src ? `\nLESSON TEXT:\n"""\n${src}\n"""\n` : ""}
Return ONLY JSON (no code fences): {"introduction":"","objectives":[""],"methods":"","aids":"","evaluation":[""],"note":[{"h":"","p":""}]}`;
    const plan = await askJson(prompt, 9000, "lesson-plan");
    plan.objectives = (plan.objectives || []).slice(0, 15);
    plan.evaluation = (plan.evaluation || []).slice(0, 20);
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

// ---------- Maktabadda Manhajka (buug kasta = fasal + maadada; OCR-kiisa waa la keydiyaa) ----------
pool.query(`CREATE TABLE IF NOT EXISTS library_books (
  id TEXT PRIMARY KEY,
  class_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  doc_hash TEXT NOT NULL UNIQUE,
  num_pages INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now())`
).catch((e) => console.error("Library DB init error:", e));

function parseRangeServer(str, max) {
  const out = new Set();
  String(str || "").split(",").forEach((part) => {
    part = part.trim();
    if (!part) return;
    const m = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b && i <= max; i++) if (i >= 1) out.add(i);
    } else {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= max) out.add(n);
    }
  });
  return Array.from(out).sort((a, b) => a - b);
}

async function getBook(id) {
  const { rows } = await pool.query("SELECT * FROM library_books WHERE id=$1", [id]);
  return rows[0] || null;
}

// Liiska buugaagta + intee bog ayaa OCR-keeda la keydiyay
app.get("/api/library", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.class_name, b.subject, b.title, b.doc_hash, b.num_pages, b.created_at,
              (SELECT COUNT(*) FROM ocr_pages p WHERE p.doc_hash = b.doc_hash)::int AS pages_done
         FROM library_books b ORDER BY b.class_name, b.subject, b.title`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Diiwaangeli buug (haddii isla faylka hore loo geliyay, xogtiisa waa la cusboonaysiiyaa)
app.post("/api/library", requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const docHash = String(b.docHash || "").trim();
    if (!docHash) return res.status(400).json({ error: "docHash required" });
    const cls = String(b.className || "").trim().slice(0, 60);
    const subj = String(b.subject || "").trim().slice(0, 100);
    const title = String(b.title || "").trim().slice(0, 200);
    const n = Math.max(0, parseInt(b.numPages, 10) || 0);
    if (!cls || !subj) return res.status(400).json({ error: "Fasalka iyo maadada waa loo baahan yahay." });
    const id = crypto.randomUUID();
    const { rows } = await pool.query(
      `INSERT INTO library_books (id, class_name, subject, title, doc_hash, num_pages)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (doc_hash) DO UPDATE SET class_name=EXCLUDED.class_name, subject=EXCLUDED.subject,
         title=EXCLUDED.title, num_pages=EXCLUDED.num_pages
       RETURNING id`,
      [id, cls, subj, title || subj, docHash, n]
    );
    res.json({ id: rows[0].id });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "server error" }); }
});

// Bogagga hore loo keydiyay (si OCR-ku uga sii socdo halka uu istaagay)
app.get("/api/library/:id/done", requireAdmin, async (req, res) => {
  try {
    const book = await getBook(req.params.id);
    if (!book) return res.status(404).json({ error: "not found" });
    const { rows } = await pool.query("SELECT page FROM ocr_pages WHERE doc_hash=$1 ORDER BY page", [book.doc_hash]);
    res.json({ pages: rows.map((r) => r.page) });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// Keydi qoraalka bogagga PDF-ka ee qoraalkoodu horay ugu jiray (OCR looma baahna)
app.post("/api/library/:id/store-pages", requireAdmin, async (req, res) => {
  try {
    const book = await getBook(req.params.id);
    if (!book) return res.status(404).json({ error: "not found" });
    const pages = (req.body && req.body.pages) || {};
    const entries = Object.entries(pages)
      .map(([k, v]) => [parseInt(k, 10), String(v || "").trim()])
      .filter(([n, t]) => n >= 1 && t);
    if (entries.length > 60) return res.status(400).json({ error: "too many pages in one call (max 60)" });
    for (const [n, t] of entries) {
      await pool.query(
        `INSERT INTO ocr_pages (doc_hash, page, doc_name, text) VALUES ($1,$2,$3,$4)
         ON CONFLICT (doc_hash, page) DO UPDATE SET text=EXCLUDED.text, doc_name=EXCLUDED.doc_name, created_at=now()`,
        [book.doc_hash, n, book.title.slice(0, 200), t]
      );
    }
    res.json({ stored: entries.length });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "server error" }); }
});

// Soo qaad qoraalka bogagga (tusaale ?pages=24-31). Haddii bogag aan la qorin, 90k xaraf ee ugu horreeya.
app.get("/api/library/:id/text", requireAdmin, async (req, res) => {
  try {
    const book = await getBook(req.params.id);
    if (!book) return res.status(404).json({ error: "not found" });
    const max = book.num_pages || 5000;
    const asked = String(req.query.pages || "").trim();
    const nums = asked ? parseRangeServer(asked, max) : null;
    const { rows } = nums
      ? await pool.query("SELECT page, text FROM ocr_pages WHERE doc_hash=$1 AND page = ANY($2::int[]) ORDER BY page", [book.doc_hash, nums])
      : await pool.query("SELECT page, text FROM ocr_pages WHERE doc_hash=$1 ORDER BY page", [book.doc_hash]);
    let text = rows.map((r) => r.text).join("\n\n");
    let truncated = false;
    if (text.length > MAX_SOURCE_CHARS) { text = text.slice(0, MAX_SOURCE_CHARS); truncated = true; }
    const have = new Set(rows.map((r) => r.page));
    res.json({
      text,
      found: rows.length,
      requested: nums ? nums.length : rows.length,
      missing: nums ? nums.filter((n) => !have.has(n)) : [],
      truncated,
    });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "server error" }); }
});

// Raadi cutub/cashar buugga gudihiisa (waxay soo celisaa lambarrada bogagga)
app.get("/api/library/:id/search", requireAdmin, async (req, res) => {
  try {
    const book = await getBook(req.params.id);
    if (!book) return res.status(404).json({ error: "not found" });
    const q = String(req.query.q || "").trim().slice(0, 100);
    if (q.length < 2) return res.json({ hits: [] });
    const like = "%" + q.replace(/[\\%_]/g, (m) => "\\" + m) + "%";
    const { rows } = await pool.query(
      "SELECT page, text FROM ocr_pages WHERE doc_hash=$1 AND text ILIKE $2 ORDER BY page LIMIT 40",
      [book.doc_hash, like]
    );
    const hits = rows.map((r) => {
      const i = r.text.toLowerCase().indexOf(q.toLowerCase());
      const s = Math.max(0, i - 40);
      return { page: r.page, snippet: r.text.slice(s, s + 120).replace(/\s+/g, " ") };
    });
    res.json({ hits });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message || "server error" }); }
});

app.delete("/api/library/:id", requireAdmin, async (req, res) => {
  try {
    const book = await getBook(req.params.id);
    if (!book) return res.json({ ok: true });
    await pool.query("DELETE FROM ocr_pages WHERE doc_hash=$1", [book.doc_hash]);
    await pool.query("DELETE FROM library_books WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
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
