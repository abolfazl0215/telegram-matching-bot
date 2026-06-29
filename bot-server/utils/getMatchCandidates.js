const path = require("path");

const {
  computeScore,
  computeActivity,
  computeNewUserBoost,
  computeReturnBoost,
  computeSubscriptionBoost,
} = require("./computeScore");

// ── CONSTANTS ─────────────────────────────────────────────────────────────────

const LIKE_WINDOW_DAYS = 3;
const LIKE_WINDOW_MS = LIKE_WINDOW_DAYS * 86400000;

// ── BOOST CONSTANTS ───────────────────────────────────────────────────────────
// FIX #1: MUTUAL_BOOST حالا در computeScore واقعاً استفاده میشه
const MUTUAL_BOOST = 0.12; // مقدار کاهش یافت تا clamp کمتر بزنه

const NEW_USER_BOOST_HOURS = 16;

const RETURN_BOOST_DAYS = 7;

// ── FINAL SCORE WEIGHTS (sum = 1.0) ───────────────────────────────────────────
// FIX #3: وزن‌های finalScore نرمال‌سازی شدن
// base(0.75) + age(0.15) + mutual(0.10) = 1.00
const FW_BASE = 0.75;
const FW_AGE = 0.15;
const FW_MUTUAL = 0.1;

// ── HELPERS ───────────────────────────────────────────────────────────────────
function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// ── AGE HELPERS ───────────────────────────────────────────────────────────────
function computeAgeRange(likedAges, viewerAge = null) {
  if (!likedAges || likedAges.length === 0) {
    const base = viewerAge ?? 25;
    return {
      min: Math.max(18, base - 5),
      max: Math.min(60, base + 5),
    };
  }
  const sorted = [...likedAges].sort((a, b) => a - b);
  const rawMin = sorted[0] - 1;
  const rawMax = sorted[sorted.length - 1] + 1;
  const mid = (rawMin + rawMax) / 2;
  return {
    min: Math.max(18, Math.min(rawMin, mid - 2)),
    max: Math.min(60, Math.max(rawMax, mid + 2)),
  };
}

function isCompatible(viewer, candidate) {
  if (!viewer || !candidate) return false;

  const viewerLooking = viewer.lookingFor ?? "noMatter";
  const candidateLooking = candidate.lookingFor ?? "noMatter";

  const viewerOk =
    viewerLooking === "noMatter" ||
    viewerLooking === candidate.gender;

  const candidateOk =
    candidateLooking === "noMatter" ||
    candidateLooking === viewer.gender;

  return viewerOk && candidateOk;
}

function getAgeCompatibilityScore(viewer, candidate) {
  if (!candidate.age) return 0.5; // FIX #1: age نداشت → neutral

  const ageRange =
    viewer.ageRange ??
    computeAgeRange(viewer.likedAges ?? [], viewer.age);
  const { min, max } = ageRange;
  const age = candidate.age;

  if (age >= min && age <= max) return 1;

  const distance = age < min ? min - age : age - max;
  return clamp01(1 - distance * 0.1); // FIX #2: از 0.15 به 0.10
}

// ── MUTUAL BOOST برای ranking فید (نه global score) ──────────────────────────
function computeMutualBoostForFeed(candidate, viewer) {
  if (!viewer?.telegramId) return 0;

  const hasLiked =
    Array.isArray(candidate.likedByMe) &&
    candidate.likedByMe.includes(viewer.telegramId);
  if (!hasLiked) return 0;

  const activity = computeActivity(candidate);
  return clamp01(activity);
}

// ── MATCH ENGINE ──────────────────────────────────────────────────────────────
function getMatchCandidates(viewer, pool, limit = 10) {
  if (!viewer) return [];

  // ── QUOTA CHECK ───────────────────────────────────────────────
  const WINDOW_MS = 12 * 3600000;
  const hasSubscription = viewer.subscriptionExpireTime > Date.now();
  const DAILY_CAP = hasSubscription ? 200 : 100;
  const now = Date.now();

  const windowExpired =
    !viewer.lastGetCandidatesAt ||
    now - viewer.lastGetCandidatesAt >= WINDOW_MS;

  if (windowExpired) {
    viewer.lastGetCandidatesAt = now;
    viewer.getCandidatesCount = 0;
  }

  // const remaining = DAILY_CAP - (viewer.getCandidatesCount ?? 0);
  // if (remaining <= 0) return [];

  // const effectiveLimit = Math.min(limit, remaining);
  const effectiveLimit = limit;
  // ─────────────────────────────────────────────────────────────
  const seen = new Set([
    ...(viewer.nopedByMe ?? []),
    ...(viewer.likedByMe ?? []),
    ...(viewer.blockedByMe ?? []),
    ...(viewer.blockedMe ?? []),
  ]);
  const scored = [];
  const addedIds = new Set();

  for (const candidate of pool) {
    if (candidate.telegramId === viewer.telegramId) continue;
    if (candidate.sleep) continue;
    if (seen.has(candidate.telegramId)) continue;
    if (!isCompatible(viewer, candidate)) continue;

    const baseScore = computeScore(candidate);
    const ageScore = getAgeCompatibilityScore(viewer, candidate);
    const mutualRaw = computeMutualBoostForFeed(candidate, viewer);

    scored.push(candidate);
    addedIds.add(candidate.telegramId);
  }

  // ── FALLBACK PASS: اگر نتیجه کمتر از ۵۰ بود، شرط isCompatible رو نادیده بگیر ──
  if (scored.length < 50) {
    for (const candidate of pool) {
      if (candidate.telegramId === viewer.telegramId) continue;
      if (candidate.sleep) continue;
      if (seen.has(candidate.telegramId)) continue;
      if (addedIds.has(candidate.telegramId)) continue;

      const baseScore = computeScore(candidate);
      const ageScore = getAgeCompatibilityScore(viewer, candidate);
      const mutualRaw = computeMutualBoostForFeed(candidate, viewer);

      scored.push(candidate);
      addedIds.add(candidate.telegramId);
    }
  }

  scored.sort((a, b) => b.finalScore - a.finalScore);
  const results = scored.slice(0, effectiveLimit);

  // ── UPDATE QUOTA (فقط تعداد نمایش‌داده‌شده ثبت میشه) ─────────
  // viewer.getCandidatesCount =
  //   (viewer.getCandidatesCount ?? 0) + results.length;

  return results;
}

module.exports = { getMatchCandidates };
