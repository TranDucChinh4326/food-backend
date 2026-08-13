require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const db = require("./db");

const app = express();
const PORT = process.env.PORT || 3000;
app.set("trust proxy", 1);
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
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

app.use((error, req, res, next) => {
  if (error?.type === "entity.too.large") {
    return res.status(413).json({
      message: "Ảnh quá lớn. Vui lòng chọn anh nhỏ hơn 1.5MB."
    });
  }

  return next(error);
});

app.use("/api/foods", require("./routes/foods"));
app.use("/api/auth", require("./routes/auth"));
app.use("/api/orders", require("./routes/orders"));
app.use("/api/announcements", require("./routes/announcements"));
app.use("/api/advertisements", require("./routes/advertisements"));
app.use("/api/feedback", require("./routes/feedback"));
app.use("/api/food-reviews", require("./routes/food-reviews"));
app.use("/api/payments", require("./routes/payments"));
app.use("/api/admin", require("./routes/admin"));

app.get("/", (req, res) => {
  res.send("FoodHub API đang chạy");
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "foodhub-api"
  });
});

async function ensureColumn(table, column, sql) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS found
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?`,
    [table, column]
  );

  if (Number(rows[0]?.found || 0) === 0) {
    await db.query(sql);
  }
}

async function ensureIndex(table, indexName, sql) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS found
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?`,
    [table, indexName]
  );

  if (Number(rows[0]?.found || 0) === 0) {
    await db.query(sql);
  }
}

async function ensureForeignKey(table, constraintName, sql) {
  const [rows] = await db.query(
    `SELECT COUNT(*) AS found
     FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND CONSTRAINT_NAME = ?`,
    [table, constraintName]
  );

  if (Number(rows[0]?.found || 0) === 0) {
    await db.query(sql);
  }
}

async function ensureSchema() {
  try {
    await db.query("ALTER TABLE announcements ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL");
    console.log("Added announcements.expires_at column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE foods ADD COLUMN stock_quantity INT NOT NULL DEFAULT 0");
    console.log("Added foods.stock_quantity column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Food stock schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users ADD COLUMN phone VARCHAR(20) DEFAULT NULL");
    console.log("Added users.phone column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("User contact schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users ADD COLUMN address VARCHAR(255) DEFAULT NULL");
    console.log("Added users.address column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("User address schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users ADD COLUMN username VARCHAR(80) DEFAULT NULL");
    console.log("Added users.username column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("User username schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users ADD UNIQUE KEY username (username)");
    console.log("Added users.username unique key");
  } catch (error) {
    if (error.code !== "ER_DUP_KEYNAME") {
      console.error("User username index check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users ADD COLUMN avatar VARCHAR(1000) DEFAULT NULL");
    console.log("Added users.avatar column");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("User avatar schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users MODIFY avatar VARCHAR(1000) DEFAULT NULL");
  } catch (error) {
    console.error("User avatar type check failed:", error.message);
  }

  try {
    await db.query("ALTER TABLE users DROP COLUMN full_name");
    console.log("Dropped duplicate users.full_name column");
  } catch (error) {
    if (error.code !== "ER_CANT_DROP_FIELD_OR_KEY") {
      console.error("User full_name cleanup failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE users DROP COLUMN password_hash");
    console.log("Dropped duplicate users.password_hash column");
  } catch (error) {
    if (error.code !== "ER_CANT_DROP_FIELD_OR_KEY") {
      console.error("User password_hash cleanup failed:", error.message);
    }
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_auth_providers (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        provider VARCHAR(30) NOT NULL,
        provider_user_id VARCHAR(150) DEFAULT NULL,
        provider_email VARCHAR(150) DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY provider_identity (provider, provider_user_id),
        UNIQUE KEY user_provider (user_id, provider),
        KEY user_id (user_id),
        CONSTRAINT user_auth_providers_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query(`
      INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
      SELECT id, 'local', NULL, email
      FROM users
      WHERE password_set = 1
    `);
    await db.query(`
      INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
      SELECT user_id, provider, provider_user_id, provider_email
      FROM social_accounts
      WHERE provider IN ('google', 'facebook')
    `);
  } catch (error) {
    console.error("Auth provider schemã check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_addresses (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        label VARCHAR(80) NOT NULL DEFAULT 'Địa chỉ giao hàng',
        receiver_name VARCHAR(150) DEFAULT NULL,
        phone VARCHAR(20) DEFAULT NULL,
        address VARCHAR(255) NOT NULL,
        is_default TINYINT NOT NULL DEFAULT 0,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY user_id (user_id),
        KEY user_default (user_id, is_default),
        CONSTRAINT user_addresses_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error("User address book schemã check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS discounts (
        id INT NOT NULL AUTO_INCREMENT,
        code VARCHAR(40) NOT NULL,
        name VARCHAR(150) NOT NULL,
        discount_type VARCHAR(20) NOT NULL DEFAULT 'percent',
        discount_value INT NOT NULL,
        apply_to VARCHAR(20) NOT NULL DEFAULT 'order',
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
        (1, 'FOODHUB10', 'Giam 10% cho don từ 100.000d', 'percent', 10, 100000, 30000, 100, 1),
        (2, 'FREESHIP20', 'Giam 20.000d cho don từ 150.000d', 'fixed', 20000, 150000, NULL, NULL, 1)
    `);
  } catch (error) {
    console.error("Discount schemã check failed:", error.message);
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN payment_method VARCHAR(30) NOT NULL DEFAULT 'cod'");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Order payment method schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid'");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Order payment status schemã check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN shipping_fee INT NOT NULL DEFAULT 0");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") {
      console.error("Order shipping fee schema check failed:", error.message);
    }
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN discount_code VARCHAR(40) DEFAULT NULL");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") console.error("Order discount code schema check failed:", error.message);
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN discount_amount INT NOT NULL DEFAULT 0");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") console.error("Order discount amount schema check failed:", error.message);
  }

  try {
    await db.query("ALTER TABLE orders ADD COLUMN user_discount_id INT DEFAULT NULL");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") console.error("Order user discount schema check failed:", error.message);
  }

  try {
    await db.query("ALTER TABLE discounts ADD COLUMN apply_to VARCHAR(20) NOT NULL DEFAULT 'order'");
  } catch (error) {
    if (error.code !== "ER_DUP_FIELDNAME") console.error("Discount apply target schema check failed:", error.message);
  }

  const discountColumnChecks = [
    ["discount_type", "ALTER TABLE discounts ADD COLUMN discount_type VARCHAR(20) NOT NULL DEFAULT 'percent'"],
    ["discount_value", "ALTER TABLE discounts ADD COLUMN discount_value INT NOT NULL DEFAULT 0"],
    ["min_order", "ALTER TABLE discounts ADD COLUMN min_order INT NOT NULL DEFAULT 0"],
    ["max_discount", "ALTER TABLE discounts ADD COLUMN max_discount INT DEFAULT NULL"],
    ["usage_limit", "ALTER TABLE discounts ADD COLUMN usage_limit INT DEFAULT NULL"],
    ["used_count", "ALTER TABLE discounts ADD COLUMN used_count INT NOT NULL DEFAULT 0"],
    ["starts_at", "ALTER TABLE discounts ADD COLUMN starts_at TIMESTAMP NULL DEFAULT NULL"],
    ["expires_at", "ALTER TABLE discounts ADD COLUMN expires_at TIMESTAMP NULL DEFAULT NULL"],
    ["is_active", "ALTER TABLE discounts ADD COLUMN is_active TINYINT DEFAULT 1"],
    ["created_at", "ALTER TABLE discounts ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ["updated_at", "ALTER TABLE discounts ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP"]
  ];

  for (const [column, statement] of discountColumnChecks) {
    try {
      await db.query(statement);
    } catch (error) {
      if (error.code !== "ER_DUP_FIELDNAME") {
        console.error(`Discount ${column} schema check failed:`, error.message);
      }
    }
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_discounts (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        discount_id INT NOT NULL,
        quantity INT NOT NULL DEFAULT 1,
        used_count INT NOT NULL DEFAULT 0,
        claimed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY user_discount_once (user_id, discount_id),
        KEY user_discount_user (user_id),
        KEY user_discount_discount (discount_id),
        CONSTRAINT user_discounts_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
        CONSTRAINT user_discounts_discount_fk FOREIGN KEY (discount_id) REFERENCES discounts (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error("User discount wallet schema check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_sessions (
        id INT NOT NULL AUTO_INCREMENT,
        order_id INT NOT NULL,
        user_id INT NOT NULL,
        method VARCHAR(30) NOT NULL,
        amount INT NOT NULL,
        bank_code VARCHAR(30) DEFAULT NULL,
        bank_account_no VARCHAR(50) DEFAULT NULL,
        bank_account_name VARCHAR(150) DEFAULT NULL,
        transfer_content VARCHAR(150) NOT NULL,
        qr_url VARCHAR(700) DEFAULT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'pending',
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        cancelled_at TIMESTAMP NULL DEFAULT NULL,
        paid_at TIMESTAMP NULL DEFAULT NULL,
        PRIMARY KEY (id),
        KEY order_id (order_id),
        KEY user_id (user_id),
        CONSTRAINT payment_sessions_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
        CONSTRAINT payment_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error("Payment session schemã check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_transactions (
        id INT NOT NULL AUTO_INCREMENT,
        order_id INT NOT NULL,
        payment_session_id INT NOT NULL,
        provider_transaction_id VARCHAR(120) DEFAULT NULL,
        amount INT NOT NULL,
        transfer_content VARCHAR(255) NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'matched',
        raw_payload JSON DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY payment_transactions_provider_txn (provider_transaction_id),
        KEY order_id (order_id),
        KEY payment_session_id (payment_session_id),
        CONSTRAINT payment_transactions_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
        CONSTRAINT payment_transactions_session_fk FOREIGN KEY (payment_session_id) REFERENCES payment_sessions (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error("Payment transaction schema check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS advertisements (
        id INT NOT NULL AUTO_INCREMENT,
        title VARCHAR(150) NOT NULL,
        image VARCHAR(1000) NOT NULL,
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
    await db.query("ALTER TABLE advertisements MODIFY image VARCHAR(1000) NOT NULL");
  } catch (error) {
    console.error("Advertisement schemã check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS customer_feedback (
        id INT NOT NULL AUTO_INCREMENT,
        user_id INT NOT NULL,
        rating TINYINT NOT NULL,
        category VARCHAR(50) NOT NULL DEFAULT 'general',
        title VARCHAR(150) NOT NULL,
        content TEXT NOT NULL,
        status VARCHAR(30) NOT NULL DEFAULT 'new',
        admin_reply TEXT DEFAULT NULL,
        replied_by INT DEFAULT NULL,
        replied_at TIMESTAMP NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY user_id (user_id),
        KEY feedback_status (status),
        KEY feedback_created_at (created_at),
        CONSTRAINT customer_feedback_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
        CONSTRAINT customer_feedback_replier_fk FOREIGN KEY (replied_by) REFERENCES users (id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  } catch (error) {
    console.error("Customer feedback schema check failed:", error.message);
  }

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS food_reviews (
        id INT NOT NULL AUTO_INCREMENT,
        food_id INT NOT NULL,
        user_id INT NOT NULL,
        order_id INT NOT NULL,
        rating TINYINT NOT NULL,
        comment TEXT DEFAULT NULL,
        admin_reply TEXT DEFAULT NULL,
        replied_by INT DEFAULT NULL,
        replied_at TIMESTAMP NULL DEFAULT NULL,
        is_visible TINYINT NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY food_review_once (food_id, user_id, order_id),
        KEY food_review_food (food_id, is_visible, created_at),
        KEY food_review_user (user_id),
        KEY food_review_order (order_id),
        KEY food_review_replier (replied_by),
        CONSTRAINT food_reviews_food_fk FOREIGN KEY (food_id) REFERENCES foods (id),
        CONSTRAINT food_reviews_user_fk FOREIGN KEY (user_id) REFERENCES users (id),
        CONSTRAINT food_reviews_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
        CONSTRAINT food_reviews_replier_fk FOREIGN KEY (replied_by) REFERENCES users (id),
        CONSTRAINT food_reviews_rating_check CHECK (rating BETWEEN 1 AND 5)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await db.query("ALTER TABLE food_reviews MODIFY comment TEXT NULL");
    await ensureColumn("food_reviews", "admin_reply", "ALTER TABLE food_reviews ADD COLUMN admin_reply TEXT DEFAULT NULL AFTER comment");
    await ensureColumn("food_reviews", "replied_by", "ALTER TABLE food_reviews ADD COLUMN replied_by INT DEFAULT NULL AFTER admin_reply");
    await ensureColumn("food_reviews", "replied_at", "ALTER TABLE food_reviews ADD COLUMN replied_at TIMESTAMP NULL DEFAULT NULL AFTER replied_by");
    await ensureIndex("food_reviews", "food_review_replier", "ALTER TABLE food_reviews ADD KEY food_review_replier (replied_by)");
    await ensureForeignKey("food_reviews", "food_reviews_replier_fk", "ALTER TABLE food_reviews ADD CONSTRAINT food_reviews_replier_fk FOREIGN KEY (replied_by) REFERENCES users (id)");
  } catch (error) {
    console.error("Food reviews schema check failed:", error.message);
  }
}

ensureSchema().finally(() => {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
});
