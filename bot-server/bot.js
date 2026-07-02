const { Telegraf } = require("telegraf");
let bot;
if (process.env.PLATFORM == "bale") {
  bot = new Telegraf(
    process.env.BALE_BOT_TOKEN,
    // "53189952:WhZI2fkLl9D6nyu3jguJ01xCme-jqyAD6ZQ", // تست
    {
      telegram: { apiRoot: "https://tapi.bale.ai/bot" },
    },
  );
} else {
  bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
}
module.exports = bot;
