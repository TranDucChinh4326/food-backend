const express = require("express");
const db = require("../db");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
    const [announcements] = await db.query(
      `SELECT id, title, content, published_at
       FROM announcements
       WHERE is_active = 1
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

module.exports = router;
