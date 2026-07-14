const mongoose = require("mongoose");

// یک شمارنده‌ی ساده و تکرارشونده برای هر رویداد؛ همیشه سه مقدار
// total / male / female داره تا هم عدد کل و هم تفکیک جنسیتی
// بدون نیاز به کوئری اضافه در دسترس باشه.
const genderCounterSchema = {
  total: { type: Number, default: 0 },
  male: { type: Number, default: 0 },
  female: { type: Number, default: 0 },
};

// این مدل، یک سند به‌ازای هر روز نگه می‌داره (کلید یکتا = date).
// نوشتن روی این سند فقط از طریق statsTracker و به‌صورت دوره‌ای
// (upsert) انجام می‌شه، نه به‌ازای هر رویداد؛ پس هیچ فشار
// لحظه‌ای به دیتابیس وارد نمی‌کنه.
const statsSchema = new mongoose.Schema({
  // فرمت: "YYYY-MM-DD" بر پایه‌ی ساعت تهران
  date: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },

  // کاربرانی که امروز حداقل یک پیام/تعامل با ربات داشتند
  activeUsers: { type: genderCounterSchema, default: () => ({}) },

  // کاربرانی که امروز برای اولین بار ثبت‌نام کردند
  newUsers: { type: genderCounterSchema, default: () => ({}) },

  // لایک‌های ارسال‌شده امروز (تفکیک بر اساس جنسیت لایک‌دهنده)
  likes: { type: genderCounterSchema, default: () => ({}) },

  // ردکردن‌های (❌) ثبت‌شده امروز (تفکیک بر اساس جنسیت ردکننده)
  nopes: { type: genderCounterSchema, default: () => ({}) },

  // مچ‌های تشکیل‌شده امروز.
  // total = تعداد رویداد مچ (هر جفت یک‌بار شمرده می‌شود)
  // male/female = تعداد شرکت‌کننده‌های هر جنسیت در مچ‌های امروز
  matches: { type: genderCounterSchema, default: () => ({}) },

  // خریدهای اشتراک ثبت‌شده امروز
  subscriptions: { type: genderCounterSchema, default: () => ({}) },

  // مجموع مبلغ خریدهای اشتراک امروز (تومان)
  subscriptionRevenue: { type: Number, default: 0 },

  // آمار بازگشت کاربران؛ چون محاسبه‌اش نیاز به کوئری سنگین روی کل
  // کالکشن User داره، فقط یک‌بار در روز (job زمان‌بندی‌شده) پر می‌شود
  // نه به‌صورت لحظه‌ای.
  retention: {
    // کاربرانی که امروز فعال بودند ولی کاربر «جدید» امروز نبودند
    returningUsers: { type: Number, default: 0 },

    // درصد: returningUsers از کل activeUsers.total
    returnRatePercent: { type: Number, default: 0 },

    // کاربرانی که بیش از ۷ روزه فعالیتی نداشتند
    inactiveOver7d: { type: Number, default: 0 },

    // کاربرانی که بیش از ۱۴ روزه فعالیتی نداشتند
    inactiveOver14d: { type: Number, default: 0 },

    // کاربرانی که بیش از ۳۰ روزه فعالیتی نداشتند (احتمالاً ازدست‌رفته)
    inactiveOver30d: { type: Number, default: 0 },

    // آخرین زمانی که این بخش محاسبه شد
    computedAt: { type: Number, default: 0 },
  },

  // آخرین باری که این سند از حافظه flush شد (برای دیباگ/مانیتورینگ)
  lastFlushAt: { type: Number, default: 0 },
});

const Stats = mongoose.model("Stats", statsSchema);

module.exports = Stats;
