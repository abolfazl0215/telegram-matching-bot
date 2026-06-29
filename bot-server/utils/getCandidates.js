const { pool } = require("../data/pool");
const { getMatchCandidates } = require("./getMatchCandidates");

function interleavePools(pool1, pool2, maxLength = 2000) {
  const len1 = pool1?.length ?? 0;
  const len2 = pool2?.length ?? 0;
  const total = Math.min(len1 + len2, maxLength);
  const result = new Array(total);

  let i = 0,
    a = 0,
    b = 0,
    turn = 0; // turn: 0 = از pool1, 1 = از pool2

  while (i < total) {
    if (turn === 0) {
      if (a < len1) result[i++] = pool1[a++];
      turn = 1;
    } else {
      if (b < len2) result[i++] = pool2[b++];
      turn = 0;
    }
  }

  return result;
}

const getCandidates = async (user) => {
  let pool_;
  if (user.lookingFor == "female") {
    pool_ = pool[`${user.state}Female`];
  } else if (user.lookingFor === "male") {
    pool_ = pool[`${user.state}Male`];
  } else {
    const pool1 = pool[`${user.state}Male`];
    const pool2 = pool[`${user.state}Female`];
    pool_ = interleavePools(pool1, pool2);
  }
  const candidates = await getMatchCandidates(user, pool_, 100);

  return candidates;
};

module.exports = { getCandidates };
