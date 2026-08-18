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
  FEEDBACK_MANAGE: "feedback.manage",
  STATS_VIEW: "stats.view"
};

function parsePermissions(value) {
  // Chuẩn hóa permissions từ Database để middleware luôn xử lý trên mảng quyền.
  // Input có thể là JSON string/mảng; output dùng cho hasPermission và giao diện admin.
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
  // Nạp lại thông tin user từ Database sau khi JWT hợp lệ.
  // Cần bước này để trạng thái khóa tài khoản và quyền admin luôn cập nhật theo dữ liệu hiện tại.
  const [users] = await db.query(
    "SELECT id, fullname, email, role, permissions, is_active FROM users WHERE id = ? LIMIT 1",
    [req.user.id]
  );

  if (users.length === 0) {
    res.status(401).json({ message: "Tài khoản không tồn tại" });
    return false;
  }

  if (!users[0].is_active) {
    res.status(403).json({ message: "Tài khoản đã bị khóa" });
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
    return req.query?.token ? String(req.query.token) : null;
  }

  return header.slice("Bearer ".length);
}

function requireAuth(req, res, next) {
  // Bảo vệ API cần đăng nhập: đọc Bearer token, xác minh JWT và gắn payload vào req.user.
  // Các middleware phân quyền sẽ dùng req.user ở bước tiếp theo để truy vấn Database.
  const token = getToken(req);

  if (!token) {
    return res.status(401).json({ message: "Vui lòng đăng nhập" });
  }

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (error) {
    res.status(401).json({ message: "Phiên đăng nhập không hợp lệ" });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const ok = await hydrateUser(req, res);
      if (!ok) return;

      if (!isAdmin(req.user)) {
        return res.status(403).json({ message: "Bạn không có quyền quản trị" });
      }

      next();
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Lỗi server" });
    }
  });
}

function requirePermission(permission) {
  // Tạo middleware kiểm tra một quyền cụ thể của nhân viên/admin.
  // Input là mã quyền nghiệp vụ; output là Express middleware trả 403 nếu tài khoản không đủ quyền.
  return (req, res, next) => {
    requireAuth(req, res, async () => {
      try {
        const ok = await hydrateUser(req, res);
        if (!ok) return;

        if (!hasPermission(req.user, permission)) {
          return res.status(403).json({ message: "Bạn không có quyền thực hiện thao tác này" });
        }

        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Lỗi server" });
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
          return res.status(403).json({ message: "Bạn không có quyền thực hiện thao tác này" });
        }

        next();
      } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Lỗi server" });
      }
    });
  };
}

function optionalAuth(req, res, next) {
  // Cho phép API chạy cả khi không đăng nhập, nhưng vẫn nhận diện user nếu token hợp lệ.
  // Chatbot dùng middleware này để lưu session theo user khi có đăng nhập và vẫn hỗ trợ khách vãng lai.
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
