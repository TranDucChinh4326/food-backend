CREATE TABLE IF NOT EXISTS user_login_sessions (
  user_id INT NOT NULL,
  client_type ENUM('web', 'app') NOT NULL,
  session_id CHAR(64) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, client_type),
  UNIQUE KEY user_login_sessions_session_id (session_id),
  CONSTRAINT user_login_sessions_user_fk
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
