# FoodHub Backend

Backend Express + MySQL cho website FoodHub.

## Cau truc file

```text
food-backend/
  index.js        Entry Express server
  db.js           Ket noi MySQL
  routes/         API auth, food, order, admin, thong bao, quang cao
  middleware/     Middleware xac thuc JWT va phan quyen
  migrations/     SQL nang cap database theo tung dot
  schema.sql      Database schema ban dau
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

## Bien moi truong

Sua `.env` theo server cua ban:

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

## Tao tai khoan admin

Dang ky tai khoan tren web truoc, sau do chay SQL:

```sql
UPDATE users SET role = 'ADMIN' WHERE email = 'email-cua-ban@example.com';
```

Admin co the mo trang:

```text
https://your-domain.com/admin.html
```
