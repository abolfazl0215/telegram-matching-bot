const axios = require("axios");
const fs = require("fs");
const User = require("../models/User");
const { uploadImageFromUrl } = require("./uploadImageFromUrl");
const badWords = require("../data/words");
const protobuf = require("protobufjs");
const usersMap = require("../utils/usersMap");
const { reply } = require("../telegram_methods/reply");
const Pictures = require("../models/Pictures");
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
const { replyWithPhoto } = require("../telegram_methods/replyWithPhoto");

const SUPPORT_ERROR_MSG =
  "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو)";

function containsLinkOrTelegramID(str) {
  // الگوی کلی برای تشخیص انواع لینک‌های URL
  // این الگو شامل http, https, ftp, www. و دامنه‌های معمولی هست
  const urlPattern =
    /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|]|\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi;

  // الگوی تشخیص آیدی تلگرام (@username)
  // حداقل ۵ کاراکتر بعد از @ و فقط حروف، اعداد و خط زیر مجاز هستند
  const telegramUsernamePattern =
    /(^|[^a-zA-Z0-9_])@[A-Za-z0-9_]{5,}/;

  const hasLink = urlPattern.test(str);
  const hasTelegramID = telegramUsernamePattern.test(str);

  return hasLink || hasTelegramID;
}

function hasBadWord(text) {
  return badWords.some((word) =>
    text?.toLowerCase().includes(word.toLowerCase()),
  );
}

const states = [
  { local: "آذربایجان شرقی", english: "eastazerbaijan" },
  { local: "تهران", english: "tehran" },
  { local: "آذربایجان غربی", english: "westazerbaijan" },
  { local: "اردبیل", english: "ardabil" },
  { local: "اصفهان", english: "isfahan" },
  { local: "البرز", english: "alborz" },
  { local: "ایلام", english: "ilam" },
  { local: "بوشهر", english: "bushehr" },
  { local: "چهارمحال و بختیاری", english: "chaharmahalandbakhtiari" },
  { local: "خراسان جنوبی", english: "southkhorasan" },
  { local: "خراسان رضوی", english: "razavikhorasan" },
  { local: "خراسان شمالی", english: "northkhorasan" },
  { local: "خوزستان", english: "khuzestan" },
  { local: "زنجان", english: "zanjan" },
  { local: "سمنان", english: "semnan" },
  { local: "سیستان و بلوچستان", english: "sistanandbaluchestan" },
  { local: "فارس", english: "fars" },
  { local: "قزوین", english: "qazvin" },
  { local: "قم", english: "qom" },
  { local: "کردستان", english: "kurdistan" },
  { local: "کرمان", english: "kerman" },
  { local: "کرمانشاه", english: "kermanshah" },
  {
    local: "کهگیلویه و بویراحمد",
    english: "kohgiluyehandboyerahmad",
  },
  { local: "گلستان", english: "golestan" },
  { local: "گیلان", english: "gilan" },
  { local: "لرستان", english: "lorestan" },
  { local: "مازندران", english: "mazandaran" },
  { local: "مرکزی", english: "markazi" },
  { local: "هرمزگان", english: "hormozgan" },
  { local: "همدان", english: "hamadan" },
  { local: "یزد", english: "yazd" },
];

const PREV_STEP_BTN = { text: "مرحله قبلی" };
const kbAges = (chunkArray, ages) => [...chunkArray(ages, 4)];
const kbGenderFilter =
  process.env.PLATFORM == "bale"
    ? [
        [
          { text: "خانم 💁‍♀️" },
          { text: "آقا 🙆‍♂️" },
          { text: "فرقی ندارد ⚧️" },
        ],
        [PREV_STEP_BTN],
      ]
    : [
        [
          { text: "فرقی ندارد ⚧️" },
          { text: "آقا 🙆‍♂️" },
          { text: "خانم 💁‍♀️" },
        ],
        [PREV_STEP_BTN],
      ];
const kbGender = [
  [{ text: "خانم 💁‍♀️" }, { text: "آقا 🙆‍♂️" }],
  [PREV_STEP_BTN],
];
const kbStates = (chunkArray) => [
  [PREV_STEP_BTN],
  ...chunkArray(
    states.map((s) => s.local),
    3,
  ),
];
const kbName = (label) => [[{ text: label }], [PREV_STEP_BTN]];
const kbConfirmProfile =
  process.env.PLATFORM == "bale"
    ? [[{ text: "بله" }, { text: "ویرایش پروفایلم" }]]
    : [[{ text: "ویرایش پروفایلم" }, { text: "بله" }]];

const kbEditMenu = MY_PROFILE_MENU_KEYBOARD;
const EDIT_MENU_TEXT = `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`;
const BIO_PROMPT_TEXT = `درباره خودت بیشتر بگو. دنبال چه کسی می‌گردی؟ می‌خوای چیکار کنی؟ من بهترین مچ‌ها رو پیدا می‌کنم برات.`;

const editProfileInBot = async (
  ctx,
  next,
  chunkArray,
  ages,
  telegramId,
  savedUser,
  redisClient,
  forYouList,
  forYouTime,
  telegramName,
) => {
  async function changeEditProfileStepAndSaveChanges(
    step,
    item,
    value,
  ) {
    savedUser.currentStep.flow =
      step == "search" ? "bot" : "editProfile";
    savedUser.currentStep.step = step;

    const dbUpdate = item
      ? { [item]: value, "currentStep.step": step }
      : {
          "currentStep.flow":
            step == "search" ? "bot" : "editProfile",
          "currentStep.step": step,
        };

    if (item) savedUser[item] = value;

    await User.findOneAndUpdate({ telegramId }, dbUpdate);
    usersMap.set(telegramId, { time: Date.now(), user: savedUser });
  }

  // جایگزین تکرار try/catch با پیام پشتیبانی (با حفظ کد ردیابی اختیاری)
  const safeReply = async (text, keyboard, errorTag) => {
    try {
      await reply(ctx, next, redisClient, text, keyboard);
    } catch (error) {
      console.log(error);
      try {
        await reply(
          ctx,
          next,
          redisClient,
          errorTag
            ? `${SUPPORT_ERROR_MSG} ${errorTag}`
            : SUPPORT_ERROR_MSG,
        );
      } catch (_) {}
    }
  };

  // جایگزین تکرار نمایش عکس+کپشن پروفایل (۴ بار در فایل اصلی)
  const sendProfileCard = async (user, { photoUrl } = {}) => {
    const { fullName, age, state, bio = "" } = user;
    const caption = `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `;
    const url = photoUrl ?? user.profileImages?.[0];

    await replyWithPhoto(ctx, next, user.profileImages,caption )


  };

  const step = savedUser.currentStep?.step;
  const text = ctx?.message?.text;

  // ----- age -----
  if (step === "age") {
    const validAge =
      text && Number(text) && ages.includes(Number(text));

    if (!validAge) {
      await changeEditProfileStepAndSaveChanges("age");
      await safeReply(
        "خطا ، لطفا یکی از اعداد زیر را انتخاب کنید",
        kbAges(chunkArray, ages),
        "jhw22",
      );
    } else {
      await changeEditProfileStepAndSaveChanges(
        "lookingFor",
        "age",
        Number(text) || 1,
      );
      await safeReply(
        "به دنبال چه کسی می گردید ؟",
        kbGenderFilter,
        "qjd7",
      );
    }
  }

  // ----- gender (مسیر میراثی؛ ظاهراً هیچ stepی به اینجا هدایت نمی‌کنه) -----
  if (step === "gender") {
    if (text === "خانم 💁‍♀️" || text === "آقا 🙆‍♂️") {
      await changeEditProfileStepAndSaveChanges(
        "lookingFor",
        "gender",
        text === "خانم 💁‍♀️" ? "female" : "male",
      );
      await safeReply(
        "به دنبال چه کسی می گردید ؟",
        kbGenderFilter,
        "qjd7",
      );
    } else if (text === "مرحله قبلی") {
      await changeEditProfileStepAndSaveChanges("age");
      await safeReply(
        "سن خود را انتخاب کنید",
        kbAges(chunkArray, ages),
        "fghv87",
      );
    } else {
      await safeReply(
        "خطا ، لطفا یکی از گزینه های زیر را انتخاب کنید",
        kbGender,
        "wjl456",
      );
    }
  }

  // ----- lookingFor -----
  if (step === "lookingFor") {
    if (
      text === "خانم 💁‍♀️" ||
      text === "آقا 🙆‍♂️" ||
      text === "فرقی ندارد ⚧️"
    ) {
      const lookingFor_ =
        text === "خانم 💁‍♀️"
          ? "female"
          : text === "آقا 🙆‍♂️"
            ? "male"
            : "noMatter";

      await changeEditProfileStepAndSaveChanges(
        "state",
        "lookingFor",
        lookingFor_,
      );
      await safeReply(
        "استان خود را انتخاب کنید 🏙️",
        kbStates(chunkArray),
      );
    } else if (text === "مرحله قبلی") {
      await changeEditProfileStepAndSaveChanges("age");
      await safeReply(
        "سن خود را انتخاب کنید",
        kbAges(chunkArray, ages),
      );
    } else {
      await safeReply("به دنبال چه کسی می گردید ؟", kbGenderFilter);
    }
  }

  // ----- state -----
  if (step === "state") {
    const findState = states.find((s) => s.local === text);

    if (text === "مرحله قبلی") {
      // قبلاً به genderFilter برمیگشت، حالا به lookingFor
      await changeEditProfileStepAndSaveChanges("lookingFor");
      await safeReply("به دنبال چه کسی می گردید ؟", kbGenderFilter);
    } else if (findState) {
      await changeEditProfileStepAndSaveChanges(
        "name",
        "state",
        findState?.english || "",
      );
      await safeReply(
        "نام خود را وارد کنید 👇🏻",
        kbName(telegramName),
      );
    } else {
      await safeReply("شهر خود را انتخاب کنید", kbStates(chunkArray));
    }
  }

  // ----- name -----
  if (step === "name") {
    if (text === "مرحله قبلی") {
      await changeEditProfileStepAndSaveChanges("state");
      await safeReply(
        "یکی از استان های زیر را انتخاب کنید",
        kbStates(chunkArray),
      );
    } else if (!text) {
      await changeEditProfileStepAndSaveChanges("name");
      await safeReply(
        "نام خود را وارد کنید 👇🏻",
        kbName(telegramName),
      );
    } else if (hasBadWord(text)) {
      try {
        await reply(ctx, next, redisClient, "حاوی کلمات نامناسب ⛔");
      } catch (_) {}
      return;
    } else if (containsLinkOrTelegramID(text)) {
      await reply(
        ctx,
        next,
        redisClient,
        "نام نمیتواند شامل لینک یا آیدی باشد ⭕",
      );
      return;
    } else if (text.length > 25) {
      await reply(
        ctx,
        next,
        redisClient,
        "تعداد کاراکتر بیش از حد مجاز است ⭕",
      );
      return;
    } else {
      await changeEditProfileStepAndSaveChanges(
        "bio",
        "fullName",
        text,
      );
      await safeReply(
        BIO_PROMPT_TEXT,
        kbName(savedUser?.bio ? savedUser.bio : "رد شدن"),
      );
    }
  }

  // ----- bio -----
  if (step === "bio") {
    if (text === "مرحله قبلی") {
      await changeEditProfileStepAndSaveChanges("name");
      await safeReply(
        "نام خود را وارد کنید 👇🏻",
        kbName(savedUser.fullName || "-"),
      );
    } else if (!text || text.length < 5) {
      await safeReply(BIO_PROMPT_TEXT, kbName("رد شدن"));
    } else if (hasBadWord(text)) {
      try {
        await reply(ctx, next, redisClient, "حاوی کلمات نامناسب ⛔");
      } catch (_) {}
      return;
    } else if (containsLinkOrTelegramID(text)) {
      await reply(
        ctx,
        next,
        redisClient,
        "بیوگرافی نمیتواند شامل لینک یا آیدی باشد ⭕",
      );
      return;
    } else if (text.length > 250) {
      await reply(
        ctx,
        next,
        redisClient,
        "تعداد کاراکتر بیش از حد مجاز است ⭕",
      );
      return;
    } else {
      try {
        await reply(ctx, next, redisClient, "⌛️");
      } catch (_) {}

      await changeEditProfileStepAndSaveChanges(
        "isCorrectProfile",
        "bio",
        text !== "رد شدن" ? text : "",
      );

      try {
        await sendProfileCard(savedUser);
        await reply(
          ctx,
          next,
          redisClient,
          "درسته ؟",
          kbConfirmProfile,
        );
      } catch (error) {
        console.error(error);
        try {
          await reply(ctx, next, redisClient, SUPPORT_ERROR_MSG);
        } catch (_) {}
      }
    }
  }

  // ----- isCorrectProfile -----
  if (step === "isCorrectProfile") {
    // add to pool (active users)
    const lastTime = lastTimeAddProfileToList.get(telegramId) ?? 0;
    if (lastTime + 500000 < Date.now()) {
      lastTimeAddProfileToList.set(telegramId, Date.now());
      addToPoolQueue.add({ user: savedUser });
    }

    // fill forYou list
    const currentList = forYouList.get(telegramId);
    if (
      !currentList ||
      (Array.isArray(currentList) && currentList.length < 5)
    ) {
      requestToFillForYouList.add({ user: savedUser });
    }

    if (text === "بله") {
      const {
        age,
        gender,
        lookingFor,
        state,
        fullName: name,
        profileImages,
      } = savedUser;
      const bio = savedUser?.bio ?? "";

      try {
        await Pictures.create({
          telegramId: +telegramId || savedUser.telegramId || 0,
          fullName: savedUser.fullName || "",
          bio: savedUser?.bio || "",
          state: savedUser?.state || "",
          url: profileImages[0],
          createdAt: Date.now(),
        });
      } catch (error) {
        console.log(error);
      }

      if (age && gender && lookingFor && state && name) {
        try {
          // save in redis
          await redisClient.hmset(`user:${savedUser.telegramId}`, {
            lastUpdate: Date.now(),
            lastSeen: Date.now(),
            age: age.toString(),
            gender,
            lookingFor,
            state,
            fullName: name,
            bio,
          });

          try {
            await changeEditProfileStepAndSaveChanges("search");
            await reply(
              ctx,
              next,
              redisClient,
              "در حال حستجوی افراد ...",
              SEARCH_KEYBOARD,
            );

            const nextCandidate = forYouList.get(telegramId)[0];
            await sendProfileCard(nextCandidate, {
              photoUrl: nextCandidate.profileImages?.[0],
            });
          } catch (error) {
            console.log({ error });
          }
        } catch (error) {
          try {
            await reply(ctx, next, redisClient, SUPPORT_ERROR_MSG);
          } catch (_) {}
        }
      } else {
        try {
          await reply(ctx, next, redisClient, SUPPORT_ERROR_MSG);
        } catch (_) {}
      }
    } else if (text === "ویرایش پروفایلم") {
      await changeEditProfileStepAndSaveChanges("editProfileMenu");
      try {
        await reply(
          ctx,
          next,
          redisClient,
          EDIT_MENU_TEXT,
          kbEditMenu,
        );
      } catch (error) {
        console.log(error);
      }
    } else {
      try {
        await sendProfileCard(savedUser);
        forYouList.set(
          telegramId,
          forYouList.get(telegramId).slice(1),
        );
        await reply(
          ctx,
          next,
          redisClient,
          "درسته ؟",
          kbConfirmProfile,
        );
      } catch (error) {
        console.log({ error });
        try {
          await reply(ctx, next, redisClient, SUPPORT_ERROR_MSG);
        } catch (_) {}
      }
      return;
    }
  }
};

module.exports = editProfileInBot;
