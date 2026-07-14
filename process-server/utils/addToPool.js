const { pool, VALID_STATES, poolUsersById } = require("../data/pool");
// FIX #3 (perf): تا کاربر تازه‌اضافه‌شده هم فوراً baseScore داشته باشه
// و مجبور نباشه تا چرخه‌ی بعدی fillPool صبر کنه (که ممکنه چند دقیقه طول بکشه).
const { computeScore } = require("./computeScore");

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
const addToPool = async (user) => {
  if (!user || !user.state || !user.gender || user.sleep) {
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

  // ── FIX #5 (stale cross-bucket duplicates) ────────────────────────────
  // اگر این کاربر قبلاً در pool حضور داشته (حتی در یک bucket متفاوت —
  // مثلاً چون استان یا جنسیتش عوض شده)، اول باید نسخه‌ی قدیمی رو از همون
  // bucket قدیمی حذف کنیم. بدون این کار، وقتی کاربر مثلاً استانش رو از
  // "تهران" به "اصفهان" تغییر می‌ده، نسخه‌ی قدیمی برای همیشه (تا زمانی که
  // fillPool دوباره از Mongo اجرا بشه) به‌صورت یتیم در bucket تهران باقی
  // می‌مونه: با پروفایل/عکس قدیمی به کاربرهای تهران نمایش داده می‌شه، و
  // امتیازش هم دیگه رفرش نمی‌شه چون recomputeAllPoolScores فقط روی
  // poolUsersById (که به نسخه‌ی جدید اشاره می‌کنه) لوپ می‌زنه، نه روی
  // آرایه‌های خام pool.
  //
  // _poolKey روی خودِ آبجکت کاربر ذخیره می‌شه (نه این‌که هر بار از
  // state/gender دوباره حساب بشه) چون آبجکت قدیمی داخل pool ممکنه از قبل
  // mutate شده باشه و دیگه state/gender درستی نداشته باشه؛ _poolKey منبع
  // قابل‌اعتمادی از این‌که "این آبجکت الان کجای pool نشسته" رو نگه می‌داره.
  const previousUser = poolUsersById.get(user.telegramId);
  if (
    previousUser &&
    previousUser._poolKey &&
    previousUser._poolKey !== poolKey
  ) {
    const oldBucket = pool[previousUser._poolKey];
    if (Array.isArray(oldBucket)) {
      const oldIndex = oldBucket.indexOf(previousUser);
      if (oldIndex !== -1) {
        oldBucket.splice(oldIndex, 1);
      }
    }
  }

  // اگر کاربر از قبل داخل همین bucket بود (بدون تغییر state/gender)، نسخه‌ی
  // قبلی حذف شود تا duplicate نداشته باشیم
  const existingIndex = pool[poolKey].findIndex(
    (u) => u.telegramId === user.telegramId,
  );
  if (existingIndex !== -1) {
    pool[poolKey].splice(existingIndex, 1);
  }

  // ── FIX #4 (invalidation): baseScore رو همین‌جا هم پیش‌محاسبه می‌کنیم ──
  // تا وقتی getMatchCandidates این کاربر رو به‌عنوان candidate می‌بینه،
  // مجبور به فراخوانی مستقیم computeScore داخل حلقه‌ی request نباشه.
  user.baseScore = computeScore(user);
  user.scoredAt = Date.now();
  user._poolKey = poolKey;

  // اضافه کردن به ابتدای آرایه
  pool[poolKey].unshift(user);

  // ثبت/به‌روزرسانی همین کاربر در ایندکس سراسری poolUsersById
  // (برای دسترسی O(1) بعداً هنگام invalidation رویداد-محور)
  poolUsersById.set(user.telegramId, user);

  // اگر طول از حد مجاز بیشتر شد، از انتها (قدیمی‌ترین‌ها) کاهش بده
  if (pool[poolKey].length > MAX_POOL_LENGTH) {
    // قبل از کوتاه کردن آرایه، id کاربرهایی که قراره حذف بشن رو هم از
    // poolUsersById پاک می‌کنیم؛ وگرنه ایندکس به آبجکت‌هایی اشاره می‌کنه
    // که دیگه در هیچ bucket ای نیستن (memory leak + داده‌ی نادرست).
    const trimmedOutUsers = pool[poolKey].slice(TRIM_TO_LENGTH);
    for (const trimmedUser of trimmedOutUsers) {
      if (poolUsersById.get(trimmedUser.telegramId) === trimmedUser) {
        poolUsersById.delete(trimmedUser.telegramId);
      }
    }
    pool[poolKey].length = TRIM_TO_LENGTH;
  }
  return true;
};

module.exports = {
  addToPool,
};
