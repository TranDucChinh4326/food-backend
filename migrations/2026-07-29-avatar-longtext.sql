-- Migration mở rộng avatar người dùng để hỗ trợ ảnh URL/base64 dài hơn.
ALTER TABLE users MODIFY avatar LONGTEXT DEFAULT NULL;
