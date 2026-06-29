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

async function getOrCreateSocialUser({ fullname, email, provider, providerId }) {
  const normalizedEmail = String(email || "").trim().toLowerCase();

  if (!normalizedEmail) {
    const error = new Error("Tai khoan social chua cap quyen email");
    error.status = 400;
    throw error;
  }

  const [users] = await db.query("SELECT * FROM users WHERE email = ?", [normalizedEmail]);

  if (users.length > 0) {
    return users[0];
  }

  const fallbackPassword = await bcrypt.hash(`${provider}:${providerId}:${Date.now()}`, 10);
  const [result] = await db.query(
    "INSERT INTO users (fullname, email, password) VALUES (?, ?, ?)",
    [String(fullname || normalizedEmail).trim(), normalizedEmail, fallbackPassword]
  );

  const [newUsers] = await db.query("SELECT * FROM users WHERE id = ?", [result.insertId]);
  return newUsers[0];
}

function sendAuthResponse(res, user) {
  const token = signToken(user);

  res.json({
    message: "Dang nhap thanh cong",
    token,
    user: {
      id: user.id,
      fullname: user.fullname,
      email: user.email,
      role: user.role
    }
  });
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

    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    });
    const profile = await response.json();

    if (!response.ok || !profile.email) {
      return res.status(401).json({ message: "Khong xac thuc duoc tai khoan Google" });
    }

    const user = await getOrCreateSocialUser({
      fullname: profile.name,
      email: profile.email,
      provider: "google",
      providerId: profile.sub
    });

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

    const url = new URL("https://graph.facebook.com/me");
    url.searchParams.set("fields", "id,name,email");
    url.searchParams.set("access_token", accessToken);

    const response = await fetch(url);
    const profile = await response.json();

    if (!response.ok || !profile.email) {
      return res.status(401).json({ message: "Khong xac thuc duoc tai khoan Facebook hoac chua cap quyen email" });
    }

    const user = await getOrCreateSocialUser({
      fullname: profile.name,
      email: profile.email,
      provider: "facebook",
      providerId: profile.id
    });

    sendAuthResponse(res, user);
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

module.exports = router;
