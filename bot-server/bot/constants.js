const MENU_TEXT = `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`;

const MENU_KEYBOARD = [
  [{ text: "1 🚀" }, { text: "2" }, { text: "3" }, { text: "4" }],
];

const SEARCH_KEYBOARD = [
  [{ text: "☰" }, { text: "❤️" }, { text: "❌" }, { text: "💌" }],
];

const NOTIFICATION_MENU_TEXT = `${"افرادی شما را لایک کردند. یه نگاهی بنداز "}\n\n1. ${"نمایش"}\n2. ${"حالت خواب"}`;

const NOTIFICATION_MENU_KEYBOARD = [[{ text: "1 🚀" }, { text: "2" }]];

const LIKE_HELP_TEXT =
  "❤️ : لایک\n❌ : رد کردن\n💌 : لایک به همراه پیام\n☰ : منو\n\nوقتی کاربری را لایک میکنید ، لایک شما برای او ارسال میشود و اگر اوهم شما را لایک کند ، متصل میشوید .";

const USERNAME_REQUIRED_TEXT =
  "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری";

const USERNAME_REQUIRED_INLINE = [
  [{ text: "انجام دادم ✅", callback_data: "done_start" }],
];

const USERNAME_PHOTO_URL =
  "https://nodejs-x695j4.chbk.dev/uploads/username.jpg";

const INVITE_SHARE_PREFIX =
  "ربات دوستیابی پونس 🔥 در بله است! یک دوست جدید یا حتی یک عاشق پیدا کنید 👫";

module.exports = {
  MENU_TEXT,
  MENU_KEYBOARD,
  SEARCH_KEYBOARD,
  NOTIFICATION_MENU_TEXT,
  NOTIFICATION_MENU_KEYBOARD,
  LIKE_HELP_TEXT,
  USERNAME_REQUIRED_TEXT,
  USERNAME_REQUIRED_INLINE,
  USERNAME_PHOTO_URL,
  INVITE_SHARE_PREFIX,
};
