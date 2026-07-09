const protobuf = require("../app/protobuf");

/**
 * newLikesStore
 * -------------
 * جایگزین منطق پراکنده‌ای که قبلاً مستقیم در index.js برای نگهداری
 * newLikesArrayFromRedis و نوشتنِ فوریِ آن در Redis (به‌ازای هر لایک/حذف)
 * وجود داشت.
 *
 * طبق تصمیم‌مان، سمت پردازنده همچنان آرایه است (نه Map)، چون اینجا نیازی
 * به دسترسی O(1) بر اساس telegramId به‌اندازه‌ی سمت ربات حیاتی نیست
 * (پردازش‌ها دسته‌ای/دوره‌ای هستند، نه در مسیر واکنش لحظه‌ای به کاربر).
 *
 * تفاوت اصلی با نسخه‌ی قبلی:
 *   - دیگر به‌ازای هر job بلافاصله در Redis نوشته نمی‌شود؛ تغییرات فقط روی
 *     آرایه‌ی درون‌حافظه‌ای اعمال و یک isDirty ست می‌شود.
 *   - یک flush دوره‌ای (startPeriodicFlush) فقط وقتی چیزی تغییر کرده باشد
 *     (isDirty) آرایه را انکود و در Redis ذخیره می‌کند.
 *   - بارگذاری از Redis هم فقط یک‌بار در startup انجام می‌شود، نه هر ۱۰
 *     ثانیه؛ چون از این پس پردازنده تنها writer نهایی Redis است و pull
 *     دوره‌ای از روی Redis می‌توانست تغییرات تازه‌ی خودِ پردازنده را که
 *     هنوز flush نشده‌اند overwrite کند.
 */

const NEW_LIKES_KEY = "newLikes";

let newLikesArray = [];
let isDirty = false;

/** بارگذاری اولیه‌ی آرایه از Redis. فقط یک‌بار در startup صدا زده شود. */
async function loadFromRedis(redisClient) {
  try {
    const getData = await redisClient.getBuffer(NEW_LIKES_KEY);
    if (!Buffer.isBuffer(getData)) return;

    await protobuf.loadNewLikeProto();
    const decodedMessage = protobuf.NewLikeProto.decode(getData);
    newLikesArray = decodedMessage.users || [];
    isDirty = false;

    console.log(
      `[newLikesStore] بارگذاری اولیه انجام شد. تعداد کاربران دارای لایک: ${newLikesArray.length}`,
    );
  } catch (error) {
    console.error(
      "[newLikesStore] خطا در بارگذاری اولیه از Redis:",
      error,
    );
  }
}

/** دسترسی مستقیم به آرایه (reference زنده -- برای مصرف‌کننده‌هایی مثل checkNewLikesForSendNotif) */
function getArray() {
  return newLikesArray;
}

/**
 * اضافه کردن یک لایک جدید به آرایه (معادل منطق قبلی داخل newLikeQueueController).
 * targetTelegramId: کسی که لایک را دریافت کرده
 * liker: آبجکت کاربر لایک‌کننده
 * message: پیام اختیاری همراه لایک
 */
function addLike(targetTelegramId, liker, message) {
  const id = Number(targetTelegramId);
  if (!Number.isFinite(id) || !liker) return;

  let strMessage = "";
  try {
    strMessage = message ? message.toString() : "";
  } catch (e) {}

  const likerEntry = {
    _id: liker._id,
    telegramId: Number(liker.telegramId),
    fullName: liker.fullName,
    userName: liker.userName,
    age: liker.age,
    gender: liker.gender,
    lookingFor: liker.lookingFor,
    state: liker.state,
    sleep: liker.sleep,
    bio: liker.bio,
    profileImages: liker.profileImages,
    inviteCode: liker.inviteCode,
    platform: liker.platform,
    fcmToken: liker.fcmToken,
    message: strMessage || "",
  };

  const findLike = newLikesArray.find(
    (f) => Number(f.telegramId) === id,
  );

  if (findLike) {
    const findLiker = findLike.likers.find(
      (f) => Number(f.telegramId) === Number(liker.telegramId),
    );
    if (!findLiker) {
      findLike.likers.push(likerEntry);
      findLike.time = Date.now();
    }
  } else {
    newLikesArray.push({
      telegramId: id,
      time: Date.now(),
      likers: [likerEntry],
    });
  }

  isDirty = true;
}

/**
 * حذف یک لایک‌کننده‌ی مشخص از صف لایک‌های یک کاربر.
 * برخلاف سمت ربات که همیشه "نفر اول" را حذف می‌کند، اینجا حذف بر اساس
 * likerTelegramId دقیق انجام می‌شود (نه صرفاً shift) تا در صورت هر جور
 * اختلاف ترتیب احتمالی بین دو سرور، عملیات idempotent و درست باقی بماند.
 * برمی‌گرداند: true اگر چیزی واقعاً حذف شد.
 */
function removeLike(targetTelegramId, likerTelegramId) {
  const id = Number(targetTelegramId);
  const likerId = Number(likerTelegramId);

  const findLike = newLikesArray.find(
    (f) => Number(f.telegramId) === id,
  );
  if (!findLike || !Array.isArray(findLike.likers)) return false;

  const beforeLength = findLike.likers.length;
  findLike.likers = findLike.likers.filter(
    (f) => Number(f.telegramId) !== likerId,
  );

  const removed = findLike.likers.length !== beforeLength;
  if (removed) {
    findLike.time = Date.now();
    isDirty = true;
  }

  return removed;
}

/**
 * حذف تمام لایک‌های در انتظار یک کاربر («رد کردن همه» که از سمت ربات
 * با فلگ clearAll در همان removeFromNewLikesQueue اعلام می‌شود).
 * هم‌راستا با removeLike، فقط likers را خالی می‌کند (نه حذف کامل entry)
 * تا رفتار با بقیه‌ی توابع یکدست بماند.
 * برمی‌گرداند: true اگر چیزی واقعاً پاک شد.
 */
function clearAll(targetTelegramId) {
  const id = Number(targetTelegramId);
  const findLike = newLikesArray.find(
    (f) => Number(f.telegramId) === id,
  );
  if (
    !findLike ||
    !Array.isArray(findLike.likers) ||
    findLike.likers.length === 0
  ) {
    return false;
  }

  findLike.likers = [];
  findLike.time = Date.now();
  isDirty = true;

  return true;
}

/**
 * حذف چند کاربر به‌طور کامل از آرایه (معادل usersToRemoveSet قدیمی در
 * checkNewLikesForSendNotif -- کاربرانی که لایک‌هایشان خیلی قدیمی شده یا
 * ربات را بلاک کرده‌اند).
 */
function removeUsers(telegramIdsSet) {
  if (!telegramIdsSet || telegramIdsSet.size === 0) return;

  const before = newLikesArray.length;
  newLikesArray = newLikesArray.filter(
    (u) => !telegramIdsSet.has(Number(u?.telegramId)),
  );

  if (newLikesArray.length !== before) {
    isDirty = true;
  }
}

/** انکود و ذخیره‌ی آرایه در Redis، فقط اگر چیزی تغییر کرده باشد (مگر force=true) */
async function flushToRedis(redisClient, force = false) {
  if (!force && !isDirty) return false;

  try {
    await protobuf.loadNewLikeProto();

    const errMsg = protobuf.NewLikeProto.verify({
      users: newLikesArray,
    });
    if (errMsg) {
      console.error(
        "[newLikesStore] خطای اعتبارسنجی protobuf:",
        errMsg,
      );
      return false;
    }

    const message_ = protobuf.NewLikeProto.create({
      users: newLikesArray,
    });
    const buffer = protobuf.NewLikeProto.encode(message_).finish();
    await redisClient.set(NEW_LIKES_KEY, buffer);
    isDirty = false;
    return true;
  } catch (error) {
    console.error(
      "[newLikesStore] خطا در flush کردن به Redis:",
      error,
    );
    return false;
  }
}

/**
 * راه‌اندازی flush دوره‌ای. فقط یک‌بار در startup صدا زده شود.
 * پیش‌فرض هر ۱۵ ثانیه، و فقط وقتی isDirty باشد واقعاً در Redis می‌نویسد.
 */
function startPeriodicFlush(redisClient, intervalMs = 15000) {
  return setInterval(async () => {
    try {
      await flushToRedis(redisClient, false);
    } catch (error) {
      console.error("[newLikesStore] خطا در flush دوره‌ای:", error);
    }
  }, intervalMs);
}

module.exports = {
  loadFromRedis,
  getArray,
  addLike,
  removeLike,
  clearAll,
  removeUsers,
  flushToRedis,
  startPeriodicFlush,
};
