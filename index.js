const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(express.text());

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN);
const chatId = process.env.TELEGRAM_CHAT_ID;

app.get('/', (req, res) => {
  res.send('Trading Alerts Bot is running!');
});

app.post('/webhook', (req, res) => {
  let message;
  
  if (typeof req.body === 'string') {
    // Если пришёл просто текст
    message = `🚨 *Trading Alert*\n\n${req.body}`;
  } else {
    // Если пришёл JSON
    const data = req.body;
    message = `🚨 *Trading Alert*\n\n`;
    message += `📊 *Ticker:* ${data.ticker || 'N/A'}\n`;
    message += `💰 *Price:* ${data.price || 'N/A'}\n`;
    message += `📈 *Action:* ${data.action || 'N/A'}\n`;
    if (data.message) {
      message += `\n💬 ${data.message}`;
    }
  }

  bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    .then(() => res.status(200).send('OK'))
    .catch(err => res.status(500).send(err.message));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
