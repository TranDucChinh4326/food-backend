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
      { value: PERMISSIONS.ANNOUNCEMENTS_MANAGE, label: "Quan ly thong bao" }
    ]
  });
});

router.get("/announcements", requirePermission(PERMISSIONS.ANNOUNCEMENTS_MANAGE), async (req, res) => {
  try {
    const search = String(req.query.q || "").trim();
    const status = String(req.query.status || "all").toLowerCase();
    const important = String(req.query.important || "all").toLowerCase();
    const where = [];
    const params = [];

    if (search) {
      where.push("(title LIKE ? OR content LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }

    if (status === "active") {
      where.push("is_active = 1");
    } else if (status === "hidden") {
      where.push("is_active = 0");
    }

    if (important === "important") {
      where.push("is_important = 1");
    } else if (important === "normal") {
      where.push("is_important = 0");
    }

    const [announcements] = await db.query(
      `SELECT id, title, content, link_url, is_important, is_active, published_at, created_at, updated_at
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
      `SELECT id, title, content, link_url, is_important, is_active, published_at, created_at, updated_at
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
      linkUrl = "",
      isImportant = false,
      isActive = true,
      publishedAt = null
    } = req.body;

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Vui long nhap tieu de thong bao" });
    }

    const [result] = await db.query(
      `INSERT INTO announcements (title, content, link_url, is_important, is_active, published_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        String(title).trim(),
        String(content || "").trim(),
        String(linkUrl || "").trim() || null,
        isImportant ? 1 : 0,
        isActive ? 1 : 0,
        publishedAt || null
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
      linkUrl = "",
      isImportant = false,
      isActive = true,
      publishedAt = null
    } = req.body;

    if (!Number.isInteger(announcementId) || announcementId <= 0) {
      return res.status(400).json({ message: "Ma thong bao khong hop le" });
    }

    if (!String(title || "").trim()) {
      return res.status(400).json({ message: "Vui long nhap tieu de thong bao" });
    }

    const [result] = await db.query(
      `UPDATE announcements
       SET title = ?, content = ?, link_url = ?, is_important = ?, is_active = ?, published_at = ?
       WHERE id = ?`,
      [
        String(title).trim(),
        String(content || "").trim(),
        String(linkUrl || "").trim() || null,
        isImportant ? 1 : 0,
        isActive ? 1 : 0,
        publishedAt || null,
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

    const [result] = await db.query(
      "UPDATE announcements SET is_active = 0 WHERE id = ?",
      [announcementId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Khong tim thay thong bao" });
    }

    res.json({ message: "Da an thong bao" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Khong the an thong bao" });
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

router.get("/foods", requirePermission(PERMISSIONS.FOODS_MANAGE), async (req, res) => {
  try {
    const [foods] = await db.query(
      `SELECT foods.*, categories.name AS category_name
       FROM foods
       LEFT JOIN categories ON categories.id = foods.category_id
       ORDER BY foods.created_at DESC, foods.id DESC`
    );

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
      where.push("role <> 'USER' AND role <> 'ADMIN'");
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
