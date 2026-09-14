CREATE TABLE IF NOT EXISTS announcement_reads (
  user_id INT NOT NULL,
  announcement_id INT NOT NULL,
  read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, announcement_id),
  INDEX announcement_reads_announcement_idx (announcement_id),
  CONSTRAINT announcement_reads_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT announcement_reads_announcement_fk FOREIGN KEY (announcement_id) REFERENCES announcements (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
