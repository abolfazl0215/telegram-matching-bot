const { poolUsersById } = require("../data/pool");
const { computeScore } = require("./computeScore");

/**
 * ── FIX #4 (invalidation رویداد-محور) ──────────────────────────────────────
 *
 * زمینه‌ی مسئله:
 * baseScore هر user حالا فقط در دو نقطه محاسبه و cache می‌شه:
 *   ۱. fillPool.js -> در چرخه‌ی دوره‌ای رفرش pool (مثلاً هر چند دقیقه)
 *   ۲. addToPool.js -> وقتی کاربر تازه وارد pool میشه
 *
 * این برای موادی که به‌آرومی decay می‌شن (activity, cold-start, ...) کاملاً
 * کافیه. اما بعضی رویدادها می‌تونن score رو به‌صورت ناگهانی و معنادار عوض
 * کنن (مثلاً یه لایک جدید، match جدید، خرید اشتراک، تکمیل پروفایل) و اگه
 * تا چرخه‌ی بعدی fillPool صبر کنیم، ممکنه چند دقیقه (بسته به فاصله‌ی
 * چرخه‌ها) کاربر با امتیاز قدیمی در فید بقیه نمایش داده بشه.
 *
 * راه‌حل: این تابع یه نقطه‌ی ورودی سبک برای "این user رو فوراً دوباره
 * score کن" فراهم می‌کنه. هر جای کد (مثلاً newLikeQueueController در
 * index.js، یا یه Bull queue consumer دیگه برای رویدادهای cross-server)
 * که یه فیلد اثرگذار روی computeScore عوض میشه، می‌تونه این تابع رو صدا
 * بزنه.
 *
 * چرا سریعه: بر خلاف fillPool که کل bucket رو از Mongo دوباره می‌خونه،
 * این تابع فقط با poolUsersById (Map با دسترسی O(1)) کاربر مورد نظر رو
 * پیدا می‌کنه، patch رو روی همون آبجکت مشترک (by reference) اعمال می‌کنه
 * و فقط computeScore همون یک نفر رو دوباره حساب می‌کنه — نه کل pool رو.
 *
 * @param {number} telegramId - شناسه‌ی کاربری که باید invalidate بشه
 * @param {(user: object) => void} [mutate] - تابع اختیاری که فیلدهای
 *   تغییر‌کرده رو مستقیم روی آبجکت user (همون آبجکتی که داخل pool هست)
 *   اعمال می‌کنه. مثال: `(u) => u.receivedLikes.unshift({ ... })`.
 *   اگه پاس داده نشه، فقط computeScore با داده‌ی فعلی دوباره اجرا میشه
 *   (برای مواردی که فیلد رو جای دیگه‌ای مستقیم عوض کردی و فقط می‌خوای
 *   score رو sync کنی).
 * @returns {boolean} - true اگه کاربر در pool پیدا و invalidate شد،
 *   false اگه کاربر اصلاً در pool (هنوز) حضور نداشت — در این حالت،
 *   کاری از دست ما ساخته نیست، چرخه‌ی بعدی fillPool یا addToPool
 *   (وقتی کاربر واقعاً وارد pool بشه) این‌رو هندل می‌کنه.
 */
function invalidatePoolUserScore(telegramId, mutate) {
  const user = poolUsersById.get(Number(telegramId));

  // کاربر یا اصلاً در pool نیست (مثلاً هنوز به بازدید کسی نرسیده) یا در
  // حال حاضر sleep/غیرفعاله. در هر دو حالت safe-fallback داریم: چرخه‌ی
  // بعدی fillPool یا فراخوانی بعدی addToPool، baseScore درست رو ست می‌کنه.
  if (!user) return false;

  try {
    if (typeof mutate === "function") {
      mutate(user);
    }
    user.baseScore = computeScore(user);
    user.scoredAt = Date.now();
    return true;
  } catch (err) {
    // یه خطای غیرمنتظره‌ی اینجا نباید کل queue consumer صدازننده رو
    // بشکنه؛ فقط لاگ می‌کنیم. بدترین حالت اینه که baseScore این یک نفر
    // یه‌کم stale بمونه تا چرخه‌ی بعدی fillPool.
    console.error(
      `[invalidatePoolUserScore] Failed for telegramId ${telegramId}:`,
      err,
    );
    return false;
  }
}

module.exports = { invalidatePoolUserScore };
