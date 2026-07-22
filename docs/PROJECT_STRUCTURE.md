# Cau truc backend FoodHub

Repo nay chi chua backend Node.js + Express + MySQL de deploy len Render.

## File chinh

- `index.js`: khoi tao server, CORS, route va health check.
- `db.js`: tao pool ket noi MySQL tu bien moi truong.
- `schema.sql`: schema ban dau khi tao database moi.

## Thu muc

- `routes/auth.js`: dang ky, dang nhap, social login, ho so.
- `routes/foods.js`: danh muc va mon an.
- `routes/orders.js`: gio hang, dat hang, lich su don hang.
- `routes/admin.js`: API quan tri tai khoan, mat khau va quyen.
- `routes/announcements.js`: thong bao he thong.
- `routes/advertisements.js`: banner quang cao.
- `middleware/auth.js`: xac thuc token va kiem tra quyen.
- `migrations/`: cac file SQL bo sung khi nang cap tinh nang.

## Luu y deploy

Khong dua file `.env` len GitHub. Tren Render chi cau hinh bien moi truong trong tab Environment.
