const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  // GET /api/announcements
  // Trả một số thông báo đang hiệu lực để frontend hiển thị nhanh ở trang chủ/header.
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
    const [announcements] = await db.query(
      `SELECT id, title, published_at, expires_at
       FROM announcements
       WHERE is_active = 1
         AND (published_at IS NULL OR published_at <= NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY id ASC
       LIMIT ?`,
      [limit]
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải thông báo" });
  }
});

router.get("/archive", async (req, res) => {
  // GET /api/announcements/archive
  // Trả danh sách thông báo đầy đủ hơn cho trang thông báo công khai.
  try {
    const [announcements] = await db.query(
      `SELECT id, title, content, is_active, published_at, expires_at,
        'active' AS status
       FROM announcements
       WHERE is_active = 1
         AND (published_at IS NULL OR published_at <= NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY COALESCE(published_at, created_at) DESC, id DESC
       LIMIT 200`
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải danh sách thông báo" });
  }
});

module.exports = router;
