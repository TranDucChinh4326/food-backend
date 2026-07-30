USE foodhub_db;

UPDATE users
SET avatar = NULL
WHERE avatar LIKE 'data:image/%';

ALTER TABLE users
MODIFY avatar VARCHAR(500) DEFAULT NULL;
