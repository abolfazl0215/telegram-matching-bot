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

const sendMessageToAllQueue = createQueue("sendMessageToAllQueue");
const cleanupOldUsersQueue = createQueue("cleanupOldUsersQueue");
const goToNotificationMenu = createQueue("goToNotificationMenu");


module.exports = {
  redisClient,
  messageQueue,
  newLikeQueue,
  sendMessageToAllQueue,
  cleanupOldUsersQueue,
  goToNotificationMenu,
  logger,
};
