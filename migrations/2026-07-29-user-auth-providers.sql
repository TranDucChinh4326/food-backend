-- Migration bổ sung username/avatar/provider để hỗ trợ đăng nhập local và social.
ALTER TABLE users ADD COLUMN username VARCHAR(80) DEFAULT NULL;
ALTER TABLE users ADD COLUMN avatar VARCHAR(500) DEFAULT NULL;
ALTER TABLE users ADD UNIQUE KEY username (username);

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

INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
SELECT id, 'local', NULL, email
FROM users
WHERE password_set = 1;

INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
SELECT user_id, provider, provider_user_id, provider_email
FROM social_accounts
WHERE provider IN ('google', 'facebook');
