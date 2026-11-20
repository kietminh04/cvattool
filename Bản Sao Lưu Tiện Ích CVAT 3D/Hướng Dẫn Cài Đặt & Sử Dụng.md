# Hướng Dẫn Cài Đặt & Sử Dụng Tiện Ích Mở Rộng CVAT 3D v2.0

> **Phiên bản**: v2.0.0 (Đồng bộ 100% tính năng & thuật toán bản Desktop EXE)  
> **Áp dụng**: Hoạt động trực tiếp trên hệ thống CVAT mới của công ty (`https://cvat-dc.vantixapps.net`, `https://cvat-test.vantixapps.net`).  
> **Không cần API Key**: Tự động dùng phiên đăng nhập (Session Cookies) của trình duyệt. Không cào ảnh, không tải PCD, hoàn toàn an toàn bảo mật.

---

## 1. Cách Cài Đặt Vào Trình Duyệt (Chrome / Edge)

1. Mở trình duyệt Chrome hoặc Microsoft Edge.
2. Truy cập vào đường dẫn quản lý tiện ích:
   - Chrome: `chrome://extensions/`
   - Edge: `edge://extensions/`
3. Bật công tắc **Chế độ dành cho nhà phát triển (Developer mode)** ở góc trên bên phải.
4. Chọn nút **Tải tiện ích đã giải nén (Load unpacked)**.
5. Trỏ tới thư mục:
   `D:\KPI Vinfast\Tiện Ích Mở Rộng CVAT 3D`  
   *(Hoặc giải nén từ tệp `Tiện Ích Mở Rộng CVAT 3D.zip`)*.
6. Tiện ích **"Trợ Lý Căn Chỉnh CVAT 3D" (v2.0.0)** sẽ xuất hiện ngay trong danh sách tiện ích của bạn.

---

## 2. Các Tính Năng Nổi Bật v2.0

### 2.1. Cửa Sổ Căn Chỉnh Toàn Bộ Chi Tiết (Canvas 2D Trực Quan)
- **Cách mở**: Chọn một Track đối tượng trên CVAT rồi bấm nút **`🔍 Chi Tiết Track`** trên thanh công cụ HUD (hoặc nhấn phím tắt **`Alt + E`**).
- **Bộ Vẽ Trực Quan Hình Học 3 Góc Nhìn (Zero Bandwidth)**:
  - **🔝 TOP VIEW (Trục X-Y: Dọc - Ngang)**: Vẽ hình chữ nhật kích thước xe ($L \times W$), tâm đối xứng, và **mũi tên hướng đầu xe ➡️**.
  - **🚗 SIDE VIEW (Trục L-H: Dọc - Cao)**: Vẽ cạnh sườn xe ($L \times H$), mũi tên chỉ đầu xe sang phải và **đường đáy mặt đất màu xanh lá**.
  - **🚘 FRONT VIEW (Trục W-H: Ngang - Cao)**: Vẽ mặt trực diện xe ($W \times H$) và trục đối xứng.
- **Thanh công cụ trong Modal**:
  - `[🚀 Tự Động Căn Track]`: Chạy thuật toán v2.0 khóa kích thước Prior, khử lật 180°, khớp dốc mặt đường Z và làm mượt quỹ đạo cho riêng track này.
  - `[📊 Chọn Khoảng]`: Mở hộp thoại chọn nhanh từ Frame $A$ đến Frame $B$.
  - `[☑️ Chọn Cả / ⬜ Bỏ Chọn Cả]`: Bật/tắt chọn toàn bộ 60 frames.
  - `[🪄 Quét Outside]` / `[✨ Bỏ Outside]`: Đánh dấu hoặc gỡ Outside cho các frame đang chọn.
  - `[↩ Hoàn Tác (Undo)]` & `[↪ Làm Lại (Redo)]`: Lưu lịch sử lên đến 50 bước thao tác.
  - `[💾 Áp Dụng & Lưu]`: Gửi dữ liệu cập nhật thẳng lên máy chủ CVAT.

### 2.2. Khắc Phục Lỗi Kẹt Nút Thu Nhỏ (Draggable Floating Badge)
- Nút thu nhỏ `⚡ CVAT 3D` giờ đây là một phần tử độc lập, **mặc định nằm gọn gàng ở góc trên bên phải màn hình** (`top: 14px; right: 80px;`), không còn bị kẹt đơ ở giữa màn hình như trước.
- Người dùng có thể **kéo thả tự do** nút thu nhỏ này đến bất kỳ vị trí nào, trình duyệt sẽ tự động ghi nhớ vị trí cuối cùng.
- Nhấp chuột vào nút để bung mở lại toàn bộ thanh công cụ HUD.

### 2.3. Bộ Thuật Toán Căn Chỉnh v2.0 (Đồng Bộ Chuẩn Bản Desktop)
1. **Khóa Kích Thước Prior (Vehicle Dimension Prior Snapping)**:
   - Sedan / Crossover: Khóa cố định $4.33\text{m} \times 1.90\text{m} \times 1.53\text{m}$, triệt tiêu hoàn toàn lỗi phình to kích thước ($4.66\text{m}$).
   - Xe hai bánh: Khóa cố định $1.90\text{m} \times 0.80\text{m} \times 1.45\text{m}$.
   - Người đi bộ: Khóa cố định $0.80\text{m} \times 0.80\text{m} \times 1.70\text{m}$.
2. **Khử Lật Góc 180° (Yaw Stabilization)**: Dùng Circular Median tự động phát hiện và xoay lật lại $180^\circ$ cho các frame bị lộn đầu xe.
3. **Bảo Tồn Dốc Mặt Đường Z**: Làm mượt chuỗi cao độ đáy $Z_{\text{bottom}}$, bảo toàn độ dốc tự nhiên khi xe lên dốc/xuống dốc.
4. **Làm Mượt Quỹ Đạo Tâm X-Y**: Triệt tiêu hiện tượng giật cục rung lắc giữa các frame kế cận.
5. **Soi Trùng Lặp & Quét Outside**: Tự động dọn dẹp các box đè nhau và phát hiện bước nhảy teleport đột biến.

---

## 3. Danh Mục Phím Tắt Tiện Dụng

| Phím Tắt | Chức Năng |
| :--- | :--- |
| **`Alt + E`** | Mở ngay cửa sổ **Căn Chỉnh Toàn Bộ Chi Tiết** (Canvas 2D) cho Track hiện tại |
| **`Alt + D`** | Đồng bộ kích thước $L, W, H$ cho toàn bộ các frame của Track |
| **`Alt + R`** | Đảo đầu xe $180^\circ$ tại frame hiện tại |
| **`Alt + W`** | Nâng cao độ $Z$ lên $+5\text{cm}$ |
| **`Alt + S`** | Hạ cao độ $Z$ xuống $-5\text{cm}$ |

---

## 4. Kiểm Thử & Xác Thực

- Toàn bộ các module JavaScript đã vượt qua bài kiểm tra cú pháp và kiểm thử tự động 100%.
- Không chứa bất kỳ câu lệnh cào ảnh hay tải PCD nào, an toàn tuyệt đối trên mạng nội bộ công ty.
