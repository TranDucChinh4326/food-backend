-- Danh mục món ăn/đồ uống. parent_id tạo cây danh mục cha-con để frontend render menu và admin lọc nhóm món.
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

-- Bảng món ăn là nguồn dữ liệu chính cho menu, giỏ hàng, chatbot và thống kê.
CREATE TABLE IF NOT EXISTS foods (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  category_id INT DEFAULT NULL,
  price INT NOT NULL,
  stock_quantity INT NOT NULL DEFAULT 0,
  description TEXT DEFAULT NULL,
  image VARCHAR(1000) DEFAULT NULL,
  is_active TINYINT DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY category_id (category_id),
  KEY stock_quantity (stock_quantity),
  CONSTRAINT foods_category_fk FOREIGN KEY (category_id) REFERENCES categories (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tài khoản khách hàng/nhân viên/admin. role và permissions được middleware auth dùng để phân quyền API.
CREATE TABLE IF NOT EXISTS users (
  id INT NOT NULL AUTO_INCREMENT,
  username VARCHAR(80) DEFAULT NULL,
  fullname VARCHAR(150) NOT NULL,
  email VARCHAR(150) NOT NULL,
  avatar VARCHAR(1000) DEFAULT NULL,
  password VARCHAR(255) NOT NULL,
  password_set TINYINT DEFAULT 1,
  role VARCHAR(20) DEFAULT 'USER',
  permissions TEXT DEFAULT NULL,
  phone VARCHAR(20) DEFAULT NULL,
  address VARCHAR(255) DEFAULT NULL,
  is_active TINYINT DEFAULT 1,
  last_seen_at TIMESTAMP NULL DEFAULT NULL,
  pin_hash VARCHAR(255) DEFAULT NULL,
  email_verified TINYINT DEFAULT 0,
  email_verified_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  UNIQUE KEY email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Luu tung dot nhap so luong mon tu file CSV de admin doi chieu lai theo ngay.
CREATE TABLE IF NOT EXISTS stock_imports (
  id INT NOT NULL AUTO_INCREMENT,
  file_name VARCHAR(255) DEFAULT NULL,
  stored_file_name VARCHAR(255) DEFAULT NULL,
  imported_by INT DEFAULT NULL,
  import_date DATE NOT NULL,
  total_rows INT NOT NULL DEFAULT 0,
  success_rows INT NOT NULL DEFAULT 0,
  failed_rows INT NOT NULL DEFAULT 0,
  note TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY stock_imports_import_date_idx (import_date),
  KEY stock_imports_imported_by_idx (imported_by),
  CONSTRAINT stock_imports_user_fk FOREIGN KEY (imported_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chi tiet tung dong trong file nhap: mon nao duoc cong bao nhieu, ton cu/ton moi, dong nao loi.
CREATE TABLE IF NOT EXISTS stock_import_details (
  id INT NOT NULL AUTO_INCREMENT,
  import_id INT NOT NULL,
  food_id INT DEFAULT NULL,
  food_name VARCHAR(150) DEFAULT NULL,
  input_name VARCHAR(255) DEFAULT NULL,
  quantity_added INT NOT NULL DEFAULT 0,
  old_stock INT DEFAULT NULL,
  new_stock INT DEFAULT NULL,
  status ENUM('success', 'failed') NOT NULL DEFAULT 'success',
  error_message TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY stock_import_details_import_id_idx (import_id),
  KEY stock_import_details_food_id_idx (food_id),
  CONSTRAINT stock_import_details_import_fk FOREIGN KEY (import_id) REFERENCES stock_imports (id) ON DELETE CASCADE,
  CONSTRAINT stock_import_details_food_fk FOREIGN KEY (food_id) REFERENCES foods (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INT NOT NULL AUTO_INCREMENT,
  actor_id INT DEFAULT NULL,
  actor_name VARCHAR(150) DEFAULT NULL,
  actor_role VARCHAR(40) DEFAULT NULL,
  action VARCHAR(40) NOT NULL,
  module VARCHAR(80) NOT NULL,
  target_type VARCHAR(80) DEFAULT NULL,
  target_id VARCHAR(80) DEFAULT NULL,
  method VARCHAR(10) NOT NULL,
  path VARCHAR(255) NOT NULL,
  details JSON DEFAULT NULL,
  ip_address VARCHAR(80) DEFAULT NULL,
  user_agent VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY admin_audit_actor_idx (actor_id),
  KEY admin_audit_created_idx (created_at),
  KEY admin_audit_module_idx (module),
  CONSTRAINT admin_audit_actor_fk FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
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

-- Token đặt lại mật khẩu khi người dùng quên mật khẩu ở trang đăng nhập.
-- Backend chỉ lưu hash token, token thật chỉ xuất hiện trong link gửi qua email.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  token_hash VARCHAR(255) NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY password_reset_token_hash (token_hash),
  KEY password_reset_user (user_id),
  CONSTRAINT password_reset_tokens_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Đơn hàng tổng: lưu thông tin giao hàng, phí ship, voucher, phương thức thanh toán và trạng thái xử lý.
CREATE TABLE IF NOT EXISTS orders (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT DEFAULT NULL,
  customer_name VARCHAR(150) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  address VARCHAR(255) NOT NULL,
  note TEXT DEFAULT NULL,
  shipping_fee INT NOT NULL DEFAULT 0,
  discount_code VARCHAR(40) DEFAULT NULL,
  discount_amount INT NOT NULL DEFAULT 0,
  user_discount_id INT DEFAULT NULL,
  shipping_method_id INT DEFAULT NULL,
  shipping_method_name VARCHAR(120) DEFAULT NULL,
  total_price INT NOT NULL,
  payment_method VARCHAR(30) NOT NULL DEFAULT 'cod',
  payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid',
  status VARCHAR(50) DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY user_id (user_id),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chi tiết từng món trong đơn. Dữ liệu này dùng cho lịch sử đơn, hoàn tồn kho và tính món bán chạy.
CREATE TABLE IF NOT EXISTS order_details (
  id INT NOT NULL AUTO_INCREMENT,
  order_id INT NOT NULL,
  food_id INT NOT NULL,
  food_name VARCHAR(150) NOT NULL,
  original_price INT DEFAULT NULL,
  price INT NOT NULL,
  quantity INT NOT NULL,
  subtotal INT NOT NULL,
  flash_sale_id INT DEFAULT NULL,
  flash_sale_item_id INT DEFAULT NULL,
  PRIMARY KEY (id),
  KEY order_id (order_id),
  KEY food_id (food_id),
  CONSTRAINT order_details_order_fk FOREIGN KEY (order_id) REFERENCES orders (id),
  CONSTRAINT order_details_food_fk FOREIGN KEY (food_id) REFERENCES foods (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flash_sales (
  id INT NOT NULL AUTO_INCREMENT,
  title VARCHAR(150) NOT NULL,
  schedule_type VARCHAR(20) NOT NULL DEFAULT 'once',
  starts_at TIMESTAMP NULL DEFAULT NULL,
  ends_at TIMESTAMP NULL DEFAULT NULL,
  start_date DATE DEFAULT NULL,
  end_date DATE DEFAULT NULL,
  start_time TIME DEFAULT NULL,
  end_time TIME DEFAULT NULL,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY flash_sale_active_window (is_active, starts_at, ends_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flash_sale_items (
  id INT NOT NULL AUTO_INCREMENT,
  flash_sale_id INT NOT NULL,
  food_id INT NOT NULL,
  sale_price INT NOT NULL,
  stock_limit INT DEFAULT NULL,
  sold_count INT NOT NULL DEFAULT 0,
  per_user_limit INT DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY flash_sale_food_once (flash_sale_id, food_id),
  KEY flash_sale_item_food (food_id),
  CONSTRAINT flash_sale_items_sale_fk FOREIGN KEY (flash_sale_id) REFERENCES flash_sales (id) ON DELETE CASCADE,
  CONSTRAINT flash_sale_items_food_fk FOREIGN KEY (food_id) REFERENCES foods (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS shipping_methods (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(255) DEFAULT NULL,
  fee INT NOT NULL DEFAULT 0,
  estimated_time VARCHAR(80) DEFAULT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  is_visible TINYINT NOT NULL DEFAULT 0,
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_favorite_foods (
  id INT NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  food_id INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY user_favorite_food_once (user_id, food_id),
  KEY user_favorite_food_user (user_id, created_at),
  KEY user_favorite_food_food (food_id),
  CONSTRAINT user_favorite_foods_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT user_favorite_foods_food_fk FOREIGN KEY (food_id) REFERENCES foods (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- Voucher công khai do admin tạo. Backend kiểm tra thời gian hiệu lực, số lượt phát hành và điều kiện đơn tối thiểu.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Voucher mà từng người dùng đã sở hữu. quantity/used_count quyết định còn bao nhiêu lượt dùng trong giỏ hàng.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phản hồi trải nghiệm của khách hàng, được admin đọc, phân loại trạng thái và trả lời.
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Phiên chat của chatbot. session_id đến từ frontend, user_id gắn vào khi khách đã đăng nhập.
CREATE TABLE IF NOT EXISTS chat_sessions (
  session_id VARCHAR(120) NOT NULL,
  user_id INT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (session_id),
  KEY chat_sessions_user (user_id),
  CONSTRAINT chat_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tin nhắn chat theo phiên. sender phân biệt user/bot để frontend khôi phục đúng lịch sử hội thoại.
CREATE TABLE IF NOT EXISTS chat_messages (
  message_id INT NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(120) NOT NULL,
  sender VARCHAR(20) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (message_id),
  KEY chat_messages_session (session_id, created_at),
  CONSTRAINT chat_messages_session_fk FOREIGN KEY (session_id) REFERENCES chat_sessions (session_id),
  CONSTRAINT chat_messages_sender_check CHECK (sender IN ('user', 'bot'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO categories (id, name, slug, type, parent_id, sort_order, is_active) VALUES
  (100, 'Đồ ăn', 'do-an', 'food', NULL, 1, 1),
  (101, 'Nước uống', 'nuoc-uong', 'drink', NULL, 2, 1);

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
  (1, 'Burger bò phô mai', 1, 59000, 'Burger bo mem, pho mai beo ngay, rau tuoi va sot dac biet.', 'https://images.unsplash.com/photo-1568901346375-23c9450c58cd', 1),
  (2, 'Pizza hải sản', 2, 129000, 'Pizza gion thom, topping hai san tuoi ngon, pho mai keo soi.', 'https://images.unsplash.com/photo-1513104890138-7c749659a591', 1),
  (3, 'Mì cay đặc biệt', 3, 49000, 'Mi cay nong hoi, nuoc dung dam vi, topping day du.', 'https://images.unsplash.com/photo-1569718212165-3a8278d5f624', 1),
  (4, 'Gà rán giòn cay', 11, 69000, 'Ga ran vang gion, vi cay nhe, ẩn kem tuong ot.', 'https://images.unsplash.com/photo-1626645738196-c2a7c87a8f58', 1),
  (5, 'Trà đào cam sả', 4, 29000, 'Tra dao thanh mat, huong cam sa thom nhe.', 'https://images.unsplash.com/photo-1556679343-c7306c1976bc', 1),
  (6, 'Phở bò tái', 6, 55000, 'Pho bo nong hoi, nuoc dung ngot thanh, thit bo mem.', 'https://images.unsplash.com/photo-1582878826629-29b7ad1cdc43', 1);

INSERT IGNORE INTO announcements (id, title, content, is_active) VALUES
  (1, 'Miễn phí giao hàng cho don từ 150.000d', 'FoodHub miễn phí giao hàng trong khu vuc nội thành cho cac đơn hàng từ 150.000d.', 1),
  (2, 'Cập nhật thực đơn mới cuối tuần', 'Nhieu món ăn mới sẽ được bo sung vao thực đơn vao thứ bảy hang tuan.', 1),
  (3, 'Hỗ trợ đặt hàng nhanh qua hotline', 'Neu can hỗ trợ đơn hàng, vui lòng liên hệ hotline tren trang liên hệ của FoodHub.', 1);

INSERT IGNORE INTO discounts (id, code, name, discount_type, discount_value, min_order, max_discount, usage_limit, is_active) VALUES
  (1, 'FOODHUB10', 'Giam 10% cho don từ 100.000d', 'percent', 10, 100000, 30000, 100, 1),
  (2, 'FREESHIP20', 'Giam 20.000d cho don từ 150.000d', 'fixed', 20000, 150000, NULL, NULL, 1);
