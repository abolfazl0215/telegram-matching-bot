const express = require("express");
const User = require("../models/User");
const Pictures = require("../models/Pictures");
const { removeFromExplore } = require("../utils/removeFromExplore");

const router = express.Router();

const BASE_URL = () => {
  if (process.env.PLATFORM === "bale") {
    return (
      "https://tapi.bale.ai/file/bot" +
      process.env.BALE_BOT_TOKEN +
      "/"
    );
  } else {
    return (
      "https://api.telegram.org/file/bot" +
      process.env.TELEGRAM_BOT_TOKEN +
      "/"
    );
  }
};

// GET /monitoring
router.get("/monitoring", async (req, res) => {
  try {
    const pics = await Pictures.find({ confirm: false }).sort({
      createdAt: -1,
    });

    // Find the latest pic per telegramId
    const latestMap = {};
    pics.forEach((p) => {
      if (
        !latestMap[p.telegramId] ||
        p.createdAt > latestMap[p.telegramId].createdAt
      ) {
        latestMap[p.telegramId] = p;
      }
    });

    // Group by telegramId to count duplicates
    const countMap = {};
    pics.forEach((p) => {
      countMap[p.telegramId] = (countMap[p.telegramId] || 0) + 1;
    });

    const rows = pics
      .map((pic) => {
        const isLatest =
          String(latestMap[pic.telegramId]._id) === String(pic._id);
        const hasMultiple = countMap[pic.telegramId] > 1;
        const date = new Date(pic.createdAt).toLocaleString("en-GB", {
          day: "2-digit",
          month: "short",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });

        return `
        <div class="card" id="card-${pic._id}">
          <div class="card-inner">
            <div class="card-img-wrap">
              ${
                pic.url
                  ? `<img src="${BASE_URL()}${pic.url}" alt="${pic.fullName}" class="card-img">`
                  : `<div class="card-img-placeholder"><i class="ti ti-user"></i></div>`
              }
            </div>
            <div class="card-body">
              <div>
                <div class="card-top">
                  <span class="card-name">${pic.fullName || "—"} — ${pic?.state || ""}</span>
                  <span class="tag ${isLatest ? "latest" : ""}">
                    ${
                      isLatest
                        ? `<i class="ti ti-circle-check"></i> Latest`
                        : `<i class="ti ti-clock"></i> Older`
                    }
                  </span>
                </div>
                <div class="card-bio">${pic.bio || "<em>No bio</em>"}</div>
                <div class="card-meta">
                  <i class="ti ti-brand-telegram"></i> ${pic.telegramId}
                  &nbsp;·&nbsp;
                  <i class="ti ti-calendar"></i> ${date}
                  ${hasMultiple ? `&nbsp;·&nbsp;<span class="warn-inline">${countMap[pic.telegramId]} submissions</span>` : ""}
                </div>
              </div>
              <div>
                <div class="card-bottom">
                  <div class="score-wrap">
                    <label for="score-${pic._id}" class="score-label">Score</label>
                    <input
                      type="number" id="score-${pic._id}" name="score"
                      class="score-input" min="1" max="100" placeholder="1–100"
                      ${!isLatest ? "disabled" : ""}
                    />
                  </div>
                  <div class="actions">
                    <form action="/confirm/${pic._id}" method="POST" style="display:inline">
                      <input type="hidden" name="score" id="score-hidden-${pic._id}">
                      <button type="submit" class="btn btn-confirm" ${!isLatest ? "disabled" : ""}
                        onclick="document.getElementById('score-hidden-${pic._id}').value = document.getElementById('score-${pic._id}').value">
                        <i class="ti ti-check"></i> Confirm
                      </button>
                    </form>
                    <form action="/ban/${pic.telegramId}" method="POST" style="display:inline">
                      <button type="submit" class="btn btn-ban">
                        <i class="ti ti-ban"></i> Ban
                      </button>
                    </form>
                  </div>
                </div>
                ${
                  !isLatest
                    ? `<div class="warn-msg"><i class="ti ti-alert-triangle"></i> Not the latest submission — confirm the newest entry instead</div>`
                    : ""
                }
              </div>
            </div>
          </div>
        </div>`;
      })
      .join("");

    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Monitoring Panel</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css"/>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #f4f5f7; color: #1a1a1a; padding: 32px 20px; }
    .panel-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 28px; }
    .panel-title { font-size: 20px; font-weight: 600; display: flex; align-items: center; gap: 10px; }
    .badge-count { font-size: 12px; font-weight: 500; background: #fee2e2; color: #b91c1c; padding: 3px 10px; border-radius: 99px; }
    .cards { display: flex; flex-direction: column; gap: 14px; max-width: 900px; margin: 0 auto; }
    .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; overflow: hidden; }
    .card-inner { display: flex; }
    .card-img { width: 130px; min-width: 130px; height: 130px; object-fit: cover; border-right: 1px solid #e5e7eb; }
    .card-img-placeholder { width: 130px; min-width: 130px; height: 130px; background: #f9fafb; border-right: 1px solid #e5e7eb; display: flex; align-items: center; justify-content: center; color: #9ca3af; font-size: 36px; }
    .card-body { padding: 14px 16px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; min-width: 0; }
    .card-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
    .card-name { font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .card-bio { font-size: 13px; color: #6b7280; line-height: 1.5; margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .card-meta { font-size: 12px; color: #9ca3af; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
    .tag { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 99px; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
    .tag.latest { background: #dcfce7; color: #166534; }
    .tag:not(.latest) { background: #fef9c3; color: #854d0e; }
    .card-bottom { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .score-wrap { display: flex; align-items: center; gap: 8px; }
    .score-label { font-size: 12px; color: #6b7280; white-space: nowrap; }
    .score-input { width: 74px; padding: 5px 8px; font-size: 13px; border: 1px solid #d1d5db; border-radius: 8px; background: #fff; color: #1a1a1a; outline: none; }
    .score-input:focus { border-color: #6366f1; box-shadow: 0 0 0 2px rgba(99,102,241,0.12); }
    .score-input:disabled { background: #f3f4f6; color: #9ca3af; cursor: not-allowed; border-color: #e5e7eb; }
    .actions { display: flex; gap: 8px; margin-left: auto; }
    .btn { padding: 6px 14px; font-size: 13px; font-weight: 500; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; color: #374151; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
    .btn:hover { background: #f9fafb; }
    .btn-confirm { border-color: #16a34a; color: #16a34a; }
    .btn-confirm:hover { background: #f0fdf4; }
    .btn-confirm:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-ban { border-color: #dc2626; color: #dc2626; }
    .btn-ban:hover { background: #fef2f2; }
    .warn-msg { font-size: 11px; color: #b45309; display: flex; align-items: center; gap: 4px; margin-top: 5px; }
    .warn-inline { color: #b45309; }
    @media (max-width: 540px) {
      .card-inner { flex-direction: column; }
      .card-img, .card-img-placeholder { width: 100%; min-width: unset; height: 200px; border-right: none; border-bottom: 1px solid #e5e7eb; }
      .actions { margin-left: 0; width: 100%; }
      .btn { flex: 1; justify-content: center; }
    }
  </style>
</head>
<body>
  <div style="max-width:900px;margin:0 auto">
    <div class="panel-header">
      <div class="panel-title">
        <i class="ti ti-photo-search"></i>
        Image Review
        <span class="badge-count">${pics.length} pending</span>
      </div>
      <a href="/monitoring" style="font-size:13px;color:#6b7280;text-decoration:none;display:flex;align-items:center;gap:5px">
        <i class="ti ti-refresh"></i> Refresh
      </a>
    </div>
    <div class="cards">${rows || '<p style="text-align:center;color:#9ca3af;padding:4rem 0">All caught up!</p>'}</div>
  </div>
</body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Error fetching data");
  }
});

// POST /confirm/:id
router.post("/confirm/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const score = parseInt(req.body.score);

    if (!score || score < 1 || score > 100) {
      return res.status(400).send("Invalid score (must be 1–100)");
    }

    // Find the picture being confirmed
    const pic = await Pictures.findById(id);
    if (!pic) return res.status(404).send("Not found");

    const telegramId = pic.telegramId;

    // Delete all OTHER pictures with same telegramId (both confirmed and unconfirmed)
    await Pictures.deleteMany({ telegramId, _id: { $ne: id } });

    // Confirm this one with the score
    await Pictures.updateOne(
      { _id: id },
      { $set: { confirm: true, score } },
    );

    return res.redirect("/monitoring");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error confirming image");
  }
});

router.post("/ban/:telegramId", async (req, res) => {
  try {
    const telegramId = Number(req.params.telegramId);
    if (!telegramId) {
      return res
        .status(400)
        .json({ error: "telegramId is required" });
    }

    const findUser = await User.findOne({ telegramId: +telegramId });

    if (!findUser) {
      return res.status(404).json({ error: "User not found" });
    }

    findUser.ban = true;
    await findUser.save();

    // Remove from explore (Redis)
    await removeFromExplore(findUser);

    // حذف تمام عکس‌ها با یک query
    const result = await Pictures.deleteMany({
      telegramId: +telegramId,
    });

    return res.redirect("/monitoring");
  } catch (err) {
    console.error(err);
    res.status(500).send("خطا در بن کاربر");
  }
});

module.exports = router;
