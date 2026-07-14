const blockedUsers = require("../utils/blockedUsers");

const reply = async (
  ctx,
  next,
  redisClient,
  text,
  keyborad,
  inline_keyborad,
) => {
  const telegramId = ctx?.from?.id;
  try {
    await ctx.reply(text, {
      reply_markup: {
        keyboard: keyborad,
        inline_keyboard: inline_keyborad,
        resize_keyboard: true,
        one_time_keyboard: false,
        is_persistent: true,
      },
    });
  } catch (error) {
    if (
      error?.response &&
      error?.response?.error_code === 403 &&
      error?.response?.description ===
        "Forbidden: bot was blocked by the user"
    ) {
      console.log(
        `User ${telegramId} blocked the bot. Not processing /start command.`,
      );
      console.log({ myMessage: text });
      console.log({ userMessage: ctx?.message?.text });
      try {
        await redisClient.sadd("blocked_users", String(telegramId));
        blockedUsers.add(String(telegramId));
        return next();
      } catch (error) {
        console.log(error);
      }
    } else if (error?.response && error?.response?.error_code === 400) {
      console.log(`Invalid reply chat_id: ${telegramId}. Likely doesn't exist.`);
      
    } else {
      console.error(
        `Error handling /start for user ${telegramId}:`,
        error,
      );
      // ممکن است بخواهید یک پیام خطای عمومی به کاربر بفرستید، اما اگر بلاک کرده باشد، خطا می‌دهد
      // try { await ctx.reply("مشکلی در پردازش دستور /start رخ داد."); } catch {}
    }
  } finally {
  }
};

module.exports = { reply };
