// models/Report.js
const mongoose = require("mongoose");
const reportSchema = new mongoose.Schema({
  telegramId: { type: Number, index: true, unique: true },
  reports: [
    {
      type: { type: String },
      reportedTelegramId: Number,
      message: String,
    },
  ],
});

const Report = mongoose.model("Report", reportSchema);

module.exports = Report;
