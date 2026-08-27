-- Luu lich su nhap so luong mon tu file CSV va chi tiet tung dong de doi chieu.
CREATE TABLE IF NOT EXISTS stock_imports (
  id INT NOT NULL AUTO_INCREMENT,
  file_name VARCHAR(255) DEFAULT NULL,
  stored_file_name VARCHAR(255) DEFAULT NULL,
  imported_by INT DEFAULT NULL,
  import_date DATE NOT NULL,
  total_rows INT NOT NULL DEFAULT 0,
  success_rows INT NOT NULL DEFAULT 0,
  failed_rows INT NOT NULL DEFAULT 0,
  note TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY stock_imports_import_date_idx (import_date),
  KEY stock_imports_imported_by_idx (imported_by),
  CONSTRAINT stock_imports_user_fk FOREIGN KEY (imported_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_import_details (
  id INT NOT NULL AUTO_INCREMENT,
  import_id INT NOT NULL,
  food_id INT DEFAULT NULL,
  food_name VARCHAR(150) DEFAULT NULL,
  input_name VARCHAR(255) DEFAULT NULL,
  quantity_added INT NOT NULL DEFAULT 0,
  old_stock INT DEFAULT NULL,
  new_stock INT DEFAULT NULL,
  status ENUM('success', 'failed') NOT NULL DEFAULT 'success',
  error_message TEXT DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY stock_import_details_import_id_idx (import_id),
  KEY stock_import_details_food_id_idx (food_id),
  CONSTRAINT stock_import_details_import_fk FOREIGN KEY (import_id) REFERENCES stock_imports (id) ON DELETE CASCADE,
  CONSTRAINT stock_import_details_food_fk FOREIGN KEY (food_id) REFERENCES foods (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
