-- Migration tạo bảng token đặt lại mật khẩu cho chức năng quên mật khẩu qua email.
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
