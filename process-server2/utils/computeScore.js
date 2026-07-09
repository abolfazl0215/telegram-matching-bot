// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const COLD_START_PEAK_BOOST = 0.3;
const COLD_START_FLAT_HOURS = 24;
const COLD_START_DECAY_DAYS = 7;

const LIKE_WINDOW_DAYS = 3;
const LIKE_WINDOW_MS = LIKE_WINDOW_DAYS * 86400000;
const LIKE_SOFT_CAP = 18;

const ACTIVITY_DECAY_DAYS = 14;
const NEUTRAL_PIC_SCORE = 50;

// ── BASE SCORE WEIGHTS (must sum to 1.0) ──────────────────────────────────────
const W_PIC = 0.18;
const W_LIKE = 0.28;
const W_ACTIVITY = 0.2;
const W_MATCHRATE = 0.22;
const W_PROFILE = 0.12;
// sum = 1.00 ✓

// ── BOOST CONSTANTS ───────────────────────────────────────────────────────────
// FIX #1: MUTUAL_BOOST حالا در computeScore واقعاً استفاده میشه
const MUTUAL_BOOST = 0.12; // مقدار کاهش یافت تا clamp کمتر بزنه

const NEW_USER_BOOST_HOURS = 16;
const NEW_USER_BOOST_THRESHOLD = 4;

const RETURN_BOOST_DAYS = 7;
const RETURN_BOOST_DURATION_HOURS = 24;

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

function safeLog(x, cap) {
  return clamp01(Math.log(1 + x) / Math.log(1 + cap));
}

function softCap(x, cap = 1.0) {
  // اگه زیر 0.85 بود، دست نزن
  if (x <= 0.85) return x;
  // بالای 0.85 رو با curve فشرده کن، نه قطع کن
  const overflow = x - 0.85;
  return 0.85 + overflow / (1 + overflow / (cap - 0.85));
}

// ── SCORE SUB-COMPONENTS ──────────────────────────────────────────────────────
function computeColdStartBoost(u) {
  if (!u.createdAt) return 0;
  const age = Date.now() - u.createdAt;
  if (age <= 0) return 0;
  const flat = COLD_START_FLAT_HOURS * 3600000; // 24h
  const decay = COLD_START_DECAY_DAYS * 86400000; // 7 days
  if (age <= flat) return COLD_START_PEAK_BOOST; // 0.3
  if (age <= decay) {
    const t = (age - flat) / (decay - flat);
    return COLD_START_PEAK_BOOST * (1 - t);
  }
  return 0;
}

function computePic(u) {
  const raw =
    typeof u.picScore === "number" ? u.picScore : NEUTRAL_PIC_SCORE;
  const x = clamp01(raw / 100);
  return 1 / (1 + Math.exp(-(x * 6 - 3)));
}

function computeLikeScore(u) {
  const likes = u.receivedLikes;
  if (!Array.isArray(likes) || likes.length === 0) return 0;

  const now = Date.now();
  const daysSinceActive = (now - (u.lastActivity ?? now)) / 86400000;

  // سقف = RETURN_BOOST_DAYS چون از اون به بعد returnBoost کاربر رو handle میکنه
  const dynamicWindow = Math.min(
    (LIKE_WINDOW_DAYS + daysSinceActive) * 86400000,
    RETURN_BOOST_DAYS * 86400000, // سقف = 7 روز
  );

  const start = now - dynamicWindow;

  const seen = new Set();
  let weighted = 0;
  let count = 0;

  for (const l of likes) {
    if (l?.at >= start) {
      if (seen.has(l.fromTelegramId)) continue;
      seen.add(l.fromTelegramId);

      const isRecent = l.at >= now - LIKE_WINDOW_MS;
      const weight = isRecent
        ? 1.0
        : clamp01(
            1 -
              (now - l.at - LIKE_WINDOW_MS) /
                (dynamicWindow - LIKE_WINDOW_MS),
          );

      weighted += clamp01(l?.likerScore ?? 0.5) * weight;
      count++;
    }
  }

  if (count === 0) return 0;
  const avg = weighted / count;
  const volume = safeLog(count, LIKE_SOFT_CAP);
  return clamp01(avg * 0.5 + volume * 0.5);
}

function computeActivity(u) {
  const last = u.lastActivity ?? u.createdAt ?? Date.now();
  const days = Math.max(0, (Date.now() - last) / 86400000);
  return clamp01(Math.exp(-days / ACTIVITY_DECAY_DAYS));
}

function computeMatchRate(u) {
  const sent = Array.isArray(u.likedByMe) ? u.likedByMe.length : 0;
  const matched = Array.isArray(u.matches) ? u.matches.length : 0;
  const smoothedSent = sent + 5;
  const smoothedMatch = matched + 1;
  return clamp01(smoothedMatch / smoothedSent);
}

function computeProfileQuality(u) {
  const c = u.profileCompletedPercent ?? 50;
  return clamp01(c / 100);
}

function computeNewUserBoost(u) {
  if (!u.createdAt) return 0;
  const hours = (Date.now() - u.createdAt) / 3600000;
  const totalLikes = Array.isArray(u.receivedLikes)
    ? u.receivedLikes.filter((l) => l.at >= u.createdAt).length
    : 0;
  if (
    hours <= NEW_USER_BOOST_HOURS &&
    totalLikes < NEW_USER_BOOST_THRESHOLD
  ) {
    return 0.5 * (1 - hours / NEW_USER_BOOST_HOURS);
  }
  return 0;
}

function computeReturnBoost(u) {
  if (!u.returnBoostAt) return 0;
  const hoursSinceLastSeen = (Date.now() - u.returnBoostAt) / 3600000;
  const RETURN_BOOST_THRESHOLD_HOURS = RETURN_BOOST_DAYS * 24;
  if (hoursSinceLastSeen < RETURN_BOOST_THRESHOLD_HOURS) return 0;
  const decay =
    1 -
    Math.min(
      1,
      (hoursSinceLastSeen - RETURN_BOOST_THRESHOLD_HOURS) /
        RETURN_BOOST_DURATION_HOURS,
    );
  return 0.1 * decay;
}

function computeSubscriptionBoost(u) {
  if (!u.subscriptionExpireTime) return 0;
  return u.subscriptionExpireTime > Date.now() ? 0.15 : 0;
}

// وقتی کاربر از طرف دیگران لایک متقابل دریافت کرده، score کلیش بالاتر میره
function computeMutualBoostForScore(u) {
  const matches = Array.isArray(u.matches) ? u.matches : [];
  if (matches.length === 0) return 0;

  const now = Date.now();
  const RECENT_WINDOW_MS = 30 * 86400000;

  let weighted = 0;
  let count = 0;

  for (const m of matches) {
    const age = now - (m.at || 0);
    if (age > RECENT_WINDOW_MS) continue;
    const freshness = 1 - age / RECENT_WINDOW_MS;
    weighted += freshness;
    count++;
  }

  if (count === 0) return 0;

  const ageDays = Math.max(
    1,
    (now - (u.createdAt ?? now)) / 86400000,
  );
  const velocity = count / ageDays;
  const avgFreshness = weighted / count;
  const score = velocity * avgFreshness * safeLog(count, 10);

  return clamp01(MUTUAL_BOOST * safeLog(score * 10, 10));
}
// ── MAIN SCORE ────────────────────────────────────────────────────────────────
function computeScore(u) {
  const pic = computePic(u);
  const like = computeLikeScore(u);
  const activity = computeActivity(u);
  const match = computeMatchRate(u);
  const profile = computeProfileQuality(u);

  // base score (weights sum to 1.0)
  const base =
    pic * W_PIC +
    like * W_LIKE +
    activity * W_ACTIVITY +
    match * W_MATCHRATE +
    profile * W_PROFILE;

  // boosts (additive, independent)
  const cold = computeColdStartBoost(u);
  const newUser = computeNewUserBoost(u);
  const returnBoost = computeReturnBoost(u);
  const subscription = computeSubscriptionBoost(u);
  // FIX #1: mutual boost اکنون واقعاً اعمال میشه
  const mutual = computeMutualBoostForScore(u);

  const dominantBoost = Math.max(cold, newUser); // فقط بزرگترین
  const raw =
    base + dominantBoost + returnBoost + subscription + mutual;
  return parseFloat(softCap(raw).toFixed(4));
}

module.exports = {
  computeScore,
  computeActivity,
  computeMutualBoostForScore,
  computeReturnBoost,
  computeNewUserBoost,
  computeSubscriptionBoost,
};
