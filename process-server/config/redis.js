const Redis = require("ioredis");
const Bull = require("bull");
const winston = require("winston");

// Logger configuration
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json(),
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "queue-errors.log" }),
  ],
});

const REDIS_URL = "redis://127.0.0.1:6379";

const redisClient = new Redis(REDIS_URL, {
  reconnectOnError: (err) => {
    logger.error("Redis reconnection error", err);
    return true;
  },
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const defaultQueueOptions = {
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: {
      count: 50,
    },
    removeOnFail: {
      count: 200,
    },
  },
  limiter: {
    max: 100, // Max jobs per duration
    duration: 1000, // Duration in milliseconds
  },
};
const defaultQueueOptionsForSendMessageToAll = {
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 1000,
    },
    removeOnComplete: {
      count: 50,
    },
    removeOnFail: {
      count: 200,
    },
  },
  limiter: {
    max: 20, // Max jobs per duration
    duration: 1000, // Duration in milliseconds
  },
};

const createQueue = (name) => {
  const defOptions =
    name == "sendMessageToAllQueue"
      ? defaultQueueOptionsForSendMessageToAll
      : defaultQueueOptions;

  const queue = new Bull(name, REDIS_URL, defOptions);

  queue.on("error", (error) => {
    logger.error(`Queue ${name} error:`, error);
  });

  queue.on("failed", (job, err) => {
    logger.warn(`Job in queue ${name} failed:`, {
      jobId: job.id,
      error: err,
    });
  });

  return queue;
};

const messageQueue = createQueue("messageQueue");
const newLikeQueue = createQueue("newLikeQueue");
// صف جدید: دریافت اعلام حذف یک لایک از سرور ربات (وقتی کاربر با 💚 یا ❌
// روی یک لایک تصمیم می‌گیرد). این صف با همان نام در bot/config/redis.js
// هم ساخته شده (هر دو سرور به یک Redis مشترک وصل‌اند)؛ ربات .add می‌کند
// و همین‌جا (processor/index.js) .process می‌شود.
const removeFromNewLikesQueue = createQueue(
  "removeFromNewLikesQueue",
);

const sendMessageToAllQueue = createQueue("sendMessageToAllQueue");
const cleanupOldUsersQueue = createQueue("cleanupOldUsersQueue");
const goToNotificationMenu = createQueue("goToNotificationMenu");

const addToPoolQueue = createQueue("addToPoolQueue");
const removeFromExploreQueue = createQueue("removeFromExploreQueue");

// FIX #4 (invalidation): صف عمومی برای رویدادهایی که خارج از این سرور
// (مثلاً در بات‌سرور) رخ می‌دن ولی روی computeScore این کاربر در پردازشگر
// اثر می‌ذارن — مثل خرید اشتراک، تکمیل پروفایل، یا ساخته‌شدن match جدید.
// بات‌سرور فقط باید یه job با شکل زیر به این صف اضافه کنه:
//   { telegramId: number, patch?: Partial<UserFields> }
// و این پردازشگر (index.js) با گرفتن این job، baseScore همون کاربر رو
// در pool به‌روزرسانی می‌کنه، بدون این‌که منتظر چرخه‌ی بعدی fillPool بمونه.
const invalidateScoreQueue = createQueue("invalidateScoreQueue");

const requestToFillForYouList = createQueue(
  "requestToFillForYouList",
);
const fillForYouList = createQueue("fillForYouList");

module.exports = {
  redisClient,
  messageQueue,
  newLikeQueue,
  removeFromNewLikesQueue,
  sendMessageToAllQueue,
  cleanupOldUsersQueue,
  goToNotificationMenu,
  addToPoolQueue,
  requestToFillForYouList,
  fillForYouList,
  removeFromExploreQueue,
  invalidateScoreQueue,
  logger,
};
