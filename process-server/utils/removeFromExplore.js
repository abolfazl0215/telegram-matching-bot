const { redisClient } = require("../config/redis");
const { pool } = require("../data/pool");

const removeFromExplore = async (user) => {
  try {
    const poolKey =
      user.state + (user.gender === "male" ? "Male" : "Female");

    // حذف از in-memory pool
    const targetPool = pool[poolKey];
    if (targetPool) {
      pool[poolKey] = targetPool.filter(
        (u) => String(u.telegramId) !== String(user.telegramId),
      );
    }

    // حذف از Redis
    const cachedTelegramIds = await redisClient.get(poolKey);
    if (!cachedTelegramIds) return;

    const telegramIds = JSON.parse(cachedTelegramIds);
    const filteredTelegramIds = telegramIds.filter(
      (t) => String(t) !== String(user.telegramId),
    );
    await redisClient.set(
      poolKey,
      JSON.stringify(filteredTelegramIds),
    );
  } catch (error) {
    console.error("removeFromExplore error:", error);
  }
};

module.exports = { removeFromExplore };
