USE foodhub_db;

ALTER TABLE orders
ADD COLUMN payment_method VARCHAR(30) NOT NULL DEFAULT 'cod';

ALTER TABLE orders
ADD COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid';

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
