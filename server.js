const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, "leaderboard.json");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const USE_SUPABASE = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);

function ensureDataFile() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ scores: [] }, null, 2), "utf8");
  }
}

function readStore() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.scores)) return { scores: [] };
    return parsed;
  } catch {
    return { scores: [] };
  }
}

function writeStore(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf8");
}

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function sanitizeName(name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ").slice(0, 14);
  return clean || "Runner";
}

function normalizeDifficulty(raw) {
  return raw === "hard" || raw === "normal" || raw === "easy" ? raw : "easy";
}

function getSortedForDifficulty(scores, difficulty) {
  return scores
    .filter((s) => s.difficulty === difficulty)
    .sort((a, b) => (b.score - a.score) || (a.createdAt - b.createdAt));
}

function withRank(rows) {
  return rows.map((row, idx) => ({
    rank: idx + 1,
    name: row.name,
    score: row.score,
    difficulty: row.difficulty,
    createdAt: row.createdAt
  }));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveFile(reqPath, res) {
  const decoded = decodeURIComponent(reqPath);
  const safePath = decoded === "/" ? "/index.html" : decoded;
  const filePath = path.join(ROOT, safePath);
  const normalized = path.normalize(filePath);

  if (!normalized.startsWith(path.normalize(ROOT + path.sep)) && normalized !== path.join(ROOT, "index.html")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }

  fs.readFile(normalized, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(normalized).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

function normalizeTimestamp(value) {
  if (!value) return Date.now();
  const t = Date.parse(value);
  return Number.isNaN(t) ? Date.now() : t;
}

function mapSupabaseRows(rows) {
  return (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    score: Number(r.score) || 0,
    difficulty: normalizeDifficulty(r.difficulty),
    createdAt: normalizeTimestamp(r.created_at)
  }));
}

function buildSupabaseUrl(pathWithQuery) {
  return `${SUPABASE_URL.replace(/\/+$/, "")}/rest/v1${pathWithQuery}`;
}

async function supabaseRequest(pathWithQuery, options = {}) {
  const res = await fetch(buildSupabaseUrl(pathWithQuery), {
    method: options.method || "GET",
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body == null ? undefined : JSON.stringify(options.body)
  });

  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      detail = "";
    }
    throw new Error(`Supabase ${res.status}: ${detail}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

async function submitScoreSupabase(name, score, difficulty) {
  const inserted = await supabaseRequest("/scores?select=id,name,score,difficulty,created_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: { name, score, difficulty }
  });

  const entry = inserted[0];
  if (!entry) throw new Error("Insert failed");

  const rows = await supabaseRequest(
    `/scores?difficulty=eq.${difficulty}&select=id,name,score,difficulty,created_at&order=score.desc,created_at.asc&limit=5000`
  );

  const mapped = mapSupabaseRows(rows);
  const ranked = withRank(mapped);
  const rank = ranked.findIndex((s) => String(s.id) === String(entry.id)) + 1;

  return {
    rank,
    total: ranked.length,
    top: ranked.slice(0, 10)
  };
}

async function getLeaderboardSupabase(difficulty, limit) {
  const rows = await supabaseRequest(
    `/scores?difficulty=eq.${difficulty}&select=id,name,score,difficulty,created_at&order=score.desc,created_at.asc&limit=5000`
  );
  const ranked = withRank(mapSupabaseRows(rows));
  return { total: ranked.length, rows: ranked.slice(0, limit) };
}

async function submitScoreLocal(name, score, difficulty) {
  const store = readStore();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = { id, name, score, difficulty, createdAt: Date.now() };
  store.scores.push(entry);
  writeStore(store);

  const sorted = getSortedForDifficulty(store.scores, difficulty);
  const rank = sorted.findIndex((s) => s.id === id) + 1;
  const top = withRank(sorted).slice(0, 10);

  return { rank, total: sorted.length, top };
}

async function getLeaderboardLocal(difficulty, limit) {
  const store = readStore();
  const ranked = withRank(getSortedForDifficulty(store.scores, difficulty));
  return { total: ranked.length, rows: ranked.slice(0, limit) };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/leaderboard" && req.method === "GET") {
    try {
      const difficulty = normalizeDifficulty(url.searchParams.get("difficulty"));
      const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || 10)));
      const data = USE_SUPABASE
        ? await getLeaderboardSupabase(difficulty, limit)
        : await getLeaderboardLocal(difficulty, limit);

      sendJson(res, 200, {
        difficulty,
        total: data.total,
        rows: data.rows,
        backend: USE_SUPABASE ? "supabase" : "local"
      });
    } catch (err) {
      sendJson(res, 500, { error: "Leaderboard failed", detail: String(err.message || err) });
    }
    return;
  }

  if (url.pathname === "/api/submit" && req.method === "POST") {
    try {
      const raw = await readRequestBody(req);
      const payload = raw ? JSON.parse(raw) : {};
      const name = sanitizeName(payload.name);
      const score = Math.max(0, Math.floor(Number(payload.score) || 0));
      const difficulty = normalizeDifficulty(payload.difficulty);

      const data = USE_SUPABASE
        ? await submitScoreSupabase(name, score, difficulty)
        : await submitScoreLocal(name, score, difficulty);

      sendJson(res, 200, {
        ok: true,
        rank: data.rank,
        total: data.total,
        top: data.top,
        entry: { name, score, difficulty },
        backend: USE_SUPABASE ? "supabase" : "local"
      });
    } catch (err) {
      sendJson(res, 400, { error: "Invalid request", detail: String(err.message || err) });
    }
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      backend: USE_SUPABASE ? "supabase" : "local"
    });
    return;
  }

  serveFile(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`Math Runner server listening on http://localhost:${PORT}`);
  console.log(`Leaderboard backend: ${USE_SUPABASE ? "supabase" : "local file"}`);
});
