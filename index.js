const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const app = express();

// Важно: text() должен идти ДО json(), чтобы корректно принимать и "сырой" текст
app.use(express.text({ type: "*/*" }));
app.use(express.json({ limit: "1mb" }));

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);

// chat_id супергруппы
const chatId = process.env.TELEGRAM_CHAT_ID;

// Ваши темы (message_thread_id)
const TOPICS = {
  "1m": 150,
  "5m": 152,
  "15m": 154,
};

// Унифицированная сборка текста (поддерживает и текст, и JSON)
function buildMessage(body) {
  if (typeof body === "string") {
    const text = body.trim();
    return `🚨 *Trading Alert*\n\n${text || "(empty body)"}`;
  }

  // Если вдруг прилетел JSON (даже если вы не можете его настраивать — оставим поддержку)
  const data = body || {};
  let msg = `🚨 *Trading Alert*\n\n`;
  msg += `📊 *Ticker:* ${data.ticker || data.symbol || "N/A"}\n`;
  msg += `💰 *Price:* ${data.price || data.close || "N/A"}\n`;
  msg += `📝 *Action:* ${data.action || data.side || data.signal || "N/A"}\n`;
  if (data.message) msg += `\n🔔 ${data.message}`;
  return msg;
}

// Отправка в Telegram с опциональным topic threadId
async function sendToTelegram({ threadId, message }) {
  const options = { parse_mode: "Markdown" };
  if (threadId) options.message_thread_id = threadId;
  return bot.sendMessage(chatId, message, options);
}

app.get("/", (req, res) => {
  res.send("Trading Alerts Bot is running!");
});

// Общий webhook (если вдруг хотите слать в General без темы)
app.post("/webhook", async (req, res) => {
  try {
    const message = buildMessage(req.body);
    await sendToTelegram({ threadId: null, message });
    res.status(200).send("OK");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Webhook под конкретную тему: /webhook/1m, /webhook/5m, /webhook/15m
app.post("/webhook/:tf", async (req, res) => {
  try {
    const tf = String(req.params.tf || "").toLowerCase();
    const threadId = TOPICS[tf];

    if (!threadId) {
      return res
        .status(400)
        .send(`Unknown tf "${tf}". Allowed: ${Object.keys(TOPICS).join(", ")}`);
    }

    const message = buildMessage(req.body);
    await sendToTelegram({ threadId, message });

    res.status(200).send("OK");
  } catch (err) {
    res.status(500).send(err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
