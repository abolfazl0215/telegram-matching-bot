const {
  computeScore,
  computeActivity,
} = require("./computeScore");

// ── FINAL SCORE WEIGHTS (sum = 1.0) ───────────────────────────────────────────
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
  if (!candidate.age) return 0.5;

  const ageRange =
    viewer.ageRange ??
    computeAgeRange(viewer.likedAges ?? [], viewer.age);
  const { min, max } = ageRange;
  const age = candidate.age;

  if (age >= min && age <= max) return 1;

  const distance = age < min ? min - age : age - max;
  return clamp01(1 - distance * 0.1);
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

  const effectiveLimit = limit;

  // ── SEEN SET ──────────────────────────────────────────────────
  const seen = new Set([
    ...(viewer.nopedByMe ?? []),
    ...(viewer.likedByMe ?? []),
    ...(viewer.blockedByMe ?? []),
    ...(viewer.blockedMe ?? []),
  ]);

  const addedIds = new Set();
  const scored = [];

  // ── PASS 1 ────────────────────────────────────────────────────
  for (const candidate of pool) {
    if (candidate.telegramId === viewer.telegramId) continue;
    if (candidate.sleep) continue;
    if (seen.has(candidate.telegramId)) continue;
    if (!isCompatible(viewer, candidate)) continue;

    const base = computeScore(candidate);
    const age = getAgeCompatibilityScore(viewer, candidate);
    const mutual = computeMutualBoostForFeed(candidate, viewer);

    candidate.finalScore =
      base * FW_BASE + age * FW_AGE + mutual * FW_MUTUAL;

    candidate._passIndex = 0;
    scored.push(candidate);
    addedIds.add(candidate.telegramId);
  }

  // ── PASS 2 ────────────────────────────────────────────────────
  if (scored.length < 50) {
    for (const candidate of pool) {
      if (candidate.telegramId === viewer.telegramId) continue;
      if (candidate.sleep) continue;
      if (seen.has(candidate.telegramId)) continue;
      if (addedIds.has(candidate.telegramId)) continue;

      const base = computeScore(candidate);
      const age = getAgeCompatibilityScore(viewer, candidate);
      const mutual = computeMutualBoostForFeed(candidate, viewer);

      candidate.finalScore =
        base * FW_BASE + age * FW_AGE + mutual * FW_MUTUAL;

      candidate._passIndex = 1;
      scored.push(candidate);
      addedIds.add(candidate.telegramId);
    }
  }

  // ── PASS 3 — NOPE RECYCLER ───────────────────────────────────
  if (scored.length < 10) {
    const hardSeen = new Set([
      ...(viewer.likedByMe ?? []),
      ...(viewer.blockedByMe ?? []),
      ...(viewer.blockedMe ?? []),
    ]);

    for (const candidate of pool) {
      if (candidate.telegramId === viewer.telegramId) continue;
      if (candidate.sleep) continue;
      if (hardSeen.has(candidate.telegramId)) continue;
      if (addedIds.has(candidate.telegramId)) continue;

      const base = computeScore(candidate);
      const age = getAgeCompatibilityScore(viewer, candidate);
      const mutual = computeMutualBoostForFeed(candidate, viewer);

      candidate.finalScore =
        base * FW_BASE + age * FW_AGE + mutual * FW_MUTUAL;

      candidate._passIndex = 2;
      scored.push(candidate);
      addedIds.add(candidate.telegramId);
    }
  }

  // ── PASS 4 — FULL RESET ──────────────────────────────────────
  if (scored.length < 10) {
    const absoluteBlockedOnly = new Set([
      ...(viewer.blockedByMe ?? []),
      ...(viewer.blockedMe ?? []),
    ]);

    for (const candidate of pool) {
      if (candidate.telegramId === viewer.telegramId) continue;
      if (candidate.sleep) continue;
      if (absoluteBlockedOnly.has(candidate.telegramId)) continue;
      if (addedIds.has(candidate.telegramId)) continue;

      const base = computeScore(candidate);
      const age = getAgeCompatibilityScore(viewer, candidate);
      const mutual = computeMutualBoostForFeed(candidate, viewer);

      candidate.finalScore =
        base * FW_BASE + age * FW_AGE + mutual * FW_MUTUAL;

      candidate._passIndex = 3;
      scored.push(candidate);
      addedIds.add(candidate.telegramId);
    }
  }

  // ── SORT نهایی ────────────────────────────────────────────────
  scored.sort((a, b) => {
    if (a._passIndex !== b._passIndex)
      return a._passIndex - b._passIndex;
    return b.finalScore - a.finalScore;
  });

  const results = scored.slice(0, effectiveLimit);
  const resultIds = new Set(results.map((c) => c.telegramId));

  // ── CLEANUP کامل ──────────────────────────────────────────────
  // روی کل scored پاک میشه (نه فقط results)، چون همه‌شون مستقیم
  // روی آبجکت‌های واقعی pool/usersMap mutate شدن.
  for (const c of scored) {
    delete c._passIndex;
    if (!resultIds.has(c.telegramId)) {
      delete c.finalScore;
    }
  }

  return results;
}

module.exports = { getMatchCandidates };
