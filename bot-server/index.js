const express = require("express");
const path = require("path");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const User = require("./models/User");
const {
  redisClient,
  cleanupOldUsersQueue,
  newLikeQueue,
  removeFromNewLikesQueue,
  addToPoolQueue,
  requestToFillForYouList,
  fillForYouList,
  logger,
  removeFromExploreQueue,
} = require("./config/redis");
const protobuf = require("./app/protobuf");
const newLikesMap = require("./utils/newLikesMap");
const { registerInBot } = require("./components/registerInBot.js");
const editProfileMenu = require("./components/userSteps/editProfileMenu.js");

// config dotenv
require("dotenv").config();
const pendingRefills = new Map();
const PENDING_TTL = 20000;

const bot = require("./bot");
const state = require("./app/state");
const {
  scheduleCleanupStart,
  loadBlockedUsers,
  getNowTime,
  cleanupOldUsersFromMapAndSaveToDB,
} = require("./app/session");
const { registerLocalQueueWorkers } = require("./app/queueWorkers");
const bodyParser = require("body-parser");
const { reply } = require("./telegram_methods/reply");
const chunkArray = require("./utils/chunkArray");
const {
  generateInviteCode,
} = require("./utils/generateInviteCode.js");
const { changePhoto } = require("./components/changePhoto.js");
const { registerPaymentHandlers } = require("./bot/payments.js");

const { replyBot } = require("./telegram_methods/replyBot.js");
const { AGES, BOT_INVITE_BASE } = require("./app/config.js");
const { registerReportHandlers } = require("./bot/reports.js");
const editProfileInBot = require("./components/editProfileInBot.js");
const constants = require("./bot/constants.js");
const {
  startStatsTracker,
  trackActivity,
  trackLike,
  trackNope,
  trackMatch,
  getLiveSnapshot,
} = require("./utils/statsTracker.js");
const Stats = require("./models/Stats.js");

const {
  replyWithPhoto,
} = require("./telegram_methods/replyWithPhoto.js");

const {
  usersMap,
  forYouList,
  forYouTime,
  blockedUsers,
  lastTimeAddProfileToList,
} = state;

const app = express();
const server = http.createServer(app);

mongoose
  .connect("mongodb://127.0.0.1:27017/pounes")
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => console.error("Could not connect to MongoDB", err));

app.use(
  cors({
    origin: "*",
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
  }),
);
app.use(express.json());

app.use(bodyParser.json({ limit: "10mb" }));

app.use((req, res, next) => {
  req.redisClient = redisClient;
  next();
});

// مسیر آمار (JSON). دسترسی با کلید محرمانه‌ی TRACKING_SECRET در .env
// کنترل می‌شود؛ اگر تنظیم نشده باشد این مسیر کاملاً بسته می‌ماند.
app.get("/tracking", async (req, res) => {
  try {
    const requiredKey = process.env.TRACKING_SECRET;
    if (!requiredKey || req.query.key !== requiredKey) {
      return res.status(403).json({ error: "دسترسی غیرمجاز" });
    }

    const days = Math.min(parseInt(req.query.days, 10) || 30, 90);
    const todayStr = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Tehran",
    }).format(new Date());

    const history = await Stats.find({})
      .sort({ date: -1 })
      .limit(days)
      .lean();

    const todayDoc = history.find((d) => d.date === todayStr) || null;

    res.json({
      today: {
        date: todayStr,
        ...(todayDoc || {}),
        // عدد لحظه‌ای فعال‌های امروز، حتی قبل از آخرین flush
        liveActiveUsersToday: getLiveSnapshot().activeUsersToday,
      },
      // از قدیم به جدید، مناسب برای رسم نمودار روند
      history: history.reverse(),
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ error: "خطای داخلی سرور" });
  }
});

// فایل‌های استاتیک داشبورد (مثل Chart.js لوکال) از این مسیر سرو می‌شن
// تا هیچ وابستگی‌ای به CDN خارجی نداشته باشیم.
app.use(
  "/tracking/vendor",
  express.static(path.join(__dirname, "public", "vendor")),
);

// صفحه‌ی HTML داشبورد؛ خودش دیتا نداره، فقط از /tracking (که با
// کلید محافظت می‌شه) دیتا رو fetch می‌کنه. برای همین این مسیر خودش
// نیازی به چک کلید نداره.
app.get("/tracking/dashboard", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "tracking-dashboard.html"),
  );
});

app.use("/", async (req, res) => {
  res.send("hello");
});

loadBlockedUsers();
registerLocalQueueWorkers();
scheduleCleanupStart();
startStatsTracker();

const ages = AGES;

const generateInviteLink = (telegramId) =>
  `${BOT_INVITE_BASE}${generateInviteCode(telegramId)}`;

// از این پس newLikesMap (utils/newLikesMap.js) جایگزین آرایه‌ی قدیمی
// newLikesArrayFromRedis شده است. این Map فقط یک‌بار، پیش از bot.launch
// (پایین‌تر در startServer) از روی Redis پر می‌شود. دیگر هیچ pull دوره‌ای
// از Redis نداریم چون سرور ربات دیگر مستقیماً در کلید "newLikes" نمی‌نویسد؛
// هر تغییری (اضافه/حذف) هم روی همین Map محلی اعمال می‌شود و هم با یک job
// به سرور پردازنده (که تنها writer نهایی Redis است) اعلام می‌شود.

fillForYouList.process(2, async (job) => {
  const { telegramId, candidates } = job.data;
  try {
    forYouList.set(+telegramId, [...candidates]);
    forYouTime.set(+telegramId, Date.now());
  } catch (error) {
    console.error("Error processing add to pool :", error);
  } finally {
    pendingRefills.delete(+telegramId);
  }
});

// Helper function - یک بار تعریف کن بیرون از handler
function waitForForYouList(
  telegramId,
  { timeout = 15000, interval = 500 } = {},
) {
  return new Promise((resolve, reject) => {
    // اگر از همان ابتدا پر بود، فوری resolve کن
    if (
      Array.isArray(forYouList.get(telegramId)) &&
      forYouList.get(telegramId).length >= 2
    ) {
      return resolve(forYouList.get(telegramId));
    }

    const startTime = Date.now();

    const check = setInterval(() => {
      const list = forYouList.get(telegramId);

      if (Array.isArray(list) && list.length >= 2) {
        clearInterval(check);
        resolve(list);
        return;
      }

      if (Date.now() - startTime >= timeout) {
        clearInterval(check);
        reject(
          new Error(
            `TIMEOUT: forYouList for ${telegramId} not ready after ${timeout}ms`,
          ),
        );
      }
    }, interval);
  });
}

const processStatement = async (ctx, next) => {
  const telegramId = ctx?.from?.id;
  const telegramName = ctx?.from?.first_name;
  const userName = ctx?.from?.username;
  const isBot = ctx?.from?.is_bot;
  const inviteCode = ctx?.startPayload;

  console.log("is bale :", process.env.PLATFORM == "bale");

  // send Message after success payment <<<<<<<<<<
  if (ctx.message.successful_payment) {
    try {
      await ctx.reply(
        "✅ پرداخت موفق ! اشتراک شما فعال شد. \n\nمشاهده مچ ها (افرادی که با آنها مطابقت داده شده اید) \n/matches\n/matches\n/matches",
      );
      setTimeout(async () => {
        let existingUser;
        if (usersMap.get(telegramId)) {
          existingUser = usersMap.get(telegramId).user;
          usersMap.get(telegramId).time = getNowTime();
        } else {
          try {
            existingUser = await User.findOne({ telegramId });
            if (existingUser) {
              usersMap.set(telegramId, {
                user: existingUser,
                time: getNowTime(),
              });
            }
          } catch (error) {
            console.log(error);
          }
        }
        if (!existingUser) return;
        existingUser.currentStep = { flow: "bot", step: "menu" };
        usersMap.set(telegramId, {
          user: existingUser,
          time: Date.now(),
        });
        try {
          await reply(
            ctx,
            next,
            redisClient,
            `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
            constants.MENU_KEYBOARD,
          );
        } catch (error) {
          console.log(error);
        }
        lastTimeAddProfileToList.set(telegramId, Date.now());
        addToPoolQueue.add({ user: existingUser });
      }, 200);
    } catch (error) {
      console.log(error);
    }
    return;
  }
  // send Message after success payment >>>>>>>>>>

  // load new like protoBuffer  <<<<<<<<<<<<<<<<<<<<<
  try {
    await protobuf.loadNewLikeProto();
  } catch (error) {
    console.log(error);
  }
  // load new like protoBuffer  >>>>>>>>>>>>>>>>>>>>

  if (isBot || !telegramId) {
    console.log(
      "no telegram id | bot",
      { isBot },
      ctx?.message?.text,
    );
    return next();
  }

  // check blocked users <<<<<<<<<<<<<<<<<<<<<<<<<<<<<
  if (blockedUsers.has(String(telegramId))) {
    try {
      await ctx.telegram.getChat(telegramId);
      await redisClient.srem("blocked_users", String(telegramId));
      blockedUsers.delete(String(telegramId));
      console.log("unblocked user ------------");
    } catch (error) {
      console.log("find a block ............ ", ctx?.message?.text);
      return next();
    }
  }
  // check blocked users >>>>>>>>>>>>>>>>>>>>>>>>>

  // fill existing user <<<<<<<<<<<
  let existingUser;
  if (usersMap.get(telegramId)) {
    existingUser = usersMap.get(telegramId).user;
    usersMap.get(telegramId).time = getNowTime();
    console.log(existingUser.currentStep);
  } else {
    try {
      existingUser = await User.findOne({
        telegramId,
        // platform: ,
      });
      if (existingUser) {
        usersMap.set(telegramId, {
          user: existingUser,
          time: getNowTime(),
        });
      }
    } catch (error) {
      console.log(error);
    }
  }
  // fill existing user >>>>>>>>>>>

  // check if user is banned cant use bot <<<<<<<<<
  if (existingUser?.ban) {
    try {
      await reply(ctx, next, redisClient, "شما مسدود شده اید");
    } catch (error) {
      console.log(error);
    }
    return;
  }
  // check if user is banned cant use bot >>>>>>>>>

  // ثبت «فعال بودن امروز» برای آمار /tracking؛ داخلش خودش جلوی
  // شمارش تکراری در طول روز رو می‌گیره، پس صدا زدنش اینجا (روی هر
  // پیام) هیچ فشار اضافه‌ای به دیتابیس وارد نمی‌کنه.
  trackActivity(telegramId, existingUser?.gender);

  // if user changed userName update it in database <<<<<<<<<<<
  if (existingUser && userName !== existingUser?.userName) {
    const updatedUser = await User.findOneAndUpdate(
      { telegramId },
      { userName: userName || "" },
      { returnDocument: "after" },
    );
    existingUser.userName = userName || "";
    usersMap.set(telegramId, {
      user: existingUser,
      time: getNowTime(),
    });
  }
  // if user changed userName update it in database >>>>>>>>>>>

  // after 8 minutes and 20 seconds add profile to forYou queue again and update last time <<<
  if (existingUser?.fullName) {
    const lastTime = lastTimeAddProfileToList.get(telegramId) ?? 0;
    if (lastTime + 500000 < Date.now()) {
      const days7 = 7 * 24 * 60 * 60 * 1000;
      if (existingUser.lastActivity + days7 < Date.now()) {
        existingUser.returnBoostAt = existingUser.lastActivity;
      }

      existingUser.lastActivity = Date.now();
      usersMap.set(telegramId, {
        time: Date.now(),
        user: existingUser,
      });

      lastTimeAddProfileToList.set(telegramId, Date.now());
      addToPoolQueue.add({ user: existingUser });
    }
  }
  // after 8 minutes and 20 seconds add profile to forYou queue again and update last time >>>

  // Check if forYou list needs to be refilled and refill if necessary and add to suggestQueue <<<
  if (existingUser) {
    const currentList = forYouList.get(telegramId);
    const lastFetchTime = forYouTime.get(telegramId) ?? 0;

    const isEmptyOrLow =
      !currentList ||
      !Array.isArray(currentList) ||
      currentList.length <= 3;
    const isStale = Date.now() - lastFetchTime >= 6 * 60 * 60 * 1000; // 6 hours in milliseconds

    const needsRefill = isEmptyOrLow || isStale;

    const lastRequestAt = pendingRefills.get(telegramId);
    const alreadyPending =
      lastRequestAt && Date.now() - lastRequestAt < PENDING_TTL;

    if (needsRefill && existingUser?.fullName && !alreadyPending) {
      pendingRefills.set(telegramId, Date.now());
      requestToFillForYouList.add({ user: existingUser });
    }
  }
  // Check if forYou list needs to be refilled and refill if necessary and add to suggestQueue >>>

  // wait for fill forYouList
  if (existingUser?.fullName) {
    try {
      await waitForForYouList(telegramId, {
        timeout: 15000,
        interval: 500,
      });
    } catch (err) {
      logger.warn(`[ForYou] ${err.message}`);
      await ctx.reply("در حال حاضر پروفایلی برای نمایش وجود ندارد.");
      return;
    }
  }
  // wait for fill forYouList >>>>>

  if (existingUser) {
    const userFlow = existingUser?.currentStep?.flow;
    const userStep = existingUser?.currentStep?.step;

    console.log({ userFlow, userStep });

    if (userFlow === "register") {
      await registerInBot(
        ctx,
        next,
        ages,
        chunkArray,
        telegramId,
        telegramName,
        existingUser,
        redisClient,
        forYouList,
        forYouTime,
      );
    } else if (userFlow === "editProfile") {
      if (userStep === "editProfileMenu") {
        await editProfileMenu(
          ctx,
          next,
          redisClient,
          telegramId,
          existingUser,
          usersMap,
          forYouList,
          forYouTime,
          ages,
        );
      } else {
        editProfileInBot(
          ctx,
          next,
          chunkArray,
          ages,
          telegramId,
          existingUser,
          redisClient,
          forYouList,
          forYouTime,
          telegramName,
        );
      }
    } else if (userFlow === "changePhoto") {
      await changePhoto(
        ctx,
        next,
        telegramId,
        existingUser,
        redisClient,
        forYouList,
        forYouTime,
      );
    } else if (userFlow === "bot") {
      if (userStep === "search") {
        // check limit for get candidates _________________________ <<<<<<
        if (
          ctx?.message?.text === "💚" ||
          ctx?.message?.text === "❌" ||
          ctx?.message?.text === "💌"
        ) {
          const now = Date.now();
          const REFILL_INTERVAL_MS = 12 * 60 * 60 * 1000;
          const LIMIT_GET_CANDIDATE =
            existingUser.gender == "female" ? 150 : 100;
          const isPremium = existingUser.subscriptionExpireTime > now;
          const CANDIDATE_LIMIT = isPremium
            ? 300
            : LIMIT_GET_CANDIDATE;

          const lastFetchedAt = existingUser.lastGetCandidatesAt ?? 0;
          const candidateCount = existingUser.getCandidatesCount ?? 0;

          const isWithinRefillWindow =
            now - lastFetchedAt < REFILL_INTERVAL_MS;
          const hasEnoughCandidates =
            candidateCount >= CANDIDATE_LIMIT;

          if (!isWithinRefillWindow) {
            // ۱۲ ساعت گذشته → ریست فقط در usersMap
            existingUser.lastGetCandidatesAt = now;
            existingUser.getCandidatesCount = 0;

            const cached = usersMap.get(+existingUser.telegramId);
            if (cached) {
              const user = cached.user ?? cached;
              user.lastGetCandidatesAt = now;
              user.getCandidatesCount = 0;
            }

            // ادامه بده → کاندید جدید بگیر
          } else if (hasEnoughCandidates) {
            const remainingMs =
              REFILL_INTERVAL_MS - (now - lastFetchedAt);
            const remainingHours = Math.floor(
              remainingMs / (60 * 60 * 1000),
            );
            const remainingMinutes = Math.floor(
              (remainingMs % (60 * 60 * 1000)) / (60 * 1000),
            );

            const waitText =
              remainingHours > 0
                ? `${remainingHours} ساعت و ${remainingMinutes} دقیقه`
                : `${remainingMinutes} دقیقه`;

            const message = isPremium
              ? `سهمیه شما تمام شده، ${waitText} دیگر می‌توانید کاندید جدید دریافت کنید`
              : `هر ۱۲ ساعت یک‌بار ${LIMIT_GET_CANDIDATE} پروفایل جدید برای شما آماده می‌شه 🕐\n\nبا خرید اشتراک این سهمیه به ۳۰۰ پروفایل در هر ۱۲ ساعت افزایش پیدا می‌کنه ✨\n\nسهمیه شما تمام شده، ${waitText} دیگر می‌توانید پروفایل جدید دریافت کنید`;

            reply(
              ctx,
              next,
              redisClient,
              message,
              [],
              isPremium
                ? []
                : [
                    [
                      {
                        text: "خرید اشتراک 💎",
                        callback_data: "buy_like",
                      },
                    ],
                  ],
            );
            return;
          }

          // اینجا: یا تایم ریست شد، یا هنوز در بازه‌ایم ولی جا داره → کاندید بگیر
        }
        // check limit for get candidates _________________________ >>>>>>

        // calculate daily likes limition ________________________________<<<
        if (
          ctx?.message?.text === "💚" ||
          ctx?.message?.text === "💌"
        ) {
          const likeCountCalculateByGender =
            existingUser.gender == "male" ? 15 : 25;
          if (
            existingUser.likesLimit.firstLikeTime + 86400000 >
              Date.now() &&
            existingUser.likesLimit.likesCount >
              likeCountCalculateByGender
          ) {
            if (existingUser.likesLimit.giftLikeCount > 0) {
              existingUser.likesLimit.giftLikeCount -= 1;
              usersMap.set(telegramId, {
                time: Date.now(),
                user: existingUser,
              });
            } else {
              const remindTime =
                existingUser.likesLimit.firstLikeTime +
                86400000 -
                Date.now();

              // اطمینان از اینکه مقدار منفی نباشد
              const totalMilliseconds = Math.max(0, remindTime);

              // تبدیل به ساعت و دقیقه
              const hours = Math.floor(
                totalMilliseconds / (1000 * 60 * 60),
              );
              const minutes = Math.floor(
                (totalMilliseconds % (1000 * 60 * 60)) / (1000 * 60),
              );

              // ساخت خروجی فارسی
              const result = `${hours} ساعت و ${minutes} دقیقه`;

              try {
                await reply(
                  ctx,
                  next,
                  redisClient,
                  `⚠️  شما فقط تعداد ${likeCountCalculateByGender} لایک در روز می‌توانید داشته باشید. برای لایک بیشتر میتوانید لایک خریداری کنید یا دوستان خود را دعوت کنید و 50 لایک هدیه بگیرید . بنر دعوت شما 👇🏽.\n\n🕜 ${result} دیگر لایک روزانه دریافت میکنید .`,
                  [],
                  [
                    [
                      {
                        text: "خرید لایک 💚",
                        callback_data: "buy_like",
                      },
                    ],
                  ],
                );
                const inviteLink = `https://ble.ir/pounesbot?start=${generateInviteCode(
                  +telegramId,
                )}`;
                const shareText =
                  "ربات دوستیابی پونس 🔥 در بله است! یک دوست جدید یا حتی یک عاشق پیدا کنید 👫" +
                  "\n👉🏻 " +
                  inviteLink;

                // await ctx.reply(shareText);
                await reply(ctx, next, redisClient, shareText);
              } catch (error) {
                console.log(error);
              }

              return;
            }
          } else if (
            existingUser.likesLimit.firstLikeTime + 86400000 <
            Date.now()
          ) {
            existingUser.likesLimit.firstLikeTime = Date.now();
            existingUser.likesLimit.likesCount = 1;
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
          } else {
            existingUser.likesLimit.firstLikeTime = Date.now();
            existingUser.likesLimit.likesCount =
              (existingUser.likesLimit.likesCount || 0) + 1;
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
          }
        }
        // calculate daily likes limition ________________________________>>>

        // check if user has a userName ___________________ <<<
        if (
          ctx?.message?.text === "💚" ||
          ctx?.message?.text === "💌"
        ) {
          // if user is not have username ask to fill it <<<<<<<<<<<<<<
          // if user is not have username ask to fill it <<<<<<<<<<<<<<
          if (!userName) {
            try {
              try {
                await ctx.replyWithPhoto(
                  "https://nodejs-x695j4.chbk.dev/uploads/username.jpg",
                  {
                    caption:
                      "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
                    reply_markup: {
                      inline_keyboard: [
                        [
                          {
                            text: "انجام دادم ✅",
                            callback_data: "done_start",
                          },
                        ],
                      ],
                    },
                  },
                );
              } catch (error) {
                try {
                  await reply(
                    ctx,
                    next,
                    redisClient,
                    "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
                    [],
                    [
                      [
                        {
                          text: "انجام دادم ✅",
                          callback_data: "done_start",
                        },
                      ],
                    ],
                  );
                } catch (error) {
                  console.log(error);
                }
              }
            } catch (e) {
              try {
                await reply(
                  ctx,
                  next,
                  redisClient,
                  "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
                );
              } catch (error) {
                console.log(error);
              }
            }
            return;
          }
          // if user is not have username ask to fill it >>>>>>>>>>>>>>
          // if user is not have username ask to fill it >>>>>>>>>>>>>>
        }
        // check if user has a userName ___________________ >>>

        if (ctx?.message?.text === "☰") {
          try {
            existingUser.currentStep.step = "menu";

            // Update user in map
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "💚") {
          // newLike for notification *********************

          //  add to liked by me _____________________________ <<<<<

          const targetId_ = forYouList.get(telegramId)?.[0]
            ?.telegramId
            ? +forYouList.get(telegramId)?.[0]?.telegramId
            : 0;
          if (!targetId_) return;

          const cachedEntry = usersMap.get(telegramId);
          let isCached = !!cachedEntry;
          let user = cachedEntry?.user;

          if (!user) {
            user = await User.findOne({ telegramId });
            if (!user) return;
          }

          if (!user.likedByMe) user.likedByMe = [];
          if (user.likedByMe.includes(targetId_)) return;

          if (!user.getCandidatesCount) {
            user.getCandidatesCount = 1;
          } else {
            user.getCandidatesCount += 1;
          }

          user.likedByMe.push(targetId_);
          if (user.likedByMe.length >= 1500) {
            user.likedByMe.splice(0, 300); // حذف ۳۰۰ تای قدیمی‌ترین (ابتدای آرایه)
          }

          if (!isCached) {
            await user.save();
          }
          usersMap.set(telegramId, {
            time: Date.now(),
            user: user,
          });

          trackLike(user?.gender);

          //  add to liked by me _____________________________ >>>>>

          // ** for candidate _________________________________________
          // -- add to received likes

          {
            const likeTargetId =
              +forYouList.get(telegramId)[0]?.telegramId;

            // آپدیت optimistic و بلافاصله‌ی Map محلی (برای نمایش سریع‌تر
            // به گیرنده‌ی لایک، بدون نیاز به رفت‌وبرگشت از پردازنده)
            newLikesMap.addLike(likeTargetId, existingUser);

            // اعلام این لایک به سرور پردازنده تا در آرایه‌ی خودش و در
            // نهایت روی Redis هم اعمال شود (پردازنده تنها writer نهایی است)
            newLikeQueue.add({
              telegramId: likeTargetId,
              liker: existingUser,
            });
          }

          if (!existingUser.forTutorial.firstLike) {
            try {
              await reply(
                ctx,
                next,
                redisClient,
                "💚 : لایک\n❌ : رد کردن\n💌 : لایک به همراه پیام\n☰ : منو\n\nوقتی کاربری را لایک میکنید ، لایک شما برای او ارسال میشود و اگر اوهم شما را لایک کند ، متصل میشوید .",
              );
              existingUser.forTutorial.firstLike = 1;
              usersMap.set(telegramId, {
                time: Date.now(),
                user: existingUser,
              });
            } catch (error) {
              console.log(error);
            }
          }

          const targetId = forYouList.get(telegramId)?.[0]?.telegramId
            ? +forYouList.get(telegramId)?.[0]?.telegramId
            : 0;
          const fullItem = forYouList.get(telegramId)?.[0];

          forYouList.set(
            telegramId,
            forYouList.get(telegramId).slice(1),
          );

          const nextUser = forYouList.get(telegramId)?.[0];
          if (!nextUser) {
            await reply(
              ctx,
              next,
              redisClient,
              "کاربری برای نمایش وجود ندارد",
            );
            return;
          }

          const {
            fullName,
            age,
            state,
            bio,
            profileImages,
            createAt,
            inviteCode: inviteCode_from_forYouList,
          } = nextUser;
          // userTelId = forYouList.get(telegramId)[0].telegramId;

          const photos = profileImages;
          const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
          const isNew = Date.now() - (createAt || 1) < twoDaysMs;

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName} ${isNew ? " (کاربر جدید) " : ""}, ${age}, ${state} ${
              bio ? "\n" + bio : ""
            } \n/user_${inviteCode_from_forYouList || "not_found"}`,
          );

          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
        } else if (ctx?.message?.text === "❌") {
          const targetId =
            forYouList.get(telegramId)?.[0]?.telegramId;

          if (!existingUser.forTutorial.firstNope) {
            try {
              await reply(
                ctx,
                next,
                redisClient,
                "💚 : لایک\n❌ : رد کردن\n💌 : لایک به همراه پیام\n☰ : منو\n\nوقتی کاربری را لایک میکنید ، لایک شما برای او ارسال میشود و اگر اوهم شما را لایک کند ، متصل میشوید .",
              );
            } catch (error) {
              console.log(error);
            }

            existingUser.forTutorial.firstNope = 1;
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
          }

          //  add to noped by me _____________________________ <<<<<
          const targetId_ = forYouList.get(telegramId)?.[0]
            ?.telegramId
            ? +forYouList.get(telegramId)?.[0]?.telegramId
            : 0;
          if (!targetId_) return;

          const cachedEntry = usersMap.get(telegramId);
          let isCached = !!cachedEntry;
          let user = cachedEntry?.user;

          if (!user) {
            user = await User.findOne({ telegramId });
            if (!user) return;
          }

          if (!user.nopedByMe) user.nopedByMe = [];
          if (user.nopedByMe.includes(targetId_)) return;

          if (!user.getCandidatesCount) {
            user.getCandidatesCount = 1;
          } else {
            user.getCandidatesCount += 1;
          }

          user.nopedByMe.push(targetId_);
          if (user.nopedByMe.length >= 1500) {
            user.nopedByMe.splice(0, 300); // حذف ۳۰۰ تای قدیمی‌ترین (ابتدای آرایه)
          }

          if (!isCached) {
            await user.save();
          }
          usersMap.set(telegramId, {
            time: Date.now(),
            user: user,
          });

          trackNope(user?.gender);
          //  add to noped by me _____________________________ >>>>>

          forYouList.set(
            telegramId,
            forYouList.get(telegramId).slice(1),
          );

          const nextUser = forYouList.get(telegramId)?.[0];

          if (!nextUser) {
            await reply(
              ctx,
              next,
              redisClient,
              "کاربری برای نمایش وجود ندارد",
            );
            return;
          }

          const {
            fullName,
            age,
            state,
            bio,
            profileImages,
            inviteCode: inviteCode_from_forYouList,
            createAt,
          } = nextUser;

          const photos = profileImages;
          const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
          const isNew = Date.now() - (createAt || 1) < twoDaysMs;

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName} ${isNew ? " (کاربر جدید) " : ""}, ${age}, ${state} ${
              bio ? "\n" + bio : ""
            } \n/user_${inviteCode_from_forYouList || "not_found"}`,
          );

          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
        } else if (ctx?.message?.text === "💌") {
          existingUser.currentStep.step = "likeWithMessage";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "پیام خود را ارسال کنید 💌👇🏻 \n\n -- لایک شما به همراه این پیام برای کاربر ارسال میشود  ",
              [[{ text: "بازگشت" }]],
            );
          } catch (error) {
            console.log(error);
          }
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "🧐👇🏽",
              constants.SEARCH_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "likeWithMessage") {
        if (ctx?.message?.text == "بازگشت") {
          existingUser.currentStep.step = "search";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });

          const targetId = forYouList.get(telegramId)?.[0]?.telegramId
            ? +forYouList.get(telegramId)?.[0]?.telegramId
            : 0;
          const fullItem = forYouList.get(telegramId)?.[0];

          const currentUser = forYouList.get(telegramId)?.[0];
          if (!currentUser) {
            await reply(
              ctx,
              next,
              redisClient,
              "کاربری برای نمایش وجود ندارد",
            );
            return;
          }

          const {
            fullName,
            age,
            state,
            bio,
            profileImages,
            createAt,
            inviteCode: inviteCode_from_forYouList,
          } = currentUser;
          // userTelId = forYouList.get(telegramId)[0].telegramId;

          const photos = profileImages;
          const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
          const isNew = Date.now() - (createAt || 1) < twoDaysMs;

          try {
            await reply(
              ctx,
              next,
              redisClient,
              "🔎",
              constants.SEARCH_KEYBOARD,
            );
          } catch (_) {}

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName} ${isNew ? " (کاربر جدید) " : ""}, ${age}, ${state} ${
              bio ? "\n" + bio : ""
            } \n/user_${inviteCode_from_forYouList || "not_found"}`,
          );
        } else if (
          ctx?.message?.text &&
          ctx?.message?.text != "❌" &&
          ctx?.message?.text != "💌" &&
          ctx?.message?.text != "💚"
        ) {
          if (
            forYouList.get(telegramId) &&
            forYouList.get(telegramId)[0]
          ) {
            //  add to liked by me _____________________________ <<<<<

            const targetId_ = forYouList.get(telegramId)?.[0]
              ?.telegramId
              ? +forYouList.get(telegramId)?.[0]?.telegramId
              : 0;
            if (!targetId_) return;

            const cachedEntry = usersMap.get(telegramId);
            let isCached = !!cachedEntry;
            let user = cachedEntry?.user;

            if (!user) {
              user = await User.findOne({ telegramId });
              if (!user) return;
            }

            if (!user.likedByMe) user.likedByMe = [];
            if (user.likedByMe.includes(targetId_)) return;

            if (!user.getCandidatesCount) {
              user.getCandidatesCount = 1;
            } else {
              user.getCandidatesCount += 1;
            }

            user.likedByMe.push(targetId_);
            if (user.likedByMe.length >= 1500) {
              user.likedByMe.splice(0, 300); // حذف ۳۰۰ تای قدیمی‌ترین (ابتدای آرایه)
            }

            if (!isCached) {
              await user.save();
            }
            usersMap.set(telegramId, {
              time: Date.now(),
              user: user,
            });

            trackLike(user?.gender);

            //  add to liked by me _____________________________ >>>>>
            // newLike for notification
            {
              const likeTargetId =
                +forYouList.get(telegramId)[0]?.telegramId;
              const likeMessage = ctx?.message?.text;

              newLikesMap.addLike(
                likeTargetId,
                existingUser,
                likeMessage,
              );

              newLikeQueue.add({
                telegramId: likeTargetId,
                liker: existingUser,
                message: likeMessage,
              });
            }
          } else {
            reply(
              ctx,
              next,
              redisClient,
              "liker id notfoundddd -------------",
            );
          }

          if (!existingUser.forTutorial.firstLike) {
            try {
              await reply(
                ctx,
                next,
                redisClient,
                "💚 : لایک\n❌ : رد کردن\n💌 : لایک به همراه پیام\n☰ : منو\n\nوقتی کاربری را لایک میکنید ، لایک شما برای او ارسال میشود و اگر اوهم شما را لایک کند ، متصل میشوید .",
              );
              existingUser.forTutorial.firstLike = 1;
              usersMap.set(telegramId, {
                time: Date.now(),
                user: existingUser,
              });
            } catch (error) {
              console.log(error);
            }
          }

          await reply(
            ctx,
            next,
            redisClient,
            "لایک شما به همراه پیام ارسال شد ✅",
            constants.SEARCH_KEYBOARD,
          );

          existingUser.currentStep.step = "search";

          const targetId = forYouList.get(telegramId)?.[0]?.telegramId
            ? +forYouList.get(telegramId)?.[0]?.telegramId
            : 0;
          const fullItem = forYouList.get(telegramId)?.[0];

          forYouList.set(
            telegramId,
            forYouList.get(telegramId).slice(1),
          );

          const nextUser = forYouList.get(telegramId)?.[0];
          if (!nextUser) {
            await reply(
              ctx,
              next,
              redisClient,
              "کاربری برای نمایش وجود ندارد",
            );
            return;
          }

          const {
            fullName,
            age,
            state,
            bio,
            profileImages,
            createAt,
            inviteCode: inviteCode_from_forYouList,
          } = nextUser;
          // userTelId = forYouList.get(telegramId)[0].telegramId;

          const photos = profileImages;
          const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
          const isNew = Date.now() - (createAt || 1) < twoDaysMs;

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName} ${isNew ? " (کاربر جدید) " : ""}, ${age}, ${state} ${
              bio ? "\n" + bio : ""
            } \n/user_${inviteCode_from_forYouList || "not_found"}`,
          );

          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "لطفا فقط پیام متنی ارسال کنید.",
            );
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "menu") {
        if (ctx?.message?.text === "1 🚀") {
          try {
            existingUser.currentStep.step = "search";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
            await reply(
              ctx,
              next,
              redisClient,
              "🔎",
              constants.SEARCH_KEYBOARD,
            );

            const {
              fullName,
              age,
              state,
              bio,
              profileImages,
              createAt,
              inviteCode: inviteCode_from_forYouList,
            } = forYouList.get(telegramId)[0];

            const photos = profileImages;
            const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
            const isNew = Date.now() - (createAt || 1) < twoDaysMs;

            await replyWithPhoto(
              ctx,
              next,
              photos,
              `${fullName} ${isNew ? " (کاربر جدید) " : ""}, ${age}, ${state} ${
                bio ? "\n" + bio : ""
              } \n/user_${inviteCode_from_forYouList || "not_found"}`,
            );
          } catch (error) {
            console.log({ error });
          }
        } else if (ctx?.message?.text === "2") {
          try {
            const photos = existingUser.profileImages;
            const fullName = existingUser.fullName;
            const age = existingUser.age;
            const state = existingUser.state;
            const bio = existingUser?.bio ?? "";
            const inviteCode = existingUser.inviteCode;

            await replyWithPhoto(
              ctx,
              next,
              photos,
              `${fullName}, ${age}, ${state} ${
                bio ? "\n" + bio : ""
              } \n/user_${inviteCode || "not_found"}`,
            );

            existingUser.currentStep.flow = "editProfile";
            existingUser.currentStep.step = "editProfileMenu";

            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`,
              constants.MY_PROFILE_MENU_KEYBOARD,
            );
          } catch (error) {
            console.log({ error });
          }
        } else if (ctx?.message?.text === "3") {
          try {
            existingUser.currentStep.step = "sleep";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              `${"حالت خواب"}: ${
                existingUser.sleep ? "فعال" : "غیرفعال"
              }\n\n${"اگر حالت خواب فعال باشد ، لایکی دریافت نمیکنید"}`,
              [
                [
                  {
                    text: existingUser.sleep ? "غیرفعال" : "فعال",
                  },
                ],
                [{ text: "بازگشت" }],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "4") {
          try {
            existingUser.currentStep.step = "invite";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              "دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید!\n\nبا دوستان خود یا در شبکه های اجتماعی خود به اشتراک گذاری کنید!\nلینک شخصی شما 👇🏽",
              [[{ text: "بازگشت" }]],
            );
            console.log("platform : ", process.env.PLATFORM);
            const shareText =
              "ربات دوستیابی پونس 🔥 در بله است! یک دوست جدید یا حتی یک عاشق پیدا کنید 👫" +
              "\n👉🏻 " +
              generateInviteLink(telegramId);

            // await ctx.reply(shareText);
            await reply(ctx, next, redisClient, shareText);
          } catch (error) {
            console.log(error);
          }

          return;
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log({ error });
          }
        }
      } else if (userStep === "invite") {
        if (ctx?.message?.text === "بازگشت") {
          existingUser.currentStep.step = "menu";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید!\n\nبا دوستان خود یا در شبکه های اجتماعی خود به اشتراک گذاری کنید!\nلینک شخصی شما 👇🏽",
              [[{ text: "بازگشت" }]],
            );
            const shareText =
              "ربات دوستیابی پونس 🔥 در بله است! یک دوست جدید یا حتی یک عاشق پیدا کنید 👫" +
              "\n👉🏻 " +
              generateInviteLink(telegramId);
            await reply(ctx, next, redisClient, shareText);
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "sleep") {
        if (ctx?.message?.text === "بازگشت") {
          try {
            existingUser.currentStep.step = "menu";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            try {
              await reply(
                ctx,
                next,
                redisClient,
                `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                constants.MENU_KEYBOARD,
              );
            } catch (error) {
              console.log(error);
            }
          } catch (error) {
            console.log({ error });
          }
        } else if (
          ctx?.message?.text === "فعال" ||
          ctx?.message?.text === "غیرفعال"
        ) {
          try {
            existingUser.currentStep.step = "menu";
            const sleppStatus = !existingUser.sleep;
            existingUser.sleep = sleppStatus;
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            if (sleppStatus) {
              try {
                removeFromExploreQueue.add({ user: existingUser });
              } catch (_) {}
            }

            // await ctx.reply("✅");
            await reply(
              ctx,
              next,
              redisClient,
              `حالت خواب ${existingUser.sleep ? "فعال" : "غیرفعال"} شد ✅`,
            );

            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log({ error });
          }
        } else {
          try {
            // await ctx.reply(
            //   `${"حالت خواب"}: ${
            //     existingUser.sleep ? "فعال" : "غیرفعال"
            //   }\n\n${"اگر حالت خواب فعال باشد ، لایکی دریافت نمیکنید"}`,
            //   {
            //     reply_markup: {
            //       keyboard: [
            //         [
            //           {
            //             text: existingUser.sleep ? "غیرفعال" : "فعال",
            //           },
            //         ],
            //         [{ text: "بازگشت" }],
            //       ],
            //       resize_keyboard: true,
            //       one_time_keyboard: false,
            //       is_persistent: true,
            //     },
            //   },
            // );
            await reply(
              ctx,
              next,
              redisClient,
              `${"حالت خواب"}: ${
                existingUser.sleep ? "فعال" : "غیرفعال"
              }\n\n${"اگر حالت خواب فعال باشد ، لایکی دریافت نمیکنید"}`,
              [
                [
                  {
                    text: existingUser.sleep ? "غیرفعال" : "فعال",
                  },
                ],
                [{ text: "بازگشت" }],
              ],
            );
          } catch (error) {
            console.log({ error });
          }
        }
      } else if (userStep === "userProfile") {
        if (ctx?.message?.text === "گزارش") {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `${"چرا میخوای این کاربر را گزارش کنی؟"} /user_${generateInviteCode(+existingUser?.lastViewedByInviteCode)}`,
              [],
              [
                [
                  {
                    text: "تبلیغات", // "تبلیغات"
                    callback_data: `report_advertisement`,
                  },
                ],
                [
                  {
                    text: "ارسال محتوای غیر اخلاقی", // "ارسال محتوای غیر اخلاقی"
                    callback_data: `report_inappropriate_content`,
                  },
                ],
                [
                  {
                    text: "ایجاد مزاحمت", // "ایجاد مزاحمت"
                    callback_data: `report_harassment`,
                  },
                ],
                [
                  {
                    text: "پخش شماره موبایل یا اطلاعات شخصی دیگران", // "پخش شماره موبایل یا اطلاعات شخصی دیگران"
                    callback_data: `report_phone_number`,
                  },
                ],
                [
                  {
                    text: "کلمات یا عکس غیراخلاقی در پروفایل", // "کلمات یا عکس غیراخلاقی در پروفایل"
                    callback_data: `report_inappropriate_profile`,
                  },
                ],
                [
                  {
                    text: "جنسیت اشتباه در پروقایل", // "جنسیت اشتباه در پروقایل"
                    callback_data: `report_incorrect_gender`,
                  },
                ],
                [
                  {
                    text: "دیگر موارد ...", // "دیگر موارد ..."
                    callback_data: `report_other`,
                  },
                ],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "بلاک") {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "کاربر بلاک شد ✅\n\n- شما دیگر پیام های این کاربر را دریافت نخواهید کرد\n- این کاربر دیگر در لیست کاربران پیشنهادی به شما نمایش داده نمی شود",
            );

            // delete from forYouList
            try {
              const current = forYouList.get(telegramId) ?? [];
              forYouList.set(
                telegramId,
                current.filter(
                  (f) =>
                    f.telegramId !=
                    existingUser.lastViewedByInviteCode,
                ),
              );
            } catch (error) {
              console.log(error);
            }

            existingUser.currentStep.step = "menu";
            if (existingUser.blockedByMe) {
              const findBlock = existingUser.blockedByMe.find(
                (f) => f == existingUser.lastViewedByInviteCode,
              );
              if (!findBlock) {
                existingUser.blockedByMe = [
                  ...existingUser.blockedByMe,
                  existingUser.lastViewedByInviteCode,
                ];
              }
            } else {
              if (existingUser.lastViewedByInviteCode)
                existingUser.blockedByMe = [
                  existingUser.lastViewedByInviteCode,
                ];
            }
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            try {
              let contact;
              if (
                usersMap.get(+existingUser.lastViewedByInviteCode)
              ) {
                contact = usersMap.get(
                  +existingUser.lastViewedByInviteCode,
                ).user;
              } else {
                contact = await User.findOne({
                  telegramId: +existingUser.lastViewedByInviteCode,
                });
              }
              if (!contact.blockedMe) contact.blockedMe = [];
              const findBlockInContact = contact.blockedMe.find(
                (f) => f == telegramId,
              );
              if (!findBlockInContact) {
                contact.blockedMe = [
                  ...contact.blockedMe,
                  +telegramId,
                ];
              }
              usersMap.set(+existingUser.lastViewedByInviteCode, {
                time: Date.now(),
                user: contact,
              });
            } catch (error) {
              console.log(error);
            }

            try {
              await reply(
                ctx,
                next,
                redisClient,
                `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                constants.MENU_KEYBOARD,
              );
            } catch (error) {
              console.log(error);
            }
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "آنبلاک") {
          try {
            await reply(ctx, next, redisClient, "کاربر آنبلاک شد ✅");
            existingUser.currentStep.step = "menu";
            if (existingUser.blockedByMe) {
              const findBlock = existingUser.blockedByMe.find(
                (f) => f == existingUser.lastViewedByInviteCode,
              );
              if (findBlock) {
                existingUser.blockedByMe =
                  existingUser.blockedByMe.filter(
                    (f) => f != existingUser.lastViewedByInviteCode,
                  );
              }
            } else {
              if (existingUser.lastViewedByInviteCode)
                existingUser.blockedByMe = [];
            }
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            try {
              let contact;
              if (
                usersMap.get(+existingUser.lastViewedByInviteCode)
              ) {
                contact = usersMap.get(
                  +existingUser.lastViewedByInviteCode,
                ).user;
              } else {
                contact = await User.findOne({
                  telegramId: +existingUser.lastViewedByInviteCode,
                });
              }
              if (!contact.blockedMe) contact.blockedMe = [];
              const findBlockInContact = contact.blockedMe.find(
                (f) => f == telegramId,
              );
              if (findBlockInContact) {
                contact.blockedMe = contact.blockedMe.filter(
                  (f) => f != +existingUser.lastViewedByInviteCode,
                );
              }
              usersMap.set(+existingUser.lastViewedByInviteCode, {
                time: Date.now(),
                user: contact,
              });
            } catch (error) {
              console.log(error);
            }

            try {
              await reply(
                ctx,
                next,
                redisClient,
                `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                constants.MENU_KEYBOARD,
              );
            } catch (error) {
              console.log(error);
            }
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "بازگشت به منوی اصلی") {
          existingUser.currentStep.step = "menu";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        } else {
          existingUser.currentStep.step = "menu";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "notificationSleepMode") {
        if (ctx?.message?.text === "بازگشت") {
          try {
            existingUser.currentStep.step = "notificationMenu";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
            await reply(
              ctx,
              next,
              redisClient,
              `${"افرادی شما را لایک کردند. یه نگاهی بنداز "}\n\n1. ${"نمایش"}\n2. ${"حالت خواب"}`,
              constants.NOTIFICATION_MENU_KEYBOARD,
            );
          } catch (error) {
            console.log({ error });
          }
        } else if (
          ctx?.message?.text === "فعال" ||
          ctx?.message?.text === "غیرفعال"
        ) {
          try {
            existingUser.currentStep.step = "notificationMenu";
            const sleppStatus = !existingUser.sleep;
            existingUser.sleep = sleppStatus;
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            if (sleppStatus) {
              try {
                removeFromExploreQueue.add({ user: existingUser });
              } catch (_) {}
            }
            await reply(
              ctx,
              next,
              redisClient,
              "حالت خواب تنظیم شد ✅",
            );
            await reply(
              ctx,
              next,
              redisClient,
              `${"افرادی شما را لایک کردند. یه نگاهی بنداز "}\n\n1. ${"نمایش"}\n2. ${"حالت خواب"}`,
              constants.NOTIFICATION_MENU_KEYBOARD,
            );
          } catch (error) {
            console.log({ error });
          }
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `${"حالت خواب"}: ${
                existingUser.sleep ? "فعال" : "غیرفعال"
              }\n\n${"اگر حالت خواب فعال باشد ، لایکی دریافت نمیکنید"}`,
              [
                [
                  {
                    text: existingUser.sleep ? "غیرفعال" : "فعال",
                  },
                ],
                [{ text: "بازگشت" }],
              ],
            );
          } catch (error) {
            console.log({ error });
          }
        }
      } else if (userStep === "notificationMenu") {
        if (ctx?.message?.text === "1 🚀") {
          try {
            existingUser.currentStep.step = "notifications";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            {
              const userFromRedis = newLikesMap.getEntry(telegramId);
              if (
                userFromRedis &&
                Array.isArray(userFromRedis.likers) &&
                userFromRedis.likers.length > 0
              ) {
                await reply(
                  ctx,
                  next,
                  redisClient,
                  "افراد زیر شما را لایک کرده اند 🥰👇🏽\n\nهر کدام را لایک کنید به او متصل میشوید و میتوانید با او چت کنید 🗨️ \n\nدر حال جستجوی لایک ها ...",
                  [
                    [{ text: "❌" }, { text: "💚" }],
                    [{ text: "رد کردن همه" }],
                  ],
                );

                const photos = userFromRedis.likers[0].profileImages;
                const fullName = userFromRedis.likers[0].fullName;
                const age = userFromRedis.likers[0].age;
                const state = userFromRedis.likers[0].state;
                const bio = userFromRedis.likers[0].bio;
                const textMessage = userFromRedis.likers[0]?.message;
                const inviteCode_ =
                  userFromRedis.likers[0].inviteCode;

                await replyWithPhoto(
                  ctx,
                  next,
                  photos,
                  `${fullName}, ${age}, ${state} ${
                    bio ? "\n" + bio : ""
                  } ${textMessage ? `\n\nپیام کاربر به شما 💌 : ` : ""}${textMessage ? textMessage : ""} \n/user_${inviteCode_ || "not_found"}`,
                );
              } else {
                try {
                  existingUser.currentStep.step = "menu";

                  usersMap.set(telegramId, {
                    time: Date.now(),
                    user: existingUser,
                  });
                  await reply(
                    ctx,
                    next,
                    redisClient,
                    "شما لایکی ندارید",
                  );

                  await reply(
                    ctx,
                    next,
                    redisClient,
                    `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                    constants.MENU_KEYBOARD,
                  );
                } catch (error) {
                  console.log(error);
                }
              }
            }
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "2") {
          try {
            existingUser.currentStep.step = "notificationSleepMode";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });
            await reply(
              ctx,
              next,
              redisClient,
              `${"حالت خواب"}: ${
                existingUser.sleep ? "فعال" : "غیرفعال"
              }\n\n${"اگر حالت خواب فعال باشد ، لایکی دریافت نمیکنید"}`,
              [
                [
                  {
                    text: existingUser.sleep ? "غیرفعال" : "فعال",
                  },
                ],
                [{ text: "بازگشت" }],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              `${"افرادی شما را لایک کردند. یه نگاهی بنداز "}\n\n1. ${"نمایش"}\n2. ${"حالت خواب"}`,
              constants.NOTIFICATION_MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "notifications") {
        // if user is not have username ask to fill it <<<<<<<<<<<<<<
        // if user is not have username ask to fill it <<<<<<<<<<<<<<
        if (!userName) {
          try {
            try {
              await ctx.replyWithPhoto(
                "https://nodejs-x695j4.chbk.dev/uploads/username.jpg",
                {
                  caption:
                    "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
                  reply_markup: {
                    inline_keyboard: [
                      [
                        {
                          text: "انجام دادم ✅",
                          callback_data: "done_start",
                        },
                      ],
                    ],
                  },
                },
              );
            } catch (error) {
              try {
                await reply(
                  ctx,
                  next,
                  redisClient,
                  "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
                  [],
                  [
                    [
                      {
                        text: "انجام دادم ✅",
                        callback_data: "done_start",
                      },
                    ],
                  ],
                );
              } catch (error) {
                console.log(error);
              }
            }
            return;
          } catch (e) {
            try {
              await reply(
                ctx,
                next,
                redisClient,
                "برای استفاده از ربات حتما باید یک شناسه کاربری (آیدی) در بله داشته باشید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
              );
            } catch (error) {
              console.log(error);
            }
          }
        }
        // if user is not have username ask to fill it >>>>>>>>>>>>>>
        // if user is not have username ask to fill it >>>>>>>>>>>>>>
        if (ctx?.message?.text === "💚") {
          try {
            if (!existingUser.matches) existingUser.matches = [];
            // const getData = await redisClient.getBuffer(`newLikes`);

            {
              const userFromRedis = newLikesMap.getEntry(telegramId);

              if (userFromRedis) {
                if (
                  userFromRedis &&
                  Array.isArray(userFromRedis.likers) &&
                  userFromRedis.likers.length > 0
                ) {
                  const liker = userFromRedis.likers[0];
                  const fcmToken = liker?.fcmToken;
                  const likerTelegramId = liker.telegramId;
                  const photos =
                    userFromRedis.likers[0]?.profileImages || [];
                  const fullName =
                    userFromRedis.likers[0]?.fullName || "";
                  const likerUserName =
                    userFromRedis.likers[0]?.userName || "";
                  const age = userFromRedis.likers[0]?.age || "";
                  const gender =
                    userFromRedis.likers[0]?.gender || "";
                  const state = userFromRedis.likers[0]?.state || "";
                  const bio = userFromRedis.likers[0]?.bio || "";
                  const textMessage =
                    userFromRedis.likers[0]?.message;

                  // ورود به این بلوک یعنی هر دو طرف همدیگر را لایک
                  // کرده‌اند، پس دقیقاً همین‌جا یک رویداد مچ جدید است
                  // (فقط یک‌بار، نه در هر دو محل unshift پایین‌تر که
                  // برای reorder هم اجرا می‌شوند).
                  trackMatch(existingUser?.gender, gender);

                  // send notification
                  // if (fcmToken) {
                  //   try {
                  //     await sendNotification({
                  //       token: fcmToken,
                  //       title: `شما و ${existingUser?.fullName || ""} باهم مَچ شدید`,
                  //       body: "اکنون میتوانید با هم چت کنید",
                  //       data: {},
                  //     });
                  //   } catch (error) {
                  //     console.log({ error });
                  //   }
                  // }

                  // send match message for me _______________ <<<
                  try {
                    if (!existingUser.matches)
                      existingUser.matches = [];
                    if (
                      (existingUser?.subscriptionExpireTime &&
                        existingUser.subscriptionExpireTime >
                          Date.now()) ||
                      existingUser.gender == "female" ||
                      existingUser.matches.length <= 2
                    ) {
                      await reply(
                        ctx,
                        next,
                        redisClient,
                        ` ${"شما و"} ${fullName} ${"با همدیگر مطابقت داده شده‌اید!"} 🎉\n\n${"از طریق دکمه زیر می‌توانید با هم چت کنید:"} \n\n آیدی کاربر : @${likerUserName}\n\n/user_${generateInviteCode(likerTelegramId)}`,
                        [],
                        [
                          [
                            {
                              text: "شروع چت 💬",
                              url: `https://ble.ir/${likerUserName}?text=${"سلام"} ${fullName} ${"من از پونس هستم"}`,
                            },
                          ],
                        ],
                      );
                    } else {
                      await reply(
                        ctx,
                        next,
                        redisClient,
                        ` ${"شما و"} ${fullName} ${"با همدیگر مطابقت داده شده‌اید!"} 🎉\n\n${"از طریق دکمه زیر می‌توانید با هم چت کنید:"} \n\n آیدی کاربر : ********\n\n/user_${generateInviteCode(likerTelegramId)} \n\n⭕برای دریافت پیوی (صفحه چت خصوصی) کاربر باید اشتراک 💎پرو داشته باشد`,
                        [],
                        [
                          [
                            {
                              text: "خرید اشتراک 💎پرو",
                              callback_data: "buy_like",
                            },
                          ],
                        ],
                      );
                    }
                  } catch (error) {
                    console.log(error);
                  } finally {
                    usersMap.set(telegramId, {
                      time: Date.now(),
                      user: existingUser,
                    });
                  }
                  // send match message for me _______________ >>>

                  // send match message for contact _______________ <<<
                  try {
                    let getLiker;
                    if (usersMap.get(+likerTelegramId)) {
                      getLiker = usersMap.get(+likerTelegramId).user;
                    } else {
                      getLiker = await User.findOne({
                        telegramId: +likerTelegramId,
                      });
                    }
                    if (!getLiker.matches) getLiker.matches = [];
                    if (
                      (getLiker?.subscriptionExpireTime &&
                        getLiker.subscriptionExpireTime >
                          Date.now()) ||
                      getLiker.gender == "female" ||
                      getLiker.matches.length <= 2
                    ) {
                      console.log({ getLiker });
                      await replyBot(
                        +likerTelegramId,
                        redisClient,
                        ` ${"شما و"} ${existingUser?.fullName} ${"با همدیگر مطابقت داده شده‌اید!"} 🎉\n\n${"از طریق دکمه زیر می‌توانید با هم چت کنید:"} \n\n آیدی کاربر : @${userName}\n\n /user_${generateInviteCode(telegramId)}`,
                        [],
                        [
                          [
                            {
                              text: "شروع چت 💬",
                              url: `https://ble.ir/${userName}?text=${"سلام"} ${existingUser?.fullName} ${"من از پونس هستم"}`,
                            },
                          ],
                        ],
                      );
                    } else {
                      await replyBot(
                        likerTelegramId,
                        redisClient,
                        ` ${"شما و"} ${existingUser?.fullName} ${"با همدیگر مطابقت داده شده‌اید!"} 🎉\n\n${"از طریق دکمه زیر می‌توانید با هم چت کنید:"} \n\n آیدی کاربر :************\n\n /user_${generateInviteCode(telegramId)} \n\n⭕برای دریافت پیوی (صفحه چت خصوصی) کاربر باید اشتراک 💎پرو داشته باشد`,
                        [],
                        [
                          [
                            {
                              text: "خرید اشتراک 💎پرو",
                              callback_data: "buy_like",
                            },
                          ],
                        ],
                      );
                    }
                  } catch (error) {
                    console.log(error);
                  }
                  // send match message for contact _______________ >>>

                  // save in matches in db for me ___________________ <<<
                  try {
                    // پیدا کردن ایندکس کاربر موجود با telegramId
                    const existingMatchIndex =
                      existingUser.matches.findIndex(
                        (match) =>
                          +match.telegramId === +likerTelegramId,
                      );

                    if (existingMatchIndex !== -1) {
                      // اگر وجود داشت، به ایندکس 0 منتقل شود
                      const existingMatch =
                        existingUser.matches.splice(
                          existingMatchIndex,
                          1,
                        )[0];
                      existingUser.matches.unshift(+existingMatch);
                    } else {
                      // اگر وجود نداشت، اضافه شود
                      existingUser.matches.unshift({
                        telegramId: +likerTelegramId,
                        at: Date.now(),
                      });
                    }
                  } catch (error) {
                    console.log(error);
                  }
                  // save in matches in db for me ___________________ >>>

                  // save in matches in db for contact ___________________ <<<
                  try {
                    let findContact;

                    if (usersMap.get(+likerTelegramId)) {
                      findContact =
                        usersMap.get(+likerTelegramId).user;
                      usersMap.get(+likerTelegramId).time =
                        getNowTime();
                    } else {
                      findContact = await User.findOne({
                        telegramId: +likerTelegramId,
                      });
                    }

                    if (findContact) {
                      if (!Array.isArray(findContact?.matches))
                        findContact.matches = [];
                      // پیدا کردن ایندکس کاربر موجود با telegramId
                      const existingMatchIndex =
                        findContact.matches.findIndex(
                          (match) =>
                            +match.telegramId === +telegramId,
                        );

                      if (existingMatchIndex !== -1) {
                        // اگر وجود داشت، به ایندکس 0 منتقل شود
                        const existingMatch =
                          findContact.matches.splice(
                            existingMatchIndex,
                            1,
                          )[0];
                        findContact.matches.unshift(+existingMatch);
                      } else {
                        // اگر وجود نداشت، اضافه شود
                        findContact.matches.unshift({
                          telegramId: +telegramId,
                          at: Date.now(),
                        });
                      }

                      if (usersMap.get(+likerTelegramId)) {
                        usersMap.set(+likerTelegramId, {
                          user: findContact,
                        });
                      } else {
                        await findContact.save({
                          optimisticConcurrency: false,
                        });
                      }
                    }
                  } catch (error) {
                    console.log(error);
                  }
                  // save in matches in db for contact ___________________ >>>

                  // delete from list ----------------------------------
                  // به‌جای بازنویسی کل آرایه و نوشتن مستقیم در Redis، فقط
                  // نفر اول را از Map محلی حذف می‌کنیم (برای پاسخ سریع به
                  // کاربر) و حذف را با یک job به سرور پردازنده اعلام
                  // می‌کنیم تا او آرایه‌ی خودش را آپدیت و در نهایت (به‌صورت
                  // دوره‌ای) روی Redis flush کند. پردازنده تنها writer
                  // نهایی Redis است، پس race بین دو سرور دیگر رخ نمی‌دهد.
                  const removalResult =
                    newLikesMap.removeFirstLike(telegramId);
                  const list = removalResult
                    ? removalResult.remainingLikers
                    : [];

                  removeFromNewLikesQueue.add({
                    telegramId: +telegramId,
                    likerTelegramId: +likerTelegramId,
                  });
                  // end delete from list ------------------------------

                  // show nextUser -------------------------------------
                  if (list[0]) {
                    const photos = list[0].profileImages;
                    const fullName = list[0].fullName;
                    const age = list[0].age;
                    const state = list[0].state;
                    const bio = list[0].bio;
                    const inviteCode_ = list[0].inviteCode;
                    const textMessage = list[0]?.message;

                    await replyWithPhoto(
                      ctx,
                      next,
                      photos,
                      `${fullName}, ${age}, ${state} ${
                        bio ? "\n" + bio : ""
                      } ${textMessage ? `\n\nپیام کاربر به شما 💌 : ` : ""}${textMessage ? textMessage : ""} \n/user_${inviteCode_ || "not_found"}`,
                    );
                  } else {
                    try {
                      await reply(
                        ctx,
                        next,
                        redisClient,
                        "پایان لایک ها",
                      );
                      existingUser.currentStep.step = "menu";

                      usersMap.set(telegramId, {
                        time: Date.now(),
                        user: existingUser,
                      });

                      await reply(
                        ctx,
                        next,
                        redisClient,
                        `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                        constants.MENU_KEYBOARD,
                      );
                    } catch (error) {
                      console.log(error);
                    }
                  }
                  // end show nextUser ---------------------------------
                } else {
                  try {
                    await reply(
                      ctx,
                      next,
                      redisClient,
                      "پایان لایک ها",
                    );
                    existingUser.currentStep.step = "menu";
                    usersMap.set(telegramId, {
                      time: Date.now(),
                      user: existingUser,
                    });
                    await reply(
                      ctx,
                      next,
                      redisClient,
                      `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                      constants.MENU_KEYBOARD,
                    );
                  } catch (error) {
                    console.log(error);
                  }

                  return;
                }
              } else {
                try {
                  existingUser.currentStep.step = "menu";

                  usersMap.set(telegramId, {
                    time: Date.now(),
                    user: existingUser,
                  });

                  await reply(
                    ctx,
                    next,
                    redisClient,
                    "شما لایکی ندارید",
                  );

                  await reply(
                    ctx,
                    next,
                    redisClient,
                    `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                    constants.MENU_KEYBOARD,
                  );
                } catch (error) {
                  console.log(error);
                }
              }
            }
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "❌") {
          try {
            // const getData = await redisClient.getBuffer(`newLikes`);

            {
              const userFromRedis = newLikesMap.getEntry(telegramId);
              if (userFromRedis) {
                if (
                  userFromRedis &&
                  Array.isArray(userFromRedis.likers) &&
                  userFromRedis.likers.length > 0
                ) {
                  // delete from list __________________ <<<
                  // به‌جای بازنویسی کل آرایه و نوشتن مستقیم در Redis، فقط
                  // نفر اول را از Map محلی حذف می‌کنیم و حذف را با یک job
                  // به سرور پردازنده اعلام می‌کنیم (که تنها writer نهایی
                  // Redis است و به‌صورت دوره‌ای flush می‌کند).
                  const removedLikerTelegramId =
                    userFromRedis.likers[0]?.telegramId;
                  const removalResult =
                    newLikesMap.removeFirstLike(telegramId);
                  const list = removalResult
                    ? removalResult.remainingLikers
                    : [];

                  removeFromNewLikesQueue.add({
                    telegramId: +telegramId,
                    likerTelegramId: +removedLikerTelegramId,
                  });
                  // delete from list __________________ >>>

                  // show nextUser -------------------------------------
                  if (list[0]) {
                    const photos = list[0].profileImages;
                    const fullName = list[0].fullName;
                    const age = list[0].age;
                    const state = list[0].state;
                    const bio = list[0].bio;
                    const inviteCode_ = list[0].inviteCode;
                    const textMessage = list[0]?.message;

                    await replyWithPhoto(
                      ctx,
                      next,
                      photos,
                      `${fullName}, ${age}, ${state} ${
                        bio ? "\n" + bio : ""
                      } ${textMessage ? `\n\nپیام کاربر به شما 💌 : ` : ""}${textMessage ? textMessage : ""} \n/user_${inviteCode_ || "not_found"}`,
                    );
                  } else {
                    try {
                      await reply(
                        ctx,
                        next,
                        redisClient,
                        "پایان لایک ها",
                      );
                      existingUser.currentStep.step = "menu";

                      usersMap.set(telegramId, {
                        time: Date.now(),
                        user: existingUser,
                      });
                      await reply(
                        ctx,
                        next,
                        redisClient,
                        `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                        constants.MENU_KEYBOARD,
                      );
                    } catch (error) {
                      console.log(error);
                    }
                  }
                  // end show nextUser ---------------------------------
                } else {
                  try {
                    await reply(
                      ctx,
                      next,
                      redisClient,
                      "پایان لایک ها",
                    );
                    existingUser.currentStep.step = "menu";
                    usersMap.set(telegramId, {
                      time: Date.now(),
                      user: existingUser,
                    });
                    await reply(
                      ctx,
                      next,
                      redisClient,
                      `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                      constants.MENU_KEYBOARD,
                    );
                  } catch (error) {
                    console.log(error);
                  }

                  return;
                }
              } else {
                try {
                  existingUser.currentStep.step = "menu";

                  usersMap.set(telegramId, {
                    time: Date.now(),
                    user: existingUser,
                  });

                  await reply(
                    ctx,
                    next,
                    redisClient,
                    "شما لایکی ندارید",
                  );

                  await reply(
                    ctx,
                    next,
                    redisClient,
                    `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                    constants.MENU_KEYBOARD,
                  );
                } catch (error) {
                  console.log(error);
                }
              }
            }
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "رد کردن همه") {
          try {
            // مرحله‌ی تأیید؛ پاک‌سازی واقعی فقط بعد از تأیید صریح کاربر
            // در step=confirmDismissAllLikes انجام می‌شود.
            existingUser.currentStep.step = "confirmDismissAllLikes";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              "⚠️ آیا مطمئن هستید؟ با این کار همه‌ی لایک‌های در انتظار شما پاک می‌شوند و دیگر قابل بازیابی نیستند.",
              [[{ text: "بله، پاک کن" }], [{ text: "انصراف" }]],
            );
          } catch (error) {
            console.log(error);
          }
        } else {
          try {
            await reply(ctx, next, redisClient, "لایک ها :", [
              [{ text: "❌" }, { text: "💚" }],
              [{ text: "رد کردن همه" }],
            ]);
          } catch (error) {
            console.log(error);
          }
        }
      } else if (userStep === "confirmDismissAllLikes") {
        if (ctx?.message?.text === "بله، پاک کن") {
          try {
            const removedCount = newLikesMap.clearAll(telegramId);

            // اعلام به سرور پردازنده تا آرایه‌ی خودش را هم خالی کند و
            // در flush دوره‌ای بعدی روی Redis اعمال کند (پردازنده تنها
            // writer نهایی است). از همان صف removeFromNewLikesQueue با
            // فلگ clearAll استفاده می‌کنیم، نه یک صف جداگانه.
            removeFromNewLikesQueue.add({
              telegramId: +telegramId,
              clearAll: true,
            });

            existingUser.currentStep.step = "menu";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            await reply(
              ctx,
              next,
              redisClient,
              removedCount > 0
                ? `همه‌ی لایک‌ها پاک شد ✅ (${removedCount} مورد)`
                : "لایکی برای پاک کردن نبود.",
            );

            await reply(
              ctx,
              next,
              redisClient,
              `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
              constants.MENU_KEYBOARD,
            );
          } catch (error) {
            console.log(error);
          }
        } else if (ctx?.message?.text === "انصراف") {
          try {
            // بازگشت امن به مرور لایک‌ها؛ اگر چیزی باقی مانده باشد همان
            // نفر اول صف دوباره نمایش داده می‌شود (چیزی حذف نشده بود).
            existingUser.currentStep.step = "notifications";
            usersMap.set(telegramId, {
              time: Date.now(),
              user: existingUser,
            });

            const userFromRedis = newLikesMap.getEntry(telegramId);
            if (
              userFromRedis &&
              Array.isArray(userFromRedis.likers) &&
              userFromRedis.likers.length > 0
            ) {
              await reply(ctx, next, redisClient, "لغو شد.", [
                [{ text: "❌" }, { text: "💚" }],
                [{ text: "رد کردن همه" }],
              ]);

              const photos = userFromRedis.likers[0].profileImages;
              const fullName = userFromRedis.likers[0].fullName;
              const age = userFromRedis.likers[0].age;
              const state = userFromRedis.likers[0].state;
              const bio = userFromRedis.likers[0].bio;
              const textMessage = userFromRedis.likers[0]?.message;
              const inviteCode_ = userFromRedis.likers[0].inviteCode;

              await replyWithPhoto(
                ctx,
                next,
                photos,
                `${fullName}, ${age}, ${state} ${
                  bio ? "\n" + bio : ""
                } ${textMessage ? `\n\nپیام کاربر به شما 💌 : ` : ""}${textMessage ? textMessage : ""} \n/user_${inviteCode_ || "not_found"}`,
              );
            } else {
              existingUser.currentStep.step = "menu";
              usersMap.set(telegramId, {
                time: Date.now(),
                user: existingUser,
              });

              await reply(
                ctx,
                next,
                redisClient,
                "لغو شد. شما لایکی ندارید",
              );

              await reply(
                ctx,
                next,
                redisClient,
                `1. ${"مشاهده پروفایل ها"}\n2. ${"پروفایل من"}\n3. ${"حالت خواب"}\n----------------------------\n4. ${"دوستان خود را دعوت کنید تا لایک های بیشتری دریافت کنید 😎"}`,
                constants.MENU_KEYBOARD,
              );
            }
          } catch (error) {
            console.log(error);
          }
        } else {
          try {
            await reply(
              ctx,
              next,
              redisClient,
              "⚠️ آیا مطمئن هستید؟ با این کار همه‌ی لایک‌های در انتظار شما پاک می‌شوند و دیگر قابل بازیابی نیستند.",
              [[{ text: "بله، پاک کن" }], [{ text: "انصراف" }]],
            );
          } catch (error) {
            console.log(error);
          }
        }
      }
    } else {
    }
  } else {
    try {
      if (inviteCode) {
        const inviteByUser = await User.findOne({ inviteCode });

        if (inviteByUser) {
          inviteByUser.likesLimit.giftLikeCount += 50;
          try {
            await inviteByUser.save();
            if (!+inviteByUser.telegramId) return;
            await replyBot(
              inviteByUser.telegramId,
              redisClient,
              "ممون از دعوت شما . 50 لایک هدیه دریافت کردید 😎💕",
            );
          } catch (error) {
            console.log(error);
          }

          if (usersMap.get(+inviteByUser.telegramId)) {
            usersMap.get(
              +inviteByUser.telegramId,
            ).user.likesLimit.giftLikeCount += 50;
            usersMap.set(+inviteByUser.telegramId, {
              user: usersMap.get(+inviteByUser.telegramId).user,
              time: Date.now(),
            });
          }
        }
      }
      const saveduser = await User.create({
        telegramId,
        userName: userName || "",
        "likesLimit.giftLikeCount": 20,
        inviteCode: generateInviteCode(telegramId),
        inviteBy: inviteCode || null,
        platform: process.env.PLATFORM,
      });

      await registerInBot(
        ctx,
        next,
        ages,
        chunkArray,
        telegramId,
        telegramName,
        saveduser,
        redisClient,
        forYouList,
        forYouTime,
      );
    } catch (error) {
      console.log(error);
    }
  }
};

bot.start(async (ctx, next) => {
  try {
    await processStatement(ctx, next);
  } catch (error) {
    console.log(error);
  }
});

bot.command("matches", async (ctx, next) => {
  try {
    await reply(ctx, next, redisClient, "جستجوی پروفایل ها ...");

    const findUser = await User.findOne({ telegramId: ctx.from.id });

    if (!findUser) {
      return reply(
        ctx,
        next,
        redisClient,
        "ابتدا ثبت نام کنید \n\n/start",
      );
    }

    const isSubscribed =
      findUser.subscriptionExpireTime != null &&
      findUser.subscriptionExpireTime > Date.now();

    if (!isSubscribed) {
      return reply(
        ctx,
        next,
        redisClient,
        "فقط کاربران 💎پرو به این بخش دسترسی دارند \n\nبا خرید اشتراک 💎پرو میتوانید مچ (matches) های خود را مشاهده کنید 😎👇🏽",
        [],
        [[{ text: "خرید اشتراک پرو 💎", callback_data: "buy_like" }]],
      );
    }

    const matches_ = findUser.matches
      ? findUser.matches.slice(0, 50)
      : [];
    const matchesIds = matches_.map((m) => m.telegramId);

    if (!matchesIds.length) {
      return reply(
        ctx,
        next,
        redisClient,
        "شما هنوز با هیچ کاربری مطابقت داده نشده اید .",
      );
    }

    const matchDocs = await User.find(
      { telegramId: { $in: matchesIds } },
      {
        telegramId: 1,
        fullName: 1,
        age: 1,
        state: 1,
        userName: 1,
        _id: 0,
      },
    );

    // حفظ ترتیب
    const matchesMap = new Map(
      matchDocs.map((m) => [m.telegramId, m]),
    );
    const matches = matchesIds
      .map((id) => matchesMap.get(id))
      .filter(Boolean);

    if (!matches.length) {
      return reply(
        ctx,
        next,
        redisClient,
        "شما هنوز با هیچ کاربری مطابقت داده نشده اید .",
      );
    }

    let matchesStr = "مچ ها (matches) 👇🏽😎\n\n";
    matches.forEach((m) => {
      matchesStr += `${m.fullName} ,${m.age} ,${m.state} ,@${m?.userName || "\n"} \n /match_${generateInviteCode(m.telegramId)}\n-------------------------------------------------\n`;
    });

    await reply(ctx, next, redisClient, matchesStr);
  } catch (error) {
    console.error("[matches command]", error);
  }
});

bot.hears(/\/user_(.+)/, async (ctx, next) => {
  const userId = ctx.match[1]; // مقدار بعد از user_
  const telegramId___ = ctx.from.id;

  let existingUser;
  try {
    const findUser = await User.findOne({ inviteCode: userId });
    if (!userId || userId === "not_found" || !findUser) {
      try {
        await reply(ctx, next, redisClient, "کاربر یافت نشد");
      } catch (error) {
        console.log(error);
      }

      return;
    }
    const {
      fullName,
      age,
      state,
      profileImages,
      bio,
      telegramId,
      inviteCode,
    } = findUser;

    if (usersMap.get(telegramId___)) {
      existingUser = usersMap.get(telegramId___).user;
      existingUser.currentStep.step = "userProfile";
      existingUser.lastViewedByInviteCode = +telegramId;
      usersMap.set(telegramId___, {
        user: existingUser,
        time: Date.now(),
      });
    } else {
      existingUser = await User.findOneAndUpdate(
        { telegramId: telegramId___ },
        {
          currentStep: {
            flow: "bot",
            step: "userProfile",
          },
          lastViewedByInviteCode: +telegramId,
        },
        { returnDocument: "after" },
      );
      usersMap.set(telegramId___, {
        user: existingUser,
        time: Date.now(),
      });
    }

    const photo = profileImages[0];
    const blockedByMee = existingUser?.blockedByMe || [];
    const findBlock = blockedByMee.find((f) => f == +telegramId);

    try {
      await ctx.replyWithPhoto(photo, {
        caption: `${fullName}, ${age}, ${state} ${
          bio ? "\n" + bio : ""
        }\n/user_${userId || "not_found"}`,
        reply_markup: {
          keyboard: [
            [
              {
                text: "گزارش",
              },
              {
                text: findBlock ? "آنبلاک" : "بلاک",
              },
            ],
            [
              {
                text: "بازگشت به منوی اصلی",
              },
            ],
          ],
          resize_keyboard: true,
          is_persistent: true,
        },
      });
    } catch (error) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          `${fullName}, ${age}, ${state} ${
            bio ? "\n" + bio : ""
          }\n/user_${userId || "not_found"}`,
          [
            [
              {
                text: "گزارش",
              },
              {
                text: findBlock ? "آنبلاک" : "بلاک",
              },
            ],
            [
              {
                text: "بازگشت به منوی اصلی",
              },
            ],
          ],
        );
      } catch (error) {
        console.log(error);
      }
    }
  } catch (error) {
    console.log(error);
  }
});

bot.hears(/\/match_(.+)/, async (ctx, next) => {
  const targetInviteCode = ctx.match[1];
  const telegramId = ctx.from.id;

  if (!telegramId || !targetInviteCode) {
    return;
  }

  let targetTelegramId;

  try {
    const findTargetUser = await User.findOne({
      inviteCode: targetInviteCode,
    });

    if (!findTargetUser)
      return await reply(
        ctx,
        next,
        redisClient,
        "مشکلی پیش آمد ، لطفا به پشتیبانی اطلاع دهید f9348",
      );

    const platform = findTargetUser?.platform ?? "bale";
    targetTelegramId = findTargetUser.telegramId;

    let chat;
    try {
      chat = await ctx.telegram.getChat(+targetTelegramId);
    } catch (error) {
      chat = "error";
    }
    console.log({ chat });
    if (chat?.username && chat?.username != "error") {
      const { fullName, age, state, bio } = findTargetUser;
      await reply(
        ctx,
        next,
        redisClient,
        `${fullName}, ${age}, ${state}${
          bio ? "\n" + bio + "\n" : ""
        }\n/user_${targetInviteCode || "not_found"}\nآیدی کاربر : @${chat.username}`,
      );
    } else {
      await User.findOneAndUpdate(
        { telegramId: +targetTelegramId },
        { userName: "" },
      );

      try {
        const findUser = await User.findOne({
          telegramId: +telegramId,
        });
        if (!findUser.usersGiftedByMissedMatch)
          findUser.usersGiftedByMissedMatch = [];

        const alreadyGifted = findUser.usersGiftedByMissedMatch.find(
          (f) => f == +targetTelegramId,
        );

        if (!alreadyGifted) {
          findUser.likesLimit.giftLikeCount =
            findUser.likesLimit.giftLikeCount + 15;
          findUser.usersGiftedByMissedMatch = [
            ...findUser.usersGiftedByMissedMatch,
            +targetTelegramId,
          ];
          await findUser.save();
          await reply(
            ctx,
            next,
            redisClient,
            "متأسفیم! این کاربر ربات را بلاک کرده یا آیدی خود را تغییر داده و امکان نمایش اطلاعات او وجود ندارد.\n\nبه عنوان جبران، ۱۵ لایک هدیه به حساب شما اضافه شد 🎁",
          );
        } else {
          await reply(
            ctx,
            next,
            redisClient,
            "متأسفیم! این کاربر ربات را بلاک کرده یا آیدی خود را تغییر داده و امکان نمایش اطلاعات او وجود ندارد.",
          );
        }
      } catch (_) {}
    }
  } catch (error) {
    try {
      const findUser = await User.findOne({
        telegramId: +telegramId,
      });
      if (!findUser.usersGiftedByMissedMatch)
        findUser.usersGiftedByMissedMatch = [];

      const alreadyGifted = findUser.usersGiftedByMissedMatch.find(
        (f) => f == +targetTelegramId,
      );

      if (!alreadyGifted) {
        findUser.likesLimit.giftLikeCount =
          findUser.likesLimit.giftLikeCount + 15;
        findUser.usersGiftedByMissedMatch = [
          ...findUser.usersGiftedByMissedMatch,
          +targetTelegramId,
        ];
        await findUser.save();
        await reply(
          ctx,
          next,
          redisClient,
          "متأسفیم! این کاربر ربات را بلاک کرده یا آیدی خود را تغییر داده و امکان نمایش اطلاعات او وجود ندارد.\n\nبه عنوان جبران، ۱۵ لایک هدیه به حساب شما اضافه شد 🎁",
        );
      } else {
        await reply(
          ctx,
          next,
          redisClient,
          "متأسفیم! این کاربر ربات را بلاک کرده یا آیدی خود را تغییر داده و امکان نمایش اطلاعات او وجود ندارد.",
        );
      }
    } catch (_) {}
  }
});

bot.on("message", async (ctx, next) => {
  try {
    await processStatement(ctx, next);
  } catch (error) {
    console.log(error);
  }
});

bot.action("done_start", async (ctx, next) => {
  try {
    await ctx.answerCbQuery(); // حذف لودینگ دکمه

    const userName = ctx?.from?.username;

    if (!userName) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "هنوز نام کاربری 'بله' انتخاب نکرده اید ، یک نام کاربری برای خود انتخاب کنید و سپس مجددا امتحان کنید \n حساب کاربری --> شناسه کاربری",
          [],
          [
            [
              {
                text: "انجام دادم ✅",
                callback_data: "done_start",
              },
            ],
          ],
        );
      } catch (error) {
        console.log(error);
      }
    } else {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          `✅ نام کاربری شما : ${userName}`,
        );
      } catch (error) {
        console.log(error);
      }
      // شبیه‌سازی اجرای دستور /start
      await bot.handleUpdate({
        update_id: Date.now(),
        message: {
          message_id: Date.now(),
          from: ctx.from,
          chat: ctx.chat,
          date: Math.floor(Date.now() / 1000),
          text: "/start",
        },
      });
    }
  } catch (error) {
    console.log(error);
  }
});

registerPaymentHandlers(bot);
registerReportHandlers(bot, usersMap);

const PORT = 3005;
async function startServer() {
  // newLikes in redis -- بارگذاری اولیه‌ی Map لایک‌ها، پیش از bot.launch
  await newLikesMap.loadNewLikesMapFromRedis(redisClient);

  bot
    .launch()
    .catch((err) => console.error("Bot launch error:", err));
  console.log("🤖 Bot launched after pool filled");

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Pounes Matching Simulator v2.2`);
    console.log(`📡 http://localhost:${PORT}`);
  });
}

process.on("SIGINT", () => {
  console.log("SIGINT *************************");
  cleanupOldUsersFromMapAndSaveToDB(0);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM *************************");
  cleanupOldUsersFromMapAndSaveToDB(0);
});
process.on("uncaughtException", (err) => {
  console.log(
    `uncaughtException: ${err.message} *************************`,
  );
  cleanupOldUsersFromMapAndSaveToDB(0);
});
process.on("unhandledRejection", (reason) => {
  console.log(
    `unhandledRejection: ${reason} *************************`,
  );
  cleanupOldUsersFromMapAndSaveToDB(0);
});

startServer();
