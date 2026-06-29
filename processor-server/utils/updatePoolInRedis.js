const { redisClient } = require("../config/redis");
const { pool } = require("../data/pool");

/**
 * یک بخش (province+gender) را از pool در حافظه می‌خواند
 * و دقیقاً به همان ترتیب فعلی آرایه pool[key]، در Redis ذخیره می‌کند.
 * یعنی pool[key][0] همیشه اولین آیتم telegramIds در Redis خواهد بود.
 * هیچ خطایی throw نمی‌کند؛ خطا برای آن کلید لاگ می‌شود و بقیه کلیدها ادامه می‌یابند.
 */
const updateSingleBucketInRedis = async (key) => {
  try {
    const bucket = pool[key];

    if (!Array.isArray(bucket)) {
      console.error(
        `[updatePoolInRedis] pool["${key}"] is not an array, skipping.`,
      );
      return { key, ok: false };
    }

    // ترتیب فعلی آرایه pool[key] حفظ می‌شود — فقط map ساده، بدون sort
    const userIds = bucket.map((user) => user.telegramId);

    await redisClient.set(key, JSON.stringify(userIds));
    return { key, ok: true };
  } catch (err) {
    console.error(
      `[updatePoolInRedis] Failed to update key "${key}":`,
      err,
    );
    return { key, ok: false };
  }
};

const updatePoolInRedis = async () => {
  const provinceGenderKeys = Object.keys(pool);

  // از allSettled استفاده می‌کنیم تا خطای یک کلید مانع نوشتن بقیه کلیدها نشود
  const results = await Promise.allSettled(
    provinceGenderKeys.map((key) => updateSingleBucketInRedis(key)),
  );

  const failedKeys = [];

  results.forEach((result, index) => {
    if (result.status === "rejected") {
      // اتفاق غیرمنتظره (خارج از try/catch داخلی)
      failedKeys.push(provinceGenderKeys[index]);
      console.error(
        `[updatePoolInRedis] Unexpected rejection for key "${provinceGenderKeys[index]}":`,
        result.reason,
      );
    } else if (result.value && result.value.ok === false) {
      failedKeys.push(result.value.key);
    }
  });

  if (failedKeys.length > 0) {
    console.error(
      `[updatePoolInRedis] ${failedKeys.length}/${provinceGenderKeys.length} bucket(s) failed:`,
      failedKeys,
    );
  } else {
    console.log(
      `[updatePoolInRedis] Pool updated in Redis successfully. (${provinceGenderKeys.length} buckets)`,
    );
  }
};

module.exports = {
  updatePoolInRedis,
};
