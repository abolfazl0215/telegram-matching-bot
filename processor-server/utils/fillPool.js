const { redisClient } = require("../config/redis");
const { pool } = require("../data/pool");
const User = require("../models/User");

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
    pool[provinceGenderKey] = telegramIds
      .map((id) => userMap.get(id))
      .filter((user) => user && !user.sleep);
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
