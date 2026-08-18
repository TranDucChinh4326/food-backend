-- Migration tạo bảng phản hồi khách hàng để admin tiếp nhận và trả lời.
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
