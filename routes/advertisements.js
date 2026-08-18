const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const db = require("../db");
const { PERMISSIONS, requirePermission } = require("../middleware/auth");

const router = express.Router();
const VALID_POSITIONS = new Set(["both", "left", "right"]);
const VALID_STATUSES = new Set(["all", "active", "scheduled", "expired", "hidden"]);
const AD_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "advertisements");
const hasCloudinaryConfig = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME
    && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinaryConfig) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

const adImageUpload = multer({
  // Upload ảnh quảng cáo vào memory để có thể đẩy lên Cloudinary hoặc ghi file local sau khi validate.
  // Giới hạn dung lượng giúp tránh request quá lớn làm ảnh hưởng API.
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      callback(new Error("Vui lòng chọn tệp hình ảnh"));
      return;
    }

    callback(null, true);
  }
});

function toMysqlDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function getApiBaseUrl(req) {
  return (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function getImageExtension(mimetype) {
  const extension = String(mimetype || "").split("/")[1] || "jpg";
  return extension === "jpeg" ? "jpg" : extension.replace(/[^a-z0-9]/gi, "") || "jpg";
}

async function saveAdvertisementImageFile(req, file) {
  // Lưu ảnh quảng cáo do admin upload.
  // Output là URL ảnh dùng cho banner nổi ngoài frontend; ưu tiên Cloudinary nếu có cấu hình.
  if (hasCloudinaryConfig) {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: process.env.CLOUDINARY_AD_FOLDER || "foodhub/advertisements",
          resource_type: "image",
          transformation: [
            { width: 420, height: 1200, crop: "limit" },
            { quality: "auto", fetch_format: "auto" }
          ]
        },
        (error, result) => {
          if (error) {
            reject(error);
            return;
          }

          resolve(result);
        }
      );

      stream.end(file.buffer);
    });

    return uploadResult.secure_url;
  }

  await fs.promises.mkdir(AD_UPLOAD_DIR, { recursive: true });
  const filename = `ad-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${getImageExtension(file.mimetype)}`;
  const filepath = path.join(AD_UPLOAD_DIR, filename);

  await fs.promises.writeFile(filepath, file.buffer);

  return `${getApiBaseUrl(req)}/uploads/advertisements/${filename}`;
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
    return res.status(400).json({ message: "Vui lòng nhập tiêu đề quảng cáo." });
  }

  if (!image) {
    return res.status(400).json({ message: "Vui lòng chọn hình ảnh quảng cáo." });
  }

  if (!/^https?:\/\//i.test(image)) {
    return res.status(400).json({ message: "Anh quảng cáo không hợp lệ." });
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
  // GET /api/advertisements
  // Trả banner quảng cáo đang hoạt động cho frontend công khai theo thời gian hiệu lực.
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
    res.status(500).json({ message: "Không thể tải quảng cáo." });
  }
});

router.get("/admin", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  // GET /api/advertisements/admin
  // Admin xem/lọc toàn bộ quảng cáo, bao gồm trạng thái hidden/scheduled/expired.
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
    res.status(500).json({ message: "Không thể tải danh sách quảng cáo." });
  }
});

router.get("/admin/:id", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM advertisements WHERE id = ? LIMIT 1", [req.params.id]);

    if (rows.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy quảng cáo." });
    }

    return res.json(normalizeAdvertisement(rows[0]));
  } catch (error) {
    console.error("Get advertisement error:", error);
    return res.status(500).json({ message: "Không thể tải quảng cáo." });
  }
});

router.post("/admin/image", requirePermission(PERMISSIONS.ADS_MANAGE), (req, res) => {
  adImageUpload.single("image")(req, res, async error => {
    if (error) {
      const isSizeError = error.code === "LIMIT_FILE_SIZE";
      return res.status(isSizeError ? 413 : 400).json({
        message: isSizeError
          ? "Ảnh quảng cáo quá lớn. Vui lòng chọn ảnh nhỏ hơn 2MB."
          : error.message || "Không thể tải ảnh quảng cáo"
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: "Vui lòng chọn ảnh quảng cáo" });
      }

      const imageUrl = await saveAdvertisementImageFile(req, req.file);
      return res.json({
        message: "Đã tải ảnh quảng cáo",
        image: imageUrl
      });
    } catch (uploadError) {
      console.error(uploadError);
      return res.status(500).json({ message: "Không thể lưu ảnh quảng cáo" });
    }
  });
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

    res.status(201).json({ message: "Đã tạo quảng cáo.", id: result.insertId });
  } catch (error) {
    console.error("Create advertisement error:", error);
    res.status(500).json({ message: "Không thể tạo quảng cáo." });
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
      return res.status(404).json({ message: "Không tìm thấy quảng cáo." });
    }

    return res.json({ message: "Da cập nhật quảng cáo." });
  } catch (error) {
    console.error("Update advertisement error:", error);
    return res.status(500).json({ message: "Không thể cập nhật quảng cáo." });
  }
});

router.delete("/admin/:id", requirePermission(PERMISSIONS.ADS_MANAGE), async (req, res) => {
  try {
    const [result] = await db.query("DELETE FROM advertisements WHERE id = ?", [req.params.id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy quảng cáo." });
    }

    return res.json({ message: "Đã xóa quảng cáo." });
  } catch (error) {
    console.error("Delete advertisement error:", error);
    return res.status(500).json({ message: "Không thể xóa quảng cáo." });
  }
});

module.exports = router;
