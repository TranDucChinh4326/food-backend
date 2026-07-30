const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const db = require("../db");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "foodhub_dev_secret_change_me";

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
    requiresAccountSetup: !isAdmin && (!hasPassword || !username)
  };
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

function normalizeUsername(username) {
  return String(username || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function shouldExposeVerificationUrl(emailSent) {
  return !emailSent || process.env.EMAIL_DEBUG_LINK === "true";
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
      subject: "Xac thuc tai khoan FoodHub",
      html: `
        <p>Chao ${String(fullname || "ban")},</p>
        <p>Bam vao lien ket ben duoi de xac thuc tai khoan FoodHub:</p>
        <p><a href="${verificationUrl}">${verificationUrl}</a></p>
        <p>Lien ket het han sau 30 phut.</p>
      `
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Khong gui duoc email xac thuc: ${errorBody}`);
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
    const error = new Error("Phuong thuc dang nhap khong hop le");
    error.status = 400;
    throw error;
  }

  if (normalizedProvider !== "local" && !normalizedProviderId) {
    const error = new Error("Thieu ma tai khoan nha cung cap");
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
    const error = new Error("Nha cung cap social khong hop le");
    error.status = 400;
    throw error;
  }

  const [linkedAccounts] = await db.query(
    "SELECT user_id FROM user_auth_providers WHERE provider = ? AND provider_user_id = ? LIMIT 1",
    [normalizedProvider, normalizedProviderId]
  );

  if (linkedAccounts.length > 0 && Number(linkedAccounts[0].user_id) !== Number(userId)) {
    const error = new Error("Tai khoan Google/Facebook nay da lien ket voi tai khoan khac");
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
    const error = new Error("Thieu ma tai khoan nha cung cap");
    error.status = 400;
    throw error;
  }

  if (!normalizedEmail && allowEmailFallback && normalizedProviderId) {
    normalizedEmail = `${normalizedProvider}_${normalizedProviderId}@foodhub.local`;
  }

  if (!normalizedEmail) {
    const error = new Error("Tai khoan social chua cap quyen email");
    error.status = 400;
    throw error;
  }

  const linkedUser = await findProviderUser(normalizedProvider, normalizedProviderId);

  if (linkedUser) {
    return linkedUser;
  }

  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [normalizedEmail]);

  if (users.length > 0) {
    const error = new Error("Email nay da co tai khoan. Vui long dang nhap bang username/password truoc, sau do vao trang tai khoan de lien ket Google hoac Facebook.");
    error.status = 409;
    throw error;
  }

  return null;
}

async function unlinkSocialAccount(userId, provider) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();

  if (!["google", "facebook"].includes(normalizedProvider)) {
    const error = new Error("Nha cung cap social khong hop le");
    error.status = 400;
    throw error;
  }

  const providerCount = await getLoginProviderCount(userId);

  if (providerCount <= 1) {
    const error = new Error("Khong the huy lien ket vi tai khoan phai con it nhat mot phuong thuc dang nhap khac");
    error.status = 400;
    throw error;
  }

  const [result] = await db.query(
    "DELETE FROM user_auth_providers WHERE user_id = ? AND provider = ?",
    [userId, normalizedProvider]
  );

  if (result.affectedRows === 0) {
    const error = new Error("Tai khoan chua lien ket phuong thuc nay");
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
    const error = new Error("Vui long nhap username, email va mat khau");
    error.status = 400;
    throw error;
  }

  if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
    const error = new Error("Username chi gom chu thuong, so, dau cham, gach ngang hoac gach duoi va tu 3-40 ky tu");
    error.status = 400;
    throw error;
  }

  if (password.length < 6) {
    const error = new Error("Mat khau toi thieu 6 ky tu");
    error.status = 400;
    throw error;
  }

  const [oldUsers] = await db.query(
    "SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1",
    [normalizedUsername, normalizedEmail]
  );

  if (oldUsers.length > 0) {
    const error = new Error("Username hoac email da ton tai");
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
    message: "Dang nhap thanh cong",
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
    const error = new Error("Khong xac thuc duoc tai khoan Google");
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
    const error = new Error("Khong xac thuc duoc tai khoan Facebook");
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

  const error = new Error("Nha cung cap social khong hop le");
  error.status = 400;
  throw error;
}

router.post("/register", async (req, res) => {
  res.status(410).json({
    message: "Dang ky thu cong da tat. Vui long xac thuc bang Google hoac Facebook truoc."
  });
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();

    if (!token) {
      return res.status(400).json({ message: "Thieu ma xac thuc" });
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
      return res.status(400).json({ message: "Link xac thuc khong hop le hoac da het han" });
    }

    await db.query(
      "UPDATE users SET email_verified = 1, email_verified_at = NOW() WHERE id = ?",
      [tokens[0].user_id]
    );
    await db.query("UPDATE email_verification_tokens SET used_at = NOW() WHERE id = ?", [
      tokens[0].id
    ]);

    res.json({ message: "Xac thuc email thanh cong. Ban co the dang nhap." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/resend-verification", async (req, res) => {
  try {
    const normalizedEmail = normalizeEmail(req.body.email);

    if (!normalizedEmail) {
      return res.status(400).json({ message: "Vui long nhap email" });
    }

    const [users] = await db.query(
      "SELECT id, fullname, email_verified FROM users WHERE email = ?",
      [normalizedEmail]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "Khong tim thay tai khoan" });
    }

    if (users[0].email_verified) {
      return res.json({ message: "Email nay da duoc xac thuc" });
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
        ? "Da gui lai email xac thuc."
        : "Da tao lai link xac thuc.",
      verificationUrl: shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { username, email, login, password } = req.body;
    const loginValue = login || username || email;

    if (!loginValue || !password) {
      return res.status(400).json({ message: "Vui long nhap username/email va mat khau" });
    }

    const user = await getUserByLogin(loginValue);

    if (!user) {
      return res.status(400).json({ message: "Username/email hoac mat khau khong dung" });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: "Tai khoan da bi khoa" });
    }

    const isMatch = user.password
      ? await bcrypt.compare(password, user.password)
      : false;

    if (!isMatch) {
      return res.status(400).json({ message: "Username/email hoac mat khau khong dung" });
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
          ? "Email chua xac thuc. Minh da gui lai email xac thuc cho ban."
          : "Email chua xac thuc. Hay bam link xac thuc de kich hoat tai khoan.",
        verificationUrl: shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
      });
    }

    sendAuthResponse(res, user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/google", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thieu Google access token" });
    }

    const profile = await getSocialProfile("google", accessToken);
    const user = await getSocialLoginUser(profile);

    if (!user) {
      return res.status(202).json({
        message: "Da xac thuc Google. Vui long tao username va mat khau de hoan tat tai khoan.",
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
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.post("/facebook", async (req, res) => {
  try {
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thieu Facebook access token" });
    }

    const profile = await getSocialProfile("facebook", accessToken);
    const user = await getSocialLoginUser(profile);

    if (!user) {
      return res.status(202).json({
        message: "Da xac thuc Facebook. Vui long tao username va mat khau de hoan tat tai khoan.",
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
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.post("/social/setup/:provider", async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const { accessToken, username, fullname, password } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thieu access token" });
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
        message: "Email nay da co tai khoan. Vui long dang nhap tai khoan do roi lien ket Google/Facebook trong trang tai khoan."
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
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.get("/social/accounts", requireAuth, async (req, res) => {
  try {
    const accounts = await listAuthProviders(req.user.id);

    res.json({ accounts });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/social/link/:provider", requireAuth, async (req, res) => {
  try {
    const provider = String(req.params.provider || "").toLowerCase();
    const { accessToken } = req.body;

    if (!accessToken) {
      return res.status(400).json({ message: "Thieu access token" });
    }

    const profile = await getSocialProfile(provider, accessToken);
    await linkSocialAccount(req.user.id, profile);

    const accounts = await listAuthProviders(req.user.id);

    res.json({ message: "Lien ket tai khoan thanh cong", accounts });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.delete("/social/unlink/:provider", requireAuth, async (req, res) => {
  try {
    await unlinkSocialAccount(req.user.id, req.params.provider);
    const accounts = await listAuthProviders(req.user.id);

    res.json({ message: "Huy lien ket tai khoan thanh cong", accounts });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
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
    res.status(500).json({ message: "Loi server" });
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
      return res.status(400).json({ message: "Vui long nhap dia chi giao hang" });
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

    res.status(201).json({ message: "Da them dia chi giao hang", id: result.insertId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
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
      return res.status(400).json({ message: "Ma dia chi khong hop le" });
    }

    if (!address) {
      return res.status(400).json({ message: "Vui long nhap dia chi giao hang" });
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
      return res.status(404).json({ message: "Khong tim thay dia chi" });
    }

    if (isDefault) {
      await db.query("UPDATE users SET address = ? WHERE id = ?", [address, req.user.id]);
    }

    res.json({ message: "Da cap nhat dia chi giao hang" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.delete("/addresses/:id", requireAuth, async (req, res) => {
  try {
    const addressId = Number(req.params.id);

    if (!Number.isInteger(addressId) || addressId <= 0) {
      return res.status(400).json({ message: "Ma dia chi khong hop le" });
    }

    const [addresses] = await db.query(
      "SELECT id, is_default FROM user_addresses WHERE id = ? AND user_id = ?",
      [addressId, req.user.id]
    );

    if (addresses.length === 0) {
      return res.status(404).json({ message: "Khong tim thay dia chi" });
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

    res.json({ message: "Da xoa dia chi giao hang" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, username, fullname, email, avatar, phone, address, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
      [req.user.id]
    );

    if (users.length === 0) {
      return res.status(404).json({ message: "Khong tim thay nguoi dung" });
    }

    res.json({ user: users[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/me", requireAuth, async (req, res) => {
  try {
    const { username, fullname, email, phone, avatar } = req.body;
    const hasAddressUpdate = Object.prototype.hasOwnProperty.call(req.body, "address");
    const address = req.body.address;
    const normalizedUsername = normalizeUsername(username);
    const normalizedEmail = normalizeEmail(email);
    const normalizedPhone = String(phone || "").trim();
    const normalizedAddress = String(address || "").trim();
    const normalizedAvatar = String(avatar || "").trim();

    if (!normalizedUsername || !fullname || !normalizedEmail) {
      return res.status(400).json({ message: "Vui long nhap username, ho ten va email" });
    }

    if (!/^[a-z0-9._-]{3,40}$/.test(normalizedUsername)) {
      return res.status(400).json({ message: "Username chi gom chu thuong, so, dau cham, gach ngang hoac gach duoi va tu 3-40 ky tu" });
    }

    if (normalizedAvatar && normalizedAvatar.length > 500000) {
      return res.status(413).json({ message: "Anh dai dien qua lon. Vui long chon anh nho hon." });
    }

    const [oldUsernames] = await db.query(
      "SELECT id FROM users WHERE username = ? AND id <> ?",
      [normalizedUsername, req.user.id]
    );

    if (oldUsernames.length > 0) {
      return res.status(400).json({ message: "Username da duoc tai khoan khac su dung" });
    }

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [normalizedEmail, req.user.id]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email da duoc tai khoan khac su dung" });
    }

    const [currentUsers] = await db.query("SELECT email FROM users WHERE id = ?", [req.user.id]);
    const emailChanged = normalizeEmail(currentUsers[0]?.email) !== normalizedEmail;

    const updateFields = [
      "username = ?",
      "fullname = ?",
      "email = ?",
      "avatar = ?",
      "phone = ?"
    ];
    const updateValues = [
      normalizedUsername,
      fullname.trim(),
      normalizedEmail,
      normalizedAvatar || null,
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
       ? "Da cap nhat email. Vui long xac thuc email moi."
       : "Cap nhat tai khoan thanh cong",
      user: users[0],
      verificationUrl: emailChanged && shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword, captchaAnswer, captchaExpected } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "Vui long nhap mat khau moi" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ message: "Mat khau moi nhap lai khong khop" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Mat khau moi toi thieu 6 ky tu" });
    }

    if (
      !captchaAnswer
      || !captchaExpected
      || String(captchaAnswer).trim().toLowerCase() !== String(captchaExpected).trim().toLowerCase()
    ) {
      return res.status(400).json({ message: "Ma captcha khong dung" });
    }

    const [users] = await db.query("SELECT * FROM users WHERE id = ?", [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({ message: "Khong tim thay nguoi dung" });
    }

    const hasPasswordSet = Boolean(users[0].password_set ?? true);

    if (hasPasswordSet && !currentPassword) {
      return res.status(400).json({ message: "Vui long nhap mat khau hien tai" });
    }

    const isMatch = hasPasswordSet
      ? await bcrypt.compare(currentPassword, users[0].password)
      : true;

    if (!isMatch) {
      return res.status(400).json({ message: "Mat khau hien tai khong dung" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await updatePasswordHash(req.user.id, hashedPassword);
    await ensureLocalProvider(req.user.id, users[0].email);

    res.json({ message: hasPasswordSet ? "Doi mat khau thanh cong" : "Tao mat khau dang nhap thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
