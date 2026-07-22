const express = require("express");
const db = require("../db");
const { PERMISSIONS, requirePermission } = require("../middleware/auth");

const router = express.Router();
const VALID_POSITIONS = new Set(["both", "left", "right"]);
const VALID_STATUSES = new Set(["all", "active", "scheduled", "expired", "hidden"]);

function toMysqlDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function getAdvertisementStatus(advertisement) {
  if (!Number(advertisement.is_active)) return "hidden";

  const now = Date.now();
  const startsAt = advertisement.starts_at ? new Date(advertisement.starts_at).getTime() : null;
  const expiresAt = advertisement.expires_at ? new Date(advertisement.expires_at).getTime() : null;

  if (startsAt && startsAt > now) return "scheduled";
  if (expiresAt && expiresAt <= now) return "expired";

  return "active";
}

function normalizeAdvertisement(advertisement) {
  return {
    id: advertisement.id,
    title: advertisement.title,
    image: advertisement.image,
    link_url: advertisement.link_url,
    linkUrl: advertisement.link_url,
    position: advertisement.position || "both",
    sort_order: advertisement.sort_order || 0,
    sortOrder: advertisement.sort_order || 0,
    starts_at: advertisement.starts_at,
    startsAt: advertisement.starts_at,
    expires_at: advertisement.expires_at,
    expiresAt: advertisement.expires_at,
    is_active: Number(advertisement.is_active),
    isActive: Boolean(Number(advertisement.is_active)),
    status: getAdvertisementStatus(advertisement)
  };
}

function validateAdvertisementPayload(req, res, next) {
  const title = String(req.body.title || "").trim();
  const image = String(req.body.image || "").trim();
  const position = VALID_POSITIONS.has(req.body.position) ? req.body.position : "both";

  if (!title) {
    return res.status(400).json({ message: "Vui long nhap tieu de quang cao." });
  }

  if (!image) {
    return res.status(400).json({ message: "Vui long chon hinh anh quang cao." });
  }

  if (!/^https?:\/\//i.test(image) && !/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) {
    return res.status(400).json({ message: "Anh quang cao khong hop le." });
  }

  if (image.length > 2_200_000) {
    return res.status(413).json({ message: "Anh qua lon. Vui long chon anh nho hon 1.5MB." });
  }

  req.advertisementPayload = {
    title,
    image,
    linkUrl: String(req.body.linkUrl || req.body.link_url || "").trim() || null,
    position,
    sortOrder: Number(req.body.sortOrder ?? req.body.sort_order ?? 0) || 0,
    startsAt: toMysqlDateTime(req.body.startsAt || req.body.starts_at),
    expiresAt: toMysqlDateTime(req.body.expiresAt || req.body.expires_at),
    isActive: req.body.isActive === false || req.body.is_active === 0 || req.body.is_active === "0" ? 0 : 1
  };

  return next();
}

router.get("/", async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
    const [advertisements] = await db.query(
      `SELECT *
       FROM advertisements
       WHERE is_active = 1
         AND (starts_at IS NULL OR starts_at <= NOW())
         AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY sort_order ASC, id ASC
       LIMIT ?`,
      [limit]
    );

    res.json(advertisements.map(normalizeAdvertisement));
  } catch (error) {
    console.error("Load advertisements error:", error);
    res.status(500).json({ message: "Khong the tai quang cao." });
  }
});

router.get("/admin", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const position = VALID_POSITIONS.has(req.query.position) ? req.query.position : "all";
    const status = VALID_STATUSES.has(req.query.status) ? req.query.status : "all";
    const [rows] = await db.query(
      `SELECT *
       FROM advertisements
       WHERE (? = '' OR title LIKE ?)
         AND (? = 'all' OR position = ? OR position = 'both')
       ORDER BY sort_order ASC, id ASC`,
      [q, `%${q}%`, position, position]
    );

    const advertisements = rows
      .map(normalizeAdvertisement)
      .filter(advertisement => status === "all" || advertisement.status === status);

    res.json(advertisements);
  } catch (error) {
    console.error("Admin advertisements error:", error);
    res.status(500).json({ message: "Khong the tai danh sach quang cao." });
  }
});

router.get("/admin/:id", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM advertisements WHERE id = ? LIMIT 1", [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Khong tim thay quang cao." });
    }

    return res.json(normalizeAdvertisement(rows[0]));
  } catch (error) {
    console.error("Get advertisement error:", error);
    return res.status(500).json({ message: "Khong the tai quang cao." });
  }
});

router.post("/admin", requirePermission(PERMISSIONS.ADS_MANAGE), validateAdvertisementPayload, async (req, res) => {
  const payload = req.advertisementPayload;

  try {
    const [result] = await db.query(
      `INSERT INTO advertisements
        (title, image, link_url, position, sort_order, starts_at, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.title,
        payload.image,
        payload.linkUrl,
        payload.position,
        payload.sortOrder,
        payload.startsAt,
        payload.expiresAt,
        payload.isActive
      ]
    );

    res.status(201).json({ message: "Da tao quang cao.", id: result.insertId });
  } catch (error) {
    console.error("Create advertisement error:", error);
    res.status(500).json({ message: "Khong the tao quang cao." });
  }
});

router.put("/admin/:id", requirePermission(PERMISSIONS.ADS_MANAGE), validateAdvertisementPayload, async (req, res) => {
  const payload = req.advertisementPayload;

  try {
    const [result] = await db.query(
      `UPDATE advertisements
       SET title = ?,
           image = ?,
           link_url = ?,
           position = ?,
           sort_order = ?,
           starts_at = ?,
           expires_at = ?,
           is_active = ?
       WHERE id = ?`,
      [
        payload.title,
        payload.image,
        payload.linkUrl,
        payload.position,
        payload.sortOrder,
        payload.startsAt,
        payload.expiresAt,
        payload.isActive,
        req.params.id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay quang cao." });
    }

    return res.json({ message: "Da cap nhat quang cao." });
  } catch (error) {
    console.error("Update advertisement error:", error);
    return res.status(500).json({ message: "Khong the cap nhat quang cao." });
  }
});

router.delete("/admin/:id", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  try {
    const [result] = await db.query("DELETE FROM advertisements WHERE id = ?", [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay quang cao." });
    }

    return res.json({ message: "Da xoa quang cao." });
  } catch (error) {
    console.error("Delete advertisement error:", error);
    return res.status(500).json({ message: "Khong the xoa quang cao." });
  }
});

module.exports = router;
