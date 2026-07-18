CREATE TABLE IF NOT EXISTS categories (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) DEFAULT NULL,
  type VARCHAR(20) NOT NULL DEFAULT 'food',
  parent_id INT DEFAULT NULL,
  sort_order INT DEFAULT 0,
  is_active TINYINT DEFAULT 1,
  PRIMARY KEY (id),
  KEY category_parent_id (parent_id),
  KEY category_type (type),
  UNIQUE KEY category_slug (slug),
  CONSTRAINT categories_parent_fk FOREIGN KEY (parent_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS foods (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  category_id INT DEFAULT NULL,
  price INT NOT NULL,
  description TEXT DEFAULT NULL,
  image LONGTEXT DEFAULT NULL,
  is_active TINYINT DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY category_id (category_id),
  CONSTRAINT foods_category_fk FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  fullname VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  password VARCHAR(255) NOT NULL,
  password_set TINYINT DEFAULT 1,
  role VARCHAR(20) DEFAULT 'USER',
  permissions TEXT DEFAULT NULL,
  is_active TINYINT DEFAULT 1,
  email_verified TINYINT DEFAULT 0,
  email_verified_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_hash (token_hash),
  KEY user_id (user_id),
  CONSTRAINT email_verification_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS social_accounts (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  provider VARCHAR(30) NOT NULL,
  provider_user_id VARCHAR(150) NOT NULL,
  provider_email VARCHAR(150) DEFAULT NULL,
  provider_name VARCHAR(150) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY provider_identity (provider, provider_user_id),
  UNIQUE KEY user_provider (user_id, provider),
  KEY user_id (user_id),
  CONSTRAINT social_accounts_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS orders (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT DEFAULT NULL,
  customer_name VARCHAR(150) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address VARCHAR(255) NOT NULL,
  note TEXT DEFAULT NULL,
  total_price INT NOT NULL,
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS order_details (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  food_id INT NOT NULL,
  food_name VARCHAR(150) NOT NULL,
  price INT NOT NULL,
  quantity INT NOT NULL,
  subtotal INT NOT NULL,
  PRIMARY KEY (id),
  KEY order_id (order_id),
  KEY food_id (food_id),
  CONSTRAINT order_details_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_details_food_fk FOREIGN KEY (food_id) REFERENCES foods (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS announcements (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  content TEXT DEFAULT NULL,
  link_url VARCHAR(500) DEFAULT NULL,
  is_important TINYINT DEFAULT 0,
  is_active TINYINT DEFAULT 1,
  published_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO categories (id, name, slug, type, parent_id, sort_order, is_active) VALUES
  (100, 'Do an', 'do-an', 'food', NULL, 1, 1),
  (101, 'Nuoc uong', 'nuoc-uong', 'drink', NULL, 2, 1);

INSERT IGNORE INTO categories (id, name, slug, type, parent_id, sort_order, is_active) VALUES
  (1, 'Burger', 'burger', 'food', 100, 10, 1),
  (2, 'Pizza', 'pizza', 'food', 100, 20, 1),
  (3, 'Mi', 'mi', 'food', 100, 30, 1),
  (4, 'Tra', 'tra', 'drink', 101, 10, 1),
  (5, 'Com', 'com', 'food', 100, 40, 1),
  (6, 'Pho', 'pho', 'food', 100, 50, 1),
  (7, 'Bun', 'bun', 'food', 100, 60, 1),
  (8, 'Ca phe', 'ca-phe', 'drink', 101, 20, 1),
  (9, 'Nuoc dong chai', 'nuoc-dong-chai', 'drink', 101, 30, 1),
  (10, 'Nuoc ep va sinh to', 'nuoc-ep-sinh-to', 'drink', 101, 40, 1),
  (11, 'Ga ran', 'ga-ran', 'food', 100, 70, 1);

INSERT IGNORE INTO foods (id, name, category_id, price, description, image, is_active) VALUES
  (1, 'Burger bo pho mai', 1, 59000, 'Burger bo mem, pho mai beo ngay, rau tuoi va sot dac biet.', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', 1),
  (2, 'Pizza hai san', 2, 129000, 'Pizza gion thom, topping hai san tuoi ngon, pho mai keo soi.', 'https://images.unsplash.com/photo-1513104890138-7c749659a591', 1),
  (3, 'Mi cay dac biet', 3, 49000, 'Mi cay nong hoi, nuoc dung dam vi, topping day du.', 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624', 1),
  (4, 'Ga ran gion cay', 11, 69000, 'Ga ran vang gion, vi cay nhe, an kem tuong ot.', 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58', 1),
  (5, 'Tra dao cam sa', 4, 29000, 'Tra dao thanh mat, huong cam sa thom nhe.', 'https://images.unsplash.com/photo-1556679343-c7306c1976bc', 1),
  (6, 'Pho bo tai', 6, 55000, 'Pho bo nong hoi, nuoc dung ngot thanh, thit bo mem.', 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43', 1);

INSERT IGNORE INTO announcements (id, title, content, is_active) VALUES
  (1, 'Mien phi giao hang cho don tu 150.000d', 'FoodHub mien phi giao hang trong khu vuc noi thanh cho cac don hang tu 150.000d.', 1),
  (2, 'Cap nhat thuc don moi cuoi tuan', 'Nhieu mon an moi se duoc bo sung vao thuc don vao thu bay hang tuan.', 1),
  (3, 'Ho tro dat hang nhanh qua hotline', 'Neu can ho tro don hang, vui long lien he hotline tren trang lien he cua FoodHub.', 1);
