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

function batchPrompt({ kind, n, marksList, textSlice, subject, klass, diagrams, diagramTopics, part, parts }) {
  const bloom = kind === "mcq"
    ? "Xusuusnaan, Fahamka, Dabaqid (heerarka hoose iyo dhexe)"
    : "Dabaqid, Falanqayn, Isku-dar/Abuur, Qiimeyn (heerarka sare); isku dar su'aalo gaagaaban iyo kuwo dhaadheer";
  const diag = diagrams > 0
    ? `Waa INUU ku jiraa SI SAX AH ${diagrams} su'aal oo leh sawir \"svg\" (SVG fudud oo cad: <svg viewBox=\"0 0 300 200\" xmlns=\"http://www.w3.org/2000/svg\">...</svg>, khadad iyo xarfo kooban, sida imtixaanada Qaranka: jaantus, shax, geometri, wareegga koronto, iwm). Su'aalaha kale svg waa null.${diagramTopics ? " Mawduucyada la doorbidayo: " + diagramTopics + "." : ""}`
    : `Dhammaan \"svg\" waa null.`;
  const shape = kind === "mcq"
    ? `{"questions":[{"text":"...","options":["A) ...","B) ...","C) ...","D) ..."],"answer":"B) ...","bloom":"Xusuusnaan","svg":null}]}`
    : `{"questions":[{"text":"... (ha ku dar qeybo a), b), c) haddii ay habboon tahay)","answer":"Jawaab qaab-dhismeed oo kooban + qodobbada dhibcaha","bloom":"Falanqayn","svg":null}]}`;
  const marksLine = kind === "struct" ? `\nDhibcaha su'aal kasta (si isku xigta): ${marksList.join(", ")}. Su'aalaha dhibcahoodu sarreeyo waa inay noqdaan kuwo ka dhaadheer.` : "";
  return `Waxaad tahay khabiir diyaarinaya imtixaanada heer-qaran ee Soomaaliya (qaabka Wasaaradda Waxbarashada / Qaranka). Samee ${n} su'aalood oo ${kind === "mcq" ? "ikhtiyaar sax ah (MCQ, 4 doorasho A-D, hal jawaab oo sax ah, doorashooyinka khaldan ha noqdaan kuwo macquul ah)" : "qaab-dhismeed ah"} oo ku saabsan ${subject} (${klass}).
Heerarka Bloom: ${bloom}.${marksLine}
Su'aal kasta waa inay ku salaysan tahay KALIYA qoraalka hoose, oo ha is-ku celin. Qoraalku waa qaybta ${part}/${parts} ee casharrada; ka dhig su'aalaha kuwo si fiican u daboola qaybtan.
${diag}

QORAALKA:
"""
${textSlice}
"""

Soo celi JSON KALIYA (faallo la'aan, code-fence la'aan), Soomaali fasiix ah, tirada su'aalaha waa inay noqotaa ${n}:
${shape}`;
}

// ---------- Generate an exam from pasted/extracted lesson text ----------
app.post("/api/generate-exam", requireAdmin, async (req, res) => {
  try {
    const {
      subject = "Maadada",
      klass = "Fasalka",
      mcqN = 10,
      structN = 8,
      totalMarks = 100,
      duration = "2 saac",
      school = "",
      diagramCount = 0,
      diagramTopics = "",
      lessons = [],
    } = req.body || {};

    const mN = Math.max(0, Math.min(60, parseInt(mcqN, 10) || 0));
    const sN = Math.max(0, Math.min(30, parseInt(structN, 10) || 0));
    const total = Math.max(1, parseInt(totalMarks, 10) || 100);
    if (mN + sN === 0) return res.status(400).json({ error: "questions required" });
    const dCount = Math.max(0, Math.min(10, parseInt(diagramCount, 10) || 0));
    const dTopics = String(diagramTopics || "").trim();

    const cleanLessons = (Array.isArray(lessons) ? lessons : []).filter((l) => l && l.text && l.text.trim());
    if (!cleanLessons.length) return res.status(400).json({ error: "lessons required" });

    const sourcesLabel = cleanLessons
      .map((l) => [l.chapter, l.pages ? "Bogga " + l.pages : ""].filter(Boolean).join(" — ") || "Cashar aan magac lahayn")
      .join(" | ");

    let allText = cleanLessons
      .map((l, i) => {
        const tag = [l.chapter || "Cashar " + (i + 1), l.pages ? "Bogga " + l.pages : ""].filter(Boolean).join(" — ");
        return `### ${tag}\n${l.text.trim()}`;
      })
      .join("\n\n");
    if (allText.length > MAX_SOURCE_CHARS) allText = allText.slice(0, MAX_SOURCE_CHARS);

    // Dhibcaha: MCQ ~40% (ugu badnaan 1 dhibic su'aal kasta haddii suurtagal ah), inta kale qaab-dhismeed
    const mcqTotal = mN === 0 ? 0 : sN === 0 ? total : Math.min(mN, Math.round(total * 0.4)) || 1;
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
    mcqCounts.forEach((n, i) => {
      const slice = splitText(allText, mcqCounts.length)[i];
      const d = structCounts.length ? 0 : diagAlloc[i];
      jobs.push({ kind: "mcq", marks: mcqMarks.slice(offset, offset + n), p: batchPrompt({ kind: "mcq", n, marksList: [], textSlice: slice, subject, klass, diagrams: d, diagramTopics: dTopics, part: i + 1, parts: mcqCounts.length }), max: d ? 6000 : 4000, label: "MCQ " + (i + 1) });
      offset += n;
    });
    offset = 0;
    structCounts.forEach((n, i) => {
      const slice = splitText(allText, structCounts.length)[i];
      const ml = structMarks.slice(offset, offset + n);
      const d = diagAlloc[i];
      jobs.push({ kind: "struct", marks: ml, p: batchPrompt({ kind: "struct", n, marksList: ml, textSlice: slice, subject, klass, diagrams: d, diagramTopics: dTopics, part: i + 1, parts: structCounts.length }), max: d ? 7000 : 5000, label: "Qaab-dhismeed " + (i + 1) });
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
    const s1 = mkSection("mcq", "QAYBTA 1-aad: Ikhtiyaar Sax ah", "Dooro jawaabta saxda ah ee su'aal kasta. Su'aal kastaa waxay leedahay dhibcaha ka horreeya.");
    const s2 = mkSection("struct", "QAYBTA 2-aad: Su'aalo Qaab-dhismeed ah", "Ka jawaab dhammaan su'aalaha. Si buuxda u qor jawaabahaaga.");

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
    const meta = { subject, klass, totalMarks: total, duration, school, sourcesLabel };

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO exams (id, subject, class_name, total_marks, duration, sources, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, subject, klass, total, duration, sourcesLabel, JSON.stringify({ ...data, meta })]
    );

    res.json({ id, exam: data, meta });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "server error" });
  }
});

// ---------- OCR a batch of scanned page images (for scanned PDFs) ----------
app.post("/api/ocr-pages", requireAdmin, async (req, res) => {
  try {
    const { images = [], mediaType = "image/png" } = req.body || {};
    if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: "images required" });
    if (images.length > 8) return res.status(400).json({ error: "too many images in one call (max 8)" });

    const content = [
      {
        type: "text",
        text:
          "Akhri sawirradan (boggag ka mid ah buug dugsi ah, luuqadu waa Soomaali/Carabi/Ingiriisi). " +
          "Ku qor qoraalka SAX U AH ee ku jira sawirrada, si taxane ah (bogga 1, bogga 2, iwm), " +
          "adigoo aan wax ka beddelin, aan soo koobin, aan faallo ku darin. Jawaabta waa qoraalka kaliya.",
      },
      ...images.map((b64) => ({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: b64 },
      })),
    ];

    const r = await callClaude({
      messages: [{ role: "user", content }],
      maxTokens: 4096,
    });
    res.json({ text: r.text });
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
