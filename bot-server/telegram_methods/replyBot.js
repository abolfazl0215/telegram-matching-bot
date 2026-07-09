const bot = require("../bot");
const blockedUsers = require("../utils/blockedUsers");

const replyBot = async (
  id,
  redisClient,
  text,
  keyborad,
  inline_keyborad,
) => {
  try {
    if (!id) return;
    await bot.telegram.sendMessage(+id, text, {
      reply_markup: {
        keyboard: keyborad,
        inline_keyboard: inline_keyborad,
        resize_keyboard: true,
        one_time_keyboard: false,
        is_persistent: true,
      },
    });
  } catch (error) {
    if (error?.response?.error_code === 404) {
      console.log("user not found reply bot :", id);
      try {
        // کاربرانی که از ربات قبلی به ربات جدید نیامده اند
        await redisClient.sadd("blocked_users", String(id));
        blockedUsers.add(String(id));
        return;
      } catch (error_) {
        console.log(error_);
      }
      console.log(error);
    }
    if (
      error?.response &&
      error?.response?.error_code === 403 &&
      error?.response?.description ===
        "Forbidden: bot was blocked by the user"
    ) {
      // console.log(
      //   `User ${id} blocked the bot. Not processing /start command.`,
      // );
      // console.log({ myMessageBot: text });
      try {
        await redisClient.sadd("blocked_users", String(id));
        blockedUsers.add(String(id));
        // return next();
        return;
      } catch (error) {
        console.log(error);
      }
    } else if (
      error?.response &&
      error?.response.error_code === 400
    ) {
      console.log(
        `Invalid chat_id: ${id}. Likely doesn't exist.`,
      );
      try {
        await redisClient.sadd("blocked_users", String(id));
        blockedUsers.add(String(id));
        // return next();
        return;
      } catch (error) {
        console.log(error);
      }
    } else {
      console.error(`Error handling /start for user ${id}:`, error);
      // ممکن است بخواهید یک پیام خطای عمومی به کاربر بفرستید، اما اگر بلاک کرده باشد، خطا می‌دهد
      // try { await ctx.reply("مشکلی در پردازش دستور /start رخ داد."); } catch {}
    }
  } finally {
  }
};

module.exports = { replyBot };
