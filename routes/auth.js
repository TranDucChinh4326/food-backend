const express = require("express");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "foodhub_dev_secret_change_me";
const passwordCaptchaStore = new Map();
const passwordCaptchaCooldownStore = new Map();
const PASSWORD_CAPTCHA_TTL_MS = 5 * 60 * 1000;
const PASSWORD_CAPTCHA_COOLDOWN_MS = 60 * 1000;
const AVATAR_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "avatars");
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 1.5 * 1024 * 1024
  },
  fileFilter(req, file, callback) {
    if (!file.mimetype || !file.mimetype.startsWith("image/")) {
      callback(new Error("Vui lòng chọn tệp hình ảnh"));
      return;
    }

    callback(null, true);
  }
});

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

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
}

function publicUser(user) {
  const username = user.username || null;
  const hasPassword = Boolean(user.password_set ?? true);
  const isAdmin = String(user.role || "").toUpperCase() === "ADMIN";
  let permissions = [];

  try {
    const parsedPermissions = typeof user.permissions === "string" ? JSON.parse(user.permissions) : user.permissions;
    permissions = Array.isArray(parsedPermissions) ? parsedPermissions.map(String) : [];
  } catch (error) {
    permissions = [];
  }

  return {
    id: user.id,
    username,
    fullname: user.fullname,
    email: user.email,
    avatar: user.avatar || null,
    role: user.role,
    phone: user.phone || null,
    address: user.address || null,
    emailVerified: Boolean(user.email_verified),
    passwordSet: hasPassword,
    permissions,
    requiresAccountSetup: !isAdmin && (!hasPassword || !username)
  };
}

function getApiBaseUrl(req) {
  return (process.env.API_PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
}

function getAvatarExtension(mimetype) {
  const extension = String(mimetype || "").split("/")[1] || "jpg";
  return extension === "jpeg" ? "jpg" : extension.replace(/[^a-z0-9]/gi, "") || "jpg";
}

function createUploadError(code, message, cause) {
  const error = new Error(message);
  error.code = code;
  error.cause = cause;
  return error;
}

async function saveAvatarFile(req, file) {
  if (hasCloudinaryConfig) {
    try {
      const uploadResult = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: process.env.CLOUDINARY_AVATAR_FOLDER || "foodhub/avatars",
            resource_type: "image",
            transformation: [
              { width: 320, height: 320, crop: "fill", gravity: "face" },
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
    } catch (error) {
      throw createUploadError(
        "CLOUDINARY_UPLOAD_FAILED",
        error.message || "Cloudinary upload failed",
        error
      );
    }
  }

  try {
    await fs.promises.mkdir(AVATAR_UPLOAD_DIR, { recursive: true });
    const filename = `${req.user.id}-${Date.now()}-${crypto.randomBytes(6).toString("hex")}.${getAvatarExtension(file.mimetype)}`;
    const filepath = path.join(AVATAR_UPLOAD_DIR, filename);

    await fs.promises.writeFile(filepath, file.buffer);

    return `${getApiBaseUrl(req)}/uploads/avatars/${filename}`;
  } catch (error) {
    throw createUploadError(
      "LOCAL_UPLOAD_FAILED",
      error.message || "Local upload failed",
      error
    );
  }
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "http://localhost:5500")
    .split(",")[0]
    .trim()
    .replace(/\/$/, "");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function getStrongPasswordError(value) {
  const password = String(value || "");
  if (password.length < 8) return "Mật khẩu phải có ít nhất 8 ký tự";
  if (!/[a-z]/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ thường";
  if (!/[A-Z]/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ hoa";
  if (!/\d/.test(password)) return "Mật khẩu phải có ít nhất 1 chữ số";
  if (!/[^A-Za-z0-9]/.test(password)) return "Mật khẩu phải có ít nhất 1 ký tự đặc biệt";
  return "";
}

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function shouldExposeVerificationUrl(emailSent) {
  return !emailSent || process.env.EMAIL_DEBUG_LINK === "true";
}

function createPasswordCaptchaCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function cleanupPasswordCaptchas() {
  const now = Date.now();

  for (const [id, captcha] of passwordCaptchaStore.entries()) {
    if (captcha.expiresAt <= now) {
      passwordCaptchaStore.delete(id);
    }
  }

  for (const [userId, availableAt] of passwordCaptchaCooldownStore.entries()) {
    if (availableAt <= now) {
      passwordCaptchaCooldownStore.delete(userId);
    }
  }
}

async function createEmailVerification(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);

  await db.query(
    "DELETE FROM email_verification_tokens WHERE user_id = ? AND used_at IS NULL",
    [userId]
  );
  await db.query(
    "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE))",
    [userId, tokenHash]
  );

  return `${getFrontendUrl()}/verify-email.html?token=${token}`;
}

async function sendVerificationEmail(email, fullname, verificationUrl) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) {
    return false;
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: email,
      subject: "Xác thực tài khoản FoodHub",
      html: `
        <p>Chao ${String(fullname || "ban")},</p>
        <p>Bam vao liên kết ben duoi de xác thực tài khoản FoodHub:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>Liên kết hết hạn sau 30 phut.</p>
      `
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Không gửi được email xác thực: ${errorBody}`);
  }

  return true;
}

async function findProviderUser(provider, providerId) {
  const [accounts] = await db.query(
    `SELECT users.*
     FROM user_auth_providers
     JOIN users ON users.id = user_auth_providers.user_id
     WHERE user_auth_providers.provider = ? AND user_auth_providers.provider_user_id = ?
     LIMIT 1`,
    [provider, providerId]
  );

  return accounts[0] || null;
}

async function createAuthProvider(userId, { provider, providerId, email }) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedEmail = normalizeEmail(email);

  if (!["local", "google", "facebook"].includes(normalizedProvider)) {
    const error = new Error("Phuong thuc đăng nhập không hợp lệ");
    error.status = 400;
    throw error;
  }

  if (normalizedProvider !== "local" && !normalizedProviderId) {
    const error = new Error("Thiếu mã tài khoản nhà cung cấp");
    error.status = 400;
    throw error;
  }

  await db.query(
    `INSERT INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       provider_email = VALUES(provider_email)`,
    [userId, normalizedProvider, normalizedProviderId || null, normalizedEmail || null]
  );
}

async function linkSocialAccount(userId, { email, provider, providerId }) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  const normalizedEmail = normalizeEmail(email);

  if (!["google", "facebook"].includes(normalizedProvider)) {
    const error = new Error("Nhà cung cấp social không hợp lệ");
    error.status = 400;
    throw error;
  }

  const [linkedAccounts] = await db.query(
    "SELECT user_id FROM user_auth_providers WHERE provider = ? AND provider_user_id = ? LIMIT 1",
    [normalizedProvider, normalizedProviderId]
  );

  if (linkedAccounts.length > 0 && Number(linkedAccounts[0].user_id) !== Number(userId)) {
    const error = new Error("Tài khoản Google/Facebook này da liên kết voi tài khoản khac");
    error.status = 400;
    throw error;
  }

  await createAuthProvider(userId, {
    provider: normalizedProvider,
    providerId: normalizedProviderId,
    email: normalizedEmail
  });
}

async function getLoginProviderCount(userId) {
  const [rows] = await db.query(
    "SELECT COUNT(*) AS total FROM user_auth_providers WHERE user_id = ?",
    [userId]
  );

  return Number(rows[0]?.total || 0);
}

async function ensureLocalProvider(userId, email) {
  await createAuthProvider(userId, {
    provider: "local",
    providerId: null,
    email
  });
}

async function getSocialLoginUser({ email, provider, providerId, allowEmailFallback = false }) {
  const normalizedProvider = String(provider || "social").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  let normalizedEmail = normalizeEmail(email);

  if (!normalizedProviderId) {
    const error = new Error("Thiếu mã tài khoản nhà cung cấp");
    error.status = 400;
    throw error;
  }

  if (!normalizedEmail && allowEmailFallback && normalizedProviderId) {
    normalizedEmail = `${normalizedProvider}_${normalizedProviderId}@foodhub.local`;
  }

  if (!normalizedEmail) {
    const error = new Error("Tài khoản social chưa cấp quyền email");
    error.status = 400;
    throw error;
  }

  const linkedUser = await findProviderUser(normalizedProvider, normalizedProviderId);

  if (linkedUser) {
    return linkedUser;
  }

  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [normalizedEmail]);

  if (users.length > 0) {
    const error = new Error("Email này da co tài khoản. Vui lòng đăng nhập bang username/password truoc, sau do vao trang tài khoản de liên kết Google hoặc Facebook.");
    error.status = 409;
    throw error;
  }

  return null;
}

async function unlinkSocialAccount(userId, provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();

  if (!["google", "facebook"].includes(normalizedProvider)) {
    const error = new Error("Nhà cung cấp social không hợp lệ");
    error.status = 400;
    throw error;
  }

  const providerCount = await getLoginProviderCount(userId);

  if (providerCount <= 1) {
    const error = new Error("Không thể huy liên kết vi tài khoản phai con it nhat mot phuong thuc đăng nhập khac");
    error.status = 400;
    throw error;
  }

  const [result] = await db.query(
    "DELETE FROM user_auth_providers WHERE user_id = ? AND provider = ?",
    [userId, normalizedProvider]
  );

  if (result.affectedRows === 0) {
    const error = new Error("Tài khoản chưa liên kết phuong thuc này");
    error.status = 404;
    throw error;
  }
}

async function listAuthProviders(userId) {
  const [accounts] = await db.query(
    `SELECT provider, provider_email, created_at
     FROM user_auth_providers
     WHERE user_id = ?
     ORDER BY FIELD(provider, 'local', 'google', 'facebook'), provider`,
    [userId]
  );

  return accounts;
}

async function getUserByLogin(login) {
  const normalizedLogin = String(login || "").trim();
  const normalizedEmail = normalizeEmail(normalizedLogin);
  const normalizedUsername = normalizeUsername(normalizedLogin);

  const [users] = await db.query(
    `SELECT *
     FROM users
     WHERE email = ? OR username = ?
     LIMIT 1`,
    [normalizedEmail, normalizedUsername]
  );

  return users[0] || null;
}

async function updatePasswordHash(userId, hashedPassword) {
  await db.query(
    "UPDATE users SET password = ?, password_set = 1 WHERE id = ?",
    [hashedPassword, userId]
  );
}

async function createLocalUser({ username, email, password, fullname }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedUsername = normalizeUsername(username);

  if (!normalizedUsername || !normalizedEmail || !password) {
    const error = new Error("Vui lòng nhập username, email va mật khẩu");
    error.status = 400;
    throw error;
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
    const error = new Error("Username chi gom chu thuong, so, dau cham, gach ngang hoặc gach duoi va từ 3-40 ky tu");
    error.status = 400;
    throw error;
  }

  const passwordError = getStrongPasswordError(password);
  if (passwordError) {
    const error = new Error(passwordError);
    error.status = 400;
    throw error;
  }
  const [oldUsers] = await db.query(
    "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
    [normalizedUsername, normalizedEmail]
  );

  if (oldUsers.length > 0) {
    const error = new Error("Username hoặc email da tồn tại");
    error.status = 400;
    throw error;
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const displayName = String(fullname || username).trim();
  const [result] = await db.query(
    `INSERT INTO users (username, fullname, email, password, password_set, email_verified)
     VALUES (?, ?, ?, ?, 1, 1)`,
    [normalizedUsername, displayName, normalizedEmail, hashedPassword]
  );

  await ensureLocalProvider(result.insertId, normalizedEmail);

  const [newUsers] = await db.query("SELECT * FROM users WHERE id = ?", [result.insertId]);

  return newUsers[0];
}

function sendAuthResponse(res, user) {
  const token = signToken(user);
  const responseUser = publicUser(user);

  res.json({
    message: "Đăng nhập thành công",
    token,
    requiresAccountSetup: responseUser.requiresAccountSetup,
    user: responseUser
  });
}

async function getGoogleProfile(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });
  const profile = await response.json();

  if (!response.ok || !profile.email) {
    const error = new Error("Không xác thực được tài khoản Google");
    error.status = 401;
    throw error;
  }

  return {
    fullname: profile.name,
    email: profile.email,
    avatar: profile.picture || null,
    provider: "google",
    providerId: profile.sub,
    allowEmailFallback: false
  };
}

async function getFacebookProfile(accessToken) {
  const url = new URL("https://graph.facebook.com/me");
  url.searchParams.set("fields", "id,name,email");
  url.searchParams.set("access_token", accessToken);

  const response = await fetch(url);
  const profile = await response.json();

  if (!response.ok || !profile.id) {
    const error = new Error("Không xác thực được tài khoản Facebook");
    error.status = 401;
    throw error;
  }

  return {
    fullname: profile.name,
    email: profile.email,
    avatar: null,
    provider: "facebook",
    providerId: profile.id,
    allowEmailFallback: true
  };
}

async function getSocialProfile(provider, accessToken) {
  if (provider === "google") {
    return getGoogleProfile(accessToken);
  }

  if (provider === "facebook") {
    return getFacebookProfile(accessToken);
  }

  const error = new Error("Nhà cung cấp social không hợp lệ");
  error.status = 400;
  throw error;
}

router.post("/register", async (req, res) => {
  res.status(410).json({
    message: "Đăng ký thu cong da tat. Vui lòng xác thực bằng Google hoặc Facebook truoc."
  });
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    if (!token) {
      return res.status(400).json({ message: "Thiếu mã xác thực" });
    }

    const [tokens] = await db.query(
      `SELECT id, user_id
       FROM email_verification_tokens
       WHERE token_hash = ?
         AND used_at IS NULL
         AND expires_at > NOW()
       LIMIT 1`,
      [hashToken(token)]
    );

    if (tokens.length === 0) {
      return res.status(400).json({ message: "Link xác thực không hợp lệ hoặc da hết hạn" });
    }

    await db.query(
      "UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = ?",
      [tokens[0].user_id]
    );
    await db.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?", [
      tokens[0].id
    ]);

    res.json({ message: "Xác thực email thành công. Bạn co the đăng nhập." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);

    if (!normalizedEmail) {
      return res.status(400).json({ message: "Vui lòng nhập email" });
    }

    const [users] = await db.query(
      "SELECT id, fullname, email_verified FROM users WHERE email = ?",
      [normalizedEmail]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy tài khoản" });
    }

    if (users[0].email_verified) {
      return res.json({ message: "Email này đã được xác thực" });
    }

    const verificationUrl = await createEmailVerification(users[0].id);
    let emailSent = false;

    try {
      emailSent = await sendVerificationEmail(normalizedEmail, users[0].fullname, verificationUrl);
    } catch (mailError) {
      console.error(mailError);
    }

    res.json({
      message: emailSent
        ? "Đã gửi lai email xác thực."
        : "Đã tạo lai link xác thực.",
      verificationUrl: shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, email, login, password } = req.body;
    const loginValue = login || username || email;

    if (!loginValue || !password) {
      return res.status(400).json({ message: "Vui lòng nhập username/email va mật khẩu" });
    }

    const user = await getUserByLogin(loginValue);

    if (!user) {
      return res.status(400).json({ message: "Username/email hoặc mật khẩu không đúng" });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: "Tài khoản đã bị khóa" });
    }

    const isMatch = user.password
      ? await bcrypt.compare(password, user.password)
      : false;

    if (!isMatch) {
      return res.status(400).json({ message: "Username/email hoặc mật khẩu không đúng" });
    }

    const isAdmin = String(user.role || "").toUpperCase() === "ADMIN";

    if (!isAdmin && !user.email_verified) {
      const verificationUrl = await createEmailVerification(user.id);
      let emailSent = false;

      try {
        emailSent = await sendVerificationEmail(user.email, user.fullname, verificationUrl);
      } catch (mailError) {
        console.error(mailError);
      }

      return res.status(403).json({
        message: emailSent
          ? "Email chưa xác thực. Minh đã gửi lai email xác thực cho ban."
          : "Email chưa xác thực. Hay bam link xác thực de kích hoạt tài khoản.",
        verificationUrl: shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
      });
    }

    sendAuthResponse(res, user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thiếu Google access token" });
    }

    const profile = await getSocialProfile("google", accessToken);
    const user = await getSocialLoginUser(profile);

    if (!user) {
      return res.status(202).json({
        message: "Da xác thực Google. Vui lòng tạo username va mật khẩu de hoàn tất tài khoản.",
        requiresAccountSetup: true,
        provider: profile.provider,
        providerEmail: profile.email,
        fullname: profile.fullname,
        avatar: profile.avatar || null
      });
    }

    sendAuthResponse(res, user);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Lỗi server" });
  }
});

router.post("/facebook", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thiếu Facebook access token" });
    }

    const profile = await getSocialProfile("facebook", accessToken);
    const user = await getSocialLoginUser(profile);

    if (!user) {
      return res.status(202).json({
        message: "Da xác thực Facebook. Vui lòng tạo username va mật khẩu de hoàn tất tài khoản.",
        requiresAccountSetup: true,
        provider: profile.provider,
        providerEmail: profile.email,
        fullname: profile.fullname,
        avatar: profile.avatar || null
      });
    }

    sendAuthResponse(res, user);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Lỗi server" });
  }
});

router.post("/social/setup/:provider", async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const { accessToken, username, fullname, password } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thiếu access token" });
    }

    const profile = await getSocialProfile(provider, accessToken);
    const existingProviderUser = await findProviderUser(profile.provider, profile.providerId);

    if (existingProviderUser) {
      return sendAuthResponse(res, existingProviderUser);
    }

    const normalizedEmail = normalizeEmail(profile.email);
    const [emailUsers] = await db.query("SELECT id FROM users WHERE email = ? LIMIT 1", [normalizedEmail]);

    if (emailUsers.length > 0) {
      return res.status(409).json({
        message: "Email này da co tài khoản. Vui lòng đăng nhập tài khoản do roi liên kết Google/Facebook trong trang tài khoản."
      });
    }

    const user = await createLocalUser({
      username,
      fullname: fullname || profile.fullname || normalizedEmail,
      email: normalizedEmail,
      password
    });

    await db.query(
      "UPDATE users SET avatar = ?, email_verified = 1, email_verified_at = COALESCE(email_verified_at, NOW()) WHERE id = ?",
      [profile.avatar || null, user.id]
    );
    await createAuthProvider(user.id, {
      provider: profile.provider,
      providerId: profile.providerId,
      email: normalizedEmail
    });

    const [users] = await db.query("SELECT * FROM users WHERE id = ?", [user.id]);
    sendAuthResponse(res, users[0]);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Lỗi server" });
  }
});

router.get("/social/accounts", requireAuth, async (req, res) => {
  try {
    const accounts = await listAuthProviders(req.user.id);

    res.json({ accounts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/social/link/:provider", requireAuth, async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thiếu access token" });
    }

    const profile = await getSocialProfile(provider, accessToken);
    await linkSocialAccount(req.user.id, profile);

    const accounts = await listAuthProviders(req.user.id);

    res.json({ message: "Liên kết tài khoản thành công", accounts });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Lỗi server" });
  }
});

router.delete("/social/unlink/:provider", requireAuth, async (req, res) => {
  try {
    await unlinkSocialAccount(req.user.id, req.params.provider);
    const accounts = await listAuthProviders(req.user.id);

    res.json({ message: "Huy liên kết tài khoản thành công", accounts });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Lỗi server" });
  }
});

router.get("/addresses", requireAuth, async (req, res) => {
  try {
    const [addresses] = await db.query(
      `SELECT id, label, receiver_name AS receiverName, phone, address, is_default AS isDefault, created_at AS createdAt
       FROM user_addresses
       WHERE user_id = ?
       ORDER BY is_default DESC, id DESC`,
      [req.user.id]
    );

    res.json({ addresses });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/addresses", requireAuth, async (req, res) => {
  try {
    const label = String(req.body.label || "Địa chỉ giao hàng").trim();
    const receiverName = String(req.body.receiverName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const address = String(req.body.address || "").trim();
    const isDefault = Boolean(req.body.isDefault);

    if (!address) {
      return res.status(400).json({ message: "Vui lòng nhập địa chỉ giao hàng" });
    }

    if (isDefault) {
      await db.query("UPDATE user_addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }

    const [existing] = await db.query("SELECT COUNT(*) AS total FROM user_addresses WHERE user_id = ?", [req.user.id]);
    const shouldDefault = isDefault || Number(existing[0]?.total || 0) === 0;

    const [result] = await db.query(
      `INSERT INTO user_addresses (user_id, label, receiver_name, phone, address, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, label || "Địa chỉ giao hàng", receiverName || null, phone || null, address, shouldDefault ? 1 : 0]
    );

    if (shouldDefault) {
      await db.query("UPDATE users SET address = ? WHERE id = ?", [address, req.user.id]);
    }

    res.status(201).json({ message: "Đã thêm địa chỉ giao hàng", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const addressId = Number(req.params.id);
    const label = String(req.body.label || "Địa chỉ giao hàng").trim();
    const receiverName = String(req.body.receiverName || "").trim();
    const phone = String(req.body.phone || "").trim();
    const address = String(req.body.address || "").trim();
    const isDefault = Boolean(req.body.isDefault);

    if (!Number.isInteger(addressId) || addressId <= 0) {
      return res.status(400).json({ message: "Ma địa chỉ không hợp lệ" });
    }

    if (!address) {
      return res.status(400).json({ message: "Vui lòng nhập địa chỉ giao hàng" });
    }

    if (isDefault) {
      await db.query("UPDATE user_addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
    }

    const [result] = await db.query(
      `UPDATE user_addresses
       SET label = ?, receiver_name = ?, phone = ?, address = ?, is_default = ?
       WHERE id = ? AND user_id = ?`,
      [label || "Địa chỉ giao hàng", receiverName || null, phone || null, address, isDefault ? 1 : 0, addressId, req.user.id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Không tìm thấy địa chỉ" });
    }

    if (isDefault) {
      await db.query("UPDATE users SET address = ? WHERE id = ?", [address, req.user.id]);
    }

    res.json({ message: "Da cập nhật địa chỉ giao hàng" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.delete("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const addressId = Number(req.params.id);

    if (!Number.isInteger(addressId) || addressId <= 0) {
      return res.status(400).json({ message: "Ma địa chỉ không hợp lệ" });
    }

    const [addresses] = await db.query(
      "SELECT id, is_default FROM user_addresses WHERE id = ? AND user_id = ?",
      [addressId, req.user.id]
    );

    if (addresses.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy địa chỉ" });
    }

    await db.query("DELETE FROM user_addresses WHERE id = ? AND user_id = ?", [addressId, req.user.id]);

    if (addresses[0].is_default) {
      const [nextAddresses] = await db.query(
        "SELECT id, address FROM user_addresses WHERE user_id = ? ORDER BY id DESC LIMIT 1",
        [req.user.id]
      );

      if (nextAddresses.length) {
        await db.query("UPDATE user_addresses SET is_default = 1 WHERE id = ?", [nextAddresses[0].id]);
        await db.query("UPDATE users SET address = ? WHERE id = ?", [nextAddresses[0].address, req.user.id]);
      } else {
        await db.query("UPDATE users SET address = NULL WHERE id = ?", [req.user.id]);
      }
    }

    res.json({ message: "Đã xóa địa chỉ giao hàng" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, username, fullname, email, avatar, phone, address, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }

    res.json({ user: users[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.put("/me", requireAuth, async (req, res) => {
  try {
    const { username, fullname, email, phone } = req.body;
    const hasAddressUpdate = Object.prototype.hasOwnProperty.call(req.body, "address");
    const address = req.body.address;
    const normalizedUsername = normalizeUsername(username);
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = String(phone || "").trim();
    const normalizedAddress = String(address || "").trim();

    if (!normalizedUsername || !fullname || !normalizedEmail) {
      return res.status(400).json({ message: "Vui lòng nhập username, họ tên va email" });
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
      return res.status(400).json({ message: "Username chi gom chu thuong, so, dau cham, gach ngang hoặc gach duoi va từ 3-40 ky tu" });
    }


    const [oldUsernames] = await db.query(
      "SELECT id FROM users WHERE username = ? AND id <> ?",
      [normalizedUsername, req.user.id]
    );

    if (oldUsernames.length > 0) {
      return res.status(400).json({ message: "Username đã được tài khoản khác sử dụng" });
    }

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [normalizedEmail, req.user.id]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email đã được tài khoản khác sử dụng" });
    }

    const [currentUsers] = await db.query("SELECT email FROM users WHERE id = ?", [req.user.id]);
    const emailChanged = normalizeEmail(currentUsers[0]?.email) !== normalizedEmail;

    const updateFields = [
      "username = ?",
      "fullname = ?",
      "email = ?",
      "phone = ?"
    ];
    const updateValues = [
      normalizedUsername,
      fullname.trim(),
      normalizedEmail,
      normalizedPhone || null
    ];

    if (hasAddressUpdate) {
      updateFields.push("address = ?");
      updateValues.push(normalizedAddress || null);
    }

    updateFields.push(
      "email_verified = CASE WHEN ? THEN 0 ELSE email_verified END",
      "email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END"
    );
    updateValues.push(emailChanged, emailChanged, req.user.id);

    await db.query(
      `UPDATE users SET ${updateFields.join(", ")} WHERE id = ?`,
      updateValues
    );

    const [users] = await db.query(
      "SELECT id, username, fullname, email, avatar, phone, address, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
      [req.user.id]
    );

    let verificationUrl;
    let emailSent = false;

    if (emailChanged) {
      verificationUrl = await createEmailVerification(req.user.id);

      try {
       emailSent = await sendVerificationEmail(normalizedEmail, fullname, verificationUrl);
      } catch (mailError) {
       console.error(mailError);
      }
    }

    res.json({
      message: emailChanged
       ? "Da cập nhật email. Vui lòng xác thực email mới."
       : "Cập nhật tài khoản thành công",
      user: users[0],
      verificationUrl: emailChanged && shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

router.post("/avatar", requireAuth, (req, res) => {
  avatarUpload.single("avatar")(req, res, async error => {
    if (error) {
      const isSizeError = error.code === "LIMIT_FILE_SIZE";
      return res.status(isSizeError ? 413 : 400).json({
        message: isSizeError
          ? "Ảnh đại diện qua lon. Vui lòng chọn anh nhỏ hơn 1.5MB."
          : error.message || "Không thể tải ảnh đại diện"
      });
    }

    try {
      if (!req.file) {
        return res.status(400).json({ message: "Vui lòng chọn ảnh đại diện" });
      }

      const avatarUrl = await saveAvatarFile(req, req.file);
      try {
        await db.query("UPDATE users SET avatar = ? WHERE id = ?", [avatarUrl, req.user.id]);
      } catch (error) {
        throw createUploadError(
          "AVATAR_DB_UPDATE_FAILED",
          error.message || "Avatar database update failed",
          error
        );
      }

      const [users] = await db.query(
        "SELECT id, username, fullname, email, avatar, phone, address, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
        [req.user.id]
      );

      return res.json({
        message: "Cập nhật ảnh đại diện thành công",
        avatar: avatarUrl,
        user: users[0]
      });
    } catch (uploadError) {
      console.error("Avatar upload failed:", {
        code: uploadError.code || "AVATAR_UPLOAD_FAILED",
        message: uploadError.message,
        cause: uploadError.cause?.message
      });
      return res.status(500).json({
        message: "Không thể lưu ảnh đại diện",
        code: uploadError.code || "AVATAR_UPLOAD_FAILED",
        detail: uploadError.message
      });
    }
  });
});

router.get("/password-captcha", requireAuth, async (req, res) => {
  cleanupPasswordCaptchas();

  const nextAvailableAt = passwordCaptchaCooldownStore.get(req.user.id) || 0;
  const waitMs = nextAvailableAt - Date.now();

  if (waitMs > 0) {
    return res.status(429).json({
      message: `Vui lòng doi ${Math.ceil(waitMs / 1000)} giay de xin mã mới`,
      retryAfterSeconds: Math.ceil(waitMs / 1000)
    });
  }

  const id = crypto.randomBytes(16).toString("hex");
  const code = createPasswordCaptchaCode();

  passwordCaptchaStore.set(id, {
    userId: req.user.id,
    code: code.toLowerCase(),
    expiresAt: Date.now() + PASSWORD_CAPTCHA_TTL_MS
  });
  passwordCaptchaCooldownStore.set(req.user.id, Date.now() + PASSWORD_CAPTCHA_COOLDOWN_MS);

  res.json({
    id,
    code,
    expiresInSeconds: PASSWORD_CAPTCHA_TTL_MS / 1000,
    cooldownSeconds: PASSWORD_CAPTCHA_COOLDOWN_MS / 1000
  });
});

router.put("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword, captchaAnswer, captchaId } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "Vui lòng nhập mật khẩu mới" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Mật khẩu mới nhập lai không khớp" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Mật khẩu mới tối thiểu 6 ky tu" });
    }

    const [users] = await db.query(
      "SELECT id, email, password, password_set FROM users WHERE id = ? LIMIT 1",
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "Không tìm thấy người dùng" });
    }

    const hasPasswordSet = Boolean(users[0].password_set) && Boolean(users[0].password);

    if (hasPasswordSet && !currentPassword) {
      return res.status(400).json({ message: "Vui lòng nhập mật khẩu hiện tại" });
    }

    const isMatch = hasPasswordSet
      ? await bcrypt.compare(currentPassword, users[0].password)
      : true;

    if (!isMatch) {
      return res.status(400).json({ message: "Mật khẩu hiện tại không đúng" });
    }

    cleanupPasswordCaptchas();
    const normalizedCaptchaId = String(captchaId || "");
    const captcha = passwordCaptchaStore.get(normalizedCaptchaId);

    if (
      !captcha
      || captcha.userId !== req.user.id
      || !captchaAnswer
      || String(captchaAnswer).trim().toLowerCase() !== captcha.code
    ) {
      passwordCaptchaStore.delete(normalizedCaptchaId);
      return res.status(400).json({ message: "Ma captcha không đúng" });
    }

    passwordCaptchaStore.delete(normalizedCaptchaId);

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await updatePasswordHash(req.user.id, hashedPassword);
    await ensureLocalProvider(req.user.id, users[0].email);

    res.json({ message: hasPasswordSet ? "Doi mật khẩu thành công" : "Tạo mật khẩu đăng nhập thành công" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Lỗi server" });
  }
});

module.exports = router;
