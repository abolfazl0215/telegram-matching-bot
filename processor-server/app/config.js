module.exports = {
  PORT: 6338,
  MONGODB_URI:
    process.env.PLATFORM == "bale"
      ? "mongodb://root:iufWbfg4Or7YpwwI@services.irn9.chabokan.net:10949"
      : "mongodb+srv://xchat:Abolfazl021_@botdb.omatymd.mongodb.net/?appName=botdb",
  // ,
  AGES: Array.from({ length: 63 }, (_, i) => 18 + i),
  PROVIDER_TOKEN: "WALLET-l5dCPuAvjRjSLcEk",
  BOT_INVITE_BASE:
    process.env.PLATFORM == "bale"
      ? "https://ble.ir/pounesbot?start="
      : "https://t.me/pounesbot?start=",
};
