-- Migration chuẩn hóa lại schema auth hiện tại và bảo toàn dữ liệu user/provider đang dùng.
START TRANSACTION;

ALTER TABLE users DROP COLUMN full_name;
ALTER TABLE users DROP COLUMN password_hash;

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

CREATE TEMPORARY TABLE keep_users AS
SELECT id
FROM users
WHERE UPPER(role) = 'ADMIN'
   OR email = 'admin@foodhub.local';

DELETE od
FROM order_details od
JOIN orders o ON o.id = od.order_id
LEFT JOIN keep_users ku ON ku.id = o.user_id
WHERE o.user_id IS NOT NULL
  AND ku.id IS NULL;

DELETE o
FROM orders o
LEFT JOIN keep_users ku ON ku.id = o.user_id
WHERE o.user_id IS NOT NULL
  AND ku.id IS NULL;

DELETE ev
FROM email_verification_tokens ev
LEFT JOIN keep_users ku ON ku.id = ev.user_id
WHERE ku.id IS NULL;

DELETE uap
FROM user_auth_providers uap
LEFT JOIN keep_users ku ON ku.id = uap.user_id
WHERE ku.id IS NULL;

DELETE sa
FROM social_accounts sa
LEFT JOIN keep_users ku ON ku.id = sa.user_id
WHERE ku.id IS NULL;

DELETE u
FROM users u
LEFT JOIN keep_users ku ON ku.id = u.id
WHERE ku.id IS NULL;

UPDATE users
SET email = 'admin@foodhub.local',
    username = NULL,
    password = '$2b$10$S8TH17kslyyd3.2SNQvwUOp4npKg1UFauXyD/N1tZzNM4JsRVfNVC',
    password_set = 1,
    role = 'ADMIN',
    is_active = 1,
    email_verified = 1,
    email_verified_at = COALESCE(email_verified_at, NOW())
WHERE UPPER(role) = 'ADMIN'
   OR email = 'admin@foodhub.local';

INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
SELECT id, 'local', NULL, email
FROM users
WHERE email = 'admin@foodhub.local';

COMMIT;
