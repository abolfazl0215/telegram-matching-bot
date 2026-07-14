const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const User = require("./models/User");
const protobuff = require("./app/protobuf");
const cron = require("node-cron");
const { fillPool } = require("./utils/fillPool");
const { updatePoolInRedis } = require("./utils/updatePoolInRedis");
const { addToPool } = require("./utils/addToPool");
const { getCandidates } = require("./utils/getCandidates.js");
const {
  recomputeAllPoolScores,
} = require("./utils/recomputeAllPoolScores");

const monitoringRoute = require("./routes/monitoring.js");

const {
  redisClient,
  cleanupOldUsersQueue,
  newLikeQueue,
  removeFromNewLikesQueue,
  sendMessageToAllQueue,
  addToPoolQueue,
  requestToFillForYouList,
  fillForYouList,
  removeFromExploreQueue,
  invalidateScoreQueue,
} = require("./config/redis");

// config dotenv
require("dotenv").config();

const { computeScore } = require("./utils/computeScore");
// FIX #4 (invalidation): برای sync کردن فوری baseScore کاربری که یه
// لایک جدید دریافت کرده، بدون نیاز به صبر کردن تا چرخه‌ی بعدی fillPool.
const {
  invalidatePoolUserScore,
} = require("./utils/invalidatePoolUserScore");
const state = require("./app/state");
const {
  scheduleCleanupStart,
  loadBlockedUsers,
  getNowTime,
} = require("./app/session");
const bodyParser = require("body-parser");
const { reply } = require("./telegram_methods/reply");
const { AGES, BOT_INVITE_BASE } = require("./app/config");
const {
  generateInviteCode,
} = require("./utils/generateInviteCode.js");
const {
  checkNewLikesForSendNotif,
} = require("./tools/checkNewLikesForSendNotif.js");
const newLikesStore = require("./utils/newLikesStore");
const { replyBot } = require("./telegram_methods/replyBot.js");
const Pictures = require("./models/Pictures.js");
const { removeFromExplore } = require("./utils/removeFromExplore.js");

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
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  req.redisClient = redisClient;
  next();
});

app.use("/", monitoringRoute);

// از این پس newLikesStore (utils/newLikesStore.js) مالک آرایه‌ی لایک‌های
// جدید است. فقط یک‌بار، در startServer و پیش از ثبت پردازشگرهای صف
// newLikeQueue / removeFromNewLikesQueue، از روی Redis بارگذاری می‌شود؛
// دیگر هیچ pull دوره‌ای از Redis نداریم، چون این پردازشگر تنها writer
// نهایی کلید "newLikes" است و pull دوره‌ای می‌توانست تغییرات تازه‌ی
// هنوز-flush-نشده را overwrite کند.

app.use("/", async (req, res) => {
  res.send("hello");
});

// حذف دوره ای عکس های کانفرم شده
cron.schedule("*/35 * * * *", async () => {
  try {
    const confirmedPics = await Pictures.find({ confirm: true });
    if (!confirmedPics.length) return;

    for (const pic of confirmedPics) {
      const user = await User.findOne({
        telegramId: Number(pic.telegramId),
      });
      if (user) {
        user.picScore = pic.score || 1;
        await user.save();
      }
      await Pictures.deleteOne({ _id: pic._id });
    }

    console.log(
      `[cron] Processed ${confirmedPics.length} confirmed pictures`,
    );
  } catch (err) {
    console.error("[cron] Error in picture score sync:", err);
  }
});

const cleanupGuestUsers = async () => {
  try {
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const result = await User.deleteMany({
      guest: true,
      createdAt: { $lt: sevenDaysAgo },
    });

    if (result.deletedCount > 0) {
      console.log(
        `[GuestCleanup] ${result.deletedCount} guest account(s) deleted`,
      );
    }
  } catch (error) {
    console.error("[GuestCleanup] Error:", error);
  }
};

// هر 45 دقیقه یکبار
setInterval(cleanupGuestUsers, 45 * 60 * 1000);

loadBlockedUsers();
scheduleCleanupStart();

const newLikeQueueController = async ({
  // %%%%%%%%%%%
  telegramId,
  liker,
  message,
}) => {
  try {
    let strMessage = "";
    try {
      strMessage = message ? message.toString() : "";
    } catch (e) {}

    // add to received likes
    try {
      const userExists = await User.exists({
        telegramId: +telegramId,
      });
      if (!userExists) {
        console.warn(`[receivedLikes] user not found: ${telegramId}`);
        return;
      }

      const [userScore, at] = await Promise.all([
        computeScore(liker),
        Promise.resolve(Date.now()),
      ]);

      const newLikeEntry = {
        fromTelegramId: +liker.telegramId,
        at,
        likerScore: userScore,
      };

      await User.updateOne(
        { telegramId: +telegramId },
        {
          $push: {
            receivedLikes: {
              $each: [newLikeEntry],
              $position: 0,
              $slice: 100,
            },
          },
        },
      );

      // ── FIX #4 (invalidation) ────────────────────────────────────
      // همون تغییری که به Mongo زدیم ($push با $position:0 و $slice:100)
      // رو دقیقاً به همون شکل روی آبجکت in-memory کاربر در pool هم mirror
      // می‌کنیم تا receivedLikes داخل pool با DB هم‌خوان بمونه، و بعد
      // baseScore این کاربر رو همون لحظه دوباره حساب می‌کنیم. اگه این
      // کاربر فعلاً در pool نباشه (مثلاً هنوز به فید کسی نرسیده)،
      // invalidatePoolUserScore فقط false برمی‌گردونه و هیچ خطایی
      // نمی‌ده؛ baseScoreش وقتی وارد pool بشه (addToPool) یا در چرخه‌ی
      // بعدی fillPool درست محاسبه میشه.
      invalidatePoolUserScore(+telegramId, (user) => {
        if (!Array.isArray(user.receivedLikes)) {
          user.receivedLikes = [];
        }
        user.receivedLikes.unshift(newLikeEntry);
        if (user.receivedLikes.length > 100) {
          user.receivedLikes.length = 100;
        }
      });
    } catch (err) {
      console.error(`[receivedLikes] failed for ${telegramId}:`, err);
    }

    // به‌جای دستکاری مستقیم آرایه و نوشتن فوری در Redis (که هم race با
    // نوشتن سمت ربات داشت و هم به‌ازای هر لایک یک بار کل آرایه رو در
    // Redis می‌نوشت)، حالا فقط newLikesStore رو صدا می‌زنیم؛ خودش دوپلیکیت
    // رو چک می‌کنه و به‌صورت دوره‌ای (نه فوری) flush می‌شه.
    newLikesStore.addLike(telegramId, liker, strMessage);
  } catch (error) {
    console.log(error);
  }
};

// توجه: newLikeQueue، addToPoolQueue، removeFromExploreQueue،
// requestToFillForYouList و removeFromNewLikesQueue عمداً اینجا ثبت
// (process) نمی‌شوند. newLikeQueue و removeFromNewLikesQueue چون از این
// پس به newLikesStore وابسته‌اند که باید پیش از پردازش هر job از Redis
// بارگذاری شده باشد (وگرنه یک job ممکن است قبل از بارگذاری اولیه پردازش
// شود و بعد بارگذاری آن را overwrite کند). بقیه هم چون به pool/state ای
// وابسته‌اند که fillPool() می‌سازد. ثبت همه‌ی این‌ها به داخل startServer()
// منتقل شده تا جاب‌های موجود در صف Redis زودتر از موعد، روی state ناقص
// پردازش نشوند.

const sendMessageToAllQueueController = async ({
  telegramId,
  text,
}) => {
  await replyBot(telegramId, redisClient, text);
};

sendMessageToAllQueue.process(2, async (job) => {
  const { telegramId, text } = job.data;
  try {
    await sendMessageToAllQueueController({ telegramId, text });
  } catch (error) {
    console.error("Error processing explore queue:", error);
  }
});

app.post("/sendMessageToAll", async (req, res) => {
  try {
    const users = await User.find({}, { telegramId: 1 }); // فقط فیلد مورد نیاز را واکشی کنید

    // استفاده از Promise.all برای اضافه کردن سریع به صف
    await Promise.all(
      users.map((u) => {
        if (!blockedUsers.has(String(u.telegramId))) {
          sendMessageToAllQueue.add({
            telegramId: +u.telegramId,
            text: "",
          });
        }
      }),
    );

    res.send(`Success ✅ : ${users.length} jobs added to queue.`);
  } catch (err) {
    res.status(500).send("Error adding jobs");
  }
});

cleanupOldUsersQueue.process(2, async (job) => {
  const { telegramId, currentUser } = job.data;

  try {
    await User.findOneAndUpdate(
      { telegramId: Number(telegramId) },
      {
        $set: {
          fullName: currentUser.fullName ?? "",
          userName: currentUser.userName ?? "",
          inviteCode: currentUser.inviteCode ?? "",
          inviteBy: currentUser.inviteBy ?? "",

          age: currentUser.age ?? 18,
          gender: currentUser.gender ?? "male",
          lookingFor: currentUser.lookingFor ?? "noMatter",
          state: currentUser.state ?? "tehran",
          bio: currentUser.bio ?? "",

          lastActivity: Date.now(),
          picScore: currentUser.picScore ?? 50,

          sleep: currentUser.sleep ?? false,
          ban: currentUser.ban ?? false,

          lastViewedByInviteCode:
            currentUser.lastViewedByInviteCode ?? 1,

          likesLimit: currentUser.likesLimit ?? {
            firstLikeTime: Date.now(),
            likesCount: 0,
            giftLikeCount: 20,
          },

          currentStep: currentUser.currentStep ?? {
            flow: "register",
            step: "welcomeMessage",
          },

          forTutorial: currentUser.forTutorial ?? {
            firstLike: 0,
            firstNope: 0,
          },

          usersGiftedByMissedMatch:
            currentUser.usersGiftedByMissedMatch ?? [],

          fcmToken: currentUser.fcmToken ?? "",
          platform: currentUser.platform ?? "",
          appId: currentUser.appId ?? "",
          isGuest: currentUser.isGuest ?? false,

          subscriptionExpireTime:
            currentUser.subscriptionExpireTime ?? Date.now(),

          profileCompletedPercent:
            currentUser.profileCompletedPercent ?? 70,

          ageRange: currentUser.ageRange ?? {
            min: 18,
            max: 30,
          },

          profileImages: currentUser.profileImages ?? [],
          profileImagesEdit: currentUser.profileImagesEdit ?? [],

          receivedLikes: currentUser.receivedLikes ?? [],
          likedByMe: currentUser.likedByMe ?? [],
          nopedByMe: currentUser.nopedByMe ?? [],
          blockedByMe: currentUser.blockedByMe ?? [],
          blockedMe: currentUser.blockedMe ?? [],
          reportedByMe: currentUser.reportedByMe ?? [],
          matches: currentUser.matches ?? [],
          likedAges: currentUser.likedAges ?? [],

          lastGetCandidatesAt: currentUser.lastGetCandidatesAt ?? 1,
          getCandidatesCount: currentUser.getCandidatesCount ?? 0,
        },
      },
      { upsert: true, returnDocument: "after" },
    );
  } catch (error) {
    console.error(
      "Error processing cleanup queue:",
      error.message,
      error.stack,
    );
    throw error; // re-throw so the queue correctly marks this job as failed
  }
});

// send remembering message <<<<<<<<<<<<<<<<<<<<<<<<<<<
// send remembering message <<<<<<<<<<<<<<<<<<<<<<<<<<<

const checkForSendRememberMessage = async () => {
  const query = {
    $or: [{ fullName: "" }, { fullName: { $exists: false } }],
    rememberingMessage: {
      $in: [null, 0, 1, 2],
    },
  };
  const users = await User.find(query);
  if (Array.isArray(users) && users.length > 0) {
    console.log("users : ", users.length);
    for (let user of users) {
      if (!blockedUsers.has(String(user.telegramId))) {
        console.log(" -------- ", user.telegramId);
        if (
          !user.rememberingMessage ||
          user.rememberingMessage == 0
        ) {
          try {
            if (user.createdAt + 1 > Date.now()) continue;
            // if (user.createdAt + 1800000 > Date.now()) return;
            await User.findByIdAndUpdate(user._id, {
              rememberingMessage: 1,
            });
            const textMessage = `درود خوبی؟ 😊  \n
  این ربات مثل بقیه ربات‌های دوستیابی نیست؛ اینجا خبری از اکانت‌های فیک نیست و ما ساختار متفاوتی رو پیاده کردیم تا تجربه‌ی بهتری داشته باشی.\n
  ارزششو داره که امتحانش کنی! همین الان کلی دختر و پسر واقعی منتظر پیدا کردن یه دوست جدید یا یه آشنایی خوب هستن.\n
  هر سوالی داشتی ازم میتونی بپرسی \n
  @abolfazl021mokhtari\n@abolfazl021mokhtari
  `;
            await replyBot(
              +user.telegramId,
              redisClient,
              textMessage,
              [],
              [
                [
                  {
                    text: "بزن بریم 😎",
                    callback_data: "done_start",
                  },
                ],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        } else if (user.rememberingMessage == 1) {
          try {
            if (user.createdAt + 86400000 > Date.now()) continue;
            await User.findByIdAndUpdate(user._id, {
              rememberingMessage: 2,
            });
            const textMessage = `درود! 👋 \nهنوز فرصت نکردی پروفایلت رو بسازی؟ یادت باشه که پروفایل کامل، شانس پیدا کردن دوست یا آشنایی عالی رو چند برابر می‌کنه. 😉\nدر پونس گپ، ما روی ارتباطات واقعی تمرکز کردیم.
  `;
            await replyBot(
              +user.telegramId,
              redisClient,
              textMessage,
              [],
              [
                [
                  {
                    text: "بزن بریم 😎",
                    callback_data: "done_start",
                  },
                ],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        } else if (user.rememberingMessage == 2) {
          try {
            if (user.createdAt + 172800000 > Date.now()) continue;
            await User.findByIdAndUpdate(user._id, {
              rememberingMessage: 3,
            });
            const textMessage = `درود! چطوری؟ 🙂 \nاگر در مورد تکمیل پروفایلت سوالی داری یا نیاز به راهنمایی داری، من اینجام که کمکت کنم! @abolfazl021mokhtari \nفقط کافیه دکمه زیر رو بزنی تا مراحل رو با هم مرور کنیم.
  `;
            await replyBot(
              +user.telegramId,
              redisClient,
              textMessage,
              [],
              [
                [
                  {
                    text: "بزن بریم 😎",
                    callback_data: "done_start",
                  },
                ],
              ],
            );
          } catch (error) {
            console.log(error);
          }
        }
      }
    }
    console.log("finish");
  }
};

setTimeout(async () => {
  await checkForSendRememberMessage();
}, 1800000);
// send remembering message >>>>>>>>>>>>>>>>>>>>>>>>>>>
// send remembering message >>>>>>>>>>>>>>>>>>>>>>>>>>>

setInterval(async () => {
  // %%%%%%%%%%%%
  try {
    console.log("start check new like");
    // از این پس به‌جای اینکه خودش مستقل از Redis بخونه، آرایه‌ی
    // درون‌حافظه‌ای newLikesStore (که همیشه تازه‌ترینه) رو می‌گیره؛
    // هر تغییری (حذف کاربر قدیمی/بلاک‌شده و ...) هم از طریق store اعمال
    // می‌شه تا در flush دوره‌ای بعدی خودش رو در Redis منعکس کنه.
    await checkNewLikesForSendNotif(redisClient, newLikesStore);
  } catch (error) {
    console.log(error);
  }
  // }, 10000);
}, 3600000);

const PORT = 3010;
async function startServer() {
  console.time("ّFill pool started in");
  await fillPool();
  console.timeEnd("ّFill pool started in");

  // ── newLikesStore ──────────────────────────────────────────────
  // باید پیش از ثبت newLikeQueue.process / removeFromNewLikesQueue.process
  // از روی Redis بارگذاری شود، وگرنه یک job که زودتر از موعد پردازش شود
  // با بارگذاری اولیه overwrite می‌شود و آن لایک/حذف گم می‌شود.
  await newLikesStore.loadFromRedis(redisClient);
  // flush دوره‌ای؛ فقط وقتی چیزی تغییر کرده باشد واقعاً در Redis می‌نویسد.
  newLikesStore.startPeriodicFlush(redisClient, 15000);

  newLikeQueue.process(2, async (job) => {
    const { telegramId, liker, message } = job.data;
    try {
      await newLikeQueueController({ telegramId, liker, message });
    } catch (error) {
      console.error("Error processing explore queue:", error);
    }
  });

  removeFromNewLikesQueue.process(5, async (job) => {
    const { telegramId, likerTelegramId, clearAll } = job.data;
    try {
      // «رد کردن همه»: به‌جای اضافه کردن یک صف کاملاً جدید فقط برای این
      // یک حالت، همین صف موجود را با یک فلگ گسترش دادیم — چون از نظر
      // معنایی همچنان «حذف از لیست لایک‌های در انتظار» است، فقط دسته‌جمعی.
      if (clearAll) {
        const cleared = newLikesStore.clearAll(telegramId);
        if (!cleared) {
          console.log(
            `[removeFromNewLikesQueue] چیزی برای پاک کردن همه پیدا نشد: target=${telegramId}`,
          );
        }
        return;
      }

      const removed = newLikesStore.removeLike(
        telegramId,
        likerTelegramId,
      );
      if (!removed) {
        console.log(
          `[removeFromNewLikesQueue] چیزی برای حذف پیدا نشد: target=${telegramId} liker=${likerTelegramId}`,
        );
      }
    } catch (error) {
      console.error(
        "Error processing removeFromNewLikesQueue:",
        error,
      );
    }
  });

  // این پردازشگرها فقط بعد از تکمیل fillPool ثبت می‌شوند، چون addToPool،
  // removeFromExplore و getCandidates روی pool/state ای کار می‌کنند که
  // fillPool می‌سازد. اگر زودتر ثبت شوند و در Redis جابی منتظر باشد،
  // Bull بلافاصله (حتی قبل از پایان fillPool) آن را پردازش می‌کند.
  addToPoolQueue.process(2, async (job) => {
    const { user } = job.data;
    try {
      await addToPool(user);
    } catch (error) {
      console.error("Error processing add to pool :", error);
    }
  });

  removeFromExploreQueue.process(2, async (job) => {
    const { user } = job.data;
    try {
      await removeFromExplore(user);
    } catch (error) {
      console.error("Error processing add to pool :", error);
    }
  });

  // ── FIX #4 (invalidation) ────────────────────────────────────────
  // مصرف‌کننده‌ی صف invalidateScoreQueue. هر سرور دیگری (مثل بات‌سرور)
  // که یه فیلد اثرگذار روی computeScore رو برای یه کاربر عوض می‌کنه
  // (خرید اشتراک، تکمیل پروفایل، ساخته‌شدن match جدید و ...) باید یه
  // job با شکل { telegramId, patch } به این صف اضافه کنه:
  //
  //   invalidateScoreQueue.add({
  //     telegramId: 123456,
  //     patch: { subscriptionExpireTime: Date.now() + 30*86400000 },
  //   });
  //
  // patch یه آبجکت ساده از فیلدهایی هست که باید روی user در pool
  // merge (Object.assign) بشن؛ بعدش computeScore دوباره برای همون یک
  // نفر حساب میشه. اگه کاربر فعلاً در pool نباشه، کاری انجام نمیشه
  // (چون invalidatePoolUserScore خودش false برمی‌گردونه) و baseScore
  // این کاربر هروقت وارد pool بشه (addToPool) یا در چرخه‌ی بعدی
  // fillPool، به‌درستی محاسبه خواهد شد.
  invalidateScoreQueue.process(5, async (job) => {
    const { telegramId, patch } = job.data;
    try {
      const changed = invalidatePoolUserScore(telegramId, (user) => {
        if (patch && typeof patch === "object") {
          Object.assign(user, patch);
        }
      });
      if (!changed) {
        console.log(
          `[invalidateScoreQueue] user ${telegramId} not in pool yet; skipped.`,
        );
      }
    } catch (error) {
      console.error(
        `[invalidateScoreQueue] Failed for telegramId ${telegramId}:`,
        error,
      );
    }
  });

  requestToFillForYouList.process(5, async (job) => {
    const { user } = job.data;
    try {
      const candidates = await getCandidates(user);
      fillForYouList.add({ telegramId: user.telegramId, candidates });
    } catch (error) {
      console.error("Error processing add to pool :", error);
    }
  });

  setInterval(
    async () => {
      await updatePoolInRedis();
    },
    5 * 60 * 1000,
  );

  // ── RECOMPUTE سبک دوره‌ای ────────────────────────────────────────
  // رفرش baseScore تمام کاربرهای pool، بدون I/O، برای جلوگیری از
  // فریز شدن امتیازهای وابسته به گذر زمان (activity/cold-start/...)
  setInterval(
    async () => {
      await recomputeAllPoolScores();
    },
    10 * 60 * 1000, // هر ۱۰ دقیقه
  );

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Pounes Matching Simulator v2.2`);
    console.log(`📡 http://localhost:${PORT}`);
  });
}

// ── Graceful shutdown ──────────────────────────────────────────────
// چون flush آرایه‌ی newLikes حالا دوره‌ای (هر ۱۵ ثانیه) است نه فوری،
// ممکن است در لحظه‌ی ری‌استارت/دیپلوی، چند ثانیه‌ی آخر هنوز flush نشده
// باشد. برای جلوگیری از گم‌شدن آن تغییرات، پیش از خروج یک بار force
// flush می‌کنیم.
async function gracefulShutdown(signal) {
  try {
    console.log(
      `[shutdown] دریافت ${signal}، در حال flush نهایی newLikes...`,
    );
    await newLikesStore.flushToRedis(redisClient, true);
  } catch (error) {
    console.error("[shutdown] خطا در flush نهایی:", error);
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

startServer();
