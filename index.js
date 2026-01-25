const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const app = express();
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

const TOPICS = {
  "5m": 152,
  "15m": 525,
  "rsi4h": 538,
  "risk": 625,
  "fibo": 658,
  "btcvol": 684,
  "news": 703,
};

// ---------------- Telegram queue ----------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const queue = [];
let processing = false;
const MIN_DELAY_MS = Number(process.env.TG_MIN_DELAY_MS || 1100);

async function sendWithRetry(job, attempt = 1) {
  const options = { parse_mode: job.parseMode || "HTML" };
  if (job.disablePreview) options.disable_web_page_preview = true;
  if (job.threadId) options.message_thread_id = job.threadId;

  try {
    await bot.sendMessage(chatId, job.message, options);
  } catch (err) {
    const code = err?.response?.body?.error_code;
    const params = err?.response?.body?.parameters;

    if (code === 429 && params?.retry_after && attempt <= 5) {
      await sleep(params.retry_after * 1000 + 250);
      return sendWithRetry(job, attempt + 1);
    }
    const msg = String(err?.message || err);
    const isTransient = msg.includes("ETIMEDOUT") || msg.includes("ECONNRESET") || msg.includes("EAI_AGAIN") || msg.includes("socket hang up");
    if (isTransient && attempt <= 3) {
      await sleep(800 * attempt);
      return sendWithRetry(job, attempt + 1);
    }
    console.error("TG send failed:", err?.response?.body || msg);
  }
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const job = queue.shift();
    await sendWithRetry(job);
    await sleep(MIN_DELAY_MS);
  }
  processing = false;
}

function enqueue(job) {
  queue.push(job);
  processQueue().catch(e => console.error("Queue processing error:", e));
}

// ---------------- Alerts ----------------
function buildMessage(body) {
  if (typeof body === "string") {
    const text = body.trim();
    return `🚨 <b>Trading Alert</b>\n\n${escapeHtml(text || "(empty body)")}`;
  }
  const d = body || {};
  let msg = `🚨 <b>Trading Alert</b>\n\n`;
  msg += `📊 <b>Ticker:</b> ${escapeHtml(d.ticker || d.symbol || "N/A")}\n`;
  msg += `💰 <b>Price:</b> ${escapeHtml(d.price || d.close || "N/A")}\n`;
  msg += `📝 <b>Action:</b> ${escapeHtml(d.action || d.side || d.signal || "N/A")}\n`;
  if (d.message) msg += `\n🔔 ${escapeHtml(d.message)}`;
  return msg;
}

// ---------------- News config ----------------
const NEWS_ENABLED = String(process.env.NEWS_ENABLED || "1") === "1";
const NEWS_INTERVAL_MIN = Number(process.env.NEWS_INTERVAL_MIN || 10);
const NEWS_TIMESPAN = process.env.NEWS_TIMESPAN || "24h";
const NEWS_MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 3);
const NEWS_AI_MAX_PER_RUN = Number(process.env.NEWS_AI_MAX_PER_RUN || NEWS_MAX_PER_RUN);
const NEWS_MIN_SOURCES = Number(process.env.NEWS_MIN_SOURCES || 1);
const NEWS_DISABLE_PREVIEW = String(process.env.NEWS_DISABLE_PREVIEW || "0") === "1";

const NEWS_DOMAINS = (process.env.NEWS_DOMAINS || "").split(",").map(s => s.trim()).filter(Boolean);
const NEWS_SOURCELANG_LIST = (process.env.NEWS_SOURCELANG || "").split(",").map(s => s.trim()).filter(Boolean);

const GDELT_QUERY = (process.env.GDELT_QUERY || `(missile OR airstrike OR invasion OR sanctions OR coup OR emergency)`)
  .replace(/\s+/g, " ").trim();

const NLP_URL = (process.env.NLP_URL || "").trim();
const NLP_API_KEY = (process.env.NLP_API_KEY || "").trim();

// дедуп
const sent = new Map();
function cleanupSent(ttlHours = 48) {
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  for (const [k, ts] of sent.entries()) if (ts < cutoff) sent.delete(k);
}

// helpers
function formatSeenDateUTC(seendate) {
  const s = String(seendate || "");
  if (!/^\d{14}$/.test(s)) return s || "unknown";
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)} ${s.slice(8,10)}:${s.slice(10,12)}:${s.slice(12,14)} UTC`;
}
function pickDomain(a) {
  if (a?.domain) return a.domain;
  try { return new URL(a?.url).hostname; } catch { return ""; }
}
function normalizeTitleToKey(title) {
  const stop = new Set(["the","a","an","and","or","to","of","in","on","for","with","as","at","by","from","after","before","over","under","into","amid","says","say","said","update","live","breaking","report","reports"]);
  const tokens = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length >= 4 && !stop.has(w));
  tokens.sort();
  return tokens.slice(0, 12).join("_");
}

function clusterArticles(articles) {
  const clusters = new Map();
  for (const a of articles) {
    const title = a?.title || "";
    const url = a?.url || "";
    if (!title || !url) continue;

    const key = normalizeTitleToKey(title);
    const dom = pickDomain(a);

    if (!clusters.has(key)) clusters.set(key, { key, domains: new Set(), items: [] });
    const c = clusters.get(key);
    c.domains.add(dom);
    c.items.push(a);
  }

  const out = [];
  for (const c of clusters.values()) {
    c.items.sort((x, y) => String(y?.seendate || "").localeCompare(String(x?.seendate || "")));
    out.push({
      key: c.key,
      domainCount: c.domains.size,
      top: c.items[0],
      domains: Array.from(c.domains).filter(Boolean).slice(0, 10),
    });
  }

  out.sort((a, b) => {
    if (a.domainCount !== b.domainCount) return b.domainCount - a.domainCount;
    return String(b.top?.seendate || "").localeCompare(String(a.top?.seendate || ""));
  });

  return out;
}

function buildGdeltUrl() {
  let q = GDELT_QUERY;

  if (NEWS_SOURCELANG_LIST.length && !/sourcelang:/i.test(q)) {
    const block = NEWS_SOURCELANG_LIST.map(l => `sourcelang:${l}`).join(" OR ");
    q += ` (${block})`;
  }

  if (NEWS_DOMAINS.length && !/domainis:/i.test(q)) {
    const domBlock = NEWS_DOMAINS.map(d => `domainis:${d}`).join(" OR ");
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

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`GDELT HTTP ${res.status}: ${text.slice(0, 200)}`);
    try { return JSON.parse(text); } catch { throw new Error(`GDELT non-JSON: ${text.slice(0, 200)}`); }
  } finally {
    clearTimeout(t);
  }
}

// чтение статьи: Readability + fallback r.jina.ai
const UA = process.env.NEWS_UA || "Mozilla/5.0 (NewsBot)";

function clampText(s, max = 16000) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + " …";
}

async function fetchArticleReadability(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" },
    });
    const html = await res.text();
    const dom = new JSDOM(html, { url });

    let parsed = null;
    try { parsed = new Readability(dom.window.document).parse(); } catch {}

    const title = parsed?.title || dom.window.document.title || "";
    const text = clampText(parsed?.textContent || "", 16000);
    const excerpt = clampText(parsed?.excerpt || "", 2000);

    return { title, text, excerpt };
  } finally {
    clearTimeout(t);
  }
}

async function fetchArticleJina(url, timeoutMs = 20000) {
  // r.jina.ai отдаёт текстовую “читабельную” версию страницы
  const target = `https://r.jina.ai/${url}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(target, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/plain,*/*" },
    });
    const text = await res.text();
    return clampText(text, 16000);
  } finally {
    clearTimeout(t);
  }
}

async function getArticle(url) {
  const minChars = Number(process.env.NEWS_ARTICLE_MIN_CHARS || 800);

  // 1) Readability
  let a = { title: "", text: "", excerpt: "" };
  try { a = await fetchArticleReadability(url, 20000); } catch {}

  // 2) Если текста мало — fallback jina
  if ((a.text || "").length < minChars) {
    try {
      const t = await fetchArticleJina(url, 20000);
      if (t && t.length > (a.text || "").length) a.text = t;
    } catch {}
  }

  return a;
}

// NLP call (timeout + лог ошибок)
async function callNlp(payload) {
  if (!NLP_URL) return null;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);

  try {
    const res = await fetch(NLP_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        ...(NLP_API_KEY ? { "x-api-key": NLP_API_KEY } : {}),
      },
      body: JSON.stringify(payload),
    });

    const raw = await res.text();
    if (!res.ok) throw new Error(`NLP HTTP ${res.status}: ${raw.slice(0, 200)}`);

    try { return JSON.parse(raw); }
    catch { throw new Error(`NLP non-JSON: ${raw.slice(0, 200)}`); }
  } finally {
    clearTimeout(t);
  }
}

function tagsToHashtags(tags) {
  if (!Array.isArray(tags)) return "";
  const cleaned = tags
    .map(t => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 8)
    .map(t => "#" + t.replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_]/gu, ""));
  return cleaned.join(" ");
}

function formatNewsMessage({ header, title, summary, tags, domains, when, link }) {
  const h = escapeHtml(header || "События • Мир");
  const t = escapeHtml(title || "Новость");
  const s = escapeHtml(summary || "");
  const d = escapeHtml(domains || "");
  const w = escapeHtml(when || "");
  const l = escapeHtml(link || "");

  let msg = `💥 <b>${h}</b>\n<b>${t}</b>\n\n`;
  if (s) msg += `${s}\n\n`;
  const ht = tagsToHashtags(tags);
  if (ht) msg += `${escapeHtml(ht)}\n\n`;
  msg += `📰 <i>${d}</i>\n`;
  msg += `🕒 <code>${w}</code>\n`;
  if (l) msg += `🔗 <a href="${l}">Открыть источник</a>`;
  return msg;
}

let newsRunning = false;
let lastGdeltFetch = 0;

async function pollGdeltAndSend() {
  if (newsRunning) return;
  newsRunning = true;

  try {
    cleanupSent(48);

    // защита от слишком частых ручных вызовов (GDELT 429)
    if (Date.now() - lastGdeltFetch < 6000) return;
    lastGdeltFetch = Date.now();

    const url = buildGdeltUrl();
    console.log("[NEWS] GDELT url:", url);

    const json = await fetchJsonWithTimeout(url, 20000);
    const articles = Array.isArray(json?.articles) ? json.articles : [];
    if (!articles.length) return;

    const clusters = clusterArticles(articles);

    const chosen = [];
    for (const c of clusters) {
      if (c.domainCount < NEWS_MIN_SOURCES) continue;
      const a = c.top;
      const dedupKey = `${c.key}::${a?.url || ""}`;
      if (sent.has(dedupKey)) continue;

      chosen.push({ c, a, dedupKey });
      if (chosen.length >= NEWS_MAX_PER_RUN) break;
    }

    let aiUsed = 0;

    for (const item of chosen) {
      const a = item.a;
      const link = a?.url || "";
      const when = formatSeenDateUTC(a?.seendate);
      const domains = item.c.domains.join(", ") || pickDomain(a) || "source";

      // По умолчанию: fallback формат (без AI)
      let header = "События • Мир";
      let title = a?.title || "News";
      let summary = "";
      let tags = [];

      // AI: обрабатываем до NEWS_AI_MAX_PER_RUN
      if (aiUsed < NEWS_AI_MAX_PER_RUN) {
        try {
          const article = link ? await getArticle(link) : { title: "", text: "", excerpt: "" };

          const ai = await callNlp({
            title: article.title || a?.title || "",
            text: article.text || "",
            snippet: article.excerpt || "",
          });

          if (ai) {
            header = ai.header_ru || header;
            title = ai.title_ru || title;
            summary = ai.summary_ru || "";
            tags = ai.tags || [];
          }

          aiUsed += 1;
        } catch (e) {
          console.warn("[NEWS] NLP failed:", e?.message || e);
        }
      }

      const msg = formatNewsMessage({ header, title, summary, tags, domains, when, link });

      enqueue({
        threadId: TOPICS.news,
        message: msg,
        parseMode: "HTML",
        disablePreview: NEWS_DISABLE_PREVIEW,
      });

      sent.set(item.dedupKey, Date.now());
      await sleep(250);
    }
  } catch (e) {
    console.error("[NEWS] poll error:", e?.message || e);
  } finally {
    newsRunning = false;
  }
}

function startNewsScheduler() {
  if (!NEWS_ENABLED) {
    console.log("[NEWS] disabled");
    return;
  }
  console.log(`[NEWS] scheduler enabled. interval=${NEWS_INTERVAL_MIN}m timespan=${NEWS_TIMESPAN}`);
  pollGdeltAndSend().catch(() => {});
  setInterval(() => pollGdeltAndSend().catch(() => {}), NEWS_INTERVAL_MIN * 60 * 1000);
}

// ---------------- routes ----------------
app.get("/", (req, res) => res.send("Trading Alerts Bot is running!"));

app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  enqueue({ threadId: null, message: buildMessage(req.body), parseMode: "HTML" });
});

app.post("/webhook/:tf", (req, res) => {
  const tf = String(req.params.tf || "").toLowerCase();
  const threadId = TOPICS[tf];
  if (!threadId) return res.status(400).send(`Unknown tf "${tf}". Allowed: ${Object.keys(TOPICS).join(", ")}`);
  res.status(200).send("OK");
  enqueue({ threadId, message: buildMessage(req.body), parseMode: "HTML" });
});

app.get("/news/test", (req, res) => {
  enqueue({ threadId: TOPICS.news, message: "🧪 TEST: бот пишет в топик NEWS", parseMode: "HTML" });
  res.send("OK");
});

app.post("/news/poll", (req, res) => {
  res.status(200).send("OK");
  pollGdeltAndSend().catch(() => {});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewsScheduler();
});
