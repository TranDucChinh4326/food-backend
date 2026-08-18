-- Migration chuẩn bị lưu avatar dạng dữ liệu dài và phân biệt nguồn avatar.
USE foodhub_db;

ALTER TABLE users
MODIFY avatar LONGTEXT DEFAULT NULL;
