const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

const app = express();

// Принимаем всё как текст (TradingView часто шлёт plain text), JSON тоже поддержим
app.use(express.text({ type: "*/*", limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));

// -------------------- TELEGRAM --------------------
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
const chatId = process.env.TELEGRAM_CHAT_ID; // "-100...."

const TOPICS = {
  "5m": 152,
  "15m": 525,
  "rsi4h": 538,
  "risk": 625,
  "fibo": 658,
  "btcvol": 684,
  "news": 703,
  "etf": 1241,
};

// ---------- helpers ----------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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

// ---------- Telegram send queue (важно для 429) ----------
const queue = [];
let processing = false;

// безопасная скорость: ~1 сообщение/сек в один чат (уменьшает 429)
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

    if (code === 429 && params?.retry_after && attempt <= 6) {
      const waitMs = params.retry_after * 1000 + 350;
      console.warn(`TG 429 retry_after=${params.retry_after}s attempt=${attempt}`);
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
      console.warn(`TG transient error attempt=${attempt}: ${msg}`);
      await sleep(900 * attempt);
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

// -------------------- NEWS / GDELT --------------------
function envBool(name, def) {
  const v = String(process.env[name] ?? "").trim();
  if (!v) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}
function envInt(name, def) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : def;
}
function envStr(name, def) {
  const v = String(process.env[name] ?? "").trim();
  return v ? v : def;
}

const NEWS_ENABLED = envBool("NEWS_ENABLED", true);
const NEWS_INTERVAL_MIN = envInt("NEWS_INTERVAL_MIN", 10);
const NEWS_TIMESPAN = envStr("NEWS_TIMESPAN", "24h"); // 2h / 6h / 24h
const NEWS_MAX_PER_RUN = envInt("NEWS_MAX_PER_RUN", 1);
const NEWS_MIN_SOURCES = envInt("NEWS_MIN_SOURCES", 1);
const NEWS_MIN_SOURCES_HARD = envInt("NEWS_MIN_SOURCES_HARD", 1);

const NEWS_SOURCELANGS = envStr("NEWS_SOURCELANG", "english")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// домены whitelist (опционально) — если пусто, берём любые
const NEWS_DOMAINS = envStr("NEWS_DOMAINS", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ручной триггер /news/poll
const NEWS_POLL_KEY = envStr("NEWS_POLL_KEY", "");

// AI / NLP (твой news-nlp)
const NEWS_AI_ENABLED = envBool("NEWS_AI_ENABLED", true);
const NEWS_AI_MAX_PER_RUN = envInt("NEWS_AI_MAX_PER_RUN", NEWS_MAX_PER_RUN); // ВАЖНО: поставь >= NEWS_MAX_PER_RUN
const NLP_URL = envStr("NLP_URL", ""); // пример: http://138.124.69.96:8787/nlp
const NLP_API_KEY = envStr("NLP_API_KEY", "");
const NLP_TIMEOUT_MS = envInt("NLP_TIMEOUT_MS", 65000);

// чтение статей
const NEWS_FETCH_FULL = envBool("NEWS_FETCH_FULL", true);
const NEWS_ARTICLE_TIMEOUT_MS = envInt("NEWS_ARTICLE_TIMEOUT_MS", 25000);
const NEWS_ARTICLE_MAX_CHARS = envInt("NEWS_ARTICLE_MAX_CHARS", 12000);

const NEWS_DISABLE_PREVIEW = envBool("NEWS_DISABLE_PREVIEW", false);

// дедуп (Render FS может быть эфемерной, но в рамках инстанса спасает от спама)
const NEWS_STATE_FILE = path.join(process.cwd(), "gdelt_state.json");

function loadNewsState() {
  try {
    const raw = fs.readFileSync(NEWS_STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s.sent) s.sent = {};
    if (!s.lastGdeltAt) s.lastGdeltAt = 0;
    return s;
  } catch {
    return { sent: {}, lastRunIso: null, lastGdeltAt: 0 };
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
  return /nuclear|radiological|missile|airstrike|air strike|chemical attack|coup|martial law|state of emergency|tsunami|earthquake|internet shutdown|blackout|power outage/.test(
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

function formatSeenDateUTC(seendate) {
  const s = String(seendate || "");
  if (!/^\d{14}$/.test(s)) return s || "unknown";
  const yyyy = s.slice(0, 4);
  const mm = s.slice(4, 6);
  const dd = s.slice(6, 8);
  const HH = s.slice(8, 10);
  const MI = s.slice(10, 12);
  return `${yyyy}-${mm}-${dd} ${HH}:${MI} UTC`;
}

function tagsToHashtags(tags) {
  if (!Array.isArray(tags)) return "";
  const out = [];
  for (const t of tags) {
    const s = String(t || "")
      .toLowerCase()
      .replace(/[^\wа-яё]+/gi, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    if (s.length >= 2) out.push(`#${s}`);
    if (out.length >= 8) break;
  }
  return out.join(" ");
}

async function fetchText(url, timeoutMs, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": opts.ua || "Mozilla/5.0 (NewsBot/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 140)}`);
    return text;
  } finally {
    clearTimeout(t);
  }
}

async function fetchJson(url, timeoutMs) {
  const raw = await fetchText(url, timeoutMs);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Non-JSON from GDELT: ${raw.slice(0, 180)}`);
  }
}

async function extractArticle(url) {
  const html = await fetchText(url, NEWS_ARTICLE_TIMEOUT_MS, {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  });

  const clipped = html.length > 2_000_000 ? html.slice(0, 2_000_000) : html;
  const dom = new JSDOM(clipped, { url });
  const reader = new Readability(dom.window.document);
  const parsed = reader.parse();

  const text = String(parsed?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();

  return {
    title: parsed?.title || "",
    excerpt: parsed?.excerpt || "",
    text,
  };
}

async function callNlp({ title, snippet }) {
  if (!NEWS_AI_ENABLED) return null;
  if (!NLP_URL) throw new Error("NLP_URL is empty");
  if (!NLP_API_KEY) throw new Error("NLP_API_KEY is empty");

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), NLP_TIMEOUT_MS);

  try {
    const res = await fetch(NLP_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": NLP_API_KEY,
      },
      body: JSON.stringify({
        title,
        snippet,                 // ВАЖНО: news-nlp ожидает "snippet"
        target_lang: "ru",       // если твой сервер это поддерживает — ок, если нет — проигнорирует
        style: "news_summary",   // опционально
        min_sentences: 3,        // опционально
        max_sentences: 6,        // опционально
      }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`NLP HTTP ${res.status}: ${text.slice(0, 200)}`);

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`NLP non-JSON: ${text.slice(0, 200)}`);
    }
    return data;
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

const GDELT_QUERY_BASE = envStr("GDELT_QUERY", DEFAULT_GDELT_QUERY);

function buildGdeltQuery() {
  let q = `(${GDELT_QUERY_BASE.replace(/\s+/g, " ").trim()})`;

  if (NEWS_SOURCELANGS.length) {
    const langBlock = NEWS_SOURCELANGS.map((l) => `sourcelang:${l}`).join(" OR ");
    q += ` AND (${langBlock})`;
  }

  if (NEWS_DOMAINS.length) {
    const domBlock = NEWS_DOMAINS.map((d) => `domain:${d}`).join(" OR ");
    q += ` AND (${domBlock})`;
  }

  return q;
}

function buildGdeltUrl() {
  const params = new URLSearchParams({
    query: buildGdeltQuery(),
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

let newsRunning = false;

async function pollGdeltAndSend() {
  if (newsRunning) return;
  newsRunning = true;

  try {
    const state = loadNewsState();
    cleanupNewsState(state, 72);

    // анти-429: не чаще 1 раза в 6 сек
    const minGapMs = envInt("NEWS_GDELT_MIN_GAP_MS", 6000);
    if (Date.now() - (state.lastGdeltAt || 0) < minGapMs) {
      console.log("[NEWS] skip: too frequent (anti-429)");
      return;
    }

    const url = buildGdeltUrl();
    console.log("[NEWS] GDELT url:", url);

    state.lastGdeltAt = Date.now();
    saveNewsState(state);

    const json = await fetchJson(url, 25000);
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

      const dedupKey = `${c.key}`; // дедуп по событию (не по url)
      if (state.sent[dedupKey]) continue;

      toSend.push({ ...c, dedupKey });
      if (toSend.length >= NEWS_MAX_PER_RUN) break;
    }

    let aiUsed = 0;

    for (const item of toSend) {
      const a = item.top;
      const srcUrl = String(a?.url || "");
      const srcTitle = String(a?.title || "Untitled");
      const when = formatSeenDateUTC(a?.seendate);
      const domains = item.domains.join(", ") || pickDomain(a) || "source";

      // 1) пытаемся получить текст статьи
      let longText = "";
      let excerpt = "";

      if (NEWS_FETCH_FULL && srcUrl) {
        try {
          const art = await extractArticle(srcUrl);
          excerpt = art.excerpt || "";
          if (art.text && art.text.length > 200) {
            longText = art.text;
          }
        } catch (e) {
          console.warn("[NEWS] article parse failed:", e?.message || e);
        }
      }

      // fallback: если нет полного текста, дадим хотя бы заголовок/кусок
      let snippet = longText || excerpt || srcTitle;
      snippet = snippet.replace(/\s+/g, " ").trim();
      if (snippet.length > NEWS_ARTICLE_MAX_CHARS) snippet = snippet.slice(0, NEWS_ARTICLE_MAX_CHARS);

      // 2) AI обработка (перевод+выжимка+теги)
      let ai = null;
      if (NEWS_AI_ENABLED && aiUsed < NEWS_AI_MAX_PER_RUN) {
        try {
          ai = await callNlp({ title: srcTitle, snippet });
          aiUsed++;
        } catch (e) {
          console.warn("[NEWS] NLP failed:", e?.message || e);
        }
      }

      const titleRu = ai?.title_ru ? String(ai.title_ru) : "";
      const summaryRu = ai?.summary_ru ? String(ai.summary_ru) : "";
      const tags = Array.isArray(ai?.tags) ? ai.tags : [];
      const hashtags = tagsToHashtags(tags);

      // 3) формируем красивое сообщение (HTML)
      const header = `<b>🌍 События • Мир</b>`;
      const titleLine = `<b>${escapeHtml(titleRu || srcTitle)}</b>`;
      const summaryBlock = summaryRu ? `\n\n${escapeHtml(summaryRu)}` : "";
      const tagLine = hashtags ? `\n\n<i>${escapeHtml(hashtags)}</i>` : "";
      const domainLine = `\n\n🗞 <code>${escapeHtml(domains)}</code>`;
      const timeLine = `\n🕒 <code>${escapeHtml(when)}</code>`;
      const linkLine = srcUrl ? `\n🔗 <a href="${escapeHtml(srcUrl)}">Открыть источник</a>` : "";

      const msg = `${header}\n${titleLine}${summaryBlock}${tagLine}${domainLine}${timeLine}${linkLine}`;

      enqueue({
        threadId: TOPICS.news,
        message: msg,
        parseMode: "HTML",
        disablePreview: NEWS_DISABLE_PREVIEW,
      });

      state.sent[item.dedupKey] = Date.now();
      saveNewsState(state);

      await sleep(350);
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
    `[NEWS] scheduler enabled interval=${NEWS_INTERVAL_MIN}m timespan=${NEWS_TIMESPAN} minSources=${NEWS_MIN_SOURCES}/${NEWS_MIN_SOURCES_HARD} ai=${NEWS_AI_ENABLED ? 1 : 0}`
  );

  // первый запуск сразу
  pollGdeltAndSend().catch(() => {});

  setInterval(() => {
    pollGdeltAndSend().catch(() => {});
  }, NEWS_INTERVAL_MIN * 60 * 1000);
}

// Ручной триггер (удобно для Cron). Защищаем ключом.
app.post("/news/poll", (req, res) => {
  const key = req.headers["x-api-key"] || req.query.key || "";
  if (NEWS_POLL_KEY && key !== NEWS_POLL_KEY) {
    return res.status(403).send("Forbidden");
  }
  res.status(200).send("OK");
  pollGdeltAndSend().catch(() => {});
});

// тест
app.get("/news/test", (req, res) => {
  enqueue({
    threadId: TOPICS.news,
    message: "<b>🧪 TEST</b>\nБот пишет в топик NEWS",
    parseMode: "HTML",
  });
  res.send("OK");
});

// -------------------- ETF FLOWS (BTC + ETH) --------------------
const ETF_ENABLED = envBool("ETF_ENABLED", true);
const ETF_TIMEZONE = envStr("ETF_TIMEZONE", "Europe/Warsaw");
const ETF_HOUR = envInt("ETF_HOUR", 11);
const ETF_MINUTE = envInt("ETF_MINUTE", 0);

const ETF_BTC_URL = "https://farside.co.uk/bitcoin-etf-flow-all-data/";
const ETF_ETH_URL = "https://farside.co.uk/ethereum-etf-flow-all-data/";

const ETF_STATE_FILE = path.join(process.cwd(), "etf_state.json");

function loadEtfState() {
  try {
    const raw = fs.readFileSync(ETF_STATE_FILE, "utf8");
    const s = JSON.parse(raw);
    if (!s.lastSent) s.lastSent = {};
    return s;
  } catch {
    return { lastSent: {} };
  }
}
function saveEtfState(state) {
  try {
    fs.writeFileSync(ETF_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (e) {
    console.error("[ETF] Failed to save state:", e?.message || e);
  }
}

function parseLatestTotalFromFarsideHtml(html) {
  const dom = new JSDOM(String(html || ""));
  const doc = dom.window.document;

  // Дата вида "29 Jan 2026"
  const dateRe = /^\d{2}\s+[A-Za-z]{3}\s+\d{4}$/;

  // Собираем кандидатов по всем таблицам и выберем ту, где больше всего "дат-строк"
  const tables = Array.from(doc.querySelectorAll("table"));
  if (!tables.length) throw new Error("No tables found on page");

  function extractFromTable(tableEl) {
    const rows = Array.from(tableEl.querySelectorAll("tr"));
    const candidates = [];

    for (const tr of rows) {
      const cells = Array.from(tr.querySelectorAll("th,td"))
        .map((c) => c.textContent.replace(/\u00a0/g, " ").trim());

      if (cells.length < 2) continue;

      const first = cells[0];
      if (!dateRe.test(first)) continue;          // нужна именно строка с датой

      // последняя колонка — Total (на Farside это правый край в этой таблице)
      const totalRaw = cells[cells.length - 1];

      // отсекаем пустое/мусор
      if (!totalRaw) continue;
      if (totalRaw.toLowerCase() === "total") continue;

      // допускаем "-", "(123.4)", "1,234.5", "0.0"
      if (!(totalRaw === "-" || /^-?\(?[\d,]+(\.\d+)?\)?$/.test(totalRaw))) continue;

      candidates.push({ date: first, totalRaw });
    }

    return candidates;
  }

  let best = [];
  for (const t of tables) {
    const c = extractFromTable(t);
    if (c.length > best.length) best = c;
  }

  if (!best.length) {
    throw new Error("Could not find any date rows with Total column (layout changed?)");
  }

  // Берём последнюю опубликованную дату (последняя дата-строка в таблице)
  const last = best[best.length - 1];

  const isDash = last.totalRaw === "-";
  const isSell = !isDash && /^\(.*\)$/.test(last.totalRaw);

  return {
    date: last.date,
    totalRaw: last.totalRaw,
    side: isDash ? "no_data" : (isSell ? "sell" : "buy"),
  };
}


function nowInTzParts(timeZone) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = dtf.formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type)?.value;

  return {
    HH: Number(get("hour")),
    MI: Number(get("minute")),
    ymd: `${get("year")}-${get("month")}-${get("day")}`,
  };
}

function formatFlowMessage({ asset, date, totalRaw, side, sourceUrl }) {
  const emoji = side === "sell" ? "🔴" : side === "buy" ? "🟢" : "⚪️";
  const sideText =
    side === "sell" ? "Продажи" :
    side === "buy" ? "Покупки" :
    "Нет данных";

  return (
    `<b>📊 ${escapeHtml(asset)} ETF Total</b>\n` +
    `Дата: <code>${escapeHtml(date)}</code>\n` +
    `${emoji} <b>${escapeHtml(sideText)} ${escapeHtml(asset)}</b>\n` +
    `Total: <b>${escapeHtml(totalRaw)}</b> (US$m)\n` +
    `Источник: <a href="${escapeHtml(sourceUrl)}">farside.co.uk</a>`
  );
}

async function fetchAndSendFlow({ key, asset, url }, force = false) {
  const state = loadEtfState();

  const html = await fetchText(url, 25000, { ua: "Mozilla/5.0 (ETFBot/1.0)" });
  const data = parseLatestTotalFromFarsideHtml(html);

  const dedupKey = `${data.date}|${data.totalRaw}`;
  if (!force && state.lastSent[key] === dedupKey) {
    console.log(`[ETF] skip already sent ${key}:`, dedupKey);
    return;
  }

  const msg = formatFlowMessage({
    asset,
    date: data.date,
    totalRaw: data.totalRaw,
    side: data.side,
    sourceUrl: url,
  });

  enqueue({
    threadId: TOPICS.etf, // 1241
    message: msg,
    parseMode: "HTML",
    disablePreview: true,
  });

  state.lastSent[key] = dedupKey;
  saveEtfState(state);

  console.log(`[ETF] sent ${key}:`, dedupKey);
}

async function sendEtfDailyReport(force = false) {
  // шлём два сообщения: BTC и ETH
  await fetchAndSendFlow(
    { key: "btc", asset: "BTC", url: ETF_BTC_URL },
    force
  );

  // небольшая пауза чтобы не упереться в лимиты (очередь и так защитит, но пусть будет)
  await sleep(300);

  await fetchAndSendFlow(
    { key: "eth", asset: "ETH", url: ETF_ETH_URL },
    force
  );
}

let etfLoopStarted = false;

function startEtfScheduler() {
  if (!ETF_ENABLED) {
    console.log("[ETF] disabled (ETF_ENABLED!=1)");
    return;
  }
  if (etfLoopStarted) return;
  etfLoopStarted = true;

  console.log(
    `[ETF] scheduler enabled at ${String(ETF_HOUR).padStart(2, "0")}:${String(ETF_MINUTE).padStart(2, "0")} TZ=${ETF_TIMEZONE}`
  );

  setInterval(() => {
    try {
      const t = nowInTzParts(ETF_TIMEZONE);
      if (t.HH === ETF_HOUR && t.MI === ETF_MINUTE) {
        sendEtfDailyReport(false).catch((e) =>
          console.error("[ETF] send error:", e?.message || e)
        );
      }
    } catch (e) {
      console.error("[ETF] loop error:", e?.message || e);
    }
  }, 20000);
}

// ручной запуск (удобно для теста/крона)
app.post("/etf/poll", (req, res) => {
  res.status(200).send("OK");
  sendEtfDailyReport(true).catch((e) =>
    console.error("[ETF] manual poll error:", e?.message || e)
  );
});

// тестовый пост в топик
app.get("/etf/test", (req, res) => {
  enqueue({
    threadId: TOPICS.etf,
    message: "<b>🧪 ETF TEST</b>\nБот пишет в топик ETF",
    parseMode: "HTML",
    disablePreview: true,
  });
  res.send("OK");
});

// -------------------- ROUTES --------------------
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  startNewsScheduler();
  startEtfScheduler();
});
