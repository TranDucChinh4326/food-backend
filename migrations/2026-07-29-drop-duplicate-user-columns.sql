-- Migration xóa các cột user cũ sau khi đổi sang schema auth chuẩn.
ALTER TABLE users DROP COLUMN full_name;
ALTER TABLE users DROP COLUMN password_hash;
