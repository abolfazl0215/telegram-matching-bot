// models/Payments.js
const mongoose = require("mongoose");
const now = () => Date.now();

const paymentsSchema = new mongoose.Schema({
  telegramId: { type: Number, index: true },
  time: { type: Number, default: now },
  fee: { type: Number, default: 0 },
});

const Payments = mongoose.model("Payments", paymentsSchema);

module.exports = Payments;
