const express = require("express");
const db = require("../db");
const { optionalAuth, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", optionalAuth, async (req, res) => {
  // GET /api/announcements
  // Trả một số thông báo đang hiệu lực để frontend hiển thị nhanh ở trang chủ/header.
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 6, 1), 20);
    const [announcements] = await db.query(
      `SELECT a.id, a.title, a.published_at, a.expires_at,
              CASE WHEN ar.announcement_id IS NULL THEN 0 ELSE 1 END AS is_read
       FROM announcements a
       LEFT JOIN announcement_reads ar
         ON ar.announcement_id = a.id AND ar.user_id = ?
       WHERE a.is_active = 1
         AND (a.published_at IS NULL OR a.published_at <= NOW())
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id DESC
       LIMIT ?`,
      [req.user?.id || null, limit]
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải thông báo" });
  }
});

router.get("/archive", optionalAuth, async (req, res) => {
  // GET /api/announcements/archive
  // Trả danh sách thông báo đầy đủ hơn cho trang thông báo công khai.
  try {
    const [announcements] = await db.query(
      `SELECT a.id, a.title, a.content, a.is_active, a.published_at, a.expires_at,
        'active' AS status,
        CASE WHEN ar.announcement_id IS NULL THEN 0 ELSE 1 END AS is_read
       FROM announcements a
       LEFT JOIN announcement_reads ar
         ON ar.announcement_id = a.id AND ar.user_id = ?
       WHERE a.is_active = 1
         AND (a.published_at IS NULL OR a.published_at <= NOW())
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
       ORDER BY COALESCE(a.published_at, a.created_at) DESC, a.id DESC
       LIMIT 200`,
      [req.user?.id || null]
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải danh sách thông báo" });
  }
});

router.get("/unread-count", requireAuth, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT COUNT(*) AS unread_count
       FROM announcements a
       LEFT JOIN announcement_reads ar
         ON ar.announcement_id = a.id AND ar.user_id = ?
       WHERE a.is_active = 1
         AND (a.published_at IS NULL OR a.published_at <= NOW())
         AND (a.expires_at IS NULL OR a.expires_at > NOW())
         AND ar.announcement_id IS NULL`,
      [req.user.id]
    );

    res.json({ unreadCount: Number(rows[0]?.unread_count || 0) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the dem thong bao chua doc" });
  }
});

router.post("/read", requireAuth, async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids)
      ? [...new Set(req.body.ids.map(Number).filter(Number.isInteger).filter(id => id > 0))]
      : [];

    if (ids.length === 0) {
      return res.status(400).json({ message: "Danh sach thong bao khong hop le" });
    }

    const placeholders = ids.map(() => "?").join(", ");
    await db.query(
      `INSERT IGNORE INTO announcement_reads (user_id, announcement_id)
       SELECT ?, id
       FROM announcements
       WHERE id IN (${placeholders})
         AND is_active = 1
         AND (published_at IS NULL OR published_at <= NOW())`,
      [req.user.id, ...ids]
    );

    res.json({ message: "Da danh dau thong bao la da doc" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the cap nhat thong bao" });
  }
});

module.exports = router;
