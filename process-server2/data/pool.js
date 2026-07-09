const pool = {
  eastazerbaijanMale: [],
  eastazerbaijanFemale: [],
  tehranMale: [],
  tehranFemale: [],
  westazerbaijanMale: [],
  westazerbaijanFemale: [],
  ardabilMale: [],
  ardabilFemale: [],
  isfahanMale: [],
  isfahanFemale: [],
  alborzMale: [],
  alborzFemale: [],
  ilamMale: [],
  ilamFemale: [],
  bushehrMale: [],
  bushehrFemale: [],
  chaharmahalandbakhtiariMale: [],
  chaharmahalandbakhtiariFemale: [],
  southkhorasanMale: [],
  southkhorasanFemale: [],
  razavikhorasanMale: [],
  razavikhorasanFemale: [],
  northkhorasanMale: [],
  northkhorasanFemale: [],
  khuzestanMale: [],
  khuzestanFemale: [],
  zanjanMale: [],
  zanjanFemale: [],
  semnanMale: [],
  semnanFemale: [],
  sistanandbaluchestanMale: [],
  sistanandbaluchestanFemale: [],
  farsMale: [],
  farsFemale: [],
  qazvinMale: [],
  qazvinFemale: [],
  qomMale: [],
  qomFemale: [],
  kurdistanMale: [],
  kurdistanFemale: [],
  kermanMale: [],
  kermanFemale: [],
  kermanshahMale: [],
  kermanshahFemale: [],
  kohgiluyehandboyerahmadMale: [],
  kohgiluyehandboyerahmadFemale: [],
  golestanMale: [],
  golestanFemale: [],
  gilanMale: [],
  gilanFemale: [],
  lorestanMale: [],
  lorestanFemale: [],
  mazandaranMale: [],
  mazandaranFemale: [],
  markaziMale: [],
  markaziFemale: [],
  hormozganMale: [],
  hormozganFemale: [],
  hamadanMale: [],
  hamadanFemale: [],
  yazdMale: [],
  yazdFemale: [],
};

const VALID_STATES = [
  "eastazerbaijan",
  "tehran",
  "westazerbaijan",
  "ardabil",
  "isfahan",
  "alborz",
  "ilam",
  "bushehr",
  "chaharmahalandbakhtiari",
  "southkhorasan",
  "razavikhorasan",
  "northkhorasan",
  "khuzestan",
  "zanjan",
  "semnan",
  "sistanandbaluchestan",
  "fars",
  "qazvin",
  "qom",
  "kurdistan",
  "kerman",
  "kermanshah",
  "kohgiluyehandboyerahmad",
  "golestan",
  "gilan",
  "lorestan",
  "mazandaran",
  "markazi",
  "hormozgan",
  "hamadan",
  "yazd",
];

// ── FIX #4 (invalidation): ایندکس دوم برای دسترسی O(1) به هر user در pool ──
// pool اصلی به‌صورت ۶۲ آرایه (استان × جنسیت) سازمان‌دهی شده و برای پیدا کردن
// یک user خاص باید کل آرایه‌ی مربوطه رو خط به خط جست‌وجو کرد (و اگه state/gender
// اون user رو از قبل ندونیم، باید هر ۶۲ آرایه رو بگردیم که خیلی سنگینه).
//
// poolUsersById یه Map ساده از telegramId → همون آبجکت user (by reference)
// نگه می‌داره. چون این همون آبجکتیه که داخل آرایه‌ی pool[stateGenderKey]
// قرار داره (نه یه کپی)، هر تغییری که روی این آبجکت اعمال بشه (مثلاً آپدیت
// baseScore) بلافاصله توی pool هم منعکس میشه، بدون نیاز به پیدا کردن index
// آرایه یا splice/rebuild کردن چیزی.
//
// این Map توسط fillPool.js (موقع رفرش دوره‌ای) و addToPool.js (موقع ورود
// لحظه‌ای کاربر جدید) به‌روزرسانی میشه، و توسط
// utils/invalidatePoolUserScore.js برای invalidation رویداد-محور خونده میشه.
//
// ⚠️ نکته‌ی مهم: fillPool.js و addToPool.js این Map رو مستقیماً import
// می‌کنن (`const { pool, poolUsersById } = require("../data/pool")`).
// اگه این‌جا export نشه، اون دو فایل با خطای
// "Cannot read properties of undefined (reading 'set')" کرش می‌کنن.
const poolUsersById = new Map();

module.exports = {
  pool,
  VALID_STATES,
  poolUsersById,
};
