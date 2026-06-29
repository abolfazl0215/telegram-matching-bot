const express = require("express");
const cors = require("cors");
const http = require("http");
const mongoose = require("mongoose");
const User = require("./models/User");
const protobuff = require("./app/protobuf");
const cron = require("node-cron");

const {
  redisClient,
  cleanupOldUsersQueue,
  newLikeQueue,
  sendMessageToAllQueue,
} = require("./config/redis");

// config dotenv
require("dotenv").config();

const { computeScore } = require("./utils/computeScore");
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
const { replyBot } = require("./telegram_methods/replyBot.js");
const Pictures = require("./models/Pictures.js");

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

let usersArrayFromRedis = [];
const getNewLikesFromProtoBuff = async () => {
  const getData = await redisClient.getBuffer("newLikes");

  if (!Buffer.isBuffer(getData)) {
    return res.json({
      likes: [],
    });
  }

  protobuff.loadNewLikeProto();

  const decodedMessage = protobuff.NewLikeProto.decode(getData);

  // تبدیل protobuf به object js عادی
  const data = protobuff.NewLikeProto.toObject(decodedMessage, {
    longs: Number, // int64 -> number
    enums: String,
    defaults: true,
    arrays: true,
    objects: true,
  });

  usersArrayFromRedis = data.users || [];
};
setTimeout(async () => {
  await getNewLikesFromProtoBuff();
}, 0);
setInterval(async () => {
  await getNewLikesFromProtoBuff();
}, 10000);

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

      await User.updateOne(
        { telegramId: +telegramId },
        {
          $push: {
            receivedLikes: {
              $each: [
                {
                  fromTelegramId: +liker.telegramId,
                  at,
                  likerScore: userScore,
                },
              ],
              $position: 0,
              $slice: 100,
            },
          },
        },
      );
    } catch (err) {
      console.error(`[receivedLikes] failed for ${telegramId}:`, err);
    }

    const findLike = usersArrayFromRedis.find(
      (f) => Number(f.telegramId) === Number(telegramId),
    );

    if (findLike) {
      const findLiker = findLike.likers.find(
        (f) => Number(f.telegramId) === Number(liker.telegramId),
      );

      if (!findLiker) {
        findLike.likers.push({
          _id: liker._id,
          telegramId: Number(liker.telegramId),
          fullName: liker.fullName,
          userName: liker.userName,
          age: liker.age,
          gender: liker.gender,
          lookingFor: liker.lookingFor,
          state: liker.state,

          sleep: liker.sleep,

          bio: liker.bio,
          profileImages: liker.profileImages,
          inviteCode: liker.inviteCode,

          platform: liker.platform,
          fcmToken: liker.fcmToken,

          message: strMessage || "",
        });
      }
    } else {
      usersArrayFromRedis.push({
        telegramId: Number(telegramId),
        time: Date.now(),
        likers: [
          {
            _id: liker._id,
            telegramId: liker.telegramId,
            fullName: liker.fullName,
            userName: liker.userName,
            age: liker.age,
            gender: liker.gender,
            lookingFor: liker.lookingFor,
            state: liker.state,

            sleep: liker.sleep,

            bio: liker.bio,
            profileImages: liker.profileImages,
            inviteCode: liker.inviteCode,

            platform: liker.platform,
            fcmToken: liker.fcmToken,

            message: strMessage || "",
          },
        ],
      });
    }

    // اعتبارسنجی داده‌ها
    const errMsg = protobuff.NewLikeProto.verify({
      users: usersArrayFromRedis,
    });
    if (errMsg) {
      console.log("Protobuf validation error:", errMsg);
      return;
    }

    // تبدیل به protobuf و ذخیره در ردیس
    const message_ = protobuff.NewLikeProto.create({
      users: usersArrayFromRedis,
    });
    const buffer = protobuff.NewLikeProto.encode(message_).finish();
    await redisClient.set("newLikes", buffer);
  } catch (error) {
    console.log(error);
  }
};

newLikeQueue.process(2, async (job) => {
  const { telegramId, liker, message } = job.data;
  try {
    await newLikeQueueController({ telegramId, liker, message });
  } catch (error) {
    console.error("Error processing explore queue:", error);
  }
});

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
    await checkNewLikesForSendNotif(
      redisClient,
      protobuff.NewLikeProto,
      protobuff.loadNewLikeProto,
    );
  } catch (error) {
    console.log(error);
  }
}, 10000);
// }, 3600000);

const PORT = 3010;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n🚀 Pounes Matching Simulator v2.2`);
  console.log(`📡 http://localhost:${PORT}`);
});
