const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const {
  ADMIN_ROLE,
  PERMISSIONS,
  hasPermission,
  requireAnyPermission,
  requirePermission
} = require("../middleware/auth");

const router = express.Router();

const MANAGED_ROLES = ["USER", "STAFF_SALES", "STAFF_CONTENT", "STAFF_MANAGER"];
const ALL_PERMISSIONS = Object.values(PERMISSIONS);

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

function parseNullablePositiveNumber(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.round(number);
}

function validateDiscountPayload(body) {
  const code = normalizeDiscountCode(body.code);
  const name = String(body.name || "").trim();
  const discountType = String(body.discountType || body.discount_type || "percent").trim().toLowerCase();
  const discountValue = parsePositiveNumber(body.discountValue ?? body.discount_value, 0);
  const minOrder = parsePositiveNumber(body.minOrder ?? body.min_order, 0);
  const maxDiscount = parseNullablePositiveNumber(body.maxDiscount ?? body.max_discount);
  const usageLimit = parseNullablePositiveNumber(body.usageLimit ?? body.usage_limit);

  if (!code) {
    return { error: "Vui long nhap ma giam gia" };
  }

  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) {
    return { error: "Ma giam gia chi gom chu, so, dau gach ngang hoac gach duoi" };
  }

  if (!name) {
    return { error: "Vui long nhap ten chuong trinh" };
  }

  if (!["percent", "fixed"].includes(discountType)) {
    return { error: "Kieu giam gia khong hop le" };
  }

  if (discountValue <= 0 || (discountType === "percent" && discountValue > 100)) {
    return { error: "Gia tri giam gia khong hop le" };
  }

  return {
    value: {
      code,
      name,
      discountType,
      discountValue,
      minOrder,
      maxDiscount,
      usageLimit,
      startsAt: toMysqlDateTime(body.startsAt ?? body.starts_at),
      expiresAt: toMysqlDateTime(body.expiresAt ?? body.expires_at),
      isActive: body.isActive === undefined ? true : Boolean(body.isActive)
    }
  };
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
    return res.status(403).json({ message: "Khong duoc chinh sua quyen ADMIN qua man hinh nay" });
  }

  if (normalizedTargetRole === "USER" && !canManageUsers(req.user)) {
    return res.status(403).json({ message: "Ban khong co quyen quan ly khach hang" });
  }

  if (normalizedTargetRole !== "USER" && !canManageStaff(req.user)) {
    return res.status(403).json({ message: "Ban khong co quyen quan ly nhan vien" });
  }

  return null;
}

router.get("/permissions", requirePermission(PERMISSIONS.ROLES_MANAGE), (req, res) => {
  res.json({
    roles: MANAGED_ROLES,
    permissions: [
      { value: PERMISSIONS.ORDERS_MANAGE, label: "Quan ly don hang" },
      { value: PERMISSIONS.FOODS_MANAGE, label: "Quan ly mon an" },
      { value: PERMISSIONS.USERS_MANAGE, label: "Quan ly khach hang" },
      { value: PERMISSIONS.STAFF_MANAGE, label: "Quan ly nhan vien" },
      { value: PERMISSIONS.ROLES_MANAGE, label: "Cap phat quyen" },
      { value: PERMISSIONS.PASSWORD_RESET, label: "Dat lai mat khau theo yeu cau" },
      { value: PERMISSIONS.ANNOUNCEMENTS_MANAGE, label: "Quan ly thong bao" },
      { value: PERMISSIONS.ADS_MANAGE, label: "Quan ly quang cao" },
      { value: PERMISSIONS.DISCOUNTS_MANAGE, label: "Quan ly ma giam gia" },
      { value: PERMISSIONS.STATS_VIEW, label: "Xem thong ke" }
    ]
  });
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
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/announcements/:id", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const announcementId = Number(req.params.id);

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thong bao khong hop le" });
    }

    const [announcements] = await db.query(
      `SELECT id, title, content, is_active, published_at, expires_at, created_at, updated_at
       FROM announcements
       WHERE id = ?`,
      [announcementId]
    );

    if (announcements.length === 0) {
      return res.status(404).json({ message: "Khong tim thay thong bao" });
    }

    res.json(announcements[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
      return res.status(400).json({ message: "Vui long nhap tieu de thong bao" });
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

    res.status(201).json({ message: "Da tao thong bao", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tao thong bao" });
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
      return res.status(400).json({ message: "Ma thong bao khong hop le" });
    }

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Vui long nhap tieu de thong bao" });
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
      return res.status(404).json({ message: "Khong tim thay thong bao" });
    }

    res.json({ message: "Da cap nhat thong bao" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the cap nhat thong bao" });
  }
});

router.delete("/announcements/:id", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const announcementId = Number(req.params.id);

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thong bao khong hop le" });
    }

    const [result] = await db.query("DELETE FROM announcements WHERE id = ?", [announcementId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay thong bao" });
    }

    res.json({ message: "Da xoa thong bao" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the xoa thong bao" });
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
      where.push("is_active = 1 AND (starts_at IS NULL OR starts_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit)");
    } else if (status === "hidden") {
      where.push("is_active = 0");
    } else if (status === "expired") {
      where.push("is_active = 1 AND expires_at IS NOT NULL AND expires_at <= NOW()");
    } else if (status === "scheduled") {
      where.push("is_active = 1 AND starts_at IS NOT NULL AND starts_at > NOW()");
    } else if (status === "soldout") {
      where.push("usage_limit IS NOT NULL AND used_count >= usage_limit");
    }

    const [discounts] = await db.query(
      `SELECT id, code, name, discount_type, discount_value, min_order, max_discount,
        usage_limit, used_count, starts_at, expires_at, is_active, created_at, updated_at,
        CASE
          WHEN is_active = 0 THEN 'hidden'
          WHEN usage_limit IS NOT NULL AND used_count >= usage_limit THEN 'soldout'
          WHEN starts_at IS NOT NULL AND starts_at > NOW() THEN 'scheduled'
          WHEN expires_at IS NOT NULL AND expires_at <= NOW() THEN 'expired'
          ELSE 'active'
        END AS status
       FROM discounts
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT 300`,
      params
    );

    res.json(discounts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Ma giam gia khong hop le" });
    }

    const [discounts] = await db.query(
      `SELECT id, code, name, discount_type, discount_value, min_order, max_discount,
        usage_limit, used_count, starts_at, expires_at, is_active, created_at, updated_at
       FROM discounts
       WHERE id = ?`,
      [discountId]
    );

    if (discounts.length === 0) {
      return res.status(404).json({ message: "Khong tim thay ma giam gia" });
    }

    res.json(discounts[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
       (code, name, discount_type, discount_value, min_order, max_discount, usage_limit, starts_at, expires_at, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        discount.code,
        discount.name,
        discount.discountType,
        discount.discountValue,
        discount.minOrder,
        discount.maxDiscount,
        discount.usageLimit,
        discount.startsAt,
        discount.expiresAt,
        discount.isActive ? 1 : 0
      ]
    );

    res.status(201).json({ message: "Da tao ma giam gia", id: result.insertId });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Ma giam gia da ton tai" });
    }

    console.error(error);
    res.status(500).json({ message: "Khong the tao ma giam gia" });
  }
});

router.put("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Ma giam gia khong hop le" });
    }

    const parsed = validateDiscountPayload(req.body);
    if (parsed.error) {
      return res.status(400).json({ message: parsed.error });
    }

    const discount = parsed.value;
    const [result] = await db.query(
      `UPDATE discounts
       SET code = ?, name = ?, discount_type = ?, discount_value = ?, min_order = ?,
        max_discount = ?, usage_limit = ?, starts_at = ?, expires_at = ?, is_active = ?
       WHERE id = ?`,
      [
        discount.code,
        discount.name,
        discount.discountType,
        discount.discountValue,
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
      return res.status(404).json({ message: "Khong tim thay ma giam gia" });
    }

    res.json({ message: "Da cap nhat ma giam gia" });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Ma giam gia da ton tai" });
    }

    console.error(error);
    res.status(500).json({ message: "Khong the cap nhat ma giam gia" });
  }
});

router.delete("/discounts/:id", requirePermission(PERMISSIONS.DISCOUNTS_MANAGE), async (req, res) => {
  try {
    const discountId = Number(req.params.id);

    if (!Number.isInteger(discountId) || discountId <= 0) {
      return res.status(400).json({ message: "Ma giam gia khong hop le" });
    }

    const [result] = await db.query("DELETE FROM discounts WHERE id = ?", [discountId]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay ma giam gia" });
    }

    res.json({ message: "Da xoa ma giam gia" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the xoa ma giam gia" });
  }
});

router.get("/stats", requireAnyPermission([PERMISSIONS.STATS_VIEW, PERMISSIONS.ORDERS_MANAGE]), async (req, res) => {
  try {
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    const where = [];
    const params = [];

    if (from) {
      where.push("DATE(created_at) >= ?");
      params.push(from);
    }

    if (to) {
      where.push("DATE(created_at) <= ?");
      params.push(to);
    }

    const orderWhere = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const detailWhere = where.length
      ? `WHERE ${where.map(condition => condition.replace("created_at", "orders.created_at")).join(" AND ")}`
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
        COALESCE(SUM(CASE WHEN role = 'USER' THEN 1 ELSE 0 END), 0) AS customers,
        COALESCE(SUM(CASE WHEN role <> 'USER' THEN 1 ELSE 0 END), 0) AS staff
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
        COALESCE(SUM(CASE WHEN is_active = 1 AND (starts_at IS NULL OR starts_at <= NOW()) AND (expires_at IS NULL OR expires_at > NOW()) AND (usage_limit IS NULL OR used_count < usage_limit) THEN 1 ELSE 0 END), 0) AS active_discounts
       FROM discounts`
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
      `SELECT DATE(created_at) AS order_date, COUNT(*) AS orders_count,
        COALESCE(SUM(CASE WHEN status = 'done' THEN total_price ELSE 0 END), 0) AS revenue
       FROM orders
       ${orderWhere}
       GROUP BY DATE(created_at)
       ORDER BY order_date DESC
       LIMIT 14`,
      params
    );

    res.json({
      summary: {
        ...orderRows[0],
        ...userRows[0],
        ...foodRows[0],
        ...discountRows[0]
      },
      topFoods,
      dailyRevenue
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tai thong ke" });
  }
});

router.get("/orders", requirePermission(PERMISSIONS.ORDERS_MANAGE), async (req, res) => {
  try {
    const [orders] = await db.query(
      `SELECT id, customer_name, phone, address, note, total_price, status, created_at
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
    res.status(500).json({ message: "Loi server" });
  }
});

router.patch("/orders/:id/status", requirePermission(PERMISSIONS.ORDERS_MANAGE), async (req, res) => {
  try {
    const orderId = Number(req.params.id);
    const { status } = req.body;
    const allowedStatuses = ["pending", "confirmed", "delivering", "done", "cancelled"];

    if (!Number.isInteger(orderId) || orderId <= 0) {
      return res.status(400).json({ message: "Ma don hang khong hop le" });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Trang thai khong hop le" });
    }

    const [result] = await db.query(
      "UPDATE orders SET status = ? WHERE id = ?",
      [status, orderId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay don hang" });
    }

    res.json({ message: "Cap nhat trang thai thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/categories", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const parentId = req.body.parentId ? Number(req.body.parentId) : null;
    const sortOrder = parsePositiveNumber(req.body.sortOrder, 0);
    const isActive = req.body.isActive === false || req.body.isActive === 0 || req.body.isActive === "0" ? 0 : 1;

    if (!name) {
      return res.status(400).json({ message: "Vui long nhap ten danh muc" });
    }

    const slug = await createUniqueCategorySlug(name);
    const type = await resolveCategoryType(parentId, slug);

    if (!type) {
      return res.status(400).json({ message: "Danh muc cha khong hop le" });
    }

    const [result] = await db.query(
      `INSERT INTO categories (name, slug, type, parent_id, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, slug, type, parentId, sortOrder, isActive]
    );

    res.status(201).json({ message: "Them danh muc thanh cong", id: result.insertId, slug });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
      return res.status(400).json({ message: "Ma danh muc khong hop le" });
    }

    if (!name) {
      return res.status(400).json({ message: "Vui long nhap ten danh muc" });
    }

    if (parentId === categoryId) {
      return res.status(400).json({ message: "Danh muc cha khong duoc trung voi danh muc hien tai" });
    }

    const slug = await createUniqueCategorySlug(name, categoryId);
    const type = await resolveCategoryType(parentId, slug);

    if (!type) {
      return res.status(400).json({ message: "Danh muc cha khong hop le" });
    }

    const [result] = await db.query(
      `UPDATE categories
       SET name = ?, slug = ?, type = ?, parent_id = ?, sort_order = ?, is_active = ?
       WHERE id = ?`,
      [name, slug, type, parentId, sortOrder, isActive, categoryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay danh muc" });
    }

    res.json({ message: "Cap nhat danh muc thanh cong", slug });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.delete("/categories/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const categoryId = Number(req.params.id);

    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      return res.status(400).json({ message: "Ma danh muc khong hop le" });
    }

    const [result] = await db.query(
      "UPDATE categories SET is_active = 0 WHERE id = ? OR parent_id = ?",
      [categoryId, categoryId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay danh muc" });
    }

    res.json({ message: "Da an danh muc" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
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
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/foods", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const { name, categoryId, price, description = "", image = "", isActive = 1 } = req.body;

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui long nhap ten mon, danh muc va gia" });
    }

    const [result] = await db.query(
      `INSERT INTO foods (name, category_id, price, description, image, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name.trim(), Number(categoryId), Number(price), description.trim(), image.trim(), Number(isActive)]
    );

    res.status(201).json({ message: "Them mon thanh cong", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/foods/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const foodId = Number(req.params.id);
    const { name, categoryId, price, description = "", image = "", isActive = 1 } = req.body;

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Ma mon khong hop le" });
    }

    if (!name || !categoryId || !price) {
      return res.status(400).json({ message: "Vui long nhap ten mon, danh muc va gia" });
    }

    const [result] = await db.query(
      `UPDATE foods
       SET name = ?, category_id = ?, price = ?, description = ?, image = ?, is_active = ?
       WHERE id = ?`,
      [
        name.trim(),
        Number(categoryId),
        Number(price),
        description.trim(),
        image.trim(),
        Number(isActive),
        foodId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay mon an" });
    }

    res.json({ message: "Cap nhat mon thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.delete("/foods/:id", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const foodId = Number(req.params.id);

    if (!Number.isInteger(foodId) || foodId <= 0) {
      return res.status(400).json({ message: "Ma mon khong hop le" });
    }

    const [result] = await db.query(
      "UPDATE foods SET is_active = 0 WHERE id = ?",
      [foodId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay mon an" });
    }

    res.json({ message: "Da an mon khoi menu" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
      `SELECT id, fullname, email, role, permissions, is_active, email_verified, password_set, created_at
       FROM users
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY created_at DESC, id DESC
       LIMIT 200`,
      params
    );

    res.json(users.map(publicManagedUser));
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/users", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const { fullname, email, password, role = "USER", permissions = [] } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = String(role || "USER").trim().toUpperCase();

    if (!fullname || !normalizedEmail || !password) {
      return res.status(400).json({ message: "Vui long nhap ho ten, email va mat khau" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ message: "Vai tro khong hop le" });
    }

    const blocked = ensureManageAccess(req, res, normalizedRole);
    if (blocked) return;

    if (password.length < 6) {
      return res.status(400).json({ message: "Mat khau toi thieu 6 ky tu" });
    }

    const [existingUsers] = await db.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);
    if (existingUsers.length > 0) {
      return res.status(409).json({ message: "Email da ton tai" });
    }

    const hashedPassword = await bcrypt.hash(String(password), 10);
    const savedPermissions = normalizedRole === "USER" || !canManageRoles(req.user)
      ? "[]"
      : serializePermissions(permissions);

    const [result] = await db.query(
      `INSERT INTO users
       (fullname, email, password, password_set, role, permissions, is_active, email_verified, email_verified_at)
       VALUES (?, ?, ?, 1, ?, ?, 1, 1, NOW())`,
      [
        String(fullname).trim(),
        normalizedEmail,
        hashedPassword,
        normalizedRole,
        savedPermissions
      ]
    );

    res.status(201).json({ message: "Da tao tai khoan", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the tao tai khoan" });
  }
});

router.post("/staff", requirePermission(PERMISSIONS.STAFF_MANAGE), async (req, res) => {
  try {
    const { fullname, email, password, role = "STAFF_SALES", permissions = [] } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = String(role || "").trim().toUpperCase();

    if (!fullname || !normalizedEmail || !password) {
      return res.status(400).json({ message: "Vui long nhap ho ten, email va mat khau" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole) || normalizedRole === "USER") {
      return res.status(400).json({ message: "Vai tro nhan vien khong hop le" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Mat khau toi thieu 6 ky tu" });
    }

    const [oldUsers] = await db.query("SELECT id FROM users WHERE email = ?", [normalizedEmail]);

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email da ton tai" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const [result] = await db.query(
      `INSERT INTO users
       (fullname, email, password, password_set, role, permissions, is_active, email_verified, email_verified_at)
       VALUES (?, ?, ?, 1, ?, ?, 1, 1, NOW())`,
      [
        String(fullname).trim(),
        normalizedEmail,
        hashedPassword,
        normalizedRole,
        canManageRoles(req.user) ? serializePermissions(permissions) : "[]"
      ]
    );

    res.status(201).json({ message: "Da tao tai khoan nhan vien", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/users/:id", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { fullname, email, role = "USER", permissions = [] } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const normalizedRole = String(role || "USER").trim().toUpperCase();

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Ma tai khoan khong hop le" });
    }

    if (!fullname || !normalizedEmail) {
      return res.status(400).json({ message: "Vui long nhap ho ten va email" });
    }

    if (!MANAGED_ROLES.includes(normalizedRole)) {
      return res.status(400).json({ message: "Vai tro khong hop le" });
    }

    const blocked = ensureManageAccess(req, res, normalizedRole);
    if (blocked) return;

    const [targetUsers] = await db.query("SELECT id, role, permissions FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Khong tim thay tai khoan" });
    }

    const targetBlocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (targetBlocked) return;

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [normalizedEmail, userId]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email da duoc tai khoan khac su dung" });
    }

    await db.query(
      `UPDATE users
       SET fullname = ?,
           email = ?,
           role = ?,
           permissions = ?
       WHERE id = ?`,
      [
        String(fullname).trim(),
        normalizedEmail,
        normalizedRole,
        canManageRoles(req.user) ? serializePermissions(permissions) : serializePermissions(parsePermissions(targetUsers[0].permissions)),
        userId
      ]
    );

    res.json({ message: "Da cap nhat tai khoan" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.patch("/users/:id/status", requireAnyPermission([PERMISSIONS.USERS_MANAGE, PERMISSIONS.STAFF_MANAGE]), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const isActive = Boolean(req.body.isActive);

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Ma tai khoan khong hop le" });
    }

    if (Number(req.user.id) === userId) {
      return res.status(400).json({ message: "Khong the tu khoa tai khoan dang dang nhap" });
    }

    const [targetUsers] = await db.query("SELECT id, role FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Khong tim thay tai khoan" });
    }

    const blocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (blocked) return;

    await db.query("UPDATE users SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, userId]);
    res.json({ message: isActive ? "Da mo khoa tai khoan" : "Da khoa tai khoan" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/users/:id/password", requirePermission(PERMISSIONS.PASSWORD_RESET), async (req, res) => {
  try {
    const userId = Number(req.params.id);
    const { newPassword } = req.body;

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ message: "Ma tai khoan khong hop le" });
    }

    if (!newPassword || String(newPassword).length < 6) {
      return res.status(400).json({ message: "Mat khau moi toi thieu 6 ky tu" });
    }

    const [targetUsers] = await db.query("SELECT id, role FROM users WHERE id = ?", [userId]);

    if (targetUsers.length === 0) {
      return res.status(404).json({ message: "Khong tim thay tai khoan" });
    }

    const blocked = ensureManageAccess(req, res, targetUsers[0].role);
    if (blocked) return;

    const hashedPassword = await bcrypt.hash(String(newPassword), 10);
    await db.query("UPDATE users SET password = ?, password_set = 1 WHERE id = ?", [
      hashedPassword,
      userId
    ]);

    res.json({ message: "Da dat lai mat khau moi cho tai khoan" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
