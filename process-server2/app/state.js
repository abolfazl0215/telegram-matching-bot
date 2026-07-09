const usersMap = require("../utils/usersMap");
const blockedUsers = require("../utils/blockedUsers");

const lastTimeAddProfileToList = new Map();
const forYouTime = new Map();
let globalUsers = [];

module.exports = {
  usersMap,
  blockedUsers,
  lastTimeAddProfileToList,
  forYouTime,
  get globalUsers() {
    return globalUsers;
  },
  setGlobalUsers(users) {
    globalUsers = users;
  },
};
