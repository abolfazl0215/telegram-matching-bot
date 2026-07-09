const User = require("../models/User");
const Report = require("../models/Report");
const { reply } = require("../telegram_methods/reply");
const { redisClient } = require("../config/redis");
const { MENU_TEXT, MENU_KEYBOARD } = require("./constants");

async function reportAction(reportType, telegramId, ctx, next, usersMap) {
  try {
    let existingUser =
      usersMap.get(telegramId)?.user ??
      (await User.findOne({ telegramId }));

    if (!existingUser?.telegramId) {
      try {
        await reply(ctx, next, redisClient, "کاربر یافت نشد.");
      } catch (error) {
        console.log(error);
      }
      return;
    }

    if (
      !existingUser.lastViewedByInviteCode &&
      !Number(existingUser.lastViewedByInviteCode)
    ) {
      return;
    }

    const reportedId = +existingUser.lastViewedByInviteCode;

    let report = await Report.findOne({ telegramId: reportedId });
    if (!report) {
      report = await Report.create({ telegramId: reportedId });
    }

    if (
      report.reports.find((r) => r.reportedTelegramId === telegramId)
    ) {
      try {
        await reply(
          ctx,
          next,
          redisClient,
          "شما قبلا برای این کاربر گزارش داده اید.",
        );
      } catch (error) {}
      return;
    }

    report.reports.push({
      type: reportType,
      reportedTelegramId: telegramId,
    });

    try {
      await report.save();
      await reply(ctx, next, redisClient, "گزارش شما ثبت شد ✅");
    } catch (error) {}

    existingUser.currentStep.step = "menu";
    usersMap.set(telegramId, {
      user: existingUser,
      time: Date.now(),
    });

    try {
      await reply(ctx, next, redisClient, MENU_TEXT, MENU_KEYBOARD);
    } catch (error) {
      console.log(error);
    }
  } catch (error) {
    console.log(error);
  }
}

const REPORT_ACTIONS = [
  "report_advertisement",
  "report_inappropriate_content",
  "report_harassment",
  "report_phone_number",
  "report_inappropriate_profile",
  "report_incorrect_gender",
  "report_other",
];

function registerReportHandlers(bot, usersMap) {
  for (const action of REPORT_ACTIONS) {
    bot.action(action, async (ctx, next) => {
      await reportAction(action, ctx.from.id, ctx, next, usersMap);
    });
  }
}

module.exports = { registerReportHandlers };
