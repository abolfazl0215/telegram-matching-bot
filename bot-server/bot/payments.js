const User = require("../models/User");
const { reply } = require("../telegram_methods/reply");
const { PROVIDER_TOKEN } = require("../app/config");
const { redisClient } = require("../config/redis");
const Payments = require("../models/Payments");
const usersMap = require("../utils/usersMap");

const SUBSCRIPTION_PACKAGES = [
  {
    key: "like1",
    callback: "buy_like_1",
    menuLabel: "1 ماهه + 500 لایک  --  249,000 تومان",
    title: "💎 اشتراک پرو + 500 لایک اضافه",
    description: "💎 اشتراک پرو (یک ماهه) + 500 لایک اضافه",
    amount: 2490000,
    giftLikeCount: 500,
    days: 30,
  },
  {
    key: "like2",
    callback: "buy_like_2",
    menuLabel: "1 ماهه + 1000 لایک  --  369,000 تومان",
    title: "💎 اشتراک پرو + 1000 لایک اضافه",
    description: "💎 اشتراک پرو (یک ماهه) + 1000 لایک اضافه",
    amount: 3690000,
    giftLikeCount: 1000,
    days: 30,
  },
  {
    key: "like3",
    callback: "buy_like_3",
    menuLabel: "👑 3 ماهه + 1500 لایک  --  389,000 تومان (28% off)",
    title: "💎 اشتراک پرو + 1500 لایک اضافه",
    description: "💎 اشتراک پرو (سه ماهه) + 1500 لایک اضافه",
    amount: 10000,
    // amount: 3890000,
    giftLikeCount: 1500,
    days: 90,
  },
  {
    key: "like4",
    callback: "buy_like_4",
    menuLabel: "3 ماهه + 2500 لایک  --  739,000 تومان",
    title: "💎 اشتراک پرو + 2500 لایک اضافه",
    description: "💎 اشتراک پرو (سه ماهه) + 2500 لایک اضافه",
    amount: 7390000,
    giftLikeCount: 2500,
    days: 90,
  },
  {
    key: "like5",
    callback: "buy_like_5",
    menuLabel: "6 ماهه + 5000 لایک  --  999,000 تومان",
    title: "💎 اشتراک پرو + 5000 لایک اضافه",
    description: "💎 اشتراک پرو (شش ماهه) + 5000 لایک اضافه",
    amount: 9990000,
    giftLikeCount: 5000,
    days: 180,
  },
];

const PACKAGES_BY_KEY = Object.fromEntries(
  SUBSCRIPTION_PACKAGES.map((p) => [p.key, p]),
);

function registerPaymentHandlers(bot) {
  bot.action("buy_like", async (ctx, next) => {
    await reply(
      ctx,
      next,
      redisClient,
      "💎 اشتراک پرو + 💚 لایک اضافه \n\nیه پکیج انتخاب کن:",
      [],
      SUBSCRIPTION_PACKAGES.map((p) => [
        { text: p.menuLabel, callback_data: p.callback },
      ]),
    );
  });

  for (const pkg of SUBSCRIPTION_PACKAGES) {
    bot.action(pkg.callback, async (ctx) => {
      try {
        await ctx.sendInvoice({
          chat_id: ctx.chat.id,
          title: pkg.title,
          description: pkg.description,
          payload: `${pkg.key}_${ctx.from.id}`,
          provider_token: PROVIDER_TOKEN,
          prices: [{ label: "اشتراک پونس", amount: pkg.amount }],
        });
      } catch (e) {
        console.error("Error during sendInvoice:", e);
        await ctx.reply("خطا در ارسال صورتحساب");
      }
    });
  }

  bot.on("pre_checkout_query", async (ctx) => {
    try {
      const q = ctx.update.pre_checkout_query;
      console.log({ q: q.from.id, q2: q.invoice_payload });

      if (
        !q.invoice_payload ||
        !q.invoice_payload.startsWith("like")
      ) {
        return await ctx.answerPreCheckoutQuery(
          false,
          "payload نامعتبر است.",
        );
      }

      const userIdFromPayload = q.invoice_payload.split("_")[1];
      if (String(q.from.id) !== String(userIdFromPayload)) {
        return await ctx.answerPreCheckoutQuery(
          false,
          "کاربر پرداخت‌کننده با سفارش مطابقت ندارد.",
        );
      }

      const packageKey = Object.keys(PACKAGES_BY_KEY).find((key) =>
        q.invoice_payload.startsWith(`${key}_`),
      );

      if (!packageKey) {
        return await ctx.answerPreCheckoutQuery(
          false,
          "پکیج نامعتبر است.",
        );
      }

      const pkg = PACKAGES_BY_KEY[packageKey];

      if (q.total_amount !== pkg.amount) {
        return await ctx.answerPreCheckoutQuery(
          false,
          "مبلغ سفارش نادرست است.",
        );
      }

      const daysInMs = pkg.days * 24 * 60 * 60 * 1000;
      const now = Date.now();

      const findUser = await User.findOne({ telegramId: q.from.id });
      if (!findUser) {
        return await ctx.answerPreCheckoutQuery(
          false,
          "کاربر یافت نشد.",
        );
      }

      try {
        const userInMap = usersMap.get(q.from.id)?.user;
        if (userInMap) {
          if (!userInMap.likesLimit.giftLikeCount)
            userInMap.likesLimit.giftLikeCount = 1;

          userInMap.likesLimit.giftLikeCount += pkg.giftLikeCount;
          userInMap.subscriptionExpireTime =
            userInMap.subscriptionExpireTime > now
              ? userInMap.subscriptionExpireTime + daysInMs
              : now + daysInMs;

          usersMap.set(q.from.id, {
            user: userInMap,
            time: Date.now(),
          });
        }
      } catch (error) {
        console.log({ error });
      }

      if (!findUser.likesLimit.giftLikeCount)
        findUser.likesLimit.giftLikeCount = 1;

      findUser.likesLimit.giftLikeCount += pkg.giftLikeCount;
      findUser.subscriptionExpireTime =
        findUser.subscriptionExpireTime > now
          ? findUser.subscriptionExpireTime + daysInMs
          : now + daysInMs;

      await findUser.save();

      try {
        await Payments.create({
          telegramId: findUser.telegramId,
          time: Date.now(),
          fee: q.total_amount,
        });
      } catch (error) {
        console.log({ error });
      }

      return await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error("pre_checkout_query error:", err);
      try {
        await ctx.answerPreCheckoutQuery(
          false,
          "خطا در تأیید پرداخت.",
        );
      } catch (_) {}
    }
  });
}

module.exports = { registerPaymentHandlers };
