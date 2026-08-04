USE foodhub_db;

ALTER TABLE orders
ADD COLUMN payment_method VARCHAR(30) NOT NULL DEFAULT 'cod';

ALTER TABLE orders
ADD COLUMN payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid';
