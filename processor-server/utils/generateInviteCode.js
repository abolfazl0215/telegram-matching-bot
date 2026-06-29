function generateInviteCode(userId) {
  return Buffer.from(userId.toString())
    .toString("base64")
    .slice(0, 8);
}

module.exports = { generateInviteCode };
