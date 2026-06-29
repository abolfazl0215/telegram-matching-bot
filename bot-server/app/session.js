const {
  redisClient,
  cleanupOldUsersQueue,
} = require("../config/redis");
const state = require("./state");

let cachedTime = Date.now();
setInterval(() => {
  cachedTime = Date.now();
}, 5000);

function getNowTime() {
  return cachedTime;
}

async function loadBlockedUsers() {
  const ids = await redisClient.smembers("blocked_users");
  state.blockedUsers.clear();
  for (const id of ids) {
    state.blockedUsers.add(String(id));
  }
}

async function cleanupOldUsersFromMapAndSaveToDB(time = 30) {
  const {
    usersMap,
    lastTimeAddProfileToList,
    forYouTime,
    forYouList,
  } = state;
  try {
    const now = Date.now();
    const thresholdMs = time * 60 * 1000;
    const entries = Array.from(usersMap.entries());

    await Promise.all(
      entries.map(async ([telegramId, userData]) => {
        if (now - userData.time < thresholdMs) return;
        try {
          cleanupOldUsersQueue.add({
            telegramId,
            currentUser: userData.user,
          });
          usersMap.delete(telegramId);
          lastTimeAddProfileToList.delete(telegramId);
          forYouTime.delete(telegramId);
          forYouList.delete(telegramId);
        } catch (error) {
          console.log(error);
        }
      }),
    );

    console.log(
      `🧹 پاک‌سازی انجام شد. تعداد کاربران باقیمانده: ${usersMap.size}`,
    );
  } catch (error) {
    console.error("❌ خطا در پاک‌سازی کاربران:", error);
  }
}

const CLEANUP_INTERVAL_MINUTES = 30;
// const CLEANUP_INTERVAL_MINUTES = 1;

async function startCleanupSchedule() {
  try {
    await cleanupOldUsersFromMapAndSaveToDB(CLEANUP_INTERVAL_MINUTES);
  } catch (error) {
    console.log(error);
  } finally {
    setTimeout(
      startCleanupSchedule,
      CLEANUP_INTERVAL_MINUTES * 60 * 1000,
    );
  }
}

function scheduleCleanupStart() {
  setTimeout(() => startCleanupSchedule(), 10000);
}

module.exports = {
  getNowTime,
  loadBlockedUsers,
  cleanupOldUsersFromMapAndSaveToDB,
  scheduleCleanupStart,
};
