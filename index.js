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
app.use("/api/advertisements", require("./routes/advertisements"));
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

  try {
    await db.query("ALTER TABLE foods ADD COLUMN stock_quantity INT NOT NULL DEFAULT 0");
    console.log("Added foods.stock_quantity column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Food stock schema check failed:", error.message);
    }
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS discounts (
        id INT NOT NULL AUTO_INCREMENT,
        code VARCHAR(40) NOT NULL,
        name VARCHAR(150) NOT NULL,
        discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
        discount_value INT NOT NULL,
        min_order INT NOT NULL DEFAULT 0,
        max_discount INT DEFAULT NULL,
        usage_limit INT DEFAULT NULL,
        used_count INT NOT NULL DEFAULT 0,
        starts_at TIMESTAMP NULL DEFAULT NULL,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY discount_code (code)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
      INSERT IGNORE INTO discounts
        (id, code, name, discount_type, discount_value, min_order, max_discount, usage_limit, is_active)
      VALUES
        (1, 'FOODHUB10', 'Giam 10% cho don tu 100.000d', 'percent', 10, 100000, 30000, 100, 1),
        (2, 'FREESHIP20', 'Giam 20.000d cho don tu 150.000d', 'fixed', 20000, 150000, NULL, NULL, 1)
    `);
  } catch (error) {
    console.error("Discount schema check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS advertisements (
        id INT NOT NULL AUTO_INCREMENT,
        title VARCHAR(150) NOT NULL,
        image LONGTEXT NOT NULL,
        link_url VARCHAR(500) DEFAULT NULL,
        position VARCHAR(20) NOT NULL DEFAULT 'both',
        sort_order INT NOT NULL DEFAULT 0,
        starts_at TIMESTAMP NULL DEFAULT NULL,
        expires_at TIMESTAMP NULL DEFAULT NULL,
        is_active TINYINT DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY advertisement_active (is_active),
        KEY advertisement_position (position)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query("ALTER TABLE advertisements MODIFY image LONGTEXT NOT NULL");
  } catch (error) {
    console.error("Advertisement schema check failed:", error.message);
  }
}

ensureSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
