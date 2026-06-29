const mongoose = require("mongoose");
const now = () => Date.now();

const userSchema = new mongoose.Schema({
  telegramId: {
    type: Number,
    required: true,
    unique: true,
    index: true,
  },
  fullName: { type: String },
  userName: { type: String },
  inviteCode: { type: String },
  inviteBy: { type: String },

  rememberingMessage: { type: Number, default: 0 },

  age: { type: Number },
  gender: { type: String, enum: ["male", "female"] },
  lookingFor: { type: String, enum: ["male", "female", "noMatter"] },
  state: { type: String },
  bio: { type: String },

  lastActivity: { type: Number, default: now },
  createdAt: { type: Number, default: now },
  picScore: { type: Number, default: 50 },

  sleep: { type: Boolean, default: false },
  ban: { type: Boolean, default: false },

  likesLimit: {
    firstLikeTime: { type: Number, default: now },
    likesCount: { type: Number, default: 0 },
    giftLikeCount: { type: Number, default: 20 },
  },

  currentStep: {
    flow: { type: String, default: "register" }, // register / notification / bot
    step: { type: String, default: "welcomeMessage" },
  },

  forTutorial: {
    firstLike: { type: Number, default: 0 },
    firstNope: { type: Number, default: 0 },
  },

  usersGiftedByMissedMatch: [{ type: Number }],

  fcmToken: { type: String },
  platform: { type: String },
  appId: { type: String },
  isGuest: { type: Boolean },

  subscriptionExpireTime: { type: Number, default: 0 },

  lastViewedByInviteCode: Number,

  profileCompletedPercent: { type: Number, default: 70 },
  ageRange: {
    min: { type: Number, default: 18 },
    max: { type: Number, default: 30 },
  },

  profileImages: [{ type: String }],
  profileImagesEdit: [{ type: String }],

  // score: { type: Number, default: 0.5 },
  receivedLikes: [
    // maxLength = 100
    {
      fromTelegramId: Number,
      at: Number,
      likerScore: { type: Number, default: 0.5 },
    },
  ],

  likedByMe: [Number], // maxLength = 1500 وقتی هرکدام به سقف رسید به نسبت کم شوند
  nopedByMe: [Number], // maxLength = 1500
  blockedByMe: [Number],
  blockedMe: [Number],
  reportedByMe: [Number],
  matches: [Number],
  likedAges: [Number],

  lastGetCandidatesAt: { type: Number, default: 1 },
  getCandidatesCount: { type: Number, default: 0 },
});

const User = mongoose.model("User", userSchema);

module.exports = User;
