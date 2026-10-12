# Mở giao diện quản lý cho team qua Cloudflare Tunnel

Tool vẫn chạy trên máy Windows (quét Facebook bằng IP và trình duyệt của máy này). Cloudflare Tunnel đưa
giao diện ra địa chỉ `https://minigame.drnatro.net`. Người vào phải **đăng nhập bằng Google**: Gmail của họ
được ghi lại, và Gmail mới chỉ vào được sau khi bạn bấm **Cho phép** trên máy chạy tool. Không cần Zero Trust.

```
Máy Windows: npm run ui (127.0.0.1:4321) + cloudflared (dịch vụ Windows)
      │  kết nối ra ngoài, không mở cổng modem
      ▼
Cloudflare ──► minigame.drnatro.net ──► Trang "Đăng nhập bằng Google" ──► Giao diện
```

Thiếu cấu hình đăng nhập Google thì mọi truy cập qua Tunnel bị chặn, nên làm sai thứ tự các bước bên dưới
cũng không lộ dữ liệu ra ngoài.

> Tài khoản Cloudflare công ty đang có các Tunnel, Worker, R2 khác. Chỉ **tạo mới**, không sửa hay xoá
> những thứ đang có.

## Bước 1: Tạo Client ID cho nút "Đăng nhập bằng Google"

Dùng project Google Cloud đang chứa service account của tool (project có service account `minigame-mkt@...`).

1. Mở https://console.cloud.google.com, chọn đúng project ở thanh trên cùng.
2. Vào **Google Auth Platform → Branding** (lần đầu sẽ có nút **Get started**):
   - App name: `Quản lý dữ liệu Minigame`, User support email: email công ty.
   - Audience / User type: **External**.
   - Authorized domains: `drnatro.net`.
   - Lưu lại.
3. Vào **Google Auth Platform → Audience**, bấm **Publish app** để chuyển sang **In production**. Tool chỉ
   xin quyền cơ bản (email, tên), loại này không cần Google duyệt app. Nếu để **Testing** thì chỉ những
   Gmail được thêm vào mục Test users mới đăng nhập được.
4. Vào **Google Auth Platform → Clients → Create client**:
   - Application type: **Web application**, Name: `Minigame UI`.
   - **Authorized JavaScript origins**: `https://minigame.drnatro.net`.
   - **Create**, sao chép **Client ID** (dạng `....apps.googleusercontent.com`). Không cần Client secret.

## Bước 2: Điền cấu hình trên máy chạy tool

Sửa `config.json`, phần `ui`:

```json
"ui": {
  "port": 4321,
  "openBrowser": true,
  "publicUrl": "https://minigame.drnatro.net",
  "googleClientId": "<dán Client ID ở bước 1>",
  "allowedEmails": ["gmail-cua-ban@gmail.com"]
}
```

`allowedEmails` là các Gmail được vào ngay không cần duyệt (có thể để `[]` rồi cho phép dần trong giao diện).
Khởi động lại giao diện để nhận cấu hình mới:

- Nếu đã cài tự bật cùng Windows (xem README, mục Giao diện quản lý):
  `powershell -ExecutionPolicy Bypass -File .\scripts\restart-ui.ps1`
- Nếu đang chạy tay: tắt cửa sổ giao diện (Ctrl+C) rồi chạy lại `npm run ui`.

Nhật ký in thêm dòng `Team truy cập từ xa: https://minigame.drnatro.net ...`.

## Bước 3: Cài cloudflared

Mở PowerShell:

```powershell
winget install --id Cloudflare.cloudflared
```

## Bước 4: Tạo Tunnel cho máy này

1. Trên dashboard Cloudflare (tài khoản công ty): **Networking → Tunnels → Create a tunnel**.
2. Tên: `minigame-pc` → **Create Tunnel**.
3. Chọn **Windows**, sao chép lệnh cài đặt Cloudflare hiển thị (dạng `cloudflared.exe service install <mã>`).
4. Mở PowerShell bằng **Run as administrator**, dán lệnh và chạy. Cloudflared được cài thành dịch vụ
   Windows, tự chạy khi bật máy.
5. Chờ dashboard báo đã kết nối → **Continue**.

> Mã trong lệnh cài là chìa khoá của Tunnel: không gửi cho người khác, không dán vào chat hay Git.

## Bước 5: Gắn địa chỉ minigame.drnatro.net vào Tunnel

1. **Networking → Tunnels → minigame-pc → Routes → Add route → Published application**.
2. Subdomain `minigame`, Domain `drnatro.net`.
3. Service URL: `http://127.0.0.1:4321`. Dùng `127.0.0.1`, không dùng `localhost` (trên Windows `localhost`
   có thể trỏ sang IPv6 trong khi giao diện chỉ nghe IPv4).
4. **Add route**.

## Bước 6: Thử

1. Dùng điện thoại (tắt Wi-Fi công ty, dùng 4G) mở `https://minigame.drnatro.net`.
2. Trang đăng nhập hiện ra, bấm **Đăng nhập bằng Google**, chọn một Gmail có trong `allowedEmails`.
3. Giao diện mở ra, góc phải ghi `Đăng nhập: <gmail>` và nút **Đăng xuất**.
4. Thử bằng một Gmail khác: trang báo "chưa được cấp quyền". Trên máy chạy tool, tab **Người truy cập**
   hiện Gmail đó ở trạng thái **Chờ cấp quyền**.

## Vận hành hằng ngày

- **Người mới**: họ mở link và đăng nhập bằng Google. Bạn mở giao diện trên máy chạy tool → tab
  **Người truy cập** → **Cho phép** → họ đăng nhập lại là vào được. Có thể thêm trước Gmail của họ bằng ô
  "Thêm Gmail được phép" trong tab đó.
- **Chặn ai đó**: bấm **Chặn**, phiên đang mở của họ bị cắt ngay.
- **Gmail được lưu ở đâu**: `data/ui-visitors.json` (Gmail, tên Google, lần đầu, lần gần nhất, số lần vào).
  Mỗi lần duyệt tay, chạy quét hoặc đổi link bài viết, nhật ký (`logs\`, tab Nhật ký) ghi kèm Gmail người làm.
- Chỉ trên máy chạy tool mới xem được danh sách Gmail và cấp/chặn quyền; người vào từ xa không thấy tab này.
- Đăng nhập giữ trong 7 ngày rồi phải đăng nhập lại.
- Máy Windows phải bật và đã đăng nhập. Giao diện tự chạy ẩn nếu đã cài tự bật cùng Windows
  (`scripts\setup-ui-autostart.ps1`); dịch vụ cloudflared cũng tự chạy. Điện thoại báo lỗi 502 nghĩa là giao diện
  đang tắt: chạy `scripts\restart-ui.ps1`, xem lỗi trong `logs\ui-autostart.log`.
- Tạm đóng truy cập từ xa: xoá route ở bước 5. Gỡ hẳn: xoá route và Tunnel `minigame-pc` trên dashboard, rồi
  chạy `cloudflared.exe service uninstall` trong PowerShell quyền quản trị.
