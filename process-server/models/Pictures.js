// models/Report.js
const mongoose = require("mongoose");
const now = () => Date.now();

const picturesSchema = new mongoose.Schema({
  telegramId: { type: Number },
  url: { type: String },
  fullName: String,
  bio: String,
  state: String,
  score: Number,
  confirm: { type: Boolean, default: false },
  createdAt: { type: Number, default: now },
});

const Pictures = mongoose.model("Pictures", picturesSchema);

module.exports = Pictures;
