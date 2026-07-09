const protobuf = require("../app/protobuf");

/**
 * newLikesMap
 * -----------
 * جایگزین آرایه‌ی قدیمی newLikesArrayFromRedis.
 *
 * ساختار:
 *   Map<targetTelegramId(number), { time: number, likers: LikerObject[] }>
 *
 * چرا Map؟
 *   دسترسی به لایک‌های یک کاربر خاص (بر اساس telegramId) از O(n) (find روی آرایه)
 *   به O(1) کاهش پیدا می‌کند. این کار هم در مسیر لایک کردن (step=search) و هم
 *   در مسیر مرور لایک‌ها (step=notifications) روی هر پیام کاربر اجرا می‌شود، پس
 *   با رشد تعداد کاربران این بهینه‌سازی محسوس خواهد بود.
 *
 * مالکیت داده (ownership):
 *   از این پس سرور ربات دیگر مستقیماً چیزی در کلید Redis "newLikes" نمی‌نویسد.
 *   فقط یک‌بار در startup (قبل از bot.launch) این Map از روی همان کلید پر می‌شود
 *   و از آن به بعد، هر تغییری (اضافه/حذف لایک) هم به‌صورت optimistic روی همین
 *   Map محلی اعمال می‌شود و هم با یک job به صف مربوطه به سرور پردازنده اعلام
 *   می‌شود تا سرور پردازنده (که تنها writer نهایی Redis است) آن را روی آرایه‌ی
 *   خودش و در نهایت روی Redis اعمال کند. به این ترتیب فقط یک نویسنده برای
 *   Redis وجود دارد و race/overwrite بین دو سرور از بین می‌رود.
 */

const newLikesMap = new Map();

/**
 * بارگذاری اولیه‌ی Map از روی بافر protobuf ذخیره‌شده در Redis.
 * فقط باید یک‌بار، قبل از bot.launch صدا زده شود.
 */
async function loadNewLikesMapFromRedis(redisClient) {
  try {
    const getData = await redisClient.getBuffer("newLikes");
    if (!Buffer.isBuffer(getData)) return;

    await protobuf.loadNewLikeProto();
    const decodedMessage = protobuf.NewLikeProto.decode(getData);
    const users = decodedMessage.users || [];

    newLikesMap.clear();
    for (const user of users) {
      const id = Number(user.telegramId);
      if (!Number.isFinite(id)) continue;
      newLikesMap.set(id, {
        time: Number(user.time) || Date.now(),
        likers: Array.isArray(user.likers) ? [...user.likers] : [],
      });
    }

    console.log(
      `[newLikesMap] بارگذاری اولیه انجام شد. تعداد کاربران دارای لایک: ${newLikesMap.size}`,
    );
  } catch (error) {
    console.error(
      "[newLikesMap] خطا در بارگذاری اولیه از Redis:",
      error,
    );
  }
}

/** خواندن entry کامل یک کاربر (یا undefined) */
function getEntry(telegramId) {
  return newLikesMap.get(Number(telegramId));
}

/** خواندن لیست لایک‌کننده‌های یک کاربر (همیشه آرایه، هرچند خالی) */
function getLikers(telegramId) {
  const entry = newLikesMap.get(Number(telegramId));
  return entry?.likers || [];
}

/**
 * اضافه کردن یک لایک جدید به Map محلی.
 * targetTelegramId: کسی که لایک را دریافت کرده
 * liker: آبجکت کاربر لایک‌کننده
 * message: پیام اختیاری همراه لایک
 * برمی‌گرداند: true اگر واقعاً اضافه شد، false اگر تکراری بود (نادیده گرفته شد)
 */
function addLike(targetTelegramId, liker, message) {
  const id = Number(targetTelegramId);
  if (!Number.isFinite(id) || !liker) return false;

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

  const existing = newLikesMap.get(id);
  if (existing) {
    const alreadyLiked = existing.likers.some(
      (f) => Number(f.telegramId) === Number(liker.telegramId),
    );
    if (alreadyLiked) return false;

    existing.likers.push(likerEntry);
    existing.time = Date.now();
  } else {
    newLikesMap.set(id, {
      time: Date.now(),
      likers: [likerEntry],
    });
  }

  return true;
}

/**
 * حذف اولین لایک‌کننده از صف لایک‌های یک کاربر (همان رفتار list.shift() قبلی،
 * چون UI فعلی همیشه نفر اول صف را نشان می‌دهد و بعد از 💚/❌ حذفش می‌کند).
 * برمی‌گرداند: { removed, remainingLikers } یا null اگر چیزی برای حذف نبود.
 */
function removeFirstLike(targetTelegramId) {
  const id = Number(targetTelegramId);
  const entry = newLikesMap.get(id);
  if (
    !entry ||
    !Array.isArray(entry.likers) ||
    entry.likers.length === 0
  ) {
    return null;
  }

  const removed = entry.likers.shift();
  entry.time = Date.now();

  return { removed, remainingLikers: entry.likers };
}

/**
 * حذف تمام لایک‌های در انتظار یک کاربر («رد کردن همه»).
 * برخلاف removeFirstLike که یکی‌یکی حذف می‌کند، این تابع کل صف لایک‌های
 * یک کاربر را یک‌جا خالی می‌کند. توجه: این کار فقط لیست «لایک‌های در
 * انتظار نمایش» را پاک می‌کند، نه سابقه‌ی receivedLikes در Mongo — دقیقاً
 * همان محدوده‌ای که ❌ (رد کردن تکی) هم قبلاً پاک می‌کرد.
 * برمی‌گرداند: تعداد لایک‌هایی که پاک شدند (برای نمایش/لاگ).
 */
function clearAll(targetTelegramId) {
  const id = Number(targetTelegramId);
  const entry = newLikesMap.get(id);
  if (
    !entry ||
    !Array.isArray(entry.likers) ||
    entry.likers.length === 0
  ) {
    return 0;
  }

  const removedCount = entry.likers.length;
  entry.likers = [];
  entry.time = Date.now();

  return removedCount;
}

module.exports = {
  newLikesMap,
  loadNewLikesMapFromRedis,
  getEntry,
  getLikers,
  addLike,
  removeFirstLike,
  clearAll,
};
