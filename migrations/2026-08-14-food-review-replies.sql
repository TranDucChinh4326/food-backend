-- Migration bổ sung phản hồi admin và ẩn/hiện cho đánh giá món ăn.
ALTER TABLE food_reviews
  ADD COLUMN admin_reply TEXT DEFAULT NULL AFTER comment,
  ADD COLUMN replied_by INT DEFAULT NULL AFTER admin_reply,
  ADD COLUMN replied_at TIMESTAMP NULL DEFAULT NULL AFTER replied_by,
  ADD KEY food_review_replier (replied_by),
  ADD CONSTRAINT food_reviews_replier_fk FOREIGN KEY (replied_by) REFERENCES users (id);
