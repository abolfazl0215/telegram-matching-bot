const Stats = require("../models/Stats");
const User = require("../models/User");

// هر چند وقت یک‌بار ارقامِ حافظه به دیتابیس flush بشه (میلی‌ثانیه).
// عدد کوچیک‌تر = دقت لحظه‌ای بیشتر ولی درخواست بیشتر به Mongo.
const FLUSH_INTERVAL_MS = 2 * 60 * 1000; // ۲ دقیقه

// ساعتی از شبانه‌روز (به وقت تهران) که محاسبه‌ی سنگین‌ retention
// (بازگشت کاربر / کاربران ازدست‌رفته) توش انجام میشه؛ کم‌ترافیک‌ترین ساعت.
const RETENTION_HOUR = 4;

// ایران از ۱۴۰۰ دیگر ساعت تابستانی نداره و افست ثابت +۰۳:۳۰ ست؛
// برای محاسبه‌ی ساعت شروع روز (نیمه‌شب تهران) همین افست ثابت کافیه.
const TEHRAN_OFFSET_MS = 3.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------
// کمک‌تابع‌های زمان (بدون نیاز به کتابخانه‌ی timezone خارجی)
// ---------------------------------------------------------------

function tehranDateParts(d = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  });
  const parts = {};
  fmt.formatToParts(d).forEach(({ type, value }) => {
    parts[type] = value;
  });
  return parts;
}

function tehranDateString(d = new Date()) {
  const p = tehranDateParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

function tehranHour(d = new Date()) {
  return parseInt(tehranDateParts(d).hour, 10);
}

// تخمینِ لحظه‌ی (timestamp) شروع یک روزِ تهران؛ برای مقایسه‌ی
// lastActivity / createdAt در کوئری‌های retention استفاده میشه.
// دقت کافی (چون تصمیم‌های محصولی نیازی به دقتِ ثانیه‌ای ندارن).
function tehranStartOfDayMs(dateStr) {
  return (
    new Date(`${dateStr}T00:00:00.000Z`).getTime() - TEHRAN_OFFSET_MS
  );
}

// ---------------------------------------------------------------
// وضعیتِ درون‌حافظه‌ای امروز
// ---------------------------------------------------------------

function emptyCounter() {
  return { total: 0, male: 0, female: 0 };
}

function createEmptyState(day) {
  return {
    day,
    // برای جلوگیری از شمارش تکراریِ «فعال امروز» در طول کل روز
    activeIdsToday: new Set(),
    // شمارنده‌های delta؛ فقط چیزهایی که از آخرین flush به بعد اتفاق افتاده
    pendingActive: emptyCounter(),
    pendingNewUsers: emptyCounter(),
    pendingLikes: emptyCounter(),
    pendingNopes: emptyCounter(),
    pendingMatches: emptyCounter(),
    pendingSubscriptions: emptyCounter(),
    pendingSubscriptionRevenue: 0,
    // آیا محاسبه‌ی retention برای امروز قبلاً انجام شده؟
    retentionDone: false,
  };
}

let state = createEmptyState(tehranDateString());
let isFlushing = false;
let intervalHandle = null;

function normalizeGender(gender) {
  return gender === "male" || gender === "female" ? gender : null;
}

function bump(counter, gender) {
  counter.total += 1;
  const g = normalizeGender(gender);
  if (g) counter[g] += 1;
}

// اگر روز عوض شده باشه (نیمه‌شب تهران رد شده)، وضعیت را برای روز
// جدید ریست می‌کنیم و باقیمانده‌ی آمار روز قبل را (بدون منتظر ماندن)
// به دیتابیس flush می‌کنیم تا چیزی گم نشه.
function ensureCurrentDay() {
  const today = tehranDateString();
  if (today === state.day) return;

  const previousState = state;
  state = createEmptyState(today);

  flushStateToDb(previousState).catch((err) => {
    console.error("statsTracker: flush on day rollover failed", err);
  });
}

// ---------------------------------------------------------------
// API عمومی برای هوک‌کردن رویدادها از بقیه‌ی پروژه
// ---------------------------------------------------------------

function trackActivity(telegramId, gender) {
  try {
    ensureCurrentDay();
    if (!telegramId) return;
    if (state.activeIdsToday.has(telegramId)) return;
    state.activeIdsToday.add(telegramId);
    bump(state.pendingActive, gender);
  } catch (err) {
    console.error("statsTracker.trackActivity error", err);
  }
}

function trackNewUser(gender) {
  try {
    ensureCurrentDay();
    bump(state.pendingNewUsers, gender);
  } catch (err) {
    console.error("statsTracker.trackNewUser error", err);
  }
}

function trackLike(gender) {
  try {
    ensureCurrentDay();
    bump(state.pendingLikes, gender);
  } catch (err) {
    console.error("statsTracker.trackLike error", err);
  }
}

function trackNope(gender) {
  try {
    ensureCurrentDay();
    bump(state.pendingNopes, gender);
  } catch (err) {
    console.error("statsTracker.trackNope error", err);
  }
}

// یک رویداد مچ، جنسیتِ هر دو طرف را می‌گیرد. total یک‌بار برای هر
// جفت زیاد می‌شود؛ male/female تعداد شرکت‌کننده‌ها را نشان می‌دهند.
function trackMatch(genderA, genderB) {
  try {
    ensureCurrentDay();
    state.pendingMatches.total += 1;
    const gA = normalizeGender(genderA);
    const gB = normalizeGender(genderB);
    if (gA) state.pendingMatches[gA] += 1;
    if (gB) state.pendingMatches[gB] += 1;
  } catch (err) {
    console.error("statsTracker.trackMatch error", err);
  }
}

function trackSubscription(gender, amount) {
  try {
    ensureCurrentDay();
    bump(state.pendingSubscriptions, gender);
    if (typeof amount === "number" && amount > 0) {
      state.pendingSubscriptionRevenue += amount;
    }
  } catch (err) {
    console.error("statsTracker.trackSubscription error", err);
  }
}

// یک نمای لحظه‌ای (بدون کوئری دیتابیس) برای استفاده‌ی احتمالی
// در داشبورد، مثلاً برای نشان‌دادن «فعال امروز» با دقت کامل حتی
// قبل از flush بعدی.
function getLiveSnapshot() {
  return {
    day: state.day,
    activeUsersToday: state.activeIdsToday.size,
  };
}

// ---------------------------------------------------------------
// Flush به دیتابیس
// ---------------------------------------------------------------

function counterToIncPaths(fieldName, counter) {
  const inc = {};
  if (counter.total) inc[`${fieldName}.total`] = counter.total;
  if (counter.male) inc[`${fieldName}.male`] = counter.male;
  if (counter.female) inc[`${fieldName}.female`] = counter.female;
  return inc;
}

// این تابع روی یک state مشخص (نه لزوماً state فعلی) کار می‌کند تا هم
// برای flush دوره‌ای و هم برای flush لحظه‌ی تعویض روز قابل استفاده باشد.
async function flushStateToDb(targetState) {
  const pendingGroups = {
    activeUsers: targetState.pendingActive,
    newUsers: targetState.pendingNewUsers,
    likes: targetState.pendingLikes,
    nopes: targetState.pendingNopes,
    matches: targetState.pendingMatches,
    subscriptions: targetState.pendingSubscriptions,
  };

  const hasChanges =
    Object.values(pendingGroups).some((c) => c.total > 0) ||
    targetState.pendingSubscriptionRevenue > 0;
  if (!hasChanges) return;

  // فوراً یک نسخه از delta فعلی برمی‌داریم و شمارنده‌ها را صفر می‌کنیم
  // تا رویدادهایی که حین نوشتن روی دیتابیس اتفاق می‌افتند، دوباره
  // شمارش نشوند (نه گم بشن، نه دوبار اضافه بشن).
  const snapshot = {};
  for (const [key, counter] of Object.entries(pendingGroups)) {
    snapshot[key] = { ...counter };
    counter.total = 0;
    counter.male = 0;
    counter.female = 0;
  }
  const revenueSnapshot = targetState.pendingSubscriptionRevenue;
  targetState.pendingSubscriptionRevenue = 0;

  const incDoc = {};
  for (const [key, counter] of Object.entries(snapshot)) {
    Object.assign(incDoc, counterToIncPaths(key, counter));
  }
  if (revenueSnapshot > 0) {
    incDoc.subscriptionRevenue = revenueSnapshot;
  }

  try {
    await Stats.findOneAndUpdate(
      { date: targetState.day },
      {
        $inc: incDoc,
        $set: { lastFlushAt: Date.now() },
        $setOnInsert: { date: targetState.day },
      },
      { upsert: true },
    );
  } catch (err) {
    // اگر نوشتن با خطا مواجه شد، مقادیر را برگردان تا در flush
    // بعدی دوباره امتحان شوند؛ هیچ آماری گم نمی‌شود.
    for (const [key, counter] of Object.entries(snapshot)) {
      const target = pendingGroups[key];
      target.total += counter.total;
      target.male += counter.male;
      target.female += counter.female;
    }
    targetState.pendingSubscriptionRevenue += revenueSnapshot;
    console.error("statsTracker: failed to flush stats", err);
  }
}

// ---------------------------------------------------------------
// محاسبه‌ی روزانه‌ی retention (سنگین، فقط یک‌بار در روز)
// ---------------------------------------------------------------

async function computeAndStoreRetention(day) {
  const now = Date.now();
  const startOfToday = tehranStartOfDayMs(day);
  const ms7d = 7 * 24 * 60 * 60 * 1000;
  const ms14d = 14 * 24 * 60 * 60 * 1000;
  const ms30d = 30 * 24 * 60 * 60 * 1000;

  const [
    returningUsers,
    inactiveOver7d,
    inactiveOver14d,
    inactiveOver30d,
    todayDoc,
  ] = await Promise.all([
    // فعال بوده امروز، ولی کاربر جدیدِ امروز نبوده => یعنی برگشته
    User.countDocuments({
      lastActivity: { $gte: startOfToday },
      createdAt: { $lt: startOfToday },
    }),
    User.countDocuments({ lastActivity: { $lt: now - ms7d } }),
    User.countDocuments({ lastActivity: { $lt: now - ms14d } }),
    User.countDocuments({ lastActivity: { $lt: now - ms30d } }),
    Stats.findOne({ date: day }).lean(),
  ]);

  const activeTotal = todayDoc?.activeUsers?.total || 0;
  const returnRatePercent =
    activeTotal > 0
      ? Math.round((returningUsers / activeTotal) * 1000) / 10
      : 0;

  await Stats.findOneAndUpdate(
    { date: day },
    {
      $set: {
        "retention.returningUsers": returningUsers,
        "retention.returnRatePercent": returnRatePercent,
        "retention.inactiveOver7d": inactiveOver7d,
        "retention.inactiveOver14d": inactiveOver14d,
        "retention.inactiveOver30d": inactiveOver30d,
        "retention.computedAt": now,
      },
      $setOnInsert: { date: day },
    },
    { upsert: true },
  );
}

// ---------------------------------------------------------------
// تیک دوره‌ای
// ---------------------------------------------------------------

async function tick() {
  if (isFlushing) return; // جلوگیری از هم‌پوشانی دو flush
  isFlushing = true;
  try {
    ensureCurrentDay();
    await flushStateToDb(state);

    if (tehranHour() === RETENTION_HOUR && !state.retentionDone) {
      await computeAndStoreRetention(state.day);
      state.retentionDone = true;
    }
  } catch (err) {
    console.error("statsTracker: tick failed", err);
  } finally {
    isFlushing = false;
  }
}

// باید فقط یک‌بار، هنگام بالا آمدن سرور صدا زده شود.
function startStatsTracker() {
  if (intervalHandle) return; // جلوگیری از استارت دوباره
  intervalHandle = setInterval(tick, FLUSH_INTERVAL_MS);

  // best-effort: هنگام خاموش‌شدن عادی سرور، آخرین آمار را ذخیره کن
  const flushOnExit = () => {
    flushStateToDb(state).finally(() => process.exit(0));
  };
  process.once("SIGINT", flushOnExit);
  process.once("SIGTERM", flushOnExit);
}

module.exports = {
  startStatsTracker,
  trackActivity,
  trackNewUser,
  trackLike,
  trackNope,
  trackMatch,
  trackSubscription,
  getLiveSnapshot,
};
