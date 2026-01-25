const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");

const app = express();

// Принимаем всё как текст (TradingView часто шлёт plain text), JSON тоже поддержим
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

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

// ---------- Telegram send queue (важно для 429) ----------
const queue = [];
let processing = false;

// безопасная скорость: ~1 сообщение/сек в один чат (уменьшает 429)
const MIN_DELAY_MS = Number(process.env.TG_MIN_DELAY_MS || 1100);

async function sendWithRetry(job, attempt = 1) {
  const { threadId, message, parseMode } = job;

  const options = { parse_mode: parseMode || "Markdown" };
  if (threadId) options.message_thread_id = threadId;

  try {
    await bot.sendMessage(chatId, message, options);
  } catch (err) {
    const code = err?.response?.body?.error_code;
    const params = err?.response?.body?.parameters;

    // 429: Telegram просит подождать retry_after секунд
    if (code === 429 && params?.retry_after && attempt <= 5) {
      const waitMs = params.retry_after * 1000 + 250;
      console.warn(`TG 429. retry_after=${params.retry_after}s. attempt=${attempt}`);
      await sleep(waitMs);
      return sendWithRetry(job, attempt + 1);
    }

    // сетевые/временные ошибки — повторим пару раз
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
//                          GDELT NEWS INTEGRATION
// =====================================================================

// Включение/настройки
const NEWS_ENABLED = String(process.env.NEWS_ENABLED || "1") === "1";
const NEWS_INTERVAL_MIN = Number(process.env.NEWS_INTERVAL_MIN || 10); // каждые 10 минут
const NEWS_TIMESPAN = process.env.NEWS_TIMESPAN || "2h"; // окно поиска, например 1h/2h/6h
const NEWS_MAX_PER_RUN = Number(process.env.NEWS_MAX_PER_RUN || 2); // максимум постов за запуск
const NEWS_MIN_SOURCES = Number(process.env.NEWS_MIN_SOURCES || 3); // минимально уникальных доменов на событие
const NEWS_MIN_SOURCES_HARD = Number(process.env.NEWS_MIN_SOURCES_HARD || 1); // для "тяжёлых" событий
const NEWS_SOURCELANG = (process.env.NEWS_SOURCELANG || "english").trim(); // english / russian / etc

// whitelist доменов (опционально). Пример: reuters.com,bbc.co.uk,apnews.com,aljazeera.com
const NEWS_DOMAINS = (process.env.NEWS_DOMAINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Ключ API для ручного триггера /news/poll (чтобы чужие не дергали)
const NEWS_POLL_KEY = process.env.NEWS_POLL_KEY || "";

// Где хранить дедуп (файл). Для “чтобы не спамить” в рамках одного инстанса достаточно.
// Если хотите переживать рестарты надежно — лучше Redis/SQLite, но это уже следующий шаг.
const NEWS_STATE_FILE = path.join(process.cwd(), "gdelt_state.json");

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
  const entries = Object.entries(state.sent || {});
  for (const [k, ts] of entries) {
    if (!ts || ts < cutoff) delete state.sent[k];
  }
}

// “тяжёлые” события — можно постить даже при 1 источнике
function isHardImpact(title) {
  const t = String(title || "").toLowerCase();
  return /nuclear|radiological|missile|airstrike|air strike|chemical attack|coup|martial law|state of emergency|tsunami|earthquake|internet shutdown/.test(
    t
  );
}

// Нормализация заголовка для грубого “кластера” (чтобы 10 статей = 1 событие)
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

function formatSeenDateUTC(seendate) {
  // Обычно seendate приходит как YYYYMMDDHHMMSS
  const s = String(seendate || "");
  if (!/^\d{14}$/.test(s)) return s || "unknown";
  const yyyy = s.slice(0, 4);
  const mm = s.slice(4, 6);
  const dd = s.slice(6, 8);
  const HH = s.slice(8, 10);
  const MI = s.slice(10, 12);
  const SS = s.slice(12, 14);
  return `${yyyy}-${mm}-${dd} ${HH}:${MI}:${SS} UTC`;
}

async function fetchJsonWithTimeout(url, timeoutMs = 15000) {
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

// Запрос по умолчанию (геополитика/кризисы)
const DEFAULT_GDELT_QUERY = `(
  "state of emergency" OR "martial law" OR coup OR "military takeover" OR
  missile OR missiles OR "air strike" OR airstrike OR drone OR drones OR
  nuclear OR radiological OR "chemical attack" OR
  sanctions OR "export controls" OR blockade OR
  "internet shutdown" OR "power outage" OR blackout OR
  earthquake OR tsunami OR "volcanic eruption"
)`;

const GDELT_QUERY = (process.env.GDELT_QUERY || DEFAULT_GDELT_QUERY).replace(/\s+/g, " ").trim();

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
      domains: Array.from(c.domains).filter(Boolean).slice(0, 6),
    });
  }

  out.sort((a, b) => {
    if (a.hard !== b.hard) return a.hard ? -1 : 1;
    if (a.domainCount !== b.domainCount) return b.domainCount - a.domainCount;
    return String(b.top?.seendate || "").localeCompare(String(a.top?.seendate || ""));
  });

  return out;
}

let newsRunning = false;

async function pollGdeltAndSend() {
  if (newsRunning) return;
  newsRunning = true;

  try {
    const state = loadNewsState();
    cleanupNewsState(state, 72);

    const url = buildGdeltUrl();
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

      const dedupKey = `${c.key}::${c.top?.url || ""}`;
      if (state.sent[dedupKey]) continue;

      toSend.push({ ...c, dedupKey });
      if (toSend.length >= NEWS_MAX_PER_RUN) break;
    }

    for (const item of toSend) {
      const a = item.top;

      const title = escapeHtml(a?.title || "Untitled");
      const link = escapeHtml(a?.url || "");
      const when = escapeHtml(formatSeenDateUTC(a?.seendate));
      const domains = escapeHtml(item.domains.join(", ") || pickDomain(a) || "source");

      const msg =
        `<b>🌍 Global Alert</b>\n` +
        `<b>${title}</b>\n` +
        `<i>${domains}</i>\n` +
        `<code>${when}</code>\n` +
        (link ? `<a href="${link}">Open source</a>` : "");

      // ВАЖНО: отправляем в топик news
      enqueue({
        threadId: TOPICS.news,
        message: msg,
        parseMode: "HTML",
      });

      state.sent[item.dedupKey] = Date.now();
      await sleep(250); // чуть разнести (очередь и так ограничит)
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
    `[NEWS] scheduler enabled. interval=${NEWS_INTERVAL_MIN}m timespan=${NEWS_TIMESPAN} minSources=${NEWS_MIN_SOURCES}/${NEWS_MIN_SOURCES_HARD}`
  );

  // первый запуск сразу
  pollGdeltAndSend().catch(() => {});

  // затем по интервалу
  setInterval(() => {
    pollGdeltAndSend().catch(() => {});
  }, NEWS_INTERVAL_MIN * 60 * 1000);
}

// Ручной триггер (удобно для Render Cron Job). Защищаем ключом.
app.post("/news/poll", (req, res) => {
  const key = req.headers["x-api-key"] || req.query.key || "";
  if (NEWS_POLL_KEY && key !== NEWS_POLL_KEY) {
    return res.status(403).send("Forbidden");
  }
  res.status(200).send("OK");
  pollGdeltAndSend().catch(() => {});
});

// =====================================================================

// ---------- routes ----------
app.get("/", (req, res) => res.send("Trading Alerts Bot is running!"));

app.post("/webhook", (req, res) => {
  // ВАЖНО: сразу отвечаем TradingView 200 OK (чтобы не терять алерты на таймауте)
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

  // Сразу ack
  res.status(200).send("OK");

  const message = buildMessage(req.body);
  enqueue({ threadId, message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewsScheduler(); // запуск GDELT-новостей
});
