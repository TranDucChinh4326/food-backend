-- Migration mở rộng cột ảnh món ăn để lưu URL/base64 dài hơn khi cần.
ALTER TABLE foods MODIFY image LONGTEXT DEFAULT NULL;
