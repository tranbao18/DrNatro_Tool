# DrNatro Minigame Tool

Tool quét bình luận của bài minigame trong group Facebook, lọc theo luật minigame và ghi kết quả vào Google Sheet. Chạy trên máy Windows, cập nhật mỗi giờ, tự dừng sau mốc chốt.

## Luật minigame được áp dụng

Một user được tính khi có **một bình luận** thoả:

1. Tag **5 người khác nhau** trong cùng bình luận (tag chủ post tính, tag chính mình không tính).
2. Là **thành viên group** (tool tự kiểm tra bằng tài khoản admin).
3. Đã **share công khai** bài viết (tool đối chiếu danh sách "Người đã chia sẻ"; trường hợp không thấy sẽ để team duyệt tay).

Nếu user có nhiều bình luận đủ tag, tool lấy bình luận có **tổng tương tác cao nhất** (lượt thích + lượt trả lời).

Trạng thái trong sheet:

| Trạng thái | Ý nghĩa |
|---|---|
| ĐỦ ĐIỀU KIỆN | Đủ tag, là thành viên, có trong danh sách share công khai, hoặc được duyệt tay "OK" |
| CHỜ DUYỆT | Đủ tag nhưng share hoặc thành viên chưa xác nhận tự động được. Team kiểm tra rồi ghi OK hoặc LOẠI vào cột "Duyệt tay" |
| LOẠI | Không phải thành viên, hoặc duyệt tay ghi "LOẠI" |

User không đủ 5 tag nằm ở tab **Bị loại** kèm lý do.

## Cài đặt lần đầu (Windows)

### 1. Cài Node.js

Tải bản LTS tại https://nodejs.org (Node 18 trở lên). Mở PowerShell, kiểm tra:

```powershell
node -v
```

### 2. Tải code và cài thư viện

```powershell
git clone https://github.com/tranbao18/DrNatro_Tool.git
cd DrNatro_Tool
npm install
npx playwright install chromium
```

### 3. Tạo Google Service Account (để tool ghi vào sheet)

1. Vào https://console.cloud.google.com, tạo project mới (hoặc dùng project có sẵn).
2. Menu **APIs & Services → Library**, tìm **Google Sheets API**, bấm **Enable**.
3. Menu **APIs & Services → Credentials → Create credentials → Service account**. Đặt tên bất kỳ, bấm Done.
4. Bấm vào service account vừa tạo → tab **Keys → Add key → Create new key → JSON**. File JSON sẽ được tải về.
5. Đổi tên file đó thành `service-account.json` và chép vào thư mục `DrNatro_Tool`.
6. Mở file JSON, copy giá trị `client_email` (dạng `xxx@xxx.iam.gserviceaccount.com`).
7. Mở Google Sheet kết quả → **Share** → dán email đó → quyền **Editor**.

### 4. Tạo file cấu hình

Copy `config.example.json` thành `config.json` rồi sửa:

| Khoá | Ý nghĩa |
|---|---|
| `postUrl` | Link bài viết minigame (bắt buộc khi chạy quét) |
| `groupUrl` | Link group |
| `sheetId` | Chuỗi giữa `/d/` và `/edit` trong link Google Sheet |
| `freezeAt` | Mốc chốt. Sau mốc này tool không cập nhật nữa. Mặc định `2026-10-21T00:00:00+07:00` (hết ngày 20/10) |
| `intervalMinutes` | Chu kỳ chạy ở chế độ watch, mặc định 60 |
| `finalRunLeadMinutes` | Lần chạy chốt cuối bắt đầu trước `freezeAt` bao nhiêu phút, mặc định 15 (tức 23:45 ngày 20/10). Ghi `0` để tắt |
| `rules.requiredTags` | Số người phải tag, mặc định 5 |
| `rules.countSelfTag` | Tính tag chính mình hay không, mặc định `false` |
| `rules.includeReplies` | Tính cả bình luận trả lời làm bài dự thi hay không, mặc định `false` |
| `browser.headless` | `false` để thấy cửa sổ trình duyệt (khuyên dùng, ít bị Facebook chặn hơn) |
| `browser.channel` | Để trống dùng Chromium của Playwright. Ghi `chrome` để dùng Google Chrome đã cài trên máy |
| `limits.maxMemberChecksPerRun` | Số user kiểm tra thành viên tối đa mỗi lần chạy, phần còn lại chạy lần sau |
| `limits.minCommentRatio` | Nếu số bình luận đọc được thấp hơn tỉ lệ này so với lần chạy trước (mặc định `0.8` = 80%), tool coi là Facebook tải thiếu và không ghi đè sheet. Ghi `0` để tắt |
| `memberCheck` | `auto` để tự kiểm tra thành viên, `off` để chỉ duyệt tay |
| `debug.dumpGraphql` | `true` để lưu dữ liệu thô vào `data/debug/` khi cần dev xem lỗi |

### 5. Đăng nhập Facebook (một lần)

```powershell
npm run login
```

Cửa sổ trình duyệt mở ra, đăng nhập bằng **tài khoản phụ là admin group**. Phiên đăng nhập lưu trong `data/profile`, không lưu mật khẩu. Khi Facebook yêu cầu đăng nhập lại, chạy lại lệnh này.

### 6. Kiểm tra kết nối sheet

```powershell
npm run check-sheet
```

## Chạy

Quét một lần:

```powershell
npm start
```

Chạy lặp mỗi giờ trong một cửa sổ PowerShell mở sẵn:

```powershell
npm run watch
```

Hoặc đặt lịch Windows Task Scheduler chạy mỗi giờ kể cả khi đóng PowerShell (máy phải bật và đang đăng nhập Windows; chạy được cả khi máy dùng pin). Lịch có thêm một lần chạy chốt cuối lúc `freezeAt` trừ `finalRunLeadMinutes`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-schedule.ps1
```

Chỉ dùng **một** trong hai cách (watch hoặc lịch), vì cả hai dùng chung phiên đăng nhập trong `data/profile`. Khi đổi `freezeAt` hoặc `finalRunLeadMinutes`, chạy lại lệnh trên để cập nhật lịch.

Gỡ lịch: `powershell -ExecutionPolicy Bypass -File .\scripts\remove-schedule.ps1`. Log của lịch nằm ở `logs\scheduler.log`, log chi tiết theo ngày ở `logs\`.

## Google Sheet đầu ra

| Tab | Nội dung |
|---|---|
| Danh sách | Mỗi user đủ 5 tag một dòng: tên, link profile, trạng thái, lý do, kết quả kiểm tra thành viên và share, cột **Duyệt tay** và **Ghi chú duyệt** (tool không ghi đè hai cột này), lượt thích, lượt trả lời, tổng tương tác, link và nội dung bình luận |
| Bị loại | User có bình luận nhưng không đủ 5 tag |
| Lịch sử | Mỗi ngày một dòng cho mỗi user: lượt thích, trả lời, tổng tương tác. Dùng để đối chiếu khi chốt |
| Hệ thống | Lần chạy gần nhất, số liệu tổng, lỗi gần nhất, trạng thái chốt |

Cột **Duyệt tay** chấp nhận `OK` (hoặc Đạt, Duyệt) và `LOẠI` (hoặc Không, X). Ghi OK sẽ đưa user lên ĐỦ ĐIỀU KIỆN kể cả khi tool chưa xác nhận được share. Ghi LOẠI sẽ loại user đó.

Quyết định duyệt tay được lưu theo User ID trong `data/state.json`. Nếu một lần quét không tải được bình luận của ai đó, dòng của họ tạm biến khỏi tab Danh sách nhưng quyết định vẫn được giữ và tự điền lại khi họ xuất hiện trở lại. Muốn bỏ quyết định, xoá trắng ô Duyệt tay và Ghi chú duyệt của user đó.

Bảng được sắp xếp lại sau mỗi lần chạy. Khi nhập Duyệt tay, kiểm tra lại tên trên dòng trước khi gõ và tránh nhập đúng lúc tool đang ghi (giờ chạy xem ở tab Hệ thống).

## Chốt kết quả

Tool cập nhật đến hết ngày 20/10/2026:

- Lúc 23:45 ngày 20/10 (`freezeAt` trừ `finalRunLeadMinutes`) tool chạy **lần chốt cuối**. Lần chạy nào bắt đầu trong khoảng 23:45 đến trước 00:00 đều là lần chốt cuối. Chạy xong, tool ghi "ĐÃ CHỐT" vào tab Hệ thống và không cập nhật nữa, kể cả khi còn vài phút mới tới 00:00.
- Nếu lần chốt cuối bị lỗi, lần chạy tiếp theo trước 00:00 sẽ thử lại. Từ 00:00 ngày 21/10/2026, mỗi lần chạy chỉ ghi "ĐÃ CHỐT" và không sửa số liệu.
- Lần chạy bắt đầu trước 00:00 nhưng ghi xong sau 00:00 vẫn tính vào ngày 20/10 trong tab Lịch sử. Dòng "Lần chạy gần nhất" ở tab Hệ thống ghi cả giờ bắt đầu và giờ xong.

Muốn đổi mốc, sửa `freezeAt` trong `config.json` (rồi chạy lại `setup-schedule.ps1` nếu dùng lịch).

## Cách tool hoạt động

1. Mở bài viết bằng Chromium (Playwright), chuyển sang "Tất cả bình luận", bấm "Xem thêm bình luận" và "Xem phản hồi" cho tới khi hết.
2. Đọc dữ liệu từ phản hồi GraphQL của Facebook thay vì đọc giao diện, nên lấy được ID user chính xác, số người được tag, lượt thích, lượt trả lời.
3. Mở hộp thoại "Người đã chia sẻ bài viết" để lấy danh sách người share và chế độ riêng tư.
4. Với mỗi user đủ tag, mở trang hồ sơ thành viên trong group `groups/<id>/user/<uid>` để xác nhận là thành viên. Nếu trang vừa có dấu hiệu là thành viên vừa có chữ kiểu "không khả dụng"/"rời nhóm" (thường nằm trong bài viết của chính họ), tool không tự loại mà để CHỜ DUYỆT. Kết quả cache 24 giờ trong `data/state.json`.
5. Nếu số bình luận đọc được tụt mạnh so với lần trước, tool dừng và giữ nguyên sheet (xem mục Lưu ý).
6. Đọc cột duyệt tay hiện có, gộp với bản lưu trong `data/state.json`, tính trạng thái, ghi lại 4 tab.

## Lưu ý và xử lý sự cố

- **Facebook đổi giao diện** khiến tool không bấm được nút hoặc không đọc được dữ liệu: bật `debug.dumpGraphql: true`, chạy lại, gửi thư mục `data/debug/` cho dev để chỉnh bộ đọc.
- **Không đọc được bình luận nào**: kiểm tra `postUrl`, tài khoản có xem được bài không, hoặc đã bị đăng xuất (chạy `npm run login`).
- **Lỗi "Chỉ đọc được X bình luận, ít hơn nhiều so với Y ở lần chạy trước"**: tool nghi Facebook tải thiếu nên giữ nguyên sheet. Nếu 3 lần liên tiếp vẫn thấp, tool coi là bình luận bị xoá thật và cập nhật bình thường. Nếu chắc chắn bình luận đã bị xoá và muốn cập nhật ngay, tạm đặt `limits.minCommentRatio` thành `0` rồi chạy `npm start`.
- **Lỗi 403 từ Google**: chưa share sheet cho email service account với quyền Editor.
- **Tài khoản bị checkpoint**: đăng nhập lại trong `npm run login`, giảm tần suất bằng `intervalMinutes`, giảm `limits.maxMemberChecksPerRun`.
- Tool chỉ dùng tài khoản Facebook đã đăng nhập trong trình duyệt, không lưu mật khẩu. File `service-account.json`, `config.json`, thư mục `data/` và `logs/` đã nằm trong `.gitignore`, không được đưa lên Git.
- Việc tự động hoá trình duyệt trái với điều khoản Facebook. Chỉ dùng tài khoản phụ và chấp nhận rủi ro tài khoản đó bị hạn chế.

## Kiểm thử

```powershell
npm test
```

Kiểm thử logic lọc, chọn bình luận tốt nhất, đọc dữ liệu GraphQL và dựng dòng sheet. Phần thao tác với Facebook thật chỉ kiểm chứng được khi chạy thực tế.
