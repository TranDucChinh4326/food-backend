-- Migration dọn dữ liệu test nhưng giữ tài khoản admin chính để môi trường demo sạch hơn.
START TRANSACTION;

CREATE TEMPORARY TABLE keep_users AS
SELECT id
FROM users
WHERE UPPER(role) = 'ADMIN';

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
SET username = NULL
WHERE username REGEXP '^user_[0-9]+$';

INSERT IGNORE INTO user_auth_providers (user_id, provider, provider_user_id, provider_email)
SELECT id, 'local', NULL, email
FROM users
WHERE UPPER(role) = 'ADMIN'
  AND password_set = 1;

COMMIT;
