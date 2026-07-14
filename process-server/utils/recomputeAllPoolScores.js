const { poolUsersById } = require("../data/pool");
const { computeScore } = require("./computeScore");

/**
 * ── RECOMPUTE سبک دوره‌ای ────────────────────────────────────────────────────
 *
 * زمینه‌ی مسئله:
 * baseScore هر کاربر فقط در دو نقطه محاسبه/کش می‌شه: fillPool (فقط یک‌بار
 * در startup) و addToPool (وقتی کاربر تازه وارد pool میشه). برای کاربری که
 * از قبل در pool هست و هیچ رویداد invalidation (لایک/match/خرید اشتراک) روش
 * اتفاق نمی‌افته، امتیازهای وابسته به گذر زمان (activity decay، cold-start،
 * new-user boost، return boost) عملاً فریز می‌مونن.
 *
 * راه‌حل: این تابع، بدون هیچ رفت‌وبرگشتی به Redis/Mongo، فقط روی کاربرهایی
 * که همین الان در حافظه (poolUsersById) هستن لوپ می‌زنه و baseScore هرکدوم
 * رو دوباره حساب می‌کنه. چون مستقیم روی همون آبجکت مشترک (by reference)
 * که داخل آرایه‌های pool[stateGender] هم هست کار می‌کنه، هیچ آرایه‌ای
 * جایگزین/replace نمی‌شه؛ در نتیجه هیچ تداخلی با addToPool یا
 * removeFromExplore که هم‌زمان ممکنه روی همون آرایه‌ها کار کنن پیش نمیاد.
 *
 * هزینه: فقط CPU (O(poolSize) × هزینه‌ی computeScore)، بدون I/O. برای
 * جلوگیری از بلاک شدن محسوس event loop روی pool های بزرگ، هر N کاربر
 * یک تیک به event loop برگردونده می‌شه (yield با setImmediate).
 *
 * @param {number} yieldEvery - بعد از پردازش این تعداد کاربر، یک تیک از
 *   event loop آزاد بشه تا درخواست‌های دیگه (مثل getCandidates) گرسنه نمونن.
 */
async function recomputeAllPoolScores(yieldEvery = 500) {
  const startedAt = Date.now();
  let processed = 0;
  let failed = 0;

  for (const user of poolUsersById.values()) {
    try {
      user.baseScore = computeScore(user);
      user.scoredAt = Date.now();
    } catch (err) {
      failed++;
      console.error(
        `[recomputeAllPoolScores] Failed for telegramId ${user?.telegramId}:`,
        err,
      );
      // یه کاربر خراب نباید کل چرخه رو متوقف کنه؛ فقط رد میشیم.
      continue;
    }

    processed++;

    // ── یک تیک به event loop برگردون تا request های دیگه معطل نمونن ──
    if (processed % yieldEvery === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  console.log(
    `[recomputeAllPoolScores] Done in ${Date.now() - startedAt}ms. ` +
      `processed=${processed} failed=${failed}`,
  );
}

module.exports = { recomputeAllPoolScores };
