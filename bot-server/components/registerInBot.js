const User = require("../models/User");
const { uploadImageFromUrl } = require("./uploadImageFromUrl");
const badWords = require("../data/words");
const protobuf = require("protobufjs");
const usersMap = require("../utils/usersMap");
const Pictures = require("../models/Pictures");
const { reply } = require("../telegram_methods/reply");
const { checkUrl } = require("../utils/checkUrl");
const { addToPool } = require("../utils/addToPool");
const { getCandidates } = require("../utils/getCandidates");
const { lastTimeAddProfileToList } = require("../app/state");

// ============================================================
// Constants & static data
// ============================================================

const ERROR_MESSAGE =
  "مشکلی پیش آمده است لطفا به پشتیبانی اطلاع دهید (آیدی پشتیبانی در بیو)";

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

const STATE_LOCAL_NAMES = states.map((s) => s.local);

const KEYBOARDS = {
  prevOnly: [[{ text: "مرحله قبلی" }]],
  genderSelect: [
    [{ text: "خانم 💁‍♀️" }, { text: "آقا 🙆‍♂️" }],
    [{ text: "مرحله قبلی" }],
  ],
  lookingForSelect: [
    [
      { text: "خانم 💁‍♀️" },
      { text: "آقا 🙆‍♂️" },
      { text: "فرقی ندارد ⚧️" },
    ],
    [{ text: "مرحله قبلی" }],
  ],
  bioStep: [[{ text: "رد شدن" }], [{ text: "مرحله قبلی" }]],
  confirmProfile: [[{ text: "بله" }, { text: "ویرایش پروفایلم" }]],
  searchBar: [
    [{ text: "☰" }, { text: "❤️" }, { text: "❌" }, { text: "💌" }],
  ],
  editProfileMenu: [[{ text: "1🚀" }, { text: "2" }, { text: "3" }]],
};

const stateKeyboard = (chunkArray) => [
  [{ text: "مرحله قبلی" }],
  ...chunkArray(STATE_LOCAL_NAMES, 3),
];

const ageKeyboard = (ages, chunkArray) => [...chunkArray(ages, 4)];

const containsBadWord = (text) =>
  badWords.some((word) =>
    text?.toLowerCase().includes(word.toLowerCase()),
  );

function containsLinkOrTelegramID(str) {
  // الگوی کلی برای تشخیص انواع لینک‌های URL
  const urlPattern =
    /(\b(https?|ftp|file):\/\/[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|]|\bwww\.[-A-Z0-9+&@#\/%?=~_|!:,.;]*[-A-Z0-9+&@#\/%=~_|])/gi;

  // الگوی تشخیص آیدی تلگرام (@username) - حداقل ۵ کاراکتر بعد از @
  const telegramUsernamePattern =
    /(^|[^a-zA-Z0-9_])@[A-Za-z0-9_]{5,}/;

  return urlPattern.test(str) || telegramUsernamePattern.test(str);
}

// ============================================================
// Main handler
// ============================================================

const registerInBot = async (
  ctx,
  next,
  ages,
  chunkArray,
  telegramId,
  telegramName,
  savedUser,
  redisClient,
  forYouList,
  forYouTime,
) => {
  if (!telegramId) {
    await reply(ctx, next, redisClient, "مشکلی پیش آمده است");
    return;
  }

  // ----------------------------------------------------------
  // Local helpers (closures over ctx/next/redisClient/savedUser)
  // ----------------------------------------------------------

  /** Reply, and on failure fall back to the generic error message. */
  async function replyOrFallback(text, keyboard) {
    try {
      await reply(ctx, next, redisClient, text, keyboard);
    } catch (error) {
      console.log(error);
      await reply(ctx, next, redisClient, ERROR_MESSAGE);
    }
  }

  /** Persist a single field + step (or just the step) to DB, memory cache, and savedUser. */
  async function changeRegisterStepAndSaveChanges(step, item, value) {
    savedUser.currentStep.step = step;

    const dbUpdate = item
      ? { [item]: value, "currentStep.step": step }
      : { "currentStep.flow": "register", "currentStep.step": step };

    if (item) savedUser[item] = value;

    await User.findOneAndUpdate({ telegramId }, dbUpdate);
    usersMap.set(telegramId, { time: Date.now(), user: savedUser });
  }

  /** Send a user's profile card (photo + caption), falling back to text-only on failure. */
  async function sendProfileCard(profile) {
    const { fullName, age, state, bio, profileImages } = profile;
    const caption = `${fullName}, ${age}, ${state} ${bio ? "\n" + bio : ""} `;

    try {
      await ctx.replyWithPhoto(checkUrl(profileImages?.[0]), {
        caption,
      });
    } catch (error) {
      console.log(error);
      await reply(ctx, next, redisClient, caption);
    }
  }

  // ----------------------------------------------------------
  // Step handlers
  // ----------------------------------------------------------

  const step = savedUser?.currentStep?.step;

  if (step === "welcomeMessage" || !step) {
    if (ctx?.message?.text !== "بزن بریم 🚀") {
      await changeRegisterStepAndSaveChanges("welcomeMessage");
      await replyOrFallback(
        `همین حالا هزاران نفر در پونس همدیگه رو پیدا می‌کنن 😉 \n\nمن بهت کمک می‌کنم که یه دوست پیدا کنی 👫`,
        [[{ text: "بزن بریم 🚀" }]],
      );
      return;
    }

    await changeRegisterStepAndSaveChanges("age");
    await replyOrFallback(
      "سن خود را انتخاب کنید\n\n⚪️⚪️⚪️⚪️⚪️⚪️⚪️🟢",
      ageKeyboard(ages, chunkArray),
    );
  }

  if (step === "age") {
    const ageValue = Number(ctx?.message?.text);
    const isValidAge =
      ctx?.message?.text && ageValue && ages.includes(ageValue);

    if (!isValidAge) {
      await changeRegisterStepAndSaveChanges("age");
      await reply(
        ctx,
        next,
        redisClient,
        "خطا در انتخاب سن",
        ageKeyboard(ages, chunkArray),
      );
    } else {
      await changeRegisterStepAndSaveChanges(
        "gender",
        "age",
        ageValue || 1,
      );
      await replyOrFallback(
        "جنسیت خود را انتخاب کنید\n\n⭕غیرقابل تغییر⭕\n⭕در انتخاب خود دقت کنید⭕\n\n⚪️⚪️⚪️⚪️⚪️⚪️🟢🟢",
        KEYBOARDS.genderSelect,
      );
    }
  }

  if (step === "gender") {
    const text = ctx?.message?.text;

    if (text === "خانم 💁‍♀️" || text === "آقا 🙆‍♂️") {
      await changeRegisterStepAndSaveChanges(
        "lookingFor",
        "gender",
        text === "خانم 💁‍♀️" ? "female" : "male",
      );
      await replyOrFallback(
        "دنبال چه کسی میگردید  ؟\n\n⚪️⚪️⚪️⚪️⚪️🟢🟢🟢",
        KEYBOARDS.lookingForSelect,
      );
    } else if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("age");
      await replyOrFallback(
        "سن خود را انتخاب کنید 👇🏻\n\n⚪️⚪️⚪️⚪️⚪️⚪️⚪️🟢",
        ageKeyboard(ages, chunkArray),
      );
    } else {
      await replyOrFallback(
        "خطا در انتخاب جنسیت ، لطفا یکی از گزینه های زیر را انتخاب کنید 👇🏻",
        KEYBOARDS.genderSelect,
      );
    }
  }

  if (step === "lookingFor") {
    const text = ctx?.message?.text;
    const lookingForMap = {
      "خانم 💁‍♀️": "female",
      "آقا 🙆‍♂️": "male",
      "فرقی ندارد ⚧️": "noMatter",
    };

    if (lookingForMap[text]) {
      await changeRegisterStepAndSaveChanges(
        "state",
        "lookingFor",
        lookingForMap[text],
      );
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "استان خود را انتخاب کنید 🏙️\n\n⚪️⚪️⚪️⚪️🟢🟢🟢🟢",
          stateKeyboard(chunkArray),
        );
      } catch (error) {
        await reply(ctx, next, redisClient, "مشکلی پیش آمده است");
      }
    } else if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("gender");
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "جنسیت خود را انتخاب کنید\n\n⭕غیرقابل تغییر⭕\n⭕در انتخاب خود دقت کنید⭕\n\n⚪️⚪️⚪️⚪️⚪️⚪️🟢🟢",
          KEYBOARDS.genderSelect,
        );
      } catch (error) {
        await reply(ctx, next, redisClient, "مشکلی پیش آمده است");
      }
    } else {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "دنبال چه کسی میگردید ؟ 🔎",
          KEYBOARDS.lookingForSelect,
        );
      } catch (error) {
        await reply(ctx, next, redisClient, "مشکلی پیش آمده است");
      }
    }
  }

  if (step === "state") {
    const text = ctx?.message?.text;
    const findState = states.find((s) => s.local === text);

    if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("lookingFor");
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "دنبال چه کسی میگردید ؟ 🔎",
          KEYBOARDS.lookingForSelect,
        );
      } catch (error) {
        await reply(ctx, next, redisClient, "مشکلی پیش آمده است");
      }
    } else if (findState) {
      await changeRegisterStepAndSaveChanges(
        "name",
        "state",
        findState.english || "",
      );
      await replyOrFallback(
        "نام خود را وارد کنید 👇🏻\n\n⚪️⚪️🟢🟢🟢🟢🟢🟢",
        [[{ text: telegramName }], [{ text: "مرحله قبلی" }]],
      );
    } else {
      await replyOrFallback(
        "استان خود را انتخاب کنید 🏙️\n\n⚪️⚪️⚪️🟢🟢🟢🟢🟢",
        stateKeyboard(chunkArray),
      );
    }
  }

  if (step === "name") {
    const text = ctx?.message?.text;

    if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("state");
      await replyOrFallback(
        "استان خود را انتخاب کنید 🏙️\n\n⚪️⚪️⚪️🟢🟢🟢🟢🟢",
        stateKeyboard(chunkArray),
      );
    } else if (!text) {
      await changeRegisterStepAndSaveChanges("name");
      await replyOrFallback(
        "نام خود را وارد کنید 👇🏻\n\n⚪️⚪️🟢🟢🟢🟢🟢🟢",
        [[{ text: telegramName }], [{ text: "مرحله قبلی" }]],
      );
    } else if (containsBadWord(text)) {
      await reply(ctx, next, redisClient, "حاوی کلمات نامناسب ⛔");
    } else if (containsLinkOrTelegramID(text)) {
      await reply(
        ctx,
        next,
        redisClient,
        "نام نمیتواند شامل لینک یا آیدی باشد ⭕",
      );
    } else if (text.length > 25) {
      await reply(
        ctx,
        next,
        redisClient,
        "تعداد کاراکتر بیش از حد مجاز است ⭕",
      );
    } else {
      await changeRegisterStepAndSaveChanges("bio", "fullName", text);
      await replyOrFallback(
        "درباره خودت بیشتر بگو. دنبال چه کسی می‌گردی؟ می‌خوای چیکار کنی؟ من بهترین مچ‌ها رو پیدا می‌کنم برات\n\n⚪️🟢🟢🟢🟢🟢🟢🟢",
        KEYBOARDS.bioStep,
      );
    }
  }

  if (step === "bio") {
    const text = ctx?.message?.text;

    if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("name");
      await replyOrFallback(
        "نام خود را وارد کنید 👇🏻\n\n⚪️⚪️🟢🟢🟢🟢🟢🟢",
        [[{ text: telegramName }], [{ text: "مرحله قبلی" }]],
      );
    } else if (!text || text.length < 5) {
      await replyOrFallback(
        "درباره خودت بیشتر بگو. دنبال چه کسی می‌گردی؟ می‌خوای چیکار کنی؟ من بهترین مچ‌ها رو پیدا می‌کنم برات\n\n⚪️🟢🟢🟢🟢🟢🟢🟢",
        KEYBOARDS.bioStep,
      );
    } else if (containsBadWord(text)) {
      await reply(ctx, next, redisClient, "شامل کلمات نامناسب");
    } else if (containsLinkOrTelegramID(text)) {
      await reply(
        ctx,
        next,
        redisClient,
        "بیوگرافی نمیتواند شامل لینک یا آیدی باشد ⭕",
      );
    } else if (text.length > 250) {
      await reply(
        ctx,
        next,
        redisClient,
        "تعداد کاراکتر بیش از حد مجاز است ⭕",
      );
    } else {
      // ثبت در کاربران جدید
      const getNewRegistered = await redisClient.get("newRegister");
      const newRegister = getNewRegistered
        ? JSON.parse(getNewRegistered)
        : [];
      if (!newRegister.includes(+telegramId)) {
        newRegister.push(+telegramId);
      }
      await redisClient.set(
        "newRegister",
        JSON.stringify(newRegister),
      );

      const bio_ = text !== "رد شدن" ? text : "";
      await changeRegisterStepAndSaveChanges("photo", "bio", bio_);
      await replyOrFallback(
        "یک تصویر برای پروفایل خود ارسال کنید 🖼️\n\n🟢🟢🟢🟢🟢🟢🟢🟢",
        KEYBOARDS.prevOnly,
      );
    }
  }

  if (step === "photo") {
    const text = ctx?.message?.text;

    if (text === "مرحله قبلی") {
      await changeRegisterStepAndSaveChanges("bio");
      await replyOrFallback(
        "درباره خودت بیشتر بگو. دنبال چه کسی می‌گردی؟ می‌خوای چیکار کنی؟ من بهترین مچ‌ها رو پیدا می‌کنم برات\n\n⚪️🟢🟢🟢🟢🟢🟢🟢",
        KEYBOARDS.bioStep,
      );
    } else if (ctx.message.photo) {
      const photos = savedUser.profileImages || [];
      if (photos.length === 3) return;

      try {
        await reply(ctx, next, redisClient, "⌛️");

        const fileId = ctx.message.photo.at(-1).file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const imageUrl = fileLink?.href || "";

        if (photos.length === 3) return;

        savedUser.profileImages = [imageUrl];

        await Promise.allSettled([
          Pictures.create({
            telegramId: +telegramId || savedUser.telegramId || 0,
            fullName: savedUser.fullName || "",
            bio: savedUser?.bio || "",
            state: savedUser?.state || "",
            url: imageUrl,
            createdAt: Date.now(),
          }),
          User.findOneAndUpdate(
            { telegramId },
            {
              registerStep: "photo",
              profileImages: savedUser.profileImages,
            },
          ),
        ]);

        usersMap.set(telegramId, {
          time: Date.now(),
          user: savedUser,
        });
        await changeRegisterStepAndSaveChanges("isCorrectProfile");

        await sendProfileCard(savedUser);
        await reply(
          ctx,
          next,
          redisClient,
          "درسته ؟",
          KEYBOARDS.confirmProfile,
        );
      } catch (error) {
        console.log(error);
        try {
          await reply(
            ctx,
            next,
            redisClient,
            "تصویر پروفایل شما ثبت نشد 🙁 . اینترنت ضعیف است لطفا بعدا یک تصویر برای پروفایل خود قرار دهید .",
          );
          await changeRegisterStepAndSaveChanges("isCorrectProfile");
          await sendProfileCard(savedUser);
          await reply(
            ctx,
            next,
            redisClient,
            "درسته ؟",
            KEYBOARDS.confirmProfile,
          );
        } catch (e) {}
      }
    } else {
      await User.findOneAndUpdate(
        { telegramId },
        { registerStep: "photo" },
      );
      usersMap.set(telegramId, { time: Date.now(), user: savedUser });
      await replyOrFallback(
        "یک تصویر برای پروفایل خود ارسال کنید 🖼️\n\n🟢🟢🟢🟢🟢🟢🟢🟢",
        KEYBOARDS.prevOnly,
      );
    }
  }

  if (step === "isCorrectProfile") {
    // add to pool ( active users )
    const lastTime = lastTimeAddProfileToList.get(telegramId) ?? 0;
    if (lastTime + 500000 < Date.now()) {
      lastTimeAddProfileToList.set(telegramId, Date.now());
      addToPool(savedUser);
    }

    // fill forYou list
    const currentList = forYouList.get(telegramId);
    if (
      !currentList ||
      (Array.isArray(currentList) && currentList.length < 5)
    ) {
      const candidates = await getCandidates(savedUser);
      forYouList.set(telegramId, [...candidates]);
      forYouTime.set(telegramId, Date.now());
    }

    const text = ctx?.message?.text;

    if (text === "بله") {
      const {
        age,
        gender,
        lookingFor,
        state,
        fullName: name,
      } = savedUser;

      if (!(age && gender && lookingFor && state && name)) {
        await reply(ctx, next, redisClient, ERROR_MESSAGE);
        return;
      }

      try {
        savedUser.currentStep.flow = "bot";
        savedUser.currentStep.step = "search";
        await User.findOneAndUpdate(
          { telegramId },
          { currentStep: { flow: "bot", step: "search" } },
        );
        usersMap.set(telegramId, {
          time: Date.now(),
          user: savedUser,
        });

        // پیام خوش‌آمدگویی ویژه برای خانم‌های تهران/البرز
        if (
          (savedUser.state === "Tehran" ||
            savedUser.state === "Alborz") &&
          savedUser.gender === "female"
        ) {
          await reply(
            ctx,
            next,
            redisClient,
            `درود ${savedUser.fullName} عزیز \n\n من ابولفضم سازنده ی ربات ، هر سوالی یا مشکلی داشتی میتونی ازم بپرسی 💕 \n\n@abolfazl021mokhtari \n@abolfazl021mokhtari \n@abolfazl021mokhtari`,
          );
        }

        await reply(
          ctx,
          next,
          redisClient,
          "در حال جستجوی افراد ...",
          KEYBOARDS.searchBar,
        );

        const nextCandidate = forYouList.get(telegramId)?.[0];
        if (nextCandidate) {
          await sendProfileCard(nextCandidate);
          forYouList.set(
            telegramId,
            forYouList.get(telegramId).slice(1),
          );
        }
      } catch (error) {
        console.log(error);
        await reply(ctx, next, redisClient, ERROR_MESSAGE);
      }
    } else if (text === "ویرایش پروفایلم") {
      await User.findOneAndUpdate(
        { telegramId },
        {
          currentStep: {
            flow: "editProfile",
            step: "editProfileMenu",
          },
        },
      );
      savedUser.currentStep.flow = "editProfile";
      savedUser.currentStep.step = "editProfileMenu";
      usersMap.set(telegramId, { time: Date.now(), user: savedUser });

      await reply(
        ctx,
        next,
        redisClient,
        `1. ${"مشاهده پروفایل ها"} \n2. ${"ویرایش پروفایلم"} \n3. ${"تغییر عکس من"}`,
        KEYBOARDS.editProfileMenu,
      );
    } else {
      await sendProfileCard(savedUser);
      await replyOrFallback("درسته ؟", KEYBOARDS.confirmProfile);
    }
  }
};

module.exports = {
  registerInBot,
};
