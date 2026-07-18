const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
    const [announcements] = await db.query(
      `SELECT id, title, content, link_url, is_important, published_at
       FROM announcements
       WHERE is_active = 1
       ORDER BY is_important DESC, COALESCE(published_at, created_at) DESC, id DESC
       LIMIT ?`,
      [limit]
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tai thong bao" });
  }
});

module.exports = router;
