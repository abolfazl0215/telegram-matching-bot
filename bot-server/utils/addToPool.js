const { pool, VALID_STATES } = require("../data/pool");

const MAX_POOL_LENGTH = 2100;
const TRIM_TO_LENGTH = 1900;

/**
 * یک کاربر را به ابتدای pool مربوط به استان و جنسیتش اضافه می‌کند (unshift).
 * اگر طول آن pool بیشتر از MAX_POOL_LENGTH شود، به TRIM_TO_LENGTH کاهش می‌یابد
 * (قدیمی‌ترین کاربران یعنی انتهای آرایه حذف می‌شوند).
 *
 * @param {Object} user - سند کاربر (باید فیلدهای state و gender را داشته باشد)
 * @returns {boolean} - true در صورت موفقیت، false در صورت نامعتبر بودن state/gender
 */
const addToPool = (user) => {
  if (!user || !user.state || !user.gender) {
    console.error(
      `[addToPool] User missing state or gender. telegramId: ${user?.telegramId}`,
    );
    return false;
  }

  if (!VALID_STATES.includes(user.state)) {
    console.error(
      `[addToPool] Invalid state "${user.state}" for telegramId: ${user.telegramId}`,
    );
    return false;
  }

  // gender در دیتابیس "male" یا "female" است؛ کلیدهای pool با حرف بزرگ تمام می‌شوند (Male/Female)
  const normalizedGender =
    user.gender === "male"
      ? "Male"
      : user.gender === "female"
        ? "Female"
        : null;

  if (!normalizedGender) {
    console.error(
      `[addToPool] Invalid gender "${user.gender}" for telegramId: ${user.telegramId}`,
    );
    return false;
  }

  const poolKey = `${user.state}${normalizedGender}`;

  if (!Array.isArray(pool[poolKey])) {
    console.error(
      `[addToPool] Pool bucket "${poolKey}" does not exist.`,
    );
    return false;
  }

  // اگر کاربر از قبل در pool بود، نسخه‌ی قبلی حذف شود
  const existingIndex = pool[poolKey].findIndex(
    (u) => u.telegramId === user.telegramId,
  );
  if (existingIndex !== -1) {
    pool[poolKey].splice(existingIndex, 1);
  }

  // اضافه کردن به ابتدای آرایه
  pool[poolKey].unshift(user);

  // اگر طول از حد مجاز بیشتر شد، از انتها (قدیمی‌ترین‌ها) کاهش بده
  if (pool[poolKey].length > MAX_POOL_LENGTH) {
    pool[poolKey].length = TRIM_TO_LENGTH;
  }
  return true;
};

module.exports = {
  addToPool,
};
