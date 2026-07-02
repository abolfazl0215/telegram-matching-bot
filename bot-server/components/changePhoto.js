const axios = require("axios");
const User = require("../models/User");
const { uploadImageFromUrl } = require("./uploadImageFromUrl");
const usersMap = require("../utils/usersMap");
const Pictures = require("../models/Pictures");
const fs = require("fs");
const { reply } = require("../telegram_methods/reply");
const { checkUrl } = require("../utils/checkUrl");
const { lastTimeAddProfileToList } = require("../app/state");
const { addToPool } = require("../utils/addToPool");
const {
  addToPoolQueue,
  requestToFillForYouList,
} = require("../config/redis");
const {
  SEARCH_KEYBOARD,
  MY_PROFILE_MENU_KEYBOARD,
} = require("../bot/constants");
const {
  getUserProfilePicture,
} = require("../utils/getProfilePicture");
const {
  replyWithPhoto,
} = require("../telegram_methods/replyWithPhoto");

const changePhoto = async (
  ctx,
  next,
  telegramId,
  existingUser,
  redisClient,
  forYouList,
  forYouTime,
) => {
  if (existingUser.currentStep.step === "isCorrectProfile") {
    const lastTime = lastTimeAddProfileToList.get(telegramId) ?? 0;
    if (lastTime + 500000 < Date.now()) {
      lastTimeAddProfileToList.set(telegramId, Date.now());
      addToPoolQueue.add({ user: existingUser });
    }

    // fill forYou list
    const currentList = forYouList.get(telegramId);
    if (
      !currentList ||
      (Array.isArray(currentList) && currentList.length < 5)
    ) {
      requestToFillForYouList.add({ user: existingUser });
    }
    if (ctx?.message?.text === "بله") {
      try {
        existingUser.currentStep.flow = "bot";
        existingUser.currentStep.step = "search";
        existingUser.profileImagesEdit = [];
        existingUser.currentStep.step = "";
        // await existingUser.save();
        usersMap.set(telegramId, {
          time: Date.now(),
          user: existingUser,
        });

        try {
          existingUser.currentStep.flow = "bot";
          existingUser.currentStep.step = "search";
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });

          await reply(
            ctx,
            next,
            redisClient,
            "در حال جستجوی افراد ...",
            SEARCH_KEYBOARD,
          );

          const { fullName, age, state, flag, bio, profileImages } =
            forYouList.get(telegramId)[0];

          const photos = profileImages;

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `,
          );

          forYouList.set(
            telegramId,
            forYouList.get(telegramId).slice(1),
          );
        } catch (error) {
          console.log({ error });
        }
      } catch (error) {
        try {
          await reply(
            ctx,
            next,
            redisClient,
            "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو) y823",
          );
        } catch (error) {
          console.log(error);
        }
      }
    } else if (ctx?.message?.text === "ویرایش پروفایلم") {
      try {
        existingUser.currentStep.flow = "editProfile";
        existingUser.currentStep.step = "editProfileMenu";

        // await existingUser.save();
        usersMap.set(telegramId, {
          time: Date.now(),
          user: existingUser,
        });

        await reply(
          ctx,
          next,
          redisClient,
          `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`,
          MY_PROFILE_MENU_KEYBOARD,
        );
      } catch (error) {
        console.log({ error });
      }
    } else {
      const photos = existingUser.profileImages || [];
      const fullName = existingUser.fullName;
      const age = existingUser.age;
      const state = existingUser.state;
      const bio = existingUser?.bio ?? "";

      try {
        await replyWithPhoto(
          ctx,
          next,
          photos,
          `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `,
        );

        await reply(
          ctx,
          next,
          redisClient,
          "درسته ؟",
          process.env.PLATFORM == "bale"
            ? [[{ text: "بله" }, { text: "ویرایش پروفایلم" }]]
            : [[{ text: "ویرایش پروفایلم" }, { text: "بله" }]],
        );
      } catch (error) {
        try {
          await reply(
            ctx,
            next,
            redisClient,
            "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو)",
          );
          console.log({ error });
        } catch (e) {}
      }

      return;
    }
  } else if (ctx?.message?.text === "بازگشت") {
    try {
      existingUser.currentStep.flow = "editProfile";
      existingUser.currentStep.step = "editProfileMenu";
      existingUser.profileImagesEdit = [];
      // await existingUser.save();
      usersMap.set(telegramId, {
        time: Date.now(),
        user: existingUser,
      });

      await reply(
        ctx,
        next,
        redisClient,
        `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`,
        MY_PROFILE_MENU_KEYBOARD,
      );
    } catch (error) {
      console.log({ error });
    }
  } else if (
    ctx?.message?.text === "عکس پروفایل تلگرامم را قرار بده"
  ) {
    try {
      const profilePicture = await getUserProfilePicture(ctx);

      if (profilePicture) {
        ctx.reply("⌛️");

        const imageUrl = profilePicture.fileId;
        const photos = existingUser.profileImagesEdit || [];
        if (photos.length < 3) {
          photos.push(imageUrl);
          await Pictures.create({
            telegramId: +telegramId || existingUser.telegramId || 0,
            fullName: existingUser.fullName || "",
            bio: existingUser?.bio || "",
            state: existingUser?.state || "",
            url: imageUrl,
            createdAt: Date.now(),
          });
        }

        existingUser.profileImages = photos;
        // await existingUser.save();
        await User.findOneAndUpdate(
          { telegramId },
          {
            profileImagesEdit: existingUser.profileImages,
          },
        );

        usersMap.set(telegramId, {
          time: Date.now(),
          user: existingUser,
        });

        if (photos.length === 1) {
          ctx.reply("عکس اضافه شد - 1 از 3. یکی بیشتر؟", {
            reply_markup: {
              keyboard: [
                [
                  {
                    text: "تمام ، ذخیره تصاویر ✅",
                  },
                ],
              ],
              resize_keyboard: true,
              one_time_keyboard: false,
              is_persistent: true,
            },
          });
        } else if (photos.length === 2) {
          ctx.reply("عکس اضافه شد - 2 از 3. یکی بیشتر؟", {
            reply_markup: {
              keyboard: [
                [
                  {
                    text: "تمام ، ذخیره تصاویر ✅",
                  },
                ],
              ],
              resize_keyboard: true,
              one_time_keyboard: false,
              is_persistent: true,
            },
          });
        } else {
          ctx.reply("تمام ، ذخیره تصاویر ✅");
        }

        return;
        // }
        // await ctx.reply(
        //   `عکس پروفایل شما: ${profilePicture.fileUrl}`,
        // );
      } else {
        await ctx.reply(
          "شما عکس پروفایل ندارید یا عکس شما خصوصی است.",
        );
      }
    } catch (error) {
      console.log({ error });
      ctx.reply("مشکلی پیش امد" + "r29");
    }
  } else if (ctx.message.photo) {
    try {
      const photos = existingUser.profileImagesEdit || [];
      if (photos.length === 3) return;
      await reply(ctx, next, redisClient, "⌛️");

      const fileId = ctx.message.photo.at(-1).file_id;
      const fileLink = await ctx.telegram.getFileLink(fileId);

      // const imageUrl = await uploadImageFromUrl(fileLink);
      // const imageUrl = fileLink?.href || "";
      const imageUrl = fileId || "";
      console.log({imageUrl})
      console.log("href : ",fileLink?.href )
      if (photos.length === 3) return;
      photos.push(imageUrl);
      await Pictures.create({
        telegramId: +telegramId || existingUser.telegramId || 0,
        fullName: existingUser.fullName || "",
        bio: existingUser?.bio || "",
        state: existingUser?.state || "",
        url: imageUrl,
        createdAt: Date.now(),
      });
      existingUser.profileImagesEdit = photos;
      // await existingUser.save();
      usersMap.set(telegramId, {
        time: Date.now(),
        user: existingUser,
      });

      if (photos.length === 1) {
        ctx.reply("عکس اضافه شد - 1 از 3. یکی بیشتر؟", {
          reply_markup: {
            keyboard: [
              [
                {
                  text: "تمام ، ذخیره تصاویر ✅",
                },
              ],
            ],
            resize_keyboard: true,
          },
        });
      } else if (photos.length === 2) {
        ctx.reply("عکس اضافه شد - 2 از 3. یکی بیشتر؟", {
          reply_markup: {
            keyboard: [
              [
                {
                  text: "تمام ، ذخیره تصاویر ✅",
                },
              ],
            ],
            resize_keyboard: true,
          },
        });
      } else {
        // setTimeout(async () => {
        try {
          existingUser.profileImages = existingUser.profileImagesEdit;
          existingUser.profileImagesEdit = [];
          existingUser.currentStep.step = "isCorrectProfile";
          // if (!existingUser?.limitGetPicture) {
          //   existingUser.limitGetPicture = {
          //     time: Date.now(),
          //     count: 1,
          //   };
          // } else {
          //   try {
          //     existingUser.limitGetPicture.count += 1;
          //   } catch (_) {}
          // }
          // await existingUser.save();
          usersMap.set(telegramId, {
            time: Date.now(),
            user: existingUser,
          });
          const photos = existingUser.profileImages || [];
          const fullName = existingUser.fullName;
          const age = existingUser.age;
          const state = existingUser.state;
          const bio = existingUser?.bio ?? "";

          await replyWithPhoto(
            ctx,
            next,
            photos,
            `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `,
          );

          await reply(
            ctx,
            next,
            redisClient,
            "درسته ؟",
            process.env.PLATFORM == "bale"
              ? [[{ text: "بله" }, { text: "ویرایش پروفایلم" }]]
              : [[{ text: "ویرایش پروفایلم" }, { text: "بله" }]],
          );
        } catch (error) {
          try {
            console.log({ error });
            await reply(
              ctx,
              next,
              redisClient,
              "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو) lk39",
            );
          } catch (e) {}
        }
        // }, 1000);

        return;
      }

      return;
    } catch (error) {
      try {
        console.log({ error: error.message });
        await reply(
          ctx,
          next,
          redisClient,
          "⭕ مشکل در آپلود تصویر\n\nمشکل به احتمال زیاد از زیرساخت بله یا سرعت اینترنت است لطفا ساعتی بعد مجددا امتحان کنید\nپشتیبانی : @abolfazl021mokhtari",
        );
      } catch (e) {}
    }
  } else if (ctx?.message?.text === "تمام ، ذخیره تصاویر ✅") {
    try {
      await reply(ctx, next, redisClient, "⌛️");
      if (
        existingUser.profileImages.length &&
        existingUser.profileImagesEdit > 0
      ) {
        await Pictures.deleteMany({
          url: { $in: existingUser.profileImages },
        });
      }
      existingUser.profileImages = existingUser.profileImagesEdit;
      existingUser.profileImagesEdit = [];
      existingUser.currentStep.step = "isCorrectProfile";
      // await existingUser.save();
      usersMap.set(telegramId, {
        time: Date.now(),
        user: existingUser,
      });

      const photos = existingUser.profileImages || [];
      const fullName = existingUser.fullName;
      const age = existingUser.age;
      const state = existingUser.state;
      const bio = existingUser.bio ?? "";
      await replyWithPhoto(
        ctx,
        next,
        photos,
        `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `,
      );

      await reply(
        ctx,
        next,
        redisClient,
        "درسته ؟",
        process.env.PLATFORM == "bale"
          ? [[{ text: "بله" }, { text: "ویرایش پروفایلم" }]]
          : [[{ text: "ویرایش پروفایلم" }, { text: "بله" }]],
      );
    } catch (error) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو)",
        );
      } catch (error) {
        console.log(error);
      }
    }
    return;
  } else {
    existingUser.step = "photo";
    existingUser.currentStep.step = "";
    // await existingUser.save();
    usersMap.set(telegramId, {
      time: Date.now(),
      user: existingUser,
    });
    try {
      await reply(
        ctx,
        next,
        redisClient,
        "عکس خود را ارسال کنید 🖼️",
        process.env.PLATFORM == "bale"
          ? [[{ text: "بازگشت" }]]
          : [
              [{ text: "بازگشت" }],
              [{ text: "عکس پروفایل تلگرامم را قرار بده" }],
            ],
      );
    } catch (error) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو) jyuq2",
        );
      } catch (e) {}
    }
  }
};

module.exports = {
  changePhoto,
};
