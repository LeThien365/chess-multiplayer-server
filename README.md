# Chess Multiplayer Server

Server Node.js (Express + Socket.IO + SQLite) cho ứng dụng cờ vua/cờ tướng của bạn.
Xử lý: tạo phòng, danh sách phòng chờ, ghép cặp tự động (matchmaking), đồng bộ nước đi
real-time, hệ thống Elo, chat trong ván, đầu hàng/cầu hòa/hủy ván, tái đấu.

## Cài đặt & chạy thử trên máy bạn (trước khi deploy lên mạng)

```bash
cd server
npm install
npm start
```

Server chạy ở `http://localhost:3000`. Mở trình duyệt vào địa chỉ đó, thấy JSON báo "ok"
là server chạy đúng.

## Đưa lên internet (miễn phí)

Xem file `HUONG_DAN_DEPLOY.md` — hướng dẫn từng bước, không cần biết trước gì.

## Cấu trúc thư mục

```
server/
├── package.json          # Khai báo thư viện cần dùng
├── render.yaml            # Cấu hình để Render.com tự nhận diện cách deploy
├── HUONG_DAN_DEPLOY.md    # Hướng dẫn deploy chi tiết từng bước
└── src/
    ├── server.js          # File chính: nhận kết nối Socket.IO, xử lý mọi sự kiện
    ├── db.js              # Lưu người chơi + Elo bằng SQLite (file, không cần DB ngoài)
    ├── rooms.js            # Quản lý phòng mở (ai cũng thấy, bấm vào chơi) + hàng chờ ghép cặp
    └── game.js             # Trạng thái 1 ván đấu: đồng hồ, nước đi, đầu hàng, hòa, hủy, chat
```

## Các sự kiện Socket.IO mà client (app Python) sẽ dùng

### Gửi lên server (client → server)

| Sự kiện | Dữ liệu gửi | Mô tả |
|---|---|---|
| `player:identify` | `{ playerId, displayName }` | Xác định danh tính (playerId tự sinh và lưu lại trên máy client để giữ Elo qua các lần chơi) |
| `player:get-ratings` | `{ variant }` | Lấy Elo hiện tại theo từng tốc độ |
| `room:create-open` | `{ variant, baseMinutes, incrementSeconds }` | Tạo phòng mở cho người khác thấy |
| `room:list-open` | `{}` | Lấy danh sách phòng đang chờ |
| `room:join-open` | `{ roomId }` | Vào 1 phòng mở |
| `matchmaking:join` | `{ variant, baseMinutes, incrementSeconds }` | Tìm đối thủ tự động (ghép theo Elo gần nhất) |
| `matchmaking:cancel` | `{ variant, baseMinutes, incrementSeconds }` | Hủy tìm đối thủ |
| `move:play` | `{ roomId, san, from, to, fen, promotion }` | Gửi nước đi |
| `room:abort` | `{ roomId }` | Hủy ván (chỉ khi chưa ai đi nước nào) |
| `game:resign` | `{ roomId }` | Đầu hàng |
| `draw:offer` / `draw:accept` / `draw:decline` | `{ roomId }` | Cầu hòa / chấp nhận / từ chối |
| `game:report-end` | `{ roomId, result, reason }` | Báo kết thúc ván (chiếu hết, hết nước đi...) đã được xác nhận ở client |
| `chat:send` | `{ roomId, text }` | Gửi tin nhắn chat |
| `rematch:offer` / `rematch:accept` / `rematch:decline` | `{ roomId }` | Đề nghị tái đấu / chấp nhận / từ chối |

### Nhận từ server (server → client)

| Sự kiện | Mô tả |
|---|---|
| `rooms:list-updated` | Danh sách phòng mở vừa thay đổi |
| `game:started` | Ván đấu bắt đầu (kèm toàn bộ trạng thái ban đầu) |
| `move:opponent-played` | Đối thủ vừa đi 1 nước |
| `clock:update` | Cập nhật đồng hồ mỗi giây |
| `game:aborted` | Ván bị hủy (kèm `byColor`, `byYou` để phân biệt "bạn hủy" hay "đối phương hủy") |
| `game:finished` | Ván kết thúc (kèm `result`, `reason`, `eloUpdate` — thay đổi Elo mỗi bên) |
| `draw:offered` / `draw:declined` | Có người cầu hòa / từ chối hòa |
| `chat:new-message` | Có tin nhắn chat mới |
| `rematch:offered` / `rematch:started` / `rematch:declined` | Trạng thái tái đấu |

## API HTTP thường (không qua Socket.IO)

- `GET /api/search-players?q=ten` — tìm người chơi theo tên
- `GET /api/leaderboard?variant=chess&speed=rapid` — bảng xếp hạng

## Bước tiếp theo

Đây là **Bước 1/4**. Các bước tiếp theo (sau khi bạn deploy và xác nhận server chạy được):
- Bước 2: Viết module Python client kết nối vào server này (giao diện chọn "Chơi với người
  khác", tạo/vào phòng, bàn cờ online, đồng hồ, chat, các nút đầu hàng/hòa/hủy)
- Bước 3: Module phân tích Stockfish sau ván đấu — gắn 8 nhãn + bảng thống kê + Accuracy
- Bước 4: Gắn module tìm kiếm người chơi + bảng xếp hạng Elo vào giao diện có sẵn
