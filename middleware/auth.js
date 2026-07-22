const jwt = require("jsonwebtoken");
const db = require("../db");
const JWT_SECRET = process.env.JWT_SECRET || "foodhub_dev_secret_change_me";

const ADMIN_ROLE = "ADMIN";
const PERMISSIONS = {
  ORDERS_MANAGE: "orders.manage",
  FOODS_MANAGE: "foods.manage",
  USERS_MANAGE: "users.manage",
  STAFF_MANAGE: "staff.manage",
  ROLES_MANAGE: "roles.manage",
  PASSWORD_RESET: "password.reset",
  ANNOUNCEMENTS_MANAGE: "announcements.manage",
  DISCOUNTS_MANAGE: "discounts.manage",
  ADS_MANAGE: "ads.manage",
  STATS_VIEW: "stats.view"
};

function parsePermissions(value) {
  if (!value) return [];

  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch (error) {
    return [];
  }
}

function isAdmin(user) {
  return String(user?.role || "").toUpperCase() === ADMIN_ROLE;
}

function hasPermission(user, permission) {
  if (isAdmin(user)) return true;

  const permissions = Array.isArray(user?.permissions)
    ? user.permissions
    : parsePermissions(user?.permissions);

  return permissions.includes(permission);
}

async function hydrateUser(req, res) {
  const [users] = await db.query(
    "SELECT id, fullname, email, role, permissions, is_active FROM users WHERE id = ? LIMIT 1",
    [req.user.id]
  );

  if (users.length === 0) {
    res.status(401).json({ message: "Tai khoan khong ton tai" });
    return false;
  }

  if (!users[0].is_active) {
    res.status(403).json({ message: "Tai khoan da bi khoa" });
    return false;
  }

  req.user = {
    ...req.user,
    ...users[0],
    permissions: parsePermissions(users[0].permissions)
  };

  return true;
}

function getToken(req) {
  const header = req.headers.authorization || "";

  if (!header.startsWith("Bearer ")) {
    return null;
  }

  return header.slice("Bearer ".length);
}

function requireAuth(req, res, next) {
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({ message: "Vui long dang nhap" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ message: "Phien dang nhap khong hop le" });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const ok = await hydrateUser(req, res);
      if (!ok) return;

      if (!isAdmin(req.user)) {
        return res.status(403).json({ message: "Ban khong co quyen quan tri" });
      }

      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Loi server" });
    }
  });
}

function requirePermission(permission) {
  return (req, res, next) => {
    requireAuth(req, res, async () => {
      try {
        const ok = await hydrateUser(req, res);
        if (!ok) return;

        if (!hasPermission(req.user, permission)) {
          return res.status(403).json({ message: "Ban khong co quyen thuc hien thao tac nay" });
        }

        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Loi server" });
      }
    });
  };
}

function requireAnyPermission(permissions) {
  return (req, res, next) => {
    requireAuth(req, res, async () => {
      try {
        const ok = await hydrateUser(req, res);
        if (!ok) return;

        if (!permissions.some(permission => hasPermission(req.user, permission))) {
          return res.status(403).json({ message: "Ban khong co quyen thuc hien thao tac nay" });
        }

        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Loi server" });
      }
    });
  };
}

function optionalAuth(req, res, next) {
  const token = getToken(req);

  if (!token) {
    next();
    return;
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch (error) {
    req.user = null;
  }

  next();
}

module.exports = {
  ADMIN_ROLE,
  PERMISSIONS,
  hasPermission,
  requireAuth,
  requireAdmin,
  requirePermission,
  requireAnyPermission,
  optionalAuth
};
