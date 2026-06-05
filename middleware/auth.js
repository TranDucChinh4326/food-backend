const jwt = require("jsonwebtoken");
const JWT_SECRET = process.env.JWT_SECRET || "foodhub_dev_secret_change_me";

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
  requireAuth(req, res, () => {
    if (String(req.user.role || "").toUpperCase() !== "ADMIN") {
      return res.status(403).json({ message: "Ban khong co quyen quan tri" });
    }

    next();
  });
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
  requireAuth,
  requireAdmin,
  optionalAuth
};
