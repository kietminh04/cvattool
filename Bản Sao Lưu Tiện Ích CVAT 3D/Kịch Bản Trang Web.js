

/**

 * Kịch Bản Trang Web v2.6.2 (CVAT 3D Toolbar Content Script)

 * Nhúng thanh công cụ ngang (Horizontal Toolbar Ribbon) đồng bộ 1 khung duy nhất giống bản Desktop

 * Kết nối REST API CVAT không cần API key (chạy bằng Session Cookies)

 * Cửa sổ Căn Chỉnh Toàn Bộ Chi Tiết từng frame với bộ vẽ Canvas 2D Vector Projection

 */



(function () {

    console.log("%c[CVAT 3D Assistant v2.7.0]%c Khởi động Toolbar hợp nhất...", "color: #38bdf8; font-weight: bold;", "color: inherit;");



    let currentAnnotations = null;

    let currentLabels = {};

    let selectedTrackId = null;



    // Undo / Redo cho Modal Chi Tiết

    let modalUndoStack = [];
let modalSelectedFrames = new Set();

    let modalRedoStack = [];

    let activeModalTrack = null;

    function capNhatGiaoDienCacNutKhoaDim() {
        if (!activeModalTrack) return;
        ['l', 'w', 'h'].forEach(dim => {
            const btn = document.getElementById(`modal-btn-lock-${dim}`);
            if (!btn) return;
            const isLocked = Boolean(activeModalTrack[`lock_${dim}`]);
            if (isLocked) {
                btn.textContent = '🔒';
                btn.style.background = '#b45309';
                btn.style.color = '#fef08a';
                btn.style.borderColor = '#f59e0b';
                btn.title = `Đang khóa chiều ${dim.toUpperCase()}. Bấm để mở khóa`;
            } else {
                btn.textContent = '🔓';
                btn.style.background = '#1e293b';
                btn.style.color = '#94a3b8';
                btn.style.borderColor = '#475569';
                btn.title = `Khóa chiều ${dim.toUpperCase()}: Giữ nguyên khi căn tự động`;
            }
        });
    }



    /**

     * Tự động khởi tạo giao diện khi vào trang Job hoặc Task

     */

    function kiemTraVaNhungHUD() {
        const url = window.location.href;
        if (!url.includes('/jobs/') && !url.includes('/tasks/')) {
            return;
        }

        const jobId = window.quanLyAPICVAT ? window.quanLyAPICVAT.layJobIdTuURL() : null;
        if (!jobId) return;

        if (!document.getElementById('cvat-3d-assistant-wrapper')) {
            nhungGiaoDienHUD();
            napDuLieuBanDau();
            khoiTaoTheoDoiFrame();
            khoiTaoPhimTat();
        } else if (window.quanLyAPICVAT && window.quanLyAPICVAT.jobId !== jobId) {
            console.log(`[CVAT 3D] URL chuyển sang Job #${jobId}, tự động làm mới...`);
            window.quanLyAPICVAT.jobId = jobId;
            window.quanLyAPICVAT.cacheAnnotations = null;
            currentAnnotations = null;
            napDuLieuBanDau();
        }
    }



    /**

     * Theo dõi SPA URL Navigation (React Router)

     */

    function khoiTaoSPAListener() {

        const rawPushState = history.pushState;

        history.pushState = function () {

            rawPushState.apply(this, arguments);

            setTimeout(kiemTraVaNhungHUD, 400);

        };

        const rawReplaceState = history.replaceState;

        history.replaceState = function () {

            rawReplaceState.apply(this, arguments);

            setTimeout(kiemTraVaNhungHUD, 400);

        };

        window.addEventListener('popstate', () => {

            setTimeout(kiemTraVaNhungHUD, 400);

        });

        setInterval(kiemTraVaNhungHUD, 1500);

    }



    /**

     * Nhúng giao diện HUD Toolbar & Badge độc lập vào trang web

     */

    function nhungGiaoDienHUD() {

        if (document.getElementById('cvat-3d-assistant-wrapper')) return;



        // HTML template nhúng trực tiếp đồng bộ (Zero fetch, Zero CSP block, Instant injection)

        const hudHtml = `<!-- Giao Diện HUD Toolbar & Modal Chi Tiết CVAT 3D v2.0 -->

<div id="cvat-3d-assistant-wrapper">

    <div id="cvat-3d-assistant-hud">

        <!-- Header Thanh Công Cụ (Draggable) -->

        <div class="hud-header" id="hud-drag-header">

            <div class="hud-header-left">

                <span class="hud-drag-handle">⋮⋮</span>

                <span class="hud-logo">⚡</span>

                <span class="hud-title">CVAT 3D TOOLBAR v2.7.0</span>

                <span class="hud-job-pill" id="hud-job-badge">🟢 Đang kết nối...</span>
                <button class="hud-cam-map-btn" id="btn-hud-cam-map" title="Tự nối các ảnh 2D vào đúng góc hướng Camera (Front, Back-Left, Back-Right...)">📷 Nối Góc Cam</button>
                <button class="hud-qc-tool-btn" id="btn-hud-qc-tool" title="Kiểm định chất lượng 3D Annotation: đồng bộ size, ngưỡng kích thước, xoay đột ngột, chồng lấn box">🛡️ QC Tool</button>

            </div>

            <div class="hud-header-right">

                <button class="hud-btn-icon" id="btn-hud-reload" title="Tải lại dữ liệu mới nhất từ Server CVAT">🔄</button>

                <button class="hud-btn-icon" id="btn-hud-minimize" title="Thu gọn thành nút mini ở góc">➖</button>

            </div>

        </div>



        <!-- KHUNG MENU ĐIỀU KHIỂN TRACK -->

        <div class="hud-menu-container">

            <!-- ĐIỀU KHIỂN & ĐỒNG BỘ TRACK ĐANG CHỌN -->

            <div class="hud-track-row">

                <div class="hud-track-group">

                    <span class="hud-label-accent">🎯 Track:</span>

                    <input type="number" class="hud-mini-input" id="inp-track-id" placeholder="ID" min="1" title="Track ID đang thao tác" />

                    <button class="hud-btn-action" id="btn-lay-track-hien-tai" title="Đọc ID và kích thước từ vật thể đang chọn">🎯 Lấy Track</button>

                    <button class="hud-btn-action hud-btn-detail" id="btn-mo-chi-tiet-track" title="Mở bảng Căn Chỉnh Toàn Bộ Chi Tiết từng frame với bộ vẽ Canvas 2D (Alt + E)">🔍 Chi Tiết Track</button>
                    <button class="hud-btn-action btn-hud-can-track-don" id="btn-hud-can-track-don" title="Tự động căn chỉnh riêng Track này theo chuẩn Master Pipeline (Khớp đường, Khóa size, Ép vỏ xe 2cm)">🚀 Căn Track</button>
                    <button class="hud-btn-action hud-btn-lock-track" id="btn-hud-lock-track" title="Khóa bảo vệ Track: Chống tất cả thuật toán tự động làm thay đổi kích thước/tọa độ đã chỉnh tay">🔓 Cho Phép Căn Chỉnh</button>

                </div>



                <div class="hud-dim-group">

                    <span class="hud-dim-tag red">L</span>

                    <input type="number" step="0.01" class="hud-dim-input" id="inp-dim-l" placeholder="4.33" />

                    <span class="hud-dim-tag green">W</span>

                    <input type="number" step="0.01" class="hud-dim-input" id="inp-dim-w" placeholder="1.90" />

                    <span class="hud-dim-tag blue">H</span>

                    <input type="number" step="0.01" class="hud-dim-input" id="inp-dim-h" placeholder="1.53" />

                    <button class="hud-btn-success" id="btn-dong-bo-track-don" title="Đồng bộ kích thước này cho toàn bộ frame của Track (Alt + D)">

                        🔄 Đồng Bộ Size

                    </button>
                    <button class="hud-btn-action hud-btn-lock-size" id="btn-hud-lock-size" title="Cấu hình Khóa Kích Thước chuyên sâu (Key Frame, L, W, H) - Giữ nguyên kích thước vẽ tay khi căn chỉnh">
                        🔒 Khóa Size
                    </button>

                </div>



                <div class="hud-nudge-group">

                    <button class="hud-btn-primary" id="btn-dao-dau-xe" title="Đảo đầu xe 180 độ tại frame hiện tại (Alt + R)">

                        🔄 Đảo 180°

                    </button>

                </div>



                <button class="hud-btn-stats-toggle" id="btn-toan-job-thong-ke" title="Bật/Tắt bảng Thống Kê Chi Tiết">

                    📊 Thống Kê ▾

                </button>

            </div>



            <!-- BẢNG THỐNG KÊ CHI TIẾT -->

            <div id="hud-stats-panel" class="hud-stats-panel" style="display: none;">

                <div class="stats-grid">

                    <div class="stats-card">

                        <div class="stats-card-title">📌 THÔNG TIN JOB</div>

                        <div class="stats-row"><span class="stats-label">Mã Job:</span><span class="stats-val cyan" id="stat-job-id">#--</span></div>

                        <div class="stats-row"><span class="stats-label">Khung hình:</span><span class="stats-val green" id="stat-frames">0 / 60</span></div>

                        <div class="stats-row"><span class="stats-label">Đủ 60 frame:</span><span class="stats-val purple" id="stat-complete-pct">-- %</span></div>

                    </div>



                    <div class="stats-card">

                        <div class="stats-card-title">🎯 TRẠNG THÁI TRACKS</div>

                        <div class="stats-row"><span class="stats-label">Tổng số Tracks:</span><span class="stats-val cyan" id="stat-total-tracks">--</span></div>

                        <div class="stats-row"><span class="stats-label">Hoạt động (Active):</span><span class="stats-val green" id="stat-active-tracks">--</span></div>

                        <div class="stats-row"><span class="stats-label">Đã gán Outside:</span><span class="stats-val amber" id="stat-outside-tracks">--</span></div>

                    </div>



                    <div class="stats-card">

                        <div class="stats-card-title">🚗 PHÂN LOẠI ĐỐI TƯỢNG</div>

                        <div class="stats-row"><span class="stats-label">🚗 Vehicles (Ô tô):</span><span class="stats-val cyan" id="stat-count-vehicles">--</span></div>

                        <div class="stats-row"><span class="stats-label">🏍️ Two-Wheels (Xe máy):</span><span class="stats-val amber" id="stat-count-twowheels">--</span></div>

                        <div class="stats-row"><span class="stats-label">🚶 Pedestrian (Người):</span><span class="stats-val green" id="stat-count-pedestrian">--</span></div>

                    </div>

                </div>



                                                <!-- BỘ LỌC THỐNG KÊ (LOẠI XE & FRAMES) -->
                <div class="stats-filter-bar">
                    <div class="stats-filter-row">
                        <!-- 1. Chọn Loại Xe -->
                        <div class="filter-type-group">
                            <span class="filter-group-title">🔍 Lọc:</span>
                            <span class="filter-sub-title">Chọn loại xe:</span>
                            <button class="btn-stats-filter-type active" data-type="all">Tất Cả</button>
                            <button class="btn-stats-filter-type" data-type="vehicles">🚗 Vehicles</button>
                            <button class="btn-stats-filter-type" data-type="two-wheels">🏍️ Two-Wheels</button>
                            <button class="btn-stats-filter-type" data-type="pedestrian">🚶 Pedestrian</button>
                        </div>

                        <!-- 2. Chọn Frames -->
                        <div class="filter-frame-group">
                            <span class="filter-sub-title">Chọn frames:</span>
                            <button class="btn-stats-frame-all active" id="btn-stats-frame-all" title="Xem danh sách đối tượng trên toàn bộ 60 frames của Job">Tất Cả Frames</button>
                            <div class="stats-frame-picker-inline" id="stats-frame-picker-box">
                                <button class="btn-stats-frame-step" id="btn-stats-frame-prev" title="Frame trước">◀</button>
                                <div class="stats-frame-input-wrap">
                                    <span class="stats-frame-prefix">Frame</span>
                                    <input type="number" id="inp-stats-filter-frame" min="0" max="59" value="0" class="inp-stats-filter-frame" title="Nhập số frame cần lọc" />
                                </div>
                                <button class="btn-stats-frame-step" id="btn-stats-frame-next" title="Frame tiếp theo">▶</button>
                                <button class="btn-stats-frame-sync" id="btn-stats-frame-cur-cvat" title="Lấy nhanh số frame đang phát trên timeline CVAT">
                                    ⏱️ Theo CVAT (<span id="stats-val-cur-cvat-frame">0</span>)
                                </button>
                                <label class="stats-filter-chk-label" title="Chỉ hiện các track đang hoạt động (ẩn các xe bị gắn cờ Outside tại frame này)">
                                    <input type="checkbox" id="chk-stats-frame-active-only" checked />
                                    <span>Chỉ Active</span>
                                </label>
                            </div>
                            <button class="btn-stats-reset-all" id="btn-stats-reset-all" title="Khôi phục toàn bộ bộ lọc về mặc định">🔄 Đặt Lại</button>
                        </div>
                    </div>
                    <div id="stats-filter-status-banner" class="stats-filter-status-banner" style="display: none;">
                        <span id="stats-filter-status-text">Đang lọc: ...</span>
                    </div>
                </div>

                <div class="stats-detail-section">
                    <div class="stats-class-box vehicle">
                        <div class="stats-class-header">
                            <span class="stats-class-title cyan" id="stat-title-vehicles">🚗 Vehicles (<span id="stat-list-vehicles-count">0</span> tracks) — <i>Bấm vào ID để chọn ngay:</i></span>
                            <button class="stats-copy-btn cyan" id="btn-copy-vehicles-ids">📋 Chọn Tất Cả</button>
                        </div>
                        <div class="stats-chips-container" id="stat-chips-vehicles"></div>
                    </div>

                    <div class="stats-class-box twowheel">
                        <div class="stats-class-header">
                            <span class="stats-class-title amber" id="stat-title-twowheels">🏍️ Two-Wheels (<span id="stat-list-twowheels-count">0</span> tracks):</span>
                            <button class="stats-copy-btn amber" id="btn-copy-twowheels-ids">📋 Chọn Tất Cả</button>
                        </div>
                        <div class="stats-chips-container" id="stat-chips-twowheels"></div>
                    </div>

                    <div class="stats-class-box pedestrian">
                        <div class="stats-class-header">
                            <span class="stats-class-title green" id="stat-title-pedestrian">🚶 Pedestrian (<span id="stat-list-pedestrian-count">0</span> tracks):</span>
                            <button class="stats-copy-btn green" id="btn-copy-pedestrian-ids">📋 Chọn Tất Cả</button>
                        </div>
                        <div class="stats-chips-container" id="stat-chips-pedestrian"></div>
                    </div>
                </div>



            <!-- THANH TRẠNG THÁI -->

            <div class="hud-status-bar">

                <span class="hud-status-text" id="hud-status-message">⚡ CVAT 3D Toolbar v2.7.0 • Sẵn sàng thao tác</span>

                <span class="hud-status-counts" id="hud-stats-summary">-- Tracks • -- Frames</span>

            </div>

        
        
    </div>

    </div>

</div>



<!-- NÚT PILL THU GỌN NỔI ĐỘC LẬP (DRAGGABLE - KHÔNG BỊ TRÓI Ở GIỮA MÀN HÌNH) -->

<div id="cvat-3d-assistant-badge" style="display: none;">

    <span class="badge-drag-dot">⋮⋮</span>

    <span class="badge-logo">⚡</span>

    <span class="badge-title">CVAT 3D</span>

</div>



<!-- MODAL CĂN CHỈNH TOÀN BỘ CHI TIẾT (ĐỒNG BỘ CHUẨN EXE) -->

<div id="cvat-detail-modal" class="cvat-modal-overlay" style="display: none;">

    <div class="cvat-modal-dialog">

        <!-- Modal Top Bar -->

        <div class="modal-top-bar" id="modal-drag-header">

            <div class="modal-title-left">
                <div class="modal-title-top-row">
                    <span class="modal-icon">🎯</span>
                    <span class="modal-title" id="modal-track-title" style="display:inline-flex;align-items:center;gap:4px;">
                        <span>CĂN CHỈNH CHI TIẾT TRACK</span>
                        <span class="modal-track-id-editor" title="Nhập ID Track hoặc bấm ◀ ▶ để chuyển nhanh giữa các Track">
                            <span style="color:#38bdf8;font-weight:900;font-size:13px;">#</span>
                            <button type="button" class="btn-header-track-step" id="modal-btn-prev-track" title="Chuyển sang Track trước">◀</button>
                            <input type="number" id="modal-inp-header-track-id" class="inp-header-track-id" min="1" value="1" title="Nhập số Track ID rồi nhấn Enter để chuyển ngay" />
                            <button type="button" class="btn-header-track-step" id="modal-btn-next-track" title="Chuyển sang Track tiếp theo">▶</button>
                        </span>
                        <span id="modal-track-frames-count">(10 FRAMES)</span>
                    </span>
                </div>
                <div class="modal-track-meta-row">
                    <span id="modal-track-label-badge" class="badge-track-label">vehicles</span>
                    <div id="modal-track-attr-container" style="display: inline-flex; align-items: center; gap: 6px;"></div>
                </div>
            </div>

            <!-- Cụm nút hệ thống & Lưu ở góc phải Hàng 1 -->
            <div class="modal-system-actions">
                <button class="btn-m-icon" id="modal-btn-undo" title="Hoàn tác thao tác trước (Undo)">↩</button>
                <button class="btn-m-icon" id="modal-btn-redo" title="Làm lại thao tác vừa hủy (Redo)">↪</button>
                <button class="btn-m-action btn-m-approve" id="modal-btn-approve" data-state="CHUA" title="Đánh dấu Duyệt ID này làm điểm neo chuẩn (Click: cả Track · Shift+Click: riêng Frame hiện tại; cần bấm Lưu để chốt vĩnh viễn)">✓ Duyệt</button>
                <button class="btn-m-action btn-m-unapprove" id="modal-btn-unapprove" style="display:none;" title="Hủy duyệt vĩnh viễn (Click: cả Track · Shift+Click: riêng Frame hiện tại)">Hủy duyệt</button>
                <button class="btn-m-action btn-m-save" id="modal-btn-save" title="Lưu các thay đổi lên máy chủ CVAT (đồng thời chốt Duyệt hoặc cập nhật neo đã duyệt nếu có) và đóng cửa sổ">
                    💾 Lưu
                </button>
                <span class="modal-approve-badge" id="modal-approve-badge" style="display:none;"></span>
                <button class="btn-m-action btn-m-restore" id="modal-btn-restore" style="display:none;background:#22c55e;color:#fff;border:1px solid #4ade80;border-radius:4px;padding:4px 12px;font-weight:bold;cursor:pointer;font-size:12px;box-shadow:0 0 10px rgba(34,197,94,0.5);" title="Phóng to modal lại kích thước đầy đủ (hoặc phím M)">🗖 Phóng To</button>
                <button class="btn-m-icon btn-m-minimize" id="modal-btn-minimize" title="Thu nhỏ modal thành thanh nổi ở góc (hoặc phím M)">➖</button>
                <button class="btn-m-icon btn-m-close" id="modal-btn-close" title="Đóng cửa sổ">✕</button>
            </div>

        </div>

        <!-- HÀNG 2: MENU CÔNG CỤ THAO TÁC TRACK (CHỐNG TRÀN 100%) -->
        <div class="modal-actions-menu-row" id="modal-actions-menu-row">
            <button class="btn-m-action btn-m-full-job" id="modal-btn-toggle-full-job" title="Chuyển đổi giữa Hiện chỉ frames có Box và Hiện toàn bộ frames của Job">
                🌐 Hiện Đủ Frames Job
            </button>
            <button class="btn-m-action btn-m-auto-align" id="modal-btn-auto-align" title="Bấm để mở bảng cấu hình Cỡ Phóng Đại & Phạm Vi Căn Track">
                🚀 Auto fit box ▾
            </button>
            <button class="btn-m-action btn-m-auto-sub" id="modal-btn-auto-sub" title="Các tính năng căn chỉnh riêng lẻ: Căn mặt đường, Căn hướng xe, Ôm khít xe, Xác định chiều cao">
                ⚡ Tính Năng Căn ▾
            </button>
            <button class="btn-m-action btn-m-select-menu" id="modal-btn-select-menu" title="Mở menu chọn frames: Chọn Khoảng hoặc Chọn Tất Cả">
                ☑️ Chọn ▾
            </button>
            <button class="btn-m-action btn-m-scan-out" id="modal-btn-scan-out" title="Mở menu quản lý Outside: Quét Outside, Bỏ Outside (bỏ cờ luôn), Hiện/Ẩn Outside (giữ cờ)">
                🩺 Outside ▾
            </button>
            <button class="btn-m-action btn-m-other-obj" id="modal-btn-toggle-other-obj" title="Bật/Tắt hiển thị bounding box các vật thể khác (Other Objects) • Double-click hoặc Ctrl+Click vào vật thể để chuyển sang Track đó">
                🎯 Other Objects
            </button>
            <button class="btn-m-action btn-m-edit-all" id="modal-btn-edit-all-obj" title="Cho phép kéo/chỉnh sửa trực tiếp tất cả các vật thể trong View TOP & Double-click hoặc Ctrl+Click vào vật thể để chuyển sang Track đó">
                🛠️ Chỉnh Tất Cả
            </button>
            <button class="btn-m-action btn-m-surface" id="modal-btn-surface" title="Tái tạo & hiệu chỉnh lưới mặt đường 3D (Surface)">Surface</button>
        </div>



        <!-- Banner Hướng Dẫn & Thông Báo Tịnh Tiến Kéo Thả Trực Quan -->

                <!-- Banner Hướng Dẫn & Thanh Chỉnh Kích Thước Trực Quan -->
        <div class="modal-sub-bar" id="modal-sub-bar">
            <div class="modal-size-toolbar" id="modal-size-toolbar" style="width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: nowrap; overflow-x: auto;">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: nowrap; white-space: nowrap; flex-shrink: 0;">
                    <div class="size-field" style="display: flex; align-items: center; gap: 2px;">
                        <label style="font-size: 11px; font-weight: bold;">Dài (L):</label>
                        <button class="btn-size-step" data-dim="L" data-dir="-1" title="Giảm 5cm">-</button>
                        <input type="number" id="modal-inp-size-L" step="0.05" min="0.2" max="25" value="4.33" style="width: 48px; text-align: center;" />
                        <button class="btn-size-step" data-dim="L" data-dir="1" title="Tăng 5cm">+</button>
                        <button class="btn-lock-dim" id="modal-btn-lock-l" data-dim="l" title="Khóa chiều Dài (L)" style="background:#1e293b;color:#94a3b8;border:1px solid #475569;border-radius:3px;padding:2px 5px;margin-left:2px;font-size:11px;cursor:pointer;">🔓</button>
                    </div>
                    <div class="size-field" style="display: flex; align-items: center; gap: 2px;">
                        <label style="font-size: 11px; font-weight: bold;">Rộng (W):</label>
                        <button class="btn-size-step" data-dim="W" data-dir="-1" title="Giảm 5cm">-</button>
                        <input type="number" id="modal-inp-size-W" step="0.05" min="0.2" max="10" value="1.90" style="width: 48px; text-align: center;" />
                        <button class="btn-size-step" data-dim="W" data-dir="1" title="Tăng 5cm">+</button>
                        <button class="btn-lock-dim" id="modal-btn-lock-w" data-dim="w" title="Khóa chiều Rộng (W)" style="background:#1e293b;color:#94a3b8;border:1px solid #475569;border-radius:3px;padding:2px 5px;margin-left:2px;font-size:11px;cursor:pointer;">🔓</button>
                    </div>
                    <div class="size-field" style="display: flex; align-items: center; gap: 2px;">
                        <label style="font-size: 11px; font-weight: bold;">Cao (H):</label>
                        <button class="btn-size-step" data-dim="H" data-dir="-1" title="Giảm 5cm">-</button>
                        <input type="number" id="modal-inp-size-H" step="0.05" min="0.2" max="10" value="1.53" style="width: 48px; text-align: center;" />
                        <button class="btn-size-step" data-dim="H" data-dir="1" title="Tăng 5cm">+</button>
                        <button class="btn-lock-dim" id="modal-btn-lock-h" data-dim="h" title="Khóa chiều Cao (H)" style="background:#1e293b;color:#94a3b8;border:1px solid #475569;border-radius:3px;padding:2px 5px;margin-left:2px;font-size:11px;cursor:pointer;">🔓</button>
                    </div>
                </div>
                <div style="display: flex; align-items: center; gap: 8px; flex-wrap: nowrap; white-space: nowrap; flex-shrink: 0;">
                    <div class="size-field" style="gap: 5px;">
                        <label style="color: #38bdf8; font-weight: bold; white-space: nowrap;">🎯 Chọn Frame:</label>
                        <select id="modal-sel-frame-size" style="background:#0f172a;color:#f8fafc;border:1px solid #38bdf8;border-radius:4px;padding:3px 6px;font-size:11px;font-weight:bold;cursor:pointer;">
                        </select>
                    </div>
                    <button class="btn-size-apply" id="modal-btn-apply-size" title="Đồng bộ kích thước đang chọn cho toàn bộ 60 frames" style="background:#0284c7;color:#fff;border:none;border-radius:4px;padding:4px 10px;font-weight:bold;cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap;">🔄 Đồng Bộ Size</button>
                    <button class="btn-lock-track" id="modal-btn-lock-track" style="background:#334155;color:#94a3b8;border:1px solid #475569;border-radius:4px;padding:4px 8px;font-weight:bold;font-size:11px;cursor:pointer;white-space:nowrap;" title="Khóa bảo vệ Track: Chống thuật toán can thiệp làm bóp méo hình vẽ tay">🔓 Cho Phép Căn Chỉnh</button>
                    <div class="size-field" style="gap: 4px; padding: 2px 6px; background: rgba(30, 41, 59, 0.85); border: 1px solid #38bdf8; border-radius: 4px; white-space: nowrap;" title="Điều chỉnh kích thước hạt điểm LiDAR (PP) từ 0.6px đến 3.0px (không bị nhòe to khi zoom)">
                        <label style="color: #cbd5e1; font-weight: bold; font-size: 11px; white-space: nowrap;">✨ Cỡ Điểm:</label>
                        <button class="btn-pt-size-step" id="modal-btn-pt-size-dec" title="Giảm cỡ điểm (nhỏ gọn, sắc nét hơn)" style="padding: 1px 6px; font-weight: bold; cursor: pointer; background: #1e293b; color: #38bdf8; border: 1px solid #475569; border-radius: 3px;">-</button>
                        <span id="modal-lbl-pt-size" style="color: #38bdf8; font-weight: bold; font-size: 11px; min-width: 32px; text-align: center;">1.3px</span>
                        <button class="btn-pt-size-step" id="modal-btn-pt-size-inc" title="Tăng cỡ điểm" style="padding: 1px 6px; font-weight: bold; cursor: pointer; background: #1e293b; color: #38bdf8; border: 1px solid #475569; border-radius: 3px;">+</button>
                    </div>
                </div>
            </div>
        </div>

        <!-- POPOVER CẤU HÌNH TỰ ĐỘNG CĂN TRACK (CARD NỔI TỰ DO XUỐNG DƯỚI, KHÔNG BỊ XÉN) -->
        <div class="modal-scale-popover" id="modal-scale-popover" style="display: none;">
            <div class="scale-pop-header">
                <span class="scale-pop-title">📐 CẤU HÌNH TỰ ĐỘNG CĂN TRACK</span>
                <div style="display: flex; align-items: center; gap: 6px;">
                    <span class="scale-pop-badge" id="modal-scale-pop-badge">1.0x</span>
                    <button type="button" id="modal-btn-close-scale-pop" style="background: none; border: none; color: #94a3b8; font-size: 14px; font-weight: bold; cursor: pointer; padding: 0 4px; line-height: 1;" title="Đóng bảng">✕</button>
                </div>
            </div>
            <div class="scale-pop-control-row">
                <button class="btn-scale-arrow" id="modal-btn-scale-dec" title="Giảm 0.1">◀</button>
                <input type="number" id="modal-inp-scan-scale" min="1.0" max="2.0" step="0.1" value="1.0" class="inp-scale-num" />
                <button class="btn-scale-arrow" id="modal-btn-scale-inc" title="Tăng 0.1">▶</button>
                <div style="display: flex; gap: 4px; margin-left: 6px;">
                    <button type="button" class="scale-chip" data-val="1.0" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; background: #1e293b; color: #38bdf8; border: 1px solid #334155; cursor: pointer;">1.0x</button>
                    <button type="button" class="scale-chip" data-val="1.2" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; cursor: pointer;">1.2x</button>
                    <button type="button" class="scale-chip" data-val="1.5" style="padding: 2px 6px; font-size: 10px; border-radius: 4px; background: #1e293b; color: #cbd5e1; border: 1px solid #334155; cursor: pointer;">1.5x</button>
                </div>
            </div>
            <div class="scale-pop-desc" id="modal-scale-pop-desc">
                🟢 <b>1.0x:</b> Ôm sát vỏ xe (±10cm), an toàn tuyệt đối chống hút bờ tường, dải phân cách, xe sát bên.
            </div>
            <!-- KHOẢNG FRAME ÁP DỤNG -->
            <div class="scale-pop-range-wrap">
                <div class="scale-pop-range-header">
                    <span class="scale-pop-range-title">🎯 KHOẢNG FRAME ÁP DỤNG:</span>
                    <span class="scale-pop-range-badge" id="modal-scale-range-badge">Cả Track</span>
                </div>
                <input type="text" id="modal-inp-scale-range" class="inp-scale-range" placeholder="VD: 10-25, 35-50 (hoặc để trống)" title="Nhập danh sách khoảng frame cần chỉnh, ví dụ 0-15, 20-35. Để trống để căn toàn track" />
                <div class="scale-pop-range-buttons">
                    <button type="button" class="btn-range-chip active" id="modal-btn-range-all" title="Căn toàn bộ frames trong track">🌐 Cả Track</button>
                    <button type="button" class="btn-range-chip" id="modal-btn-range-selected" title="Chỉ căn các frame đang được tick chọn trên bảng">☑️ Đang Tick</button>
                </div>
            </div>
            <button class="btn-scale-exec" id="modal-btn-do-auto-align">
                ⚡ Bắt Đầu Căn Track
            </button>
        </div>
        <!-- POPOVER CÁC TÍNH NĂNG CĂN CHỈNH RIÊNG LẺ (SAU AUTO FIT BOX) -->
        <div class="modal-scale-popover" id="modal-auto-sub-popover" style="display: none; width: 260px !important;">
            <div class="scale-pop-header" style="border-bottom-color: rgba(56, 189, 248, 0.25) !important;">
                <span class="scale-pop-title" style="color: #38bdf8 !important;">⚡ TÍNH NĂNG CĂN RIÊNG LẺ</span>
                <button type="button" id="modal-btn-close-auto-sub-pop" style="background: none; border: none; color: #94a3b8; font-size: 14px; font-weight: bold; cursor: pointer; padding: 0 4px; line-height: 1;" title="Đóng bảng">✕</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px; margin: 6px 0;">
                <button type="button" class="btn-sub-align" id="sub-align-ground" style="display: flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 5px; padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 700; text-align: left;" title="Khớp đáy hộp tiếp xúc chuẩn mặt đường (Bảo tồn dốc & khử Z-spike)">
                    <span style="font-size: 14px;">🛣️</span>
                    <div>
                        <div style="color: #38bdf8;">Căn Mặt Đường</div>
                        <div style="font-size: 9px; color: #94a3b8; font-weight: normal;">Bám đáy tiếp xúc mặt đường Z</div>
                    </div>
                </button>
                <button type="button" class="btn-sub-align" id="sub-align-height" style="display: flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 5px; padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 700; text-align: left;" title="Xác định và vi chỉnh chiều cao nóc xe theo trung vị toàn track">
                    <span style="font-size: 14px;">📏</span>
                    <div>
                        <div style="color: #f59e0b;">Căn Nóc Xe</div>
                        <div style="font-size: 9px; color: #94a3b8; font-weight: normal;">Trung vị chiều cao H & nóc xe</div>
                    </div>
                </button>
                <button type="button" class="btn-sub-align" id="sub-align-yaw" style="display: flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 5px; padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 700; text-align: left;" title="Căn góc quay và hướng di chuyển chuẩn theo mây điểm">
                    <span style="font-size: 14px;">🔄</span>
                    <div>
                        <div style="color: #a855f7;">Căn Hướng Xe</div>
                        <div style="font-size: 9px; color: #94a3b8; font-weight: normal;">Khử lật 180° & căn trục Yaw</div>
                    </div>
                </button>
                <button type="button" class="btn-sub-align" id="sub-align-fit" style="display: flex; align-items: center; gap: 8px; background: #0f172a; border: 1px solid #334155; color: #f8fafc; border-radius: 5px; padding: 7px 10px; cursor: pointer; font-size: 11px; font-weight: 700; text-align: left;" title="Cắt lớp và co kéo viền ôm sát vỏ xe">
                    <span style="font-size: 14px;">✂️</span>
                    <div>
                        <div style="color: #10b981;">Ôm Khít Xe</div>
                        <div style="font-size: 9px; color: #94a3b8; font-weight: normal;">Cắt lớp ôm khít mép vỏ xe</div>
                    </div>
                </button>
            </div>
            <div style="font-size: 10px; color: #64748b; text-align: center; border-top: 1px solid #1e293b; padding-top: 4px;">
                Áp dụng cho các frame đang chọn (hoặc cả track)
            </div>
        </div>


        <!-- POPOVER MENU CHỌN FRAMES (GỘP CHỌN KHOẢNG & CHỌN CẢ - DARK MODE) -->
        <div class="modal-scale-popover modal-select-popover" id="modal-select-popover" style="display: none; width: 260px !important; background: #090d16 !important; border: 1px solid rgba(168, 85, 247, 0.4) !important; border-radius: 8px !important; padding: 10px !important; box-shadow: 0 10px 25px rgba(0,0,0,0.8) !important;">
            <div class="scale-pop-header" style="border-bottom: 1px solid rgba(168, 85, 247, 0.3) !important; padding-bottom: 6px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                <span class="scale-pop-title" style="color: #c084fc !important; font-weight: 800; font-size: 12px;">☑️ CHỌN FRAMES</span>
                <button type="button" id="modal-btn-close-select-pop" class="btn-close-modal-pop" style="background: none; border: none; color: #94a3b8; font-size: 14px; font-weight: bold; cursor: pointer;" title="Đóng bảng">✕</button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
                <button type="button" class="btn-pop-menu-item" id="modal-btn-range" title="Mở hộp thoại chọn khoảng frames thông minh" style="display: flex !important; flex-direction: column !important; align-items: flex-start !important; background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 6px !important; padding: 8px 10px !important; color: #f8fafc !important; cursor: pointer !important; text-align: left !important; width: 100% !important; box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important; transition: all 0.15s ease !important;">
                    <span class="pop-item-title" style="display: block !important; font-size: 12px !important; font-weight: 700 !important; color: #e9d5ff !important;">📊 Chọn Khoảng</span>
                    <span class="pop-item-sub" style="display: block !important; font-size: 10.5px !important; color: #94a3b8 !important; margin-top: 2px !important;">Nhập dải frame bất kỳ (VD: 0-15, 20)</span>
                </button>
                <button type="button" class="btn-pop-menu-item btn-pop-select-all" id="modal-btn-select-all" title="Bật/Tắt chọn tất cả các frames (Ctrl+A)" style="display: flex !important; flex-direction: column !important; align-items: flex-start !important; background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 6px !important; padding: 8px 10px !important; color: #f8fafc !important; cursor: pointer !important; text-align: left !important; width: 100% !important; box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important; transition: all 0.15s ease !important;">
                    <span class="pop-item-title" style="display: block !important; font-size: 12px !important; font-weight: 700 !important; color: #c084fc !important;">☑️ Chọn Cả</span>
                    <span class="pop-item-sub" style="display: block !important; font-size: 10.5px !important; color: #94a3b8 !important; margin-top: 2px !important;">Chọn hoặc bỏ chọn toàn bộ frames</span>
                </button>
            </div>
        </div>

        <!-- POPOVER QUẢN LÝ OUTSIDE (QUÉT OUTSIDE / BỎ OUTSIDE BỎ CỜ / HIỆN-ẨN OUTSIDE GIỮ CỜ - DARK MODE) -->
        <div class="modal-scale-popover modal-scan-out-popover" id="modal-scan-out-popover" style="display: none; width: 310px !important; background: #090d16 !important; border: 1px solid rgba(245, 158, 11, 0.4) !important; border-radius: 8px !important; padding: 12px !important; box-shadow: 0 12px 28px rgba(0, 0, 0, 0.8) !important;">
            <div class="scale-pop-header" style="border-bottom: 1px solid rgba(245, 158, 11, 0.25) !important; padding-bottom: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <span class="scale-pop-title" style="color: #fbbf24 !important; font-weight: 800; font-size: 12px;">🩺 QUẢN LÝ OUTSIDE</span>
                <button type="button" id="modal-btn-close-scan-out-pop" class="btn-close-modal-pop" style="background: none; border: none; color: #94a3b8; font-size: 14px; font-weight: bold; cursor: pointer;" title="Đóng bảng">✕</button>
            </div>
            <div class="outside-pop-scan-box" style="background: #0f172a; border: 1px solid #334155; border-radius: 6px; padding: 10px; margin-bottom: 8px;">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px;">
                    <span style="font-size: 11px; font-weight: 700; color: #cbd5e1;">🎯 Đánh Outside khi ít hơn:</span>
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <input type="number" id="modal-inp-out-pts" min="1" max="100" step="1" value="5" style="width: 52px; height: 26px; text-align: center; font-size: 13px; font-weight: 800; background: #090d16; border: 1.5px solid #f59e0b; color: #fef08a; border-radius: 4px; outline: none;" />
                        <span style="font-size: 11px; color: #fcd34d; font-weight: 700;">pts</span>
                    </div>
                </div>
                <button type="button" class="btn-scale-exec" id="modal-btn-do-scan-out" style="width: 100%; background: linear-gradient(135deg, #d97706, #b45309) !important; border: 1px solid #f59e0b !important; color: #fff !important; font-weight: 800; padding: 7px 8px; border-radius: 6px; cursor: pointer; font-size: 12px; box-shadow: 0 4px 12px rgba(217, 119, 6, 0.35);">
                    🪄 Quét Outside
                </button>
            </div>
            <div style="display: flex; flex-direction: column; gap: 6px;">
                <button type="button" class="btn-pop-menu-item btn-pop-clear-perm" id="modal-btn-clear-out-perm" title="Bỏ Outside tất cả frame và XÓA VĨNH VIỄN cờ Outside" style="display: flex !important; flex-direction: column !important; align-items: flex-start !important; background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 6px !important; padding: 8px 10px !important; color: #f8fafc !important; cursor: pointer !important; text-align: left !important; width: 100% !important; box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important; transition: all 0.15s ease !important;">
                    <span class="pop-item-title" style="display: block !important; font-size: 12px !important; font-weight: 700 !important; color: #f87171 !important;">✨ Bỏ Outside</span>
                    <span class="pop-item-sub" style="display: block !important; font-size: 10px !important; color: #94a3b8 !important; margin-top: 2px !important;">Đưa về Active &amp; bỏ cờ Outside luôn</span>
                </button>
                <button type="button" class="btn-pop-menu-item btn-pop-toggle-vis" id="modal-btn-clear-out" title="Tạm bỏ Outside để xem frame (KHÔNG bỏ cờ); bấm lại để Ẩn Outside lại" style="display: flex !important; flex-direction: column !important; align-items: flex-start !important; background: #0f172a !important; border: 1px solid #334155 !important; border-radius: 6px !important; padding: 8px 10px !important; color: #f8fafc !important; cursor: pointer !important; text-align: left !important; width: 100% !important; box-shadow: 0 2px 6px rgba(0,0,0,0.4) !important; transition: all 0.15s ease !important;">
                    <span class="pop-item-title" style="display: block !important; font-size: 12px !important; font-weight: 700 !important; color: #38bdf8 !important;">👁️ Hiện Outside</span>
                    <span class="pop-item-sub" style="display: block !important; font-size: 10px !important; color: #94a3b8 !important; margin-top: 2px !important;">Tạm bỏ Outside để xem (không bỏ cờ)</span>
                </button>
            </div>
        </div>

        <!-- Modal Column Headers -->
        <div class="modal-col-headers">
            <div class="col-head col-head-meta">FRAME</div>
            <div class="col-head col-head-top">TOP</div>
            <div class="col-head col-head-side">SIDE</div>
            <div class="col-head col-head-front">FRONT</div>
        </div>



        <!-- Modal Rows Container (Cuộn dọc) -->

        <div class="modal-rows-container" id="modal-rows-list">

            <!-- Render động từng frame bằng Canvas 2D Vector Projection -->

        </div>

    </div>

</div>



<!-- POPUP CẤU HÌNH KHÓA KÍCH THƯỚC (CHUẨN BangCauHinhKhoaKichThuoc) -->
<div id="cvat-lock-size-popup" class="cvat-popup-overlay" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 9999999; justify-content: center; align-items: center;">
    <div class="cvat-popup-card" style="width: 400px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.8); color: #f8fafc; font-family: sans-serif;">
        <div style="font-size: 14px; font-weight: bold; color: #f59e0b; margin-bottom: 6px;">🔒 Cấu Hình Khóa Kích Thước Track</div>
        <div style="font-size: 11px; color: #94a3b8; margin-bottom: 12px;">Chọn frame ảnh mẫu và tích chọn các chiều muốn khóa cố định khi chạy căn chỉnh:</div>
        <div style="display: flex; flex-direction: column; gap: 10px;">
            <div style="display: flex; align-items: center; justify-content: space-between;">
                <span style="font-size: 11px; font-weight: bold; color: #38bdf8;">📸 Frame Mẫu (Key Frame):</span>
                <input type="number" id="lock-pop-kf" min="0" max="1000" value="0" style="width: 80px; padding: 4px 6px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-weight: bold;" />
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; font-weight: bold; color: #ef4444; width: 50px;">Dài (L):</span>
                <input type="number" id="lock-pop-l" step="0.05" min="0.1" max="50" value="4.33" style="flex: 1; padding: 4px 6px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-weight: bold;" />
                <label style="font-size: 11px; font-weight: bold; color: #ef4444; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" id="lock-pop-chk-l" checked /> 🔒 Khóa L
                </label>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; font-weight: bold; color: #22c55e; width: 50px;">Rộng (W):</span>
                <input type="number" id="lock-pop-w" step="0.05" min="0.1" max="50" value="1.90" style="flex: 1; padding: 4px 6px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-weight: bold;" />
                <label style="font-size: 11px; font-weight: bold; color: #22c55e; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" id="lock-pop-chk-w" checked /> 🔒 Khóa W
                </label>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
                <span style="font-size: 11px; font-weight: bold; color: #38bdf8; width: 50px;">Cao (H):</span>
                <input type="number" id="lock-pop-h" step="0.05" min="0.1" max="50" value="1.53" style="flex: 1; padding: 4px 6px; background: #1e293b; border: 1px solid #475569; color: #f8fafc; border-radius: 4px; font-weight: bold;" />
                <label style="font-size: 11px; font-weight: bold; color: #38bdf8; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                    <input type="checkbox" id="lock-pop-chk-h" checked /> 🔒 Khóa H
                </label>
            </div>
        </div>
        <div style="display: flex; gap: 6px; margin-top: 14px;">
            <button id="lock-pop-btn-ok" style="flex: 2; background: #16a34a; color: white; padding: 7px 12px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">✓ Xác Nhận</button>
            <button id="lock-pop-btn-unlock" style="flex: 1.2; background: #334155; color: #cbd5e1; padding: 7px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">🔓 Mở Khóa Cả 3</button>
            <button id="lock-pop-btn-cancel" style="flex: 1; background: #1e293b; color: #94a3b8; border: 1px solid #334155; padding: 7px 10px; border-radius: 4px; font-size: 11px; cursor: pointer;">✕ Đóng</button>
        </div>
    </div>
</div>

<!-- POPUP CHỌN KHOẢNG FRAMES ĐA MIỀN (CHUẨN EXE CuaSoChonKhoangFrames) -->
<div id="cvat-range-popup" class="cvat-popup-overlay" style="display: none;">
    <div class="cvat-popup-card" style="width: 440px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 18px; box-shadow: 0 10px 25px rgba(0,0,0,0.6);">
        <div class="popup-title" style="font-size: 14px; font-weight: 700; color: #38bdf8; margin-bottom: 8px;">🔢 Chọn Khoảng Frames Đa Miền</div>
        <div class="popup-guide" id="popup-range-guide" style="font-size: 11px; color: #94a3b8; margin-bottom: 10px;">Track có 60 frames (từ frame 0 đến 59):</div>
        <div class="popup-form" style="display: flex; flex-direction: column; gap: 8px;">
            <label style="font-size: 11px; color: #cbd5e1; font-weight: 600;">Nhập danh sách khoảng frames (ngăn cách bằng dấu phẩy):</label>
            <input type="text" id="popup-inp-ranges" placeholder="Ví dụ: 0-10, 15, 20..35" style="width: 100%; padding: 8px 10px; background: #1e293b; border: 1px solid #334155; color: #38bdf8; border-radius: 4px; font-weight: bold; font-size: 12px;" />
            <div id="popup-preview-label" style="font-size: 11px; color: #38bdf8; min-height: 16px;">💡 Gõ khoảng frames để xem trước kết quả...</div>
        </div>
        <div class="popup-actions" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 14px;">
            <button class="btn-p-action btn-p-primary" id="popup-btn-replace" style="background: #0284c7; color: white; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">☑️ Áp Dụng (Chỉ Chọn Khoảng Này)</button>
            <button class="btn-p-action btn-p-secondary" id="popup-btn-add" style="background: #0d9488; color: white; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">➕ Thêm Vào Đang Chọn</button>
            <button class="btn-p-action" id="popup-btn-sub" style="background: #b45309; color: white; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">➖ Bớt Khỏi Đang Chọn</button>
            <button class="btn-p-action" id="popup-btn-all" style="background: #2563eb; color: white; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">☑️ Chọn Cả (Ctrl+A)</button>
            <button class="btn-p-action" id="popup-btn-none" style="background: #334155; color: #e2e8f0; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">⬜ Bỏ Chọn Cả</button>
            <button class="btn-p-action btn-p-cancel" id="popup-btn-cancel" style="background: #475569; color: white; padding: 7px 10px; border-radius: 4px; font-size: 11px; font-weight: bold; border: none; cursor: pointer;">❌ Đóng</button>
        </div>
    </div>
</div>



<!-- Toast Popup Thông Báo Nhanh -->

<div id="cvat-3d-toast">Đã thực hiện xong!</div>

<!-- FLOATING QUICK TRACK LOCK BADGE -->
<div id="cvat-quick-track-lock-badge" style="display: none;">
    <span id="quick-badge-title" style="font-weight: 700; color: #38bdf8;">🎯 Track #--</span>
    <span id="quick-badge-dims" style="color: #94a3b8; font-weight: 600;">4.33 x 1.90 x 1.53m</span>
    <button id="quick-badge-btn-lock-track" class="hud-btn-lock-track" title="Khóa bảo vệ Track này">🔓 Khóa Track</button>
    <button id="quick-badge-btn-lock-size" class="hud-btn-lock-size" title="Cấu hình Khóa Kích Thước">📐 Khóa Size</button>
</div>

<!-- POPUP BÁO CÁO HOÀN TẤT CĂN CHỈNH TOÀN DIỆN (CHUẨN DESKTOP APP) -->
<div id="cvat-finish-report-modal" class="cvat-popup-overlay" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.75); z-index: 99999999; justify-content: center; align-items: center;">
    <div class="cvat-popup-card" style="width: 480px; background: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 22px; box-shadow: 0 15px 35px rgba(0,0,0,0.85); color: #f8fafc; font-family: sans-serif;">
        <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">
            <div style="width: 40px; height: 40px; border-radius: 50%; background: #0284c7; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: bold; color: white;">ℹ️</div>
            <div>
                <div style="font-size: 15px; font-weight: bold; color: #38bdf8;">🎉 HOÀN TẤT CĂN CHỈNH TOÀN DIỆN CHO TOÀN BỘ JOB!</div>
                <div style="font-size: 11px; color: #94a3b8;">Thuật toán Master Pipeline đã đồng bộ hóa và bảo toàn cấu trúc dữ liệu.</div>
            </div>
        </div>
        <div id="finish-report-content" style="background: #1e293b; border-radius: 6px; padding: 12px 14px; font-size: 12px; line-height: 1.8; color: #cbd5e1; border-left: 4px solid #0ea5e9;">
            <!-- Điền động -->
        </div>
        <div style="margin-top: 14px; font-size: 11px; color: #a5f3fc; background: rgba(14, 165, 233, 0.1); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(14, 165, 233, 0.2);">
            ✨ Tất cả các hình hộp đã được khóa phẳng đáy mặt đường và ôm khít vỏ xe đón tia!
        </div>
        <div style="display: flex; justify-content: flex-end; margin-top: 16px;">
            <button id="finish-report-btn-close" style="background: #0284c7; color: white; border: none; padding: 7px 24px; border-radius: 6px; font-weight: bold; cursor: pointer; font-size: 12px;">OK</button>
        </div>
    </div>
</div>

`;

// Tạo container tạm để tách wrapper, badge và modal

        const tempDiv = document.createElement('div');

        tempDiv.innerHTML = hudHtml;



        const wrapper = tempDiv.querySelector('#cvat-3d-assistant-wrapper');

        const badge = tempDiv.querySelector('#cvat-3d-assistant-badge');

        const modal = tempDiv.querySelector('#cvat-detail-modal');

        const popup = tempDiv.querySelector('#cvat-range-popup');

        const toast = tempDiv.querySelector('#cvat-3d-toast');



        // Gắn ĐỘC LẬP vào body để không bị ảnh hưởng bởi transform của wrapper

        if (wrapper) document.body.appendChild(wrapper);

        if (badge) document.body.appendChild(badge);

        if (modal) document.body.appendChild(modal);

        if (popup) document.body.appendChild(popup);

        if (toast) document.body.appendChild(toast);



        // Khởi tạo tính năng kéo thả (Draggable)

        khoiTaoKeoThaToolbar();

        khoiTaoKeoThaBadge();

        khoiTaoKeoThaModal();

        khoiTaoSuKienChinh();

    }



    /**

     * Kéo thả Toolbar HUD

     */

    function khoiTaoKeoThaToolbar() {

        const wrapper = document.getElementById('cvat-3d-assistant-wrapper');

        const header = document.getElementById('hud-drag-header');

        if (!wrapper || !header) return;



        let isDragging = false;

        let startX, startY, initLeft, initTop;



        // Khôi phục vị trí đã lưu

        try {

            const savedPos = localStorage.getItem('cvat_toolbar_hud_pos');

            if (savedPos) {

                const { left, top } = JSON.parse(savedPos);

                const l = parseFloat(left);

                const t = parseFloat(top);

                if (!isNaN(l) && !isNaN(t) && l >= 0 && l < window.innerWidth - 150 && t >= 0 && t < window.innerHeight - 50) {

                    wrapper.style.left = `${l}px`;

                    wrapper.style.top = `${t}px`;

                    wrapper.style.transform = 'none';

                }

            }

        } catch (e) {}



        header.addEventListener('mousedown', (e) => {

            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('.hud-header-right')) return;

            isDragging = true;

            startX = e.clientX;

            startY = e.clientY;

            const rect = wrapper.getBoundingClientRect();

            initLeft = rect.left;

            initTop = rect.top;

            wrapper.style.transform = 'none';

            e.preventDefault();

        });



        window.addEventListener('mousemove', (e) => {

            if (!isDragging) return;

            const dx = e.clientX - startX;

            const dy = e.clientY - startY;

            const newLeft = Math.max(10, Math.min(window.innerWidth - wrapper.offsetWidth - 10, initLeft + dx));

            const newTop = Math.max(10, Math.min(window.innerHeight - 60, initTop + dy));

            wrapper.style.left = `${newLeft}px`;

            wrapper.style.top = `${newTop}px`;

        });



        window.addEventListener('mouseup', () => {

            if (isDragging) {

                isDragging = false;

                try {

                    localStorage.setItem('cvat_toolbar_hud_pos', JSON.stringify({

                        left: wrapper.style.left,

                        top: wrapper.style.top

                    }));

                } catch (e) {}

            }

        });

    }



    /**

     * Kéo thả Badge thu gọn nổi (Khắc phục triệt để lỗi kẹt ở giữa màn hình)

     */

    function khoiTaoKeoThaBadge() {

        const badge = document.getElementById('cvat-3d-assistant-badge');

        const hud = document.getElementById('cvat-3d-assistant-hud');

        if (!badge) return;



        let isDragging = false;

        let startX, startY, initLeft, initTop;

        let hasMoved = false;



        // Khôi phục vị trí badge đã lưu

        try {

            const savedBadgePos = localStorage.getItem('cvat_toolbar_badge_pos');

            if (savedBadgePos) {

                const { left, top } = JSON.parse(savedBadgePos);

                const l = parseFloat(left);

                const t = parseFloat(top);

                if (!isNaN(l) && !isNaN(t) && l >= 0 && l < window.innerWidth - 80 && t >= 0 && t < window.innerHeight - 40) {

                    badge.style.left = `${l}px`;

                    badge.style.top = `${t}px`;

                    badge.style.right = 'auto';

                }

            }

        } catch (e) {}



        badge.addEventListener('mousedown', (e) => {

            isDragging = true;

            hasMoved = false;

            startX = e.clientX;

            startY = e.clientY;

            const rect = badge.getBoundingClientRect();

            initLeft = rect.left;

            initTop = rect.top;

            e.preventDefault();

        });



        window.addEventListener('mousemove', (e) => {

            if (!isDragging) return;

            const dx = e.clientX - startX;

            const dy = e.clientY - startY;

            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;

            const newLeft = Math.max(10, Math.min(window.innerWidth - badge.offsetWidth - 10, initLeft + dx));

            const newTop = Math.max(10, Math.min(window.innerHeight - badge.offsetHeight - 10, initTop + dy));

            badge.style.left = `${newLeft}px`;

            badge.style.top = `${newTop}px`;

            badge.style.right = 'auto';

        });



        window.addEventListener('mouseup', () => {

            if (isDragging) {

                isDragging = false;

                if (!hasMoved) {

                    // Click mở lại HUD

                    badge.style.display = 'none';

                    if (hud) hud.style.display = 'flex';

                } else {

                    // Lưu vị trí

                    try {

                        localStorage.setItem('cvat_toolbar_badge_pos', JSON.stringify({

                            left: badge.style.left,

                            top: badge.style.top

                        }));

                    } catch (e) {}

                }

            }

        });



        // Nút Minimize trên HUD

        document.getElementById('btn-hud-minimize')?.addEventListener('click', () => {

            if (hud) hud.style.display = 'none';

            badge.style.display = 'flex';

        });

    }



    /**

     * Kéo thả Modal Dialog Căn Chỉnh Toàn Bộ Chi Tiết

     */

    function khoiTaoKeoThaModal() {

        const dialog = document.querySelector('#cvat-detail-modal .cvat-modal-dialog');

        const header = document.getElementById('modal-drag-header');

        if (!dialog || !header) return;



        let isDragging = false;

        let startX, startY, initLeft, initTop;



        header.addEventListener('mousedown', (e) => {
            if (dialog.classList.contains('is-minimized')) return;
            if (e.target.closest('button') || e.target.closest('input') || e.target.closest('select') || e.target.closest('option') || e.target.closest('label') || e.target.closest('#modal-track-attr-container') || e.target.closest('#modal-track-label-badge') || e.target.closest('.modal-track-meta-row') || e.target.closest('.modal-system-actions') || e.target.closest('.modal-actions-menu-row')) return;

            isDragging = true;

            startX = e.clientX;

            startY = e.clientY;

            const rect = dialog.getBoundingClientRect();

            initLeft = rect.left;

            initTop = rect.top;

            dialog.style.position = 'fixed';

            dialog.style.left = `${initLeft}px`;

            dialog.style.top = `${initTop}px`;

            dialog.style.margin = '0';

            e.preventDefault();

        });



        window.addEventListener('mousemove', (e) => {

            if (!isDragging) return;

            const dx = e.clientX - startX;

            const dy = e.clientY - startY;

            dialog.style.left = `${Math.max(10, Math.min(window.innerWidth - 300, initLeft + dx))}px`;

            dialog.style.top = `${Math.max(10, Math.min(window.innerHeight - 150, initTop + dy))}px`;

        });



        window.addEventListener('mouseup', () => {

            if (isDragging) isDragging = false;

        });

    }



    /**

     * Chuyển góc nhìn của CVAT player tới frame chỉ định

     */

    function chuyenFrameCVAT(frameNum) {
        try {
            if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.getStore === 'function') {
                const store = window.quanLyAPICVAT.getStore();
                if (store) {
                    store.dispatch({ type: 'CHANGE_FRAME', payload: { frame: frameNum } });
                }
            }
            const inp = document.querySelector('.cvat-player-frame-selector input') ||
                        document.querySelector('input.cvat-player-frame-selector') ||
                        document.querySelector('.cvat-player-frame-selector input[type="number"]');
            if (inp) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                inp.focus();
                if (setter) {
                    setter.call(inp, String(frameNum));
                } else {
                    inp.value = frameNum;
                }
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
                inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                inp.blur();
            }
        } catch (e) {}
        document.querySelectorAll('.frame-detail-row').forEach(r => r.classList.remove('is-current-frame'));
        const row = document.getElementById(`modal-row-frame-${frameNum}`);
        if (row) row.classList.add('is-current-frame');
        hienToast(`🔍 Đã chuyển CVAT tới Frame ${frameNum}`);
    }



    /**

     * Nạp dữ liệu ban đầu

     */

    async function napDuLieuBanDau() {

        const badge = document.getElementById('hud-job-badge');

        try {

            if (badge) badge.textContent = "🔄 Đang tải...";

            currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();

            currentLabels = await window.quanLyAPICVAT.taiLabels();



            const jid = window.quanLyAPICVAT.jobId;

            if (badge) {

                badge.textContent = `🟢 Job #${jid}`;

                badge.style.borderColor = "#22c55e";

                badge.style.color = "#4ade80";

                badge.style.cursor = "pointer";

                badge.title = "Đã kết nối dữ liệu. Bấm vào đây để làm mới bất kỳ lúc nào.";

            }

            const statJob = document.getElementById('stat-job-id');

            if (statJob) statJob.textContent = `#${jid}`;



            capNhatThongKe();

            if (window.khoDuyet && typeof window.khoDuyet.khoiTao === 'function') {
                window.khoDuyet.khoiTao(jid);
            }

            hienToast("⚡ CVAT 3D Toolbar v2.7.0 sẵn sàng!");

        } catch (err) {

            console.warn("[CVAT 3D Assistant] Lỗi nạp:", err);

            if (badge) {

                badge.textContent = "⚠️ Mất kết nối (Bấm nạp lại)";

                badge.style.borderColor = "#ef4444";

                badge.style.color = "#f87171";

                badge.style.cursor = "pointer";

                badge.title = "Lỗi kết nối. Bấm vào đây để thử nạp lại ngay.";

            }

            hienToast("⚠️ " + err.message);

        }

    }



    /**

     * Cập nhật bảng thống kê

     */

        // =========================================================================
    // QUẢN LÝ BỘ LỌC THỐNG KÊ (CHỌN LOẠI XE & CHỌN FRAMES) & CHUẨN HÓA ID GỐC CVAT
    // =========================================================================
    let statsBoLocLoai = 'all'; // 'all' | 'vehicles' | 'two-wheels' | 'pedestrian'
    let statsBoLocFrameBat = false;
    let statsBoLocFrameNum = 0;
    let statsBoLocFrameChiActive = true;
    let statsCachedFilteredLists = {
        vehicles: [],
        twoWheels: [],
        pedestrian: []
    };

    /**
     * Đồng bộ bảng ánh xạ ID giữa serverID và clientID (Số thứ tự gốc CVAT hiển thị trên sidebar)
     */
    function dongBoBangAnhXaID(annotations) {
        if (!annotations || !annotations.tracks) return;
        const serverToClient = new Map();

        // 1. Quét từ Collection RAM cvat-core
        try {
            const job = (typeof window !== 'undefined' && window.quanLyAPICVAT) ? window.quanLyAPICVAT.getJobInstance() : null;
            if (job && job.annotations) {
                const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
                if (coll) {
                    const s2c = coll.serverToClient || coll._serverToClient;
                    if (s2c) {
                        const entries = (s2c instanceof Map) ? s2c.entries() : Object.entries(s2c);
                        for (const [sid, cid] of entries) {
                            if (sid !== undefined && cid !== undefined) {
                                serverToClient.set(Number(sid), Number(cid));
                            }
                        }
                    }
                    const c2s = coll.clientToServer || coll._clientToServer;
                    if (c2s) {
                        const entries = (c2s instanceof Map) ? c2s.entries() : Object.entries(c2s);
                        for (const [cid, sid] of entries) {
                            if (sid !== undefined && cid !== undefined) {
                                serverToClient.set(Number(sid), Number(cid));
                            }
                        }
                    }
                    const trs = coll.tracks || coll._tracks || [];
                    const list = Array.isArray(trs) ? trs : Object.values(trs);
                    for (const t of list) {
                        if (t) {
                            const sid = t.serverID !== undefined ? t.serverID : (t._serverID !== undefined ? t._serverID : (t.id !== undefined ? t.id : null));
                            const cid = t.clientID !== undefined ? t.clientID : (t._clientID !== undefined ? t._clientID : null);
                            if (sid !== null && cid !== null) {
                                serverToClient.set(Number(sid), Number(cid));
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        // 2. Quét từ Redux annotations states
        try {
            const ann = (typeof window !== 'undefined' && window.quanLyAPICVAT) ? window.quanLyAPICVAT.getAnnotationState()?.annotations : null;
            if (ann && Array.isArray(ann.states)) {
                for (const st of ann.states) {
                    if (st) {
                        const sid = st.serverID !== undefined ? st.serverID : (st.parentID !== undefined ? st.parentID : null);
                        const cid = st.clientID !== undefined ? st.clientID : null;
                        if (sid !== null && cid !== null) {
                            serverToClient.set(Number(sid), Number(cid));
                        }
                    }
                }
            }
        } catch (e) {}

        // 3. Đối chiếu hình học (Geometric Matching) tại frame hiện tại
        // Đảm bảo dù cvat-core ẩn map nội bộ thì đối tượng ở frame hiện tại luôn map trúng 100% với clientID trên Canvas/Sidebar!
        try {
            const curFrame = (typeof window !== 'undefined' && window.quanLyAPICVAT) ? window.quanLyAPICVAT.getCurrentFrameNumber() : null;
            const ann = (typeof window !== 'undefined' && window.quanLyAPICVAT) ? window.quanLyAPICVAT.getAnnotationState()?.annotations : null;
            if (Number.isInteger(curFrame) && ann && Array.isArray(ann.states) && ann.states.length > 0) {
                for (const st of ann.states) {
                    if (!st || st.clientID === undefined || !st.points || st.points.length < 9) continue;
                    const stX = st.points[0], stY = st.points[1], stZ = st.points[2];
                    const stL = st.points[6], stW = st.points[7], stH = st.points[8];

                    for (const tr of annotations.tracks) {
                        if (serverToClient.has(tr.id)) continue;
                        const s = (tr.shapes || []).find(shp => shp.frame === curFrame && !shp.outside);
                        if (s && s.points && s.points.length >= 9) {
                            const dx = Math.abs(s.points[0] - stX);
                            const dy = Math.abs(s.points[1] - stY);
                            const dz = Math.abs(s.points[2] - stZ);
                            const dl = Math.abs(s.points[6] - stL);
                            const dw = Math.abs(s.points[7] - stW);
                            const dh = Math.abs(s.points[8] - stH);
                            if (dx < 0.05 && dy < 0.05 && dz < 0.05 && dl < 0.05 && dw < 0.05 && dh < 0.05) {
                                serverToClient.set(Number(tr.id), Number(st.clientID));
                                break;
                            }
                        }
                    }
                }
            }
        } catch (e) {}

        // 4. Gán displayId vào từng track
        for (let idx = 0; idx < annotations.tracks.length; idx++) {
            const tr = annotations.tracks[idx];
            let dispId = null;
            if (serverToClient.has(tr.id)) {
                dispId = serverToClient.get(tr.id);
            } else if (tr._displayId !== undefined && tr._displayId !== null) {
                dispId = tr._displayId;
            } else if (tr._clientID !== undefined && tr._clientID !== null) {
                dispId = tr._clientID;
            } else if (tr._trackNumber !== undefined && tr._trackNumber !== null) {
                dispId = tr._trackNumber;
            } else {
                dispId = idx + 1;
            }
            tr._displayId = dispId;
            tr._trackNumber = dispId;
            tr._clientID = dispId;
        }
    }

    /**
     * Cập nhật bảng thống kê: Lọc linh hoạt theo Chọn loại xe, Chọn frames hoặc kết hợp cả 2
     */
    function capNhatThongKe() {
        if (!currentAnnotations) return;

        // Chuẩn hóa ID hiển thị gốc CVAT trước khi thống kê
        dongBoBangAnhXaID(currentAnnotations);

        const stats = window.thuatToanCanChinh.tinhThongKeToanJob(currentAnnotations, currentLabels);

        const elFrames = document.getElementById('stat-frames');
        if (elFrames) elFrames.textContent = `${stats.tongShapes} / ${stats.tongFrames}`;

        const elComplete = document.getElementById('stat-complete-pct');
        if (elComplete) elComplete.textContent = `${stats.tyLeHoanChinh} (${stats.soTrackHoanChinh})`;

        const elTotal = document.getElementById('stat-total-tracks');
        if (elTotal) elTotal.textContent = stats.tongTracks;

        const elActive = document.getElementById('stat-active-tracks');
        if (elActive) elActive.textContent = stats.activeTracks;

        const elOutside = document.getElementById('stat-outside-tracks');
        if (elOutside) elOutside.textContent = stats.outsideTracks;

        const elVeh = document.getElementById('stat-count-vehicles');
        if (elVeh) elVeh.textContent = stats.phanLoaiNhan['vehicles'];

        const elMoto = document.getElementById('stat-count-twowheels');
        if (elMoto) elMoto.textContent = stats.phanLoaiNhan['two-wheels'];

        const elPed = document.getElementById('stat-count-pedestrian');
        if (elPed) elPed.textContent = stats.phanLoaiNhan['pedestrian'];

        const elSummary = document.getElementById('hud-stats-summary');
        if (elSummary) elSummary.textContent = `${stats.activeTracks} Active / ${stats.tongTracks} Tracks • ${stats.tongFrames} Frames`;

        // 1. ÁP DỤNG BỘ LỌC THEO FRAME
        function locDanhSachTheoFrame(list, targetFrame, chiActive) {
            if (!statsBoLocFrameBat) return list;
            return list.filter(item => {
                const shapes = item.shapes || (item.tr ? item.tr.shapes : []);
                const s = (shapes || []).find(sh => sh && sh.frame === targetFrame);
                if (!s) return false;
                if (chiActive && s.outside) return false;
                item.outsideAtF = !!s.outside;
                return true;
            });
        }

        const filteredVeh = locDanhSachTheoFrame(stats.danhSach.vehicles, statsBoLocFrameNum, statsBoLocFrameChiActive);
        const filteredTwo = locDanhSachTheoFrame(stats.danhSach.twoWheels, statsBoLocFrameNum, statsBoLocFrameChiActive);
        const filteredPed = locDanhSachTheoFrame(stats.danhSach.pedestrian, statsBoLocFrameNum, statsBoLocFrameChiActive);

        // Lưu cache danh sách đã lọc để phục vụ nút Chọn Tất Cả
        statsCachedFilteredLists = {
            vehicles: filteredVeh,
            twoWheels: filteredTwo,
            pedestrian: filteredPed
        };

        // 2. CẬP NHẬT TIÊU ĐỀ & SỐ LƯỢNG CỦA TỪNG KHỐI PHÂN LOẠI
        const frameSuffix = statsBoLocFrameBat ? ` tại Frame ${statsBoLocFrameNum}` : '';

        const titleVeh = document.getElementById('stat-title-vehicles');
        if (titleVeh) titleVeh.innerHTML = `🚗 Vehicles (<span id="stat-list-vehicles-count">${filteredVeh.length}</span> tracks${frameSuffix}) — <i>Bấm vào ID để chọn ngay:</i>`;

        const titleTwo = document.getElementById('stat-title-twowheels');
        if (titleTwo) titleTwo.innerHTML = `🏍️ Two-Wheels (<span id="stat-list-twowheels-count">${filteredTwo.length}</span> tracks${frameSuffix}):`;

        const titlePed = document.getElementById('stat-title-pedestrian');
        if (titlePed) titlePed.innerHTML = `🚶 Pedestrian (<span id="stat-list-pedestrian-count">${filteredPed.length}</span> tracks${frameSuffix}):`;

        // 3. RENDER CHIPS VỚI ID GỐC CVAT
        renderChips('stat-chips-vehicles', filteredVeh, statsBoLocFrameBat ? statsBoLocFrameNum : null);
        renderChips('stat-chips-twowheels', filteredTwo, statsBoLocFrameBat ? statsBoLocFrameNum : null);
        renderChips('stat-chips-pedestrian', filteredPed, statsBoLocFrameBat ? statsBoLocFrameNum : null);

        // 4. ÁP DỤNG BỘ LỌC THEO LOẠI XE (ẨN / HIỆN CÁC KHỐI PHÂN LOẠI TƯƠNG ỨNG)
        const boxVeh = document.querySelector('.stats-class-box.vehicle');
        const boxTwo = document.querySelector('.stats-class-box.twowheel');
        const boxPed = document.querySelector('.stats-class-box.pedestrian');

        if (boxVeh) boxVeh.style.display = (statsBoLocLoai === 'all' || statsBoLocLoai === 'vehicles') ? 'block' : 'none';
        if (boxTwo) boxTwo.style.display = (statsBoLocLoai === 'all' || statsBoLocLoai === 'two-wheels') ? 'block' : 'none';
        if (boxPed) boxPed.style.display = (statsBoLocLoai === 'all' || statsBoLocLoai === 'pedestrian') ? 'block' : 'none';

        // 5. CẬP NHẬT GIAO DIỆN TRẠNG THÁI BỘ LỌC & NÚT TẤT CẢ FRAMES
        const btnFrameAll = document.getElementById('btn-stats-frame-all');
        const pickerBox = document.getElementById('stats-frame-picker-box');
        if (btnFrameAll) btnFrameAll.classList.toggle('active', !statsBoLocFrameBat);
        if (pickerBox) pickerBox.classList.toggle('active', statsBoLocFrameBat);

        const curCvatVal = document.getElementById('stats-val-cur-cvat-frame');
        if (curCvatVal) curCvatVal.textContent = layFrameHienTai();

        const banner = document.getElementById('stats-filter-status-banner');
        const bannerText = document.getElementById('stats-filter-status-text');

        if (banner && bannerText) {
            const isFiltering = (statsBoLocLoai !== 'all' || statsBoLocFrameBat);
            banner.style.display = isFiltering ? 'block' : 'none';
            if (isFiltering) {
                const nameLoai = {
                    'all': 'Tất Cả Loại Xe',
                    'vehicles': '🚗 Vehicles',
                    'two-wheels': '🏍️ Two-Wheels',
                    'pedestrian': '🚶 Pedestrian'
                }[statsBoLocLoai] || statsBoLocLoai;

                const frameInfo = statsBoLocFrameBat
                    ? ` • 🎯 Frame ${statsBoLocFrameNum} (${statsBoLocFrameChiActive ? 'Chỉ Active' : 'Cả Outside'})`
                    : ' • 🌐 Tất Cả 60 Frames';

                let totalFound = 0;
                if (statsBoLocLoai === 'all') totalFound = filteredVeh.length + filteredTwo.length + filteredPed.length;
                else if (statsBoLocLoai === 'vehicles') totalFound = filteredVeh.length;
                else if (statsBoLocLoai === 'two-wheels') totalFound = filteredTwo.length;
                else if (statsBoLocLoai === 'pedestrian') totalFound = filteredPed.length;

                bannerText.textContent = `🔍 Đang lọc: ${nameLoai}${frameInfo} ➔ Tìm thấy ${totalFound} tracks`;
            }
        }
    }

    /**
     * Kích hoạt & Focus Track từ Extension sang CVAT (đồng bộ 2 chiều toàn diện)
     * - Mở 3 góc nhìn đáy Top, Side, Front của CVAT
     * - Căn giữa Camera 3D LiDAR PCD vào Track
     * - Cuộn và kích hoạt card Track trên Sidebar CVAT
     * - Tự động chuyển timeline CVAT nếu Track ở frame khác
     */
    async function kichHoatTrackSangCVAT(trackId, targetFrame = null) {
        if (!trackId) return;
        const numId = parseInt(trackId, 10);
        if (isNaN(numId)) return;

        let f = targetFrame;
        const curF = layFrameHienTai();

        if (f === null && currentAnnotations) {
            const tr = window.thuatToanCanChinh ? window.thuatToanCanChinh.timTrack(currentAnnotations, numId) : null;
            if (tr && Array.isArray(tr.shapes) && tr.shapes.length > 0) {
                const hasCur = tr.shapes.some(s => s && s.frame === curF && !s.outside);
                if (!hasCur) {
                    const firstAct = tr.shapes.find(s => s && !s.outside) || tr.shapes[0];
                    if (firstAct && Number.isInteger(firstAct.frame)) {
                        f = firstAct.frame;
                    }
                }
            }
        }

        // Chuyển frame trên CVAT nếu cần
        if (f !== null && f !== undefined && f !== curF) {
            chuyenFrameCVAT(f);
        }

        // Gọi sang QuanLyAPICVAT xử lý đa lớp (Canvas3D, Redux, DOM Sidebar)
        if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.kichHoatVaFocusTrackCVAT === 'function') {
            await window.quanLyAPICVAT.kichHoatVaFocusTrackCVAT(numId, f, currentAnnotations);
        }
    }

    /**
     * Render các chip hiển thị mã Track chuẩn gốc CVAT
     */
    function renderChips(containerId, list, filterFrame = null) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';

        if (!list || list.length === 0) {
            const emptySpan = document.createElement('span');
            emptySpan.style.color = '#64748b';
            emptySpan.style.fontSize = '10px';
            emptySpan.style.fontStyle = 'italic';
            emptySpan.style.padding = '4px 2px';
            emptySpan.textContent = filterFrame !== null ? `(Không có track nào tại Frame ${filterFrame})` : '(Trống)';
            container.appendChild(emptySpan);
            return;
        }

        for (const item of list) {
            const chip = document.createElement('span');
            chip.className = 'track-chip';
            const dispId = item.displayId !== undefined ? item.displayId : item.id;
            chip.setAttribute('data-track-id', dispId);
            chip.setAttribute('data-server-id', item.id);

            let statusTip = '';
            if (filterFrame !== null) {
                if (item.outsideAtF) {
                    chip.classList.add('chip-outside');
                    chip.textContent = `#${dispId} 🔴`;
                    statusTip = ` • Frame ${filterFrame}: Outside 🔴`;
                } else {
                    chip.classList.add('chip-active');
                    chip.textContent = `#${dispId}`;
                    statusTip = ` • Frame ${filterFrame}: Active 🟢`;
                }
            } else {
                chip.textContent = `#${dispId}`;
            }

            chip.title = `Track #${dispId} (Gốc CVAT) • Server ID: #${item.id}${statusTip} • ${item.active}/${item.total} frames. Bấm để chọn; Nháy đúp mở Chi Tiết!`;

            chip.addEventListener('click', () => {
                const inp = document.getElementById('inp-track-id');
                if (inp) inp.value = dispId;
                selectedTrackId = dispId;
                kichHoatTrackSangCVAT(dispId, filterFrame);
                docKichThuocTrackHienTai(dispId);
                hienToast(`🎯 Đã chọn Track #${dispId} (Gốc CVAT) • 3 Views & Camera đã kích hoạt!`);
            });

            chip.addEventListener('dblclick', () => {
                const inp = document.getElementById('inp-track-id');
                if (inp) inp.value = dispId;
                selectedTrackId = dispId;
                kichHoatTrackSangCVAT(dispId, filterFrame);
                moModalChiTietTrack(dispId);
            });

            container.appendChild(chip);
        }
    }


    
    // =========================================================================
    // QUẢN LÝ KHÓA TRACK BẢO VỆ CHỈNH TAY & CẤU HÌNH KHÓA KÍCH THƯỚC (CHUẨN EXE)
    // =========================================================================

    let currentLockingTrackId = null;

    function laTrackBiKhoa(tr) {
        if (!tr) return false;
        return Boolean(tr.lock || tr.khoa_track || tr.khoa_toan_bo || tr.khoa_chinh_tay);
    }

    function capNhatGiaoDienKhoaTrack(tid) {
        if (!tid) return;
        let tr = null;
        if (currentAnnotations && window.thuatToanCanChinh) {
            tr = window.thuatToanCanChinh.timTrack(currentAnnotations, tid);
        }
        if (!tr && typeof activeModalTrack !== 'undefined' && activeModalTrack && activeModalTrack.id === tid) {
            tr = activeModalTrack;
        }
        if (!tr) return;

        const daKhoaTrack = laTrackBiKhoa(tr);
        const lockL = Boolean(tr.lock_l);
        const lockW = Boolean(tr.lock_w);
        const lockH = Boolean(tr.lock_h);
        const daKhoaSize = Boolean(tr.khoa_kich_thuoc || tr.lock_size || lockL || lockW || lockH);

        // 1. Cập nhật nút Khóa Track trên thanh HUD ngoài
        const btnHudLockTr = document.getElementById('btn-hud-lock-track');
        if (btnHudLockTr) {
            if (daKhoaTrack) {
                btnHudLockTr.innerHTML = '🔒 ĐÃ KHÓA TRACK (BẢO VỆ)';
                btnHudLockTr.classList.add('locked');
                btnHudLockTr.title = 'Track này đã được khóa bảo vệ. Toàn bộ thuật toán sẽ bỏ qua 100%! Bấm để mở khóa.';
            } else {
                btnHudLockTr.innerHTML = '🔓 Cho Phép Căn Chỉnh';
                btnHudLockTr.classList.remove('locked');
                btnHudLockTr.title = 'Track chưa khóa: Cho phép thuật toán căn chỉnh tự động can thiệp. Bấm để khóa bảo vệ.';
            }
        }

        // 2. Cập nhật nút Khóa Size trên thanh HUD ngoài
        const btnHudLockSz = document.getElementById('btn-hud-lock-size');
        if (btnHudLockSz) {
            if (daKhoaSize) {
                const ds = [];
                if (lockL) ds.push('L');
                if (lockW) ds.push('W');
                if (lockH) ds.push('H');
                const str = ds.length > 0 ? ds.join(',') : 'CỐ ĐỊNH';
                btnHudLockSz.innerHTML = `🔒 SIZE (${str})`;
                btnHudLockSz.classList.add('locked');
                btnHudLockSz.title = `Kích thước đã khóa (${str}). Bấm để mở bảng cấu hình hoặc mở khóa.`;
            } else {
                btnHudLockSz.innerHTML = '🔓 Khóa Size';
                btnHudLockSz.classList.remove('locked');
                btnHudLockSz.title = 'Bấm để mở bảng cấu hình Khóa Kích Thước (Key Frame, L, W, H).';
            }
        }

        // 3. Cập nhật nút Khóa Track trong Modal Chi Tiết
        const modalBtnLockTr = document.getElementById('modal-btn-lock-track');
        if (modalBtnLockTr) {
            if (daKhoaTrack) {
                modalBtnLockTr.innerHTML = '🔒 ĐÃ KHÓA TRACK (BẢO VỆ)';
                modalBtnLockTr.classList.add('locked');
            } else {
                modalBtnLockTr.innerHTML = '🔓 Cho Phép Căn Chỉnh';
                modalBtnLockTr.classList.remove('locked');
            }
        }

        // 4. Cập nhật nút Khóa Size trong Modal Chi Tiết
        const modalBtnLockSz = document.getElementById('modal-btn-lock-size');
        if (modalBtnLockSz) {
            if (daKhoaSize) {
                const ds = [];
                if (lockL) ds.push('L');
                if (lockW) ds.push('W');
                if (lockH) ds.push('H');
                const str = ds.length > 0 ? ds.join(',') : 'CỐ ĐỊNH';
                modalBtnLockSz.innerHTML = `🔒 ĐÃ KHÓA SIZE (${str})`;
                modalBtnLockSz.classList.add('locked');
            } else {
                modalBtnLockSz.innerHTML = '🔓 Cài Đặt Khóa Size';
                modalBtnLockSz.classList.remove('locked');
            }
        }

        // 5. Cập nhật Floating Quick Badge
        const qBadge = document.getElementById('cvat-quick-track-lock-badge');
        const qBtnLockTr = document.getElementById('quick-badge-btn-lock-track');
        const qBtnLockSz = document.getElementById('quick-badge-btn-lock-size');
        const qTitle = document.getElementById('quick-badge-title');
        const qDims = document.getElementById('quick-badge-dims');
        if (qBadge && qBtnLockTr && qTitle) {
            qTitle.textContent = `🎯 Track #${tid}`;
            const sh = (tr.shapes || []).find(s => !s.outside) || (tr.shapes || [])[0];
            if (sh && sh.points && sh.points.length >= 9) {
                if (qDims) qDims.textContent = `${sh.points[6].toFixed(2)} x ${sh.points[7].toFixed(2)} x ${sh.points[8].toFixed(2)}m`;
            }
            if (daKhoaTrack) {
                qBtnLockTr.innerHTML = '🔒 ĐÃ KHÓA';
                qBtnLockTr.classList.add('locked');
            } else {
                qBtnLockTr.innerHTML = '🔓 Mở Khóa';
                qBtnLockTr.classList.remove('locked');
            }
            if (daKhoaSize) {
                qBtnLockSz.classList.add('locked');
            } else {
                qBtnLockSz.classList.remove('locked');
            }
            // qBadge.style.display = 'flex'; // [v2.7.0] Đã ẩn vĩnh viễn để tránh che lấp các nút hàng 1 & 2 của HUD Toolbar
        }
    }

    async function toggleKhoaTrack(tid) {
        if (!tid) return;
        if (!currentAnnotations) {
            currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();
        }
        let tr = window.thuatToanCanChinh ? window.thuatToanCanChinh.timTrack(currentAnnotations, tid) : null;
        if (!tr && typeof activeModalTrack !== 'undefined' && activeModalTrack && activeModalTrack.id === tid) {
            tr = activeModalTrack;
        }
        if (!tr) return;

        const dangKhoa = laTrackBiKhoa(tr);
        const trangThaiMoi = !dangKhoa;
        tr.khoa_track = trangThaiMoi;
        tr.khoa_toan_bo = trangThaiMoi;
        tr.khoa_chinh_tay = trangThaiMoi;
        tr.lock = trangThaiMoi;

        if (typeof activeModalTrack !== 'undefined' && activeModalTrack && activeModalTrack.id === tid) {
            activeModalTrack.khoa_track = trangThaiMoi;
            activeModalTrack.khoa_toan_bo = trangThaiMoi;
            activeModalTrack.khoa_chinh_tay = trangThaiMoi;
            activeModalTrack.lock = trangThaiMoi;
        }

        capNhatGiaoDienKhoaTrack(tid);

        if (trangThaiMoi) {
            hienToast(`🔒 ĐÃ KHÓA BẢO VỆ TRACK #${tid}! Tất cả thuật toán sẽ bỏ qua 100% để giữ nguyên nét vẽ tay.`);
        } else {
            hienToast(`🔓 ĐÃ MỞ KHÓA TRACK #${tid}! Cho phép thuật toán căn chỉnh can thiệp.`);
        }

        // Tự động lưu lên CVAT
        try {
            await window.quanLyAPICVAT.luuAnnotations(currentAnnotations);
        } catch (e) {}

        // Đồng bộ với icon ổ khóa trên sidebar của CVAT nếu có
        try {
            const cards = document.querySelectorAll('.cvat-objects-sidebar-state-item');
            for (const c of cards) {
                const titleEl = c.querySelector('.cvat-objects-sidebar-state-item-header, [class*="title"], [class*="header"]');
                if (titleEl && titleEl.textContent.includes(String(tid))) {
                    const lockIcon = c.querySelector('.anticon-lock, .anticon-unlock, [aria-label="lock"], [aria-label="unlock"]');
                    if (lockIcon) {
                        const cvatIsLocked = lockIcon.classList.contains('anticon-lock') || lockIcon.getAttribute('aria-label') === 'lock';
                        if (cvatIsLocked !== trangThaiMoi) {
                            lockIcon.closest('button, span')?.click();
                        }
                    }
                    break;
                }
            }
        } catch (e) {}
    }

    async function moPopupKhoaKichThuoc(tid) {
        if (!tid) return;
        if (!currentAnnotations) {
            currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();
        }
        let tr = window.thuatToanCanChinh ? window.thuatToanCanChinh.timTrack(currentAnnotations, tid) : null;
        if (!tr && typeof activeModalTrack !== 'undefined' && activeModalTrack && activeModalTrack.id === tid) {
            tr = activeModalTrack;
        }
        if (!tr) {
            hienToast(`⚠️ Không tìm thấy Track #${tid}!`);
            return;
        }

        currentLockingTrackId = tid;
        const popLock = document.getElementById('cvat-lock-size-popup');
        const popKf = document.getElementById('lock-pop-kf');
        const popL = document.getElementById('lock-pop-l');
        const popW = document.getElementById('lock-pop-w');
        const popH = document.getElementById('lock-pop-h');
        const popChkL = document.getElementById('lock-pop-chk-l');
        const popChkW = document.getElementById('lock-pop-chk-w');
        const popChkH = document.getElementById('lock-pop-chk-h');

        const shapes = (tr.shapes || []).filter(s => s.points && s.points.length >= 9);
        const shapeDict = {};
        shapes.forEach(s => { shapeDict[s.frame] = s; });
        const frameList = Object.keys(shapeDict).map(Number).sort((a, b) => a - b);

        const curKf = tr.key_frame_size ?? (typeof activeFrameIndex !== 'undefined' ? activeFrameIndex : (frameList[0] || 0));
        if (popKf) {
            popKf.value = curKf;
            if (frameList.length > 0) {
                popKf.min = frameList[0];
                popKf.max = frameList[frameList.length - 1];
            }
        }

        const activeShape = shapeDict[curKf] || shapes[0];
        const curL = tr.locked_l_val ?? (activeShape ? activeShape.points[6] : 4.33);
        const curW = tr.locked_w_val ?? (activeShape ? activeShape.points[7] : 1.90);
        const curH = tr.locked_h_val ?? (activeShape ? activeShape.points[8] : 1.53);

        if (popL) popL.value = Number(curL).toFixed(3);
        if (popW) popW.value = Number(curW).toFixed(3);
        if (popH) popH.value = Number(curH).toFixed(3);

        const isLockedAny = Boolean(tr.khoa_kich_thuoc || tr.lock_size);
        let initLockL = Boolean(tr.lock_l ?? isLockedAny);
        let initLockW = Boolean(tr.lock_w ?? isLockedAny);
        let initLockH = Boolean(tr.lock_h ?? isLockedAny);
        if (isLockedAny && !initLockL && !initLockW && !initLockH) {
            initLockL = initLockW = initLockH = true;
        }

        if (popChkL) popChkL.checked = initLockL;
        if (popChkW) popChkW.checked = initLockW;
        if (popChkH) popChkH.checked = initLockH;

        if (popLock) popLock.style.display = 'flex';
    }

    function docKichThuocTrackHienTai(trackId) {
        let tr = currentAnnotations ? window.thuatToanCanChinh.timTrack(currentAnnotations, trackId) : null;
        if (!tr && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTrackLiveTuRAM === 'function') {
            tr = window.quanLyAPICVAT.layTrackLiveTuRAM(trackId);
            if (tr && currentAnnotations) {
                if (!Array.isArray(currentAnnotations.tracks)) currentAnnotations.tracks = [];
                const idx = currentAnnotations.tracks.findIndex(t => t && (t.id === tr.id || t._trackNumber === tr._trackNumber || t._clientID === tr._clientID));
                if (idx >= 0) {
                    currentAnnotations.tracks[idx] = tr;
                } else {
                    currentAnnotations.tracks.push(tr);
                }
            }
        }

        if (!tr) {
            window.quanLyAPICVAT.taiAnnotations(true).then(anno => {
                if (anno) {
                    currentAnnotations = anno;
                    docKichThuocTrackHienTai(trackId);
                }
            }).catch(() => {});
            return;
        }

        if (!tr || !tr.shapes || tr.shapes.length === 0) return;

        const active = tr.shapes.find(s => !s.outside) || tr.shapes[0];

        if (active && active.points && active.points.length >= 9) {

            const l = active.points[6];

            const w = active.points[7];

            const h = active.points[8];

            const inL = document.getElementById('inp-dim-l');

            const inW = document.getElementById('inp-dim-w');

            const inH = document.getElementById('inp-dim-h');

            if (inL) inL.value = l.toFixed(3);

            if (inW) inW.value = w.toFixed(3);

            if (inH) inH.value = h.toFixed(3);

        }

        capNhatGiaoDienKhoaTrack(trackId);

    }



    /**

     * Thực thi hành động và lưu lên server CVAT (Session Cookies)

     */

    function taoNeighborBoxesChoTrack(track, targetFrames = null, baseAnno = null) {
        try {
            const tt = window.thuatToanCanChinh || (typeof ThuatToanCanChinh !== 'undefined' ? ThuatToanCanChinh : null);
            if (!tt || typeof tt.layNeighborBoxesTuAnnotations !== 'function') return null;
            const srcAnno = baseAnno || currentAnnotations;
            if (!srcAnno) return null;

            const allTracks = Array.isArray(srcAnno.tracks) ? [...srcAnno.tracks] : [];
            if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTatCaTracksLiveTuRAM === 'function') {
                const live = window.quanLyAPICVAT.layTatCaTracksLiveTuRAM();
                if (Array.isArray(live) && live.length > 0) {
                    const existingIds = new Set(allTracks.map(t => t && (t.id || t._trackNumber || t._clientID)));
                    for (const lt of live) {
                        if (lt && !existingIds.has(lt.id) && !existingIds.has(lt._trackNumber) && !existingIds.has(lt._clientID)) {
                            allTracks.push(lt);
                        }
                    }
                }
            }
            const mergedAnno = { tracks: allTracks, shapes: Array.isArray(srcAnno.shapes) ? srcAnno.shapes : [] };
            return tt.layNeighborBoxesTuAnnotations(mergedAnno, track, targetFrames, currentLabels);
        } catch (e) {
            console.warn('[AutoFit] Lỗi tạo neighborBoxesDict:', e);
            return null;
        }
    }

    async function thucThiVaLuu(tenThaoTac, hamThaoTac, tuDongReload = false) {

        try {

            hienToast(`Đang thực hiện: ${tenThaoTac}...`);

            if (!currentAnnotations) {

                currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();

            }



            const ketQua = hamThaoTac(currentAnnotations);



            hienToast(`Đang lưu dữ liệu lên CVAT...`);

            await window.quanLyAPICVAT.luuAnnotations(currentAnnotations);

            capNhatThongKe();



            if (tuDongReload) {

                hienToast(`✅ ${tenThaoTac} thành công! Đang đồng bộ 3D...`);

                await window.quanLyAPICVAT.kichHoatLamMoiGiaoDien(0);

            } else {

                await window.quanLyAPICVAT.kichHoatLamMoiGiaoDien(0);

                hienToast(`✅ ${tenThaoTac} hoàn tất thành công (Không cần F5)!`);

            }

            return ketQua;

        } catch (err) {

            console.error(`[CVAT 3D Assistant] Lỗi:`, err);

            hienToast(`❌ Lỗi: ${err.message}`);

            throw err;

        }

    }



    // Biến quản lý Kéo Thả Tịnh Tiến Đồng Bộ trong Modal Chi Tiết
    let modalDragState = null;
    let modalDragRafPending = false;
    let modalDragRafId = 0;

    // Hàng đợi vẽ nền & các helper thao tác Modal (chia sẻ an toàn giữa các module scope)
    let modalBatchRedrawQueue = [];
    let modalBatchRedrawRaf = null;
    let themHangVaoHangDoiVeNen = null;
    let chayHangDoiVeNen = null;
    let veLaiTatCaHangModal = null;
    let capNhatOInputKichThuocTuTrack = null;
    let dongBoKichThuocToanBoTrack = null;
    let tinhTienDongBoTay = null;
    let capNhatTrangThaiNutChonCa = null;
    let dongBoGiaoDienNutOutside = null;

    // Bảng lưu trạng thái Zoom & Pan độc lập cho từng view của từng frame (Top, Side, Front)
    const modalCanvasViewStates = new Map(); // Key: `${frameNum}_${viewType}` -> { zoom: 1.0, panX: 0, panY: 0 }
    let modalPanState = null;
    let modalPanRafPending = false;
    let modalFullscreenView = null; // { frameNum, viewType } đang phóng to toàn màn hình (nếu có)

    function dangKeoHoacXoayModal() {
        return !!(
            (modalDragState && modalDragState.isDragging) ||
            modalPanState ||
            (typeof modalRotateViewState !== 'undefined' && modalRotateViewState)
        );
    }

    function dangTuongTacCanvas(fn, viewType = null) {
        const frameNum = Number(fn);
        if (modalDragState && modalDragState.isDragging && Number(modalDragState.sourceFrame) === frameNum) {
            return viewType ? modalDragState.viewType === viewType : true;
        }
        if (modalPanState && Number(modalPanState.frameNum) === frameNum) {
            return viewType ? modalPanState.viewType === viewType : true;
        }
        if (typeof modalRotateViewState !== 'undefined' && modalRotateViewState && Number(modalRotateViewState.frameNum) === frameNum) {
            return viewType ? modalRotateViewState.viewType === viewType : true;
        }
        return false;
    }

    function layViewStateCanvas(canvas, frameNum, viewType) {
        const fn = (frameNum !== undefined && frameNum !== null) ? frameNum : (canvas?._frameNum !== undefined ? canvas._frameNum : 0);
        const vt = viewType || canvas?._viewType || 'top';
        const key = `${fn}_${vt}`;
        if (!modalCanvasViewStates.has(key)) {
            modalCanvasViewStates.set(key, { zoom: 1.0, panX: 0, panY: 0, viewPitch: 0, viewYaw: 0 });
        }
        const vs = modalCanvasViewStates.get(key);
        if (vs) {
            if (vs.viewPitch === undefined) vs.viewPitch = 0;
            if (vs.viewYaw === undefined) vs.viewYaw = 0;
        }
        if (canvas) {
            canvas._viewState = vs;
            canvas._frameNum = fn;
            canvas._viewType = vt;
        }
        return vs;
    }

    function taiVeCanvasTheoFrame(canvas, viewType, frameNum) {
        if (!canvas || !activeModalTrack) return;
        const fn = (frameNum !== undefined && frameNum !== null) ? Number(frameNum) : (canvas._frameNum !== undefined ? Number(canvas._frameNum) : 0);
        let sh = (activeModalTrack.shapes || []).find(s => Number(s.frame) === fn);
        if (!sh && typeof layShapeChoFrame === 'function') {
            sh = layShapeChoFrame(activeModalTrack, fn);
        }
        const row = document.getElementById(`modal-row-frame-${fn}`);
        if (row && row._needsLiDARReproject && sh && sh.points) {
            reprojectLiDARChoRow(row, sh);
        }
        const redBox = row ? row._redInterpolatedBox : null;
        const basePoints = (sh && sh.points && sh.points.length >= 9) ? sh.points : (redBox && redBox.length >= 9 ? redBox : null);
        if (!basePoints) return;
        const [x, y, z, , , , L, W, H] = basePoints;
        if (viewType === 'top') {
            const showOther = row ? (row._showOtherObjects !== undefined ? !!row._showOtherObjects : modalShowOtherObjects) : modalShowOtherObjects;
            const pts = (row && row._wideLiDARPoints && row._wideLiDARPoints.length > 0)
                        ? row._wideLiDARPoints
                        : (row ? (row._localLiDARPoints || []) : []);
            veCanvasTopView(canvas, L, W, H, pts, 0, 0, false, 0, fn, showOther);
        } else if (viewType === 'side') {
            const pts = row ? (row._localLiDARPoints || []) : [];
            veCanvasSideView(canvas, L, W, H, pts, z, 0, 0, false, 0);
        } else if (viewType === 'front') {
            const pts = row ? (row._localLiDARPoints || []) : [];
            veCanvasFrontView(canvas, L, W, H, pts, z, 0, 0, false, 0);
        }
    }




    /**

     * BỘ VẼ HÌNH CHIẾU CANVAS 2D TƯƠNG TÁC (TOP, SIDE, FRONT VIEW)

     * Hiển thị lưới tọa độ metric, tâm xe, hướng đầu xe, đường mặt đất chuẩn xác

     * Hỗ trợ vẽ độ lệch khi kéo chuột (Live Drag Offset Preview)

     */

    // =========================================================================

    // BỘ NẠP & GIẢI MÃ ĐIỂM LIDAR POINT CLOUD (CHUẨN EXE 100%)

    // =========================================================================

    function layJobIdHienTai() {
        if (window.quanLyAPICVAT && window.quanLyAPICVAT.jobId) return window.quanLyAPICVAT.jobId;
        if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layJobIdTuURL === 'function') {
            const jid = window.quanLyAPICVAT.layJobIdTuURL();
            if (jid) return jid;
        }
        if (typeof window !== 'undefined' && window.location) {
            const match = (window.location.pathname || '').match(/\/tasks\/(\d+)\/jobs\/(\d+)/) ||
                          (window.location.pathname || '').match(/\/jobs\/(\d+)/) ||
                          (window.location.href || '').match(/\/jobs\/(\d+)/);
            if (match) return parseInt(match[2] || match[1], 10);
        }
        return null;
    }
    const layJobIdTuUrl = layJobIdHienTai;

    class NormalizedFrameMap extends Map {
        get(key) {
            const k = typeof key === 'number' ? Math.floor(key) : parseInt(key, 10);
            return isNaN(k) ? undefined : super.get(k);
        }
        set(key, value) {
            const k = typeof key === 'number' ? Math.floor(key) : parseInt(key, 10);
            if (!isNaN(k)) super.set(k, value);
            return this;
        }
        has(key) {
            const k = typeof key === 'number' ? Math.floor(key) : parseInt(key, 10);
            return isNaN(k) ? false : super.has(k);
        }
        delete(key) {
            const k = typeof key === 'number' ? Math.floor(key) : parseInt(key, 10);
            return isNaN(k) ? false : super.delete(k);
        }
    }

    const pcdFrameCache = new NormalizedFrameMap();
    const pcdSyntheticCache = new NormalizedFrameMap();
    // Cache lưu trực tiếp dữ liệu binary gốc của các file PCD (không tốn mạng tải lại khi đổi track)
    const pcdRawBufferCache = new NormalizedFrameMap();
    let currentCachedTrackId = null;

    const pcdLoadingPromises = new NormalizedFrameMap();

    // Biến toàn cục lưu kích thước hiển thị hạt điểm LiDAR (PP) trong Modal, mặc định 1.3px (sắc nét, thanh mảnh)
    let modalLiDARPointSize = parseFloat(localStorage.getItem('cvat_modal_pt_size')) || 1.3;



    /**

     * Giải mã file PCD (Binary hoặc ASCII) thành danh sách điểm [x, y, z]

     */

    function phanTichHeaderPCD(arrayBuffer) {
        if (!arrayBuffer || Array.isArray(arrayBuffer) || arrayBuffer.byteLength < 32) return null;
        const uint8 = new Uint8Array(arrayBuffer);
        let headerText = '';
        let headerEndIndex = 0;
        let isBinary = true;
        const scanLen = Math.min(2048, uint8.length);

        for (let i = 0; i < scanLen; i++) {
            headerText += String.fromCharCode(uint8[i]);
            if (headerText.endsWith('DATA binary\n') || headerText.endsWith('DATA binary\r\n')) {
                headerEndIndex = i + 1;
                isBinary = true;
                break;
            }
            if (headerText.endsWith('DATA ascii\n') || headerText.endsWith('DATA ascii\r\n')) {
                headerEndIndex = i + 1;
                isBinary = false;
                break;
            }
        }
        if (!headerEndIndex) return null;

        const lines = headerText.split(/\r?\n/);
        let pointsCount = 0;
        let pointStep = 16;
        let fields = [];
        let sizes = [];
        let types = [];
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts[0] === 'POINTS') pointsCount = parseInt(parts[1], 10);
            if (parts[0] === 'SIZE') sizes = parts.slice(1).map(Number);
            if (parts[0] === 'TYPE') types = parts.slice(1);
            if (parts[0] === 'FIELDS') fields = parts.slice(1);
        }
        if (sizes.length > 0) pointStep = sizes.reduce((a, b) => a + b, 0);
        if (!pointsCount && isBinary) return null;

        let rgbOffset = -1;
        let intensityOffset = -1;
        let intensityType = 'F';
        let intensitySize = 4;
        let curOff = 0;
        for (let f = 0; f < fields.length; f++) {
            const fName = fields[f].toLowerCase();
            const fSize = sizes[f] || 4;
            if (fName === 'rgb') rgbOffset = curOff;
            if (fName === 'intensity' || fName === 'i') {
                intensityOffset = curOff;
                intensityType = types[f] || 'F';
                intensitySize = fSize;
            }
            curOff += fSize;
        }
        return { uint8, headerEndIndex, isBinary, pointsCount, pointStep, rgbOffset, intensityOffset, intensityType, intensitySize };
    }

    const pcdFullFrameCache = new Map(); // LRU 8 frame: { flatArray, isFlat: true, count, source: 'full_pcd' }

    function giaiMaPCDFullEgo(arrayBuffer, maxPts = 90000, egoRadius = 70.0) {
        if (!arrayBuffer || Array.isArray(arrayBuffer)) return null;
        const hdr = phanTichHeaderPCD(arrayBuffer);
        if (!hdr) return null;

        const { uint8, headerEndIndex, isBinary, pointsCount, pointStep } = hdr;
        const rMax2 = egoRadius * egoRadius;

        // Voxel giảm mẫu đều theo không gian quanh Ego (0, 0) khi mây vượt quá maxPts
        const rawCap = isBinary ? pointsCount : 120000;
        const tmpFlat = new Float32Array(Math.min(rawCap, isBinary ? pointsCount : rawCap) * 3);
        let nValid = 0;

        if (isBinary) {
            const dataView = new DataView(arrayBuffer, headerEndIndex);
            for (let i = 0; i < pointsCount; i++) {
                const offset = i * pointStep;
                if (offset + 12 > dataView.byteLength) break;
                const px = dataView.getFloat32(offset, true);
                const py = dataView.getFloat32(offset + 4, true);
                const pz = dataView.getFloat32(offset + 8, true);
                if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
                if (px * px + py * py > rMax2) continue;
                const b = nValid * 3;
                if (b + 2 >= tmpFlat.length) break;
                tmpFlat[b] = px; tmpFlat[b + 1] = py; tmpFlat[b + 2] = pz;
                nValid++;
            }
        } else {
            const asciiBody = new TextDecoder().decode(uint8.subarray(headerEndIndex));
            const bodyLines = asciiBody.split(/\r?\n/);
            const outBuf = new Float32Array(bodyLines.length * 3);
            for (let i = 0; i < bodyLines.length; i++) {
                const lineStr = bodyLines[i].trim();
                if (!lineStr) continue;
                const pParts = lineStr.split(/\s+/);
                if (pParts.length < 3) continue;
                const px = parseFloat(pParts[0]);
                const py = parseFloat(pParts[1]);
                const pz = parseFloat(pParts[2]);
                if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
                if (px * px + py * py > rMax2) continue;
                const b = nValid * 3;
                outBuf[b] = px; outBuf[b + 1] = py; outBuf[b + 2] = pz;
                nValid++;
            }
            if (nValid <= maxPts) {
                return { flatArray: outBuf.subarray(0, nValid * 3), isFlat: true, count: nValid, source: 'full_pcd' };
            }
            // Giữ phân bố không gian đều bằng lưới voxel 2D + step nhẹ
            const vSize = 0.25;
            const seen = new Set();
            const keptBuf = new Float32Array(maxPts * 3);
            let nKept = 0;
            const strideA = Math.max(1, Math.floor(nValid / (maxPts * 1.2)));
            for (let k = 0; k < nValid && nKept < maxPts; k += strideA) {
                const b = k * 3;
                const key = ((Math.floor(outBuf[b] / vSize) + 2048) << 12) | ((Math.floor(outBuf[b + 1] / vSize) + 2048) & 0xfff);
                if (seen.has(key) && nValid > maxPts * 1.4) continue;
                seen.add(key);
                const ob = nKept * 3;
                keptBuf[ob] = outBuf[b]; keptBuf[ob + 1] = outBuf[b + 1]; keptBuf[ob + 2] = outBuf[b + 2];
                nKept++;
            }
            return nKept > 0 ? { flatArray: keptBuf.subarray(0, nKept * 3), isFlat: true, count: nKept, source: 'full_pcd' } : null;
        }

        if (nValid === 0) return null;
        if (nValid <= maxPts) {
            return { flatArray: tmpFlat.subarray(0, nValid * 3), isFlat: true, count: nValid, source: 'full_pcd' };
        }
        // Decimate đều không gian qua lưới voxel 2D (0.25m) rồi bù bằng bước đều quanh Ego
        const vSize = 0.25;
        const gridW = Math.ceil((2.0 * egoRadius) / vSize) + 2;
        const occ = new Uint8Array(gridW * gridW);
        const kept = new Float32Array(maxPts * 3);
        let nKept = 0;
        const step = Math.max(1, Math.floor(nValid / maxPts));
        for (let k = 0; k < nValid && nKept < maxPts; k++) {
            const b = k * 3;
            const px = tmpFlat[b], py = tmpFlat[b + 1], pz = tmpFlat[b + 2];
            const gx = Math.floor((px + egoRadius) / vSize);
            const gy = Math.floor((py + egoRadius) / vSize);
            const gid = (gx >= 0 && gx < gridW && gy >= 0 && gy < gridW) ? (gy * gridW + gx) : -1;
            const takeByGrid = gid >= 0 && occ[gid] < 2;
            if (takeByGrid || (k % step === 0)) {
                if (gid >= 0) occ[gid]++;
                const ob = nKept * 3;
                kept[ob] = px; kept[ob + 1] = py; kept[ob + 2] = pz;
                nKept++;
            }
        }
        return nKept > 0 ? { flatArray: kept.subarray(0, nKept * 3), isFlat: true, count: nKept, source: 'full_pcd' } : null;
    }

    function layDiemFullFrameChoSurface(fn) {
        const keyFn = Number(fn);
        if (!Number.isFinite(keyFn)) return null;
        if (pcdFullFrameCache.has(keyFn)) {
            const hit = pcdFullFrameCache.get(keyFn);
            pcdFullFrameCache.delete(keyFn);
            pcdFullFrameCache.set(keyFn, hit);
            return hit;
        }
        if (typeof pcdRawBufferCache === 'undefined' || !pcdRawBufferCache.has(keyFn)) return null;
        const buf = pcdRawBufferCache.get(keyFn);
        const decoded = giaiMaPCDFullEgo(buf, 90000, 75.0);
        if (decoded && decoded.count >= 100) {
            pcdFullFrameCache.set(keyFn, decoded);
            if (pcdFullFrameCache.size > 8) {
                const oldest = pcdFullFrameCache.keys().next().value;
                if (oldest !== undefined) pcdFullFrameCache.delete(oldest);
            }
            return decoded;
        }
        return null;
    }

    function giaiMaPCD(arrayBuffer, targetCenter = null) {
        if (!arrayBuffer) return null;
        if (Array.isArray(arrayBuffer)) return arrayBuffer;
        const hdr = phanTichHeaderPCD(arrayBuffer);
        if (!hdr) return null;
        const { uint8, headerEndIndex, isBinary, pointsCount, pointStep, rgbOffset, intensityOffset, intensityType, intensitySize } = hdr;

        // Tự động tìm targetCenter từ activeModalTrack nếu chưa truyền
        if (!targetCenter && typeof activeModalTrack !== 'undefined' && activeModalTrack?.shapes) {
            const sh = activeModalTrack.shapes[0];
            if (sh && sh.points && sh.points.length >= 3) {
                targetCenter = [sh.points[0], sh.points[1], sh.points[2]];
            }
        }

        const pts = [];
        const tcx = (targetCenter && targetCenter.length >= 3) ? targetCenter[0] : null;
        const tcy = (targetCenter && targetCenter.length >= 3) ? targetCenter[1] : null;
        const tcz = (targetCenter && targetCenter.length >= 3) ? targetCenter[2] : null;
        const distThreshSq = 8.0 * 8.0; // Bán kính 8 mét quanh xe giữ lại 100% điểm sắc nét
        const maxSceneDistSq = 80.0 * 80.0; // Bán kính 80 mét cho mây điểm toàn cảnh rộng

        // Bảng màu LiDAR chuẩn công nghiệp (Chống rác cầu vồng, giữ khối xe trắng sáng & điểm nhấn đèn đỏ)
        function tinhMauIntensity(intVal) {
            if (isNaN(intVal)) return [235, 240, 250];
            // Chuẩn CVAT gốc 100% (Ảnh 2): Trắng bạc sáng tinh khôi, hoàn toàn không sinh điểm đỏ/hồng!
            const norm = Math.max(0, Math.min(1, intVal <= 1.0 ? intVal : intVal / 255.0));
            const val = Math.round(218 + norm * 37);
            return [val, val, Math.min(255, val + 5)];
        }

        if (isBinary) {
            const dataView = new DataView(arrayBuffer, headerEndIndex);
            const step = Math.max(1, Math.floor(pointsCount / 40000));
            for (let i = 0; i < pointsCount; i++) {
                const offset = i * pointStep;
                if (offset + 12 > dataView.byteLength) break;
                const px = dataView.getFloat32(offset, true);
                const py = dataView.getFloat32(offset + 4, true);
                const pz = dataView.getFloat32(offset + 8, true);
                if (isNaN(px) || isNaN(py) || isNaN(pz)) continue;

                let isKept = false;
                if (tcx !== null) {
                    const dx = px - tcx, dy = py - tcy, dz = pz - tcz;
                    const dSq = dx * dx + dy * dy + dz * dz;
                    if (dSq <= distThreshSq) {
                        isKept = true; // 100% điểm trong 6m quanh xe (không decimate)
                    } else if (i % step === 0 && dSq <= maxSceneDistSq) {
                        isKept = true;
                    }
                } else {
                    if (i % step === 0) isKept = true;
                }

                if (!isKept) continue;

                let pr = 175, pg = 200, pb = 208;
                if (rgbOffset >= 0 && offset + rgbOffset + 4 <= dataView.byteLength) {
                    const rgbInt = dataView.getUint32(offset + rgbOffset, true);
                    const b = rgbInt & 0xFF;
                    const g = (rgbInt >> 8) & 0xFF;
                    const r = (rgbInt >> 16) & 0xFF;
                    if (r > 0 || g > 0 || b > 0) {
                        pr = r; pg = g; pb = b;
                    }
                } else if (intensityOffset >= 0 && offset + intensityOffset + intensitySize <= dataView.byteLength) {
                    let intVal = 0;
                    if (intensityType === 'F') {
                        intVal = dataView.getFloat32(offset + intensityOffset, true);
                    } else if (intensitySize === 1) {
                        intVal = dataView.getUint8(offset + intensityOffset);
                    } else {
                        intVal = dataView.getUint16(offset + intensityOffset, true);
                    }
                    const [ir, ig, ib] = tinhMauIntensity(intVal);
                    pr = ir; pg = ig; pb = ib;
                }

                pts.push([px, py, pz, pr, pg, pb]);
            }
        } else {
            const asciiBody = new TextDecoder().decode(uint8.subarray(headerEndIndex));
            const bodyLines = asciiBody.split(/\r?\n/);
            const step = Math.max(1, Math.floor(bodyLines.length / 40000));
            for (let i = 0; i < bodyLines.length; i++) {
                const lineStr = bodyLines[i].trim();
                if (!lineStr) continue;
                const pParts = lineStr.split(/\s+/);
                if (pParts.length < 3) continue;

                const px = parseFloat(pParts[0]);
                const py = parseFloat(pParts[1]);
                const pz = parseFloat(pParts[2]);
                if (isNaN(px) || isNaN(py) || isNaN(pz)) continue;

                let isKept = false;
                if (tcx !== null) {
                    const dx = px - tcx, dy = py - tcy, dz = pz - tcz;
                    const dSq = dx * dx + dy * dy + dz * dz;
                    if (dSq <= distThreshSq) {
                        isKept = true;
                    } else if (i % step === 0 && dSq <= maxSceneDistSq) {
                        isKept = true;
                    }
                } else {
                    if (i % step === 0) isKept = true;
                }

                if (!isKept) continue;

                let pr = 175, pg = 200, pb = 208;
                if (pParts.length >= 4) {
                    const val = parseFloat(pParts[3]);
                    if (!isNaN(val)) {
                        if (val > 255) {
                            const rgbInt = parseInt(pParts[3], 10);
                            pr = (rgbInt >> 16) & 0xFF;
                            pg = (rgbInt >> 8) & 0xFF;
                            pb = rgbInt & 0xFF;
                        } else {
                            const [ir, ig, ib] = tinhMauIntensity(val);
                            pr = ir; pg = ig; pb = ib;
                        }
                    }
                }

                pts.push([px, py, pz, pr, pg, pb]);
            }
        }
        return pts.length > 0 ? pts : null;
    }

    async function taiDiemLiDARChoFrame(jobId, frameNum, targetCenter = null) {
        frameNum = parseInt(frameNum, 10);
        if (isNaN(frameNum)) return null;

        // Tự động tìm targetCenter từ activeModalTrack nếu chưa truyền
        if (!targetCenter && typeof activeModalTrack !== 'undefined' && activeModalTrack?.shapes) {
            const sh = activeModalTrack.shapes.find(s => Number(s.frame) === Number(frameNum));
            if (sh && sh.points && sh.points.length >= 3) {
                targetCenter = [sh.points[0], sh.points[1], sh.points[2]];
            }
        }

        // 1. Nếu đã có điểm LiDAR THỰC trong cache thì trả về ngay 0ms
        if (pcdFrameCache.has(frameNum)) return pcdFrameCache.get(frameNum);
        if (pcdLoadingPromises.has(frameNum)) return await pcdLoadingPromises.get(frameNum);

        let loadPromise;
        loadPromise = (async () => {
            try {
                if (!jobId) {
                    jobId = layJobIdHienTai();
                }

                // 1. [v2.5.7] ƯU TIÊN 1: Nếu đã có pcdBuffer gốc trong RAM -> Giải mã 0ms theo tâm của Track mới!
                if (pcdRawBufferCache.has(frameNum)) {
                    const cachedBuf = pcdRawBufferCache.get(frameNum);
                    const pts = giaiMaPCD(cachedBuf, targetCenter);
                    if (pts && pts.length > 0) {
                        pcdFrameCache.set(frameNum, pts);
                        return pts;
                    }
                }

                // 2. Tải file PCD gốc từ máy chủ CVAT qua REST API
                try {
                    const resp = await fetch(`/api/jobs/${jobId}/data?type=frame&quality=original&number=${frameNum}`, { credentials: 'include' });
                    if (resp.ok) {
                        const pcdBuffer = await resp.arrayBuffer();
                        if (pcdBuffer && pcdBuffer.byteLength >= 16) {
                            pcdRawBufferCache.set(frameNum, pcdBuffer); // Lưu buffer vĩnh viễn cho Job
                            const pts = giaiMaPCD(pcdBuffer, targetCenter);
                            if (pts && pts.length > 0) {
                                pcdFrameCache.set(frameNum, pts);
                                return pts;
                            }
                        }
                    }
                } catch (eFetch) {}

                // 2. Dự phòng: Nạp từ Three.js RAM nếu REST API bị chặn
                try {
                    const curFn = layFrameHienTai();
                    if (curFn === frameNum && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layDiemLiDARThreeJS === 'function') {
                        const curTargetCenter = targetCenter || (activeModalTrack?.shapes?.find(s => Number(s.frame) === frameNum)?.points) || null;
                        const memPts = window.quanLyAPICVAT.layDiemLiDARThreeJS(frameNum, curTargetCenter ? [curTargetCenter[0], curTargetCenter[1], curTargetCenter[2]] : null);
                        if (memPts && memPts.length > 0) {
                            pcdFrameCache.set(frameNum, memPts);
                            return memPts;
                        }
                    }
                } catch (eMem) {
                    console.warn(`[CVAT 3D] Không lấy được điểm Three.js frame ${frameNum}:`, eMem);
                }

                // 4. Dự phòng: Nạp từ CVAT Core Native frames API nếu REST API bị chặn
                try {
                    const job = window.quanLyAPICVAT ? window.quanLyAPICVAT.getJobInstance() : null;
                    if (job && job.frames && typeof job.frames.get === 'function') {
                        const frameData = await Promise.race([
                            job.frames.get(frameNum),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout CVAT Native frame data')), 2500))
                        ]);
                        if (frameData) {
                            let rawData = null;
                            if (typeof frameData.data === 'function') {
                                const dataRes = await frameData.data();
                                rawData = dataRes?.imageData || dataRes?.pointCloud || dataRes?.points || dataRes?.data || dataRes;
                            } else {
                                rawData = frameData.imageData || frameData.pointCloud || frameData.points || frameData.data;
                            }

                            let pcdBuffer = null;
                            if (rawData instanceof ArrayBuffer) {
                                pcdBuffer = rawData;
                            } else if (ArrayBuffer.isView(rawData)) {
                                pcdBuffer = rawData.buffer.slice(rawData.byteOffset, rawData.byteOffset + rawData.byteLength);
                            } else if (rawData && typeof rawData.arrayBuffer === 'function') {
                                pcdBuffer = await rawData.arrayBuffer();
                            }

                            if (pcdBuffer && pcdBuffer.byteLength >= 16) {
                                const pts = giaiMaPCD(pcdBuffer, targetCenter);
                                if (pts && pts.length > 0) {
                                    pcdFrameCache.set(frameNum, pts);
                                    return pts;
                                }
                            }

                            if (Array.isArray(rawData) && rawData.length > 0 && Array.isArray(rawData[0])) {
                                pcdFrameCache.set(frameNum, rawData);
                                return rawData;
                            }
                        }
                    }
                } catch (eJob) {}

                // Nếu chưa tải được điểm thật từ API, trả về mảng rỗng []
                return [];
            } catch (errTop) {
                return [];
            }
        })();

        pcdLoadingPromises.set(frameNum, loadPromise);
        try {
            return await loadPromise;
        } finally {
            pcdLoadingPromises.delete(frameNum);
        }
    }



    /**

     * Sinh đám mây điểm LiDAR mô phỏng chuẩn xác thân xe CAD và mặt đường

     * Đảm bảo hiển thị tức thì 0ms, không bao giờ bị rỗng hộp trắng

     */

    function sinhDiemLiDARXe(L, W, H, seed = 0) {
        const pts = [];
        const hl = L / 2;
        const hw = W / 2;
        const hh = H / 2;

        let s = (seed + 1) * 9301 + 49297;
        function rnd() {
            s = (s * 9301 + 49297) % 233280;
            return s / 233280;
        }

        // [v2.3.4] MÔ PHỎNG LASER LIDAR ĐA TẦNG SIÊU THỰC (~1080 ĐIỂM, 750+ ĐIỂM TRONG BOX)
        // 1. Nóc xe & Mui xe (Roof & Top) - 3 dải tia laser song song (140 điểm)
        for (let i = 0; i < 140; i++) {
            const u = hl * (-0.50 + 0.55 * rnd());
            const v = hw * (rnd() * 1.6 - 0.8);
            const w = hh - H * 0.05 * rnd();
            pts.push([u, v, w, 240, 245, 255]);
        }

        // 2. Kính chắn gió trước nghiêng dốc (Windshield) - 90 điểm
        for (let i = 0; i < 90; i++) {
            const t = rnd();
            const u = hl * (0.35 - 0.30 * t);
            const v = hw * (rnd() * 1.6 - 0.8);
            const w = -hh + H * (0.50 + 0.45 * t);
            pts.push([u, v, w, 220, 238, 255]);
        }

        // 3. Nắp ca-pô & Cản trước (Hood & Front Bumper) - 130 điểm
        for (let i = 0; i < 130; i++) {
            const u = hl * (0.35 + 0.63 * rnd());
            const v = hw * (rnd() * 1.8 - 0.9);
            const w = -hh + H * (0.35 + 0.15 * rnd());
            pts.push([u, v, w, 235, 242, 252]);
        }

        // 4. Kính sau & Cốp sau (Rear Window & Trunk) - 110 điểm
        for (let i = 0; i < 110; i++) {
            const t = rnd();
            const u = hl * (-0.50 - 0.45 * t);
            const v = hw * (rnd() * 1.7 - 0.85);
            const w = -hh + H * (0.32 + 0.55 * (1 - t));
            pts.push([u, v, w, 225, 235, 250]);
        }

        // 5. Hai bên sườn xe, Cửa, Viền gương & Vòm bánh (Doors & Sides) - 220 điểm
        for (let i = 0; i < 220; i++) {
            const u = hl * (rnd() * 1.94 - 0.97);
            const sign = rnd() > 0.5 ? 1 : -1;
            const v = sign * hw * (0.92 + 0.08 * rnd());
            const w = -hh + H * (0.12 + 0.78 * rnd());
            pts.push([u, v, w, 230, 238, 250]);
        }

        // 6. Cản trước, cản sau và đèn xe (Front/Rear lights & bumpers) - 70 điểm
        for (let i = 0; i < 70; i++) {
            const sign = rnd() > 0.5 ? 1 : -1;
            const u = sign * hl * (0.95 + 0.05 * rnd());
            const v = hw * (rnd() * 1.8 - 0.9);
            const w = -hh + H * (0.20 + 0.35 * rnd());
            pts.push([u, v, w, 245, 250, 255]);
        }

        // 7. Mặt đường xung quanh xe với 6 vòng quét LiDAR đồng tâm (Ground LiDAR Rings) - 320 điểm
        const ringRadii = [1.2, 1.8, 2.6, 3.5, 4.6, 6.0];
        for (let rIdx = 0; rIdx < ringRadii.length; rIdx++) {
            const rBase = ringRadii[rIdx];
            const count = 35 + rIdx * 8;
            for (let i = 0; i < count; i++) {
                const ang = (i / count) * Math.PI * 2 + (rnd() * 0.1 - 0.05);
                const dist = rBase + (rnd() * 0.16 - 0.08);
                const u = Math.cos(ang) * dist;
                const v = Math.sin(ang) * dist;
                const w = -hh - 0.04 + (rnd() * 0.06 - 0.03);
                pts.push([u, v, w, 155, 175, 195]);
            }
        }

        return pts;
    }



    /**

     * Chuyển đổi điểm LiDAR toàn cục sang hệ tọa độ cục bộ của xe (Local Vehicle Frame)

     */

    function chuyenDiemSangCucBo(globalPts, cx, cy, cz, p5, p6, p7, p8) {
        if (!globalPts || globalPts.length === 0) return [];

        let rx = 0, ry = 0, rz = 0, maxDist = 8.0;

        // Phân biệt chính xác giữa gọi 5-6 tham số (cũ: rz, maxDist) và 7-8 tham số (chuẩn: rx, ry, rz, maxDist)
        if (arguments.length <= 6) {
            rz = (typeof p5 === 'number') ? p5 : 0;
            maxDist = (typeof p6 === 'number' && p6 > 0) ? p6 : 8.0;
            rx = 0;
            ry = 0;
        } else {
            rx = (typeof p5 === 'number') ? p5 : 0;
            ry = (typeof p6 === 'number') ? p6 : 0;
            rz = (typeof p7 === 'number') ? p7 : 0;
            maxDist = (typeof p8 === 'number' && p8 > 0) ? p8 : 8.0;
        }
        const limDist = maxDist;
        const limZ = Math.max(4.0, limDist * 0.45);

        let rotMat = null;
        if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.eulerXYZToMatrix === 'function') {
            rotMat = window.thuatToanCanChinh.eulerXYZToMatrix(rx || 0, ry || 0, rz || 0);
        }

        const localPts = [];
        if (rotMat) {
            for (let i = 0; i < globalPts.length; i++) {
                const p = globalPts[i];
                const gx = p[0], gy = p[1], gz = p[2];
                const pr = p[3] !== undefined ? p[3] : 240;
                const pg = p[4] !== undefined ? p[4] : 240;
                const pb = p[5] !== undefined ? p[5] : 240;

                const dx = gx - cx;
                const dy = gy - cy;
                const dz = gz - cz;
                if (Math.abs(dx) > limDist || Math.abs(dy) > limDist || Math.abs(dz) > limZ) continue;

                const u = dx * rotMat[0][0] + dy * rotMat[1][0] + dz * rotMat[2][0];
                const v = dx * rotMat[0][1] + dy * rotMat[1][1] + dz * rotMat[2][1];
                const w = dx * rotMat[0][2] + dy * rotMat[1][2] + dz * rotMat[2][2];
                localPts.push([u, v, w, pr, pg, pb]);
            }
        } else {
            const cosRz = Math.cos(-rz);
            const sinRz = Math.sin(-rz);
            for (let i = 0; i < globalPts.length; i++) {
                const p = globalPts[i];
                const gx = p[0], gy = p[1], gz = p[2];
                const pr = p[3] !== undefined ? p[3] : 240;
                const pg = p[4] !== undefined ? p[4] : 240;
                const pb = p[5] !== undefined ? p[5] : 240;

                const dx = gx - cx;
                const dy = gy - cy;
                const dz = gz - cz;
                if (Math.abs(dx) > limDist || Math.abs(dy) > limDist || Math.abs(dz) > limZ) continue;
                const u = cosRz * dx - sinRz * dy;
                const v = sinRz * dx + cosRz * dy;
                const w = dz;
                localPts.push([u, v, w, pr, pg, pb]);
            }
        }
        return localPts;
    }



    // =========================================================================

    // BỘ VẼ CANVAS 2D CHUẨN XÁC Y HỆT BẢN DESKTOP EXE (PYQTGRAPH REPLICA)

    // =========================================================================



    /**

     * 1. TOP VIEW (TRỤC X-Y: DỌC - NGANG)

     * Ngang: -5m đến +5m (Dọc xe, Đầu xe ➡️)

     * Dọc: -2m đến +2m (Ngang xe)

     */

    // =========================================================================
    // TRỢ LÝ VẼ ĐIỂM LIDAR NHANH (LUT 32 MỨC + ZERO STRING/OBJECT ALLOCATION)
    // & TÁI CHIẾU / VẼ LẠI THEO HÀNG (SHARED REPROJECTION HELPERS)
    // =========================================================================
    const _OUT_GRAY_LUT = new Array(32);
    const _IN_GRAY_LUT = new Array(32);
    const _IN_HEIGHT_LUT = new Array(32);
    for (let _b = 0; _b < 32; _b++) {
        const _v = Math.min(255, _b * 8 + 4);
        const _outV = Math.round(_v * 0.75);
        const _outB = Math.min(255, Math.round(Math.min(255, _v + 5) * 0.75));
        const _inB = Math.min(255, _v + 5);
        _OUT_GRAY_LUT[_b] = `rgba(${_outV},${_outV},${_outB},0.92)`;
        _IN_GRAY_LUT[_b] = `rgba(${_v},${_v},${_inB},0.98)`;
        const _normH = _b / 31;
        const _hr = Math.round(225 + _normH * 30);
        const _hg = Math.round(240 + _normH * 15);
        _IN_HEIGHT_LUT[_b] = `rgba(${_hr},${_hg},255,0.98)`;
    }
    const _lidarOutDefaultPts = [];
    const _lidarOutGrayBuckets = Array.from({ length: 32 }, () => []);
    const _lidarInGrayBuckets = Array.from({ length: 32 }, () => []);
    const _lidarInHeightBuckets = Array.from({ length: 32 }, () => []);
    const _lidarOutRgbExtra = [];
    const _lidarInRgbExtra = [];
    const _rgbStyleLutOut = new Map();
    const _rgbStyleLutIn = new Map();

    function _layMauRgbQuantized(r, g, b, isInside) {
        const rq = Math.min(31, Math.max(0, r >> 3));
        const gq = Math.min(31, Math.max(0, g >> 3));
        const bq = Math.min(31, Math.max(0, b >> 3));
        const key = (rq << 10) | (gq << 5) | bq;
        const lut = isInside ? _rgbStyleLutIn : _rgbStyleLutOut;
        let style = lut.get(key);
        if (!style) {
            const rv = Math.min(255, rq * 8 + 4);
            const gv = Math.min(255, gq * 8 + 4);
            const bv = Math.min(255, bq * 8 + 4);
            if (isInside) {
                style = `rgba(${rv},${gv},${bv},0.98)`;
            } else {
                style = `rgba(${Math.round(rv * 0.75)},${Math.round(gv * 0.75)},${Math.round(bv * 0.75)},0.92)`;
            }
            lut.set(key, style);
        }
        return style;
    }

    function batDauThuThapDiemCanvas() {
        _lidarOutDefaultPts.length = 0;
        _lidarOutRgbExtra.length = 0;
        _lidarInRgbExtra.length = 0;
        for (let b = 0; b < 32; b++) {
            _lidarOutGrayBuckets[b].length = 0;
            _lidarInGrayBuckets[b].length = 0;
            _lidarInHeightBuckets[b].length = 0;
        }
    }

    function themDiemNgoaiCanvas(px, py, rawR, rawG, rawB) {
        if (rawR === undefined) {
            _lidarOutDefaultPts.push(px, py);
            return;
        }
        if (rawG === rawR && (rawB === rawR || rawB === Math.min(255, rawR + 5))) {
            const b = Math.min(31, Math.max(0, rawR >> 3));
            _lidarOutGrayBuckets[b].push(px, py);
        } else {
            _lidarOutRgbExtra.push(px, py, _layMauRgbQuantized(rawR, rawG, rawB, false));
        }
    }

    function themDiemTrongCanvas(px, py, w, hh, H, rawR, rawG, rawB) {
        if (rawR === undefined) {
            const normH = Math.max(0, Math.min(1, ((w || 0) + hh) / Math.max(0.1, H)));
            const b = Math.min(31, Math.max(0, Math.round(normH * 31)));
            _lidarInHeightBuckets[b].push(px, py);
            return;
        }
        if (rawG === rawR && (rawB === rawR || rawB === Math.min(255, rawR + 5))) {
            const b = Math.min(31, Math.max(0, rawR >> 3));
            _lidarInGrayBuckets[b].push(px, py);
        } else {
            _lidarInRgbExtra.push(px, py, _layMauRgbQuantized(rawR, rawG, rawB, true));
        }
    }

    function _veMangBucketToaDo(ctx, arr, radius, diameter) {
        for (let k = 0; k < arr.length; k += 2) {
            ctx.fillRect(arr[k] - radius, arr[k + 1] - radius, diameter, diameter);
        }
    }

    function ketThucVeDiemCanvas(ctx, outPtRadius, outD, inPtRadius, inD) {
        if (_lidarOutDefaultPts.length > 0) {
            ctx.fillStyle = 'rgba(215, 230, 245, 0.90)';
            _veMangBucketToaDo(ctx, _lidarOutDefaultPts, outPtRadius, outD);
        }
        for (let b = 0; b < 32; b++) {
            const arr = _lidarOutGrayBuckets[b];
            if (arr.length > 0) {
                ctx.fillStyle = _OUT_GRAY_LUT[b];
                _veMangBucketToaDo(ctx, arr, outPtRadius, outD);
                arr.length = 0;
            }
        }
        if (_lidarOutRgbExtra.length > 0) {
            let lastStyle = '';
            for (let k = 0; k < _lidarOutRgbExtra.length; k += 3) {
                const st = _lidarOutRgbExtra[k + 2];
                if (st !== lastStyle) { ctx.fillStyle = st; lastStyle = st; }
                ctx.fillRect(_lidarOutRgbExtra[k] - outPtRadius, _lidarOutRgbExtra[k + 1] - outPtRadius, outD, outD);
            }
        }
        for (let b = 0; b < 32; b++) {
            const arr = _lidarInGrayBuckets[b];
            if (arr.length > 0) {
                ctx.fillStyle = _IN_GRAY_LUT[b];
                _veMangBucketToaDo(ctx, arr, inPtRadius, inD);
                arr.length = 0;
            }
            const hArr = _lidarInHeightBuckets[b];
            if (hArr.length > 0) {
                ctx.fillStyle = _IN_HEIGHT_LUT[b];
                _veMangBucketToaDo(ctx, hArr, inPtRadius, inD);
                hArr.length = 0;
            }
        }
        if (_lidarInRgbExtra.length > 0) {
            let lastStyle = '';
            for (let k = 0; k < _lidarInRgbExtra.length; k += 3) {
                const st = _lidarInRgbExtra[k + 2];
                if (st !== lastStyle) { ctx.fillStyle = st; lastStyle = st; }
                ctx.fillRect(_lidarInRgbExtra[k] - inPtRadius, _lidarInRgbExtra[k + 1] - inPtRadius, inD, inD);
            }
        }
        _lidarOutDefaultPts.length = 0;
        _lidarOutRgbExtra.length = 0;
        _lidarInRgbExtra.length = 0;
    }

    function bienDoiDiemCucBoTaiCho(pts, du, dv, dz, dyaw = 0, dpitch = 0, droll = 0) {
        if (!Array.isArray(pts) || pts.length === 0) return pts;
        const hasYaw = Math.abs(dyaw) > 1e-6;
        const hasPitch = Math.abs(dpitch) > 1e-6;
        const hasRoll = Math.abs(droll) > 1e-6;
        const cosY = hasYaw ? Math.cos(-dyaw) : 1, sinY = hasYaw ? Math.sin(-dyaw) : 0;
        const cosP = hasPitch ? Math.cos(-dpitch) : 1, sinP = hasPitch ? Math.sin(-dpitch) : 0;
        const cosR = hasRoll ? Math.cos(-droll) : 1, sinR = hasRoll ? Math.sin(-droll) : 0;

        const res = new Array(pts.length);
        for (let i = 0; i < pts.length; i++) {
            const pt = pts[i];
            let u = pt[0] - du;
            let v = pt[1] - dv;
            let w = (pt[2] || 0) - dz;
            if (hasYaw) {
                const nu = cosY * u - sinY * v;
                const nv = sinY * u + cosY * v;
                u = nu; v = nv;
            }
            if (hasPitch) {
                const nu = cosP * u - sinP * w;
                const nw = sinP * u + cosP * w;
                u = nu; w = nw;
            }
            if (hasRoll) {
                const nv = cosR * v - sinR * w;
                const nw = sinR * v + cosR * w;
                v = nv; w = nw;
            }
            if (pt.length >= 6) {
                res[i] = [u, v, w, pt[3], pt[4], pt[5]];
            } else {
                res[i] = [u, v, w];
            }
        }
        return res;
    }

    function reprojectLiDARChoRow(row, sh, deltaFallback = null) {
        if (!row || !sh || !sh.points) return false;
        const fn = Number(row.getAttribute('data-frame-num') ?? row.getAttribute('data-frame') ?? sh.frame);
        const p = sh.points;
        const rawPts = pcdFrameCache.get(fn) || pcdSyntheticCache.get(fn);
        if (rawPts && rawPts.length > 0) {
            row._localLiDARPoints = chuyenDiemSangCucBo(rawPts, p[0], p[1], p[2], p[3] || 0, p[4] || 0, p[5] || 0, 8.0);
            row._wideLiDARPoints = chuyenDiemSangCucBo(rawPts, p[0], p[1], p[2], 0, 0, p[5] || 0, 80.0);
        } else {
            const delta = deltaFallback || row._pendingPointDeltas;
            if (delta && (delta.du || delta.dv || delta.dz || delta.dyaw || delta.dpitch || delta.droll)) {
                if (Array.isArray(row._localLiDARPoints) && row._localLiDARPoints.length > 0) {
                    row._localLiDARPoints = bienDoiDiemCucBoTaiCho(row._localLiDARPoints, delta.du, delta.dv, delta.dz, delta.dyaw, delta.dpitch, delta.droll);
                }
                if (Array.isArray(row._wideLiDARPoints) && row._wideLiDARPoints.length > 0) {
                    row._wideLiDARPoints = bienDoiDiemCucBoTaiCho(row._wideLiDARPoints, delta.du, delta.dv, delta.dz, delta.dyaw, 0, 0);
                }
            }
        }
        row._needsLiDARReproject = false;
        row._pendingPointDeltas = null;

        const localPts = row._localLiDARPoints;
        if (Array.isArray(localPts)) {
            const hl = (p[6] || 0) / 2, hw = (p[7] || 0) / 2, hh = (p[8] || 0) / 2;
            let inBoxPts = 0;
            for (let i = 0; i < localPts.length; i++) {
                const pt = localPts[i];
                if (Math.abs(pt[0]) <= hl && Math.abs(pt[1]) <= hw && Math.abs(pt[2]) <= hh) inBoxPts++;
            }
            const badgePts = row.querySelector('.pts-count-badge');
            if (badgePts) badgePts.textContent = `${inBoxPts} pts`;
        }
        return !!(rawPts && rawPts.length > 0);
    }

    function tichLuyDeltaChoRow(row, du, dv, dz, dyaw = 0, dpitch = 0, droll = 0) {
        if (!row) return;
        const prev = row._pendingPointDeltas || { du: 0, dv: 0, dz: 0, dyaw: 0, dpitch: 0, droll: 0 };
        prev.du += du; prev.dv += dv; prev.dz += dz;
        prev.dyaw += dyaw; prev.dpitch += dpitch; prev.droll += droll;
        row._pendingPointDeltas = prev;
        row._needsLiDARReproject = true;
    }

    function laRowDangHienThi(row, listEl = null) {
        if (!row) return false;
        if (row.querySelector('.row-view-card.is-fullscreen-view')) return true;
        const body = listEl || document.getElementById('modal-rows-list');
        if (!body) return true;
        const sTop = body.scrollTop;
        const cHeight = body.clientHeight || 800;
        const rTop = row.offsetTop;
        const rBottom = rTop + (row.offsetHeight || 225);
        return rBottom >= (sTop - 250) && rTop <= (sTop + cHeight + 250);
    }

    function veRowCanvasTuDiem(row, sh, forceAllViews = false) {
        if (!row || !sh || !sh.points) return false;
        const fn = Number(row.getAttribute('data-frame-num') ?? row.getAttribute('data-frame') ?? sh.frame);
        if (!forceAllViews && dangTuongTacCanvas(fn)) {
            row._needsRedraw = true;
            return false;
        }
        if (row._needsLiDARReproject) {
            reprojectLiDARChoRow(row, sh);
        }
        row._needsRedraw = false;
        const [, , z, , , , L, W, H] = sh.points;
        const localPts = row._localLiDARPoints || [];
        const topPts = (row._wideLiDARPoints && row._wideLiDARPoints.length > 0) ? row._wideLiDARPoints : localPts;
        const showOther = (row._showOtherObjects !== undefined ? !!row._showOtherObjects : modalShowOtherObjects);
        const ct = row.querySelector('.canvas-top');
        const cs = row.querySelector('.canvas-side');
        const cf = row.querySelector('.canvas-front');
        if (ct && (forceAllViews || !dangTuongTacCanvas(fn, 'top'))) {
            veCanvasTopView(ct, L, W, H, topPts, 0, 0, false, 0, fn, showOther);
        }
        if (cs && (forceAllViews || !dangTuongTacCanvas(fn, 'side'))) {
            veCanvasSideView(cs, L, W, H, localPts, z, 0, 0, false, 0);
        }
        if (cf && (forceAllViews || !dangTuongTacCanvas(fn, 'front'))) {
            veCanvasFrontView(cf, L, W, H, localPts, z, 0, 0, false, 0);
        }
        return true;
    }

    /**
     * Xác định con trỏ chuột đang nằm trên tay cầm resize (8 tay cầm) hay vùng di chuyển (move)
     */
    /**
     * TÍNH TOÁN TỶ LỆ PHÓNG (SCALE ZOOM) CHUẨN XÁC 100% THEO THUẬT TOÁN CVAT NATIVE
     * (focusedObjectPadding = 50px, baseline = ORTHO_FRUSTUM_HEIGHT, căn chỉnh vừa khít khung hình)
     */

    function chupSnapshotMainTrack(track) {
        if (!track || !track.shapes) return null;
        return {
            _isMainTrackUndoSnapshot: true,
            outsideDangTamBo: !!track._outsideDangTamBo,
            shapes: track.shapes.map(s => ({
                frame: s.frame,
                outside: !!s.outside,
                marked: !!s._markedOutside,
                points: [...(s.points || [])]
            }))
        };
    }

    function apDungSnapshotMainTrack(track, stateObj) {
        if (!track || !track.shapes || !stateObj) return;
        const shapeList = Array.isArray(stateObj) ? stateObj : (stateObj.shapes || []);
        for (const s of track.shapes) {
            const match = shapeList.find(p => p.frame === s.frame);
            if (match) {
                s.outside = !!match.outside;
                if (match.marked) s._markedOutside = true;
                else delete s._markedOutside;
                s.points = [...(match.points || [])];
            }
        }
        if (!Array.isArray(stateObj) && typeof stateObj.outsideDangTamBo === 'boolean') {
            track._outsideDangTamBo = stateObj.outsideDangTamBo;
        }
        if (typeof dongBoGiaoDienNutOutside === 'function') {
            dongBoGiaoDienNutOutside();
        }
    }

    function luuUndoSnapshotModal() {
        if (!activeModalTrack || !activeModalTrack.shapes) return;
        activeModalTrack._isDirty = true;
        delete activeModalTrack._origShapesBackup;
        const curState = chupSnapshotMainTrack(activeModalTrack);
        if (!curState) return;
        modalUndoStack.push(curState);
        if (modalUndoStack.length > 50) modalUndoStack.shift();
        modalRedoStack = [];
    }

    function luuUndoSnapshotOtherTrack(otherTrack) {
        if (!otherTrack || !Array.isArray(otherTrack.shapes)) return;
        otherTrack._isDirty = true;
        delete otherTrack._origShapesBackup;
        const snap = otherTrack.shapes.map(s => ({
            type: s.type || 'cuboid',
            frame: Number(s.frame),
            outside: !!s.outside,
            occluded: !!s.occluded,
            points: [...(s.points || [])],
            attributes: s.attributes ? JSON.parse(JSON.stringify(s.attributes)) : []
        }));
        modalUndoStack.push({
            _isOtherTrackUndo: true,
            track: otherTrack,
            shapesSnap: snap
        });
        if (modalUndoStack.length > 50) modalUndoStack.shift();
        modalRedoStack = [];
    }

    // =========================================================================
    // BỘ VẼ 3 KHUNG NHÌN 3D CHUẨN XÁC 100% CVAT THREE.JS NATIVE (cuboid.ts & canvas3dView.ts)
    // - Depth Clipping Frustum near/far (+-0.10m): Triệt tiêu bức tường / cây cối / xe sau
    // - Colormap Z-gradient Cyan rực rỡ chuẩn Three.js: Thân xe sáng rõ nét, mặt đường dịu mắt
    // - Cuboid viền trắng (#ffffff), 4 chấm đỏ (#ff0000) 4 góc, 1 chấm xanh (#33b864) rotation helper
    // =========================================================================

    // =========================================================================
    // BỘ VẼ 3 KHUNG NHÌN 3D CHUẨN XÁC 100% CVAT THREE.JS NATIVE (cuboid.ts & canvas3dView.ts)
    // - Phạm vi bao quát toàn diện y hệt CVAT: Nhìn rõ mặt đường, vạch kẻ đường, không gian xung quanh
    // - Depth Clipping chuẩn CVAT (0.1m - 0.35m): Triệt tiêu bức tường / cột điện / cây cối phía sau
    // - Phối màu y hệt CVAT: Nền cuboid xanh sẫm [5, 48, 57], viền trắng, chấm đỏ resize, chấm xanh rotation
    // - Điểm LiDAR xám bạc ánh xanh ngọc khói chân thực, tia quét mặt đường rõ nét
    // =========================================================================

    // =========================================================================
    // BỘ VẼ 3 KHUNG NHÌN 3D CHUẨN XÁC 100% CVAT THREE.JS NATIVE (cuboid.ts & canvas3dView.ts)
    // - Đầy đủ 3 trục tọa độ xe RGB (Đỏ: X, Xanh lá: Y, Xanh lam: Z)
    // - Chiều trục chuẩn xác 100% không bị ngược: Mặt đường & xe làn bên nằm đúng vị trí
    // - Nền cuboid xanh sẫm [5, 48, 57], 4 chấm đỏ resize, 1 chấm xanh rotation helper
    // =========================================================================

    function veMuiTenTruc(ctx, fromX, fromY, toX, toY, color, lineWidth = 2) {
        if (!ctx || typeof ctx.moveTo !== 'function' || typeof ctx.lineTo !== 'function') return;
        if (ctx.save) ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = lineWidth;
        ctx.beginPath();
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.stroke();

        const angle = Math.atan2(toY - fromY, toX - fromX);
        const headLen = 7;
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(toX - headLen * Math.cos(angle - Math.PI / 6), toY - headLen * Math.sin(angle - Math.PI / 6));
        ctx.lineTo(toX - headLen * Math.cos(angle + Math.PI / 6), toY - headLen * Math.sin(angle + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
        if (ctx.restore) ctx.restore();
    }

    function tinhScaleCVAT(viewType, L, W, H, cw, ch) {
        L = (typeof L === 'number' && L > 0) ? L : 4.4;
        W = (typeof W === 'number' && W > 0) ? W : 1.9;
        H = (typeof H === 'number' && H > 0) ? H : 1.6;

        if (viewType === 'top') {
            return Math.min(cw * 0.60 / L, ch * 0.54 / W);
        } else if (viewType === 'side') {
            return Math.min(cw * 0.60 / L, ch * 0.50 / H);
        } else if (viewType === 'front') {
            return Math.min(cw * 0.42 / W, ch * 0.50 / H);
        }
        return 52.0;
    }




    
    // =========================================================================
    // QUẢN LÝ HIỂN THỊ CÁC VẬT THỂ KHÁC (OTHER OBJECTS) TOÀN BỘ MODAL CHI TIẾT
    // =========================================================================
        // Cache danh sách Other Objects đã tính toán cho từng frame để không bị tính lại khi rê chuột
    const modalOtherObjectsCache = new Map();
    let modalShowOtherObjects = false;
    let modalEditAllObjects = false;

    function toggleChinhTatCaObjects(forceVal = null) {
        if (forceVal !== null) {
            modalEditAllObjects = !!forceVal;
        } else {
            modalEditAllObjects = !modalEditAllObjects;
        }

        const btnEditAll = document.getElementById('modal-btn-edit-all-obj');
        if (btnEditAll) {
            btnEditAll.classList.toggle('is-active', modalEditAllObjects);
        }

        // Khi bật Chỉnh Tất Cả, tự động bật hiển thị Other Objects nếu đang tắt
        if (modalEditAllObjects && !modalShowOtherObjects) {
            toggleHienThiOtherObjects(true, true);
        } else {
            modalOtherObjectsCache.clear();
            document.querySelectorAll('.frame-detail-row').forEach(row => {
                const cTop = row.querySelector('.canvas-top');
                if (cTop) {
                    const fn = (cTop._frameNum !== undefined) ? cTop._frameNum : parseInt(row.id.replace('modal-row-frame-', ''), 10);
                    taiVeCanvasTheoFrame(cTop, 'top', fn);
                }
            });
        }

        hienToast(modalEditAllObjects
            ? '🛠️ Đã BẬT Chỉnh Tất Cả: Kéo chỉnh trực tiếp mọi vật thể trên View TOP • Double-click hoặc Ctrl+Click vào vật thể để chuyển Track!'
            : '🛠️ Đã TẮT chế độ Chỉnh Tất Cả trên View TOP');
    }

    function toggleHienThiOtherObjects(forceVal = null, silentToast = false) {
        modalOtherObjectsCache.clear();
        if (forceVal !== null) {
            modalShowOtherObjects = !!forceVal;
        } else {
            modalShowOtherObjects = !modalShowOtherObjects;
        }

        // Cập nhật tất cả các nút Other Objects trên từng hàng
        document.querySelectorAll('.btn-toggle-other-obj').forEach(btn => {
            if (modalShowOtherObjects) {
                btn.classList.add('is-active');
                btn.style.background = '#0ea5e9';
                btn.style.color = '#ffffff';
                btn.style.borderColor = '#38bdf8';
                btn.style.boxShadow = '0 0 8px rgba(14, 165, 233, 0.5)';
                btn.textContent = '👁️ Other Objects [BẬT]';
            } else {
                btn.classList.remove('is-active');
                btn.style.background = '#1e293b';
                btn.style.color = '#94a3b8';
                btn.style.borderColor = '#475569';
                btn.style.boxShadow = 'none';
                btn.textContent = '👁️ Other Objects';
            }
        });

        // Cập nhật nút trên thanh công cụ Header (Giữ nguyên form dáng, chỉ toggle class is-active)
        const headerBtn = document.getElementById('modal-btn-toggle-other-obj');
        if (headerBtn) {
            headerBtn.classList.toggle('is-active', modalShowOtherObjects);
            headerBtn.style.background = '';
            headerBtn.style.color = '';
            headerBtn.style.borderColor = '';
            headerBtn.style.boxShadow = '';
            let approvedCnt = 0;
            if (window.khoDuyet && currentAnnotations && Array.isArray(currentAnnotations.tracks)) {
                const fnCur = (typeof activeModalFocusFrame !== 'undefined' && activeModalFocusFrame !== null) ? Number(activeModalFocusFrame) : layFrameHienTai();
                for (const ot of currentAnnotations.tracks) {
                    if (!ot || (activeModalTrack && ot.id === activeModalTrack.id && ot._trackNumber === activeModalTrack._trackNumber)) continue;
                    if (window.khoDuyet.laDaDuyet(ot, fnCur, ot)) approvedCnt++;
                }
            }
            headerBtn.textContent = approvedCnt > 0 ? `🎯 Other Objects (${approvedCnt}✓)` : '🎯 Other Objects';
        }

        // Cập nhật trạng thái và vẽ lại View TOP ngay lập tức cho toàn bộ các hàng trong Modal
        document.querySelectorAll('.frame-detail-row').forEach(row => {
            row._showOtherObjects = modalShowOtherObjects;
            const cTop = row.querySelector('.canvas-top');
            if (cTop) {
                const fn = (cTop._frameNum !== undefined) ? cTop._frameNum : parseInt(row.id.replace('modal-row-frame-', ''), 10);
                taiVeCanvasTheoFrame(cTop, 'top', fn);
            }
        });

        if (!modalShowOtherObjects && modalEditAllObjects) {
            modalEditAllObjects = false;
            document.getElementById('modal-btn-edit-all-obj')?.classList.remove('is-active');
        }
        if (!silentToast) {
            hienToast(modalShowOtherObjects
                ? '👁️ Đã BẬT Other Objects (Double-click hoặc Ctrl+Click vào vật thể bất kỳ trên View TOP để chuyển sang Track đó)'
                : '👁️ Đã TẮT hiển thị các đối tượng khác (Chỉ xem đối tượng đang chọn)');
        }
    }

    /**
     * Lấy shape của track cho frameNum (tự động nội suy mượt mà giữa các keyframe nếu frame nằm giữa)
     */
    function layShapeChoFrame(track, frameNum) {
        if (!track || !track.shapes || track.shapes.length === 0) return null;
        const fn = Number(frameNum);
        if (isNaN(fn)) return null;

        // 1. Nếu có keyframe trùng khớp chính xác với frameNum
        const direct = track.shapes.find(s => Number(s.frame) === fn);
        if (direct) {
            return direct.outside ? null : direct;
        }

        // 2. Tìm keyframe trước đó gần nhất (prev) và keyframe sau đó gần nhất (next)
        let prev = null, next = null;
        for (const s of track.shapes) {
            if (!s || s.frame === undefined) continue;
            const sf = Number(s.frame);
            if (isNaN(sf)) continue;
            if (sf < fn) {
                if (!prev || sf > Number(prev.frame)) prev = s;
            } else if (sf > fn) {
                if (!next || sf < Number(next.frame)) next = s;
            }
        }

        // Trước keyframe đầu tiên: vật thể chưa xuất hiện trong scene
        if (!prev) return null;

        // Keyframe trước đó đã bị đánh dấu outside: vật thể đã biến mất
        if (prev.outside) return null;

        const p1 = prev.points;
        if (!p1 || p1.length < 9) return null;

        // Không có keyframe sau: duy trì vị trí của prev đến hết job
        if (!next) {
            return {
                frame: fn,
                points: [...p1],
                outside: false,
                attributes: prev.attributes ? JSON.parse(JSON.stringify(prev.attributes)) : []
            };
        }

        // Có keyframe tiếp theo: Kể cả khi next.outside === true, vật thể VẪN HOẠT ĐỘNG cho tới frame next - 1!
        const p2 = next.points;
        const hasValidP2 = p2 && p2.length >= 9 && (p2[6] > 0.05 || p2[7] > 0.05);

        // Nếu next không có tọa độ hộp hợp lệ: giữ nguyên tọa độ của prev
        if (!hasValidP2) {
            return {
                frame: fn,
                points: [...p1],
                outside: false,
                attributes: prev.attributes ? JSON.parse(JSON.stringify(prev.attributes)) : []
            };
        }

        // Nội suy mượt mà giữa prev và next
        const wrapAng = (a) => {
            if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.wrapToPi === 'function') {
                return window.thuatToanCanChinh.wrapToPi(a);
            }
            let r = a % (2 * Math.PI);
            if (r > Math.PI) r -= 2 * Math.PI;
            if (r < -Math.PI) r += 2 * Math.PI;
            return r;
        };

        const t = (fn - Number(prev.frame)) / (Number(next.frame) - Number(prev.frame));
        const dRz = wrapAng((p2[5] || 0) - (p1[5] || 0));
        const curL = (p2[6] && p2[6] > 0.05) ? (p1[6] + (p2[6] - p1[6]) * t) : (p1[6] || 4.5);
        const curW = (p2[7] && p2[7] > 0.05) ? (p1[7] + (p2[7] - p1[7]) * t) : (p1[7] || 1.9);
        const curH = (p2[8] && p2[8] > 0.05) ? (p1[8] + (p2[8] - p1[8]) * t) : (p1[8] || 1.6);

        const interPts = [
            p1[0] + (p2[0] - p1[0]) * t,
            p1[1] + (p2[1] - p1[1]) * t,
            p1[2] + (p2[2] - p1[2]) * t,
            (p1[3] || 0) + ((p2[3] || 0) - (p1[3] || 0)) * t,
            (p1[4] || 0) + ((p2[4] || 0) - (p1[4] || 0)) * t,
            wrapAng((p1[5] || 0) + dRz * t),
            curL,
            curW,
            curH
        ];

        return {
            frame: fn,
            points: interPts,
            outside: false,
            attributes: prev.attributes || next.attributes || []
        };
    }

    function laySurfaceDangBat() {
        const ts = (typeof window !== 'undefined') ? window.thuatToanSurface : null;
        return (ts && ts.isActive) ? ts : null;
    }

    function layBoxThamChieuSurface(fn, row) {
        if (!activeModalTrack) return (row && row._redInterpolatedBox) ? row._redInterpolatedBox : null;
        const numFn = Number(fn);
        let targetShape = Number.isFinite(numFn)
            ? (activeModalTrack.shapes || []).find(s => Number(s.frame) === numFn)
            : null;
        if (!targetShape && Number.isFinite(numFn) && typeof layShapeChoFrame === 'function') {
            targetShape = layShapeChoFrame(activeModalTrack, numFn);
        }
        let ref = (targetShape && targetShape.points && targetShape.points.length >= 9)
            ? targetShape.points
            : (row && row._redInterpolatedBox ? row._redInterpolatedBox : null);
        if (!ref && activeModalTrack.shapes) {
            const anyValid = activeModalTrack.shapes.find(s => s && s.points && s.points.length >= 9 && !s.outside);
            if (anyValid) ref = anyValid.points;
        }
        return ref;
    }

    function veCanvasTopView(canvas, L, W, H, points, offsetDu = 0, offsetDv = 0, isDragging = false, rotAngle = 0, frameNum = null, showOtherObjects = false) {
        if (Array.isArray(H)) {
            isDragging = offsetDv;
            offsetDv = offsetDu;
            offsetDu = points;
            points = H;
            H = 1.6;
        }
        H = (typeof H === 'number' && H > 0) ? H : 1.6;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        // [v2.5.1 SIÊU MƯỢT 120 FPS]: Dùng trực tiếp clientWidth/Height để tránh getBoundingClientRect() gây forced layout reflow mỗi frame
        const cssW = canvas.clientWidth || (canvas._cachedCssW || 360);
        const cssH = canvas.clientHeight || (canvas._cachedCssH || 200);
        canvas._cachedCssW = cssW;
        canvas._cachedCssH = cssH;

        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);

        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx.resetTransform) {
            ctx.resetTransform();
        } else {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.scale(dpr, dpr);

        const cw = cssW;
        const ch = cssH;

        // 1. NỀN ĐEN THUẦN TUÝ CHUẨN CVAT THREE.JS (#000000)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cw, ch);

        // Khung nhìn cố định: Base scale giữ nguyên không bị zoom giật khi kéo co giãn hộp
        const vs = (canvas && canvas._viewState) ? canvas._viewState : layViewStateCanvas(canvas, canvas?._frameNum, 'top');
        if (!vs.baseScale) {
            const refL = activeModalTrack?._refL || (typeof L === 'number' && L > 0 ? L : 4.4);
            const refW = activeModalTrack?._refW || (typeof W === 'number' && W > 0 ? W : 1.9);
            const refH = activeModalTrack?._refH || (typeof H === 'number' && H > 0 ? H : 1.6);
            vs.baseScale = tinhScaleCVAT('top', refL, refW, refH, cw, ch);
        }
        const S0 = vs.baseScale;
        const zoom = vs.zoom || 1.0;
        const S = S0 * zoom;
        const cx = cw / 2 + (vs.panX || 0);
        const cy = ch / 2 + (vs.panY || 0);

        const hl = L / 2;
        const hw = W / 2;
        const hh = H / 2;

        const viewPitch = vs.viewPitch || 0;
        const viewYaw = vs.viewYaw || 0;
        const is3D = (Math.abs(viewPitch) > 0.02 || Math.abs(viewYaw) > 0.02);

        const cosYaw = Math.cos(viewYaw);
        const sinYaw = Math.sin(viewYaw);
        const cosPitch = Math.cos(viewPitch);
        const sinPitch = Math.sin(viewPitch);

        // Hàm chiếu tọa độ cục bộ 3D (u: dài, v: rộng, w: cao) lên màn hình Canvas
        function project3D(u, v, w, du = 0, dv = 0) {
            const lu = u + du;
            const lv = v + dv;
            const lw = w;
            const u2 = cosYaw * lu - sinYaw * lv;
            const v2 = sinYaw * lu + cosYaw * lv;
            const w2 = lw;
            const xCam = u2;
            const yCam = (viewPitch !== 0) ? (v2 * cosPitch + w2 * sinPitch) : v2;
            return {
                x: cx + xCam * S,
                y: cy - yCam * S
            };
        }

        const fn = (frameNum !== null && frameNum !== undefined) ? frameNum : (canvas?._frameNum !== undefined ? canvas._frameNum : null);
        const row = (fn !== null) ? document.getElementById(`modal-row-frame-${fn}`) : (canvas ? canvas.closest('.frame-detail-row') : null);
        const isShowOther = (typeof modalShowOtherObjects !== 'undefined' && modalShowOtherObjects) || showOtherObjects || (row ? !!row._showOtherObjects : false);
        if (row && row._wideLiDARPoints && row._wideLiDARPoints.length > 0 && (!points || points === row._localLiDARPoints)) {
            points = row._wideLiDARPoints;
        }

        const fnTopSurf = (fn !== null && fn !== undefined) ? Number(fn) : (row ? Number(row.getAttribute('data-frame-num')) : NaN);
        if (canvas) canvas._surfTopProj = null;
        const surfTs = laySurfaceDangBat();
        const surfBox = (surfTs && Number.isFinite(fnTopSurf)) ? layBoxThamChieuSurface(fnTopSurf, row) : null;
        if (surfBox) {
            if (canvas) {
                canvas._surfTopProj = {
                    S, cx, cy, viewYaw, viewPitch, rotAngle,
                    box: [surfBox[0], surfBox[1], surfBox[2], surfBox[5] || 0, H]
                };
            }
            const cR = Math.cos(-rotAngle), sR = Math.sin(-rotAngle);
            try {
                surfTs.veLenCanvasTop(ctx, {
                    fn: fnTopSurf,
                    box: surfBox,
                    cw,
                    ch,
                    project: (u, v, w) => project3D(cR * u - sR * v, sR * u + cR * v, w, 0, 0)
                });
            } catch (e) { console.warn('[Surface] TOP:', e); }
        }

        // 2. LỚP NỀN TRONG SUỐT CỦA KHỐI HỘP KHI Ở GÓC NHÌN 2D
        if (!is3D) {
            const bx = cx + offsetDu * S;
            const by = cy - offsetDv * S;
            const pw = L * S;
            const ph = W * S;
            ctx.fillStyle = isDragging ? 'rgba(7, 65, 80, 0.40)' : 'rgba(5, 48, 58, 0.30)';
            ctx.fillRect(bx - pw / 2, by - ph / 2, pw, ph);
        }

        // 3. VẼ ĐÁM MÂY ĐIỂM LIDAR NỔI LÊN TRÊN (SIÊU TỐI ƯU HÓA 60-120 FPS GPU SKIA)
        let drawPts = (row && row._wideLiDARPoints && row._wideLiDARPoints.length > 0)
                      ? row._wideLiDARPoints
                      : (points || (row ? (row._localLiDARPoints || []) : []));

        let inBoxCount = 0;
        const cosRot = (rotAngle !== 0) ? Math.cos(-rotAngle) : 1;
        const sinRot = (rotAngle !== 0) ? Math.sin(-rotAngle) : 0;
        const basePtR = (typeof modalLiDARPointSize === 'number' && modalLiDARPointSize > 0) ? modalLiDARPointSize : 1.3;
        const inPtRadius = Math.max(0.6, Math.min(3.2, basePtR * Math.pow(zoom, 0.25)));
        const outPtRadius = inPtRadius;

        if (drawPts && drawPts.length > 0) {
            const maxW = 8.0;
            const minW = -8.0;
            const inD = Math.max(1, inPtRadius * 2);
            const outD = Math.max(1, outPtRadius * 2);

            // [v2.7.1 FIX TRIỆT ĐỂ MẤT ĐIỂM KHI XOAY]:
            // Giữ nguyên 100% mây điểm LiDAR sắc nét, hoàn toàn không nhảy hay biến mất điểm khi ấn giữ xoay
            const stride = 1;

            batDauThuThapDiemCanvas();

            for (let i = 0; i < drawPts.length; i += stride) {
                const pt = drawPts[i];
                const u = pt[0], v = pt[1], w = pt[2];

                if (w !== undefined && (w > maxW || w < minW)) continue;

                const ru = (rotAngle !== 0) ? (cosRot * u - sinRot * v) : u;
                const rv = (rotAngle !== 0) ? (sinRot * u + cosRot * v) : v;
                const rw = w || 0;

                // Chiếu theo góc xoay camera 3D (viewYaw, viewPitch)
                const u2 = (viewYaw !== 0) ? (cosYaw * ru - sinYaw * rv) : ru;
                const v2 = (viewYaw !== 0) ? (sinYaw * ru + cosYaw * rv) : rv;
                const w2 = rw;

                const xCam = u2;
                const yCam = (viewPitch !== 0) ? (v2 * cosPitch + w2 * sinPitch) : v2;

                const px = cx + xCam * S;
                const py = cy - yCam * S;

                if (px < -2 || px > cw + 2 || py < -2 || py > ch + 2) continue;

                const inside = (Math.abs(ru - offsetDu) <= hl && Math.abs(rv - offsetDv) <= hw && Math.abs(rw) <= hh + 0.3);
                const rawR = pt[3], rawG = pt[4], rawB = pt[5];

                if (inside) {
                    inBoxCount++;
                    themDiemTrongCanvas(px, py, w, hh, H, rawR, rawG, rawB);
                } else {
                    themDiemNgoaiCanvas(px, py, rawR, rawG, rawB);
                }
            }

            ketThucVeDiemCanvas(ctx, outPtRadius, outD, inPtRadius, inD);
        }

        if (surfBox) {
            const cR = Math.cos(-rotAngle), sR = Math.sin(-rotAngle);
            try {
                surfTs.veVienDongTamTop?.(ctx, {
                    fn: fnTopSurf,
                    box: surfBox,
                    cw,
                    ch,
                    skipJump: !!isDragging,
                    project: (u, v, w) => project3D(cR * u - sR * v, sR * u + cR * v, w, 0, 0)
                });
            } catch (e) {}
        }

        // 4. VẼ KHỐI HỘP BOUNDING BOX CỦA ĐỐI TƯỢNG ĐANG CHỌN (MÀU CYAN NEON NỔI BẬT #00f0ff)
        const redRadius = 6.0;
        const greenRadius = 5.0;

        if (is3D) {
            // Chiếu 8 đỉnh khối hộp vào không gian 3D
            const c_bfl = project3D(-hl, -hw, -hh, offsetDu, offsetDv);
            const c_bfr = project3D( hl, -hw, -hh, offsetDu, offsetDv);
            const c_bbr = project3D( hl,  hw, -hh, offsetDu, offsetDv);
            const c_bbl = project3D(-hl,  hw, -hh, offsetDu, offsetDv);

            const c_tfl = project3D(-hl, -hw,  hh, offsetDu, offsetDv);
            const c_tfr = project3D( hl, -hw,  hh, offsetDu, offsetDv);
            const c_tbr = project3D( hl,  hw,  hh, offsetDu, offsetDv);
            const c_tbl = project3D(-hl,  hw,  hh, offsetDu, offsetDv);

            // 1. Vẽ đáy hộp xe đang chọn (Cyan đậm #06b6d4)
            ctx.strokeStyle = '#06b6d4';
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            ctx.moveTo(c_bfl.x, c_bfl.y);
            ctx.lineTo(c_bfr.x, c_bfr.y);
            ctx.lineTo(c_bbr.x, c_bbr.y);
            ctx.lineTo(c_bbl.x, c_bbl.y);
            ctx.closePath();
            ctx.stroke();

            // 2. Vẽ 4 cột đứng nối đáy lên nóc (Cyan đậm #06b6d4)
            ctx.beginPath();
            ctx.moveTo(c_bfl.x, c_bfl.y); ctx.lineTo(c_tfl.x, c_tfl.y);
            ctx.moveTo(c_bfr.x, c_bfr.y); ctx.lineTo(c_tfr.x, c_tfr.y);
            ctx.moveTo(c_bbr.x, c_bbr.y); ctx.lineTo(c_tbr.x, c_tbr.y);
            ctx.moveTo(c_bbl.x, c_bbl.y); ctx.lineTo(c_tbl.x, c_tbl.y);
            ctx.stroke();

            // 3. Mặt nóc hộp (Cyan Neon rực rỡ #00f0ff)
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 2.2;
            ctx.beginPath();
            ctx.moveTo(c_tfl.x, c_tfl.y);
            ctx.lineTo(c_tfr.x, c_tfr.y);
            ctx.lineTo(c_tbr.x, c_tbr.y);
            ctx.lineTo(c_tbl.x, c_tbl.y);
            ctx.closePath();
            ctx.stroke();

            // Nền mặt nóc hộp trong suốt màu cyan
            ctx.fillStyle = isDragging ? 'rgba(6, 182, 212, 0.35)' : 'rgba(6, 182, 212, 0.22)';
            ctx.beginPath();
            ctx.moveTo(c_tfl.x, c_tfl.y);
            ctx.lineTo(c_tfr.x, c_tfr.y);
            ctx.lineTo(c_tbr.x, c_tbr.y);
            ctx.lineTo(c_tbl.x, c_tbl.y);
            ctx.closePath();
            ctx.fill();

            // 4. Mặt trước (đầu xe): màu Cyan Neon nổi bật
            ctx.fillStyle = 'rgba(0, 240, 255, 0.35)';
            ctx.beginPath();
            ctx.moveTo(c_tfr.x, c_tfr.y);
            ctx.lineTo(c_tbr.x, c_tbr.y);
            ctx.lineTo(c_bbr.x, c_bbr.y);
            ctx.lineTo(c_bfr.x, c_bfr.y);
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 2.4;
            ctx.stroke();

            // Vẽ trục tọa độ 3D từ tâm hộp
            const pCenter = project3D(0, 0, 0, offsetDu, offsetDv);
            const pAxisX = project3D(hl + 0.6, 0, 0, offsetDu, offsetDv);
            const pAxisY = project3D(0, hw + 0.6, 0, offsetDu, offsetDv);
            const pAxisZ = project3D(0, 0, hh + 0.6, offsetDu, offsetDv);
            veMuiTenTruc(ctx, pCenter.x, pCenter.y, pAxisX.x, pAxisX.y, '#ff0000', 2.0); // Trục X (Đỏ)
            veMuiTenTruc(ctx, pCenter.x, pCenter.y, pAxisY.x, pAxisY.y, '#00ff00', 2.0); // Trục Y (Xanh lá)
            veMuiTenTruc(ctx, pCenter.x, pCenter.y, pAxisZ.x, pAxisZ.y, '#38bdf8', 2.0); // Trục Z (Xanh lam)

            // 4 Chấm tròn đỏ 4 góc trên nóc hộp
            [c_tfl, c_tfr, c_tbr, c_tbl].forEach(c => {
                ctx.beginPath();
                ctx.arc(c.x, c.y, redRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#ff0000';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.stroke();
            });

            // Chấm tròn xanh lá chỉ hướng đầu xe (Đồng bộ 100% khoảng cách với 2D & Hit-Test)
            const rotOffsetM3D = Math.min(28, Math.max(12, 0.75 * S)) / Math.max(1e-3, S);
            const pRot = project3D(0, hw + rotOffsetM3D, hh, offsetDu, offsetDv);
            ctx.beginPath();
            ctx.arc(pRot.x, pRot.y, greenRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#33b864';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        } else {
            // GÓC NHÌN 2D TOP-DOWN CHUẨN CYAN NEON
            const bx = cx + offsetDu * S;
            const by = cy - offsetDv * S;
            const pw = L * S;
            const ph = W * S;

            ctx.fillStyle = isDragging ? 'rgba(6, 182, 212, 0.35)' : 'rgba(6, 182, 212, 0.22)';
            ctx.fillRect(bx - pw / 2, by - ph / 2, pw, ph);

            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 2.2;
            ctx.strokeRect(bx - pw / 2, by - ph / 2, pw, ph);

            // Viền mặt trước đầu xe
            ctx.strokeStyle = '#00f0ff';
            ctx.lineWidth = 3.0;
            ctx.beginPath();
            ctx.moveTo(bx + pw / 2, by - ph / 2);
            ctx.lineTo(bx + pw / 2, by + ph / 2);
            ctx.stroke();

            // Trục X (ĐỎ): hướng sang phải từ tâm xe ra ngoài mép
            veMuiTenTruc(ctx, bx, by, bx + pw / 2 + 28, by, '#ff0000', 2.0);
            // Trục Y (XANH LÁ): hướng lên trên từ tâm xe ra ngoài mép
            veMuiTenTruc(ctx, bx, by, bx, by - ph / 2 - 22, '#00ff00', 2.0);

            // 4 Chấm tròn đỏ 4 góc
            const corners = [
                { x: bx - pw / 2, y: by - ph / 2 },
                { x: bx + pw / 2, y: by - ph / 2 },
                { x: bx + pw / 2, y: by + ph / 2 },
                { x: bx - pw / 2, y: by + ph / 2 }
            ];
            corners.forEach(c => {
                ctx.beginPath();
                ctx.arc(c.x, c.y, redRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#ff0000';
                ctx.fill();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1;
                ctx.stroke();
            });

            // 1 Chấm tròn xanh lá chỉ hướng đầu xe
            const rotOffsetPx = Math.min(28, Math.max(12, 0.75 * S));
            const rotX = bx;
            const rotY = by - ph / 2 - rotOffsetPx;
            ctx.beginPath();
            ctx.arc(rotX, rotY, greenRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#33b864';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // 5. VẼ CÁC VẬT THỂ KHÁC (OTHER OBJECTS) TOÀN BỘ JOB TRONG CÙNG FRAME
        canvas._otherObjectsHitList = [];
        if (isShowOther && fn !== null && currentAnnotations && activeModalTrack) {
            let targetShape = (activeModalTrack.shapes || []).find(s => Number(s.frame) === Number(fn));
            if (!targetShape && typeof layShapeChoFrame === 'function') {
                targetShape = layShapeChoFrame(activeModalTrack, fn);
            }
            let refBasePts = (targetShape && targetShape.points && targetShape.points.length >= 9) 
                ? targetShape.points 
                : (row && row._redInterpolatedBox ? row._redInterpolatedBox : null);
            if (!refBasePts && activeModalTrack.shapes) {
                const anyValid = activeModalTrack.shapes.find(s => s && s.points && s.points.length >= 9 && !s.outside);
                if (anyValid) refBasePts = anyValid.points;
            }

            if (refBasePts) {
                const [tcx, tcy, tcz, , , trz] = refBasePts;
                const cosTrz = Math.cos(-(trz || 0));
                const sinTrz = Math.sin(-(trz || 0));

                function layBangMauOtherObject(trackObj, shapeObj) {
                    let clsName = '';
                    const lid = (trackObj && trackObj.label_id !== undefined) ? trackObj.label_id : (shapeObj ? shapeObj.label_id : undefined);
                    if (lid !== undefined && currentLabels && currentLabels[lid] && currentLabels[lid].name) {
                        clsName = String(currentLabels[lid].name).toLowerCase();
                    }
                    if (!clsName && trackObj && typeof xacDinhNhanTrack === 'function') {
                        clsName = String(xacDinhNhanTrack(trackObj, currentLabels) || '').toLowerCase();
                    }
                    if (!clsName && window.thuatToanCanChinh && typeof window.thuatToanCanChinh._lopNhan === 'function') {
                        clsName = String(window.thuatToanCanChinh._lopNhan('', trackObj || shapeObj) || '').toLowerCase();
                    }
                    if (!clsName && shapeObj && Array.isArray(shapeObj.points) && shapeObj.points.length >= 9) {
                        const oL = shapeObj.points[6] || 0;
                        if (oL > 2.2) clsName = 'vehicles';
                        else if (oL > 1.2) clsName = 'two-wheels';
                        else clsName = 'pedestrian';
                    }

                    // 1. Pedestrian (pedes): Xanh lá (#22c55e / #4ade80)
                    if (clsName.includes('pedes') || clsName.includes('person') || lid === 12872 || lid === 8661579) {
                        return {
                            stroke: '#22c55e',
                            fill: 'rgba(34, 197, 94, 0.18)',
                            frontStroke: '#4ade80',
                            frontFill: 'rgba(74, 222, 128, 0.35)',
                            arrowColor: '#4ade80',
                            labelColor: '#86efac'
                        };
                    }
                    // 2. Two-wheels (2wheel): Vàng (#eab308 / #fde047)
                    if (clsName.includes('two') || clsName.includes('wheel') || clsName.includes('moto') || clsName.includes('bike') || lid === 12873 || lid === 8661580) {
                        return {
                            stroke: '#eab308',
                            fill: 'rgba(234, 179, 8, 0.18)',
                            frontStroke: '#fde047',
                            frontFill: 'rgba(253, 224, 71, 0.34)',
                            arrowColor: '#fde047',
                            labelColor: '#fef08a'
                        };
                    }
                    // 3. Vehicles: Màu Cam đồng nhất (#f97316 / #fb923c) để tách biệt rõ với hộp đang chọn (màu Xanh dương/Cyan #00f0ff)
                    return {
                        stroke: '#f97316',
                        fill: 'rgba(249, 115, 22, 0.14)',
                        frontStroke: '#fb923c',
                        frontFill: 'rgba(249, 115, 22, 0.24)',
                        arrowColor: '#fb923c',
                        labelColor: '#fdba74'
                    };
                }

                function veNhanOther(ctx, item, lblX, lblY, pal, maxW, fontPx, daDuyet, hitEntry) {
                    if (!item || !item.label) return;
                    ctx.save();
                    ctx.font = `bold ${fontPx}px "Segoe UI", Arial, sans-serif`;
                    const lblW = Math.max(24, ctx.measureText(item.label).width || (item.label.length * 7));
                    const tickR = daDuyet ? Math.max(5.0, fontPx * 0.52) : 0;
                    const gap = daDuyet ? 4 : 0;
                    const totalHalfW = lblW * 0.5 + (daDuyet ? (gap + tickR) : 0);
                    if (hitEntry) {
                        hitEntry.labelRect = { x0: lblX - totalHalfW - 4, y0: lblY - 14, x1: lblX + totalHalfW + 4, y1: lblY + 2 };
                    }
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.lineWidth = 3.2;
                    ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
                    ctx.strokeText(item.label, lblX, lblY);
                    ctx.fillStyle = pal.labelColor;
                    ctx.fillText(item.label, lblX, lblY);

                    if (daDuyet) {
                        let tx = lblX + lblW * 0.5 + gap + tickR;
                        if (Number.isFinite(maxW) && tx + tickR + 2 > maxW) {
                            tx = lblX - lblW * 0.5 - gap - tickR;
                        }
                        const ty = lblY - fontPx * 0.45;
                        ctx.beginPath();
                        ctx.arc(tx, ty, tickR, 0, Math.PI * 2);
                        ctx.fillStyle = '#22c55e';
                        ctx.fill();
                        ctx.lineWidth = 1.2;
                        ctx.strokeStyle = '#052e16';
                        ctx.stroke();

                        ctx.beginPath();
                        ctx.moveTo(tx - tickR * 0.48, ty + tickR * 0.02);
                        ctx.lineTo(tx - tickR * 0.12, ty + tickR * 0.40);
                        ctx.lineTo(tx + tickR * 0.50, ty - tickR * 0.36);
                        ctx.strokeStyle = '#ffffff';
                        ctx.lineWidth = Math.max(1.6, tickR * 0.32);
                        ctx.lineCap = 'round';
                        ctx.lineJoin = 'round';
                        ctx.stroke();
                    }
                    ctx.restore();
                }

                let otherItems = modalOtherObjectsCache.get(fn);
                if (!otherItems) {
                    otherItems = [];
                    let allTracks = (currentAnnotations && Array.isArray(currentAnnotations.tracks)) ? [...currentAnnotations.tracks] : [];
                    if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTatCaTracksLiveTuRAM === 'function') {
                        const live = window.quanLyAPICVAT.layTatCaTracksLiveTuRAM();
                        if (Array.isArray(live) && live.length > 0) {
                            const existingIds = new Set(allTracks.map(t => t.id || t._trackNumber || t._clientID));
                            for (const lt of live) {
                                if (lt && !existingIds.has(lt.id) && !existingIds.has(lt._trackNumber) && !existingIds.has(lt._clientID)) {
                                    allTracks.push(lt);
                                }
                            }
                        }
                    }

                    // 1) Quét toàn bộ tracks
                    for (let idx = 0; idx < allTracks.length; idx++) {
                        const otherTr = allTracks[idx];
                        if (!otherTr) continue;
                        if (otherTr.id === activeModalTrack.id || (activeModalTrack._trackNumber && otherTr._trackNumber === activeModalTrack._trackNumber)) {
                            continue;
                        }
                        const otherShape = layShapeChoFrame(otherTr, fn);
                        if (!otherShape || otherShape.outside || !otherShape.points || otherShape.points.length < 9) continue;
                        const palette = layBangMauOtherObject(otherTr, otherShape);
                        const tidNum = otherTr._displayId || otherTr._trackNumber || otherTr._clientID || otherTr.clientID || otherTr.id || (idx + 1);
                        const tidText = `#${tidNum}`;
                        otherItems.push({ track: otherTr, trackId: tidNum, shape: otherShape, palette, label: tidText });
                    }

                    // 2) Quét thêm standalone shapes (nếu có)
                    if (Array.isArray(currentAnnotations.shapes)) {
                        for (const sh of currentAnnotations.shapes) {
                            if (!sh || Number(sh.frame) !== Number(fn) || sh.outside || !sh.points || sh.points.length < 9) continue;
                            const palette = layBangMauOtherObject(null, sh);
                            const tidText = `#${sh.id || 'obj'}`;
                            otherItems.push({ track: null, trackId: sh.id, shape: sh, palette, label: tidText });
                        }
                    }
                    modalOtherObjectsCache.set(fn, otherItems);
                }

                // Vẽ từng đối tượng khác theo bảng màu phân loại (Vehicles: Xanh dương - Cam, Pedestrian: Xanh lá, Two-wheels: Vàng)
                for (const item of otherItems) {
                    const pal = item.palette || layBangMauOtherObject(item.track, item.shape);
                    const [ox, oy, oz, , , orz, oL, oW, oH] = item.shape.points;
                    const dx = ox - tcx;
                    const dy = oy - tcy;
                    const dz = oz - tcz;

                    let relX = cosTrz * dx - sinTrz * dy;
                    let relY = sinTrz * dx + cosTrz * dy;
                    let relZ = dz;
                    let relYaw = (orz || 0) - (trz || 0);

                    // Khi người dùng đang xoay box chính (rotAngle !== 0), cả thế giới xoay quanh tâm xe chính
                    if (rotAngle !== 0) {
                        const rX = cosRot * relX - sinRot * relY;
                        const rY = sinRot * relX + cosRot * relY;
                        relX = rX;
                        relY = rY;
                        relYaw = relYaw - rotAngle;
                    }

                    const scrX = cx + relX * S;
                    const scrY = cy - relY * S;

                    const ohl = oL / 2;
                    const ohw = oW / 2;
                    const ohh = oH / 2;
                    const totalYawOnScreen = relYaw + (viewYaw || 0);

                    if (is3D) {
                        const cosRelYaw = Math.cos(relYaw);
                        const sinRelYaw = Math.sin(relYaw);

                        function projOtherPt(vx, vy, vz) {
                            const u_o = cosRelYaw * vx - sinRelYaw * vy;
                            const v_o = sinRelYaw * vx + cosRelYaw * vy;
                            const w_o = vz;
                            return project3D(relX + u_o, relY + v_o, relZ + w_o, 0, 0);
                        }

                        const p_bfl = projOtherPt(-ohl, -ohw, -ohh);
                        const p_bfr = projOtherPt( ohl, -ohw, -ohh);
                        const p_bbr = projOtherPt( ohl,  ohw, -ohh);
                        const p_bbl = projOtherPt(-ohl,  ohw, -ohh);

                        const p_tfl = projOtherPt(-ohl, -ohw,  ohh);
                        const p_tfr = projOtherPt( ohl, -ohw,  ohh);
                        const p_tbr = projOtherPt( ohl,  ohw,  ohh);
                        const p_tbl = projOtherPt(-ohl,  ohw,  ohh);

                        const minX = Math.min(p_bfl.x, p_bfr.x, p_bbr.x, p_bbl.x, p_tfl.x, p_tfr.x, p_tbr.x, p_tbl.x);
                        const maxX = Math.max(p_bfl.x, p_bfr.x, p_bbr.x, p_bbl.x, p_tfl.x, p_tfr.x, p_tbr.x, p_tbl.x);
                        const minY = Math.min(p_bfl.y, p_bfr.y, p_bbr.y, p_bbl.y, p_tfl.y, p_tfr.y, p_tbr.y, p_tbl.y);
                        const maxY = Math.max(p_bfl.y, p_bfr.y, p_bbr.y, p_bbl.y, p_tfl.y, p_tfr.y, p_tbr.y, p_tbl.y);
                        const margin = 200;
                        if (maxX < -margin || minX > cw + margin || maxY < -margin || minY > ch + margin) continue;

                        ctx.strokeStyle = pal.stroke;
                        ctx.lineWidth = 1.5;

                        // 1. Mặt dưới (đáy hộp)
                        ctx.beginPath();
                        ctx.moveTo(p_bfl.x, p_bfl.y);
                        ctx.lineTo(p_bfr.x, p_bfr.y);
                        ctx.lineTo(p_bbr.x, p_bbr.y);
                        ctx.lineTo(p_bbl.x, p_bbl.y);
                        ctx.closePath();
                        ctx.stroke();

                        // 2. 4 Cột đứng nối đáy lên nóc
                        ctx.beginPath();
                        ctx.moveTo(p_tfl.x, p_tfl.y); ctx.lineTo(p_bfl.x, p_bfl.y);
                        ctx.moveTo(p_tfr.x, p_tfr.y); ctx.lineTo(p_bfr.x, p_bfr.y);
                        ctx.moveTo(p_tbr.x, p_tbr.y); ctx.lineTo(p_bbr.x, p_bbr.y);
                        ctx.moveTo(p_tbl.x, p_tbl.y); ctx.lineTo(p_bbl.x, p_bbl.y);
                        ctx.stroke();

                        // 3. Mặt trên (nóc hộp xe khác)
                        ctx.beginPath();
                        ctx.moveTo(p_tfl.x, p_tfl.y);
                        ctx.lineTo(p_tfr.x, p_tfr.y);
                        ctx.lineTo(p_tbr.x, p_tbr.y);
                        ctx.lineTo(p_tbl.x, p_tbl.y);
                        ctx.closePath();
                        ctx.stroke();

                        ctx.fillStyle = pal.fill;
                        ctx.beginPath();
                        ctx.moveTo(p_tfl.x, p_tfl.y);
                        ctx.lineTo(p_tfr.x, p_tfr.y);
                        ctx.lineTo(p_tbr.x, p_tbr.y);
                        ctx.lineTo(p_tbl.x, p_tbl.y);
                        ctx.closePath();
                        ctx.fill();

                        // 4. Mặt trước (đầu xe khác - đối với vehicles là màu cam #f97316 kết hợp thân xanh dương #3b82f6)
                        ctx.fillStyle = pal.frontFill;
                        ctx.beginPath();
                        ctx.moveTo(p_tfr.x, p_tfr.y);
                        ctx.lineTo(p_tbr.x, p_tbr.y);
                        ctx.lineTo(p_bbr.x, p_bbr.y);
                        ctx.lineTo(p_bfr.x, p_bfr.y);
                        ctx.closePath();
                        ctx.fill();
                        ctx.strokeStyle = pal.frontStroke;
                        ctx.lineWidth = 2.0;
                        ctx.stroke();

                        // 5. Mũi tên chỉ hướng đầu xe khác
                        const p_head = projOtherPt(ohl + Math.min(0.8, 0.4 * oL), 0, ohh);
                        const p_center_top = projOtherPt(0, 0, ohh);
                        veMuiTenTruc(ctx, p_center_top.x, p_center_top.y, p_head.x, p_head.y, pal.arrowColor, 2.0);

                        // Khi bật Chỉnh Tất Cả: Vẽ 4 chấm đỏ góc & 1 chấm xanh xoay cho Other Object
                        if (modalEditAllObjects) {
                            const rDot = Math.max(3.2, Math.min(5.0, redRadius * 0.9));
                            [p_tfl, p_tfr, p_tbr, p_tbl].forEach(c => {
                                ctx.beginPath();
                                ctx.arc(c.x, c.y, rDot, 0, Math.PI * 2);
                                ctx.fillStyle = '#ff0000';
                                ctx.fill();
                                ctx.strokeStyle = '#fef08a';
                                ctx.lineWidth = 1;
                                ctx.stroke();
                            });
                            const rotOffM = Math.min(28, Math.max(12, 0.75 * S)) / Math.max(1e-3, S);
                            const p_rot_other = projOtherPt(0, ohw + rotOffM, ohh);
                            ctx.beginPath();
                            ctx.arc(p_rot_other.x, p_rot_other.y, Math.max(3.5, greenRadius * 0.9), 0, Math.PI * 2);
                            ctx.fillStyle = '#33b864';
                            ctx.fill();
                            ctx.strokeStyle = '#ffffff';
                            ctx.lineWidth = 1;
                            ctx.stroke();
                        }

                        // Lưu thông tin Hit-Test cho Chỉnh Tất Cả & Double-Click chuyển Track
                        const p_center_mid = projOtherPt(0, 0, 0);
                        const hull3D = baoLoi2D([p_bfl, p_bfr, p_bbr, p_bbl, p_tfl, p_tfr, p_tbr, p_tbl]);
                        const hitEntry3D = {
                            track: item.track,
                            trackId: item.trackId,
                            shape: item.shape,
                            label: item.label,
                            bx: p_center_top.x,
                            by: p_center_top.y,
                            midX: p_center_mid.x,
                            midY: p_center_mid.y,
                            L: oL,
                            W: oW,
                            H: oH,
                            S: S,
                            totalYaw: totalYawOnScreen,
                            viewPitch: viewPitch,
                            poly: hull3D,
                            areaPx: dienTichDaGiac(hull3D),
                            labelRect: null
                        };
                        canvas._otherObjectsHitList.push(hitEntry3D);

                        if (item.label) {
                            const topY = Math.min(p_tfl.y, p_tfr.y, p_tbr.y, p_tbl.y);
                            const lblX = (p_tfl.x + p_tfr.x + p_tbr.x + p_tbl.x) * 0.25;
                            const lblY = Math.max(13, topY - 4);
                            const daDuyet = Boolean(window.khoDuyet && window.khoDuyet.laDaDuyet(item.trackId, fn, item.track));
                            veNhanOther(ctx, item, lblX, lblY, pal, cw, 11, daDuyet, hitEntry3D);
                        }
                    } else {
                        // Vẽ 2D chuẩn orthographic
                        const maxExtent = Math.max(oL, oW) * S;
                        const margin = Math.max(200, maxExtent * 1.5);
                        if (scrX + maxExtent < -margin || scrX - maxExtent > cw + margin || scrY + maxExtent < -margin || scrY - maxExtent > ch + margin) continue;

                        ctx.save();
                        ctx.translate(scrX, scrY);
                        ctx.rotate(-relYaw);

                        const opw = oL * S;
                        const oph = oW * S;

                        ctx.fillStyle = pal.fill;
                        ctx.fillRect(-opw / 2, -oph / 2, opw, oph);

                        ctx.strokeStyle = pal.stroke;
                        ctx.lineWidth = 1.6;
                        ctx.strokeRect(-opw / 2, -oph / 2, opw, oph);

                        // Viền mặt trước đầu xe khác nổi bật (Cam #f97316 cho vehicles, Xanh lá sáng cho pedes, Vàng sáng cho 2wheel)
                        ctx.strokeStyle = pal.frontStroke;
                        ctx.lineWidth = 2.8;
                        ctx.beginPath();
                        ctx.moveTo(opw / 2, -oph / 2);
                        ctx.lineTo(opw / 2, oph / 2);
                        ctx.stroke();

                        // Mũi tên hướng đầu xe khác
                        veMuiTenTruc(ctx, 0, 0, opw / 2 + Math.min(18, 0.6 * S), 0, pal.arrowColor, 1.9);

                        // Khi bật Chỉnh Tất Cả: Vẽ 4 chấm đỏ góc & 1 chấm xanh xoay cho Other Object
                        if (modalEditAllObjects) {
                            const rDot = Math.max(3.2, Math.min(5.0, redRadius * 0.9));
                            const oCorners = [
                                { x: -opw / 2, y: -oph / 2 },
                                { x:  opw / 2, y: -oph / 2 },
                                { x:  opw / 2, y:  oph / 2 },
                                { x: -opw / 2, y:  oph / 2 }
                            ];
                            oCorners.forEach(c => {
                                ctx.beginPath();
                                ctx.arc(c.x, c.y, rDot, 0, Math.PI * 2);
                                ctx.fillStyle = '#ff0000';
                                ctx.fill();
                                ctx.strokeStyle = '#fef08a';
                                ctx.lineWidth = 1;
                                ctx.stroke();
                            });
                            const oRotOffsetPx = Math.min(28, Math.max(12, 0.75 * S));
                            ctx.beginPath();
                            ctx.arc(0, -oph / 2 - oRotOffsetPx, Math.max(3.5, greenRadius * 0.9), 0, Math.PI * 2);
                            ctx.fillStyle = '#33b864';
                            ctx.fill();
                            ctx.strokeStyle = '#ffffff';
                            ctx.lineWidth = 1;
                            ctx.stroke();
                        }

                        ctx.restore();

                        // Lưu thông tin Hit-Test cho Chỉnh Tất Cả & Double-Click chuyển Track
                        const cosR2 = Math.cos(-relYaw), sinR2 = Math.sin(-relYaw);
                        const rot2 = (lx, ly) => ({ x: scrX + lx * cosR2 - ly * sinR2, y: scrY + lx * sinR2 + ly * cosR2 });
                        const poly2D = [
                            rot2(-opw / 2, -oph / 2),
                            rot2( opw / 2, -oph / 2),
                            rot2( opw / 2,  oph / 2),
                            rot2(-opw / 2,  oph / 2)
                        ];
                        const hitEntry2D = {
                            track: item.track,
                            trackId: item.trackId,
                            shape: item.shape,
                            label: item.label,
                            bx: scrX,
                            by: scrY,
                            midX: scrX,
                            midY: scrY,
                            L: oL,
                            W: oW,
                            H: oH,
                            S: S,
                            totalYaw: totalYawOnScreen,
                            viewPitch: 0,
                            poly: poly2D,
                            areaPx: Math.max(1, opw * oph),
                            labelRect: null
                        };
                        canvas._otherObjectsHitList.push(hitEntry2D);

                        // Hiển thị ID của Other Object (+ dấu tích xanh nếu đã duyệt) phía trên khung hộp
                        if (item.label) {
                            const halfExtentY = Math.abs((oL * S * 0.5) * Math.sin(relYaw)) + Math.abs((oW * S * 0.5) * Math.cos(relYaw));
                            const lblX = scrX;
                            const lblY = Math.max(13, scrY - halfExtentY - 3);
                            const daDuyet = Boolean(window.khoDuyet && window.khoDuyet.laDaDuyet(item.trackId, fn, item.track));
                            veNhanOther(ctx, item, lblX, lblY, pal, cw, 11, daDuyet, hitEntry2D);
                        }
                    }
                }

                // 5.2. GỐC TỌA ĐỘ TOÀN CẢNH [0, 0, 0] CHUẨN CVAT THREE.JS (AXES HELPER TẠI TÂM LIDAR)
                // Cắm trực tiếp 3 trục tọa độ vào gốc (0, 0, 0) chuẩn xác 100% như màn hình CVAT Three.js (Trục X Đỏ, Trục Y Xanh lá, Trục Z Xanh lam)
                let targetRotMat = null;
                if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.eulerXYZToMatrix === 'function') {
                    targetRotMat = window.thuatToanCanChinh.eulerXYZToMatrix(refBasePts[3] || 0, refBasePts[4] || 0, trz || 0);
                }

                function chieuDiemToanCanh(gx, gy, gz) {
                    const dx = gx - tcx;
                    const dy = gy - tcy;
                    const dz = gz - tcz;
                    let u, v, w;
                    if (targetRotMat) {
                        u = dx * targetRotMat[0][0] + dy * targetRotMat[1][0] + dz * targetRotMat[2][0];
                        v = dx * targetRotMat[0][1] + dy * targetRotMat[1][1] + dz * targetRotMat[2][1];
                        w = dx * targetRotMat[0][2] + dy * targetRotMat[1][2] + dz * targetRotMat[2][2];
                    } else {
                        u = cosTrz * dx - sinTrz * dy;
                        v = sinTrz * dx + cosTrz * dy;
                        w = dz;
                    }
                    if (rotAngle !== 0) {
                        const ru = cosRot * u - sinRot * v;
                        const rv = sinRot * u + cosRot * v;
                        u = ru;
                        v = rv;
                    }
                    if (is3D) {
                        return project3D(u, v, w, 0, 0);
                    } else {
                        return {
                            x: cx + u * S,
                            y: cy - v * S
                        };
                    }
                }

                // Gốc tọa độ (0, 0, 0) và các đỉnh trục tọa độ toàn cảnh
                const pOrigin = chieuDiemToanCanh(0, 0, 0);
                const pAxisX = chieuDiemToanCanh(3.5, 0, 0);
                const pAxisY = chieuDiemToanCanh(0, 3.5, 0);
                const pAxisZ = is3D ? chieuDiemToanCanh(0, 0, 4.5) : null;

                const originMargin = 250;
                if (pOrigin.x >= -originMargin && pOrigin.x <= cw + originMargin && pOrigin.y >= -originMargin && pOrigin.y <= ch + originMargin) {
                    if (is3D) {
                        // 1. Trục Z (Xanh lam #38bdf8): Phóng thẳng đứng vút lên trời (+Z)
                        veMuiTenTruc(ctx, pOrigin.x, pOrigin.y, pAxisZ.x, pAxisZ.y, '#38bdf8', 2.4);

                        // 2. Trục X (Đỏ #ff0000): Phóng về phía trước (+X)
                        veMuiTenTruc(ctx, pOrigin.x, pOrigin.y, pAxisX.x, pAxisX.y, '#ff0000', 2.4);

                        // 3. Trục Y (Xanh lá #00ff00): Phóng sang mạn trái (+Y)
                        veMuiTenTruc(ctx, pOrigin.x, pOrigin.y, pAxisY.x, pAxisY.y, '#00ff00', 2.4);
                    } else {
                        // 2D Top-down orthographic
                        // Trục X (Đỏ): Hướng theo vector (+X)
                        veMuiTenTruc(ctx, pOrigin.x, pOrigin.y, pAxisX.x, pAxisX.y, '#ff0000', 2.2);

                        // Trục Y (Xanh lá): Hướng theo vector (+Y)
                        veMuiTenTruc(ctx, pOrigin.x, pOrigin.y, pAxisY.x, pAxisY.y, '#00ff00', 2.2);
                    }

                    // Chấm tròn tâm gốc tọa độ (0, 0, 0)
                    ctx.beginPath();
                    ctx.arc(pOrigin.x, pOrigin.y, 4.0, 0, Math.PI * 2);
                    ctx.fillStyle = '#ffffff';
                    ctx.fill();
                    ctx.strokeStyle = '#38bdf8';
                    ctx.lineWidth = 1.4;
                    ctx.stroke();


                }
            }
        }
    
        const INTERP_MODE_META = {
            A: { name: 'Quỹ đạo', short: 'A: Quỹ đạo', color: '#22d3ee', fill: 'rgba(34, 211, 238, 0.07)', head: '#22d3ee' },
            C: { name: '+ Mặt đường', short: 'C: +Mặt đường', color: '#c084fc', fill: 'rgba(192, 132, 252, 0.09)', head: '#c084fc' }
        };

        const layDanhSachHopVeNgoaiSuy = (rowEl) => {
            if (!rowEl || !rowEl._redInterpolatedBox) return [];
            const selMode = rowEl._interpSel || 'A';
            const cands = rowEl._interpCands || {};
            const selMeta = INTERP_MODE_META[selMode] || { name: 'Dự đoán' };
            const primary = {
                mode: selMode,
                box: rowEl._redInterpolatedBox,
                isPrimary: true,
                color: '#ef4444',
                fill: 'rgba(239, 68, 68, 0.22)',
                headColor: '#f87171',
                lineWidth: 2.3,
                dashed: false,
                labelTag: selMeta.name
            };
            const list = [];
            if (rowEl._interpShowAll) {
                const seen = [primary.box];
                for (const m of ['A', 'C']) {
                    if (m === selMode) continue;
                    const bx = cands[m];
                    if (!Array.isArray(bx) || bx.length < 9) continue;
                    const isDup = seen.some(sb => {
                        const d3 = Math.hypot(bx[0] - sb[0], bx[1] - sb[1], bx[2] - sb[2]);
                        const dyaw = Math.abs(Math.atan2(Math.sin((bx[5] || 0) - (sb[5] || 0)), Math.cos((bx[5] || 0) - (sb[5] || 0))));
                        return d3 < 0.015 && dyaw < 0.01;
                    });
                    if (isDup) continue;
                    seen.push(bx);
                    const mm = INTERP_MODE_META[m];
                    list.push({
                        mode: m,
                        box: bx,
                        isPrimary: false,
                        color: mm.color,
                        fill: mm.fill,
                        headColor: mm.head,
                        lineWidth: 1.5,
                        dashed: true,
                        labelTag: mm.short
                    });
                }
            }
            list.push(primary); // Vẽ khung đang chọn sau cùng để luôn nổi lên trên
            return list;
        };

        const tinhToaDoTuongDoiNgoaiSuy = (candBox, tShape) => {
            const [tcx, tcy, tcz, , , trz] = (tShape && tShape.points) ? tShape.points : [candBox[0], candBox[1], candBox[2], 0, 0, candBox[5]];
            const [rx, ry, rz, , , rrz, rL, rW, rH] = candBox;
            const dx = rx - tcx, dy = ry - tcy, dz = rz - tcz;
            const dist3D = Math.hypot(dx, dy, dz);
            const cosTrz = Math.cos(-(trz || 0)), sinTrz = Math.sin(-(trz || 0));
            return {
                relX: cosTrz * dx - sinTrz * dy,
                relY: sinTrz * dx + cosTrz * dy,
                relZ: dz,
                relYaw: (rrz || 0) - (trz || 0),
                rL, rW, rH, dist3D
            };
        };

        // 6. VẼ KHUNG ĐỎ NỘI SUY (PREDICTED INTERPOLATED CUBOID) & CÁC PHƯƠNG ÁN SO SÁNH
        const rowElemTop = (fn !== null) ? document.getElementById('modal-row-frame-' + fn) : (canvas ? canvas.closest('.frame-detail-row') : null);
        const hopNgoaiSuyTopList = layDanhSachHopVeNgoaiSuy(rowElemTop);
        if (hopNgoaiSuyTopList.length > 0) {
            const targetShape = (activeModalTrack && activeModalTrack.shapes) ? activeModalTrack.shapes.find(s => Number(s.frame) === Number(fn)) : null;
            for (const item of hopNgoaiSuyTopList) {
                const { relX, relY, relZ, relYaw, rL, rW, rH, dist3D } = tinhToaDoTuongDoiNgoaiSuy(item.box, targetShape);
                const r_hl = rL / 2, r_hw = rW / 2, r_hh = rH / 2;
                const lblTxt = item.isPrimary
                    ? (dist3D >= 0.15 ? `⚡ ${item.labelTag} (Δ${dist3D.toFixed(1)}m)` : `⚡ ${item.labelTag}`)
                    : item.labelTag;

                if (is3D) {
                    const cosRelYaw = Math.cos(relYaw), sinRelYaw = Math.sin(relYaw);
                    const projRedPt = (vx, vy, vz) => {
                        const u_o = cosRelYaw * vx - sinRelYaw * vy;
                        const v_o = sinRelYaw * vx + cosRelYaw * vy;
                        return project3D(relX + u_o, relY + v_o, relZ + vz, 0, 0);
                    };

                    const p_bfl = projRedPt(-r_hl, -r_hw, -r_hh), p_bfr = projRedPt(r_hl, -r_hw, -r_hh);
                    const p_bbr = projRedPt(r_hl, r_hw, -r_hh), p_bbl = projRedPt(-r_hl, r_hw, -r_hh);
                    const p_tfl = projRedPt(-r_hl, -r_hw, r_hh), p_tfr = projRedPt(r_hl, -r_hw, r_hh);
                    const p_tbr = projRedPt(r_hl, r_hw, r_hh), p_tbl = projRedPt(-r_hl, r_hw, r_hh);

                    ctx.save();
                    ctx.setLineDash([4, 3]);
                    ctx.strokeStyle = item.isPrimary ? 'rgba(239, 68, 68, 0.65)' : item.color;
                    ctx.globalAlpha = item.isPrimary ? 1.0 : 0.72;
                    ctx.lineWidth = item.isPrimary ? 1.4 : 1.0;
                    ctx.beginPath();
                    ctx.moveTo(p_bfl.x, p_bfl.y); ctx.lineTo(p_bfr.x, p_bfr.y);
                    ctx.lineTo(p_bbr.x, p_bbr.y); ctx.lineTo(p_bbl.x, p_bbl.y);
                    ctx.closePath();
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.moveTo(p_bfl.x, p_bfl.y); ctx.lineTo(p_tfl.x, p_tfl.y);
                    ctx.moveTo(p_bfr.x, p_bfr.y); ctx.lineTo(p_tfr.x, p_tfr.y);
                    ctx.moveTo(p_bbr.x, p_bbr.y); ctx.lineTo(p_tbr.x, p_tbr.y);
                    ctx.moveTo(p_bbl.x, p_bbl.y); ctx.lineTo(p_tbl.x, p_tbl.y);
                    ctx.stroke();

                    if (!item.dashed) ctx.setLineDash([]);
                    ctx.strokeStyle = item.color;
                    ctx.lineWidth = item.lineWidth;
                    ctx.beginPath();
                    ctx.moveTo(p_tfl.x, p_tfl.y); ctx.lineTo(p_tfr.x, p_tfr.y);
                    ctx.lineTo(p_tbr.x, p_tbr.y); ctx.lineTo(p_tbl.x, p_tbl.y);
                    ctx.closePath();
                    ctx.stroke();

                    ctx.fillStyle = item.fill;
                    ctx.fill();

                    if (item.isPrimary) {
                        ctx.strokeStyle = item.headColor;
                        ctx.lineWidth = 2.4;
                        ctx.beginPath();
                        ctx.moveTo(p_tfr.x, p_tfr.y); ctx.lineTo(p_tbr.x, p_tbr.y);
                        ctx.stroke();
                        const p_center_top = projRedPt(0, 0, r_hh);
                        const p_head = projRedPt(r_hl + Math.min(0.8, 0.4 * rL), 0, r_hh);
                        veMuiTenTruc(ctx, p_center_top.x, p_center_top.y, p_head.x, p_head.y, item.color, 2.0);
                    }

                    ctx.fillStyle = item.color;
                    ctx.font = item.isPrimary ? 'bold 11px sans-serif' : 'bold 9.5px sans-serif';
                    const yOff = item.isPrimary ? -4 : (item.mode === 'A' ? -16 : (item.mode === 'C' ? 12 : -26));
                    ctx.fillText(lblTxt, p_tfr.x + 4, p_tfr.y + yOff);
                    ctx.restore();
                } else {
                    const scrX = cx + relX * S, scrY = cy - relY * S;
                    const rpw = rL * S, rph = rW * S;
                    if (item.isPrimary && targetShape && targetShape.points && Math.hypot(scrX - cx, scrY - cy) > 8) {
                        ctx.save();
                        ctx.setLineDash([4, 3]);
                        ctx.strokeStyle = 'rgba(239, 68, 68, 0.80)';
                        ctx.lineWidth = 1.6;
                        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(scrX, scrY); ctx.stroke();
                        ctx.restore();
                    }
                    ctx.save();
                    ctx.translate(scrX, scrY);
                    ctx.rotate(-relYaw);
                    if (item.dashed) ctx.setLineDash([4, 3]);
                    ctx.fillStyle = item.fill;
                    ctx.fillRect(-rpw / 2, -rph / 2, rpw, rph);
                    ctx.strokeStyle = item.color;
                    ctx.lineWidth = item.lineWidth;
                    ctx.strokeRect(-rpw / 2, -rph / 2, rpw, rph);
                    if (item.isPrimary) veMuiTenTruc(ctx, 0, 0, rpw / 2 + Math.min(22, 0.7 * S), 0, item.color, 2.0);
                    ctx.restore();

                    ctx.save();
                    ctx.fillStyle = item.color;
                    ctx.font = item.isPrimary ? 'bold 11px sans-serif' : 'bold 9.5px sans-serif';
                    const yOff = item.isPrimary ? -6 : (item.mode === 'A' ? -18 : (item.mode === 'C' ? 12 : -28));
                    ctx.fillText(lblTxt, scrX - 25, scrY - rph / 2 + yOff);
                    ctx.restore();
                }
            }
        }

    }

    function veCanvasSideView(canvas, L, W, H, points, z = 0, offsetDu = 0, offsetDz = 0, isDragging = false, rotAngle = 0) {
        if (Array.isArray(z)) {
            isDragging = offsetDz;
            offsetDz = offsetDu;
            offsetDu = z;
            z = points;
            points = z;
        }
        H = (typeof H === 'number' && H > 0) ? H : 1.6;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = canvas.clientWidth || (canvas._cachedCssW || 360);
        const cssH = canvas.clientHeight || (canvas._cachedCssH || 200);
        canvas._cachedCssW = cssW;
        canvas._cachedCssH = cssH;

        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);

        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx.resetTransform) {
            ctx.resetTransform();
        } else {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.scale(dpr, dpr);

        const cw = cssW;
        const ch = cssH;

        // 1. NỀN ĐEN THUẦN TUÝ CHUẨN CVAT THREE.JS (#000000)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cw, ch);

        // Khung nhìn cố định: Base scale giữ nguyên không bị zoom giật khi kéo co giãn hộp
        const vs = (canvas && canvas._viewState) ? canvas._viewState : layViewStateCanvas(canvas, canvas?._frameNum, 'side');
        if (!vs.baseScale) {
            const refL = activeModalTrack?._refL || (typeof L === 'number' && L > 0 ? L : 4.4);
            const refW = activeModalTrack?._refW || (typeof W === 'number' && W > 0 ? W : 1.9);
            const refH = activeModalTrack?._refH || (typeof H === 'number' && H > 0 ? H : 1.6);
            vs.baseScale = tinhScaleCVAT('side', refL, refW, refH, cw, ch);
        }
        const S0 = vs.baseScale;
        const zoom = vs.zoom || 1.0;
        const S = S0 * zoom;
        const cx = cw / 2 + (vs.panX || 0);
        const cy = ch / 2 + (vs.panY || 0);

        const hl = L / 2;
        const hw = W / 2;
        const hh = H / 2;
        const bx = cx + offsetDu * S;
        const bz = cy - offsetDz * S;
        const pw = L * S;
        const ph = H * S;

        // Kiểm tra khung đỏ nội suy trên Side View để mở rộng lát cắt độ sâu LiDAR nếu cần
        const fnSide = (canvas && canvas._frameNum !== undefined) ? canvas._frameNum : null;
        const rowElemSide = (fnSide !== null) ? document.getElementById('modal-row-frame-' + fnSide) : (canvas ? canvas.closest('.frame-detail-row') : null);
        const redBoxSide = (rowElemSide && rowElemSide._redInterpolatedBox) ? rowElemSide._redInterpolatedBox : null;
        let redRelU = 0, redRelV = 0, redRelW = 0, rSideHL = 0, rSideHW = 0, rSideHH = 0;
        if (redBoxSide) {
            const targetShape = (activeModalTrack && activeModalTrack.shapes) ? activeModalTrack.shapes.find(s => Number(s.frame) === Number(fnSide)) : null;
            const [tcx, tcy, tcz, , , trz] = (targetShape && targetShape.points) ? targetShape.points : [redBoxSide[0], redBoxSide[1], redBoxSide[2], 0, 0, redBoxSide[5]];
            const [rx, ry, rz, , , , rL, rW, rH] = redBoxSide;
            const dx = rx - tcx, dy = ry - tcy, dz = rz - tcz;
            const cosTrz = Math.cos(-(trz || 0)), sinTrz = Math.sin(-(trz || 0));
            redRelU = cosTrz * dx - sinTrz * dy;
            redRelV = sinTrz * dx + cosTrz * dy;
            redRelW = dz;
            rSideHL = (rL || L) / 2;
            rSideHW = (rW || W) / 2;
            rSideHH = (rH || H) / 2;
        }

        const fnSideSurf = (fnSide !== null && fnSide !== undefined) ? Number(fnSide) : (rowElemSide ? Number(rowElemSide.getAttribute('data-frame-num')) : NaN);
        const surfTsS = laySurfaceDangBat();
        const surfBoxS = (surfTsS && Number.isFinite(fnSideSurf)) ? layBoxThamChieuSurface(fnSideSurf, rowElemSide) : null;
        if (surfBoxS) {
            const cR = Math.cos(-rotAngle), sR = Math.sin(-rotAngle);
            try {
                surfTsS.veLenCanvasCat(ctx, {
                    view: 'side',
                    fn: fnSideSurf,
                    box: surfBoxS,
                    S,
                    ch,
                    sMin: -cx / S - 1,
                    sMax: (cw - cx) / S + 1,
                    halfDepth: hw,
                    boxS: offsetDu,
                    boxBottomW: offsetDz - hh,
                    toPx: (u, v, w) => ({ x: cx + (cR * u - sR * w) * S, y: cy - (sR * u + cR * w) * S })
                });
            } catch (e) { console.warn('[Surface] SIDE:', e); }
        }

        // 2. LỚP NỀN TRONG SUỐT CỦA KHỐI HỘP NẰM DƯỚI ĐIỂM
        ctx.fillStyle = isDragging ? 'rgba(7, 65, 80, 0.40)' : 'rgba(5, 48, 58, 0.30)';
        ctx.fillRect(bx - pw / 2, bz - ph / 2, pw, ph);

        // 3. VẼ ĐÁM MÂY ĐIỂM LIDAR NỔI LÊN TRÊN (SÁNG RỰC RỠ)
        let inBoxCount = 0;
        const cosRot = (rotAngle !== 0) ? Math.cos(-rotAngle) : 1;
        const sinRot = (rotAngle !== 0) ? Math.sin(-rotAngle) : 0;
        const basePtR = (typeof modalLiDARPointSize === 'number' && modalLiDARPointSize > 0) ? modalLiDARPointSize : 1.3;
        const inPtRadius = Math.max(0.6, Math.min(3.2, basePtR * Math.pow(zoom, 0.25)));
        const outPtRadius = Math.max(0.5, Math.min(2.5, (basePtR * 0.8) * Math.pow(zoom, 0.25)));

        if (points && points.length > 0) {
            const maxSideDepth = hw + 0.30;
            const inD = Math.max(1, inPtRadius * 2);
            const outD = Math.max(1, outPtRadius * 2);

            ctx.fillStyle = 'rgba(215, 230, 245, 0.90)';
            ctx.beginPath();
            let hasDefaultOutside = false;
            const insidePtsToDraw = [];

            for (let i = 0; i < points.length; i++) {
                const pt = points[i];
                const u = pt[0], v = pt[1], w = pt[2];

                const inWhiteSlice = (v === undefined || Math.abs(v) <= maxSideDepth) &&
                                     (w === undefined || (w <= hh + 0.35 && w >= -hh - 0.50));
                const inRedSlice = redBoxSide ? (
                    (v === undefined || Math.abs(v - redRelV) <= rSideHW + 0.35) &&
                    (w === undefined || (w <= redRelW + rSideHH + 0.35 && w >= redRelW - rSideHH - 0.50))
                ) : false;
                if (!inWhiteSlice && !inRedSlice) continue;

                const ru = (rotAngle !== 0) ? (cosRot * u - sinRot * w) : u;
                const rw = (rotAngle !== 0) ? (sinRot * u + cosRot * w) : w;

                const px = cx + ru * S;
                const py = cy - rw * S;

                if (px < -2 || px > cw + 2 || py < -2 || py > ch + 2) continue;

                const insideWhite = (Math.abs(ru - offsetDu) <= hl && Math.abs(rw - offsetDz) <= hh && inWhiteSlice);
                const insideRed = redBoxSide ? (Math.abs(ru - redRelU) <= rSideHL && Math.abs(rw - redRelW) <= rSideHH && inRedSlice) : false;
                const inside = insideWhite || insideRed;
                let rawR = pt[3], rawG = pt[4], rawB = pt[5];

                if (inside) {
                    if (insideWhite) inBoxCount++;
                    themDiemTrongCanvas(px, py, w, hh, H, rawR, rawG, rawB);
                } else {
                    themDiemNgoaiCanvas(px, py, rawR, rawG, rawB);
                }
            }

            ketThucVeDiemCanvas(ctx, outPtRadius, outD, inPtRadius, inD);
        }

        // 4. VIỀN HỘP TRẮNG VÀ CÁC TAY CẦM
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0;
        ctx.strokeRect(bx - pw / 2, bz - ph / 2, pw, ph);

        // VẼ 2 TRỤC TỌA ĐỘ XE CHUẨN CVAT CUBOID ORIENTATION
        // Trục X (ĐỎ): hướng sang phải từ tâm xe ra ngoài mép
        veMuiTenTruc(ctx, bx, bz, bx + pw / 2 + 28, bz, '#ff0000', 2.0);
        // Trục Z (XANH LAM): hướng lên trên từ tâm xe ra ngoài nóc xe
        veMuiTenTruc(ctx, bx, bz, bx, bz - ph / 2 - 22, '#0088ff', 2.0);

        const redRadius = 6.0;
        const corners = [
            { x: bx - pw / 2, y: bz - ph / 2 },
            { x: bx + pw / 2, y: bz - ph / 2 },
            { x: bx + pw / 2, y: bz + ph / 2 },
            { x: bx - pw / 2, y: bz + ph / 2 }
        ];
        corners.forEach(c => {
            ctx.beginPath();
            ctx.arc(c.x, c.y, redRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ff0000';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Rotation helper chấm xanh lá trên nóc xe
        const greenRadius = 5.0;
        const rotOffsetPx = Math.min(28, Math.max(12, 0.75 * S));
        const rotX = bx;
        const rotY = bz - ph / 2 - rotOffsetPx;
        ctx.beginPath();
        ctx.arc(rotX, rotY, greenRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#33b864';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();


        // VẼ KHUNG ĐỎ NỘI SUY & CÁC PHƯƠNG ÁN SO SÁNH TRÊN SIDE VIEW
        if (rowElemSide && rowElemSide._redInterpolatedBox) {
            const targetShapeSide = (activeModalTrack && activeModalTrack.shapes) ? activeModalTrack.shapes.find(s => Number(s.frame) === Number(fnSide)) : null;
            veDanhSachKhungNgoaiSuy2D(ctx, rowElemSide, targetShapeSide, 'side', cx, cy, bx, bz, S, L, W, H);
        }

    }

function veCanvasFrontView(canvas, L, W, H, points, z = 0, offsetDv = 0, offsetDz = 0, isDragging = false, rotAngle = 0) {
        if (Array.isArray(z)) {
            isDragging = offsetDz;
            offsetDz = offsetDv;
            offsetDv = z;
            z = points;
            points = z;
        }
        H = (typeof H === 'number' && H > 0) ? H : 1.6;

        const dpr = Math.max(1, window.devicePixelRatio || 1);
        const cssW = canvas.clientWidth || (canvas._cachedCssW || 360);
        const cssH = canvas.clientHeight || (canvas._cachedCssH || 200);
        canvas._cachedCssW = cssW;
        canvas._cachedCssH = cssH;

        const targetW = Math.round(cssW * dpr);
        const targetH = Math.round(cssH * dpr);

        if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
        }

        const ctx = canvas.getContext('2d');
        if (ctx.resetTransform) {
            ctx.resetTransform();
        } else {
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
        ctx.scale(dpr, dpr);

        const cw = cssW;
        const ch = cssH;

        // 1. NỀN ĐEN THUẦN TUÝ CHUẨN CVAT THREE.JS (#000000)
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, cw, ch);

        // Khung nhìn cố định: Base scale giữ nguyên không bị zoom giật khi kéo co giãn hộp
        const vs = (canvas && canvas._viewState) ? canvas._viewState : layViewStateCanvas(canvas, canvas?._frameNum, 'front');
        if (!vs.baseScale) {
            const refL = activeModalTrack?._refL || (typeof L === 'number' && L > 0 ? L : 4.4);
            const refW = activeModalTrack?._refW || (typeof W === 'number' && W > 0 ? W : 1.9);
            const refH = activeModalTrack?._refH || (typeof H === 'number' && H > 0 ? H : 1.6);
            vs.baseScale = tinhScaleCVAT('front', refL, refW, refH, cw, ch);
        }
        const S0 = vs.baseScale;
        const zoom = vs.zoom || 1.0;
        const S = S0 * zoom;
        const cx = cw / 2 + (vs.panX || 0);
        const cy = ch / 2 + (vs.panY || 0);

        const hl = L / 2;
        const hw = W / 2;
        const hh = H / 2;
        // Chuẩn trục CVAT: Trục Y (ngang) sang PHẢI (dấu +), Trục Z (cao) lên TRÊN (dấu -)
        const bx = cx + offsetDv * S;
        const bz = cy - offsetDz * S;
        const pw = W * S;
        const ph = H * S;

        // Kiểm tra khung đỏ nội suy trên Front View để mở rộng lát cắt độ sâu LiDAR nếu cần
        const fnFront = (canvas && canvas._frameNum !== undefined) ? canvas._frameNum : null;
        const rowElemFront = (fnFront !== null) ? document.getElementById('modal-row-frame-' + fnFront) : (canvas ? canvas.closest('.frame-detail-row') : null);
        const redBoxFront = (rowElemFront && rowElemFront._redInterpolatedBox) ? rowElemFront._redInterpolatedBox : null;
        let redRelU = 0, redRelV = 0, redRelW = 0, rFrontHL = 0, rFrontHW = 0, rFrontHH = 0;
        if (redBoxFront) {
            const targetShape = (activeModalTrack && activeModalTrack.shapes) ? activeModalTrack.shapes.find(s => Number(s.frame) === Number(fnFront)) : null;
            const [tcx, tcy, tcz, , , trz] = (targetShape && targetShape.points) ? targetShape.points : [redBoxFront[0], redBoxFront[1], redBoxFront[2], 0, 0, redBoxFront[5]];
            const [rx, ry, rz, , , , rL, rW, rH] = redBoxFront;
            const dx = rx - tcx, dy = ry - tcy, dz = rz - tcz;
            const cosTrz = Math.cos(-(trz || 0)), sinTrz = Math.sin(-(trz || 0));
            redRelU = cosTrz * dx - sinTrz * dy;
            redRelV = sinTrz * dx + cosTrz * dy;
            redRelW = dz;
            rFrontHL = (rL || L) / 2;
            rFrontHW = (rW || W) / 2;
            rFrontHH = (rH || H) / 2;
        }

        const fnFrontSurf = (fnFront !== null && fnFront !== undefined) ? Number(fnFront) : (rowElemFront ? Number(rowElemFront.getAttribute('data-frame-num')) : NaN);
        const surfTsF = laySurfaceDangBat();
        const surfBoxF = (surfTsF && Number.isFinite(fnFrontSurf)) ? layBoxThamChieuSurface(fnFrontSurf, rowElemFront) : null;
        if (surfBoxF) {
            const cR = Math.cos(-rotAngle), sR = Math.sin(-rotAngle);
            try {
                surfTsF.veLenCanvasCat(ctx, {
                    view: 'front',
                    fn: fnFrontSurf,
                    box: surfBoxF,
                    S,
                    ch,
                    sMin: -cx / S - 1,
                    sMax: (cw - cx) / S + 1,
                    halfDepth: hl,
                    boxS: offsetDv,
                    boxBottomW: offsetDz - hh,
                    toPx: (u, v, w) => ({ x: cx + (cR * v - sR * w) * S, y: cy - (sR * v + cR * w) * S })
                });
            } catch (e) { console.warn('[Surface] FRONT:', e); }
        }

        // 2. LỚP NỀN TRONG SUỐT CỦA KHỐI HỘP NẰM DƯỚI ĐIỂM
        ctx.fillStyle = isDragging ? 'rgba(7, 65, 80, 0.40)' : 'rgba(5, 48, 58, 0.30)';
        ctx.fillRect(bx - pw / 2, bz - ph / 2, pw, ph);

        // 3. VẼ ĐÁM MÂY ĐIỂM LIDAR NỔI LÊN TRÊN (SÁNG RỰC RỠ)
        let inBoxCount = 0;
        const cosRot = (rotAngle !== 0) ? Math.cos(-rotAngle) : 1;
        const sinRot = (rotAngle !== 0) ? Math.sin(-rotAngle) : 0;
        const basePtR = (typeof modalLiDARPointSize === 'number' && modalLiDARPointSize > 0) ? modalLiDARPointSize : 1.3;
        const inPtRadius = Math.max(0.6, Math.min(3.2, basePtR * Math.pow(zoom, 0.25)));
        const outPtRadius = Math.max(0.5, Math.min(2.5, (basePtR * 0.8) * Math.pow(zoom, 0.25)));

        if (points && points.length > 0) {
            const maxFrontDepth = hl + 0.35;
            const inD = Math.max(1, inPtRadius * 2);
            const outD = Math.max(1, outPtRadius * 2);

            ctx.fillStyle = 'rgba(215, 230, 245, 0.90)';
            ctx.beginPath();
            let hasDefaultOutside = false;
            const insidePtsToDraw = [];

            for (let i = 0; i < points.length; i++) {
                const pt = points[i];
                const u = pt[0], v = pt[1], w = pt[2];

                const inWhiteSlice = (u === undefined || Math.abs(u) <= maxFrontDepth) &&
                                     (w === undefined || (w <= hh + 0.35 && w >= -hh - 0.50));
                const inRedSlice = redBoxFront ? (
                    (u === undefined || Math.abs(u - redRelU) <= rFrontHL + 0.35) &&
                    (w === undefined || (w <= redRelW + rFrontHH + 0.35 && w >= redRelW - rFrontHH - 0.50))
                ) : false;
                if (!inWhiteSlice && !inRedSlice) continue;

                const rv = (rotAngle !== 0) ? (cosRot * v - sinRot * w) : v;
                const rw = (rotAngle !== 0) ? (sinRot * v + cosRot * w) : w;

                // Chuẩn trục: rv sang phải (cx + rv * S)
                const px = cx + rv * S;
                const py = cy - rw * S;

                if (px < -2 || px > cw + 2 || py < -2 || py > ch + 2) continue;

                const insideWhite = (Math.abs(rv - offsetDv) <= hw && Math.abs(rw - offsetDz) <= hh && inWhiteSlice);
                const insideRed = redBoxFront ? (Math.abs(rv - redRelV) <= rFrontHW && Math.abs(rw - redRelW) <= rFrontHH && inRedSlice) : false;
                const inside = insideWhite || insideRed;
                let rawR = pt[3], rawG = pt[4], rawB = pt[5];

                if (inside) {
                    if (insideWhite) inBoxCount++;
                    themDiemTrongCanvas(px, py, w, hh, H, rawR, rawG, rawB);
                } else {
                    themDiemNgoaiCanvas(px, py, rawR, rawG, rawB);
                }
            }

            ketThucVeDiemCanvas(ctx, outPtRadius, outD, inPtRadius, inD);
        }

        // 4. VIỀN HỘP TRẮNG VÀ CÁC TAY CẦM
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.0;
        ctx.strokeRect(bx - pw / 2, bz - ph / 2, pw, ph);

        // VẼ 2 TRỤC TỌA ĐỘ XE CHUẨN CVAT CUBOID ORIENTATION
        // Trục Y (XANH LÁ): hướng sang phải từ tâm xe ra ngoài mép
        veMuiTenTruc(ctx, bx, bz, bx + pw / 2 + 28, bz, '#00ff00', 2.0);
        // Trục Z (XANH LAM): hướng lên trên từ tâm xe ra ngoài nóc xe
        veMuiTenTruc(ctx, bx, bz, bx, bz - ph / 2 - 22, '#0088ff', 2.0);

        const redRadius = 6.0;
        const corners = [
            { x: bx - pw / 2, y: bz - ph / 2 },
            { x: bx + pw / 2, y: bz - ph / 2 },
            { x: bx + pw / 2, y: bz + ph / 2 },
            { x: bx - pw / 2, y: bz + ph / 2 }
        ];
        corners.forEach(c => {
            ctx.beginPath();
            ctx.arc(c.x, c.y, redRadius, 0, Math.PI * 2);
            ctx.fillStyle = '#ff0000';
            ctx.fill();
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // 1 Chấm tròn xanh lá chỉ hướng nóc xe
        const greenRadius = 5.0;
        const rotOffsetPx = Math.min(28, Math.max(12, 0.75 * S));
        const rotX = bx;
        const rotY = bz - ph / 2 - rotOffsetPx;
        ctx.beginPath();
        ctx.arc(rotX, rotY, greenRadius, 0, Math.PI * 2);
        ctx.fillStyle = '#33b864';
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();


        // VẼ KHUNG ĐỎ NỘI SUY & CÁC PHƯƠNG ÁN SO SÁNH TRÊN FRONT VIEW
        if (rowElemFront && rowElemFront._redInterpolatedBox) {
            const targetShapeFront = (activeModalTrack && activeModalTrack.shapes) ? activeModalTrack.shapes.find(s => Number(s.frame) === Number(fnFront)) : null;
            veDanhSachKhungNgoaiSuy2D(ctx, rowElemFront, targetShapeFront, 'front', cx, cy, bx, bz, S, L, W, H);
        }
    }

    function veDanhSachKhungNgoaiSuy2D(ctx, rowEl, targetShape, viewMode, cx, cy, bx, bz, S, defL, defW, defH) {
        if (!rowEl || !rowEl._redInterpolatedBox) return;
        const metaMap = {
            A: { name: 'Quỹ đạo', short: 'A: Quỹ đạo', color: '#22d3ee', fill: 'rgba(34, 211, 238, 0.06)', head: '#22d3ee' },
            C: { name: '+ Mặt đường', short: 'C: +Mặt đường', color: '#c084fc', fill: 'rgba(192, 132, 252, 0.08)', head: '#c084fc' }
        };
        const selMode = rowEl._interpSel || 'A';
        const cands = rowEl._interpCands || {};
        const selM = metaMap[selMode] || { name: 'DỰ ĐOÁN' };
        const list = [];
        const primaryBox = rowEl._redInterpolatedBox;

        if (rowEl._interpShowAll) {
            const seen = [primaryBox];
            for (const m of ['A', 'C']) {
                if (m === selMode) continue;
                const cand = cands[m];
                if (!Array.isArray(cand) || cand.length < 9) continue;
                const isDup = seen.some(sb => Math.hypot(cand[0] - sb[0], cand[1] - sb[1], cand[2] - sb[2]) < 0.015);
                if (isDup) continue;
                seen.push(cand);
                const mm = metaMap[m];
                list.push({ mode: m, box: cand, isPrimary: false, color: mm.color, fill: mm.fill, headColor: mm.head, lineWidth: 1.5, dashed: true, labelTxt: mm.short });
            }
        }
        list.push({ mode: selMode, box: primaryBox, isPrimary: true, color: '#ef4444', fill: 'rgba(239, 68, 68, 0.22)', headColor: '#f87171', lineWidth: 2.2, dashed: false, labelTxt: `⚡ ${selM.name}` });

        for (const item of list) {
            const b = item.box;
            const [tcx, tcy, tcz, , , trz] = (targetShape && targetShape.points) ? targetShape.points : [b[0], b[1], b[2], 0, 0, b[5]];
            const dx = b[0] - tcx, dy = b[1] - tcy, dz = b[2] - tcz;
            const cosTrz = Math.cos(-(trz || 0)), sinTrz = Math.sin(-(trz || 0));
            const relU = cosTrz * dx - sinTrz * dy;
            const relV = sinTrz * dx + cosTrz * dy;
            const relW = dz;
            const horiz = viewMode === 'side' ? relU : relV;
            const dimH = viewMode === 'side' ? (b[6] || defL) : (b[7] || defW);
            const dimV = b[8] || defH;
            const px = cx + horiz * S;
            const pz = cy - relW * S;
            const rpw = dimH * S;
            const rph = dimV * S;

            if (item.isPrimary && Math.hypot(px - bx, pz - bz) > 8) {
                ctx.save();
                ctx.setLineDash([4, 3]);
                ctx.strokeStyle = 'rgba(239, 68, 68, 0.80)';
                ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(bx, bz); ctx.lineTo(px, pz); ctx.stroke();
                ctx.restore();
            }
            ctx.save();
            if (item.dashed) ctx.setLineDash([4, 3]);
            ctx.fillStyle = item.fill;
            ctx.fillRect(px - rpw / 2, pz - rph / 2, rpw, rph);
            ctx.strokeStyle = item.color;
            ctx.lineWidth = item.lineWidth;
            ctx.strokeRect(px - rpw / 2, pz - rph / 2, rpw, rph);
            if (item.isPrimary) {
                veMuiTenTruc(ctx, px, pz, px + rpw / 2 + 20, pz, item.color, 1.8);
                veMuiTenTruc(ctx, px, pz, px, pz - rph / 2 - 16, item.headColor, 1.8);
            }
            ctx.fillStyle = item.color;
            ctx.font = item.isPrimary ? 'bold 10px sans-serif' : 'bold 9px sans-serif';
            const yOff = item.isPrimary ? -4 : (item.mode === 'A' ? -15 : (item.mode === 'C' ? 11 : -25));
            ctx.fillText(item.labelTxt, px - rpw / 2, pz - rph / 2 + yOff);
            ctx.restore();
        }
    }


    function baoLoi2D(pts) {
        if (!Array.isArray(pts) || pts.length < 3) return pts || [];
        const sorted = pts
            .filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y))
            .slice()
            .sort((a, b) => (a.x - b.x) || (a.y - b.y));
        if (sorted.length < 3) return sorted;
        const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
        const lower = [];
        for (const p of sorted) {
            while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
            lower.push(p);
        }
        const upper = [];
        for (let i = sorted.length - 1; i >= 0; i--) {
            const p = sorted[i];
            while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
            upper.push(p);
        }
        lower.pop();
        upper.pop();
        return lower.concat(upper);
    }

    function dienTichDaGiac(poly) {
        if (!Array.isArray(poly) || poly.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            area += a.x * b.y - b.x * a.y;
        }
        return Math.abs(area) * 0.5;
    }

    function diemTrongDaGiac(px, py, poly) {
        if (!Array.isArray(poly) || poly.length < 3) return false;
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            const xi = poly[i].x, yi = poly[i].y;
            const xj = poly[j].x, yj = poly[j].y;
            const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    function khoangCachToiDaGiac(px, py, poly) {
        if (!Array.isArray(poly) || poly.length === 0) return Infinity;
        let minD = Infinity;
        for (let i = 0; i < poly.length; i++) {
            const a = poly[i];
            const b = poly[(i + 1) % poly.length];
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const len2 = abx * abx + aby * aby;
            let t = 0;
            if (len2 > 1e-9) {
                t = Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2));
            }
            const cx = a.x + t * abx;
            const cy = a.y + t * aby;
            const d = Math.hypot(px - cx, py - cy);
            if (d < minD) minD = d;
        }
        return minD;
    }

    function timVatTheTopTaiToaDo(canvas, mx, my, options = {}) {
        if (!canvas || !Array.isArray(canvas._otherObjectsHitList) || canvas._otherObjectsHitList.length === 0) return null;
        const padBase = Number.isFinite(options.padPx) ? options.padPx : 10;
        const allowLabel = options.allowLabel !== false;
        const cands = [];

        for (let i = canvas._otherObjectsHitList.length - 1; i >= 0; i--) {
            const it = canvas._otherObjectsHitList[i];
            if (!it || !it.trackId) continue;

            let inPoly = false;
            let distEdge = Infinity;
            let areaPx = it.areaPx || 0;

            if (Array.isArray(it.poly) && it.poly.length >= 3) {
                inPoly = diemTrongDaGiac(mx, my, it.poly);
                distEdge = inPoly ? 0 : khoangCachToiDaGiac(mx, my, it.poly);
                if (!areaPx) areaPx = dienTichDaGiac(it.poly);
            } else {
                const obx = it.bx, oby = it.by;
                const oS = it.S || 40;
                const opw = it.L * oS, oph = it.W * oS;
                const cosY = Math.cos(it.totalYaw || 0), sinY = Math.sin(it.totalYaw || 0);
                const relSX = mx - obx;
                const pitchScale = (it.viewPitch && Math.abs(it.viewPitch) > 0.02) ? Math.max(0.35, Math.cos(it.viewPitch)) : 1.0;
                const relSY = (oby - my) / pitchScale;
                const locX = cosY * relSX + sinY * relSY;
                const locY = -sinY * relSX + cosY * relSY;
                const dxOut = Math.max(0, Math.abs(locX) - opw * 0.5);
                const dyOut = Math.max(0, Math.abs(locY) - oph * 0.5);
                distEdge = Math.hypot(dxOut, dyOut);
                inPoly = (distEdge === 0);
                areaPx = Math.max(1, opw * oph);
            }

            const lr = it.labelRect;
            const inLabel = !!(allowLabel && lr && mx >= lr.x0 && mx <= lr.x1 && my >= lr.y0 && my <= lr.y1);

            // Xe 2 bánh / người đi bộ khi zoom xa rất mảnh -> mở rộng dung sai hit lên ít nhất 15px
            const isSmallObj = (areaPx > 0 && areaPx < 900) || (it.W && it.W <= 1.25);
            const effPad = isSmallObj ? Math.max(padBase, 15) : padBase;

            if (!inPoly && !inLabel && distEdge > effPad) continue;

            const tier = inPoly ? 0 : (inLabel ? 1 : 2);
            const cx = Number.isFinite(it.midX) ? it.midX : (it.bx || 0);
            const cy = Number.isFinite(it.midY) ? it.midY : (it.by || 0);
            const distCenter = Math.hypot(mx - cx, my - cy);

            cands.push({ it, tier, distEdge, areaPx: Math.max(1, areaPx), distCenter, idx: i });
        }

        if (cands.length === 0) return null;
        cands.sort((a, b) => {
            if (a.tier !== b.tier) return a.tier - b.tier;
            if (a.tier === 2 && Math.abs(a.distEdge - b.distEdge) > 3.0) {
                return a.distEdge - b.distEdge;
            }
            const bigArea = Math.max(a.areaPx, b.areaPx);
            const smallArea = Math.min(a.areaPx, b.areaPx);
            if (bigArea > smallArea * 1.8) {
                return a.areaPx - b.areaPx;
            }
            if (Math.abs(a.distCenter - b.distCenter) > 1e-3) {
                return a.distCenter - b.distCenter;
            }
            return b.idx - a.idx;
        });
        return cands[0].it;
    }

function layThongTinHandleCanvas(canvas, viewType, L, W, H, mouseX, mouseY, offsetDu = 0, offsetDv = 0, offsetDz = 0) {
        const rawMx = mouseX;
        const rawMy = mouseY;
        const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
        const cssW = (rect && rect.width > 50) ? Math.round(rect.width) : (canvas.clientWidth || 360);
        const cssH = (rect && rect.height > 50) ? Math.round(rect.height) : (canvas.clientHeight || 185);

        const vs = (canvas && canvas._viewState) ? canvas._viewState : layViewStateCanvas(canvas, canvas?._frameNum, viewType);
        if (!vs.baseScale) {
            const refL = activeModalTrack?._refL || (typeof L === 'number' && L > 0 ? L : 4.4);
            const refW = activeModalTrack?._refW || (typeof W === 'number' && W > 0 ? W : 1.9);
            const refH = activeModalTrack?._refH || (typeof H === 'number' && H > 0 ? H : 1.6);
            vs.baseScale = tinhScaleCVAT(viewType, refL, refW, refH, cssW, cssH);
        }
        const S0 = vs.baseScale;
        const zoom = vs.zoom || 1.0;
        const S = S0 * zoom;
        const cx = cssW / 2 + (vs.panX || 0);
        const cy = cssH / 2 + (vs.panY || 0);

        let bx = cx, by = cy, pw = 0, ph = 0;
        if (viewType === 'top') {
            bx = cx + offsetDu * S;
            by = cy - offsetDv * S;
            pw = L * S;
            ph = W * S;
        } else if (viewType === 'side') {
            bx = cx + offsetDu * S;
            by = cy - offsetDz * S;
            pw = L * S;
            ph = H * S;
        } else if (viewType === 'front') {
            bx = cx + offsetDv * S;
            by = cy - offsetDz * S;
            pw = W * S;
            ph = H * S;
        }

        // Nếu ở View TOP và đang xoay 3D (viewYaw / viewPitch), quy đổi tọa độ chuột ngược về hệ trục 2D của hộp
        if (viewType === 'top' && (Math.abs(vs.viewYaw || 0) > 0.02 || Math.abs(vs.viewPitch || 0) > 0.02)) {
            const vYaw = vs.viewYaw || 0;
            const vPitch = vs.viewPitch || 0;
            const pitchScale = (Math.abs(vPitch) > 0.02) ? Math.max(0.35, Math.cos(vPitch)) : 1;
            const cosVY = Math.cos(vYaw), sinVY = Math.sin(vYaw);
            const relScreenX = mouseX - bx;
            const relScreenY = (by - mouseY) / pitchScale;
            const localX = cosVY * relScreenX + sinVY * relScreenY;
            const localY = -sinVY * relScreenX + cosVY * relScreenY;
            mouseX = bx + localX;
            mouseY = by - localY;
        }

        // 1. Kiểm tra điểm tròn xoay màu xanh lá (Green Orientation Dot)
        const rotOffsetPx = Math.min(28, Math.max(12, 0.75 * S));
        const rotTipX = bx;
        const rotTipY = by - ph / 2 - rotOffsetPx;
        const distRot = Math.hypot(mouseX - rotTipX, mouseY - rotTipY);
        if (distRot <= 15) {
            return { type: 'rotate', cursor: 'grab', rotTipX, rotTipY, bx, by };
        }

        const xMin = bx - pw / 2;
        const xMax = bx + pw / 2;
        const yMin = by - ph / 2;
        const yMax = by + ph / 2;

        // [v2.3.8 FIX CO GIÃN HỘP] Bán kính bắt điểm mở rộng siêu nhạy theo hệ tọa độ CSS Pixels chuẩn 1:1
        const cornerTol = 15; // Bắt điểm 4 góc đỏ 2 chiều (15px)
        const edgeTol = 10;   // Bắt điểm 4 cạnh viền 1 chiều (10px)

        // 2. Kiểm tra 4 góc điều chỉnh kích thước 2 chiều (Corner Handles - ưu tiên cao nhất)
        if (Math.hypot(mouseX - xMin, mouseY - yMin) <= cornerTol) return { type: 'corner-nw', cursor: 'nwse-resize', bx, by };
        if (Math.hypot(mouseX - xMax, mouseY - yMin) <= cornerTol) return { type: 'corner-ne', cursor: 'nesw-resize', bx, by };
        if (Math.hypot(mouseX - xMax, mouseY - yMax) <= cornerTol) return { type: 'corner-se', cursor: 'nwse-resize', bx, by };
        if (Math.hypot(mouseX - xMin, mouseY - yMax) <= cornerTol) return { type: 'corner-sw', cursor: 'nesw-resize', bx, by };

        // 3. Kiểm tra 4 cạnh điều chỉnh kích thước từng chiều (Edge Handles - kéo 1 hướng)
        if (Math.abs(mouseX - xMin) <= edgeTol && mouseY >= (yMin - edgeTol) && mouseY <= (yMax + edgeTol)) {
            return { type: 'edge-left', cursor: 'ew-resize', bx, by };
        }
        if (Math.abs(mouseX - xMax) <= edgeTol && mouseY >= (yMin - edgeTol) && mouseY <= (yMax + edgeTol)) {
            return { type: 'edge-right', cursor: 'ew-resize', bx, by };
        }
        if (Math.abs(mouseY - yMin) <= edgeTol && mouseX >= (xMin - edgeTol) && mouseX <= (xMax + edgeTol)) {
            return { type: 'edge-top', cursor: 'ns-resize', bx, by };
        }
        if (Math.abs(mouseY - yMax) <= edgeTol && mouseX >= (xMin - edgeTol) && mouseX <= (xMax + edgeTol)) {
            return { type: 'edge-bottom', cursor: 'ns-resize', bx, by };
        }

        // 4. Kiểm tra di chuyển toàn bộ thân hộp (Move)
        // CHỈ khi con trỏ chuột nằm lọt bên trong ruột thân hộp (cách mép ít nhất edgeTol px)
        if (mouseX > (xMin + edgeTol) && mouseX < (xMax - edgeTol) && mouseY > (yMin + edgeTol) && mouseY < (yMax - edgeTol)) {
            return { type: 'move', cursor: 'move', bx, by };
        }

        // 5. [v2.7.6] KHI BẬT "CHỈNH TẤT CẢ" TRÊN VIEW TOP: KIỂM TRA HIT-TEST TRÊN TOÀN BỘ OTHER OBJECTS
        if (viewType === 'top' && modalEditAllObjects && Array.isArray(canvas._otherObjectsHitList) && canvas._otherObjectsHitList.length > 0) {
            for (let i = canvas._otherObjectsHitList.length - 1; i >= 0; i--) {
                const it = canvas._otherObjectsHitList[i];
                if (!it || !it.shape || !it.shape.points) continue;
                const obx = it.bx;
                const oby = it.by;
                const oS = it.S || S;
                const opw = it.L * oS;
                const oph = it.W * oS;
                const cosY = Math.cos(it.totalYaw || 0);
                const sinY = Math.sin(it.totalYaw || 0);
                const relSX = rawMx - obx;
                const pitchScale = (it.viewPitch && Math.abs(it.viewPitch) > 0.02) ? Math.max(0.35, Math.cos(it.viewPitch)) : 1.0;
                const relSY = (oby - rawMy) / pitchScale;

                const locX = cosY * relSX + sinY * relSY;
                const locY = -sinY * relSX + cosY * relSY;
                const mxO = obx + locX;
                const myO = oby - locY;

                const oRotOffsetPx = Math.min(28, Math.max(12, 0.75 * oS));
                const oRotTipX = obx;
                const oRotTipY = oby - oph / 2 - oRotOffsetPx;
                if (Math.hypot(mxO - oRotTipX, myO - oRotTipY) <= 14) {
                    return { type: 'rotate', cursor: 'grab', rotTipX: oRotTipX, rotTipY: oRotTipY, bx: obx, by: oby, otherItem: it };
                }

                const oxMin = obx - opw / 2, oxMax = obx + opw / 2;
                const oyMin = oby - oph / 2, oyMax = oby + oph / 2;
                const cTol = 13, eTol = 9;

                if (Math.hypot(mxO - oxMin, myO - oyMin) <= cTol) return { type: 'corner-nw', cursor: 'nwse-resize', bx: obx, by: oby, otherItem: it };
                if (Math.hypot(mxO - oxMax, myO - oyMin) <= cTol) return { type: 'corner-ne', cursor: 'nesw-resize', bx: obx, by: oby, otherItem: it };
                if (Math.hypot(mxO - oxMax, myO - oyMax) <= cTol) return { type: 'corner-se', cursor: 'nwse-resize', bx: obx, by: oby, otherItem: it };
                if (Math.hypot(mxO - oxMin, myO - oyMax) <= cTol) return { type: 'corner-sw', cursor: 'nesw-resize', bx: obx, by: oby, otherItem: it };

                if (Math.abs(mxO - oxMin) <= eTol && myO >= (oyMin - eTol) && myO <= (oyMax + eTol)) return { type: 'edge-left', cursor: 'ew-resize', bx: obx, by: oby, otherItem: it };
                if (Math.abs(mxO - oxMax) <= eTol && myO >= (oyMin - eTol) && myO <= (oyMax + eTol)) return { type: 'edge-right', cursor: 'ew-resize', bx: obx, by: oby, otherItem: it };
                if (Math.abs(myO - oyMin) <= eTol && mxO >= (oxMin - eTol) && mxO <= (oxMax + eTol)) return { type: 'edge-top', cursor: 'ns-resize', bx: obx, by: oby, otherItem: it };
                if (Math.abs(myO - oyMax) <= eTol && mxO >= (oxMin - eTol) && mxO <= (oxMax + eTol)) return { type: 'edge-bottom', cursor: 'ns-resize', bx: obx, by: oby, otherItem: it };

                if (mxO > (oxMin + eTol) && mxO < (oxMax - eTol) && myO > (oyMin + eTol) && myO < (oyMax - eTol)) {
                    return { type: 'move', cursor: 'move', bx: obx, by: oby, otherItem: it };
                }
            }
        }

        return null;
    }

    /**
     * Cập nhật con trỏ chuột thời gian thực khi di chuyển trên Canvas 2D
     */
    function capNhatConTroChuotCanvas(e, viewType, frameNum) {
        if (modalDragState || modalPanState || modalRotateViewState || !activeModalTrack) return;
        const canvas = e.currentTarget;
        const fnNum = Number(frameNum);
        const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fnNum);
        if (!sh || !sh.points) {
            canvas.style.cursor = 'crosshair';
            return;
        }
        const [, , , , , , L, W, H] = sh.points;
        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        if (viewType === 'top' && (e.ctrlKey || e.metaKey)) {
            const hoverOther = timVatTheTopTaiToaDo(canvas, mx, my, { padPx: 14 });
            if (hoverOther) {
                canvas.style.cursor = 'pointer';
                return;
            }
        }

        const hit = layThongTinHandleCanvas(canvas, viewType, L, W, H, mx, my);
        if (hit && hit.cursor) {
            canvas.style.cursor = hit.cursor;
        } else if (viewType === 'top' && timVatTheTopTaiToaDo(canvas, mx, my, { padPx: 12 })) {
            canvas.style.cursor = 'pointer';
        } else {
            canvas.style.cursor = 'crosshair';
        }
    }

    function batDauKeoCanvas(e, viewType, frameNum) {
        if (!activeModalTrack) return;
        const isRightClick = (e.button === 2);
        const isLeftClick = (e.button === 0);
        if (!isRightClick && !isLeftClick) return;

        const canvas = e.currentTarget;
        const fnNum = Number(frameNum);
        const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fnNum);
        if (!sh || !sh.points) return;

        // [v2.7.2 TỐI ƯU ZERO-LAG]: Bấm canvas chỉ đổi visual highlight trong modal, KHÔNG ép CVAT Three.js reload 3D hay cuộn scroll làm lệch toạ độ chuột
        if (Number(modalCurrentActiveFrame) !== fnNum) {
            nhayToiFrameModal(fnNum, false, false);
        }

        const [initX, initY, initZ, , , initRz, initL, initW, initH] = sh.points;

        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // Ctrl/Cmd + Click trên View TOP: chuyển ngay sang vật thể được click (mượt, không bị pan/drag cản)
        if (isLeftClick && viewType === 'top' && (e.ctrlKey || e.metaKey)) {
            const hitCtrlObj = timVatTheTopTaiToaDo(canvas, mx, my, { padPx: 15 });
            if (hitCtrlObj && hitCtrlObj.trackId) {
                e.preventDefault();
                e.stopPropagation();
                if (!hitCtrlObj.track) {
                    hienToast(`ℹ️ Vật thể #${hitCtrlObj.trackId} là Shape đơn lẻ (không phải Track chuỗi) nên không mở bảng Track!`);
                    return;
                }
                canvas._lastTopSwitchTs = Date.now();
                canvas._lastTopClickMeta = null;
                chuyenTrackGiuNguyenTopView(hitCtrlObj.trackId, fnNum, hitCtrlObj.shape);
                return;
            }
        }

        const hit = isLeftClick ? layThongTinHandleCanvas(canvas, viewType, initL, initW, initH, mx, my) : null;

        // 1. NHẤP CHUỘT PHẢI:
        // - Trên View TOP: Cho phép ấn giữ chuột phải để XOAY DỌC (Pitch 3D) và XOAY NGANG (Yaw 3D)
        // - Trên View SIDE / FRONT: Chuột phải dùng để Pan khung nhìn
        if (isRightClick) {
            if (viewType === 'top') {
                const vs = layViewStateCanvas(canvas, fnNum, viewType);
                vs._userInteracted = true;
                modalRotateViewState = {
                    canvas,
                    frameNum: fnNum,
                    viewType,
                    startX: e.clientX,
                    startY: e.clientY,
                    initPitch: vs.viewPitch || 0,
                    initYaw: vs.viewYaw || 0
                };
                canvas.style.cursor = 'grab';
                e.preventDefault();
                e.stopPropagation();
                return;
            } else {
                const vs = layViewStateCanvas(canvas, fnNum, viewType);
                modalPanState = {
                    canvas,
                    viewType,
                    frameNum: fnNum,
                    startX: e.clientX,
                    startY: e.clientY,
                    initPanX: vs.panX || 0,
                    initPanY: vs.panY || 0,
                    hasMoved: false,
                    rect
                };
                canvas.style.cursor = 'grabbing';
                e.preventDefault();
                e.stopPropagation();
                return;
            }
        }

        // 2. KÉO PAN KHUNG NHÌN: Khi nhấp chuột trái trên nền trống (hit === null)
        if (!hit) {
            const vs = layViewStateCanvas(canvas, fnNum, viewType);
            vs._userInteracted = true;
            modalPanState = {
                canvas,
                viewType,
                frameNum: fnNum,
                startX: e.clientX,
                startY: e.clientY,
                initPanX: vs.panX || 0,
                initPanY: vs.panY || 0,
                hasMoved: false,
                rect
            };
            canvas.style.cursor = 'grabbing';
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const mode = (hit.type === 'move') ? 'move' : ((hit.type === 'rotate') ? 'rotate' : 'resize');
        const handleType = hit.type;

        // [v2.7.6] NẾU NGƯỜI DÙNG ĐANG KÉO CHỈNH 1 OTHER OBJECT TRONG VIEW TOP (CHẾ ĐỘ CHỈNH TẤT CẢ)
        if (hit.otherItem && viewType === 'top') {
            const oItem = hit.otherItem;
            let existing = (oItem.track && Array.isArray(oItem.track.shapes))
                ? oItem.track.shapes.find(s => Number(s.frame) === fnNum)
                : null;
            const realOtherShape = existing || ((oItem.track && Array.isArray(oItem.track.shapes)) ? {
                type: 'cuboid',
                frame: fnNum,
                outside: false,
                occluded: false,
                points: [...oItem.shape.points],
                attributes: oItem.shape.attributes ? JSON.parse(JSON.stringify(oItem.shape.attributes)) : []
            } : oItem.shape);

            const oPts = [...realOtherShape.points];
            const vs = layViewStateCanvas(canvas, fnNum, viewType);
            const S0 = vs.baseScale || tinhScaleCVAT('top', initL, initW, initH, rect.width || 360, rect.height || 185);
            const S = S0 * (vs.zoom || 1.0);
            const oPitch = vs.viewPitch || 0;
            const oPitchScale = (Math.abs(oPitch) > 0.02) ? Math.max(0.35, Math.cos(oPitch)) : 1;

            modalDragState = {
                mode,
                handleType,
                canvas,
                viewType: 'top',
                sourceFrame: fnNum,
                targetFrames: [fnNum],
                editingOther: {
                    track: oItem.track,
                    trackId: oItem.trackId,
                    label: oItem.label,
                    shape: realOtherShape,
                    initPoints: oPts,
                    totalYaw: oItem.totalYaw || 0,
                    committedToTrack: !!existing,
                    hasMoved: false
                },
                sourceStartPoints: oPts,
                startX: e.clientX,
                startY: e.clientY,
                boxScreenX: rect.left + ((hit.bx !== undefined) ? hit.bx : ((rect.width || 360) / 2)),
                boxScreenY: rect.top + ((hit.by !== undefined) ? hit.by : ((rect.height || 185) / 2)),
                scale: S,
                pitchScale: oPitchScale,
                viewYaw: oItem.totalYaw || 0,
                viewPitch: oPitch,
                du: 0, dv: 0, dz: 0,
                dl: 0, dw: 0, dh: 0,
                dyaw: 0, dpitch: 0, droll: 0,
                curL: oPts[6], curW: oPts[7], curH: oPts[8],
                isDragging: true
            };
            document.body.classList.add('cvat-is-dragging');
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        const chk = document.querySelector(`.chk-frame-row[data-frame="${fnNum}"]`);
        const isChecked = chk ? chk.checked : true;

        let targetFrames = [];
        if (isChecked) {
            document.querySelectorAll('.chk-frame-row:checked').forEach(c => {
                const parsedFn = parseInt(c.getAttribute('data-frame'), 10);
                if (!isNaN(parsedFn) && !targetFrames.includes(parsedFn)) targetFrames.push(parsedFn);
            });
            if (!targetFrames.includes(fnNum)) targetFrames.push(fnNum);
        } else {
            targetFrames = [fnNum];
        }

        const startPointsMap = new Map();
        for (const fn of targetFrames) {
            const s = activeModalTrack.shapes.find(item => Number(item.frame) === Number(fn));
            if (s && s.points) {
                startPointsMap.set(Number(fn), [...s.points]);
            }
        }

        const cssW = (rect && rect.width > 50) ? Math.round(rect.width) : (canvas.clientWidth || 360);
        const cssH = (rect && rect.height > 50) ? Math.round(rect.height) : (canvas.clientHeight || 185);
        const vs = layViewStateCanvas(canvas, fnNum, viewType);
        if (!vs.baseScale) {
            const refL = activeModalTrack?._refL || (typeof initL === 'number' && initL > 0 ? initL : 4.4);
            const refW = activeModalTrack?._refW || (typeof initW === 'number' && initW > 0 ? initW : 1.9);
            const refH = activeModalTrack?._refH || (typeof initH === 'number' && initH > 0 ? initH : 1.6);
            vs.baseScale = tinhScaleCVAT(viewType, refL, refW, refH, cssW, cssH);
        }
        const S0 = vs.baseScale;
        const S = S0 * (vs.zoom || 1.0);
        const vPitch = vs.viewPitch || 0;
        const pitchScale = (viewType === 'top' && Math.abs(vPitch) > 0.02) ? Math.max(0.35, Math.cos(vPitch)) : 1;

        const boxScreenX = rect.left + ((hit.bx !== undefined) ? hit.bx : (cssW / 2));
        const boxScreenY = rect.top + ((hit.by !== undefined) ? hit.by : (cssH / 2));

        modalDragState = {
            mode,
            handleType,
            viewType,
            sourceFrame: fnNum,
            targetFrames,
            startPointsMap,
            sourceStartPoints: [...sh.points],
            startX: e.clientX,
            startY: e.clientY,
            boxScreenX,
            boxScreenY,
            scale: S,
            pitchScale,
            viewYaw: vs.viewYaw || 0,
            viewPitch: vPitch,
            du: 0,
            dv: 0,
            dz: 0,
            dl: 0,
            dw: 0,
            dh: 0,
            dyaw: 0,
            dpitch: 0,
            droll: 0,
            curL: initL,
            curW: initW,
            curH: initH,
            isDragging: true
        };

        document.body.classList.add('cvat-is-dragging');
        e.preventDefault();
        e.stopPropagation();
    }

    /**
     * XỬ LÝ KÉO CHUỘT (MOUSEMOVE): ZERO-LAG MULTI-FRAME SYNC
     * Trong suốt quá trình rê chuột: CHỈ render duy nhất hàng đang kéo!
     * 59 frames còn lại không di chuyển 1nm nào, triệt tiêu hoàn toàn giật lag!
     */
    let modalRotateViewState = null;
    let modalRotateRafPending = false;

    function xuLyKeoChuot(e) {
        if (modalRotateViewState) {
            const dx = e.clientX - modalRotateViewState.startX;
            const dy = e.clientY - modalRotateViewState.startY;
            const vs = layViewStateCanvas(modalRotateViewState.canvas, modalRotateViewState.frameNum, 'top');

            // Kéo chuột mượt mà, đầm tay, chuẩn CAD / 3D Viewer
            const dPitch = -dy * 0.0065;
            const dYaw = dx * 0.0065;

            vs.viewPitch = Math.max(-1.4, Math.min(1.4, modalRotateViewState.initPitch + dPitch));
            vs.viewYaw = modalRotateViewState.initYaw + dYaw;

            if (!modalRotateRafPending) {
                modalRotateRafPending = true;
                requestAnimationFrame(() => {
                    modalRotateRafPending = false;
                    if (modalRotateViewState) {
                        taiVeCanvasTheoFrame(modalRotateViewState.canvas, 'top', modalRotateViewState.frameNum);
                    }
                });
            }
            return;
        }

        if (modalPanState) {
            const dxPx = e.clientX - modalPanState.startX;
            const dyPx = e.clientY - modalPanState.startY;
            if (!modalPanState.hasMoved) {
                if (Math.hypot(dxPx, dyPx) < 4) return;
                modalPanState.hasMoved = true;
            }
            const vs = layViewStateCanvas(modalPanState.canvas, modalPanState.frameNum, modalPanState.viewType);
            if (vs) vs._userInteracted = true;

            vs.panX = modalPanState.initPanX + dxPx;
            vs.panY = modalPanState.initPanY + dyPx;

            if (!modalPanRafPending) {
                modalPanRafPending = true;
                requestAnimationFrame(() => {
                    modalPanRafPending = false;
                    if (modalPanState) {
                        taiVeCanvasTheoFrame(modalPanState.canvas, modalPanState.viewType, modalPanState.frameNum);
                    }
                });
            }
            return;
        }

        if (!modalDragState || !modalDragState.isDragging || !activeModalTrack) return;

        const dxPx = e.clientX - modalDragState.startX;
        const dyPx = e.clientY - modalDragState.startY;
        if (modalDragState.editingOther && !modalDragState.editingOther.hasMoved && Math.hypot(dxPx, dyPx) < 4) {
            return;
        }
        const S = modalDragState.scale;

        const { mode, handleType, viewType, sourceStartPoints } = modalDragState;
        const [initX, initY, initZ, initRx, initRy, initRz, initL, initW, initH] = sourceStartPoints;

        const dxM = dxPx / S;
        const dyM = -dyPx / S;

        let du = 0, dv = 0, dz = 0;
        let dl = 0, dw = 0, dh = 0;
        let dyaw = 0, dpitch = 0, droll = 0;
        let curL = initL, curW = initW, curH = initH;

        if (mode === 'rotate') {
            const { boxScreenX, boxScreenY, startX, startY } = modalDragState;
            const startAngle = Math.atan2(startY - boxScreenY, startX - boxScreenX);
            const curAngle = Math.atan2(e.clientY - boxScreenY, e.clientX - boxScreenX);
            const dAngle = -(curAngle - startAngle);

            if (viewType === 'top') {
                dyaw = dAngle;
            } else if (viewType === 'side') {
                dpitch = dAngle;
            } else if (viewType === 'front') {
                droll = dAngle;
            }
        } else if (mode === 'resize') {
            const isRight = (handleType === 'edge-right' || handleType === 'corner-ne' || handleType === 'corner-se' || handleType === 'resize-ne' || handleType === 'resize-se');
            const isLeft = (handleType === 'edge-left' || handleType === 'corner-nw' || handleType === 'corner-sw' || handleType === 'resize-nw' || handleType === 'resize-sw');
            const isTop = (handleType === 'edge-top' || handleType === 'corner-ne' || handleType === 'corner-nw' || handleType === 'resize-ne' || handleType === 'resize-nw');
            const isBottom = (handleType === 'edge-bottom' || handleType === 'corner-se' || handleType === 'corner-sw' || handleType === 'resize-se' || handleType === 'resize-sw');

            if (viewType === 'top') {
                const vYaw = modalDragState.viewYaw || 0;
                const effDyM = dyM / (modalDragState.pitchScale || 1);
                const cosVY = Math.cos(vYaw), sinVY = Math.sin(vYaw);
                const locDx = cosVY * dxM + sinVY * effDyM;
                const locDy = -sinVY * dxM + cosVY * effDyM;
                if (isRight) dl = locDx;
                if (isLeft) dl = -locDx;
                if (isTop) dw = locDy;
                if (isBottom) dw = -locDy;
            } else if (viewType === 'side') {
                if (isRight) dl = dxM;
                if (isLeft) dl = -dxM;
                if (isTop) dh = dyM;
                if (isBottom) dh = -dyM;
            } else if (viewType === 'front') {
                if (isRight) dw = dxM;
                if (isLeft) dw = -dxM;
                if (isTop) dh = dyM;
                if (isBottom) dh = -dyM;
            }
            curL = Math.max(0.2, initL + dl);
            curW = Math.max(0.2, initW + dw);
            curH = Math.max(0.2, initH + dh);
            dl = curL - initL;
            dw = curW - initW;
            dh = curH - initH;

            if (viewType === 'top') {
                du = isRight ? dl / 2 : (isLeft ? -dl / 2 : 0);
                dv = isTop ? dw / 2 : (isBottom ? -dw / 2 : 0);
            } else if (viewType === 'side') {
                du = isRight ? dl / 2 : (isLeft ? -dl / 2 : 0);
                dz = isTop ? dh / 2 : (isBottom ? -dh / 2 : 0);
            } else if (viewType === 'front') {
                dv = isRight ? dw / 2 : (isLeft ? -dw / 2 : 0);
                dz = isTop ? dh / 2 : (isBottom ? -dh / 2 : 0);
            }

            // Cập nhật giá trị hiển thị thời gian thực lên 3 ô input kích thước modal
            const liveInpL = document.getElementById('modal-inp-size-L');
            const liveInpW = document.getElementById('modal-inp-size-W');
            const liveInpH = document.getElementById('modal-inp-size-H');
            if (liveInpL) liveInpL.value = curL.toFixed(2);
            if (liveInpW) liveInpW.value = curW.toFixed(2);
            if (liveInpH) liveInpH.value = curH.toFixed(2);
        } else {
            // mode === 'move'
            if (viewType === 'top') {
                const vYaw = modalDragState.viewYaw || 0;
                const effDyM = dyM / (modalDragState.pitchScale || 1);
                const cosVY = Math.cos(vYaw), sinVY = Math.sin(vYaw);
                du = cosVY * dxM + sinVY * effDyM;
                dv = -sinVY * dxM + cosVY * effDyM;
                dz = 0;
            } else if (viewType === 'side') {
                du = dxM;
                dv = 0;
                dz = dyM;
            } else if (viewType === 'front') {
                du = 0;
                dv = dxM;
                dz = dyM;
            }
        }

        modalDragState.du = du;
        modalDragState.dv = dv;
        modalDragState.dz = dz;
        modalDragState.dl = dl;
        modalDragState.dw = dw;
        modalDragState.dh = dh;
        modalDragState.dyaw = dyaw;
        modalDragState.dpitch = dpitch;
        modalDragState.droll = droll;
        modalDragState.curL = curL;
        modalDragState.curW = curW;
        modalDragState.curH = curH;

        // [v2.3.4] Đã loại bỏ hoàn toàn banner text khi kéo chuột theo yêu cầu

        // ĐIỀU TỐC THỜI GIAN THỰC 60 FPS: CHỈ RENDER HÀNG ĐANG KÉO (ZERO LAG)
        if (!modalDragRafPending) {
            modalDragRafPending = true;
            modalDragRafId = requestAnimationFrame(() => {
                modalDragRafPending = false;
                modalDragRafId = 0;
                if (!modalDragState || !modalDragState.isDragging || !activeModalTrack) return;

                const curDu = modalDragState.du;
                const curDv = modalDragState.dv;
                const curDz = modalDragState.dz;
                const curDyaw = modalDragState.dyaw || 0;
                const curDpitch = modalDragState.dpitch || 0;
                const curDroll = modalDragState.droll || 0;
                const L = modalDragState.curL;
                const W = modalDragState.curW;
                const H = modalDragState.curH;

                // [v2.7.6] NẾU ĐANG KÉO CHỈNH TRỰC TIẾP OTHER OBJECT TRÊN VIEW TOP
                if (modalDragState.editingOther) {
                    const eo = modalDragState.editingOther;
                    const fn = Number(modalDragState.sourceFrame);
                    const [ox0, oy0, oz0, orx0, ory0, orz0, oL0, oW0, oH0] = eo.initPoints;
                    const movedEnough = Math.hypot(curDu, curDv) > 0.002 || Math.abs(curDyaw) > 0.0005 || Math.abs(L - oL0) > 0.003 || Math.abs(W - oW0) > 0.003 || Math.abs(H - oH0) > 0.003;
                    if (!eo.hasMoved && movedEnough) {
                        eo.hasMoved = true;
                        if (eo.track) {
                            luuUndoSnapshotOtherTrack(eo.track);
                            if (!eo.committedToTrack && Array.isArray(eo.track.shapes)) {
                                eo.track.shapes.push(eo.shape);
                                eo.track.shapes.sort((a, b) => a.frame - b.frame);
                                eo.committedToTrack = true;
                            }
                        }
                    }
                    if (!eo.hasMoved) return;
                    const newOrz = window.thuatToanCanChinh ? window.thuatToanCanChinh.wrapToPi(orz0 + curDyaw) : (orz0 + curDyaw);
                    const cosOrz = Math.cos(orz0), sinOrz = Math.sin(orz0);
                    eo.shape.points[0] = ox0 + (cosOrz * curDu - sinOrz * curDv);
                    eo.shape.points[1] = oy0 + (sinOrz * curDu + cosOrz * curDv);
                    eo.shape.points[2] = oz0;
                    eo.shape.points[5] = newOrz;
                    eo.shape.points[6] = L;
                    eo.shape.points[7] = W;
                    eo.shape.points[8] = H;
                    modalOtherObjectsCache.delete(fn);

                    const row = document.getElementById(`modal-row-frame-${fn}`);
                    const cTop = row ? row.querySelector('.canvas-top') : null;
                    const mainSh = activeModalTrack.shapes.find(s => Number(s.frame) === fn);
                    if (cTop && mainSh && mainSh.points) {
                        if (row && row._needsLiDARReproject) reprojectLiDARChoRow(row, mainSh);
                        const topDragPts = (row && row._wideLiDARPoints && row._wideLiDARPoints.length > 0)
                                           ? row._wideLiDARPoints
                                           : (row ? (row._localLiDARPoints || []) : []);
                        veCanvasTopView(cTop, mainSh.points[6], mainSh.points[7], mainSh.points[8], topDragPts, 0, 0, true, 0, fn, true);
                    }
                    return;
                }

                // [v2.7.7 THEO YÊU CẦU KIỆT]: Trong suốt lúc đang giữ chuột kéo/xoay (mousemove),
                // CHỈ cập nhật duy nhất 1 view đang thao tác của đúng 1 frame đang kéo (xoay tít mù các view/frame còn lại không cần chạy theo tức thì).
                // Đến khi thả chuột (mouseup / ketThucKeoChuot) mới đồng bộ toàn bộ theo độ lệch đầu-cuối!
                const fn = Number(modalDragState.sourceFrame);
                const row = document.getElementById(`modal-row-frame-${fn}`);
                if (!row) return;

                const curSh = activeModalTrack.shapes.find(s => Number(s.frame) === fn);
                if (row._needsLiDARReproject && curSh) {
                    reprojectLiDARChoRow(row, curSh);
                }

                const initPts = modalDragState.sourceStartPoints || modalDragState.startPointsMap?.get(fn) || curSh?.points;
                if (!initPts) return;
                const rX = initPts[0], rY = initPts[1], rZ = initPts[2], rRz = initPts[5] || 0;

                const cosRz = Math.cos(rRz + curDyaw), sinRz = Math.sin(rRz + curDyaw);
                const curX = rX + (cosRz * curDu - sinRz * curDv);
                const curY = rY + (sinRz * curDu + cosRz * curDv);
                const curZ = rZ + curDz;

                const coordText = row.querySelector('.row-coord-text');
                if (coordText) {
                    coordText.innerHTML = `X:${curX.toFixed(2)} Y:${curY.toFixed(2)}<br>Z:${curZ.toFixed(2)} R:${((rRz + curDyaw) * 180 / Math.PI).toFixed(1)}°<br><span style="color:#38bdf8;font-weight:700">L:${L.toFixed(2)} W:${W.toFixed(2)} H:${H.toFixed(2)}</span>`;
                }

                const activeView = modalDragState.viewType;
                if (activeView === 'top') {
                    const topDragPts = (row._wideLiDARPoints && row._wideLiDARPoints.length > 0)
                                       ? row._wideLiDARPoints
                                       : (row._localLiDARPoints || []);
                    const cTop = row.querySelector('.canvas-top');
                    if (cTop) veCanvasTopView(cTop, L, W, H, topDragPts, curDu, curDv, true, curDyaw, fn, modalShowOtherObjects);
                } else if (activeView === 'side') {
                    const pts = row._localLiDARPoints || [];
                    const cSide = row.querySelector('.canvas-side');
                    if (cSide) veCanvasSideView(cSide, L, W, H, pts, curZ, curDu, curDz, true, curDpitch);
                } else if (activeView === 'front') {
                    const pts = row._localLiDARPoints || [];
                    const cFront = row.querySelector('.canvas-front');
                    if (cFront) veCanvasFrontView(cFront, L, W, H, pts, curZ, curDv, curDz, true, curDroll);
                }
            });
        }
    }

    function thuChuyenTrackTuDoubleTapTop(canvas, clientX, clientY, fn, isCtrlKey = false) {
        if (!canvas || canvas._viewType !== 'top') return false;
        const ts = typeof window !== 'undefined' ? window.thuatToanSurface : null;
        if (ts && ts.isActive && ts.cheDoChonTrenTop) return false;
        const rect = canvas.getBoundingClientRect();
        const mx = clientX - rect.left;
        const my = clientY - rect.top;
        const hitObj = timVatTheTopTaiToaDo(canvas, mx, my, { padPx: 16 });
        if (isCtrlKey) {
            if (!hitObj || !hitObj.trackId) return false;
            canvas._lastTopClickMeta = null;
            canvas._lastTopSwitchTs = Date.now();
            if (!hitObj.track) {
                hienToast(`ℹ️ Vật thể #${hitObj.trackId} là Shape đơn lẻ (không phải Track chuỗi) nên không mở bảng Track!`);
                return true;
            }
            chuyenTrackGiuNguyenTopView(hitObj.trackId, fn, hitObj.shape);
            return true;
        }
        const now = Date.now();
        const prev = canvas._lastTopClickMeta;
        if (prev && (now - prev.time) <= 420 && Math.hypot(clientX - prev.x, clientY - prev.y) <= 10) {
            const target = hitObj || prev.hitObj;
            canvas._lastTopClickMeta = null;
            if (target && target.trackId) {
                canvas._lastTopSwitchTs = now;
                if (!target.track) {
                    hienToast(`ℹ️ Vật thể #${target.trackId} là Shape đơn lẻ (không phải Track chuỗi) nên không mở bảng Track!`);
                    return true;
                }
                chuyenTrackGiuNguyenTopView(target.trackId, fn, target.shape);
                return true;
            }
        }
        canvas._lastTopClickMeta = hitObj ? { time: now, x: clientX, y: clientY, hitObj } : null;
        return false;
    }

    /**
     * KẾT THÚC KÉO CHUỘT (MOUSEUP): ĐỒNG BỘ 100% CÁC FRAMES ĐÃ CHỌN
     */
    function ketThucKeoChuot(e) {
        if (modalDragRafId) {
            cancelAnimationFrame(modalDragRafId);
            modalDragRafId = 0;
        }
        modalDragRafPending = false;

        if (modalRotateViewState) {
            const rotC = modalRotateViewState.canvas;
            const rotFn = modalRotateViewState.frameNum;
            if (rotC) {
                rotC.style.cursor = 'crosshair';
            }
            modalRotateViewState = null;
            // Vẽ lại 1 frame chất lượng tối đa 100% số điểm khi vừa thả chuột
            if (rotC) {
                requestAnimationFrame(() => {
                    taiVeCanvasTheoFrame(rotC, 'top', rotFn);
                });
            }
            if (modalBatchRedrawQueue.length > 0 && !modalBatchRedrawRaf && typeof chayHangDoiVeNen === 'function') {
                chayHangDoiVeNen();
            }
            return;
        }

        if (modalPanState) {
            const panC = modalPanState.canvas;
            const panFn = modalPanState.frameNum;
            const panMoved = !!modalPanState.hasMoved;
            if (panC) {
                panC.style.cursor = 'crosshair';
            }
            modalPanState = null;
            if (panC && !panMoved && (!e || e.button === 0 || e.button === undefined)) {
                thuChuyenTrackTuDoubleTapTop(panC, e.clientX, e.clientY, panFn, !!(e && (e.ctrlKey || e.metaKey)));
            } else if (panC && panMoved) {
                panC._lastTopClickMeta = null;
            }
            if (modalBatchRedrawQueue.length > 0 && !modalBatchRedrawRaf && typeof chayHangDoiVeNen === 'function') {
                chayHangDoiVeNen();
            }
            return;
        }

        if (!modalDragState || !activeModalTrack) return;

        if (modalDragState.editingOther) {
            const eo = modalDragState.editingOther;
            const fn = Number(modalDragState.sourceFrame);
            const dragC = modalDragState.canvas;
            document.body.classList.remove('cvat-is-dragging');
            modalDragState = null;
            if (eo.hasMoved) {
                if (dragC) dragC._lastTopClickMeta = null;
                window._modalHasEditedMultipleTracks = true;
                modalOtherObjectsCache.clear();
                if (typeof veLaiTatCaHangModal === 'function') {
                    veLaiTatCaHangModal(false);
                }
                hienToast(`🛠️ Đã cập nhật vật thể ${eo.label || ('#' + eo.trackId)} tại Frame ${fn} (Hỗ trợ Ctrl+Z hoàn tác)`);
            } else if (dragC && (!e || e.button === 0 || e.button === undefined)) {
                thuChuyenTrackTuDoubleTapTop(dragC, e.clientX, e.clientY, fn, !!(e && (e.ctrlKey || e.metaKey)));
            }
            if (modalBatchRedrawQueue.length > 0 && !modalBatchRedrawRaf && typeof chayHangDoiVeNen === 'function') {
                chayHangDoiVeNen();
            }
            return;
        }

        const { mode, viewType, sourceFrame, targetFrames, du, dv, dz, dl, dw, dh, dyaw, dpitch, droll, curL, curW, curH, startPointsMap, sourceStartPoints } = modalDragState;
        const totalDist = Math.hypot(du, dv, dz);
        const [initX, initY, initZ, initRx, initRy, initRz, initL, initW, initH] = sourceStartPoints;
        const isSizeChanged = Math.abs(curL - initL) > 0.005 || Math.abs(curW - initW) > 0.005 || Math.abs(curH - initH) > 0.005;
        const isRotChanged = (mode === 'rotate') && (Math.abs(dyaw || 0) > 0.0001 || Math.abs(dpitch || 0) > 0.0001 || Math.abs(droll || 0) > 0.0001);
        const isMoved = (mode === 'move') && totalDist > 0.003;

        document.body.classList.remove('cvat-is-dragging');

        modalDragState = null;

        if (!isMoved && !isSizeChanged && !isRotChanged) {
            if (totalDist > 0 || Math.abs(dyaw || 0) > 0 || Math.abs(dpitch || 0) > 0 || Math.abs(droll || 0) > 0 || Math.abs(dl || 0) > 0 || Math.abs(dw || 0) > 0 || Math.abs(dh || 0) > 0) {
                const srcFn = Number(sourceFrame);
                const row = document.getElementById(`modal-row-frame-${srcFn}`);
                if (row) {
                    const sh = activeModalTrack.shapes.find(s => Number(s.frame) === srcFn);
                    if (sh && sh.points) {
                        veRowCanvasTuDiem(row, sh, true);
                    }
                }
            }
            if (modalBatchRedrawQueue.length > 0 && !modalBatchRedrawRaf && typeof chayHangDoiVeNen === 'function') {
                chayHangDoiVeNen();
            }
            return;
        }

        // Lưu Undo snapshot chỉ khi người dùng thực sự có thay đổi vị trí / kích thước / góc xoay
        luuUndoSnapshotModal();

        // BUÔNG CHUỘT: ÁP DỤNG THAY ĐỔI ĐỒNG BỘ 100% (ƯU TIÊN REPROJECT TỨC THÌ HÀNG HIỂN THỊ, ĐẨY HÀNG ẨN VÀO QUEUE NỀN)
        const container = document.getElementById('modal-rows-list');
        const sTop = container ? container.scrollTop : 0;
        const cHeight = container ? (container.clientHeight || 800) : 800;
        const vTop = sTop - 250;
        const vBottom = sTop + cHeight + 250;
        const rowsToQueueBackground = [];

        const rowDeltaU = (mode === 'move' || mode === 'resize') ? du : 0;
        const rowDeltaV = (mode === 'move' || mode === 'resize') ? dv : 0;
        const rowDeltaZ = (mode === 'move' || mode === 'resize') ? dz : 0;
        const rowDyaw = (mode === 'rotate' && viewType === 'top') ? (dyaw || 0) : 0;
        const rowDpitch = (mode === 'rotate' && viewType === 'side') ? (dpitch || 0) : 0;
        const rowDroll = (mode === 'rotate' && viewType === 'front') ? (droll || 0) : 0;

        for (const fn of targetFrames) {
            const fnNum = Number(fn);
            const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fnNum);
            const initPts = startPointsMap.get(fnNum);
            if (!sh || !initPts) continue;

            const rx = initPts[3] || 0;
            const ry = initPts[4] || 0;
            const rz = initPts[5] || 0;

            let deltaWorldX = 0, deltaWorldY = 0, deltaWorldZ = 0;
            if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.eulerXYZToMatrix === 'function' && typeof window.thuatToanCanChinh.matVecMul === 'function') {
                const rotMat = window.thuatToanCanChinh.eulerXYZToMatrix(rx, ry, rz);
                const shift = window.thuatToanCanChinh.matVecMul(rotMat, [du, dv, dz]);
                deltaWorldX = shift[0];
                deltaWorldY = shift[1];
                deltaWorldZ = shift[2];
            } else {
                const cosRz = Math.cos(rz), sinRz = Math.sin(rz);
                deltaWorldX = cosRz * du - sinRz * dv;
                deltaWorldY = sinRz * du + cosRz * dv;
                deltaWorldZ = dz;
            }

            if (mode === 'move') {
                // Tịnh tiến đồng bộ 100% bảo toàn vector cục bộ cho toàn bộ các frames đã chọn
                sh.points[0] = initPts[0] + deltaWorldX;
                sh.points[1] = initPts[1] + deltaWorldY;
                sh.points[2] = initPts[2] + deltaWorldZ;
            } else if (mode === 'resize' && isSizeChanged) {
                // Co giãn kích thước: ÁP DỤNG ĐỒNG BỘ 100% CHO TOÀN BỘ CÁC FRAMES ĐÃ CHỌN
                const newL = Math.max(0.2, initPts[6] + dl);
                const newW = Math.max(0.2, initPts[7] + dw);
                const newH = Math.max(0.2, initPts[8] + dh);

                sh.points[6] = newL;
                sh.points[7] = newW;
                sh.points[8] = newH;

                sh.points[0] = initPts[0] + deltaWorldX;
                sh.points[1] = initPts[1] + deltaWorldY;
                sh.points[2] = initPts[2] + deltaWorldZ;

                if (activeModalTrack) {
                    activeModalTrack.locked_l_val = sh.points[6];
                    activeModalTrack.locked_w_val = sh.points[7];
                    activeModalTrack.locked_h_val = sh.points[8];
                }
            } else if (mode === 'rotate' && isRotChanged) {
                // Đồng bộ góc xoay tương đối 100% theo hệ tọa độ cục bộ của xe (Local Roll/Pitch/Yaw)
                const rotAngle = (viewType === 'top') ? dyaw : ((viewType === 'side') ? dpitch : droll);
                if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.xoayGocCucBo === 'function') {
                    const [newRx, newRy, newRz] = window.thuatToanCanChinh.xoayGocCucBo(initPts[3] || 0, initPts[4] || 0, initPts[5] || 0, viewType, rotAngle);
                    sh.points[3] = newRx;
                    sh.points[4] = newRy;
                    sh.points[5] = newRz;
                } else {
                    if (viewType === 'top') {
                        sh.points[5] = window.thuatToanCanChinh ? window.thuatToanCanChinh.wrapToPi(initPts[5] + dyaw) : (initPts[5] + dyaw);
                    } else if (viewType === 'side') {
                        sh.points[4] = window.thuatToanCanChinh ? window.thuatToanCanChinh.wrapToPi((initPts[4] || 0) + dpitch) : ((initPts[4] || 0) + dpitch);
                    } else if (viewType === 'front') {
                        sh.points[3] = window.thuatToanCanChinh ? window.thuatToanCanChinh.wrapToPi((initPts[3] || 0) + droll) : ((initPts[3] || 0) + droll);
                    }
                }
                if (sh.rotation && Array.isArray(sh.rotation)) {
                    sh.rotation[0] = sh.points[3] || 0;
                    sh.rotation[1] = sh.points[4] || 0;
                    sh.rotation[2] = sh.points[5] || 0;
                }
            }

            const row = document.getElementById(`modal-row-frame-${fnNum}`);
            if (!row) continue;

            const [newX, newY, newZ, , , newRz, L, W, H] = sh.points;

            const coordText = row.querySelector('.row-coord-text');
            if (coordText) {
                coordText.innerHTML = `X:${newX.toFixed(2)} Y:${newY.toFixed(2)}<br>Z:${newZ.toFixed(2)} R:${(newRz * 180 / Math.PI).toFixed(1)}°<br><span style="color:#38bdf8;font-weight:700">L:${L.toFixed(2)} W:${W.toFixed(2)} H:${H.toFixed(2)}</span>`;
            }

            tichLuyDeltaChoRow(row, rowDeltaU, rowDeltaV, rowDeltaZ, rowDyaw, rowDpitch, rowDroll);

            const hasFs = !!row.querySelector('.row-view-card.is-fullscreen-view');
            let canDrawNow = (fnNum === Number(sourceFrame)) || hasFs;
            if (!canDrawNow && container) {
                const rTop = row.offsetTop;
                const rBottom = rTop + (row.offsetHeight || 225);
                canDrawNow = (rBottom >= vTop && rTop <= vBottom);
            }
            if (canDrawNow) {
                veRowCanvasTuDiem(row, sh, true);
            } else {
                row._needsRedraw = true;
                rowsToQueueBackground.push(row);
            }
        }

        if (rowsToQueueBackground.length > 0 && typeof themHangVaoHangDoiVeNen === 'function') {
            themHangVaoHangDoiVeNen(rowsToQueueBackground);
        } else if (modalBatchRedrawQueue.length > 0 && !modalBatchRedrawRaf && typeof chayHangDoiVeNen === 'function') {
            chayHangDoiVeNen();
        }

        // Tự động cập nhật 3 ô input kích thước Dài, Rộng, Cao trên header modal và thanh HUD ngoài
        if (typeof capNhatOInputKichThuocTuTrack === 'function') {
            capNhatOInputKichThuocTuTrack(activeModalTrack);
        }
        if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') {
            dongBoTrangThaiSuaSauThaoTac();
        }

        const curShape = activeModalTrack.shapes.find(s => Number(s.frame) === Number(sourceFrame)) || activeModalTrack.shapes[0];
        if (curShape && curShape.points) {
            const inpL = document.getElementById('modal-inp-size-L');
            const inpW = document.getElementById('modal-inp-size-W');
            const inpH = document.getElementById('modal-inp-size-H');
            if (inpL) inpL.value = curShape.points[6].toFixed(2);
            if (inpW) inpW.value = curShape.points[7].toFixed(2);
            if (inpH) inpH.value = curShape.points[8].toFixed(2);

            // Đồng bộ luôn ra thanh HUD Toolbar bên ngoài
            const outL = document.getElementById('inp-dim-l');
            const outW = document.getElementById('inp-dim-w');
            const outH = document.getElementById('inp-dim-h');
            if (outL) outL.value = curShape.points[6].toFixed(3);
            if (outW) outW.value = curShape.points[7].toFixed(3);
            if (outH) outH.value = curShape.points[8].toFixed(3);
        }

        const actionName = (mode === 'resize') ? 'co giãn kích thước' : ((mode === 'rotate') ? 'xoay góc hướng' : 'tịnh tiến');
        hienToast(`✅ Đã đồng bộ ${actionName} cho ${targetFrames.length} frames thành công!`);
    }

    function xuLyCuonChuotZoomCanvas(e, viewType, frameNum) {
        e.preventDefault();
        e.stopPropagation();
        const canvas = e.currentTarget;
        if (!canvas) return;

        const cw = canvas.width || 360;
        const ch = canvas.height || 185;
        const clientW = canvas.clientWidth || cw;
        const clientH = canvas.clientHeight || ch;
        // Dùng e.offsetX/offsetY để triệt tiêu hoàn toàn getBoundingClientRect layout thrashing
        const mx = (typeof e.offsetX === 'number') ? e.offsetX * (cw / clientW) : cw / 2;
        const my = (typeof e.offsetY === 'number') ? e.offsetY * (ch / clientH) : ch / 2;

        const vs = layViewStateCanvas(canvas, frameNum, viewType);
        const oldZoom = vs.zoom || 1.0;
        let zoomFactor = e.deltaY < 0 ? 1.15 : (1 / 1.15);
        if (e.shiftKey) {
            zoomFactor = e.deltaY < 0 ? 1.05 : (1 / 1.05); // Vi chỉnh mịn
        } else if (e.ctrlKey) {
            zoomFactor = e.deltaY < 0 ? 1.30 : (1 / 1.30); // Phóng to/thu nhỏ nhanh
        }
        const newZoom = Math.min(15.0, Math.max(0.05, oldZoom * zoomFactor));

        if (Math.abs(newZoom - oldZoom) < 1e-4) return;

        const leftMargin = 38, rightMargin = 16, topMargin = 24, bottomMargin = 28;
        const plotW = cw - leftMargin - rightMargin;
        const plotH = ch - topMargin - bottomMargin;
        const cx0 = leftMargin + plotW / 2;
        const cy0 = topMargin + plotH / 2;

        const inPlot = (mx >= leftMargin && mx <= cw - rightMargin && my >= topMargin && my <= ch - bottomMargin);
        const anchorX = inPlot ? mx : (cx0 + (vs.panX || 0));
        const anchorY = inPlot ? my : (cy0 + (vs.panY || 0));

        const k = newZoom / oldZoom;
        const effCx = cx0 + (vs.panX || 0);
        const effCy = cy0 + (vs.panY || 0);

        // Giữ nguyên điểm dữ liệu nằm dưới đầu con trỏ
        const newEffCx = anchorX - (anchorX - effCx) * k;
        const newEffCy = anchorY - (anchorY - effCy) * k;

        vs.panX = newEffCx - cx0;
        vs.panY = newEffCy - cy0;
        vs.zoom = newZoom;

        // ĐIỀU TỐC V-SYNC 60-120 FPS: Tránh gọi taiVeCanvasTheoFrame dồn dập hàng trăm lần/giây khi cuộn
        if (!canvas._zoomRafPending) {
            canvas._zoomRafPending = true;
            requestAnimationFrame(() => {
                canvas._zoomRafPending = false;
                taiVeCanvasTheoFrame(canvas, viewType, frameNum);
            });
        }
    }

    // Lazy Loading LiDAR thông minh: Chỉ tải khi hàng cuộn vào tầm nhìn (giới hạn tối đa 2 tải đồng thời)
    let modalIntersectionObserver = null;
    let pcdFetchQueue = [];
    let pcdActiveFetches = 0;

    /**
     * Cập nhật tức thì dữ liệu điểm LiDAR thực cho một hàng trên Modal Chi Tiết
     */
    function capNhatDiemChoHangModal(fn, realPts) {
        if (!realPts || realPts.length === 0) return;
        const fnNum = Number(fn);
        const row = document.getElementById(`modal-row-frame-${fnNum}`);
        if (!row || !activeModalTrack) return;
        const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fnNum);
        if (!sh || !sh.points || sh.points.length < 9) return;

        const [x, y, z, rx, ry, rz, L, W, H] = sh.points;
        const updatedLocal = chuyenDiemSangCucBo(realPts, x, y, z, rx || 0, ry || 0, rz || 0, 8.0);
        const updatedWide = chuyenDiemSangCucBo(realPts, x, y, z, 0, 0, rz || 0, 80.0);

        let ptsCount = 0;
        const hl = L / 2, hw = W / 2, hh = H / 2;
        for (let i = 0; i < updatedLocal.length; i++) {
            const p = updatedLocal[i];
            if (Math.abs(p[0]) <= hl && Math.abs(p[1]) <= hw && Math.abs(p[2]) <= hh) ptsCount++;
        }

        // Cập nhật điểm LiDAR thật mới nhất (xóa cờ pending cũ vì đã reproject từ rawPts mới nhất)
        row._localLiDARPoints = updatedLocal;
        row._wideLiDARPoints = updatedWide;
        row._needsLiDARReproject = false;
        row._pendingPointDeltas = null;

        const badge = row.querySelector('.pts-count-badge');
        if (badge) badge.textContent = `${ptsCount} pts`;

        if (dangTuongTacCanvas(fnNum)) {
            row._needsRedraw = true;
            return;
        }

        row._needsRedraw = false;
        const ct = row.querySelector('.canvas-top');
        const cs = row.querySelector('.canvas-side');
        const cf = row.querySelector('.canvas-front');
        const showOther = row ? (row._showOtherObjects !== undefined ? !!row._showOtherObjects : modalShowOtherObjects) : modalShowOtherObjects;
        const capTopPts = (updatedWide && updatedWide.length > 0) ? updatedWide : updatedLocal;
        if (ct) veCanvasTopView(ct, L, W, H, capTopPts, 0, 0, false, 0, fnNum, showOther);
        if (cs) veCanvasSideView(cs, L, W, H, updatedLocal, z, 0, 0, false, 0);
        if (cf) veCanvasFrontView(cf, L, W, H, updatedLocal, z, 0, 0, false, 0);
    }

    function xuLyHangDoiLiDAR(jid) {
        if (!jid) return;
        while (pcdActiveFetches < 6 && pcdFetchQueue.length > 0) {
            const fn = pcdFetchQueue.shift();
            if (pcdFrameCache.has(fn)) continue;
            pcdActiveFetches++;

            taiDiemLiDARChoFrame(jid, fn).then(realPts => {
                if (realPts && realPts.length > 0 && !realPts._isSynthetic) {
                    pcdFrameCache.set(fn, realPts);
                    capNhatDiemChoHangModal(fn, realPts);
                }
            }).catch(() => {}).finally(() => {
                pcdActiveFetches--;
                xuLyHangDoiLiDAR(jid);
            });
        }
    }

    function khoiTaoLazyLoadingLiDAR(container, jid) {
        if (!jid) jid = layJobIdHienTai();
        if (!jid || !container) return;
        if (typeof IntersectionObserver === 'undefined') return;
        if (modalIntersectionObserver) {
            modalIntersectionObserver.disconnect();
            modalIntersectionObserver = null;
        }
        pcdFetchQueue = [];

        modalIntersectionObserver = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    const row = entry.target;
                    const fnStr = row.getAttribute('data-frame-num');
                    if (!fnStr) continue;
                    const fn = parseInt(fnStr, 10);
                    if (!isNaN(fn)) {
                        modalIntersectionObserver.unobserve(row);
                        if (!pcdFrameCache.has(fn) && !pcdFetchQueue.includes(fn)) {
                            pcdFetchQueue.push(fn);
                            xuLyHangDoiLiDAR(jid);
                        }
                    }
                }
            }
        }, {
            root: container,
            rootMargin: '200px 0px'
        });

        container.querySelectorAll('.frame-detail-row').forEach(row => {
            const fnStr = row.getAttribute('data-frame-num');
            if (fnStr) {
                const fn = parseInt(fnStr, 10);
                if (!pcdFrameCache.has(fn)) {
                    modalIntersectionObserver.observe(row);
                }
            }
        });

        const curFn = layFrameHienTai();
        if (!pcdFrameCache.has(curFn) && !pcdFetchQueue.includes(curFn)) {
            pcdFetchQueue.unshift(curFn);
        }
        // Đẩy toàn bộ các frames đang Active của track vào hàng đợi nạp LiDAR để sẵn sàng căn chỉnh
        const activeFns = (activeModalTrack?.shapes || []).filter(s => !s.outside).map(s => s.frame);
        for (const fn of activeFns) {
            if (!pcdFrameCache.has(fn) && !pcdFetchQueue.includes(fn)) {
                pcdFetchQueue.push(fn);
            }
        }
        xuLyHangDoiLiDAR(jid);
    }

    /**
     * XÁC ĐỊNH NHÃN CHO TRACK (SUY LUẬN THÔNG MINH CHO XE HƠI, XE MÁY, NGƯỜI ĐI BỘ)
     */
    function xacDinhNhanTrack(track, labelsMap) {
        if (!track) return 'vehicles';
        if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.suyLuanNhanTrack === 'function') {
            return window.thuatToanCanChinh.suyLuanNhanTrack(track, labelsMap || currentLabels);
        }
        const lid = track.label_id;
        if (labelsMap && labelsMap[lid] && labelsMap[lid].name) {
            return labelsMap[lid].name;
        }
        if (lid === 8661578 || lid === 12871) return 'vehicles';
        if (lid === 8661579 || lid === 12872) return 'pedestrian';
        if (lid === 8661580 || lid === 12873) return 'two-wheels';
        return 'vehicles';
    }

    /**
     * ĐIỀU HƯỚNG TỚI FRAME CHỈ ĐỊNH TRONG MODAL VÀ CUỘN MƯỢT
     */
    let modalCurrentActiveFrame = 0;

    function layFrameHienTaiCuaModal() {
        const curRow = document.querySelector('.frame-detail-row.is-current-frame');
        if (curRow) {
            const fnStr = curRow.getAttribute('data-frame-num');
            const fn = parseInt(fnStr, 10);
            if (!isNaN(fn)) return fn;
        }
        const sel = document.getElementById('modal-sel-frame-size');
        if (sel && sel.value !== '') {
            const fn = parseInt(sel.value, 10);
            if (!isNaN(fn)) return fn;
        }
        return Number.isInteger(modalCurrentActiveFrame) ? modalCurrentActiveFrame : layFrameHienTai();
    }

    function layDanhSachFramesModal() {
        if (!activeModalTrack) return [];
        if (cheDoHienFullFramesJob) {
            const total = layTongSoFrameJob();
            return Array.from({ length: total }, (_, i) => i);
        }
        const allRows = Array.from(document.querySelectorAll('.frame-detail-row'));
        if (allRows.length > 0) {
            const fns = allRows.map(r => parseInt(r.getAttribute('data-frame-num'), 10)).filter(fn => !isNaN(fn));
            if (fns.length > 0) return fns;
        }
        return (activeModalTrack.shapes || []).map(s => parseInt(s.frame, 10)).filter(fn => !isNaN(fn)).sort((a, b) => a - b);
    }

    /**
     * ĐIỀU HƯỚNG TỚI FRAME CHỈ ĐỊNH TRONG MODAL VÀ CUỘN MƯỢT
     */
    function nhayToiFrameModal(frameNum, syncCVAT = false, shouldScroll = true) {
        if (!activeModalTrack) return;
        frameNum = parseInt(frameNum, 10);
        if (isNaN(frameNum)) return;

        modalCurrentActiveFrame = frameNum;

        // 1. Cập nhật visual highlight cho hàng mục tiêu
        const allRows = document.querySelectorAll('.frame-detail-row');
        allRows.forEach(r => r.classList.remove('is-current-frame'));
        const targetRow = document.getElementById(`modal-row-frame-${frameNum}`);
        if (targetRow) {
            targetRow.classList.add('is-current-frame');
            if (targetRow._needsLiDARReproject || targetRow._needsRedraw) {
                const curSh = activeModalTrack.shapes.find(s => Number(s.frame) === frameNum);
                if (curSh) veRowCanvasTuDiem(targetRow, curSh, false);
            }
            if (shouldScroll) {
                targetRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            }
        }

        // 2. Cập nhật dropdown Chọn Frame trên header modal
        const selKeyFrame = document.getElementById('modal-sel-frame-size');
        if (selKeyFrame) {
            selKeyFrame.value = String(frameNum);
            const curShape = activeModalTrack.shapes.find(s => Number(s.frame) === frameNum && !s.outside);
            if (curShape && curShape.points) {
                const inpL = document.getElementById('modal-inp-size-L');
                const inpW = document.getElementById('modal-inp-size-W');
                const inpH = document.getElementById('modal-inp-size-H');
                if (inpL) inpL.value = curShape.points[6].toFixed(2);
                if (inpW) inpW.value = curShape.points[7].toFixed(2);
                if (inpH) inpH.value = curShape.points[8].toFixed(2);
            }
        }

        if (syncCVAT) {
            chuyenFrameCVAT(frameNum);
        }
    }

    /**
     * Chuyển sang Track khác khi Double-Click vào một vật thể trong View TOP tại anchorFrame:
     * - Giữ nguyên 100% góc nhìn, độ phóng đại (zoom), độ nghiêng (pitch/yaw) và vị trí trên màn hình của View TOP tại đúng anchorFrame!
     * - Toàn bộ các frames khác (!== anchorFrame) và 2 view còn lại (SIDE, FRONT) đổi về Standard View chuẩn!
     */
    function khopDoiTuongTrack(t, refTrack) {
        if (!t || !refTrack) return false;
        if (t === refTrack) return true;
        if (t.id !== undefined && refTrack.id !== undefined && t.id === refTrack.id) return true;
        if (refTrack._trackNumber !== undefined && t._trackNumber !== undefined && Number(t._trackNumber) === Number(refTrack._trackNumber)) return true;
        return false;
    }

    function luuHoacKhoiPhucTrackTruocKhiChuyen() {
        if (!activeModalTrack || !currentAnnotations || !Array.isArray(currentAnnotations.tracks)) return;
        if (!activeModalTrack._isDirty && Array.isArray(activeModalTrack._origShapesBackup)) {
            activeModalTrack.shapes = activeModalTrack._origShapesBackup;
            delete activeModalTrack._origShapesBackup;
        } else if (activeModalTrack._isDirty) {
            window._modalHasEditedMultipleTracks = true;
        }
        const curIdx = currentAnnotations.tracks.findIndex(t => khopDoiTuongTrack(t, activeModalTrack));
        if (curIdx !== -1) {
            currentAnnotations.tracks[curIdx] = activeModalTrack;
        }
    }

    async function chuyenTrackGiuNguyenTopView(newTrackId, anchorFrame, clickedShape = null) {
        if (!currentAnnotations || !activeModalTrack) {
            return await moModalChiTietTrack(newTrackId);
        }
        newTrackId = parseInt(newTrackId, 10);
        if (isNaN(newTrackId)) return;
        if (Number(activeModalTrack._trackNumber) === newTrackId) return;

        const targetTr = window.thuatToanCanChinh.timTrack(currentAnnotations, newTrackId);
        if (!targetTr) {
            hienToast(`❌ Không tìm thấy Track #${newTrackId}!`);
            return;
        }

        const container = document.getElementById('modal-rows-list');
        const oldRow = document.getElementById(`modal-row-frame-${anchorFrame}`);
        const oldRowScreenTop = (oldRow && container) ? (oldRow.offsetTop - container.scrollTop) : null;
        const cTopOld = oldRow ? oldRow.querySelector('.canvas-top') : null;
        const vsOld = cTopOld ? layViewStateCanvas(cTopOld, anchorFrame, 'top') : null;

        // Lấy tọa độ hộp của Track cũ và Track mới tại anchorFrame (kể cả khi đang ở trạng thái outside) để tính phép bù dịch tâm & góc xoay chuẩn xác
        const oldShape = (activeModalTrack.shapes || []).find(s => Number(s.frame) === Number(anchorFrame) && s.points && s.points.length >= 9)
                      || layShapeChoFrame(activeModalTrack, anchorFrame)
                      || (oldRow && oldRow._redInterpolatedBox ? { points: oldRow._redInterpolatedBox } : (activeModalTrack.shapes || [])[0]);
        const newShape = (clickedShape && clickedShape.points && clickedShape.points.length >= 9)
                      ? clickedShape
                      : ((targetTr.shapes || []).find(s => Number(s.frame) === Number(anchorFrame) && s.points && s.points.length >= 9)
                         || layShapeChoFrame(targetTr, anchorFrame)
                         || (targetTr.shapes || [])[0]);

        try {
            const kqRoi = await hoiXuLyPhienBanKhiRoi(activeModalTrack);
            if (kqRoi === 'cancel') return;
        } catch (errRoi) {
            console.error('[hoiXuLyPhienBanKhiRoi]', errRoi);
        }
        luuHoacKhoiPhucTrackTruocKhiChuyen();

        let preservedTopVs = null;
        if (vsOld && oldShape && oldShape.points && newShape && newShape.points) {
            const [tcx1, tcy1, tcz1, , , trz1, L1, W1, H1] = oldShape.points;
            const [tcx2, tcy2, tcz2, , , trz2] = newShape.points;

            const cw = (cTopOld && cTopOld.clientWidth > 50) ? cTopOld.clientWidth : 360;
            const ch = (cTopOld && cTopOld.clientHeight > 50) ? cTopOld.clientHeight : 185;
            const refL1 = activeModalTrack._refL || L1 || 4.4;
            const refW1 = activeModalTrack._refW || W1 || 1.9;
            const refH1 = activeModalTrack._refH || H1 || 1.6;
            const S0_old = vsOld.baseScale || tinhScaleCVAT('top', refL1, refW1, refH1, cw, ch);
            const S_old = S0_old * (vsOld.zoom || 1.0);

            const viewPitch_old = vsOld.viewPitch || 0;
            const viewYaw_old = vsOld.viewYaw || 0;

            const dx = tcx2 - tcx1;
            const dy = tcy2 - tcy1;
            const dz = tcz2 - tcz1;
            const cosTrz1 = Math.cos(-(trz1 || 0));
            const sinTrz1 = Math.sin(-(trz1 || 0));
            const relX = cosTrz1 * dx - sinTrz1 * dy;
            const relY = sinTrz1 * dx + cosTrz1 * dy;
            const relZ = dz;

            const cosVY1 = Math.cos(viewYaw_old);
            const sinVY1 = Math.sin(viewYaw_old);
            const u2 = cosVY1 * relX - sinVY1 * relY;
            const v2 = sinVY1 * relX + cosVY1 * relY;
            const w2 = relZ;
            const xCam = u2;
            const yCam = (viewPitch_old !== 0) ? (v2 * Math.cos(viewPitch_old) + w2 * Math.sin(viewPitch_old)) : v2;

            // Tâm của Track mới trên màn hình hiện tại cách tâm canvas một khoảng (newPanX, newPanY)
            const newPanX = (vsOld.panX || 0) + xCam * S_old;
            const newPanY = (vsOld.panY || 0) - yCam * S_old;

            const wrapFn = (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.wrapToPi === 'function')
                ? window.thuatToanCanChinh.wrapToPi
                : ((a) => { let r = a % (2 * Math.PI); if (r > Math.PI) r -= 2 * Math.PI; if (r < -Math.PI) r += 2 * Math.PI; return r; });
            const newViewYaw = wrapFn(viewYaw_old + ((trz2 || 0) - (trz1 || 0)));

            preservedTopVs = {
                baseScale: S_old,
                zoom: 1.0,
                panX: newPanX,
                panY: newPanY,
                viewPitch: viewPitch_old,
                viewYaw: newViewYaw,
                _userInteracted: true
            };
        }

        // Đồng bộ ô nhập Track ID bên ngoài HUD
        selectedTrackId = newTrackId;
        const hudInp = document.getElementById('inp-track-id');
        if (hudInp) hudInp.value = newTrackId;

        await moModalChiTietTrack(newTrackId, {
            preserveTopViewFrame: anchorFrame,
            preservedTopViewState: preservedTopVs,
            anchorRowScreenTop: oldRowScreenTop
        });
    }

    async function moModalChiTietTrack(trackId, options = {}) {
        if (!currentAnnotations) {
            hienToast("⚠️ Chưa có dữ liệu annotations!", async () => {
                hienToast("🔄 Đang tải annotations từ máy chủ...");
                await napDuLieuBanDau();
                if (currentAnnotations) {
                    moModalChiTietTrack(trackId);
                }
            }, "🔄 Bấm để nạp ngay");
            // Tự động thử nạp ngầm luôn
            napDuLieuBanDau().then(() => {
                if (currentAnnotations && !activeModalTrack) {
                    moModalChiTietTrack(trackId);
                }
            }).catch(() => {});
            return;
        }

        let tr = window.thuatToanCanChinh.timTrack(currentAnnotations, trackId);
        if (!tr && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTrackLiveTuRAM === 'function') {
            tr = window.quanLyAPICVAT.layTrackLiveTuRAM(trackId);
            if (tr && currentAnnotations) {
                if (!Array.isArray(currentAnnotations.tracks)) currentAnnotations.tracks = [];
                const idx = currentAnnotations.tracks.findIndex(t => t && (t.id === tr.id || t._trackNumber === tr._trackNumber || t._clientID === tr._clientID));
                if (idx >= 0) {
                    currentAnnotations.tracks[idx] = tr;
                } else {
                    currentAnnotations.tracks.push(tr);
                }
            }
        }
        if (!tr) {
            await napDuLieuBanDau();
            tr = window.thuatToanCanChinh.timTrack(currentAnnotations, trackId);
            if (!tr && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTrackLiveTuRAM === 'function') {
                tr = window.quanLyAPICVAT.layTrackLiveTuRAM(trackId);
            }
        }
        if (!tr) {
            hienToast(`❌ Không tìm thấy Track #${trackId}!`);
            return;
        }

        tr._trackNumber = parseInt(trackId, 10);
        tr._clientID = parseInt(trackId, 10);

        // Đồng bộ ngưỡng Quét Outside đã lưu từ trước
        const savedOutThreshold = parseInt(localStorage.getItem('cvat_scan_out_pts_threshold'), 10);
        const outPtsInput = document.getElementById('modal-inp-out-pts');
        if (outPtsInput && !isNaN(savedOutThreshold) && savedOutThreshold >= 1) {
            outPtsInput.value = savedOutThreshold;
        }

        if (currentCachedTrackId !== tr._trackNumber) {
            currentCachedTrackId = tr._trackNumber;
            // Giải mã lại điểm từ pcdRawBufferCache (nếu đã có) theo tâm của Track mới trong 0ms để chuyển Track mượt tức thì
            if (pcdRawBufferCache.size > 0 && Array.isArray(tr.shapes)) {
                for (const s of tr.shapes) {
                    const fn = Number(s.frame);
                    if (pcdRawBufferCache.has(fn) && s.points && s.points.length >= 3) {
                        const pts = giaiMaPCD(pcdRawBufferCache.get(fn), [s.points[0], s.points[1], s.points[2]]);
                        if (pts && pts.length > 0) pcdFrameCache.set(fn, pts);
                    }
                }
            }
        }

        if (activeModalTrack && activeModalTrack !== tr && window.khoDuyet) {
            if (window.khoDuyet.boCho(activeModalTrack)) {
                hienToast('ℹ️ Duyệt chưa chốt đã bỏ (chưa bấm Lưu)');
            }
            if (typeof window.khoDuyet.dongPhien === 'function') {
                window.khoDuyet.dongPhien(activeModalTrack, { luu: false });
            }
        }
        dongBoBangAnhXaID(currentAnnotations);
        activeModalTrack = tr;
        if (window.khoDuyet && typeof window.khoDuyet.moPhien === 'function' && tr) {
            const ph = window.khoDuyet.moPhien(tr, tr);
            if (ph) {
                hienToast(`🔓 ID #${tr._trackNumber || tr.id} đã duyệt đang mở chỉnh — vẫn giữ Đã duyệt, bấm Lưu để cập nhật neo`);
            }
        }
        modalUndoStack = [];
        modalRedoStack = [];
        modalCanvasViewStates.clear();
        if (!options || options.preserveTopViewFrame === undefined) {
            modalFullscreenView = null;
        }
        if (options && options.preserveTopViewFrame !== undefined && options.preservedTopViewState) {
            modalCanvasViewStates.set(`${options.preserveTopViewFrame}_top`, options.preservedTopViewState);
        }
        modalOtherObjectsCache.clear();
        modalSelectedFrames.clear();
        modalLastInterpRange = "";

        if (tr.shapes) {
            for (const s of tr.shapes) {
                if (s && s.frame !== undefined) s.frame = parseInt(s.frame, 10);
            }
        }

        // Đảm bảo toàn bộ các frames (0 đến 59) được xếp liên tục từ trên xuống
        const validShapes = (tr.shapes || []).filter(s => s.points && s.points.length >= 9 && !s.outside);
        const allShapes = (tr.shapes || []).filter(s => s.points && s.points.length >= 9);
        const refShape = validShapes[0] || allShapes[0] || { points: [0, 0, 0, 0, 0, 0, 4.5, 1.9, 1.6] };

        let medL = refShape.points[6];
        let medW = refShape.points[7];
        let medH = refShape.points[8];
        let medZ = refShape.points[2];
        let medRz = refShape.points[5];

        if (validShapes.length > 0) {
            const arrL = validShapes.map(s => s.points[6]).sort((a, b) => a - b);
            const arrW = validShapes.map(s => s.points[7]).sort((a, b) => a - b);
            const arrH = validShapes.map(s => s.points[8]).sort((a, b) => a - b);
            const arrZ = validShapes.map(s => s.points[2]).sort((a, b) => a - b);
            const mid = Math.floor(arrL.length / 2);
            medL = arrL[mid]; medW = arrW[mid]; medH = arrH[mid]; medZ = arrZ[mid];
        }

        // Bảo lưu bản gốc của tr.shapes nếu Track chưa bị chỉnh sửa để tránh sinh keyframe thừa khi chỉ duyệt qua Track
        if (!tr._isDirty && !Array.isArray(tr._origShapesBackup)) {
            tr._origShapesBackup = JSON.parse(JSON.stringify(tr.shapes || []));
        }

        // [v2.5.8] Tự động mở rộng đầy đủ các frames cho Track (Track liên tục từ startFrame tới maxFrame/hết job)
        const totalJobFrames = layTongSoFrameJob();
        const existingFrames = (tr.shapes || []).map(s => Number(s.frame)).filter(fn => !isNaN(fn));
        const minFrame = existingFrames.length > 0 ? Math.min(...existingFrames) : 0;
        const hasOutsideShape = (tr.shapes || []).some(s => s && s.outside);
        const maxFrame = hasOutsideShape ? Math.max(...existingFrames) : Math.max(minFrame, totalJobFrames - 1);

        const existingShapeMap = new Map();
        for (const s of (tr.shapes || [])) {
            if (s && s.frame !== undefined && s.points && s.points.length >= 9) {
                existingShapeMap.set(Number(s.frame), s);
            }
        }

        const expandedShapes = [];
        for (let f = minFrame; f <= maxFrame; f++) {
            if (existingShapeMap.has(f)) {
                expandedShapes.push(existingShapeMap.get(f));
            } else {
                const interpShape = layShapeChoFrame(tr, f);
                if (interpShape) {
                    expandedShapes.push(interpShape);
                }
            }
        }
        tr.shapes = expandedShapes.length > 0 ? expandedShapes : (tr.shapes || []);
        tr.shapes.sort((a, b) => a.frame - b.frame);
        tr._refL = medL;
        tr._refW = medW;
        tr._refH = medH;

    function capNhatHeaderThuocTinhTrack(tr, lname) {
        const attrContainer = document.getElementById('modal-track-attr-container');
        const badgeElem = document.getElementById('modal-track-label-badge');
        if (!attrContainer || !tr) return;
        attrContainer.innerHTML = '';

        // Cho phép bấm chọn đổi cả Nhãn lớp (Label: [vehicles], [two-wheels], [pedestrian]...) ngay trên badge nếu có currentLabels
        if (badgeElem) {
            const labelEntries = currentLabels ? Object.entries(currentLabels) : [];
            if (labelEntries.length > 1) {
                badgeElem.innerHTML = '';
                badgeElem.style.padding = '0';
                badgeElem.style.border = 'none';
                badgeElem.style.background = 'transparent';
                const lblSelect = document.createElement('select');
                lblSelect.className = 'modal-attr-select';
                lblSelect.style.cssText = 'color: #38bdf8; font-weight: 800; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.45); border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer; pointer-events: auto;';
                lblSelect.title = 'Đổi nhãn (Label) của Track này';
                for (const [lid, lobj] of labelEntries) {
                    const opt = document.createElement('option');
                    opt.value = lid;
                    opt.textContent = lobj.name || lid;
                    opt.style.background = '#0f172a';
                    opt.style.color = '#f8fafc';
                    if (Number(lid) === Number(tr.label_id) || String(lobj.name).toLowerCase() === String(lname).toLowerCase()) {
                        opt.selected = true;
                    }
                    lblSelect.appendChild(opt);
                }
                lblSelect.addEventListener('mousedown', (e) => e.stopPropagation());
                lblSelect.addEventListener('click', (e) => e.stopPropagation());
                lblSelect.addEventListener('change', (e) => {
                    const newLid = Number(e.target.value);
                    const newLObj = currentLabels[newLid];
                    if (!newLObj) return;
                    tr._isDirty = true;
                    delete tr._origShapesBackup;
                    window._modalHasEditedMultipleTracks = true;
                    tr.label_id = newLid;
                    tr.attributes = [];
                    if (Array.isArray(tr.shapes)) {
                        for (const s of tr.shapes) {
                            s.attributes = [];
                        }
                    }
                    // Khởi tạo thuộc tính mặc định của nhãn mới
                    if (Array.isArray(newLObj.attributes)) {
                        for (const ad of newLObj.attributes) {
                            const defVal = ad.default_value !== undefined && ad.default_value !== '' ? String(ad.default_value) : (Array.isArray(ad.values) && ad.values.length > 0 ? String(ad.values[0]) : '');
                            if (ad.mutable) {
                                if (Array.isArray(tr.shapes)) {
                                    for (const s of tr.shapes) {
                                        s.attributes.push({ spec_id: ad.id, value: defVal });
                                    }
                                }
                            } else {
                                tr.attributes.push({ spec_id: ad.id, value: defVal });
                            }
                        }
                    }
                    if (currentAnnotations && Array.isArray(currentAnnotations.tracks)) {
                        const rawTrack = currentAnnotations.tracks.find(t => t.id === tr.id || (tr._trackNumber && t._trackNumber === tr._trackNumber));
                        if (rawTrack) {
                            rawTrack.label_id = newLid;
                            rawTrack.attributes = JSON.parse(JSON.stringify(tr.attributes));
                            if (Array.isArray(rawTrack.shapes)) {
                                for (let i = 0; i < rawTrack.shapes.length; i++) {
                                    rawTrack.shapes[i].attributes = tr.shapes[i] ? JSON.parse(JSON.stringify(tr.shapes[i].attributes || [])) : [];
                                }
                            }
                        }
                    }
                    capNhatHeaderThuocTinhTrack(tr, newLObj.name);
                    hienToast(`✅ Đã đổi nhãn Track sang ${newLObj.name}! Bấm "Áp Dụng & Lưu" để lưu lên CVAT.`);
                });
                badgeElem.appendChild(lblSelect);
            } else {
                badgeElem.textContent = lname || '3D Object';
            }
        }

        let labelDef = currentLabels ? currentLabels[tr.label_id] : null;
        let attrDefs = (labelDef && Array.isArray(labelDef.attributes) && labelDef.attributes.length > 0) ? labelDef.attributes : null;

        // Fallback thuộc tính thông minh theo tên loại nếu API chưa trả về attributes
        if (!attrDefs || attrDefs.length === 0) {
            const lnameLower = (lname || '').toLowerCase();
            if (lnameLower.includes('vehicle') || lnameLower.includes('car')) {
                attrDefs = [{
                    id: 1816,
                    name: 'type',
                    mutable: false,
                    input_type: 'select',
                    values: ['car', 'truck', 'bus', 'van', 'contruction', 'pickup', 'Trailer', 'Tricycle', 'Stroller', 'Wheelchair', 'other']
                }];
            } else if (lnameLower.includes('two-wheel') || lnameLower.includes('motor') || lnameLower.includes('bike')) {
                attrDefs = [{
                    id: 1819,
                    name: 'type',
                    mutable: false,
                    input_type: 'select',
                    values: ['motorcycle', 'bicycle']
                }];
            } else if (lnameLower.includes('pedestrian') || lnameLower.includes('person')) {
                attrDefs = [
                    { id: 1817, name: 'age', mutable: false, input_type: 'select', values: ['adult', 'child'] },
                    { id: 1818, name: 'pose', mutable: true, input_type: 'select', values: ['standing', 'sitting', 'bending'] }
                ];
            }
        }

        if (attrDefs && attrDefs.length > 0) {
            for (const ad of attrDefs) {
                const attrWrap = document.createElement('div');
                attrWrap.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; pointer-events: auto;';

                const attrLbl = document.createElement('span');
                attrLbl.style.cssText = 'color: #94a3b8; font-size: 11px; font-weight: 600;';
                attrLbl.textContent = `${ad.name || 'attr'}:`;
                attrWrap.appendChild(attrLbl);

                const select = document.createElement('select');
                select.className = 'modal-attr-select';
                select.style.cssText = 'pointer-events: auto !important; cursor: pointer !important;';
                select.setAttribute('data-spec-id', ad.id || '');
                select.setAttribute('data-attr-name', ad.name || '');

                // Chặn triệt để sự kiện mousedown/click lan lên thanh kéo thả #modal-drag-header
                select.addEventListener('mousedown', (e) => e.stopPropagation());
                select.addEventListener('click', (e) => e.stopPropagation());

                let curVal = '';
                if (Array.isArray(tr.attributes)) {
                    const existing = tr.attributes.find(a => (ad.id && Number(a.spec_id) === Number(ad.id)) || (ad.name && a.name === ad.name));
                    if (existing && existing.value !== undefined) curVal = String(existing.value);
                }
                if (curVal === '' && tr.shapes && tr.shapes.length > 0) {
                    for (const s of tr.shapes) {
                        if (Array.isArray(s.attributes)) {
                            const existing = s.attributes.find(a => (ad.id && Number(a.spec_id) === Number(ad.id)) || (ad.name && a.name === ad.name));
                            if (existing && existing.value !== undefined) { curVal = String(existing.value); break; }
                        }
                    }
                }
                if (curVal === '' && ad.default_value !== undefined && ad.default_value !== '') {
                    curVal = String(ad.default_value);
                }

                let vals = Array.isArray(ad.values) ? [...ad.values] : (typeof ad.values === 'string' ? ad.values.split('\n') : []);
                const inpType = String(ad.input_type || ad.inputType || '').toLowerCase();
                // Nếu là kiểu checkbox (ví dụ Ride_state: false/true) mà CVAT chỉ trả về ['false'], bổ sung đủ ['false', 'true']
                if (inpType === 'checkbox' || (vals.length === 1 && (String(vals[0]).toLowerCase() === 'false' || String(vals[0]).toLowerCase() === 'true'))) {
                    vals = ['false', 'true'];
                }
                if (vals.length === 0) {
                    vals = curVal !== '' ? [curVal] : ['default'];
                } else if (curVal !== '' && !vals.some(v => String(v).toLowerCase() === String(curVal).toLowerCase())) {
                    vals.unshift(curVal);
                }
                if (curVal === '' && vals.length > 0) {
                    curVal = String(vals[0]);
                }

                for (const v of vals) {
                    const opt = document.createElement('option');
                    opt.value = v;
                    opt.textContent = v;
                    opt.style.background = '#0f172a';
                    opt.style.color = '#f8fafc';
                    if (String(v).toLowerCase() === String(curVal).toLowerCase()) {
                        opt.selected = true;
                    }
                    select.appendChild(opt);
                }

                select.addEventListener('change', (e) => {
                    const newVal = String(e.target.value);
                    const specId = Number(ad.id) || 0;
                    const attrName = ad.name || '';

                    // 1. Kiểm tra vị trí lưu trữ thuộc tính (tr.attributes cho immutable, s.attributes cho mutable)
                    if (!Array.isArray(tr.attributes)) tr.attributes = [];
                    let foundInTrack = false;
                    let foundInShapes = false;

                    for (const a of tr.attributes) {
                        if ((specId && Number(a.spec_id) === specId) || (attrName && a.name === attrName)) {
                            a.value = newVal;
                            foundInTrack = true;
                        }
                    }

                    if (Array.isArray(tr.shapes)) {
                        for (const s of tr.shapes) {
                            if (!Array.isArray(s.attributes)) s.attributes = [];
                            const existingShAttr = s.attributes.find(a => (specId && Number(a.spec_id) === specId) || (attrName && a.name === attrName));
                            if (existingShAttr) {
                                existingShAttr.value = newVal;
                                foundInShapes = true;
                            }
                        }
                    }

                    if (!foundInTrack && !foundInShapes) {
                        if (ad.mutable) {
                            if (Array.isArray(tr.shapes)) {
                                for (const s of tr.shapes) {
                                    if (!Array.isArray(s.attributes)) s.attributes = [];
                                    s.attributes.push({ spec_id: specId, value: newVal });
                                }
                            }
                        } else {
                            tr.attributes.push({ spec_id: specId, value: newVal });
                        }
                    } else if (foundInShapes && Array.isArray(tr.shapes)) {
                        for (const s of tr.shapes) {
                            if (!Array.isArray(s.attributes)) s.attributes = [];
                            const existingShAttr = s.attributes.find(a => (specId && Number(a.spec_id) === specId) || (attrName && a.name === attrName));
                            if (!existingShAttr) {
                                s.attributes.push({ spec_id: specId, value: newVal });
                            }
                        }
                    }

                    // 2. Đồng bộ vào currentAnnotations.tracks
                    if (currentAnnotations && Array.isArray(currentAnnotations.tracks)) {
                        const rawTrack = currentAnnotations.tracks.find(t => t.id === tr.id || (tr._trackNumber && t._trackNumber === tr._trackNumber));
                        if (rawTrack) {
                            rawTrack.attributes = JSON.parse(JSON.stringify(tr.attributes));
                            if (Array.isArray(rawTrack.shapes) && Array.isArray(tr.shapes)) {
                                for (const rs of rawTrack.shapes) {
                                    const ms = tr.shapes.find(s => Number(s.frame) === Number(rs.frame));
                                    if (ms && Array.isArray(ms.attributes)) {
                                        rs.attributes = JSON.parse(JSON.stringify(ms.attributes));
                                    }
                                }
                            }
                        }
                    }

                    // 3. Đồng bộ tức thì lên CVAT RAM / Store (hỗ trợ cả cấu trúc Map lẫn Array của cvat-core)
                    if (window.quanLyAPICVAT) {
                        try {
                            const job = window.quanLyAPICVAT.getJobInstance();
                            if (job && job.annotations) {
                                const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
                                if (coll) {
                                    const tracks = coll.tracks || coll._tracks || [];
                                    const targetTrack = (Array.isArray(tracks) ? tracks : Object.values(tracks)).find(item => {
                                        return item.clientID === tr._trackNumber || item.serverID === tr.id || item.clientID === tr.id || item.id === tr.id;
                                    });
                                    if (targetTrack) {
                                        if (Array.isArray(targetTrack.attributes)) {
                                            targetTrack.attributes = JSON.parse(JSON.stringify(tr.attributes));
                                        } else if (targetTrack.attributes && typeof targetTrack.attributes === 'object' && specId) {
                                            targetTrack.attributes[specId] = newVal;
                                        }
                                        const tShapes = targetTrack.shapes || targetTrack._shapes || [];
                                        const shapeList = Array.isArray(tShapes) ? tShapes : Object.values(tShapes);
                                        for (const ms of shapeList) {
                                            if (ms && ms.attributes) {
                                                if (Array.isArray(ms.attributes)) {
                                                    const ex = ms.attributes.find(a => Number(a.spec_id) === specId);
                                                    if (ex) ex.value = newVal;
                                                } else if (typeof ms.attributes === 'object' && specId) {
                                                    ms.attributes[specId] = newVal;
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (errSync) {
                            console.warn("[Modal] Lỗi sync attribute sang CVAT:", errSync);
                        }
                    }

                    hienToast(`✅ Đã đổi thuộc tính: ${attrName} = ${newVal} (Đồng bộ ${tr.shapes.length} frames)`);
                });

                attrWrap.appendChild(select);
                attrContainer.appendChild(attrWrap);
            }
        }
    }

        // Cập nhật tiêu đề Modal (ô nhập Track ID) và Header Thuộc tính Track
        const lname = xacDinhNhanTrack(tr, currentLabels);
        const headerTrackInp = document.getElementById('modal-inp-header-track-id');
        const framesCountSpan = document.getElementById('modal-track-frames-count');
        if (headerTrackInp && framesCountSpan) {
            headerTrackInp.value = trackId;
            framesCountSpan.textContent = `(${tr.shapes.length} FRAMES)`;
        } else {
            const titleElem = document.getElementById('modal-track-title');
            if (titleElem) {
                titleElem.textContent = `CĂN CHỈNH CHI TIẾT TRACK #${trackId} (${tr.shapes.length} FRAMES)`;
            }
        }
        capNhatHeaderThuocTinhTrack(tr, lname);
        try {
            capNhatNutDuyet();
        } catch (errDuyet) {
            console.error('[capNhatNutDuyet]', errDuyet);
        }

        // Cập nhật nhãn cỡ điểm LiDAR đã lưu
        const lblPtInit = document.getElementById('modal-lbl-pt-size');
        if (lblPtInit) lblPtInit.textContent = `${modalLiDARPointSize.toFixed(1)}px`;

        // Hiển thị modal dialog
        const modal = document.getElementById('cvat-detail-modal');
        if (modal) {
            modal.style.display = 'flex';
            modal.classList.remove('is-transparent');
            const dlg = modal.querySelector('.cvat-modal-dialog');
            if (dlg) {
                dlg.classList.remove('is-minimized');
                dlg.style.position = '';
                dlg.style.left = '';
                dlg.style.top = '';
                dlg.style.bottom = '';
                dlg.style.right = '';
                dlg.style.margin = '';
                dlg.style.transform = '';
            }
            const btnMinReset = document.getElementById('modal-btn-minimize');
            const btnRestReset = document.getElementById('modal-btn-restore');
            if (btnMinReset) btnMinReset.style.display = 'inline-flex';
            if (btnRestReset) btnRestReset.style.display = 'none';
        }

        // Lấy trước điểm LiDAR từ Three.js RAM nếu có
        if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layDiemLiDARThreeJS === 'function') {
            const curFrame = layFrameHienTai();
            const curTargetShape = tr.shapes.find(s => s.frame === curFrame) || tr.shapes[0];
            const curCenter = curTargetShape?.points ? [curTargetShape.points[0], curTargetShape.points[1], curTargetShape.points[2]] : null;
            const pts = window.quanLyAPICVAT.layDiemLiDARThreeJS(curFrame, curCenter);
            if (pts && pts.length > 0) {
                pcdFrameCache.set(curFrame, pts);
            }
        }

        // Render toàn bộ 60 hàng liên tục từ trên xuống dưới
        // 1. Cập nhật các ô input kích thước trên modal theo frame hiện tại
        const curFrameNum = layFrameHienTai();
        const curShape = tr.shapes.find(s => s.frame === curFrameNum && !s.outside) || refShape;
        const curL = (curShape && curShape.points) ? curShape.points[6] : medL;
        const curW = (curShape && curShape.points) ? curShape.points[7] : medW;
        const curH = (curShape && curShape.points) ? curShape.points[8] : medH;

        const inpL = document.getElementById('modal-inp-size-L');
        const inpW = document.getElementById('modal-inp-size-W');
        const inpH = document.getElementById('modal-inp-size-H');
        if (inpL) inpL.value = curL.toFixed(2);
        if (inpW) inpW.value = curW.toFixed(2);
        if (inpH) inpH.value = curH.toFixed(2);

        // 2. Điền danh sách frames thực tế vào bộ chọn 🎯 Chọn Frame
        const selKeyFrame = document.getElementById('modal-sel-frame-size');
        if (selKeyFrame) {
            selKeyFrame.innerHTML = '';
            for (const s of tr.shapes) {
                const opt = document.createElement('option');
                opt.value = s.frame;
                opt.textContent = `Frame ${s.frame}${!s.outside ? ' (Active)' : ' (Outside)'}`;
                if (s.frame === curFrameNum) opt.selected = true;
                selKeyFrame.appendChild(opt);
            }
            if (!tr.shapes.some(s => s.frame === curFrameNum) && tr.shapes.length > 0) {
                const f0 = tr.shapes[0];
                selKeyFrame.value = f0.frame;
                if (f0 && f0.points && f0.points.length >= 9) {
                    if (inpL) inpL.value = f0.points[6].toFixed(2);
                    if (inpW) inpW.value = f0.points[7].toFixed(2);
                    if (inpH) inpH.value = f0.points[8].toFixed(2);
                }
            }
        }

        // 3. Cập nhật giao diện 3 nút khóa riêng lẻ L, W, H
        capNhatGiaoDienCacNutKhoaDim();

        renderCacHangModalChiTiet(false);

        // Nếu chuyển Track từ Double-Click trên View TOP của một frame cụ thể -> Giữ nguyên vị trí cuộn của frame đó trên màn hình!
        if (options && options.preserveTopViewFrame !== undefined) {
            const anchorFn = options.preserveTopViewFrame;
            modalCurrentActiveFrame = anchorFn;
            document.querySelectorAll('.frame-detail-row').forEach(r => r.classList.remove('is-current-frame'));
            const anchorRow = document.getElementById(`modal-row-frame-${anchorFn}`);
            const listContainer = document.getElementById('modal-rows-list');
            if (anchorRow && listContainer) {
                anchorRow.classList.add('is-current-frame');
                if (typeof options.anchorRowScreenTop === 'number') {
                    listContainer.scrollTop = Math.max(0, anchorRow.offsetTop - options.anchorRowScreenTop);
                } else {
                    anchorRow.scrollIntoView({ behavior: 'auto', block: 'center' });
                }
                const cTopAnchor = anchorRow.querySelector('.canvas-top');
                if (cTopAnchor) taiVeCanvasTheoFrame(cTopAnchor, 'top', anchorFn);
            }
        } else {
            // Cuộn mượt tới frame đang chọn trên CVAT
            setTimeout(() => {
                const curFn = layFrameHienTai();
                const curRow = document.getElementById(`modal-row-frame-${curFn}`);
                if (curRow) {
                    curRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 150);
        }

        // [v2.3.5] TỰ ĐỘNG NẠP TRƯỚC TOÀN BỘ LIDAR THẬT CHO TẤT CẢ FRAMES CỦA TRACK (KHÔNG CẦN BẤM GÌ!)
        const jid = layJobIdHienTai();
        if (jid && tr.shapes && tr.shapes.length > 0) {
            const missingFrames = [...new Set(tr.shapes.map(s => parseInt(s.frame, 10)).filter(fn => !isNaN(fn)))]
                .filter(fn => !pcdFrameCache.has(fn))
                .sort((a, b) => a - b);

            if (missingFrames.length > 0) {
                hienToast(`⏳ Đang tự động nạp LiDAR sắc nét cho ${missingFrames.length} frames...`);
                (async () => {
                    for (let i = 0; i < missingFrames.length; i += 6) {
                        const batch = missingFrames.slice(i, i + 6);
                        await Promise.all(batch.map(async fn => {
                            try {
                                const realPts = await taiDiemLiDARChoFrame(jid, fn);
                                if (realPts && realPts.length > 0 && !realPts._isSynthetic) {
                                    pcdFrameCache.set(fn, realPts);
                                    capNhatDiemChoHangModal(fn, realPts);
                                }
                            } catch (_) {}
                        }));
                    }
                    hienToast(`✅ Đã nạp đầy đủ dữ liệu LiDAR thực sắc nét cho toàn bộ frames!`);
                })();
            }
        }
        hienToast(`🎯 Đã mở chi tiết Track #${trackId} (${tr.shapes.length} Frames thực tế)`);
    }

    
    // =========================================================================
    // TÍNH NĂNG ĐỒNG BỘ KHUNG NHÌN NATIVE CVAT & HIỂN THỊ ĐỦ FRAMES JOB
    // =========================================================================
    let cheDoHienFullFramesJob = false;

    function layTongSoFrameJob() {
        let maxF = 0;
        if (typeof currentAnnotations !== 'undefined' && currentAnnotations?.tracks) {
            for (const tr of currentAnnotations.tracks) {
                for (const s of (tr.shapes || [])) {
                    if (s && typeof s.frame === 'number' && s.frame > maxF) maxF = s.frame;
                }
            }
        }
        try {
            const jobInst = window.quanLyAPICVAT ? window.quanLyAPICVAT.getJobInstance() : null;
            if (jobInst && jobInst.size) return Math.max(maxF + 1, jobInst.size);
            if (jobInst && typeof jobInst.stopFrame === 'number') return Math.max(maxF + 1, jobInst.stopFrame + 1);
        } catch (_) {}
        return Math.max(maxF + 1, 77);
    }

    function loiKhungDuoiCVATSangFrame(frameNum) {
        try {
            const views = window.quanLyAPICVAT ? window.quanLyAPICVAT.getAnnotationState()?.canvas?.instance?.view?.views : null;
            if (!views) {
                hienToast("⚠️ Chưa sẵn sàng 3 khung nhìn Three.js của CVAT!");
                return false;
            }
            const row = document.getElementById(`modal-row-frame-${frameNum}`);
            if (!row) return false;

            const mapping = [
                { key: 'top', sel: '.canvas-top' },
                { key: 'side', sel: '.canvas-side' },
                { key: 'front', sel: '.canvas-front' }
            ];

            let copied = 0;
            for (const m of mapping) {
                const srcCv = views[m.key]?.renderer?.domElement;
                const dstCv = row.querySelector(m.sel);
                if (srcCv && dstCv) {
                    const ctx = dstCv.getContext('2d');
                    ctx.clearRect(0, 0, dstCv.width, dstCv.height);
                    ctx.fillStyle = '#080d1a';
                    ctx.fillRect(0, 0, dstCv.width, dstCv.height);
                    ctx.drawImage(srcCv, 0, 0, dstCv.width, dstCv.height);
                    dstCv._daChupTuCVAT = true;
                    copied++;
                }
            }
            if (copied > 0) {
                hienToast(`📸 Đã lôi thành công hình chiếu gốc từ CVAT lên Frame ${frameNum}!`);
                return true;
            }
        } catch (e) {
            console.warn('[Modal 3D] Lỗi sao chép khung nhìn CVAT:', e);
            hienToast(`❌ Lỗi lôi khung nhìn: ${e.message || e}`);
        }
        return false;
    }


    /**
     * [v2.6.5+] Thuật toán nội suy & ngoại suy vị trí hộp bounding box 3D
     * Hỗ trợ 3 chế độ:
     * - In-between: Nội suy tuyến tính & SLERP góc giữa 2 frame mốc (VD: 10, 12 -> 11)
     * - Forward extrapolation: Ngoại suy tiến bằng hồi quy vận tốc tuyến tính & vận tốc góc (VD: 0-10 -> 11)
     * - Backward extrapolation: Ngoại suy lùi mượt mà ngược thời gian (VD: 5-15 -> 4, 3, 2)
     */
    /**
     * [v2.6.5+] Phân tích chuỗi khoảng frame người dùng nhập (VD: "0-10, 15, 20-25" hoặc "49-58")
     * Hỗ trợ chuẩn hóa khoảng trắng quanh dấu gạch, en-dash, em-dash, dấu phẩy, chấm phẩy.
     */
    function parseRangeInputString(str, maxFrame = 999999) {
        if (!str || typeof str !== 'string' || !str.trim()) return [];
        const normalized = str
            .replace(/[\u2013\u2014]/g, '-')
            .replace(/\s*-\s*/g, '-')
            .replace(/\s*\.\.\s*/g, '..');
        const parts = normalized.split(/[,;\s]+/);
        const res = new Set();
        for (const p of parts) {
            if (!p.trim()) continue;
            const m = p.match(/^(\d+)(?:-|\.\.)(\d+)$/);
            if (m) {
                const start = parseInt(m[1], 10);
                const end = parseInt(m[2], 10);
                const low = Math.max(0, Math.min(start, end));
                const high = Math.min(maxFrame, Math.max(start, end));
                for (let f = low; f <= high; f++) res.add(f);
            } else {
                const single = parseInt(p, 10);
                if (!isNaN(single) && single >= 0 && single <= maxFrame) {
                    res.add(single);
                }
            }
        }
        return Array.from(res).sort((a, b) => a - b);
    }
    window.parseRangeInputString = parseRangeInputString;

    /**
     * [v2.6.5 CHUẨN] Động cơ Nội suy & Ngoại suy 3D kết hợp Bù góc cua Ego-Motion & Bám cụm điểm LiDAR thực:
     * 1. Neo 100% tại frame mốc sát nhất (blend = 0) + trọng số mũ nhanh (0.65) trên 4 frames gần nhất để bắt đúng đà rẽ tức thời.
     * 2. Bù chuyển động rẽ của xe LiDAR (Co-moving Neighbor Ego-Flow): Khi xe LiDAR vào cua (như Frame 14->15 Job 1767),
     *    tự động tham chiếu độ văng ngang và góc xoay của các xe lân cận cùng chiều để dự đoán chính xác quỹ đạo cong.
     * 3. Quét tìm cụm điểm xe thực 2D (Loại trừ điểm thuộc Other Objects) + Căn mặt đường & Ép sát vách LiDAR chuẩn v2.6.5.
     */
    /**
     * [v2.6.5 CHUẨN SE(2) WORLD-STABILIZED] Động cơ Nội suy & Ngoại suy 3D Bù Chuyển Động Ego-Vehicle Toàn Cục:
     * 1. Tự động khôi phục phép biến đổi cứng 2D SE(2) (góc quay dtheta + tịnh tiến tx, ty của xe LiDAR) giữa các frames
     *    bằng RANSAC + Procrustes Kabsch Least-Squares trên toàn bộ các xe tĩnh trong cảnh.
     * 2. Đưa quỹ đạo các frame mốc của xe về Hệ Tọa Độ Thế Giới Ổn Định (World-Stabilized Frame tại targetFrame),
     *    triệt tiêu 100% sai số văng ngang (6m - 15m) khi xe LiDAR vào cua gắt tại ngã tư.
     * 3. Tự động phân biệt xe đang đỗ (Static World) và xe đang chạy (Moving World) để nội/ngoại suy chính xác.
     * 4. Dò cụm điểm LiDAR thực 2D (tự động ước lượng mặt đất cục bộ, hỗ trợ xe ở xa từ 4 điểm trở lên, loại trừ Other Objects).
     */
    function uocLuongBienDoiCanhSE2(fA, fB, allTracks, excludeTrack = null, opts = null) {
        if (!allTracks || !Array.isArray(allTracks) || fA === fB) {
            return { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        }
        const wrapAngle = (a) => {
            let res = a % (2 * Math.PI);
            if (res > Math.PI) res -= 2 * Math.PI;
            if (res < -Math.PI) res += 2 * Math.PI;
            return res;
        };

        const kho = (opts && opts.khoDuyet) || window.khoDuyet || null;
        const ptsA = [];
        const ptsB = [];
        const ptsW = [];
        for (const tr of allTracks) {
            if (!tr || tr === excludeTrack || (excludeTrack && tr.id !== undefined && tr.id === excludeTrack.id && tr._trackNumber === excludeTrack._trackNumber)) {
                continue;
            }
            let sA = null, sB = null;
            for (const s of (tr.shapes || [])) {
                if (!s || s.outside || !s.points || s.points.length < 9) continue;
                const fn = Number(s.frame);
                if (fn === fA) sA = s.points;
                else if (fn === fB) sB = s.points;
            }
            if (sA && sB) {
                ptsA.push([sA[0], sA[1], sA[5] || 0]);
                ptsB.push([sB[0], sB[1], sB[5] || 0]);
                const appBoth = Boolean(kho && kho.batNeo && kho.laDaDuyet(tr, fA, tr, null) && kho.laDaDuyet(tr, fB, tr, null));
                ptsW.push(appBoth ? 3.0 : 1.0);
            }
        }

        const n = ptsA.length;
        if (n < 2) {
            return { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        }

        let bestInliers = [];
        let bestScore = -1;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const p1 = ptsA[i], p2 = ptsA[j];
                const q1 = ptsB[i], q2 = ptsB[j];
                const dA = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
                const dB = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
                if (dA < 2.5 || Math.abs(dA - dB) > 0.40) continue;

                const angA = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                const angB = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
                const dtheta = wrapAngle(angB - angA);
                const c = Math.cos(dtheta), s = Math.sin(dtheta);
                const tx = q1[0] - (c * p1[0] - s * p1[1]);
                const ty = q1[1] - (s * p1[0] + c * p1[1]);

                const inliers = [];
                let score = 0;
                for (let k = 0; k < n; k++) {
                    const pk = ptsA[k], qk = ptsB[k];
                    const px = c * pk[0] - s * pk[1] + tx;
                    const py = s * pk[0] + c * pk[1] + ty;
                    if (Math.hypot(px - qk[0], py - qk[1]) < 0.45) {
                        inliers.push(k);
                        score += ptsW[k];
                    }
                }
                if (score > bestScore || (score === bestScore && inliers.length > bestInliers.length)) {
                    bestScore = score;
                    bestInliers = inliers;
                }
            }
        }

        if (bestInliers.length < 2) {
            return { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        }

        // Tinh chỉnh Least-Squares 2D Procrustes (Kabsch) có trọng số theo điểm neo đã duyệt
        let wSum = 0, cxA = 0, cyA = 0, cxB = 0, cyB = 0;
        for (const idx of bestInliers) {
            const w = ptsW[idx];
            wSum += w;
            cxA += w * ptsA[idx][0]; cyA += w * ptsA[idx][1];
            cxB += w * ptsB[idx][0]; cyB += w * ptsB[idx][1];
        }
        const m = bestInliers.length;
        cxA /= wSum; cyA /= wSum; cxB /= wSum; cyB /= wSum;

        let numCos = 0, numSin = 0;
        for (const idx of bestInliers) {
            const w = ptsW[idx];
            const ax = ptsA[idx][0] - cxA, ay = ptsA[idx][1] - cyA;
            const bx = ptsB[idx][0] - cxB, by = ptsB[idx][1] - cyB;
            numCos += w * (ax * bx + ay * by);
            numSin += w * (ax * by - ay * bx);
        }
        const dtheta = Math.atan2(numSin, numCos);
        const c = Math.cos(dtheta), s = Math.sin(dtheta);
        const tx = cxB - (c * cxA - s * cyA);
        const ty = cyB - (s * cxA + c * cyA);

        return { dtheta, tx, ty, inliers: m };
    }

    let _egoGraphCacheObj = { key: null, cache: null };

    function layOptsMoKhoaDuyet(track = activeModalTrack) {
        const kho = (typeof window !== 'undefined') ? window.khoDuyet : null;
        const set = new Set();
        if (!kho || !track || typeof kho.trackKey !== 'function') return { trackKeysMoKhoa: set };
        let ph = (typeof kho.layPhien === 'function') ? kho.layPhien(track) : null;
        if (!ph && typeof kho.moPhien === 'function') {
            ph = kho.moPhien(track, track);
        }
        const key = (ph && ph.key) || kho.trackKey(track);
        if (key) set.add(key);
        return { trackKeysMoKhoa: set };
    }

    function locFrameCanBaoVe(track, kho, opts = null) {
        const set = new Set();
        if (!track || !Array.isArray(track.shapes) || !kho || !kho.batNeo) return set;
        const checker = typeof kho.laKhoaChoSua === 'function'
            ? (fn) => kho.laKhoaChoSua(track, fn, track, opts)
            : (fn) => kho.laDaDuyet(track, fn, track, null);
        for (const s of track.shapes) {
            if (s && !s.outside && Array.isArray(s.points) && s.points.length >= 9 && checker(s.frame)) {
                set.add(Number(s.frame));
            }
        }
        return set;
    }

    function dongBoTrangThaiSuaSauThaoTac() {
        const kho = (typeof window !== 'undefined') ? window.khoDuyet : null;
        if (!kho || !activeModalTrack) return;
        if (typeof kho.capNhatDirtyTuTrack === 'function') {
            kho.capNhatDirtyTuTrack(activeModalTrack, activeModalTrack);
        }
        try {
            capNhatNutDuyet();
        } catch (errDuyet) {
            console.error('[capNhatNutDuyet]', errDuyet);
        }
    }

    // Đặt ở module scope để moModalChiTietTrack / chuyenTrackTrongModal luôn gọi được trực tiếp
    function capNhatNutDuyet() {
        const btnApp = document.getElementById('modal-btn-approve');
        const btnUnapp = document.getElementById('modal-btn-unapprove');
        const btnSave = document.getElementById('modal-btn-save');
        const badge = document.getElementById('modal-approve-badge');
        const kho = window.khoDuyet;
        if (!btnApp) return;
        if (!kho || !activeModalTrack) {
            btnApp.setAttribute('data-state', 'CHUA');
            btnApp.textContent = '✓ Duyệt';
            btnApp.disabled = true;
            if (btnUnapp) btnUnapp.style.display = 'none';
            if (btnSave) { btnSave.textContent = '💾 Lưu'; btnSave.classList.remove('is-pending-commit'); }
            if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
            return;
        }

        const curFn = (typeof activeModalFocusFrame !== 'undefined' && activeModalFocusFrame !== null) ? Number(activeModalFocusFrame) : layFrameHienTai();
        const info = (typeof kho.ttHienThi === 'function')
            ? kho.ttHienThi(activeModalTrack, curFn)
            : { ...kho.trangThaiTrack(activeModalTrack, curFn), ttHien: kho.trangThaiTrack(activeModalTrack, curFn).tt, dirty: false };
        const tt = info.ttHien || info.tt;
        btnApp.setAttribute('data-state', tt);
        btnApp.disabled = (info.totalValid === 0);

        if (tt === 'CHUA') {
            btnApp.textContent = '✓ Duyệt';
            if (btnUnapp) btnUnapp.style.display = 'none';
            if (btnSave) { btnSave.textContent = '💾 Lưu'; btnSave.classList.remove('is-pending-commit'); }
            if (badge) { badge.style.display = 'none'; badge.textContent = ''; }
        } else if (tt === 'CHO') {
            const pv = info.pending?.phamVi === 'frame' ? `F${info.pending.frame}` : 'Track';
            btnApp.textContent = '✓ Duyệt · chờ Lưu';
            if (btnUnapp) btnUnapp.style.display = 'none';
            if (btnSave) { btnSave.textContent = '💾 Lưu để chốt duyệt'; btnSave.classList.add('is-pending-commit'); }
            if (badge) {
                badge.style.display = 'inline-block';
                badge.textContent = `⏳ Chờ chốt (${pv})`;
                badge.style.color = '#fde68a';
                badge.style.borderColor = '#f59e0b';
            }
        } else if (tt === 'DA') {
            btnApp.textContent = '✓ Đã duyệt';
            if (btnUnapp) btnUnapp.style.display = 'inline-flex';
            if (btnSave) { btnSave.textContent = '💾 Lưu'; btnSave.classList.remove('is-pending-commit'); }
            if (badge) {
                badge.style.display = 'inline-block';
                badge.textContent = `${info.approvedCount}/${info.totalValid}f✓`;
                badge.style.color = '#86efac';
                badge.style.borderColor = '#22c55e';
            }
        } else if (tt === 'DA_DANG_SUA') {
            btnApp.textContent = '✓ Đã duyệt';
            if (btnUnapp) btnUnapp.style.display = 'inline-flex';
            if (btnSave) { btnSave.textContent = '💾 Lưu & cập nhật'; btnSave.classList.add('is-pending-commit'); }
            if (badge) {
                badge.style.display = 'inline-block';
                badge.textContent = `● Đã sửa · nhớ Lưu`;
                badge.style.color = '#67e8f9';
                badge.style.borderColor = '#22d3ee';
            }
        } else {
            btnApp.textContent = '⚠ Duyệt lại';
            if (btnUnapp) btnUnapp.style.display = 'inline-flex';
            if (btnSave) { btnSave.textContent = '💾 Lưu'; btnSave.classList.remove('is-pending-commit'); }
            if (badge) {
                badge.style.display = 'inline-block';
                badge.textContent = `Lệch ${info.driftedCount}f`;
                badge.style.color = '#fdba74';
                badge.style.borderColor = '#fb923c';
            }
        }

        // Đồng bộ số lượng ✓ trên nút Other Objects
        const otherBtn = document.getElementById('modal-btn-toggle-other-obj');
        if (otherBtn && currentAnnotations && Array.isArray(currentAnnotations.tracks)) {
            let approvedCnt = 0;
            for (const ot of currentAnnotations.tracks) {
                if (!ot || (ot.id === activeModalTrack.id && ot._trackNumber === activeModalTrack._trackNumber)) continue;
                if (kho.laDaDuyet(ot, curFn, ot)) approvedCnt++;
            }
            otherBtn.textContent = approvedCnt > 0 ? `🎯 Other Objects (${approvedCnt}✓)` : '🎯 Other Objects';
        }
    }

    let _dangLuuModal = false;
    async function thucHienLuuVaDongModal({ giuModalMo = false } = {}) {
        if (_dangLuuModal) return false;
        _dangLuuModal = true;
        const btnSave = document.getElementById('modal-btn-save');
        if (btnSave) btnSave.disabled = true;
        try {
            let restoredFlagCount = 0;
            const tracksToCheck = [activeModalTrack, ...((currentAnnotations && currentAnnotations.tracks) || [])];
            const visitedTracks = new Set();
            for (const trk of tracksToCheck) {
                if (!trk || visitedTracks.has(trk) || !trk._outsideDangTamBo) continue;
                visitedTracks.add(trk);
                for (const s of (trk.shapes || [])) {
                    if (s && s._markedOutside && !s.outside) {
                        s.outside = true;
                        restoredFlagCount++;
                    }
                }
                trk._outsideDangTamBo = false;
            }
            if (restoredFlagCount > 0 && typeof dongBoGiaoDienNutOutside === 'function') {
                dongBoGiaoDienNutOutside();
            }

            const kho = window.khoDuyet;
            const oldTracks = Array.isArray(currentAnnotations?.tracks) ? currentAnnotations.tracks : [];
            const activeIdx = oldTracks.indexOf(activeModalTrack);
            const pendingMeta = (kho && activeModalTrack) ? kho.layCho(activeModalTrack) : null;
            const oldTrackKey = kho && activeModalTrack ? kho.trackKey(activeModalTrack) : null;
            const hadSession = Boolean(kho && oldTrackKey && typeof kho.layPhien === 'function' && kho.layPhien(oldTrackKey));

            hienToast(restoredFlagCount > 0
                ? `ℹ️ Đã tự động ẩn lại ${restoredFlagCount} frame gắn cờ Outside & đang lưu lên CVAT...`
                : "Đang lưu thay đổi lên CVAT...");
            currentAnnotations._activeTrack = activeModalTrack;
            const resData = await window.quanLyAPICVAT.luuAnnotations(currentAnnotations);
            if (resData) {
                if (Array.isArray(resData.tracks) && oldTracks.length === resData.tracks.length) {
                    for (let k = 0; k < resData.tracks.length; k++) {
                        const ot = oldTracks[k], nt = resData.tracks[k];
                        if (!ot || !nt) continue;
                        if (ot._displayId !== undefined) nt._displayId = ot._displayId;
                        if (ot._trackNumber !== undefined) nt._trackNumber = ot._trackNumber;
                        if (ot._clientID !== undefined) nt._clientID = ot._clientID;
                        if (ot._isLocked !== undefined) nt._isLocked = ot._isLocked;
                        if (ot._refL !== undefined) nt._refL = ot._refL;
                        if (ot._refW !== undefined) nt._refW = ot._refW;
                        if (ot._refH !== undefined) nt._refH = ot._refH;
                    }
                }
                currentAnnotations = resData;
            }
            capNhatThongKe();

            let trackSau = activeModalTrack;
            if (resData && Array.isArray(resData.tracks)) {
                if (activeIdx >= 0 && resData.tracks[activeIdx]) {
                    trackSau = resData.tracks[activeIdx];
                } else if (oldTrackKey && kho) {
                    trackSau = resData.tracks.find(t => kho.trackKey(t) === oldTrackKey) || activeModalTrack;
                }
                activeModalTrack = trackSau;
            }

            let committedCount = 0;
            let resyncCount = 0;
            if (kho && pendingMeta && trackSau) {
                const cRes = kho.chotDuyet(oldTrackKey || trackSau, trackSau, pendingMeta);
                if (cRes && cRes.ok) committedCount = cRes.count;
            }
            if (kho && hadSession && trackSau && typeof kho.dongBoLaiSig === 'function') {
                const sRes = kho.dongBoLaiSig(oldTrackKey || trackSau, trackSau);
                if (sRes && sRes.ok) resyncCount = sRes.count;
            }

            await window.quanLyAPICVAT.refreshView(trackSau);
            capNhatNutDuyet();

            const trackId = trackSau._trackNumber || trackSau.id;
            const inpTrack = document.getElementById('inp-track-id');
            if (inpTrack && trackSau._trackNumber) {
                inpTrack.value = trackSau._trackNumber;
            }
            docKichThuocTrackHienTai(trackId);

            if (!giuModalMo) {
                if (kho && typeof kho.dongPhien === 'function') {
                    kho.dongPhien(oldTrackKey || trackSau, { luu: false });
                }
                if (modalIntersectionObserver) {
                    modalIntersectionObserver.disconnect();
                    modalIntersectionObserver = null;
                }
                pcdFetchQueue = [];
                document.getElementById('cvat-detail-modal').style.display = 'none';
            }
            hienToast(committedCount > 0
                ? `✅ Đã Lưu & Chốt Duyệt Track #${trackId} (${committedCount} frames✓) làm neo chuẩn!`
                : (resyncCount > 0
                    ? `✅ Đã Lưu & cập nhật neo Đã duyệt Track #${trackId} (${resyncCount} frames✓)!`
                    : "✅ Đã lưu toàn bộ thay đổi và đồng bộ 3D Canvas thành công!"));
            return true;
        } catch (err) {
            hienToast("❌ Lỗi: " + err.message);
            return false;
        } finally {
            _dangLuuModal = false;
            if (btnSave) btnSave.disabled = false;
        }
    }

    function hoiXuLyPhienBanKhiRoi(track) {
        const kho = window.khoDuyet;
        if (!kho || !track || typeof kho.layPhien !== 'function') return Promise.resolve('clean');
        if (typeof kho.capNhatDirtyTuTrack === 'function') kho.capNhatDirtyTuTrack(track, track);
        const ph = kho.layPhien(track);
        if (!ph || !ph.dirty) return Promise.resolve('clean');

        if (typeof document === 'undefined' || !document.body) {
            return Promise.resolve('discarded');
        }
        return new Promise((resolve) => {
            document.getElementById('cvat-duyet-dirty-dialog')?.remove();
            const wrap = document.createElement('div');
            wrap.id = 'cvat-duyet-dirty-dialog';
            wrap.style.cssText = 'position:fixed;inset:0;z-index:100000100;background:rgba(2,6,23,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;';
            const tidShow = track._trackNumber || track.id || '';
            wrap.innerHTML = `
                <div style="background:linear-gradient(145deg,#0f172a,#1e293b);border:1px solid #22d3ee;border-radius:12px;padding:18px 20px;max-width:410px;width:92%;color:#e2e8f0;box-shadow:0 16px 40px rgba(0,0,0,0.65);font-family:'Segoe UI',sans-serif;">
                    <div style="font-size:14px;font-weight:800;color:#67e8f9;margin-bottom:8px;">● ID #${tidShow} (Đã duyệt) có chỉnh sửa chưa Lưu</div>
                    <div style="font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:14px;">Bạn muốn xử lý các thay đổi vừa chỉnh trên ID đã duyệt này như thế nào?</div>
                    <div style="display:flex;flex-direction:column;gap:8px;">
                        <button id="dlg-duyet-save" style="padding:8px 12px;border-radius:8px;border:1px solid #22c55e;background:linear-gradient(135deg,#15803d,#0284c7);color:#fff;font-weight:700;cursor:pointer;">💾 Lưu & giữ trạng thái Đã duyệt</button>
                        <button id="dlg-duyet-discard" style="padding:8px 12px;border-radius:8px;border:1px solid #f59e0b;background:rgba(217,119,6,0.22);color:#fde68a;font-weight:700;cursor:pointer;">↩ Bỏ chỉnh sửa (giữ nguyên neo cũ)</button>
                        <button id="dlg-duyet-cancel" style="padding:7px 12px;border-radius:8px;border:1px solid #475569;background:rgba(30,41,59,0.85);color:#cbd5e1;font-weight:600;cursor:pointer;">✏️ Ở lại tiếp tục sửa</button>
                    </div>
                </div>`;
            document.body.appendChild(wrap);
            const finish = (choice) => {
                wrap.remove();
                resolve(choice);
            };
            wrap.querySelector('#dlg-duyet-save')?.addEventListener('click', async () => {
                const ok = await thucHienLuuVaDongModal({ giuModalMo: true });
                if (ok) {
                    kho.dongPhien(track, { luu: false });
                    finish('saved');
                } else {
                    finish('cancel');
                }
            });
            wrap.querySelector('#dlg-duyet-discard')?.addEventListener('click', () => {
                kho.khoiPhucSnapshot(track, track);
                kho.dongPhien(track, { luu: false });
                if (typeof capNhatOInputKichThuocTuTrack === 'function') capNhatOInputKichThuocTuTrack(track);
                if (typeof renderCacHangModalChiTiet === 'function') renderCacHangModalChiTiet(true);
                finish('discarded');
            });
            wrap.querySelector('#dlg-duyet-cancel')?.addEventListener('click', () => finish('cancel'));
        });
    }

    if (typeof window !== 'undefined') {
        window._cvatModalDuyetHelpers = { locFrameCanBaoVe, layOptsMoKhoaDuyet };
    }

    function _chuanBiNguCanhNoiSuyV2(track, targetFrame, opts = null) {
        const kho = (opts && opts.khoDuyet) || window.khoDuyet || null;
        const isLockedFrame = kho && (typeof kho.laKhoaChoSua === 'function'
            ? kho.laKhoaChoSua(track, targetFrame, track, opts)
            : (kho.batNeo && kho.laDaDuyet(track, targetFrame, track, null)));
        if (isLockedFrame) {
            return { locked: true };
        }
        const NS = window.thuatToanNgoaiSuy;
        const tKeyCur = kho ? kho.trackKey(track) : null;
        const isUnlockedTrack = Boolean(tKeyCur && opts && opts.trackKeysMoKhoa && opts.trackKeysMoKhoa.has(tKeyCur));
        const excludeSelfFrame = (opts && opts.excludeSelfFrame !== undefined) ? Boolean(opts.excludeSelfFrame) : isUnlockedTrack;
        const allTrs = (typeof currentAnnotations !== 'undefined' && currentAnnotations?.tracks)
            ? currentAnnotations.tracks
            : (window.quanLyAPICVAT?.cacheAnnotations?.tracks || []);
        const layPtsFn = (fn) => (typeof pcdFrameCache !== 'undefined' && pcdFrameCache ? pcdFrameCache.get(Number(fn)) : null);
        const cacheKey = `${layJobIdHienTai() || 'j'}_${allTrs.length}_${typeof pcdFrameCache !== 'undefined' ? pcdFrameCache.size : 0}`;
        if (NS && (!_egoGraphCacheObj.cache || _egoGraphCacheObj.key !== cacheKey)) {
            _egoGraphCacheObj = {
                key: cacheKey,
                cache: NS.taoBoDemEgo(layPtsFn, allTrs, { khoDuyet: kho })
            };
        }
        const neoDuyetLib = window.NeoDuyet || null;
        let neoList = null;
        if (neoDuyetLib) {
            neoList = neoDuyetLib.thuThapNeo(allTrs, targetFrame, null, {
                gomTam: opts?.gomTam || null,
                excludeSelfFrame,
                excludeTrackKey: tKeyCur,
                excludeFrame: targetFrame
            });
        }
        return {
            locked: false,
            kho,
            tKeyCur,
            excludeSelfFrame,
            NS,
            allTrs,
            layPtsFn,
            neoDuyetLib,
            neoList
        };
    }

    function soSanhUngVien(cands) {
        if (!cands || !Array.isArray(cands.A)) return { B: null, C: null, canhBao: [] };
        const a = cands.A;
        const diffBox = (bx) => {
            if (!Array.isArray(bx) || bx.length < 9) return null;
            const dXY = Math.hypot(bx[0] - a[0], bx[1] - a[1]);
            const dZ = bx[2] - a[2];
            const dYawRad = Math.atan2(Math.sin((bx[5] || 0) - (a[5] || 0)), Math.cos((bx[5] || 0) - (a[5] || 0)));
            const dYawDeg = Math.abs(dYawRad * (180 / Math.PI));
            return {
                dXY: Number(dXY.toFixed(3)),
                dZ: Number(dZ.toFixed(3)),
                dYawDeg: Number(dYawDeg.toFixed(1))
            };
        };

        const B = diffBox(cands.B);
        const C = diffBox(cands.C);
        const canhBao = [];
        const surf = cands.meta && cands.meta.surface;
        const lidar = cands.meta && cands.meta.lidar;

        if (C && surf && !surf.boQua && Math.abs(C.dZ) > 0.30) {
            canhBao.push(`⚠ Mặt đường kéo Z lệch ${(C.dZ * 100).toFixed(0)}cm`);
        }
        if (C && surf && (surf.occ || (!surf.boQua && (surf.nDiemDat || 0) < 15))) {
            canhBao.push(`⚠ Mặt đường ít điểm (${surf.nDiemDat || 0}đ)/OCC`);
        }
        if (lidar && lidar.boQua && lidar.loai !== 'noiSuyKepGiua' && lidar.loai !== 'motMoc') {
            canhBao.push('ℹ LiDAR thiếu điểm → giữ Quỹ đạo');
        }
        return { B, C, canhBao };
    }

    function layPhienBanTrackNoiSuy(track) {
        if (!track || !Array.isArray(track.shapes)) return '0';
        const parts = [];
        for (let i = 0; i < track.shapes.length; i++) {
            const s = track.shapes[i];
            if (!s || s.outside) continue;
            const p = s.points || [];
            parts.push(`${s.frame}:${(p[0] || 0).toFixed(2)},${(p[1] || 0).toFixed(2)},${(p[2] || 0).toFixed(2)},${(p[5] || 0).toFixed(2)}`);
        }
        return `${track.shapes.length}|${parts.length}|${parts.slice(-8).join(';')}`;
    }

    function tinhToanNoiSuyDaPhuongAn(track, targetFrame, refData, rawGlobalPts = null, opts = null) {
        const frames = Object.keys(refData || {}).map(Number).sort((a, b) => a - b);
        if (frames.length === 0) return null;
        const ctx = _chuanBiNguCanhNoiSuyV2(track, targetFrame, opts);
        if (ctx.locked) return null;
        if (ctx.NS && typeof ctx.NS.tinhToanNoiSuyDaPhuongAn === 'function') {
            try {
                return ctx.NS.tinhToanNoiSuyDaPhuongAn(track, targetFrame, refData, rawGlobalPts, {
                    ...(opts || {}),
                    khoDuyet: ctx.kho,
                    allTracks: ctx.allTrs,
                    egoCache: _egoGraphCacheObj.cache,
                    layPtsFn: ctx.layPtsFn,
                    labelsMap: typeof currentLabels !== 'undefined' ? currentLabels : null,
                    thuatToanCanChinh: window.thuatToanCanChinh || null,
                    neoDuyetLib: ctx.neoDuyetLib,
                    neoList: ctx.neoList
                });
            } catch (errMulti) {
                console.warn('[NgoaiSuyDaPhuongAn] Lỗi V2, fallback V1:', errMulti);
            }
        }
        const fb = tinhToanNoiSuyBox(track, targetFrame, refData, rawGlobalPts, { ...(opts || {}), thuatToanV2: false });
        if (!fb) return null;
        return {
            A: [...fb],
            B: [...fb],
            C: (opts && opts.phuongAn && String(opts.phuongAn).includes('C')) ? [...fb] : null,
            meta: { lidar: { boQua: true, nPts: 0, gatePass: false, loai: 'fallbackV1' }, surface: null }
        };
    }

    function tinhToanNoiSuyBox(track, targetFrame, refData, rawGlobalPts = null, opts = null) {
        const frames = Object.keys(refData).map(Number).sort((a, b) => a - b);
        if (frames.length === 0) return null;

        const ctx = _chuanBiNguCanhNoiSuyV2(track, targetFrame, opts);
        if (ctx.locked) {
            return null; // Track không mở chỉnh -> frame đã duyệt là chỉ-đọc, không ghi đè
        }

        // [V2] Chuyển giao sang bộ động cơ Ngoại suy & Nội suy chuẩn CTRV + L-shape + BEV Ego Scan-Match (có fallback V1)
        const useV2 = (!opts || opts.thuatToanV2 !== false) && ctx.NS && typeof ctx.NS.tinhToanNoiSuyBoxV2 === 'function';
        if (useV2) {
            try {
                const resV2 = ctx.NS.tinhToanNoiSuyBoxV2(track, targetFrame, refData, rawGlobalPts, {
                    ...(opts || {}),
                    khoDuyet: ctx.kho,
                    allTracks: ctx.allTrs,
                    egoCache: _egoGraphCacheObj.cache,
                    layPtsFn: ctx.layPtsFn,
                    labelsMap: typeof currentLabels !== 'undefined' ? currentLabels : null,
                    thuatToanCanChinh: window.thuatToanCanChinh || null,
                    neoDuyetLib: ctx.neoDuyetLib,
                    neoList: ctx.neoList
                });
                if (resV2 && Array.isArray(resV2) && resV2.length >= 9 && resV2.every(Number.isFinite)) {
                    return resV2;
                }
            } catch (errV2) {
                console.warn('[NgoaiSuyV2] Fallback về V1:', errV2);
            }
        }
        const kho = ctx.kho;
        const excludeSelfFrame = ctx.excludeSelfFrame;

        const wrapAngle = (a) => {
            if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.wrapToPi === 'function') {
                return window.thuatToanCanChinh.wrapToPi(a);
            }
            let res = a % (2 * Math.PI);
            if (res > Math.PI) res -= 2 * Math.PI;
            if (res < -Math.PI) res += 2 * Math.PI;
            return res;
        };

        const applySE2 = (pt, se2) => {
            const c = Math.cos(se2.dtheta), s = Math.sin(se2.dtheta);
            return [
                c * pt[0] - s * pt[1] + se2.tx,
                s * pt[0] + c * pt[1] + se2.ty,
                wrapAngle(pt[2] + se2.dtheta)
            ];
        };

        const invertSE2 = (se2) => {
            const c = Math.cos(-se2.dtheta), s = Math.sin(-se2.dtheta);
            return {
                dtheta: -se2.dtheta,
                tx: -(c * se2.tx - s * se2.ty),
                ty: -(s * se2.tx + c * se2.ty),
                inliers: se2.inliers
            };
        };

        // Lấy kích thước (L, W, H) từ frame mốc gần nhất
        let nearestF = frames[0];
        let minDistF = Math.abs(targetFrame - nearestF);
        for (const f of frames) {
            const d = Math.abs(targetFrame - f);
            if (d < minDistF) {
                minDistF = d;
                nearestF = f;
            }
        }
        const nearPts = refData[nearestF];
        const refL = (nearPts && nearPts[6] > 0.2) ? nearPts[6] : ((track && track._refL) ? track._refL : 4.5);
        const refW = (nearPts && nearPts[7] > 0.2) ? nearPts[7] : ((track && track._refW) ? track._refW : 1.9);
        const refH = (nearPts && nearPts[8] > 0.2) ? nearPts[8] : ((track && track._refH) ? track._refH : 1.6);

        if (frames.length === 1) {
            const p0 = refData[frames[0]];
            return [p0[0], p0[1], p0[2], p0[3] || 0, p0[4] || 0, p0[5] || 0, refL, refW, refH];
        }

        // Unwrap chuỗi góc Yaw liên tục trên toàn bộ các frame mốc
        const unwrappedRz = {};
        let curYaw = refData[frames[0]][5] || 0;
        unwrappedRz[frames[0]] = curYaw;
        for (let i = 1; i < frames.length; i++) {
            const f = frames[i];
            const rawRz = refData[f][5] || 0;
            let dAng = wrapAngle(rawRz - curYaw);
            if (Math.abs(dAng) > 2.356) {
                const altDAng = wrapAngle(rawRz + Math.PI - curYaw);
                if (Math.abs(altDAng) < Math.abs(dAng)) dAng = altDAng;
            }
            curYaw += dAng;
            unwrappedRz[f] = curYaw;
        }

        const allTracks = (typeof currentAnnotations !== 'undefined' && currentAnnotations?.tracks)
            ? currentAnnotations.tracks
            : (window.quanLyAPICVAT?.cacheAnnotations?.tracks || []);

        let predBox = null;
        let isInterpolation = false;

        // CASE 1: NỘI SUY KẸP GIỮA (In-between Interpolation: VD 0, 2 -> 1 hoặc 10, 12 -> 11)
        if (frames[0] <= targetFrame && targetFrame <= frames[frames.length - 1]) {
            isInterpolation = true;
            if (refData[targetFrame]) return [...refData[targetFrame]];

            let prevIdx = 0;
            for (let i = 0; i < frames.length; i++) {
                if (frames[i] < targetFrame) prevIdx = i;
                else break;
            }
            const nextIdx = Math.min(frames.length - 1, prevIdx + 1);
            const prevF = frames[prevIdx];
            const nextF = frames[nextIdx];

            const p1 = refData[prevF];
            const p2 = refData[nextF];
            const span = Math.max(1, nextF - prevF);
            const t = (targetFrame - prevF) / span;

            // Ánh xạ p1 và p2 về cùng hệ tọa độ của targetFrame qua chuỗi SE(2) nếu khoảng cách <= 8 frames
            let m1 = [p1[0], p1[1], unwrappedRz[prevF]];
            let m2 = [p2[0], p2[1], unwrappedRz[nextF]];
            let hasSE2 = false;
            if (span <= 8 && allTracks.length >= 2) {
                hasSE2 = true;
                for (let f = prevF; f < targetFrame; f++) {
                    const se2 = uocLuongBienDoiCanhSE2(f, f + 1, allTracks, track);
                    if (se2.inliers < 2) { hasSE2 = false; break; }
                    m1 = applySE2(m1, se2);
                }
                if (hasSE2) {
                    for (let f = nextF - 1; f >= targetFrame; f--) {
                        const se2 = uocLuongBienDoiCanhSE2(f, f + 1, allTracks, track);
                        if (se2.inliers < 2) { hasSE2 = false; break; }
                        m2 = applySE2(m2, invertSE2(se2));
                    }
                }
            }

            let x, y, rz;
            if (hasSE2) {
                x = m1[0] + (m2[0] - m1[0]) * t;
                y = m1[1] + (m2[1] - m1[1]) * t;
                const dYaw = wrapAngle(m2[2] - m1[2]);
                rz = wrapAngle(m1[2] + dYaw * t);
            } else {
                x = p1[0] + (p2[0] - p1[0]) * t;
                y = p1[1] + (p2[1] - p1[1]) * t;
                rz = wrapAngle(unwrappedRz[prevF] + (unwrappedRz[nextF] - unwrappedRz[prevF]) * t);
            }

            const z = p1[2] + (p2[2] - p1[2]) * t;
            const rx = (p1[3] || 0) + ((p2[3] || 0) - (p1[3] || 0)) * t;
            const ry = (p1[4] || 0) + ((p2[4] || 0) - (p1[4] || 0)) * t;
            const curL = (p1[6] || refL) * (1 - t) + (p2[6] || refL) * t;
            const curW = (p1[7] || refW) * (1 - t) + (p2[7] || refW) * t;
            const curH = (p1[8] || refH) * (1 - t) + (p2[8] || refH) * t;

            predBox = [x, y, z, rx, ry, rz, curL, curW, curH];
        }
        // CASE 2 & 3: NGOẠI SUY TIẾN (Forward) HOẶC NGOẠI SUY LÙI (Backward) TRONG HỆ TỌA ĐỘ THẾ GIỚI SE(2)
        else {
            isInterpolation = false;
            const isForward = targetFrame > frames[frames.length - 1];
            const k = Math.min(frames.length, 6);
            const subFrames = isForward ? frames.slice(frames.length - k) : frames.slice(0, k);
            const anchorF = isForward ? frames[frames.length - 1] : frames[0];
            const dt = targetFrame - anchorF;

            const minF = Math.min(anchorF, targetFrame);
            const maxF = Math.max(anchorF, targetFrame);

            const stepSE2 = {};
            let se2ValidCount = 0;
            if (maxF - minF <= 25 && allTracks.length >= 2) {
                for (let f = minF; f < maxF; f++) {
                    const se2 = uocLuongBienDoiCanhSE2(f, f + 1, allTracks, track);
                    stepSE2[f] = se2;
                    if (se2.inliers >= 2) se2ValidCount++;
                }
            }

            // KIỂM TRA XE ĐỖ TĨNH DỰA TRÊN ĐỘ DỊCH TỪNG BƯỚC THỰC TẾ (CHỐNG NHẦM LẪN KHI VÀO CUA Ở XA 50M)
            const stepDisps = [];
            for (let i = 0; i < frames.length - 1; i++) {
                const fA = frames[i], fB = frames[i + 1];
                if (fB - fA === 1) {
                    const se2 = stepSE2[fA] || uocLuongBienDoiCanhSE2(fA, fB, allTracks, track);
                    if (se2 && se2.inliers >= 2) {
                        const pA = refData[fA], pB = refData[fB];
                        const pA_in_B = applySE2([pA[0], pA[1], unwrappedRz[fA] || 0], se2);
                        const disp = Math.hypot(pA_in_B[0] - pB[0], pA_in_B[1] - pB[1]);
                        stepDisps.push(disp);
                    }
                }
            }
            stepDisps.sort((a, b) => a - b);
            const medStepDisp = stepDisps.length > 0 ? stepDisps[Math.floor(stepDisps.length / 2)] : 0;
            const staticCount = stepDisps.filter(d => d < 0.38).length;
            const isStaticVehicle = (stepDisps.length === 0) || (medStepDisp < 0.40) || (stepDisps.length >= 3 && staticCount / stepDisps.length >= 0.55);

            // Tính độ cao Z từ anchor
            const zAnchor = refData[anchorF][2];
            const vz = Math.max(-0.08, Math.min(0.08, (refData[subFrames[subFrames.length - 1]][2] - refData[subFrames[0]][2]) / Math.max(1, subFrames[subFrames.length - 1] - subFrames[0])));
            const predZ = zAnchor + vz * dt;

            let predX, predY, predRz;
            if (isStaticVehicle) {
                // XE ĐỖ TĨNH: Lan truyền SE(2) trực tiếp từ anchorF tới targetFrame
                // Triệt tiêu 100% sai số hồi quy vận tốc ảo WLS làm văng box khi xe vào cua gắt
                let p = [refData[anchorF][0], refData[anchorF][1], unwrappedRz[anchorF]];
                if (anchorF < targetFrame) {
                    for (let f = anchorF; f < targetFrame; f++) {
                        if (stepSE2[f]) p = applySE2(p, stepSE2[f]);
                    }
                } else {
                    for (let f = anchorF - 1; f >= targetFrame; f--) {
                        if (stepSE2[f]) p = applySE2(p, invertSE2(stepSE2[f]));
                    }
                }
                predX = p[0];
                predY = p[1];
                predRz = wrapAngle(p[2]);
            } else {
                // XE ĐANG DI CHUYỂN THẬT: Hồi quy tuyến tính trọng số mũ (WLS) có chốt chặn trần vận tốc
                const mapToTargetWorld = (fSrc) => {
                    const rawP = refData[fSrc];
                    let p = [rawP[0], rawP[1], unwrappedRz[fSrc]];
                    if (fSrc < targetFrame) {
                        for (let f = fSrc; f < targetFrame; f++) {
                            if (stepSE2[f]) p = applySE2(p, stepSE2[f]);
                        }
                    } else if (fSrc > targetFrame) {
                        for (let f = fSrc - 1; f >= targetFrame; f--) {
                            if (stepSE2[f]) p = applySE2(p, invertSE2(stepSE2[f]));
                        }
                    }
                    return p;
                };

                const mapped = {};
                for (const f of subFrames) {
                    mapped[f] = mapToTargetWorld(f);
                }

                const unwrappedMappedYaw = {};
                let mYaw = mapped[subFrames[0]][2];
                unwrappedMappedYaw[subFrames[0]] = mYaw;
                for (let i = 1; i < subFrames.length; i++) {
                    const f = subFrames[i];
                    let dAng = wrapAngle(mapped[f][2] - mYaw);
                    if (Math.abs(dAng) > 2.356) {
                        const alt = wrapAngle(mapped[f][2] + Math.PI - mYaw);
                        if (Math.abs(alt) < Math.abs(dAng)) dAng = alt;
                    }
                    mYaw += dAng;
                    unwrappedMappedYaw[f] = mYaw;
                }

                let sumW = 0, tBar = 0, xBar = 0, yBar = 0, yawBar = 0;
                const weights = [];
                for (let i = 0; i < subFrames.length; i++) {
                    const f = subFrames[i];
                    const w = Math.exp(-0.55 * Math.abs(f - anchorF));
                    weights.push(w);
                    sumW += w;
                    tBar += w * f;
                    xBar += w * mapped[f][0];
                    yBar += w * mapped[f][1];
                    yawBar += w * unwrappedMappedYaw[f];
                }
                tBar /= sumW; xBar /= sumW; yBar /= sumW; yawBar /= sumW;

                let denom = 0, numX = 0, numY = 0, numYaw = 0;
                for (let i = 0; i < subFrames.length; i++) {
                    const f = subFrames[i];
                    const w = weights[i];
                    const d = f - tBar;
                    denom += w * d * d;
                    numX += w * d * (mapped[f][0] - xBar);
                    numY += w * d * (mapped[f][1] - yBar);
                    numYaw += w * d * (unwrappedMappedYaw[f] - yawBar);
                }
                let vx = denom > 1e-6 ? numX / denom : 0;
                let vy = denom > 1e-6 ? numY / denom : 0;
                let wz = denom > 1e-6 ? numYaw / denom : 0;
                if (Math.abs(wz) < 0.004) wz = 0;
                wz = Math.max(-0.18, Math.min(0.18, wz));

                // Giới hạn vận tốc xe di chuyển hợp lý (tối đa 1.8m/frame ~ 65km/h)
                vx = Math.max(-1.8, Math.min(1.8, vx));
                vy = Math.max(-1.8, Math.min(1.8, vy));

                predX = mapped[anchorF][0] + vx * dt;
                predY = mapped[anchorF][1] + vy * dt;
                predRz = wrapAngle(unwrappedMappedYaw[anchorF] + wz * dt);
            }

            predBox = [
                predX,
                predY,
                predZ,
                refData[anchorF][3] || 0,
                refData[anchorF][4] || 0,
                predRz,
                refL,
                refW,
                refH
            ];
        }

        // BƯỚC 4: QUÉT TÌM CỤM ĐIỂM LIDAR THỰC CỦA XE & CĂN KHÍT CHUẨN v2.6.5
        if (predBox && rawGlobalPts && rawGlobalPts.length > 5) {
            let [px, py, pz, prx, pry, prz, pL, pW, pH] = predBox;
            const hl = pL / 2, hw = pW / 2, hh = pH / 2;

            // QUAN TRỌNG: NẾU LÀ NỘI SUY (INTERPOLATION), PHÉP NỘI SUY SE(2) ĐÃ CHÍNH XÁC ĐẾN < 10cm!
            // TUYỆT ĐỐI KHÔNG DỊCH CHUYỂN XY THEO ĐẾM ĐIỂM ĐỂ TRÁNH BỊ CỤM ĐIỂM VỈA HÈ / BỜ TƯỜNG HÚT LỆCH 1.1m
            if (isInterpolation) {
                if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.canChinhMatDuongHop === 'function') {
                    const Neo = window.NeoDuyet || null;
                    const neoDuyet = Neo ? Neo.thuThapNeo(allTracks, targetFrame, null, { gomTam: opts?.gomTam || null }) : null;
                    const roadRes = window.thuatToanCanChinh.canChinhMatDuongHop([px, py, pz], [prx, pry, prz], [pL, pW, pH], rawGlobalPts, 0.06, neoDuyet ? { neoDuyet } : null);
                    if (roadRes && roadRes.newPos && Math.abs(roadRes.newPos[2] - pz) <= 0.20) {
                        predBox[2] = roadRes.newPos[2];
                    }
                }
                return predBox;
            }

            // Lấy danh sách hộp của các Other Objects trên targetFrame để loại trừ điểm của xe khác
            const otherBoxes = [];
            for (const otr of allTracks) {
                if (!otr || otr === track || (track && otr.id !== undefined && otr.id === track.id && otr._trackNumber === track._trackNumber)) continue;
                const osh = (otr.shapes || []).find(s => Number(s.frame) === Number(targetFrame) && !s.outside);
                if (osh && osh.points && osh.points.length >= 9) {
                    otherBoxes.push(osh.points);
                }
            }

            const isInsideOtherBox = (gx, gy, gz) => {
                for (let k = 0; k < otherBoxes.length; k++) {
                    const ob = otherBoxes[k];
                    const odx = gx - ob[0], ody = gy - ob[1], odz = gz - ob[2];
                    if (Math.abs(odz) > (ob[8] / 2 + 0.35)) continue;
                    const rMax = Math.max(ob[6], ob[7]) * 0.62;
                    if (Math.abs(odx) <= rMax && Math.abs(ody) <= rMax) return true;
                }
                return false;
            };

            // Lọc các điểm xung quanh vùng dự đoán không thuộc xe khác
            const searchRad = Math.max(pL, pW) + 2.5;
            const cleanGlobalPts = [];
            for (let i = 0; i < rawGlobalPts.length; i++) {
                const pt = rawGlobalPts[i];
                if (Math.abs(pt[0] - px) <= searchRad && Math.abs(pt[1] - py) <= searchRad && Math.abs(pt[2] - pz) <= 3.0) {
                    if (!isInsideOtherBox(pt[0], pt[1], pt[2])) {
                        cleanGlobalPts.push(pt);
                    }
                }
            }

            if (cleanGlobalPts.length >= 4) {
                const sortedZ = cleanGlobalPts.map(p => p[2]).sort((a, b) => a - b);
                const localGroundZ = sortedZ[Math.floor(sortedZ.length * 0.12)];
                const minBodyZ = Math.max(localGroundZ + 0.20, pz - hh + 0.15);
                const maxBodyZ = Math.min(localGroundZ + pH + 0.35, pz + hh + 0.45);

                const cosInv = Math.cos(-prz), sinInv = Math.sin(-prz);
                const bodyPtsUV = [];
                for (let i = 0; i < cleanGlobalPts.length; i++) {
                    const gx = cleanGlobalPts[i][0], gy = cleanGlobalPts[i][1], gz = cleanGlobalPts[i][2];
                    if (gz >= minBodyZ && gz <= maxBodyZ) {
                        const dx = gx - px, dy = gy - py;
                        const u = cosInv * dx - sinInv * dy;
                        const v = sinInv * dx + cosInv * dy;
                        if (Math.abs(u) <= hl + 1.2 && Math.abs(v) <= hw + 1.2) {
                            bodyPtsUV.push([u, v, gz]);
                        }
                    }
                }

                if (bodyPtsUV.length >= 4) {
                    let baseCount = 0;
                    for (let i = 0; i < bodyPtsUV.length; i++) {
                        if (Math.abs(bodyPtsUV[i][0]) <= hl + 0.08 && Math.abs(bodyPtsUV[i][1]) <= hw + 0.08) {
                            baseCount++;
                        }
                    }

                    // Với Ngoại suy: Khống chế bán kính quét tối đa 0.45m - 0.60m
                    // Tăng penalty theo baseCount để chống nhảy vào cây cối, vỉa hè
                    const maxShift = (baseCount >= 25) ? 0.30 : 0.60;
                    const penaltyWeight = Math.max(2.0, 0.08 * baseCount);

                    let bestDu = 0, bestDv = 0, bestScore = baseCount;
                    for (let du = -maxShift; du <= maxShift + 0.01; du += 0.15) {
                        for (let dv = -maxShift; dv <= maxShift + 0.01; dv += 0.15) {
                            let cnt = 0;
                            for (let i = 0; i < bodyPtsUV.length; i++) {
                                if (Math.abs(bodyPtsUV[i][0] - du) <= hl + 0.06 && Math.abs(bodyPtsUV[i][1] - dv) <= hw + 0.06) {
                                    cnt++;
                                }
                            }
                            if (cnt >= 4) {
                                const penalty = penaltyWeight * Math.hypot(du, dv);
                                const sc = cnt - penalty;
                                if (sc > bestScore + 1.2) {
                                    bestScore = sc;
                                    bestDu = du;
                                    bestDv = dv;
                                }
                            }
                        }
                    }

                    if (bestDu !== 0 || bestDv !== 0) {
                        const cosRz = Math.cos(prz), sinRz = Math.sin(prz);
                        px += cosRz * bestDu - sinRz * bestDv;
                        py += sinRz * bestDu + cosRz * bestDv;
                    }

                    // Tinh chỉnh bám mặt đường (Z) kết hợp Neo đã duyệt (+ neo tạm từ khoảng mốc ngoại suy nếu có)
                    let neoDuyet = null;
                    const Neo = window.NeoDuyet || null;
                    if (Neo) {
                        const extraTempAnchors = [];
                        const gomTam = opts?.gomTam || null;
                        if (gomTam && gomTam.frames && frames.length > 0 && (!kho || kho.batNeo)) {
                            const fTail = (targetFrame > frames[frames.length - 1]) ? frames.slice(-3) : frames.slice(0, 3);
                            for (const ft of fTail) {
                                if (!gomTam.frames.has(Number(ft))) continue;
                                const rp = refData[ft];
                                if (!rp || rp.length < 9) continue;
                                let pProj = [rp[0], rp[1], rp[5] || 0];
                                const aMin = Math.min(ft, targetFrame), aMax = Math.max(ft, targetFrame);
                                if (aMax - aMin <= 25 && allTracks.length >= 2) {
                                    for (let f = aMin; f < aMax; f++) {
                                        const se = uocLuongBienDoiCanhSE2(f, f + 1, allTracks, track, opts);
                                        if (se.inliers >= 2) pProj = (ft < targetFrame) ? applySE2(pProj, se) : applySE2(pProj, invertSE2(se));
                                    }
                                }
                                const zbT = rp[2] - (rp[8] || pH) * 0.5;
                                extraTempAnchors.push({
                                    kind: 'temp', trackId: `tmp_${ft}`, frame: targetFrame,
                                    cx: pProj[0], cy: pProj[1], rz: pProj[2],
                                    L: rp[6] || pL, W: rp[7] || pW, zb: zbT, a: 0, b: 0, sigmaZ: 0.04
                                });
                            }
                        }
                        neoDuyet = Neo.thuThapNeo(allTracks, targetFrame, null, { gomTam, extraTempAnchors });
                    }
                    if (window.thuatToanCanChinh) {
                        const tt = window.thuatToanCanChinh;
                        if (typeof tt.canChinhMatDuongHop === 'function') {
                            const hasNeoCar = Array.isArray(neoDuyet) && neoDuyet.some(n => n && n.kind !== 'ego');
                            const roadRes = tt.canChinhMatDuongHop([px, py, pz], [prx, pry, prz], [pL, pW, pH], cleanGlobalPts, 0.06, hasNeoCar ? { neoDuyet } : null);
                            if (roadRes && roadRes.newPos && Math.abs(roadRes.newPos[2] - pz) <= (hasNeoCar ? 0.65 : 0.30)) {
                                pz = roadRes.newPos[2];
                            }
                        }
                    }

                    predBox[0] = px;
                    predBox[1] = py;
                    predBox[2] = pz;
                }
            }
        } else if (predBox && window.NeoDuyet && (!kho || kho.batNeo)) {
            // Ít/thiếu điểm LiDAR ở xa: vẫn bám cao độ neo đã duyệt / duyệt tạm nếu nằm trong tầm
            const neoListFb = window.NeoDuyet.thuThapNeo(allTracks, targetFrame, null, { gomTam: opts?.gomTam || null });
            if (neoListFb.some(n => n && n.kind !== 'ego')) {
                const stFb = window.NeoDuyet.datTrangThaiNeo(neoListFb, null);
                const qFb = window.NeoDuyet.truyVanNeoChoBox(predBox[0], predBox[1], NaN, 0, stFb);
                if (qFb && qFb.valid && Number.isFinite(qFb.z)) {
                    predBox[2] = qFb.z + (predBox[8] || refH) * 0.5;
                }
            }
        }

        return predBox;
    }

    
    // =========================================================================
    // [v2.7.0] TÍNH NĂNG PHÓNG TO / THU NHỎ TOÀN MÀN HÌNH TỪNG Ô VIEW CANVAS
    // =========================================================================
    function datGiaoDienNutFullscreen(btnZoom, isFs) {
        if (!btnZoom) return;
        if (isFs) {
            btnZoom.classList.add('is-fullscreen');
            btnZoom.title = 'Thu nhỏ lại góc nhìn bình thường (Esc)';
            btnZoom.innerHTML = '<span class="fs-icon">🗗</span> <span class="fs-label" style="font-size:11px;font-weight:bold;margin-left:2px;">Thu Nhỏ</span>';
        } else {
            btnZoom.classList.remove('is-fullscreen');
            btnZoom.title = 'Phóng to ô này toàn màn hình để soi kỹ hơn';
            btnZoom.innerHTML = '<span class="fs-icon">⛶</span>';
        }
    }

    function toggleZoomViewCard(box, canvas, viewType, frameNum, btnZoom) {
        if (!box || !canvas) return;
        const isNowFullscreen = !box.classList.contains('is-fullscreen-view');

        // Đóng các ô view khác nếu đang fullscreen
        document.querySelectorAll('.row-view-card.is-fullscreen-view').forEach(curFs => {
            if (curFs !== box) {
                curFs.classList.remove('is-fullscreen-view');
                const oldBtn = curFs.querySelector('.btn-view-fullscreen');
                datGiaoDienNutFullscreen(oldBtn, false);
                const oldC = curFs.querySelector('canvas');
                if (oldC) {
                    const oldVs = layViewStateCanvas(oldC, oldC._frameNum, oldC._viewType);
                    if (oldVs) oldVs.baseScale = null;
                    taiVeCanvasTheoFrame(oldC, oldC._viewType, oldC._frameNum);
                }
            }
        });

        if (isNowFullscreen) {
            modalFullscreenView = { frameNum: Number(frameNum), viewType };
            box.classList.add('is-fullscreen-view');
            datGiaoDienNutFullscreen(btnZoom, true);
            hienToast(`🔍 Đang phóng to Frame ${frameNum} - Bấm 🗗 hoặc phím Esc để thu nhỏ`);
        } else {
            modalFullscreenView = null;
            box.classList.remove('is-fullscreen-view');
            datGiaoDienNutFullscreen(btnZoom, false);
        }

        const vs = layViewStateCanvas(canvas, frameNum, viewType);
        if (vs) vs.baseScale = null;

        requestAnimationFrame(() => {
            taiVeCanvasTheoFrame(canvas, viewType, frameNum);
        });
    }

    function ganNutZoomChoViewCard(box, canvas, viewType, frameNum) {
        if (!box || !canvas) return;
        if (viewType) box.classList.add(`view-${viewType}-card`);
        const btnZoom = document.createElement('button');
        btnZoom.type = 'button';
        btnZoom.className = 'btn-view-fullscreen';
        btnZoom.title = 'Phóng to ô này toàn màn hình để soi kỹ hơn';
        btnZoom.innerHTML = '<span class="fs-icon">⛶</span>';

        btnZoom.addEventListener('click', (ev) => {
            ev.stopPropagation();
            ev.preventDefault();
            toggleZoomViewCard(box, canvas, viewType, frameNum, btnZoom);
        });

        box.appendChild(btnZoom);
    }

    function renderCacHangModalChiTiet(preserveScroll = false) {
        const container = document.getElementById('modal-rows-list');
        if (!container || !activeModalTrack) return;

        const prevScrollTop = preserveScroll ? container.scrollTop : 0;

        // Bảo toàn trạng thái ô view đang phóng to toàn màn hình (nếu có) trước khi render lại DOM
        if (!modalFullscreenView) {
            const curFsCard = container.querySelector('.row-view-card.is-fullscreen-view');
            if (curFsCard) {
                const curFsCanvas = curFsCard.querySelector('canvas');
                const curFsRow = curFsCard.closest('.frame-detail-row');
                const fsFn = curFsCanvas?._frameNum !== undefined
                    ? Number(curFsCanvas._frameNum)
                    : parseInt(curFsRow?.getAttribute('data-frame-num') || 'NaN', 10);
                const fsVt = curFsCanvas?._viewType || (curFsCard.classList.contains('view-top-card') ? 'top' : (curFsCard.classList.contains('view-side-card') ? 'side' : 'front'));
                if (Number.isFinite(fsFn) && fsVt) {
                    modalFullscreenView = { frameNum: fsFn, viewType: fsVt };
                }
            }
        }

        // BẢO TOÀN TRẠNG THÁI LỰA CHỌN FRAME (CHỐNG TỰ ĐỘNG CHỌN CẢ KHI QUÉT OUTSIDE, UNDO, REDO...)
        const existingDomChks = container.querySelectorAll('.chk-frame-row');
        if (existingDomChks.length > 0) {
            modalSelectedFrames.clear();
            existingDomChks.forEach(chk => {
                if (chk.checked) {
                    modalSelectedFrames.add(parseInt(chk.getAttribute('data-frame'), 10));
                }
            });
        }

        container.innerHTML = '';

        const curFrameCVAT = layFrameHienTai();
        const jid = layJobIdHienTai();

        // Xây dựng danh sách frames hiển thị theo chế độ
        const shapeMap = new Map();
        for (const s of (activeModalTrack.shapes || [])) {
            if (s && s.frame !== undefined) shapeMap.set(parseInt(s.frame, 10), s);
        }

        const totalJobFrames = layTongSoFrameJob();
        const frameItems = [];

        if (cheDoHienFullFramesJob) {
            for (let f = 0; f < totalJobFrames; f++) {
                frameItems.push({ fn: f, shape: shapeMap.get(f) || null });
            }
        } else {
            const sortedShapes = [...(activeModalTrack.shapes || [])].filter(s => s && s.points && s.points.length >= 9);
            sortedShapes.sort((a, b) => a.frame - b.frame);
            for (const s of sortedShapes) {
                frameItems.push({ fn: s.frame, shape: s });
            }
        }

        for (const item of frameItems) {
            try {
                const fn = item.fn;
                const s = item.shape;

                // TRƯỜNG HỢP FRAME CHƯA CÓ BOX TRONG TRACK (KHI BẬT HIỆN FULL JOB FRAMES)
                if (!s) {
                    const emptyRow = document.createElement('div');
                    emptyRow.className = `frame-detail-row is-empty-frame ${fn === curFrameCVAT ? 'is-current-frame' : ''}`;
                    emptyRow.id = `modal-row-frame-${fn}`;
                    emptyRow.setAttribute('data-frame-num', fn);
                    emptyRow.style.opacity = '0.75';
                    emptyRow.style.borderLeft = '4px dashed #64748b';

                    const emptyMeta = document.createElement('div');
                    emptyMeta.className = 'row-meta-col';
                    emptyMeta.innerHTML = `
                        <div class="row-check-frame">
                            <span class="row-frame-badge ${fn === curFrameCVAT ? 'current' : ''}">Frame ${fn}</span>
                        </div>
                        <div class="row-status-line">
                            <span class="row-status-tag" style="background:#1e293b;color:#94a3b8;border:1px dashed #64748b;">⚪ Chưa có box</span>
                        </div>
                        <button class="btn-frame-focus" data-frame="${fn}" title="Nhảy timeline CVAT tới frame này">👁️ Xem frame</button>
                        <button class="btn-add-box-empty" data-frame="${fn}" style="background:#0284c7;color:#ffffff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;font-weight:bold;cursor:pointer;margin-top:4px;" title="Tạo box cho frame này kế thừa vị trí & kích thước chuẩn">➕ Thêm Box</button>
                    `;

                    emptyMeta.querySelector('.btn-frame-focus')?.addEventListener('click', () => {
                        chuyenFrameCVAT(fn);
                    });

                    emptyMeta.querySelector('.btn-add-box-empty')?.addEventListener('click', () => {
                        luuUndoSnapshotModal();
                        const allSorted = [...activeModalTrack.shapes].sort((a, b) => a.frame - b.frame);
                        let refS = allSorted.filter(sh => sh.frame < fn).pop() || allSorted[0];
                        if (!refS || !refS.points || refS.points.length < 9) {
                            refS = { points: [0, 0, 0, 0, 0, 0, 4.5, 1.9, 1.6] };
                        }
                        const newS = {
                            type: 'cuboid',
                            frame: fn,
                            outside: false,
                            occluded: false,
                            rotation: 0.0,
                            points: [...refS.points]
                        };
                        activeModalTrack.shapes.push(newS);
                        activeModalTrack.shapes.sort((a, b) => a.frame - b.frame);
                        renderCacHangModalChiTiet(true);
                        hienToast(`➕ Đã tạo box mới cho Frame ${fn}`);
                    });

                    emptyRow.appendChild(emptyMeta);

                    for (const vTitle of ['TOP', 'SIDE', 'FRONT']) {
                        const emptyBox = document.createElement('div');
                        emptyBox.className = 'row-view-card';
                        emptyBox.innerHTML = `
                            <div class="view-card-header" style="justify-content:center;">
                                <span class="view-title" style="color:#64748b;">${vTitle} (Chưa gán box)</span>
                            </div>
                            <div style="height:185px;display:flex;align-items:center;justify-content:center;color:#475569;font-size:11px;background:#060a14;border-radius:4px;">
                                Bấm ➕ Thêm Box để kích hoạt
                            </div>
                        `;
                        emptyRow.appendChild(emptyBox);
                    }

                    container.appendChild(emptyRow);
                    continue;
                }
            const isOut = !!s.outside;
            const isCur = (fn === curFrameCVAT);
            const [x, y, z, rx, ry, rz, L, W, H] = s.points;

            const row = document.createElement('div');
            row.className = `frame-detail-row ${isOut ? 'is-outside' : ''} ${isCur ? 'is-current-frame' : ''} ${modalSelectedFrames.has(fn) ? 'is-checked-row' : ''}`;
            row.id = `modal-row-frame-${fn}`;
            row.setAttribute('data-frame-num', fn);

            // Sinh hoặc lấy điểm LiDAR cục bộ (Ưu tiên Three.js RAM 0ms)
            let localPoints = [];
            let pts = pcdFrameCache.get(fn);
            if (!pts && fn === curFrameCVAT && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layDiemLiDARThreeJS === 'function') {
                const memPts = window.quanLyAPICVAT.layDiemLiDARThreeJS(fn, [x, y, z]);
                if (memPts && memPts.length > 0) {
                    pcdFrameCache.set(fn, memPts);
                    pts = memPts;
                }
            }

            let widePoints = [];
            if (pts && pts.length > 0) {
                localPoints = chuyenDiemSangCucBo(pts, x, y, z, rx || 0, ry || 0, rz || 0, 8.0);
                widePoints = chuyenDiemSangCucBo(pts, x, y, z, 0, 0, rz || 0, 80.0);
            }

            // [v2.4.7 LOẠI BỎ HOÀN TOÀN MÂY ĐIỂM MÔ PHỎNG GIẢ TẠO THEO YÊU CẦU CỦA KIỆT]
            // Tuyệt đối không tự ý sinh điểm đồ chơi giả tạo. Nếu frame chưa có điểm thật, giữ nguyên rỗng []
            // để người dùng bấm "Xem frame" nạp 100% điểm thật từ Three.js!
            row._localLiDARPoints = localPoints || [];
            row._wideLiDARPoints = widePoints || [];
            row._showOtherObjects = (typeof modalShowOtherObjects !== 'undefined' && modalShowOtherObjects);

            // Đếm số điểm trong hộp
            const inBoxPts = localPoints.filter(p => Math.abs(p[0]) <= L / 2 && Math.abs(p[1]) <= W / 2 && Math.abs(p[2]) <= H / 2).length;

            // 1. CỘT ĐIỀU KHIỂN BÊN TRÁI (META CONTROL COLUMN)
            const metaCol = document.createElement('div');
            metaCol.className = 'row-meta-col';
            metaCol.innerHTML = `
                <div class="row-check-frame">
                    <input type="checkbox" class="chk-frame-row" data-frame="${fn}" ${modalSelectedFrames.has(fn) ? 'checked' : ''} title="Tick chọn để tịnh tiến đồng bộ cùng các frames khác" />
                    <span class="row-frame-badge ${isCur ? 'current' : ''}">Frame ${fn}</span>
                </div>
                <div class="row-status-line">
                    <span class="row-status-tag ${isOut ? 'outside' : 'active'}">${isOut ? '🔴 Outside' : '🟢 Active'}</span>
                    <span class="pts-count-badge">${inBoxPts} pts</span>
                </div>
                <button class="btn-frame-focus" data-frame="${fn}" title="Nhảy timeline CVAT tới frame này">👁️ Xem frame</button>
                <div class="row-nudge-tools" style="margin-top: 4px;">
                    <button class="btn-nudge-mini" data-action="flip" title="Đảo đầu xe 180° tại frame này">🔄 Đảo</button>
                    <button class="btn-nudge-mini" data-action="out" title="Bật/Tắt cờ Outside">${isOut ? '✨ Bỏ Out' : '🔴 Out'}</button>
                </div>
                <div class="row-view-tools" style="margin-top: 2px; display: flex; flex-direction: column; gap: 3px;">
                    <button class="btn-nudge-mini btn-view-2d-img" data-frame="${fn}" title="Mở Ảnh 2D chuẩn hướng nhất với vị trí vật thể (Có nút chuyển đổi giữa các góc cam)">📷 Ảnh 2D</button>
                    <button class="btn-nudge-mini btn-std-view" data-frame="${fn}" title="Đặt lại góc nhìn chuẩn 1.0x, đưa tâm hộp về chính giữa khung nhìn (cả 3 view)">🎯 Standard View</button>
                    <button class="btn-nudge-mini btn-interp-frame" data-frame="${fn}" title="Nội suy vị trí hộp từ các frame mốc khác">⚡ Interpolation</button>
                    <div class="row-interp-panel" id="interp-panel-${fn}" style="display: none; margin-top: 3px; background: rgba(15, 23, 42, 0.96); border: 1px solid #38bdf8; border-radius: 4px; padding: 4px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
                        <div style="font-size: 9px; color: #94a3b8; font-weight: bold; margin-bottom: 3px; display: flex; justify-content: space-between; align-items: center;">
                            <span>🎯 Frame mốc:</span>
                            <span class="btn-close-interp" data-frame="${fn}" style="cursor: pointer; color: #ef4444; font-size: 11px; font-weight: bold; padding: 0 2px;" title="Đóng panel">✕</span>
                        </div>
                        <div style="display: flex; gap: 3px; align-items: center;">
                            <input type="text" class="inp-interp-range" data-frame="${fn}" placeholder="VD: 0-10" style="width: 58px; height: 20px; font-size: 10px; background: #0b1120; border: 1px solid #38bdf8; color: #f8fafc; border-radius: 3px; padding: 0 4px; outline: none; font-family: monospace;" />
                            <button class="btn-interp-calc" data-frame="${fn}" style="flex: 1; height: 20px; background: #0284c7; color: #fff; font-size: 9px; font-weight: bold; border: none; border-radius: 3px; cursor: pointer; padding: 0 4px;" title="Tính toán và dựng khung đỏ">Tính</button>
                        </div>
                        <div class="interp-cands-box" id="interp-cands-${fn}" style="display: none;">
                            <button class="interp-mode-btn" data-mode="A" title="Tính theo đà chạy (Quỹ đạo mốc + LiDAR BEV ego)"><span>Quỹ đạo</span><small class="interp-mode-delta">gốc</small></button>
                            <button class="interp-mode-btn" data-mode="C" title="Ép thêm độ cao Z &amp; dốc theo Mặt đường (Surface)"><span>+ Mặt đường</span><small class="interp-mode-delta">⟳</small></button>
                            <label class="interp-showall-lbl" title="Vẽ đồng thời các khung khác nhau bằng nét đứt để so sánh trên Top / Side / Front">
                                <input type="checkbox" class="chk-interp-showall" data-frame="${fn}" /> Hiện cả 2
                            </label>
                            <div class="interp-warn-txt" style="display: none;"></div>
                        </div>
                        <div class="row-interp-actions" id="interp-actions-${fn}" style="display: none; gap: 3px; margin-top: 4px;">
                            <button class="btn-interp-merge" data-frame="${fn}" style="flex: 1; height: 22px; background: #10b981; color: white; font-size: 9px; font-weight: bold; border: none; border-radius: 3px; cursor: pointer;" title="Nhập box về vị trí khung đỏ dự đoán">Merge</button>
                            <button class="btn-interp-delete" data-frame="${fn}" style="flex: 1; height: 22px; background: #ef4444; color: white; font-size: 9px; font-weight: bold; border: none; border-radius: 3px; cursor: pointer;" title="Xóa bỏ khung đỏ dự đoán">Delete</button>
                        </div>
                    </div>
                </div>
            `;

            const chkRow = metaCol.querySelector('.chk-frame-row');
            if (chkRow) {
                chkRow.addEventListener('click', (e) => {
                    const allChks = Array.from(document.querySelectorAll('.chk-frame-row'));
                    const curIdx = allChks.indexOf(e.target);
                    // Shift + Click: Chọn hoặc bỏ chọn một dải liên tục
                    if (e.shiftKey && window._modalLastCheckedIdx !== undefined && window._modalLastCheckedIdx !== -1 && curIdx !== -1) {
                        const start = Math.min(window._modalLastCheckedIdx, curIdx);
                        const end = Math.max(window._modalLastCheckedIdx, curIdx);
                        const targetState = e.target.checked;
                        for (let i = start; i <= end; i++) {
                            allChks[i].checked = targetState;
                            const fNum = parseInt(allChks[i].getAttribute('data-frame'), 10);
                            if (!isNaN(fNum)) {
                                if (targetState) modalSelectedFrames.add(fNum);
                                else modalSelectedFrames.delete(fNum);
                            }
                        }
                    }
                    window._modalLastCheckedIdx = curIdx;
                });

                chkRow.addEventListener('change', (e) => {
                    const f = parseInt(e.target.getAttribute('data-frame'), 10);
                    if (e.target.checked) modalSelectedFrames.add(f);
                    else modalSelectedFrames.delete(f);
                    capNhatTrangThaiNutChonCa();
                });
            }

            metaCol.querySelector('.btn-frame-focus')?.addEventListener('click', () => {
                // Chỉ chuyển frame trên giao diện CVAT đằng sau, KHÔNG ghi đè dữ liệu PCD bằng Three.js
                chuyenFrameCVAT(fn);
            });
            metaCol.querySelector('.btn-grab-row-cvat')?.addEventListener('click', () => {
                loiKhungDuoiCVATSangFrame(fn);
            });
            metaCol.querySelectorAll('.btn-nudge-mini[data-action]').forEach(btn => {
                btn.addEventListener('click', () => {
                    luuUndoSnapshotModal();
                    const act = btn.getAttribute('data-action');
                    if (act === 'flip') {
                        const chk = row.querySelector('.chk-frame-row');
                        const isChecked = chk ? chk.checked : true;
                        let targetFns = [];
                        if (isChecked) {
                            document.querySelectorAll('.chk-frame-row:checked').forEach(c => {
                                targetFns.push(parseInt(c.getAttribute('data-frame'), 10));
                            });
                            if (!targetFns.includes(fn)) targetFns.push(fn);
                        } else {
                            targetFns = [fn];
                        }

                        for (const targetFn of targetFns) {
                            const targetSh = activeModalTrack.shapes.find(item => item.frame === targetFn);
                            if (targetSh && targetSh.points) {
                                targetSh.points[5] = window.thuatToanCanChinh.wrapToPi(targetSh.points[5] + Math.PI);
                                if (targetSh.rotation && Array.isArray(targetSh.rotation)) {
                                    targetSh.rotation[2] = targetSh.points[5];
                                }
                                const targetRow = document.getElementById(`modal-row-frame-${targetFn}`);
                                if (targetRow) {
                                    const curRz = targetSh.points[5];
                                    const [curX, curY, curZ, curRx, curRy, , curL, curW, curH] = targetSh.points;
                                    const coordText = targetRow.querySelector('.row-coord-text');
                                    if (coordText) {
                                        coordText.innerHTML = `X:${curX.toFixed(2)} Y:${curY.toFixed(2)}<br>Z:${curZ.toFixed(2)} R:${(curRz * 180 / Math.PI).toFixed(1)}°`;
                                    }
                                    const rawPts = pcdFrameCache.get(targetFn);
                                    if (rawPts && rawPts.length > 0) {
                                        targetRow._localLiDARPoints = chuyenDiemSangCucBo(rawPts, curX, curY, curZ, curRx || 0, curRy || 0, curRz, 8.0);
                                    }
                                    const pts = targetRow._localLiDARPoints || [];
                                    const ct = targetRow.querySelector('.canvas-top');
                                    const cs = targetRow.querySelector('.canvas-side');
                                    const cf = targetRow.querySelector('.canvas-front');
                                    if (ct) veCanvasTopView(ct, curL, curW, curH, pts, 0, 0, false);
                                    if (cs) veCanvasSideView(cs, curL, curW, curH, pts, curZ, 0, 0, false);
                                    if (cf) veCanvasFrontView(cf, curL, curW, curH, pts, curZ, 0, 0, false);
                                }
                            }
                        }
                        hienToast(`🔄 Đã đảo đầu xe 180° cho ${targetFns.length} frames thành công!`);
                    } else if (act === 'out') {
                        if (s.outside) {
                            // Người dùng chủ động bỏ Outside bằng tay -> Xóa cờ vĩnh viễn
                            s.outside = false;
                            delete s._markedOutside;
                        } else {
                            // Người dùng chủ động đánh Outside bằng tay -> Gắn cờ
                            s.outside = true;
                            s._markedOutside = true;
                        }
                        row.className = `frame-detail-row ${s.outside ? 'is-outside' : ''} ${fn === curFrameCVAT ? 'is-current-frame' : ''} ${modalSelectedFrames.has(fn) ? 'is-checked-row' : ''}`;
                        const tag = row.querySelector('.row-status-tag');
                        if (tag) {
                            tag.className = `row-status-tag ${s.outside ? 'outside' : 'active'}`;
                            tag.textContent = s.outside ? '🔴 Outside' : '🟢 Active';
                        }
                        btn.textContent = s.outside ? '✨ Bỏ Out' : '🔴 Out';
                        if (typeof dongBoGiaoDienNutOutside === 'function') {
                            dongBoGiaoDienNutOutside();
                        }
                        hienToast(s.outside ? `🔴 Đã gắn Outside Frame ${fn}` : `🟢 Đã khôi phục Active Frame ${fn}`);
                    }
                });
            });

            // 2. KHUNG NHÌN TOP (CHUẨN CVAT THREE.JS NATIVE VIEW)
            const boxTop = document.createElement('div');
            boxTop.className = 'row-view-card';
            const cTop = document.createElement('canvas');
            cTop.className = 'canvas-top';
            cTop._frameNum = fn;
            cTop._viewType = 'top';
            boxTop.appendChild(cTop);
            ganNutZoomChoViewCard(boxTop, cTop, 'top', fn);
            cTop.addEventListener('mousedown', (e) => batDauKeoCanvas(e, 'top', fn));
            cTop.addEventListener('mousemove', (e) => capNhatConTroChuotCanvas(e, 'top', fn));
            cTop.addEventListener('wheel', (e) => xuLyCuonChuotZoomCanvas(e, 'top', fn), { passive: false });
            cTop.addEventListener('contextmenu', (e) => e.preventDefault());
            cTop.addEventListener('dblclick', (e) => {
                if (cTop._lastTopSwitchTs && (Date.now() - cTop._lastTopSwitchTs) < 250) return;
                const ts = typeof window !== 'undefined' ? window.thuatToanSurface : null;
                if (ts && ts.isActive && (ts.cheDoChonTrenTop || e.altKey)) return;
                const rect = cTop.getBoundingClientRect();
                const rawMx = e.clientX - rect.left;
                const rawMy = e.clientY - rect.top;
                const hitObj = timVatTheTopTaiToaDo(cTop, rawMx, rawMy, { padPx: 16 });
                if (!hitObj || !hitObj.trackId) return;
                e.preventDefault();
                e.stopPropagation();
                cTop._lastTopClickMeta = null;
                cTop._lastTopSwitchTs = Date.now();
                if (!hitObj.track) {
                    hienToast(`ℹ️ Vật thể #${hitObj.trackId} là Shape đơn lẻ (không phải Track chuỗi) nên không mở bảng Track!`);
                    return;
                }
                chuyenTrackGiuNguyenTopView(hitObj.trackId, fn, hitObj.shape);
            });

            // 3. KHUNG NHÌN SIDE (CHUẨN CVAT THREE.JS NATIVE VIEW)
            const boxSide = document.createElement('div');
            boxSide.className = 'row-view-card';
            const cSide = document.createElement('canvas');
            cSide.className = 'canvas-side';
            cSide._frameNum = fn;
            cSide._viewType = 'side';
            boxSide.appendChild(cSide);
            ganNutZoomChoViewCard(boxSide, cSide, 'side', fn);
            cSide.addEventListener('mousedown', (e) => batDauKeoCanvas(e, 'side', fn));
            cSide.addEventListener('mousemove', (e) => capNhatConTroChuotCanvas(e, 'side', fn));
            cSide.addEventListener('wheel', (e) => xuLyCuonChuotZoomCanvas(e, 'side', fn), { passive: false });
            cSide.addEventListener('contextmenu', (e) => e.preventDefault());

            // 4. KHUNG NHÌN FRONT (CHUẨN CVAT THREE.JS NATIVE VIEW)
            const boxFront = document.createElement('div');
            boxFront.className = 'row-view-card';
            const cFront = document.createElement('canvas');
            cFront.className = 'canvas-front';
            cFront._frameNum = fn;
            cFront._viewType = 'front';
            boxFront.appendChild(cFront);
            ganNutZoomChoViewCard(boxFront, cFront, 'front', fn);
            cFront.addEventListener('mousedown', (e) => batDauKeoCanvas(e, 'front', fn));
            cFront.addEventListener('mousemove', (e) => capNhatConTroChuotCanvas(e, 'front', fn));
            cFront.addEventListener('wheel', (e) => xuLyCuonChuotZoomCanvas(e, 'front', fn), { passive: false });
            cFront.addEventListener('contextmenu', (e) => e.preventDefault());

            // Gắn sự kiện nút Reset (R) khôi phục góc nhìn zoom/pan
            [boxTop, boxSide, boxFront].forEach(box => {
                const btnReset = box.querySelector('.btn-view-reset');
                btnReset?.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const vType = btnReset.getAttribute('data-view') || 'top';
                    const targetCanvas = box.querySelector('canvas');
                    if (targetCanvas) {
                        const vs = layViewStateCanvas(targetCanvas, fn, vType);
                        vs.zoom = 1.0;
                        vs.panX = 0;
                        vs.panY = 0;
                        vs.viewPitch = 0;
                        vs.viewYaw = 0;
                        vs.baseScale = null;
                        taiVeCanvasTheoFrame(targetCanvas, vType, fn);
                        hienToast(`🔄 Đã đặt lại góc nhìn ${vType.toUpperCase()} Frame ${fn}`);
                    }
                });
            });

            metaCol.querySelector('.btn-view-2d-img')?.addEventListener('click', (e) => {
                e.stopPropagation();
                moKhungXemAnh2D(fn);
            });

            metaCol.querySelector('.btn-std-view')?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isSelected = modalSelectedFrames && modalSelectedFrames.has(fn);
                const targetFns = (isSelected && modalSelectedFrames.size > 0) ? Array.from(modalSelectedFrames) : [fn];

                for (const targetFn of targetFns) {
                    for (const vt of ['top', 'side', 'front']) {
                        const key = `${targetFn}_${vt}`;
                        let vs = modalCanvasViewStates.get(key);
                        if (!vs) {
                            vs = { zoom: 1.0, panX: 0, panY: 0, viewPitch: 0, viewYaw: 0 };
                            modalCanvasViewStates.set(key, vs);
                        } else {
                            vs.zoom = 1.0;
                            vs.panX = 0;
                            vs.panY = 0;
                            vs.viewPitch = 0;
                            vs.viewYaw = 0;
                        }
                        vs.baseScale = null;
                        vs._userInteracted = false;
                    }
                    const r = document.getElementById(`modal-row-frame-${targetFn}`);
                    if (r) {
                        const ct = r.querySelector('.canvas-top');
                        const cs = r.querySelector('.canvas-side');
                        const cf = r.querySelector('.canvas-front');
                        if (ct) taiVeCanvasTheoFrame(ct, 'top', targetFn);
                        if (cs) taiVeCanvasTheoFrame(cs, 'side', targetFn);
                        if (cf) taiVeCanvasTheoFrame(cf, 'front', targetFn);
                    }
                }
                hienToast(targetFns.length > 1 ? `🎯 Đã đặt lại Standard View cho ${targetFns.length} frames đã chọn!` : `🎯 Frame ${fn}: Đã đặt lại Standard View (Góc chuẩn 2D, tâm hộp ở giữa)`);
            });

            // SỰ KIỆN NỘI SUY (INTERPOLATION) TỪNG FRAME
            const btnInterp = metaCol.querySelector('.btn-interp-frame');
            const panelInterp = metaCol.querySelector(`#interp-panel-${fn}`);
            const inpInterp = metaCol.querySelector('.inp-interp-range');
            const candsBoxInterp = metaCol.querySelector(`#interp-cands-${fn}`);
            const chkShowAllInterp = metaCol.querySelector('.chk-interp-showall');
            const warnInterp = metaCol.querySelector('.interp-warn-txt');
            const actionsInterp = metaCol.querySelector(`#interp-actions-${fn}`);

            const capNhatUIUngVienNoiSuy = () => {
                if (!candsBoxInterp) return;
                const cands = row._interpCands;
                if (!cands) {
                    candsBoxInterp.style.display = 'none';
                    return;
                }
                candsBoxInterp.style.display = 'flex';
                const cmp = row._interpCmp || soSanhUngVien(cands);
                row._interpCmp = cmp;
                const sel = row._interpSel || 'A';

                candsBoxInterp.querySelectorAll('.interp-mode-btn').forEach(btnM => {
                    const m = btnM.getAttribute('data-mode');
                    const deltaEl = btnM.querySelector('.interp-mode-delta');
                    btnM.classList.toggle('is-selected', m === sel);

                    if (m === 'A') {
                        if (deltaEl) deltaEl.textContent = 'gốc';
                    } else if (m === 'C') {
                        if (!cands.C) {
                            if (deltaEl) deltaEl.textContent = '⟳';
                            btnM.title = 'Bấm để tính thử bản ép độ cao theo Mặt đường (Surface)';
                        } else if (cands.meta?.surface?.boQua) {
                            if (deltaEl) deltaEl.textContent = '=A';
                            btnM.title = 'Mặt đường thiếu điểm đất nên giữ Z theo quỹ đạo';
                        } else if (cmp.C) {
                            const dzCm = Math.round(cmp.C.dZ * 100);
                            if (deltaEl) deltaEl.textContent = `Z${dzCm >= 0 ? '+' : ''}${dzCm}cm`;
                            btnM.title = `Lệch so với Quỹ đạo: Z=${dzCm >= 0 ? '+' : ''}${dzCm}cm, XY=${Math.round(cmp.C.dXY * 100)}cm (đất: ${cands.meta?.surface?.nDiemDat || 0} pts)`;
                        }
                    }
                });

                if (chkShowAllInterp) {
                    chkShowAllInterp.checked = Boolean(row._interpShowAll);
                }
                if (warnInterp) {
                    const warNs = (cmp.canhBao || []).filter(w => {
                        if (w.includes('LiDAR')) return false;
                        return Boolean(cands.C) && (sel === 'C' || row._interpShowAll);
                    });
                    if (warNs.length > 0) {
                        warnInterp.textContent = warNs.join(' · ');
                        warnInterp.style.display = 'block';
                    } else {
                        warnInterp.style.display = 'none';
                    }
                }
            };

            const taiLai3ViewCanvas = () => {
                for (const vt of ['top', 'side', 'front']) {
                    const c = row.querySelector(`.canvas-${vt}`);
                    if (c) taiVeCanvasTheoFrame(c, vt, fn);
                }
            };

            const tinhUngVienC = async () => {
                if (!row._interpCands || !row._interpRefData) return false;
                const curVer = layPhienBanTrackNoiSuy(activeModalTrack);
                if (row._interpTrackVer && row._interpTrackVer !== curVer) {
                    hienToast('🔄 Track đã thay đổi, đang tính lại các phương án...');
                    await thucHienTinhNoiSuy();
                    if (row._interpCands && !row._interpCands.C) {
                        return await tinhUngVienC();
                    }
                    return Boolean(row._interpCands && row._interpCands.C);
                }
                const validFrames = Object.keys(row._interpRefData).map(Number).sort((a, b) => a - b);
                const optsNoiSuyC = {
                    ...layOptsMoKhoaDuyet(activeModalTrack),
                    excludeSelfFrame: true,
                    phuongAn: 'AC'
                };
                let resC = null;
                const runC = (ctxTam) => {
                    resC = tinhToanNoiSuyDaPhuongAn(activeModalTrack, fn, row._interpRefData, row._interpRawPts || null, {
                        ...optsNoiSuyC,
                        gomTam: ctxTam
                    });
                };
                if (window.khoDuyet && typeof window.khoDuyet.voiTamThoi === 'function') {
                    await window.khoDuyet.voiTamThoi(activeModalTrack, validFrames.map(f => [f, f]), async (ctxTam) => { runC(ctxTam); });
                } else {
                    runC(null);
                }
                if (resC && resC.C) {
                    row._interpCands.C = resC.C;
                    if (!row._interpCands.meta) row._interpCands.meta = {};
                    row._interpCands.meta.surface = resC.meta ? resC.meta.surface : null;
                    row._interpCmp = soSanhUngVien(row._interpCands);
                    return true;
                }
                return false;
            };

            const goiYKhoangMocTheoMode = (mode = 'auto') => {
                if (!activeModalTrack || !activeModalTrack.shapes) return '';
                const allFns = activeModalTrack.shapes
                    .filter(item => item && !item.outside && item.points && item.points.length >= 6)
                    .map(item => Number(item.frame))
                    .filter(f => f !== fn)
                    .sort((a, b) => a - b);
                if (allFns.length === 0) return '';
                const prevFns = allFns.filter(f => f < fn);
                const nextFns = allFns.filter(f => f > fn);

                if (mode === 'prev' && prevFns.length > 0) {
                    const endP = prevFns[prevFns.length - 1];
                    const startP = Math.max(prevFns[0], endP - 10);
                    return startP === endP ? `${endP}` : `${startP}-${endP}`;
                }
                if (mode === 'next' && nextFns.length > 0) {
                    const startN = nextFns[0];
                    const endN = Math.min(nextFns[nextFns.length - 1], startN + 10);
                    return startN === endN ? `${startN}` : `${startN}-${endN}`;
                }
                if (mode === 'mid' && prevFns.length > 0 && nextFns.length > 0) {
                    return `${prevFns[prevFns.length - 1]}, ${nextFns[0]}`;
                }
                // Auto mode: Ưu tiên nhớ khoảng mốc người dùng vừa dùng trên track này
                if (modalLastInterpRange && modalLastInterpRange.trim()) {
                    return modalLastInterpRange.trim();
                }
                // Nếu ở đầu track (<= 5 frame đầu) thì ưu tiên ngoại suy lùi từ đoạn sau
                if (prevFns.length <= 2 && nextFns.length >= 2) {
                    const startN = nextFns[0];
                    const endN = Math.min(nextFns[nextFns.length - 1], startN + 10);
                    return startN === endN ? `${startN}` : `${startN}-${endN}`;
                }
                // Mặc định ưu tiên ngoại suy tiến từ đoạn trước (0-10 -> 11)
                if (prevFns.length > 0) {
                    const endP = prevFns[prevFns.length - 1];
                    const startP = Math.max(prevFns[0], endP - 10);
                    return startP === endP ? `${endP}` : `${startP}-${endP}`;
                }
                if (nextFns.length > 0) {
                    const startN = nextFns[0];
                    const endN = Math.min(nextFns[nextFns.length - 1], startN + 10);
                    return startN === endN ? `${startN}` : `${startN}-${endN}`;
                }
                return '';
            };

            const thucHienTinhNoiSuy = async () => {
                try {
                    if (!inpInterp) return;
                    const rawVal = inpInterp.value.trim();
                    if (!rawVal) {
                        hienToast(`⚠️ Vui lòng nhập khoảng frame mốc (VD: 0-10 hoặc 5-15)`);
                        return;
                    }
                    const parseFn = (typeof parseRangeInputString === 'function')
                        ? parseRangeInputString
                        : (window.parseRangeInputString || null);
                    if (!parseFn) {
                        hienToast(`❌ Không tìm thấy hàm phân tích dải frame`);
                        return;
                    }
                    const refFns = parseFn(rawVal, 999999);
                    if (!refFns || refFns.length === 0) {
                        hienToast(`⚠️ Không có frame hợp lệ trong chuỗi "${rawVal}"`);
                        return;
                    }
                    if (!activeModalTrack || !activeModalTrack.shapes) {
                        hienToast(`⚠️ Không có dữ liệu track active`);
                        return;
                    }
                    const refData = {};
                    for (const f of refFns) {
                        if (f === fn) continue; // Không lấy chính frame đang tính
                        let item = activeModalTrack.shapes.find(s => Number(s.frame) === Number(f) && !s.outside);
                        if (!item && typeof layShapeChoFrame === 'function') {
                            item = layShapeChoFrame(activeModalTrack, f);
                        }
                        if (item && !item.outside && item.points && item.points.length >= 6) {
                            refData[f] = [...item.points];
                        }
                    }
                    const validFrames = Object.keys(refData).map(Number).sort((a, b) => a - b);
                    if (validFrames.length === 0) {
                        hienToast(`⚠️ Các frames [${refFns.join(', ')}] đang Outside hoặc không có box hợp lệ!`);
                        return;
                    }

                    // Lưu lại khoảng mốc người dùng đang dùng để tiện làm liên hoàn các frame kế tiếp
                    modalLastInterpRange = rawVal;

                    // Duyệt tạm thời các frame trong khoảng mốc CHỈ cho phép suy luận này (tắt ngay khi xong trong finally)
                    let rawPts = pcdFrameCache.get(fn) || [];
                    let prelimPred = null;
                    let candsRes = null;
                    let predicted = null;
                    const optsNoiSuyBase = {
                        ...layOptsMoKhoaDuyet(activeModalTrack),
                        excludeSelfFrame: true
                    };
                    const reqPhuongAn = row._interpShowAll ? 'AC' : 'A';
                    const chayVoiCtx = (ctxTam) => {
                        prelimPred = tinhToanNoiSuyBox(activeModalTrack, fn, refData, null, { ...optsNoiSuyBase, phuongAn: 'A', gomTam: ctxTam });
                        if (!prelimPred) return;
                        if (pcdRawBufferCache.has(fn)) {
                            const buf = pcdRawBufferCache.get(fn);
                            const denseAtRed = giaiMaPCD(buf, [prelimPred[0], prelimPred[1], prelimPred[2]]);
                            if (denseAtRed && denseAtRed.length > 0) {
                                rawPts = denseAtRed;
                                pcdFrameCache.set(fn, denseAtRed);
                            }
                        }
                        candsRes = tinhToanNoiSuyDaPhuongAn(activeModalTrack, fn, refData, rawPts, {
                            ...optsNoiSuyBase,
                            phuongAn: reqPhuongAn,
                            gomTam: ctxTam
                        });
                    };
                    if (window.khoDuyet && typeof window.khoDuyet.voiTamThoi === 'function') {
                        await window.khoDuyet.voiTamThoi(activeModalTrack, validFrames.map(f => [f, f]), async (ctxTam) => {
                            chayVoiCtx(ctxTam);
                        });
                    } else {
                        chayVoiCtx(null);
                    }
                    if (!prelimPred || !candsRes || !candsRes.A) {
                        hienToast(`⚠️ Không thể nội suy vị trí cho Frame ${fn}`);
                        return;
                    }
                    const defaultSel = 'A';
                    row._interpCands = candsRes;
                    row._interpRefData = refData;
                    row._interpRawPts = rawPts;
                    row._interpTrackVer = layPhienBanTrackNoiSuy(activeModalTrack);
                    row._interpSel = defaultSel;
                    row._interpCmp = soSanhUngVien(candsRes);
                    predicted = (candsRes[defaultSel] || candsRes.A).slice();
                    row._redInterpolatedBox = predicted;
                    capNhatUIUngVienNoiSuy();
                    if (actionsInterp) {
                        actionsInterp.style.display = 'flex';
                    }

                    // Cập nhật đám mây điểm cục bộ bao phủ cả hộp trắng hiện tại lẫn khung đỏ dự đoán
                    const curPts = (s && s.points && s.points.length >= 6) ? s.points : predicted;
                    const dx = predicted[0] - curPts[0];
                    const dy = predicted[1] - curPts[1];
                    const dz = predicted[2] - curPts[2];
                    const dist3D = Math.hypot(dx, dy, dz);

                    if (rawPts && rawPts.length > 0) {
                        const reachRadius = Math.max(10.0, dist3D + 8.5);
                        row._localLiDARPoints = chuyenDiemSangCucBo(rawPts, curPts[0], curPts[1], curPts[2], curPts[3] || 0, curPts[4] || 0, curPts[5] || 0, reachRadius);
                        row._wideLiDARPoints = chuyenDiemSangCucBo(rawPts, curPts[0], curPts[1], curPts[2], curPts[3] || 0, curPts[4] || 0, curPts[5] || 0, Math.max(25.0, reachRadius + 10.0));
                    }

                    // Tự động dịch tâm camera (Auto-Pan) về phía khung đỏ nếu hộp cũ bị bay đi xa (> 1.8m)
                    // giúp người dùng nhìn thấy ngay lập tức khung đỏ đè lên điểm LiDAR mà không phải mò zoom/pan
                    const cosTrz = Math.cos(-(curPts[5] || 0));
                    const sinTrz = Math.sin(-(curPts[5] || 0));
                    const relU = cosTrz * dx - sinTrz * dy;
                    const relV = sinTrz * dx + cosTrz * dy;
                    const relW = dz;

                    for (const vt of ['top', 'side', 'front']) {
                        const c = row.querySelector(`.canvas-${vt}`);
                        if (!c) continue;
                        const vs = layViewStateCanvas(c, fn, vt);
                        if (dist3D > 4.5) {
                            const rect = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
                            const cw = (rect && rect.width > 50) ? rect.width : 320;
                            const ch = (rect && rect.height > 50) ? rect.height : 185;
                            const S0 = vs.baseScale || tinhScaleCVAT(vt, curPts[6] || 4.5, curPts[7] || 1.9, curPts[8] || 1.6, cw, ch);
                            // Nếu lệch vừa phải (<= 8m) thì nhìn cả 2 hộp; nếu hộp cũ bay quá xa (> 8m) thì tâm nhìn đặt thẳng vào khung đỏ
                            const focusWeight = dist3D > 8.0 ? 1.0 : 0.75;
                            const newZoom = dist3D > 8.0 ? 1.0 : Math.max(0.45, Math.min(1.0, 4.5 / (dist3D + 3.0)));
                            vs.zoom = newZoom;
                            const S = S0 * newZoom;
                            if (vt === 'top') {
                                vs.panX = -relU * S * focusWeight;
                                vs.panY = +relV * S * focusWeight;
                            } else if (vt === 'side') {
                                vs.panX = -relU * S * focusWeight;
                                vs.panY = +relW * S * focusWeight;
                            } else if (vt === 'front') {
                                vs.panX = -relV * S * focusWeight;
                                vs.panY = +relW * S * focusWeight;
                            }
                        }
                        taiVeCanvasTheoFrame(c, vt, fn);
                    }

                    const rangeDesc = validFrames.length > 3
                        ? `${validFrames[0]}..${validFrames[validFrames.length - 1]} (${validFrames.length} frames)`
                        : validFrames.join(', ');
                    hienToast(`⚡ Frame ${fn}: Đã dựng khung đỏ từ mốc [${rangeDesc}] (Δ=${dist3D.toFixed(2)}m)`);
                } catch (err) {
                    console.error("[Interpolation Error]", err);
                    hienToast(`❌ Lỗi nội suy: ${err.message}`);
                }
            };

            btnInterp?.addEventListener('click', (e) => {
                e.stopPropagation();
                const isVisible = panelInterp && panelInterp.style.display !== 'none';
                if (isVisible) {
                    panelInterp.style.display = 'none';
                    btnInterp.classList.remove('is-active');
                } else if (panelInterp) {
                    panelInterp.style.display = 'block';
                    btnInterp.classList.add('is-active');
                    if (inpInterp) {
                        inpInterp.focus();
                        inpInterp.select();
                    }
                }
            });

            metaCol.querySelectorAll('.btn-interp-preset').forEach(btnPre => {
                btnPre.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const mode = btnPre.getAttribute('data-mode') || 'auto';
                    const suggested = goiYKhoangMocTheoMode(mode);
                    if (inpInterp && suggested) {
                        inpInterp.value = suggested;
                        thucHienTinhNoiSuy();
                    } else {
                        hienToast(`⚠️ Không có đủ frame mốc hợp lệ cho chế độ này!`);
                    }
                });
            });

            metaCol.querySelector('.btn-close-interp')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (panelInterp) panelInterp.style.display = 'none';
                btnInterp?.classList.remove('is-active');
            });

            metaCol.querySelector('.btn-interp-calc')?.addEventListener('click', (e) => {
                e.stopPropagation();
                thucHienTinhNoiSuy();
            });

            inpInterp?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    thucHienTinhNoiSuy();
                }
            });

            candsBoxInterp?.querySelectorAll('.interp-mode-btn').forEach(btnM => {
                btnM.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const m = btnM.getAttribute('data-mode');
                    if (!m || !row._interpCands) return;
                    const curVer = layPhienBanTrackNoiSuy(activeModalTrack);
                    if (row._interpTrackVer && row._interpTrackVer !== curVer) {
                        hienToast('🔄 Track vừa thay đổi, đang tính lại...');
                        await thucHienTinhNoiSuy();
                    }
                    if (m === 'C' && (!row._interpCands || !row._interpCands.C)) {
                        await tinhUngVienC();
                    }
                    const chosen = row._interpCands ? (row._interpCands[m] || row._interpCands.A) : null;
                    if (!chosen) return;
                    row._interpSel = m;
                    row._redInterpolatedBox = chosen.slice();
                    capNhatUIUngVienNoiSuy();
                    taiLai3ViewCanvas();
                });
            });

            chkShowAllInterp?.addEventListener('change', async (e) => {
                e.stopPropagation();
                row._interpShowAll = Boolean(e.target.checked);
                if (row._interpShowAll && row._interpCands && !row._interpCands.C) {
                    await tinhUngVienC();
                }
                capNhatUIUngVienNoiSuy();
                taiLai3ViewCanvas();
            });

            // NÚT MERGE (NHẬP KHUNG VỀ VỊ TRÍ ĐỎ DỰ ĐOÁN)
            metaCol.querySelector('.btn-interp-merge')?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!row._redInterpolatedBox) {
                    hienToast(`⚠️ Chưa có khung đỏ để nhập!`);
                    return;
                }
                luuUndoSnapshotModal();
                const redBox = row._redInterpolatedBox;
                let sItem = activeModalTrack.shapes.find(item => Number(item.frame) === Number(fn));
                if (!sItem) {
                    sItem = {
                        type: 'cuboid',
                        frame: fn,
                        outside: false,
                        points: [...redBox],
                        rotation: [redBox[3], redBox[4], redBox[5]]
                    };
                    activeModalTrack.shapes.push(sItem);
                    activeModalTrack.shapes.sort((a, b) => a.frame - b.frame);
                } else {
                    sItem.points = [...redBox];
                    if (sItem.rotation && Array.isArray(sItem.rotation)) {
                        sItem.rotation[0] = redBox[3];
                        sItem.rotation[1] = redBox[4];
                        sItem.rotation[2] = redBox[5];
                    }
                    sItem.outside = false;
                }

                // Tự động mở rộng khoảng mốc nhớ tạm (modalLastInterpRange) nối tiếp frame vừa Merge
                // giúp làm ngoại suy liên hoàn (VD: 5-15 -> Merge 4 -> tự thành 4-15 cho Frame 3!)
                if (modalLastInterpRange) {
                    const mRange = modalLastInterpRange.trim().match(/^(\d+)-(\d+)$/);
                    if (mRange) {
                        const rStart = parseInt(mRange[1], 10);
                        const rEnd = parseInt(mRange[2], 10);
                        if (fn === rStart - 1) modalLastInterpRange = `${fn}-${rEnd}`;
                        else if (fn === rEnd + 1) modalLastInterpRange = `${rStart}-${fn}`;
                    }
                }

                row.className = `frame-detail-row ${fn === curFrameCVAT ? 'is-current-frame' : ''}`;
                const tag = row.querySelector('.row-status-tag');
                if (tag) {
                    tag.className = 'row-status-tag active';
                    tag.textContent = '🟢 Active';
                }
                const btnOut = row.querySelector('.btn-nudge-mini[data-action="out"]');
                if (btnOut) btnOut.textContent = '🔴 Out';

                const coordText = row.querySelector('.row-coord-text');
                if (coordText) {
                    coordText.innerHTML = `X:${redBox[0].toFixed(2)} Y:${redBox[1].toFixed(2)}<br>Z:${redBox[2].toFixed(2)} R:${(redBox[5] * 180 / Math.PI).toFixed(1)}°`;
                }

                if (pcdRawBufferCache.has(fn)) {
                    const densePts = giaiMaPCD(pcdRawBufferCache.get(fn), [redBox[0], redBox[1], redBox[2]]);
                    if (densePts && densePts.length > 0) pcdFrameCache.set(fn, densePts);
                }
                const rawPts = pcdFrameCache.get(fn);
                if (rawPts && rawPts.length > 0) {
                    row._localLiDARPoints = chuyenDiemSangCucBo(rawPts, redBox[0], redBox[1], redBox[2], redBox[3], redBox[4], redBox[5], 8.0);
                    row._wideLiDARPoints = chuyenDiemSangCucBo(rawPts, redBox[0], redBox[1], redBox[2], redBox[3], redBox[4], redBox[5], 25.0);
                }

                const inBoxPts = (row._localLiDARPoints || []).filter(p => Math.abs(p[0]) <= redBox[6] / 2 && Math.abs(p[1]) <= redBox[7] / 2 && Math.abs(p[2]) <= redBox[8] / 2).length;
                const ptsBadge = row.querySelector('.pts-count-badge');
                if (ptsBadge) ptsBadge.textContent = `${inBoxPts} pts`;

                const mergedModeName = ({ A: 'Quỹ đạo', C: '+ Mặt đường' }[row._interpSel || 'A']) || 'Dự đoán';
                row._redInterpolatedBox = null;
                row._interpCands = null;
                row._interpCmp = null;
                row._interpRefData = null;
                row._interpRawPts = null;
                if (candsBoxInterp) candsBoxInterp.style.display = 'none';
                if (actionsInterp) actionsInterp.style.display = 'none';
                if (panelInterp) panelInterp.style.display = 'none';
                btnInterp?.classList.remove('is-active');

                // Đặt lại tâm nhìn chuẩn (Standard View) cho hộp vừa Merge
                for (const vt of ['top', 'side', 'front']) {
                    const c = row.querySelector(`.canvas-${vt}`);
                    if (c) {
                        const vs = layViewStateCanvas(c, fn, vt);
                        vs.zoom = 1.0;
                        vs.panX = 0;
                        vs.panY = 0;
                        taiVeCanvasTheoFrame(c, vt, fn);
                    }
                }

                if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
                hienToast(`✅ Frame ${fn}: Đã Merge [${mergedModeName}] thành công!`);
            });

            // NÚT DELETE (XÓA BỎ KHUNG ĐỎ DỰ ĐOÁN)
            metaCol.querySelector('.btn-interp-delete')?.addEventListener('click', (e) => {
                e.stopPropagation();
                row._redInterpolatedBox = null;
                row._interpCands = null;
                row._interpCmp = null;
                row._interpRefData = null;
                row._interpRawPts = null;
                if (candsBoxInterp) candsBoxInterp.style.display = 'none';
                if (actionsInterp) actionsInterp.style.display = 'none';

                // Khôi phục tâm nhìn và bán kính điểm chuẩn quanh hộp hiện tại
                const rawPts = pcdFrameCache.get(fn);
                if (rawPts && rawPts.length > 0 && s && s.points) {
                    row._localLiDARPoints = chuyenDiemSangCucBo(rawPts, s.points[0], s.points[1], s.points[2], s.points[3] || 0, s.points[4] || 0, s.points[5] || 0, 8.0);
                }
                for (const vt of ['top', 'side', 'front']) {
                    const c = row.querySelector(`.canvas-${vt}`);
                    if (c) {
                        const vs = layViewStateCanvas(c, fn, vt);
                        vs.zoom = 1.0;
                        vs.panX = 0;
                        vs.panY = 0;
                        taiVeCanvasTheoFrame(c, vt, fn);
                    }
                }

                hienToast(`🗑️ Frame ${fn}: Đã xóa bỏ khung đỏ dự đoán`);
            });

            row.appendChild(metaCol);
            row.appendChild(boxTop);
            row.appendChild(boxSide);
            row.appendChild(boxFront);

            // [v2.3.9] Bấm chọn hàng để active và đồng bộ ngay lập tức (hỗ trợ cả mousedown và click, KHÔNG ép cuộn scroll gây giật/lệch khi kéo)
            row.addEventListener('mousedown', (ev) => {
                if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
                if (Number(modalCurrentActiveFrame) !== Number(fn)) {
                    nhayToiFrameModal(fn, false, false);
                }
            });
            row.addEventListener('click', (ev) => {
                if (ev.target.tagName === 'BUTTON' || ev.target.tagName === 'INPUT' || ev.target.tagName === 'SELECT') return;
                if (Number(modalCurrentActiveFrame) !== Number(fn)) {
                    nhayToiFrameModal(fn, false, false);
                }
            });

            // [v2.6.5 FIX CO NHỎ CANVAS KHI CLICK]: Gắn row vào DOM trước rồi mới vẽ canvas
            // Nhờ đó getBoundingClientRect đo chính xác 100% kích thước CSS thực tế ngay lần render đầu tiên
            container.appendChild(row);
            const initialTopPts = (widePoints && widePoints.length > 0) ? widePoints : localPoints;
            row._showOtherObjects = modalShowOtherObjects;
            veCanvasTopView(cTop, L, W, H, initialTopPts, 0, 0, false, 0, fn, modalShowOtherObjects);
            veCanvasSideView(cSide, L, W, H, localPoints, z);
            veCanvasFrontView(cFront, L, W, H, localPoints, z);
            } catch (errRow) {
                console.error("Lỗi render Frame:", errRow);
            }
        }

        if (preserveScroll) container.scrollTop = prevScrollTop;

        // Khôi phục ô view đang phóng to toàn màn hình (tránh bị thoát Zoom khi bấm Hạ / Auto Fit / Redraw DOM)
        let restoredFsInfo = null;
        if (modalFullscreenView) {
            const fsRow = document.getElementById(`modal-row-frame-${modalFullscreenView.frameNum}`);
            const fsCard = fsRow ? fsRow.querySelector(`.view-${modalFullscreenView.viewType}-card`) : null;
            const fsCanvas = fsCard ? fsCard.querySelector(`.canvas-${modalFullscreenView.viewType}`) : null;
            const fsBtn = fsCard ? fsCard.querySelector('.btn-view-fullscreen') : null;
            if (fsCard && fsCanvas) {
                fsCard.classList.add('is-fullscreen-view');
                datGiaoDienNutFullscreen(fsBtn, true);
                const fsVs = layViewStateCanvas(fsCanvas, modalFullscreenView.frameNum, modalFullscreenView.viewType);
                if (fsVs) fsVs.baseScale = null;
                restoredFsInfo = { canvas: fsCanvas, viewType: modalFullscreenView.viewType, frameNum: modalFullscreenView.frameNum, vs: fsVs };
            } else {
                modalFullscreenView = null;
            }
        }

        // Khởi tạo Lazy Loading LiDAR thông minh: Chỉ tải khi hàng cuộn vào viewport
        khoiTaoLazyLoadingLiDAR(container, jid);

        // Gắn listener cuộn mượt 60fps để tự động vẽ lại những hàng cuộn vào tầm nhìn (triệt tiêu lỗi đen canvas)
        if (container && !container._hasScrollRedrawListener) {
            container._hasScrollRedrawListener = true;
            let scrollPending = false;
            container.addEventListener('scroll', () => {
                if (!scrollPending) {
                    scrollPending = true;
                    requestAnimationFrame(() => {
                        scrollPending = false;
                        if (!dangKeoHoacXoayModal() && typeof veLaiTatCaHangModal === 'function') {
                            veLaiTatCaHangModal(false);
                        }
                    });
                }
            }, { passive: true });
        }

        // Đảm bảo các hàng đang hiển thị (đặc biệt Frame 0 & ô phóng to) được vẽ hoàn chỉnh khi gắn vào DOM
        requestAnimationFrame(() => {
            if (restoredFsInfo && restoredFsInfo.canvas) {
                if (restoredFsInfo.vs) restoredFsInfo.vs.baseScale = null;
                taiVeCanvasTheoFrame(restoredFsInfo.canvas, restoredFsInfo.viewType, restoredFsInfo.frameNum);
            }
            if (typeof veLaiTatCaHangModal === 'function') {
                veLaiTatCaHangModal(false);
            }
        });

        // Giữ nguyên nhãn nút Chọn Cả & Outside phản ánh đúng trạng thái thực tế sau khi render
        if (typeof capNhatTrangThaiNutChonCa === 'function') {
            capNhatTrangThaiNutChonCa();
        }
        if (typeof dongBoGiaoDienNutOutside === 'function') {
            dongBoGiaoDienNutOutside();
        }
    }

        // [v2.3.4] TỰ ĐỘNG BẮT ĐIỂM LIDAR THREE.JS KHI CVAT CHUYỂN TIMELINE FRAME
    let lastObservedCVATFrame = -1;
    function khoiTaoTheoDoiChuyenFrameCVAT() {
        try {
            const store = window.quanLyAPICVAT ? window.quanLyAPICVAT.getStore() : null;
            if (!store || typeof store.subscribe !== 'function') return;

            store.subscribe(() => {
                try {
                    const state = store.getState();
                    const curFn = state?.annotation?.player?.frame?.number;
                    if (Number.isInteger(curFn) && curFn !== lastObservedCVATFrame) {
                        lastObservedCVATFrame = curFn;
                        // [v2.5.5] Không ghi đè cache PCD bằng Three.js của CVAT để giữ độ sáng trắng bạc chuẩn xác 100%
                    }
                } catch (_) {}
            });
        } catch (_) {}
    }
function khoiTaoSuKienChinh() {
        khoiTaoTheoDoiChuyenFrameCVAT();

        // Nút Reload từ server

        document.getElementById('btn-hud-reload')?.addEventListener('click', async () => {

            try {

                hienToast("🔄 Đang nạp lại dữ liệu...");

                await napDuLieuBanDau();

            } catch (e) {

                hienToast("❌ " + e.message);

            }

        });

        // Nút mở bảng Nối Góc Cam 2D ngay cạnh Job ID
        document.getElementById('btn-hud-cam-map')?.addEventListener('click', (e) => {
            e.stopPropagation();
            moModalNoiGocCam2D();
        });

        // Nút mở bảng QC Tool kiểm định chất lượng 3D
        document.getElementById('btn-hud-qc-tool')?.addEventListener('click', (e) => {
            e.stopPropagation();
            moModalQCTool();
        });

        // Bấm trực tiếp vào Huy Hiệu Job Badge để nạp lại
        document.getElementById('hud-job-badge')?.addEventListener('click', async () => {

            try {

                hienToast("🔄 Đang thử kết nối lại và nạp dữ liệu...");

                await napDuLieuBanDau();

            } catch (e) {

                hienToast("❌ " + e.message);

            }

        });



        // NGƯỠNG ĐIỂM QUÉT OUTSIDE DÙNG CHUNG CHO MODAL CHI TIẾT TRACK
        function layNguongQuetOutHienTai() {
            const val = parseInt(localStorage.getItem('cvat_scan_out_pts_threshold'), 10);
            return (!isNaN(val) && val >= 1) ? val : 1;
        }

        function capNhatGiaoDienScanOutPop(scope, val) {
            val = Math.max(1, parseInt(val, 10) || 1);
            localStorage.setItem('cvat_scan_out_pts_threshold', val.toString());

            // Đồng bộ ô input Modal
            const mInp = document.getElementById('modal-inp-out-pts');
            if (mInp && document.activeElement !== mInp) mInp.value = val;
        }

        // NÚT "🎯 Lấy Track" TỪ CVAT
        // NÚT KHÓA TRACK TRÊN THANH HUD NGOÀI
        document.getElementById('btn-hud-lock-track')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) tid = dongBoTrackTuCVAT(false);
            if (!tid) {
                hienToast("⚠️ Vui lòng chọn 1 Track trên CVAT hoặc nhập Track ID!");
                return;
            }
            toggleKhoaTrack(tid);
        });

        // NÚT CẤU HÌNH KHÓA KÍCH THƯỚC TRÊN THANH HUD NGOÀI
        document.getElementById('btn-hud-lock-size')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) tid = dongBoTrackTuCVAT(false);
            if (!tid) {
                hienToast("⚠️ Vui lòng chọn 1 Track trên CVAT hoặc nhập Track ID!");
                return;
            }
            moPopupKhoaKichThuoc(tid);
        });

        // NÚT CĂN TRACK TỰ ĐỘNG RIÊNG LẺ TRÊN THANH HUD NGOÀI (MASTER PIPELINE)
        document.getElementById('btn-hud-can-track-don')?.addEventListener('click', async () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) tid = dongBoTrackTuCVAT(false);
            if (!tid) {
                hienToast("⚠️ Vui lòng chọn 1 Track trên CVAT hoặc nhập Track ID!");
                return;
            }

            if (!currentAnnotations) {
                currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();
            }
            let tr = window.thuatToanCanChinh ? window.thuatToanCanChinh.timTrack(currentAnnotations, tid) : null;
            if (!tr && window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTrackLiveTuRAM === 'function') {
                tr = window.quanLyAPICVAT.layTrackLiveTuRAM(tid);
            }
            if (!tr) {
                currentAnnotations = await window.quanLyAPICVAT.taiAnnotations(true);
                tr = window.thuatToanCanChinh ? window.thuatToanCanChinh.timTrack(currentAnnotations, tid) : null;
            }
            if (!tr) {
                hienToast(`⚠️ Không tìm thấy Track #${tid}!`);
                return;
            }

            if (laTrackBiKhoa(tr)) {
                hienToast(`⚠️ Track #${tid} đang được KHÓA BẢO VỆ CHỈNH TAY! Vui lòng mở khóa trước nếu muốn thuật toán can thiệp.`);
                return;
            }

            const jid = layJobIdTuUrl();
            const activeShapes = (tr.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
            const missing = [...new Set(activeShapes.map(s => parseInt(s.frame, 10)).filter(fn => !isNaN(fn)))]
                .filter(fn => !pcdFrameCache.has(fn));

            if (missing.length > 0) {
                hienToast(`⏳ Đang nạp LiDAR cho ${missing.length} frames...`);
                for (let i = 0; i < missing.length; i += 6) {
                    const batch = missing.slice(i, i + 6);
                    await Promise.all(batch.map(fn => taiDiemLiDARChoFrame(jid, fn)));
                }
            }

            await thucThiVaLuu(`Tự động căn chỉnh Track #${tid}`, (anno) => {
                const trTarget = window.thuatToanCanChinh.timTrack(anno, tid);
                const lname = xacDinhNhanTrack(trTarget, currentLabels);
                const nbDict = taoNeighborBoxesChoTrack(trTarget, null, anno);
                return window.thuatToanCanChinh.canChinhTrackV2(trTarget, lname, pcdFrameCache, typeof currentScanScale !== 'undefined' ? currentScanScale : 1.0, null, nbDict);
            }, true);
        });

        // NÚT KHÓA TRACK TRONG FLOATING QUICK BADGE
        document.getElementById('quick-badge-btn-lock-track')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            const tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (tid) toggleKhoaTrack(tid);
        });

        // NÚT KHÓA SIZE TRONG FLOATING QUICK BADGE
        document.getElementById('quick-badge-btn-lock-size')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            const tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (tid) moPopupKhoaKichThuoc(tid);
        });

        // NÚT ĐÓNG POPUP BÁO CÁO HOÀN TẤT
        document.getElementById('finish-report-btn-close')?.addEventListener('click', () => {
            const m = document.getElementById('cvat-finish-report-modal');
            if (m) m.style.display = 'none';
        });

        document.getElementById('btn-lay-track-hien-tai')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            const tid = inp ? parseInt(inp.value, 10) : null;
            const synced = dongBoTrackTuCVAT(true);
            if (tid) {
                kichHoatTrackSangCVAT(tid);
            }
        });

        // LẮNG NGHE THAY ĐỔI INPUT TRACK ID
        const inpTrackIdElem = document.getElementById('inp-track-id');
        if (inpTrackIdElem) {
            let debounceTimer = null;
            const onTrackChange = (immediate = false) => {
                const tid = parseInt(inpTrackIdElem.value, 10);
                if (tid && !isNaN(tid)) {
                    selectedTrackId = tid;
                    docKichThuocTrackHienTai(tid);
                    if (immediate) {
                        kichHoatTrackSangCVAT(tid);
                    } else {
                        clearTimeout(debounceTimer);
                        debounceTimer = setTimeout(() => {
                            kichHoatTrackSangCVAT(tid);
                        }, 350);
                    }
                }
            };
            inpTrackIdElem.addEventListener('input', () => onTrackChange(false));
            inpTrackIdElem.addEventListener('change', () => onTrackChange(true));
            inpTrackIdElem.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    onTrackChange(true);
                }
            });
        }

        // LẮNG NGHE POINTERUP TOÀN CỤC ĐỂ ĐỒNG BỘ 0MS KHI CLICK 3D CANVAS HOẶC SIDEBAR
        document.addEventListener('pointerup', (e) => {
            if (e.target && (e.target.closest('#cvat-detail-modal') || e.target.closest('#cvat-3d-assistant-hud') || e.target.tagName === 'INPUT')) {
                return;
            }
            setTimeout(() => dongBoTrackTuCVAT(false), 80);
        });

        // 9. NÚT MỞ MODAL CHI TIẾT TRACK
        document.getElementById('btn-mo-chi-tiet-track')?.addEventListener('click', () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) {
                tid = dongBoTrackTuCVAT(false);
            }
            if (!tid) {
                hienToast("⚠️ Vui lòng nhập hoặc chọn Track ID!");
                return;
            }
            moModalChiTietTrack(tid);
        });



        // ĐỒNG BỘ TRACK ĐƠN
        document.getElementById('btn-dong-bo-track-don')?.addEventListener('click', async () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) tid = dongBoTrackTuCVAT(false);
            if (!tid) { hienToast("⚠️ Vui lòng chọn 1 Track trên CVAT hoặc nhập Track ID!"); return; }

            const l = parseFloat(document.getElementById('inp-dim-l')?.value);
            const w = parseFloat(document.getElementById('inp-dim-w')?.value);
            const h = parseFloat(document.getElementById('inp-dim-h')?.value);

            await thucThiVaLuu(`Đồng bộ size Track #${tid}`, (anno) => {
                return window.thuatToanCanChinh.dongBoKichThuocTrack(anno, tid, l, w, h);
            }, true);
        });

        // ĐẢO ĐẦU XE 180°
        document.getElementById('btn-dao-dau-xe')?.addEventListener('click', async () => {
            const inp = document.getElementById('inp-track-id');
            let tid = inp ? parseInt(inp.value, 10) : selectedTrackId;
            if (!tid) tid = dongBoTrackTuCVAT(false);
            if (!tid) { hienToast("⚠️ Vui lòng chọn 1 Track trên CVAT hoặc nhập Track ID!"); return; }

            const curFrame = layFrameHienTai();
            await thucThiVaLuu(`Đảo đầu xe Track #${tid}`, (anno) => {
                return window.thuatToanCanChinh.daoDauXe180(anno, tid, curFrame);
            }, false);
        });



        // BẬT / TẮT CHẾ ĐỘ TRONG SUỐT CHO MODAL CHI TIẾT
        document.getElementById('modal-btn-toggle-other-obj')?.addEventListener('click', () => {
            toggleHienThiOtherObjects();
        });

        document.getElementById('modal-btn-edit-all-obj')?.addEventListener('click', () => {
            toggleChinhTatCaObjects();
        });

        document.getElementById('modal-btn-surface')?.addEventListener('click', () => {
            if (!window.thuatToanSurface) {
                hienToast('⚠️ Chưa nạp được mô-đun Thuật Toán Surface!');
                return;
            }
            window.thuatToanSurface.toggle({
                getJobId: () => layJobIdHienTai(),
                getCurrentFrame: () => layFrameHienTai(),
                getLiveFrame: () => layFrameHienTai(),
                getFocusFrame: () => (typeof layFrameHienTaiCuaModal === 'function' ? layFrameHienTaiCuaModal() : Number(modalCurrentActiveFrame)),
                getAnnotations: () => currentAnnotations,
                getActiveTrack: () => activeModalTrack,
                getUnlockedTrackKeys: () => layOptsMoKhoaDuyet(activeModalTrack).trackKeysMoKhoa,
                isModalOpen: () => {
                    const m = document.getElementById('cvat-detail-modal');
                    return !!(m && m.style.display !== 'none');
                },
                getTargetFrames: () => layTargetFramesChoSubAlign(),
                getAllModalFrames: () => {
                    if (!activeModalTrack || !Array.isArray(activeModalTrack.shapes)) return [];
                    const set = new Set();
                    for (const s of activeModalTrack.shapes) {
                        if (s && !s.outside && s.points && s.points.length >= 9) {
                            const f = Number(s.frame);
                            if (Number.isFinite(f)) set.add(f);
                        }
                    }
                    return [...set].sort((a, b) => a - b);
                },
                napLiDAR: (targetFramesSet) => damBaoNapLiDARChoSubAlign(targetFramesSet),
                getFramePts: (fn) => pcdFrameCache.get(fn),
                getFullFramePts: (fn) => layDiemFullFrameChoSurface(fn),
                getFrameBoxes: (fn) => {
                    const fNum = Number(fn);
                    const boxes = [];
                    let allTracks = (currentAnnotations && Array.isArray(currentAnnotations.tracks)) ? [...currentAnnotations.tracks] : [];
                    if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.layTatCaTracksLiveTuRAM === 'function') {
                        const live = window.quanLyAPICVAT.layTatCaTracksLiveTuRAM();
                        if (Array.isArray(live) && live.length > 0) {
                            const existingIds = new Set(allTracks.map(t => t.id || t._trackNumber || t._clientID));
                            for (const lt of live) {
                                if (lt && !existingIds.has(lt.id) && !existingIds.has(lt._trackNumber) && !existingIds.has(lt._clientID)) {
                                    allTracks.push(lt);
                                }
                            }
                        }
                    }
                    const seenShapes = new Set();
                    for (const tr of allTracks) {
                        if (!tr || !Array.isArray(tr.shapes)) continue;
                        const direct = tr.shapes.find(s => Number(s.frame) === fNum);
                        let sh = null;
                        if (direct) {
                            sh = direct.outside ? null : direct;
                        } else if (typeof layShapeChoFrame === 'function') {
                            sh = layShapeChoFrame(tr, fNum);
                        }
                        if (sh && !sh.outside && sh.points && sh.points.length >= 9) {
                            seenShapes.add(sh);
                            boxes.push({
                                track: tr,
                                shape: sh,
                                cx: sh.points[0],
                                cy: sh.points[1],
                                cz: sh.points[2],
                                isDirect: !!direct
                            });
                        }
                    }
                    if (currentAnnotations && Array.isArray(currentAnnotations.shapes)) {
                        for (const sh of currentAnnotations.shapes) {
                            if (!sh || seenShapes.has(sh) || Number(sh.frame) !== fNum || sh.outside || !sh.points || sh.points.length < 9) continue;
                            boxes.push({
                                track: null,
                                shape: sh,
                                cx: sh.points[0],
                                cy: sh.points[1],
                                cz: sh.points[2],
                                isDirect: true
                            });
                        }
                    }
                    return boxes;
                },
                saveUndo: (touchedTracks) => {
                    const uniqueTracks = Array.isArray(touchedTracks) ? [...new Set(touchedTracks.filter(Boolean))] : [];
                    if (uniqueTracks.length <= 1) {
                        const only = uniqueTracks[0];
                        if (!only || only === activeModalTrack) luuUndoSnapshotModal();
                        else luuUndoSnapshotOtherTrack(only);
                        return;
                    }
                    const items = [];
                    for (const tr of uniqueTracks) {
                        if (tr === activeModalTrack) {
                            const snap = chupSnapshotMainTrack(activeModalTrack);
                            if (snap) items.push({ isMain: true, mainSnap: snap });
                        } else if (Array.isArray(tr.shapes)) {
                            tr._isDirty = true;
                            delete tr._origShapesBackup;
                            items.push({
                                isMain: false,
                                track: tr,
                                shapesSnap: tr.shapes.map(s => ({
                                    type: s.type || 'cuboid',
                                    frame: Number(s.frame),
                                    outside: !!s.outside,
                                    occluded: !!s.occluded,
                                    points: [...(s.points || [])],
                                    attributes: s.attributes ? JSON.parse(JSON.stringify(s.attributes)) : []
                                }))
                            });
                        }
                    }
                    if (items.length > 0) {
                        modalUndoStack.push({ _isMultiTrackUndo: true, items });
                        if (modalUndoStack.length > 50) modalUndoStack.shift();
                        modalRedoStack = [];
                    }
                },
                onShapesUpdated: (fnOrFrames) => {
                    if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
                    try {
                        if (typeof modalOtherObjectsCache !== 'undefined') {
                            if (Array.isArray(fnOrFrames) || fnOrFrames instanceof Set) {
                                for (const f of fnOrFrames) modalOtherObjectsCache.delete(Number(f));
                            } else if (fnOrFrames !== undefined) {
                                modalOtherObjectsCache.delete(Number(fnOrFrames));
                            }
                        }
                    } catch (_) {}
                    hoanTatCapNhatSubAlign();
                },
                onSurfaceChanged: () => {
                    if (typeof veLaiTatCaHangModal === 'function') veLaiTatCaHangModal(false);
                },
                onSurfaceFrameReady: (fn) => {
                    const row = document.getElementById(`modal-row-frame-${fn}`);
                    if (!row || !activeModalTrack) return;
                    let sh = (activeModalTrack.shapes || []).find(s => Number(s.frame) === Number(fn));
                    if (!sh && typeof layShapeChoFrame === 'function') sh = layShapeChoFrame(activeModalTrack, fn);
                    if (!sh) return;
                    if (typeof laRowDangHienThi === 'function' && laRowDangHienThi(row)) {
                        veRowCanvasTuDiem(row, sh, false);
                    } else {
                        row._needsRedraw = true;
                    }
                },
                isModalMinimized: () => !!document.querySelector('#cvat-detail-modal .cvat-modal-dialog.is-minimized'),
                toggleModal3D: (fFocus) => {
                    const dlg = document.querySelector('#cvat-detail-modal .cvat-modal-dialog');
                    if (!dlg) return null;
                    if (dlg.classList.contains('is-minimized')) {
                        toggleMinimizeModal(true);
                        return 'restored';
                    }
                    toggleMinimizeModal(false);
                    if (Number.isInteger(fFocus) && fFocus !== layFrameHienTai()) {
                        chuyenFrameCVAT(fFocus);
                    }
                    return 'minimized';
                },
                restoreModal: () => toggleMinimizeModal(true),
                toast: (msg) => hienToast(msg)
            });
        });

        // Bắt click chọn ô/lớp Surface trực tiếp trên View TOP trong Extension Modal (pha capture, không xung đột kéo box)
        if (!window._surfTopPickBound) {
            window._surfTopPickBound = true;
            const laClickSurfaceTop = (e) => {
                const ts = laySurfaceDangBat();
                const c = e.target;
                return !!(ts && e.button === 0 && c?.classList?.contains('canvas-top') && c._surfTopProj && (ts.cheDoChonTrenTop || e.altKey));
            };
            document.addEventListener('mousedown', (e) => {
                if (!laClickSurfaceTop(e)) return;
                e.preventDefault();
                e.stopPropagation();
                const ts = window.thuatToanSurface;
                const T = window.ThuatToanSurface;
                if (!ts || !T) return;
                const c = e.target;
                const fn = Number(c._frameNum ?? c.closest('.frame-detail-row')?.getAttribute('data-frame-num'));
                if (!Number.isFinite(fn)) return;
                const r = c.getBoundingClientRect();
                const res = ts.laySurfaceChoVe(fn);
                const wp = T.giaiChieuPixelTop(
                    c._surfTopProj,
                    e.clientX - r.left,
                    e.clientY - r.top,
                    (x, y) => (res ? T.caoDoTai(res.data, x, y) : null)
                );
                if (!wp) {
                    hienToast('⚠️ Nhấn R đưa TOP về góc nhìn từ trên rồi chọn Surface');
                    return;
                }
                if (Number(modalCurrentActiveFrame) !== fn) {
                    nhayToiFrameModal(fn, false, false);
                }
                ts.chonOTaiToaDoTheGioi(fn, wp.x, wp.y, true);
            }, true);
            document.addEventListener('click', (e) => {
                if (laClickSurfaceTop(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
            document.addEventListener('dblclick', (e) => {
                if (laClickSurfaceTop(e)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            }, true);
        }

        // Ô NHẬP CHUYỂN TRACK ID TRỰC TIẾP TRÊN HEADER MODAL (GÓC TRÁI)
        const layDanhSachTrackIdsHopLe = () => {
            if (!currentAnnotations || !Array.isArray(currentAnnotations.tracks)) return [];
            const ids = [];
            currentAnnotations.tracks.forEach((t, i) => {
                if (!t) return;
                const tid = t._trackNumber || (i + 1) || t.id;
                if (tid !== undefined && !ids.includes(Number(tid))) ids.push(Number(tid));
            });
            return ids.sort((a, b) => a - b);
        };

        let _dangChuyenTrackHeader = false;
        const thucHienChuyenTrackTuHeader = async (targetTid) => {
            if (_dangChuyenTrackHeader) return;
            targetTid = parseInt(targetTid, 10);
            const inpH = document.getElementById('modal-inp-header-track-id');
            if (isNaN(targetTid) || targetTid < 1) {
                if (inpH && activeModalTrack) inpH.value = activeModalTrack._trackNumber || 1;
                return;
            }
            if (activeModalTrack && Number(activeModalTrack._trackNumber) === targetTid) {
                return;
            }
            const foundTr = (currentAnnotations && window.thuatToanCanChinh)
                ? window.thuatToanCanChinh.timTrack(currentAnnotations, targetTid)
                : null;
            if (!foundTr && (!window.quanLyAPICVAT || typeof window.quanLyAPICVAT.layTrackLiveTuRAM !== 'function' || !window.quanLyAPICVAT.layTrackLiveTuRAM(targetTid))) {
                hienToast(`❌ Không tìm thấy Track #${targetTid} trong Job!`);
                if (inpH && activeModalTrack) inpH.value = activeModalTrack._trackNumber || 1;
                return;
            }
            _dangChuyenTrackHeader = true;
            try {
                try {
                    const kqRoi = await hoiXuLyPhienBanKhiRoi(activeModalTrack);
                    if (kqRoi === 'cancel') {
                        if (inpH && activeModalTrack) inpH.value = activeModalTrack._trackNumber || 1;
                        return;
                    }
                } catch (errRoi) {
                    console.error('[hoiXuLyPhienBanKhiRoi]', errRoi);
                }
                luuHoacKhoiPhucTrackTruocKhiChuyen();
                selectedTrackId = targetTid;
                const hudInp = document.getElementById('inp-track-id');
                if (hudInp) hudInp.value = targetTid;
                await moModalChiTietTrack(targetTid);
            } finally {
                _dangChuyenTrackHeader = false;
            }
        };

        const inpHeaderTrack = document.getElementById('modal-inp-header-track-id');
        if (inpHeaderTrack) {
            inpHeaderTrack.addEventListener('mousedown', (e) => e.stopPropagation());
            inpHeaderTrack.addEventListener('click', (e) => { e.stopPropagation(); inpHeaderTrack.select(); });
            inpHeaderTrack.addEventListener('keydown', (e) => {
                e.stopPropagation();
                if (e.key === 'Enter') {
                    e.preventDefault();
                    inpHeaderTrack.blur();
                }
            });
            inpHeaderTrack.addEventListener('change', (e) => {
                e.stopPropagation();
                thucHienChuyenTrackTuHeader(inpHeaderTrack.value);
            });
        }

        document.getElementById('modal-btn-prev-track')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const ids = layDanhSachTrackIdsHopLe();
            const curTid = parseInt(document.getElementById('modal-inp-header-track-id')?.value || (activeModalTrack?._trackNumber || 1), 10);
            if (ids.length > 0) {
                const idx = ids.indexOf(curTid);
                const prevTid = (idx > 0) ? ids[idx - 1] : ids[ids.length - 1];
                thucHienChuyenTrackTuHeader(prevTid);
            } else if (curTid > 1) {
                thucHienChuyenTrackTuHeader(curTid - 1);
            }
        });

        document.getElementById('modal-btn-next-track')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const ids = layDanhSachTrackIdsHopLe();
            const curTid = parseInt(document.getElementById('modal-inp-header-track-id')?.value || (activeModalTrack?._trackNumber || 1), 10);
            if (ids.length > 0) {
                const idx = ids.indexOf(curTid);
                const nextTid = (idx >= 0 && idx < ids.length - 1) ? ids[idx + 1] : ids[0];
                thucHienChuyenTrackTuHeader(nextTid);
            } else {
                thucHienChuyenTrackTuHeader(curTid + 1);
            }
        });

        document.getElementById('modal-btn-opacity')?.addEventListener('click', () => {
            const overlay = document.getElementById('cvat-detail-modal');
            const dlg = document.querySelector('#cvat-detail-modal .cvat-modal-dialog');
            const btn = document.getElementById('modal-btn-opacity');
            if (!overlay || !dlg) return;

            const isTrans = overlay.classList.toggle('is-transparent');
            dlg.classList.toggle('is-transparent', isTrans);

            if (btn) btn.textContent = isTrans ? "👁️ Đậm Màu" : "👁️ Trong Suốt";
            hienToast(isTrans ? "Đã bật chế độ trong suốt (nhìn xuyên qua CVAT)" : "Đã bật chế độ đậm màu");
        });

        // BẬT / TẮT THU NHỎ (MINIMIZE) VÀ PHÓNG TO MODAL CHI TIẾT
        function toggleMinimizeModal(forceRestore = false) {
            const overlay = document.getElementById('cvat-detail-modal');
            const dlg = document.querySelector('#cvat-detail-modal .cvat-modal-dialog');
            const btnMin = document.getElementById('modal-btn-minimize');
            const btnRestore = document.getElementById('modal-btn-restore');
            if (!overlay || !dlg) return;

            function khoiPhucViTriChuanGiua() {
                dlg.classList.remove('is-minimized');
                overlay.classList.remove('is-transparent');
                // XÓA BỎ HOÀN TOÀN TỌA ĐỘ INLINE ĐỂ MODAL VỀ LẠI CHÍNH GIỮA MÀN HÌNH
                dlg.style.position = '';
                dlg.style.left = '';
                dlg.style.top = '';
                dlg.style.bottom = '';
                dlg.style.right = '';
                dlg.style.margin = '';
                dlg.style.transform = '';
                if (btnMin) btnMin.style.display = 'inline-flex';
                if (btnRestore) btnRestore.style.display = 'none';
                hienToast("🗖 Đã phóng to modal về chính giữa màn hình");
            }

            let isCurrentlyMin = dlg.classList.contains('is-minimized');
            if (forceRestore) {
                khoiPhucViTriChuanGiua();
                return;
            }

            const nextMin = !isCurrentlyMin;
            if (nextMin) {
                dlg.classList.add('is-minimized');
                overlay.classList.add('is-transparent');
                // Khi thu nhỏ: xóa left/top inline để CSS bottom/right có hiệu lực
                dlg.style.position = '';
                dlg.style.left = '';
                dlg.style.top = '';
                dlg.style.margin = '';
                if (btnMin) btnMin.style.display = 'none';
                if (btnRestore) btnRestore.style.display = 'inline-flex';
                hienToast("🗕 Đã thu nhỏ modal (bấm 🗖 Phóng To hoặc nhấn M để mở lại)");
            } else {
                khoiPhucViTriChuanGiua();
            }
        }

        document.getElementById('modal-btn-minimize')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMinimizeModal();
        });

        document.getElementById('modal-btn-restore')?.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMinimizeModal(true);
        });

        document.getElementById('modal-drag-header')?.addEventListener('click', (e) => {
            const dlg = document.querySelector('#cvat-detail-modal .cvat-modal-dialog');
            if (dlg && dlg.classList.contains('is-minimized')) {
                if (!e.target.closest('#modal-btn-close')) {
                    toggleMinimizeModal(true);
                }
            }
        });

        // SỰ KIỆN THANH ĐIỀU HƯỚNG FRAME (NAV TOOLBAR)
        document.getElementById('modal-nav-first')?.addEventListener('click', () => nhayToiFrameModal(0));
        document.getElementById('modal-nav-last')?.addEventListener('click', () => nhayToiFrameModal(59));
        document.getElementById('modal-nav-prev')?.addEventListener('click', () => {
            const cur = parseInt(document.getElementById('modal-nav-frame-input')?.value || 0, 10);
            nhayToiFrameModal(cur - 1);
        });
        document.getElementById('modal-nav-next')?.addEventListener('click', () => {
            const cur = parseInt(document.getElementById('modal-nav-frame-input')?.value || 0, 10);
            nhayToiFrameModal(cur + 1);
        });
        const navInput = document.getElementById('modal-nav-frame-input');
        if (navInput) {
            navInput.addEventListener('change', () => {
                const fn = parseInt(navInput.value, 10);
                if (!isNaN(fn)) nhayToiFrameModal(fn);
            });
            navInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    const fn = parseInt(navInput.value, 10);
                    if (!isNaN(fn)) nhayToiFrameModal(fn);
                }
            });
        }



        // Gắn sự kiện kéo chuột tịnh tiến toàn cục

        window.addEventListener('mousemove', xuLyKeoChuot);

        window.addEventListener('mouseup', ketThucKeoChuot);

        window.addEventListener('blur', ketThucKeoChuot);

        window.addEventListener('pointercancel', ketThucKeoChuot);



        // BẬT / TẮT THỐNG KÊ
                // BẬT / TẮT THỐNG KÊ & KHỞI TẠO BỘ LỌC
        document.getElementById('btn-toan-job-thong-ke')?.addEventListener('click', () => {
            const panel = document.getElementById('hud-stats-panel');
            if (panel) {
                const isHidden = panel.style.display === 'none';
                panel.style.display = isHidden ? 'block' : 'none';
                document.getElementById('btn-toan-job-thong-ke').textContent = isHidden ? "📊 Thống Kê ▴" : "📊 Thống Kê ▾";
                if (isHidden) {
                    capNhatThongKe();
                }
            }
        });

        // 1. BẮT SỰ KIỆN CHỌN LOẠI XE
        document.querySelectorAll('.btn-stats-filter-type').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                document.querySelectorAll('.btn-stats-filter-type').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                statsBoLocLoai = btn.getAttribute('data-type') || 'all';
                capNhatThongKe();
            });
        });

        // 2. NÚT CHỌN "TẤT CẢ FRAMES"
        document.getElementById('btn-stats-frame-all')?.addEventListener('click', (e) => {
            e.stopPropagation();
            statsBoLocFrameBat = false;
            hienToast("🌐 Đang xem đối tượng trên tất cả các Frames");
            capNhatThongKe();
        });

        // 3. NÚT CHUYỂN FRAME TRƯỚC / SAU
        document.getElementById('btn-stats-frame-prev')?.addEventListener('click', (e) => {
            e.stopPropagation();
            statsBoLocFrameBat = true;
            statsBoLocFrameNum = Math.max(0, statsBoLocFrameNum - 1);
            const inp = document.getElementById('inp-stats-filter-frame');
            if (inp) inp.value = statsBoLocFrameNum;
            chuyenFrameCVAT(statsBoLocFrameNum);
            capNhatThongKe();
        });

        document.getElementById('btn-stats-frame-next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            statsBoLocFrameBat = true;
            const totalF = layTongSoFrameJob() || 60;
            statsBoLocFrameNum = Math.min(totalF - 1, statsBoLocFrameNum + 1);
            const inp = document.getElementById('inp-stats-filter-frame');
            if (inp) inp.value = statsBoLocFrameNum;
            chuyenFrameCVAT(statsBoLocFrameNum);
            capNhatThongKe();
        });

        // 4. Ô NHẬP SỐ FRAME TRỰC TIẾP
        document.getElementById('inp-stats-filter-frame')?.addEventListener('change', (e) => {
            const val = parseInt(e.target.value, 10);
            const totalF = layTongSoFrameJob() || 60;
            if (!isNaN(val)) {
                statsBoLocFrameBat = true;
                statsBoLocFrameNum = Math.max(0, Math.min(totalF - 1, val));
                e.target.value = statsBoLocFrameNum;
                chuyenFrameCVAT(statsBoLocFrameNum);
                capNhatThongKe();
            }
        });

        // 5. NÚT ĐỒNG BỘ SỐ FRAME THEO TIMELINE CVAT
        document.getElementById('btn-stats-frame-cur-cvat')?.addEventListener('click', (e) => {
            e.stopPropagation();
            statsBoLocFrameBat = true;
            statsBoLocFrameNum = layFrameHienTai();
            const inp = document.getElementById('inp-stats-filter-frame');
            if (inp) inp.value = statsBoLocFrameNum;
            hienToast(`⏱️ Đã đồng bộ với Frame hiện tại CVAT (${statsBoLocFrameNum})`);
            capNhatThongKe();
        });

        // 6. CHECKBOX CHỈ ACTIVE
        document.getElementById('chk-stats-frame-active-only')?.addEventListener('change', (e) => {
            statsBoLocFrameChiActive = e.target.checked;
            statsBoLocFrameBat = true;
            capNhatThongKe();
        });

        // 7. NÚT ĐẶT LẠI TẤT CẢ BỘ LỌC
        document.getElementById('btn-stats-reset-all')?.addEventListener('click', (e) => {
            e.stopPropagation();
            statsBoLocLoai = 'all';
            statsBoLocFrameBat = false;
            document.querySelectorAll('.btn-stats-filter-type').forEach(b => {
                b.classList.toggle('active', b.getAttribute('data-type') === 'all');
            });
            const inp = document.getElementById('inp-stats-filter-frame');
            if (inp) inp.value = layFrameHienTai();
            hienToast("🔄 Đã đặt lại toàn bộ bộ lọc thống kê");
            capNhatThongKe();
        });

        // 8. CÁC NÚT SAO CHÉP / CHỌN TẤT CẢ
        const ganSuKienNutCopy = (btnId, getListFn, label) => {
            document.getElementById(btnId)?.addEventListener('click', (e) => {
                e.stopPropagation();
                const list = getListFn();
                if (!list || list.length === 0) {
                    hienToast(`⚠️ Danh sách ${label} đang trống!`);
                    return;
                }
                const ids = list.map(item => item.displayId !== undefined ? item.displayId : item.id);
                const str = ids.join(', ');
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(str).then(() => {
                        hienToast(`📋 Đã sao chép ${ids.length} Track IDs (#${ids.slice(0, 5).join(', #')}${ids.length > 5 ? '...' : ''})`);
                    }).catch(() => {
                        hienToast(`📋 ${ids.length} Tracks: ${ids.slice(0, 8).join(', ')}...`);
                    });
                }
            });
        };

        ganSuKienNutCopy('btn-copy-vehicles-ids', () => statsCachedFilteredLists.vehicles, 'Vehicles');
        ganSuKienNutCopy('btn-copy-twowheels-ids', () => statsCachedFilteredLists.twoWheels, 'Two-Wheels');
        ganSuKienNutCopy('btn-copy-pedestrian-ids', () => statsCachedFilteredLists.pedestrian, 'Pedestrian');
        // KHÔI PHỤC GỐC

        // SỰ KIỆN TRONG MODAL CHI TIẾT

        let modalScrollRedrawPending = false;

        // [v2.7.1] HÀNG ĐỢI NỀN TỰ ĐỘNG VẼ TOÀN BỘ CÁC HÀNG TRÁNH GIẬT LAG & TRÁNH PHẢI CLICK/KÉO THẢ
        themHangVaoHangDoiVeNen = function(rowElements) {
            if (!rowElements || rowElements.length === 0) return;
            for (const r of rowElements) {
                if (r && !modalBatchRedrawQueue.includes(r)) {
                    modalBatchRedrawQueue.push(r);
                }
            }
            if (!modalBatchRedrawRaf && !dangKeoHoacXoayModal()) {
                chayHangDoiVeNen();
            }
        };

        chayHangDoiVeNen = function() {
            if (modalBatchRedrawRaf || dangKeoHoacXoayModal()) return;
            if (!activeModalTrack || modalBatchRedrawQueue.length === 0) return;

            modalBatchRedrawRaf = requestAnimationFrame(() => {
                modalBatchRedrawRaf = null;
                if (!activeModalTrack || modalBatchRedrawQueue.length === 0) return;
                if (dangKeoHoacXoayModal()) return;

                const tStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                let processed = 0;

                // Xử lý tối đa 6 hàng hoặc tối đa 6ms mỗi frame để giữ scroll & UI mượt 60-120fps
                while (modalBatchRedrawQueue.length > 0 && processed < 6) {
                    const row = modalBatchRedrawQueue.shift();
                    if (!row || !row.isConnected) continue;
                    const fnStr = row.getAttribute('data-frame-num') || (row.id ? row.id.replace('modal-row-frame-', '') : null);
                    if (!fnStr) continue;
                    const fn = parseInt(fnStr, 10);
                    const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fn);
                    if (!sh || !sh.points) continue;

                    if (dangTuongTacCanvas(fn)) {
                        row._needsRedraw = true;
                        continue;
                    }

                    veRowCanvasTuDiem(row, sh, false);
                    processed++;

                    const elapsed = ((typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()) - tStart;
                    if (elapsed >= 6) break;
                }

                if (modalBatchRedrawQueue.length > 0 && !dangKeoHoacXoayModal()) {
                    chayHangDoiVeNen();
                }
            });
        };

        // [v2.7.1 TỐI ƯU SIÊU MƯỢT] Vẽ lại thông minh:
        // Đo đạc bằng offsetTop / scrollTop không gây forced reflow -> triệt tiêu hoàn toàn giật lag
        // Hàng trong viewport vẽ ngay tức thì, hàng ngoài viewport tự động đưa vào queue vẽ nền
        veLaiTatCaHangModal = function(forceAll = false) {
            if (!activeModalTrack) return;
            const container = document.getElementById('modal-rows-list');
            if (!container) return;

            const sTop = container.scrollTop;
            const cHeight = container.clientHeight || 800;
            const vTop = sTop - 350;
            const vBottom = sTop + cHeight + 350;

            const rowsToQueueBackground = [];

            document.querySelectorAll('.frame-detail-row').forEach(row => {
                const fnStr = row.getAttribute('data-frame-num') || (row.id ? row.id.replace('modal-row-frame-', '') : null);
                if (!fnStr) return;
                const fn = parseInt(fnStr, 10);
                const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fn);
                if (!sh || !sh.points) return;

                if (dangTuongTacCanvas(fn)) {
                    row._needsRedraw = true;
                    return;
                }

                const hasFs = !!row.querySelector('.row-view-card.is-fullscreen-view');

                let isVisible = true;
                if (!forceAll && !hasFs) {
                    const rTop = row.offsetTop;
                    const rBottom = rTop + (row.offsetHeight || 225);
                    isVisible = (rBottom >= vTop && rTop <= vBottom);
                }

                if (!isVisible) {
                    row._needsRedraw = true;
                    rowsToQueueBackground.push(row);
                    return;
                }

                veRowCanvasTuDiem(row, sh, false);
            });

            if (rowsToQueueBackground.length > 0) {
                themHangVaoHangDoiVeNen(rowsToQueueBackground);
            }
        };

        // Hàm cập nhật ngay lập tức các ô input kích thước L, W, H trên toolbar
        capNhatOInputKichThuocTuTrack = function(track) {
            if (!track || !track.shapes) return;
            const curShape = track.shapes.find(s => Number(s.frame) === Number(modalCurrentActiveFrame)) ||
                             track.shapes.find(s => !s.outside && s.points && s.points.length >= 9) ||
                             track.shapes[0];
            if (curShape && curShape.points && curShape.points.length >= 9) {
                const L = curShape.points[6];
                const W = curShape.points[7];
                const H = curShape.points[8];
                const inpL = document.getElementById('modal-inp-size-L');
                const inpW = document.getElementById('modal-inp-size-W');
                const inpH = document.getElementById('modal-inp-size-H');
                if (inpL && !isNaN(L)) inpL.value = L.toFixed(2);
                if (inpW && !isNaN(W)) inpW.value = W.toFixed(2);
                if (inpH && !isNaN(H)) inpH.value = H.toFixed(2);
            }
        };

        // [v2.3.9] Hàm đồng bộ kích thước toàn bộ track (L, W, H) chuẩn xác
        dongBoKichThuocToanBoTrack = function(L, W, H, dimLock = null) {
            if (!activeModalTrack || !activeModalTrack.shapes) return;

            luuUndoSnapshotModal();

            const parseDim = (v) => {
                const n = parseFloat(v);
                return (!isNaN(n) && n > 0.1) ? parseFloat(n.toFixed(3)) : null;
            };

            const targetL = parseDim(L);
            const targetW = parseDim(W);
            const targetH = parseDim(H);

            let changedCount = 0;
            const hasSelected = modalSelectedFrames && modalSelectedFrames.size > 0;

            const dzByFrame = new Map();
            activeModalTrack.shapes.forEach(sh => {
                // [v2.7.2 FIX CHỌN CẢ]: Nếu người dùng có chọn frames, chỉ áp dụng size cho các frame được chọn
                if (hasSelected && !modalSelectedFrames.has(Number(sh.frame))) return;
                if (!sh.points || sh.points.length < 9) return;
                const [x, y, z, rx, ry, rz, oldL, oldW, oldH] = sh.points;

                const nL = targetL !== null ? targetL : oldL;
                const nW = targetW !== null ? targetW : oldW;
                const nH = targetH !== null ? targetH : oldH;

                // Bảo toàn đáy bám mặt đường: z_bottom = z - oldH/2 => z_new = z_bottom + nH/2
                const nZ = z - (oldH / 2) + (nH / 2);
                const dzShift = nZ - z;
                if (Math.abs(dzShift) > 1e-6) dzByFrame.set(Number(sh.frame), dzShift);

                sh.points = [x, y, nZ, rx, ry, rz, nL, nW, nH];
                changedCount++;
            });

            // Cập nhật ô input trên header modal
            const inpL = document.getElementById('modal-inp-size-L');
            const inpW = document.getElementById('modal-inp-size-W');
            const inpH = document.getElementById('modal-inp-size-H');
            if (inpL && targetL !== null) inpL.value = targetL.toFixed(2);
            if (inpW && targetW !== null) inpW.value = targetW.toFixed(2);
            if (inpH && targetH !== null) inpH.value = targetH.toFixed(2);

            const finalL = targetL !== null ? targetL : (parseFloat(inpL?.value) || 4.33);
            const finalW = targetW !== null ? targetW : (parseFloat(inpW?.value) || 1.90);
            const finalH = targetH !== null ? targetH : (parseFloat(inpH?.value) || 1.53);

            // Đồng bộ lên thanh HUD ngoài CVAT nếu có
            const hudL = document.getElementById('cvat-3d-inp-size-L');
            const hudW = document.getElementById('cvat-3d-inp-size-W');
            const hudH = document.getElementById('cvat-3d-inp-size-H');
            if (hudL && targetL !== null) hudL.value = targetL.toFixed(2);
            if (hudW && targetW !== null) hudW.value = targetW.toFixed(2);
            if (hudH && targetH !== null) hudH.value = targetH.toFixed(2);

            // [v2.7.1] Đồng bộ tức thì thông số hiển thị và badge số điểm cho toàn bộ các hàng trong DOM
            document.querySelectorAll('.frame-detail-row').forEach(row => {
                const fnStr = row.getAttribute('data-frame-num') || (row.id ? row.id.replace('modal-row-frame-', '') : null);
                if (!fnStr) return;
                const fn = parseInt(fnStr, 10);
                const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fn);
                if (!sh || !sh.points) return;
                const [x, y, z, rx, ry, rz, sL, sW, sH] = sh.points;

                const dzShift = dzByFrame.get(fn) || 0;
                if (dzShift !== 0) tichLuyDeltaChoRow(row, 0, 0, dzShift, 0, 0, 0);

                const coordText = row.querySelector('.row-coord-text');
                if (coordText) {
                    coordText.innerHTML = `X:${x.toFixed(2)} Y:${y.toFixed(2)}<br>Z:${z.toFixed(2)} R:${((rz || 0) * 180 / Math.PI).toFixed(1)}°<br><span style="color:#38bdf8;font-weight:700">L:${sL.toFixed(2)} W:${sW.toFixed(2)} H:${sH.toFixed(2)}</span>`;
                }

                if (row._localLiDARPoints && row._localLiDARPoints.length > 0 && !row._needsLiDARReproject) {
                    let inBoxPts = 0;
                    const hl = sL / 2, hw = sW / 2, hh = sH / 2;
                    for (let i = 0; i < row._localLiDARPoints.length; i++) {
                        const p = row._localLiDARPoints[i];
                        if (Math.abs(p[0]) <= hl && Math.abs(p[1]) <= hw && Math.abs(p[2]) <= hh) inBoxPts++;
                    }
                    const badgePts = row.querySelector('.pts-count-badge');
                    if (badgePts) badgePts.textContent = `${inBoxPts} pts`;
                }
            });

            // Vẽ lại toàn bộ các canvas: hàng trong viewport vẽ tức thì, hàng ngoài viewport tự động vẽ nền
            veLaiTatCaHangModal(false);

            const lockNote = dimLock ? ` [Khóa ${dimLock.toUpperCase()}]` : '';
            hienToast(`📐 Đã cập nhật kích thước cho ${changedCount} frames ${hasSelected ? '(Đang chọn)' : '(Cả track)'}: ${finalL.toFixed(2)} x ${finalW.toFixed(2)} x ${finalH.toFixed(2)}m!`);
        }

        // Bắt sự kiện các nút tăng/giảm kích thước +/-
        document.querySelectorAll('.btn-size-step').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const dim = btn.getAttribute('data-dim');
                if (!dim) return;
                const dir = parseInt(btn.getAttribute('data-dir'), 10) || 1;
                const step = (e.shiftKey ? 0.02 : 0.05) * dir;
                const inp = document.getElementById(`modal-inp-size-${dim}`);
                if (!inp || !activeModalTrack) return;
                let val = parseFloat(inp.value) || 1.0;
                val = Math.max(0.2, val + step);
                inp.value = val.toFixed(2);

                const curL = parseFloat(document.getElementById('modal-inp-size-L')?.value) || 4.33;
                const curW = parseFloat(document.getElementById('modal-inp-size-W')?.value) || 1.90;
                const curH = parseFloat(document.getElementById('modal-inp-size-H')?.value) || 1.53;
                dongBoKichThuocToanBoTrack(curL, curW, curH);
            });
        });

        // Cập nhật nhãn và hàm thay đổi cỡ điểm
        const capNhatNhanCoDiem = () => {
            const lbl = document.getElementById('modal-lbl-pt-size');
            if (lbl) lbl.textContent = `${modalLiDARPointSize.toFixed(1)}px`;
        };

        document.getElementById('modal-btn-pt-size-dec')?.addEventListener('click', (e) => {
            e.stopPropagation();
            modalLiDARPointSize = Math.max(0.6, parseFloat((modalLiDARPointSize - 0.2).toFixed(1)));
            localStorage.setItem('cvat_modal_pt_size', modalLiDARPointSize);
            capNhatNhanCoDiem();
            veLaiTatCaHangModal();
        });

        document.getElementById('modal-btn-pt-size-inc')?.addEventListener('click', (e) => {
            e.stopPropagation();
            modalLiDARPointSize = Math.min(3.0, parseFloat((modalLiDARPointSize + 0.2).toFixed(1)));
            localStorage.setItem('cvat_modal_pt_size', modalLiDARPointSize);
            capNhatNhanCoDiem();
            veLaiTatCaHangModal();
        });

        // Bắt sự kiện nút Đồng Bộ Size
        document.getElementById('modal-btn-apply-size')?.addEventListener('click', () => {
            if (!activeModalTrack) return;
            const curL = parseFloat(document.getElementById('modal-inp-size-L')?.value) || 4.33;
            const curW = parseFloat(document.getElementById('modal-inp-size-W')?.value) || 1.90;
            const curH = parseFloat(document.getElementById('modal-inp-size-H')?.value) || 1.53;
            dongBoKichThuocToanBoTrack(curL, curW, curH);
        });

        // Bắt sự kiện nút Khóa Track trong Modal Chi Tiết
        document.getElementById('modal-btn-lock-track')?.addEventListener('click', () => {
            if (activeModalTrack) {
                toggleKhoaTrack(activeModalTrack.id);
            }
        });

        // BẮT SỰ KIỆN 3 NÚT KHÓA RIÊNG LẺ 🔓 / 🔒 Dài (L), Rộng (W), Cao (H)
        ['l', 'w', 'h'].forEach(dim => {
            const btn = document.getElementById(`modal-btn-lock-${dim}`);
            btn?.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!activeModalTrack) return;
                const isCurrentlyLocked = Boolean(activeModalTrack[`lock_${dim}`]);
                const nextLocked = !isCurrentlyLocked;
                activeModalTrack[`lock_${dim}`] = nextLocked;

                if (nextLocked) {
                    const inp = document.getElementById(`modal-inp-size-${dim.toUpperCase()}`);
                    const val = parseFloat(inp?.value) || 1.0;
                    activeModalTrack[`locked_${dim}_val`] = val;
                    // Đồng bộ ngay giá trị chiều này sang toàn bộ các frame
                    dongBoKichThuocToanBoTrack(
                        dim === 'l' ? val : null,
                        dim === 'w' ? val : null,
                        dim === 'h' ? val : null,
                        dim
                    );
                } else {
                    hienToast(`🔓 Đã mở khóa chiều ${dim.toUpperCase()}`);
                }
                capNhatGiaoDienCacNutKhoaDim();
            });
        });

        // BẮT SỰ KIỆN BỘ CHỌN 🎯 Chọn Frame
        document.getElementById('modal-sel-frame-size')?.addEventListener('change', (e) => {
            if (!activeModalTrack) return;
            const fn = parseInt(e.target.value, 10);
            if (isNaN(fn)) return;
            nhayToiFrameModal(fn, false);
            const sh = (activeModalTrack.shapes || []).find(s => s.frame === fn && !s.outside) ||
                       (activeModalTrack.shapes || []).find(s => s.frame === fn);
            if (sh && sh.points && sh.points.length >= 9) {
                const [, , , , , , L, W, H] = sh.points;
                hienToast(`🎯 Frame ${fn}: L=${L.toFixed(2)}m, W=${W.toFixed(2)}m, H=${H.toFixed(2)}m`);
            }
        });

        // Bắt sự kiện nút Khóa Kích Thước Track (Mở Popup Cấu Hình Chi Tiết)
        const btnLockSize = document.getElementById('modal-btn-lock-size');
        const popLock = document.getElementById('cvat-lock-size-popup');
        const popKf = document.getElementById('lock-pop-kf');
        const popL = document.getElementById('lock-pop-l');
        const popW = document.getElementById('lock-pop-w');
        const popH = document.getElementById('lock-pop-h');
        const popChkL = document.getElementById('lock-pop-chk-l');
        const popChkW = document.getElementById('lock-pop-chk-w');
        const popChkH = document.getElementById('lock-pop-chk-h');

        const capNhatNutLockSize = () => {
            if (!btnLockSize || !activeModalTrack) return;
            const lockL = Boolean(activeModalTrack.lock_l);
            const lockW = Boolean(activeModalTrack.lock_w);
            const lockH = Boolean(activeModalTrack.lock_h);
            const daKhoa = Boolean(activeModalTrack.khoa_kich_thuoc || activeModalTrack.lock_size || lockL || lockW || lockH);
            if (daKhoa) {
                const ds = [];
                if (lockL) ds.push('L');
                if (lockW) ds.push('W');
                if (lockH) ds.push('H');
                const str = ds.length > 0 ? ds.join(',') : 'CỐ ĐỊNH';
                btnLockSize.textContent = `🔒 ĐÃ KHÓA SIZE (${str})`;
                btnLockSize.style.background = '#b45309';
                btnLockSize.style.color = '#fef08a';
                btnLockSize.style.borderColor = '#f59e0b';
                btnLockSize.title = `Kích thước đã khóa (${str}). Bấm để mở bảng cấu hình hoặc mở khóa.`;
            } else {
                btnLockSize.textContent = '🔓 Cài Đặt Khóa Size';
                btnLockSize.style.background = '#334155';
                btnLockSize.style.color = '#94a3b8';
                btnLockSize.style.borderColor = '#475569';
                btnLockSize.title = 'Bấm để mở bảng cấu hình Khóa Kích Thước (Key Frame, L, W, H).';
            }
        };

        if (activeModalTrack) {
            capNhatNutLockSize();
        }

        btnLockSize?.addEventListener('click', () => {
            if (!activeModalTrack || !popLock) return;
            const shapes = (activeModalTrack.shapes || []).filter(s => s.points && s.points.length >= 9);
            const shapeDict = {};
            shapes.forEach(s => { shapeDict[s.frame] = s; });
            const frameList = Object.keys(shapeDict).map(Number).sort((a, b) => a - b);

            const curKf = activeModalTrack.key_frame_size ?? activeFrameIndex;
            if (popKf) {
                popKf.value = curKf;
                if (frameList.length > 0) {
                    popKf.min = frameList[0];
                    popKf.max = frameList[frameList.length - 1];
                }
            }

            const activeShape = shapeDict[curKf] || shapes[0];
            const curL = activeModalTrack.locked_l_val ?? (activeShape ? activeShape.points[6] : 4.33);
            const curW = activeModalTrack.locked_w_val ?? (activeShape ? activeShape.points[7] : 1.90);
            const curH = activeModalTrack.locked_h_val ?? (activeShape ? activeShape.points[8] : 1.53);

            if (popL) popL.value = Number(curL).toFixed(3);
            if (popW) popW.value = Number(curW).toFixed(3);
            if (popH) popH.value = Number(curH).toFixed(3);

            const isLockedAny = Boolean(activeModalTrack.khoa_kich_thuoc || activeModalTrack.lock_size);
            let initLockL = Boolean(activeModalTrack.lock_l ?? isLockedAny);
            let initLockW = Boolean(activeModalTrack.lock_w ?? isLockedAny);
            let initLockH = Boolean(activeModalTrack.lock_h ?? isLockedAny);
            if (isLockedAny && !initLockL && !initLockW && !initLockH) {
                initLockL = initLockW = initLockH = true;
            }

            if (popChkL) popChkL.checked = initLockL;
            if (popChkW) popChkW.checked = initLockW;
            if (popChkH) popChkH.checked = initLockH;

            popLock.style.display = 'flex';
        });

        popKf?.addEventListener('change', () => {
            if (!activeModalTrack) return;
            const f = parseInt(popKf.value, 10);
            const s = (activeModalTrack.shapes || []).find(sh => sh.frame === f && sh.points && sh.points.length >= 9);
            if (s) {
                if (popL) popL.value = Number(s.points[6]).toFixed(3);
                if (popW) popW.value = Number(s.points[7]).toFixed(3);
                if (popH) popH.value = Number(s.points[8]).toFixed(3);
            }
        });

        document.getElementById('lock-pop-btn-ok')?.addEventListener('click', async () => {
            let trTarget = (typeof activeModalTrack !== 'undefined' && activeModalTrack) ? activeModalTrack : null;
            if (!trTarget && currentLockingTrackId && currentAnnotations && window.thuatToanCanChinh) {
                trTarget = window.thuatToanCanChinh.timTrack(currentAnnotations, currentLockingTrackId);
            }
            if (!trTarget) return;
            const lockL = Boolean(popChkL?.checked);
            const lockW = Boolean(popChkW?.checked);
            const lockH = Boolean(popChkH?.checked);
            const nL = parseFloat(popL?.value) || 4.33;
            const nW = parseFloat(popW?.value) || 1.90;
            const nH = parseFloat(popH?.value) || 1.53;
            const kf = parseInt(popKf?.value, 10) || 0;

            activeModalTrack.key_frame_size = kf;
            activeModalTrack.lock_l = lockL;
            activeModalTrack.lock_w = lockW;
            activeModalTrack.lock_h = lockH;
            activeModalTrack.locked_l_val = nL;
            activeModalTrack.locked_w_val = nW;
            activeModalTrack.locked_h_val = nH;
            activeModalTrack.khoa_kich_thuoc = Boolean(lockL || lockW || lockH);
            activeModalTrack.lock_size = activeModalTrack.khoa_kich_thuoc;

            dongBoKichThuocToanBoTrack(nL, nW, nH);
            capNhatNutLockSize();
            if (popLock) popLock.style.display = 'none';
            hienToast(`🔒 Đã lưu cấu hình Khóa Kích Thước Track #${activeModalTrack.id}!`);
        });

        document.getElementById('lock-pop-btn-unlock')?.addEventListener('click', () => {
            if (!activeModalTrack) return;
            activeModalTrack.lock_l = false;
            activeModalTrack.lock_w = false;
            activeModalTrack.lock_h = false;
            activeModalTrack.khoa_kich_thuoc = false;
            activeModalTrack.lock_size = false;
            capNhatNutLockSize();
            if (popLock) popLock.style.display = 'none';
            hienToast(`🔓 Đã mở khóa: Kích thước sẽ tự động tối ưu khi căn track.`);
        });

        document.getElementById('lock-pop-btn-cancel')?.addEventListener('click', () => {
            if (popLock) popLock.style.display = 'none';
        });

        // [v2.3.9] Bắt phím Enter và sự kiện change trên các ô input kích thước
        ['L', 'W', 'H'].forEach(dim => {
            const inp = document.getElementById(`modal-inp-size-${dim}`);
            if (!inp) return;
            const capNhatKichThuocTuInp = () => {
                const curL = parseFloat(document.getElementById('modal-inp-size-L')?.value) || 4.33;
                const curW = parseFloat(document.getElementById('modal-inp-size-W')?.value) || 1.90;
                const curH = parseFloat(document.getElementById('modal-inp-size-H')?.value) || 1.53;
                dongBoKichThuocToanBoTrack(curL, curW, curH);
            };
            inp.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    capNhatKichThuocTuInp();
                    inp.blur();
                }
            });
            inp.addEventListener('change', () => {
                capNhatKichThuocTuInp();
            });
        });


        // [v2.7.1] HÀM TỊNH TIẾN ĐỒNG BỘ TAY (BẮT SỰ KIỆN NÚT NHÍCH VÀ PHÍM TẮT ALT + ARROWS)
        tinhTienDongBoTay = function(du, dv, dz) {
            if (!activeModalTrack || !activeModalTrack.shapes) return;
            luuUndoSnapshotModal();

            const checkedDom = document.querySelectorAll('.chk-frame-row:checked');
            let targetFrames = [];
            if (checkedDom.length > 0) {
                checkedDom.forEach(c => {
                    const fn = parseInt(c.getAttribute('data-frame'), 10);
                    if (!isNaN(fn) && !targetFrames.includes(fn)) targetFrames.push(fn);
                });
            }
            if (targetFrames.length === 0) {
                targetFrames = [layFrameHienTaiCuaModal()];
            }

            const container = document.getElementById('modal-rows-list');
            const sTop = container ? container.scrollTop : 0;
            const cHeight = container ? (container.clientHeight || 800) : 800;
            const vTop = sTop - 250;
            const vBottom = sTop + cHeight + 250;
            const rowsToQueue = [];
            const activeFn = Number(layFrameHienTaiCuaModal());

            for (const fn of targetFrames) {
                const fnNum = Number(fn);
                const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fnNum);
                if (!sh || !sh.points || sh.points.length < 9) continue;

                const [initX, initY, initZ, rx, ry, rz, L, W, H] = sh.points;
                let deltaWorldX = 0, deltaWorldY = 0, deltaWorldZ = dz;
                if (window.thuatToanCanChinh && typeof window.thuatToanCanChinh.eulerXYZToMatrix === 'function' && typeof window.thuatToanCanChinh.matVecMul === 'function') {
                    const rotMat = window.thuatToanCanChinh.eulerXYZToMatrix(rx || 0, ry || 0, rz || 0);
                    const shift = window.thuatToanCanChinh.matVecMul(rotMat, [du, dv, dz]);
                    deltaWorldX = shift[0];
                    deltaWorldY = shift[1];
                    deltaWorldZ = shift[2];
                } else {
                    const cosRz = Math.cos(rz || 0), sinRz = Math.sin(rz || 0);
                    deltaWorldX = cosRz * du - sinRz * dv;
                    deltaWorldY = sinRz * du + cosRz * dv;
                }

                sh.points[0] = initX + deltaWorldX;
                sh.points[1] = initY + deltaWorldY;
                sh.points[2] = initZ + deltaWorldZ;

                const row = document.getElementById(`modal-row-frame-${fnNum}`);
                if (!row) continue;

                const coordText = row.querySelector('.row-coord-text');
                if (coordText) {
                    coordText.innerHTML = `X:${sh.points[0].toFixed(2)} Y:${sh.points[1].toFixed(2)}<br>Z:${sh.points[2].toFixed(2)} R:${((rz || 0) * 180 / Math.PI).toFixed(1)}°<br><span style="color:#38bdf8;font-weight:700">L:${L.toFixed(2)} W:${W.toFixed(2)} H:${H.toFixed(2)}</span>`;
                }

                tichLuyDeltaChoRow(row, du, dv, dz, 0, 0, 0);

                const hasFs = !!row.querySelector('.row-view-card.is-fullscreen-view');
                let canDrawNow = (fnNum === activeFn) || hasFs;
                if (!canDrawNow && container) {
                    const rTop = row.offsetTop;
                    const rBottom = rTop + (row.offsetHeight || 225);
                    canDrawNow = (rBottom >= vTop && rTop <= vBottom);
                }

                if (canDrawNow) {
                    veRowCanvasTuDiem(row, sh, true);
                } else {
                    row._needsRedraw = true;
                    rowsToQueue.push(row);
                }
            }

            if (rowsToQueue.length > 0 && typeof themHangVaoHangDoiVeNen === 'function') {
                themHangVaoHangDoiVeNen(rowsToQueue);
            }

            hienToast(`🚀 Đã nhích tọa độ [Δu=${du.toFixed(2)}, Δv=${dv.toFixed(2)}, Δz=${dz.toFixed(2)}] cho ${targetFrames.length} frames!`);
        };

        // Bắt sự kiện các nút nhích nhanh ±5cm (Dọc, Ngang, Cao)
        document.querySelectorAll('.btn-nudge-step').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const axis = btn.getAttribute('data-axis');
                const dir = parseInt(btn.getAttribute('data-dir'), 10) || 1;
                let step = 0.05;
                if (e.shiftKey) step = 0.02;
                else if (e.ctrlKey || e.metaKey) step = 0.10;

                const delta = step * dir;
                let du = 0, dv = 0, dz = 0;
                if (axis === 'u') du = delta;
                else if (axis === 'v') dv = delta;
                else if (axis === 'z') dz = delta;

                tinhTienDongBoTay(du, dv, dz);
            });
        });

        document.getElementById('modal-btn-close')?.addEventListener('click', async () => {
            try {
                const kqRoi = await hoiXuLyPhienBanKhiRoi(activeModalTrack);
                if (kqRoi === 'cancel') return;
            } catch (errRoi) {
                console.error('[hoiXuLyPhienBanKhiRoi]', errRoi);
            }
            if (window.khoDuyet) {
                if (window.khoDuyet.boCho(activeModalTrack)) {
                    hienToast('ℹ️ Duyệt chưa chốt đã bỏ (chưa bấm Lưu)');
                    try {
                        capNhatNutDuyet();
                    } catch (errDuyet) {
                        console.error('[capNhatNutDuyet]', errDuyet);
                    }
                }
                if (typeof window.khoDuyet.dongPhien === 'function') {
                    window.khoDuyet.dongPhien(activeModalTrack, { luu: false });
                }
            }
            if (modalIntersectionObserver) {
                modalIntersectionObserver.disconnect();
                modalIntersectionObserver = null;
            }
            pcdFetchQueue = [];
            const m = document.getElementById('cvat-detail-modal');
            if (m) m.style.display = 'none';
        });



        // 🚀 TỰ ĐỘNG CĂN TRACK NGAY TRONG MODAL (XE Ô TÔ CẮT LỚP, XE 2 BÁNH & NGƯỜI ĐI BỘ V2.0)


        // NÚT TOGGLE HIỆN TOÀN BỘ 77 FRAMES JOB
        document.getElementById('modal-btn-toggle-full-job')?.addEventListener('click', () => {
            cheDoHienFullFramesJob = !cheDoHienFullFramesJob;
            const btn = document.getElementById('modal-btn-toggle-full-job');
            if (btn) {
                btn.style.background = cheDoHienFullFramesJob ? '#0284c7' : '';
                btn.style.color = cheDoHienFullFramesJob ? '#ffffff' : '';
                btn.textContent = cheDoHienFullFramesJob ? '🌐 Hiện Có Box (43f)' : '🌐 Hiện Đủ Frames Job';
            }
            renderCacHangModalChiTiet(true);
            hienToast(cheDoHienFullFramesJob ? '🌐 Đang hiển thị toàn bộ các frames của Job!' : '🎯 Đang hiển thị các frames có box thực tế!');
        });

        // [v2.6.3] XỬ LÝ POPOVER CỠ PHÓNG ĐẠI QUÉT (1.0x - 2.0x) THEO YÊU CẦU KIỆT
        let currentScanScale = 1.0;

        function capNhatGiaoDienScalePop(val) {
            let v = parseFloat(val);
            if (isNaN(v)) v = 1.0;
            v = Math.max(1.0, Math.min(2.0, Math.round(v * 10) / 10));
            currentScanScale = v;
            const strV = v.toFixed(1);

            const badge = document.getElementById('modal-scale-pop-badge');
            const inp = document.getElementById('modal-inp-scan-scale');
            const desc = document.getElementById('modal-scale-pop-desc');

            if (badge) badge.textContent = `${strV}x`;
            if (inp && inp.value !== strV) inp.value = strV;

            document.querySelectorAll('.scale-chip').forEach(chip => {
                chip.classList.toggle('active', chip.dataset.val === strV);
            });

            if (desc) {
                if (strV === '1.0') {
                    desc.innerHTML = `🟢 <b>1.0x:</b> Ôm sát vỏ xe (±10cm), an toàn tuyệt đối chống hút bờ tường, dải phân cách, xe sát bên.`;
                } else if (v >= 1.5) {
                    desc.innerHTML = `🟣 <b>${strV}x:</b> Phóng to nuốt trọn xe (Big Cuboid), dành cho hộp bị bóp méo teo nhỏ hoặc lệch xa.`;
                } else {
                    const cm = Math.round(10 + (v - 1.0) * 130);
                    desc.innerHTML = `🟡 <b>${strV}x:</b> Nới nhẹ vừa phải (±${cm}cm), bao quát nhẹ quanh xe.`;
                }
            }
        }

        // Bộ quản lý tập trung các Popover trên thanh công cụ Modal (dùng chung cho 4 menu thả xuống)
        const MODAL_POPOVER_PAIRS = [
            ['modal-scale-popover', 'modal-btn-auto-align'],
            ['modal-auto-sub-popover', 'modal-btn-auto-sub'],
            ['modal-select-popover', 'modal-btn-select-menu'],
            ['modal-scan-out-popover', 'modal-btn-scan-out']
        ];

        function dongTatCaPopoverModal(exceptPopId = null) {
            for (const [pId, bId] of MODAL_POPOVER_PAIRS) {
                if (pId === exceptPopId) continue;
                const pEl = document.getElementById(pId);
                const bEl = document.getElementById(bId);
                if (pEl) pEl.style.display = 'none';
                if (bEl) bEl.classList.remove('is-active');
            }
        }

        function batTatPopoverModal(btnId, popId, popW = 280, offsetLeft = 0, onOpen = null) {
            const pop = document.getElementById(popId);
            const btn = document.getElementById(btnId);
            const dlg = document.querySelector('.cvat-modal-dialog');
            if (!pop || !btn || !dlg) return false;

            const isHidden = (pop.style.display === 'none' || !pop.style.display);
            if (!isHidden) {
                pop.style.display = 'none';
                btn.classList.remove('is-active');
                return false;
            }
            dongTatCaPopoverModal(popId);
            const bRect = btn.getBoundingClientRect();
            const dRect = dlg.getBoundingClientRect();
            pop.style.top = (bRect.bottom - dRect.top + 6) + 'px';
            let leftPos = bRect.left - dRect.left + offsetLeft;
            if (leftPos + popW > dRect.width - 15) leftPos = dRect.width - popW - 15;
            if (leftPos < 10) leftPos = 10;
            pop.style.left = leftPos + 'px';
            pop.style.display = 'flex';
            btn.classList.add('is-active');
            if (typeof onOpen === 'function') onOpen(pop, btn);
            return true;
        }

        // Bấm nút Tự Động Căn Track -> Bật/Tắt Card Popover Nổi Tự Do Xuống Dưới
        document.getElementById('modal-btn-auto-align')?.addEventListener('click', (e) => {
            e.stopPropagation();
            batTatPopoverModal('modal-btn-auto-align', 'modal-scale-popover', 310, -40, () => {
                capNhatGiaoDienScalePop(currentScanScale);
                const inpRange = document.getElementById('modal-inp-scale-range');
                const badgeRange = document.getElementById('modal-scale-range-badge');
                const btnAll = document.getElementById('modal-btn-range-all');
                const btnSel = document.getElementById('modal-btn-range-selected');

                const checkedFrames = [];
                document.querySelectorAll('.chk-frame-row:checked').forEach(c => {
                    checkedFrames.push(parseInt(c.getAttribute('data-frame'), 10));
                });
                const totalFrames = document.querySelectorAll('.chk-frame-row').length;

                if (checkedFrames.length > 0 && checkedFrames.length < totalFrames) {
                    const strRange = chuyenTapFrameThanhChuoiKhoang(new Set(checkedFrames));
                    if (inpRange) inpRange.value = strRange;
                    if (badgeRange) badgeRange.textContent = `${checkedFrames.length} frames`;
                    btnAll?.classList.remove('active');
                    btnSel?.classList.add('active');
                } else {
                    if (inpRange) inpRange.value = '';
                    if (badgeRange) badgeRange.textContent = 'Cả Track';
                    btnAll?.classList.add('active');
                    btnSel?.classList.remove('active');
                }
                setTimeout(() => document.getElementById('modal-inp-scale-range')?.focus(), 50);
            });
        });

        // XỬ LÝ KHỐI KHOẢNG FRAME TRONG POPOVER
        const inpScaleRange = document.getElementById('modal-inp-scale-range');
        const badgeScaleRange = document.getElementById('modal-scale-range-badge');
        const btnScaleRangeAll = document.getElementById('modal-btn-range-all');
        const btnScaleRangeSel = document.getElementById('modal-btn-range-selected');

        inpScaleRange?.addEventListener('input', () => {
            const val = inpScaleRange.value.trim();
            const parsed = parseRangeInputString(val, 999999);
            if (!val || parsed.length === 0) {
                if (badgeScaleRange) badgeScaleRange.textContent = 'Cả Track';
                btnScaleRangeAll?.classList.add('active');
                btnScaleRangeSel?.classList.remove('active');
            } else {
                if (badgeScaleRange) badgeScaleRange.textContent = `${parsed.length} frames`;
                btnScaleRangeAll?.classList.remove('active');
                btnScaleRangeSel?.classList.remove('active');
            }
        });

        btnScaleRangeAll?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (inpScaleRange) inpScaleRange.value = '';
            if (badgeScaleRange) badgeScaleRange.textContent = 'Cả Track';
            btnScaleRangeAll.classList.add('active');
            btnScaleRangeSel?.classList.remove('active');
        });

        btnScaleRangeSel?.addEventListener('click', (e) => {
            e.stopPropagation();
            const checkedFrames = [];
            document.querySelectorAll('.chk-frame-row:checked').forEach(c => {
                checkedFrames.push(parseInt(c.getAttribute('data-frame'), 10));
            });
            if (checkedFrames.length === 0) {
                hienToast("⚠️ Chưa có frame nào được tick chọn trên bảng!");
                return;
            }
            const strRange = chuyenTapFrameThanhChuoiKhoang(new Set(checkedFrames));
            if (inpScaleRange) inpScaleRange.value = strRange;
            if (badgeScaleRange) badgeScaleRange.textContent = `${checkedFrames.length} frames`;
            btnScaleRangeSel.classList.add('active');
            btnScaleRangeAll?.classList.remove('active');
        });

        // Nút giảm 0.1
        document.getElementById('modal-btn-scale-dec')?.addEventListener('click', (e) => {
            e.stopPropagation();
            capNhatGiaoDienScalePop(currentScanScale - 0.1);
        });

        // Nút tăng 0.1
        document.getElementById('modal-btn-scale-inc')?.addEventListener('click', (e) => {
            e.stopPropagation();
            capNhatGiaoDienScalePop(currentScanScale + 0.1);
        });

        // Ô nhập số trực tiếp
        document.getElementById('modal-inp-scan-scale')?.addEventListener('input', (e) => {
            const v = parseFloat(e.target.value);
            if (!isNaN(v)) capNhatGiaoDienScalePop(v);
        });

        document.getElementById('modal-inp-scan-scale')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('modal-btn-do-auto-align')?.click();
            }
        });

        // Các chip chọn nhanh 1.0x, 1.2x, 1.5x, 2.0x
        document.querySelectorAll('.scale-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const val = parseFloat(chip.dataset.val);
                if (!isNaN(val)) capNhatGiaoDienScalePop(val);
            });
        });

        // Nút đóng ✕ của Popover Cấu Hình Căn Track
        document.getElementById('modal-btn-close-scale-pop')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const pop = document.getElementById('modal-scale-popover');
            const btn = document.getElementById('modal-btn-auto-align');
            if (pop) pop.style.display = 'none';
            if (btn) btn.classList.remove('is-active');
        });

        // Đóng toàn bộ Popover Modal khi click ra ngoài popover và ngoài nút kích hoạt
        document.addEventListener('click', (e) => {
            for (const [pId, bId] of MODAL_POPOVER_PAIRS) {
                const popEl = document.getElementById(pId);
                const btnEl = document.getElementById(bId);
                if (popEl && popEl.style.display !== 'none') {
                    if (!popEl.contains(e.target) && (!btnEl || !btnEl.contains(e.target))) {
                        popEl.style.display = 'none';
                        btnEl?.classList.remove('is-active');
                    }
                }
            }
        });

        // Ngăn click bên trong các popover làm đóng popover ngoài ý muốn
        for (const [pId] of MODAL_POPOVER_PAIRS) {
            document.getElementById(pId)?.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        // Thực thi Căn Track khi bấm nút Xác nhận trong popover
        document.getElementById('modal-btn-do-auto-align')?.addEventListener('click', async (e) => {
            e.stopPropagation();
            const pop = document.getElementById('modal-scale-popover');
            if (pop) pop.style.display = 'none';
            document.getElementById('modal-btn-auto-align')?.classList.remove('is-active');
            if (!activeModalTrack) return;
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang được KHÓA BẢO VỆ CHỈNH TAY! Vui lòng mở khóa trước nếu muốn thuật toán can thiệp.`);
                return;
            }
            const btnAuto = document.getElementById('modal-btn-auto-align');
            if (btnAuto && btnAuto.disabled) return;

            try {
                if (btnAuto) {
                    btnAuto.disabled = true;
                    btnAuto.style.opacity = '0.6';
                    btnAuto.style.pointerEvents = 'none';
                }

                if (activeModalTrack.shapes) {
                    for (const s of activeModalTrack.shapes) {
                        if (s && s.frame !== undefined) s.frame = parseInt(s.frame, 10);
                    }
                }

                const activeShapes = (activeModalTrack.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
                if (activeShapes.length === 0) {
                    hienToast("⚠️ Track không có hình hộp Active nào để căn chỉnh!");
                    return;
                }

                // Dọn dẹp hàng đợi background để tránh tranh chấp tài nguyên
                pcdFetchQueue = [];

                // Kiểm tra các frames chưa có trong bộ nhớ đệm (khử trùng lặp và sắp xếp theo thứ tự)
                const missingFrames = [...new Set(activeShapes.map(s => parseInt(s.frame, 10)).filter(fn => !isNaN(fn)))]
                    .filter(fn => !pcdFrameCache.has(fn))
                    .sort((a, b) => a - b);

                if (missingFrames.length > 0) {
                    const totalMissing = missingFrames.length;
                    hienToast(`⏳ Đang nạp dữ liệu LiDAR toàn bộ ${totalMissing} frames...`);
                    const jid = layJobIdHienTai();
                    let loadedCount = 0;
                    for (let i = 0; i < missingFrames.length; i += 10) {
                        const batch = missingFrames.slice(i, i + 10);
                        const results = await Promise.all(batch.map(fn => taiDiemLiDARChoFrame(jid, fn)));
                        results.forEach((pts, idx) => {
                            const fn = batch[idx];
                            if (pts && pts.length > 0) {
                                capNhatDiemChoHangModal(fn, pts);
                            }
                        });
                        loadedCount += batch.length;
                        hienToast(`⏳ Đang nạp dữ liệu LiDAR (${Math.min(loadedCount, totalMissing)}/${totalMissing} frames)...`);
                    }
                }

                luuUndoSnapshotModal();

                // [v2.5.7] Tôn trọng kích thước gốc của xe to (xe tải, xe van, container). Chỉ mở khóa nếu số đo hoàn toàn phi lý
                if (activeModalTrack.lock_w && (activeModalTrack.locked_w_val > 3.50 || activeModalTrack.locked_w_val < 1.20)) {
                    activeModalTrack.lock_w = false;
                }
                if (activeModalTrack.lock_h && (activeModalTrack.locked_h_val > 4.50 || activeModalTrack.locked_h_val < 1.00)) {
                    activeModalTrack.lock_h = false;
                }
                if (activeModalTrack.lock_l && (activeModalTrack.locked_l_val > 22.0 || activeModalTrack.locked_l_val < 2.00)) {
                    activeModalTrack.lock_l = false;
                }

                // Phân tích khoảng frames áp dụng
                const rawRangeStr = document.getElementById('modal-inp-scale-range')?.value?.trim();
                let targetFramesSet = null;
                if (rawRangeStr) {
                    const parsed = parseRangeInputString(rawRangeStr, 999999);
                    if (parsed.length > 0) {
                        targetFramesSet = new Set(parsed);
                    }
                }

                // Sao lưu tọa độ toàn bộ shapes trước khi chạy căn chỉnh
                const backupPointsMap = new Map();
                for (const s of activeModalTrack.shapes) {
                    if (s && s.frame !== undefined && s.points) {
                        backupPointsMap.set(s.frame, [...s.points]);
                    }
                }

                const lname = xacDinhNhanTrack(activeModalTrack, currentLabels);
                const tt = window.thuatToanCanChinh || (typeof ThuatToanCanChinh !== 'undefined' ? ThuatToanCanChinh : null);
                if (tt && typeof tt.canChinhTrackV2 === 'function') {
                    // Chạy căn chỉnh toàn track kết hợp dữ liệu Other Objects để chống nhảy sang xe bên cạnh
                    const nbDict = taoNeighborBoxesChoTrack(activeModalTrack, targetFramesSet, currentAnnotations);
                    const epLai = Boolean(typeof e !== "undefined" && e && e.shiftKey);
                    tt.canChinhTrackV2(activeModalTrack, lname, pcdFrameCache, currentScanScale, targetFramesSet, nbDict, { epLai });
                    if (activeModalTrack._ambiguousFrames && activeModalTrack._ambiguousFrames.length > 0) {
                        hienToast(`⚠️ Có ${activeModalTrack._ambiguousFrames.length} frame mơ hồ (giữ prelabel): [${activeModalTrack._ambiguousFrames.slice(0, 6).join(', ')}]`);
                    }
                }

                // Khôi phục bất biến chỉ cho frame bị khóa (nếu không thuộc phiên mở sửa) + frame ngoài khoảng chọn
                const khoAlign = window.khoDuyet;
                const optsMoKhoaAlign = (typeof layOptsMoKhoaDuyet === 'function') ? layOptsMoKhoaDuyet(activeModalTrack) : null;
                let modifiedCount = 0;
                let skippedApproved = 0;
                for (const s of activeModalTrack.shapes) {
                    if (!s || s.frame === undefined || !backupPointsMap.has(s.frame)) continue;
                    const isLockedF = Boolean(khoAlign && (typeof khoAlign.laKhoaChoSua === 'function'
                        ? khoAlign.laKhoaChoSua(activeModalTrack, s.frame, activeModalTrack, optsMoKhoaAlign)
                        : (khoAlign.batNeo && khoAlign.laDaDuyet(activeModalTrack, s.frame, activeModalTrack, null))));
                    if (isLockedF) {
                        s.points = backupPointsMap.get(s.frame);
                        skippedApproved++;
                    } else if (targetFramesSet && targetFramesSet.size > 0 && !targetFramesSet.has(s.frame)) {
                        s.points = backupPointsMap.get(s.frame);
                    } else {
                        modifiedCount++;
                    }
                }
                if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
                if (skippedApproved > 0) {
                    hienToast(`🔒 Đã giữ nguyên ${skippedApproved} frame đã duyệt bị khóa!`);
                }

                // Cập nhật lại trạng thái 3 nút khóa trên modal
                capNhatGiaoDienCacNutKhoaDim();

                // Đồng bộ kích thước lên các ô input trên modal
                const validShapes = (activeModalTrack.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9 && !isNaN(s.points[6]));
                if (validShapes.length > 0) {
                    const ls = validShapes.map(s => s.points[6]).sort((a, b) => a - b);
                    const ws = validShapes.map(s => s.points[7]).sort((a, b) => a - b);
                    const hs = validShapes.map(s => s.points[8]).sort((a, b) => a - b);
                    const medL = ls[Math.floor(ls.length / 2)];
                    const medW = ws[Math.floor(ws.length / 2)];
                    const medH = hs[Math.floor(hs.length / 2)];
                    const inpL = document.getElementById('modal-inp-size-L');
                    const inpW = document.getElementById('modal-inp-size-W');
                    const inpH = document.getElementById('modal-inp-size-H');
                    if (inpL) inpL.value = medL.toFixed(2);
                    if (inpW) inpW.value = medW.toFixed(2);
                    if (inpH) inpH.value = medH.toFixed(2);
                }

                renderCacHangModalChiTiet(true);
                const afBaoCao = activeModalTrack._afBaoCao;
                let afMsg = '';
                if (afBaoCao) {
                    if (afBaoCao.nSkipped === afBaoCao.totalFrames) {
                        afMsg = ' (0.00cm - Toàn bộ frame đã hội tụ chuẩn)';
                    } else {
                        afMsg = ` (Hội tụ: ${afBaoCao.nConverged}, Giữ nguyên: ${afBaoCao.nSkipped}, Vòng: ${afBaoCao.rounds})`;
                    }
                }
                if (targetFramesSet && targetFramesSet.size > 0) {
                    hienToast(`🎉 Đã căn chỉnh thành công ${modifiedCount} frames đã chọn${afMsg}! (Giữ nguyên các frames còn lại)`);
                } else {
                    hienToast(`🎉 Tự động căn track thành công toàn bộ frames${afMsg}! (Nhìn tổng thể toàn track)`);
                }
            } catch (err) {
                console.error("[Modal 3D] Lỗi tự động căn track:", err);
                hienToast(`❌ Lỗi căn track: ${err.message || err}`);
            } finally {
                if (btnAuto) {
                    btnAuto.disabled = false;
                    btnAuto.style.opacity = '1';
                    btnAuto.style.pointerEvents = 'auto';
                }
            }
        });



        // CHỌN KHOẢNG

        document.getElementById('modal-btn-range')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();
            if (!activeModalTrack) return;
            const shapes = activeModalTrack.shapes || [];
            if (shapes.length === 0) return;
            const fns = shapes.map(s => s.frame);
            const minF = Math.min(...fns);
            const maxF = Math.max(...fns);

            const popup = document.getElementById('cvat-range-popup');
            const guide = document.getElementById('popup-range-guide');
            const inFrom = document.getElementById('popup-inp-from');
            const inTo = document.getElementById('popup-inp-to');

            if (guide) guide.textContent = `Track có ${shapes.length} frames (từ frame ${minF} đến ${maxF}):`;
            if (inFrom) { inFrom.min = minF; inFrom.max = maxF; inFrom.value = minF; }
            if (inTo) { inTo.min = minF; inTo.max = maxF; inTo.value = maxF; }
            if (popup) popup.style.display = 'flex';
        });



        // XỬ LÝ TRONG POPUP CHỌN KHOẢNG (ĐÃ GỘP SẠCH SẼ KHÔNG TRÙNG LẶP)
function chuyenTapFrameThanhChuoiKhoang(frameSet) {
    if (!frameSet || frameSet.size === 0) return "";
    const arr = Array.from(frameSet).sort((a, b) => a - b);
    const ranges = [];
    let start = arr[0], prev = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] === prev + 1) {
            prev = arr[i];
        } else {
            ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
            start = arr[i];
            prev = arr[i];
        }
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    return ranges.join(", ");
}

// Sử dụng hàm parseRangeInputString dùng chung ở phạm vi module

        const rangeInp = document.getElementById('popup-inp-ranges');
        const rangePreview = document.getElementById('popup-preview-label');
        rangeInp?.addEventListener('input', () => {
            const parsed = parseRangeInputString(rangeInp.value);
            if (rangePreview) {
                rangePreview.textContent = parsed.length > 0 ?
                    `💡 Sẽ áp dụng cho ${parsed.length} frames: [${parsed.slice(0, 8).join(', ')}${parsed.length > 8 ? '...' : ''}]` :
                    "💡 Gõ khoảng frames để xem trước kết quả...";
            }
        });

        document.getElementById('popup-btn-cancel')?.addEventListener('click', () => {
            document.getElementById('cvat-range-popup').style.display = 'none';
        });

        document.getElementById('popup-btn-replace')?.addEventListener('click', () => {
            const parsed = new Set(parseRangeInputString(rangeInp ? rangeInp.value : ''));
            if (parsed.size === 0) {
                hienToast("⚠️ Vui lòng nhập ít nhất 1 khoảng hợp lệ!");
                return;
            }
            modalSelectedFrames.clear();
            document.querySelectorAll('.chk-frame-row').forEach(chk => {
                const fn = parseInt(chk.getAttribute('data-frame'), 10);
                const st = parsed.has(fn);
                chk.checked = st;
                chk.closest('.frame-detail-row')?.classList.toggle('is-checked-row', st);
                if (st) modalSelectedFrames.add(fn);
            });
            capNhatTrangThaiNutChonCa();
            document.getElementById('cvat-range-popup').style.display = 'none';
            hienToast(`☑️ Đã chọn ${parsed.size} frames theo danh sách!`);
        });

        document.getElementById('popup-btn-add')?.addEventListener('click', () => {
            const parsed = new Set(parseRangeInputString(rangeInp ? rangeInp.value : ''));
            if (parsed.size === 0) return;
            document.querySelectorAll('.chk-frame-row').forEach(chk => {
                const fn = parseInt(chk.getAttribute('data-frame'), 10);
                if (parsed.has(fn)) {
                    chk.checked = true;
                    chk.closest('.frame-detail-row')?.classList.add('is-checked-row');
                    modalSelectedFrames.add(fn);
                }
            });
            capNhatTrangThaiNutChonCa();
            document.getElementById('cvat-range-popup').style.display = 'none';
            hienToast(`➕ Đã thêm ${parsed.size} frames vào danh sách chọn!`);
        });

        document.getElementById('popup-btn-sub')?.addEventListener('click', () => {
            const parsed = new Set(parseRangeInputString(rangeInp ? rangeInp.value : ''));
            if (parsed.size === 0) return;
            document.querySelectorAll('.chk-frame-row').forEach(chk => {
                const fn = parseInt(chk.getAttribute('data-frame'), 10);
                if (parsed.has(fn)) {
                    chk.checked = false;
                    chk.closest('.frame-detail-row')?.classList.remove('is-checked-row');
                    modalSelectedFrames.delete(fn);
                }
            });
            capNhatTrangThaiNutChonCa();
            document.getElementById('cvat-range-popup').style.display = 'none';
            hienToast(`➖ Đã bỏ ${parsed.size} frames khỏi danh sách chọn!`);
        });

        document.getElementById('popup-btn-all')?.addEventListener('click', () => {
            document.querySelectorAll('.chk-frame-row').forEach(chk => {
                chk.checked = true;
                chk.closest('.frame-detail-row')?.classList.add('is-checked-row');
                modalSelectedFrames.add(parseInt(chk.getAttribute('data-frame'), 10));
            });
            capNhatTrangThaiNutChonCa();
            document.getElementById('cvat-range-popup').style.display = 'none';
            hienToast("☑️ Đã chọn tất cả các frames!");
        });

        document.getElementById('popup-btn-none')?.addEventListener('click', () => {
            document.querySelectorAll('.chk-frame-row').forEach(chk => {
                chk.checked = false;
                chk.closest('.frame-detail-row')?.classList.remove('is-checked-row');
            });
            modalSelectedFrames.clear();
            capNhatTrangThaiNutChonCa();
            document.getElementById('cvat-range-popup').style.display = 'none';
            hienToast("⬜ Đã bỏ chọn tất cả các frames!");
        });

        // CẬP NHẬT TRẠNG THÁI NÚT CHỌN MENU & MỤC CHỌN CẢ
        capNhatTrangThaiNutChonCa = function() {
            const menuBtn = document.getElementById('modal-btn-select-menu');
            const btn = document.getElementById('modal-btn-select-all');
            const chks = document.querySelectorAll('.chk-frame-row');
            const total = chks.length;

            let checkedCount = 0;
            chks.forEach(c => {
                if (c.checked) checkedCount++;
                c.closest('.frame-detail-row')?.classList.toggle('is-checked-row', c.checked);
            });
            const allChecked = (checkedCount === total && total > 0);

            if (menuBtn) {
                menuBtn.classList.toggle('has-selection', checkedCount > 0);
                if (checkedCount > 0) {
                    menuBtn.textContent = `☑️ Chọn (${checkedCount}/${total}) ▾`;
                    menuBtn.title = `Đang chọn ${checkedCount}/${total} frames — bấm để Chọn Khoảng hoặc Chọn Cả`;
                } else {
                    menuBtn.textContent = `☑️ Chọn ▾`;
                    menuBtn.title = 'Mở menu chọn frames: Chọn Khoảng hoặc Chọn Tất Cả';
                }
            }

            if (btn) {
                const titleEl = btn.querySelector('.pop-item-title');
                const subEl = btn.querySelector('.pop-item-sub');
                btn.classList.toggle('is-all-selected', allChecked);
                if (allChecked) {
                    if (titleEl) titleEl.textContent = `⬜ Bỏ Chọn Cả (${total})`;
                    else btn.textContent = `⬜ Bỏ Chọn Cả (${total})`;
                    if (subEl) subEl.textContent = 'Bỏ chọn toàn bộ các frames (Ctrl+A)';
                    btn.title = 'Bấm để bỏ chọn toàn bộ các frames (Ctrl+A)';
                } else if (checkedCount > 0) {
                    if (titleEl) titleEl.textContent = `☑️ Chọn Cả (${checkedCount}/${total})`;
                    else btn.textContent = `☑️ Chọn Cả (${checkedCount}/${total})`;
                    if (subEl) subEl.textContent = `Đang chọn ${checkedCount}/${total} frames — bấm để chọn tất cả`;
                    btn.title = `Đang chọn ${checkedCount}/${total} frames. Bấm để chọn tất cả.`;
                } else {
                    if (titleEl) titleEl.textContent = `☑️ Chọn Cả`;
                    else btn.textContent = `☑️ Chọn Cả`;
                    if (subEl) subEl.textContent = 'Chọn hoặc bỏ chọn toàn bộ frames';
                    btn.title = 'Bấm để chọn tất cả các frames (Ctrl+A)';
                }
            }

            // Đồng bộ trực quan lên nhãn "Chọn Frame" trên toolbar
            const selFrame = document.getElementById('modal-sel-frame-size');
            if (selFrame) {
                const parent = selFrame.closest('.size-field') || selFrame.parentElement;
                const lbl = parent ? parent.querySelector('label') : null;
                if (lbl) {
                    if (checkedCount > 0) {
                        lbl.innerHTML = `🎯 Đang chọn: <span style="color:#f59e0b;font-weight:800;">${checkedCount}/${total}</span> frames`;
                    } else {
                        lbl.innerHTML = `🎯 Chọn Frame:`;
                    }
                }
            }
        };

        // BẬT / TẮT CHỌN CẢ TRÊN MODAL (CHỈ CHỌN KHI NGƯỜI DÙNG BẤM)
        // Bấm nút Chọn ▾ -> Mở/Đóng popover chọn Chọn Khoảng hoặc Chọn Cả
        document.getElementById('modal-btn-select-menu')?.addEventListener('click', (e) => {
            e.stopPropagation();
            batTatPopoverModal('modal-btn-select-menu', 'modal-select-popover', 245, 0);
        });

        document.getElementById('modal-btn-close-select-pop')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();
        });

        document.getElementById('modal-btn-select-all')?.addEventListener('click', (e) => {
            if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
            const chks = document.querySelectorAll('.chk-frame-row');
            if (chks.length === 0) return;
            const anyUnchecked = Array.from(chks).some(c => !c.checked);
            const targetState = anyUnchecked;
            chks.forEach(c => {
                c.checked = targetState;
                c.closest('.frame-detail-row')?.classList.toggle('is-checked-row', targetState);
                const f = parseInt(c.getAttribute('data-frame'), 10);
                if (!isNaN(f)) {
                    if (targetState) modalSelectedFrames.add(f);
                    else modalSelectedFrames.delete(f);
                }
            });
            capNhatTrangThaiNutChonCa();
            dongTatCaPopoverModal();
            hienToast(targetState ? "☑️ Đã chọn toàn bộ các frames" : "⬜ Đã bỏ chọn toàn bộ");
        });



        // MENU OUTSIDE TRONG MODAL (GỘP QUÉT OUTSIDE / BỎ OUTSIDE BỎ CỜ / HIỆN-ẨN OUTSIDE GIỮ CỜ)
        document.getElementById('modal-btn-scan-out')?.addEventListener('click', (e) => {
            e.stopPropagation();
            batTatPopoverModal('modal-btn-scan-out', 'modal-scan-out-popover', 295, -20, () => {
                capNhatGiaoDienScanOutPop('modal', layNguongQuetOutHienTai());
                if (typeof dongBoGiaoDienNutOutside === 'function') {
                    dongBoGiaoDienNutOutside();
                }
            });
        });

        // BẬT / TẮT POPOVER TÍNH NĂNG CĂN RIÊNG LẺ
        document.getElementById('modal-btn-auto-sub')?.addEventListener('click', (e) => {
            e.stopPropagation();
            batTatPopoverModal('modal-btn-auto-sub', 'modal-auto-sub-popover', 260, -20);
        });

        document.getElementById('modal-btn-close-auto-sub-pop')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();
        });

        // HÀM LẤY TARGET FRAMES ĐANG CHỌN:
        // - Ưu tiên 1: Nếu các dòng trong modal đang được tick (.chk-frame-row:checked) và KHÔNG PHẢI đang tick toàn bộ 100% frames -> dùng danh sách tick
        // - Ưu tiên 2: Nếu ô chọn khoảng (#modal-inp-scale-range) có nhập khoảng -> dùng khoảng đó
        // - Mặc định: null (áp dụng toàn bộ Track, giống Auto fit box)
        function layTargetFramesChoSubAlign() {
            const allChks = document.querySelectorAll('.chk-frame-row');
            const checkedDom = document.querySelectorAll('.chk-frame-row:checked');
            if (checkedDom.length > 0 && checkedDom.length < allChks.length) {
                const arr = [];
                checkedDom.forEach(c => {
                    const fn = parseInt(c.getAttribute('data-frame'), 10);
                    if (!isNaN(fn)) arr.push(fn);
                });
                return new Set(arr);
            }
            const rawRangeStr = document.getElementById('modal-inp-scale-range')?.value?.trim();
            if (rawRangeStr) {
                const parsed = parseRangeInputString(rawRangeStr, 999999);
                if (parsed.length > 0) {
                    return new Set(parsed);
                }
            }
            if (checkedDom.length > 0) {
                const arr = [];
                checkedDom.forEach(c => {
                    const fn = parseInt(c.getAttribute('data-frame'), 10);
                    if (!isNaN(fn)) arr.push(fn);
                });
                return new Set(arr);
            }
            return null; // Null nghĩa là cả track
        }

        // HÀM ĐẢM BẢO NẠP ĐẦY ĐỦ DỮ LIỆU LIDAR CHO TOÀN BỘ ACTIVE SHAPES CỦA TRACK (Giống hệt Auto fit box để có ngữ cảnh toàn cục)
        async function damBaoNapLiDARChoSubAlign(targetFramesSet) {
            if (!activeModalTrack || !Array.isArray(activeModalTrack.shapes)) return;
            for (const s of activeModalTrack.shapes) {
                if (s && s.frame !== undefined) s.frame = parseInt(s.frame, 10);
            }
            const jid = layJobIdHienTai();
            const missingSet = new Set();
            for (const s of activeModalTrack.shapes) {
                if (!s || s.outside || !s.points || s.points.length < 9) continue;
                const fn = Number(s.frame);
                const existing = pcdFrameCache.get(fn);
                if (!existing || existing.length === 0 || existing._isSynthetic) {
                    missingSet.add(fn);
                }
            }
            if (targetFramesSet instanceof Set) {
                for (const fnRaw of targetFramesSet) {
                    const fn = Number(fnRaw);
                    if (!Number.isFinite(fn)) continue;
                    const existing = pcdFrameCache.get(fn);
                    if (!existing || existing.length === 0 || existing._isSynthetic) {
                        missingSet.add(fn);
                    }
                }
            }
            const missingFns = [...missingSet];
            if (missingFns.length > 0 && jid) {
                pcdFetchQueue = [];
                const totalMissing = missingFns.length;
                hienToast(`⏳ Đang nạp dữ liệu LiDAR (${totalMissing} frames) để chạy thuật toán...`);
                for (let i = 0; i < missingFns.length; i += 10) {
                    const batch = missingFns.slice(i, i + 10);
                    const results = await Promise.all(batch.map(async (fn) => {
                        const sh = activeModalTrack.shapes.find(it => Number(it.frame) === fn);
                        const center = (sh && sh.points) ? [sh.points[0], sh.points[1], sh.points[2]] : null;
                        return await taiDiemLiDARChoFrame(jid, fn, center);
                    }));
                    results.forEach((pts, idx) => {
                        const fn = batch[idx];
                        if (pts && pts.length > 0) {
                            capNhatDiemChoHangModal(fn, pts);
                        }
                    });
                }
            }
        }

        // HÀM ĐỒNG BỘ LẠI CÁC Ô INPUT KÍCH THƯỚC & VẼ LẠI TOÀN BỘ HÀNG SAU KHI CHẠY THUẬT TOÁN
        function hoanTatCapNhatSubAlign() {
            if (!activeModalTrack) return;
            capNhatGiaoDienCacNutKhoaDim();
            const validShapes = (activeModalTrack.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9 && !isNaN(s.points[6]));
            if (validShapes.length > 0) {
                const ls = validShapes.map(s => s.points[6]).sort((a, b) => a - b);
                const ws = validShapes.map(s => s.points[7]).sort((a, b) => a - b);
                const hs = validShapes.map(s => s.points[8]).sort((a, b) => a - b);
                const medL = ls[Math.floor(ls.length / 2)];
                const medW = ws[Math.floor(ws.length / 2)];
                const medH = hs[Math.floor(hs.length / 2)];
                const inpL = document.getElementById('modal-inp-size-L');
                const inpW = document.getElementById('modal-inp-size-W');
                const inpH = document.getElementById('modal-inp-size-H');
                if (inpL) inpL.value = medL.toFixed(2);
                if (inpW) inpW.value = medW.toFixed(2);
                if (inpH) inpH.value = medH.toFixed(2);

                const outL = document.getElementById('inp-dim-l');
                const outW = document.getElementById('inp-dim-w');
                const outH = document.getElementById('inp-dim-h');
                if (outL) outL.value = medL.toFixed(3);
                if (outW) outW.value = medW.toFixed(3);
                if (outH) outH.value = medH.toFixed(3);
            }
            renderCacHangModalChiTiet(true);
            if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
        }

        function baoVeFrameDaDuyetSauSubAlign(fnChay) {
            const tr = activeModalTrack;
            const kho = window.khoDuyet;
            const snap = new Map();
            const optsLock = (typeof layOptsMoKhoaDuyet === 'function') ? layOptsMoKhoaDuyet(tr) : null;
            const lockSet = (typeof locFrameCanBaoVe === 'function') ? locFrameCanBaoVe(tr, kho, optsLock) : new Set();
            if (tr && Array.isArray(tr.shapes) && lockSet.size > 0) {
                for (const s of tr.shapes) {
                    if (s && !s.outside && Array.isArray(s.points) && lockSet.has(Number(s.frame))) {
                        snap.set(Number(s.frame), { points: [...s.points], rot: Array.isArray(s.rotation) ? [...s.rotation] : s.rotation });
                    }
                }
            }
            const kq = fnChay();
            if (snap.size > 0 && tr && Array.isArray(tr.shapes)) {
                for (const s of tr.shapes) {
                    const prev = snap.get(Number(s.frame));
                    if (prev) {
                        s.points = prev.points;
                        if (prev.rot !== undefined) s.rotation = prev.rot;
                    }
                }
            }
            return { kq, skippedApproved: snap.size };
        }

        // 1. CĂN MẶT ĐƯỜNG RIÊNG LẺ (Tách trực tiếp từ Pha Mặt Đường của Auto fit box: canChinhMatDuongRiengLe)
        document.getElementById('sub-align-ground')?.addEventListener('click', async () => {
            if (!activeModalTrack) return;
            document.getElementById('modal-auto-sub-popover').style.display = 'none';
            document.getElementById('modal-btn-auto-sub')?.classList.remove('is-active');
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang khóa bảo vệ chỉnh tay!`);
                return;
            }

            const targetFrames = layTargetFramesChoSubAlign();
            await damBaoNapLiDARChoSubAlign(targetFrames);
            luuUndoSnapshotModal();

            const tt = window.thuatToanCanChinh;
            let count = 0;
            if (tt && typeof tt.canChinhMatDuongRiengLe === 'function') {
                const optsAlign = {
                    allTracks: currentAnnotations?.tracks || null,
                    ...((typeof layOptsMoKhoaDuyet === 'function') ? layOptsMoKhoaDuyet(activeModalTrack) : {})
                };
                const { kq } = baoVeFrameDaDuyetSauSubAlign(() =>
                    tt.canChinhMatDuongRiengLe(activeModalTrack, pcdFrameCache, targetFrames, optsAlign)
                );
                count = kq;
            }
            hoanTatCapNhatSubAlign();
            hienToast(count > 0
                ? `🛣️ Đã căn mặt đường & cân bằng góc nghiêng chuẩn Auto fit box cho ${count} frames!`
                : `⚠️ Không tìm thấy đủ điểm LiDAR để căn mặt đường cho các frame đã chọn!`);
        });

        // 2. CĂN HƯỚNG XE RIÊNG LẺ (Tách trực tiếp từ Pha Góc Xoay Yaw của Auto fit box: canChinhHuongXeRiengLe)
        document.getElementById('sub-align-yaw')?.addEventListener('click', async () => {
            if (!activeModalTrack) return;
            document.getElementById('modal-auto-sub-popover').style.display = 'none';
            document.getElementById('modal-btn-auto-sub')?.classList.remove('is-active');
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang khóa bảo vệ chỉnh tay!`);
                return;
            }

            const targetFrames = layTargetFramesChoSubAlign();
            await damBaoNapLiDARChoSubAlign(targetFrames);
            luuUndoSnapshotModal();

            const tt = window.thuatToanCanChinh;
            const lname = xacDinhNhanTrack(activeModalTrack, currentLabels);
            let soFrameSua = 0;
            if (tt && typeof tt.canChinhHuongXeRiengLe === 'function') {
                soFrameSua = baoVeFrameDaDuyetSauSubAlign(() =>
                    tt.canChinhHuongXeRiengLe(activeModalTrack, pcdFrameCache, lname, targetFrames)
                ).kq;
            }
            hoanTatCapNhatSubAlign();
            hienToast(`🔄 Đã căn hướng Yaw (L-Shape Histogram + TLS + Khử lật 180°) cho ${soFrameSua} frames!`);
        });

        // 3. ÔM KHÍT XE RIÊNG LẺ (Tách trực tiếp từ Vòng lặp Hội tụ XY của Auto fit box: omKhitXeRiengLe)
        document.getElementById('sub-align-fit')?.addEventListener('click', async () => {
            if (!activeModalTrack) return;
            document.getElementById('modal-auto-sub-popover').style.display = 'none';
            document.getElementById('modal-btn-auto-sub')?.classList.remove('is-active');
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang khóa bảo vệ chỉnh tay!`);
                return;
            }

            const targetFrames = layTargetFramesChoSubAlign();
            await damBaoNapLiDARChoSubAlign(targetFrames);
            luuUndoSnapshotModal();

            const tt = window.thuatToanCanChinh;
            const lname = xacDinhNhanTrack(activeModalTrack, currentLabels);
            let count = 0;
            if (tt && typeof tt.omKhitXeRiengLe === 'function') {
                const nbDict = taoNeighborBoxesChoTrack(activeModalTrack, targetFrames, currentAnnotations);
                count = baoVeFrameDaDuyetSauSubAlign(() =>
                    tt.omKhitXeRiengLe(activeModalTrack, pcdFrameCache, lname, currentScanScale || 1.0, targetFrames, 0.025, nbDict)
                ).kq;
            }
            hoanTatCapNhatSubAlign();
            if (activeModalTrack._ambiguousFrames && activeModalTrack._ambiguousFrames.length > 0) {
                hienToast(`✂️ Đã ôm khít ${count} frames! ⚠️ Giữ prelabel ${activeModalTrack._ambiguousFrames.length} frame mơ hồ: [${activeModalTrack._ambiguousFrames.slice(0, 6).join(', ')}]`);
            } else {
                hienToast(`✂️ Đã ôm khít vách thân xe (bảo toàn Z, góc xoay & kích thước) cho ${count} frames!`);
            }
        });

        // 4. XÁC ĐỊNH CHIỀU CAO RIÊNG LẺ (Tách trực tiếp từ Pha Chiều Cao + Hồ sơ thuộc tính của Auto fit box: xacDinhChieuCaoRiengLe)
        document.getElementById('sub-align-height')?.addEventListener('click', async () => {
            if (!activeModalTrack) return;
            document.getElementById('modal-auto-sub-popover').style.display = 'none';
            document.getElementById('modal-btn-auto-sub')?.classList.remove('is-active');
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang khóa bảo vệ chỉnh tay!`);
                return;
            }

            const targetFrames = layTargetFramesChoSubAlign();
            await damBaoNapLiDARChoSubAlign(targetFrames);
            luuUndoSnapshotModal();

            const tt = window.thuatToanCanChinh;
            const lname = xacDinhNhanTrack(activeModalTrack, currentLabels);
            if (tt && typeof tt.xacDinhChieuCaoRiengLe === 'function') {
                const res = baoVeFrameDaDuyetSauSubAlign(() =>
                    tt.xacDinhChieuCaoRiengLe(activeModalTrack, pcdFrameCache, lname, targetFrames)
                ).kq;
                if (res && res.count > 0 && res.newH !== null) {
                    activeModalTrack._refH = res.newH;
                    if (activeModalTrack.lock_h) activeModalTrack.locked_h_val = res.newH;
                    hoanTatCapNhatSubAlign();
                    hienToast(`📏 Đã xác định chiều cao sát nóc H = ${res.newH.toFixed(2)}m (chuẩn hồ sơ ${res.profileType || lname}) cho ${res.count} frames!`);
                    return;
                }
            }
            hienToast("⚠️ Không thể xác định chiều cao cho Track hiện tại!");
        });

        dongBoGiaoDienNutOutside = function() {
            const btnMenu = document.getElementById('modal-btn-scan-out');
            const btnToggle = document.getElementById('modal-btn-clear-out');
            const shapes = (activeModalTrack && Array.isArray(activeModalTrack.shapes)) ? activeModalTrack.shapes : [];
            const isTamHien = Boolean(activeModalTrack && activeModalTrack._outsideDangTamBo);

            let outsideCount = 0;
            let markedCount = 0;
            for (const s of shapes) {
                if (!s) continue;
                if (s.outside) outsideCount++;
                if (s._markedOutside) markedCount++;
            }

            if (btnMenu) {
                btnMenu.classList.toggle('is-temp-showing', isTamHien);
                if (isTamHien) {
                    btnMenu.textContent = `🩺 Outside (Đang Hiện) ▾`;
                    btnMenu.title = `Đang bật Hiện Outside (${markedCount} frame giữ cờ) — bấm để Ẩn Outside hoặc Bỏ Outside luôn`;
                } else if (outsideCount > 0) {
                    btnMenu.textContent = `🩺 Outside (${outsideCount}) ▾`;
                    btnMenu.title = `Có ${outsideCount} frame Outside — mở để Quét, Bỏ Outside (bỏ cờ luôn), hoặc Hiện Outside (giữ cờ)`;
                } else {
                    btnMenu.textContent = `🩺 Outside ▾`;
                    btnMenu.title = `Mở menu quản lý Outside: Quét Outside, Bỏ Outside (bỏ cờ luôn), Hiện/Ẩn Outside (giữ cờ)`;
                }
            }

            if (btnToggle) {
                const titleEl = btnToggle.querySelector('.pop-item-title');
                const subEl = btnToggle.querySelector('.pop-item-sub');
                btnToggle.classList.toggle('is-temp-visible', isTamHien);
                if (isTamHien) {
                    if (titleEl) titleEl.textContent = markedCount > 0 ? `🙈 Ẩn Outside (${markedCount})` : '🙈 Ẩn Outside';
                    else btnToggle.textContent = '🙈 Ẩn Outside';
                    if (subEl) subEl.textContent = `Đặt lại Outside cho ${markedCount} frame đang giữ cờ`;
                    btnToggle.title = 'Đặt lại Outside cho đúng các frame đang giữ cờ';
                } else {
                    if (titleEl) titleEl.textContent = '👁️ Hiện Outside';
                    else btnToggle.textContent = '👁️ Hiện Outside';
                    if (subEl) subEl.textContent = 'Tạm bỏ Outside để xem (không bỏ cờ)';
                    btnToggle.title = 'Tạm bỏ Outside để xem frame (KHÔNG bỏ cờ); bấm lại để Ẩn Outside lại';
                }
            }
        };

        document.getElementById('modal-btn-close-scan-out-pop')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();
        });

        // Input trong Popover Modal
        document.getElementById('modal-inp-out-pts')?.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!isNaN(val) && val >= 1) capNhatGiaoDienScanOutPop('modal', val);
        });

        // Bấm nút Quét Outside trong Popover Modal
        document.getElementById('modal-btn-do-scan-out')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();

            if (!activeModalTrack) return;
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang được KHÓA BẢO VỆ CHỈNH TAY! Vui lòng mở khóa trước nếu muốn Quét Outside.`);
                return;
            }
            luuUndoSnapshotModal();

            const thresholdPts = layNguongQuetOutHienTai();
            let soKhoiPhuc = 0;
            let soOutsideMoi = 0;

            for (const s of activeModalTrack.shapes) {
                if (!s.points || s.points.length < 9) continue;
                const fn = s.frame;
                const row = document.getElementById(`modal-row-frame-${fn}`);
                const localPts = row?._localLiDARPoints || [];
                const [ , , , , , , L, W, H] = s.points;

                // Lọc bỏ mặt đường: Chỉ đếm các điểm nằm trên thân xe thực tế (loại trừ 20cm sát gầm đáy: z > -H/2 + 0.20m)
                let ptBodyCnt = 0;
                if (localPts.length > 0) {
                    for (const p of localPts) {
                        if (Math.abs(p[0]) <= L / 2 && Math.abs(p[1]) <= W / 2 && Math.abs(p[2]) <= H / 2) {
                            if (p[2] > -H / 2 + 0.20) {
                                ptBodyCnt++;
                            }
                        }
                    }
                }

                const wasOut = !!s.outside;
                if (ptBodyCnt >= thresholdPts) {
                    delete s._markedOutside;
                    if (wasOut) {
                        s.outside = false;
                        soKhoiPhuc++;
                    }
                } else {
                    s._markedOutside = true; // Gắn cờ quét outside
                    if (!wasOut) {
                        s.outside = true;
                        soOutsideMoi++;
                    }
                }
            }

            activeModalTrack._outsideDangTamBo = false;
            dongBoGiaoDienNutOutside();
            renderCacHangModalChiTiet(true);
            hienToast(`🩺 Quét Outside (<${thresholdPts} pts): Đã khôi phục ${soKhoiPhuc} frames Active (≥${thresholdPts} điểm), đánh dấu ${soOutsideMoi} frames Outside (<${thresholdPts} điểm)!`);
        });

        // BỎ OUTSIDE VĨNH VIỄN (BỎ OUTSIDE VÀ XÓA CỜ LUÔN)
        document.getElementById('modal-btn-clear-out-perm')?.addEventListener('click', (e) => {
            e.stopPropagation();
            dongTatCaPopoverModal();
            if (!activeModalTrack) return;
            if (laTrackBiKhoa(activeModalTrack)) {
                hienToast(`⚠️ Track #${activeModalTrack.id} đang được KHÓA BẢO VỆ CHỈNH TAY! Vui lòng mở khóa trước nếu muốn Bỏ Outside.`);
                return;
            }
            luuUndoSnapshotModal();

            let clearedCnt = 0;
            let unflaggedCnt = 0;
            for (const s of (activeModalTrack.shapes || [])) {
                if (!s) continue;
                if (s.outside) {
                    s.outside = false;
                    clearedCnt++;
                }
                if (s._markedOutside) {
                    delete s._markedOutside;
                    unflaggedCnt++;
                }
            }
            activeModalTrack._outsideDangTamBo = false;
            dongBoGiaoDienNutOutside();
            renderCacHangModalChiTiet(true);
            hienToast(`✨ Đã Bỏ Outside & xóa cờ vĩnh viễn cho ${Math.max(clearedCnt, unflaggedCnt)} frames!`);
        });

        // HIỆN OUTSIDE ↔ ẨN OUTSIDE (BỎ OUTSIDE TẠM THỜI NHƯNG KHÔNG BỎ CỜ)
        document.getElementById('modal-btn-clear-out')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!activeModalTrack) return;
            const isCurrentlyShowing = Boolean(activeModalTrack._outsideDangTamBo);

            if (!isCurrentlyShowing) {
                const shapes = activeModalTrack.shapes || [];
                const targetOutsideCount = shapes.filter(s => s && (s.outside || s._markedOutside)).length;
                if (targetOutsideCount === 0) {
                    hienToast('ℹ️ Track này hiện không có frame nào đang đánh Outside để hiện!');
                    return;
                }
                luuUndoSnapshotModal();
                let cnt = 0;
                for (const s of shapes) {
                    if (!s) continue;
                    if (s.outside || s._markedOutside) {
                        s._markedOutside = true; // Bảo lưu cờ
                        if (s.outside) {
                            s.outside = false; // Bỏ outside tạm để xem frame
                            cnt++;
                        }
                    }
                }
                activeModalTrack._outsideDangTamBo = true;
                dongBoGiaoDienNutOutside();
                renderCacHangModalChiTiet(true);
                hienToast(`👁️ Đã hiện ${cnt} frames Outside (vẫn giữ cờ — nút đã chuyển thành "Ẩn Outside")!`);
            } else {
                luuUndoSnapshotModal();
                let cnt = 0;
                for (const s of (activeModalTrack.shapes || [])) {
                    if (s && s._markedOutside) {
                        s.outside = true; // Bật lại outside đúng các frame còn giữ cờ
                        cnt++;
                    }
                }
                activeModalTrack._outsideDangTamBo = false;
                dongBoGiaoDienNutOutside();
                renderCacHangModalChiTiet(true);
                hienToast(`🙈 Đã ẩn Outside lại cho ${cnt} frames đang giữ cờ!`);
            }
        });



        // UNDO TRONG MODAL (Hỗ trợ cả Track chính và Other Objects trong chế độ Chỉnh Tất Cả)
        const apDungMultiTrackUndoEntry = (entry) => {
            const revItems = [];
            for (const it of (entry.items || [])) {
                if (it.isMain && activeModalTrack) {
                    const curMain = chupSnapshotMainTrack(activeModalTrack);
                    if (curMain) revItems.push({ isMain: true, mainSnap: curMain });
                    apDungSnapshotMainTrack(activeModalTrack, it.mainSnap);
                    capNhatOInputKichThuocTuTrack(activeModalTrack);
                } else if (it.track) {
                    const curShapes = (it.track.shapes || []).map(s => ({
                        type: s.type || 'cuboid',
                        frame: Number(s.frame),
                        outside: !!s.outside,
                        occluded: !!s.occluded,
                        points: [...(s.points || [])],
                        attributes: s.attributes ? JSON.parse(JSON.stringify(s.attributes)) : []
                    }));
                    revItems.push({ isMain: false, track: it.track, shapesSnap: curShapes });
                    it.track.shapes = it.shapesSnap;
                }
            }
            modalOtherObjectsCache.clear();
            renderCacHangModalChiTiet(true);
            return { _isMultiTrackUndo: true, items: revItems };
        };

        document.getElementById('modal-btn-undo')?.addEventListener('click', () => {
            if (!activeModalTrack || modalUndoStack.length === 0) {
                hienToast("Không có thao tác nào để hoàn tác!");
                return;
            }
            const prevState = modalUndoStack.pop();
            if (prevState && prevState._isMultiTrackUndo) {
                modalRedoStack.push(apDungMultiTrackUndoEntry(prevState));
                hienToast(`↩ Đã hoàn tác hàng loạt (${prevState.items?.length || 0} track)!`);
                return;
            }
            if (prevState && prevState._isOtherTrackUndo && prevState.track) {
                const curOtherSnap = (prevState.track.shapes || []).map(s => ({
                    type: s.type || 'cuboid',
                    frame: Number(s.frame),
                    outside: !!s.outside,
                    occluded: !!s.occluded,
                    points: [...(s.points || [])],
                    attributes: s.attributes ? JSON.parse(JSON.stringify(s.attributes)) : []
                }));
                modalRedoStack.push({
                    _isOtherTrackUndo: true,
                    track: prevState.track,
                    shapesSnap: curOtherSnap
                });
                prevState.track.shapes = prevState.shapesSnap;
                modalOtherObjectsCache.clear();
                renderCacHangModalChiTiet(true);
                hienToast("↩ Đã hoàn tác chỉnh sửa vật thể phụ!");
                return;
            }

            const curState = chupSnapshotMainTrack(activeModalTrack);
            if (curState) modalRedoStack.push(curState);

            apDungSnapshotMainTrack(activeModalTrack, prevState);
            capNhatOInputKichThuocTuTrack(activeModalTrack);
            renderCacHangModalChiTiet(true);
            if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
            hienToast("↩ Đã hoàn tác!");
        });

        // REDO TRONG MODAL (Hỗ trợ cả Track chính và Other Objects trong chế độ Chỉnh Tất Cả)
        document.getElementById('modal-btn-redo')?.addEventListener('click', () => {
            if (!activeModalTrack || modalRedoStack.length === 0) {
                hienToast("Không có thao tác nào để làm lại!");
                return;
            }
            const nextState = modalRedoStack.pop();
            if (nextState && nextState._isMultiTrackUndo) {
                modalUndoStack.push(apDungMultiTrackUndoEntry(nextState));
                hienToast(`↪ Đã làm lại hàng loạt (${nextState.items?.length || 0} track)!`);
                return;
            }
            if (nextState && nextState._isOtherTrackUndo && nextState.track) {
                const curOtherSnap = (nextState.track.shapes || []).map(s => ({
                    type: s.type || 'cuboid',
                    frame: Number(s.frame),
                    outside: !!s.outside,
                    occluded: !!s.occluded,
                    points: [...(s.points || [])],
                    attributes: s.attributes ? JSON.parse(JSON.stringify(s.attributes)) : []
                }));
                modalUndoStack.push({
                    _isOtherTrackUndo: true,
                    track: nextState.track,
                    shapesSnap: curOtherSnap
                });
                nextState.track.shapes = nextState.shapesSnap;
                modalOtherObjectsCache.clear();
                renderCacHangModalChiTiet(true);
                hienToast("↪ Đã làm lại chỉnh sửa vật thể phụ!");
                return;
            }

            const curState = chupSnapshotMainTrack(activeModalTrack);
            if (curState) modalUndoStack.push(curState);

            apDungSnapshotMainTrack(activeModalTrack, nextState);
            capNhatOInputKichThuocTuTrack(activeModalTrack);
            renderCacHangModalChiTiet(true);
            if (typeof dongBoTrangThaiSuaSauThaoTac === 'function') dongBoTrangThaiSuaSauThaoTac();
            hienToast("↪ Đã làm lại!");
        });



        // DUYỆT & LƯU (các hàm capNhatNutDuyet / thucHienLuuVaDongModal / hoiXuLyPhienBanKhiRoi đã đặt ở module scope)

        if (window.khoDuyet && typeof window.khoDuyet.onThayDoi === 'function') {
            window.khoDuyet.onThayDoi(() => {
                capNhatNutDuyet();
                const modalEl = document.getElementById('cvat-detail-modal');
                if (modalEl && modalEl.style.display !== 'none' && modalShowOtherObjects) {
                    document.querySelectorAll('.frame-detail-row .canvas-top').forEach(cTop => {
                        const fn = Number(cTop._frameNum);
                        if (Number.isFinite(fn)) taiVeCanvasTheoFrame(cTop, 'top', fn);
                    });
                }
            });
        }

        document.getElementById('modal-btn-approve')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const kho = window.khoDuyet;
            if (!kho || !activeModalTrack) return;
            const curFn = (typeof activeModalFocusFrame !== 'undefined' && activeModalFocusFrame !== null) ? Number(activeModalFocusFrame) : layFrameHienTai();
            const phamVi = e.shiftKey ? 'frame' : 'track';
            const curInfo = (typeof kho.ttHienThi === 'function') ? kho.ttHienThi(activeModalTrack, curFn) : kho.trangThaiTrack(activeModalTrack, curFn);
            if (curInfo.totalValid === 0) {
                hienToast('⚠️ Track chưa có hình hộp hợp lệ để duyệt!');
                return;
            }
            const ttCur = curInfo.ttHien || curInfo.tt;
            if (ttCur === 'DA' || ttCur === 'DA_DANG_SUA') {
                hienToast(ttCur === 'DA_DANG_SUA'
                    ? '🔓 ID đang mở chỉnh sửa — bấm "💾 Lưu & cập nhật" để giữ Đã duyệt (hoặc bấm "Hủy duyệt" nếu muốn bỏ)!'
                    : '✓ ID đã duyệt và đang mở chỉnh sửa — chỉnh xong bấm 💾 Lưu để cập nhật neo (hoặc bấm "Hủy duyệt" nếu muốn bỏ).');
                return;
            }
            const next = kho.chuyenTrangThai(curInfo.tt, 'DUYET');
            if (next.hanhDong.includes('dat_cho')) {
                kho.datCho(activeModalTrack, { phamVi, frame: curFn });
                hienToast(phamVi === 'frame'
                    ? `⏳ Đã đánh dấu Duyệt Frame ${curFn} — Hãy bấm "💾 Lưu để chốt duyệt"!`
                    : `⏳ Đã đánh dấu Duyệt toàn Track — Hãy bấm "💾 Lưu để chốt duyệt"!`);
            } else if (next.hanhDong.includes('bo_cho')) {
                kho.boCho(activeModalTrack);
                hienToast('↩ Đã bỏ đánh dấu chờ Duyệt.');
            }
            capNhatNutDuyet();
        });

        document.getElementById('modal-btn-unapprove')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const kho = window.khoDuyet;
            if (!kho || !activeModalTrack) return;
            const curFn = (typeof activeModalFocusFrame !== 'undefined' && activeModalFocusFrame !== null) ? Number(activeModalFocusFrame) : layFrameHienTai();
            const phamVi = e.shiftKey ? 'frame' : 'track';
            const curInfo = kho.trangThaiTrack(activeModalTrack, curFn);
            const tidShow = activeModalTrack._trackNumber || activeModalTrack.id;
            const msg = phamVi === 'frame'
                ? `Hủy duyệt Frame ${curFn} của Track #${tidShow}?`
                : `Hủy duyệt vĩnh viễn Track #${tidShow} (${curInfo.approvedCount + curInfo.driftedCount} frames)?`;
            if (window.confirm(msg)) {
                kho.huyDuyet(activeModalTrack, phamVi === 'frame' ? { frame: curFn } : {});
                hienToast(`🗑️ Đã hủy duyệt Track #${tidShow}!`);
                capNhatNutDuyet();
            }
        });

        // LƯU TRONG MODAL (ĐỒNG BỘ 3D TỨC THÌ KHÔNG CẦN F5; CHỐT DUYỆT HOẶC CẬP NHẬT NEO ĐÃ DUYỆT)
        document.getElementById('modal-btn-save')?.addEventListener('click', () => {
            thucHienLuuVaDongModal({ giuModalMo: false });
        });
    }



    /**

     * Theo dõi frame hiện tại từ giao diện CVAT

     */

    function layFrameHienTai() {
        if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.getCurrentFrameNumber === 'function') {
            const fn = window.quanLyAPICVAT.getCurrentFrameNumber();
            if (Number.isInteger(fn)) return fn;
        }
        const inp = document.querySelector('.cvat-player-frame-selector input') ||
                    document.querySelector('input.cvat-player-frame-selector') ||
                    document.querySelector('.cvat-player-frame-selector input[type="number"]') ||
                    document.querySelector('input[type="number"][value]');
        if (inp && inp.value !== undefined) {
            return parseInt(inp.value, 10) || 0;
        }
        return 0;
    }



    /**
     * Đồng bộ Track ID và kích thước từ CVAT 3D Canvas / Sidebar về Toolbar HUD
     */
    function dongBoTrackTuCVAT(hienThiToast = false) {
        const modalEl = document.getElementById('cvat-detail-modal');
        if (!hienThiToast && modalEl && modalEl.style.display !== 'none' && activeModalTrack) {
            return selectedTrackId;
        }
        let detectedId = null;

        // 1. Kiểm tra từ CVAT Redux Store (nhanh nhất & chính xác nhất)
        try {
            const ann = window.quanLyAPICVAT ? window.quanLyAPICVAT.getAnnotationState()?.annotations : null;
            if (ann) {
                const activeId = ann.activatedStateID !== undefined && ann.activatedStateID !== null ? ann.activatedStateID : ann.selectedStateID;
                if (activeId !== undefined && activeId !== null) {
                    const states = ann.states || [];
                    const st = states.find(s => s && (s.clientID === activeId || s.serverID === activeId));
                    if (st) {
                        detectedId = st.clientID !== undefined ? st.clientID : (st.serverID !== undefined ? st.serverID : activeId);
                    } else {
                        detectedId = activeId;
                    }
                }
            }
        } catch (e) {}

        // 2. Quét DOM sidebar của CVAT nếu Redux chưa trả về
        if (detectedId === null) {
            const activeCard = document.querySelector(
                '.cvat-objects-sidebar-state-item.cvat-objects-sidebar-state-item-active, ' +
                '.cvat-objects-sidebar-state-item-active, ' +
                '.cvat-objects-sidebar-item-active, ' +
                '.cvat-objects-sidebar-item.selected, ' +
                '[class*="cvat-objects-sidebar-state-item"][class*="active"]'
            );
            if (activeCard) {
                const header = activeCard.querySelector(
                    '.cvat-objects-sidebar-state-item-header, ' +
                    '.cvat-objects-sidebar-item-title, ' +
                    '.cvat-text-color'
                ) || activeCard;
                const txt = header.textContent.trim();
                const m = txt.match(/#(\d+)/) || txt.match(/^(\d+)/) || txt.match(/(\d+)\s+CUBOID/i);
                if (m && m[1]) {
                    detectedId = parseInt(m[1], 10);
                }
            }
        }

        // 3. Fallback: Đọc từ input hiện tại nếu đã nhập
        if (detectedId === null) {
            const inp = document.getElementById('inp-track-id');
            if (inp && inp.value) {
                detectedId = parseInt(inp.value, 10);
            }
        }

        if (detectedId !== null && !isNaN(detectedId)) {
            const isChanged = (selectedTrackId !== detectedId);
            selectedTrackId = detectedId;
            const inp = document.getElementById('inp-track-id');
            if (inp && document.activeElement !== inp) {
                inp.value = detectedId;
            }
            if (isChanged || hienThiToast) {
                docKichThuocTrackHienTai(detectedId);
            }

            if (hienThiToast) {
                const inL = document.getElementById('inp-dim-l')?.value || '--';
                const inW = document.getElementById('inp-dim-w')?.value || '--';
                const inH = document.getElementById('inp-dim-h')?.value || '--';
                hienToast(`🎯 Đã chọn Track #${detectedId} (L:${inL}m, W:${inW}m, H:${inH}m)`);
            }
            return detectedId;
        } else {
            if (hienThiToast) {
                hienToast("⚠️ Chưa chọn đối tượng nào trên 3D Canvas hoặc Sidebar!");
            }
            return null;
        }
    }

    function khoiTaoTheoDoiFrame() {
        setInterval(() => {
            dongBoTrackTuCVAT(false);
        }, 400);
    }



    /**

     * Khởi tạo phím tắt nhanh

     */

    function khoiTaoPhimTat() {

        window.addEventListener('keydown', (e) => {

            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;



            // Alt + E: Mở modal chi tiết track

            if (e.altKey && (e.key === 'e' || e.key === 'E')) {

                e.preventDefault();

                const inp = document.getElementById('inp-track-id');

                const tid = inp ? parseInt(inp.value, 10) : selectedTrackId;

                if (tid) moModalChiTietTrack(tid);

            }

            // Alt + D: Đồng bộ size

            else if (e.altKey && (e.key === 'd' || e.key === 'D')) {

                e.preventDefault();

                document.getElementById('btn-dong-bo-track-don')?.click();

            }

            // Alt + R: Đảo đầu 180°

            else if (e.altKey && (e.key === 'r' || e.key === 'R')) {

                e.preventDefault();

                document.getElementById('btn-dao-dau-xe')?.click();

            }

            // Phím tắt trong Modal: Ctrl + Z / Ctrl + Y / Escape / Arrow Navigation / T / M
            const modal = document.getElementById('cvat-detail-modal');
            const isModalOpen = modal && modal.style.display !== 'none';
            if (isModalOpen) {
                if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
                    e.preventDefault();
                    document.getElementById('modal-btn-undo')?.click();
                } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
                    e.preventDefault();
                    document.getElementById('modal-btn-redo')?.click();
                } else if (e.key === 'Escape') {
                    const viewer2d = document.getElementById('cvat-2d-image-viewer');
                    const camMapModal = document.getElementById('cvat-cam-mapping-modal');
                    const fsCard = document.querySelector('.row-view-card.is-fullscreen-view');
                    if (camMapModal && camMapModal.style.display !== 'none') {
                        e.preventDefault();
                        e.stopPropagation();
                        camMapModal.style.display = 'none';
                        return;
                    }
                    if (viewer2d && viewer2d.style.display !== 'none') {
                        e.preventDefault();
                        e.stopPropagation();
                        viewer2d.style.display = 'none';
                        return;
                    }
                    if (fsCard) {
                        e.preventDefault();
                        e.stopPropagation();
                        const btn = fsCard.querySelector('.btn-view-fullscreen');
                        if (btn) btn.click();
                        return;
                    }
                    e.preventDefault();
                    document.getElementById('modal-btn-close')?.click();
                } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    const curFn = layFrameHienTaiCuaModal();
                    const idx = frames.indexOf(curFn);
                    let nextFn = curFn;
                    if (idx >= 0 && idx < frames.length - 1) {
                        nextFn = frames[idx + 1];
                    } else if (idx === -1 && frames.length > 0) {
                        nextFn = frames[0];
                    }
                    nhayToiFrameModal(nextFn, true);
                } else if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    const curFn = layFrameHienTaiCuaModal();
                    const idx = frames.indexOf(curFn);
                    let prevFn = curFn;
                    if (idx > 0) {
                        prevFn = frames[idx - 1];
                    } else if (idx === -1 && frames.length > 0) {
                        prevFn = frames[0];
                    }
                    nhayToiFrameModal(prevFn, true);
                } else if (e.key === 'PageDown') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    const curFn = layFrameHienTaiCuaModal();
                    const idx = frames.indexOf(curFn);
                    const targetIdx = Math.min(frames.length - 1, (idx >= 0 ? idx : 0) + 5);
                    if (frames[targetIdx] !== undefined) nhayToiFrameModal(frames[targetIdx], true);
                } else if (e.key === 'PageUp') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    const curFn = layFrameHienTaiCuaModal();
                    const idx = frames.indexOf(curFn);
                    const targetIdx = Math.max(0, (idx >= 0 ? idx : 0) - 5);
                    if (frames[targetIdx] !== undefined) nhayToiFrameModal(frames[targetIdx], true);
                } else if (e.key === 'Home') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    if (frames.length > 0) nhayToiFrameModal(frames[0], true);
                } else if (e.key === 'End') {
                    e.preventDefault();
                    const frames = layDanhSachFramesModal();
                    if (frames.length > 0) nhayToiFrameModal(frames[frames.length - 1], true);

                } else if (e.key === 'm' || e.key === 'M') {
                    e.preventDefault();
                    document.getElementById('modal-btn-minimize')?.click();
                }
                // Phím Space: Toggle chọn/bỏ chọn checkbox frame hiện tại
                else if (e.code === 'Space') {
                    e.preventDefault();
                    const curF = Number(layFrameHienTaiCuaModal());
                    const chk = document.querySelector(`.chk-frame-row[data-frame="${curF}"]`);
                    if (chk) {
                        chk.checked = !chk.checked;
                        if (chk.checked) modalSelectedFrames.add(curF);
                        else modalSelectedFrames.delete(curF);
                        const row = document.getElementById(`modal-row-frame-${curF}`);
                        if (row) {
                            row.classList.toggle('is-checked-row', chk.checked);
                        }
                        if (typeof capNhatTrangThaiNutChonCa === 'function') {
                            capNhatTrangThaiNutChonCa();
                        }
                    }
                }
                // Phím O: Toggle cờ Outside frame hiện tại
                else if (e.key === 'o' || e.key === 'O') {
                    e.preventDefault();
                    const curF = layFrameHienTaiCuaModal();
                    const btnOut = document.querySelector(`#modal-row-frame-${curF} .btn-nudge-mini[data-action="out"]`);
                    if (btnOut) btnOut.click();
                }
                // Phím R: Đảo đầu 180° tại frame hiện tại
                else if (e.key === 'r' || e.key === 'R') {
                    e.preventDefault();
                    const curF = layFrameHienTaiCuaModal();
                    const btnFlip = document.querySelector(`#modal-row-frame-${curF} .btn-nudge-mini[data-action="flip"]`);
                    if (btnFlip) btnFlip.click();
                }
                // Alt + Arrows: Nhích nhanh tịnh tiến ±5cm (Dọc/Ngang/Cao)
                else if (e.altKey && e.key === 'ArrowUp') {
                    e.preventDefault();
                    tinhTienDongBoTay(0.05, 0, 0);
                } else if (e.altKey && e.key === 'ArrowDown') {
                    e.preventDefault();
                    tinhTienDongBoTay(-0.05, 0, 0);
                } else if (e.altKey && e.key === 'ArrowLeft') {
                    e.preventDefault();
                    tinhTienDongBoTay(0, -0.05, 0);
                } else if (e.altKey && e.key === 'ArrowRight') {
                    e.preventDefault();
                    tinhTienDongBoTay(0, 0.05, 0);
                }

            }
        });

    }



    /**

     * Hiển thị Toast thông báo nhanh

     */

    let toastTimer = null;

    function hienToast(msg, clickHandler = null, btnText = null) {

        const toast = document.getElementById('cvat-3d-toast');

        if (!toast) return;

        toast.innerHTML = '';
        const span = document.createElement('span');
        span.textContent = msg;
        toast.appendChild(span);

        if (clickHandler && typeof clickHandler === 'function') {
            const btn = document.createElement('button');
            btn.style.marginLeft = '10px';
            btn.style.padding = '3px 10px';
            btn.style.borderRadius = '5px';
            btn.style.backgroundColor = '#2563eb';
            btn.style.color = '#ffffff';
            btn.style.border = '1px solid #60a5fa';
            btn.style.cursor = 'pointer';
            btn.style.fontSize = '12px';
            btn.style.fontWeight = 'bold';
            btn.textContent = btnText || '🔄 Nạp lại';
            btn.onmouseenter = () => { btn.style.backgroundColor = '#1d4ed8'; };
            btn.onmouseleave = () => { btn.style.backgroundColor = '#2563eb'; };
            btn.onclick = (e) => {
                e.stopPropagation();
                clickHandler();
            };
            toast.appendChild(btn);
        }

        toast.classList.add('show');

        if (toastTimer) clearTimeout(toastTimer);

        toastTimer = setTimeout(() => {

            toast.classList.remove('show');

        }, clickHandler ? 6000 : 2800);

    }



    // Cầu nối kiểm thử tự động (Automated Verification Bridge)
    if (typeof window !== 'undefined') {
        window.__cvatTestBridge = {
            pcdFrameCache,
            pcdLoadingPromises,
            taiDiemLiDARChoFrame,
            giaiMaPCD,
            sinhDiemLiDARXe,
            layJobIdHienTai,
            getActiveModalTrack: () => activeModalTrack,
            setActiveModalTrack: (t) => {
                if (t && t.shapes) {
                    for (const s of t.shapes) {
                        if (s && s.frame !== undefined) s.frame = parseInt(s.frame, 10);
                    }
                }
                activeModalTrack = t;
            },
            getCurrentAnnotations: () => currentAnnotations,
            setCurrentAnnotations: (a) => { currentAnnotations = a; },
            getCurrentLabels: () => currentLabels,
            setCurrentLabels: (l) => { currentLabels = l; },
            chuyenDiemSangCucBo,
            renderCacHangModalChiTiet,
            moModalChiTietTrack,
            capNhatThongKe
        };
    }


    // =========================================================================
    // [v2.7.5] HỆ THỐNG XEM ẢNH 2D THEO HƯỚNG VẬT THỂ & NỐI GÓC CAMERA THỦ CÔNG
    // =========================================================================
    const contextImageCache = new Map(); // key: `${jobId}_${frameNum}` -> Array<{ idx, name, url }>

    // Danh sách 8 hướng góc chuẩn quanh xe LiDAR (Hệ tọa độ chuẩn: +X Trước = 0°, +Y Trái = +90°, -Y Phải = -90°, ±180° Sau)
    const DANH_SACH_GOC_CAM_CHUAN = [
        { key: 'front',       label: '⬆️ Front (Trước 0°)',             deg: 0 },
        { key: 'front_left',  label: '↖️ Front-Left (Trước Trái +45°)',  deg: 45 },
        { key: 'left',        label: '⬅️ Left (Trái +90°)',             deg: 90 },
        { key: 'back_left',   label: '↙️ Back-Left (Sau Trái +135°)',    deg: 135 },
        { key: 'back',        label: '⬇️ Back / Rear (Sau 180°)',       deg: 180 },
        { key: 'back_right',  label: '↘️ Back-Right (Sau Phải -135°)',  deg: -135 },
        { key: 'right',       label: '➡️ Right (Phải -90°)',            deg: -90 },
        { key: 'front_right', label: '↗️ Front-Right (Trước Phải -45°)', deg: -45 }
    ];

    const MAP_GOC_THEO_KEY = {};
    for (const item of DANH_SACH_GOC_CAM_CHUAN) {
        MAP_GOC_THEO_KEY[item.key] = item;
    }

    /**
     * Tự động đoán hướng camera từ tên file ảnh (VD: cam_back_left.jpg, front_right.png, rear_left...)
     */
    function doanHuongCamTuTenAnh(rawName) {
        if (!rawName || typeof rawName !== 'string') return 'unknown';
        const s = rawName.toLowerCase().replace(/[^a-z0-9]/g, '_');

        // Ưu tiên bắt tổ hợp 2 từ trước (front_left, front_right, back_left, back_right, rear_left, rear_right)
        if ((s.includes('front') || s.includes('fwd') || s.includes('fore')) && (s.includes('left') || s.includes('_fl') || s.includes('fl_'))) return 'front_left';
        if ((s.includes('front') || s.includes('fwd') || s.includes('fore')) && (s.includes('right') || s.includes('_fr') || s.includes('fr_'))) return 'front_right';
        if ((s.includes('back') || s.includes('rear') || s.includes('bwd')) && (s.includes('left') || s.includes('_bl') || s.includes('_rl') || s.includes('bl_') || s.includes('rl_'))) return 'back_left';
        if ((s.includes('back') || s.includes('rear') || s.includes('bwd')) && (s.includes('right') || s.includes('_br') || s.includes('_rr') || s.includes('br_') || s.includes('rr_'))) return 'back_right';

        // Bắt các viết tắt thông dụng (CAM_FL, CAM_FR, CAM_BL, CAM_BR, CAM_RL, CAM_RR)
        if (/(?:^|_)(fl|f_l|left_front)(?:_|$)/.test(s)) return 'front_left';
        if (/(?:^|_)(fr|f_r|right_front)(?:_|$)/.test(s)) return 'front_right';
        if (/(?:^|_)(bl|b_l|rl|r_l|left_back|left_rear)(?:_|$)/.test(s)) return 'back_left';
        if (/(?:^|_)(br|b_r|rr|r_r|right_back|right_rear)(?:_|$)/.test(s)) return 'back_right';

        // Tiếp theo bắt các hướng đơn (front, back/rear, left, right)
        if (s.includes('front') || s.includes('forward') || s.includes('center_cam') || /(?:^|_)(cam_f|f_cam)(?:_|$)/.test(s)) return 'front';
        if (s.includes('back') || s.includes('rear') || /(?:^|_)(cam_b|b_cam|cam_r)(?:_|$)/.test(s)) return 'back';
        if (s.includes('left')) return 'left';
        if (s.includes('right')) return 'right';

        return 'unknown';
    }

    /**
     * Đọc cấu hình nối góc cam do người dùng lưu trong localStorage
     */
    function layCauHinhNoiGocCam(jobId) {
        try {
            const perJob = localStorage.getItem(`cvat_cam_map_job_${jobId}`);
            if (perJob) return JSON.parse(perJob);
            const globalMap = localStorage.getItem('cvat_cam_map_global');
            if (globalMap) return JSON.parse(globalMap);
        } catch (_) {}
        return null;
    }

    function luuCauHinhNoiGocCam(jobId, mapObj) {
        try {
            const jsonStr = JSON.stringify(mapObj || {});
            if (jobId) localStorage.setItem(`cvat_cam_map_job_${jobId}`, jsonStr);
            localStorage.setItem('cvat_cam_map_global', jsonStr);
        } catch (_) {}
    }

    /**
     * Giải nén file ZIP chứa các ảnh context_image của CVAT ngay trên trình duyệt (Hỗ trợ cả Store=0 và Deflate=8)
     */
    async function giaiNenZipContextImages(arrayBuffer) {
        const view = new DataView(arrayBuffer);
        const bytes = new Uint8Array(arrayBuffer);
        const results = [];
        let offset = 0;

        while (offset + 30 <= bytes.length) {
            const sig = view.getUint32(offset, true);
            if (sig !== 0x04034b50) break; // Không phải Local File Header PK\x03\x04

            const method = view.getUint16(offset + 8, true);
            const compSize = view.getUint32(offset + 18, true);
            const uncompSize = view.getUint32(offset + 22, true);
            const nameLen = view.getUint16(offset + 26, true);
            const extraLen = view.getUint16(offset + 28, true);

            const nameBytes = bytes.subarray(offset + 30, offset + 30 + nameLen);
            const fileName = new TextDecoder('utf-8').decode(nameBytes);
            const dataStart = offset + 30 + nameLen + extraLen;
            const dataEnd = dataStart + compSize;
            if (dataEnd > bytes.length) break;

            const isDir = fileName.endsWith('/');
            const lowerName = fileName.toLowerCase();
            const isImg = /\.(jpg|jpeg|png|webp|bmp)$/i.test(lowerName);

            if (!isDir && isImg && compSize > 0) {
                const rawSlice = bytes.subarray(dataStart, dataEnd);
                let fileBytes = null;
                if (method === 0) {
                    fileBytes = rawSlice;
                } else if (method === 8 && typeof DecompressionStream !== 'undefined') {
                    try {
                        const ds = new DecompressionStream('deflate-raw');
                        const writer = ds.writable.getWriter();
                        writer.write(rawSlice);
                        writer.close();
                        const resp = new Response(ds.readable);
                        const ab = await resp.arrayBuffer();
                        fileBytes = new Uint8Array(ab);
                    } catch (_) {}
                }
                if (fileBytes) {
                    const mime = lowerName.endsWith('.png') ? 'image/png' : (lowerName.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
                    const blob = new Blob([fileBytes], { type: mime });
                    const cleanName = fileName.split('/').pop() || fileName;
                    results.push({
                        name: cleanName,
                        fullPath: fileName,
                        url: URL.createObjectURL(blob)
                    });
                }
            }
            offset = dataEnd;
        }
        return results;
    }

    /**
     * Tải danh sách ảnh 2D (Context Images) của 1 Frame từ CVAT (Kết hợp CVAT Core -> REST API ZIP/Image -> DOM Fallback)
     */
    async function taiDanhSachAnh2DChoFrame(jobId, frameNum) {
        const cacheKey = `${jobId}_${frameNum}`;
        if (contextImageCache.has(cacheKey)) {
            return contextImageCache.get(cacheKey);
        }

        const list = [];

        // TẦNG 1: Gọi qua CVAT Core Job Instance nếu có
        try {
            const jobInst = window.quanLyAPICVAT ? window.quanLyAPICVAT.getJobInstance() : null;
            if (jobInst && jobInst.frames && typeof jobInst.frames.contextImage === 'function') {
                const ctxData = await jobInst.frames.contextImage(frameNum);
                if (ctxData && typeof ctxData === 'object') {
                    for (const [k, val] of Object.entries(ctxData)) {
                        if (!val) continue;
                        let url = '';
                        if (typeof val === 'string') {
                            url = val;
                        } else if (val instanceof Blob) {
                            url = URL.createObjectURL(val);
                        } else if (typeof ImageBitmap !== 'undefined' && val instanceof ImageBitmap) {
                            const cv = document.createElement('canvas');
                            cv.width = val.width;
                            cv.height = val.height;
                            cv.getContext('2d').drawImage(val, 0, 0);
                            url = cv.toDataURL('image/jpeg', 0.92);
                        } else if (val instanceof HTMLImageElement || val instanceof HTMLCanvasElement) {
                            const cv = document.createElement('canvas');
                            cv.width = val.naturalWidth || val.width || 800;
                            cv.height = val.naturalHeight || val.height || 600;
                            cv.getContext('2d').drawImage(val, 0, 0);
                            url = cv.toDataURL('image/jpeg', 0.92);
                        }
                        if (url) {
                            list.push({ idx: list.length, name: String(k), url });
                        }
                    }
                }
            }
        } catch (_) {}

        // TẦNG 2: Tải trực tiếp qua REST API CVAT `/api/jobs/${jobId}/data?type=context_image&number=${frameNum}`
        if (list.length === 0 && jobId) {
            try {
                const resp = await fetch(`/api/jobs/${jobId}/data?type=context_image&number=${frameNum}`, {
                    credentials: 'include'
                });
                if (resp.ok) {
                    const contentType = (resp.headers.get('content-type') || '').toLowerCase();
                    const ab = await resp.arrayBuffer();
                    const u8 = new Uint8Array(ab);
                    // Kiểm tra chữ ký PK (0x50 0x4B) của file ZIP
                    if (u8.length > 4 && u8[0] === 0x50 && u8[1] === 0x4B) {
                        const extracted = await giaiNenZipContextImages(ab);
                        extracted.forEach((it, idx) => {
                            list.push({ idx, name: it.name, url: it.url });
                        });
                    } else if (u8.length > 0 && (contentType.includes('image') || u8[0] === 0xFF || u8[0] === 0x89)) {
                        const blob = new Blob([ab], { type: contentType || 'image/jpeg' });
                        list.push({ idx: 0, name: `context_frame_${frameNum}.jpg`, url: URL.createObjectURL(blob) });
                    }
                }
            } catch (_) {}
        }

        // TẦNG 3: Quét trực tiếp các thẻ <img> / <canvas> của khung Context Image trên DOM CVAT (nếu đang ở cùng frame)
        if (list.length === 0) {
            const domEls = document.querySelectorAll('.cvat-context-image-wrapper img, .cvat-canvas-context-image-wrapper img, [class*="context-image"] img, [class*="contextImage"] img, .cvat-context-image-wrapper canvas');
            domEls.forEach((el, i) => {
                try {
                    const rawTitle = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('data-name') || el.dataset?.cam || `Cam_${i + 1}`;
                    if (el.tagName === 'IMG' && el.src) {
                        list.push({ idx: list.length, name: rawTitle, url: el.src });
                    } else if (el.tagName === 'CANVAS' && el.width > 0 && el.height > 0) {
                        list.push({ idx: list.length, name: rawTitle, url: el.toDataURL('image/jpeg', 0.9) });
                    }
                } catch (_) {}
            });
        }

        if (list.length > 0) {
            contextImageCache.set(cacheKey, list);
        }
        return list;
    }

    /**
     * Phân tích danh sách ảnh 2D của frame, gán góc hướng (ưu tiên cấu hình thủ công -> đọc tên ảnh),
     * đồng thời phát hiện thiếu ảnh, không rõ tên hoặc 2 ảnh trùng cùng 1 góc.
     */
    function phanTichVaGanHuongAnh2D(rawImages, jobId) {
        const manualMap = layCauHinhNoiGocCam(jobId) || {};
        const dirCount = {};
        let hasUnknown = false;
        let hasDuplicate = false;

        const items = (rawImages || []).map((img, idx) => {
            // Kiểm tra xem người dùng đã gán tay cho tên ảnh này hoặc theo vị trí index chưa
            let assignedDir = manualMap[img.name] || manualMap[`__idx_${idx}`] || '';
            let isManual = Boolean(assignedDir && assignedDir !== 'auto');

            if (!assignedDir || assignedDir === 'auto') {
                assignedDir = doanHuongCamTuTenAnh(img.name);
            }

            if (!assignedDir || assignedDir === 'unknown') {
                assignedDir = 'unknown';
                hasUnknown = true;
            } else {
                dirCount[assignedDir] = (dirCount[assignedDir] || 0) + 1;
                if (dirCount[assignedDir] > 1) {
                    hasDuplicate = true;
                }
            }

            const dirMeta = MAP_GOC_THEO_KEY[assignedDir] || null;
            return {
                idx,
                name: img.name,
                url: img.url,
                dirKey: assignedDir,
                dirLabel: dirMeta ? dirMeta.label : '❓ Chưa rõ góc',
                dirDeg: dirMeta ? dirMeta.deg : null,
                isManual
            };
        });

        // Kiểm tra nếu tổng số ảnh ít hơn 4 hoặc có ảnh trùng góc / không rõ góc -> Đánh dấu cần chú ý
        const isMissingAngles = items.length > 0 && items.length < 4;
        const needsManualAttention = hasUnknown || hasDuplicate || isMissingAngles;

        // Cập nhật trạng thái nút #btn-hud-cam-map trên thanh HUD
        const btnHudCam = document.getElementById('btn-hud-cam-map');
        if (btnHudCam) {
            if (needsManualAttention) {
                btnHudCam.classList.add('has-warning');
                btnHudCam.title = '⚠️ Có ảnh 2D chưa rõ góc, bị thiếu hoặc trùng góc! Bấm để tự nối ảnh vào góc camera.';
            } else {
                btnHudCam.classList.remove('has-warning');
                btnHudCam.title = 'Tự nối các ảnh 2D vào đúng góc hướng Camera';
            }
        }

        return {
            items,
            hasUnknown,
            hasDuplicate,
            isMissingAngles,
            needsManualAttention
        };
    }

    /**
     * Tính góc phương vị (Azimuth) của vật thể (Cuboid) so với xe LiDAR gốc (0, 0, 0)
     * Hệ trục chuẩn LiDAR: +X hướng thẳng về phía trước (0°), +Y hướng sang trái (+90°), -Y hướng sang phải (-90°), ±180° phía sau
     */
    function tinhGocHuongVatTheSoVoiXeLiDAR(shape) {
        if (!shape || !Array.isArray(shape.points) || shape.points.length < 3) {
            return { deg: 0, distXY: 0, idealDirKey: 'front', idealDirLabel: '⬆️ Front (0°)' };
        }
        const [x, y] = shape.points;
        const distXY = Math.hypot(x, y);
        const deg = Math.atan2(y, x) * (180 / Math.PI);

        // Tìm hướng chuẩn lý tưởng gần nhất trong 8 hướng
        let bestStandard = DANH_SACH_GOC_CAM_CHUAN[0];
        let minDiff = 999;
        for (const std of DANH_SACH_GOC_CAM_CHUAN) {
            let diff = Math.abs(deg - std.deg);
            if (diff > 180) diff = 360 - diff;
            if (diff < minDiff) {
                minDiff = diff;
                bestStandard = std;
            }
        }

        return {
            deg,
            distXY,
            idealDirKey: bestStandard.key,
            idealDirLabel: bestStandard.label
        };
    }

    /**
     * Chọn ảnh 2D có góc hướng khớp nhất với góc phương vị của vật thể
     */
    function chonAnh2DChuanHuongNhat(analyzedItems, objAzimuthDeg) {
        if (!analyzedItems || analyzedItems.length === 0) return 0;

        let bestIdx = 0;
        let bestDiff = 9999;

        for (let i = 0; i < analyzedItems.length; i++) {
            const it = analyzedItems[i];
            if (typeof it.dirDeg === 'number') {
                let diff = Math.abs(objAzimuthDeg - it.dirDeg);
                if (diff > 180) diff = 360 - diff;
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestIdx = i;
                }
            }
        }
        return bestIdx;
    }

    /**
     * Khởi tạo DOM cho Khung Xem Ảnh 2D Nổi (#cvat-2d-image-viewer)
     */
    let v2dState = {
        frameNum: 0,
        images: [],
        activeIndex: 0,
        bestMatchIndex: 0,
        objInfo: null,
        analysis: null,
        zoom: 1.0,
        panX: 0,
        panY: 0,
        isDragging: false,
        startX: 0,
        startY: 0
    };

    function damBaoKhungXemAnh2DTonTai() {
        let viewer = document.getElementById('cvat-2d-image-viewer');
        if (viewer) return viewer;

        viewer = document.createElement('div');
        viewer.id = 'cvat-2d-image-viewer';
        viewer.innerHTML = `
            <div class="v2d-header" id="v2d-drag-header">
                <div class="v2d-title-wrap">
                    <span class="v2d-title" id="v2d-header-title">📷 ẢNH 2D - FRAME 0</span>
                    <span class="v2d-dir-badge" id="v2d-obj-azimuth-badge">🎯 Hướng vật thể: --°</span>
                    <span class="v2d-warn-badge" id="v2d-warn-mapping" style="display:none;" title="Bấm để tự nối lại các ảnh vào đúng góc camera">⚠️ Góc cam trùng/chưa rõ (Bấm để tự xếp)</span>
                </div>
                <div class="v2d-header-actions">
                    <button class="btn-m-action" id="v2d-btn-open-mapper" style="padding:3px 8px;font-size:11px;background:#0f766e;border:1px solid #2dd4bf;color:#fff;border-radius:4px;cursor:pointer;" title="Tự nối các ảnh vào đúng góc hướng camera">⚙️ Nối Góc Cam</button>
                    <button class="btn-m-action" id="v2d-btn-reset-zoom" style="padding:3px 8px;font-size:11px;background:#1e293b;border:1px solid #475569;color:#cbd5e1;border-radius:4px;cursor:pointer;" title="Đặt lại phóng to 100%">🔍 1:1</button>
                    <button class="btn-m-icon btn-m-close" id="v2d-btn-close" title="Đóng khung Ảnh 2D (Esc)">✕</button>
                </div>
            </div>
            <div class="v2d-tabs-bar" id="v2d-tabs-bar"></div>
            <div class="v2d-stage" id="v2d-stage">
                <button class="v2d-nav-arrow prev" id="v2d-btn-prev" title="Đổi sang ảnh camera trước (Phím [ hoặc ◀)">❮</button>
                <img id="v2d-main-img" src="" alt="2D Context Image" />
                <div id="v2d-empty-msg" style="display:none;color:#94a3b8;font-size:13px;text-align:center;padding:20px;"></div>
                <button class="v2d-nav-arrow next" id="v2d-btn-next" title="Đổi sang ảnh camera tiếp theo (Phím ] hoặc ▶)">❯</button>
            </div>
            <div class="v2d-footer">
                <span id="v2d-footer-filename" style="font-family:monospace;color:#38bdf8;font-weight:700;">--</span>
                <span style="display:inline-flex;align-items:center;gap:8px;">
                    <button class="btn-m-nav" id="v2d-btn-prev-frame" title="Xem ảnh 2D của Frame trước">⏮ Frame Trước</button>
                    <button class="btn-m-nav" id="v2d-btn-next-frame" title="Xem ảnh 2D của Frame tiếp theo">Frame Tiếp ⏭</button>
                    <span style="color:#64748b;">Cuộn chuột để Zoom • Kéo để Pan • Bấm ❮ ❯ để đổi ảnh</span>
                </span>
            </div>
        `;
        document.body.appendChild(viewer);

        // Kéo thả khung cửa sổ Ảnh 2D
        const header = viewer.querySelector('#v2d-drag-header');
        let isMovingWin = false, winStartX = 0, winStartY = 0, initLeft = 0, initTop = 0;
        header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button, .v2d-warn-badge')) return;
            isMovingWin = true;
            const rect = viewer.getBoundingClientRect();
            viewer.style.transform = 'none';
            viewer.style.left = `${rect.left}px`;
            viewer.style.top = `${rect.top}px`;
            winStartX = e.clientX;
            winStartY = e.clientY;
            initLeft = rect.left;
            initTop = rect.top;
        });
        window.addEventListener('mousemove', (e) => {
            if (isMovingWin) {
                viewer.style.left = `${Math.max(0, initLeft + e.clientX - winStartX)}px`;
                viewer.style.top = `${Math.max(0, initTop + e.clientY - winStartY)}px`;
            } else if (v2dState.isDragging) {
                v2dState.panX += (e.clientX - v2dState.startX);
                v2dState.panY += (e.clientY - v2dState.startY);
                v2dState.startX = e.clientX;
                v2dState.startY = e.clientY;
                capNhatTransformAnh2D();
            }
        });
        window.addEventListener('mouseup', () => {
            isMovingWin = false;
            v2dState.isDragging = false;
        });

        // Zoom & Pan trên ảnh 2D
        const stage = viewer.querySelector('#v2d-stage');
        stage.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY < 0 ? 1.15 : 0.87;
            v2dState.zoom = Math.max(0.5, Math.min(8.0, v2dState.zoom * factor));
            capNhatTransformAnh2D();
        }, { passive: false });

        stage.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            v2dState.isDragging = true;
            v2dState.startX = e.clientX;
            v2dState.startY = e.clientY;
        });

        // Các nút điều khiển
        viewer.querySelector('#v2d-btn-close')?.addEventListener('click', () => {
            viewer.style.display = 'none';
        });
        viewer.querySelector('#v2d-btn-reset-zoom')?.addEventListener('click', () => {
            v2dState.zoom = 1.0;
            v2dState.panX = 0;
            v2dState.panY = 0;
            capNhatTransformAnh2D();
        });
        viewer.querySelector('#v2d-btn-open-mapper')?.addEventListener('click', () => {
            moModalNoiGocCam2D(v2dState.frameNum);
        });
        viewer.querySelector('#v2d-warn-mapping')?.addEventListener('click', () => {
            moModalNoiGocCam2D(v2dState.frameNum);
        });
        viewer.querySelector('#v2d-btn-prev')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (v2dState.images.length > 0) {
                v2dState.activeIndex = (v2dState.activeIndex - 1 + v2dState.images.length) % v2dState.images.length;
                renderTrangThaiKhungXemAnh2D();
            }
        });
        viewer.querySelector('#v2d-btn-next')?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (v2dState.images.length > 0) {
                v2dState.activeIndex = (v2dState.activeIndex + 1) % v2dState.images.length;
                renderTrangThaiKhungXemAnh2D();
            }
        });
        viewer.querySelector('#v2d-btn-prev-frame')?.addEventListener('click', () => {
            const fns = layDanhSachFramesModal();
            const idx = fns.indexOf(v2dState.frameNum);
            if (idx > 0) moKhungXemAnh2D(fns[idx - 1]);
            else if (v2dState.frameNum > 0) moKhungXemAnh2D(v2dState.frameNum - 1);
        });
        viewer.querySelector('#v2d-btn-next-frame')?.addEventListener('click', () => {
            const fns = layDanhSachFramesModal();
            const idx = fns.indexOf(v2dState.frameNum);
            if (idx >= 0 && idx < fns.length - 1) moKhungXemAnh2D(fns[idx + 1]);
            else moKhungXemAnh2D(v2dState.frameNum + 1);
        });

        return viewer;
    }

    function capNhatTransformAnh2D() {
        const img = document.getElementById('v2d-main-img');
        if (img) {
            img.style.transform = `translate(${v2dState.panX}px, ${v2dState.panY}px) scale(${v2dState.zoom})`;
        }
    }

    function renderTrangThaiKhungXemAnh2D() {
        const viewer = damBaoKhungXemAnh2DTonTai();
        const titleEl = viewer.querySelector('#v2d-header-title');
        const badgeEl = viewer.querySelector('#v2d-obj-azimuth-badge');
        const warnEl = viewer.querySelector('#v2d-warn-mapping');
        const tabsBar = viewer.querySelector('#v2d-tabs-bar');
        const imgEl = viewer.querySelector('#v2d-main-img');
        const emptyMsg = viewer.querySelector('#v2d-empty-msg');
        const footerName = viewer.querySelector('#v2d-footer-filename');

        const trId = activeModalTrack ? (activeModalTrack._trackNumber ?? activeModalTrack.id) : '--';
        if (titleEl) titleEl.textContent = `📷 ẢNH 2D - FRAME ${v2dState.frameNum} (Track #${trId})`;

        if (badgeEl && v2dState.objInfo) {
            const sign = v2dState.objInfo.deg >= 0 ? '+' : '';
            badgeEl.textContent = `🎯 Vật thể: ${sign}${v2dState.objInfo.deg.toFixed(1)}° (Cách ${v2dState.objInfo.distXY.toFixed(1)}m) → Khớp hướng: ${v2dState.objInfo.idealDirLabel}`;
        }

        if (warnEl && v2dState.analysis) {
            if (v2dState.analysis.needsManualAttention) {
                warnEl.style.display = 'inline-flex';
                const reasons = [];
                if (v2dState.analysis.hasUnknown) reasons.push('chưa rõ tên góc');
                if (v2dState.analysis.hasDuplicate) reasons.push('2 ảnh trùng góc');
                if (v2dState.analysis.isMissingAngles) reasons.push('thiếu góc ảnh');
                warnEl.textContent = `⚠️ Phát hiện ${reasons.join(', ')}! Bấm để tự xếp góc`;
            } else {
                warnEl.style.display = 'none';
            }
        }

        tabsBar.innerHTML = '';
        if (!v2dState.images || v2dState.images.length === 0) {
            imgEl.style.display = 'none';
            emptyMsg.style.display = 'block';
            emptyMsg.innerHTML = `⚠️ Không tìm thấy dữ liệu ảnh 2D (Context Image) cho <b>Frame ${v2dState.frameNum}</b>.<br><span style="font-size:11px;color:#64748b;">Nếu Job có ảnh 2D nhưng chưa nạp kịp, hãy bấm "👁️ Xem frame" hoặc kiểm tra kết nối server CVAT.</span>`;
            footerName.textContent = 'Không có ảnh 2D';
            return;
        }

        imgEl.style.display = 'block';
        emptyMsg.style.display = 'none';

        v2dState.images.forEach((it, idx) => {
            const btn = document.createElement('button');
            btn.className = `v2d-cam-tab ${idx === v2dState.activeIndex ? 'is-active' : ''} ${idx === v2dState.bestMatchIndex ? 'is-best-match' : ''}`;
            const star = idx === v2dState.bestMatchIndex ? '⭐ ' : '';
            const shortDir = it.dirKey !== 'unknown' ? it.dirLabel.replace(/^[^\s]+\s/, '') : it.name;
            btn.textContent = `${star}${idx + 1}. ${shortDir}`;
            btn.title = `Tên file gốc: ${it.name} | Hướng gán: ${it.dirLabel}`;
            btn.addEventListener('click', () => {
                v2dState.activeIndex = idx;
                v2dState.zoom = 1.0;
                v2dState.panX = 0;
                v2dState.panY = 0;
                renderTrangThaiKhungXemAnh2D();
            });
            tabsBar.appendChild(btn);
        });

        const curImg = v2dState.images[v2dState.activeIndex] || v2dState.images[0];
        if (curImg) {
            imgEl.src = curImg.url;
            capNhatTransformAnh2D();
            const isAutoPick = v2dState.activeIndex === v2dState.bestMatchIndex;
            footerName.innerHTML = `📄 File: <b>${curImg.name}</b> &nbsp;|&nbsp; 🧭 Góc Cam: <b style="color:#2dd4bf;">${curImg.dirLabel}</b> ${isAutoPick ? '<span style="color:#facc15;">(⭐ Tự động chọn chuẩn hướng nhất)</span>' : '<span style="color:#94a3b8;">(Đang chuyển xem tay)</span>'}`;
        }
    }

    /**
     * Mở Khung Xem Ảnh 2D cho frame chỉ định, tự động tính góc cuboid và chọn ảnh chuẩn hướng nhất
     */
    async function moKhungXemAnh2D(frameNum) {
        frameNum = parseInt(frameNum, 10);
        if (isNaN(frameNum)) frameNum = layFrameHienTai();

        const viewer = damBaoKhungXemAnh2DTonTai();
        viewer.style.display = 'flex';

        const jid = layJobIdHienTai();
        let shape = null;
        if (activeModalTrack && Array.isArray(activeModalTrack.shapes)) {
            shape = activeModalTrack.shapes.find(s => Number(s.frame) === frameNum) || activeModalTrack.shapes[0];
        }

        const objInfo = tinhGocHuongVatTheSoVoiXeLiDAR(shape);
        v2dState.frameNum = frameNum;
        v2dState.objInfo = objInfo;
        v2dState.zoom = 1.0;
        v2dState.panX = 0;
        v2dState.panY = 0;

        // Hiển thị trạng thái đang tải nếu chưa có trong cache
        const emptyMsg = viewer.querySelector('#v2d-empty-msg');
        const imgEl = viewer.querySelector('#v2d-main-img');
        if (emptyMsg && imgEl && !contextImageCache.has(`${jid}_${frameNum}`)) {
            imgEl.style.display = 'none';
            emptyMsg.style.display = 'block';
            emptyMsg.textContent = `⏳ Đang tải ảnh 2D của Frame ${frameNum} và đối chiếu góc vật thể (${objInfo.deg.toFixed(1)}°)...`;
        }

        const rawImages = await taiDanhSachAnh2DChoFrame(jid, frameNum);
        const analysis = phanTichVaGanHuongAnh2D(rawImages, jid);
        const bestIdx = chonAnh2DChuanHuongNhat(analysis.items, objInfo.deg);

        v2dState.images = analysis.items;
        v2dState.analysis = analysis;
        v2dState.bestMatchIndex = bestIdx;
        v2dState.activeIndex = bestIdx;

        renderTrangThaiKhungXemAnh2D();
    }

    /**
     * Mở Modal Tự Nối Các Ảnh 2D Vào Đúng Góc Hướng Camera (#cvat-cam-mapping-modal)
     */
    async function moModalNoiGocCam2D(refFrameNum = null) {
        const jid = layJobIdHienTai();
        const fn = (refFrameNum !== null && !isNaN(refFrameNum)) ? Number(refFrameNum) : layFrameHienTai();

        let modal = document.getElementById('cvat-cam-mapping-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'cvat-cam-mapping-modal';
            modal.innerHTML = `
                <div class="cam-map-dialog">
                    <div class="cam-map-header">
                        <div>
                            <div style="font-size:14px;font-weight:800;color:#38bdf8;">📷 TỰ NỐI ẢNH 2D VÀO ĐÚNG GÓC HƯỚNG CAMERA (JOB #<span id="cam-map-job-id">--</span>)</div>
                            <div style="font-size:11px;color:#94a3b8;margin-top:2px;">Nếu tên ảnh không rõ, thiếu góc hoặc 2 ảnh bị trùng góc, bạn hãy chọn đúng hướng cho từng ảnh bên dưới.</div>
                        </div>
                        <button class="btn-m-icon btn-m-close" id="cam-map-btn-close">✕</button>
                    </div>
                    <div class="cam-map-body" id="cam-map-body"></div>
                    <div class="cam-map-footer">
                        <span id="cam-map-status-text" style="font-size:11px;color:#cbd5e1;">💡 Cấu hình sẽ được nhớ tự động cho toàn bộ các frames trong Job.</span>
                        <div style="display:flex;gap:8px;">
                            <button class="btn-p-action" id="cam-map-btn-auto" title="Đặt lại về chế độ tự động đọc từ tên ảnh">🔄 Tự Động Đọc Tên</button>
                            <button class="btn-p-action btn-p-primary" id="cam-map-btn-save" style="padding:6px 16px;font-size:12px;">💾 Lưu Cấu Hình Góc Cam</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelector('#cam-map-btn-close')?.addEventListener('click', () => {
                modal.style.display = 'none';
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.style.display = 'none';
            });
        }

        modal.style.display = 'flex';
        const jobSpan = modal.querySelector('#cam-map-job-id');
        if (jobSpan) jobSpan.textContent = jid || 'Hiện Tại';

        const body = modal.querySelector('#cam-map-body');
        body.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#38bdf8;">⏳ Đang nạp ảnh mẫu từ Frame ${fn}...</div>`;

        const rawImages = await taiDanhSachAnh2DChoFrame(jid, fn);
        const analysis = phanTichVaGanHuongAnh2D(rawImages, jid);
        const savedMap = layCauHinhNoiGocCam(jid) || {};

        if (!rawImages || rawImages.length === 0) {
            body.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:#f87171;">⚠️ Không tìm thấy ảnh 2D nào tại Frame ${fn} để cấu hình.</div>`;
            return;
        }

        const renderMappingCards = () => {
            body.innerHTML = '';
            // Kiểm tra xung đột 2 ảnh cùng gán 1 hướng
            const currentSelects = {};
            analysis.items.forEach((it, idx) => {
                const val = savedMap[it.name] || savedMap[`__idx_${idx}`] || it.dirKey || 'unknown';
                if (val && val !== 'unknown') {
                    currentSelects[val] = (currentSelects[val] || 0) + 1;
                }
            });

            analysis.items.forEach((it, idx) => {
                const curVal = savedMap[it.name] || savedMap[`__idx_${idx}`] || it.dirKey || 'unknown';
                const isConflict = curVal !== 'unknown' && currentSelects[curVal] > 1;
                const autoDetected = doanHuongCamTuTenAnh(it.name);

                const card = document.createElement('div');
                card.className = `cam-map-card ${isConflict ? 'is-conflict' : ''}`;

                let optionsHtml = `<option value="unknown" ${curVal === 'unknown' ? 'selected' : ''}>❓ Chưa biết / Tự xếp sau</option>`;
                for (const std of DANH_SACH_GOC_CAM_CHUAN) {
                    const sel = (curVal === std.key) ? 'selected' : '';
                    optionsHtml += `<option value="${std.key}" ${sel}>${std.label}</option>`;
                }

                card.innerHTML = `
                    <div class="cam-map-thumb">
                        <img src="${it.url}" alt="${it.name}" />
                    </div>
                    <div class="cam-map-name" title="${it.name}">#${idx + 1}: ${it.name}</div>
                    <div style="font-size:10px;color:${autoDetected !== 'unknown' ? '#34d399' : '#fbbf24'};">
                        ${autoDetected !== 'unknown' ? `🔍 Đọc tên tự động: ${MAP_GOC_THEO_KEY[autoDetected]?.label || autoDetected}` : '⚠️ Tên ảnh không chứa từ khóa góc'}
                        ${isConflict ? '<br><b style="color:#f59e0b;">⚠️ Đang trùng góc với ảnh khác!</b>' : ''}
                    </div>
                    <select class="cam-map-select" data-name="${it.name}" data-idx="${idx}">
                        ${optionsHtml}
                    </select>
                `;

                const selectEl = card.querySelector('.cam-map-select');
                selectEl.addEventListener('change', (ev) => {
                    const newDir = ev.target.value;
                    savedMap[it.name] = newDir;
                    savedMap[`__idx_${idx}`] = newDir;
                    renderMappingCards();
                });

                body.appendChild(card);
            });
        };

        renderMappingCards();

        const btnAuto = modal.querySelector('#cam-map-btn-auto');
        if (btnAuto) {
            btnAuto.onclick = () => {
                for (const k of Object.keys(savedMap)) delete savedMap[k];
                luuCauHinhNoiGocCam(jid, {});
                const refreshed = phanTichVaGanHuongAnh2D(rawImages, jid);
                analysis.items = refreshed.items;
                renderMappingCards();
                hienToast('🔄 Đã khôi phục chế độ tự động nhận diện góc từ tên ảnh!');
            };
        }

        const btnSave = modal.querySelector('#cam-map-btn-save');
        if (btnSave) {
            btnSave.onclick = () => {
                luuCauHinhNoiGocCam(jid, savedMap);
                modal.style.display = 'none';
                hienToast('✅ Đã lưu bảng nối góc Camera 2D thành công!');
                // Nếu khung xem ảnh 2D đang mở thì cập nhật lại ngay lập tức
                const viewer2d = document.getElementById('cvat-2d-image-viewer');
                if (viewer2d && viewer2d.style.display !== 'none') {
                    moKhungXemAnh2D(v2dState.frameNum);
                } else {
                    phanTichVaGanHuongAnh2D(rawImages, jid);
                }
            };
        }
    }

    /**
     * =========================================================================
     * MODAL CÔNG CỤ KIỂM ĐỊNH CHẤT LƯỢNG 3D ANNOTATION (#cvat-qc-modal)
     * GIAO DIỆN MỚI: PHÂN CẤP CÂY THỤT LỀ, TÁCH BIỆT 4 TABS, BỎ ICON KIẾM
     * =========================================================================
     */
    let qcActiveConfig = null;
    let qcActiveJobId = null;
    let lastQCReportResult = null;
    let qcFilterType = 'all';
    const qcClassCollapsedMap = {}; // Lưu trạng thái gập/mở của từng class

    function hasNonEmptyLabels(labels) {
        if (!labels) return false;
        if (Array.isArray(labels)) return labels.length > 0;
        if (typeof labels === 'object') return Object.keys(labels).length > 0;
        return false;
    }

    function escQCHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function syncYawPresetPills(val) {
        const num = Number(val);
        document.querySelectorAll('#cvat-qc-modal .qc-preset-pill').forEach(p => {
            p.classList.toggle('active', Number.isFinite(num) && Number(p.getAttribute('data-val')) === num);
        });
    }

    function apDungBoLocBangQC(tbodyEl, queryStr) {
        if (!tbodyEl) return;
        const q = String(queryStr || '').trim().toLowerCase();
        tbodyEl.querySelectorAll('tr.qc-leaf-row').forEach(tr => {
            const cName = tr.getAttribute('data-class') || '';
            const isCollapsed = !!qcClassCollapsedMap[cName];
            if (!q) {
                tr.style.display = isCollapsed ? 'none' : '';
            } else {
                const txt = tr.textContent.toLowerCase();
                tr.style.display = txt.includes(q) ? '' : 'none';
            }
        });
        tbodyEl.querySelectorAll('tr.qc-subgroup-row').forEach(trSub => {
            const cName = trSub.getAttribute('data-class') || '';
            const isCollapsed = !!qcClassCollapsedMap[cName];
            trSub.style.display = (!q && isCollapsed) ? 'none' : '';
        });
    }

    function setClassRowsCollapsed(tbodyEl, cName, collapsed) {
        if (!tbodyEl) return;
        qcClassCollapsedMap[cName] = !!collapsed;
        tbodyEl.querySelectorAll('tr.qc-leaf-row, tr.qc-subgroup-row').forEach(row => {
            if ((row.getAttribute('data-class') || '') === cName) {
                row.style.display = collapsed ? 'none' : '';
            }
        });
    }

    function layKhoaCauHinhQC(jid) {
        return `cvat_3d_qc_config_v2_${jid || 'global'}`;
    }

    function docCauHinhQCTuStorage(jid) {
        try {
            const raw = localStorage.getItem(layKhoaCauHinhQC(jid)) || localStorage.getItem('cvat_3d_qc_config_v2');
            return raw ? JSON.parse(raw) : null;
        } catch (e) {
            return null;
        }
    }

    function luuCauHinhQCVaoStorage(jid, cfg) {
        try {
            const str = JSON.stringify(cfg);
            localStorage.setItem(layKhoaCauHinhQC(jid), str);
            localStorage.setItem('cvat_3d_qc_config_v2', str);
        } catch (e) {}
    }

    async function dieuHuongDenTrackVaFrame(trackId, frameNum, ref = {}) {
        if (frameNum !== undefined && frameNum !== null && !isNaN(frameNum)) {
            chuyenFrameCVAT(Number(frameNum));
        }
        if (trackId !== undefined && trackId !== null) {
            const inp = document.getElementById('inp-track-id');
            if (inp) inp.value = trackId;
            if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.kichHoatVaFocusTrackCVAT === 'function') {
                try {
                    await window.quanLyAPICVAT.kichHoatVaFocusTrackCVAT(Number(trackId), Number(frameNum || 0), currentAnnotations, ref);
                } catch (e) {}
            }
        }
    }

    async function moModalQCTool() {
        const jid = layJobIdHienTai();
        let modal = document.getElementById('cvat-qc-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'cvat-qc-modal';
            modal.innerHTML = `
                <div class="qc-dialog">
                    <div class="qc-header">
                        <div>
                            <div style="font-size:15px;font-weight:800;color:#818cf8;display:flex;align-items:center;gap:8px;">
                                <span>🛡️</span> CÔNG CỤ KIỂM ĐỊNH CHẤT LƯỢNG 3D ANNOTATION (JOB #<span id="qc-job-id">--</span>)
                            </div>
                            <div style="font-size:11px;color:#94a3b8;margin-top:2px;">
                                Tự động rà soát đồng bộ kích thước qua frames, lệch ngưỡng chuẩn L/W/H, xoay đột ngột và chồng lấn giữa các box chưa Outside.
                            </div>
                        </div>
                        <button class="btn-m-icon btn-m-close" id="qc-btn-close">✕</button>
                    </div>

                    <div class="qc-nav-tabs">
                        <button class="qc-tab-btn active" data-tab="qc-tab-rules">📏 Quy Chuẩn Kích Thước</button>
                        <button class="qc-tab-btn" data-tab="qc-tab-collision">📦 Chồng Lấn Box</button>
                        <button class="qc-tab-btn" data-tab="qc-tab-yaw">🔄 Góc Xoay Đột Ngột</button>
                        <button class="qc-tab-btn" data-tab="qc-tab-split-id">🔀 Object Nhiều ID</button>
                        <button class="qc-tab-btn" data-tab="qc-tab-report">
                            📊 Báo Cáo Kiểm Định <span class="qc-badge-pill empty" id="qc-tab-report-badge">0</span>
                        </button>
                    </div>

                    <div class="qc-body">
                        <!-- TAB 1: QUY CHUẨN KÍCH THƯỚC (TREE HIERARCHY) -->
                        <div class="qc-tab-panel active" id="qc-tab-rules">
                            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;gap:12px;">
                                <div style="font-size:11px;color:#cbd5e1;line-height:1.4;">
                                    💡 <b>Phân cấp</b>: Bấm vào tiêu đề Class để ẩn/hiện danh sách con. Tích <b>Đồng bộ</b> để bắt buộc cố định $L, W, H$ qua mọi frames.
                                </div>
                                <div style="display:flex;align-items:center;gap:6px;">
                                    <button class="btn-qc-action" id="qc-btn-expand-all" title="Mở rộng tất cả các Class">⊞ Mở Rộng</button>
                                    <button class="btn-qc-action" id="qc-btn-collapse-all" title="Thu gọn tất cả các Class">⊟ Thu Gọn</button>
                                    <input type="text" id="qc-rules-search-inp" placeholder="🔍 Lọc nhanh..." style="background:#090d16;border:1px solid #334155;border-radius:6px;padding:4px 10px;font-size:11px;color:#fff;width:150px;" />
                                </div>
                            </div>
                            <div class="qc-table-wrap">
                                <table class="qc-table">
                                    <thead>
                                        <tr>
                                            <th>Class & Phân Loại Cụ Thể</th>
                                            <th style="text-align:center;">Đồng Bộ Kích Thước</th>
                                            <th style="text-align:center;">Dài L [min - max] (m)</th>
                                            <th style="text-align:center;">Rộng W [min - max] (m)</th>
                                            <th style="text-align:center;">Cao H [min - max] (m)</th>
                                            <th style="text-align:center;">Mặc Định</th>
                                        </tr>
                                    </thead>
                                    <tbody id="qc-rules-table-body">
                                        <!-- Dynamic tree rows -->
                                    </tbody>
                                </table>
                            </div>
                        </div>

                        <!-- TAB 2: CHỒNG LẤN BOX (THÊM BẰNG DẤU CỘNG, CHỌN 2 DROPDOWN) -->
                        <div class="qc-tab-panel" id="qc-tab-collision">
                            <div class="qc-collision-section">
                                <div class="qc-section-title">
                                    <span>📦</span> Danh Sách Cặp Class Kiểm Tra Chồng Lấn 3D (Z-overlap + 2D BEV)
                                </div>
                                <div class="qc-section-desc">
                                    Hệ thống chỉ rà soát va chạm giữa 2 hộp thuộc các cặp class được liệt kê dưới đây khi cả 2 hộp đều chưa đánh Outside.
                                </div>

                                <div class="qc-collision-actions-bar">
                                    <div style="display:flex;align-items:center;gap:8px;">
                                        <button class="btn-qc-action primary" id="qc-btn-show-add-pair" style="font-size:12px;padding:6px 14px;">
                                            ➕ Thêm Cặp Chồng Lấn
                                        </button>
                                        <button class="btn-qc-action" id="qc-btn-restore-default-pairs">🔄 Khôi Phục 4 Cặp Chuẩn</button>
                                        <button class="btn-qc-action" id="qc-btn-clear-all-pairs">🗑️ Xóa Tất Cả</button>
                                    </div>
                                    <span id="qc-pairs-count-lbl" style="font-size:11px;color:#94a3b8;font-weight:700;">Đang theo dõi: 4 cặp</span>
                                </div>

                                <!-- Khung Thêm Cặp Mới (Ẩn/Hiện) -->
                                <div class="qc-add-pair-box" id="qc-add-pair-box">
                                    <span style="font-size:12px;font-weight:700;color:#c7d2fe;">➕ Thêm Cặp Mới:</span>
                                    <select id="qc-select-class1" class="qc-select-class"></select>
                                    <span class="qc-pair-arrow-sep">↔</span>
                                    <select id="qc-select-class2" class="qc-select-class"></select>
                                    <button class="btn-qc-action primary" id="qc-btn-confirm-add-pair">Xác Nhận Thêm</button>
                                    <button class="btn-qc-action" id="qc-btn-cancel-add-pair">Hủy</button>
                                </div>

                                <!-- Danh Sách Các Cặp -->
                                <div class="qc-pairs-list-grid" id="qc-pairs-list-container">
                                    <!-- Dynamic cards -->
                                </div>
                            </div>
                        </div>

                        <!-- TAB 3: GÓC XOAY ĐỘT NGỘT -->
                        <div class="qc-tab-panel" id="qc-tab-yaw">
                            <div class="qc-yaw-section">
                                <div class="qc-section-title">
                                    <span>🔄</span> Ngưỡng Kiểm Tra Góc Xoay Đột Ngột (Sudden Yaw Jump)
                                </div>
                                <div class="qc-section-desc">
                                    Cảnh báo khi góc Yaw của Track bị giật hướng vượt quá ngưỡng giữa 2 frames liên tiếp (thường gặp khi người gán nhãn lật ngược 180° so với hướng di chuyển thực tế).
                                </div>

                                <div class="qc-yaw-input-row">
                                    <span style="font-size:13px;color:#e2e8f0;font-weight:700;">Ngưỡng góc giật:</span>
                                    <input type="number" id="qc-inp-yaw-threshold" min="30" max="180" value="150" class="qc-num-inp" style="width:75px;font-size:13px;padding:5px 8px;text-align:right;" />
                                    <span style="font-size:13px;color:#38bdf8;font-weight:800;">độ (°)</span>
                                </div>

                                <div style="display:flex;align-items:center;gap:10px;">
                                    <span style="font-size:11px;color:#94a3b8;font-weight:600;">Mức chọn nhanh:</span>
                                    <div class="qc-preset-pills">
                                        <button class="qc-preset-pill" data-val="90">90°</button>
                                        <button class="qc-preset-pill" data-val="120">120°</button>
                                        <button class="qc-preset-pill active" data-val="150">150° (Chuẩn VinFast)</button>
                                        <button class="qc-preset-pill" data-val="170">170°</button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- TAB 4: PHÁT HIỆN OBJECT NHIỀU ID (SPLIT-ID) -->
                        <div class="qc-tab-panel" id="qc-tab-split-id">
                            <div class="qc-split-panel">
                                <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:12px 14px;">
                                    <div>
                                        <div style="font-size:13px;font-weight:800;color:#22d3ee;">🔀 Phát Hiện 1 Object Bị Chia Nhiều Track ID</div>
                                        <div style="font-size:11px;color:#94a3b8;margin-top:3px;line-height:1.4;">
                                            Tự động ngoại suy thuận từ đoạn track trước (bỏ frame <code>outside</code> cuối) &amp; ngoại suy ngược từ track kế tiếp, so khớp vị trí BEV + kích thước + góc yaw để phát hiện các track bị gãy ID.
                                        </div>
                                    </div>
                                    <button class="btn-qc-action cyan" id="qc-btn-run-split-id" style="padding:7px 14px;white-space:nowrap;">🔀 Quét Object Nhiều ID</button>
                                </div>

                                <div class="qc-split-grid">
                                    <div class="qc-split-field">
                                        <label for="qc-chk-split-bat">
                                            <span>Bật kiểm tra Object Nhiều ID khi quét toàn Job</span>
                                            <input type="checkbox" id="qc-chk-split-bat" checked style="width:16px;height:16px;accent-color:#06b6d4;cursor:pointer;" />
                                        </label>
                                        <small>Tích để gom kết quả Object Nhiều ID vào chung nút "Kiểm Tra Toàn Bộ Job".</small>
                                    </div>

                                    <div class="qc-split-field">
                                        <label for="qc-chk-split-lowconf">
                                            <span>Hiện cả ca độ tin cậy thấp / mơ hồ</span>
                                            <input type="checkbox" id="qc-chk-split-lowconf" style="width:16px;height:16px;accent-color:#06b6d4;cursor:pointer;" />
                                        </label>
                                        <small>Tắt để chỉ báo các ca chắc chắn (Cao / Trung bình); bật nếu muốn rà kỹ cả ca gần ngưỡng.</small>
                                    </div>

                                    <div class="qc-split-field">
                                        <label for="qc-inp-split-k">
                                            <span>Khoảng hở tối đa K (số frame chuyển giao)</span>
                                            <input type="number" id="qc-inp-split-k" class="qc-inp-num" value="3" min="1" max="10" step="1" style="width:72px;" />
                                        </label>
                                        <small>Cho phép ID mới xuất hiện ngay tại frame <code>f1 + 1</code> hoặc cách tối đa K frame (mặc định: 3).</small>
                                    </div>

                                    <div class="qc-split-field">
                                        <label for="qc-inp-split-overlap">
                                            <span>Chồng lấn frame tối đa khi chuyển ID</span>
                                            <input type="number" id="qc-inp-split-overlap" class="qc-inp-num" value="2" min="0" max="5" step="1" style="width:72px;" />
                                        </label>
                                        <small>Số frame giao nhau tối đa giữa ID cũ và ID mới ở vùng chuyển tiếp (mặc định: 2).</small>
                                    </div>

                                    <div class="qc-split-field" style="grid-column:span 2;">
                                        <label for="qc-inp-split-score">
                                            <span>Ngưỡng điểm hợp nhất tối thiểu (scoreMin: 0.30 - 0.90)</span>
                                            <input type="number" id="qc-inp-split-score" class="qc-inp-num" value="0.50" min="0.30" max="0.90" step="0.05" style="width:80px;" />
                                        </label>
                                        <small>Điểm tổng hợp từ khoảng cách ngoại suy BEV, IoU vùng giao, độ lệch L/W/H, góc yaw và cao độ Z (mặc định: 0.50).</small>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- TAB 5: BÁO CÁO KIỂM ĐỊNH -->
                        <div class="qc-tab-panel" id="qc-tab-report">
                            <div class="qc-stats-summary">
                                <div class="qc-stat-card active" data-filter="all">
                                    <span class="qc-stat-val" id="qc-stat-total">0</span>
                                    <span class="qc-stat-lbl">Tất Cả Lỗi</span>
                                </div>
                                <div class="qc-stat-card amber" data-filter="size_variance">
                                    <span class="qc-stat-val" id="qc-stat-sync">0</span>
                                    <span class="qc-stat-lbl">Không Đồng Bộ</span>
                                </div>
                                <div class="qc-stat-card red" data-filter="dimension_bound">
                                    <span class="qc-stat-val" id="qc-stat-bound">0</span>
                                    <span class="qc-stat-lbl">Lệch Ngưỡng</span>
                                </div>
                                <div class="qc-stat-card blue" data-filter="yaw_jump">
                                    <span class="qc-stat-val" id="qc-stat-yaw">0</span>
                                    <span class="qc-stat-lbl">Xoay Đột Ngột</span>
                                </div>
                                <div class="qc-stat-card purple" data-filter="box_overlap">
                                    <span class="qc-stat-val" id="qc-stat-collision">0</span>
                                    <span class="qc-stat-lbl">Chồng Lấn</span>
                                </div>
                                <div class="qc-stat-card cyan" data-filter="split_id">
                                    <span class="qc-stat-val" id="qc-stat-split-id">0</span>
                                    <span class="qc-stat-lbl">Object Nhiều ID</span>
                                </div>
                            </div>

                            <div class="qc-issues-list" id="qc-issues-container">
                                <div style="text-align:center;padding:50px;color:#94a3b8;">
                                    💡 Bấm <b>"🚀 KIỂM TRA TOÀN BỘ JOB"</b> bên dưới để quét phát hiện lỗi ngay tức thì.
                                </div>
                            </div>
                        </div>
                    </div>

                    <div class="qc-footer">
                        <span id="qc-status-text" style="font-size:11px;color:#94a3b8;">
                            💡 Cấu hình được lưu tự động trên trình duyệt theo từng Job.
                        </span>
                        <div style="display:flex;gap:8px;">
                            <button class="btn-qc-action" id="qc-btn-reset" title="Đặt lại toàn bộ cấu hình về chuẩn mặc định thông minh">🔄 Khôi Phục Mặc Định</button>
                            <button class="btn-qc-action" id="qc-btn-save" title="Lưu lại cấu hình vào bộ nhớ trình duyệt">💾 Lưu Cấu Hình</button>
                            <button class="btn-qc-action primary" id="qc-btn-run" style="padding:6px 18px;font-size:12px;">🚀 KIỂM TRA TOÀN BỘ JOB</button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Đóng Modal
            modal.querySelector('#qc-btn-close')?.addEventListener('click', () => { modal.style.display = 'none'; });
            modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

            // Chuyển Tab (4 tabs)
            modal.querySelectorAll('.qc-tab-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const targetTab = btn.getAttribute('data-tab');
                    modal.querySelectorAll('.qc-tab-btn').forEach(b => b.classList.remove('active'));
                    modal.querySelectorAll('.qc-tab-panel').forEach(p => p.classList.remove('active'));
                    btn.classList.add('active');
                    const panel = modal.querySelector(`#${targetTab}`);
                    if (panel) panel.classList.add('active');
                });
            });

            // Lọc loại lỗi trên thẻ thống kê (Tab 4)
            modal.querySelectorAll('.qc-stat-card').forEach(card => {
                card.addEventListener('click', () => {
                    modal.querySelectorAll('.qc-stat-card').forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                    qcFilterType = card.getAttribute('data-filter') || 'all';
                    renderQCIssuesList();
                });
            });

            // Tìm kiếm nhanh bảng quy tắc
            modal.querySelector('#qc-rules-search-inp')?.addEventListener('input', (e) => {
                apDungBoLocBangQC(modal.querySelector('#qc-rules-table-body'), e.target.value);
            });

            // Mở rộng / Thu gọn tất cả class
            modal.querySelector('#qc-btn-expand-all')?.addEventListener('click', () => {
                const tbodyEl = modal.querySelector('#qc-rules-table-body');
                modal.querySelectorAll('.qc-class-header-row').forEach(hr => {
                    const c = hr.getAttribute('data-class');
                    setClassRowsCollapsed(tbodyEl, c, false);
                    const toggleEl = hr.querySelector('.qc-tree-toggle');
                    if (toggleEl) toggleEl.textContent = '▼';
                    const hintEl = hr.querySelector('.qc-class-hint');
                    if (hintEl) hintEl.textContent = '(Bấm để thu gọn)';
                });
                const searchInp = modal.querySelector('#qc-rules-search-inp');
                if (searchInp && searchInp.value.trim()) {
                    apDungBoLocBangQC(tbodyEl, searchInp.value);
                }
            });
            modal.querySelector('#qc-btn-collapse-all')?.addEventListener('click', () => {
                const tbodyEl = modal.querySelector('#qc-rules-table-body');
                modal.querySelectorAll('.qc-class-header-row').forEach(hr => {
                    const c = hr.getAttribute('data-class');
                    setClassRowsCollapsed(tbodyEl, c, true);
                    const toggleEl = hr.querySelector('.qc-tree-toggle');
                    if (toggleEl) toggleEl.textContent = '▶';
                    const hintEl = hr.querySelector('.qc-class-hint');
                    if (hintEl) hintEl.textContent = '(Bấm để mở rộng)';
                });
            });

            // Xử lý Tab Chồng Lấn (Tab 2)
            const addBox = modal.querySelector('#qc-add-pair-box');
            modal.querySelector('#qc-btn-show-add-pair')?.addEventListener('click', () => {
                if (addBox) {
                    addBox.style.display = (addBox.style.display === 'flex') ? 'none' : 'flex';
                }
            });
            modal.querySelector('#qc-btn-cancel-add-pair')?.addEventListener('click', () => {
                if (addBox) addBox.style.display = 'none';
            });
            modal.querySelector('#qc-btn-confirm-add-pair')?.addEventListener('click', () => {
                const c1 = modal.querySelector('#qc-select-class1')?.value;
                const c2 = modal.querySelector('#qc-select-class2')?.value;
                if (!c1 || !c2 || !qcActiveConfig) return;

                const exists = qcActiveConfig.collisionPairs.some(p =>
                    (p.label1 === c1 && p.label2 === c2) || (p.label1 === c2 && p.label2 === c1)
                );
                if (exists) {
                    hienToast(`⚠️ Cặp ${c1} ↔ ${c2} đã tồn tại trong danh sách!`);
                    return;
                }
                qcActiveConfig.collisionPairs.push({ label1: c1, label2: c2 });
                renderCollisionPairsList();
                addBox.style.display = 'none';
                hienToast(`✅ Đã thêm cặp theo dõi: ${c1} ↔ ${c2}`);
            });

            modal.querySelector('#qc-btn-restore-default-pairs')?.addEventListener('click', () => {
                if (!qcActiveConfig) return;
                const cls = qcActiveConfig.classes || ['vehicles', 'two-wheels', 'pedestrian'];
                const vehi = cls.find(c => c.toLowerCase().includes('vehi') || c.toLowerCase().includes('car')) || 'vehicles';
                const twoW = cls.find(c => c.toLowerCase().includes('two-wheel') || c.toLowerCase().includes('moto')) || 'two-wheels';
                const pede = cls.find(c => c.toLowerCase().includes('pedes') || c.toLowerCase().includes('person')) || 'pedestrian';
                qcActiveConfig.collisionPairs = [
                    { label1: vehi, label2: vehi },
                    { label1: twoW, label2: twoW },
                    { label1: vehi, label2: twoW },
                    { label1: vehi, label2: pede }
                ];
                renderCollisionPairsList();
                hienToast('🔄 Đã khôi phục 4 cặp va chạm chuẩn!');
            });

            modal.querySelector('#qc-btn-clear-all-pairs')?.addEventListener('click', () => {
                if (qcActiveConfig) {
                    qcActiveConfig.collisionPairs = [];
                    renderCollisionPairsList();
                    hienToast('🗑️ Đã xóa toàn bộ cặp chồng lấn!');
                }
            });

            // Preset Pills Tab 3 (Góc xoay)
            modal.querySelectorAll('.qc-preset-pill').forEach(pill => {
                pill.addEventListener('click', () => {
                    modal.querySelectorAll('.qc-preset-pill').forEach(p => p.classList.remove('active'));
                    pill.classList.add('active');
                    const val = Number(pill.getAttribute('data-val'));
                    const inp = modal.querySelector('#qc-inp-yaw-threshold');
                    if (inp) inp.value = val;
                    if (qcActiveConfig) qcActiveConfig.yawThresholdDeg = val;
                });
            });

            // Lưu & Khôi phục cấu hình
            modal.querySelector('#qc-btn-save')?.addEventListener('click', () => {
                docDuLieuFormVaoConfig();
                const curJid = layJobIdHienTai();
                luuCauHinhQCVaoStorage(curJid, qcActiveConfig);
                hienToast('💾 Đã lưu cấu hình QC Tool thành công!');
            });
            modal.querySelector('#qc-btn-reset')?.addEventListener('click', () => {
                const curJid = layJobIdHienTai();
                try {
                    localStorage.removeItem(layKhoaCauHinhQC(curJid));
                    localStorage.removeItem('cvat_3d_qc_config_v2');
                } catch (e) {}
                khoiTaoConfigMacDinh();
                renderQCModalToanBo();
                hienToast('🔄 Đã khôi phục cấu hình QC Tool về chuẩn mặc định!');
            });

            // NÚT CHẠY KIỂM ĐỊNH TOÀN BỘ JOB
            modal.querySelector('#qc-btn-run')?.addEventListener('click', async () => {
                await chayVaHienThiBaoCaoQC({ focusFilter: 'all' });
            });

            // NÚT QUÉT NHANH OBJECT NHIỀU ID (TRONG TAB CONFIG)
            const chayQuetObjectNhieuID = async () => {
                const chkBat = modal.querySelector('#qc-chk-split-bat');
                if (chkBat) chkBat.checked = true;
                if (qcActiveConfig) {
                    if (!qcActiveConfig.splitId || typeof qcActiveConfig.splitId !== 'object') {
                        qcActiveConfig.splitId = {};
                    }
                    qcActiveConfig.splitId.bat = true;
                }
                await chayVaHienThiBaoCaoQC({ focusFilter: 'split_id' });
            };
            modal.querySelector('#qc-btn-run-split-id')?.addEventListener('click', chayQuetObjectNhieuID);
        }

        modal.style.display = 'flex';
        const jobSpan = modal.querySelector('#qc-job-id');
        if (jobSpan) jobSpan.textContent = jid || 'Hiện Tại';

        // Reset trạng thái QC khi chuyển sang Job khác qua SPA
        if (qcActiveJobId !== jid) {
            qcActiveJobId = jid;
            qcActiveConfig = null;
            lastQCReportResult = null;
            qcFilterType = 'all';
            capNhatNutQCTrenHUD(0);
        }

        // Đảm bảo dữ liệu annotations và labels sẵn sàng
        if (!currentAnnotations || !Array.isArray(currentAnnotations.tracks) || currentAnnotations.tracks.length === 0) {
            try {
                if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.taiAnnotations === 'function') {
                    currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();
                }
            } catch (e) {}
        }
        if (!hasNonEmptyLabels(currentLabels)) {
            try {
                if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.taiLabels === 'function') {
                    currentLabels = await window.quanLyAPICVAT.taiLabels();
                }
            } catch (e) {}
        }

        // Khởi tạo config nếu chưa có
        if (!qcActiveConfig) {
            khoiTaoConfigMacDinh();
        }

        renderQCModalToanBo();
    }

    function khoiTaoConfigMacDinh() {
        const jid = layJobIdHienTai();
        const saved = docCauHinhQCTuStorage(jid);
        const engine = window.thuatToanCanChinh;
        if (!engine || typeof engine.khamPhaSchemaQCTuDong !== 'function') return;

        const base = engine.khamPhaSchemaQCTuDong(currentAnnotations, currentLabels || {});

        if (saved && Array.isArray(saved.rules)) {
            const savedRuleMap = new Map();
            saved.rules.forEach(r => { if (r && r.key) savedRuleMap.set(r.key, r); });
            base.rules.forEach(r => {
                if (savedRuleMap.has(r.key)) {
                    const s = savedRuleMap.get(r.key);
                    r.dongBoKichThuoc = s.dongBoKichThuoc !== undefined ? !!s.dongBoKichThuoc : r.dongBoKichThuoc;
                    const readNum = (v, fallback) => (v !== undefined && v !== null && Number.isFinite(Number(v))) ? Number(v) : fallback;
                    r.minL = readNum(s.minL, r.minL);
                    r.maxL = readNum(s.maxL, r.maxL);
                    r.minW = readNum(s.minW, r.minW);
                    r.maxW = readNum(s.maxW, r.maxW);
                    r.minH = readNum(s.minH, r.minH);
                    r.maxH = readNum(s.maxH, r.maxH);
                }
            });

            if (Array.isArray(saved.collisionPairs)) {
                base.collisionPairs = saved.collisionPairs;
            }

            const savedYaw = Number(saved.yawThresholdDeg);
            if (saved.yawThresholdDeg !== undefined && saved.yawThresholdDeg !== null && Number.isFinite(savedYaw) && savedYaw > 0) {
                base.yawThresholdDeg = savedYaw;
            } else {
                base.yawThresholdDeg = 150;
            }
        } else {
            base.yawThresholdDeg = 150;
        }

        const macDinhSplit = (typeof engine._mergeCauHinhSplitID === 'function')
            ? engine._mergeCauHinhSplitID({})
            : { bat: true, K: 3, maxOverlap: 2, scoreMin: 0.50, hienDoTinCayThap: false };
        base.splitId = (saved && saved.splitId && typeof engine._mergeCauHinhSplitID === 'function')
            ? engine._mergeCauHinhSplitID(saved.splitId)
            : macDinhSplit;

        qcActiveConfig = base;
    }

    function renderQCModalToanBo() {
        renderTreeRulesTable();
        renderCollisionTab();
        renderYawTab();
        renderSplitIdTab();
        document.querySelectorAll('#cvat-qc-modal .qc-stat-card').forEach(c => {
            c.classList.toggle('active', (c.getAttribute('data-filter') || 'all') === qcFilterType);
        });
        if (lastQCReportResult) {
            capNhatThongKeVaBadge(lastQCReportResult);
            renderQCIssuesList();
        } else {
            capNhatThongKeVaBadge({
                tongLoi: 0,
                soLoiDongBo: 0,
                soLoiKhoangKichThuoc: 0,
                soLoiXoayDotNgot: 0,
                soLoiChongLan: 0,
                soLoiVoID: 0
            });
            renderQCIssuesList();
        }
    }

    /**
     * VẼ BẢNG CÂY PHÂN CẤP THỤT LỀ (TREE HIERARCHY TABLE)
     */
    function renderTreeRulesTable() {
        const tbody = document.getElementById('qc-rules-table-body');
        if (!tbody || !qcActiveConfig || !Array.isArray(qcActiveConfig.tree)) return;

        tbody.innerHTML = '';
        const rulesMap = new Map();
        (qcActiveConfig.rules || []).forEach(r => rulesMap.set(r.key, r));

        qcActiveConfig.tree.forEach(classNode => {
            const cName = classNode.className;
            const isCollapsed = !!qcClassCollapsedMap[cName];
            const totalItems = classNode.hasSubGroups ?
                classNode.subGroups.reduce((acc, sg) => acc + sg.items.length, 0) :
                classNode.children.length;

            // 1. Hàng Class Header (Level 0)
            const trClass = document.createElement('tr');
            trClass.className = 'qc-tree-row qc-class-header-row';
            trClass.setAttribute('data-class', cName);
            trClass.innerHTML = `
                <td colspan="6" class="qc-class-header-cell">
                    <div class="qc-class-title-wrap">
                        <span class="qc-tree-toggle">${isCollapsed ? '▶' : '▼'}</span>
                        <span style="font-size:14px;">${classNode.icon}</span>
                        <span class="qc-class-name">${cName}</span>
                        <span class="qc-class-count-badge">${totalItems} phân loại</span>
                        <span class="qc-class-hint">(Bấm để ${isCollapsed ? 'mở rộng' : 'thu gọn'})</span>
                    </div>
                </td>
            `;

            // Toggle thu gọn/mở rộng khi bấm vào Header
            trClass.addEventListener('click', () => {
                const nowCollapsed = !qcClassCollapsedMap[cName];
                setClassRowsCollapsed(tbody, cName, nowCollapsed);
                const toggleEl = trClass.querySelector('.qc-tree-toggle');
                if (toggleEl) toggleEl.textContent = nowCollapsed ? '▶' : '▼';
                const hintEl = trClass.querySelector('.qc-class-hint');
                if (hintEl) hintEl.textContent = `(Bấm để ${nowCollapsed ? 'mở rộng' : 'thu gọn'})`;
                const searchInp = document.getElementById('qc-rules-search-inp');
                if (searchInp && searchInp.value.trim()) {
                    apDungBoLocBangQC(tbody, searchInp.value);
                }
            });

            tbody.appendChild(trClass);

            // Hàm sinh HTML cho hàng lá (Leaf row)
            const renderLeafRow = (rule, indentPx, prefixTxt) => {
                const tr = document.createElement('tr');
                tr.className = `qc-tree-row qc-leaf-row qc-child-of-${cName}`;
                tr.setAttribute('data-class', cName);
                tr.setAttribute('data-rule-key', rule.key);
                if (isCollapsed) tr.style.display = 'none';

                tr.innerHTML = `
                    <td style="padding-left:${indentPx}px;">
                        <div class="qc-leaf-name-wrap">
                            <span class="qc-leaf-prefix">${prefixTxt}</span>
                            <span style="font-weight:600;color:#f8fafc;">${rule.displayName}</span>
                        </div>
                    </td>
                    <td style="text-align:center;">
                        <label class="qc-checkbox-label" title="Tích chọn để bắt buộc kích thước không thay đổi qua các frames">
                            <input type="checkbox" class="qc-checkbox qc-inp-sync" ${rule.dongBoKichThuoc ? 'checked' : ''} data-key="${rule.key}" />
                            <span style="font-size:11px;color:${rule.dongBoKichThuoc ? '#34d399' : '#64748b'};font-weight:${rule.dongBoKichThuoc ? '700' : '500'};">
                                Đồng bộ kích thước
                            </span>
                        </label>
                    </td>
                    <td style="text-align:center;">
                        <div class="qc-input-range">
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-minL" value="${rule.minL}" data-key="${rule.key}" />
                            <span style="color:#64748b;">-</span>
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-maxL" value="${rule.maxL}" data-key="${rule.key}" />
                        </div>
                    </td>
                    <td style="text-align:center;">
                        <div class="qc-input-range">
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-minW" value="${rule.minW}" data-key="${rule.key}" />
                            <span style="color:#64748b;">-</span>
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-maxW" value="${rule.maxW}" data-key="${rule.key}" />
                        </div>
                    </td>
                    <td style="text-align:center;">
                        <div class="qc-input-range">
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-minH" value="${rule.minH}" data-key="${rule.key}" />
                            <span style="color:#64748b;">-</span>
                            <input type="number" step="0.05" class="qc-num-inp qc-inp-maxH" value="${rule.maxH}" data-key="${rule.key}" />
                        </div>
                    </td>
                    <td style="text-align:center;">
                        <button class="btn-qc-action btn-qc-row-reset" data-key="${rule.key}" title="Khôi phục thông số mặc định">🔄</button>
                    </td>
                `;
                tbody.appendChild(tr);
            };

            // 2. Render các hàng con
            if (classNode.hasSubGroups) {
                // Nhóm có cấp trung gian (pedestrian, two-wheels)
                classNode.subGroups.forEach(sg => {
                    const trSub = document.createElement('tr');
                    trSub.className = `qc-tree-row qc-subgroup-row qc-child-of-${cName}`;
                    trSub.setAttribute('data-class', cName);
                    if (isCollapsed) trSub.style.display = 'none';
                    trSub.innerHTML = `
                        <td colspan="6" class="qc-subgroup-cell">
                            <div class="qc-subgroup-wrap">
                                <span>📁</span>
                                <span>${sg.groupName}</span>
                            </div>
                        </td>
                    `;
                    tbody.appendChild(trSub);

                    sg.items.forEach(it => {
                        const rule = rulesMap.get(it.key) || it;
                        renderLeafRow(rule, 52, '↳');
                    });
                });
            } else {
                // Nhóm phẳng 1 cấp (vehicles, other classes)
                classNode.children.forEach(it => {
                    const rule = rulesMap.get(it.key) || it;
                    renderLeafRow(rule, 32, '↳');
                });
            }
        });

        // Bắt sự kiện thay đổi dữ liệu trên bảng
        tbody.querySelectorAll('.qc-inp-sync').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const key = e.target.getAttribute('data-key');
                const rule = rulesMap.get(key);
                if (rule) {
                    rule.dongBoKichThuoc = e.target.checked;
                    const lbl = e.target.parentElement.querySelector('span');
                    if (lbl) {
                        lbl.style.color = e.target.checked ? '#34d399' : '#64748b';
                        lbl.style.fontWeight = e.target.checked ? '700' : '500';
                    }
                }
            });
        });

        const bindNumChange = (selector, prop) => {
            tbody.querySelectorAll(selector).forEach(inp => {
                const syncVal = (e) => {
                    const key = e.target.getAttribute('data-key');
                    const val = parseFloat(e.target.value);
                    const rule = rulesMap.get(key);
                    if (rule && Number.isFinite(val)) {
                        rule[prop] = val;
                    }
                };
                inp.addEventListener('input', syncVal);
                inp.addEventListener('change', syncVal);
            });
        };

        bindNumChange('.qc-inp-minL', 'minL');
        bindNumChange('.qc-inp-maxL', 'maxL');
        bindNumChange('.qc-inp-minW', 'minW');
        bindNumChange('.qc-inp-maxW', 'maxW');
        bindNumChange('.qc-inp-minH', 'minH');
        bindNumChange('.qc-inp-maxH', 'maxH');

        // Reset từng hàng về mặc định
        tbody.querySelectorAll('.btn-qc-row-reset').forEach(btn => {
            btn.addEventListener('click', (e) => {
                docDuLieuFormVaoConfig();
                const key = btn.getAttribute('data-key');
                const rule = rulesMap.get(key);
                if (!rule || !window.thuatToanCanChinh) return;
                const base = window.thuatToanCanChinh.khamPhaSchemaQCTuDong(currentAnnotations, currentLabels || {});
                const defRule = (base.rules || []).find(r => r.key === key);
                if (defRule) {
                    Object.assign(rule, defRule);
                    renderTreeRulesTable();
                    hienToast(`🔄 Đã khôi phục quy tắc: ${rule.displayName}`);
                }
            });
        });

        // Giữ nguyên bộ lọc tìm kiếm nếu đang có từ khóa
        const searchInp = document.getElementById('qc-rules-search-inp');
        if (searchInp && searchInp.value.trim()) {
            apDungBoLocBangQC(tbody, searchInp.value);
        }
    }

    /**
     * VẼ TAB CHỒNG LẤN BOX (TAB 2)
     */
    function renderCollisionTab() {
        if (!qcActiveConfig) return;
        const clsList = qcActiveConfig.classes || ['vehicles', 'two-wheels', 'pedestrian'];

        // Điền options cho 2 dropdown thêm cặp mới
        const sel1 = document.getElementById('qc-select-class1');
        const sel2 = document.getElementById('qc-select-class2');
        if (sel1 && sel2) {
            let optHtml = '';
            clsList.forEach(c => {
                optHtml += `<option value="${c}">${c}</option>`;
            });
            sel1.innerHTML = optHtml;
            sel2.innerHTML = optHtml;
            if (clsList.length > 1) sel2.selectedIndex = 1;
        }

        renderCollisionPairsList();
    }

    function renderCollisionPairsList() {
        const container = document.getElementById('qc-pairs-list-container');
        const countLbl = document.getElementById('qc-pairs-count-lbl');
        if (!container || !qcActiveConfig) return;

        const pairs = qcActiveConfig.collisionPairs || [];
        if (countLbl) countLbl.textContent = `Đang theo dõi: ${pairs.length} cặp`;

        if (pairs.length === 0) {
            container.innerHTML = `
                <div style="grid-column:1/-1;text-align:center;padding:30px;color:#94a3b8;background:#090d16;border:1px dashed #334155;border-radius:8px;">
                    Chưa có cặp class nào được theo dõi. Hãy bấm <b>"➕ Thêm Cặp Chồng Lấn"</b> để thêm.
                </div>
            `;
            return;
        }

        const getClassIcon = (c) => {
            const cl = String(c || '').toLowerCase();
            if (cl.includes('vehi') || cl.includes('car')) return '🚗';
            if (cl.includes('two-wheel') || cl.includes('moto')) return '🏍️';
            if (cl.includes('pedes') || cl.includes('person')) return '🚶';
            return '📦';
        };

        container.innerHTML = '';
        pairs.forEach((p, idx) => {
            const card = document.createElement('div');
            card.className = 'qc-pair-card';
            card.innerHTML = `
                <div class="qc-pair-content">
                    <span class="qc-class-badge">${getClassIcon(p.label1)} ${p.label1}</span>
                    <span class="qc-pair-connector">↔</span>
                    <span class="qc-class-badge">${getClassIcon(p.label2)} ${p.label2}</span>
                </div>
                <button class="btn-qc-del-pair" data-idx="${idx}" title="Xóa cặp ${p.label1} ↔ ${p.label2}">✕</button>
            `;

            card.querySelector('.btn-qc-del-pair')?.addEventListener('click', () => {
                qcActiveConfig.collisionPairs.splice(idx, 1);
                renderCollisionPairsList();
                hienToast(`🗑️ Đã xóa cặp: ${p.label1} ↔ ${p.label2}`);
            });

            container.appendChild(card);
        });
    }

    /**
     * VẼ TAB GÓC XOAY ĐỘT NGỘT (TAB 3)
     */
    function renderYawTab() {
        const inp = document.getElementById('qc-inp-yaw-threshold');
        if (inp && qcActiveConfig) {
            const rawCfg = Number(qcActiveConfig.yawThresholdDeg);
            const curVal = (Number.isFinite(rawCfg) && rawCfg > 0) ? rawCfg : 150;
            inp.value = curVal;
            syncYawPresetPills(curVal);

            const handleYawUpdate = (e, normalizeInvalid) => {
                const txt = String(e.target.value ?? '').trim();
                const raw = txt === '' ? NaN : Number(txt);
                if (Number.isFinite(raw) && raw > 0) {
                    qcActiveConfig.yawThresholdDeg = raw;
                    syncYawPresetPills(raw);
                } else {
                    syncYawPresetPills(NaN);
                    if (normalizeInvalid) {
                        qcActiveConfig.yawThresholdDeg = 150;
                        e.target.value = 150;
                        syncYawPresetPills(150);
                    }
                }
            };

            inp.oninput = (e) => handleYawUpdate(e, false);
            inp.onchange = (e) => handleYawUpdate(e, true);
        }
    }

    /**
     * VẼ TAB PHÁT HIỆN OBJECT NHIỀU ID (TAB 4)
     */
    function renderSplitIdTab() {
        const cfg = (qcActiveConfig && qcActiveConfig.splitId) || {
            bat: true,
            K: 3,
            maxOverlap: 2,
            scoreMin: 0.50,
            hienDoTinCayThap: false
        };
        const chkBat = document.getElementById('qc-chk-split-bat');
        const chkLow = document.getElementById('qc-chk-split-lowconf');
        const inpK = document.getElementById('qc-inp-split-k');
        const inpOv = document.getElementById('qc-inp-split-overlap');
        const inpScore = document.getElementById('qc-inp-split-score');

        if (chkBat) chkBat.checked = cfg.bat !== false;
        if (chkLow) chkLow.checked = !!cfg.hienDoTinCayThap;
        if (inpK) inpK.value = Number.isFinite(Number(cfg.K)) ? Number(cfg.K) : 3;
        if (inpOv) inpOv.value = Number.isFinite(Number(cfg.maxOverlap)) ? Number(cfg.maxOverlap) : 2;
        if (inpScore) inpScore.value = Number.isFinite(Number(cfg.scoreMin)) ? Number(cfg.scoreMin).toFixed(2) : '0.50';
    }

    function docDuLieuFormVaoConfig() {
        if (!qcActiveConfig) return;

        // Đồng bộ mọi chỉnh sửa đang chờ trên bảng quy tắc kích thước (kể cả khi chưa blur)
        if (Array.isArray(qcActiveConfig.rules)) {
            const rulesMap = new Map();
            qcActiveConfig.rules.forEach(r => {
                if (r && r.key) rulesMap.set(r.key, r);
            });
            const tbody = document.getElementById('qc-rules-table-body');
            if (tbody) {
                tbody.querySelectorAll('.qc-inp-sync').forEach(inp => {
                    const key = inp.getAttribute('data-key');
                    const rule = key ? rulesMap.get(key) : null;
                    if (rule) rule.dongBoKichThuoc = !!inp.checked;
                });
                const numBindings = [
                    ['.qc-inp-minL', 'minL'],
                    ['.qc-inp-maxL', 'maxL'],
                    ['.qc-inp-minW', 'minW'],
                    ['.qc-inp-maxW', 'maxW'],
                    ['.qc-inp-minH', 'minH'],
                    ['.qc-inp-maxH', 'maxH']
                ];
                for (const [sel, prop] of numBindings) {
                    tbody.querySelectorAll(sel).forEach(inp => {
                        const key = inp.getAttribute('data-key');
                        const rule = key ? rulesMap.get(key) : null;
                        const val = parseFloat(inp.value);
                        if (rule && Number.isFinite(val)) {
                            rule[prop] = val;
                        }
                    });
                }
            }
        }

        const yawInp = document.getElementById('qc-inp-yaw-threshold');
        if (yawInp) {
            const txt = String(yawInp.value ?? '').trim();
            const rawYaw = txt === '' ? NaN : Number(txt);
            const safeYaw = (Number.isFinite(rawYaw) && rawYaw > 0) ? rawYaw : 150;
            qcActiveConfig.yawThresholdDeg = safeYaw;
            syncYawPresetPills(safeYaw);
        }

        if (!qcActiveConfig.splitId || typeof qcActiveConfig.splitId !== 'object') {
            qcActiveConfig.splitId = {};
        }
        const chkBat = document.getElementById('qc-chk-split-bat');
        const chkLow = document.getElementById('qc-chk-split-lowconf');
        const inpK = document.getElementById('qc-inp-split-k');
        const inpOv = document.getElementById('qc-inp-split-overlap');
        const inpScore = document.getElementById('qc-inp-split-score');

        if (chkBat) qcActiveConfig.splitId.bat = !!chkBat.checked;
        if (chkLow) qcActiveConfig.splitId.hienDoTinCayThap = !!chkLow.checked;
        if (inpK) {
            const kVal = parseInt(inpK.value, 10);
            qcActiveConfig.splitId.K = Number.isFinite(kVal) ? Math.min(10, Math.max(1, kVal)) : 3;
        }
        if (inpOv) {
            const ovVal = parseInt(inpOv.value, 10);
            qcActiveConfig.splitId.maxOverlap = Number.isFinite(ovVal) ? Math.min(5, Math.max(0, ovVal)) : 2;
        }
        if (inpScore) {
            const sVal = Number(inpScore.value);
            qcActiveConfig.splitId.scoreMin = Number.isFinite(sVal) ? Math.min(0.90, Math.max(0.30, sVal)) : 0.50;
        }
    }

    async function chayVaHienThiBaoCaoQC(opts = {}) {
        const engine = window.thuatToanCanChinh;
        if (!engine || typeof engine.chayKiemDinhQC !== 'function') {
            hienToast('❌ Thuật toán kiểm định QC chưa được khởi tạo!');
            return;
        }

        if (!currentAnnotations || !Array.isArray(currentAnnotations.tracks)) {
            try {
                if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.taiAnnotations === 'function') {
                    currentAnnotations = await window.quanLyAPICVAT.taiAnnotations();
                }
            } catch (e) {}
        }
        if (!currentAnnotations || !Array.isArray(currentAnnotations.tracks)) {
            hienToast('⚠️ Chưa có dữ liệu Annotations để kiểm định QC!');
            return;
        }

        if (!hasNonEmptyLabels(currentLabels)) {
            try {
                if (window.quanLyAPICVAT && typeof window.quanLyAPICVAT.taiLabels === 'function') {
                    currentLabels = await window.quanLyAPICVAT.taiLabels();
                }
            } catch (e) {}
        }

        if (!qcActiveConfig) {
            khoiTaoConfigMacDinh();
        }
        docDuLieuFormVaoConfig();
        const jid = layJobIdHienTai();
        luuCauHinhQCVaoStorage(jid, qcActiveConfig);

        if (opts && opts.focusFilter) {
            qcFilterType = opts.focusFilter;
        }
        document.querySelectorAll('#cvat-qc-modal .qc-stat-card').forEach(c => {
            c.classList.toggle('active', (c.getAttribute('data-filter') || 'all') === qcFilterType);
        });

        try {
            dongBoBangAnhXaID(currentAnnotations);
        } catch (eSync) {
            console.warn('[QC] Đồng bộ ID thất bại, dùng thứ tự #idx:', eSync);
        }

        const res = engine.chayKiemDinhQC(currentAnnotations, qcActiveConfig, currentLabels || {});
        lastQCReportResult = res;

        const statusEl = document.getElementById('qc-status-text');
        if (statusEl) {
            if ((res.soFallbackID || 0) > 0) {
                statusEl.textContent = `⚠️ Có ${res.soFallbackID} track chưa khớp CVAT, đang dùng thứ tự #idx.`;
                statusEl.style.color = '#fbbf24';
            } else {
                statusEl.textContent = '💡 Đã đồng bộ Track ID khớp CVAT (cấu hình lưu tự động theo từng Job).';
                statusEl.style.color = '#94a3b8';
            }
        }

        // Cập nhật giao diện thống kê và badge
        capNhatThongKeVaBadge(res);

        // Chuyển sang Tab Báo Cáo
        const tabReportBtn = document.querySelector('.qc-tab-btn[data-tab="qc-tab-report"]');
        if (tabReportBtn) tabReportBtn.click();

        renderQCIssuesList();

        // Cập nhật trạng thái nút HUD
        capNhatNutQCTrenHUD(res.tongLoi);

        if (opts && opts.focusFilter === 'split_id') {
            if ((res.soLoiVoID || 0) === 0) {
                hienToast('✅ Không phát hiện object nào bị chia nhiều ID!');
            } else {
                hienToast(`🔀 Phát hiện ${res.soLoiVoID} object bị chia nhiều ID (${res.soIDThua || 0} ID thừa)!`);
            }
        } else if (res.tongLoi === 0) {
            hienToast('🎉 Chúc mừng! Toàn bộ 3D Annotation hoàn hảo, không có lỗi nào!');
        } else {
            hienToast(`⚠️ Phát hiện ${res.tongLoi} điểm bất thường cần rà soát!`);
        }
    }

    function capNhatThongKeVaBadge(res) {
        if (!res) return;
        const setVal = (id, v) => {
            const el = document.getElementById(id);
            if (el) el.textContent = v;
        };
        const tongLoi = res.tongLoi || 0;
        setVal('qc-stat-total', tongLoi);
        setVal('qc-stat-sync', res.soLoiDongBo || 0);
        setVal('qc-stat-bound', res.soLoiKhoangKichThuoc || 0);
        setVal('qc-stat-yaw', res.soLoiXoayDotNgot || 0);
        setVal('qc-stat-collision', res.soLoiChongLan || 0);
        setVal('qc-stat-split-id', res.soLoiVoID || 0);

        const tabBadge = document.getElementById('qc-tab-report-badge');
        if (tabBadge) {
            tabBadge.textContent = tongLoi;
            if (tongLoi > 0) {
                tabBadge.className = 'qc-badge-pill';
            } else {
                tabBadge.className = 'qc-badge-pill empty';
            }
        }
    }

    function capNhatNutQCTrenHUD(tongLoi) {
        const btn = document.getElementById('btn-hud-qc-tool');
        if (!btn) return;
        if (tongLoi > 0) {
            btn.classList.add('has-errors');
            btn.innerHTML = `🛡️ QC (${tongLoi})`;
            btn.title = `Phát hiện ${tongLoi} lỗi 3D Annotation! Bấm để mở danh sách kiểm định chi tiết.`;
        } else {
            btn.classList.remove('has-errors');
            btn.innerHTML = `🛡️ QC Tool`;
            btn.title = `Kiểm định chất lượng 3D Annotation: đồng bộ size, ngưỡng kích thước, xoay đột ngột, chồng lấn box`;
        }
    }

    function renderQCIssuesList() {
        const container = document.getElementById('qc-issues-container');
        if (!container) return;

        document.querySelectorAll('#cvat-qc-modal .qc-stat-card').forEach(c => {
            c.classList.toggle('active', (c.getAttribute('data-filter') || 'all') === qcFilterType);
        });

        if (!lastQCReportResult) {
            container.innerHTML = `<div style="text-align:center;padding:50px;color:#94a3b8;">💡 Bấm <b>"🚀 KIỂM TRA TOÀN BỘ JOB"</b> bên dưới để quét phát hiện lỗi ngay tức thì.</div>`;
            return;
        }

        const res = lastQCReportResult;
        let issues = [];

        if (qcFilterType === 'all') {
            issues = [
                ...(res.loiDongBo || []),
                ...(res.loiKhoangKichThuoc || []),
                ...(res.loiXoayDotNgot || []),
                ...(res.loiChongLan || []),
                ...(res.loiVoID || [])
            ];
        } else if (qcFilterType === 'size_variance') {
            issues = [...(res.loiDongBo || [])];
        } else if (qcFilterType === 'dimension_bound') {
            issues = [...(res.loiKhoangKichThuoc || [])];
        } else if (qcFilterType === 'yaw_jump') {
            issues = [...(res.loiXoayDotNgot || [])];
        } else if (qcFilterType === 'box_overlap') {
            issues = [...(res.loiChongLan || [])];
        } else if (qcFilterType === 'split_id') {
            issues = [...(res.loiVoID || [])];
        }

        if (issues.length === 0) {
            container.innerHTML = `
                <div style="text-align:center;padding:40px;color:#34d399;background:#090d16;border:1px dashed #059669;border-radius:10px;">
                    <div style="font-size:24px;margin-bottom:6px;">🎉</div>
                    <div style="font-size:13px;font-weight:700;">Không có lỗi nào thuộc bộ lọc này!</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:2px;">Tất cả hình hộp và thuộc tính đều thỏa mãn quy chuẩn kiểm định.</div>
                </div>
            `;
            return;
        }

        container.innerHTML = '';
        issues.forEach(iss => {
            const card = document.createElement('div');
            card.className = `qc-issue-card type-${iss.loai.replace('_', '-')}`;

            let badgeHtml = '';
            let titleHtml = '';
            let descHtml = '';
            let actionsHtml = '';

            if (iss.loai === 'size_variance') {
                badgeHtml = `<span style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid #f59e0b;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;">⚠️ KHÔNG ĐỒNG BỘ SIZE</span>`;
                titleHtml = `Track #${iss.trackId} (${escQCHtml(iss.label)}) - ${escQCHtml(iss.ruleName)}`;
                descHtml = `Kích thước thay đổi: ${escQCHtml(iss.details)}. Lệch lớn nhất: ΔL=${iss.delta.L}m, ΔW=${iss.delta.W}m, ΔH=${iss.delta.H}m qua ${iss.frames.length} frames.`;
                actionsHtml = `
                    <button class="btn-qc-action" data-action="view" data-track="${iss.trackId}" data-track-key="${escQCHtml(iss.trackKey || '')}" data-frame="${iss.firstFrame}">👁️ Xem Frame #${iss.firstFrame}</button>
                    <button class="btn-qc-action success" data-action="quick-fix" data-track="${iss.trackId}" data-track-key="${escQCHtml(iss.trackKey || '')}">⚡ Sửa Nhanh (Trung Vị)</button>
                `;
            } else if (iss.loai === 'dimension_bound') {
                badgeHtml = `<span style="background:rgba(239,68,68,0.2);color:#f87171;border:1px solid #ef4444;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;">🔴 LỆCH NGƯỠNG</span>`;
                titleHtml = `Track #${iss.trackId} (${escQCHtml(iss.label)}) tại Frame #${iss.frame}`;
                descHtml = `${escQCHtml(iss.details)} (Quy chuẩn chuẩn hóa: ${escQCHtml(iss.ruleName)})`;
                actionsHtml = `
                    <button class="btn-qc-action" data-action="view" data-track="${iss.trackId}" data-track-key="${escQCHtml(iss.trackKey || '')}" data-frame="${iss.frame}">👁️ Xem Frame #${iss.frame}</button>
                `;
            } else if (iss.loai === 'yaw_jump') {
                badgeHtml = `<span style="background:rgba(56,189,248,0.2);color:#38bdf8;border:1px solid #0284c7;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;">🔄 XOAY ĐỘT NGỘT</span>`;
                titleHtml = `Track #${iss.trackId} (${escQCHtml(iss.label)}) tại Frame #${iss.frame}`;
                descHtml = `${escQCHtml(iss.details)} (Chênh lệch: ${iss.angleJump}°)`;
                actionsHtml = `
                    <button class="btn-qc-action" data-action="view" data-track="${iss.trackId}" data-track-key="${escQCHtml(iss.trackKey || '')}" data-frame="${iss.frame}">👁️ Xem Frame #${iss.frame}</button>
                    <button class="btn-qc-action primary" data-action="flip-180" data-track="${iss.trackId}" data-track-key="${escQCHtml(iss.trackKey || '')}" data-frame="${iss.frame}">🔄 Đảo 180°</button>
                `;
            } else if (iss.loai === 'box_overlap') {
                badgeHtml = `<span style="background:rgba(236,72,153,0.2);color:#f472b6;border:1px solid #ec4899;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;">💥 CHỒNG LẤN BOX</span>`;
                titleHtml = `Track #${iss.track1} (${escQCHtml(iss.label1)}) ↔ Track #${iss.track2} (${escQCHtml(iss.label2)}) tại Frame #${iss.frame}`;
                descHtml = `${escQCHtml(iss.details)}`;
                actionsHtml = `
                    <button class="btn-qc-action" data-action="view" data-track="${iss.track1}" data-track-key="${escQCHtml(iss.track1Key || '')}" data-frame="${iss.frame}">👁️ Track #${iss.track1}</button>
                    <button class="btn-qc-action" data-action="view" data-track="${iss.track2}" data-track-key="${escQCHtml(iss.track2Key || '')}" data-frame="${iss.frame}">👁️ Track #${iss.track2}</button>
                    <button class="btn-qc-action success" data-action="outside-smaller" data-track1="${iss.track1}" data-track2="${iss.track2}" data-track1-key="${escQCHtml(iss.track1Key || '')}" data-track2-key="${escQCHtml(iss.track2Key || '')}" data-frame="${iss.frame}">⚡ Outside Hộp Ngắn Hơn</button>
                `;
            }

            if (iss.loai === 'split_id') {
                const cum = iss.chiTiet || {};
                const chain = Array.isArray(cum.chain) ? cum.chain : [];
                const links = Array.isArray(cum.links) ? cum.links : [];

                const infoDiv = document.createElement('div');
                infoDiv.className = 'qc-issue-info';

                const titleRow = document.createElement('div');
                titleRow.className = 'qc-issue-title';

                const badgeSpan = document.createElement('span');
                badgeSpan.style.cssText = 'background:rgba(6,182,212,0.2);color:#22d3ee;border:1px solid #06b6d4;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:800;';
                badgeSpan.textContent = '🔀 OBJECT NHIỀU ID';
                titleRow.appendChild(badgeSpan);

                const confMap = { cao: 'Tin cậy: Cao', trungbinh: 'Tin cậy: TB', thap: 'Tin cậy: Thấp' };
                const confSpan = document.createElement('span');
                const confKey = iss.doTinCay === 'cao' || iss.doTinCay === 'trungbinh' || iss.doTinCay === 'thap' ? iss.doTinCay : 'trungbinh';
                confSpan.className = `qc-split-conf ${confKey}`;
                confSpan.textContent = `${confMap[confKey]} (${Math.round((iss.diemThapNhat || 0) * 100)}%)`;
                titleRow.appendChild(confSpan);

                if (iss.moHo) {
                    const warnSpan = document.createElement('span');
                    warnSpan.style.cssText = 'background:rgba(245,158,11,0.18);color:#fbbf24;border:1px solid rgba(251,191,36,0.5);padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700;';
                    warnSpan.textContent = '⚠️ Có ứng viên gần';
                    titleRow.appendChild(warnSpan);
                }

                const titleText = document.createElement('span');
                const labelHead = chain[0]?.label || iss.nhom || '';
                titleText.textContent = `1 Object có ${iss.soID} ID (${labelHead})`;
                titleRow.appendChild(titleText);
                infoDiv.appendChild(titleRow);

                const chainDiv = document.createElement('div');
                chainDiv.className = 'qc-split-chain';
                chain.forEach((seg, idx) => {
                    if (idx > 0) {
                        const arrow = document.createElement('span');
                        arrow.className = 'qc-split-arrow';
                        const lnk = links[idx - 1];
                        arrow.textContent = lnk ? `→ (Δ=${lnk.dt}f, score=${lnk.score}) →` : '→';
                        chainDiv.appendChild(arrow);
                    }
                    const chip = document.createElement('span');
                    chip.className = 'qc-split-seg-chip';
                    const outStr = seg.outsideAfterFrame != null ? `, out@F${seg.outsideAfterFrame}` : '';
                    chip.textContent = `#${seg.trackId} [F${seg.f0}..${seg.f1}${outStr}]`;
                    chainDiv.appendChild(chip);
                });
                infoDiv.appendChild(chainDiv);

                if (links.length > 0) {
                    const descDiv = document.createElement('div');
                    descDiv.className = 'qc-issue-desc';
                    const metricParts = links.map(lnk => {
                        const fwdD = lnk.fwd?.d != null ? `${lnk.fwd.d}m` : 'n/a';
                        const bwdD = lnk.bwd?.d != null ? `${lnk.bwd.d}m` : 'n/a';
                        const iouTxt = Math.max(lnk.fwd?.iou || 0, lnk.bwd?.iou || 0).toFixed(2);
                        return `#${lnk.fromTrackId}→#${lnk.toTrackId}: lệch Fwd=${fwdD}, Bwd=${bwdD}, IoU=${iouTxt}, ΔYaw=${lnk.dYawDeg ?? '--'}°, ΔSize=${lnk.dSize ?? '--'}`;
                    });
                    descDiv.textContent = metricParts.join(' | ');
                    infoDiv.appendChild(descDiv);
                }

                const actionsDiv = document.createElement('div');
                actionsDiv.className = 'qc-issue-actions';
                chain.forEach((seg, idx) => {
                    const btn = document.createElement('button');
                    btn.className = 'btn-qc-action';
                    btn.setAttribute('data-action', 'view');
                    btn.setAttribute('data-track', String(seg.trackId));
                    if (seg.trackKey) btn.setAttribute('data-track-key', String(seg.trackKey));
                    const targetFrame = idx === 0 ? seg.f1 : seg.f0;
                    btn.setAttribute('data-frame', String(targetFrame));
                    btn.textContent = `👁️ #${seg.trackId} (F${targetFrame})`;
                    actionsDiv.appendChild(btn);
                });
                if (links[0] && links[0].outsideFrame != null) {
                    const btnTrans = document.createElement('button');
                    btnTrans.className = 'btn-qc-action cyan';
                    btnTrans.setAttribute('data-action', 'view');
                    btnTrans.setAttribute('data-track', String(links[0].toTrackId));
                    if (links[0].toTrackKey) btnTrans.setAttribute('data-track-key', String(links[0].toTrackKey));
                    btnTrans.setAttribute('data-frame', String(links[0].toF0));
                    btnTrans.textContent = `👁️ Chuyển giao F${links[0].toF0}`;
                    actionsDiv.appendChild(btnTrans);
                }

                card.appendChild(infoDiv);
                card.appendChild(actionsDiv);
            } else {
                card.innerHTML = `
                    <div class="qc-issue-info">
                        <div class="qc-issue-title">
                            ${badgeHtml}
                            <span>${titleHtml}</span>
                        </div>
                        <div class="qc-issue-desc">${descHtml}</div>
                    </div>
                    <div class="qc-issue-actions">
                        ${actionsHtml}
                    </div>
                `;
            }

            // Xử lý sự kiện cho các nút hành động trên card
            card.querySelectorAll('button[data-action]').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    const action = btn.getAttribute('data-action');
                    const trId = Number(btn.getAttribute('data-track'));
                    const trKey = btn.getAttribute('data-track-key') || '';
                    const fn = Number(btn.getAttribute('data-frame'));
                    const engine = window.thuatToanCanChinh;

                    if (action === 'view') {
                        await dieuHuongDenTrackVaFrame(trId, fn, { trackKey: trKey });
                        hienToast(`🎯 Đã chuyển tới Track #${trId} tại Frame #${fn}`);
                    } else if (action === 'quick-fix') {
                        if (engine && typeof engine.suaNhanhDongBoKichThuocTrack === 'function') {
                            const fixRes = engine.suaNhanhDongBoKichThuocTrack(currentAnnotations, trId, iss.median, { trackKey: trKey });
                            if (fixRes) {
                                window._modalHasEditedMultipleTracks = true;
                                hienToast(`✅ Đã đồng bộ kích thước Track #${trId} về L=${fixRes.newSize.L}, W=${fixRes.newSize.W}, H=${fixRes.newSize.H}m! Hãy bấm Áp Dụng & Lưu để lưu.`);
                                await chayVaHienThiBaoCaoQC();
                            } else {
                                hienToast('⚠️ Không tìm thấy track để đồng bộ, hãy chạy lại QC!');
                            }
                        }
                    } else if (action === 'flip-180') {
                        const tr = (engine && typeof engine.timTrackQC === 'function')
                            ? engine.timTrackQC(currentAnnotations, { trackKey: trKey, trackId: trId })
                            : null;
                        if (!tr) {
                            hienToast('⚠️ Không tìm thấy track, hãy chạy lại QC!');
                            return;
                        }
                        const sh = Array.isArray(tr.shapes)
                            ? (tr.shapes.find(s => s.frame === fn && !s.outside) || tr.shapes.find(s => s.frame === fn))
                            : null;
                        if (sh && sh.points && sh.points.length >= 6) {
                            const flippedYaw = Math.atan2(Math.sin(sh.points[5] + Math.PI), Math.cos(sh.points[5] + Math.PI));
                            sh.points[5] = parseFloat(flippedYaw.toFixed(3));
                            tr._isDirty = true;
                            window._modalHasEditedMultipleTracks = true;
                            hienToast(`🔄 Đã đảo 180° Track #${trId} tại Frame #${fn}!`);
                            await chayVaHienThiBaoCaoQC();
                        } else {
                            hienToast(`⚠️ Không tìm thấy keyframe hợp lệ tại Frame #${fn}!`);
                        }
                    } else if (action === 'outside-smaller') {
                        const trId1 = Number(btn.getAttribute('data-track1'));
                        const trId2 = Number(btn.getAttribute('data-track2'));
                        const trKey1 = btn.getAttribute('data-track1-key') || '';
                        const trKey2 = btn.getAttribute('data-track2-key') || '';
                        const tr1 = (engine && typeof engine.timTrackQC === 'function')
                            ? engine.timTrackQC(currentAnnotations, { trackKey: trKey1, trackId: trId1 })
                            : null;
                        const tr2 = (engine && typeof engine.timTrackQC === 'function')
                            ? engine.timTrackQC(currentAnnotations, { trackKey: trKey2, trackId: trId2 })
                            : null;
                        if (!tr1 || !tr2) {
                            hienToast('⚠️ Không tìm thấy track, hãy chạy lại QC!');
                            return;
                        }
                        const len1 = (tr1.shapes || []).filter(s => !s.outside).length;
                        const len2 = (tr2.shapes || []).filter(s => !s.outside).length;
                        let targetTrId, targetTr;
                        if (len1 !== len2) {
                            targetTrId = len1 < len2 ? trId1 : trId2;
                            targetTr = len1 < len2 ? tr1 : tr2;
                        } else {
                            targetTrId = trId1 > trId2 ? trId1 : trId2;
                            targetTr = trId1 > trId2 ? tr1 : tr2;
                        }
                        const targetSh = Array.isArray(targetTr.shapes)
                            ? (targetTr.shapes.find(s => s.frame === fn && !s.outside) || targetTr.shapes.find(s => s.frame === fn))
                            : null;
                        if (targetSh) {
                            targetSh.outside = true;
                            targetTr._isDirty = true;
                            window._modalHasEditedMultipleTracks = true;
                            hienToast(`✅ Đã đánh Outside Track #${targetTrId} tại Frame #${fn}!`);
                            await chayVaHienThiBaoCaoQC();
                        } else {
                            hienToast(`⚠️ Track #${targetTrId} không có keyframe tại Frame #${fn} (đang nội suy), hãy bấm Xem Track để xử lý!`);
                        }
                    }
                });
            });

            container.appendChild(card);
        });
    }

    // Lắng nghe phím Esc (thu nhỏ), ArrowLeft / ArrowRight (chuyển view), và Ctrl+A (Chọn Cả trong modal)
    document.addEventListener('keydown', (e) => {
        const viewer2d = document.getElementById('cvat-2d-image-viewer');
        if (viewer2d && viewer2d.style.display !== 'none' && !e.target.matches('input, textarea, select')) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                viewer2d.style.display = 'none';
                return;
            } else if (e.key === 'ArrowLeft' || e.key === '[') {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById('v2d-btn-prev')?.click();
                return;
            } else if (e.key === 'ArrowRight' || e.key === ']') {
                e.preventDefault();
                e.stopPropagation();
                document.getElementById('v2d-btn-next')?.click();
                return;
            }
        }

        const modal = document.getElementById('cvat-detail-modal');
        const isModalOpen = modal && modal.style.display !== 'none';

        // Phím tắt Ctrl + A để Chọn Cả / Bỏ Chọn Cả khi modal đang mở
        if (isModalOpen && (e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A') && !e.target.matches('input, textarea, select')) {
            e.preventDefault();
            e.stopPropagation();
            document.getElementById('modal-btn-select-all')?.click();
            return;
        }
        if (e.key === 'Escape') {
            const fsCard = document.querySelector('.row-view-card.is-fullscreen-view');
            if (fsCard) {
                e.preventDefault();
                e.stopPropagation();
                const btn = fsCard.querySelector('.btn-view-fullscreen');
                if (btn) btn.click();
            }
        } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.altKey && !e.ctrlKey && !e.shiftKey) {
            const fsCard = document.querySelector('.row-view-card.is-fullscreen-view');
            if (fsCard) {
                // Đang ở trạng thái phóng to 1 view: Đổi view tuần hoàn TOP <-> SIDE <-> FRONT
                e.preventDefault();
                e.stopPropagation();

                const row = fsCard.closest('.frame-detail-row');
                if (!row) return;

                const fn = parseInt(row.getAttribute('data-frame-num') || (row.id ? row.id.replace('modal-row-frame-', '') : '0'), 10);
                const curView = fsCard.classList.contains('view-top-card') ? 'top' :
                               (fsCard.classList.contains('view-side-card') ? 'side' : 'front');

                const views = ['top', 'side', 'front'];
                const curIdx = views.indexOf(curView);
                const nextIdx = (e.key === 'ArrowRight') ? (curIdx + 1) % 3 : (curIdx - 1 + 3) % 3;
                const nextView = views[nextIdx];

                const nextCard = row.querySelector(`.view-${nextView}-card`);
                const nextCanvas = nextCard ? nextCard.querySelector(`.canvas-${nextView}`) : null;
                const nextBtn = nextCard ? nextCard.querySelector('.btn-view-fullscreen') : null;

                if (nextCard && nextCanvas && nextBtn) {
                    // Kiểm tra nếu view đó chưa từng xoay hoặc zoom -> Giữ nguyên Standard View
                    const vs = layViewStateCanvas(nextCanvas, fn, nextView);
                    const daXoayHoacZoom = Boolean(vs && (vs._userInteracted || Math.abs(vs.viewPitch || 0) > 0.02 || Math.abs(vs.viewYaw || 0) > 0.02 || Math.abs(vs.panX || 0) > 1 || Math.abs(vs.panY || 0) > 1 || Math.abs((vs.zoom || 1) - 1.0) > 0.05));

                    if (!daXoayHoacZoom && vs) {
                        vs.zoom = 1.0;
                        vs.panX = 0;
                        vs.panY = 0;
                        vs.viewPitch = 0;
                        vs.viewYaw = 0;
                        vs.baseScale = null;
                    }

                    toggleZoomViewCard(nextCard, nextCanvas, nextView, fn, nextBtn);
                }
            }
        }
    });

    // Tự động vẽ lại ô phóng to khi cửa sổ trình duyệt thay đổi kích thước
    window.addEventListener('resize', () => {
        const fsCard = document.querySelector('.row-view-card.is-fullscreen-view');
        if (fsCard) {
            const c = fsCard.querySelector('canvas');
            if (c && typeof taiVeCanvasTheoFrame === 'function') {
                taiVeCanvasTheoFrame(c, c._viewType, c._frameNum);
            }
        }
    });

    // Khởi động

    khoiTaoSPAListener();

    kiemTraVaNhungHUD();

})();
