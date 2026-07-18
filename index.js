require("dotenv").config();

const express = require("express");
const cors = require("cors");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGIN || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const allowedPreviewSuffixes = (process.env.CORS_PREVIEW_SUFFIX || ".food-shop-b0p.pages.dev")
  .split(",")
  .map(suffix => suffix.trim())
  .filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
    return true;
  }

  try {
    const { hostname, protocol } = new URL(origin);

    return protocol === "https:" && allowedPreviewSuffixes.some(suffix => (
      hostname.endsWith(suffix) && hostname !== suffix.slice(1)
    ));
  } catch (error) {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error("Origin is not allowed by CORS"));
  }
}));
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true, limit: "8mb" }));

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      message: "Anh qua lon. Vui long chon anh nho hon 1.5MB."
    });
  }

  return next(error);
});

app.use("/api/foods", require("./routes/foods"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/announcements", require("./routes/announcements"));
app.use("/api/admin", require("./routes/admin"));

app.get("/", (req, res) => {
  res.send("FoodHub API dang chay");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "foodhub-api"
  });
});

async function ensureSchema() {
  try {
    await db.query("ALTER TABLE announcements ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL");
    console.log("Added announcements.expires_at column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Schema check failed:", error.message);
    }
  }
}

ensureSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
