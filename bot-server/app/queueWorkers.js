const {
  goToNotificationMenu,
  cleanupOldUsersQueue,
  newLikeQueue,
  redisClient,
} = require("../config/redis");
const User = require("../models/User");
const { computeScore } = require("../utils/computeScore");
const protobuff = require("./protobuf");
const state = require("./state");
const lastViewed = state.lastViewed;

// const newLikeQueueController = async ({
//   telegramId,
//   liker,
//   message,
// }) => {
//   try {
//     let strMessage = "";
//     try {
//       strMessage = message ? message.toString() : "";
//     } catch (e) {}

//     // add to received likes
//     try {
//       const userExists = await User.exists({
//         telegramId: +telegramId,
//       });
//       if (!userExists) {
//         console.warn(`[receivedLikes] user not found: ${telegramId}`);
//         return;
//       }

//       const [userScore, at] = await Promise.all([
//         computeScore(liker),
//         Promise.resolve(Date.now()),
//       ]);

//       await User.updateOne(
//         { telegramId: +telegramId },
//         {
//           $push: {
//             receivedLikes: {
//               $each: [
//                 {
//                   fromTelegramId: +liker.telegramId,
//                   at,
//                   likerScore: userScore,
//                 },
//               ],
//               $position: 0,
//               $slice: 100,
//             },
//           },
//         },
//       );
//     } catch (err) {
//       console.error(`[receivedLikes] failed for ${telegramId}:`, err);
//     }

//     // ست کردن کاربران اولیه در forYou
//     const getData = await redisClient.getBuffer(`newLikes`);

//     // liker = me
//     // telegramId = user telegram id

//     if (Buffer.isBuffer(getData)) {
//       await protobuff.loadNewLikeProto();
//       const decodedMessage = protobuff.NewLikeProto.decode(getData);
//       let usersArrayFromRedis = decodedMessage.users || [];

//       const findLike = usersArrayFromRedis.find(
//         (f) => Number(f.telegramId) === Number(telegramId),
//       );

//       if (findLike) {
//         const findLiker = findLike.likers.find(
//           (f) => Number(f.telegramId) === Number(liker.telegramId),
//         );

//         if (!findLiker) {
//           findLike.likers.push({
//             _id: liker._id,
//             telegramId: Number(liker.telegramId),
//             fullName: liker.fullName,
//             userName: liker.userName,
//             age: liker.age,
//             gender: liker.gender,
//             lookingFor: liker.lookingFor,
//             state: liker.state,

//             sleep: liker.sleep,

//             bio: liker.bio,
//             profileImages: liker.profileImages,
//             inviteCode: liker.inviteCode,

//             platform: liker.platform,
//             fcmToken: liker.fcmToken,

//             message: strMessage || "",
//           });
//         }
//       } else {
//         usersArrayFromRedis.push({
//           telegramId: Number(telegramId),
//           time: Date.now(),
//           likers: [
//             {
//               _id: liker._id,
//               telegramId: liker.telegramId,
//               fullName: liker.fullName,
//               userName: liker.userName,
//               age: liker.age,
//               gender: liker.gender,
//               lookingFor: liker.lookingFor,
//               state: liker.state,

//               sleep: liker.sleep,

//               bio: liker.bio,
//               profileImages: liker.profileImages,
//               inviteCode: liker.inviteCode,

//               platform: liker.platform,
//               fcmToken: liker.fcmToken,

//               message: strMessage || "",
//             },
//           ],
//         });
//       }

//       // اعتبارسنجی داده‌ها
//       const errMsg = protobuff.NewLikeProto.verify({
//         users: usersArrayFromRedis,
//       });
//       if (errMsg) {
//         console.log("Protobuf validation error:", errMsg);
//         return;
//       }

//       // تبدیل به protobuf و ذخیره در ردیس
//       const message_ = protobuff.NewLikeProto.create({
//         users: usersArrayFromRedis,
//       });
//       const buffer = protobuff.NewLikeProto.encode(message_).finish();
//       await redisClient.set("newLikes", buffer);
//     } else {
//       const likers = [
//         {
//           telegramId,
//           time: Date.now(),
//           likers: [
//             {
//               _id: liker._id,
//               telegramId: liker.telegramId,
//               fullName: liker.fullName,
//               userName: liker.userName,
//               age: liker.age,
//               gender: liker.gender,
//               lookingFor: liker.lookingFor,
//               state: liker.state,

//               sleep: liker.sleep,

//               bio: liker.bio,
//               profileImages: liker.profileImages,
//               inviteCode: liker.inviteCode,

//               platform: liker.platform,
//               fcmToken: liker.fcmToken,

//               message: strMessage || "",
//             },
//           ],
//         },
//       ];

//       await protobuff.loadNewLikeProto();
//       const message_ = protobuff.NewLikeProto.create({
//         users: likers,
//       });
//       const buffer = protobuff.NewLikeProto.encode(message_).finish();
//       await redisClient.set("newLikes", buffer);
//     }
//   } catch (error) {
//     console.log(error);
//   }
// };

function registerLocalQueueWorkers() {

  goToNotificationMenu.process(1, async (job) => {
    const { telegramId } = job.data;
    try {
      const id = +telegramId;
      const userEntry = state.usersMap.get(id);
      if (userEntry) {
        const user = userEntry.user;
        user.currentStep.flow = "bot";
        user.currentStep.step = "notificationMenu";
        state.usersMap.set(id, { user, time: Date.now() });
      }
    } catch (error) {
      console.error("Error processing explore queue:", error);
    }
  });

}

module.exports = { registerLocalQueueWorkers };
