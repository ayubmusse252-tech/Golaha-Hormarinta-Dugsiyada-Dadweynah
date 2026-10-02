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
const CLAUDE_MODEL = "claude-sonnet-5";

async function callClaude({ system, messages, maxTokens }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error("ANTHROPIC_API_KEY lama dejin server-ka.");
    err.code = "no_api_key";
    throw err;
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens || 4096,
      system,
      messages,
    }),
  });
  const json = await res.json();
  if (!res.ok) {
    const err = new Error((json && json.error && json.error.message) || "Claude API error");
    err.code = "upstream_error";
    throw err;
  }
  const textBlock = (json.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "";
}

function extractJson(text) {
  let t = String(text || "").trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = t.search(/[{[]/);
  const endBrace = t.lastIndexOf("}");
  const endBracket = t.lastIndexOf("]");
  const end = Math.max(endBrace, endBracket);
  if (start === -1 || end === -1) throw new Error("no JSON found in reply");
  return JSON.parse(t.slice(start, end + 1));
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

    const dCount = Math.max(0, Math.min(10, parseInt(diagramCount, 10) || 0));
    const dTopics = String(diagramTopics || "").trim();

    const cleanLessons = (Array.isArray(lessons) ? lessons : []).filter((l) => l && l.text && l.text.trim());
    if (!cleanLessons.length) return res.status(400).json({ error: "lessons required" });

    const sourcesLabel = cleanLessons
      .map((l) => [l.chapter, l.pages ? "Bogga " + l.pages : ""].filter(Boolean).join(" — ") || "Cashar aan magac lahayn")
      .join(" | ");

    const blocksText = cleanLessons
      .map((l, i) => {
        const tag = [l.chapter || "Cashar " + (i + 1), l.pages ? "Bogga " + l.pages : ""].filter(Boolean).join(" — ");
        return `### ${tag}\n${l.text}`;
      })
      .join("\n\n");

    const diagramInstr = dCount > 0
      ? `Waa INUU IMTIXAANKU KU JIRO SI SAX AH ${dCount} sawir/diagram (SVG), sida kuwa ku jira imtixaanada Qaranka Soomaaliya (tusaale: shaxan/jir geometri ah oo cabbirro leh, bilog/jibaarane, jaantus jir-dhiska sida spring/wave, qaab-dhismeedka kiimikada (molecular structure), khadka/qalabka tijaabada koronto ama radioactive detector, khariidad ama graph). Dooro ${dCount} su'aalood oo ka mid ah kuwa ugu habboon qoraalka casharka (kuwaas oo runtii u baahan in lagu sawiro), oo mid kasta ku dar qeyb "svg" oo ay ku jirto SVG qoraal ah oo fudud, cad, oo la fahmi karo: <svg viewBox="0 0 300 200" xmlns="http://www.w3.org/2000/svg">...</svg> (isticmaal khadad/qaab fudud, qoraal ku jira xaruufo/tiro haddii loo baahdo, sida kuwa buugga). Dhammaan su'aalaha kale ee aan ahayn kuwan la doortay, "svg" waa inay ahaadaan null. Ha dhaafin, hana ka badin tirada ${dCount}.${dTopics ? ` Diagrams-ka intii suurtagal ah ha ku saabsanaadeen mawduucyadan: ${dTopics}.` : ""}`
      : `Ha ku darin wax sawir/diagram ah (svg) su'aal kasta — dhammaan qiyamka "svg" waa inay ahaadaan null.`;

    const prompt = `Waxaad tahay khabiir diyaarinaya imtixaanaada dugsiyada sare ee Soomaaliya, oo ku dhaqan qaabka imtixaanada heer-qaran (sida kuwa Puntland/Qaranka Soomaaliya): laba qaybood — Qaybta 1 ikhtiyaar sax ah (multiple choice), Qaybta 2 su'aalo qaab-dhismeed ah (structured/short-answer/essay). Su'aal kasta waa inay ku salaysan tahay oo keliya qoraallada casharrada/cutubyada hoose.

Isticmaal Bloom's Taxonomy: xusuusnaan, fahamka, dabaqid, falanqayn, isku-darka/abuur, qiimeyn. Qaybta 1 heerarka hoose, Qaybta 2 heerarka sare.

${diagramInstr}

Maadada: ${subject}
Fasalka: ${klass}
Tirada su'aalaha ikhtiyaarka (MCQ): ${mcqN}
Tirada su'aalaha qaab-dhismeedka: ${structN}
Wadarta dhibcaha: ${totalMarks}
Waqtiga: ${duration}

CUTUBYADA/CASHARADA (isha kaliya ee su'aalaha ka soo baxaan):
"""
${blocksText}
"""

Soo celi JSON KALIYA (aan faallo ahayn, aan leh calaamado code-fence ah):
{
 "sections":[
   {"name":"QAYBTA 1-aad: Ikhtiyaar Sax ah","instructions":"...","marks":<n>,
    "questions":[{"number":1,"text":"...","marks":1,"bloom":"Xusuusnaan","options":["A) ...","B) ...","C) ...","D) ..."],"svg":null}]},
   {"name":"QAYBTA 2-aad: Su'aalo Qaab-dhismeed ah","instructions":"...","marks":<n>,
    "questions":[{"number":11,"text":"...","marks":5,"bloom":"Falanqayn","options":null,"svg":null}]}
 ],
 "answerKey":[{"number":1,"answer":"..."}]
}
Hubi tirada su'aalaha iyo wadarta dhibcaha ay sax yihiin, qoraalku Soomaali fasiix ah yahay, aan wax faallo ah oo JSON-ka ka baxsan jirin.`;

    const text = await callClaude({
      messages: [{ role: "user", content: prompt }],
      maxTokens: 8000,
    });
    const data = extractJson(text);

    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO exams (id, subject, class_name, total_marks, duration, sources, data) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, subject, klass, Number(totalMarks) || 0, duration, sourcesLabel, JSON.stringify({ ...data, meta: { subject, klass, totalMarks, duration, school, sourcesLabel } })]
    );

    res.json({ id, exam: data, meta: { subject, klass, totalMarks, duration, school, sourcesLabel } });
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

    const text = await callClaude({
      messages: [{ role: "user", content }],
      maxTokens: 4096,
    });
    res.json({ text });
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
