const { redisClient } = require("../config/redis");
const { pool, poolUsersById } = require("../data/pool");
const User = require("../models/User");
// FIX #3 (perf): computeScore رو اینجا import می‌کنیم چون حالا baseScore
// به‌صورت پیش‌محاسبه‌شده (cache) در زمان fillPool ساخته میشه، نه در هر request.
const { computeScore } = require("./computeScore");

// فقط فیلدهایی که واقعاً در ادامه (matching/scoring) استفاده می‌شوند از دیتابیس خوانده می‌شوند
const POOL_USER_PROJECTION = {
  fullName: 1,
  userName: 1,
  telegramId: 1,
  inviteCode: 1,
  age: 1,
  gender: 1,
  lookingFor: 1,
  state: 1,
  bio: 1,
  lastActivity: 1,
  createdAt: 1,
  picScore: 1,
  sleep: 1,
  fcmToken: 1,
  platform: 1,
  subscriptionExpireTime: 1,
  profileCompletedPercent: 1,
  ageRange: 1,
  profileImages: 1,
  receivedLikes: 1,
  likedByMe: 1,
  matches: 1,
};

/**
 * یک بخش (province+gender) را از روی Redis و MongoDB پر می‌کند.
 * ترتیب نهایی آرایه دقیقاً همان ترتیب telegramIds کش‌شده در Redis است.
 * هیچ خطایی throw نمی‌کند؛ در صورت خطا، آرایه آن بخش [] می‌ماند و خطا لاگ می‌شود.
 */
const fillSingleProvinceGenderBucket = async (provinceGenderKey) => {
  try {
    const cachedTelegramIds =
      await redisClient.get(provinceGenderKey);

    if (!cachedTelegramIds) {
      pool[provinceGenderKey] = [];
      return;
    }

    let telegramIds;
    try {
      telegramIds = JSON.parse(cachedTelegramIds);
    } catch (parseErr) {
      console.error(
        `[fillPool] JSON.parse failed for key "${provinceGenderKey}". Raw value:`,
        cachedTelegramIds,
        parseErr,
      );
      pool[provinceGenderKey] = [];
      return;
    }

    if (!Array.isArray(telegramIds) || telegramIds.length === 0) {
      pool[provinceGenderKey] = [];
      return;
    }

    const matchedUsers = await User.find(
      { telegramId: { $in: telegramIds } },
      POOL_USER_PROJECTION,
    );

    // ساخت map برای lookup سریع O(1)
    const userMap = new Map(
      matchedUsers.map((user) => [user.telegramId, user]),
    );

    // بازسازی آرایه دقیقاً به همان ترتیب telegramIds در Redis
    // کاربرهایی که دیگر در DB نیستند یا sleep هستند، فیلتر می‌شوند
    const bucketUsers = telegramIds
      .map((id) => userMap.get(id))
      .filter((user) => user && !user.sleep);

    // ── FIX #3 (perf): پیش‌محاسبه‌ی baseScore ────────────────────────
    // قبلاً computeScore() برای هر candidate، در هر request جداگانه
    // (داخل getMatchCandidates) دوباره محاسبه می‌شد. یعنی با N کاربر
    // همزمان که درخواست candidate می‌دادن، این محاسبه‌ی نسبتاً سنگین
    // (چند حلقه روی receivedLikes/matches) به تعداد N × اندازه‌ی pool
    // اجرا می‌شد و چون این کد synchronous است، event loop رو برای
    // مدت محسوسی بلاک می‌کرد.
    //
    // راه‌حل: چون تمام ورودی‌های computeScore (activity decay,
    // cold-start boost, like window, match rate و ...) بر پایه‌ی
    // ساعت/روز decay می‌شن (نه ثانیه)، می‌تونیم این امتیاز رو فقط
    // یک‌بار در هر چرخه‌ی fillPool (که به‌صورت دوره‌ای صدا زده میشه)
    // محاسبه کنیم و روی خود آبجکت کاربر cache کنیم. دقتش عملاً افت
    // محسوسی نمی‌کنه، ولی بار CPU هر request از
    // O(poolSize × cost(computeScore)) به O(poolSize × O(1)) کاهش پیدا می‌کنه.
    //
    // scoredAt هم برای دیباگ/مانیتورینگ نگه داشته میشه تا در صورت نیاز
    // بشه فهمید baseScore هر user از چه زمانی stale شده.
    const now = Date.now();
    for (const user of bucketUsers) {
      user.baseScore = computeScore(user);
      user.scoredAt = now;
      // FIX #5: تا addToPool بعداً (وقتی همین کاربر state/gender‌اش رو
      // عوض کنه) بتونه bucket قدیمی‌اش رو پیدا و ازش حذفش کنه.
      user._poolKey = provinceGenderKey;
    }

    // ── FIX #4 (invalidation): رفرش poolUsersById هم‌زمان با رفرش bucket ──
    // اول همه‌ی id هایی که قبلاً متعلق به این bucket بودن رو از ایندکس پاک
    // می‌کنیم (چون ممکنه بعضی‌شون دیگه در bucket جدید نباشن — مثلاً به خواب
    // رفته باشن یا از دیتابیس حذف شده باشن)، بعد id های bucket جدید رو ثبت
    // می‌کنیم. این کار از نشتی حافظه (memory leak) در poolUsersById هم
    // جلوگیری می‌کنه.
    const oldBucketArray = pool[provinceGenderKey] ?? [];
    for (const oldUser of oldBucketArray) {
      // فقط اگه هنوز به همین آبجکت قدیمی اشاره می‌کنه پاکش کن؛ اگه یه
      // addToPool لحظه‌ای همین الان یه نسخه‌ی جدیدتر رو جایگزین کرده،
      // نباید اون رو دور بندازیم.
      if (poolUsersById.get(oldUser.telegramId) === oldUser) {
        poolUsersById.delete(oldUser.telegramId);
      }
    }
    for (const user of bucketUsers) {
      poolUsersById.set(user.telegramId, user);
    }

    pool[provinceGenderKey] = bucketUsers;
  } catch (err) {
    console.error(
      `[fillPool] Failed to fill bucket "${provinceGenderKey}":`,
      err,
    );
    // fallback امن: بخش خراب خالی می‌ماند، بقیه بخش‌ها تحت تاثیر قرار نمی‌گیرند
    pool[provinceGenderKey] = [];
  }
};

const fillPool = async () => {
  const provinceGenderKeys = Object.keys(pool);

  // از allSettled استفاده می‌کنیم تا خطای یک بخش باعث متوقف شدن بقیه نشود
  const results = await Promise.allSettled(
    provinceGenderKeys.map((key) =>
      fillSingleProvinceGenderBucket(key),
    ),
  );

  const failedKeys = results
    .map((result, index) =>
      result.status === "rejected" ? provinceGenderKeys[index] : null,
    )
    .filter(Boolean);

  if (failedKeys.length > 0) {
    console.error(
      `[fillPool] ${failedKeys.length} bucket(s) failed unexpectedly:`,
      failedKeys,
    );
  }

  console.log(
    `[fillPool] Done. ${provinceGenderKeys.length - failedKeys.length}/${provinceGenderKeys.length} buckets filled successfully.`,
  );
};

module.exports = {
  fillPool,
};
