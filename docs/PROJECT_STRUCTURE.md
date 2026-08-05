# Cau truc backend FoodHub

Repo này chỉ chứa backend Node.js + Express + MySQL để deploy lên Render.

## File chinh

- `index.js`: khoi tạo server, CORS, route va health check.
- `db.js`: tạo pool kết nối MySQL từ bien mới truong.
- `schema.sql`: schemã bạn dau khi tạo database mới.

## Thu muc

- `routes/auth.js`: đăng ký, đăng nhập, social login, hồ sơ.
- `routes/foods.js`: danh mục va món ăn.
- `routes/orders.js`: giỏ hàng, đặt hàng, lịch sử đơn hàng.
- `routes/admin.js`: API quản trị tài khoản, mật khẩu va quyền.
- `routes/announcements.js`: thông báo he thong.
- `routes/advertisements.js`: banner quảng cáo.
- `middleware/auth.js`: xác thực token va kiểm tra quyền.
- `migrations/`: cac file SQL bo sung khi nang cap tinh nang.

## Lưu y deploy

Không đưa file `.env` len GitHub. Trên Render chỉ cấu hình bien mới truong trong tab Environment.
