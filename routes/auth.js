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
  return {
    id: user.id,
    fullname: user.fullname,
    email: user.email,
    role: user.role,
    emailVerified: Boolean(user.email_verified),
    passwordSet: Boolean(user.password_set ?? true)
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
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedEmail = normalizeEmail(email);

  const [linkedAccounts] = await db.query(
    "SELECT user_id FROM social_accounts WHERE provider = ? AND provider_user_id = ?",
    [normalizedProvider, providerId]
  );

  if (linkedAccounts.length > 0 && Number(linkedAccounts[0].user_id) !== Number(userId)) {
    const error = new Error("Tai khoan social nay da lien ket voi tai khoan khac");
    error.status = 400;
    throw error;
  }

  if (normalizedProvider === "google" && normalizedEmail) {
    const [emailUsers] = await db.query(
      "SELECT id FROM users WHERE email = ? AND id <> ?",
      [normalizedEmail, userId]
    );

    if (emailUsers.length > 0) {
      const error = new Error("Email Google nay da thuoc tai khoan khac");
      error.status = 400;
      throw error;
    }
  }

  await db.query(
    `INSERT INTO social_accounts (user_id, provider, provider_user_id, provider_email, provider_name)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       user_id = VALUES(user_id),
       provider_user_id = VALUES(provider_user_id),
       provider_email = VALUES(provider_email),
       provider_name = VALUES(provider_name)`,
    [userId, normalizedProvider, providerId, normalizedEmail || null, fullname || null]
  );

  if (normalizedProvider === "google" && normalizedEmail) {
    await db.query(
      `UPDATE users
       SET email = ?,
           fullname = ?,
           email_verified = 1,
           email_verified_at = COALESCE(email_verified_at, NOW())
       WHERE id = ?`,
      [normalizedEmail, String(fullname || normalizedEmail).trim(), userId]
    );
  } else if (fullname) {
    await db.query("UPDATE users SET fullname = ? WHERE id = ?", [
      String(fullname).trim(),
      userId
    ]);
  }
}

async function getOrCreateSocialUser({ fullname, email, provider, providerId, allowEmailFallback = false }) {
  const normalizedProvider = String(provider || "social").trim().toLowerCase();
  const normalizedProviderId = String(providerId || "").trim();
  let normalizedEmail = normalizeEmail(email);

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
    if (normalizedProvider === "google" && normalizedEmail) {
      await linkSocialAccount(linkedUser.id, {
        fullname,
        email: normalizedEmail,
        provider: normalizedProvider,
        providerId: normalizedProviderId
      });

      const [users] = await db.query("SELECT * FROM users WHERE id = ?", [linkedUser.id]);
      return users[0];
    }

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

    const [updatedUsers] = await db.query("SELECT * FROM users WHERE id = ?", [users[0].id]);
    return updatedUsers[0];
  }

  const fallbackPassword = await bcrypt.hash(`${normalizedProvider}:${normalizedProviderId}:${Date.now()}`, 10);
  const isVerifiedSocialEmail = normalizedProvider === "google";
  const [result] = await db.query(
    `INSERT INTO users (fullname, email, password, password_set, email_verified, email_verified_at)
     VALUES (?, ?, ?, 0, ?, ${isVerifiedSocialEmail ? "NOW()" : "NULL"})`,
    [
      String(fullname || normalizedEmail).trim(),
      normalizedEmail,
      fallbackPassword,
      isVerifiedSocialEmail ? 1 : 0
    ]
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
    const normalizedEmail = normalizeEmail(email);

    if (!fullname || !normalizedEmail || !password) {
      return res.status(400).json({ message: "Vui long nhap day du thong tin" });
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
      "INSERT INTO users (fullname, email, password, email_verified) VALUES (?, ?, ?, 0)",
      [fullname.trim(), normalizedEmail, hashedPassword]
    );

    const verificationUrl = await createEmailVerification(result.insertId);
    let emailSent = false;

    try {
      emailSent = await sendVerificationEmail(normalizedEmail, fullname, verificationUrl);
    } catch (mailError) {
      console.error(mailError);
    }

    res.status(201).json({
      message: emailSent
        ? "Dang ky thanh cong. Vui long kiem tra email de xac thuc tai khoan."
        : "Dang ky thanh cong. Hay bam link xac thuc de kich hoat tai khoan.",
      verificationUrl: shouldExposeVerificationUrl(emailSent) ? verificationUrl : undefined
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
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

    if (!user.is_active) {
      return res.status(403).json({ message: "Tai khoan da bi khoa" });
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ message: "Email hoac mat khau khong dung" });
    }

    if (!user.email_verified) {
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
      "SELECT id, fullname, email, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
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
    const normalizedEmail = normalizeEmail(email);

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

    const [currentUsers] = await db.query("SELECT email FROM users WHERE id = ?", [req.user.id]);
    const emailChanged = normalizeEmail(currentUsers[0]?.email) !== normalizedEmail;

    await db.query(
      `UPDATE users
       SET fullname = ?,
           email = ?,
           email_verified = CASE WHEN ? THEN 0 ELSE email_verified END,
           email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END
       WHERE id = ?`,
      [fullname.trim(), normalizedEmail, emailChanged, emailChanged, req.user.id]
    );

    const [users] = await db.query(
      "SELECT id, fullname, email, role, email_verified AS emailVerified, password_set AS passwordSet, created_at FROM users WHERE id = ?",
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
    const { currentPassword, newPassword } = req.body;

    if (!newPassword) {
      return res.status(400).json({ message: "Vui long nhap mat khau moi" });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Mat khau moi toi thieu 6 ky tu" });
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

    await db.query("UPDATE users SET password = ?, password_set = 1 WHERE id = ?", [
      hashedPassword,
      req.user.id
    ]);

    res.json({ message: hasPasswordSet ? "Doi mat khau thanh cong" : "Tao mat khau dang nhap thanh cong" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Loi server" });
  }
});

module.exports = router;
