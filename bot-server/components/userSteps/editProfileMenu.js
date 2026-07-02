const chunkArray = require("../../utils/chunkArray.js");
const fs = require("fs");
const { reply } = require("../../telegram_methods/reply.js");

const { checkUrl } = require("../../utils/checkUrl.js");
const {
  SEARCH_KEYBOARD,
  MENU_KEYBOARD,
  MY_PROFILE_MENU_KEYBOARD,
} = require("../../bot/constants.js");
const {
  replyWithPhoto,
} = require("../../telegram_methods/replyWithPhoto.js");

const SUPPORT_ERROR_MSG =
  "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو)";

const DAY_MS = 86400000; // 24 ساعت
const DAILY_PHOTO_CHANGE_LIMIT = 3;
const FOR_YOU_LIST_MIN_LENGTH = 10;
const FOR_YOU_LIST_TTL_MS = 600000; // 10 دقیقه

const kbSearchMenu = SEARCH_KEYBOARD;
const kbEditMenu = MY_PROFILE_MENU_KEYBOARD;
const kbEditMenuWithExtra = MENU_KEYBOARD;

const EDIT_MENU_TEXT = `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`;

const editProfileMenu = async (
  ctx,
  next,
  redisClient,
  telegramId,
  existingUser,
  usersMap,
  forYouList,
  forYouTime,
  ages,
) => {
  const text = ctx?.message?.text;

  const saveUser = () => {
    usersMap.set(telegramId, {
      time: Date.now(),
      user: existingUser,
    });
  };

  const safeReply = async (msg, keyboard) => {
    try {
      await reply(ctx, next, redisClient, msg, keyboard);
    } catch (error) {
      console.log({ error });
    }
  };

  // جایگزین تکرار دوباره‌ی نمایش عکس+کپشن کاندید فعلی forYouList
  const sendCurrentCandidateCard = async () => {
    const {
      fullName,
      age,
      state,
      bio,
      profileImages,
      inviteCode: inviteCode_from_forYouList,
    } = forYouList.get(telegramId)[0];

    const caption = `${fullName}, ${age}, ${state} ${
      bio ? "\n" + bio : ""
    } \n/user_${inviteCode_from_forYouList || "not_found"}`;

    await replyWithPhoto(ctx, next, profileImages, caption);

    // existingUser.lastViewed =
    //   +forYouList.get(telegramId)[0].telegramId;
    forYouList.set(telegramId, forYouList.get(telegramId).slice(1));
    saveUser();
  };

  if (text === "1 🚀") {
    try {
      existingUser.currentStep.flow = "bot";
      existingUser.currentStep.step = "search";
      saveUser();

      const list = forYouList.get(telegramId);
      const cacheIsFresh =
        list &&
        Array.isArray(list) &&
        list.length > FOR_YOU_LIST_MIN_LENGTH &&
        forYouTime.get(telegramId) &&
        forYouTime.get(telegramId) + FOR_YOU_LIST_TTL_MS > Date.now();

      if (cacheIsFresh) {
        await safeReply("🔎", kbSearchMenu);
        await sendCurrentCandidateCard();
      } else {
        await safeReply("🔎", kbSearchMenu);

        try {
          await sendCurrentCandidateCard();
        } catch (error) {
          console.log({ error });
        }
      }
    } catch (error) {
      console.log({ error });
    }
  } else if (text === "2") {
    existingUser.currentStep.flow = "editProfile";
    existingUser.currentStep.step = "age";
    saveUser();

    try {
      await reply(ctx, next, redisClient, "سن خود را انتخاب کنید", [
        ...chunkArray(ages, 4),
      ]);
    } catch (error) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          SUPPORT_ERROR_MSG + " r878",
        );
      } catch (error) {
        console.log({ error });
      }
    }
  } else if (text === "3") {
    if (
      !existingUser?.limitGetPicture ||
      !existingUser?.limitGetPicture?.time
    ) {
      existingUser.limitGetPicture = { time: Date.now(), count: 0 };
    }

    const lastTimeSetPic = existingUser?.limitGetPicture?.time;

    if (lastTimeSetPic + DAY_MS < Date.now()) {
      existingUser.limitGetPicture = { time: Date.now(), count: 0 };
    }

    const limitWindowActive = lastTimeSetPic + DAY_MS > Date.now();
    const limitReached =
      existingUser?.limitGetPicture?.count >=
      DAILY_PHOTO_CHANGE_LIMIT;

    if (limitWindowActive && limitReached) {
      existingUser.currentStep.flow = "editProfile";
      existingUser.currentStep.step = "editProfileMenu";
      saveUser();

      await reply(
        ctx,
        next,
        redisClient,
        `⭕ در هر روز فقط ${DAILY_PHOTO_CHANGE_LIMIT} بار میتوانید تصویر پروفایل را تغییر دهید`,
        kbEditMenu,
      );
      return;
    }

    existingUser.currentStep.flow = "changePhoto";
    existingUser.currentStep.step = "";
    saveUser();

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
          SUPPORT_ERROR_MSG + " r5821",
        );
      } catch (error) {
        console.log({ error });
      }
    }
  } else {
    await safeReply(EDIT_MENU_TEXT, kbEditMenuWithExtra);
  }
};

module.exports = editProfileMenu;
