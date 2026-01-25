// gdelt_geopolitics.js
// Node 18+ (есть global fetch). Работает как:
// - библиотека: require('./gdelt_geopolitics').startScheduler()
// - одноразовый запуск (для cron): node gdelt_geopolitics.js

const fs = require("fs");
const path = require("path");

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  process.env.TELEGRAM_BOT_TOKEN ||
  process.env.TG_TOKEN;

const NEWS_CHAT_ID = process.env.NEWS_CHAT_ID; // -100...
const NEWS_THREAD_ID = process.env.NEWS_THREAD_ID
  ? Number(process.env.NEWS_THREAD_ID)
  : undefined;

const NEWS_TIMESPAN = process.env.NEWS_TIMESPAN || "2h"; // например 1h, 2h, 30min
const NEWS_INTERVAL_MIN = Number(process.env.NEWS_INTERVAL_MIN || 10);
const NEWS_MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 3);

// “важность”: минимум источников (уникальных доменов) для отправки
const NEWS_MIN_SOURCES = Number(process.env.NEWS_MIN_SOURCES || 3);
// для “жёстких” событий (ракетный удар, ядерка и т.д.) можно слать даже при 1 источнике
const NEWS_MIN_SOURCES_HARD = Number(process.env.NEWS_MIN_SOURCES_HARD || 1);

const NEWS_SOURCELANG = (process.env.NEWS_SOURCELANG || "").trim(); // например: english

// whitelist доменов (опционально): "reuters.com,bbc.co.uk,aljazeera.com"
const NEWS_DOMAINS = (process.env.NEWS_DOMAINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Запрос по умолчанию (геополитика/кризисы). Меняйте под себя.
const DEFAULT_QUERY = `(
  "state of emergency" OR "martial law" OR coup OR "military takeover" OR
  missile OR missiles OR "air strike" OR airstrike OR drone OR drones OR
  "nuclear" OR "radiological" OR "chemical attack" OR
  sanctions OR "export controls" OR blockade OR "ceasefire" OR "peace talks" OR
  "internet shutdown" OR "power outage" OR "major outage" OR
  earthquake OR tsunami OR "volcanic eruption"
)`;

const GDELT_QUERY = (process.env.GDELT_QUERY || DEFAULT_QUERY).replace(/\s+/g, " ").trim();

const STATE_FILE = path.join(process.cwd(), "gdelt_state.json");

// -------------------- helpers --------------------
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s.sentKeys) s.sentKeys = {};
    return s;
  } catch {
    return { sentKeys: {}, lastRunIso: null };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to save state:", e?.message || e);
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function hardImpact(title) {
  const t = String(title || "").toLowerCase();
  return (
    /nuclear|radiological|missile|airstrike|air strike|chemical attack|coup|martial law|state of emergency|tsunami|earthquake|internet shutdown/.test(
      t
    )
  );
}

function normalizeTitleToKey(title) {
  const stop = new Set([
    "the","a","an","and","or","to","of","in","on","for","with","as","at","by",
    "from","after","before","over","under","into","amid","says","say","said",
    "update","live","breaking","report","reports"
  ]);

  const tokens = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stop.has(w));

  // Сортируем токены для устойчивости к перестановкам слов
  tokens.sort();
  return tokens.slice(0, 12).join("_"); // достаточно для грубого кластера
}

async function fetchJson(url, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// -------------------- GDELT --------------------
function buildGdeltUrl() {
  let q = GDELT_QUERY;

  if (NEWS_SOURCELANG) {
    q += ` sourcelang:${NEWS_SOURCELANG}`;
  }

  if (NEWS_DOMAINS.length) {
    const domBlock = NEWS_DOMAINS.map((d) => `domain:${d}`).join(" OR ");
    q += ` (${domBlock})`;
  }

  const params = new URLSearchParams({
    query: q,
    mode: "artlist",
    format: "json",
    sort: "datedesc",
    maxrecords: "250",
    timespan: NEWS_TIMESPAN,
  });

  return `https://api.gdeltproject.org/api/v2/doc/doc?${params.toString()}`;
}

function pickDomain(article) {
  return article?.domain || (() => {
    try { return new URL(article?.url).hostname; } catch { return ""; }
  })();
}

function clusterArticles(articles) {
  const clusters = new Map();

  for (const a of articles) {
    const title = a?.title || "";
    const url = a?.url || "";
    if (!title || !url) continue;

    const key = normalizeTitleToKey(title);
    const dom = pickDomain(a);

    if (!clusters.has(key)) {
      clusters.set(key, {
        key,
        hard: hardImpact(title),
        domains: new Set(),
        items: [],
      });
    }

    const c = clusters.get(key);
    c.domains.add(dom);
    c.items.push(a);
    if (hardImpact(title)) c.hard = true;
  }

  // Преобразуем к массиву, сортируем кластеры по “силі” + свежести
  const out = [];
  for (const c of clusters.values()) {
    c.items.sort((x, y) => String(y?.seendate || "").localeCompare(String(x?.seendate || "")));
    const top = c.items[0];
    out.push({
      key: c.key,
      hard: c.hard,
      domainCount: c.domains.size,
      top,
      domains: Array.from(c.domains).slice(0, 6),
    });
  }

  out.sort((a, b) => {
    // сначала hard, потом по количеству доменов, потом по дате
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    if (a.domainCount !== b.domainCount) return b.domainCount - a.domainCount;
    return String(b.top?.seendate || "").localeCompare(String(a.top?.seendate || ""));
  });

  return out;
}

// -------------------- Telegram --------------------
async function tgSendMessage(htmlText) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: NEWS_CHAT_ID,
    text: htmlText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (Number.isFinite(NEWS_THREAD_ID)) {
    body.message_thread_id = NEWS_THREAD_ID;
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const msg = data?.description || `HTTP ${res.status}`;
    throw new Error(`Telegram sendMessage failed: ${msg}`);
  }
}

// -------------------- main run --------------------
async function runOnce() {
  if (!BOT_TOKEN) throw new Error("BOT_TOKEN/TELEGRAM_BOT_TOKEN not set");
  if (!NEWS_CHAT_ID) throw new Error("NEWS_CHAT_ID not set");

  const state = loadState();

  const gdeltUrl = buildGdeltUrl();
  const json = await fetchJson(gdeltUrl);

  const articles = Array.isArray(json?.articles) ? json.articles : [];
  if (!articles.length) {
    state.lastRunIso = new Date().toISOString();
    saveState(state);
    return;
  }

  const clusters = clusterArticles(articles);

  const picked = [];
  for (const c of clusters) {
    const min = c.hard ? NEWS_MIN_SOURCES_HARD : NEWS_MIN_SOURCES;
    if (c.domainCount < min) continue;

    // дедуп: по ключу кластера + топ url
    const dedupKey = `${c.key}::${c.top?.url || ""}`;
    if (state.sentKeys[dedupKey]) continue;

    picked.push({ ...c, dedupKey });
    if (picked.length >= NEWS_MAX_PER_RUN) break;
  }

  for (const p of picked) {
    const a = p.top;
    const title = escapeHtml(a.title);
    const link = escapeHtml(a.url);
    const when = escapeHtml(a.seendate || "");
    const domains = escapeHtml(p.domains.join(", "));

    const text =
      `<b>${title}</b>\n` +
      `<i>${domains}</i>\n` +
      `<code>${when} UTC</code>\n` +
      `<a href="${link}">Открыть источник</a>`;

    await tgSendMessage(text);
    state.sentKeys[p.dedupKey] = Date.now();

    // мягкая пауза, чтобы не упереться в лимиты
    await sleep(1200);
  }

  // чистим старые ключи (чтобы файл не рос бесконечно)
  const keys = Object.entries(state.sentKeys).sort((a, b) => b[1] - a[1]);
  state.sentKeys = Object.fromEntries(keys.slice(0, 800));

  state.lastRunIso = new Date().toISOString();
  saveState(state);
}

function startScheduler() {
  // сразу один запуск, затем по интервалу
  runOnce().catch((e) => console.error("[GDELT] runOnce error:", e?.message || e));

  const ms = NEWS_INTERVAL_MIN * 60 * 1000;
  setInterval(() => {
    runOnce().catch((e) => console.error("[GDELT] runOnce error:", e?.message || e));
  }, ms);
}

module.exports = { runOnce, startScheduler };

// Если запустили как отдельный скрипт (cron) — отработать 1 раз и выйти
if (require.main === module) {
  runOnce()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
