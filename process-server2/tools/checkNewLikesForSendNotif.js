const { NOTIFICATION_MENU_KEYBOARD } = require("../app/constants");
const { goToNotificationMenu } = require("../config/redis");
const User = require("../models/User");
const { replyBot } = require("../telegram_methods/replyBot");
const blockedUsers = require("../utils/blockedUsers");

const NEW_LIKES_LOCK_KEY = "lock:newLikes:notif";
const LOCK_TTL_SECONDS = 55 * 60; // کمتر از یک ساعت
const CONCURRENCY = 10; // محافظه‌کارانه برای هزاران کاربر

function chunkArray_(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function getTelegramId(user) {
  const id = Number(user?.telegramId);
  return Number.isFinite(id) ? id : null;
}

function countByGender(likers = [], gender) {
  let count = 0;
  for (const liker of likers) {
    if (liker?.gender === gender) count++;
  }
  return count;
}

// خطاهای "قطعی" که می‌توان کاربر را حذف کرد
function isPermanentBotError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  return (
    msg.includes("bot was blocked by the user") ||
    msg.includes("user is deactivated") ||
    msg.includes("chat not found") ||
    msg.includes("403") ||
    msg.includes("400: bad request")
  );
}

// خطاهای موقت که نباید باعث حذف کاربر شوند
function isTransientBotError(err) {
  const msg = String(err?.message || err || "").toLowerCase();

  return (
    msg.includes("timeout") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("429") ||
    msg.includes("too many requests") ||
    msg.includes("network")
  );
}

async function acquireLock(redisClient) {
  try {
    // اگر Redis شما set با NX/EX را پشتیبانی می‌کند
    const result = await redisClient.set(
      NEW_LIKES_LOCK_KEY,
      String(Date.now()),
      "EX",
      LOCK_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  } catch (e) {
    // اگر نتوانستیم lock بگیریم، امن‌تر است اجرا نکنیم
    console.log("Failed to acquire lock:", e);
    return false;
  }
}

async function releaseLock(redisClient) {
  try {
    await redisClient.del(NEW_LIKES_LOCK_KEY);
  } catch (e) {
    console.log("Failed to release lock:", e);
  }
}

async function processSingleUser(
  user,
  usersToRemoveSet,
  redisClient,
) {
  try {
    const telegramId__ = getTelegramId(user);
    if (!telegramId__) return;

    if (!user.time || +user.time + 1209600000 < Date.now()) {
      usersToRemoveSet.add(telegramId__);
      return;
    }

    const numberOfMen = countByGender(user?.likers || [], "male");
    const numberOfWomen = countByGender(user?.likers || [], "female");

    let findUser = await User.findOne({ telegramId: telegramId__ });

    if (
      findUser?.currentStep.step !== "notificationMenu" &&
      findUser?.currentStep.step !== "notifications" &&
      findUser?.currentStep.flow !== "register" &&
      // findUser?.currentStep.step !== "editProfile" &&
      // findUser?.currentStep.step !== "editProfileMenu" &&
      findUser?.currentStep.step !== "notificationSleepMode" &&
      !findUser?.sleep &&
      (numberOfWomen !== 0 || numberOfMen !== 0)
    ) {
      const messageText =
        `${numberOfMen !== 0 ? `${numberOfMen} ${"آقا"}` : ""} ` +
        `${numberOfMen !== 0 && numberOfWomen !== 0 ? "و" : ""} ` +
        `${numberOfWomen !== 0 ? `${numberOfWomen} ${"خانم 💁‍♀️"}` : ""} ` +
        `${"شما را لایک کردند . یه نگاهی بنداز "}.\n\n1. ${"نمایش"}\n2. ${"حالت خواب"}`;

      // try {
      //   if (findUser?.fcmToken) {
      //     await sendNotification({
      //       token: findUser.fcmToken,
      //       title: "لایک جدید دارید !",
      //       body: messageText,
      //       data: {},
      //     });
      //   }
      // } catch (_) {}

      try {
        if (blockedUsers.has(String(telegramId__)))
          return console.log(
            "user is block (check new like for send notif)",
          );
        await replyBot(
          telegramId__,
          redisClient,
          messageText,
          NOTIFICATION_MENU_KEYBOARD,
        );

        if (findUser) {
          findUser.currentStep.flow = "bot";
          findUser.currentStep.step = "notificationMenu";
          await findUser.save();
          goToNotificationMenu.add({
            telegramId: telegramId__,
          });
        }
      } catch (err) {
        // فقط خطاهای قطعی => حذف
        if (isPermanentBotError(err) && !isTransientBotError(err)) {
          usersToRemoveSet.add(telegramId__);
          console.log(
            "Permanent bot error, will remove user:",
            telegramId__,
            err,
          );
        } else {
          // خطای موقتی یا نامشخص => حذف نکن
          console.log(
            "Transient/unknown bot error, user kept:",
            telegramId__,
            err,
          );
        }
      }
    }
  } catch (userError) {
    console.error(
      `Error processing user: ${userError?.message || userError}`,
    );
    // خطای داخلی پردازش => حذف نکن
  }
}

const checkNewLikesForSendNotif = async (
  redisClient,
  newLikesStore,
) => {
  console.log("start checkNewLikesForSendNotif ---------");
  let lockAcquired = false;

  try {
    // قفل توزیع‌شده: اگر (مثلاً به‌خاطر کند بودن اجرای قبلی یا اجرای
    // موازی چند instance) اجرای قبلی هنوز تمام نشده باشد، از این اجرا
    // صرف‌نظر می‌کنیم. نکته: قبلاً این تابع تعریف می‌شد ولی هیچ‌جا صدا
    // زده نمی‌شد، پس عملاً بی‌اثر بود؛ همین‌جا اصلاح شد.
    lockAcquired = await acquireLock(redisClient);
    if (!lockAcquired) {
      console.log(
        "checkNewLikesForSendNotif: قفل قبلاً گرفته شده، این اجرا رد شد.",
      );
      return;
    }

    // به‌جای خواندن مستقل از Redis، از آرایه‌ی درون‌حافظه‌ای newLikesStore
    // استفاده می‌کنیم که همیشه تازه‌ترین نسخه است (پردازنده تنها writer
    // نهایی Redis است، اما بین دو flush دوره‌ای، حافظه از Redis جلوتر است).
    const newLikes = newLikesStore.getArray();

    if (!Array.isArray(newLikes) || newLikes.length === 0) return;

    const usersToRemoveSet = new Set();

    // پردازش با concurrency محدود
    const batches = chunkArray_(newLikes, CONCURRENCY);
    for (const batch of batches) {
      await Promise.all(
        batch.map((user) => {
          const telegramId__ = getTelegramId(user);
          if (blockedUsers.has(String(telegramId__))) return;
          return processSingleUser(
            user,
            usersToRemoveSet,
            redisClient,
          );
        }),
      );
    }

    // فقط اگر حذف قطعی داریم، newLikesStore را آپدیت کن (خودش دوره‌ای
    // flush می‌کند، نیازی به نوشتن فوری در Redis نیست)
    if (usersToRemoveSet.size > 0) {
      newLikesStore.removeUsers(usersToRemoveSet);

      console.log(
        `Removed ${usersToRemoveSet.size} users from newLikes list:`,
        Array.from(usersToRemoveSet),
      );
    }
  } catch (error) {
    console.log("Main interval error:", error);
  } finally {
    if (lockAcquired) {
      await releaseLock(redisClient);
    }
  }
};

module.exports = { checkNewLikesForSendNotif };
