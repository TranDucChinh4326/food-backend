const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
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
    res.status(500).json({ message: "Khong the tai thong bao" });
  }
});

router.get("/archive", async (req, res) => {
  try {
    const [announcements] = await db.query(
      `SELECT id, title, content, is_active, published_at, expires_at,
        CASE
          WHEN is_active = 0 THEN 'hidden'
          WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'expired'
          WHEN published_at IS NOT NULL AND published_at > NOW() THEN 'scheduled'
          ELSE 'active'
        END AS status
       FROM announcements
       ORDER BY id ASC
       LIMIT 200`
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tai danh sach thong bao" });
  }
});

module.exports = router;
