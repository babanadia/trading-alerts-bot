const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

// Для извлечения текста статьи:
const { Readability } = require("@mozilla/readability");
const { JSDOM } = require("jsdom");

const app = express();

// Принимаем всё как текст (TradingView часто шлёт plain text), JSON тоже поддержим
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID; // "-100...."

// Темы (message_thread_id)
const TOPICS = {
  "5m": 152,
  "15m": 525,
  "rsi4h": 538,
  "risk": 625,
  "fibo": 658,
  "btcvol": 684,
  "news": 703,
};

// ---------- helpers ----------
function buildMessage(body) {
  if (typeof body === "string") {
    const text = body.trim();
    return `🚨 *Trading Alert*\n\n${text || "(empty body)"}`;
  }

  const data = body || {};
  let msg = `🚨 *Trading Alert*\n\n`;
  msg += `📊 *Ticker:* ${data.ticker || data.symbol || "N/A"}\n`;
  msg += `💰 *Price:* ${data.price || data.close || "N/A"}\n`;
  msg += `📝 *Action:* ${data.action || data.side || data.signal || "N/A"}\n`;
  if (data.message) msg += `\n🔔 ${data.message}`;
  return msg;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(str) {
  // для href=""
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateText(s, max) {
  s = String(s || "");
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

// ---------- Telegram send queue (важно для 429) ----------
const queue = [];
let processing = false;

// безопасная скорость: ~1 сообщение/сек в один чат
const MIN_DELAY_MS = Number(process.env.TG_MIN_DELAY_MS || 1100);

async function sendWithRetry(job, attempt = 1) {
  const { threadId, message, parseMode, disablePreview } = job;

  const options = { parse_mode: parseMode || "Markdown" };
  if (disablePreview) options.disable_web_page_preview = true;
  if (threadId) options.message_thread_id = threadId;

  try {
    await bot.sendMessage(chatId, message, options);
  } catch (err) {
    const code = err?.response?.body?.error_code;
    const params = err?.response?.body?.parameters;

    if (code === 429 && params?.retry_after && attempt <= 5) {
      const waitMs = params.retry_after * 1000 + 250;
      console.warn(`TG 429. retry_after=${params.retry_after}s. attempt=${attempt}`);
      await sleep(waitMs);
      return sendWithRetry(job, attempt + 1);
    }

    const msg = String(err?.message || err);
    const isTransient =
      msg.includes("ETIMEDOUT") ||
      msg.includes("ECONNRESET") ||
      msg.includes("EAI_AGAIN") ||
      msg.includes("socket hang up");

    if (isTransient && attempt <= 3) {
      console.warn(`TG transient error. attempt=${attempt}. ${msg}`);
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
  processQueue().catch((e) => console.error("Queue processing error:", e));
}

// =====================================================================
//                          NEWS (GDELT + FULL ARTICLE + NLP)
// =====================================================================

// --- базовые настройки ---
const NEWS_ENABLED = String(process.env.NEWS_ENABLED || "1") === "1";
const NEWS_INTERVAL_MIN = Number(process.env.NEWS_INTERVAL_MIN || 10);
const NEWS_TIMESPAN = String(process.env.NEWS_TIMESPAN || "24h").trim();
const NEWS_MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 1);
const NEWS_MIN_SOURCES = Number(process.env.NEWS_MIN_SOURCES || 1);
const NEWS_MIN_SOURCES_HARD = Number(process.env.NEWS_MIN_SOURCES_HARD || 1);
const NEWS_DISABLE_PREVIEW = String(process.env.NEWS_DISABLE_PREVIEW || "1") === "1";

// языки: "english,russian"
const NEWS_SOURCELANG = String(process.env.NEWS_SOURCELANG || "").trim();

// домены whitelist (опционально): "reuters.com,bbc.co.uk"
const NEWS_DOMAINS = (process.env.NEWS_DOMAINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ручной /news/poll защитить ключом (опционально)
const NEWS_POLL_KEY = process.env.NEWS_POLL_KEY || "";

// дедуп на диске (в рамках одного инстанса)
const NEWS_STATE_FILE = path.join(process.cwd(), "gdelt_state.json");

// анти-спам по запросам к GDELT (защита от 429)
const GDELT_MIN_GAP_MS = Number(process.env.GDELT_MIN_GAP_MS || 5500);
let lastGdeltRequestAt = 0;

// --- вытаскивание полного текста статьи ---
const NEWS_FETCH_FULL = String(process.env.NEWS_FETCH_FULL || "1") === "1";
const NEWS_FULL_MAX_CHARS = Number(process.env.NEWS_FULL_MAX_CHARS || 9000);
const NEWS_FETCH_TIMEOUT_MS = Number(process.env.NEWS_FETCH_TIMEOUT_MS || 15000);
const NEWS_FETCH_MAX_BYTES = Number(process.env.NEWS_FETCH_MAX_BYTES || 900000);
const NEWS_TEXT_MIN_CHARS = Number(process.env.NEWS_TEXT_MIN_CHARS || 400);

// --- NLP (ваш news-nlp на VPS) ---
const NLP_URL = String(process.env.NLP_URL || "").trim(); // например http://IP:8787/nlp
const NLP_API_KEY = String(process.env.NLP_API_KEY || "").trim();
const NEWS_AI_MAX_PER_RUN = Number(process.env.NEWS_AI_MAX_PER_RUN || 1);
const NEWS_AI_ENABLED = String(process.env.NEWS_AI_ENABLED || "1") === "1";

// --- запрос по умолчанию ---
const DEFAULT_GDELT_QUERY = `(missile OR airstrike OR invasion OR sanctions OR coup OR emergency)`;
const GDELT_QUERY = String(process.env.GDELT_QUERY || DEFAULT_GDELT_QUERY).replace(/\s+/g, " ").trim();

function loadNewsState() {
  try {
    const raw = fs.readFileSync(NEWS_STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s.sent) s.sent = {};
    return s;
  } catch {
    return { sent: {}, lastRunIso: null };
  }
}
function saveNewsState(state) {
  try {
    fs.writeFileSync(NEWS_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[NEWS] Failed to save state:", e?.message || e);
  }
}
function cleanupNewsState(state, ttlHours = 72) {
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  for (const [k, ts] of Object.entries(state.sent || {})) {
    if (!ts || ts < cutoff) delete state.sent[k];
  }
}

function isHardImpact(title) {
  const t = String(title || "").toLowerCase();
  return /nuclear|radiological|missile|airstrike|chemical attack|coup|martial law|state of emergency|tsunami|earthquake|internet shutdown|blackout/.test(
    t
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

  tokens.sort();
  return tokens.slice(0, 12).join("_");
}

function pickDomain(article) {
  if (article?.domain) return article.domain;
  try {
    return new URL(article?.url).hostname;
  } catch {
    return "";
  }
}

function pickOneDomain(domainsRaw) {
  const d = String(domainsRaw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return d[0] || "";
}

function guessRegion(title, summary) {
  const t = `${title} ${summary}`.toLowerCase();
  if (t.match(/украин|киев|kiev|ukrain|zelensk/)) return "Украина";
  if (t.match(/росси|москв|russia|kremlin/)) return "Россия";
  if (t.match(/израил|israel|gaza/)) return "Израиль";
  if (t.match(/иран|iran/)) return "Иран";
  if (t.match(/кита|china|beijing/)) return "Китай";
  if (t.match(/сша|usa|u\.s\.|united states|washington/)) return "США";
  if (t.match(/евросоюз|eu|european union|ес\b/)) return "ЕС";
  return "Мир";
}

function guessCategory(title, summary) {
  const t = `${title} ${summary}`.toLowerCase();
  if (t.match(/missile|drone|strike|airstrike|invasion|attack|war|войн|удар|дрон|ракето|вторжен/)) return "⚔️ Конфликт";
  if (t.match(/sanction|tariff|export control|санкц|пошлин|экспорт/)) return "💰 Экономика";
  if (t.match(/earthquake|tsunami|volcan|flood|storm|землетр|цунами|изверж|ураган|пожар/)) return "💥 ЧП";
  if (t.match(/election|parliament|minister|government|президент|министр|правительств|выбор|дипломат/)) return "🏛 Политика";
  return "🌍 События";
}

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 250)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON: ${text.slice(0, 250)}`);
    }
  } finally {
    clearTimeout(t);
  }
}

function buildGdeltQueryFinal() {
  let q = GDELT_QUERY;

  // языки: english,russian -> (sourcelang:english OR sourcelang:russian)
  const langs = NEWS_SOURCELANG
    ? NEWS_SOURCELANG.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  if (langs.length === 1) {
    q += ` AND sourcelang:${langs[0]}`;
  } else if (langs.length > 1) {
    const block = langs.map((l) => `sourcelang:${l}`).join(" OR ");
    q += ` AND (${block})`;
  }

  if (NEWS_DOMAINS.length) {
    const domBlock = NEWS_DOMAINS.map((d) => `domainis:${d}`).join(" OR ");
    q += ` AND (${domBlock})`;
  }

  return q.replace(/\s+/g, " ").trim();
}

function buildGdeltUrl() {
  const q = buildGdeltQueryFinal();
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
        hard: isHardImpact(title),
        domains: new Set(),
        items: [],
      });
    }

    const c = clusters.get(key);
    c.domains.add(dom);
    c.items.push(a);
    if (isHardImpact(title)) c.hard = true;
  }

  const out = [];
  for (const c of clusters.values()) {
    c.items.sort((x, y) => String(y?.seendate || "").localeCompare(String(x?.seendate || "")));
    const top = c.items[0];
    out.push({
      key: c.key,
      hard: c.hard,
      domainCount: c.domains.size,
      top,
      domains: Array.from(c.domains).filter(Boolean).slice(0, 8),
    });
  }

  out.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    if (a.domainCount !== b.domainCount) return b.domainCount - a.domainCount;
    return String(b.top?.seendate || "").localeCompare(String(a.top?.seendate || ""));
  });

  return out;
}

// --- скачивание HTML и извлечение текста статьи ---
async function fetchHtml(url, timeoutMs, maxBytes) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (NewsBot/1.0)",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ru,en;q=0.8",
      },
    });

    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("text/html")) {
      throw new Error(`Not HTML: ${ct || "unknown"}`);
    }

    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const sliced = buf.length > maxBytes ? buf.subarray(0, maxBytes) : buf;
    return sliced.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

async function extractArticleText(url) {
  try {
    const html = await fetchHtml(url, NEWS_FETCH_TIMEOUT_MS, NEWS_FETCH_MAX_BYTES);
    const dom = new JSDOM(html, { url });

    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article || !article.textContent) return null;

    const text = String(article.textContent)
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    if (!text || text.length < NEWS_TEXT_MIN_CHARS) return null;

    return {
      title: article.title || "",
      text: text.slice(0, NEWS_FULL_MAX_CHARS),
    };
  } catch (e) {
    console.warn("[NEWS] extract failed:", e?.message || e);
    return null;
  }
}

// --- вызов вашего NLP ---
async function callNlp({ title, snippet }) {
  if (!NEWS_AI_ENABLED) return null;
  if (!NLP_URL) return null;

  const payload = {
    title: String(title || "").slice(0, 400),
    snippet: String(snippet || "").slice(0, 12000),
  };

  try {
    const res = await fetch(NLP_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(NLP_API_KEY ? { "x-api-key": NLP_API_KEY } : {}),
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`NLP HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`NLP non-JSON: ${text.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("[NEWS] nlp failed:", e?.message || e);
    return null;
  }
}

// --- красивое сообщение ---
function normalizeSummaryToBullets(summaryRu) {
  let s = String(summaryRu || "").trim();
  if (!s) return "";

  // если пришли "- " строки — превращаем в "• "
  const lines = s.split("\n").map(l => l.trim()).filter(Boolean);
  const out = lines.map(l => {
    if (l.startsWith("- ")) return "• " + l.slice(2).trim();
    if (l.startsWith("• ")) return l;
    return l;
  });

  // если всё в одну строку — оставим как есть
  return out.join("\n");
}

function buildPrettyNewsHtml({ title, titleRu, summaryRu, tags, domains, link }) {
  const ruTitle = (titleRu || title || "Без заголовка").trim();
  const summary = normalizeSummaryToBullets(summaryRu);

  const region = guessRegion(ruTitle, summary);
  const cat = guessCategory(ruTitle, summary);

  const oneDomain = pickOneDomain(domains.join(", "));

  // чтобы не упереться в лимит Telegram 4096 — режем разумно
  const safeTitle = truncateText(ruTitle, 240);
  const safeSummary = truncateText(summary, 2500);

  let msg = "";
  msg += `<b>${escapeHtml(cat)} • ${escapeHtml(region)}</b>\n`;
  msg += `<b>${escapeHtml(safeTitle)}</b>\n`;

  if (safeSummary) {
    msg += `\n${escapeHtml(safeSummary)}\n`;
  }

  if (Array.isArray(tags) && tags.length) {
    const tagLine = tags
      .map((t) => String(t || "").trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => "#" + t.replace(/\s+/g, "_"))
      .join(" ");
    if (tagLine) msg += `\n<i>${escapeHtml(tagLine)}</i>\n`;
  }

  if (oneDomain) msg += `\n🗞 <i>${escapeHtml(oneDomain)}</i>\n`;
  if (link) msg += `🔗 <a href="${escapeAttr(link)}">Открыть источник</a>`;

  return msg.trim();
}

let newsRunning = false;

async function pollGdeltAndSend() {
  if (newsRunning) return;
  newsRunning = true;

  try {
    // защита от слишком частых запросов к GDELT (429)
    const now = Date.now();
    if (now - lastGdeltRequestAt < GDELT_MIN_GAP_MS) {
      console.log("[NEWS] skip (cooldown)");
      return;
    }
    lastGdeltRequestAt = now;

    const state = loadNewsState();
    cleanupNewsState(state, 72);

    const url = buildGdeltUrl();
    console.log("[NEWS] GDELT url:", url);

    const json = await fetchJsonWithTimeout(url, 20000);
    const articles = Array.isArray(json?.articles) ? json.articles : [];

    if (!articles.length) {
      state.lastRunIso = new Date().toISOString();
      saveNewsState(state);
      return;
    }

    const clusters = clusterArticles(articles);

    const toSend = [];
    for (const c of clusters) {
      const min = c.hard ? NEWS_MIN_SOURCES_HARD : NEWS_MIN_SOURCES;
      if (c.domainCount < min) continue;

      // дедуп по ключу кластера (а не по url), чтобы не спамило “одно и то же”
      const dedupKey = `${c.key}`;
      if (state.sent[dedupKey]) continue;

      toSend.push({ ...c, dedupKey });
      if (toSend.length >= NEWS_MAX_PER_RUN) break;
    }

    let aiUsed = 0;

    for (const item of toSend) {
      const a = item.top;
      const titleRaw = String(a?.title || "Untitled");
      const linkRaw = String(a?.url || "");
      const domains = item.domains;

      // 1) пытаемся вытащить полный текст статьи
      let articleText = "";
      if (NEWS_FETCH_FULL && linkRaw) {
        const extracted = await extractArticleText(linkRaw);
        if (extracted?.text) articleText = extracted.text;
      }

      // fallback на короткое описание
      const snippetRaw =
        String(a?.description || a?.summary || a?.context || a?.snippet || "").trim();

      const textForNlp = articleText || snippetRaw || titleRaw;

      // 2) NLP (ограничиваем кол-во вызовов за один poll)
      let ai = null;
      if (NEWS_AI_ENABLED && NLP_URL && aiUsed < NEWS_AI_MAX_PER_RUN) {
        ai = await callNlp({ title: titleRaw, snippet: textForNlp });
        aiUsed++;
      }

      // 3) формируем сообщение
      const msg = buildPrettyNewsHtml({
        title: titleRaw,
        titleRu: ai?.title_ru || "",
        summaryRu: ai?.summary_ru || (snippetRaw ? truncateText(snippetRaw, 900) : ""),
        tags: ai?.tags || [],
        domains,
        link: linkRaw,
      });

      enqueue({
        threadId: TOPICS.news,
        message: msg,
        parseMode: "HTML",
        disablePreview: NEWS_DISABLE_PREVIEW,
      });

      state.sent[item.dedupKey] = Date.now();
      await sleep(400);
    }

    state.lastRunIso = new Date().toISOString();
    saveNewsState(state);
  } catch (e) {
    console.error("[NEWS] poll error:", e?.message || e);
  } finally {
    newsRunning = false;
  }
}

// Планировщик внутри сервиса
function startNewsScheduler() {
  if (!NEWS_ENABLED) {
    console.log("[NEWS] disabled (NEWS_ENABLED!=1)");
    return;
  }

  console.log(
    `[NEWS] scheduler enabled. interval=${NEWS_INTERVAL_MIN}m timespan=${NEWS_TIMESPAN} minSources=${NEWS_MIN_SOURCES}/${NEWS_MIN_SOURCES_HARD} fetchFull=${NEWS_FETCH_FULL} ai=${NEWS_AI_ENABLED}`
  );

  // первый запуск сразу
  pollGdeltAndSend().catch(() => {});

  // затем по интервалу
  setInterval(() => {
    pollGdeltAndSend().catch(() => {});
  }, NEWS_INTERVAL_MIN * 60 * 1000);
}

// Ручной триггер. (Если NEWS_POLL_KEY пустой — доступ открыт, если задан — проверяем)
app.post("/news/poll", (req, res) => {
  const key = req.headers["x-api-key"] || req.query.key || "";
  if (NEWS_POLL_KEY && key !== NEWS_POLL_KEY) return res.status(403).send("Forbidden");
  res.status(200).send("OK");
  pollGdeltAndSend().catch(() => {});
});

// ---------- routes ----------
app.get("/", (req, res) => res.send("Trading Alerts Bot is running!"));

app.post("/webhook", (req, res) => {
  res.status(200).send("OK");
  const message = buildMessage(req.body);
  enqueue({ threadId: null, message });
});

app.post("/webhook/:tf", (req, res) => {
  const tf = String(req.params.tf || "").toLowerCase();
  const threadId = TOPICS[tf];

  if (!threadId) {
    return res
      .status(400)
      .send(`Unknown tf "${tf}". Allowed: ${Object.keys(TOPICS).join(", ")}`);
  }

  res.status(200).send("OK");
  const message = buildMessage(req.body);
  enqueue({ threadId, message });
});

// тест
app.get("/news/test", (req, res) => {
  enqueue({
    threadId: TOPICS.news,
    message: "🧪 TEST: бот пишет в топик NEWS",
  });
  res.send("OK");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewsScheduler();
});
