# FoodHub Backend

Backend Express + MySQL cho website FoodHub.

## Cau truc file

```text
food-backend/
  index.js        Entry Express server
  db.js           Kết nối MySQL
  routes/         API auth, food, order, admin, thông báo, quảng cáo
  middleware/     Middleware xác thực JWT va phan quyền
  migrations/     SQL nang cap database theo tung dot
  schema.sql      Database schemã bạn dau
  docs/           Ghi chu cau truc va van hanh
```

## Chay local

```bash
npm install
copy .env.example .env
npm start
```

Import database:

```bash
mysql -u root -p < schema.sql
```

API mac dinh chay tai:

```text
http://localhost:3000
```

## Bien mới truong

Sửa `.env` theo server của ban:

```env
PORT=3000
CORS_ORIGIN=https://your-domain.com
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=foodhub_db
JWT_SECRET=change_this_to_a_long_random_secret
```

Khi dung Cloudflare Tunnel, tro subdomain API ve backend local:

```text
api.your-domain.com -> http://localhost:3000
```

Sau do doi frontend `config.js` thanh:

```js
window.FOODHUB_CONFIG = {
  API_BASE_URL: "https://api.your-domain.com/api"
};
```

## Tạo tài khoản admin

Đăng ký tài khoản tren web truoc, sau do chay SQL:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'email-cua-ban@example.com';
```

Admin co the mo trang:

```text
https://your-domain.com/admin.html
```
