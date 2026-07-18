ALTER TABLE categories ADD COLUMN IF NOT EXISTS slug VARCHAR(120) DEFAULT NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'food';
ALTER TABLE categories ADD COLUMN IF NOT EXISTS parent_id INT DEFAULT NULL;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INT DEFAULT 0;
ALTER TABLE categories ADD COLUMN IF NOT EXISTS is_active TINYINT DEFAULT 1;

INSERT IGNORE INTO categories (id, name, slug, type, parent_id, sort_order, is_active) VALUES
  (100, 'Do an', 'do-an', 'food', NULL, 1, 1),
  (101, 'Nuoc uong', 'nuoc-uong', 'drink', NULL, 2, 1);

UPDATE categories
SET name = 'Burger', slug = 'burger', type = 'food', parent_id = 100, sort_order = 10, is_active = 1
WHERE id = 1;

UPDATE categories
SET name = 'Pizza', slug = 'pizza', type = 'food', parent_id = 100, sort_order = 20, is_active = 1
WHERE id = 2;

UPDATE categories
SET name = 'Mi', slug = 'mi', type = 'food', parent_id = 100, sort_order = 30, is_active = 1
WHERE id = 3;

UPDATE categories
SET name = 'Tra', slug = 'tra', type = 'drink', parent_id = 101, sort_order = 10, is_active = 1
WHERE id = 4;

INSERT IGNORE INTO categories (id, name, slug, type, parent_id, sort_order, is_active) VALUES
  (5, 'Com', 'com', 'food', 100, 40, 1),
  (6, 'Pho', 'pho', 'food', 100, 50, 1),
  (7, 'Bun', 'bun', 'food', 100, 60, 1),
  (8, 'Ca phe', 'ca-phe', 'drink', 101, 20, 1),
  (9, 'Nuoc dong chai', 'nuoc-dong-chai', 'drink', 101, 30, 1),
  (10, 'Nuoc ep va sinh to', 'nuoc-ep-sinh-to', 'drink', 101, 40, 1),
  (11, 'Ga ran', 'ga-ran', 'food', 100, 70, 1);

UPDATE foods SET category_id = 11 WHERE id = 4;
UPDATE foods SET category_id = 6 WHERE id = 6;
