const express = require("express");
const bcrypt = require("bcryptjs");
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
  return {
    id: user.id,
    fullname: user.fullname,
    email: user.email,
    role: user.role
  };
}

async function findSocialUser(provider, providerId) {
  const [accounts] = await db.query(
    `SELECT users.*
     FROM social_accounts
     JOIN users ON users.id = social_accounts.user_id
     WHERE social_accounts.provider = ? AND social_accounts.provider_user_id = ?`,
    [provider, providerId]
  );

  return accounts[0] || null;
}

async function linkSocialAccount(userId, { fullname, email, provider, providerId }) {
  const [linkedAccounts] = await db.query(
    "SELECT user_id FROM social_accounts WHERE provider = ? AND provider_user_id = ?",
    [provider, providerId]
  );

  if (linkedAccounts.length > 0 && Number(linkedAccounts[0].user_id) !== Number(userId)) {
    const error = new Error("Tai khoan social nay da lien ket voi tai khoan khac");
    error.status = 400;
    throw error;
  }

  await db.query(
    `INSERT INTO social_accounts (user_id, provider, provider_user_id, provider_email, provider_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       provider_user_id = VALUES(provider_user_id),
       provider_email = VALUES(provider_email),
       provider_name = VALUES(provider_name)`,
    [userId, provider, providerId, email || null, fullname || null]
  );
}

async function getOrCreateSocialUser({ fullname, email, provider, providerId, allowEmailFallback = false }) {
  const normalizedProvider = String(provider || "social").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  let normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail && allowEmailFallback && normalizedProviderId) {
    normalizedEmail = `${normalizedProvider}_${normalizedProviderId}@foodhub.local`;
  }

  if (!normalizedEmail) {
    const error = new Error("Tai khoan social chua cap quyen email");
    error.status = 400;
    throw error;
  }

  const linkedUser = await findSocialUser(normalizedProvider, normalizedProviderId);

  if (linkedUser) {
    return linkedUser;
  }

  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [normalizedEmail]);

  if (users.length > 0) {
    await linkSocialAccount(users[0].id, {
      fullname,
      email: normalizedEmail,
      provider: normalizedProvider,
      providerId: normalizedProviderId
    });
    return users[0];
  }

  const fallbackPassword = await bcrypt.hash(`${normalizedProvider}:${normalizedProviderId}:${Date.now()}`, 10);
  const [result] = await db.query(
    "INSERT INTO users (fullname, email, password) VALUES (?, ?, ?)",
    [String(fullname || normalizedEmail).trim(), normalizedEmail, fallbackPassword]
  );

  const [newUsers] = await db.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  await linkSocialAccount(result.insertId, {
    fullname,
    email: normalizedEmail,
    provider: normalizedProvider,
    providerId: normalizedProviderId
  });
  return newUsers[0];
}

function sendAuthResponse(res, user) {
  const token = signToken(user);

  res.json({
    message: "Dang nhap thanh cong",
    token,
    user: {
      ...publicUser(user)
    }
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
  try {
    const { fullname, email, password } = req.body;

    if (!fullname || !email || !password) {
      return res.status(400).json({ message: "Vui long nhap day du thong tin" });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: "Mat khau toi thieu 6 ky tu" });
    }

    const [oldUsers] = await db.query("SELECT id FROM users WHERE email = ?", [email]);

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email da ton tai" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    await db.query(
      "INSERT INTO users (fullname, email, password) VALUES (?, ?, ?)",
      [fullname.trim(), email.trim().toLowerCase(), hashedPassword]
    );

    res.status(201).json({ message: "Dang ky thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Vui long nhap email va mat khau" });
    }

    const [users] = await db.query("SELECT * FROM users WHERE email = ?", [
      email.trim().toLowerCase()
    ]);

    if (users.length === 0) {
      return res.status(400).json({ message: "Email hoac mat khau khong dung" });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Email hoac mat khau khong dung" });
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
    const user = await getOrCreateSocialUser(profile);

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
    const user = await getOrCreateSocialUser(profile);

    sendAuthResponse(res, user);
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.get("/social/accounts", requireAuth, async (req, res) => {
  try {
    const [accounts] = await db.query(
      "SELECT provider, provider_email, provider_name, created_at FROM social_accounts WHERE user_id = ? ORDER BY provider",
      [req.user.id]
    );

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

    const [accounts] = await db.query(
      "SELECT provider, provider_email, provider_name, created_at FROM social_accounts WHERE user_id = ? ORDER BY provider",
      [req.user.id]
    );

    res.json({ message: "Lien ket tai khoan thanh cong", accounts });
  } catch (error) {
    console.error(error);
    res.status(error.status || 500).json({ message: error.message || "Loi server" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [users] = await db.query(
      "SELECT id, fullname, email, role, created_at FROM users WHERE id = ?",
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
    const { fullname, email } = req.body;
    const normalizedEmail = String(email || "").trim().toLowerCase();

    if (!fullname || !normalizedEmail) {
      return res.status(400).json({ message: "Vui long nhap ho ten va email" });
    }

    const [oldUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [normalizedEmail, req.user.id]
    );

    if (oldUsers.length > 0) {
      return res.status(400).json({ message: "Email da duoc tai khoan khac su dung" });
    }

    await db.query(
      "UPDATE users SET fullname = ?, email = ? WHERE id = ?",
      [fullname.trim(), normalizedEmail, req.user.id]
    );

    const [users] = await db.query(
      "SELECT id, fullname, email, role, created_at FROM users WHERE id = ?",
      [req.user.id]
    );

    res.json({ message: "Cap nhat tai khoan thanh cong", user: users[0] });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

router.put("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Vui long nhap day du mat khau" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Mat khau moi toi thieu 6 ky tu" });
    }

    const [users] = await db.query("SELECT * FROM users WHERE id = ?", [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({ message: "Khong tim thay nguoi dung" });
    }

    const isMatch = await bcrypt.compare(currentPassword, users[0].password);

    if (!isMatch) {
      return res.status(400).json({ message: "Mat khau hien tai khong dung" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await db.query("UPDATE users SET password = ? WHERE id = ?", [
      hashedPassword,
      req.user.id
    ]);

    res.json({ message: "Doi mat khau thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
