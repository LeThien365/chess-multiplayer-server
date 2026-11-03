# Hướng dẫn đưa server lên mạng (MIỄN PHÍ, không cần thẻ ngân hàng)

Server này cho phép nhiều người chơi cờ với nhau qua internet, giống lichess.com nhưng nhỏ hơn.
Làm theo đúng từng bước, không bỏ bước nào.

---

## Bước 0 — Những thứ cần có trước

1. Một tài khoản **GitHub** (miễn phí) — nếu chưa có: vào https://github.com/signup, đăng ký bằng email, không cần thẻ.
2. Một tài khoản **Render.com** (miễn phí) — vào https://render.com, bấm "Get Started", chọn **"Sign up with GitHub"** (đăng nhập luôn bằng GitHub ở bước 1, không cần thẻ ngân hàng).

---

## Bước 1 — Đưa code server lên GitHub

1. Vào https://github.com/new để tạo **repository mới**.
2. Đặt tên ví dụ: `chess-multiplayer-server`
3. Chọn **Public** (để Render free dùng được) hoặc Private đều được.
4. Bấm **Create repository**.
5. Trên máy bạn, mở thư mục `server` (thư mục này) rồi chạy các lệnh sau trong Terminal/CMD
   (nếu chưa cài Git: tải tại https://git-scm.com/downloads rồi cài như bình thường):

```bash
cd duong-dan-toi-thu-muc/server
git init
git add .
git commit -m "Server co vua multiplayer"
git branch -M main
git remote add origin https://github.com/LeThien365/chess-multiplayer-server.git
git push -u origin main
```

(Thay `TEN_TAI_KHOAN_CUA_BAN` bằng tên tài khoản GitHub của bạn — GitHub sẽ hiện đúng dòng lệnh
này cho bạn copy ngay sau khi tạo repo xong, ở phần "…or push an existing repository from the
command line".)

---

## Bước 2 — Deploy lên Render.com

1. Đăng nhập https://render.com
2. Bấm **New +** (góc trên bên phải) → chọn **Web Service**
3. Chọn **Build and deploy from a Git repository** → bấm **Next**
4. Chọn repo `chess-multiplayer-server` bạn vừa tạo (nếu chưa thấy, bấm **Configure account** để cấp quyền cho Render truy cập GitHub)
5. Điền thông tin:
   - **Name**: `chess-multiplayer-server` (hoặc tên bạn thích)
   - **Region**: chọn gần Việt Nam nhất, ví dụ `Singapore`
   - **Branch**: `main`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: chọn **Free** ($0/month)
6. Bấm **Create Web Service**

Render sẽ tự động cài đặt và chạy server (mất khoảng 2-5 phút lần đầu). Khi thấy chữ
**"Live"** màu xanh ở trên cùng là server đã chạy.

---

## Bước 3 — Lấy địa chỉ server của bạn

Sau khi deploy xong, Render cho bạn 1 địa chỉ dạng:

```
https://chess-multiplayer-server-xxxx.onrender.com
```

Đây chính là địa chỉ mà **app Python của bạn sẽ kết nối tới** (dùng giao thức `wss://` cho
Socket.IO thay vì `https://`, phần này app Python đã tự xử lý, bạn chỉ cần dán đúng domain vào
file cấu hình `config.py` của app — mình sẽ ghi rõ ở bước nối app Python).

Mở địa chỉ đó trên trình duyệt — nếu thấy dòng chữ JSON kiểu:
```json
{"status":"ok","message":"Chess multiplayer server dang chay","time":...}
```
nghĩa là **server đã chạy thành công**.

---

## Lưu ý quan trọng về gói FREE của Render

- **Server sẽ "ngủ"** sau 15 phút không có ai dùng. Lần kết nối đầu tiên sau khi ngủ sẽ mất
  khoảng **30–50 giây** để server "thức dậy" — đây là giới hạn của gói miễn phí, không phải lỗi.
- Dữ liệu Elo được lưu trong file `data.sqlite` ngay trên server — gói Free của Render **không
  lưu ổ đĩa vĩnh viễn** (ổ đĩa sẽ bị xóa mỗi khi server khởi động lại, ví dụ sau khi bạn sửa
  code và deploy lại). Nếu sau này bạn cần Elo được lưu mãi mãi kể cả khi redeploy, lúc đó
  cần nâng cấp lên **Render Disk** (có phí nhỏ) hoặc chuyển sang dùng database ngoài miễn phí
  như **Supabase** (phần này mình có thể làm giúp khi bạn cần, không bắt buộc ngay bây giờ).
- Giới hạn gói Free: 750 giờ chạy/tháng — đủ cho 1 server chạy cả tháng không nghỉ, miễn phí
  hoàn toàn.

---

## Mỗi khi bạn sửa code server và muốn cập nhật

```bash
cd duong-dan-toi-thu-muc/server
git add .
git commit -m "Cap nhat"
git push
```

Render sẽ **tự động deploy lại** mỗi khi bạn push code mới lên GitHub — không cần làm gì thêm
trên Render.

---

## Nếu bị lỗi khi deploy

Vào tab **Logs** trong trang Render của bạn để xem dòng lỗi màu đỏ, copy dòng đó gửi lại cho
mình, mình sẽ giúp sửa.
