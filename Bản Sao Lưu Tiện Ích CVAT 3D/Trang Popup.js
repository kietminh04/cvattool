/**
 * Trang Popup.js (CVAT 3D Toolbar Popup Controller)
 * Gửi lệnh điều khiển tới Content Script trên tab CVAT đang mở
 */

document.addEventListener('DOMContentLoaded', async () => {
    const statusPill = document.getElementById('header-status');
    const statusBox = document.getElementById('popup-status');

    function setStatus(msg, isSuccess = true) {
        if (statusBox) statusBox.textContent = msg;
        if (statusPill) {
            statusPill.textContent = isSuccess ? "🟢 Đã kết nối" : "⚠️ Cảnh báo";
            statusPill.style.color = isSuccess ? "#34d399" : "#fbbf24";
        }
    }

    async function sendToActiveTab(action, payload = {}) {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.id) {
                setStatus("Không tìm thấy tab CVAT đang mở!", false);
                return null;
            }

            if (!tab.url || (!tab.url.includes('/jobs/') && !tab.url.includes('/tasks/'))) {
                setStatus("Vui lòng mở một trang Job CVAT!", false);
                return null;
            }

            const response = await chrome.tabs.sendMessage(tab.id, { action, payload });
            return response;
        } catch (err) {
            console.error("Lỗi gửi thông điệp:", err);
            setStatus("Chưa kết nối tab CVAT. Vui lòng F5 lại trang!", false);
            return null;
        }
    }

    // 1. Lấy thông tin track hiện tại
    document.getElementById('popup-btn-get-track')?.addEventListener('click', async () => {
        setStatus("Đang đọc track trên trang CVAT...");
        const res = await sendToActiveTab('LAY_TRACK_HIEN_TAI');
        if (res && res.trackId) {
            document.getElementById('popup-track-id').value = res.trackId;
            if (res.dimensions) {
                document.getElementById('popup-dim-l').value = res.dimensions.l.toFixed(3);
                document.getElementById('popup-dim-w').value = res.dimensions.w.toFixed(3);
                document.getElementById('popup-dim-h').value = res.dimensions.h.toFixed(3);
            }
            setStatus(`🎯 Nhận diện Track #${res.trackId}`);
        } else {
            setStatus("Không đọc được track. Vui lòng chọn track trên CVAT!", false);
        }
    });

    // 2. Đồng bộ size track đơn
    document.getElementById('popup-btn-sync-single')?.addEventListener('click', async () => {
        const trackId = parseInt(document.getElementById('popup-track-id').value, 10);
        const l = parseFloat(document.getElementById('popup-dim-l').value);
        const w = parseFloat(document.getElementById('popup-dim-w').value);
        const h = parseFloat(document.getElementById('popup-dim-h').value);

        if (!trackId || isNaN(l) || isNaN(w) || isNaN(h)) {
            setStatus("Vui lòng nhập Track ID và L, W, H!", false);
            return;
        }

        setStatus(`Đang đồng bộ size Track #${trackId}...`);
        const res = await sendToActiveTab('DONG_BO_TRACK', { trackId, l, w, h });
        if (res && res.success) {
            setStatus(`✅ Đã đồng bộ size Track #${trackId}!`);
        } else {
            setStatus(`❌ Lỗi: ${res?.error || 'Không thể đồng bộ'}`, false);
        }
    });

    // 3. Đảo đầu xe 180°
    document.getElementById('popup-btn-invert-yaw')?.addEventListener('click', async () => {
        const trackId = parseInt(document.getElementById('popup-track-id').value, 10);
        setStatus("Đang đảo đầu xe...");
        const res = await sendToActiveTab('DAO_DAU_XE', { trackId });
        if (res && res.success) setStatus("🔄 Đã đảo đầu xe 180°!");
    });

    // 5. CÔNG CỤ TOÀN JOB: Căn Chỉnh Toàn Diện
    document.getElementById('popup-btn-master')?.addEventListener('click', async () => {
        if (!confirm("Khởi động Căn Chỉnh Toàn Diện 5 bước cho TOÀN BỘ JOB?")) return;
        setStatus("🚀 Đang chạy Căn Chỉnh Toàn Diện...");
        const res = await sendToActiveTab('TOAN_JOB_CAN_CHINH');
        if (res && res.success) setStatus("✅ Hoàn tất Căn Chỉnh Toàn Diện!");
    });

    // 6. Khớp Mặt Đường
    document.getElementById('popup-btn-ground')?.addEventListener('click', async () => {
        setStatus("🛣️ Đang khớp mặt đường toàn Job...");
        const res = await sendToActiveTab('TOAN_JOB_KHOP_DUONG');
        if (res && res.success) setStatus("✅ Đã khớp mặt đường!");
    });

    // 7. Ép Sát Thân Xe
    document.getElementById('popup-btn-body')?.addEventListener('click', async () => {
        setStatus("✂️ Đang ép sát thân xe toàn Job...");
        const res = await sendToActiveTab('TOAN_JOB_EP_SAT');
        if (res && res.success) setStatus("✅ Đã ép sát thân xe!");
    });

    // 8. Quét < 5 Điểm (Outside)
    document.getElementById('popup-btn-scan')?.addEventListener('click', async () => {
        setStatus("⚡ Đang quét < 5 điểm...");
        const res = await sendToActiveTab('TOAN_JOB_QUET_OUTSIDE');
        if (res && res.success) setStatus("✅ Đã quét và gán Outside!");
    });

    // 9. Khử Lật Góc 180°
    document.getElementById('popup-btn-yaw')?.addEventListener('click', async () => {
        setStatus("🔄 Đang khử lật góc 180°...");
        const res = await sendToActiveTab('TOAN_JOB_KHU_LAT_GOC');
        if (res && res.success) setStatus("✅ Đã khử lật góc 180°!");
    });

    // 10. Soi Trùng Lặp
    document.getElementById('popup-btn-dup')?.addEventListener('click', async () => {
        setStatus("🔍 Đang soi trùng lặp...");
        const res = await sendToActiveTab('TOAN_JOB_SOI_TRUNG');
        if (res && res.success) setStatus("✅ Đã dọn dẹp trùng lặp!");
    });

    // 11. Tạm Ẩn Outside
    document.getElementById('popup-btn-outside')?.addEventListener('click', async () => {
        const res = await sendToActiveTab('TOAN_JOB_AN_OUTSIDE');
        if (res && res.success) setStatus("👁️ Đã chuyển đổi trạng thái Outside!");
    });

    // 12. Khôi Phục Dữ Liệu Gốc
    document.getElementById('popup-btn-restore')?.addEventListener('click', async () => {
        if (!confirm("⚠️ BẠN CÓ CHẮC MUỐN KHÔI PHỤC DỮ LIỆU GỐC?\n\nToàn bộ bounding box sẽ được hoàn trả về trạng thái Dữ Liệu Thô gốc (khắc phục hoàn toàn lỗi lún mặt đường).")) return;
        setStatus("⏪ Đang khôi phục dữ liệu gốc...");
        const res = await sendToActiveTab('KHOI_PHUC_GOC');
        if (res && res.success) {
            setStatus("✅ Đã khôi phục dữ liệu gốc thành công!");
            await capNhatThongKePopup();
        } else {
            setStatus(`❌ Lỗi: ${res?.error || 'Không thể khôi phục'}`, false);
        }
    });

    async function capNhatThongKePopup() {
        try {
            const res = await sendToActiveTab('LAY_THONG_KE');
            if (res && res.stats) {
                const st = res.stats;
                const elJob = document.getElementById('popup-stat-job-badge');
                if (elJob) elJob.textContent = `JOB #${res.jobId || '1523'}`;

                const elTotal = document.getElementById('popup-stat-total');
                if (elTotal) elTotal.textContent = `${st.tongTracks} (${st.tongShapes} boxes)`;

                const elComp = document.getElementById('popup-stat-complete');
                if (elComp) elComp.textContent = `${st.soTrackHoanChinh}/${st.tongTracks} (${st.tyLeHoanChinh})`;

                const elActOut = document.getElementById('popup-stat-active-out');
                if (elActOut) elActOut.textContent = `${st.activeTracks} act / ${st.outsideTracks} out`;

                const elClasses = document.getElementById('popup-stat-classes');
                if (elClasses) {
                    const p = st.phanLoaiNhan || {};
                    elClasses.textContent = `${p['vehicles'] || 0} / ${p['two-wheels'] || 0} / ${p['pedestrian'] || 0}`;
                }

                const elFramesBadge = document.getElementById('popup-frames-badge');
                if (elFramesBadge) {
                    elFramesBadge.textContent = `FRAME ${res.currentFrame || 0}/${st.tongFrames || 60}`;
                }

                // Render danh sách chi tiết Track IDs
                const ds = st.danhSach || {};
                const curTid = parseInt(document.getElementById('popup-track-id')?.value, 10);

                const renderPopupChips = (containerId, countId, list, cls) => {
                    const cEl = document.getElementById(containerId);
                    const cntEl = document.getElementById(countId);
                    if (cntEl) cntEl.textContent = (list || []).length;
                    if (!cEl) return;
                    if (!list || list.length === 0) {
                        cEl.innerHTML = '<span style="color:#64748b; font-size:9px;">Trống</span>';
                        return;
                    }
                    cEl.innerHTML = list.map(id => {
                        const act = (id === curTid) ? ' active-chip' : '';
                        return `<span class="hud-chip ${cls}${act}" data-id="${id}" title="Track #${id}">#${id}</span>`;
                    }).join('');
                };

                renderPopupChips('popup-chips-vehicles', 'popup-veh-count', ds.vehicles, 'vehicle');
                renderPopupChips('popup-chips-twowheels', 'popup-two-count', ds.twoWheels, 'twowheel');
                renderPopupChips('popup-chips-pedestrian', 'popup-ped-count', ds.pedestrian, 'pedestrian');
            }
        } catch (e) {}
    }

    // Khởi tạo đọc track và thống kê ban đầu
    const initRes = await sendToActiveTab('LAY_TRACK_HIEN_TAI');
    if (initRes && initRes.trackId) {
        document.getElementById('popup-track-id').value = initRes.trackId;
        if (initRes.dimensions) {
            document.getElementById('popup-dim-l').value = initRes.dimensions.l.toFixed(3);
            document.getElementById('popup-dim-w').value = initRes.dimensions.w.toFixed(3);
            document.getElementById('popup-dim-h').value = initRes.dimensions.h.toFixed(3);
        }
        setStatus(`🟢 Đã kết nối Job • Track #${initRes.trackId}`);
    } else {
        setStatus("🟢 Sẵn sàng thao tác");
    }

    
    // Bắt sự kiện click chip trên popup để chọn track
    document.getElementById('popup-stats-card')?.addEventListener('click', async (e) => {
        const chip = e.target.closest('.hud-chip');
        if (!chip) return;
        const tid = parseInt(chip.getAttribute('data-id'), 10);
        if (!tid) return;

        document.getElementById('popup-track-id').value = tid;
        document.querySelectorAll('#popup-stats-card .hud-chip').forEach(c => c.classList.remove('active-chip'));
        chip.classList.add('active-chip');

        setStatus(`Đang đọc Track #${tid}...`);
        const res = await sendToActiveTab('LAY_TRACK_HIEN_TAI');
        // Kích hoạt đọc từ content script
        if (document.getElementById('popup-btn-get-track')) {
            document.getElementById('popup-btn-get-track').click();
        }
    });

    await capNhatThongKePopup();
});
