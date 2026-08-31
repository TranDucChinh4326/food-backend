const express = require("express");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const XLSX = require("xlsx");
const { v2: cloudinary } = require("cloudinary");
const db = require("../db");
const {
  ADMIN_ROLE,
  PERMISSIONS,
  hasPermission,
  requireAuth,
  requireAnyPermission,
  requirePermission
} = require("../middleware/auth");

const router = express.Router();

const MANAGED_ROLES = ["USER", "STAFF_SALES", "STAFF_CONTENT", "STAFF_MANAGER"];
const ALL_PERMISSIONS = Object.values(PERMISSIONS);
const FOOD_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "foods");
const STOCK_IMPORT_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "stock-imports");
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

const foodImageUpload = multer({
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

function parsePermissions(value) {
  if (!value) return [];

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter(permission => ALL_PERMISSIONS.includes(permission)) : [];
  } catch (error) {
    return [];
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function buildStaffEmail(username) {
  return `${normalizeUsername(username)}@staff.foodhub.local`;
}

function getApiBaseUrl(req) {
  return (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function getImageExtension(mimetype) {
  const extension = String(mimetype || "").split("/")[1] || "jpg";
  return extension === "jpeg" ? "jpg" : extension.replace(/[^a-z0-9]/gi, "") || "jpg";
}

async function saveFoodImageFile(req, file) {
  // Lưu ảnh món ăn do admin upload.
  // Nếu có Cloudinary thì trả URL cloud; nếu không có thì lưu local trong uploads để frontend dùng lại.
  if (hasCloudinaryConfig) {
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: process.env.CLOUDINARY_FOOD_FOLDER || "foodhub/foods",
          resource_type: "image",
          transformation: [
            { width: 900, height: 700, crop: "limit" },
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

  await fs.promises.mkdir(FOOD_UPLOAD_DIR, { recursive: true });
  const filename = `food-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${getImageExtension(file.mimetype)}`;
  const filepath = path.join(FOOD_UPLOAD_DIR, filename);

  await fs.promises.writeFile(filepath, file.buffer);

  return `${getApiBaseUrl(req)}/uploads/foods/${filename}`;
}

async function ensureLocalProvider(userId, email) {
  await db.query(
    `INSERT INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
     VALUES (?, 'local', NULL, ?)
     ON DUPLICATE KEY UPDATE provider_email = VALUES(provider_email)`,
    [userId, normalizeEmail(email)]
  );
}

function serializePermissions(permissions = []) {
  return JSON.stringify([...new Set(permissions.filter(permission => ALL_PERMISSIONS.includes(permission)))]);
}

function addDays(date, days) {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

function toMysqlDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeMysqlDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function normalizeMysqlTime(value) {
  const text = String(value || "").trim();
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(text)) return null;
  return text.length === 5 ? `${text}:00` : text;
}

function resolveAnnouncementExpiry(publishedAt, validityDays, expiresAt) {
  if (expiresAt) {
    return toMysqlDateTime(expiresAt);
  }

  const days = Number(validityDays);
  if (!Number.isFinite(days) || days <= 0) {
    return null;
  }

  const startDate = publishedAt ? new Date(publishedAt) : new Date();
  if (Number.isNaN(startDate.getTime())) {
    return null;
  }

  return toMysqlDateTime(addDays(startDate, days));
}

function normalizeDiscountCode(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

const AUDIT_METHOD_ACTIONS = {
  POST: "create",
  PUT: "update",
  PATCH: "update",
  DELETE: "delete"
};

const AUDIT_MODULE_LABELS = {
  announcements: "Thông báo",
  discounts: "Mã giảm giá",
  "shipping-methods": "Phí vận chuyển",
  orders: "Đơn hàng",
  categories: "Danh mục",
  foods: "Món ăn",
  users: "Tài khoản",
  staff: "Nhân viên",
  feedback: "Phản hồi",
  "food-reviews": "Bình luận món"
};

const AUDIT_SENSITIVE_KEYS = new Set([
  "password",
  "newPassword",
  "confirmPassword",
  "token",
  "accessToken",
  "refreshToken",
  "authorization"
]);

function getAuditModule(pathname) {
  const segment = String(pathname || "").split("/").filter(Boolean)[0] || "admin";
  return {
    key: segment,
    label: AUDIT_MODULE_LABELS[segment] || segment
  };
}

function getAuditTarget(pathname) {
  const segments = String(pathname || "").split("/").filter(Boolean);
  return {
    type: segments[0] || "admin",
    id: segments[1] || null
  };
}

function sanitizeAuditDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !AUDIT_SENSITIVE_KEYS.has(key))
      .map(([key, item]) => {
        if (item && typeof item === "object") return [key, "[object]"];
        const text = String(item ?? "");
        return [key, text.length > 180 ? `${text.slice(0, 180)}...` : item];
      })
  );
}

async function recordAdminAuditLog(req, action, statusCode) {
  if (!req.user || String(req.user.role || "").toUpperCase() === "USER") return;

  const moduleInfo = getAuditModule(req.path);
  const target = getAuditTarget(req.path);
  const details = sanitizeAuditDetails(req.body);
  const actorName = req.user.fullname || req.user.username || req.user.email || `User #${req.user.id}`;

  try {
    await db.query(
      `INSERT INTO admin_audit_logs
        (actor_id, actor_name, actor_role, action, module, target_type, target_id, method, path, details, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        actorName,
        req.user.role || null,
        action,
        moduleInfo.label,
        target.type,
        target.id,
        req.method,
        req.originalUrl,
        details ? JSON.stringify({ ...details, statusCode }) : JSON.stringify({ statusCode }),
        req.ip || null,
        String(req.get("user-agent") || "").slice(0, 255)
      ]
    );
  } catch (error) {
    console.error("Admin audit log write failed:", error.message);
  }
}

router.use((req, res, next) => {
  const action = AUDIT_METHOD_ACTIONS[req.method];
  if (!action) {
    next();
    return;
  }

  res.on("finish", () => {
    if (res.statusCode >= 200 && res.statusCode < 400) {
      recordAdminAuditLog(req, action, res.statusCode);
    }
  });

  next();
});

const stockImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 2 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    const originalName = String(file.originalname || "").toLowerCase();
    const isCsv = file.mimetype === "text/csv"
      || file.mimetype === "application/vnd.ms-excel"
      || originalName.endsWith(".csv");
    const isExcel = file.mimetype === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      || file.mimetype === "application/octet-stream"
      || originalName.endsWith(".xlsx");

    if (!isCsv && !isExcel) {
      callback(new Error("Vui long chon file Excel .xlsx hoac CSV"));
      return;
    }

    callback(null, true);
  }
});

function slugifyCategory(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function createUniqueCategorySlug(name, currentId = null) {
  const baseSlug = slugifyCategory(name) || `danh-muc-${Date.now()}`;
  let slug = baseSlug;
  let counter = 2;

  while (true) {
    const params = currentId ? [slug, currentId] : [slug];
    const sql = currentId
      ? "SELECT id FROM categories WHERE slug = ? AND id <> ? LIMIT 1"
      : "SELECT id FROM categories WHERE slug = ? LIMIT 1";
    const [rows] = await db.query(sql, params);

    if (rows.length === 0) return slug;

    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }
}

async function resolveCategoryType(parentId, fallbackSlug) {
  if (!parentId) {
    return fallbackSlug || "category";
  }

  const [parents] = await db.query(
    "SELECT id, slug, type FROM categories WHERE id = ? LIMIT 1",
    [parentId]
  );

  if (parents.length === 0) {
    return null;
  }

  return parents[0].type || parents[0].slug || fallbackSlug || "category";
}

function parsePositiveNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return fallback;
  return Math.round(number);
}

function normalizeFoodLookupName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/Ä‘/g, "d")
    .replace(/đ/g, "d")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let insideQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && insideQuote && next === '"') {
      current += '"';
      index += 1;
      continue;
    }

    if (char === '"') {
      insideQuote = !insideQuote;
      continue;
    }

    if (char === "," && !insideQuote) {
      values.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

function normalizeStockImportHeader(value) {
  return normalizeFoodLookupName(value).replace(/\s+/g, "_");
}

function mapStockImportRows(rows) {
  if (rows.length < 2) return [];

  const headers = rows[0].map(normalizeStockImportHeader);
  const foodIdIndex = headers.findIndex(header => ["ma_mon", "id_mon", "food_id", "id"].includes(header));
  const nameIndex = headers.findIndex(header => ["ten_mon", "ten_hang", "mon", "name", "food_name"].includes(header));
  const quantityIndex = headers.findIndex(header => ["so_luong_nhap", "so_luong", "quantity", "quantity_added"].includes(header));

  if (foodIdIndex === -1 && nameIndex === -1) {
    throw new Error("File can co cot ma_mon hoac ten_mon");
  }

  if (quantityIndex === -1) {
    throw new Error("File can co cot so_luong_nhap");
  }

  return rows.slice(1)
    .map((values, index) => ({
      rowNumber: index + 2,
      foodId: Number(values[foodIdIndex] || 0),
      inputName: nameIndex === -1 ? "" : String(values[nameIndex] || "").trim(),
      rawQuantity: values[quantityIndex],
      quantity: Number(values[quantityIndex] || 0)
    }))
    .filter(row => row.rawQuantity !== null && row.rawQuantity !== undefined && String(row.rawQuantity).trim() !== "");
}

function parseStockImportFile(file) {
  const originalName = String(file.originalname || "").toLowerCase();

  if (originalName.endsWith(".xlsx")) {
    const workbook = XLSX.read(file.buffer, { type: "buffer" });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return [];

    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: ""
    });
    return mapStockImportRows(rows);
  }

  const text = file.buffer.toString("utf8").replace(/^\uFEFF/, "");
  const rows = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(parseCsvLine);

  return mapStockImportRows(rows);
}

function buildWorkbookBuffer(rows, sheetName = "Data") {
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet["!cols"] = Object.keys(rows[0] || { data: "" }).map(key => ({
    wch: Math.max(14, Math.min(36, key.length + 8))
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

function sendWorkbook(res, filename, rows, sheetName) {
  const buffer = buildWorkbookBuffer(rows.length ? rows : [{ thong_bao: "Khong co du lieu" }], sheetName);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

function getDateRange(query = {}) {
  const from = String(query.from || "").trim();
  const to = String(query.to || "").trim();
  const where = [];
  const params = [];

  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    where.push("created_at >= ?");
    params.push(`${from} 00:00:00`);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    where.push("created_at <= ?");
    params.push(`${to} 23:59:59`);
  }

  return { where, params, from, to };
}

function parseNullablePositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function validateDiscountPayload(body) {
  // Chuẩn hóa dữ liệu voucher từ form admin trước khi ghi Database.
  // Output là { value } hợp lệ hoặc { error } để endpoint trả lỗi 400 rõ ràng cho frontend.
  const code = normalizeDiscountCode(body.code);
  const name = String(body.name || "").trim();
  const discountType = String(body.discountType || body.discount_type || "percent").trim().toLowerCase();
  const applyTo = String(body.applyTo || body.apply_to || "order").trim().toLowerCase();
  const discountValue = parsePositiveNumber(body.discountValue ?? body.discount_value, 0);
  const minOrder = parsePositiveNumber(body.minOrder ?? body.min_order, 0);
  const maxDiscount = parseNullablePositiveNumber(body.maxDiscount ?? body.max_discount);
  const usageLimit = parseNullablePositiveNumber(body.usageLimit ?? body.usage_limit);

  if (!code) return { error: "Vui lòng nhập mã giảm giá" };
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) return { error: "Mã giảm giá chỉ gồm chữ, số, dấu gạch ngang hoặc gạch dưới" };
  if (!name) return { error: "Vui lòng nhập tên chương trình" };
  if (!["percent", "fixed", "free_shipping"].includes(discountType)) return { error: "Kiểu giảm giá không hợp lệ" };
  if (!["order", "shipping"].includes(applyTo)) return { error: "Phạm vi áp dụng mã giảm giá không hợp lệ" };
  if ((discountType !== "free_shipping" && discountValue <= 0) || (discountType === "percent" && discountValue > 100)) {
    return { error: "Giá trị giảm giá không hợp lệ" };
  }

  return {
    value: {
      code,
      name,
      discountType,
      applyTo,
      discountValue: discountType === "free_shipping" ? 0 : discountValue,
      minOrder,
      maxDiscount,
      usageLimit,
      startsAt: toMysqlDateTime(body.startsAt ?? body.starts_at),
      expiresAt: toMysqlDateTime(body.expiresAt ?? body.expires_at),
      isActive: body.isActive === undefined ? true : Boolean(body.isActive)
    }
  };
}

function validateFlashSalePayload(body) {
  const title = String(body.title || "").trim();
  const scheduleType = String(body.scheduleType || body.schedule_type || "once").trim().toLowerCase();
  const startsAt = scheduleType === "daily" ? null : toMysqlDateTime(body.startsAt || body.starts_at);
  const endsAt = scheduleType === "daily" ? null : toMysqlDateTime(body.endsAt || body.ends_at);
  const startDate = scheduleType === "daily" ? normalizeMysqlDate(body.startDate || body.start_date) : null;
  const endDate = scheduleType === "daily" ? normalizeMysqlDate(body.endDate || body.end_date) : null;
  const startTime = scheduleType === "daily" ? normalizeMysqlTime(body.startTime || body.start_time) : null;
  const endTime = scheduleType === "daily" ? normalizeMysqlTime(body.endTime || body.end_time) : null;
  const isActive = body.isActive === undefined && body.is_active === undefined
    ? true
    : Boolean(Number(body.isActive ?? body.is_active));

  if (!title) return { error: "Vui lòng nhập tên flash sale" };
  if (title.length > 150) return { error: "Tên flash sale tối đa 150 ký tự" };
  if (!["once", "daily"].includes(scheduleType)) return { error: "Kiểu khung giờ flash sale không hợp lệ" };
  if (scheduleType === "daily" && (!startTime || !endTime)) {
    return { error: "Vui lòng chọn giờ bắt đầu và giờ kết thúc hằng ngày" };
  }
  if (scheduleType === "daily" && startDate && endDate && startDate > endDate) {
    return { error: "Ngày kết thúc phải sau ngày bắt đầu" };
  }
  if (startsAt && endsAt && new Date(startsAt) >= new Date(endsAt)) {
    return { error: "Thời gian kết thúc phải sau thời gian bắt đầu" };
  }

  return { value: { title, scheduleType, startsAt, endsAt, startDate, endDate, startTime, endTime, isActive } };
}

function validateFlashSaleItemPayload(body) {
  const foodId = Number(body.foodId || body.food_id);
  const salePrice = parsePositiveNumber(body.salePrice ?? body.sale_price, 0);
  const stockLimit = parseNullablePositiveNumber(body.stockLimit ?? body.stock_limit);
  const perUserLimit = parseNullablePositiveNumber(body.perUserLimit ?? body.per_user_limit);
  const sortOrder = parsePositiveNumber(body.sortOrder ?? body.sort_order, 0);
  const isActive = body.isActive === undefined && body.is_active === undefined
    ? true
    : Boolean(Number(body.isActive ?? body.is_active));

  if (!Number.isInteger(foodId) || foodId <= 0) return { error: "Món ăn không hợp lệ" };
  if (salePrice <= 0) return { error: "Giá flash sale phải lớn hơn 0" };

  return { value: { foodId, salePrice, stockLimit, perUserLimit, sortOrder, isActive } };
}

function validateShippingMethodPayload(body) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const fee = parsePositiveNumber(body.fee, 0);
  const estimatedTime = String(body.estimatedTime || body.estimated_time || "").trim();
  const sortOrder = parsePositiveNumber(body.sortOrder ?? body.sort_order, 0);
  const isActive = body.isActive === undefined ? true : Boolean(body.isActive);

  if (!name) return { error: "Vui lòng nhập tên hình thức giao hàng" };
  if (name.length > 120) return { error: "Tên hình thức giao hàng tối đa 120 ký tự" };
  if (description.length > 255) return { error: "Mô tả tối đa 255 ký tự" };
  if (estimatedTime.length > 80) return { error: "Thời gian dự kiến tối đa 80 ký tự" };

  return {
    value: {
      name,
      description: description || null,
      fee,
      estimatedTime: estimatedTime || null,
      sortOrder,
      isActive
    }
  };
}

async function restoreOrderDiscountUsage(connection, order) {
  // Hoàn lượt voucher khi đơn bị hủy.
  // Hàm chạy trong transaction của đơn hàng để user_discounts và discounts không bị lệch số lượng.
  if (order.user_discount_id) {
    await connection.query(
      "UPDATE user_discounts SET used_count = GREATEST(used_count - 1, 0) WHERE id = ? AND user_id = ?",
      [order.user_discount_id, order.user_id]
    );
  }

  if (order.discount_code) {
    await connection.query(
      "UPDATE discounts SET used_count = GREATEST(used_count - 1, 0) WHERE code = ?",
      [order.discount_code]
    );
  }
}

async function restoreOrderFlashSaleUsage(connection, orderId) {
  const [items] = await connection.query(
    `SELECT flash_sale_item_id, quantity
     FROM order_details
     WHERE order_id = ? AND flash_sale_item_id IS NOT NULL`,
    [orderId]
  );

  for (const item of items) {
    await connection.query(
      "UPDATE flash_sale_items SET sold_count = GREATEST(sold_count - ?, 0) WHERE id = ?",
      [Number(item.quantity || 0), item.flash_sale_item_id]
    );
  }
}

function publicManagedUser(user) {
  return {
    id: user.id,
    fullname: user.fullname,
    email: user.email,
    role: user.role,
    permissions: parsePermissions(user.permissions),
    isActive: Boolean(user.is_active),
    emailVerified: Boolean(user.email_verified),
    passwordSet: Boolean(user.password_set ?? true),
    createdAt: user.created_at
  };
}

function inferCategoryType(category) {
  const text = `${category.name || ""} ${category.category_name || ""}`.toLowerCase();
  if (Number(category.id || category.category_id) === 4 || text.includes("uong") || text.includes("tra") || text.includes("ca phe")) {
    return "drink";
  }

  return "food";
}

function canManageStaff(user) {
  return hasPermission(user, PERMISSIONS.STAFF_MANAGE);
}

function canManageUsers(user) {
  return hasPermission(user, PERMISSIONS.USERS_MANAGE);
}

function canManageRoles(user) {
  return hasPermission(user, PERMISSIONS.ROLES_MANAGE);
}

function ensureManageAccess(req, res, targetRole = "USER") {
  const normalizedTargetRole = String(targetRole || "USER").toUpperCase();

  if (normalizedTargetRole === ADMIN_ROLE) {
    return res.status(403).json({ message: "Không được chinh sửa quyền ADMIN qua man hinh này" });
  }

  if (normalizedTargetRole === "USER" && !canManageUsers(req.user)) {
    return res.status(403).json({ message: "Bạn không có quyền quản lý khách hàng" });
  }

  if (normalizedTargetRole !== "USER" && !canManageStaff(req.user)) {
    return res.status(403).json({ message: "Bạn không có quyền quản lý nhân viên" });
  }

  return null;
}

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, username, fullname, email, role, permissions, is_active FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );

    if (users.length === 0 || !users[0].is_active) {
      return res.status(401).json({ message: "Tài khoản không khả dụng" });
    }

    const user = users[0];
    if (String(user.role || "").toUpperCase() === "USER") {
      return res.status(403).json({ message: "Bạn không có quyền quản trị" });
    }

    res.json({
      id: user.id,
      username: user.username,
      fullname: user.fullname,
      email: user.email,
      role: user.role,
      permissions: String(user.role || "").toUpperCase() === ADMIN_ROLE ? ALL_PERMISSIONS : parsePermissions(user.permissions)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/permissions", requirePermission(PERMISSIONS.ROLES_MANAGE), (req, res) => {
  res.json({
    roles: MANAGED_ROLES,
    permissions: [
      { value: PERMISSIONS.ORDERS_MANAGE, label: "Quản lý đơn hàng" },
      { value: PERMISSIONS.FOODS_MANAGE, label: "Quản lý món ăn" },
      { value: PERMISSIONS.USERS_MANAGE, label: "Quản lý khách hàng" },
      { value: PERMISSIONS.STAFF_MANAGE, label: "Quản lý nhân viên" },
      { value: PERMISSIONS.ROLES_MANAGE, label: "Cấp phát quyền" },
      { value: PERMISSIONS.PASSWORD_RESET, label: "Đặt lại mật khẩu theo yêu cầu" },
      { value: PERMISSIONS.ANNOUNCEMENTS_MANAGE, label: "Quản lý thông báo" },
      { value: PERMISSIONS.ADS_MANAGE, label: "Quản lý quảng cáo" },
      { value: PERMISSIONS.DISCOUNTS_MANAGE, label: "Quản lý mã giảm giá" },
      { value: PERMISSIONS.SHIPPING_MANAGE, label: "Quản lý phí vận chuyển" },
      { value: PERMISSIONS.FEEDBACK_MANAGE, label: "Quản lý phản hồi khách hàng" },
      { value: PERMISSIONS.STATS_VIEW, label: "Xem thống kê" }
    ]
  });
});

router.get("/audit-logs", requireAnyPermission([PERMISSIONS.STATS_VIEW, PERMISSIONS.ROLES_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const moduleFilter = String(req.query.module || "all").trim();
    const actionFilter = String(req.query.action || "all").trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 80, 20), 200);
    const where = [];
    const params = [];

    if (search) {
      where.push("(actor_name LIKE ? OR module LIKE ? OR path LIKE ? OR target_id LIKE ?)");
      const keyword = `%${search}%`;
      params.push(keyword, keyword, keyword, keyword);
    }

    if (moduleFilter && moduleFilter !== "all") {
      where.push("module = ?");
      params.push(moduleFilter);
    }

    if (actionFilter && actionFilter !== "all") {
      where.push("action = ?");
      params.push(actionFilter);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await db.query(
      `SELECT id, actor_id, actor_name, actor_role, action, module, target_type, target_id,
              method, path, details, ip_address, user_agent, created_at
       FROM admin_audit_logs
       ${whereSql}
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
      [...params, limit]
    );

    res.json({ logs: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải nhật ký thao tác" });
  }
});

router.get("/announcements", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    const status = String(req.query.status || "all").toLowerCase();
    const where = [];
    const params = [];

    if (search) {
      where.push("(title LIKE ? OR content LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status === "active") {
      where.push("is_active = 1 AND (published_at IS NULL OR published_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW())");
    } else if (status === "hidden") {
      where.push("is_active = 0");
    } else if (status === "expired") {
      where.push("is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()");
    }

    const [announcements] = await db.query(
      `SELECT id, title, content, is_active, published_at, expires_at, created_at, updated_at,
        CASE
          WHEN is_active = 0 THEN 'hidden'
          WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'expired'
          WHEN published_at IS NOT NULL AND published_at > NOW() THEN 'scheduled'
          ELSE 'active'
        END AS status
       FROM announcements
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY id ASC
       LIMIT 200`,
      params
    );

    res.json(announcements);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/announcements/:id", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const announcementId = Number(req.params.id);

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thông báo không hợp lệ" });
    }

    const [announcements] = await db.query(
      `SELECT id, title, content, is_active, published_at, expires_at, created_at, updated_at
       FROM announcements
       WHERE id = ?`,
      [announcementId]
    );

    if (announcements.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy thông báo" });
    }

    res.json(announcements[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/announcements", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const {
      title,
      content = "",
      isActive = true,
      publishedAt = null,
      validityDays = null,
      expiresAt = null
    } = req.body;

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Vui lòng nhập tiêu đề thông báo" });
    }

    const resolvedPublishedAt = publishedAt || null;
    const resolvedExpiresAt = resolveAnnouncementExpiry(resolvedPublishedAt, validityDays, expiresAt);

    const [result] = await db.query(
      `INSERT INTO announcements (title, content, is_active, published_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(title).trim(),
        String(content || "").trim(),
        isActive ? 1 : 0,
        resolvedPublishedAt,
        resolvedExpiresAt
      ]
    );

    res.status(201).json({ message: "Đã tạo thông báo", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tạo thông báo" });
  }
});

router.put("/announcements/:id", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const announcementId = Number(req.params.id);
    const {
      title,
      content = "",
      isActive = true,
      publishedAt = null,
      validityDays = null,
      expiresAt = null
    } = req.body;

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thông báo không hợp lệ" });
    }

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Vui lòng nhập tiêu đề thông báo" });
    }

    const resolvedPublishedAt = publishedAt || null;
    const resolvedExpiresAt = resolveAnnouncementExpiry(resolvedPublishedAt, validityDays, expiresAt);

    const [result] = await db.query(
      `UPDATE announcements
       SET title = ?, content = ?, is_active = ?, published_at = ?, expires_at = ?
       WHERE id = ?`,
      [
        String(title).trim(),
        String(content || "").trim(),
        isActive ? 1 : 0,
        resolvedPublishedAt,
        resolvedExpiresAt,
        announcementId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy thông báo" });
    }

    res.json({ message: "Đã cập nhật thông báo" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể cập nhật thông báo" });
  }
});

router.delete("/announcements/:id", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const announcementId = Number(req.params.id);

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thông báo không hợp lệ" });
    }

    const [result] = await db.query("DELETE FROM announcements WHERE id = ?", [announcementId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy thông báo" });
    }

    res.json({ message: "Đã xóa thông báo" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa thông báo" });
  }
});

router.get("/discounts", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    const status = String(req.query.status || "all").toLowerCase();
    const where = [];
    const params = [];

    if (search) {
      where.push("(code LIKE ? OR name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status === "active") {
      where.push("discounts.is_active = 1 AND (starts_at IS NULL OR starts_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR COALESCE(claim_stats.claimed_count, 0) < usage_limit)");
    } else if (status === "hidden") {
      where.push("discounts.is_active = 0");
    } else if (status === "expired") {
      where.push("discounts.is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()");
    } else if (status === "scheduled") {
      where.push("discounts.is_active = 1 AND starts_at IS NOT NULL AND starts_at > NOW()");
    } else if (status === "soldout") {
      where.push("usage_limit IS NOT NULL AND COALESCE(claim_stats.claimed_count, 0) >= usage_limit");
    }

    const [discounts] = await db.query(
      `SELECT id, code, name, discount_type, discount_value, apply_to, min_order, max_discount,
        usage_limit, used_count, COALESCE(claim_stats.claimed_count, 0) AS claimed_count,
        starts_at, expires_at, is_active, created_at, updated_at,
        CASE
          WHEN discounts.is_active = 0 THEN 'hidden'
          WHEN usage_limit IS NOT NULL AND COALESCE(claim_stats.claimed_count, 0) >= usage_limit THEN 'soldout'
          WHEN starts_at IS NOT NULL AND starts_at > NOW() THEN 'scheduled'
          WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
       FROM discounts
       LEFT JOIN (
         SELECT discount_id, COALESCE(SUM(quantity), 0) AS claimed_count
         FROM user_discounts
         GROUP BY discount_id
       ) claim_stats ON claim_stats.discount_id = discounts.id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY discounts.created_at DESC, discounts.id DESC
       LIMIT 300`,
      params
    );

    res.json(discounts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Mã giảm giá không hợp lệ" });
    }

    const [discounts] = await db.query(
      `SELECT id, code, name, discount_type, discount_value, apply_to, min_order, max_discount,
        usage_limit, used_count, starts_at, expires_at, is_active, created_at, updated_at
       FROM discounts
       WHERE id = ?`,
      [discountId]
    );

    if (discounts.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy mã giảm giá" });
    }

    res.json(discounts[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/discounts", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const parsed = validateDiscountPayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const discount = parsed.value;
    const [result] = await db.query(
      `INSERT INTO discounts
       (code, name, discount_type, discount_value, apply_to, min_order, max_discount, usage_limit, starts_at, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        discount.code,
        discount.name,
        discount.discountType,
        discount.discountValue,
        discount.applyTo,
        discount.minOrder,
        discount.maxDiscount,
        discount.usageLimit,
        discount.startsAt,
        discount.expiresAt,
        discount.isActive ? 1 : 0
      ]
    );

    res.status(201).json({ message: "Đã tạo mã giảm giá", id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Mã giảm giá đã tồn tại" });
    }

    console.error(error);
    res.status(500).json({ message: "Không thể tạo mã giảm giá" });
  }
});

router.put("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Mã giảm giá không hợp lệ" });
    }

    const parsed = validateDiscountPayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const discount = parsed.value;
    const [result] = await db.query(
      `UPDATE discounts
       SET code = ?, name = ?, discount_type = ?, discount_value = ?, apply_to = ?, min_order = ?,
        max_discount = ?, usage_limit = ?, starts_at = ?, expires_at = ?, is_active = ?
       WHERE id = ?`,
      [
        discount.code,
        discount.name,
        discount.discountType,
        discount.discountValue,
        discount.applyTo,
        discount.minOrder,
        discount.maxDiscount,
        discount.usageLimit,
        discount.startsAt,
        discount.expiresAt,
        discount.isActive ? 1 : 0,
        discountId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy mã giảm giá" });
    }

    res.json({ message: "Đã cập nhật mã giảm giá" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Mã giảm giá đã tồn tại" });
    }

    console.error(error);
    res.status(500).json({ message: "Không thể cập nhật mã giảm giá" });
  }
});

router.delete("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Mã giảm giá không hợp lệ" });
    }

    const [result] = await db.query("DELETE FROM discounts WHERE id = ?", [discountId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy mã giảm giá" });
    }

    res.json({ message: "Đã xóa mã giảm giá" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa mã giảm giá" });
  }
});

router.get("/flash-sales", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const [sales] = await db.query(
      `SELECT flash_sales.id, flash_sales.title, flash_sales.schedule_type,
              DATE_FORMAT(flash_sales.starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
              DATE_FORMAT(flash_sales.ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
              DATE_FORMAT(flash_sales.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(flash_sales.end_date, '%Y-%m-%d') AS end_date,
              TIME_FORMAT(flash_sales.start_time, '%H:%i:%s') AS start_time,
              TIME_FORMAT(flash_sales.end_time, '%H:%i:%s') AS end_time,
              flash_sales.is_active, flash_sales.created_at, flash_sales.updated_at,
              COUNT(flash_sale_items.id) AS item_count,
              COALESCE(SUM(flash_sale_items.sold_count), 0) AS sold_count,
              CASE
                WHEN flash_sales.is_active = 0 THEN 'hidden'
                WHEN flash_sales.schedule_type = 'daily'
                  AND flash_sales.start_date IS NOT NULL
                  AND flash_sales.start_date > DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) THEN 'scheduled'
                WHEN flash_sales.schedule_type = 'daily'
                  AND flash_sales.end_date IS NOT NULL
                  AND flash_sales.end_date < DATE(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) THEN 'expired'
                WHEN flash_sales.schedule_type = 'daily'
                  AND flash_sales.start_time IS NOT NULL
                  AND flash_sales.end_time IS NOT NULL
                  AND (
                    (flash_sales.start_time <= flash_sales.end_time AND TIME(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) >= flash_sales.start_time AND TIME(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) < flash_sales.end_time)
                    OR
                    (flash_sales.start_time > flash_sales.end_time AND (TIME(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) >= flash_sales.start_time OR TIME(DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR)) < flash_sales.end_time))
                  ) THEN 'active'
                WHEN flash_sales.schedule_type = 'daily' THEN 'scheduled'
                WHEN flash_sales.starts_at IS NOT NULL AND flash_sales.starts_at > DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR) THEN 'scheduled'
                WHEN flash_sales.ends_at IS NOT NULL AND flash_sales.ends_at <= DATE_ADD(UTC_TIMESTAMP(), INTERVAL 7 HOUR) THEN 'expired'
                ELSE 'active'
              END AS status
       FROM flash_sales
       LEFT JOIN flash_sale_items ON flash_sale_items.flash_sale_id = flash_sales.id
       GROUP BY flash_sales.id
       ORDER BY flash_sales.created_at DESC, flash_sales.id DESC
       LIMIT 300`
    );

    res.json(sales);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải flash sale" });
  }
});

router.get("/flash-sales/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Flash sale không hợp lệ" });
    }

    const [sales] = await db.query(
      `SELECT id, title, schedule_type,
              DATE_FORMAT(starts_at, '%Y-%m-%d %H:%i:%s') AS starts_at,
              DATE_FORMAT(ends_at, '%Y-%m-%d %H:%i:%s') AS ends_at,
              DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
              TIME_FORMAT(start_time, '%H:%i:%s') AS start_time,
              TIME_FORMAT(end_time, '%H:%i:%s') AS end_time,
              is_active, created_at, updated_at
       FROM flash_sales
       WHERE id = ?`,
      [saleId]
    );

    if (sales.length === 0) return res.status(404).json({ message: "Không tìm thấy flash sale" });

    const [items] = await db.query(
      `SELECT flash_sale_items.id, flash_sale_items.food_id, flash_sale_items.sale_price,
              flash_sale_items.stock_limit, flash_sale_items.sold_count, flash_sale_items.per_user_limit,
              flash_sale_items.sort_order, flash_sale_items.is_active,
              foods.name AS food_name, foods.price AS original_price, foods.image
       FROM flash_sale_items
       JOIN foods ON foods.id = flash_sale_items.food_id
       WHERE flash_sale_items.flash_sale_id = ?
       ORDER BY flash_sale_items.sort_order ASC, flash_sale_items.id ASC`,
      [saleId]
    );

    res.json({ ...sales[0], items });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải flash sale" });
  }
});

router.post("/flash-sales", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const parsed = validateFlashSalePayload(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const sale = parsed.value;
    const [result] = await db.query(
      `INSERT INTO flash_sales
       (title, schedule_type, starts_at, ends_at, start_date, end_date, start_time, end_time, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sale.title, sale.scheduleType, sale.startsAt, sale.endsAt, sale.startDate, sale.endDate, sale.startTime, sale.endTime, sale.isActive ? 1 : 0]
    );

    res.status(201).json({ message: "Đã tạo flash sale", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tạo flash sale" });
  }
});

router.put("/flash-sales/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Flash sale không hợp lệ" });
    }

    const parsed = validateFlashSalePayload(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const sale = parsed.value;
    const [result] = await db.query(
      `UPDATE flash_sales
       SET title = ?, schedule_type = ?, starts_at = ?, ends_at = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, is_active = ?
       WHERE id = ?`,
      [sale.title, sale.scheduleType, sale.startsAt, sale.endsAt, sale.startDate, sale.endDate, sale.startTime, sale.endTime, sale.isActive ? 1 : 0, saleId]
    );

    if (result.affectedRows === 0) return res.status(404).json({ message: "Không tìm thấy flash sale" });

    res.json({ message: "Đã cập nhật flash sale" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể cập nhật flash sale" });
  }
});

router.delete("/flash-sales/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Flash sale không hợp lệ" });
    }

    const [result] = await db.query("DELETE FROM flash_sales WHERE id = ?", [saleId]);
    if (result.affectedRows === 0) return res.status(404).json({ message: "Không tìm thấy flash sale" });

    res.json({ message: "Đã xóa flash sale" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa flash sale" });
  }
});

router.post("/flash-sales/:id/items", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const saleId = Number(req.params.id);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({ message: "Flash sale không hợp lệ" });
    }

    const parsed = validateFlashSaleItemPayload(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const item = parsed.value;
    const [foods] = await db.query("SELECT id, price FROM foods WHERE id = ? AND is_active = 1 LIMIT 1", [item.foodId]);
    if (foods.length === 0) return res.status(404).json({ message: "Không tìm thấy món ăn" });
    if (item.salePrice >= Number(foods[0].price || 0)) {
      return res.status(400).json({ message: "Giá flash sale phải nhỏ hơn giá gốc" });
    }

    const [result] = await db.query(
      `INSERT INTO flash_sale_items
       (flash_sale_id, food_id, sale_price, stock_limit, per_user_limit, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         sale_price = VALUES(sale_price),
         stock_limit = VALUES(stock_limit),
         per_user_limit = VALUES(per_user_limit),
         sort_order = VALUES(sort_order),
         is_active = VALUES(is_active)`,
      [saleId, item.foodId, item.salePrice, item.stockLimit, item.perUserLimit, item.sortOrder, item.isActive ? 1 : 0]
    );

    res.status(201).json({ message: "Đã lưu món flash sale", id: result.insertId || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể lưu món flash sale" });
  }
});

router.delete("/flash-sales/:saleId/items/:itemId", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const saleId = Number(req.params.saleId);
    const itemId = Number(req.params.itemId);
    if (!Number.isInteger(saleId) || saleId <= 0 || !Number.isInteger(itemId) || itemId <= 0) {
      return res.status(400).json({ message: "Món flash sale không hợp lệ" });
    }

    const [result] = await db.query(
      "DELETE FROM flash_sale_items WHERE id = ? AND flash_sale_id = ?",
      [itemId, saleId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ message: "Không tìm thấy món flash sale" });

    res.json({ message: "Đã xóa món flash sale" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa món flash sale" });
  }
});

router.get("/shipping-methods", requirePermission(PERMISSIONS.SHIPPING_MANAGE), async (req, res) => {
  try {
    const [methods] = await db.query(
      `SELECT id, name, description, fee, estimated_time, sort_order, is_active, created_at, updated_at
       FROM shipping_methods
       ORDER BY sort_order ASC, fee ASC, id ASC`
    );

    res.json(methods);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải phí vận chuyển" });
  }
});

router.post("/shipping-methods", requirePermission(PERMISSIONS.SHIPPING_MANAGE), async (req, res) => {
  try {
    const parsed = validateShippingMethodPayload(req.body);
    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const method = parsed.value;
    const [result] = await db.query(
      `INSERT INTO shipping_methods (name, description, fee, estimated_time, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [method.name, method.description, method.fee, method.estimatedTime, method.sortOrder, method.isActive ? 1 : 0]
    );

    res.status(201).json({ message: "Đã tạo phí vận chuyển", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tạo phí vận chuyển" });
  }
});

router.put("/shipping-methods/:id", requirePermission(PERMISSIONS.SHIPPING_MANAGE), async (req, res) => {
  try {
    const methodId = Number(req.params.id);
    const parsed = validateShippingMethodPayload(req.body);

    if (!Number.isInteger(methodId) || methodId <= 0) {
      return res.status(400).json({ message: "Mã hình thức giao hàng không hợp lệ" });
    }

    if (parsed.error) return res.status(400).json({ message: parsed.error });

    const method = parsed.value;
    const [result] = await db.query(
      `UPDATE shipping_methods
       SET name = ?, description = ?, fee = ?, estimated_time = ?, sort_order = ?, is_active = ?
       WHERE id = ?`,
      [method.name, method.description, method.fee, method.estimatedTime, method.sortOrder, method.isActive ? 1 : 0, methodId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy hình thức giao hàng" });
    }

    res.json({ message: "Đã cập nhật phí vận chuyển" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể cập nhật phí vận chuyển" });
  }
});

router.delete("/shipping-methods/:id", requirePermission(PERMISSIONS.SHIPPING_MANAGE), async (req, res) => {
  try {
    const methodId = Number(req.params.id);

    if (!Number.isInteger(methodId) || methodId <= 0) {
      return res.status(400).json({ message: "Mã hình thức giao hàng không hợp lệ" });
    }

    await db.query("UPDATE orders SET shipping_method_id = NULL WHERE shipping_method_id = ?", [methodId]);
    const [result] = await db.query("DELETE FROM shipping_methods WHERE id = ?", [methodId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy hình thức giao hàng" });
    }

    res.json({ message: "Đã xóa phí vận chuyển" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa phí vận chuyển" });
  }
});

router.get("/stats", requireAnyPermission([PERMISSIONS.STATS_VIEW, PERMISSIONS.ORDERS_MANAGE]), async (req, res) => {
  // GET /api/admin/stats
  // Tổng hợp doanh thu, số đơn, top món, danh mục và phản hồi cho dashboard quản trị.
  try {
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const trend = ["day", "custom", "month", "quarter", "year"].includes(String(req.query.trend || "").trim())
      ? String(req.query.trend || "").trim()
      : "day";
    const where = [];
    const params = [];
    const revenueTrendConfig = {
      day: {
        label: "DATE(created_at)",
        date: "DATE(created_at)",
        limit: 7
      },
      custom: {
        label: "DATE(created_at)",
        date: "DATE(created_at)",
        limit: 366
      },
      month: {
        label: "DATE_FORMAT(created_at, '%Y-%m')",
        date: "MIN(DATE(created_at))",
        limit: 12
      },
      quarter: {
        label: "CONCAT(YEAR(created_at), '-Q', QUARTER(created_at))",
        date: "MIN(DATE(created_at))",
        limit: 8
      },
      year: {
        label: "DATE_FORMAT(created_at, '%Y')",
        date: "MIN(DATE(created_at))",
        limit: 6
      }
    }[trend];

    if (from) {
      where.push("DATE(created_at) >= ?");
      params.push(from);
    }

    if (to) {
      where.push("DATE(created_at) <= ?");
      params.push(to);
    }

    if (!from && !to) {
      if (trend === "day") {
        where.push("DATE(created_at) >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)");
      } else if (trend === "month") {
        where.push("created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 11 MONTH), '%Y-%m-01')");
      } else if (trend === "quarter") {
        where.push("created_at >= DATE_SUB(CURDATE(), INTERVAL 21 MONTH)");
      } else if (trend === "year") {
        where.push("YEAR(created_at) >= YEAR(CURDATE()) - 5");
      }
    }

    const orderWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const detailConditions = [
      "orders.status = 'done'",
      ...where.map(condition => condition.replace("created_at", "orders.created_at"))
    ];
    const detailWhere = `WHERE ${detailConditions.join(" AND ")}`;
    const customerOrderJoin = where.length
      ? `AND ${where.map(condition => condition.replace("created_at", "orders.created_at")).join(" AND ")}`
      : "";

    const [orderRows] = await db.query(
      `SELECT
        COUNT(*) AS total_orders,
        COALESCE(SUM(CASE WHEN status = 'done' THEN total_price ELSE 0 END), 0) AS revenue,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_orders,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done_orders,
        COALESCE(SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders
       FROM orders
       ${orderWhere}`,
      params
    );

    const [userRows] = await db.query(
      `SELECT
        COUNT(*) AS total_users,
        COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active_users,
        COALESCE(SUM(CASE WHEN UPPER(COALESCE(role, 'USER')) = 'USER' AND last_seen_at >= NOW() - INTERVAL 5 MINUTE THEN 1 ELSE 0 END), 0) AS online_users,
        COALESCE(SUM(CASE WHEN UPPER(COALESCE(role, 'USER')) = 'USER' THEN 1 ELSE 0 END), 0) AS customers,
        COALESCE(SUM(CASE WHEN UPPER(COALESCE(role, 'USER')) <> 'USER' THEN 1 ELSE 0 END), 0) AS staff
       FROM users`
    );

    const [foodRows] = await db.query(
      `SELECT
        COUNT(*) AS total_foods,
        COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active_foods
       FROM foods`
    );

    const [discountRows] = await db.query(
      `SELECT
        COUNT(*) AS total_discounts,
        COALESCE(SUM(CASE WHEN is_active = 1 AND (starts_at IS NULL OR starts_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR COALESCE(claim_stats.claimed_count, 0) < usage_limit) THEN 1 ELSE 0 END), 0) AS active_discounts
       FROM discounts
       LEFT JOIN (
         SELECT discount_id, COALESCE(SUM(quantity), 0) AS claimed_count
         FROM user_discounts
         GROUP BY discount_id
       ) claim_stats ON claim_stats.discount_id = discounts.id`
    );

    const [topFoods] = await db.query(
      `SELECT order_details.food_name, SUM(order_details.quantity) AS quantity,
        SUM(order_details.subtotal) AS revenue
       FROM order_details
       JOIN orders ON orders.id = order_details.order_id
       ${detailWhere}
       GROUP BY order_details.food_name
       ORDER BY quantity DESC, revenue DESC
       LIMIT 5`,
      params
    );

    const [dailyRevenue] = await db.query(
      `SELECT ${revenueTrendConfig.label} AS order_label,
        ${revenueTrendConfig.date} AS order_date,
        COUNT(*) AS orders_count,
        COALESCE(SUM(CASE WHEN status = 'done' THEN total_price ELSE 0 END), 0) AS revenue
       FROM orders
       ${orderWhere}
       GROUP BY ${revenueTrendConfig.label}
       ORDER BY order_label DESC
       LIMIT ${revenueTrendConfig.limit}`,
      params
    );

    const [categorySales] = await db.query(
      `SELECT COALESCE(parent_categories.name, categories.name, 'Chưa phân loại') AS category_name,
        SUM(order_details.quantity) AS quantity,
        SUM(order_details.subtotal) AS revenue
       FROM order_details
       JOIN orders ON orders.id = order_details.order_id
       LEFT JOIN foods ON foods.id = order_details.food_id
       LEFT JOIN categories ON categories.id = foods.category_id
       LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
       ${detailWhere}
       GROUP BY COALESCE(parent_categories.name, categories.name, 'Chưa phân loại')
       ORDER BY quantity DESC, revenue DESC
       LIMIT 6`,
      params
    );

    const [customerStats] = await db.query(
      `SELECT users.id,
              COALESCE(users.fullname, users.username, users.email, 'Khách hàng') AS customer_name,
              users.email,
              COUNT(orders.id) AS total_orders,
              COALESCE(SUM(CASE WHEN orders.status = 'done' THEN 1 ELSE 0 END), 0) AS done_orders,
              COALESCE(SUM(CASE WHEN orders.status = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_orders,
              COALESCE(SUM(CASE WHEN orders.status = 'done' THEN orders.total_price ELSE 0 END), 0) AS revenue,
              MAX(orders.created_at) AS last_order_at
       FROM users
       LEFT JOIN orders ON orders.user_id = users.id ${customerOrderJoin}
       WHERE UPPER(COALESCE(users.role, 'USER')) = 'USER'
       GROUP BY users.id, users.fullname, users.username, users.email
       ORDER BY revenue DESC, total_orders DESC, last_order_at DESC, users.created_at DESC
       LIMIT 20`,
      params
    );

    const [feedbackRows] = await db.query(
      `SELECT COUNT(*) AS total_feedback,
        COALESCE(AVG(rating), 0) AS average_rating
       FROM customer_feedback`
    );

    res.json({
      summary: {
        ...orderRows[0],
        ...userRows[0],
        ...foodRows[0],
        ...discountRows[0]
      },
      trend,
      topFoods,
      dailyRevenue,
      categorySales,
      customerStats,
      feedback: feedbackRows[0] || { total_feedback: 0, average_rating: 0 }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải thống kê" });
  }
});

router.get("/orders", requirePermission(PERMISSIONS.ORDERS_MANAGE), async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, shipping_fee, shipping_method_id, shipping_method_name, discount_code, discount_amount, total_price, payment_method, payment_status, status, created_at
       FROM orders
       ORDER BY created_at DESC`
    );

    if (orders.length === 0) {
      return res.json([]);
    }

    const orderIds = orders.map(order => order.id);
    const placeholders = orderIds.map(() => "?").join(",");
    const [items] = await db.query(
      `SELECT order_id, food_id, food_name, price, quantity, subtotal
       FROM order_details
       WHERE order_id IN (${placeholders})
       ORDER BY id ASC`,
      orderIds
    );

    const itemsByOrder = items.reduce((map, item) => {
      if (!map[item.order_id]) {
        map[item.order_id] = [];
      }

      map[item.order_id].push(item);
      return map;
    }, {});

    res.json(orders.map(order => ({
      ...order,
      items: itemsByOrder[order.id] || []
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/orders/:id/status", requirePermission(PERMISSIONS.ORDERS_MANAGE), async (req, res) => {
  // PATCH /api/admin/orders/:id/status
  // Admin cập nhật trạng thái đơn; khi hủy đơn hệ thống hoàn lại voucher đã dùng.
  const connection = await db.getConnection();

  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;
    const allowedStatuses = ["pending_payment", "pending", "confirmed", "delivering", "done", "cancelled"];

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Mã đơn hàng không hợp lệ" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Trạng thái không hợp lệ" });
    }

    await connection.beginTransaction();

    const [orders] = await connection.query(
      `SELECT id, user_id, status, payment_method, payment_status, discount_code, user_discount_id
       FROM orders
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [orderId]
    );

    if (orders.length === 0) {
      await connection.rollback();
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    const order = orders[0];
    let nextPaymentStatus = null;

    if (status === "done" && order.payment_method === "cod" && order.payment_status !== "paid") {
      nextPaymentStatus = "paid";
    } else if (
      status === "cancelled"
      && !["paid", "refunded", "cancelled"].includes(order.payment_status)
    ) {
      nextPaymentStatus = "cancelled";
    }

    if (nextPaymentStatus) {
      await connection.query(
        "UPDATE orders SET status = ?, payment_status = ? WHERE id = ?",
        [status, nextPaymentStatus, orderId]
      );
    } else {
      await connection.query("UPDATE orders SET status = ? WHERE id = ?", [status, orderId]);
    }

    if (status === "cancelled" && order.status !== "cancelled") {
      const [items] = await connection.query(
        "SELECT food_id, quantity FROM order_details WHERE order_id = ?",
        [orderId]
      );

      for (const item of items) {
        const [foods] = await connection.query(
          "SELECT id, name, stock_quantity FROM foods WHERE id = ? LIMIT 1 FOR UPDATE",
          [item.food_id]
        );
        const food = foods[0] || {};
        const oldStock = Number(food.stock_quantity || 0);
        const newStock = oldStock + Number(item.quantity || 0);
        await connection.query(
          "UPDATE foods SET stock_quantity = stock_quantity + ? WHERE id = ?",
          [item.quantity, item.food_id]
        );
        await connection.query(
          `INSERT INTO stock_movements
            (food_id, food_name, movement_type, quantity, stock_before, stock_after, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'RETURN', ?, ?, ?, 'order_cancel', ?, ?, ?)`,
          [item.food_id, food.name || null, Number(item.quantity || 0), oldStock, newStock, orderId, `Hoan kho do admin huy don #${orderId}`, req.user?.id || null]
        );
      }
      await restoreOrderDiscountUsage(connection, order);
      await restoreOrderFlashSaleUsage(connection, orderId);
    }

    await connection.commit();
    req.app.get("emitOrderEvent")?.("order:updated", {
      order: {
        id: orderId,
        userId: order.user_id,
        status,
        paymentStatus: nextPaymentStatus || order.payment_status,
        updatedAt: new Date().toISOString()
      }
    });
    res.json({ message: "Cập nhật trạng thái thành công" });
  } catch (error) {
    await connection.rollback();
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  } finally {
    connection.release();
  }
});
router.patch("/orders/:id/payment", requirePermission(PERMISSIONS.ORDERS_MANAGE), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { paymentStatus } = req.body;
    const allowedStatuses = ["unpaid", "pending", "paid", "failed", "cancelled", "expired", "refunded"];

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Mã đơn hàng không hợp lệ" });
    }

    if (!allowedStatuses.includes(paymentStatus)) {
      return res.status(400).json({ message: "Trạng thái thanh toán không hợp lệ" });
    }

    const nextOrderStatus = paymentStatus === "paid" ? "pending" : undefined;
    const [result] = await db.query(
      nextOrderStatus
        ? "UPDATE orders SET payment_status = ?, status = ? WHERE id = ?"
        : "UPDATE orders SET payment_status = ? WHERE id = ?",
      nextOrderStatus ? [paymentStatus, nextOrderStatus, orderId] : [paymentStatus, orderId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy đơn hàng" });
    }

    if (paymentStatus === "paid") {
      await db.query("UPDATE payment_sessions SET status = 'paid', paid_at = NOW() WHERE order_id = ?", [orderId]);
    }

    const [[updatedOrder]] = await db.query(
      "SELECT id, user_id, status, payment_status FROM orders WHERE id = ? LIMIT 1",
      [orderId]
    );

    req.app.get("emitOrderEvent")?.("order:updated", {
      order: {
        id: orderId,
        userId: updatedOrder?.user_id,
        status: updatedOrder?.status || nextOrderStatus,
        paymentStatus: updatedOrder?.payment_status || paymentStatus,
        updatedAt: new Date().toISOString()
      }
    });

    res.json({ message: "Cập nhật thanh toán thành công" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/categories", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    let categories;
    const includeInactive = req.query.includeInactive === "1" || req.query.includeInactive === "true";

    try {
      [categories] = await db.query(
        `SELECT categories.id,
                categories.name,
                categories.slug,
                categories.type,
                categories.parent_id AS parentId,
                categories.sort_order AS sortOrder,
                categories.is_active AS isActive,
                parent_categories.name AS parentName,
                parent_categories.slug AS parentSlug
         FROM categories
         LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
         ${includeInactive ? "" : "WHERE categories.is_active = 1"}
         ORDER BY COALESCE(parent_categories.sort_order, categories.sort_order) ASC,
                  categories.parent_id IS NOT NULL ASC,
                  categories.sort_order ASC,
                  categories.name ASC`
      );
    } catch (error) {
      const [oldCategories] = await db.query(
        `SELECT id, name
         FROM categories
         ORDER BY id ASC`
      );

      categories = oldCategories.map(category => ({
        ...category,
        slug: null,
        type: inferCategoryType(category),
        parentId: null,
        sortOrder: category.id,
        isActive: true,
        parentName: null,
        parentSlug: null
      }));
    }

    res.json(categories);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/categories", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    const sortOrder = parsePositiveNumber(req.body.sortOrder, 0);
    const isActive = req.body.isActive === false || req.body.isActive === 0 || req.body.isActive === "0" ? 0 : 1;

    if (!name) {
      return res.status(400).json({ message: "Vui lòng nhập ten danh mục" });
    }

    const slug = await createUniqueCategorySlug(name);
    const type = await resolveCategoryType(parentId, slug);

    if (!type) {
      return res.status(400).json({ message: "Danh mục cha không hợp lệ" });
    }

    const [result] = await db.query(
      `INSERT INTO categories (name, slug, type, parent_id, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, slug, type, parentId, sortOrder, isActive]
    );

    res.status(201).json({ message: "Thêm danh mục thành công", id: result.insertId, slug });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/categories/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const categoryId = Number(req.params.id);
    const name = String(req.body.name || "").trim();
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    const sortOrder = parsePositiveNumber(req.body.sortOrder, 0);
    const isActive = req.body.isActive === false || req.body.isActive === 0 || req.body.isActive === "0" ? 0 : 1;

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ message: "Ma danh mục không hợp lệ" });
    }

    if (!name) {
      return res.status(400).json({ message: "Vui lòng nhập ten danh mục" });
    }

    if (parentId === categoryId) {
      return res.status(400).json({ message: "Danh mục cha không được trung voi danh mục hiện tại" });
    }

    const slug = await createUniqueCategorySlug(name, categoryId);
    const type = await resolveCategoryType(parentId, slug);

    if (!type) {
      return res.status(400).json({ message: "Danh mục cha không hợp lệ" });
    }

    const [result] = await db.query(
      `UPDATE categories
       SET name = ?, slug = ?, type = ?, parent_id = ?, sort_order = ?, is_active = ?
       WHERE id = ?`,
      [name, slug, type, parentId, sortOrder, isActive, categoryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json({ message: "Cập nhật danh mục thành công", slug });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/categories/:id/visibility", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const categoryId = Number(req.params.id);
    const isActive = req.body.isActive === true || req.body.isActive === 1 || req.body.isActive === "1" ? 1 : 0;

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ message: "Mã danh mục không hợp lệ" });
    }

    const [result] = await db.query(
      "UPDATE categories SET is_active = ? WHERE id = ? OR parent_id = ?",
      [isActive, categoryId, categoryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json({ message: isActive ? "Đã hiện danh mục" : "Đã ẩn danh mục" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.delete("/categories/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const categoryId = Number(req.params.id);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ message: "Mã danh mục không hợp lệ" });
    }

    const [result] = await db.query(
      "DELETE FROM categories WHERE id = ?",
      [categoryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy danh mục" });
    }

    res.json({ message: "Đã xóa danh mục" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED") {
      return res.status(409).json({
        message: "Danh mục này đang có danh mục con hoặc món ăn nên không thể xóa vĩnh viễn. Hãy chuyển hoặc xóa dữ liệu liên quan trước."
      });
    }
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/inventory/overview", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const [foods] = await db.query(
      `SELECT foods.id,
              foods.name,
              foods.stock_quantity,
              foods.is_active,
              categories.name AS category_name,
              COALESCE(imports.total_in, 0) AS total_in,
              COALESCE(exports.total_out, 0) AS total_out
       FROM foods
       LEFT JOIN categories ON categories.id = foods.category_id
       LEFT JOIN (
         SELECT food_id, SUM(quantity_added) AS total_in
         FROM stock_import_details
         WHERE status = 'success'
         GROUP BY food_id
       ) imports ON imports.food_id = foods.id
       LEFT JOIN (
         SELECT food_id, SUM(quantity) AS total_out
         FROM order_details
         JOIN orders ON orders.id = order_details.order_id
         WHERE orders.status <> 'cancelled'
           AND orders.payment_status NOT IN ('failed', 'cancelled')
         GROUP BY food_id
       ) exports ON exports.food_id = foods.id
       ORDER BY foods.stock_quantity ASC, foods.name ASC`
    );
    const summary = foods.reduce((acc, food) => {
      acc.totalFoods += 1;
      acc.totalStock += Number(food.stock_quantity || 0);
      acc.totalIn += Number(food.total_in || 0);
      acc.totalOut += Number(food.total_out || 0);
      if (Number(food.stock_quantity || 0) <= 0) acc.outOfStock += 1;
      if (Number(food.stock_quantity || 0) > 0 && Number(food.stock_quantity || 0) <= 10) acc.lowStock += 1;
      return acc;
    }, { totalFoods: 0, totalStock: 0, totalIn: 0, totalOut: 0, outOfStock: 0, lowStock: 0 });

    res.json({ summary, foods });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải tổng quan kho" });
  }
});

router.get("/inventory/imports", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const { where, params } = getDateRange(req.query);
    const sqlWhere = where.length ? `WHERE ${where.map(item => item.replace("created_at", "stock_imports.created_at")).join(" AND ")}` : "";
    const [imports] = await db.query(
      `SELECT stock_imports.*,
              users.fullname AS importer_name,
              users.email AS importer_email,
              COALESCE(SUM(CASE WHEN stock_import_details.status = 'success' THEN stock_import_details.quantity_added ELSE 0 END), 0) AS total_quantity
       FROM stock_imports
       LEFT JOIN users ON users.id = stock_imports.imported_by
       LEFT JOIN stock_import_details ON stock_import_details.import_id = stock_imports.id
       ${sqlWhere}
       GROUP BY stock_imports.id
       ORDER BY stock_imports.created_at DESC, stock_imports.id DESC
       LIMIT 100`,
      params
    );
    res.json(imports);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải lịch sử nhập kho" });
  }
});

router.get("/inventory/imports/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const importId = Number(req.params.id);
    if (!Number.isInteger(importId) || importId <= 0) {
      return res.status(400).json({ message: "Mã phiếu nhập không hợp lệ" });
    }

    const [imports] = await db.query(
      `SELECT stock_imports.*, users.fullname AS importer_name, users.email AS importer_email
       FROM stock_imports
       LEFT JOIN users ON users.id = stock_imports.imported_by
       WHERE stock_imports.id = ?
       LIMIT 1`,
      [importId]
    );
    if (imports.length === 0) return res.status(404).json({ message: "Không tìm thấy phiếu nhập" });

    const [details] = await db.query(
      `SELECT stock_import_details.*,
              foods.category_id,
              categories.name AS category_name
       FROM stock_import_details
       LEFT JOIN foods ON foods.id = stock_import_details.food_id
       LEFT JOIN categories ON categories.id = foods.category_id
       WHERE stock_import_details.import_id = ?
       ORDER BY stock_import_details.id ASC`,
      [importId]
    );
    res.json({ import: imports[0], details });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải chi tiết phiếu nhập" });
  }
});

router.get("/inventory/imports/:id/export", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const importId = Number(req.params.id);
    const [details] = await db.query(
      `SELECT food_id AS ma_mon,
              COALESCE(food_name, input_name) AS ten_mon,
              quantity_added AS so_luong_nhap,
              old_stock AS so_luong_truoc,
              new_stock AS so_luong_sau,
              status AS trang_thai,
              error_message AS loi
       FROM stock_import_details
       WHERE import_id = ?
       ORDER BY id ASC`,
      [importId]
    );
    sendWorkbook(res, `phieu-nhap-kho-${importId}.xlsx`, details, "Phieu nhap");
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xuất phiếu nhập" });
  }
});

router.get("/inventory/exports", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const { where, params } = getDateRange(req.query);
    const sqlWhere = where.length ? `AND ${where.map(item => item.replace("created_at", "orders.created_at")).join(" AND ")}` : "";
    const [orders] = await db.query(
      `SELECT orders.id,
              orders.customer_name,
              orders.status,
              orders.payment_status,
              orders.created_at,
              COUNT(order_details.id) AS total_items,
              COALESCE(SUM(order_details.quantity), 0) AS total_quantity,
              COALESCE(SUM(order_details.subtotal), 0) AS revenue
       FROM orders
       JOIN order_details ON order_details.order_id = orders.id
       WHERE orders.status <> 'cancelled'
         AND orders.payment_status NOT IN ('failed', 'cancelled')
         ${sqlWhere}
       GROUP BY orders.id
       ORDER BY orders.created_at DESC, orders.id DESC
       LIMIT 100`,
      params
    );
    res.json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải lịch sử xuất kho" });
  }
});

router.get("/inventory/exports/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Mã phiếu xuất không hợp lệ" });
    }

    const [orders] = await db.query("SELECT * FROM orders WHERE id = ? LIMIT 1", [orderId]);
    if (orders.length === 0) return res.status(404).json({ message: "Không tìm thấy đơn xuất kho" });
    const [details] = await db.query(
      `SELECT order_details.food_id,
              order_details.food_name,
              order_details.quantity,
              order_details.price,
              order_details.subtotal,
              movements.stock_before,
              movements.stock_after,
              movements.created_at AS exported_at
       FROM order_details
       LEFT JOIN stock_movements movements
         ON movements.reference_type = 'order'
        AND movements.reference_id = order_details.order_id
        AND movements.food_id = order_details.food_id
        AND movements.movement_type = 'OUT'
       WHERE order_details.order_id = ?
       ORDER BY order_details.id ASC`,
      [orderId]
    );
    res.json({ order: orders[0], details });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tải chi tiết xuất kho" });
  }
});

router.get("/inventory/exports/:id/export", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const [details] = await db.query(
      `SELECT order_details.food_id AS ma_mon,
              order_details.food_name AS ten_mon,
              order_details.quantity AS so_luong_ban,
              movements.stock_before AS ton_truoc,
              movements.stock_after AS ton_sau,
              order_details.price AS don_gia,
              order_details.subtotal AS thanh_tien
       FROM order_details
       LEFT JOIN stock_movements movements
         ON movements.reference_type = 'order'
        AND movements.reference_id = order_details.order_id
        AND movements.food_id = order_details.food_id
        AND movements.movement_type = 'OUT'
       WHERE order_details.order_id = ?
       ORDER BY order_details.id ASC`,
      [orderId]
    );
    sendWorkbook(res, `phieu-xuat-kho-${orderId}.xlsx`, details, "Phieu xuat");
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xuất phiếu xuất" });
  }
});

router.get("/foods/stock-import-template", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const [foods] = await db.query(
      `SELECT foods.id,
              foods.name,
              foods.stock_quantity,
              foods.is_active,
              categories.name AS category_name,
              parent_categories.name AS parent_category_name
       FROM foods
       LEFT JOIN categories ON categories.id = foods.category_id
       LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
       ORDER BY foods.name ASC, foods.id ASC`
    );

    const rows = foods.map(food => ({
      ma_mon: food.id,
      ten_mon: food.name,
      danh_muc: food.parent_category_name
        ? `${food.parent_category_name} / ${food.category_name || ""}`
        : food.category_name || "",
      so_luong_hien_tai: Number(food.stock_quantity || 0),
      so_luong_nhap: "",
      trang_thai: Number(food.is_active) ? "Dang ban" : "Da an"
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows, {
      header: ["ma_mon", "ten_mon", "danh_muc", "so_luong_hien_tai", "so_luong_nhap", "trang_thai"]
    });
    worksheet["!cols"] = [
      { wch: 10 },
      { wch: 32 },
      { wch: 28 },
      { wch: 18 },
      { wch: 16 },
      { wch: 14 }
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Nhap so luong");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", "attachment; filename=\"mau-nhap-so-luong-mon.xlsx\"");
    res.send(buffer);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the xuat file mau nhap so luong" });
  }
});

router.get("/foods/stock-imports", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 1), 50);
    const [imports] = await db.query(
      `SELECT stock_imports.*,
              users.fullname AS importer_name,
              users.email AS importer_email
       FROM stock_imports
       LEFT JOIN users ON users.id = stock_imports.imported_by
       ORDER BY stock_imports.created_at DESC, stock_imports.id DESC
       LIMIT ?`,
      [limit]
    );

    if (imports.length === 0) {
      return res.json([]);
    }

    const placeholders = imports.map(() => "?").join(",");
    const [details] = await db.query(
      `SELECT *
       FROM stock_import_details
       WHERE import_id IN (${placeholders})
       ORDER BY id ASC`,
      imports.map(item => item.id)
    );
    const detailsByImport = new Map();

    details.forEach(detail => {
      const importId = Number(detail.import_id);
      if (!detailsByImport.has(importId)) detailsByImport.set(importId, []);
      detailsByImport.get(importId).push(detail);
    });

    res.json(imports.map(item => ({
      ...item,
      details: detailsByImport.get(Number(item.id)) || []
    })));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/foods/stock-imports", requirePermission(PERMISSIONS.FOODS_MANAGE), (req, res) => {
  stockImportUpload.single("file")(req, res, async error => {
    if (error) {
      const isSizeError = error.code === "LIMIT_FILE_SIZE";
      return res.status(isSizeError ? 413 : 400).json({
        message: isSizeError ? "File qua lon. Vui long chon file nho hon 2MB." : error.message || "Khong the doc file"
      });
    }

    const connection = await db.getConnection();

    try {
      if (!req.file) {
        return res.status(400).json({ message: "Vui long chon file Excel .xlsx hoac CSV" });
      }

      const rows = parseStockImportFile(req.file);
      if (rows.length === 0) {
        return res.status(400).json({ message: "File chua co dong du lieu de nhap" });
      }

      await fs.promises.mkdir(STOCK_IMPORT_UPLOAD_DIR, { recursive: true });
      const importExtension = String(req.file.originalname || "").toLowerCase().endsWith(".xlsx") ? "xlsx" : "csv";
      const storedFileName = `stock-import-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${importExtension}`;
      await fs.promises.writeFile(path.join(STOCK_IMPORT_UPLOAD_DIR, storedFileName), req.file.buffer);

      await connection.beginTransaction();

      const today = new Date().toISOString().slice(0, 10);
      const [importResult] = await connection.query(
        `INSERT INTO stock_imports (file_name, stored_file_name, imported_by, import_date, total_rows, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          req.file.originalname || storedFileName,
          storedFileName,
          req.user?.id || null,
          req.body.importDate || today,
          rows.length,
          String(req.body.note || "").trim() || null
        ]
      );
      const importId = importResult.insertId;

      const [foods] = await connection.query("SELECT id, name, stock_quantity FROM foods");
      const foodsById = new Map(foods.map(food => [Number(food.id), food]));
      const foodsByName = new Map();
      foods.forEach(food => {
        const key = normalizeFoodLookupName(food.name);
        if (!foodsByName.has(key)) foodsByName.set(key, food);
      });

      const details = [];
      let successRows = 0;
      let failedRows = 0;

      for (const row of rows) {
        const inputName = String(row.inputName || "").trim();
        const quantity = Number(row.quantity);
        const hasFoodId = Number.isInteger(row.foodId) && row.foodId > 0;
        const food = hasFoodId
          ? foodsById.get(Number(row.foodId))
          : foodsByName.get(normalizeFoodLookupName(inputName));

        if (!Number.isInteger(quantity) || quantity <= 0) {
          if (!row.rawQuantity && row.rawQuantity !== 0) {
            continue;
          }
          failedRows += 1;
          details.push([importId, null, null, inputName, 0, null, null, "failed", `Dong ${row.rowNumber}: so_luong_nhap khong hop le`]);
          continue;
        }

        if (!hasFoodId && !inputName) {
          failedRows += 1;
          details.push([importId, null, null, inputName, 0, null, null, "failed", `Dong ${row.rowNumber}: thieu ma_mon hoac ten_mon`]);
          continue;
        }

        if (!food) {
          failedRows += 1;
          details.push([importId, null, null, inputName || `#${row.foodId}`, quantity, null, null, "failed", `Dong ${row.rowNumber}: khong tim thay mon`]);
          continue;
        }

        const oldStock = Number(food.stock_quantity || 0);
        const newStock = oldStock + quantity;
        await connection.query(
          "UPDATE foods SET stock_quantity = stock_quantity + ? WHERE id = ?",
          [quantity, food.id]
        );
        await connection.query(
          `INSERT INTO stock_movements
            (food_id, food_name, movement_type, quantity, stock_before, stock_after, reference_type, reference_id, note, created_by)
           VALUES (?, ?, 'IN', ?, ?, ?, 'import', ?, ?, ?)`,
          [food.id, food.name, quantity, oldStock, newStock, importId, `Nhap kho tu file ${req.file.originalname || storedFileName}`, req.user?.id || null]
        );
        food.stock_quantity = newStock;
        successRows += 1;
        details.push([importId, food.id, food.name, inputName, quantity, oldStock, newStock, "success", null]);
      }

      if (details.length > 0) {
        await connection.query(
          `INSERT INTO stock_import_details
            (import_id, food_id, food_name, input_name, quantity_added, old_stock, new_stock, status, error_message)
           VALUES ?`,
          [details]
        );
      }

      await connection.query(
        `UPDATE stock_imports
         SET success_rows = ?, failed_rows = ?
         WHERE id = ?`,
        [successRows, failedRows, importId]
      );

      await connection.commit();

      res.status(201).json({
        message: "Da nhap so luong mon",
        importId,
        totalRows: rows.length,
        successRows,
        failedRows,
        details: details.map(item => ({
          foodId: item[1],
          foodName: item[2],
          inputName: item[3],
          quantityAdded: item[4],
          oldStock: item[5],
          newStock: item[6],
          status: item[7],
          errorMessage: item[8]
        }))
      });
    } catch (importError) {
      await connection.rollback().catch(() => {});
      console.error(importError);
      const isBadCsv = /CSV|ten_mon|so_luong_nhap|dong du lieu/i.test(importError.message || "");
      res.status(isBadCsv ? 400 : 500).json({ message: importError.message || "Khong the nhap so luong mon" });
    } finally {
      connection.release();
    }
  });
});

router.get("/foods", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    let foods;

    try {
      [foods] = await db.query(
        `SELECT foods.*,
                categories.name AS category_name,
                categories.slug AS category_slug,
                categories.type AS category_type,
                categories.parent_id AS parent_category_id,
                parent_categories.name AS parent_category_name,
                parent_categories.slug AS parent_category_slug
         FROM foods
         LEFT JOIN categories ON categories.id = foods.category_id
         LEFT JOIN categories AS parent_categories ON parent_categories.id = categories.parent_id
         ORDER BY foods.created_at DESC, foods.id DESC`
      );
    } catch (error) {
      const [oldFoods] = await db.query(
        `SELECT foods.*, categories.name AS category_name
         FROM foods
         LEFT JOIN categories ON categories.id = foods.category_id
         ORDER BY foods.created_at DESC, foods.id DESC`
      );

      foods = oldFoods.map(food => ({
        ...food,
        category_type: inferCategoryType(food),
        parent_category_id: null,
        parent_category_name: null,
        parent_category_slug: null
      }));
    }

    res.json(foods);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/foods/image", requirePermission(PERMISSIONS.FOODS_MANAGE), (req, res) => {
  foodImageUpload.single("image")(req, res, async error => {
    if (error) {
      const isSizeError = error.code === "LIMIT_FILE_SIZE";
      return res.status(isSizeError ? 413 : 400).json({
        message: isSizeError
          ? "Ảnh món ăn quá lớn. Vui lòng chọn ảnh nhỏ hơn 2MB."
          : error.message || "Không thể tải ảnh món ăn"
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: "Vui lòng chọn ảnh món ăn" });
      }

      const imageUrl = await saveFoodImageFile(req, req.file);
      return res.json({
        message: "Đã tải ảnh món ăn",
        image: imageUrl
      });
    } catch (uploadError) {
      console.error(uploadError);
      return res.status(500).json({ message: "Không thể lưu ảnh món ăn" });
    }
  });
});

router.post("/foods", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  // POST /api/admin/foods
  // Tạo món mới từ màn hình quản trị. Dữ liệu này được menu, chatbot và thống kê sử dụng làm nguồn chính.
  try {
    const { name, categoryId, price, stockQuantity, description = "", image = "", isActive = 1 } = req.body;
    const normalizedImage = String(image || "").trim();

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui lòng nhập ten mon, danh mục va gia" });
    }

    if (normalizedImage && !/^https?:\/\//i.test(normalizedImage)) {
      return res.status(400).json({ message: "Ảnh món ăn không hợp lệ. Vui lòng tải ảnh lên hệ thống trước." });
    }

    const normalizedStock = Math.max(0, parsePositiveNumber(stockQuantity, 0));

    const [result] = await db.query(
      `INSERT INTO foods (name, category_id, price, stock_quantity, description, image, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name.trim(), Number(categoryId), Number(price), normalizedStock, description.trim(), normalizedImage, Number(isActive)]
    );

    res.status(201).json({ message: "Thêm mon thành công", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/foods/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const foodId = Number(req.params.id);
    const { name, categoryId, price, stockQuantity, description = "", image = "", isActive = 1 } = req.body;
    const normalizedImage = String(image || "").trim();

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Ma mon không hợp lệ" });
    }

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui lòng nhập ten mon, danh mục va gia" });
    }

    if (normalizedImage && !/^https?:\/\//i.test(normalizedImage)) {
      return res.status(400).json({ message: "Ảnh món ăn không hợp lệ. Vui lòng tải ảnh lên hệ thống trước." });
    }

    const normalizedStock = Math.max(0, parsePositiveNumber(stockQuantity, 0));

    const [result] = await db.query(
      `UPDATE foods
       SET name = ?, category_id = ?, price = ?, stock_quantity = ?, description = ?, image = ?, is_active = ?
       WHERE id = ?`,
      [
        name.trim(),
        Number(categoryId),
        Number(price),
        normalizedStock,
        description.trim(),
        normalizedImage,
        Number(isActive),
        foodId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy món ăn" });
    }

    res.json({ message: "Cập nhật mon thành công" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/foods/:id/visibility", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const foodId = Number(req.params.id);
    const isActive = req.body.isActive === true || req.body.isActive === 1 || req.body.isActive === "1" ? 1 : 0;

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Mã món không hợp lệ" });
    }

    const [result] = await db.query(
      "UPDATE foods SET is_active = ? WHERE id = ?",
      [isActive, foodId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy món ăn" });
    }

    res.json({ message: isActive ? "Đã hiện món trên thực đơn" : "Đã ẩn món khỏi thực đơn" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.delete("/foods/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const foodId = Number(req.params.id);

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Mã món không hợp lệ" });
    }

    const [result] = await db.query(
      "DELETE FROM foods WHERE id = ?",
      [foodId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy món ăn" });
    }

    res.json({ message: "Đã xóa món ăn" });
  } catch (error) {
    console.error(error);
    if (error.code === "ER_ROW_IS_REFERENCED_2" || error.code === "ER_ROW_IS_REFERENCED") {
      return res.status(409).json({
        message: "Món này đã phát sinh đơn hàng nên không thể xóa vĩnh viễn. Hãy dùng nút Ẩn món."
      });
    }
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/users", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const type = String(req.query.type || "all").toLowerCase();
    const search = String(req.query.q || "").trim();
    const params = [];
    const where = [];

    if (type === "staff") {
      where.push(String(req.user.role || "").toUpperCase() === ADMIN_ROLE ? "role <> 'USER'" : "role <> 'USER' AND role <> 'ADMIN'");
    } else if (type === "customers") {
      where.push("role = 'USER'");
    }

    if (search) {
      where.push("(fullname LIKE ? OR email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (!canManageUsers(req.user)) {
      where.push("role <> 'USER' AND role <> 'ADMIN'");
    } else if (!canManageStaff(req.user)) {
      where.push("role = 'USER'");
    }

    const [users] = await db.query(
      `SELECT id, username, fullname, email, role, permissions, is_active, email_verified, password_set, created_at
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      params
    );

    res.json(users.map(publicManagedUser));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/users", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const { fullname, username, email, password, role = "USER", permissions = [] } = req.body;
    let normalizedRole = String(role || "USER").trim().toUpperCase();
    const normalizedUsername = normalizeUsername(username);
    if (normalizedRole === "USER" && normalizedUsername && !normalizeEmail(email)) {
      normalizedRole = "STAFF_SALES";
    }
    const normalizedEmail = normalizedRole === "USER" ? normalizeEmail(email) : buildStaffEmail(normalizedUsername);

    if (!fullname || !password || (normalizedRole === "USER" ? !normalizedEmail : !normalizedUsername)) {
      return res.status(400).json({ message: "Vui lòng nhập đầy đủ thông tin tài khoản" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ message: "Vai trò không hợp lệ" });
    }

    const blocked = ensureManageAccess(req, res, normalizedRole);
    if (blocked) return;

    if (String(password || "").length < 6) {
      return res.status(400).json({ message: "Mật khẩu tối thiểu 6 ký tự" });
    }

    if (normalizedUsername && !/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
      return res.status(400).json({ message: "Tên đăng nhập chỉ gồm chữ thường, số, dấu chấm, gạch ngang hoặc gạch dưới và từ 3-40 ký tự" });
    }

    const [existingUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? OR (username IS NOT NULL AND username = ?) LIMIT 1",
      [normalizedEmail, normalizedUsername || null]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ message: normalizedRole === "USER" ? "Email đã tồn tại" : "Tên đăng nhập đã tồn tại" });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const savedPermissions = normalizedRole === "USER" || !canManageRoles(req.user)
      ? "[]"
      : serializePermissions(permissions);

    const [result] = await db.query(
      `INSERT INTO users
       (username, fullname, email, password, password_set, role, permissions, is_active, email_verified, email_verified_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, NOW())`,
      [
        normalizedRole === "USER" ? null : normalizedUsername,
        String(fullname).trim(),
        normalizedEmail,
        hashedPassword,
        normalizedRole,
        savedPermissions
      ]
    );
    await ensureLocalProvider(result.insertId, normalizedEmail);

    res.status(201).json({ message: "Đã tạo tài khoản", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể tạo tài khoản" });
  }
});

router.post("/staff", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const { fullname, username, email, password, role = "STAFF_SALES", permissions = [] } = req.body;
    const normalizedUsername = normalizeUsername(username || email);
    const normalizedEmail = buildStaffEmail(normalizedUsername);
    const normalizedRole = String(role || "STAFF_SALES").trim().toUpperCase();

    if (!fullname || !normalizedUsername || !password) {
      return res.status(400).json({ message: "Vui lòng nhập họ tên, tên đăng nhập và mật khẩu" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole) || normalizedRole === "USER") {
      return res.status(400).json({ message: "Vai trò nhân viên không hợp lệ" });
    }

    if (String(password || "").length < 6) {
      return res.status(400).json({ message: "Mật khẩu tối thiểu 6 ký tự" });
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
      return res.status(400).json({ message: "Tên đăng nhập chỉ gồm chữ thường, số, dấu chấm, gạch ngang hoặc gạch dưới và từ 3-40 ký tự" });
    }

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1",
      [normalizedEmail, normalizedUsername]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Tên đăng nhập đã tồn tại" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      `INSERT INTO users
       (username, fullname, email, password, password_set, role, permissions, is_active, email_verified, email_verified_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, NOW())`,
      [
        normalizedUsername,
        String(fullname).trim(),
        normalizedEmail,
        hashedPassword,
        normalizedRole,
        canManageRoles(req.user) ? serializePermissions(permissions) : "[]"
      ]
    );
    await ensureLocalProvider(result.insertId, normalizedEmail);

    res.status(201).json({ message: "Đã tạo tài khoản nhân viên", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/users/:id", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { fullname, username, email, role = "USER", permissions = [] } = req.body;
    let normalizedRole = String(role || "USER").trim().toUpperCase();
    const normalizedUsername = normalizeUsername(username);
    if (normalizedRole === "USER" && normalizedUsername && !normalizeEmail(email)) {
      normalizedRole = "STAFF_SALES";
    }
    const normalizedEmail = normalizedRole === "USER" ? normalizeEmail(email) : buildStaffEmail(normalizedUsername);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Mã tài khoản không hợp lệ" });
    }

    if (!fullname || (normalizedRole === "USER" ? !normalizedEmail : !normalizedUsername)) {
      return res.status(400).json({ message: "Vui lòng nhập đầy đủ thông tin tài khoản" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ message: "Vai trò không hợp lệ" });
    }

    if (normalizedUsername && !/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
      return res.status(400).json({ message: "Tên đăng nhập chỉ gồm chữ thường, số, dấu chấm, gạch ngang hoặc gạch dưới và từ 3-40 ký tự" });
    }

    const blocked = ensureManageAccess(req, res, normalizedRole);
    if (blocked) return;

    const [targetUsers] = await db.query("SELECT id, role, permissions FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    const targetBlocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (targetBlocked) return;

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE (email = ? OR (username IS NOT NULL AND username = ?)) AND id <> ?",
      [normalizedEmail, normalizedUsername || null, userId]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: normalizedRole === "USER" ? "Email đã được tài khoản khác sử dụng" : "Tên đăng nhập đã được tài khoản khác sử dụng" });
    }

    await db.query(
      `UPDATE users
       SET username = ?,
           fullname = ?,
           email = ?,
           role = ?,
           permissions = ?
       WHERE id = ?`,
      [
        normalizedRole === "USER" ? null : normalizedUsername,
        String(fullname).trim(),
        normalizedEmail,
        normalizedRole,
        canManageRoles(req.user) ? serializePermissions(permissions) : serializePermissions(parsePermissions(targetUsers[0].permissions)),
        userId
      ]
    );

    res.json({ message: "Đã cập nhật tài khoản" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/users/:id/permissions", requirePermission(PERMISSIONS.ROLES_MANAGE), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const permissions = Array.isArray(req.body.permissions) ? req.body.permissions : [];

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Mã tài khoản không hợp lệ" });
    }

    const [targetUsers] = await db.query("SELECT id, role FROM users WHERE id = ? LIMIT 1", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    const normalizedRole = String(targetUsers[0].role || "USER").toUpperCase();
    if (normalizedRole === ADMIN_ROLE || normalizedRole === "USER") {
      return res.status(403).json({ message: "Chỉ cấp quyền cho tài khoản nhân viên nội bộ" });
    }

    await db.query(
      "UPDATE users SET permissions = ? WHERE id = ?",
      [serializePermissions(permissions), userId]
    );

    res.json({ message: "Đã cập nhật phân quyền nhân viên" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/users/:id/status", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const isActive = Boolean(req.body.isActive);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Ma tài khoản không hợp lệ" });
    }

    if (Number(req.user.id) === userId) {
      return res.status(400).json({ message: "Không thể tự khóa tài khoản đang đăng nhập" });
    }

    const [targetUsers] = await db.query("SELECT id, role FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    const blocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (blocked) return;

    await db.query("UPDATE users SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, userId]);
    res.json({ message: isActive ? "Đã mở khóa tài khoản" : "Đã khóa tài khoản" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.delete("/users/:id", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const userId = Number(req.params.id);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Mã tài khoản không hợp lệ" });
    }

    if (Number(req.user.id) === userId) {
      return res.status(400).json({ message: "Không thể tự xóa tài khoản đang đăng nhập" });
    }

    const [targetUsers] = await db.query("SELECT id, role FROM users WHERE id = ? LIMIT 1", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    const blocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (blocked) return;

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query("DELETE FROM email_verification_tokens WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM password_reset_tokens WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM social_accounts WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM user_auth_providers WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM user_addresses WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM user_discounts WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM chat_messages WHERE session_id IN (SELECT session_id FROM chat_sessions WHERE user_id = ?)", [userId]);
      await connection.query("DELETE FROM chat_sessions WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM payment_transactions WHERE payment_session_id IN (SELECT id FROM payment_sessions WHERE user_id = ?)", [userId]);
      await connection.query("DELETE FROM payment_sessions WHERE user_id = ?", [userId]);
      await connection.query("UPDATE food_reviews SET replied_by = NULL WHERE replied_by = ?", [userId]);
      await connection.query("DELETE FROM food_reviews WHERE user_id = ?", [userId]);
      await connection.query("UPDATE customer_feedback SET replied_by = NULL WHERE replied_by = ?", [userId]);
      await connection.query("DELETE FROM customer_feedback WHERE user_id = ?", [userId]);
      await connection.query("UPDATE orders SET user_id = NULL WHERE user_id = ?", [userId]);
      await connection.query("DELETE FROM users WHERE id = ?", [userId]);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    res.json({ message: "Đã xóa tài khoản" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa tài khoản" });
  }
});

router.get("/feedback", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const status = String(req.query.status || "all").trim().toLowerCase();
    const search = String(req.query.search || "").trim();
    const where = [];
    const params = [];

    if (["new", "in_progress", "replied", "closed"].includes(status)) {
      where.push("customer_feedback.status = ?");
      params.push(status);
    }

    if (search) {
      where.push("(customer_feedback.title LIKE ? OR customer_feedback.content LIKE ? OR users.fullname LIKE ? OR users.email LIKE ?)");
      const keyword = `%${search}%`;
      params.push(keyword, keyword, keyword, keyword);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [feedback] = await db.query(
      `SELECT customer_feedback.id,
              customer_feedback.user_id,
              customer_feedback.rating,
              customer_feedback.category,
              customer_feedback.title,
              customer_feedback.content,
              customer_feedback.status,
              customer_feedback.admin_reply,
              customer_feedback.replied_by,
              customer_feedback.replied_at,
              customer_feedback.created_at,
              customer_feedback.updated_at,
              users.fullname AS customer_name,
              users.email AS customer_email,
              replier.fullname AS replied_by_name
       FROM customer_feedback
       JOIN users ON users.id = customer_feedback.user_id
       LEFT JOIN users replier ON replier.id = customer_feedback.replied_by
       ${whereSql}
       ORDER BY
         CASE customer_feedback.status
           WHEN 'new' THEN 1
           WHEN 'in_progress' THEN 2
           WHEN 'replied' THEN 3
           ELSE 4
         END,
         customer_feedback.created_at DESC`,
      params
    );

    res.json(feedback);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/feedback/:id", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const feedbackId = Number(req.params.id);
    const status = String(req.body.status || "").trim().toLowerCase();

    if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
      return res.status(400).json({ message: "Mã phản hồi không hợp lệ" });
    }

    if (!["new", "in_progress", "replied", "closed"].includes(status)) {
      return res.status(400).json({ message: "Trạng thái phản hồi không hợp lệ" });
    }

    const [result] = await db.query(
      "UPDATE customer_feedback SET status = ? WHERE id = ?",
      [status, feedbackId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy phản hồi" });
    }

    res.json({ message: "Đã cập nhật trạng thái phản hồi" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/feedback/:id/reply", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const feedbackId = Number(req.params.id);
    const reply = String(req.body.reply || "").trim();

    if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
      return res.status(400).json({ message: "Mã phản hồi không hợp lệ" });
    }

    if (reply.length < 5 || reply.length > 2000) {
      return res.status(400).json({ message: "Nội dung phản hồi cần từ 5 đến 2000 ký tự" });
    }

    const [result] = await db.query(
      `UPDATE customer_feedback
       SET admin_reply = ?, replied_by = ?, replied_at = NOW(), status = 'replied'
       WHERE id = ?`,
      [reply, req.user.id, feedbackId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy phản hồi" });
    }

    res.json({ message: "Đã gửi phản hồi đến khách hàng" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/food-reviews", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();
    const rating = Number(req.query.rating || 0);
    const visibility = String(req.query.visibility || "all").trim().toLowerCase();
    const where = [];
    const params = [];

    if (Number.isInteger(rating) && rating >= 1 && rating <= 5) {
      where.push("food_reviews.rating = ?");
      params.push(rating);
    }

    if (visibility === "visible") {
      where.push("food_reviews.is_visible = 1");
    } else if (visibility === "hidden") {
      where.push("food_reviews.is_visible = 0");
    }

    if (search) {
      where.push("(foods.name LIKE ? OR food_reviews.comment LIKE ? OR users.fullname LIKE ? OR users.email LIKE ?)");
      const keyword = `%${search}%`;
      params.push(keyword, keyword, keyword, keyword);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [reviews] = await db.query(
      `SELECT food_reviews.id,
              food_reviews.food_id,
              food_reviews.order_id,
              food_reviews.user_id,
              food_reviews.rating,
              food_reviews.comment,
              food_reviews.admin_reply,
              food_reviews.replied_by,
              food_reviews.replied_at,
              food_reviews.is_visible,
              food_reviews.created_at,
              foods.name AS food_name,
              foods.image AS food_image,
              COALESCE(users.fullname, users.username, users.email, 'Khách hàng') AS customer_name,
              users.email AS customer_email,
              users.avatar,
              COALESCE(replier.fullname, replier.username, replier.email) AS replied_by_name
       FROM food_reviews
       JOIN foods ON foods.id = food_reviews.food_id
       JOIN users ON users.id = food_reviews.user_id
       LEFT JOIN users replier ON replier.id = food_reviews.replied_by
       ${whereSql}
       ORDER BY food_reviews.created_at DESC, food_reviews.id DESC`,
      params
    );

    res.json(reviews);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/food-reviews/:id/reply", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const reviewId = Number(req.params.id);
    const reply = String(req.body.reply || "").trim();

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({ message: "Mã đánh giá không hợp lệ" });
    }

    if (reply.length < 2 || reply.length > 2000) {
      return res.status(400).json({ message: "Phan hoi phai tu 2 den 2000 ky tu" });
    }

    const [result] = await db.query(
      `UPDATE food_reviews
       SET admin_reply = ?, replied_by = ?, replied_at = NOW()
       WHERE id = ?`,
      [reply, req.user.id, reviewId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy đánh giá" });
    }

    res.json({ message: "Đã lưu phản hồi bình luận" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.patch("/food-reviews/:id/visibility", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const reviewId = Number(req.params.id);
    const isVisible = Boolean(req.body.isVisible);

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({ message: "Mã đánh giá không hợp lệ" });
    }

    const [result] = await db.query(
      "UPDATE food_reviews SET is_visible = ? WHERE id = ?",
      [isVisible ? 1 : 0, reviewId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy đánh giá" });
    }

    res.json({ message: isVisible ? "Đã hiển thị đánh giá" : "Đã ẩn đánh giá" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.delete("/food-reviews/:id", requirePermission(PERMISSIONS.FEEDBACK_MANAGE), async (req, res) => {
  try {
    const reviewId = Number(req.params.id);

    if (!Number.isInteger(reviewId) || reviewId <= 0) {
      return res.status(400).json({ message: "Mã đánh giá không hợp lệ" });
    }

    const [result] = await db.query("DELETE FROM food_reviews WHERE id = ?", [reviewId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy đánh giá" });
    }

    res.json({ message: "Đã xóa bình luận" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Không thể xóa bình luận" });
  }
});

router.put("/users/:id/password", requirePermission(PERMISSIONS.PASSWORD_RESET), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { newPassword } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Ma tài khoản không hợp lệ" });
    }

    if (String(newPassword || "").length < 6) {
      return res.status(400).json({ message: "Mật khẩu mới tối thiểu 6 ký tự" });
    }

    const [targetUsers] = await db.query("SELECT id, email, role FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    const blocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (blocked) return;

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);
    await db.query("UPDATE users SET password = ?, password_set = 1 WHERE id = ?", [
      hashedPassword,
      userId
    ]);
    await ensureLocalProvider(userId, targetUsers[0].email);

    res.json({ message: "Đã đặt lại mật khẩu mới cho tài khoản" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

module.exports = router;
