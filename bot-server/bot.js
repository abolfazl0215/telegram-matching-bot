const { Telegraf } = require("telegraf");
let bot;
// if (global.currentPlatform == "bale") {
bot = new Telegraf(
  "464655215:70b-Xr7K_6BvjHKHklKe_q2qNSZ3ncI1-rU",
  // "53189952:WhZI2fkLl9D6nyu3jguJ01xCme-jqyAD6ZQ", // تست
  {
    telegram: { apiRoot: "https://tapi.bale.ai/bot" },
  },
);
// } else {
//   bot = new Telegraf(
//     "8853616218:AAFKyHNYv2g4dSfiBqgNJJD7vY8lgjY2oLk",
//   );
// }
module.exports = bot;
