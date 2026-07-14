function generateInviteCode(userId) {
  return BigInt(userId).toString(36);
}
module.exports = { generateInviteCode };
