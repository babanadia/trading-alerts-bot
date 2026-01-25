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

function escapeAttr(str) {
  // для href и подобных атрибутов
  return escapeHtml(String(str || "")).replace(/"/g, "&quot;");
}

// ---------- Telegram send queue (важно для 429) ----------
const queue = [];
let processing = false;

// безопасная скорость: ~1 сообщение/сек в один чат (уменьшает 429)
const MIN_DELAY_MS = Number(process.env.TG_MIN_DELAY_MS || 1100);

async function sendWithRetry(job, attempt = 1) {
  const { threadId, message, parseMode } = job;

  const options = { parse_mode: parseMode || "Markdown" };
  if (job.disablePreview) options.disable_web_page_preview = true;
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
//                          NLP (перевод/выжимка)
// =====================================================================

const NLP_URL = String(process.env.NLP_URL || "").trim();              // например: http://138.124.69.96:8787/nlp
const NLP_API_KEY = String(process.env.NLP_API_KEY || "").trim();      // ваш x-api-key
const NLP_ENABLED = String(process.env.NLP_ENABLED || "1") === "1" && NLP_URL && NLP_API_KEY;
const NLP_TIMEOUT_MS = Number(process.env.NLP_TIMEOUT_MS || 15000);

// сколько новостей за один poll прогонять через NLP (чтобы не грузить VPS)
const NEWS_AI_MAX_PER_RUN = Number(process.env.NEWS_AI_MAX_PER_RUN || 2);

async function fetchTextWithTimeout(url, options = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

async function nlpRu({ title, snippet }) {
  if (!NLP_ENABLED) return null;

  try {
    const { res, text } = await fetchTextWithTimeout(
      NLP_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": NLP_API_KEY,
        },
        body: JSON.stringify({ title, snippet }),
      },
      NLP_TIMEOUT_MS
    );

    if (!res.ok) {
      console.warn("[NEWS][NLP] HTTP", res.status, text.slice(0, 200));
      return null;
    }

    try {
      return JSON.parse(text); // {title_ru, summary_ru, tags}
    } catch {
      console.warn("[NEWS][NLP] non-JSON:", text.slice(0, 200));
      return null;
    }
  } catch (e) {
    console.warn("[NEWS][NLP] failed:", e?.message || e);
    return null;
  }
}

function buildPrettyNewsHtml({ title, titleRu, summaryRu, tags, domains, when, link }) {
  const lines = [];

  lines.push(`<b>🌍 Глобальные события</b>`);
  lines.push(`<b>${escapeHtml(titleRu || title || "Без заголовка")}</b>`);

  if (summaryRu) lines.push(`📝 ${escapeHtml(summaryRu)}`);

  if (Array.isArray(tags) && tags.length) {
    const tagLine = tags.slice(0, 3).map((t) => String(t || "").trim()).filter(Boolean).join(", ");
    if (tagLine) lines.push(`🏷 ${escapeHtml(tagLine)}`);
  }

  if (domains) lines.push(`🗞 <i>${escapeHtml(domains)}</i>`);
  if (when) lines.push(`⏱ <code>${escapeHtml(when)}</code>`);

  if (link) lines.push(`🔗 <a href="${escapeAttr(link)}">Открыть источник</a>`);

  return lines.join("\n");
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

// можно: "english" или "english,russian"
const NEWS_SOURCELANG_RAW = String(process.env.NEWS_SOURCELANG || "english").trim();

// whitelist доменов (опционально). Пример: reuters.com,bbc.co.uk,apnews.com,aljazeera.com
const NEWS_DOMAINS = (process.env.NEWS_DOMAINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// отключать превью по умолчанию (карточки)
const NEWS_DISABLE_PREVIEW = String(process.env.NEWS_DISABLE_PREVIEW || "1") === "1";

// Ключ API для ручного триггера /news/poll (чтобы чужие не дергали)
const NEWS_POLL_KEY = process.env.NEWS_POLL_KEY || "";

// Где хранить дедуп (файл).
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

// Нормализация заголовка для грубого “кластера”
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

async function fetchJsonWithTimeout(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: ctrl.signal });

    // Важно: сначала читаем как текст
    const text = await res.text();

    if (!res.ok) {
      throw new Error(`GDELT HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GDELT returned non-JSON: ${text.slice(0, 200)}`);
    }
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

  // --- sourcelang: поддержка "english,russian"
  const langs = NEWS_SOURCELANG_RAW
    .split(/[,\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (langs.length === 1) {
    q += ` sourcelang:${langs[0]}`;
  } else if (langs.length > 1) {
    // скобки только если есть OR (иначе GDELT ругается)
    q += ` (${langs.map((l) => `sourcelang:${l}`).join(" OR ")})`;
  }

  // --- domains: скобки только если доменов > 1
  if (NEWS_DOMAINS.length === 1) {
    q += ` domainis:${NEWS_DOMAINS[0]}`;
  } else if (NEWS_DOMAINS.length > 1) {
    const domBlock = NEWS_DOMAINS.map((d) => `domainis:${d}`).join(" OR ");
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

      const dedupKey = `${c.key}::${c.top?.url || ""}`;
      if (state.sent[dedupKey]) continue;

      toSend.push({ ...c, dedupKey });
      if (toSend.length >= NEWS_MAX_PER_RUN) break;
    }

    let aiUsed = 0;

    for (const item of toSend) {
      const a = item.top;

      const titleRaw = String(a?.title || "Untitled");
      const linkRaw = String(a?.url || "");
      const whenRaw = formatSeenDateUTC(a?.seendate);
      const domainsRaw = item.domains.join(", ") || pickDomain(a) || "source";

      // Если у статьи есть описание/контекст — используйте его как snippet (если нет — пусть будет пусто)
      const snippetRaw =
        String(a?.description || a?.summary || a?.context || a?.snippet || "").trim();

      let ai = null;
      if (NLP_ENABLED && aiUsed < NEWS_AI_MAX_PER_RUN) {
        ai = await nlpRu({ title: titleRaw, snippet: snippetRaw });
        aiUsed++;
      }

      const msg = buildPrettyNewsHtml({
        title: titleRaw,
        titleRu: ai?.title_ru,
        summaryRu: ai?.summary_ru,
        tags: ai?.tags,
        domains: domainsRaw,
        when: whenRaw,
        link: linkRaw,
      });

      enqueue({
        threadId: TOPICS.news,
        message: msg,
        parseMode: "HTML",
        disablePreview: NEWS_DISABLE_PREVIEW, // чтобы не было огромных карточек
      });

      state.sent[item.dedupKey] = Date.now();
      await sleep(250);
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
    `[NEWS] scheduler enabled. interval=${NEWS_INTERVAL_MIN}m timespan=${NEWS_TIMESPAN} minSources=${NEWS_MIN_SOURCES}/${NEWS_MIN_SOURCES_HARD} ai=${NLP_ENABLED ? "on" : "off"} aiMax=${NEWS_AI_MAX_PER_RUN}`
  );

  // первый запуск сразу
  pollGdeltAndSend().catch(() => {});

  // затем по интервалу
  setInterval(() => {
    pollGdeltAndSend().catch(() => {});
  }, NEWS_INTERVAL_MIN * 60 * 1000);
}

// Ручной триггер. Защищаем ключом (если NEWS_POLL_KEY задан).
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

const PORT = process.env.PORT || 3000;

// test
app.get("/news/test", (req, res) => {
  enqueue({
    threadId: TOPICS.news,
    message: "🧪 TEST: бот пишет в топик NEWS",
  });
  res.send("OK");
});
// test

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewsScheduler();
});
