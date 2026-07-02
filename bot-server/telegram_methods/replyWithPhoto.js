const { redisClient } = require("../config/redis");
const blockedUsers = require("../utils/blockedUsers");
const { checkUrl } = require("../utils/checkUrl");
const { reply } = require("./reply");

const replyWithPhoto = async (ctx, next, photos, caption) => {
  const telegramId = ctx?.from?.id;
  try {
    if (
      Array.isArray(photos) &&
      photos.length <= 1 &&
      process.env.PLATFORM == "bale"
    ) {
      await ctx.replyWithPhoto(photos[0], {
        caption,
      });
    } else {
      await ctx.replyWithMediaGroup(
        photos.map((photo, index) => ({
          type: "photo",
          media: photo,
          caption: index === 0 ? caption : undefined,
        })),
      );
    }
  } catch (error) {
    try {
      await reply(ctx, next, redisClient, caption);
    } catch (error) {
      console.log(error);
    }
  }
};

module.exports = { replyWithPhoto };
