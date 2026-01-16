const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// Принимаем всё как текст (TradingView часто шлёт plain text), JSON тоже поддержим
app.use(express.text({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID; // ""

// Темы (message_thread_id)
const TOPICS = {
  "1m": 150,
  "5m": 152,
  "15m": 154,
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

// ---------- Telegram send queue (важно для 429) ----------
const queue = [];
let processing = false;

// безопасная скорость: ~1 сообщение/сек в один чат (уменьшает 429)
const MIN_DELAY_MS = Number(process.env.TG_MIN_DELAY_MS || 1100);

async function sendWithRetry({ threadId, message }, attempt = 1) {
  const options = { parse_mode: "Markdown" };
  if (threadId) options.message_thread_id = threadId;

  try {
    await bot.sendMessage(chatId, message, options);
  } catch (err) {
    const code = err?.response?.body?.error_code;
    const params = err?.response?.body?.parameters;

    // 429: Telegram просит подождать retry_after секунд
    if (code === 429 && params?.retry_after && attempt <= 5) {
      const waitMs = (params.retry_after * 1000) + 250;
      console.warn(`TG 429. retry_after=${params.retry_after}s. attempt=${attempt}`);
      await sleep(waitMs);
      return sendWithRetry({ threadId, message }, attempt + 1);
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
      return sendWithRetry({ threadId, message }, attempt + 1);
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
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
