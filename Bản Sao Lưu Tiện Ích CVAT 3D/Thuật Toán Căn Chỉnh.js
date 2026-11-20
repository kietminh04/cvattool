/**
 * Thuật Toán Căn Chỉnh CVAT 3D v2.6.3 (Geometry & Optimization Engine)
 * Đồng bộ 100% thuật toán v2.0 chuẩn bản Desktop EXE:
 * 1. Khóa kích thước Prior xe ô tô, xe máy, người đi bộ
 * 2. Khử lật góc 180° (Circular Median & Unwrapping)
 * 3. Khớp mặt đường Z (Bảo tồn dốc tự nhiên & đáy tiếp xúc Z_bottom)
 * 4. Làm mượt quỹ đạo tâm (XY Trajectory Smoothing)
 * 5. Căn chỉnh toàn diện toàn Job & Từng Track độc lập
 * 6. Quét Outside thông minh & Tự chữa lành Outside
 * 7. Tách Track khi Outside kéo dài (Split Track on Gap)
 * 8. Soi trùng lặp & Loại bỏ hộp đè nhau
 * 9. Đồng bộ kích thước Track đơn / Nhóm Track
 * 10. Thống kê chi tiết chuẩn EXE
 */

const QC_NGUONG = {
    vehicles: { minL: 3.2, maxL: 5.5, minW: 1.6, maxW: 2.2, minH: 1.45, maxH: 1.9 },
    pedestrian: { minL: 0.65, maxL: 1.0, minW: 0.65, maxW: 1.0, minH: 1.2, maxH: 1.9 },
    'two-wheels': { minL: 1.5, maxL: 2.0, minW: 0.6, maxW: 0.9, minH: 1.45, maxH: 1.8 }
};

const hoSo = (p, mode = 'clamp', large = false, small = false) => ({
    prior: p.slice(0, 3),
    limits: { minL: p[3], maxL: p[4], minW: p[5], maxW: p[6], minH: p[7], maxH: p[8] },
    mode, isLargeVehicle: large, isSmallSpecial: small
});

const HO_SO_XE = {
    car:         hoSo([4.35, 1.85, 1.58, 3.20, 5.50, 1.60, 2.20, 1.45, 1.85]),
    pickup:      hoSo([5.30, 1.88, 1.82, 4.80, 6.00, 1.70, 2.10, 1.60, 2.05]),
    van:         hoSo([5.40, 1.90, 2.20, 3.30, 7.00, 1.40, 2.25, 1.75, 2.85], 'clamp', true),
    truck:       hoSo([6.50, 2.10, 2.60, 3.20, 14.0, 1.35, 2.70, 1.70, 4.20], 'clamp', true),
    bus:         hoSo([10.5, 2.50, 3.30, 5.00, 14.0, 1.80, 2.70, 2.20, 4.10], 'clamp', true),
    contruction: hoSo([6.00, 2.50, 3.00, 2.00, 13.0, 1.20, 3.50, 1.60, 4.40], 'clamp', true),
    trailer:     hoSo([13.0, 2.50, 4.00, 2.00, 16.0, 1.20, 2.70, 0.80, 4.40], 'clamp', true),
    tricycle:    hoSo([3.00, 1.25, 1.55, 1.80, 4.50, 0.80, 1.80, 1.00, 2.20], 'clamp', false, true),
    stroller:    hoSo([0.85, 0.60, 1.05, 0.55, 1.25, 0.40, 0.85, 0.70, 1.25], 'clamp', false, true),
    wheelchair:  hoSo([1.05, 0.68, 1.30, 0.75, 1.50, 0.55, 0.90, 0.90, 1.55], 'clamp', false, true),
    other:       hoSo([4.35, 1.85, 1.58, 0.50, 14.0, 0.40, 3.50, 0.50, 4.20])
};

const HO_SO_XE_LON_CU = hoSo([6.50, 2.10, 2.60, 4.50, 14.0, 1.80, 2.70, 1.80, 4.20], 'clamp', true);

const HO_SO_HAI_BANH = {
    motorcycle:           hoSo([1.95, 0.80, 1.55, 1.50, 2.30, 0.60, 1.00, 1.40, 1.80], 'snap'),
    bicycle:              hoSo([1.75, 0.65, 1.50, 1.20, 2.00, 0.50, 0.90, 1.30, 1.80], 'snap'),
    motorcycleKhongNguoi: hoSo([1.92, 0.72, 1.12, 1.50, 2.30, 0.60, 1.00, 0.90, 1.40], 'snap'),
    bicycleKhongNguoi:    hoSo([1.70, 0.55, 1.05, 1.20, 2.00, 0.40, 0.90, 0.70, 1.30], 'snap')
};

const HO_SO_NGUOI = {
    'adult|standing': hoSo([0.65, 0.65, 1.70, 0.65, 1.00, 0.65, 1.00, 1.40, 1.90], 'snap'),
    'adult|sitting':  hoSo([0.80, 0.65, 1.25, 0.65, 1.10, 0.65, 1.00, 0.95, 1.45], 'snap'),
    'adult|bending':  hoSo([0.95, 0.65, 1.25, 0.70, 1.25, 0.65, 1.00, 0.95, 1.55], 'snap'),
    'child|standing': hoSo([0.65, 0.65, 1.20, 0.65, 0.80, 0.65, 0.80, 0.75, 1.55], 'snap'),
    'child|sitting':  hoSo([0.65, 0.65, 0.85, 0.65, 0.85, 0.65, 0.80, 0.50, 1.10], 'snap'),
    'child|bending':  hoSo([0.70, 0.65, 0.80, 0.65, 0.95, 0.65, 0.80, 0.50, 1.15], 'snap')
};

const GIA_TRI_THUOC_TINH = {
    vehicles: { type: { car: 'car', truck: 'truck', bus: 'bus', van: 'van', pickup: 'pickup',
        contruction: 'contruction', construction: 'contruction', trailer: 'trailer',
        tricycle: 'tricycle', stroller: 'stroller', wheelchair: 'wheelchair', other: 'other' } },
    'two-wheels': { type: { motorcycle: 'motorcycle', bicycle: 'bicycle' },
        ride: { true: 'true', false: 'false' } },
    pedestrian: { age: { adult: 'adult', child: 'child' },
        pose: { standing: 'standing', walking: 'standing', sitting: 'sitting', bending: 'bending' } }
};

class ThuatToanCanChinh {

    // =========================================================================
    // HỆ THỐNG KÍCH THƯỚC ĐỒNG BỘ THEO THUỘC TÍNH (ATTRIBUTE-DRIVEN DIMENSIONS)
    // =========================================================================

    static _lopNhan(labelName, track) {
        const s = String(labelName || '').toLowerCase();
        const id = track && track.label_id;
        if (s.includes('two-wheel') || s.includes('moto') || s === '12873' || s === '8661580' || id === 12873 || id === 8661580) return 'two-wheels';
        if (s.includes('pedestrian') || s === '12872' || s === '8661579' || id === 12872 || id === 8661579) return 'pedestrian';
        return 'vehicles';
    }

    static _gomGiaTri(lop, danhSach, kq) {
        if (!Array.isArray(danhSach)) return;
        for (const a of danhSach) {
            if (!a || a.value === undefined || a.value === null) continue;
            const v = String(a.value).trim().toLowerCase();
            for (const t of Object.keys(lop)) {
                if (Object.prototype.hasOwnProperty.call(lop[t], v)) (kq[t] = kq[t] || []).push(lop[t][v]);
            }
        }
    }

    static _giaTriPhoBien(mang) {
        const dem = {};
        let tot = null;
        for (const v of mang) {
            dem[v] = (dem[v] || 0) + 1;
            if (tot === null || dem[v] > dem[tot]) tot = v;
        }
        return tot;
    }

    static _docThuocTinhTrack(track, currentShape, lop) {
        const capTrack = {}, capShape = {}, capHienTai = {};
        this._gomGiaTri(lop, track && track.attributes, capTrack);
        const hoatDong = ((track && track.shapes) || []).filter(s => !s.outside);
        for (const s of hoatDong) this._gomGiaTri(lop, s.attributes, capShape);
        if (currentShape) this._gomGiaTri(lop, currentShape.attributes, capHienTai);

        const kq = {};
        for (const t of Object.keys(lop)) {
            const nguon = capTrack[t] || capShape[t] || capHienTai[t];
            kq[t] = nguon ? this._giaTriPhoBien(nguon) : null;
        }
        if (lop.pose && !capTrack.pose && capShape.pose) {
            const nguong = Math.max(1, 0.1 * hoatDong.length);
            const dem = {};
            for (const p of capShape.pose) dem[p] = (dem[p] || 0) + 1;
            kq.pose = ['standing', 'bending', 'sitting'].find(p => (dem[p] || 0) >= nguong) || kq.pose;
        }
        return kq;
    }

    static _trungViKichThuoc(track) {
        const act = ((track && track.shapes) || []).filter(s => !s.outside && s.points && s.points.length >= 9);
        const tv = i => {
            const a = act.map(s => s.points[i]).filter(v => !isNaN(v) && v > 0).sort((x, y) => x - y);
            return a.length ? a[Math.floor(a.length / 2)] : null;
        };
        return { L: tv(6), W: tv(7), H: tv(8) };
    }

    static layKichThuocChuanTheoThuocTinh(track, currentShape = null, labelName = null) {
        const lop = this._lopNhan(labelName, track);
        const tt = this._docThuocTinhTrack(track, currentShape, GIA_TRI_THUOC_TINH[lop]);
        const m = this._trungViKichThuoc(track);
        let hs, attributeType, nguonThuocTinh = 'attribute', xungDotThuocTinh = false;

        if (lop === 'pedestrian') {
            const age = tt.age || 'adult', pose = tt.pose || 'standing';
            hs = HO_SO_NGUOI[`${age}|${pose}`] || HO_SO_NGUOI['adult|standing'];
            attributeType = `${age}|${pose}`;
            if (!tt.age && !tt.pose) nguonThuocTinh = 'fallback';
        } else if (lop === 'two-wheels') {
            let loai = tt.type;
            if (!loai) {
                loai = (m.L !== null && m.W !== null && m.L <= 1.80 && m.W <= 0.70) ? 'bicycle' : 'motorcycle';
                nguonThuocTinh = 'fallback';
            }
            const khongNguoi = tt.ride === 'false' && m.H !== null && m.H < 1.35;
            hs = HO_SO_HAI_BANH[khongNguoi ? `${loai}KhongNguoi` : loai];
            attributeType = khongNguoi ? `${loai}|khong-nguoi` : loai;
        } else {
            const vuotXeConTheoChieuDai = (m.L !== null && m.L > 5.65);
            if (!tt.type) {
                hs = vuotXeConTheoChieuDai ? HO_SO_XE_LON_CU : HO_SO_XE.car;
                attributeType = vuotXeConTheoChieuDai ? 'legacy-large' : 'car';
                nguonThuocTinh = 'fallback';
            } else if (tt.type === 'car' && vuotXeConTheoChieuDai) {
                hs = HO_SO_XE_LON_CU;
                attributeType = 'car';
                xungDotThuocTinh = true;
            } else {
                hs = HO_SO_XE[tt.type] || HO_SO_XE.car;
                attributeType = tt.type;
            }
        }
        return {
            prior: hs.prior.slice(), limits: { ...hs.limits },
            isLargeVehicle: hs.isLargeVehicle, isSmallSpecial: hs.isSmallSpecial, attributeType,
            sizeMode: hs.mode, nguonThuocTinh, xungDotThuocTinh, qc: QC_NGUONG[lop]
        };
    }

    static chotKichThuocTrack(track, cfg, khoa = {}) {
        const m = this._trungViKichThuoc(track);
        const { limits: g, prior: p, qc: q } = cfg;
        const chon = (soDo, p0, min, max, kv) => {
            if (kv !== undefined && kv !== null) return kv;
            if (cfg.sizeMode === 'snap' || soDo === null) return p0;
            return Math.max(min, Math.min(max, soDo));
        };
        const L = +chon(m.L, p[0], g.minL, g.maxL, khoa.L).toFixed(3);
        const W = +chon(m.W, p[1], g.minW, g.maxW, khoa.W).toFixed(3);
        const H = +chon(m.H, p[2], g.minH, g.maxH, khoa.H).toFixed(3);
        const canGhiIssuesLog = L < q.minL || L > q.maxL || W < q.minW || W > q.maxW || H < q.minH || H > q.maxH;
        return { L, W, H, canGhiIssuesLog };
    }

    /**
     * Trả về UI Track ID hiển thị trên CVAT (_displayId -> _trackNumber -> _clientID -> idx + 1).
     * Tuyệt đối không rơi về database primary key (tr.id).
     */
    static layIdHienThi(tr, idx = 0) {
        if (tr) {
            const cands = [tr._displayId, tr._trackNumber, tr._clientID];
            for (let i = 0; i < cands.length; i++) {
                const v = cands[i];
                if (v !== undefined && v !== null && v !== '') {
                    const n = Number(v);
                    if (Number.isFinite(n) && n > 0) return n;
                }
            }
        }
        return (Number.isInteger(idx) && idx >= 0) ? (idx + 1) : 1;
    }

    /**
     * Chuẩn hóa 3 lớp định danh track trước khi chạy kiểm định QC (idempotent):
     * - _qcKey: khóa nội bộ duy nhất theo vị trí ("k" + idx)
     * - _serverId: bản chụp tr.id (chỉ dùng log/debug)
     * - _displayId: UI Track ID khớp CVAT
     */
    static chuanHoaDinhDanhTrack(annotations) {
        if (!annotations || !Array.isArray(annotations.tracks)) {
            return { soTrack: 0, soFallback: 0, trungId: [] };
        }
        const tracks = annotations.tracks;
        let soFallback = 0;
        const seen = new Map();
        const trungSet = new Set();

        for (let idx = 0; idx < tracks.length; idx++) {
            const tr = tracks[idx];
            if (!tr) continue;
            tr._qcKey = `k${idx}`;
            if (tr._serverId === undefined && tr.id !== undefined) {
                tr._serverId = tr.id;
            }
            const rawCands = [tr._displayId, tr._trackNumber, tr._clientID];
            const coNguon = rawCands.some(v => v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0);
            if (!coNguon) soFallback++;

            const dispId = this.layIdHienThi(tr, idx);
            tr._displayId = dispId;

            if (seen.has(dispId)) {
                trungSet.add(dispId);
            } else {
                seen.set(dispId, tr._qcKey);
            }
        }

        const trungId = [...trungSet];
        if (trungId.length > 0 && typeof console !== 'undefined' && console.warn) {
            console.warn('[QC] Phát hiện trùng UI ID giữa các track:', trungId);
        }
        return { soTrack: tracks.length, soFallback, trungId };
    }

    /**
     * Tra cứu track an toàn cho QC Tool: ưu tiên _qcKey, fallback sang UI ID (không bao giờ so t.id).
     */
    static timTrackQC(annotations, ref = {}) {
        if (!annotations || !Array.isArray(annotations.tracks) || !ref) return null;
        const tracks = annotations.tracks;
        if (ref.trackKey !== undefined && ref.trackKey !== null && ref.trackKey !== '') {
            const byKey = tracks.find(t => t && t._qcKey === ref.trackKey);
            if (byKey) return byKey;
        }
        if (ref.trackId !== undefined && ref.trackId !== null && ref.trackId !== '') {
            const target = Number(ref.trackId);
            if (Number.isFinite(target) && target > 0) {
                for (let idx = 0; idx < tracks.length; idx++) {
                    const t = tracks[idx];
                    if (t && this.layIdHienThi(t, idx) === target) return t;
                }
            }
        }
        return null;
    }

    /**
     * Tìm track theo ID (Hỗ trợ ID số thực tế hoặc Index 1-based)
     */
    /**
     * Tìm kiếm Track chính xác với cơ chế đồng bộ đa lớp (Multi-Strategy Sync):
     * 1. Khớp _trackNumber hoặc _clientID đã gán khi load
     * 2. Khớp qua CVAT Core Collection mapping (serverID <-> clientID)
     * 3. Khớp theo database id (tr.id === targetId)
     * 4. Khớp theo thứ tự 1-based index (idx + 1 === targetId)
     */
    static timTrack(annotations, trackId) {
        if (!annotations || !annotations.tracks) return null;
        const targetId = parseInt(trackId, 10);
        if (isNaN(targetId)) return null;

        // 1. Thử khớp theo _displayId, _trackNumber hoặc _clientID
        let found = annotations.tracks.find(tr => tr._displayId === targetId || tr._trackNumber === targetId || tr._clientID === targetId);
        if (found) return found;

        // 2. Thử khớp qua CVAT Core Collection mapping nếu có
        try {
            const job = (typeof window !== 'undefined' && window.quanLyAPICVAT) ? window.quanLyAPICVAT.getJobInstance() : null;
            if (job && job.annotations) {
                const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
                if (coll) {
                    const cTracks = coll.tracks || coll._tracks || [];
                    const list = Array.isArray(cTracks) ? cTracks : Object.values(cTracks);
                    const matchedClient = list.find(ct => ct && (ct.clientID === targetId || ct.serverID === targetId));
                    if (matchedClient) {
                        const sid = matchedClient.serverID;
                        if (sid !== undefined && sid !== null) {
                            found = annotations.tracks.find(tr => tr.id === sid);
                            if (found) return found;
                        }
                    }
                }
            }
        } catch (e) {}

        // 3. Thử khớp theo database id của track
        found = annotations.tracks.find(tr => tr.id === targetId);
        if (found) return found;

        // 4. Thử khớp theo 1-based index (thứ tự hiển thị 1..N)
        if (targetId >= 1 && targetId <= annotations.tracks.length) {
            return annotations.tracks[targetId - 1];
        }

        return null;
    }

    /**
     * Lấy shape của track tại frame cụ thể
     */
    static timShapeTrongFrame(track, frame) {
        if (!track || !track.shapes) return null;
        return track.shapes.find(s => s.frame === frame);
    }

    /**
     * Chuẩn hóa góc quay về khoảng [-pi, pi] an toàn tuyệt đối bằng atan2(sin, cos)
     */
    static wrapToPi(angle) {
        return Math.atan2(Math.sin(angle), Math.cos(angle));
    }

    /**
     * TÍNH PERCENTILE CHUẨN NUMPY
     */
    static median(arr) {
        if (!arr || arr.length === 0) return 0;
        return this.percentile(arr, 50);
    }

    static percentile(arr, p) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = (p / 100.0) * (sorted.length - 1);
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const weight = index - lower;
        return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }

    /**
     * MA TRẬN XOAY EULER THEO THỨ TỰ XYZ CHUẨN SCIPY
     */
    static eulerXYZToMatrix(rx, ry, rz) {
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);

        return [
            [cy * cz, -cy * sz, sy],
            [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
            [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy]
        ];
    }

    /**
     * NHÂN VECTOR HÀNG VỚI MA TRẬN 3x3: v @ M
     */
    static vectorMatMul(v, M) {
        return [
            v[0] * M[0][0] + v[1] * M[1][0] + v[2] * M[2][0],
            v[0] * M[0][1] + v[1] * M[1][1] + v[2] * M[2][1],
            v[0] * M[0][2] + v[1] * M[1][2] + v[2] * M[2][2]
        ];
    }

    /**
     * NHÂN MA TRẬN 3x3 VỚI VECTOR CỘT: M @ v
     */
    static matVecMul(M, v) {
        return [
            M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
            M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
            M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
        ];
    }

    /**
     * NHÂN HAI MA TRẬN 3x3: A @ B
     */
    static matMul3x3(A, B) {
        const C = [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0]
        ];
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
            }
        }
        return C;
    }

    /**
     * TRÍCH XUẤT GÓC EULER THEO THỨ TỰ XYZ TỪ MA TRẬN XOAY R = Rx * Ry * Rz
     */
    static matrixToEulerXYZ(R) {
        const sy = Math.max(-1.0, Math.min(1.0, R[0][2]));
        const ry = Math.asin(sy);
        const cosRy = Math.cos(ry);
        let rx = 0, rz = 0;
        if (Math.abs(cosRy) > 1e-6) {
            rx = Math.atan2(-R[1][2], R[2][2]);
            rz = Math.atan2(-R[0][1], R[0][0]);
        } else {
            rx = Math.atan2(R[2][1], R[1][1]);
            rz = 0.0;
        }
        return [rx, ry, rz];
    }

    /**
     * XOAY HỘP THEO HỆ TỌA ĐỘ CỤC BỘ CỦA XE (LOCAL ROTATION)
     */
    static xoayGocCucBo(rx, ry, rz, viewType, angle) {
        const R_init = this.eulerXYZToMatrix(rx || 0, ry || 0, rz || 0);
        let R_delta = null;
        if (viewType === 'top') {
            const cz = Math.cos(angle), sz = Math.sin(angle);
            R_delta = [
                [cz, -sz, 0],
                [sz, cz, 0],
                [0, 0, 1]
            ];
        } else if (viewType === 'side') {
            const cy = Math.cos(-angle), sy = Math.sin(-angle);
            R_delta = [
                [cy, 0, sy],
                [0, 1, 0],
                [-sy, 0, cy]
            ];
        } else if (viewType === 'front') {
            const cx = Math.cos(angle), sx = Math.sin(angle);
            R_delta = [
                [1, 0, 0],
                [0, cx, -sx],
                [0, sx, cx]
            ];
        } else {
            return [rx || 0, ry || 0, rz || 0];
        }
        const R_new = this.matMul3x3(R_init, R_delta);
        return this.matrixToEulerXYZ(R_new);
    }

    /**
     * ĐO CHIỀU CAO LIÊN TỤC TỪ ĐÁY HỘP LÊN NÓC XE (CONTINUOUS ROOF CLIMBING V2.7.7)
     * - Quét từng lát cắt 3.5cm từ mặt đất đi lên.
     * - Vượt qua vùng kính cửa sổ (cho phép khoảng thưa 0.32m dưới độ cao 1.32m).
     * - Ngay khi lên tới vùng nóc (>= 1.32m), hễ gặp khoảng trống không khí liên tục >= maxGap (0.18m)
     *   thì DỪNG LẠI NGAY LẬP TỨC, chặn tuyệt đối 100% tán cây, dây điện, biển báo lơ lửng phía trên!
     */
    static doChieuCaoLeoTangNocXe(carW, wRoad, binStep = 0.035, maxGap = 0.18, maxCeiling = 1.98, minValidH = 1.36) {
        if (!carW || carW.length < 6) return null;

        const ptsAboveGround = carW.filter(w => w >= wRoad + 0.14 && w <= wRoad + maxCeiling);
        if (ptsAboveGround.length < 5) return null;

        ptsAboveGround.sort((a, b) => a - b);

        const minW = wRoad + 0.14;
        const maxW = wRoad + maxCeiling;
        const numBins = Math.max(2, Math.ceil((maxW - minW) / binStep));
        const counts = new Array(numBins).fill(0);

        for (let i = 0; i < ptsAboveGround.length; i++) {
            const idx = Math.floor((ptsAboveGround[i] - minW) / binStep);
            if (idx >= 0 && idx < numBins) counts[idx]++;
        }

        let lastOccupiedW = minW;
        let gap = 0.0;
        let foundAny = false;

        for (let b = 0; b < numBins; b++) {
            const curH = (minW + (b + 1) * binStep) - wRoad;
            const hasSupport = (counts[b] >= 2) || (counts[b] === 1 && ((counts[b - 1] || 0) >= 2 || (counts[b + 1] || 0) >= 2));
            if (hasSupport) {
                lastOccupiedW = minW + (b + 1) * binStep;
                gap = 0.0;
                foundAny = true;
            } else {
                gap += binStep;
                // Dưới 1.32m (vùng kính cửa sổ xe, tia LiDAR có thể xuyên qua kính): cho phép khoảng thưa tới 0.32m.
                // Từ 1.32m trở lên (vùng nóc xe): gặp khoảng trống không khí >= maxGap (18cm) là ĐÃ QUA KHỎI NÓC XE -> DỪNG NGAY!
                const allowedGap = (curH < 1.32) ? Math.max(maxGap, 0.32) : maxGap;
                if (foundAny && gap >= allowedGap) {
                    break;
                }
            }
        }

        if (!foundAny) return null;

        // Chiều cao đo được từ mặt đất lên đỉnh nóc xe + 1.5cm đệm ôm sát vỏ nóc
        const hMeas = (lastOccupiedW - wRoad); // Bỏ đệm nóc vỏ xe theo chỉ đạo Kiệt
        return (hMeas >= minValidH && hMeas <= maxCeiling + 0.03) ? parseFloat(hMeas.toFixed(3)) : null;
    }

    static tinhCellSizeThichUng(dSensor) {
        return Math.max(0.05, Math.min(0.15, 0.045 + 0.0032 * Math.max(1.0, dSensor)));
    }

    /**
     * LÀM MƯỢT CHUỖI DỊCH CHUYỂN KÈM NỘI SUY TUYẾN TÍNH
     */
    static lamMuotChuoiDichChuyen(arr, validMask, window = 5) {
        const n = arr.length;
        const validIdx = [];
        for (let i = 0; i < n; i++) {
            if (validMask[i]) validIdx.push(i);
        }
        if (validIdx.length === 0) return new Array(n).fill(0.0);
        if (validIdx.length === 1) return new Array(n).fill(arr[validIdx[0]]);

        const interpVals = new Array(n);
        for (let i = 0; i < n; i++) {
            if (i <= validIdx[0]) {
                interpVals[i] = arr[validIdx[0]];
            } else if (i >= validIdx[validIdx.length - 1]) {
                interpVals[i] = arr[validIdx[validIdx.length - 1]];
            } else {
                let k = 0;
                while (k < validIdx.length - 1 && validIdx[k + 1] < i) k++;
                const x0 = validIdx[k], x1 = validIdx[k + 1];
                const y0 = arr[x0], y1 = arr[x1];
                const t = (i - x0) / (x1 - x0);
                interpVals[i] = y0 + t * (y1 - y0);
            }
        }

        const half = Math.floor(window / 2);
        const res = new Array(n);
        for (let i = 0; i < n; i++) {
            const s = Math.max(0, i - half);
            const e = Math.min(n, i + half + 1);
            const wSlice = interpVals.slice(s, e).sort((a, b) => a - b);
            res[i] = wSlice[Math.floor(wSlice.length / 2)];
        }
        return res;
    }

    /**
     * THUẬT TOÁN KIỆT - LỚP NHIỀU ĐIỂM THẮNG (BUMPER & FLANK DOMINANCE) KÈM VECTOR RAY TRACING
     */
    static phanTichLopThanXeChinh(ptsRel, L, W, sx, sy, dSensor, pad = 0.05, isFirstPass = false, scanScale = 1.0, opts = null) {
        const n = ptsRel ? ptsRel.length : 0;
        if (n === 0) {
            return { ex0: 0, ex1: 0, ey0: 0, ey1: 0, bestRearX: null, bestFrontX: null, bestFlankY: null };
        }
        if (n < 6) {
            let minX = ptsRel[0][0], maxX = ptsRel[0][0];
            let minY = ptsRel[0][1], maxY = ptsRel[0][1];
            for (let i = 1; i < n; i++) {
                if (ptsRel[i][0] < minX) minX = ptsRel[i][0];
                if (ptsRel[i][0] > maxX) maxX = ptsRel[i][0];
                if (ptsRel[i][1] < minY) minY = ptsRel[i][1];
                if (ptsRel[i][1] > maxY) maxY = ptsRel[i][1];
            }
            return { ex0: minX, ex1: maxX, ey0: minY, ey1: maxY, bestRearX: null, bestFrontX: null, bestFlankY: null };
        }

        const allX = new Array(n);
        const allY = new Array(n);
        const allZ = new Array(n);
        let minX = ptsRel[0][0], maxX = ptsRel[0][0];
        let minY = ptsRel[0][1], maxY = ptsRel[0][1];
        let minZ = ptsRel[0][2], maxZ = ptsRel[0][2];

        for (let i = 0; i < n; i++) {
            const [x, y, z] = ptsRel[i];
            allX[i] = x; allY[i] = y; allZ[i] = z;
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
            if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
        }

        const cellSize = this.tinhCellSizeThichUng(dSensor);
        const normDist = Math.max(1.0, dSensor);
        const normSx = normDist > 1.0 ? sx / normDist : sx;
        const normSy = normDist > 1.0 ? sy / normDist : sy;

        const binStep = Math.max(0.04, Math.min(0.10, 0.04 + 0.0016 * normDist));

        // 1. Phân tích thành xe (Trục Y) - Quét từ ngoài vào trong có hỗ trợ không gian (tránh lẹm hốc bánh/cửa cong)
        const binY = Math.max(0.03, Math.min(0.05, binStep * 0.75));
        const numBinsY = Math.max(1, Math.floor((maxY - minY + 3 * binY) / binY));
        const countsY = new Array(numBinsY).fill(0);
        for (let i = 0; i < n; i++) {
            const idx = Math.floor((allY[i] - (minY - binY)) / binY);
            if (idx >= 0 && idx < numBinsY) countsY[idx]++;
        }

        const isTightMode = (parseFloat(scanScale) || 1.0) < 1.3;
        const flankBoundLim = W / 2.0 + 0.22; // Cho phép đón phần hốc bánh/cửa dưới phình rộng nhưng vẫn chặn xe làn bên
        const minFlankPts = Math.max(5, Math.min(18, Math.floor(n * 0.005)));
        const minFlankSpanX = Math.min(0.65, 0.20 * L);
        const minFlankOccZ = dSensor > 28.0 ? 1 : 2;

        const hasClearFlank = Math.abs(normSy) > 0.20 || (Math.abs(normSy) > 0.07 && Math.abs(sy) >= 1.2);
        const sideSign = hasClearFlank ? (normSy > 0 ? 1 : -1) : 0;

        const flankCandidates = [];
        for (let i = 0; i < numBinsY; i++) {
            const cWin = countsY[i] + (sideSign > 0 ? (countsY[i - 1] || 0) : (countsY[i + 1] || 0));
            if (countsY[i] < 3 || cWin < minFlankPts) continue;
            const yC = (minY - binY) + (i + 0.5) * binY;
            const withinFlankBound = !isTightMode || (Math.abs(yC) <= flankBoundLim);
            const allowBin = withinFlankBound && (isFirstPass || (sideSign > 0 && yC > -0.2) || (sideSign < 0 && yC < 0.2) || (sideSign === 0));
            const vachCamY = opts && Array.isArray(opts.vachCamY) ? opts.vachCamY : null;
            const biCamY = vachCamY ? vachCamY.some(yc => Math.abs(yC - yc) <= 0.10) : false;
            if (!allowBin || biCamY) continue;

            const e0 = (minY - binY) + i * binY - 0.015;
            const e1 = e0 + binY + 0.03;
            let slMinX = 999, slMaxX = -999;
            const occX = new Set(), occZ = new Set();
            const slYVals = [];
            for (let j = 0; j < n; j++) {
                if (allY[j] >= e0 && allY[j] <= e1) {
                    slYVals.push(allY[j]);
                    if (allX[j] < slMinX) slMinX = allX[j];
                    if (allX[j] > slMaxX) slMaxX = allX[j];
                    occX.add(Math.floor(allX[j] / 0.12));
                    occZ.add(Math.floor(allZ[j] / 0.10));
                }
            }
            const spanX = slMaxX >= slMinX ? (slMaxX - slMinX) : 0.0;
            const scoreY = countsY[i] * Math.max(0.2, spanX);
            const isSpatiallySupported = (spanX >= minFlankSpanX && occX.size >= 3 && occZ.size >= minFlankOccZ);
            flankCandidates.push({ yC, count: countsY[i], cWin, spanX, scoreY, isSpatiallySupported, slYVals });
        }

        let bestFlankY = null;
        if (flankCandidates.length > 0) {
            // Ưu tiên chọn vách NGOÀI CÙNG đạt chuẩn hỗ trợ không gian VÀ có mật độ tối thiểu >= 12% đỉnh vách (chặn tuyệt đối gương chiếu hậu & nhiễu rìa)
            const maxFlankScore = Math.max(...flankCandidates.map(x => x.scoreY));
            const maxFlankCount = Math.max(...flankCandidates.map(x => x.count));
            const supported = flankCandidates.filter(c => c.isSpatiallySupported && (c.scoreY >= 0.12 * maxFlankScore || c.count >= 0.12 * maxFlankCount));
            const denseFallback = flankCandidates.filter(c => c.scoreY >= 0.35 * maxFlankScore);
            const chosenPool = supported.length > 0 ? supported : (denseFallback.length > 0 ? denseFallback : flankCandidates);

            const hasGapY = (yA, yB, pickCnt, innerCnt) => {
                const bA = Math.floor((Math.min(yA, yB) - (minY - binY)) / binY);
                const bB = Math.floor((Math.max(yA, yB) - (minY - binY)) / binY);
                if (bB - bA < 2) return false;
                const pickFrac = (pickCnt <= Math.floor(0.18 * innerCnt)) ? pickCnt : Math.floor(0.85 * pickCnt);
                const thresh = Math.max(2, Math.min(pickFrac, Math.floor(0.25 * innerCnt)));
                for (let b = bA + 1; b < bB; b++) {
                    if (b >= 0 && b < numBinsY && countsY[b] <= thresh) return true;
                }
                return false;
            };
            if (sideSign > 0) {
                chosenPool.sort((a, b) => b.yC - a.yC); // Phía +Y lớn nhất (ngoài cùng hướng LiDAR)
                let pick = chosenPool[0];
                // Chống ghosting sườn xe: chỉ bóc lớp ngoài khi có thung lũng mật độ ngăn cách và lớp ngoài yếu (< 45% maxFlankScore)
                for (let g = 0; g < 3; g++) {
                    if (pick.scoreY >= 0.45 * maxFlankScore) break;
                    const inner = chosenPool.find(c =>
                        c !== pick &&
                        (pick.yC - c.yC) >= 0.12 && (pick.yC - c.yC) <= 0.45 &&
                        c.scoreY >= 2.2 * pick.scoreY && c.count >= 2.0 * pick.count &&
                        hasGapY(pick.yC, c.yC, pick.count, c.count)
                    );
                    if (!inner) break;
                    pick = inner;
                }
                if (pick.slYVals && pick.slYVals.length >= 4) {
                    pick.slYVals.sort((a, b) => a - b);
                    bestFlankY = pick.slYVals[Math.floor(pick.slYVals.length * 0.85)];
                } else {
                    bestFlankY = pick.yC;
                }
            } else if (sideSign < 0) {
                chosenPool.sort((a, b) => a.yC - b.yC); // Phía -Y nhỏ nhất (ngoài cùng hướng LiDAR)
                let pick = chosenPool[0];
                for (let g = 0; g < 3; g++) {
                    if (pick.scoreY >= 0.45 * maxFlankScore) break;
                    const inner = chosenPool.find(c =>
                        c !== pick &&
                        (c.yC - pick.yC) >= 0.12 && (c.yC - pick.yC) <= 0.45 &&
                        c.scoreY >= 2.2 * pick.scoreY && c.count >= 2.0 * pick.count &&
                        hasGapY(pick.yC, c.yC, pick.count, c.count)
                    );
                    if (!inner) break;
                    pick = inner;
                }
                if (pick.slYVals && pick.slYVals.length >= 4) {
                    pick.slYVals.sort((a, b) => a - b);
                    bestFlankY = pick.slYVals[Math.floor(pick.slYVals.length * 0.15)];
                } else {
                    bestFlankY = pick.yC;
                }
            } else {
                chosenPool.sort((a, b) => b.scoreY - a.scoreY);
                bestFlankY = chosenPool[0].yC;
            }
        }

        // 2. Phân tích cản xe (Trục X) - Quét từ ngoài vào trong có hỗ trợ bề ngang & độ cao (không trượt lên kính hậu)
        const binX = Math.max(0.04, binStep);
        const numBinsX = Math.max(1, Math.floor((maxX - minX + 3 * binX) / binX));
        const countsX = new Array(numBinsX).fill(0);
        for (let i = 0; i < n; i++) {
            const idx = Math.floor((allX[i] - (minX - binX)) / binX);
            if (idx >= 0 && idx < numBinsX) countsX[idx]++;
        }

        const isFarOrLarge = (dSensor > 25.0 || L >= 6.0);
        const minBumperPts = isFarOrLarge ? Math.max(3, Math.min(12, Math.floor(n * 0.004))) : Math.max(5, Math.min(18, Math.floor(n * 0.004)));
        const minBumperCountX = isFarOrLarge ? 2 : 3;
        const minBumperSpanY = isFarOrLarge ? Math.min(0.45, 0.22 * W) : Math.min(0.75, 0.36 * W);
        const minBumperOccY = isFarOrLarge ? 2 : 3;
        const minBumperOccZ = dSensor > 28.0 ? 1 : 2;
        const bumperCandidates = [];

        for (let i = 0; i < numBinsX; i++) {
            const cWin = countsX[i] + (normSx < -0.15 ? (countsX[i + 1] || 0) : (countsX[i - 1] || 0));
            if (countsX[i] < minBumperCountX || cWin < minBumperPts) continue;
            const xC = (minX - binX) + (i + 0.5) * binX;
            const vachCamX = opts && Array.isArray(opts.vachCamX) ? opts.vachCamX : null;
            if (vachCamX && vachCamX.some(xc => Math.abs(xC - xc) <= 0.10)) continue;
            const e0 = (minX - binX) + i * binX - 0.02;
            const e1 = e0 + binX + 0.04;
            let slMinY = 999, slMaxY = -999;
            const slIndices = [];
            const occY = new Set(), occZ = new Set();
            const slXVals = [];
            for (let j = 0; j < n; j++) {
                if (allX[j] >= e0 && allX[j] <= e1) {
                    slIndices.push(j);
                    slXVals.push(allX[j]);
                    if (allY[j] < slMinY) slMinY = allY[j];
                    if (allY[j] > slMaxY) slMaxY = allY[j];
                    occY.add(Math.floor(allY[j] / 0.12));
                    occZ.add(Math.floor(allZ[j] / 0.10));
                }
            }
            const spanY = slMaxY >= slMinY ? (slMaxY - slMinY) : 0.0;
            const isSpatiallySupported = (spanY >= minBumperSpanY && occY.size >= minBumperOccY && occZ.size >= minBumperOccZ);
            if (isSpatiallySupported || spanY >= 0.25 * W || countsX[i] >= 12) {
                const occCells = new Set();
                for (const idxPt of slIndices) {
                    const gy = Math.floor((allY[idxPt] - slMinY) / cellSize);
                    const gz = Math.floor((allZ[idxPt] - minZ) / cellSize);
                    occCells.add(`${gy}_${gz}`);
                }
                const scoreX = countsX[i] * occCells.size * Math.max(0.2, spanY);
                bumperCandidates.push({ scoreX, count: countsX[i], spanY, xC, isSpatiallySupported, slXVals });
            }
        }

        let bestRearX = null;
        let bestFrontX = null;

        if (bumperCandidates.length > 0) {
            const maxBumperCount = Math.max(...bumperCandidates.map(c => c.count));
            const maxBumperScore = Math.max(...bumperCandidates.map(c => c.scoreX));
            const supportedX = bumperCandidates.filter(b => (b.isSpatiallySupported || (b.count >= 15 && b.spanY >= 0.35)) && (b.count >= 0.05 * maxBumperCount || b.scoreX >= 0.03 * maxBumperScore));
            const fallbackX = bumperCandidates.filter(b => b.scoreX >= 0.08 * maxBumperScore);
            const poolX = supportedX.length > 0 ? supportedX : (fallbackX.length > 0 ? fallbackX : bumperCandidates);

            const hasGapX = (xA, xB, pickCnt, innerCnt) => {
                const bA = Math.floor((Math.min(xA, xB) - (minX - binX)) / binX);
                const bB = Math.floor((Math.max(xA, xB) - (minX - binX)) / binX);
                if (bB - bA < 2) return false;
                const pickFrac = (pickCnt <= Math.floor(0.18 * innerCnt)) ? pickCnt : Math.floor(0.85 * pickCnt);
                const thresh = Math.max(2, Math.min(pickFrac, Math.floor(0.25 * innerCnt)));
                for (let b = bA + 1; b < bB; b++) {
                    if (b >= 0 && b < numBinsX && countsX[b] <= thresh) return true;
                }
                return false;
            };
            if (normSx < -0.15) {
                poolX.sort((a, b) => a.xC - b.xC); // Ngoài cùng phía đuôi (-X nhỏ nhất)
                let pick = poolX[0];
                // Chống ghosting cản sau: bóc lớp ngoài yếu khi có thung lũng mật độ ngăn cách HOẶC lớp ngoài quá mỏng (<12% maxScore) trước cản thật dày gấp >=5 lần
                for (let g = 0; g < 3; g++) {
                    if (pick.scoreX >= 0.45 * maxBumperScore) break;
                    const inner = poolX.find(c => {
                        if (c === pick) return false;
                        const dist = c.xC - pick.xC;
                        if (dist < 0.10 || dist > 0.55) return false;
                        const isTinyOuterNoise = pick.scoreX < 0.12 * maxBumperScore && c.scoreX >= 5.0 * pick.scoreX && c.count >= 3.0 * pick.count;
                        if (isTinyOuterNoise) return true;
                        return dist >= 0.14 && c.scoreX >= 2.4 * pick.scoreX && c.count >= 2.2 * pick.count && hasGapX(pick.xC, c.xC, pick.count, c.count);
                    });
                    if (!inner) break;
                    pick = inner;
                }
                if (pick.slXVals && pick.slXVals.length >= 4) {
                    pick.slXVals.sort((a, b) => a - b);
                    bestRearX = pick.slXVals[Math.floor(pick.slXVals.length * 0.15)];
                } else {
                    bestRearX = pick.xC;
                }
            } else if (normSx > 0.15) {
                poolX.sort((a, b) => b.xC - a.xC); // Ngoài cùng phía đầu (+X lớn nhất)
                let pick = poolX[0];
                for (let g = 0; g < 3; g++) {
                    if (pick.scoreX >= 0.45 * maxBumperScore) break;
                    const inner = poolX.find(c => {
                        if (c === pick) return false;
                        const dist = pick.xC - c.xC;
                        if (dist < 0.10 || dist > 0.55) return false;
                        const isTinyOuterNoise = pick.scoreX < 0.12 * maxBumperScore && c.scoreX >= 5.0 * pick.scoreX && c.count >= 3.0 * pick.count;
                        if (isTinyOuterNoise) return true;
                        return dist >= 0.14 && c.scoreX >= 2.4 * pick.scoreX && c.count >= 2.2 * pick.count && hasGapX(pick.xC, c.xC, pick.count, c.count);
                    });
                    if (!inner) break;
                    pick = inner;
                }
                if (pick.slXVals && pick.slXVals.length >= 4) {
                    pick.slXVals.sort((a, b) => a - b);
                    bestFrontX = pick.slXVals[Math.floor(pick.slXVals.length * 0.85)];
                } else {
                    bestFrontX = pick.xC;
                }
            }
        }

        const clusterSpanX = maxX - minX;
        const clusterSpanY = maxY - minY;

        const maskMain = new Array(n).fill(true);
        if (bestRearX !== null) {
            for (let i = 0; i < n; i++) {
                if (allX[i] < bestRearX - 0.08 || (clusterSpanX > L + 0.15 && allX[i] > bestRearX + L + 0.15)) maskMain[i] = false;
            }
        } else if (bestFrontX !== null) {
            for (let i = 0; i < n; i++) {
                if (allX[i] > bestFrontX + 0.08 || (clusterSpanX > L + 0.15 && allX[i] < bestFrontX - L - 0.15)) maskMain[i] = false;
            }
        }

        if (sideSign !== 0 && bestFlankY !== null) {
            const emptyBinsNeed = Math.max(4, Math.ceil(0.25 / binY));
            const bFlank = Math.max(0, Math.min(numBinsY - 1, Math.floor((bestFlankY - (minY - binY)) / binY)));
            if (sideSign > 0) {
                let wallCutNeg = bestFlankY - W - 0.15;
                let zeroRun = 0, seenBody = false;
                for (let b = bFlank; b >= 0; b--) {
                    if (countsY[b] > 0) {
                        if (seenBody && zeroRun >= emptyBinsNeed) {
                            wallCutNeg = Math.max(wallCutNeg, (minY - binY) + (b + 1) * binY);
                            break;
                        }
                        seenBody = true;
                        zeroRun = 0;
                    } else if (seenBody) {
                        zeroRun++;
                    }
                }
                for (let i = 0; i < n; i++) {
                    if (allY[i] > bestFlankY + 0.08 || allY[i] < wallCutNeg) maskMain[i] = false;
                }
            } else {
                let wallCutPos = bestFlankY + W + 0.15;
                let zeroRun = 0, seenBody = false;
                for (let b = bFlank; b < numBinsY; b++) {
                    if (countsY[b] > 0) {
                        if (seenBody && zeroRun >= emptyBinsNeed) {
                            wallCutPos = Math.min(wallCutPos, (minY - binY) + b * binY);
                            break;
                        }
                        seenBody = true;
                        zeroRun = 0;
                    } else if (seenBody) {
                        zeroRun++;
                    }
                }
                for (let i = 0; i < n; i++) {
                    if (allY[i] < bestFlankY - 0.08 || allY[i] > wallCutPos) maskMain[i] = false;
                }
            }
        }

        let ex0 = 999, ex1 = -999, ey0 = 999, ey1 = -999;
        const mainXs = [], mainYs = [];
        for (let i = 0; i < n; i++) {
            if (maskMain[i]) {
                mainXs.push(allX[i]);
                mainYs.push(allY[i]);
                if (allX[i] < ex0) ex0 = allX[i];
                if (allX[i] > ex1) ex1 = allX[i];
                if (allY[i] < ey0) ey0 = allY[i];
                if (allY[i] > ey1) ey1 = allY[i];
            }
        }
        const countMain = mainXs.length;
        if (countMain >= 20) {
            mainXs.sort((a, b) => a - b);
            mainYs.sort((a, b) => a - b);
            ex0 = mainXs[Math.floor((countMain - 1) * 0.01)];
            ex1 = mainXs[Math.floor((countMain - 1) * 0.99)];
            ey0 = mainYs[Math.floor((countMain - 1) * 0.02)];
            ey1 = mainYs[Math.floor((countMain - 1) * 0.98)];
        } else if (countMain < 6) {
            ex0 = minX; ex1 = maxX; ey0 = minY; ey1 = maxY;
        }

        return { ex0, ex1, ey0, ey1, bestRearX, bestFrontX, bestFlankY };
    }


    /**
     * Tính Median Yaw theo chuẩn hình học lượng giác tròn (Circular Median)
     */
    static tinhMedianYaw(yaws) {
        if (!yaws || yaws.length === 0) return 0;
        const sins = yaws.map(y => Math.sin(y)).sort((a, b) => a - b);
        const coss = yaws.map(y => Math.cos(y)).sort((a, b) => a - b);
        const medSin = sins[Math.floor(sins.length / 2)];
        const medCos = coss[Math.floor(coss.length / 2)];
        return Math.atan2(medSin, medCos);
    }

    /**
     * Khóa kích thước Prior theo loại đối tượng (Vehicle Dimension Prior Snapping)
     * Ngăn chặn kích thước xe bị phình to hoặc trôi dạt bất hợp lý
     */
    static snapKichThuocPrior(labelName, origL, origW, origH) {
        const lbl = (labelName || '').toLowerCase();
        let L_star = origL;
        let W_star = origW;
        let H_star = origH;

        if (lbl.includes('pedestrian') || lbl === '12872' || lbl === '8661579') {
            L_star = 0.80;
            W_star = 0.80;
            H_star = 1.70;
        } else if (lbl.includes('two-wheels') || lbl.includes('moto') || lbl === '12873' || lbl === '8661580') {
            L_star = 1.90;
            W_star = 0.80;
            H_star = 1.45;
        } else if (lbl.includes('vehicle') || lbl.includes('car') || lbl === '12871' || lbl === '8661578' || origL > 2.2) {
            // Xe ô tô: Nếu xe nằm trong dải Sedan / Crossover phổ thông (3.8 - 4.8m) -> Khóa chuẩn 4.33m x 1.90m x 1.53m
            if (origL >= 3.8 && origL <= 4.8) {
                L_star = 4.33;
                W_star = 1.90;
                H_star = 1.53;
            } else {
                L_star = Math.max(3.65, Math.min(5.40, origL));
                W_star = Math.max(1.55, Math.min(2.15, origW));
                H_star = origH;
            }
        }

        return {
            L: parseFloat(L_star.toFixed(3)),
            W: parseFloat(W_star.toFixed(3)),
            H: parseFloat(H_star.toFixed(3))
        };
    }

    /**
     * THUẬT TOÁN 1: KHỬ LẬT GÓC 180° CHO 1 TRACK (YAW STABILIZATION)
     */
    /**
     * Khử giật góc Yaw cục bộ ở các frame bị che khuất 1 đầu (như Frame 30 bị lệch 2-3° so với F29, F31)
     */
    static _lamMuotYawNgoaiLai(activeShapes) {
        if (!activeShapes || activeShapes.length < 3) return 0;
        let fixed = 0;
        const origYaws = activeShapes.map(s => s.points[5] || 0);
        for (let i = 1; i < activeShapes.length - 1; i++) {
            const fPrev = Number(activeShapes[i - 1].frame);
            const fCurr = Number(activeShapes[i].frame);
            const fNext = Number(activeShapes[i + 1].frame);
            if (Math.abs(fCurr - fPrev) > 3 || Math.abs(fNext - fCurr) > 3) continue;

            const yPrev = origYaws[i - 1];
            const yCurr = origYaws[i];
            const yNext = origYaws[i + 1];
            const spanNeighbors = Math.abs(this.wrapToPi(yNext - yPrev));
            if (spanNeighbors <= 0.14) { // Hai frame kề cùng một hướng ổn định (<= 8 độ)
                const midYaw = this.wrapToPi(yPrev + 0.5 * this.wrapToPi(yNext - yPrev));
                const dev = this.wrapToPi(yCurr - midYaw);
                if (Math.abs(dev) > 0.015) { // Lệch quá ~0.86 độ so với láng giềng -> kẹp mượt về ±0.6 độ
                    const clamped = Math.max(-0.010, Math.min(0.010, dev));
                    activeShapes[i].points[5] = parseFloat(this.wrapToPi(midYaw + clamped).toFixed(3));
                    if (Array.isArray(activeShapes[i].rotation)) activeShapes[i].rotation[2] = activeShapes[i].points[5];
                    fixed++;
                }
            }
        }
        // Làm mượt 2 đầu biên (frame đầu và frame cuối) nếu cặp kề bên ổn định <= 3 độ mà biên nhảy > 2 độ
        const n = activeShapes.length;
        if (n >= 3) {
            if (Math.abs(Number(activeShapes[1].frame) - Number(activeShapes[0].frame)) <= 3 &&
                Math.abs(Number(activeShapes[2].frame) - Number(activeShapes[1].frame)) <= 3) {
                const y1 = activeShapes[1].points[5] || 0;
                const y2 = activeShapes[2].points[5] || 0;
                if (Math.abs(this.wrapToPi(y2 - y1)) <= 0.055) {
                    const dev0 = this.wrapToPi((activeShapes[0].points[5] || 0) - y1);
                    if (Math.abs(dev0) > 0.035 && Math.abs(dev0) <= 0.25) {
                        const clamped0 = Math.max(-0.015, Math.min(0.015, dev0));
                        activeShapes[0].points[5] = parseFloat(this.wrapToPi(y1 + clamped0).toFixed(3));
                        if (Array.isArray(activeShapes[0].rotation)) activeShapes[0].rotation[2] = activeShapes[0].points[5];
                        fixed++;
                    }
                }
            }
            if (Math.abs(Number(activeShapes[n - 1].frame) - Number(activeShapes[n - 2].frame)) <= 3 &&
                Math.abs(Number(activeShapes[n - 2].frame) - Number(activeShapes[n - 3].frame)) <= 3) {
                const yA = activeShapes[n - 2].points[5] || 0;
                const yB = activeShapes[n - 3].points[5] || 0;
                if (Math.abs(this.wrapToPi(yA - yB)) <= 0.055) {
                    const devLast = this.wrapToPi((activeShapes[n - 1].points[5] || 0) - yA);
                    if (Math.abs(devLast) > 0.035 && Math.abs(devLast) <= 0.25) {
                        const clampedL = Math.max(-0.015, Math.min(0.015, devLast));
                        activeShapes[n - 1].points[5] = parseFloat(this.wrapToPi(yA + clampedL).toFixed(3));
                        if (Array.isArray(activeShapes[n - 1].rotation)) activeShapes[n - 1].rotation[2] = activeShapes[n - 1].points[5];
                        fixed++;
                    }
                }
            }
        }
        return fixed;
    }

    /**
     * CHỌN GÓC YAW GẦN PRELABEL NHẤT (CHỐNG LẬT 180° VÀ QUAY NGANG 90°)
     * Do tính đối xứng của thân xe hình chữ nhật, thuật toán quét góc có 4 nghiệm khả dĩ:
     * candidate = rawYaw + k * (PI / 2) với k in [-1, 0, 1, 2].
     * Chọn candidate có |wrapToPi(candidate - origYaw)| nhỏ nhất.
     * Nếu độ lệch nhỏ nhất <= maxDevRad (~38° = 0.663 rad, tối đa PI/2), chấp nhận điều chỉnh.
     * Ngược lại nếu lệch quá lớn (> maxDevRad hoặc > PI/2), giữ nguyên origYaw ban đầu của prelabel!
     */
    static tinhGocYawGanPrelabelNhat(rawYaw, origYaw, maxDevRad = 0.663) {
        if (!Number.isFinite(origYaw)) return rawYaw;
        if (!Number.isFinite(rawYaw)) return origYaw;

        const limit = Math.min(maxDevRad, Math.PI / 2.0);
        let bestCandidate = origYaw;
        let bestDelta = Infinity;

        for (let k = -1; k <= 2; k++) {
            const candidate = rawYaw + k * (Math.PI / 2.0);
            const delta = this.wrapToPi(candidate - origYaw);
            if (Math.abs(delta) < Math.abs(bestDelta)) {
                bestDelta = delta;
                bestCandidate = candidate;
            }
        }

        if (Math.abs(bestDelta) <= limit) {
            return this.wrapToPi(origYaw + bestDelta);
        }
        return origYaw;
    }

    /**
     * LỌC MƯỢT GÓC YAW NHẢY ĐỘT NGỘT (OUTLIER CHECK THEO CHUỖI THỜI GIAN)
     * Một frame chỉ bị coi là outlier nếu 2 frame láng giềng kề cận ổn định với nhau (<= maxJumpRad),
     * nhưng frame ở giữa lại nhảy góc xa so với cả hai (> maxJumpRad).
     * Khi đó bẻ lại frame ở giữa về trung bình tròn (circular mean) của 2 láng giềng.
     */
    static locMuotGocYawDotNgotTrack(shapes, maxJumpRad = 0.35) {
        const n = shapes ? shapes.length : 0;
        if (n < 3) return 0;

        let fixed = 0;
        const yaw = shapes.map(s => (s.points && s.points.length >= 6) ? (s.points[5] || 0) : 0);
        const circularMean2 = (a, b) => this.wrapToPi(a + this.wrapToPi(b - a) / 2.0);

        const kiemTraVaSua = (i, a, b) => {
            if (!Number.isFinite(yaw[i]) || !Number.isFinite(yaw[a]) || !Number.isFinite(yaw[b])) return;
            const onDinh = Math.abs(this.wrapToPi(yaw[b] - yaw[a])) <= maxJumpRad;
            const xaA = Math.abs(this.wrapToPi(yaw[i] - yaw[a])) > maxJumpRad;
            const xaB = Math.abs(this.wrapToPi(yaw[i] - yaw[b])) > maxJumpRad;
            if (onDinh && xaA && xaB) {
                const target = circularMean2(yaw[a], yaw[b]);
                shapes[i].points[5] = parseFloat(target.toFixed(3));
                if (Array.isArray(shapes[i].rotation)) shapes[i].rotation[2] = shapes[i].points[5];
                fixed++;
            }
        };

        // Frame đầu: dùng 2 frame kế tiếp nếu chúng ổn định
        kiemTraVaSua(0, 1, 2);
        // Các frame giữa: dùng frame trước và frame sau
        for (let i = 1; i < n - 1; i++) {
            kiemTraVaSua(i, i - 1, i + 1);
        }
        // Frame cuối: dùng 2 frame liền trước nếu chúng ổn định
        kiemTraVaSua(n - 1, n - 2, n - 3);

        return fixed;
    }

    static khuLatGocTrack(track) {
        if (!track || !track.shapes) return 0;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return 0;
        const shapes = (track.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
        if (shapes.length < 2) return 0;

        shapes.sort((a, b) => a.frame - b.frame);
        let count = 0;

        // Bắt lỗi lật pha 180° CỤC BỘ 1 frame (đặc trị ca Frame 32 nằm giữa Frame 31 & 33 cùng hướng):
        for (let i = 1; i < shapes.length - 1; i++) {
            const yPrev = shapes[i - 1].points[5];
            const yCurr = shapes[i].points[5];
            const yNext = shapes[i + 1].points[5];
            const dPrevNext = Math.abs(this.wrapToPi(yNext - yPrev));
            const dCurrPrev = Math.abs(this.wrapToPi(yCurr - yPrev));
            const dCurrNext = Math.abs(this.wrapToPi(yCurr - yNext));
            // Nếu 2 frame kề nhau cùng hướng (dPrevNext <= 45°), mà frame ở giữa bị lệch > 90° so với cả hai:
            if (dPrevNext <= Math.PI / 4.0 && dCurrPrev > Math.PI / 2.0 && dCurrNext > Math.PI / 2.0) {
                shapes[i].points[5] = parseFloat(this.wrapToPi(yCurr + Math.PI).toFixed(3));
                if (Array.isArray(shapes[i].rotation)) shapes[i].rotation[2] = shapes[i].points[5];
                count++;
            }
        }

        // Lọc mượt các frame nhảy góc đột ngột so với láng giềng kề cận
        count += this.locMuotGocYawDotNgotTrack(shapes, 0.35);

        return count;
    }

    /**
     * KHỬ LẬT GÓC 180° TOÀN JOB
     */
    static khuLatGocToanJob(annotations) {
        if (!annotations || !annotations.tracks) return { soTrackDaSua: 0, soFrameDaSua: 0 };
        let tongFrame = 0;
        let soTrack = 0;

        for (const tr of annotations.tracks) {
            const cnt = this.khuLatGocTrack(tr);
            if (cnt > 0) {
                tongFrame += cnt;
                soTrack++;
            }
        }
        return { soTrackDaSua: soTrack, soFrameDaSua: tongFrame };
    }

    /**
     * THUẬT TOÁN 2: BẢO TỒN & LÀM MƯỢT DỐC MẶT ĐƯỜNG Z CHO 1 TRACK
     * Bảo toàn cao độ đáy tiếp xúc mặt đất (Z_bottom = Z_center - H/2),
     * làm mượt chuỗi Z_bottom bằng Moving Median, sau đó tính lại Z_center.
     */
    /**
     * RANSAC Plane Segmentation thuần túy (Đồng bộ 100% bản Python EXE)
     * Dò tìm mặt phẳng mặt đường z = gx * x + gy * y + d_plane
     */
    static ransacPlane(pts, distanceThreshold = 0.04, numIterations = 80, minInliers = 15) {
        if (!pts || pts.length < 3) return null;
        const n = pts.length;
        let bestInliers = [];
        let bestCount = 0;
        // PRNG tất định (mulberry32, gieo theo số điểm): cùng dữ liệu -> cùng mặt phẳng, để vạch Surface
        // (dựng miếng vá bằng chính hàm này) và Auto fit luôn trùng nhau tuyệt đối.
        let seed = (n * 2654435761) >>> 0;
        const rand = () => {
            seed = (seed + 0x6D2B79F5) >>> 0;
            let t = seed;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        if (n < 3) return null;

        for (let it = 0; it < numIterations; it++) {
            const i1 = Math.floor(rand() * n);
            let i2 = Math.floor(rand() * n);
            while (i2 === i1) i2 = Math.floor(rand() * n);
            let i3 = Math.floor(rand() * n);
            while (i3 === i1 || i3 === i2) i3 = Math.floor(rand() * n);

            const p1 = pts[i1], p2 = pts[i2], p3 = pts[i3];
            const v1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
            const v2 = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]];

            const nx = v1[1] * v2[2] - v1[2] * v2[1];
            const ny = v1[2] * v2[0] - v1[0] * v2[2];
            const nz = v1[0] * v2[1] - v1[1] * v2[0];
            const norm = Math.hypot(nx, ny, nz);
            if (norm < 1e-6) continue;

            const a = nx / norm;
            const b = ny / norm;
            const c = nz / norm;
            const d = -(a * p1[0] + b * p1[1] + c * p1[2]);

            const inliers = [];
            for (let i = 0; i < n; i++) {
                const dist = Math.abs(a * pts[i][0] + b * pts[i][1] + c * pts[i][2] + d);
                if (dist < distanceThreshold) inliers.push(i);
            }

            if (inliers.length > bestCount) {
                bestCount = inliers.length;
                bestInliers = inliers;
                if (bestCount >= Math.floor(0.85 * n)) break;
            }
        }

        if (bestCount < minInliers) return null;

        let s_xx = 0, s_xy = 0, s_x = 0;
        let s_yy = 0, s_y = 0;
        let s_xz = 0, s_yz = 0, s_z = 0;
        const m = bestInliers.length;

        for (const idx of bestInliers) {
            const x = pts[idx][0], y = pts[idx][1], z = pts[idx][2];
            s_xx += x * x; s_xy += x * y; s_x += x;
            s_yy += y * y; s_y += y;
            s_xz += x * z; s_yz += y * z; s_z += z;
        }

        const det = s_xx * (s_yy * m - s_y * s_y) - s_xy * (s_xy * m - s_y * s_x) + s_x * (s_xy * s_y - s_yy * s_x);
        if (Math.abs(det) < 1e-8) return null;

        const det_gx = s_xz * (s_yy * m - s_y * s_y) - s_xy * (s_yz * m - s_y * s_z) + s_x * (s_yz * s_y - s_yy * s_z);
        const det_gy = s_xx * (s_yz * m - s_y * s_z) - s_xz * (s_xy * m - s_y * s_x) + s_x * (s_xy * s_z - s_yz * s_x);
        const det_d  = s_xx * (s_yy * s_z - s_yz * s_y) - s_xy * (s_xy * s_z - s_yz * s_x) + s_xz * (s_xy * s_y - s_yy * s_x);

        return {
            gx: det_gx / det,
            gy: det_gy / det,
            d_plane: det_d / det,
            inliersCount: m
        };
    }

    /**
     * Căn Chỉnh Mặt Đường Hộp Chuẩn EXE (Tire Contact Patch + RANSAC + 1.2cm Sink)
     */
    /**
     * CĂN CHỈNH MẶT ĐƯỜNG & CHIỀU CAO HÌNH HỘP (GROUND & ROOF ENGINE V2.6.2)
     * Quy trình chuẩn của Kiệt:
     * 1. Phóng to cuboid, lấy sâu xuống dưới 10m từ vị trí cuboid kéo xuống bất kể tâm hộp và chiều cao hiện tại.
     * 2. Quét dần từ dưới lên (lát cắt ngang Z nào dày điểm nhất -> ĐÓ LÀ MẶT ĐẤT).
     * 3. Sau khi xác định được mặt đất -> Quét từ mặt đất lên để lấy nóc xe (chặn cành cây/dây điện).
     * 4. Hạ đáy hộp sát khít mặt đất (z_bottom = wRoad - 0.01m), tính lại tâm Z và chiều cao H.
     */
    static canChinhMatDuongHop(pos, rot, size, allPts, maxTilt = 0.08, opts = null) {
        const [cx, cy, cz] = pos;
        const [rx, ry, rz] = rot;
        const [L, W, H] = size;

        const resolveNeoZ = (zNen, confNen) => {
            if (!opts) return null;
            const Neo = (typeof NeoDuyet !== 'undefined') ? NeoDuyet : ((typeof window !== 'undefined' && window.NeoDuyet) ? window.NeoDuyet : (typeof globalThis !== 'undefined' ? globalThis.NeoDuyet : null));
            if (!Neo) return null;
            let st = opts.neoState || null;
            if (!st && Array.isArray(opts.neoDuyet) && opts.neoDuyet.length > 0) {
                st = Neo.datTrangThaiNeo(opts.neoDuyet, () => zNen, opts);
            }
            if (!st || !st.coNeoXe) return null;
            const q = Neo.truyVanNeoChoBox(cx, cy, zNen, confNen, st);
            return (q && q.valid && Number.isFinite(q.z)) ? q : null;
        };

        if (!allPts || allPts.length < 6) {
            const qFb = resolveNeoZ(NaN, 0);
            const zOut = qFb ? qFb.z : (cz - H / 2.0);
            return {
                newPos: [cx, cy, zOut + H / 2.0],
                newRot: [...rot],
                dz: qFb ? ((zOut + H / 2.0) - cz) : 0,
                foundPlane: Boolean(qFb),
                zRoad: zOut,
                zRoof: zOut + H,
                hMeas: H,
                wRoad: -H / 2.0,
                wRoof: H / 2.0,
                confidence: qFb ? Math.max(0.4, 1.0 - qFb.sigma * 2.0) : 0,
                nGroundPts: 0,
                rms: null,
                isDirectPlane: false
            };
        }

        // [FIX QUAN TRỌNG]: Khi quét tìm mặt đất từ dưới lên, BẮT BUỘC dùng ma trận phẳng ngang chỉ xoay theo Yaw (rx = 0, ry = 0)!
        // Nhờ đó dù người dùng có cố tình xoay phá góc nghiêng Pitch/Roll (rx, ry) 30°-60° ở view SIDE/FRONT,
        // trục w vẫn luôn vuông góc thẳng đứng với mặt đất thực tế, giúp bắt trúng 100% lớp điểm mặt đường!
        const rotMatLevel = this.eulerXYZToMatrix(0, 0, rz || 0);

        // [BƯỚC 1: PHÓNG TO CUBOID & QUÉT SÂU 10M DƯỚI VỊ TRÍ CUBOID KÉO XUỐNG]
        const scanL = Math.max(L + 1.40, 5.50);
        const scanW = Math.max(W + 1.20, 3.20);
        const limU = scanL / 2.0;
        const limV = scanW / 2.0;
        const limW_min = -10.0; // Quét sâu 10m xuống dưới từ cuboid kéo xuống
        const limW_max = 5.0;

        const allLocalW = [];
        for (let i = 0; i < allPts.length; i++) {
            const p = allPts[i];
            const dx = p[0] - cx;
            const dy = p[1] - cy;
            const dz = p[2] - cz;

            const u = dx * rotMatLevel[0][0] + dy * rotMatLevel[1][0] + dz * rotMatLevel[2][0];
            const v = dx * rotMatLevel[0][1] + dy * rotMatLevel[1][1] + dz * rotMatLevel[2][1];
            const w = dx * rotMatLevel[0][2] + dy * rotMatLevel[1][2] + dz * rotMatLevel[2][2];

            if (Math.abs(u) <= limU && Math.abs(v) <= limV && w >= limW_min && w <= limW_max) {
                allLocalW.push({ u, v, w, origPt: p });
            }
        }

        // [BƯỚC 2: QUÉT DẦN TỪ DƯỚI LÊN ĐỂ TÌM MẶT ĐẤT THÔ]
        let wRoadRaw = -H / 2.0;
        let foundRoad = false;

        const wVals = allLocalW.map(pt => pt.w);
        if (wVals.length >= 6) {
            wVals.sort((a, b) => a - b);
            const minW = wVals[0];
            const maxW = wVals[wVals.length - 1];
            const binSize = 0.025; // Lát cắt ngang mỏng 2.5cm
            const numBins = Math.max(1, Math.ceil((maxW - minW + 0.05) / binSize));
            const hist = new Array(numBins).fill(0);

            for (let i = 0; i < wVals.length; i++) {
                const bIdx = Math.floor((wVals[i] - minW) / binSize);
                if (bIdx >= 0 && bIdx < numBins) hist[bIdx]++;
            }

            // Quét từ dưới đáy (-10m) đi dần lên trên: tìm cụm đầu tiên làm mốc z0
            let firstClusterBin = -1;
            const thresholdPts = (wVals.length >= 25) ? 4 : 2;

            for (let b = 0; b < numBins; b++) {
                const winCount = (hist[b] || 0) + (hist[b + 1] || 0) + (hist[b + 2] || 0);
                if (winCount >= thresholdPts && hist[b] >= 2) {
                    firstClusterBin = b;
                    break;
                }
            }

            if (firstClusterBin !== -1) {
                // Cửa sổ quét đa lớp mặt đường theo khoảng cách LiDAR (chống ghosting tầng dưới, chặn tối đa 0.5*H để không ăn lên thân xe)
                const distToSensor = Math.hypot(cx, cy);
                const maxScanH = Math.max(0.18, Math.min(H * 0.50, 0.18 + 0.022 * distToSensor));
                const maxScanBins = Math.max(6, Math.ceil(maxScanH / binSize));
                const searchLimit = Math.min(numBins, firstClusterBin + maxScanBins);

                // Làm mượt histogram 3-bin để tìm tất cả đỉnh cục bộ trong [z0, z0 + maxScanH]
                const smoothHist = new Array(numBins).fill(0);
                for (let b = firstClusterBin; b < searchLimit; b++) {
                    smoothHist[b] = (hist[b - 1] || 0) + hist[b] + (hist[b + 1] || 0);
                }

                const candidateBins = [];
                for (let b = firstClusterBin; b < searchLimit; b++) {
                    const left = (b > firstClusterBin) ? smoothHist[b - 1] : -1;
                    const right = (b + 1 < searchLimit) ? smoothHist[b + 1] : -1;
                    if (smoothHist[b] >= thresholdPts && smoothHist[b] >= left && smoothHist[b] >= right) {
                        candidateBins.push(b);
                    }
                }
                if (candidateBins.length === 0) candidateBins.push(firstClusterBin);

                // Chấm điểm từng lớp mặt phẳng ứng viên: ưu tiên lớp có mật độ + độ phủ ô rộng (tránh ghosting ít điểm & tránh thân xe hẹp ô)
                const scoredLayers = [];
                for (const cb of candidateBins) {
                    const wC = minW + (cb + 0.5) * binSize;
                    let inlierCnt = 0;
                    let collarCnt = 0;
                    const uvCells = new Set();
                    for (let i = 0; i < allLocalW.length; i++) {
                        const pt = allLocalW[i];
                        if (Math.abs(pt.w - wC) <= 0.035) {
                            inlierCnt++;
                            if (Math.abs(pt.u) > L / 2.0 - 0.12 || Math.abs(pt.v) > W / 2.0 - 0.12) {
                                collarCnt++;
                            }
                            uvCells.add(`${Math.floor(pt.u / 0.35)}_${Math.floor(pt.v / 0.35)}`);
                        }
                    }
                    const layerScore = (inlierCnt + 0.5 * collarCnt) * Math.max(1, uvCells.size);
                    scoredLayers.push({ b: cb, wC, score: layerScore, inlierCnt, collarCnt });
                }

                scoredLayers.sort((a, b) => b.score - a.score);
                const bestScore = scoredLayers[0].score;
                const goodLayers = scoredLayers
                    .filter(c => c.score >= 0.70 * bestScore)
                    .sort((a, b) => a.wC - b.wC);

                // Nếu có cụm tách biệt ở trên (cách cụm dưới >= 12cm) -> nhảy qua lớp ghosting dưới để lên cụm mặt đường thật phía trên
                let clusterStartIdx = 0;
                for (let k = 1; k < goodLayers.length; k++) {
                    if (goodLayers[k].wC - goodLayers[k - 1].wC >= 0.12) {
                        clusterStartIdx = k;
                    }
                }
                // Trong cụm đã chọn: chống leo lớp (chỉ leo lên sub-layer cao hơn nếu collarCnt vượt >= 15%, hòa thì giữ lớp thấp hơn)
                let chosen = goodLayers[clusterStartIdx];
                for (let k = clusterStartIdx + 1; k < goodLayers.length; k++) {
                    const cand = goodLayers[k];
                    if (cand.collarCnt >= 1.15 * chosen.collarCnt) {
                        chosen = cand;
                    }
                }

                const wCenter = chosen.wC;
                const inPeak = wVals.filter(val => Math.abs(val - wCenter) <= 0.035);
                wRoadRaw = inPeak.length > 0 ? this.median(inPeak) : wCenter;
                foundRoad = true;
            } else {
                wRoadRaw = -H / 2.0;
            }
        }

        // [BƯỚC 3: RANSAC 3D TỰ CÂN BẰNG ĐỂ MẶT ĐƯỜNG SONG SONG VỚI CUBOID]
        // Lấy các điểm mặt đường quanh chân xe (collar / ground patch); tách riêng vành đai ngoài thân xe để tránh điểm lốp làm bẩn mép trên
        const roadPointsWorld = [];
        const collarPointsWorld = [];
        for (let i = 0; i < allLocalW.length; i++) {
            const item = allLocalW[i];
            if (Math.abs(item.u) <= L / 2.0 + 0.90 &&
                Math.abs(item.v) <= W / 2.0 + 0.90 &&
                Math.abs(item.w - wRoadRaw) <= 0.09) {
                roadPointsWorld.push(item.origPt);
                if (Math.abs(item.u) > L / 2.0 - 0.12 || Math.abs(item.v) > W / 2.0 - 0.12) {
                    collarPointsWorld.push(item.origPt);
                }
            }
        }

        const maxPlaneTilt = Math.min(0.08, maxTilt || 0.08);
        // Nếu góc nghiêng rx/ry ban đầu bị phá lệch quá độ dốc mặt đường (> maxPlaneTilt), tự động san phẳng về 0 trước khi áp mặt phẳng RANSAC
        let newRx = (Math.abs(rx || 0) <= maxPlaneTilt) ? (rx || 0) : 0;
        let newRy = (Math.abs(ry || 0) <= maxPlaneTilt) ? (ry || 0) : 0;
        let zRoadEst = cz + wRoadRaw;
        let foundPlane = false;
        let isDirectPlane = false;
        let nGroundPts = roadPointsWorld.length;
        let rms = null;

        if (roadPointsWorld.length >= 12) {
            const planeRes = this.ransacPlane(roadPointsWorld, 0.035, 100, 10);
            if (planeRes) {
                const { gx, gy, d_plane } = planeRes;
                if (Math.abs(gx) <= maxPlaneTilt && Math.abs(gy) <= maxPlaneTilt) {
                    newRx = gy;
                    newRy = -gx;
                    zRoadEst = gx * cx + gy * cy + d_plane;
                    foundPlane = true;
                    isDirectPlane = true;
                } else if (Math.abs(gx) <= 0.20 && Math.abs(gy) <= 0.20) {
                    newRx = Math.max(-maxPlaneTilt, Math.min(maxPlaneTilt, gy));
                    newRy = Math.max(-maxPlaneTilt, Math.min(maxPlaneTilt, -gx));
                    zRoadEst = gx * cx + gy * cy + d_plane;
                    foundPlane = true;
                }
                if (foundPlane) {
                    let s2 = 0, nIn = 0;
                    const inlierResids = [];
                    for (const p of roadPointsWorld) {
                        const e = p[2] - (gx * p[0] + gy * p[1] + d_plane);
                        if (Math.abs(e) <= 0.055) inlierResids.push(e);
                        if (Math.abs(e) <= 0.035) { s2 += e * e; nIn++; }
                    }
                    // Đặt đáy hộp cố định ở MÉP TRÊN (p85) của dải mặt đường dày (kẹp an toàn [0, +3cm])
                    const collarResids = [];
                    if (collarPointsWorld.length >= 25) {
                        for (const p of collarPointsWorld) {
                            const e = p[2] - (gx * p[0] + gy * p[1] + d_plane);
                            if (Math.abs(e) <= 0.055) collarResids.push(e);
                        }
                    }
                    const resSource = collarResids.length >= 25 ? collarResids : inlierResids;
                    if (resSource.length >= 20) {
                        resSource.sort((a, b) => a - b);
                        const p85 = resSource[Math.floor(resSource.length * 0.85)];
                        const topOffset = Math.min(0.030, Math.max(0.0, p85));
                        zRoadEst += topOffset;
                    } else {
                        zRoadEst += 0.005;
                    }
                    nGroundPts = nIn;
                    rms = nIn > 0 ? Math.sqrt(s2 / nIn) : null;
                }
            }
        } else if (roadPointsWorld.length > 0) {
            let s2 = 0;
            for (const p of roadPointsWorld) { const e = p[2] - zRoadEst; s2 += e * e; }
            rms = Math.sqrt(s2 / roadPointsWorld.length);
        }

        // Độ tin cậy [0..1] của phép đo mặt đường: loại mặt phẳng × mật độ điểm đất × độ phẳng (RMS)
        const kieuMat = isDirectPlane ? 1.0 : (foundPlane ? 0.6 : (foundRoad ? 0.3 : 0.05));
        const matDo = Math.min(1, Math.sqrt(nGroundPts / 80));
        const doPhang = rms === null ? 0.5 : Math.max(0.3, Math.min(1, 1 - rms / 0.05));
        let confidence = kieuMat * matDo * doPhang;

        const qNeoHop = resolveNeoZ(foundRoad ? zRoadEst : NaN, Math.min(0.85, confidence));
        if (qNeoHop) {
            const sigHop = foundPlane ? Math.max(0.035, 0.22 * (1.0 - confidence)) : (foundRoad ? 0.14 : 0.45);
            const wHop = foundRoad ? (1.0 / (sigHop * sigHop)) : 0;
            const wNeo = 1.0 / Math.max(1e-6, qNeoHop.sigma * qNeoHop.sigma);
            zRoadEst = wHop > 0 ? ((wHop * zRoadEst + wNeo * qNeoHop.z) / (wHop + wNeo)) : qNeoHop.z;
            confidence = Math.max(confidence, Math.min(0.95, 1.0 - qNeoHop.sigma * 2.0));
        }

        // Ma trận xoay mới đã tự cân bằng theo mặt đường
        const rotMatNew = this.eulerXYZToMatrix(newRx, newRy, rz || 0);

        // [BƯỚC 4: HẠ ĐÁY BOX KHÍT ĐẤT VÀ CHÌM NHẸ 1.2CM ÔM LỐP XE]
        // Đáy tiếp xúc mặt đất z_bottom = zRoadEst - 0.012
        // Tâm xe mới: z_center = zRoadEst - 0.012 + (H / 2.0)
        const targetCz = zRoadEst + (H / 2.0); // [BỎ LÚN SÂU 1.2CM]: Khít phẳng đáy hộp với mặt đường 100% (z_bottom = zRoadEst)
        const newPos = [cx, cy, targetCz];
        const newRot = [newRx, newRy, rz || 0];

        // [BƯỚC 5: QUÉT TỪ MẶT ĐẤT LÊN ĐỂ ĐO CHIỀU CAO NÓC XE CHUẨN XÁC]
        // Chuyển lại điểm theo hệ tọa độ mới của xe đã khít đất
        const bodyPtsZ = [];
        const limU_car = Math.max(3.80, Math.min(4.80, L)) / 2.0 + 0.12;
        const limV_car = Math.max(1.75, Math.min(1.92, W)) / 2.0 + 0.10;

        for (let i = 0; i < allPts.length; i++) {
            const p = allPts[i];
            const dx = p[0] - newPos[0];
            const dy = p[1] - newPos[1];
            const dz = p[2] - newPos[2];

            const lu = dx * rotMatNew[0][0] + dy * rotMatNew[1][0] + dz * rotMatNew[2][0];
            const lv = dx * rotMatNew[0][1] + dy * rotMatNew[1][1] + dz * rotMatNew[2][1];
            const lw = dx * rotMatNew[0][2] + dy * rotMatNew[1][2] + dz * rotMatNew[2][2];

            // Điểm thuộc thân xe từ sàn xe trở lên
            if (Math.abs(lu) <= limU_car && Math.abs(lv) <= limV_car && lw >= -H / 2.0 + 0.10 && lw <= H / 2.0 + 0.40) {
                bodyPtsZ.push(p[2]); // Lấy cao độ Z thế giới
            }
        }

        let hMeas = H;
        const measuredH = this.doChieuCaoLeoTangNocXe(bodyPtsZ, zRoadEst, 0.035, 0.20);
        if (measuredH !== null && measuredH >= 1.45 && measuredH <= 1.72) {
            hMeas = measuredH;
        } else if (H >= 1.45 && H <= 1.72) {
            hMeas = H;
        } else {
            hMeas = 1.58; // Giá trị tiêu chuẩn SUV/Sedan
        }

        const zRoofEst = zRoadEst + hMeas;

        return {
            newPos,
            newRot,
            dz: targetCz - cz,
            foundPlane: foundPlane || foundRoad,
            zRoad: zRoadEst,
            zRoof: zRoofEst,
            hMeas,
            wRoad: zRoadEst - cz,
            wRoof: zRoofEst - cz,
            confidence,
            nGroundPts,
            rms,
            isDirectPlane
        };
    }

    // =========================================================================
    // ĐỘ CAO TƯƠNG ĐỐI SO VỚI MẶT PHẲNG ĐẤT EGO (dùng chung lõi làm mượt của Thuật Toán Surface)
    // =========================================================================

    static _laySurface() {
        if (typeof ThuatToanSurface !== 'undefined') return ThuatToanSurface;
        if (typeof window !== 'undefined' && window.ThuatToanSurface) return window.ThuatToanSurface;
        if (typeof require === 'function' && typeof __dirname !== 'undefined') {
            try { return require(require('path').join(__dirname, 'Thuật Toán Surface.js')); } catch (e) {}
        }
        return null;
    }

    /** Mặt phẳng đất quanh Ego (seed plane của Surface), nhớ đệm theo mảng điểm của frame. */
    static uocLuongMatPhangEgo(pts) {
        if (!pts || pts.length < 20) return null;
        if (!this._egoPlaneCache) this._egoPlaneCache = new WeakMap();
        if (this._egoPlaneCache.has(pts)) return this._egoPlaneCache.get(pts);
        const S = this._laySurface();
        let plane = null;
        if (S && typeof S.timMatPhangGocRobust === 'function') {
            try { plane = S.timMatPhangGocRobust(pts); } catch (e) { plane = null; }
        }
        this._egoPlaneCache.set(pts, plane);
        return plane;
    }

    /**
     * Làm mượt cao độ mặt đường của một track theo độ cao tương đối h = zRoad − E_ego(bx, by) dọc quãng đường s.
     * shapes: các shape active đã sắp theo frame; measures: Map(frame → { zRoad, rx, ry, confidence, found }).
     * Trả Map(frame → { zRoad, rx, ry, rejected }) hoặc null nếu không đủ điều kiện (thiếu Surface / < 2 mẫu).
     */
    static lamMuotDoCaoTuongDoiTheoTrack(shapes, measures, pcdsMap, maxTilt = 0.08) {
        const S = this._laySurface();
        if (!S || typeof S.lamMuotTuongDoiTrack !== 'function') return null;
        const samples = [];
        for (const s of shapes) {
            const fn = Number(s.frame);
            const m = measures.get(fn);
            if (!m || !m.found || !Number.isFinite(m.zRoad)) continue;
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            const ego = this.uocLuongMatPhangEgo(pts);
            if (!ego) continue;
            const [bx, by, bz, , , rzRaw, L, W, H] = s.points;
            const rz = rzRaw || 0;
            const E = ego.z0 + ego.gx * bx + ego.gy * by;
            const dgx = -(m.ry || 0) - ego.gx, dgy = (m.rx || 0) - ego.gy;
            const c = Math.cos(rz), sn = Math.sin(rz);
            const d = Math.hypot(bx, by);
            const conf = Math.max(0.08, Number.isFinite(m.confidence) ? m.confidence : 0.5);
            const zLow = typeof S._zThapTrongFootprint === 'function'
                ? S._zThapTrongFootprint(pts, bx, by, rz, L, W, bz - H / 2, H) : null;
            samples.push({
                frame: fn, x: bx, y: by, rz,
                h: m.zRoad - E,
                p: dgx * c + dgy * sn,
                r: -dgx * sn + dgy * c,
                sigma: 0.025 / conf + d * 0.003,
                sigmaP: 0.015 / conf + d * 0.0008,
                hMax: zLow !== null ? zLow + 0.03 - E : null,
                E, ego
            });
        }
        if (samples.length < 2) return null;

        const out = S.lamMuotTuongDoiTrack(samples);
        const res = new Map();
        const clampT = v => Math.max(-maxTilt, Math.min(maxTilt, v));
        for (let k = 0; k < out.length; k++) {
            const o = out[k], smp = samples[k];
            const c = Math.cos(smp.rz), sn = Math.sin(smp.rz);
            const gx = clampT(smp.ego.gx + o.p * c - o.r * sn);
            const gy = clampT(smp.ego.gy + o.p * sn + o.r * c);
            res.set(smp.frame, { zRoad: smp.E + o.h, rx: gy, ry: -gx, rejected: o.rejected });
        }
        return res;
    }

    static layDiemTuPcdsMap(pcdsMap, fn) {
        if (!pcdsMap || fn === undefined || fn === null) return null;
        let pts = null;
        if (pcdsMap instanceof Map) {
            pts = pcdsMap.get(fn);
            if (!pts && typeof fn === 'string') pts = pcdsMap.get(parseInt(fn, 10));
            if (!pts && typeof fn === 'number') pts = pcdsMap.get(String(fn));
        } else if (typeof pcdsMap === 'object') {
            pts = pcdsMap[fn];
            if (!pts && typeof fn === 'string') pts = pcdsMap[parseInt(fn, 10)];
            if (!pts && typeof fn === 'number') pts = pcdsMap[String(fn)];
        }
        if (!pts) return null;
        // Bỏ qua dữ liệu CAD giả lập để chống trôi lệch (Drift Prevention)
        if (pts._isSynthetic || pts._isFallback) return null;
        return pts;
    }

    static khopMatDuongTrack(track, deltaZ = 0, pcdsMap = null) {
        if (!track || !track.shapes) return 0;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return 0;
        const activeShapes = (track.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length === 0) return 0;

        activeShapes.sort((a, b) => a.frame - b.frame);

        const dZ = parseFloat(deltaZ) || 0;

        // Khớp mặt đường từng frame bằng RANSAC nếu có PCD
        if (pcdsMap) {
            const measures = new Map();
            for (const s of activeShapes) {
                const fn = s.frame;
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (pts && pts.length >= 15) {
                    const pos = [s.points[0], s.points[1], s.points[2]];
                    const rot = [s.points[3], s.points[4], s.points[5]];
                    const size = [s.points[6], s.points[7], s.points[8]];
                    const res = this.canChinhMatDuongHop(pos, rot, size, pts);
                    if (res) {
                        measures.set(Number(fn), {
                            zRoad: res.newPos[2] - size[2] / 2.0,
                            rx: res.newRot[0], ry: res.newRot[1],
                            confidence: res.confidence, found: !!res.foundPlane,
                            newPos: res.newPos, newRot: res.newRot
                        });
                    }
                }
            }

            // [ĐỘ CAO TƯƠNG ĐỐI] Làm mượt h = zRoad − E_ego dọc quãng đường; BẢO TOÀN 100% độ dốc thật của RANSAC frame
            const smooth = this.lamMuotDoCaoTuongDoiTheoTrack(activeShapes, measures, pcdsMap);
            if (smooth) {
                for (const s of activeShapes) {
                    const fn = Number(s.frame);
                    const sm = smooth.get(fn);
                    const m = measures.get(fn);
                    if (!m) continue;
                    s.points[0] = m.newPos[0];
                    s.points[1] = m.newPos[1];

                    if (m.found) {
                        s.points[3] = parseFloat(m.newRot[0].toFixed(3));
                        s.points[4] = parseFloat(m.newRot[1].toFixed(3));
                        let zR = m.zRoad;
                        if (sm && Number.isFinite(sm.zRoad) && Math.abs(sm.zRoad - m.zRoad) <= 0.035) {
                            zR = sm.zRoad;
                        }
                        s.points[2] = parseFloat((zR + s.points[8] / 2.0 + dZ).toFixed(3));
                    } else if (sm) {
                        s.points[2] = parseFloat((sm.zRoad + s.points[8] / 2.0 + dZ).toFixed(3));
                        s.points[3] = parseFloat(sm.rx.toFixed(3));
                        s.points[4] = parseFloat(sm.ry.toFixed(3));
                    }
                }
                // Frame không có phép đo hợp lệ giữ nguyên cao độ (chỉ cộng deltaZ)
                if (dZ) {
                    for (const s of activeShapes) if (!smooth.has(Number(s.frame))) s.points[2] += dZ;
                }
                return activeShapes.length;
            }

            for (const s of activeShapes) {
                const m = measures.get(Number(s.frame));
                if (!m) continue;
                s.points[0] = m.newPos[0];
                s.points[1] = m.newPos[1];
                s.points[2] = m.newPos[2];
                s.points[3] = m.newRot[0];
                s.points[4] = m.newRot[1];
            }
        }

        const zBottoms = activeShapes.map(s => s.points[2] - (s.points[8] / 2.0));
        const smoothedZBottoms = [];

        for (let i = 0; i < activeShapes.length; i++) {
            const curFrame = activeShapes[i].frame;
            const windowVals = [];
            for (let j = Math.max(0, i - 2); j <= Math.min(activeShapes.length - 1, i + 2); j++) {
                if (Math.abs(activeShapes[j].frame - curFrame) <= 3) {
                    windowVals.push(zBottoms[j]);
                }
            }
            windowVals.sort((a, b) => a - b);
            const medVal = windowVals[Math.floor(windowVals.length / 2)];
            smoothedZBottoms.push(medVal);
        }

        for (let i = 0; i < activeShapes.length; i++) {
            const s = activeShapes[i];
            const h = s.points[8];
            s.points[2] = smoothedZBottoms[i] + (h / 2.0) + dZ;
        }
        return activeShapes.length;
    }

    /**
     * KHỚP MẶT ĐƯỜNG Z TOÀN JOB
     */
    static khopMatDuongToanJob(annotations, deltaZ = 0, pcdsMap = null) {
        if (!annotations || !annotations.tracks) return { soHinhDaCan: 0 };
        let count = 0;
        for (const tr of annotations.tracks) {
            count += this.khopMatDuongTrack(tr, deltaZ, pcdsMap);
        }
        return { soHinhDaCan: count };
    }

    /**
     * THUẬT TOÁN 3: LÀM MƯỢT QUỸ ĐẠO TÂM XE (X-Y TRAJECTORY SMOOTHING)
     * Giúp triệt tiêu rung lắc, giật cục khi xe di chuyển trên đường
     */
    static lamMuotQuyDaoTrack(track, targetFrames = null, maxDelta = 0.30) {
        if (!track || !track.shapes) return 0;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return 0;
        if (targetFrames && !(targetFrames instanceof Set)) {
            targetFrames = new Set(targetFrames);
        }
        const activeShapes = (track.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length < 3) return 0;

        activeShapes.sort((a, b) => a.frame - b.frame);
        let count = 0;

        for (let i = 1; i < activeShapes.length - 1; i++) {
            const prev = activeShapes[i - 1];
            const cur = activeShapes[i];
            const next = activeShapes[i + 1];

            if (targetFrames) {
                if (!targetFrames.has(Number(cur.frame)) ||
                    !targetFrames.has(Number(prev.frame)) ||
                    !targetFrames.has(Number(next.frame))) {
                    continue;
                }
            }

            // Chỉ làm mượt nếu các frame kề cận (khoảng cách frame <= 2)
            if (Math.abs(cur.frame - prev.frame) <= 2 && Math.abs(next.frame - cur.frame) <= 2) {
                const smoothX = 0.25 * prev.points[0] + 0.50 * cur.points[0] + 0.25 * next.points[0];
                const smoothY = 0.25 * prev.points[1] + 0.50 * cur.points[1] + 0.25 * next.points[1];

                // Giới hạn biên độ làm mượt: tránh kéo lệch box ở frame xe đang tăng/giảm tốc
                if (Math.hypot(smoothX - cur.points[0], smoothY - cur.points[1]) < maxDelta) {
                    cur.points[0] = parseFloat(smoothX.toFixed(3));
                    cur.points[1] = parseFloat(smoothY.toFixed(3));
                    count++;
                }
            }
        }
        return count;
    }

    /**
     * LÀM MƯỢT QUỸ ĐẠO TOÀN JOB
     */
    static lamMuotQuyDaoToanJob(annotations) {
        if (!annotations || !annotations.tracks) return { soFrameDaMuot: 0 };
        let count = 0;
        for (const tr of annotations.tracks) {
            count += this.lamMuotQuyDaoTrack(tr);
        }
        return { soFrameDaMuot: count };
    }

    /**
     * THUẬT TOÁN CẮT LỚP MẬT ĐỘ THUẦN TÚY (PURE DENSITY SLICING)
     * Chia các lát mỏng binSize = 3cm (0.03m), quét từ ngoài xa tiến dần về tâm xe theo hướng đón tia.
     * Tìm mép vỏ xe đón tia LiDAR đầu tiên có mật độ >= minPts và liên tục.
     */
    static findEdgeByLayerSlicing(vals, direction, expectedHalf, maxInward = 0.20, binSize = 0.025, minPts = 5) {
        if (!vals || vals.length < 8) return null;
        const minDistFromCenter = Math.max(0.35, expectedHalf - maxInward);

        if (direction === -1) {
            // Quét từ ngoài xa (-5.0m) tiến dần về tâm (0.0m)
            const minV = -5.0;
            const maxV = 0.0;
            const nBins = Math.floor((maxV - minV) / binSize);
            const counts = new Array(nBins).fill(0);
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i];
                if (v >= minV && v < maxV) {
                    const idx = Math.floor((v - minV) / binSize);
                    if (idx >= 0 && idx < nBins) counts[idx]++;
                }
            }
            for (let i = 0; i < nBins; i++) {
                if (counts[i] >= minPts) {
                    const cNext = (i + 1 < nBins) ? counts[i + 1] : 0;
                    if (counts[i] + cNext >= minPts + 2) {
                        const edge = minV + i * binSize;
                        if (Math.abs(edge) >= minDistFromCenter) {
                            return edge;
                        } else {
                            break;
                        }
                    }
                }
            }
            return null;
        } else {
            // Quét từ ngoài xa (+5.0m) lùi dần về tâm (0.0m)
            const minV = 0.0;
            const maxV = 5.0;
            const nBins = Math.floor((maxV - minV) / binSize);
            const counts = new Array(nBins).fill(0);
            for (let i = 0; i < vals.length; i++) {
                const v = vals[i];
                if (v >= minV && v <= maxV) {
                    const idx = Math.floor((v - minV) / binSize);
                    if (idx >= 0 && idx < nBins) counts[idx]++;
                }
            }
            for (let i = nBins - 1; i >= 0; i--) {
                if (counts[i] >= minPts) {
                    const cPrev = (i - 1 >= 0) ? counts[i - 1] : 0;
                    if (counts[i] + cPrev >= minPts + 2) {
                        const edge = minV + (i + 1) * binSize;
                        if (Math.abs(edge) >= minDistFromCenter) {
                            return edge;
                        } else {
                            break;
                        }
                    }
                }
            }
            return null;
        }
    }

    /**
     * Quét mép ngoài vật lý bằng histogram đa lớp (Multi-layer histogram edge detection)
     * Kiểm tra hỗ trợ 4-bin liên tiếp để loại bỏ các điểm nhiễu lơ lửng ngoài rìa
     */
    static timMepNgoaiCumDiem(vals, isFacingNeg, isFacingPos, isVeh = true) {
        if (!vals || vals.length === 0) return { edgeMin: 0.0, edgeMax: 0.0 };
        const n = vals.length;
        if (n < 8) {
            let vmin = vals[0], vmax = vals[0];
            for (let i = 1; i < n; i++) {
                if (vals[i] < vmin) vmin = vals[i];
                if (vals[i] > vmax) vmax = vals[i];
            }
            return { edgeMin: vmin, edgeMax: vmax };
        }

        let vmin = vals[0], vmax = vals[0];
        for (let i = 1; i < n; i++) {
            if (vals[i] < vmin) vmin = vals[i];
            if (vals[i] > vmax) vmax = vals[i];
        }
        if (vmax - vmin < 0.08) return { edgeMin: vmin, edgeMax: vmax };

        const binW = isVeh ? 0.035 : 0.025;
        const bMin = vmin - binW;
        const bMax = vmax + 2 * binW;
        const nb = Math.max(1, Math.floor((bMax - bMin) / binW));
        const counts = new Array(nb).fill(0);
        for (let i = 0; i < n; i++) {
            const idx = Math.floor((vals[i] - bMin) / binW);
            if (idx >= 0 && idx < nb) counts[idx]++;
        }

        const winCounts = new Array(nb);
        for (let i = 0; i < nb; i++) {
            winCounts[i] = counts[i] + (i + 1 < nb ? counts[i + 1] : 0);
        }

        const thNeg = isVeh ? (isFacingNeg ? Math.max(3, Math.min(10, Math.floor(n * 0.008))) : Math.max(2, Math.min(7, Math.floor(n * 0.005)))) : Math.max(3, Math.min(12, Math.floor(n * 0.015)));
        const thPos = isVeh ? (isFacingPos ? Math.max(3, Math.min(10, Math.floor(n * 0.008))) : Math.max(2, Math.min(7, Math.floor(n * 0.005)))) : Math.max(3, Math.min(12, Math.floor(n * 0.015)));
        const thSup = isVeh ? Math.max(5, Math.min(20, Math.floor(n * 0.020))) : Math.max(6, Math.min(25, Math.floor(n * 0.045)));

        const sortedVals = [...vals].sort((a, b) => a - b);
        let edgeMin = sortedVals[Math.floor(n * 0.02)];
        for (let i = 0; i < nb; i++) {
            let sup4 = 0;
            for (let k = i; k < Math.min(nb, i + 4); k++) sup4 += counts[k];
            if ((winCounts[i] >= thNeg || counts[i] >= Math.max(3, Math.floor(thNeg / 2))) && (sup4 >= thSup || counts[i] >= 8)) {
                const idxB = counts[i] >= 2 ? i : Math.min(nb - 1, i + 1);
                const e0 = bMin + idxB * binW;
                const e1 = e0 + binW;
                const ptsB = vals.filter(v => v >= e0 && v <= e1 + 1e-5).sort((a, b) => a - b);
                if (ptsB.length > 0) {
                    edgeMin = ptsB[Math.floor(ptsB.length * (isVeh ? 0.10 : 0.20))];
                } else {
                    edgeMin = e0;
                }
                break;
            }
        }

        let edgeMax = sortedVals[Math.min(n - 1, Math.floor(n * 0.98))];
        for (let i = nb - 1; i >= 0; i--) {
            const wC = counts[i] + (i > 0 ? counts[i - 1] : 0);
            let sup4 = 0;
            for (let k = Math.max(0, i - 3); k <= i; k++) sup4 += counts[k];
            if ((wC >= thPos || counts[i] >= Math.max(3, Math.floor(thPos / 2))) && (sup4 >= thSup || counts[i] >= 8)) {
                const idxB = counts[i] >= 2 ? i : Math.max(0, i - 1);
                const e0 = bMin + idxB * binW;
                const e1 = e0 + binW;
                const ptsB = vals.filter(v => v >= e0 - 1e-5 && v <= e1).sort((a, b) => a - b);
                if (ptsB.length > 0) {
                    edgeMax = ptsB[Math.floor(ptsB.length * (isVeh ? 0.90 : 0.80))];
                } else {
                    edgeMax = e1;
                }
                break;
            }
        }

        return { edgeMin, edgeMax };
    }

    /**
     * Tính độ dịch chuyển cục bộ (dx_local, dy_local) để mép hộp đón tia LiDAR cách mép ngoài
     * của cụm điểm thân xe đúng một khoảng đệm pad = 2cm.
     * Hỗ trợ Thuật toán Neo Cản Đơn (Single-Flank Corner Anchor) khi xe bị chiếu ngang tiếp tuyến.
     */
    static tinhDxDyMep(ex0, ex1, ey0, ey1, L, W, sx, sy, pad = 0.05, isVeh = true, maxShift = 2.50, rX = null, fX = null, fY = null) {
        let dxLocal = 0.0;
        let dyLocal = 0.0;

        const dS = Math.hypot(sx, sy);
        const normSx = (dS > 1.0) ? (sx / Math.max(dS, 1e-4)) : sx;
        const normSy = (dS > 1.0) ? (sy / Math.max(dS, 1e-4)) : sy;

        // Xe lớn (L >= 6m) hoặc ở xa (dS > 25m) có sai số LiDAR cao hơn -> dùng đệm tối thiểu 4cm để không bị lòi mép
        const effPad = (L >= 6.0 || dS > 25.0) ? Math.max(pad, 0.04) : pad;

        // --- TRỤC Y: CĂN THÀNH XE (FLANK DOMINANCE THEO CHUẨN THUẬT TOÁN KIỆT) ---
        // fY là tâm của Lớp Nhiều Điểm Thắng (bestFlankY) do hàm phanTichLopThanXeChinh tìm ra.
        const hasClearFlank = Math.abs(normSy) > 0.20 || (Math.abs(normSy) > 0.07 && Math.abs(sy) >= 1.2);
        const sideSign = hasClearFlank ? (normSy > 0 ? 1 : -1) : 0;
        const targetFlankY = (fY !== null && fY !== undefined) ? fY : (sideSign > 0 ? ey1 : ey0);

        if (sideSign > 0) {
            // Sườn trái (+Y) đón tia: Mép ngoài hộp cách thành xe đúng khoảng đệm effPad
            const yLeftTarget = targetFlankY + effPad;
            dyLocal = yLeftTarget - (W / 2.0);
        } else if (sideSign < 0) {
            // Sườn phải (-Y) đón tia: Mép ngoài hộp cách thành xe đúng khoảng đệm effPad
            const yRightTarget = targetFlankY - effPad;
            dyLocal = yRightTarget - (-W / 2.0);
        } else {
            // Nhìn thẳng tuyệt đối từ đuôi/đầu xe (|sy| < 1.2m hoặc |normSy| <= 0.07):
            // Căn tâm đối xứng theo 2 mép thân xe chính (p02/p98 chống lệch do gương/nhiễu rìa)
            dyLocal = 0.5 * (ey0 + ey1);
        }

        // Ràng buộc bao phủ toàn thân trục Y: nếu bề rộng điểm thân xe nằm vừa trong W, giữ dyLocal sao cho không bên nào bị lòi ra
        if (ey1 > ey0 && (ey1 - ey0) <= W + 2.0 * effPad) {
            const minDy = ey1 - (W / 2.0 + effPad);
            const maxDy = ey0 + (W / 2.0 + effPad);
            if (minDy <= maxDy) {
                dyLocal = Math.max(minDy, Math.min(maxDy, dyLocal));
            }
        }

        // --- TRỤC X: CĂN CẢN XE (BUMPER DOMINANCE THEO CHUẨN THUẬT TOÁN KIỆT) ---
        const targetRearX = (rX !== null && rX !== undefined) ? rX : ex0;
        const targetFrontX = (fX !== null && fX !== undefined) ? fX : ex1;

        if (normSx < -0.15) {
            // Cản sau đón tia (-X): Neo cản sau tại rX - effPad, bung L về trước (+X)
            const xRearTarget = targetRearX - effPad;
            dxLocal = xRearTarget - (-L / 2.0);
        } else if (normSx > 0.15) {
            // Cản trước đón tia (+X): Neo cản trước tại fX + effPad, bung L về sau (-X)
            const xFrontTarget = targetFrontX + effPad;
            dxLocal = xFrontTarget - (L / 2.0);
        } else {
            // Chiếu ngang hông (|normSx| <= 0.15) - Vùng mù cản:
            // Căn tâm đối xứng theo 2 mép cản (chuẩn 100% Python gốc của Kiệt)
            dxLocal = 0.5 * (ex0 + ex1);
        }

        // Ràng buộc bao phủ toàn thân: nếu cả 2 đầu thân xe (ex1 - ex0) nằm vừa trong L, giữ dxLocal sao cho không đầu nào bị lòi ra
        if (ex1 > ex0 && (ex1 - ex0) <= L + 2.0 * effPad) {
            const minDx = ex1 - (L / 2.0 + effPad);
            const maxDx = ex0 + (L / 2.0 + effPad);
            if (minDx <= maxDx) {
                dxLocal = Math.max(minDx, Math.min(maxDx, dxLocal));
            }
        }

        // Khống chế bước dịch chuyển an toàn
        const constLimX = Math.max(0.15, maxShift);
        const constLimY = Math.max(0.15, maxShift);
        dxLocal = Math.max(-constLimX, Math.min(constLimX, dxLocal));
        dyLocal = Math.max(-constLimY, Math.min(constLimY, dyLocal));

        return { dx: dxLocal, dy: dyLocal };
    }

    /**
     * TRÍCH XUẤT ĐIỂM THÂN XE BẰNG BIG CUBOID NUỐT XE (K = 1.45 THEO CHUẨN THUẬT TOÁN KIỆT)
     * - Khi isBigCuboid = true (Vòng quét đầu tiên):
     *   Tạo Big Cuboid phóng to theo chuẩn Kiệt (bán kính limY ~ 2.3m, limX ~ 3.6m).
     *   Nuốt trọn toàn bộ xe thật dù box ban đầu bị vẽ bóp nhỏ, kéo lệch hoặc sai vị trí.
     *   Không lọc chặt theo tâm cuboid để giữ trọn vách đón tia LiDAR.
     * - Khi isBigCuboid = false (Các vòng tinh chỉnh sau):
     *   Siết chặt margin (limY = W/2 + 0.12m, limX = L/2 + 0.20m) để bảo vệ tuyệt đối chống nuốt xe làn bên cạnh.
     */
    static trichXuatDiemThanXeCatLop(pts, cx, cy, cz, rx, ry, rz, L, W, H, bo14Duoi = true, marginX = 0.20, marginY = 0.12, isBigCuboid = false) {
        if (!pts || pts.length === 0) return { xp: [], yp: [], zp: [] };

        // 1. Ma trận quay 3D chuẩn Euler XYZ từ góc người dùng căn tay
        const rotMat = this.eulerXYZToMatrix(rx || 0, ry || 0, rz || 0);

        const effL = Math.max(2.50, Math.min(14.0, L));
        const effW = Math.max(0.80, Math.min(3.20, W));
        const effH = Math.max(0.80, Math.min(4.20, H));

        // 2. Giới hạn lát cắt độ cao Z: Bỏ đoạn gầm để loại bỏ mặt đường và chặn trần chống cành cây
        let zMinSlice = -effH / 2.0 + (bo14Duoi && effH >= 0.8 ? (effH / 4.0) : 0.05);
        let zMaxSlice = effH / 2.0 + 0.15; // Không quét quá nóc xe 15cm

        // 3. Khống chế Search Margin:
        // - Nếu là Big Cuboid nuốt xe: nới rộng bán kính bằng k = 1.45 (hoặc nới tối thiểu 1.35m)
        // - Nếu là vòng tinh chỉnh: ôm sát tâm cuboid (+12cm) chống nuốt xe làn bên cạnh
        let limX = effL / 2.0 + (marginX !== undefined ? marginX : 0.20);
        let limY = effW / 2.0 + (marginY !== undefined ? marginY : 0.12);

        if (isBigCuboid) {
            limX = Math.max(effL * 0.75, effL / 2.0 + Math.max(1.35, marginX || 0));
            limY = Math.max(effW * 0.75, effW / 2.0 + Math.max(1.35, marginY || 0));
        }

        const rawCandidates = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const dx = p[0] - cx;
            const dy = p[1] - cy;
            const dz = p[2] - cz;

            const lx = dx * rotMat[0][0] + dy * rotMat[1][0] + dz * rotMat[2][0];
            const ly = dx * rotMat[0][1] + dy * rotMat[1][1] + dz * rotMat[2][1];
            const lz = dx * rotMat[0][2] + dy * rotMat[1][2] + dz * rotMat[2][2];

            if (Math.abs(lx) <= limX && Math.abs(ly) <= limY && lz >= zMinSlice && lz <= zMaxSlice) {
                rawCandidates.push([lx, ly, lz]);
            }
        }

        // Fallback nới nhẹ Z nếu quá ít điểm
        if (rawCandidates.length < 6 && bo14Duoi && effH >= 0.8) {
            zMinSlice = -effH / 2.0 + 0.08;
            rawCandidates.length = 0;
            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const dx = p[0] - cx;
                const dy = p[1] - cy;
                const dz = p[2] - cz;

                const lx = dx * rotMat[0][0] + dy * rotMat[1][0] + dz * rotMat[2][0];
                const ly = dx * rotMat[0][1] + dy * rotMat[1][1] + dz * rotMat[2][1];
                const lz = dx * rotMat[0][2] + dy * rotMat[1][2] + dz * rotMat[2][2];

                if (Math.abs(lx) <= limX && Math.abs(ly) <= limY && lz >= zMinSlice && lz <= zMaxSlice) {
                    rawCandidates.push([lx, ly, lz]);
                }
            }
        }

        if (rawCandidates.length < 4) {
            return {
                xp: rawCandidates.map(p => p[0]),
                yp: rawCandidates.map(p => p[1]),
                zp: rawCandidates.map(p => p[2])
            };
        }

        // 4. BỘ LỌC CỤM ĐIỂM GẦN TÂM CUBOID:
        // - Khi isBigCuboid = true: Giữ trọn toàn bộ cụm điểm để thuật toán cắt lớp tìm vách đón tia LiDAR thật!
        // - Khi isBigCuboid = false: Chỉ giữ điểm gần tâm cuboid (|ly| <= W/2 + marginY) để chống nuốt xe làn bên cạnh.
        if (isBigCuboid) {
            return {
                xp: rawCandidates.map(p => p[0]),
                yp: rawCandidates.map(p => p[1]),
                zp: rawCandidates.map(p => p[2])
            };
        }

        const maxDistCenterY = effW / 2.0 + (marginY !== undefined ? marginY : 0.12);
        const validCarPts = rawCandidates.filter(p => Math.abs(p[1]) <= maxDistCenterY);

        const finalPts = validCarPts.length >= 4 ? validCarPts : rawCandidates;

        return {
            xp: finalPts.map(p => p[0]),
            yp: finalPts.map(p => p[1]),
            zp: finalPts.map(p => p[2])
        };
    }

    /**
     * THUẬT TOÁN ÉP SÁT THÂN XE BẰNG CẮT LỚP (Pure Density Slicing) CHO 1 FRAME
     */
    static epSatThanXeCatLopFrame(pos, rot, size, pts, pad = 0.05, maxShift = 0.95) {
        const cx = pos[0], cy = pos[1], cz = pos[2];
        const rx = rot[0], ry = rot[1], rz = rot[2];
        const L = size[0], W = size[1], H = size[2];

        const { xp, yp, zp } = this.trichXuatDiemThanXeCatLop(pts, cx, cy, cz, rx, ry, rz, L, W, H, true);
        if (xp.length < 4) {
            return { newPos: [cx, cy, cz], dx: 0, dy: 0, nPts: xp.length };
        }

        // Vector từ tâm xe tới cảm biến LiDAR (0,0,0) trong hệ tọa độ cục bộ của xe
        // V_local = (-P_car) . R
        const cosRz = Math.cos(-rz);
        const sinRz = Math.sin(-rz);
        const sx = cosRz * (-cx) - sinRz * (-cy);
        const sy = sinRz * (-cx) + cosRz * (-cy);

        // 1. Quét tìm mép ngoài bằng Cắt Lớp Mật Độ Thuần Túy (Pure Density Slicing)
        let ex0 = null, ex1 = null, ey0 = null, ey1 = null;
        if (sx < -0.5) ex0 = this.findEdgeByLayerSlicing(xp, -1, L / 2.0);
        if (sx > 0.5)  ex1 = this.findEdgeByLayerSlicing(xp, 1, L / 2.0);
        if (sy < -0.4) ey0 = this.findEdgeByLayerSlicing(yp, -1, W / 2.0);
        if (sy > 0.4)  ey1 = this.findEdgeByLayerSlicing(yp, 1, W / 2.0);

        // Fallback sang Multi-layer Histogram nếu lát cắt thuần túy bị khuất hoặc thưa
        const histX = this.timMepNgoaiCumDiem(xp, sx < -0.8, sx > 0.8, true);
        const histY = this.timMepNgoaiCumDiem(yp, sy < -0.5, sy > 0.5, true);

        if (ex0 === null) ex0 = histX.edgeMin;
        if (ex1 === null) ex1 = histX.edgeMax;
        if (ey0 === null) ey0 = histY.edgeMin;
        if (ey1 === null) ey1 = histY.edgeMax;

        // 2. Tính độ dịch chuyển (dx, dy) với khoảng đệm pad = 5cm
        let { dx, dy } = this.tinhDxDyMep(ex0, ex1, ey0, ey1, L, W, sx, sy, pad, true, maxShift);

        dx = Math.max(-maxShift, Math.min(maxShift, dx));
        dy = Math.max(-maxShift, Math.min(maxShift, dy));

        // Chuyển dịch chuyển cục bộ [dx, dy] sang tọa độ toàn cục
        const cosZ = Math.cos(rz);
        const sinZ = Math.sin(rz);
        const gDx = cosZ * dx - sinZ * dy;
        const gDy = sinZ * dx + cosZ * dy;

        return {
            newPos: [cx + gDx, cy + gDy, cz],
            dx,
            dy,
            nPts: xp.length
        };
    }

    /**
     * Làm mượt chuỗi dịch chuyển 1D và nội suy frame thiếu (Median Filter Window)
     */
    static lamMuotChuoi1D(arr, validMask, window = 5) {
        const n = arr.length;
        if (n === 0) return [];
        const res = [...arr];
        const validIdx = [];
        for (let i = 0; i < n; i++) {
            if (validMask[i]) validIdx.push(i);
        }
        if (validIdx.length === 0) return new Array(n).fill(0);
        if (validIdx.length === 1) return new Array(n).fill(arr[validIdx[0]]);

        // Nội suy tuyến tính
        for (let i = 0; i < n; i++) {
            if (!validMask[i]) {
                if (i <= validIdx[0]) {
                    res[i] = arr[validIdx[0]];
                } else if (i >= validIdx[validIdx.length - 1]) {
                    res[i] = arr[validIdx[validIdx.length - 1]];
                } else {
                    let prevI = validIdx[0], nextI = validIdx[validIdx.length - 1];
                    for (let k = 0; k < validIdx.length; k++) {
                        if (validIdx[k] < i) prevI = validIdx[k];
                        if (validIdx[k] > i) { nextI = validIdx[k]; break; }
                    }
                    const alpha = (i - prevI) / (nextI - prevI);
                    res[i] = (1 - alpha) * arr[prevI] + alpha * arr[nextI];
                }
            }
        }

        // Lọc trung vị
        const smoothed = [];
        const half = Math.floor(window / 2);
        for (let i = 0; i < n; i++) {
            const s = Math.max(0, i - half);
            const e = Math.min(n, i + half + 1);
            const w = res.slice(s, e).sort((a, b) => a - b);
            smoothed.push(w[Math.floor(w.length / 2)]);
        }
        return smoothed;
    }

    /**
     * Sinh đám mây điểm CAD chuẩn xác của thân xe để cắt lớp khi chưa tải PCD từ server
     */
    static sinhDiemCadThoiGianThuc(pos, rot, size, seed = 0) {
        const cx = pos[0], cy = pos[1], cz = pos[2];
        const rz = rot[2];
        const L = size[0], W = size[1], H = size[2];
        const hl = L / 2, hw = W / 2, hh = H / 2;

        let s = (Math.abs(seed) + 1) * 9301 + 49297;
        function rnd() {
            s = (s * 9301 + 49297) % 233280;
            return s / 233280;
        }

        const pts = [];
        // [v2.3.5] MÔ PHỎNG LASER ĐA TẦNG SIÊU THỰC (~1080 ĐIỂM, 760 ĐIỂM TRONG BOX)
        // 1. Nóc xe & Mui xe
        for (let i = 0; i < 140; i++) {
            const u = hl * (-0.50 + 0.55 * rnd());
            const v = hw * (rnd() * 1.6 - 0.8);
            const w = hh - H * 0.05 * rnd();
            pts.push([u, v, w, 240, 245, 255]);
        }
        // 2. Kính chắn gió trước
        for (let i = 0; i < 90; i++) {
            const t = rnd();
            const u = hl * (0.35 - 0.30 * t);
            const v = hw * (rnd() * 1.6 - 0.8);
            const w = -hh + H * (0.50 + 0.45 * t);
            pts.push([u, v, w, 220, 238, 255]);
        }
        // 3. Nắp ca-pô & Cản trước
        for (let i = 0; i < 130; i++) {
            const u = hl * (0.35 + 0.63 * rnd());
            const v = hw * (rnd() * 1.8 - 0.9);
            const w = -hh + H * (0.35 + 0.15 * rnd());
            pts.push([u, v, w, 235, 242, 252]);
        }
        // 4. Kính sau & Cốp sau
        for (let i = 0; i < 110; i++) {
            const t = rnd();
            const u = hl * (-0.50 - 0.45 * t);
            const v = hw * (rnd() * 1.7 - 0.85);
            const w = -hh + H * (0.32 + 0.55 * (1 - t));
            pts.push([u, v, w, 225, 235, 250]);
        }
        // 5. Hai bên sườn xe
        for (let i = 0; i < 220; i++) {
            const u = hl * (rnd() * 1.94 - 0.97);
            const sign = rnd() > 0.5 ? 1 : -1;
            const v = sign * hw * (0.92 + 0.08 * rnd());
            const w = -hh + H * (0.12 + 0.78 * rnd());
            pts.push([u, v, w, 230, 238, 250]);
        }
        // 6. Cản trước, cản sau
        for (let i = 0; i < 70; i++) {
            const sign = rnd() > 0.5 ? 1 : -1;
            const u = sign * hl * (0.95 + 0.05 * rnd());
            const v = hw * (rnd() * 1.8 - 0.9);
            const w = -hh + H * (0.20 + 0.35 * rnd());
            pts.push([u, v, w, 245, 250, 255]);
        }
        // 7. Mặt đường LiDAR rings
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

        const cosZ = Math.cos(rz);
        const sinZ = Math.sin(rz);
        const globalPts = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const gx = cx + cosZ * p[0] - sinZ * p[1];
            const gy = cy + sinZ * p[0] + cosZ * p[1];
            const gz = cz + p[2];
            const pr = p[3] || 235, pg = p[4] || 240, pb = p[5] || 250;
            globalPts.push([gx, gy, gz, pr, pg, pb]);
        }
        return globalPts;
    }

    /**
     * THUẬT TOÁN CŨ ÉP SÁT THÂN XE BẰNG CẮT LỚP CHO 1 TRACK XE Ô TÔ (VEHICLES)
     * Đồng bộ chuẩn bản EXE: Slicing Z (bỏ 1/4 gầm) + Pure Density Slicing (3cm) + Anchor 2cm + Trajectory Smoothing
     */
    static epSatThanXeCatLopTrack(track, pcdsMap = null, pad = 0.05) {
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        const validShapes = (track.shapes || []).filter(s => s.points && s.points.length >= 9);
        if (validShapes.length === 0) return false;

        const activeShapes = validShapes.filter(s => !s.outside);
        const shapesToUse = activeShapes.length > 0 ? activeShapes : validShapes;

        // 1. Đo kích thước trung vị & Khóa Prior xe ô tô
        const ls = shapesToUse.map(s => s.points[6]).sort((a, b) => a - b);
        const ws = shapesToUse.map(s => s.points[7]).sort((a, b) => a - b);
        const hs = shapesToUse.map(s => s.points[8]).sort((a, b) => a - b);
        const origL = ls[Math.floor(ls.length / 2)];
        const origW = ws[Math.floor(ws.length / 2)];
        const origH = hs[Math.floor(hs.length / 2)];

        const prior = this.snapKichThuocPrior('vehicles', origL, origW, origH);
        for (const s of validShapes) {
            const oldH = s.points[8];
            s.points[6] = prior.L;
            s.points[7] = prior.W;
            s.points[8] = prior.H;
            // Bảo toàn mặt đáy khi thay đổi chiều cao
            s.points[2] = (s.points[2] - oldH / 2.0) + (prior.H / 2.0);
        }

        // 2. Khử lật góc 180°
        this.khuLatGocTrack(track);

        // 3. Khớp và bảo tồn dốc mặt đường Z
        this.khopMatDuongTrack(track, 0, pcdsMap);

        // 4. Thuật toán Cắt Lớp Ép Sát Thân Xe trên từng frame
        const dxs = [];
        const dys = [];
        const validMask = [];

        shapesToUse.sort((a, b) => a.frame - b.frame);

        for (const s of shapesToUse) {
            const fn = s.frame;
            let pts = this.layDiemTuPcdsMap(pcdsMap, fn);

            const pos = [s.points[0], s.points[1], s.points[2]];
            const rot = [s.points[3], s.points[4], s.points[5]];
            const size = [s.points[6], s.points[7], s.points[8]];

            if (!pts || pts.length === 0) {
                pts = this.sinhDiemCadThoiGianThuc(pos, rot, size, fn);
            }

            const res = this.epSatThanXeCatLopFrame(pos, rot, size, pts, pad, 0.95);
            if (res && res.nPts >= 4) {
                dxs.push(res.dx);
                dys.push(res.dy);
                validMask.push(true);
            } else {
                dxs.push(0);
                dys.push(0);
                validMask.push(false);
            }
        }

        // 5. Làm mượt chuỗi dịch chuyển (dx, dy) bằng Median Filter
        const smoothedDx = this.lamMuotChuoi1D(dxs, validMask, 5);
        const smoothedDy = this.lamMuotChuoi1D(dys, validMask, 5);

        for (let i = 0; i < shapesToUse.length; i++) {
            const s = shapesToUse[i];
            const rz = s.points[5];
            const dx = smoothedDx[i];
            const dy = smoothedDy[i];

            const cosZ = Math.cos(rz);
            const sinZ = Math.sin(rz);
            s.points[0] += (cosZ * dx - sinZ * dy);
            s.points[1] += (sinZ * dx + cosZ * dy);
        }

        // 6. Làm mượt lại quỹ đạo tổng thể một lần cuối
        this.lamMuotQuyDaoTrack(track);

        return true;
    }

    /**
     * CĂN CHỈNH TRACK XE HAI BÁNH V2.0 (TWO-WHEELS)
     * - Khóa kích thước Prior: L=1.90, W=0.80, H=1.45 (hoặc 1.75x0.65x1.50 cho xe đạp)
     * - Bù trọng tâm người lái: Đẩy tâm hộp tiến lên phía trước +0.18m
     * - Không cắt 1/4 gầm để giữ 100% điểm bánh xe và pô xe
     * - Ghim đáy hộp sát mặt đường (Z_bottom = Z_road - 0.01m)
     * - Khử lật góc 180° và làm mượt quỹ đạo tâm
     */
        /**
     * THUẬT TOÁN MASTER: CĂN CHỈNH TRACK THEO THỨ TỰ ƯU TIÊN (ĐỒNG BỘ 100% DESKTOP EXE)
     * Quy trình 4 bước chuẩn xác:
     * 1. Khử Z-Spike (>0.35m) & Khớp mặt đường RANSAC + Trích xuất cụm điểm sạch thân xe
     * 2. Đo kích thước thực tế từ cụm điểm ở các frame nhìn rõ (80th percentile) & Khóa cứng (L*, W*, H*)
     *    đồng thời bù độ cao tâm Z theo (H* - orig_H)/2 để đáy hộp luôn tiếp xúc chuẩn mặt đường
     * 3. Căn chỉnh vị trí 3 bước (Pass 1 mượt quỹ đạo + Pass 2 khóa mép 2cm + Pass 3 kiểm chứng bao bọc
     *    kèm Zero-Leakage Enclosure Guardrail bảo vệ tuyệt đối đuôi và sườn xe)
     * 4. Nội suy tuyến tính SLERP vị trí & hướng cho các frame khuất/ít điểm (< 8 điểm)
     */
    /**
     * RANSAC 2D tìm đường thẳng thống trị (Dominant Line) trên mặt phẳng XY:
     * - Trả về { angleRad, inliersCount, spanLen }
     * - angleRad là góc nghiêng so với trục X cục bộ [-pi/2, pi/2]
     */
        /**
     * Tính góc xoay chéo dYaw của thân xe bằng kết hợp PCA và RANSAC:
     * - PCA tìm hướng trục chính thống trị của đám mây điểm vỏ xe.
     * - RANSAC xác minh trên sườn xe để khử nhiễu ngoại lai.
     * - Trả về dYaw (radian) trong khoảng [-20°, +20°].
     */
    static tinhGocCheoXePcaRansac(locPts, L, W, H, trackRefYaw = null) {
        if (!locPts || locPts.length < 25) return 0.0;

        // Lấy điểm thân xe trong dải độ cao hợp lý
        const pBody = [];
        let minX = Infinity, maxX = -Infinity;
        let minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < locPts.length; i++) {
            const pt = locPts[i];
            if (Math.abs(pt[0]) <= L / 2.0 + 0.60 &&
                Math.abs(pt[1]) <= W / 2.0 + 0.40 &&
                Math.abs(pt[2]) <= H * 0.45) {
                pBody.push(pt);
                if (pt[0] < minX) minX = pt[0];
                if (pt[0] > maxX) maxX = pt[0];
                if (pt[1] < minY) minY = pt[1];
                if (pt[1] > maxY) maxY = pt[1];
            }
        }
        if (pBody.length < 25) return 0.0;

        const spanX = maxX - minX;
        const spanY = maxY - minY;

        // RÀNG BUỘC NGẶT NGHÈO (ANTI-DRIFT GUARD):
        // Bắt buộc phải có điểm trải dài theo trục X tối thiểu 2.50m và tỉ lệ spanX / spanY >= 1.6
        // Nếu điểm chỉ tập trung ở cản sau hoặc góc đuôi xe -> TUYỆT ĐỐI KHÔNG SỬA GÓC để tránh bão xoay xéo góc!
        if (spanX < 2.50 || (spanY > 0 && spanX / spanY < 1.60)) {
            return 0.0;
        }

        try {
            // RANSAC trên sườn xe (|y| >= 0.22 * W)
            const ptsFlank = [];
            for (let i = 0; i < pBody.length; i++) {
                if (Math.abs(pBody[i][1]) >= 0.22 * W) {
                    ptsFlank.push([pBody[i][0], pBody[i][1]]);
                }
            }

            if (ptsFlank.length >= 15) {
                const resR = this.fitRansacLine2D(ptsFlank, 0.035, 60);
                if (resR.angleRad !== null && resR.spanLen >= 1.80) {
                    let ang = resR.angleRad;
                    if (ang > Math.PI / 2.0) ang -= Math.PI;
                    else if (ang < -Math.PI / 2.0) ang += Math.PI;

                    // Khống chế góc lệch tối đa trong dải cực hẹp: +- 2.5 độ (0.044 rad)
                    const maxRad = (2.5 * Math.PI) / 180.0;
                    if (Math.abs(ang) <= maxRad) {
                        return ang;
                    }
                }
            }
        } catch (e) {}

        return 0.0;
    }


    static fitRansacLine2D(xyPts, distThresh = 0.035, maxIters = 60) {
        if (!xyPts || xyPts.length < 8) {
            return { angleRad: null, inliersCount: 0, spanLen: 0.0 };
        }
        let bestInliers = [];
        let bestLine = null;
        const n = xyPts.length;

        for (let iter = 0; iter < maxIters; iter++) {
            const idx1 = Math.floor(Math.random() * n);
            let idx2 = Math.floor(Math.random() * n);
            while (idx2 === idx1) idx2 = Math.floor(Math.random() * n);

            const p1 = xyPts[idx1];
            const p2 = xyPts[idx2];
            const vx = p2[0] - p1[0];
            const vy = p2[1] - p1[1];
            const vLen = Math.hypot(vx, vy);
            if (vLen < 0.25) continue;

            const vDir = [vx / vLen, vy / vLen];
            const nVec = [-vDir[1], vDir[0]];

            const curInliers = [];
            for (let i = 0; i < n; i++) {
                const pt = xyPts[i];
                const d = Math.abs((pt[0] - p1[0]) * nVec[0] + (pt[1] - p1[1]) * nVec[1]);
                if (d <= distThresh) {
                    curInliers.push(i);
                }
            }

            if (curInliers.length > bestInliers.length) {
                bestInliers = curInliers;
                bestLine = { p1, vDir };
            }
        }

        if (bestInliers.length < 8 || !bestLine) {
            return { angleRad: null, inliersCount: bestInliers.length, spanLen: 0.0 };
        }

        const { p1, vDir } = bestLine;
        let minProj = Infinity;
        let maxProj = -Infinity;
        for (const idx of bestInliers) {
            const pt = xyPts[idx];
            const proj = (pt[0] - p1[0]) * vDir[0] + (pt[1] - p1[1]) * vDir[1];
            if (proj < minProj) minProj = proj;
            if (proj > maxProj) maxProj = proj;
        }
        const spanLen = Math.max(0.0, maxProj - minProj);

        let angle = Math.atan2(vDir[1], vDir[0]);
        if (angle > Math.PI / 2.0) angle -= Math.PI;
        else if (angle < -Math.PI / 2.0) angle += Math.PI;

        return { angleRad: angle, inliersCount: bestInliers.length, spanLen };
    }



    /**
     * TỐI ƯU HÓA GÓC XOAY YAW (COARSE-TO-FINE L-SHAPE HISTOGRAM SWEEP + BITMASK SPAN + TLS)
     * Đồng bộ nguyên bản từ lõi Auto fit box v3.1
     */
    static quetGocYawToiUu(pts2D, L, W, searchMargin = 1.40) {
        if (!pts2D || pts2D.length < 8) return 0.0;
        const n = pts2D.length;

        const X = new Float32Array(n);
        const Y = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            X[i] = pts2D[i][0];
            Y[i] = pts2D[i][1];
        }

        const R = Math.max(L / 2.0 + searchMargin, W / 2.0 + searchMargin);
        const binSize = 0.05;
        const B = Math.min(510, Math.ceil((2 * R) / binSize) + 2);

        const NUM_COARSE = 45;
        const HU = new Int32Array(B + 4);
        const HV = new Int32Array(B + 4);

        let bestCoarseScore = -1;
        let bestCoarseRad = 0.0;

        for (let k = 0; k < NUM_COARSE; k++) {
            const rad = (k * 2.0 * Math.PI) / 180.0;
            const c = Math.cos(rad);
            const s = Math.sin(rad);

            HU.fill(0);
            HV.fill(0);

            for (let i = 0; i < n; i++) {
                const u = X[i] * c + Y[i] * s;
                const v = -X[i] * s + Y[i] * c;
                const bu = Math.floor((u + R) / binSize);
                const bv = Math.floor((v + R) / binSize);
                if (bu >= 0 && bu < B) HU[bu]++;
                if (bv >= 0 && bv < B) HV[bv]++;
            }

            let pu = 0, pv = 0;
            for (let b = 0; b < B - 1; b++) {
                const winU = HU[b] + HU[b + 1];
                if (winU > pu) pu = winU;
                const winV = HV[b] + HV[b + 1];
                if (winV > pv) pv = winV;
            }

            const score = (1 + pu) * (1 + pv);
            if (score > bestCoarseScore) {
                bestCoarseScore = score;
                bestCoarseRad = rad;
            }
        }

        const fineStep = (0.25 * Math.PI) / 180.0;
        let bestFineScore = bestCoarseScore;
        let bestFineRad = bestCoarseRad;

        for (let stepIdx = -8; stepIdx <= 8; stepIdx++) {
            if (stepIdx === 0) continue;
            const rad = bestCoarseRad + stepIdx * fineStep;
            const c = Math.cos(rad);
            const s = Math.sin(rad);

            HU.fill(0);
            HV.fill(0);

            for (let i = 0; i < n; i++) {
                const u = X[i] * c + Y[i] * s;
                const v = -X[i] * s + Y[i] * c;
                const bu = Math.floor((u + R) / binSize);
                const bv = Math.floor((v + R) / binSize);
                if (bu >= 0 && bu < B) HU[bu]++;
                if (bv >= 0 && bv < B) HV[bv]++;
            }

            let pu = 0, pv = 0;
            for (let b = 0; b < B - 1; b++) {
                const winU = HU[b] + HU[b + 1];
                if (winU > pu) pu = winU;
                const winV = HV[b] + HV[b + 1];
                if (winV > pv) pv = winV;
            }

            const score = (1 + pu) * (1 + pv);
            if (score > bestFineScore) {
                bestFineScore = score;
                bestFineRad = rad;
            }
        }

        const cBest = Math.cos(bestFineRad);
        const sBest = Math.sin(bestFineRad);
        const uBest = new Float32Array(n);
        const vBest = new Float32Array(n);

        for (let i = 0; i < n; i++) {
            uBest[i] = X[i] * cBest + Y[i] * sBest;
            vBest[i] = -X[i] * sBest + Y[i] * cBest;
        }

        const spanU = this.tinhDoPhuVach(vBest, uBest, n, 0.08, R);
        const spanV = this.tinhDoPhuVach(uBest, vBest, n, 0.08, R);

        let costA = 0.0, costB = 0.0;
        const halfW = W / 2.0;
        const halfL = L / 2.0;

        for (let i = 0; i < n; i++) {
            const latA = Math.abs(vBest[i]), lonA = Math.abs(uBest[i]);
            if (latA > halfW) costA += (latA - halfW) * (latA - halfW);
            if (lonA > halfL) costA += (lonA - halfL) * (lonA - halfL);

            const latB = Math.abs(uBest[i]), lonB = Math.abs(vBest[i]);
            if (latB > halfW) costB += (latB - halfW) * (latB - halfW);
            if (lonB > halfL) costB += (lonB - halfL) * (lonB - halfL);
        }

        let thetaAligned = bestFineRad;

        if (Math.abs(costA - costB) > 0.05) {
            thetaAligned = (costB < costA) ? bestFineRad + Math.PI / 2.0 : bestFineRad;
        } else {
            let sumU = 0.0, sumV = 0.0;
            for (let i = 0; i < n; i++) {
                sumU += uBest[i];
                sumV += vBest[i];
            }
            const meanU = sumU / n;
            const meanV = sumV / n;
            const absMeanU = Math.abs(meanU);
            const absMeanV = Math.abs(meanV);

            const threshOffset = (W / 2.0 + L / 2.0) / 2.0;
            if (spanU >= 0.8 && spanV < 0.8) {
                thetaAligned = (absMeanV >= threshOffset) ? bestFineRad + Math.PI / 2.0 : bestFineRad;
            } else if (spanV >= 0.8 && spanU < 0.8) {
                thetaAligned = (absMeanU >= threshOffset) ? bestFineRad : bestFineRad + Math.PI / 2.0;
            } else if (spanU > spanV + 0.35) {
                thetaAligned = bestFineRad;
            } else if (spanV > spanU + 0.35) {
                thetaAligned = bestFineRad + Math.PI / 2.0;
            } else {
                let d1 = Math.abs(this.wrapToPi(bestFineRad));
                if (d1 > Math.PI / 2.0) d1 = Math.abs(d1 - Math.PI);
                let d2 = Math.abs(this.wrapToPi(bestFineRad + Math.PI / 2.0));
                if (d2 > Math.PI / 2.0) d2 = Math.abs(d2 - Math.PI);
                thetaAligned = (d2 < d1) ? bestFineRad + Math.PI / 2.0 : bestFineRad;
            }
        }

        let dYaw = thetaAligned;
        while (dYaw > Math.PI / 2.0) dYaw -= Math.PI;
        while (dYaw < -Math.PI / 2.0) dYaw += Math.PI;

        try {
            const cFinal = Math.cos(dYaw);
            const sFinal = Math.sin(dYaw);
            const uRot = new Float32Array(n);
            const vRot = new Float32Array(n);
            for (let i = 0; i < n; i++) {
                uRot[i] = X[i] * cFinal + Y[i] * sFinal;
                vRot[i] = -X[i] * sFinal + Y[i] * cFinal;
            }

            const leftU = [], leftV = [];
            const rightU = [], rightV = [];
            for (let i = 0; i < n; i++) {
                if (Math.abs(uRot[i]) > L / 2.0 - 0.25) continue;
                if (Math.abs(vRot[i] - W / 2.0) <= 0.18) {
                    leftU.push(uRot[i]);
                    leftV.push(vRot[i]);
                } else if (Math.abs(vRot[i] + W / 2.0) <= 0.18) {
                    rightU.push(uRot[i]);
                    rightV.push(vRot[i]);
                }
            }

            const flankU = leftU.length >= rightU.length ? leftU : rightU;
            const flankV = leftU.length >= rightU.length ? leftV : rightV;

            if (flankU.length >= 6) {
                const tlsCorr = this.fitTls2D(flankU, flankV);
                if (Math.abs(tlsCorr) < 0.08) {
                    dYaw += tlsCorr;
                }
            } else {
                const bumperU = [], bumperV = [];
                const maxVCorner = Math.max(0.30, W / 2.0 - 0.18);
                for (let i = 0; i < n; i++) {
                    if ((Math.abs(uRot[i] + L / 2.0) <= 0.35 || Math.abs(uRot[i] - L / 2.0) <= 0.35) && Math.abs(vRot[i]) <= maxVCorner) {
                        bumperU.push(uRot[i]);
                        bumperV.push(vRot[i]);
                    }
                }
                if (bumperU.length >= 6) {
                    const tlsCorr = this.fitTls2D(bumperV, bumperU);
                    if (Math.abs(tlsCorr) < 0.08) {
                        dYaw -= tlsCorr;
                    }
                }
            }
        } catch (e) {}

        while (dYaw > Math.PI / 2.0) dYaw -= Math.PI;
        while (dYaw < -Math.PI / 2.0) dYaw += Math.PI;
        return dYaw;
    }

    static tinhDoPhuVach(axisNormal, axisParallel, n, halfBand = 0.08, R = 5.0) {
        const colSize = Math.max(0.25, (2.0 * R) / 30.0);
        const colOrigin = -16.0 * colSize;
        const numCols = 32;
        let once = 0, twice = 0;

        for (let i = 0; i < n; i++) {
            const col = Math.floor((axisParallel[i] - colOrigin) / colSize);
            if (col >= 0 && col < numCols) {
                const bit = 1 << col;
                twice |= (once & bit);
                once |= bit;
            }
        }

        let countTwice = 0, tempT = twice;
        while (tempT) { countTwice += tempT & 1; tempT >>>= 1; }

        let spanT = 0;
        if (twice !== 0) {
            const hi = 31 - Math.clz32(twice);
            const lo = 31 - Math.clz32(twice & -twice);
            spanT = (hi - lo + 1) * colSize;
        }

        let countOnce = 0, tempO = once;
        while (tempO) { countOnce += tempO & 1; tempO >>>= 1; }

        let spanO = 0;
        if (once !== 0) {
            const hi = 31 - Math.clz32(once);
            const lo = 31 - Math.clz32(once & -once);
            spanO = (hi - lo + 1) * colSize;
        }

        if (countTwice >= 3 && spanT >= 1.75) return spanT;
        if (countOnce >= 3) return spanO;
        return Math.max(spanT, spanO);
    }

    static fitTls2D(uVals, vVals) {
        const n = uVals.length;
        if (n < 4) return 0.0;

        let sumU = 0, sumV = 0;
        for (let i = 0; i < n; i++) {
            sumU += uVals[i];
            sumV += vVals[i];
        }
        const meanU = sumU / n;
        const meanV = sumV / n;

        let Suv = 0, Suu = 0, Svv = 0;
        for (let i = 0; i < n; i++) {
            const du = uVals[i] - meanU;
            const dv = vVals[i] - meanV;
            Suu += du * du;
            Svv += dv * dv;
            Suv += du * dv;
        }

        if (Math.abs(Suu - Svv) < 1e-6 && Math.abs(Suv) < 1e-6) return 0.0;
        return 0.5 * Math.atan2(2 * Suv, Suu - Svv);
    }

    // =========================================================================
    // 4 TÍNH NĂNG CĂN CHỈNH ĐƠN LẺ TÁCH TRỰC TIẾP TỪ LÕI AUTO FIT BOX
    // =========================================================================

    /**
     * 1. CĂN MẶT ĐƯỜNG RIÊNG LẺ (Tách nguyên bản từ Pha Mặt Đường của Auto fit box)
     * - Chạy canChinhMatDuongHop (ma trận phẳng ngang rotMatLevel + RANSAC 3D mặt đường + hạ khít lốp 1.2cm)
     * - Làm mượt trung vị trượt 3-frame cho cao độ đáy zBottom giữa các frame liền kề
     * - Chỉ cập nhật [z, rx, ry], bảo toàn tuyệt đối [x, y, rz, L, W, H] và các frame ngoài targetFrames
     */
    static canChinhMatDuongRiengLe(track, pcdsMap, targetFrames = null, opts = null) {
        if (!track || !Array.isArray(track.shapes)) return 0;
        if (targetFrames && !(targetFrames instanceof Set)) targetFrames = new Set(targetFrames);

        const kho = (opts && opts.khoDuyet) || (typeof window !== 'undefined' && window.khoDuyet) || (typeof globalThis !== 'undefined' && globalThis.khoDuyet) || null;
        const Neo = (opts && opts.NeoDuyet) || (typeof window !== 'undefined' && window.NeoDuyet) || (typeof globalThis !== 'undefined' && globalThis.NeoDuyet) || null;
        const allTracks = (opts && Array.isArray(opts.allTracks)) ? opts.allTracks : null;
        const tKey = kho ? kho.trackKey(track) : null;
        const approvedSet = new Set();

        const activeShapes = track.shapes
            .filter(s => !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));
        if (activeShapes.length === 0) return 0;

        // Đo mặt đường cho toàn bộ activeShapes (để có ngữ cảnh lân cận làm mượt 3-frame), nhưng chỉ ghi vào targetFrames
        const roadResults = new Map();
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
            const isApp = Boolean(
                kho && kho.batNeo && tKey
                && !(opts && opts.trackKeysMoKhoa && opts.trackKeysMoKhoa.has(tKey))
                && kho.laDaDuyet(tKey, fn, track, { gomTam: opts?.gomTam || null })
            );
            if (isApp) {
                approvedSet.add(fn);
                const pl = Neo ? Neo.matPhangDay(s.points) : null;
                const zB = pl ? pl.zb : (cz - H / 2.0);
                roadResults.set(fn, {
                    zBottom: zB, newRx: rx || 0, newRy: ry || 0,
                    found: true, zRoad: zB, rx: rx || 0, ry: ry || 0, confidence: 1.0, lockedApproved: true
                });
                continue;
            }
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            const neoOpts = (opts && opts.trackKeysMoKhoa && opts.trackKeysMoKhoa.has(tKey))
                ? { ...(opts || {}), excludeSelfFrame: true, excludeTrackKey: tKey, excludeFrame: fn }
                : (opts || {});
            const neoDuyet = (Neo && allTracks && (!kho || kho.batNeo))
                ? Neo.thuThapNeo(allTracks, fn, null, neoOpts)
                : (opts?.neoDuyet || null);
            const hasCarNeo = Array.isArray(neoDuyet) && neoDuyet.some(n => n && n.kind !== 'ego');
            if ((pts && pts.length >= 6) || hasCarNeo) {
                const res = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, H], pts || [], 0.08, hasCarNeo ? { neoDuyet } : null);
                if (res && Array.isArray(res.newPos)) {
                    roadResults.set(fn, {
                        zBottom: res.newPos[2] - H / 2.0,
                        newRx: res.newRot[0],
                        newRy: res.newRot[1],
                        found: Boolean((res.foundPlane && (res.confidence >= 0.35 || res.isDirectPlane)) || hasCarNeo),
                        // Trường cho bộ làm mượt độ cao tương đối
                        zRoad: res.newPos[2] - H / 2.0,
                        rx: res.newRot[0],
                        ry: res.newRot[1],
                        confidence: res.confidence
                    });
                    continue;
                }
            }
            roadResults.set(fn, {
                zBottom: cz - H / 2.0,
                newRx: rx || 0,
                newRy: ry || 0,
                found: false
            });
        }

        // [ĐỘ CAO TƯƠNG ĐỐI] Làm mượt h = zRoad − E_ego dọc quãng đường; BẢO TOÀN 100% độ dốc thật của RANSAC frame
        const smooth = this.lamMuotDoCaoTuongDoiTheoTrack(activeShapes, roadResults, pcdsMap);
        if (smooth) {
            let n = 0;
            for (const s of activeShapes) {
                const fn = Number(s.frame);
                if (approvedSet.has(fn)) continue; // Bất biến chỉ-đọc với frame đã duyệt
                if (targetFrames && !targetFrames.has(fn)) continue;
                const cur = roadResults.get(fn);
                const sm = smooth.get(fn);

                // Nếu RANSAC frame này tìm thấy mặt đất tin cậy: GIỮ NGUYÊN 100% độ dốc thật (rx, ry) tại chỗ xe đứng!
                // Tuyệt đối không để Kalman ép phẳng lì làm hở bánh sau lơ lửng.
                if (cur && cur.found && !(sm && Number.isFinite(sm.zRoad) && Math.abs(cur.zRoad - sm.zRoad) > 0.25 && (cur.confidence || 0) < 0.70)) {
                    s.points[3] = parseFloat(cur.newRx.toFixed(3));
                    s.points[4] = parseFloat(cur.newRy.toFixed(3));
                    let zR = cur.zRoad;
                    if (sm && Number.isFinite(sm.zRoad) && Math.abs(sm.zRoad - cur.zRoad) <= 0.035) {
                        zR = sm.zRoad;
                    }
                    s.points[2] = parseFloat((zR + s.points[8] / 2.0).toFixed(3));
                } else if (sm) {
                    // Frame thưa điểm/ở xa không tìm thấy mặt phẳng: dùng Kalman để lấp chỗ trống
                    s.points[2] = parseFloat((sm.zRoad + s.points[8] / 2.0).toFixed(3));
                    s.points[3] = parseFloat(sm.rx.toFixed(3));
                    s.points[4] = parseFloat(sm.ry.toFixed(3));
                } else {
                    continue;
                }

                if (Array.isArray(s.rotation)) {
                    s.rotation[0] = s.points[3];
                    s.rotation[1] = s.points[4];
                }
                n++;
            }
            return n;
        }

        // Dự phòng (thiếu mô-đun Surface hoặc < 2 mẫu): Làm mượt trung vị 3-frame trên các frame liên tiếp thực sự (|f_i - f_j| <= 2) để khử nhấp nhô ổ gà giống Auto fit box
        let count = 0;
        for (let i = 0; i < activeShapes.length; i++) {
            const s = activeShapes[i];
            const fn = Number(s.frame);
            if (approvedSet.has(fn)) continue;
            if (targetFrames && !targetFrames.has(fn)) continue;
            const cur = roadResults.get(fn);
            if (!cur || !cur.found) continue;

            const winZ = [cur.zBottom];
            if (i > 0 && Math.abs(fn - Number(activeShapes[i - 1].frame)) <= 2) {
                const prev = roadResults.get(Number(activeShapes[i - 1].frame));
                if (prev) winZ.push(prev.zBottom);
            }
            if (i < activeShapes.length - 1 && Math.abs(Number(activeShapes[i + 1].frame) - fn) <= 2) {
                const next = roadResults.get(Number(activeShapes[i + 1].frame));
                if (next) winZ.push(next.zBottom);
            }
            winZ.sort((a, b) => a - b);
            const smoothZBottom = (winZ.length >= 3) ? winZ[1] : cur.zBottom;
            const H = s.points[8];

            s.points[2] = parseFloat((smoothZBottom + H / 2.0).toFixed(3));
            s.points[3] = parseFloat(cur.newRx.toFixed(3));
            s.points[4] = parseFloat(cur.newRy.toFixed(3));
            if (Array.isArray(s.rotation)) {
                s.rotation[0] = s.points[3];
                s.rotation[1] = s.points[4];
            }
            count++;
        }
        return count;
    }

    /**
     * 2. XÁC ĐỊNH CHIỀU CAO RIÊNG LẺ (Tách nguyên bản từ Pha Chiều Cao của Auto fit box)
     * - Đọc hồ sơ kích thước theo thuộc tính CVAT (layKichThuocChuanTheoThuocTinh: HO_SO_XE / HO_SO_HAI_BANH / HO_SO_NGUOI)
     * - Tại mỗi frame có LiDAR: dùng canChinhMatDuongHop tìm zRoadEst & ma trận cân bằng rotMatNew,
     *   lọc điểm trong lòng thân xe và chạy doChieuCaoLeoTangNocXe (dừng ngay khi gặp khe trống 18cm-20cm)
     * - Kẹp chặt trong ngưỡng [minH, maxH] của loại xe (ví dụ car: [1.45m, 1.85m], prior 1.58m -> KHÔNG BAO GIỜ vọt lên trời 3.8m!)
     * - Neo đáy hộp theo mặt đường thực tế (zRoadEst - 0.012m) hoặc mặt đáy cũ nếu không có LiDAR, đảm bảo kể cả khi hộp đang bị kéo vọt lên trời 3.6m thì khi bấm Xác Định Chiều Cao hộp vẫn hạ đỉnh về đúng nóc xe!
     */
    /**
     * BÓC TÁCH NÓC XE CHUẨN XÁC THEO LƯỚI 10x10cm (GRID-BASED ROOF ESTIMATION)
     * - Chia footprint xe thành các ô 10x10cm (u, v)
     * - Mỗi ô lấy đỉnh percentile 95 để khử nhiễu
     * - Histogram các đỉnh ô để tìm mode phẳng nóc xe thực sự (chiếm >= 10% diện tích footprint)
     * - Loại bỏ hoàn toàn sự thiên lệch của sườn xe dày điểm
     */
    static doChieuCaoNocXeLuoi10cm(bodyPtsUVZ, zRoad, L, W, priorH, minH, maxH) {
        if (!bodyPtsUVZ || bodyPtsUVZ.length < 8) return null;
        const gridSize = 0.10;
        const nU = Math.ceil(L / gridSize);
        const nV = Math.ceil(W / gridSize);
        const cells = new Map();

        for (let i = 0; i < bodyPtsUVZ.length; i++) {
            const p = bodyPtsUVZ[i];
            const u = p[0], v = p[1], z = p[2];
            const cu = Math.floor((u + L / 2) / gridSize);
            const cv = Math.floor((v + W / 2) / gridSize);
            if (cu >= 0 && cu < nU && cv >= 0 && cv < nV) {
                const key = cu * 1000 + cv;
                if (!cells.has(key)) cells.set(key, []);
                cells.get(key).push(z);
            }
        }

        if (cells.size < 4) return null;

        const cellTops = [];
        for (const zArr of cells.values()) {
            zArr.sort((a, b) => a - b);
            // Dùng p99 mỗi ô để không tự cắt mất 1-2cm lớp nóc trên cùng
            cellTops.push(zArr[Math.min(zArr.length - 1, Math.floor((zArr.length - 1) * 0.99))]);
        }

        cellTops.sort((a, b) => a - b);
        // Loại bỏ các ô cao bất thường cô lập (tán cây/nhiễu) ở đỉnh: nếu có khe hở > 10cm và chỉ có < 3 ô nằm phía trên
        while (cellTops.length >= 6) {
            const topIdx = cellTops.length - 1;
            let gapIdx = -1;
            for (let i = topIdx; i >= Math.max(1, topIdx - 2); i--) {
                if (cellTops[i] - cellTops[i - 1] > 0.10) {
                    gapIdx = i;
                    break;
                }
            }
            if (gapIdx !== -1 && (cellTops.length - gapIdx) < 3) {
                cellTops.length = gapIdx;
            } else {
                break;
            }
        }

        const zMin = cellTops[0], zMax = cellTops[cellTops.length - 1];
        const binSize = 0.035;
        const nBins = Math.max(2, Math.ceil((zMax - zMin + 0.02) / binSize));
        const hist = new Array(nBins).fill(0);
        for (const z of cellTops) {
            const b = Math.min(nBins - 1, Math.max(0, Math.floor((z - zMin) / binSize)));
            hist[b]++;
        }

        // Dừng ngay ở cụm nóc TRÊN CÙNG đủ hỗ trợ (tuyệt đối không dùng w > maxW làm tụt xuống nắp capo/sườn xe 1.44m!)
        const minCellsForRoof = Math.max(4, Math.floor(cellTops.length * 0.06));
        let bestBin = -1, roofW = 0;
        for (let b = nBins - 1; b >= 0; b--) {
            const w = hist[b] + (b > 0 ? hist[b - 1] : 0);
            if (hist[b] >= 2 && w >= minCellsForRoof) {
                bestBin = b;
                roofW = w;
                break;
            }
        }

        if (bestBin < 0) return null;
        // Lấy p99.5 trong dải nóc trên cùng (nới trần +2.5 bin ~ 8.7cm để không sót điểm nóc mỏng/thanh giá nóc)
        const zRoofBandMin = zMin + Math.max(0, bestBin - 1) * binSize;
        const zRoofBandMax = zMin + (bestBin + 2.5) * binSize;
        const roofRawZ = [];
        for (let i = 0; i < bodyPtsUVZ.length; i++) {
            const z = bodyPtsUVZ[i][2];
            if (z >= zRoofBandMin && z <= zRoofBandMax) roofRawZ.push(z);
        }
        let roofZ = zMin + (bestBin + 1.0) * binSize;
        if (roofRawZ.length >= 4) {
            roofRawZ.sort((a, b) => a - b);
            roofZ = roofRawZ[Math.min(roofRawZ.length - 1, Math.floor((roofRawZ.length - 1) * 0.995))];
        }
        const measuredH = (roofZ - zRoad);
        if (measuredH >= minH && measuredH <= maxH) {
            return { H: parseFloat(measuredH.toFixed(2)), roofZ, conf: roofW / cellTops.length };
        }
        return null;
    }

    static xacDinhChieuCaoRiengLe(track, pcdsMap, labelName = 'vehicles', targetFrames = null) {
        if (!track || !Array.isArray(track.shapes)) return { count: 0, newH: null };
        if (targetFrames && !(targetFrames instanceof Set)) targetFrames = new Set(targetFrames);

        const activeShapes = track.shapes
            .filter(s => !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));
        if (activeShapes.length === 0) return { count: 0, newH: null };

        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }

        const cfg = this.layKichThuocChuanTheoThuocTinh(track, null, lbl);
        const minH = cfg.limits.minH;
        const maxH = cfg.limits.maxH;
        const priorH = cfg.prior[2];

        const measuredHeights = [];
        const zRoadByFrame = new Map();

        for (const s of activeShapes) {
            const fn = Number(s.frame);
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            if (!pts || pts.length < 10) continue;

            const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
            // Dùng hệ quy chiếu cân bằng mặt đường nội bộ (với chiều cao tham chiếu priorH để tìm đúng mặt đất ngay cả khi H hiện tại đang bị phá = 3.6m)
            const refHForRoad = (H >= minH && H <= maxH) ? H : priorH;
            const resRoad = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, refHForRoad], pts);
            const zRoadEst = (resRoad && resRoad.foundPlane) ? resRoad.zRoad : (cz - H / 2.0);
            if (resRoad && resRoad.foundPlane) {
                zRoadByFrame.set(fn, zRoadEst);
            }
            const rNew = resRoad ? resRoad.newRot : [0, 0, rz || 0];
            const rotMatNew = this.eulerXYZToMatrix(rNew[0], rNew[1], rNew[2]);

            const limU_car = (L / 2.0) * 0.96;
            const limV_car = (W / 2.0) * 0.96;
            const bodyPtsZ = [];
            const bodyPtsUVZ = [];

            for (let i = 0; i < pts.length; i++) {
                const p = pts[i];
                const pz = p[2];
                if (pz < zRoadEst + 0.12 || pz > zRoadEst + maxH + 0.05) continue;

                const dx = p[0] - cx;
                const dy = p[1] - cy;
                const dz = pz - (zRoadEst + priorH / 2.0);

                const lu = dx * rotMatNew[0][0] + dy * rotMatNew[1][0] + dz * rotMatNew[2][0];
                const lv = dx * rotMatNew[0][1] + dy * rotMatNew[1][1] + dz * rotMatNew[2][1];
                if (Math.abs(lu) <= limU_car && Math.abs(lv) <= limV_car) {
                    bodyPtsZ.push(pz);
                    bodyPtsUVZ.push([lu, lv, pz]);
                }
            }

            let measuredH_frame = null;
            if (bodyPtsUVZ.length >= 8) {
                const resGrid = this.doChieuCaoNocXeLuoi10cm(bodyPtsUVZ, zRoadEst, L, W, priorH, minH, maxH);
                if (resGrid && typeof resGrid.H === 'number') {
                    measuredH_frame = resGrid.H;
                }
            }
            if (measuredH_frame === null && bodyPtsZ.length >= 8) {
                const hClimb = this.doChieuCaoLeoTangNocXe(bodyPtsZ, zRoadEst, 0.035, 0.18, maxH, minH);
                if (typeof hClimb === 'number' && !isNaN(hClimb) && hClimb >= minH && hClimb <= maxH) {
                    measuredH_frame = hClimb;
                }
            }
            if (measuredH_frame !== null) {
                measuredHeights.push(measuredH_frame);
            }
        }

        let H_star;
        if (measuredHeights.length >= 3) {
            measuredHeights.sort((a, b) => a - b);
            // Loại bỏ các frame cao bất thường (nhiễu/tán cây > p50 + 12cm), sau đó lấy đỉnh cao nhất hợp lệ (p95 của tập sạch) + 2cm roofPad
            const nH = measuredHeights.length;
            const h50 = measuredHeights[Math.floor((nH - 1) * 0.50)];
            const maxAllowedH = h50 + (nH >= 5 ? 0.12 : 0.15);
            const cleanHeights = measuredHeights.filter(h => h <= maxAllowedH);
            const poolH = cleanHeights.length >= 2 ? cleanHeights : measuredHeights;
            const hPeak = poolH[Math.min(poolH.length - 1, Math.floor((poolH.length - 1) * 0.95))];
            const roofPad = 0.02;
            H_star = Math.max(minH, Math.min(maxH, hPeak + roofPad));
        } else if (cfg.sizeMode === 'snap') {
            H_star = priorH;
        } else {
            // Fallback giống hệt Auto fit box (canChinhTrackTheoThuTuUuTien):
            // Nếu H hiện tại nằm trong [minH, maxH] thì giữ nguyên, nếu lệch ngoài chuẩn (như 3.6m) thì đưa về priorH (1.58m cho car)
            const curHs = activeShapes.map(s => s.points[8]).filter(v => !isNaN(v) && v > 0).sort((a, b) => a - b);
            const medCurH = curHs.length > 0 ? curHs[Math.floor(curHs.length / 2)] : priorH;
            H_star = (medCurH >= minH && medCurH <= maxH) ? medCurH : priorH;
        }

        H_star = Math.max(minH, Math.min(maxH, Math.ceil(H_star * 100) / 100));

        let count = 0;
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            if (targetFrames && !targetFrames.has(fn)) continue;
            const oldH = s.points[8];
            const oldCz = s.points[2];
            // Nếu tìm thấy mặt đường thực tế tại frame đó thì neo đáy sát mặt đường (zRoad - 0.012m) để đỉnh hộp bám sát nóc xe;
            // nếu không có điểm mặt đường thì giữ nguyên mặt đáy hiện tại (oldCz - oldH/2)
            const zRoad = zRoadByFrame.has(fn) ? zRoadByFrame.get(fn) : (oldCz - oldH / 2.0);
            s.points[8] = H_star;
            s.points[2] = parseFloat((zRoad + H_star / 2.0).toFixed(3));
            count++;
        }

        return { count, newH: H_star, profileType: cfg.attributeType, minH, maxH };
    }

    /**
     * 3. CĂN HƯỚNG XE RIÊNG LẺ (Tách nguyên bản từ Pha Góc Xoay Yaw của Auto fit box v3.1)
     * - Bước 1: Khử lật góc 180° & đồng bộ chiều tiến theo vector vận tốc quỹ đạo (khuLatGocTrack)
     * - Bước 2: Với ô tô (vehicles), cắt lớp thân xe sạch (bỏ 1/4 gầm) và chạy quetGocYawToiUu (Histogram 45 góc thô + 0.25° mịn + Bitmask Span + TLS)
     * - Bước 3: Với xe 2 bánh (two-wheels), khóa góc Yaw theo vector vận tốc quỹ đạo khi xe di chuyển (speed >= 0.08m/frame)
     * - Bước 4: Nội suy SLERP góc Yaw cho các frame thưa điểm từ các keyframe đã tối ưu
     * - Chỉ ghi duy nhất trường rz (s.points[5]) vào các frame nằm trong targetFrames!
     */
    static canChinhHuongXeRiengLe(track, pcdsMap, labelName = 'vehicles', targetFrames = null) {
        if (!track || !Array.isArray(track.shapes)) return 0;
        if (targetFrames && !(targetFrames instanceof Set)) targetFrames = new Set(targetFrames);

        const activeShapes = track.shapes
            .filter(s => !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));
        if (activeShapes.length === 0) return 0;

        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }
        const lop = this._lopNhan(lbl, track);
        const cfg = this.layKichThuocChuanTheoThuocTinh(track, null, lbl);

        // Sao lưu góc Yaw gốc của toàn bộ shapes để bảo toàn các frame ngoài targetFrames và làm mỏ neo Prelabel
        const origYawMap = new Map();
        for (const s of activeShapes) {
            origYawMap.set(Number(s.frame), s.points[5] || 0);
        }

        if (lop === 'two-wheels') {
            for (let i = 0; i < activeShapes.length; i++) {
                let vxM = 0.0, vyM = 0.0;
                if (i === 0 && activeShapes.length > 1) {
                    vxM = activeShapes[1].points[0] - activeShapes[0].points[0];
                    vyM = activeShapes[1].points[1] - activeShapes[0].points[1];
                } else if (i === activeShapes.length - 1 && activeShapes.length > 1) {
                    vxM = activeShapes[i].points[0] - activeShapes[i - 1].points[0];
                    vyM = activeShapes[i].points[1] - activeShapes[i - 1].points[1];
                } else if (activeShapes.length > 2) {
                    vxM = (activeShapes[i + 1].points[0] - activeShapes[i - 1].points[0]) / 2.0;
                    vyM = (activeShapes[i + 1].points[1] - activeShapes[i - 1].points[1]) / 2.0;
                }
                const speedStep = Math.hypot(vxM, vyM);
                if (speedStep >= 0.08) {
                    const headingYaw = Math.atan2(vyM, vxM);
                    const currYaw = activeShapes[i].points[5];
                    const diff = this.wrapToPi(headingYaw - currYaw);
                    if (Math.abs(Math.abs(diff) - Math.PI / 2.0) < 0.35 || Math.abs(diff) > Math.PI * 0.65 || Math.abs(diff) <= 0.45) {
                        activeShapes[i].points[5] = parseFloat(headingYaw.toFixed(3));
                    }
                }
            }
            this.khuLatGocTrack(track);
        } else if (lop === 'vehicles') {
            const yawKf = [];
            const optimizedFrames = new Set();

            for (const s of activeShapes) {
                const fn = Number(s.frame);
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length < 10) continue;

                const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
                const refH = (H >= cfg.limits.minH && H <= cfg.limits.maxH) ? H : cfg.prior[2];
                const resRoad = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, refH], pts);
                const pRoad = resRoad ? resRoad.newPos : [cx, cy, cz];
                const rRoad = resRoad ? resRoad.newRot : [0, 0, rz || 0];

                const preCluster = this.trichXuatDiemThanXeCatLop(
                    pts, pRoad[0], pRoad[1], pRoad[2],
                    rRoad[0], rRoad[1], s.points[5],
                    L, W, refH,
                    true, 0.55, 0.35, false
                );

                if (preCluster.xp.length >= 12) {
                    const pts2D = [];
                    // Băng thân xe thích ứng: cắt gầm theo khoảng cách z_cut(d) và cắt bỏ 22cm nóc cong/giá nóc
                    const dSensor = Math.hypot(cx, cy);
                    const cutBottom = Math.max(0.20, Math.min(0.48, 0.50 - 0.009 * dSensor));
                    const zBandMin = -refH / 2.0 + cutBottom;
                    const zBandMax = -refH / 2.0 + Math.max(cutBottom + 0.20, refH - 0.22);
                    for (let k = 0; k < preCluster.xp.length; k++) {
                        const lz = preCluster.zp ? preCluster.zp[k] : 0;
                        if (lz >= zBandMin && lz <= zBandMax &&
                            Math.abs(preCluster.xp[k]) <= L / 2.0 + 0.40 &&
                            Math.abs(preCluster.yp[k]) <= W / 2.0 + 0.25) {
                            pts2D.push([preCluster.xp[k], preCluster.yp[k]]);
                        }
                    }
                    if (pts2D.length < 10) {
                        for (let k = 0; k < preCluster.xp.length; k++) {
                            pts2D.push([preCluster.xp[k], preCluster.yp[k]]);
                        }
                    }
                    const dYaw = this.quetGocYawToiUu(pts2D, L, W, 0.50);
                    if (typeof dYaw === 'number' && !isNaN(dYaw)) {
                        const origRz = origYawMap.get(fn) ?? s.points[5];
                        const rawYaw = s.points[5] + dYaw;
                        // Khống chế nghiêm ngặt theo Prelabel ban đầu: chọn candidate gần origRz nhất, lệch <= 38°
                        const targetYaw = this.tinhGocYawGanPrelabelNhat(rawYaw, origRz, 38.0 * Math.PI / 180.0);
                        s.points[5] = parseFloat(targetYaw.toFixed(3));
                        yawKf.push({ fn, yaw: s.points[5] });
                        optimizedFrames.add(fn);
                    }
                }
            }

            // Nội suy SLERP góc Yaw cho các frame thưa điểm từ các keyframe đã tối ưu
            if (yawKf.length > 0) {
                for (const s of activeShapes) {
                    const fn = Number(s.frame);
                    if (optimizedFrames.has(fn)) continue;
                    let targetYaw;
                    if (yawKf.length === 1) {
                        targetYaw = yawKf[0].yaw;
                    } else {
                        const prev = yawKf.filter(k => k.fn <= fn);
                        const next = yawKf.filter(k => k.fn >= fn);
                        if (prev.length > 0 && next.length > 0) {
                            const k1 = prev[prev.length - 1];
                            const k2 = next[0];
                            if (k1.fn === k2.fn) targetYaw = k1.yaw;
                            else {
                                const alpha = (fn - k1.fn) / (k2.fn - k1.fn);
                                const dyaw = this.wrapToPi(k2.yaw - k1.yaw);
                                targetYaw = this.wrapToPi(k1.yaw + alpha * dyaw);
                            }
                        } else if (prev.length > 0) {
                            targetYaw = prev[prev.length - 1].yaw;
                        } else if (next.length > 0) {
                            targetYaw = next[0].yaw;
                        }
                    }
                    if (targetYaw !== undefined) {
                        s.points[5] = parseFloat(targetYaw.toFixed(3));
                    }
                }
            }

            if (activeShapes.length >= 2) {
                this.khuLatGocTrack(track);
                this._lamMuotYawNgoaiLai(activeShapes);
            }
        }

        // Khôi phục góc Yaw gốc cho các frame KHÔNG nằm trong targetFrames, và đồng bộ s.rotation[2] cho các frame được chọn
        let modifiedCount = 0;
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            const origRz = origYawMap.get(fn);
            if (targetFrames && !targetFrames.has(fn)) {
                s.points[5] = origRz;
                if (Array.isArray(s.rotation)) s.rotation[2] = origRz;
            } else {
                if (Array.isArray(s.rotation)) s.rotation[2] = s.points[5];
                modifiedCount++;
            }
        }

        return modifiedCount;
    }

    /**
     * 4. ÔM KHÍT XE RIÊNG LẺ (Tách nguyên bản vòng lặp hội tụ XY của Auto fit box)
     * - Chạy vòng lặp hội tụ 10 bước (< 3mm) dùng trichXuatDiemThanXeCatLop + phanTichLopThanXeChinh + tinhDxDyMep
     * - Dịch chuyển tâm hộp thông qua ma trận phẳng ngang rotMatLevel = eulerXYZToMatrix(0, 0, rz) để không bao giờ làm trôi cao độ Z
     * - Chỉ cập nhật duy nhất [x, y] (s.points[0], s.points[1]) trên các frame được chọn; giữ nguyên tuyệt đối [z, rx, ry, rz, L, W, H]!
     */
    static omKhitXeRiengLe(track, pcdsMap, labelName = 'vehicles', scanScale = 1.0, targetFrames = null, pad = 0.025, neighborBoxesDict = null) {
        if (!track || !Array.isArray(track.shapes)) return 0;
        if (targetFrames && !(targetFrames instanceof Set)) targetFrames = new Set(targetFrames);

        const activeShapes = track.shapes
            .filter(s => !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));
        if (activeShapes.length === 0) return 0;

        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }
        const lop = this._lopNhan(lbl, track);
        const cfg = this.layKichThuocChuanTheoThuocTinh(track, null, lbl);

        // Sao lưu toàn bộ tọa độ ban đầu để khôi phục các frame ngoài targetFrames và giữ cố định [z, rx, ry, rz, L, W, H]
        const backupMap = new Map();
        for (const s of activeShapes) {
            backupMap.set(Number(s.frame), [...s.points]);
        }

        if (lop === 'two-wheels' || lop === 'pedestrian') {
            let count = 0;
            for (const s of activeShapes) {
                const fn = Number(s.frame);
                if (targetFrames && !targetFrames.has(fn)) continue;
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length < 3) continue;

                const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
                const resRoad = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, H], pts);
                const pRoad = resRoad ? resRoad.newPos : [cx, cy, cz];
                const rRoad = resRoad ? resRoad.newRot : [0, 0, rz || 0];
                const rotMatLevel = this.eulerXYZToMatrix(0, 0, rz || 0);

                const marginX = (lop === 'two-wheels') ? 0.55 : 0.35;
                const marginY = (lop === 'two-wheels') ? 0.45 : 0.35;
                const cluster = this.trichXuatDiemThanXeCatLop(
                    pts, cx, cy, pRoad[2],
                    rRoad[0], rRoad[1], rz || 0,
                    L, W, H,
                    false, marginX, marginY
                );
                const vx = cluster.xp, vy = cluster.yp, vz = cluster.zp;
                const nPts = vx.length;
                if (nPts >= 3) {
                    let dx = 0.0, dy = 0.0;
                    if (lop === 'two-wheels') {
                        const riderIdx = [];
                        for (let i = 0; i < nPts; i++) {
                            if (vz[i] >= 0.35) riderIdx.push(i);
                        }
                        if (riderIdx.length >= 3) {
                            const rxVals = riderIdx.map(i => vx[i]).sort((a, b) => a - b);
                            const ryVals = riderIdx.map(i => vy[i]).sort((a, b) => a - b);
                            dx = rxVals[Math.floor(rxVals.length / 2)] + 0.18;
                            dy = ryVals[Math.floor(ryVals.length / 2)];
                        } else {
                            const sxVals = [...vx].sort((a, b) => a - b);
                            const syVals = [...vy].sort((a, b) => a - b);
                            dx = sxVals[Math.floor(sxVals.length / 2)];
                            dy = syVals[Math.floor(syVals.length / 2)];
                        }
                        dx = Math.max(-0.45, Math.min(0.45, dx));
                        dy = Math.max(-0.30, Math.min(0.30, dy));
                    } else {
                        const sxVals = [...vx].sort((a, b) => a - b);
                        const syVals = [...vy].sort((a, b) => a - b);
                        dx = Math.max(-0.30, Math.min(0.30, sxVals[Math.floor(sxVals.length / 2)]));
                        dy = Math.max(-0.30, Math.min(0.30, syVals[Math.floor(syVals.length / 2)]));
                    }
                    const shiftP = this.matVecMul(rotMatLevel, [dx, dy, 0.0]);
                    s.points[0] = parseFloat((cx + shiftP[0]).toFixed(3));
                    s.points[1] = parseFloat((cy + shiftP[1]).toFixed(3));
                    count++;
                }
            }
            return count;
        }

        // Ô tô (vehicles): Chạy đúng vòng lặp hội tụ 10 bước của Auto fit box (canChinhTrackTheoThuTuUuTien)
        const roadCache = new Map();
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            if (targetFrames && !targetFrames.has(fn)) continue;
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            if (!pts || pts.length === 0) continue;
            const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
            const refH = (H >= cfg.limits.minH && H <= cfg.limits.maxH) ? H : cfg.prior[2];
            const resRoad = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, refH], pts);
            roadCache.set(fn, {
                zLevel: resRoad ? resRoad.newPos[2] : cz,
                rxLevel: resRoad ? resRoad.newRot[0] : (rx || 0),
                ryLevel: resRoad ? resRoad.newRot[1] : (ry || 0),
                refH
            });
        }

        const MAX_ITERS = 3; // Tối ưu rút gọn hội tụ 3 vòng (chống ngốn CPU lặp 10 vòng vô ích)
        const scaleVal = Math.max(1.0, Math.min(2.0, parseFloat(scanScale) || 1.0));
        const scaleFactor = (scaleVal - 1.0) / 1.0;
        const baseMarginX = 0.20 + scaleFactor * (1.40 - 0.20);
        const baseMarginY = 0.10 + scaleFactor * (1.40 - 0.10);
        const contextCache = new Map();
        const ambiguousFrames = [];

        for (let iter = 0; iter < MAX_ITERS; iter++) {
            const isFirstPass = (iter === 0);
            const frameData = {};
            let maxChange = 0.0;

            const scanMarginX = Math.max(0.18, baseMarginX * Math.pow(0.5, iter));
            const scanMarginY = Math.max(0.08, baseMarginY * Math.pow(0.5, iter));
            const isBig = (scaleVal >= 1.5 && iter <= 1);
            // Khóa xê dịch tâm (maxShift) tỷ lệ thuận với khoảng phồng (scanScale) theo chuẩn Kiệt:
            // Khi scanScale <= 1.0 (mặc định): maxShift = 0.35m ở vòng 0, 0.20m ở vòng sau (chống tuyệt đối nhảy sang xe bên cạnh)
            const maxShiftBase = (scaleVal <= 1.0) ? 0.35 : Math.min(1.80, 0.35 + (scaleVal - 1.0) * 1.45);
            const maxShift = (iter === 0) ? maxShiftBase : Math.min(maxShiftBase * 0.60, 0.22);

            for (const s of activeShapes) {
                const fn = Number(s.frame);
                if (targetFrames && !targetFrames.has(fn)) continue;
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length === 0) continue;

                let ctx = contextCache.get(fn);
                if (!ctx) {
                    const nbFrame = this._layNeighborsFrame(neighborBoxesDict, fn);
                    const rcInit = roadCache.get(fn) || { zLevel: s.points[2], refH: s.points[8] };
                    ctx = this.chonVaLocNguCanhFrame(
                        pts, s.points[0], s.points[1], rcInit.zLevel, s.points[5] || 0,
                        s.points[6], s.points[7], rcInit.refH, nbFrame, scaleVal
                    );
                    ctx.origCx = s.points[0];
                    ctx.origCy = s.points[1];
                    contextCache.set(fn, ctx);
                    if (ctx.ambiguous) {
                        ambiguousFrames.push(fn);
                        console.warn(`[AutoFit] OmKhit Frame ${fn}: mơ hồ giữa các cụm (margin=${ctx.margin}) -> giữ prelabel`);
                        continue;
                    }
                    if (Math.hypot(ctx.preShiftWorld[0], ctx.preShiftWorld[1]) > 0.25) {
                        s.points[0] = parseFloat((s.points[0] + ctx.preShiftWorld[0]).toFixed(3));
                        s.points[1] = parseFloat((s.points[1] + ctx.preShiftWorld[1]).toFixed(3));
                    }
                } else if (ctx.ambiguous) {
                    continue;
                }

                const ptsUse = ctx.ptsClean || pts;
                const [cx, cy, cz, rx, ry, rz, L_star, W_star, H_star] = s.points;
                const rc = roadCache.get(fn) || { zLevel: cz, rxLevel: rx || 0, ryLevel: ry || 0, refH: H_star };
                const rotMatLevel = this.eulerXYZToMatrix(0, 0, rz || 0);

                const cluster = this.trichXuatDiemThanXeCatLop(
                    ptsUse, cx, cy, rc.zLevel,
                    rc.rxLevel, rc.ryLevel, rz || 0,
                    L_star, W_star, rc.refH,
                    true, scanMarginX, scanMarginY, isBig
                );
                const vx = cluster.xp, vy = cluster.yp, vz = cluster.zp;
                const nPts = vx.length;

                const toSensor = this.vectorMatMul([-cx, -cy, -rc.zLevel], rotMatLevel);
                const sx = toSensor[0], sy = toSensor[1];
                const distS = Math.hypot(sx, sy);

                let ex0 = 0.0, ex1 = 0.0, ey0 = 0.0, ey1 = 0.0;
                let rX = null, fX = null, fY = null;

                if (nPts >= 6) {
                    const ptsRel = [];
                    for (let i = 0; i < nPts; i++) ptsRel.push([vx[i], vy[i], vz[i]]);
                    const dRelShift = this.vectorMatMul([cx - ctx.origCx, cy - ctx.origCy, 0], rotMatLevel);
                    const ana = this.phanTichLopThanXeChinh(ptsRel, L_star, W_star, sx, sy, distS, pad, isFirstPass, scaleVal, {
                        vachCamY: (ctx.vachCamY || []).map(v => v - dRelShift[1]),
                        vachCamX: (ctx.vachCamX || []).map(v => v - dRelShift[0])
                    });
                    ex0 = ana.ex0; ex1 = ana.ex1; ey0 = ana.ey0; ey1 = ana.ey1;
                    rX = ana.bestRearX; fX = ana.bestFrontX; fY = ana.bestFlankY;
                }

                frameData[fn] = {
                    shape: s,
                    cx, cy, L_star, W_star,
                    rotMatLevel,
                    vx, vy, vz,
                    nPts,
                    ex0, ex1, ey0, ey1,
                    rX, fX, fY,
                    sx, sy,
                    carScore: ctx.carScore
                };
            }

            if (isFirstPass && activeShapes.length >= 3) {
                this.khuLatGocTrack(track);
                this._lamMuotYawNgoaiLai(activeShapes);
                for (const fnStr of Object.keys(frameData)) {
                    const fd = frameData[fnStr];
                    fd.rotMatLevel = this.eulerXYZToMatrix(0, 0, fd.shape.points[5] || 0);
                }
            }

            const sortedFns = Object.keys(frameData).map(k => parseInt(k, 10)).sort((a, b) => a - b);
            if (sortedFns.length === 0) break;

            const kfShifts = {};
            for (const fn of sortedFns) {
                const fd = frameData[fn];
                if (fd.nPts >= 6) {
                    // Gọi đúng chữ ký của tinhDxDyMep trong canChinhTrackTheoThuTuUuTien (trả về { dx, dy })
                    const effStepMaxShift = (fd.carScore !== undefined && fd.carScore < 0.45) ? Math.min(maxShift, 0.30) : maxShift;
                    const shift = this.tinhDxDyMep(
                        fd.ex0, fd.ex1, fd.ey0, fd.ey1,
                        fd.L_star, fd.W_star, fd.sx, fd.sy,
                        pad, true, effStepMaxShift,
                        fd.rX, fd.fX, fd.fY
                    );
                    kfShifts[fn] = [shift.dx, shift.dy];
                }
            }

            const validKfs = Object.keys(kfShifts).map(k => parseInt(k, 10)).sort((a, b) => a - b);

            for (const fn of sortedFns) {
                const fd = frameData[fn];
                let dx = 0.0, dy = 0.0;
                if (kfShifts[fn] !== undefined) {
                    [dx, dy] = kfShifts[fn];
                } else if (validKfs.length > 0) {
                    const prevKfs = validKfs.filter(k => k < fn);
                    const nextKfs = validKfs.filter(k => k > fn);
                    if (prevKfs.length > 0 && nextKfs.length > 0) {
                        const k1 = prevKfs[prevKfs.length - 1];
                        const k2 = nextKfs[0];
                        const alpha = (fn - k1) / (k2 - k1);
                        dx = (1.0 - alpha) * kfShifts[k1][0] + alpha * kfShifts[k2][0];
                        dy = (1.0 - alpha) * kfShifts[k1][1] + alpha * kfShifts[k2][1];
                    } else if (prevKfs.length > 0) {
                        [dx, dy] = kfShifts[prevKfs[prevKfs.length - 1]];
                    } else if (nextKfs.length > 0) {
                        [dx, dy] = kfShifts[nextKfs[0]];
                    }
                }

                const shiftP = this.matVecMul(fd.rotMatLevel, [dx, dy, 0.0]);
                const stepDist = Math.hypot(shiftP[0], shiftP[1]);
                if (stepDist > maxChange) maxChange = stepDist;

                const s = fd.shape;
                s.points[0] = parseFloat((fd.cx + shiftP[0]).toFixed(3));
                s.points[1] = parseFloat((fd.cy + shiftP[1]).toFixed(3));
            }

            if (maxChange < 0.003) break;
        }

        // Khôi phục lại tuyệt đối [z, rx, ry, rz, L, W, H] cho các frame được chọn và toàn bộ points cho các frame không chọn
        let count = 0;
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            const bk = backupMap.get(fn);
            if (!bk) continue;
            if (targetFrames && !targetFrames.has(fn)) {
                s.points = [...bk];
            } else {
                const ctx = contextCache.get(fn);
                if (ctx && ctx.ambiguous) {
                    s.points = [...bk];
                    continue;
                }
                s.points[2] = bk[2];
                s.points[3] = bk[3];
                s.points[4] = bk[4];
                s.points[5] = bk[5];
                s.points[6] = bk[6];
                s.points[7] = bk[7];
                s.points[8] = bk[8];
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (pts && pts.length > 0) count++;
            }
        }

        track._ambiguousFrames = ambiguousFrames;
        return count;
    }

    static canChinhTrackTheoThuTuUuTien(track, pcdsMap = null, labelName = 'vehicles', neighborBoxesDict = null, pad = 0.05, scanScale = 1.0, targetFrames = null) {
        if (targetFrames && !(targetFrames instanceof Set)) {
            targetFrames = new Set(targetFrames);
        }
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        const shapes = track.shapes;
        if (shapes.length === 0) return false;

        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }

        if (lbl.includes('two-wheels') || lbl.includes('moto') || lbl === '12873' || lbl === '8661580') {
            return this.canChinhTrackXeHaiBanh(track, pcdsMap, neighborBoxesDict, pad);
        } else if (lbl.includes('pedestrian') || lbl === '12872' || lbl === '8661579') {
            return this.canChinhTrackNguoiDiBo(track, pcdsMap, neighborBoxesDict, pad);
        }
        const isVeh = true;

        // Lấy kích thước gốc trung vị của track
        const activeShapes = shapes.filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length === 0) return false;

        const ls = activeShapes.map(s => s.points[6]).filter(v => !isNaN(v) && v > 0).sort((a, b) => a - b);
        const ws = activeShapes.map(s => s.points[7]).filter(v => !isNaN(v) && v > 0).sort((a, b) => a - b);
        const hs = activeShapes.map(s => s.points[8]).filter(v => !isNaN(v) && v > 0).sort((a, b) => a - b);
        let origL = ls.length > 0 ? ls[Math.floor(ls.length / 2)] : 4.35;
        let origW = ws.length > 0 ? ws[Math.floor(ws.length / 2)] : 1.85;
        let origH = hs.length > 0 ? hs[Math.floor(hs.length / 2)] : 1.58;

        // Khóa kích thước theo thiết lập người dùng
        const laKhoaSize = Boolean(track.khoa_kich_thuoc || track.lock_size);
        let lockL = Boolean(track.lock_l);
        let lockW = Boolean(track.lock_w);
        let lockH = Boolean(track.lock_h);
        if (laKhoaSize && !lockL && !lockW && !lockH) {
            lockL = lockW = lockH = true;
        }
        let lockedL = Number(track.locked_l_val ?? origL);
        let lockedW = Number(track.locked_w_val ?? origW);
        let lockedH = Number(track.locked_h_val ?? origH);

        // BẢO VỆ CHỐNG DỮ LIỆU KHÓA KÍCH THƯỚC RÁC:
        if (lockW && (lockedW > 3.50 || lockedW < 1.20)) lockW = false;
        if (lockH && (lockedH > 4.50 || lockedH < 1.00)) lockH = false;
        if (lockL && (lockedL > 22.0 || lockedL < 2.00)) lockL = false;

        // BỘ LỌC KÍCH THƯỚC XE CON CHUẨN XÁC (Tránh bị teo nhỏ hoặc phình to):
        const isSuperTruck = (origL >= 6.80 || (origL >= 5.80 && origH >= 2.60 && lbl.includes('truck')));
        if (!isSuperTruck) {
            // Nới dải kích thước xe con theo chuẩn QC_NGUONG (cho phép SUV/VF8/VF9 rộng tới 2.20m, cao tới 1.95m, dài tới 5.50m)
            if (!lockL && (origL < 3.20 || origL > 5.50)) origL = 4.50;
            if (!lockW && (origW < 1.60 || origW > 2.20)) origW = 1.90;
            if (!lockH && (origH < 1.40 || origH > 1.95)) origH = 1.65;
        }

        let L_star = lockL ? lockedL : origL;
        let W_star = lockW ? lockedW : origW;
        let H_star = lockH ? lockedH : origH;

        // Nếu không khóa H, cập nhật chiều cao chuẩn từ nóc xe thực tế (đồng bộ với Căn Nóc Xe)
        if (!lockH && pcdsMap) {
            const resH = this.xacDinhChieuCaoRiengLe(track, pcdsMap, lbl, targetFrames);
            if (resH && typeof resH.newH === 'number' && !isNaN(resH.newH)) {
                H_star = resH.newH;
            }
        }
        // Sao lưu góc Yaw gốc của toàn bộ shapes để bảo toàn các frame ngoài targetFrames và làm mỏ neo Prelabel
        const origYawMap = new Map();
        for (const s of activeShapes) {
            origYawMap.set(Number(s.frame), s.points[5] || 0);
        }

        // Khử lật góc và chống giật góc ở frame khuất ngay trước khi fit mép XY
        if (activeShapes.length >= 2) {
            this.khuLatGocTrack(track);
            this._lamMuotYawNgoaiLai(activeShapes);
        }

        // Tự động nới chiều dài L_star nếu !lockL và đo thấy nhiều frame dày điểm có thân xe dài hơn origL (tránh hụt đầu/đuôi)
        const scaleValInit = Math.max(1.0, Math.min(2.0, parseFloat(scanScale) || 1.0));
        if (!lockL && pcdsMap && scaleValInit <= 1.05 && !isSuperTruck) {
            const measuredLs = [];
            for (const s of activeShapes) {
                const fn = Number(s.frame);
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length < 20) continue;
                const [cx, cy, cz, rx, ry, rz] = s.points;
                const rotM = this.eulerXYZToMatrix(rx || 0, ry || 0, rz || 0);
                const bodyUs = [];
                for (let i = 0; i < pts.length; i++) {
                    const p = pts[i];
                    const dx = p[0] - cx, dy = p[1] - cy, dz = p[2] - cz;
                    const lu = dx * rotM[0][0] + dy * rotM[1][0] + dz * rotM[2][0];
                    const lv = dx * rotM[0][1] + dy * rotM[1][1] + dz * rotM[2][1];
                    const lw = dx * rotM[0][2] + dy * rotM[1][2] + dz * rotM[2][2];
                    if (Math.abs(lv) <= W_star / 2.0 + 0.08 &&
                        Math.abs(lu) <= origL / 2.0 + 0.45 &&
                        lw >= -H_star / 2.0 + 0.25 && lw <= H_star / 2.0 - 0.15) {
                        bodyUs.push(lu);
                    }
                }
                if (bodyUs.length >= 80) {
                    bodyUs.sort((a, b) => a - b);
                    const pLow = bodyUs[Math.floor((bodyUs.length - 1) * 0.005)];
                    const pHigh = bodyUs[Math.floor((bodyUs.length - 1) * 0.995)];
                    const spanX = pHigh - pLow;
                    if (spanX > origL + 0.05 && spanX <= Math.min(5.50, origL * 1.12)) {
                        measuredLs.push(spanX);
                    }
                }
            }
            if (measuredLs.length >= 2 || (activeShapes.length <= 4 && measuredLs.length >= 1)) {
                measuredLs.sort((a, b) => a - b);
                const medL = measuredLs[Math.floor(measuredLs.length / 2)];
                L_star = Math.min(5.50, origL * 1.12, medL + 0.04);
            }
        }

        // Đồng bộ kích thước chuẩn cố định xuyên suốt toàn track
        L_star = parseFloat(L_star.toFixed(3));
        W_star = parseFloat(W_star.toFixed(3));
        H_star = parseFloat(H_star.toFixed(3));

        for (const s of shapes) {
            if (s.points && s.points.length >= 9) {
                if (targetFrames && !targetFrames.has(s.frame)) continue;
                s.points[6] = L_star;
                s.points[7] = W_star;
                s.points[8] = H_star;
            }
        }

        // VÒNG LẶP HỘI TỤ TỰ ĐỘNG THEO TỪNG FRAME ĐỘC LẬP (Per-Frame Adaptive Convergence)
        const MAX_ITERS = 4;
        const scaleVal = Math.max(1.0, Math.min(2.0, parseFloat(scanScale) || 1.0));
        const scaleFactor = (scaleVal - 1.0) / 1.0; // [0.0, 1.0]
        const baseMarginX = 0.20 + scaleFactor * (1.40 - 0.20);
        const baseMarginY = 0.10 + scaleFactor * (1.40 - 0.10);
        const contextCache = new Map();
        const ambiguousFrames = [];

        // Theo dõi trạng thái hội tụ độc lập của từng frame
        const convergedFrames = new Set();
        let totalActiveFrames = 0;
        let allConvergedOnPass0 = false;
        let actualRoundsRun = 0;

        for (let iter = 0; iter < MAX_ITERS; iter++) {
            const isFirstPass = (iter === 0);
            const frameData = {};
            let maxChange = 0.0;

            const scanMarginX = Math.max(0.18, baseMarginX * Math.pow(0.5, iter));
            const scanMarginY = Math.max(0.08, baseMarginY * Math.pow(0.5, iter));
            const isBig = (scaleVal >= 1.5 && iter <= 1);
            // Khóa xê dịch tâm (maxShift) tỷ lệ thuận với khoảng phồng (scanScale) theo chuẩn Kiệt:
            const maxShiftBase = (scaleVal <= 1.0) ? 0.35 : Math.min(1.80, 0.35 + (scaleVal - 1.0) * 1.45);
            const maxShift = (iter === 0) ? maxShiftBase : Math.min(maxShiftBase, 0.35);

            // BƯỚC 1: Quét tất cả các frames, khớp mặt đường RANSAC + nóc xe và trích xuất điểm thân xe
            for (const s of shapes) {
                if (s.outside || !s.points || s.points.length < 9) continue;
                const fn = s.frame;
                if (targetFrames && !targetFrames.has(fn)) continue;
                if (iter === 0) totalActiveFrames++;
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length === 0) continue;

                let ctx = contextCache.get(fn);
                if (!ctx) {
                    const nbFrame = this._layNeighborsFrame(neighborBoxesDict, fn);
                    ctx = this.chonVaLocNguCanhFrame(
                        pts, s.points[0], s.points[1], s.points[2], s.points[5] || 0,
                        L_star, W_star, H_star, nbFrame, scaleVal
                    );
                    ctx.origPoints = [...s.points];
                    contextCache.set(fn, ctx);
                    if (ctx.ambiguous) {
                        ambiguousFrames.push(fn);
                        console.warn(`[AutoFit] Track Frame ${fn}: mơ hồ giữa các cụm (margin=${ctx.margin}) -> giữ prelabel`);
                        continue;
                    }
                    if (Math.hypot(ctx.preShiftWorld[0], ctx.preShiftWorld[1]) > 0.25) {
                        s.points[0] = parseFloat((s.points[0] + ctx.preShiftWorld[0]).toFixed(3));
                        s.points[1] = parseFloat((s.points[1] + ctx.preShiftWorld[1]).toFixed(3));
                    }
                } else if (ctx.ambiguous) {
                    continue;
                }

                const ptsUse = ctx.ptsClean || pts;
                const pos = [s.points[0], s.points[1], s.points[2]];
                const rot = [s.points[3], s.points[4], s.points[5]];
                const size = [L_star, W_star, H_star];

                // Căn chỉnh mặt đường RANSAC 3D Tự Cân Bằng & Nóc xe
                const resRoad = this.canChinhMatDuongHop(pos, rot, size, ptsUse);
                const pRoad = resRoad.newPos;
                const rRoad = resRoad.newRot;
                let rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);

                // [v3.1] TỐI ƯU GÓC YAW BẰNG HISTOGRAM & TLS TRÊN ĐÁM MÂY ĐIỂM THÂN XE (Đồng bộ cùng Căn Hướng Xe)
                let yawOptimized = false;
                const dSensYaw = Math.hypot(pRoad[0], pRoad[1]);
                if (isVeh && isFirstPass && (dSensYaw <= 32.0 || scaleVal > 1.05)) {
                    const preCluster = this.trichXuatDiemThanXeCatLop(
                        ptsUse, pRoad[0], pRoad[1], pRoad[2],
                        rRoad[0], rRoad[1], rRoad[2],
                        L_star, W_star, H_star,
                        true, 0.55, scaleVal <= 1.05 ? 0.12 : 0.35, false
                    );
                    if (preCluster.xp.length >= (dSensYaw > 25.0 ? 60 : 10)) {
                        const pts2D = [];
                        // Cắt dải độ cao thích ứng: bỏ gầm theo khoảng cách và bỏ 22cm nóc cong/giá nóc
                        const cutBotYaw = Math.max(0.20, Math.min(0.48, 0.50 - 0.009 * dSensYaw));
                        const zMinY = -H_star / 2.0 + cutBotYaw;
                        const zMaxY = -H_star / 2.0 + Math.max(cutBotYaw + 0.20, H_star - 0.22);
                        const yYawLim = W_star / 2.0 + (scaleVal <= 1.05 ? 0.08 : 0.25);
                        for (let k = 0; k < preCluster.xp.length; k++) {
                            const lz = preCluster.zp ? preCluster.zp[k] : 0;
                            if (lz >= zMinY && lz <= zMaxY &&
                                Math.abs(preCluster.xp[k]) <= L_star / 2.0 + 0.40 &&
                                Math.abs(preCluster.yp[k]) <= yYawLim) {
                                pts2D.push([preCluster.xp[k], preCluster.yp[k]]);
                            }
                        }
                        if (pts2D.length < 8) {
                            for (let k = 0; k < preCluster.xp.length; k++) pts2D.push([preCluster.xp[k], preCluster.yp[k]]);
                        }
                        const dYaw = this.quetGocYawToiUu(pts2D, L_star, W_star, 0.50);
                        if (typeof dYaw === 'number' && !isNaN(dYaw)) {
                            const origRz = origYawMap.get(fn) ?? rRoad[2];
                            const rawYaw = rRoad[2] + dYaw;
                            // Khống chế nghiêm ngặt theo Prelabel ban đầu: chọn candidate gần origRz nhất, lệch <= 38°
                            const targetYaw = this.tinhGocYawGanPrelabelNhat(rawYaw, origRz, 38.0 * Math.PI / 180.0);
                            if (Math.abs(this.wrapToPi(targetYaw - rRoad[2])) >= 0.005) {
                                rRoad[2] = targetYaw;
                                s.points[5] = parseFloat(rRoad[2].toFixed(3));
                                if (Array.isArray(s.rotation)) s.rotation[2] = s.points[5];
                                rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);
                                yawOptimized = true;
                            } else {
                                yawOptimized = true;
                            }
                        }
                    }
                }

                // [v2.6.3] Trích xuất điểm thân xe cắt lớp với cỡ phồng scanScale
                const cluster = this.trichXuatDiemThanXeCatLop(
                    ptsUse, pRoad[0], pRoad[1], pRoad[2],
                    rRoad[0], rRoad[1], rRoad[2],
                    L_star, W_star, H_star,
                    true, scanMarginX, scanMarginY, isBig
                );
                const vx = cluster.xp, vy = cluster.yp, vz = cluster.zp;
                const nPts = vx.length;

                const toSensor = this.vectorMatMul([-pRoad[0], -pRoad[1], -pRoad[2]], rotMat);
                const sx = toSensor[0], sy = toSensor[1];
                const distS = Math.hypot(sx, sy);

                let ex0 = 0.0, ex1 = 0.0, ey0 = 0.0, ey1 = 0.0;
                let rX = null, fX = null, fY = null;

                if (nPts >= 6) {
                    const ptsRel = [];
                    for (let i = 0; i < nPts; i++) ptsRel.push([vx[i], vy[i], vz[i]]);
                    const dRelShift = this.vectorMatMul([pRoad[0] - ctx.origPoints[0], pRoad[1] - ctx.origPoints[1], 0], rotMat);
                    const ana = this.phanTichLopThanXeChinh(ptsRel, L_star, W_star, sx, sy, distS, pad, isFirstPass, scaleVal, {
                        vachCamY: (ctx.vachCamY || []).map(v => v - dRelShift[1]),
                        vachCamX: (ctx.vachCamX || []).map(v => v - dRelShift[0])
                    });
                    ex0 = ana.ex0; ex1 = ana.ex1; ey0 = ana.ey0; ey1 = ana.ey1;
                    rX = ana.bestRearX; fX = ana.bestFrontX; fY = ana.bestFlankY;
                }

                frameData[fn] = {
                    shape: s,
                    pRoad,
                    rRoad,
                    rotMat,
                    vx, vy, vz,
                    nPts,
                    ex0, ex1, ey0, ey1,
                    rX, fX, fY,
                    sx, sy,
                    carScore: ctx.carScore,
                    wRoad: resRoad.wRoad,
                    foundPlane: Boolean(resRoad.foundPlane),
                    nGroundPts: resRoad.nGroundPts || 0
                };
            }

            if (isFirstPass && activeShapes.length >= 3) {
                this.khuLatGocTrack(track);
                this._lamMuotYawNgoaiLai(activeShapes);
                for (const fnStr of Object.keys(frameData)) {
                    const fd = frameData[fnStr];
                    fd.rRoad[2] = fd.shape.points[5];
                    fd.rotMat = this.eulerXYZToMatrix(fd.rRoad[0], fd.rRoad[1], fd.rRoad[2]);
                }
            }

            const sortedFns = Object.keys(frameData).map(k => parseInt(k, 10)).sort((a, b) => a - b);
            if (sortedFns.length === 0) break;

            // Bảo vệ các frame quá thưa điểm ở xa (ví dụ 9-20 pts): không để mặt đường nhảy vọt bay lên trời; nội suy Z/Pitch/Roll từ các frame mốc rõ
            let maxFramePts = 0;
            for (const fn of sortedFns) {
                if (frameData[fn].nPts > maxFramePts) maxFramePts = frameData[fn].nPts;
            }
            const anchorMinPts = Math.max(25, Math.min(80, Math.floor(maxFramePts * 0.03)));
            const anchorFns = sortedFns.filter(fn => frameData[fn].nPts >= anchorMinPts && frameData[fn].foundPlane);
            if (anchorFns.length >= 2) {
                for (const fn of sortedFns) {
                    const fd = frameData[fn];
                    if (fd.nPts >= anchorMinPts && fd.foundPlane) continue;
                    const prevA = anchorFns.filter(k => k <= fn);
                    const nextA = anchorFns.filter(k => k >= fn);
                    let zInterp, rxInterp, ryInterp;
                    if (prevA.length > 0 && nextA.length > 0) {
                        const k1 = prevA[prevA.length - 1], k2 = nextA[0];
                        const alpha = (k1 === k2) ? 0 : (fn - k1) / (k2 - k1);
                        const fd1 = frameData[k1], fd2 = frameData[k2];
                        zInterp = (1.0 - alpha) * fd1.pRoad[2] + alpha * fd2.pRoad[2];
                        rxInterp = (1.0 - alpha) * fd1.rRoad[0] + alpha * fd2.rRoad[0];
                        ryInterp = (1.0 - alpha) * fd1.rRoad[1] + alpha * fd2.rRoad[1];
                    } else if (prevA.length > 0) {
                        const fd1 = frameData[prevA[prevA.length - 1]];
                        zInterp = fd1.pRoad[2]; rxInterp = fd1.rRoad[0]; ryInterp = fd1.rRoad[1];
                    } else if (nextA.length > 0) {
                        const fd2 = frameData[nextA[0]];
                        zInterp = fd2.pRoad[2]; rxInterp = fd2.rRoad[0]; ryInterp = fd2.rRoad[1];
                    }
                    // Nếu frame ít điểm thân xe NHƯNG vẫn có mặt đường thực rõ ràng (gPts >= 12) và cao độ khớp quỹ đạo hoặc khớp anchor gần nhất (<= 0.45m) -> giữ mặt đường thực của chính nó!
                    if (zInterp !== undefined) {
                        let zNearest = zInterp;
                        let bestDistFn = Infinity;
                        for (const ak of anchorFns) {
                            const df = Math.abs(ak - fn);
                            if (df < bestDistFn) {
                                bestDistFn = df;
                                zNearest = frameData[ak].pRoad[2];
                            }
                        }
                        const hasValidOwnRoad = fd.foundPlane && fd.nGroundPts >= 12 &&
                            (Math.abs(fd.pRoad[2] - zInterp) <= 0.40 || Math.abs(fd.pRoad[2] - zNearest) <= 0.45);
                        if (!hasValidOwnRoad) {
                            fd.pRoad[2] = zInterp;
                            fd.rRoad[0] = rxInterp;
                            fd.rRoad[1] = ryInterp;
                            fd.rotMat = this.eulerXYZToMatrix(fd.rRoad[0], fd.rRoad[1], fd.rRoad[2]);
                        } else if (fd.nGroundPts < 25) {
                            fd.rRoad[0] = rxInterp;
                            fd.rRoad[1] = ryInterp;
                            fd.rotMat = this.eulerXYZToMatrix(fd.rRoad[0], fd.rRoad[1], fd.rRoad[2]);
                        }
                    }
                }
            }

            // BƯỚC 2: Cập nhật tâm Z khít đất và góc tự cân bằng (Roll, Pitch) cho từng shape
            for (const fn of sortedFns) {
                const fd = frameData[fn];
                const s = fd.shape;
                // Cập nhật cao độ tâm Z khít đất
                s.points[2] = parseFloat(fd.pRoad[2].toFixed(3));
                // Cập nhật góc tự cân bằng theo mặt đường
                s.points[3] = parseFloat(fd.rRoad[0].toFixed(3));
                s.points[4] = parseFloat(fd.rRoad[1].toFixed(3));
            }

            // BƯỚC 3: Tính toán dịch chuyển (dx, dy) — Phân tách Frame Tin Cậy (Anchor) vs Frame Khuất/Xa Thưa (Constrained Fit)
            const nF = sortedFns.length;
            const dxRaw = new Array(nF).fill(0.0);
            const dyRaw = new Array(nF).fill(0.0);
            const validMask = new Array(nF).fill(false);
            const reliableMask = new Array(nF).fill(false);
            const keyframesDone = {};
            const relMinPts = Math.max(25, Math.min(60, Math.floor(maxFramePts * 0.02)));

            for (let i = 0; i < nF; i++) {
                const fn = sortedFns[i];
                const fd = frameData[fn];
                if (fd.nPts < 6) continue;

                const isReliable = fd.nPts >= relMinPts || (fd.nPts >= 18 && (fd.rX !== null || fd.fX !== null) && fd.fY !== null);
                reliableMask[i] = isReliable;
                let effMaxShift = isReliable ? maxShift : Math.min(maxShift, 0.20);
                if (fd.carScore !== undefined && fd.carScore < 0.45) {
                    effMaxShift = Math.min(effMaxShift, 0.30);
                }

                const shift = this.tinhDxDyMep(
                    fd.ex0, fd.ex1, fd.ey0, fd.ey1,
                    L_star, W_star, fd.sx, fd.sy,
                    pad, isVeh, effMaxShift,
                    fd.rX, fd.fX, fd.fY
                );
                let dx = shift.dx, dy = shift.dy;

                // Chống tụt tâm về 1 góc khi frame bị khuất/xa (thiếu cả 2 cản hoặc thiếu sườn và bề rộng/dài thấy được < 55%)
                if (!isReliable) {
                    if (fd.rX === null && fd.fX === null && (fd.ex1 - fd.ex0) < 0.55 * L_star) {
                        dx = 0.0;
                        if (fd.ex1 > L_star / 2.0 + 0.04) dx = fd.ex1 - (L_star / 2.0 + 0.02);
                        else if (fd.ex0 < -L_star / 2.0 - 0.04) dx = fd.ex0 + (L_star / 2.0 + 0.02);
                        dx = Math.max(-effMaxShift, Math.min(effMaxShift, dx));
                    }
                    const dS_fd = Math.hypot(fd.sx, fd.sy);
                    const nSy_fd = dS_fd > 1.0 ? fd.sy / dS_fd : fd.sy;
                    const hasFlankDir = Math.abs(nSy_fd) > 0.20 || (Math.abs(nSy_fd) > 0.07 && Math.abs(fd.sy) >= 1.2);
                    if ((fd.fY === null || !hasFlankDir) && (fd.ey1 - fd.ey0) < 0.55 * W_star) {
                        dy = 0.0;
                        if (fd.ey1 > W_star / 2.0 + 0.04) dy = fd.ey1 - (W_star / 2.0 + 0.02);
                        else if (fd.ey0 < -W_star / 2.0 - 0.04) dy = fd.ey0 + (W_star / 2.0 + 0.02);
                        dy = Math.max(-effMaxShift, Math.min(effMaxShift, dy));
                    }
                }

                dxRaw[i] = dx;
                dyRaw[i] = dy;
                validMask[i] = true;
            }

            // Áp dụng dịch chuyển trực tiếp cho các frames đủ điểm
            for (let i = 0; i < nF; i++) {
                const fn = sortedFns[i];
                const fd = frameData[fn];
                if (fd.nPts >= 6 && validMask[i]) {
                    const dx = dxRaw[i];
                    const dy = dyRaw[i];

                    const shiftP = this.matVecMul(fd.rotMat, [dx, dy, 0.0]);
                    const pNew = [fd.pRoad[0] + shiftP[0], fd.pRoad[1] + shiftP[1], fd.pRoad[2] + shiftP[2]];

                    const s = fd.shape;
                    const change = Math.hypot(pNew[0] - s.points[0], pNew[1] - s.points[1], pNew[2] - s.points[2]);
                    if (change > maxChange) maxChange = change;

                    s.points[0] = parseFloat(pNew[0].toFixed(3));
                    s.points[1] = parseFloat(pNew[1].toFixed(3));
                    s.points[2] = parseFloat(pNew[2].toFixed(3));
                    keyframesDone[fn] = { pFin: pNew, rFin: fd.rRoad, dx, dy, isReliable: reliableMask[i] };

                    // Đóng băng frame nếu độ dịch chuyển đã siêu nhỏ (<= 5mm)
                    if (change <= 0.005) {
                        convergedFrames.add(fn);
                    }
                }
            }

            // Hàm dự đoán quỹ đạo động học từ các Anchor tin cậy (nội suy tuyến tính / ngoại suy hồi quy 4 điểm gần nhất)
            const sortedKf = Object.keys(keyframesDone).map(k => parseInt(k, 10)).sort((a, b) => a - b);
            const reliableKf = sortedKf.filter(fn => keyframesDone[fn].isReliable);
            const anchorPoolKf = reliableKf.length >= 2 ? reliableKf : sortedKf;

            const isSafeInterp = (fn) => {
                if (anchorPoolKf.length < 2) return false;
                const prevKf = anchorPoolKf.filter(k => k <= fn);
                const nextKf = anchorPoolKf.filter(k => k >= fn);
                if (prevKf.length > 0 && nextKf.length > 0) {
                    const k1 = prevKf[prevKf.length - 1], k2 = nextKf[0];
                    if (k2 - k1 > 6) return false;
                    const dyaw = Math.abs(this.wrapToPi(keyframesDone[k2].rFin[2] - keyframesDone[k1].rFin[2]));
                    return dyaw <= 0.26; // <= 15°
                }
                return false;
            };

            const predictPosFromAnchors = (fn) => {
                if (anchorPoolKf.length === 0) return null;
                if (anchorPoolKf.length === 1) return keyframesDone[anchorPoolKf[0]].pFin;
                const prevKf = anchorPoolKf.filter(k => k <= fn);
                const nextKf = anchorPoolKf.filter(k => k >= fn);
                if (prevKf.length > 0 && nextKf.length > 0) {
                    const k1 = prevKf[prevKf.length - 1], k2 = nextKf[0];
                    if (k1 === k2) return keyframesDone[k1].pFin;
                    const alpha = (fn - k1) / (k2 - k1);
                    const p1 = keyframesDone[k1].pFin, p2 = keyframesDone[k2].pFin;
                    return [
                        (1.0 - alpha) * p1[0] + alpha * p2[0],
                        (1.0 - alpha) * p1[1] + alpha * p2[1],
                        (1.0 - alpha) * p1[2] + alpha * p2[2]
                    ];
                }
                // Ngoài biên: chỉ ngoại suy tối đa 2 frame liền kề trên đoạn thẳng, không ngoại suy xa khi rẽ cua
                const win = (prevKf.length > 0) ? prevKf.slice(-3) : nextKf.slice(0, 3);
                const edgeK = (prevKf.length > 0) ? prevKf[prevKf.length - 1] : nextKf[0];
                if (win.length < 2 || Math.abs(fn - edgeK) > 2) return null;
                const dyawEdge = Math.abs(this.wrapToPi(keyframesDone[win[win.length - 1]].rFin[2] - keyframesDone[win[0]].rFin[2]));
                if (dyawEdge > 0.09) return null;
                let sumT = 0, sumX = 0, sumY = 0, sumZ = 0;
                for (const k of win) {
                    const p = keyframesDone[k].pFin;
                    sumT += k; sumX += p[0]; sumY += p[1]; sumZ += p[2];
                }
                const mT = sumT / win.length, mX = sumX / win.length, mY = sumY / win.length, mZ = sumZ / win.length;
                let den = 0, numX = 0, numY = 0, numZ = 0;
                for (const k of win) {
                    const dt = k - mT, p = keyframesDone[k].pFin;
                    den += dt * dt;
                    numX += dt * (p[0] - mX);
                    numY += dt * (p[1] - mY);
                    numZ += dt * (p[2] - mZ);
                }
                if (den < 1e-6) return [mX, mY, mZ];
                const dtPred = fn - mT;
                return [mX + (numX / den) * dtPred, mY + (numY / den) * dtPred, mZ + (numZ / den) * dtPred];
            };

            // Chống trôi cho các frame khuất/xa thưa (!isReliable) CHỈ KHI nằm trong khoảng nội suy an toàn giữa 2 Anchor gần nhau
            if (reliableKf.length >= 2) {
                for (let i = 0; i < nF; i++) {
                    const fn = sortedFns[i];
                    if (reliableMask[i] || !validMask[i] || !isSafeInterp(fn)) continue;
                    const pPred = predictPosFromAnchors(fn);
                    if (!pPred) continue;
                    const s = frameData[fn].shape;
                    const errXY = Math.hypot(s.points[0] - pPred[0], s.points[1] - pPred[1]);
                    if (errXY > 0.65) {
                        const scaleBack = 0.45 / errXY;
                        const clampedX = pPred[0] + (s.points[0] - pPred[0]) * scaleBack;
                        const clampedY = pPred[1] + (s.points[1] - pPred[1]) * scaleBack;
                        s.points[0] = parseFloat(clampedX.toFixed(3));
                        s.points[1] = parseFloat(clampedY.toFixed(3));
                        if (keyframesDone[fn]) {
                            keyframesDone[fn].pFin[0] = clampedX;
                            keyframesDone[fn].pFin[1] = clampedY;
                        }
                    }
                }
            }

            // BƯỚC 4: Nội suy / ngoại suy cho các frames rất ít điểm (< 6 điểm) CHỈ từ các Anchor tin cậy (chống lan truyền sai số)
            if (anchorPoolKf.length > 0) {
                for (const s of shapes) {
                    if (s.outside || !s.points || s.points.length < 9) continue;
                    const fn = s.frame;
                    if (targetFrames && !targetFrames.has(fn)) continue;
                    if (!keyframesDone[fn] && !(contextCache.get(fn) && contextCache.get(fn).ambiguous)) {
                        let pFin = null;
                        if (anchorPoolKf.length === 1) {
                            const kf = keyframesDone[anchorPoolKf[0]];
                            const rotM = this.eulerXYZToMatrix(s.points[3] || 0, s.points[4] || 0, s.points[5] || 0);
                            const shiftP = this.matVecMul(rotM, [kf.dx, kf.dy, 0.0]);
                            pFin = [s.points[0] + shiftP[0], s.points[1] + shiftP[1], s.points[2] + shiftP[2]];
                        } else {
                            pFin = predictPosFromAnchors(fn);
                            if (!pFin) {
                                const prevKf = anchorPoolKf.filter(k => k <= fn);
                                const nextKf = anchorPoolKf.filter(k => k >= fn);
                                const refKf = prevKf.length > 0 ? keyframesDone[prevKf[prevKf.length - 1]] : keyframesDone[nextKf[0]];
                                const rotM = this.eulerXYZToMatrix(s.points[3] || 0, s.points[4] || 0, s.points[5] || 0);
                                const shiftP = this.matVecMul(rotM, [refKf.dx, refKf.dy, 0.0]);
                                pFin = [s.points[0] + shiftP[0], s.points[1] + shiftP[1], s.points[2] + shiftP[2]];
                            }
                        }
                        if (pFin) {
                            s.points[0] = parseFloat(pFin[0].toFixed(3));
                            s.points[1] = parseFloat(pFin[1].toFixed(3));
                            s.points[2] = parseFloat(pFin[2].toFixed(3));
                        }
                    }
                }
            }

            // ĐIỀU KIỆN DỪNG VÒNG LẶP: Hội tụ từng frame độc lập
            actualRoundsRun = iter + 1;
            if (iter === 0 && maxChange <= 0.005) {
                allConvergedOnPass0 = true;
                break;
            }
            if (convergedFrames.size >= totalActiveFrames || (iter > 0 && maxChange < 0.003)) {
                break;
            }
        }

        // Báo cáo hội tụ chi tiết cho giao diện UI
        const nConv = convergedFrames.size;
        const nSkip = Math.max(0, totalActiveFrames - nConv);
        track._afBaoCao = {
            nConverged: nConv,
            nSkipped: nSkip,
            rounds: actualRoundsRun,
            totalFrames: totalActiveFrames
        };

        // BƯỚC 5: Làm mượt cực nhẹ rung lắc nhỏ (< 5cm) trong phạm vi targetFrames
        // Bỏ qua làm mượt nếu toàn bộ frame đã hội tụ chuẩn ngay từ đầu (bảo toàn đứng im tuyệt đối khi bấm lần 2)
        if (!allConvergedOnPass0) {
            this.lamMuotQuyDaoTrack(track, targetFrames, 0.05);
        }

        if (ambiguousFrames.length > 0) {
            for (const s of shapes) {
                const ctx = contextCache.get(s.frame);
                if (ctx && ctx.ambiguous && ctx.origPoints) {
                    s.points[0] = ctx.origPoints[0];
                    s.points[1] = ctx.origPoints[1];
                }
            }
        }
        track._ambiguousFrames = ambiguousFrames;

        return true;
    }

    static canChinhTrackXeHaiBanh(track, pcdsMap = null, neighborBoxesDict = null, pad = 0.02, targetFrames = null) {
        if (targetFrames && !(targetFrames instanceof Set)) {
            targetFrames = new Set(targetFrames);
        }
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        const shapes = track.shapes;
        const activeShapes = shapes.filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length === 0) return false;

        const ls = activeShapes.map(s => s.points[6]).sort((a, b) => a - b);
        const ws = activeShapes.map(s => s.points[7]).sort((a, b) => a - b);
        const origL = ls[Math.floor(ls.length / 2)];
        const origW = ws[Math.floor(ws.length / 2)];

        let L_star, W_star, H_star;
        if (origL <= 1.80 && origW <= 0.70) {
            L_star = 1.75; W_star = 0.65; H_star = 1.50; // Xe đạp
        } else {
            L_star = 1.95; W_star = 0.80; H_star = 1.55; // Xe máy tiêu chuẩn
        }

        for (const s of shapes) {
            if (s.points && s.points.length >= 9) {
                s.points[6] = L_star;
                s.points[7] = W_star;
                s.points[8] = H_star;
            }
        }

        const keyframesDone = {};
        for (const s of activeShapes) {
            const fn = s.frame;
            if (targetFrames && !targetFrames.has(fn)) continue;
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            if (!pts || pts.length === 0) continue;

            const pos = [s.points[0], s.points[1], s.points[2]];
            const rot = [s.points[3], s.points[4], s.points[5]];
            const size = [L_star, W_star, H_star];

            const resRoad = this.canChinhMatDuongHop(pos, rot, size, pts);
            const pRoad = resRoad.newPos;
            const rRoad = resRoad.newRot;
            const rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);

            const cluster = this.trichXuatDiemThanXeCatLop(
                pts, pRoad[0], pRoad[1], pRoad[2],
                rRoad[0], rRoad[1], rRoad[2],
                L_star, W_star, H_star,
                false, 0.55, 0.45
            );
            const vx = cluster.xp, vy = cluster.yp, vz = cluster.zp;
            const nPts = vx.length;

            if (nPts >= 4) {
                let dx = 0.0, dy = 0.0;
                const riderIdx = [];
                for (let i = 0; i < nPts; i++) {
                    if (vz[i] >= 0.35) riderIdx.push(i);
                }
                if (riderIdx.length >= 3) {
                    const rxVals = riderIdx.map(i => vx[i]).sort((a, b) => a - b);
                    const ryVals = riderIdx.map(i => vy[i]).sort((a, b) => a - b);
                    dx = rxVals[Math.floor(rxVals.length / 2)] + 0.18;
                    dy = ryVals[Math.floor(ryVals.length / 2)];
                } else {
                    const sxVals = [...vx].sort((a, b) => a - b);
                    const syVals = [...vy].sort((a, b) => a - b);
                    dx = sxVals[Math.floor(sxVals.length / 2)];
                    dy = syVals[Math.floor(syVals.length / 2)];
                }
                dx = Math.max(-0.45, Math.min(0.45, dx));
                dy = Math.max(-0.30, Math.min(0.30, dy));

                // Ghim đáy sát mặt đường Z_bottom = Z_road - 0.01m
                const shiftP = this.matVecMul(rotMat, [dx, dy, 0.0]); // Khít mặt đường phẳng, không lún sâu
                const pFin = [pRoad[0] + shiftP[0], pRoad[1] + shiftP[1], pRoad[2] + shiftP[2]];
                s.points[0] = parseFloat(pFin[0].toFixed(3));
                s.points[1] = parseFloat(pFin[1].toFixed(3));
                s.points[2] = parseFloat(pFin[2].toFixed(3));
                s.points[3] = parseFloat(rRoad[0].toFixed(3));
                s.points[4] = parseFloat(rRoad[1].toFixed(3));
                keyframesDone[fn] = { pFin, rFin: rRoad };
            }
        }

        // Khóa hướng quay theo vector vận tốc di chuyển giữa các frame
        activeShapes.sort((a, b) => a.frame - b.frame);
        for (let i = 0; i < activeShapes.length; i++) {
            let vxM = 0.0, vyM = 0.0;
            if (i === 0 && activeShapes.length > 1) {
                vxM = activeShapes[1].points[0] - activeShapes[0].points[0];
                vyM = activeShapes[1].points[1] - activeShapes[0].points[1];
            } else if (i === activeShapes.length - 1 && activeShapes.length > 1) {
                vxM = activeShapes[i].points[0] - activeShapes[i - 1].points[0];
                vyM = activeShapes[i].points[1] - activeShapes[i - 1].points[1];
            } else if (activeShapes.length > 2) {
                vxM = (activeShapes[i + 1].points[0] - activeShapes[i - 1].points[0]) / 2.0;
                vyM = (activeShapes[i + 1].points[1] - activeShapes[i - 1].points[1]) / 2.0;
            }

            const speedStep = Math.hypot(vxM, vyM);
            if (speedStep >= 0.05) {
                const headingYaw = Math.atan2(vyM, vxM);
                const currYaw = activeShapes[i].points[5];
                const diff = ((headingYaw - currYaw + Math.PI) % (2 * Math.PI)) - Math.PI;
                if (Math.abs(Math.abs(diff) - Math.PI / 2.0) < 0.35 || Math.abs(diff) > Math.PI * 0.65) {
                    activeShapes[i].points[5] = parseFloat(headingYaw.toFixed(3));
                }
            }
        }

        this.khuLatGocTrack(track);
        this.lamMuotQuyDaoTrack(track, targetFrames, 0.08);
        return true;
    }

    /**
     * CĂN CHỈNH TRACK NGƯỜI ĐI BỘ V2.0 (PEDESTRIAN CHUẨN EXE)
     */
    static canChinhTrackNguoiDiBo(track, pcdsMap = null, neighborBoxesDict = null, pad = 0.02, targetFrames = null) {
        if (targetFrames && !(targetFrames instanceof Set)) {
            targetFrames = new Set(targetFrames);
        }
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        const shapes = track.shapes;
        const activeShapes = shapes.filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length === 0) return false;

        const L_star = 0.65, W_star = 0.65, H_star = 1.70;
        for (const s of shapes) {
            if (s.points && s.points.length >= 9) {
                s.points[6] = L_star;
                s.points[7] = W_star;
                s.points[8] = H_star;
            }
        }

        const keyframesDone = {};
        for (const s of activeShapes) {
            const fn = s.frame;
            if (targetFrames && !targetFrames.has(fn)) continue;
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            if (!pts || pts.length === 0) continue;

            const pos = [s.points[0], s.points[1], s.points[2]];
            const rot = [s.points[3], s.points[4], s.points[5]];
            const size = [L_star, W_star, H_star];

            const resRoad = this.canChinhMatDuongHop(pos, rot, size, pts);
            const pRoad = resRoad.newPos;
            const rRoad = resRoad.newRot;
            const rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);

            const cluster = this.trichXuatDiemThanXeCatLop(
                pts, pRoad[0], pRoad[1], pRoad[2],
                rRoad[0], rRoad[1], rRoad[2],
                L_star, W_star, H_star,
                false, 0.35, 0.35
            );
            const vx = cluster.xp, vy = cluster.yp;
            const nPts = vx.length;

            if (nPts >= 3) {
                const sxVals = [...vx].sort((a, b) => a - b);
                const syVals = [...vy].sort((a, b) => a - b);
                let dx = sxVals[Math.floor(sxVals.length / 2)];
                let dy = syVals[Math.floor(syVals.length / 2)];
                dx = Math.max(-0.30, Math.min(0.30, dx));
                dy = Math.max(-0.30, Math.min(0.30, dy));

                const shiftP = this.matVecMul(rotMat, [dx, dy, 0.0]);
                const pFin = [pRoad[0] + shiftP[0], pRoad[1] + shiftP[1], pRoad[2] + shiftP[2]];
                s.points[0] = parseFloat(pFin[0].toFixed(3));
                s.points[1] = parseFloat(pFin[1].toFixed(3));
                s.points[2] = parseFloat(pFin[2].toFixed(3));
                s.points[3] = parseFloat(rRoad[0].toFixed(3));
                s.points[4] = parseFloat(rRoad[1].toFixed(3));
                keyframesDone[fn] = { pFin, rFin: rRoad };
            }
        }

        this.lamMuotQuyDaoTrack(track, targetFrames, 0.08);
        return true;
    }

    /**
     * Chuẩn hóa labelsMap từ Array, Map hoặc Object {[id]: label} thành Object {[id]: label}
     */
    static _normalizeLabelsMap(labelsMap) {
        if (!labelsMap) return {};
        if (labelsMap instanceof Map) {
            const out = {};
            for (const [k, v] of labelsMap.entries()) {
                if (v && typeof v === 'object') {
                    const key = v.id !== undefined ? v.id : k;
                    out[key] = v;
                }
            }
            return out;
        }
        if (Array.isArray(labelsMap)) {
            const out = {};
            for (let i = 0; i < labelsMap.length; i++) {
                const lbl = labelsMap[i];
                if (lbl && lbl.id !== undefined) {
                    out[lbl.id] = lbl;
                }
            }
            return out;
        }
        if (typeof labelsMap === 'object') {
            return labelsMap;
        }
        return {};
    }

    /**
     * Suy luận phân loại nhãn thông minh cho Track (Smart Label Resolution):
     * 1. Tra cứu theo ID trong labelMap
     * 2. Tra cứu theo ID dự phòng chuẩn (Job 4637659: 8661578, Job 1523: 12871...)
     * 3. Đọc từ DOM phần tử đang chọn trên CVAT sidebar (nếu có)
     * 4. Suy luận theo kích thước chiều dài hình hộp (L > 2.2m -> vehicles, L > 1.2m -> two-wheels, ...)
     * TUYỆT ĐỐI KHÔNG BAO GIỜ mặc định thành pedestrian!
     */
    static suyLuanNhanTrack(track, labelMap = {}) {
        if (!track) return 'vehicles';
        const normMap = this._normalizeLabelsMap(labelMap);
        const lid = track.label_id;
        if (normMap && normMap[lid]?.name) {
            return normMap[lid].name;
        }

        const idMap = {
            8661578: 'vehicles',
            8661579: 'pedestrian',
            8661580: 'two-wheels',
            12871: 'vehicles',
            12872: 'pedestrian',
            12873: 'two-wheels',
            12874: 'Animal',
            12875: 'Obstacle'
        };
        if (lid !== undefined && idMap[lid]) {
            return idMap[lid];
        }

        // Đọc từ active DOM element nếu đang chạy trong trình duyệt
        if (typeof document !== 'undefined') {
            try {
                const trackId = track.id;
                const sidebarItem = (trackId !== undefined ? document.querySelector(`.cvat-objects-sidebar-item[data-item-id="${trackId}"]`) : null) ||
                                    document.querySelector('.cvat-objects-sidebar-item-active') ||
                                    document.querySelector('.cvat-objects-sidebar-item.selected');
                if (sidebarItem) {
                    const text = (sidebarItem.textContent || '').toLowerCase();
                    if (text.includes('vehicle') || text.includes('car') || text.includes('ô tô')) return 'vehicles';
                    if (text.includes('two-wheel') || text.includes('motor') || text.includes('xe máy') || text.includes('bike')) return 'two-wheels';
                    if (text.includes('pedestrian') || text.includes('người')) return 'pedestrian';
                }
            } catch (e) {}
        }

        // Suy luận từ kích thước bounding box (Dimensions Prior)
        if (track.shapes && track.shapes.length > 0) {
            const sh = track.shapes.find(s => !s.outside && s.points && s.points.length >= 9) ||
                       track.shapes.find(s => s.points && s.points.length >= 9);
            if (sh && sh.points) {
                const L = sh.points[6];
                if (L > 2.2) return 'vehicles';
                if (L > 1.2) return 'two-wheels';
                return 'pedestrian';
            }
        }

        // KHÔNG BAO GIỜ mặc định thành pedestrian
        return 'vehicles';
    }

    /**
     * CĂN CHỈNH TRACK V2.0 (ĐIỀU HƯỚNG MASTER THEO NHÃN CHUẨN EXE)
     */
    static canChinhTrackV2(track, labelName = null, pcdsMap = null, scanScale = 1.0, targetFrames = null, neighborBoxesDict = null) {
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }

        if (lbl.includes('two-wheels') || lbl.includes('moto') || lbl === '12873' || lbl === '8661580') {
            return this.canChinhTrackXeHaiBanh(track, pcdsMap, neighborBoxesDict, 0.02, targetFrames);
        } else if (lbl.includes('pedestrian') || lbl === '12872' || lbl === '8661579') {
            return this.canChinhTrackNguoiDiBo(track, pcdsMap, neighborBoxesDict, 0.02, targetFrames);
        } else {
            // Xe ô tô: Áp dụng thuật toán Master theo thứ tự ưu tiên chuẩn Desktop EXE (3 Pass + Khóa mép 2cm + Enclosure Guardrail chống trôi dạt)
            return this.canChinhTrackTheoThuTuUuTien(track, pcdsMap, lbl, neighborBoxesDict, 0.025, scanScale, targetFrames);
        }
    }

    /**
     * THUẬT TOÁN 5: CĂN CHỈNH TOÀN DIỆN (TOÀN JOB) - MASTER ALIGNMENT
     */
    static canChinhToanDienToanJob(annotations, labelMap = {}, pcdsMap = null) {
        if (!annotations || !annotations.tracks) {
            throw new Error("Không có dữ liệu annotations để căn chỉnh.");
        }

        let soTrackKhoaSize = 0;
        let soTrackKhoaBaoVe = 0;

        // 1. Bước 1: Ổn định góc Yaw / Khử lật góc 180° toàn job TRƯỚC (chuẩn Desktop EXE)
        const resYaw = this.khuLatGocToanJob(annotations);

        // 2. Bước 2: Căn chỉnh từng track theo đúng Master Pipeline (chuẩn EXE 100%, bảo vệ xe máy & người đi bộ)
        for (const tr of annotations.tracks) {
            if (tr.lock || tr.khoa_track || tr.khoa_toan_bo || tr.khoa_chinh_tay) {
                soTrackKhoaBaoVe++;
                continue;
            }
            const lname = this.suyLuanNhanTrack(tr, labelMap);
            const nbDict = this.layNeighborBoxesTuAnnotations(annotations, tr, null, labelMap);
            // canChinhTrackV2 tự động điều hướng: ô tô -> Master Pipeline, xe máy -> Prior 1.95m, người đi bộ -> 0.65m
            const ok = this.canChinhTrackV2(tr, lname, pcdsMap, 1.0, null, nbDict);
            if (ok) soTrackKhoaSize++;
        }

        // 3. Bước 3: Soi trùng lặp & loại bỏ hộp đè nhau (Loại bỏ các hộp trùng lặp > 85%)
        const resDup = this.soiTrungLapToanJob(annotations, 0.85);

        // LƯU Ý: Tuyệt đối KHÔNG gọi lại khopMatDuongToanJob hay lamMuotQuyDaoToanJob ở đây
        // vì canChinhTrackV2 / canChinhTrackTheoThuTuUuTien đã tự động khớp mặt đường RANSAC,
        // khóa mép và làm mượt quỹ đạo SLERP khép kín. Việc gọi lại sẽ gây trôi lệch lũy tích (Drift).
        return {
            soTrackKhoaSize,
            soTrackKhoaBaoVe,
            soFrameSuaGoc: resYaw.soFrameDaSua,
            soHinhKhopMatDuong: 0,
            soFrameDaMuot: 0,
            soCapTrung: resDup.soCapTrung
        };
    }

    static quetOutsideThongMinh(track, nguongBuocNhay = 3.5) {
        if (!track || !track.shapes) return 0;
        const shapes = (track.shapes || []).filter(s => s.points && s.points.length >= 9);
        if (shapes.length === 0) return 0;

        shapes.sort((a, b) => a.frame - b.frame);
        let count = 0;

        // Track chỉ có đúng 1 shape cô lập trong toàn bộ job
        const activeShapes = shapes.filter(s => !s.outside);
        if (activeShapes.length === 1) {
            activeShapes[0].outside = true;
            return 1;
        }

        // Quét bước nhảy dịch chuyển đột biến (Teleportation)
        for (let i = 1; i < activeShapes.length; i++) {
            const prev = activeShapes[i - 1];
            const cur = activeShapes[i];
            const dFrame = Math.abs(cur.frame - prev.frame);
            const dist = Math.hypot(cur.points[0] - prev.points[0], cur.points[1] - prev.points[1]);

            // Nếu chỉ cách 1-2 frame mà nhảy xa hơn 3.5m/frame (tương đương vận tốc > 120km/h)
            if (dFrame <= 2 && dist > nguongBuocNhay * dFrame) {
                cur.outside = true;
                count++;
            }
        }
        return count;
    }

    /**
     * QUÉT OUTSIDE TOÀN JOB
     */
    static quetOutsideToanJob(annotations) {
        if (!annotations || !annotations.tracks) return { soShapeOutside: 0 };
        let count = 0;
        for (const tr of annotations.tracks) {
            count += this.quetOutsideThongMinh(tr);
        }
        return { soShapeOutside: count };
    }

    /**
     * THUẬT TOÁN 7: TỰ CHỮA LÀNH OUTSIDE (BI-DIRECTIONAL SELF-HEALING)
     */
    /**
     * TỰ CHỮA LÀNH OUTSIDE 2 CHIỀU CHUẨN EXE (ĐẾM ĐIỂM LIDAR TRONG HỘP)
     * - Nếu >= 5 điểm: phục hồi Active (outside = false)
     * - Nếu < 5 điểm: đánh dấu Outside (outside = true)
     */
    static tuChuaLanhOutsideTrack(track, pcdsMap = null) {
        if (!track || !track.shapes) return { soKhoiPhuc: 0, soOutsideMoi: 0 };
        let soKhoiPhuc = 0, soOutsideMoi = 0;
        for (const s of track.shapes) {
            if (!s.points || s.points.length < 9) continue;
            const fn = s.frame;
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
            let ptCnt = 0;
            if (pts && pts.length > 0) {
                const cosR = Math.cos(rz), sinR = Math.sin(rz);
                for (let i = 0; i < pts.length; i++) {
                    const dx = pts[i][0] - cx;
                    const dy = pts[i][1] - cy;
                    const dz = pts[i][2] - cz;
                    const u = cosR * dx + sinR * dy;
                    const v = -sinR * dx + cosR * dy;
                    if (Math.abs(u) <= L / 2 && Math.abs(v) <= W / 2 && Math.abs(dz) <= H / 2) {
                        ptCnt++;
                    }
                }
            } else {
                ptCnt = s.outside ? 0 : 15;
            }

            const wasOut = !!s.outside;
            if (ptCnt >= 5) {
                if (wasOut) {
                    s.outside = false;
                    soKhoiPhuc++;
                }
            } else {
                if (!wasOut) {
                    s.outside = true;
                    soOutsideMoi++;
                }
            }
        }
        return { soKhoiPhuc, soOutsideMoi };
    }

    static tuChuaLanhOutsideToanJob(annotations, pcdsMap = null) {
        if (!annotations || !annotations.tracks) return { soShapeKhoiPhuc: 0 };
        let soShapeKhoiPhuc = 0;
        for (const tr of annotations.tracks) {
            const shapes = tr.shapes || [];
            if (shapes.length <= 1) continue;
            for (let i = 0; i < shapes.length; i++) {
                const s = shapes[i];
                if (s.outside) {
                    const prevActive = shapes.slice(0, i).some(x => !x.outside);
                    const nextActive = shapes.slice(i + 1).some(x => !x.outside);
                    if (prevActive && nextActive) {
                        s.outside = false;
                        soShapeKhoiPhuc++;
                    }
                }
            }
        }
        return { soShapeKhoiPhuc };
    }

    /**
     * THUẬT TOÁN 8: SOI TRÙNG LẶP & LOẠI BỎ BOX ĐÈ NHAU
     */
    static quetTrungLapFrame(annotations, frame, nguongKhoangCach = 0.85) {
        if (!annotations || !annotations.tracks) return [];

        const activeBoxes = [];
        for (let i = 0; i < annotations.tracks.length; i++) {
            const tr = annotations.tracks[i];
            const shape = this.timShapeTrongFrame(tr, frame);
            if (shape && !shape.outside && shape.points && shape.points.length >= 9) {
                activeBoxes.push({
                    trackId: tr.id || (i + 1),
                    shapeRef: shape,
                    center: [shape.points[0], shape.points[1], shape.points[2]]
                });
            }
        }

        const trungLap = [];
        for (let i = 0; i < activeBoxes.length; i++) {
            for (let j = i + 1; j < activeBoxes.length; j++) {
                const b1 = activeBoxes[i];
                const b2 = activeBoxes[j];
                if (b1.shapeRef.outside || b2.shapeRef.outside) continue;

                const dx = b1.center[0] - b2.center[0];
                const dy = b1.center[1] - b2.center[1];
                const dz = b1.center[2] - b2.center[2];
                const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

                if (dist < nguongKhoangCach) {
                    trungLap.push({
                        track1: b1.trackId,
                        track2: b2.trackId,
                        khoangCach: dist,
                        box1: b1,
                        box2: b2
                    });
                }
            }
        }
        return trungLap;
    }

    static soiTrungLapToanJob(annotations, nguongKhoangCach = 0.85) {
        if (!annotations || !annotations.tracks) return { soCapTrung: 0, soTrackOutside: 0 };

        const trackMap = new Map();
        annotations.tracks.forEach((tr, idx) => {
            trackMap.set(tr.id || (idx + 1), tr);
        });

        let maxFrame = 0;
        for (const tr of annotations.tracks) {
            for (const s of (tr.shapes || [])) {
                if (s.frame > maxFrame) maxFrame = s.frame;
            }
        }

        let tongCap = 0;
        const tracksOutside = new Set();

        for (let f = 0; f <= maxFrame; f++) {
            const caps = this.quetTrungLapFrame(annotations, f, nguongKhoangCach);
            for (const c of caps) {
                if (c.box1.shapeRef.outside || c.box2.shapeRef.outside) continue;

                const tr1 = trackMap.get(c.track1);
                const tr2 = trackMap.get(c.track2);
                const len1 = (tr1?.shapes || []).filter(s => !s.outside).length;
                const len2 = (tr2?.shapes || []).filter(s => !s.outside).length;

                let boxToOutside;
                let idBiOutside;

                if (len1 !== len2) {
                    if (len1 > len2) {
                        boxToOutside = c.box2;
                        idBiOutside = c.track2;
                    } else {
                        boxToOutside = c.box1;
                        idBiOutside = c.track1;
                    }
                } else {
                    if (c.track1 > c.track2) {
                        boxToOutside = c.box1;
                        idBiOutside = c.track1;
                    } else {
                        boxToOutside = c.box2;
                        idBiOutside = c.track2;
                    }
                }

                boxToOutside.shapeRef.outside = true;
                tracksOutside.add(idBiOutside);
                tongCap++;
            }
        }

        return {
            soCapTrung: tongCap,
            soTrackOutside: tracksOutside.size,
            danhSachTrack: Array.from(tracksOutside)
        };
    }

    /**
     * THUẬT TOÁN 9: TÁCH TRACK KHI OUTSIDE KÉO DÀI (SPLIT TRACK ON GAP)
     */
    static splitTrackOnGap(track, maxOutsideGap = 5) {
        if (!track || !track.shapes || track.shapes.length === 0) return [track];
        const shapes = track.shapes;
        shapes.sort((a, b) => a.frame - b.frame);

        const groups = [];
        let curGroup = [];
        let outsideStreak = 0;

        for (const s of shapes) {
            if (s.outside) {
                outsideStreak++;
                if (outsideStreak >= maxOutsideGap && curGroup.length > 0) {
                    groups.push(curGroup);
                    curGroup = [];
                }
            } else {
                outsideStreak = 0;
                curGroup.push(s);
            }
        }
        if (curGroup.length > 0) groups.push(curGroup);
        if (groups.length <= 1) return [track];

        return groups.map((g, idx) => ({
            label_id: track.label_id,
            frame: g[0].frame,
            group: track.group || 0,
            attributes: track.attributes || [],
            source: 'manual',
            shapes: g
        }));
    }

    /**
     * THUẬT TOÁN 10: ĐỒNG BỘ KÍCH THƯỚC TRACK ĐƠN / NHÓM TRACK
     */
    static dongBoKichThuocTrack(annotations, trackId, L, W, H) {
        const track = this.timTrack(annotations, trackId);
        if (!track || !track.shapes) {
            throw new Error(`Không tìm thấy Track ID: #${trackId}`);
        }

        const lVal = Math.max(0.2, parseFloat(L));
        const wVal = Math.max(0.2, parseFloat(W));
        const hVal = Math.max(0.2, parseFloat(H));

        let count = 0;
        for (const s of track.shapes) {
            if (s.points && s.points.length >= 9) {
                const oldH = s.points[8];
                s.points[6] = lVal;
                s.points[7] = wVal;
                s.points[8] = hVal;
                s.points[2] = (s.points[2] - oldH / 2.0) + (hVal / 2.0);
                count++;
            }
        }
        return count;
    }

    static dongBoKichThuocDanhSachTrack(annotations, danhSachTrackId, L, W, H) {
        let tongFrame = 0;
        let soTrackThanhCong = 0;

        for (const tid of danhSachTrackId) {
            try {
                const count = this.dongBoKichThuocTrack(annotations, tid, L, W, H);
                if (count > 0) {
                    tongFrame += count;
                    soTrackThanhCong++;
                }
            } catch (e) {
                console.warn(`Bỏ qua Track #${tid}:`, e.message);
            }
        }
        return { soTrack: soTrackThanhCong, tongFrame };
    }

    /**
     * Đảo đầu xe 180° tại frame cụ thể
     */
    static daoDauXe180(annotations, trackId, currentFrame) {
        const track = this.timTrack(annotations, trackId);
        if (!track) throw new Error(`Không tìm thấy Track ID: #${trackId}`);

        const shape = this.timShapeTrongFrame(track, currentFrame);
        if (!shape || !shape.points || shape.points.length < 9) {
            throw new Error(`Track #${trackId} không xuất hiện tại frame ${currentFrame}`);
        }

        let rz = shape.points[5];
        let newRz = this.wrapToPi(rz + Math.PI);
        shape.points[5] = newRz;
        return newRz;
    }

    /**
     * Vi chỉnh cao độ Z (+/- deltaZ)
     */
    static viChinhCaoDoZ(annotations, trackId, currentFrame, deltaZ) {
        const track = this.timTrack(annotations, trackId);
        if (!track) throw new Error(`Không tìm thấy Track ID: #${trackId}`);

        const shape = this.timShapeTrongFrame(track, currentFrame);
        if (!shape || !shape.points || shape.points.length < 9) {
            throw new Error(`Track #${trackId} không xuất hiện tại frame ${currentFrame}`);
        }

        shape.points[2] += parseFloat(deltaZ);
        return shape.points[2];
    }

    /**
     * Tạm ẩn / phục hồi Outside
     */
    static toggleAnOutside(annotations, dangTamAn = false) {
        if (!annotations || !annotations.tracks) return { dangTamAn: false, soLuong: 0 };
        let count = 0;
        const newState = !dangTamAn;

        for (const tr of annotations.tracks) {
            for (const s of (tr.shapes || [])) {
                if (newState) {
                    if (s.outside) {
                        s._cvat_tam_an = true;
                        count++;
                    }
                } else {
                    if (s._cvat_tam_an) {
                        delete s._cvat_tam_an;
                        s.outside = true;
                        count++;
                    }
                }
            }
        }
        return { dangTamAn: newState, soLuong: count };
    }

    /**
     * Bảng thống kê chi tiết toàn Job (Đồng bộ chuẩn bản Desktop)
     */
    static tinhThongKeToanJob(annotations, labelMap = {}) {
        if (!annotations || !annotations.tracks) {
            return {
                tongTracks: 0,
                activeTracks: 0,
                outsideTracks: 0,
                tongShapes: 0,
                tongFrames: 60,
                tyLeHoanChinh: "0.0%",
                soTrackHoanChinh: 0,
                phanLoaiNhan: { 'vehicles': 0, 'two-wheels': 0, 'pedestrian': 0, 'khac': 0 },
                danhSach: {
                    vehicles: [],
                    twoWheels: [],
                    pedestrian: [],
                    khac: [],
                    outside: [],
                    chuaDuFrame: [],
                    hoanChinh: []
                }
            };
        }

        const tracks = annotations.tracks;
        let maxFrame = 0;
        let tongShapes = 0;
        let activeTracks = 0;
        let outsideTracks = 0;
        let soTrackHoanChinh = 0;
        const phanLoaiNhan = { 'vehicles': 0, 'two-wheels': 0, 'pedestrian': 0, 'khac': 0 };

        const danhSachVehicles = [];
        const danhSachTwoWheels = [];
        const danhSachPedestrian = [];
        const danhSachKhac = [];
        const danhSachOutside = [];
        const danhSachChuaDuFrame = [];
        const danhSachHoanChinh = [];

        for (const tr of tracks) {
            for (const s of (tr.shapes || [])) {
                if (s.frame > maxFrame) maxFrame = s.frame;
                tongShapes++;
            }
        }
        const tongFrames = Math.max(60, maxFrame + 1);

        for (let idx = 0; idx < tracks.length; idx++) {
            const tr = tracks[idx];
            const trackId = (tr.id !== undefined && tr.id !== null) ? tr.id : (idx + 1);
            const displayId = (tr._displayId !== undefined && tr._displayId !== null)
                ? tr._displayId
                : ((tr._trackNumber !== undefined && tr._trackNumber !== null)
                    ? tr._trackNumber
                    : ((tr._clientID !== undefined && tr._clientID !== null) ? tr._clientID : (idx + 1)));
            tr._displayId = displayId;
            tr._trackNumber = displayId;
            tr._clientID = displayId;

            const shapes = tr.shapes || [];
            const activeShapes = shapes.filter(s => !s.outside);
            const isOutside = (activeShapes.length === 0);

            const trackItem = {
                id: trackId,
                displayId: displayId,
                total: shapes.length,
                active: activeShapes.length,
                shapes: shapes,
                tr: tr
            };

            if (isOutside) {
                outsideTracks++;
                danhSachOutside.push(trackItem);
            } else {
                activeTracks++;
                const countActive = activeShapes.length;
                if (countActive >= tongFrames) {
                    soTrackHoanChinh++;
                    danhSachHoanChinh.push(trackItem);
                } else {
                    danhSachChuaDuFrame.push(trackItem);
                }
            }

            const lid = tr.label_id;
            const lObj = labelMap[lid];
            let rawName = lObj ? lObj.name.toLowerCase() : '';
            if (!rawName) {
                rawName = this.suyLuanNhanTrack(tr, labelMap).toLowerCase();
            }

            if (rawName.includes('vehicle') || rawName.includes('car') || lid === 12871 || lid === 8661578) {
                phanLoaiNhan['vehicles']++;
                danhSachVehicles.push(trackItem);
            } else if (rawName.includes('two-wheels') || rawName.includes('motorcycle') || lid === 12873 || lid === 8661580) {
                phanLoaiNhan['two-wheels']++;
                danhSachTwoWheels.push(trackItem);
            } else if (rawName.includes('pedestrian') || lid === 12872 || lid === 8661579) {
                phanLoaiNhan['pedestrian']++;
                danhSachPedestrian.push(trackItem);
            } else {
                phanLoaiNhan['khac']++;
                danhSachKhac.push(trackItem);
            }
        }

        const tyLeHoanChinh = tracks.length > 0 ? ((soTrackHoanChinh / tracks.length) * 100).toFixed(1) + '%' : '0.0%';

        return {
            tongTracks: tracks.length,
            activeTracks,
            outsideTracks,
            tongShapes,
            tongFrames,
            tyLeHoanChinh,
            soTrackHoanChinh,
            phanLoaiNhan,
            danhSach: {
                vehicles: danhSachVehicles,
                twoWheels: danhSachTwoWheels,
                pedestrian: danhSachPedestrian,
                khac: danhSachKhac,
                outside: danhSachOutside,
                chuaDuFrame: danhSachChuaDuFrame,
                hoanChinh: danhSachHoanChinh
            }
        };
    }

    // =========================================================================
    // CÔNG CỤ KIỂM ĐỊNH CHẤT LƯỢNG 3D ANNOTATION (QC TOOL ENGINE)
    // 1. Đồng bộ kích thước qua các frames (Size Consistency)
    // 2. Kích thước chuẩn theo khoảng min-max (Dimension Bounds)
    // 3. Xoay góc đột ngột (Sudden Yaw Jump / Flip)
    // 4. Chồng lấn giữa các box khi chưa đánh outside (Box Collision SAT)
    // =========================================================================

    /**
     * Tính 4 góc hình hộp trên mặt phẳng 2D BEV (Counter-Clockwise)
     */
    static layGocHop2D(x, y, yaw, L, W) {
        const cos = Math.cos(yaw || 0);
        const sin = Math.sin(yaw || 0);
        const hL = (L || 1) / 2;
        const hW = (W || 1) / 2;
        const ux = cos, uy = sin;
        const vx = -sin, vy = cos;
        return [
            { x: x + hL * ux + hW * vx, y: y + hL * uy + hW * vy },
            { x: x - hL * ux + hW * vx, y: y - hL * uy + hW * vy },
            { x: x - hL * ux - hW * vx, y: y - hL * uy - hW * vy },
            { x: x + hL * ux - hW * vx, y: y + hL * uy - hW * vy }
        ];
    }

    /**
     * Thuật toán kiểm tra va chạm 2D Separating Axis Theorem (SAT)
     */
    static satOverlap2D(cornersA, cornersB) {
        const polygons = [cornersA, cornersB];
        for (let p = 0; p < 2; p++) {
            const poly = polygons[p];
            for (let i = 0; i < poly.length; i++) {
                const next = (i + 1) % poly.length;
                const edgeX = poly[next].x - poly[i].x;
                const edgeY = poly[next].y - poly[i].y;
                const axisX = -edgeY;
                const axisY = edgeX;
                const len = Math.hypot(axisX, axisY);
                if (len === 0) continue;
                const nx = axisX / len;
                const ny = axisY / len;

                let minA = Infinity, maxA = -Infinity;
                for (const pt of cornersA) {
                    const proj = pt.x * nx + pt.y * ny;
                    if (proj < minA) minA = proj;
                    if (proj > maxA) maxA = proj;
                }

                let minB = Infinity, maxB = -Infinity;
                for (const pt of cornersB) {
                    const proj = pt.x * nx + pt.y * ny;
                    if (proj < minB) minB = proj;
                    if (proj > maxB) maxB = proj;
                }

                if (minA > maxB || minB > maxA) {
                    return false; // Có trục ngăn cách -> Không va chạm
                }
            }
        }
        return true; // Va chạm trên tất cả các trục
    }

    /**
     * Cắt đa giác Sutherland-Hodgman và tính diện tích phần chồng lấn 2D BEV
     */
    static clipPolygon2D(subjectPoly, clipEdgeP1, clipEdgeP2) {
        const outputList = [];
        const isInside = (p) => {
            return (clipEdgeP2.x - clipEdgeP1.x) * (p.y - clipEdgeP1.y) - (clipEdgeP2.y - clipEdgeP1.y) * (p.x - clipEdgeP1.x) >= -1e-6;
        };
        const intersection = (p1, p2) => {
            const A1 = p2.y - p1.y;
            const B1 = p1.x - p2.x;
            const C1 = A1 * p1.x + B1 * p1.y;
            const A2 = clipEdgeP2.y - clipEdgeP1.y;
            const B2 = clipEdgeP1.x - clipEdgeP2.x;
            const C2 = A2 * clipEdgeP1.x + B2 * clipEdgeP1.y;
            const det = A1 * B2 - A2 * B1;
            if (Math.abs(det) < 1e-9) return p1;
            return {
                x: (B2 * C1 - B1 * C2) / det,
                y: (A1 * C2 - A2 * C1) / det
            };
        };

        if (subjectPoly.length === 0) return [];
        let s = subjectPoly[subjectPoly.length - 1];
        for (const p of subjectPoly) {
            if (isInside(p)) {
                if (!isInside(s)) outputList.push(intersection(s, p));
                outputList.push(p);
            } else if (isInside(s)) {
                outputList.push(intersection(s, p));
            }
            s = p;
        }
        return outputList;
    }

    static tinhDienTichDaGiac2D(poly) {
        if (!poly || poly.length < 3) return 0;
        let area = 0;
        for (let i = 0; i < poly.length; i++) {
            const j = (i + 1) % poly.length;
            area += poly[i].x * poly[j].y;
            area -= poly[j].x * poly[i].y;
        }
        return Math.abs(area) / 2;
    }

    static tinhDienTichGiaoNhau2D(cornersA, cornersB) {
        let clipped = cornersA;
        for (let i = 0; i < cornersB.length; i++) {
            const next = (i + 1) % cornersB.length;
            clipped = this.clipPolygon2D(clipped, cornersB[i], cornersB[next]);
            if (clipped.length === 0) break;
        }
        return this.tinhDienTichDaGiac2D(clipped);
    }

    // =========================================================================
    // BỘ LỌC NGỮ CẢNH RỘNG, CHỐNG BÁM TƯỜNG & CHỌN ỨNG VIÊN THEO HÀNG XÓM (TH1-TH4)
    // =========================================================================

    static get cauHinhChongTuongVaLanXe() {
        return {
            bat: true,
            banKinhRongX: 20.0,
            banKinhRongY: 4.5,
            matNaTuongBand: 0.14,
            nguongCarScoreTuong: 0.35,
            nguongCarScoreXe: 0.52,
            oLuoiCum: 0.20,
            nguongMoHoMargin: 0.08
        };
    }

    static _noisuyShapeChoFrame(track, fn) {
        if (!track || !Array.isArray(track.shapes) || track.shapes.length === 0) return null;
        const shapes = track.shapes;
        let exact = null;
        let prev = null;
        let next = null;
        for (let i = 0; i < shapes.length; i++) {
            const s = shapes[i];
            if (!s) continue;
            const hasPts = Array.isArray(s.points) && s.points.length >= 9;
            if (!s.outside && !hasPts) continue;
            const sf = Number(s.frame);
            if (!Number.isFinite(sf)) continue;
            if (sf === fn) { exact = s; break; }
            if (sf < fn && (!prev || sf > Number(prev.frame))) prev = s;
            if (sf > fn && (!next || sf < Number(next.frame))) next = s;
        }
        if (exact) return exact.outside ? null : exact.points;
        if (!prev || prev.outside) return null;
        if (!next || (next.outside && (!Array.isArray(next.points) || next.points.length < 9))) return prev.points;
        const f1 = Number(prev.frame), f2 = Number(next.frame);
        if (f2 <= f1) return prev.points;
        const t = (fn - f1) / (f2 - f1);
        const out = new Array(9);
        for (let i = 0; i < 9; i++) {
            const v1 = prev.points[i] || 0;
            const v2 = next.points[i] || 0;
            if (i >= 3 && i <= 5) out[i] = v1 + t * this.wrapToPi(v2 - v1);
            else out[i] = v1 + t * (v2 - v1);
        }
        return out;
    }

    /**
     * Xây từ điển neighbor boxes (Other Objects) theo từng frame từ annotations CVAT.
     * Tự nội suy keyframe, bỏ qua outside, bỏ tự thân và bản sao trùng IoU > 0.70.
     */
    static layNeighborBoxesTuAnnotations(annotations, trackHienTai = null, targetFrames = null, labelsMap = null) {
        const out = new Map();
        if (!annotations) return out;

        const tracks = Array.isArray(annotations.tracks) ? annotations.tracks : [];
        const standaloneShapes = Array.isArray(annotations.shapes) ? annotations.shapes : [];

        let framesList = [];
        if (targetFrames && targetFrames instanceof Set && targetFrames.size > 0) {
            framesList = [...targetFrames];
        } else if (Array.isArray(targetFrames) && targetFrames.length > 0) {
            framesList = [...new Set(targetFrames.map(Number))];
        } else if (trackHienTai && Array.isArray(trackHienTai.shapes)) {
            framesList = [...new Set(trackHienTai.shapes.filter(s => s && !s.outside).map(s => Number(s.frame)))];
        }
        if (framesList.length === 0) return out;

        const selfId = trackHienTai ? trackHienTai.id : undefined;
        const selfNum = trackHienTai ? trackHienTai._trackNumber : undefined;
        const selfClient = trackHienTai ? trackHienTai._clientID : undefined;
        const selfLbl = trackHienTai ? String(this.suyLuanNhanTrack(trackHienTai, labelsMap || {}) || '').toLowerCase() : '';

        const selfFrameCache = new Map();
        if (trackHienTai) {
            for (const fn of framesList) {
                const sp = this._noisuyShapeChoFrame(trackHienTai, fn);
                if (sp && sp.length >= 9) {
                    selfFrameCache.set(fn, {
                        pts: sp,
                        corners: this.layGocHop2D(sp[0], sp[1], sp[5] || 0, sp[6], sp[7])
                    });
                }
            }
        }

        const buildEntry = (id, lblName, pts, isLocked) => {
            const [cx, cy, cz, rx, ry, rz, L, W, H] = pts;
            const corners = this.layGocHop2D(cx, cy, rz || 0, L, W);
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (let k = 0; k < corners.length; k++) {
                const c = corners[k];
                if (c.x < minX) minX = c.x;
                if (c.x > maxX) maxX = c.x;
                if (c.y < minY) minY = c.y;
                if (c.y > maxY) maxY = c.y;
            }
            const lowLbl = String(lblName || '').toLowerCase();
            const isVehicle = (L >= 2.2) || lowLbl.includes('veh') || lowLbl.includes('car') ||
                lowLbl.includes('truck') || lowLbl.includes('bus') || lowLbl.includes('van') || lowLbl.includes('pickup');
            return {
                id,
                label: lowLbl,
                isVehicle,
                cx, cy, cz,
                rz: rz || 0,
                L, W, H,
                corners,
                minX, maxX, minY, maxY,
                tinCay: isLocked ? 1.0 : 0.85
            };
        };

        for (const fn of framesList) {
            const list = [];
            const selfInfo = selfFrameCache.get(fn);

            for (let i = 0; i < tracks.length; i++) {
                const ot = tracks[i];
                if (!ot) continue;
                if ((selfId !== undefined && selfId !== null && ot.id === selfId) ||
                    (selfNum !== undefined && selfNum !== null && ot._trackNumber === selfNum) ||
                    (selfClient !== undefined && selfClient !== null && ot._clientID === selfClient)) {
                    continue;
                }
                const pts = this._noisuyShapeChoFrame(ot, fn);
                if (!pts || pts.length < 9) continue;

                const oLbl = String(this.suyLuanNhanTrack(ot, labelsMap || {}) || '').toLowerCase();
                if (selfInfo && oLbl === selfLbl) {
                    const [ox, oy, , , , orz, oL, oW] = pts;
                    if (Math.abs(ox - selfInfo.pts[0]) < oL + 1.0 && Math.abs(oy - selfInfo.pts[1]) < oW + 1.0) {
                        const oCorners = this.layGocHop2D(ox, oy, orz || 0, oL, oW);
                        const inter = this.tinhDienTichGiaoNhau2D(oCorners, selfInfo.corners);
                        const union = Math.max(1e-6, oL * oW + selfInfo.pts[6] * selfInfo.pts[7] - inter);
                        if (inter / union > 0.70) continue; // Bỏ bản sao trùng chính track đang fit
                    }
                }
                const tid = ot.id ?? ot._trackNumber ?? ot._clientID ?? (i + 1);
                const locked = Boolean(ot.lock || ot.khoa_track || ot.khoa_toan_bo || ot.khoa_chinh_tay);
                list.push(buildEntry(tid, oLbl, pts, locked));
            }

            for (let i = 0; i < standaloneShapes.length; i++) {
                const sh = standaloneShapes[i];
                if (!sh || Number(sh.frame) !== fn || sh.outside || !sh.points || sh.points.length < 9) continue;
                const sLbl = (labelsMap && labelsMap[sh.label_id] && labelsMap[sh.label_id].name)
                    ? labelsMap[sh.label_id].name : this._lopNhan('', sh);
                list.push(buildEntry(sh.id || `sh_${i}`, sLbl, sh.points, Boolean(sh.lock)));
            }
            out.set(fn, list);
        }
        return out;
    }

    static _layNeighborsFrame(neighborBoxesDict, fn) {
        if (!neighborBoxesDict) return null;
        if (neighborBoxesDict instanceof Map) return neighborBoxesDict.get(fn) || neighborBoxesDict.get(String(fn)) || null;
        if (typeof neighborBoxesDict === 'object') return neighborBoxesDict[fn] || neighborBoxesDict[String(fn)] || null;
        return null;
    }

    static _diemTrongHop2D(px, py, cx, cy, rz, halfL, halfW) {
        const dx = px - cx, dy = py - cy;
        const c = Math.cos(-rz), s = Math.sin(-rz);
        const lx = c * dx - s * dy;
        if (Math.abs(lx) > halfL) return false;
        const ly = s * dx + c * dy;
        return Math.abs(ly) <= halfW;
    }

    static _smoothstep(edge0, edge1, x) {
        const t = Math.max(0.0, Math.min(1.0, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
        return t * t * (3.0 - 2.0 * t);
    }

    static _sigmoid(x, mid, scale) {
        const z = Math.max(-30, Math.min(30, (x - mid) * scale));
        return 1.0 / (1.0 + Math.exp(-z));
    }

    /**
     * Bước 1: Trích xuất ngữ cảnh rộng quanh box trong hệ tọa độ local (bỏ mặt đất <= 0.22m).
     */
    static trichXuatNguCanhRong(pts, cx, cy, zBottom, rz, halfX = 20.0, halfY = 4.5) {
        if (!pts || pts.length === 0) return [];
        const maxR2 = halfX * halfX + halfY * halfY;
        const c = Math.cos(-rz), s = Math.sin(-rz);
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const dx = p[0] - cx, dy = p[1] - cy;
            if (dx * dx + dy * dy > maxR2) continue;
            const lx = c * dx - s * dy;
            if (Math.abs(lx) > halfX) continue;
            const ly = s * dx + c * dy;
            if (Math.abs(ly) > halfY) continue;
            const lzAbove = p[2] - zBottom;
            if (lzAbove <= 0.22 || lzAbove >= 3.80) continue;
            out.push([lx, ly, lzAbove, i]);
        }
        return out;
    }

    /**
     * Bước 2: Phát hiện tường/hàng rào dài liên tục trong BEV bằng RANSAC đường thẳng (tối đa 3 dải).
     * Đảm bảo không nhận nhầm xe buýt/xe tải dài bằng kiểm tra độ dày p90Dist & độ dài liên tục.
     */
    static phatHienTuongDai(widePts, L, W, H) {
        if (!widePts || widePts.length < 40) return [];
        const lines = [];
        let rem = widePts;
        const minWallLen = Math.max(L * 1.65, L + 3.5);
        const tallWallH = Math.max(2.35, H + 0.55);

        for (let pass = 0; pass < 3; pass++) {
            if (rem.length < 40) break;
            const stride = Math.max(1, Math.floor(rem.length / 800));
            const smp = [];
            for (let i = 0; i < rem.length; i += stride) smp.push(rem[i]);
            const nS = smp.length;
            if (nS < 15) break;

            let bInl = -1, bA = 0, bB = 1, bC = 0;
            for (let it = 0; it < 80; it++) {
                const p1 = smp[(it * 37) % nS];
                const p2 = smp[(it * 97 + 13) % nS];
                const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
                const len = Math.hypot(dx, dy);
                if (len < 1.2) continue;
                const a = -dy / len, b = dx / len, c = -(a * p1[0] + b * p1[1]);
                let cnt = 0;
                for (let k = 0; k < nS; k++) {
                    if (Math.abs(a * smp[k][0] + b * smp[k][1] + c) <= 0.08) cnt++;
                }
                if (cnt > bInl) { bInl = cnt; bA = a; bB = b; bC = c; }
            }
            if (bInl < Math.max(18, Math.floor(nS * 0.05))) break;

            const inliers = [];
            const nextRem = [];
            for (let i = 0; i < rem.length; i++) {
                const p = rem[i];
                if (Math.abs(bA * p[0] + bB * p[1] + bC) <= 0.10) inliers.push(p);
                else nextRem.push(p);
            }
            if (inliers.length < 30) { rem = nextRem; continue; }

            const ts = inliers.map(p => -bB * p[0] + bA * p[1]).sort((a, b) => a - b);
            let maxRun = 0, runStart = ts[0], prev = ts[0];
            for (let i = 1; i < ts.length; i++) {
                if (ts[i] - prev > 0.65) {
                    const run = prev - runStart;
                    if (run > maxRun) maxRun = run;
                    runStart = ts[i];
                }
                prev = ts[i];
            }
            if (prev - runStart > maxRun) maxRun = prev - runStart;

            let maxZ = 0;
            for (let i = 0; i < inliers.length; i++) {
                if (inliers[i][2] > maxZ) maxZ = inliers[i][2];
            }

            const bandDs = [];
            for (let i = 0; i < widePts.length; i++) {
                const p = widePts[i];
                const d = Math.abs(bA * p[0] + bB * p[1] + bC);
                if (d <= 0.35) bandDs.push(d);
            }
            bandDs.sort((a, b) => a - b);
            const p90Dist = bandDs.length > 10 ? bandDs[Math.floor(bandDs.length * 0.90)] : 0.10;

            const isWall = (maxRun >= minWallLen) || (maxRun >= L + 1.0 && maxZ >= tallWallH && p90Dist <= 0.16);
            if (isWall) {
                lines.push({ a: bA, b: bB, c: bC, maxRun, maxH: maxZ, p90Dist, inl: inliers.length });
            }
            rem = nextRem;
        }
        return lines;
    }

    /**
     * Bước 3: Chấm điểm độ giống xe carScore ∈ [0, 1] cho 1 cụm (xử lý TH3: tường thấp ngắn cỡ xe).
     * Đã kiểm chuẩn thực nghiệm trên Job 1767: tường <= 0.11, xe >= 0.54.
     */
    static chamDiemGiongXe(localPts, zBottom, H, sx, sy) {
        const zHi = zBottom + Math.max(2.4, H + 0.5);
        const body = [];
        for (let i = 0; i < localPts.length; i++) {
            const p = localPts[i];
            if (p[2] > zBottom + 0.22 && p[2] < zHi) body.push(p);
        }
        if (body.length < 40) return { carScore: 0.5, insufficient: true, n: body.length };

        const stride = Math.max(1, Math.floor(body.length / 200));
        const smp = [];
        for (let i = 0; i < body.length; i += stride) smp.push(body[i]);
        let bInl = -1, bA = 0, bB = 1, bC = 0;
        const jStep = Math.max(1, Math.floor(smp.length / 18));
        for (let i = 0; i < smp.length; i++) {
            for (let j = i + 1; j < smp.length; j += jStep) {
                const dx = smp[j][0] - smp[i][0], dy = smp[j][1] - smp[i][1];
                const len = Math.hypot(dx, dy);
                if (len < 0.4) continue;
                const a = -dy / len, b = dx / len, c = -(a * smp[i][0] + b * smp[i][1]);
                let cnt = 0;
                for (let k = 0; k < smp.length; k++) {
                    if (Math.abs(a * smp[k][0] + b * smp[k][1] + c) <= 0.06) cnt++;
                }
                if (cnt > bInl) { bInl = cnt; bA = a; bB = b; bC = c; }
            }
        }
        if (bInl < 0) return { carScore: 0.5, insufficient: true, n: body.length };

        let cxM = 0, cyM = 0;
        for (let i = 0; i < body.length; i++) { cxM += body[i][0]; cyM += body[i][1]; }
        cxM /= body.length; cyM /= body.length;
        if (bA * (sx - cxM) + bB * (sy - cyM) > 0) {
            bA = -bA; bB = -bB; bC = -bC;
        }

        const dAll = new Array(body.length);
        for (let i = 0; i < body.length; i++) dAll[i] = bA * body[i][0] + bB * body[i][1] + bC;
        const dSort = [...dAll].sort((a, b) => a - b);
        const p05 = dSort[Math.floor(dSort.length * 0.05)];
        const p95 = dSort[Math.floor(dSort.length * 0.95)];
        const thickness = p95 - p05;

        let behindCnt = 0;
        const zBins = new Map();
        for (let i = 0; i < body.length; i++) {
            const dRel = dAll[i] - p05;
            const zAbove = body[i][2] - zBottom;
            if (dRel >= 0.22 && dRel <= 1.50 && zAbove >= 0.35 && zAbove <= 1.55) behindCnt++;
            const zb = Math.floor(zAbove / 0.12);
            if (!zBins.has(zb)) zBins.set(zb, []);
            zBins.get(zb).push(dRel);
        }
        const behindRatio = behindCnt / body.length;

        const meds = [];
        for (const arr of zBins.values()) {
            if (arr.length >= 3) {
                arr.sort((a, b) => a - b);
                meds.push(arr[Math.floor(arr.length / 2)]);
            }
        }
        let zStd = 0;
        if (meds.length >= 3) {
            const m = meds.reduce((s, v) => s + v, 0) / meds.length;
            let varSum = 0;
            for (let i = 0; i < meds.length; i++) varSum += (meds[i] - m) * (meds[i] - m);
            zStd = Math.sqrt(varSum / meds.length);
        }

        const inlRatio = bInl / smp.length;
        const carScore =
            0.40 * this._sigmoid(thickness, 0.19, 16.0) +
            0.30 * this._sigmoid(behindRatio, 0.04, 45.0) +
            0.20 * this._sigmoid(zStd, 0.042, 50.0) +
            0.10 * (1.0 - this._sigmoid(inlRatio, 0.78, 12.0));

        return { carScore: parseFloat(carScore.toFixed(3)), thickness, behindRatio, zStd, inlRatio, insufficient: false };
    }

    static _tachCumRoiRacBEV(candPts, L, cellSize = 0.20) {
        const cellMap = new Map();
        for (let i = 0; i < candPts.length; i++) {
            const ix = Math.floor(candPts[i][0] / cellSize);
            const iy = Math.floor(candPts[i][1] / cellSize);
            const k = `${ix},${iy}`;
            if (!cellMap.has(k)) cellMap.set(k, []);
            cellMap.get(k).push(i);
        }
        const visited = new Set();
        const rawClusters = [];
        for (const sk of cellMap.keys()) {
            if (visited.has(sk)) continue;
            const q = [sk];
            visited.add(sk);
            const idxs = [];
            while (q.length > 0) {
                const cur = q.pop();
                const arr = cellMap.get(cur);
                if (arr) for (let m = 0; m < arr.length; m++) idxs.push(arr[m]);
                const parts = cur.split(',');
                const gx = parseInt(parts[0], 10);
                const gy = parseInt(parts[1], 10);
                for (let dx = -1; dx <= 1; dx++) {
                    for (let dy = -1; dy <= 1; dy++) {
                        if (dx === 0 && dy === 0) continue;
                        const nk = `${gx + dx},${gy + dy}`;
                        if (cellMap.has(nk) && !visited.has(nk)) {
                            visited.add(nk);
                            q.push(nk);
                        }
                    }
                }
            }
            if (idxs.length >= 12) rawClusters.push(idxs.map(idx => candPts[idx]));
        }

        // Tách cụm quá dài dọc trục X (> L + 0.90m) tại thung lũng mật độ sâu nhất
        const clusters = [];
        for (let i = 0; i < rawClusters.length; i++) {
            const cl = rawClusters[i];
            let minX = Infinity, maxX = -Infinity;
            for (let k = 0; k < cl.length; k++) {
                if (cl[k][0] < minX) minX = cl[k][0];
                if (cl[k][0] > maxX) maxX = cl[k][0];
            }
            if (maxX - minX > L + 0.90) {
                const step = 0.30;
                const bins = new Map();
                for (let k = 0; k < cl.length; k++) {
                    const b = Math.floor(cl[k][0] / step);
                    bins.set(b, (bins.get(b) || 0) + 1);
                }
                const bStart = Math.floor((minX + L * 0.35) / step);
                const bEnd = Math.floor((maxX - L * 0.35) / step);
                let bestB = null, bestC = Infinity;
                for (let b = bStart; b <= bEnd; b++) {
                    const cVal = bins.get(b) || 0;
                    if (cVal < bestC) { bestC = cVal; bestB = b; }
                }
                if (bestB !== null) {
                    const splitX = (bestB + 0.5) * step;
                    const left = cl.filter(p => p[0] <= splitX);
                    const right = cl.filter(p => p[0] > splitX);
                    if (left.length >= 12) clusters.push(left);
                    if (right.length >= 12) clusters.push(right);
                    continue;
                }
            }
            clusters.push(cl);
        }
        return clusters;
    }

    /**
     * Lọc ngữ cảnh thông minh cho 1 frame trước khi vào phanTichLopThanXeChinh:
     * 1) Quét rộng phát hiện & gỡ mặt nạ tường dài (TH2 + lỗi sát tường).
     * 2) Phình vùng tìm kiếm (min 1.2x), phân cụm BEV, loại cụm tường ngắn carScore <= 0.35 (TH3).
     * 3) Chấm điểm ứng viên theo Prior + carScore + độ phủ - phạt mềm IoA/PointOwnership hàng xóm (TH4).
     * 4) Trả về ptsClean (đã gỡ tường + điểm thuộc hàng xóm xâm lấn), preShift và cờ ambiguous.
     */
    static chonVaLocNguCanhFrame(ptsWorld, cx, cy, cz, rz, L, W, H, neighborsFrame = null, scanScale = 1.0) {
        const cfg = this.cauHinhChongTuongVaLanXe;
        if (!cfg.bat || !ptsWorld || ptsWorld.length < 25) {
            return { ptsClean: ptsWorld, wallLines: [], vachCamY: [], vachCamX: [], preShiftWorld: [0, 0], carScore: 0.5, ambiguous: false, margin: 1.0 };
        }

        const zBottom = cz - H / 2.0;
        const cosR = Math.cos(-rz), sinR = Math.sin(-rz);
        const rotMat = this.eulerXYZToMatrix(0, 0, rz);
        const sx = cosR * (-cx) - sinR * (-cy);
        const sy = sinR * (-cx) + cosR * (-cy);

        // 1. Quét rộng + phát hiện tường dài (RANSAC)
        const widePts = this.trichXuatNguCanhRong(ptsWorld, cx, cy, zBottom, rz, cfg.banKinhRongX, cfg.banKinhRongY);
        const wallLines = this.phatHienTuongDai(widePts, L, W, H);

        // Xác định vách cấm ±0.10m cho phanTichLopThanXeChinh nếu tường chạy gần song song trục X/Y local
        const vachCamY = [];
        const vachCamX = [];
        for (let wi = 0; wi < wallLines.length; wi++) {
            const w = wallLines[wi];
            if (Math.abs(w.a) < 0.25 && Math.abs(w.b) > 0.90) {
                vachCamY.push(-w.c / w.b);
            } else if (Math.abs(w.b) < 0.25 && Math.abs(w.a) > 0.90) {
                vachCamX.push(-w.c / w.a);
            }
        }

        // Lập mặt nạ lọc nhanh các điểm nằm trên tường dài (trong bán kính ~24m quanh xe)
        const isWallLocal = (lx, ly) => {
            for (let wi = 0; wi < wallLines.length; wi++) {
                const w = wallLines[wi];
                if (Math.abs(w.a * lx + w.b * ly + w.c) <= cfg.matNaTuongBand) return true;
            }
            return false;
        };

        // 2. Gom điểm ứng viên trong cửa sổ phồng max(1.2, scanScale) để xét cụm & neighbor
        const expScale = Math.max(1.20, parseFloat(scanScale) || 1.0);
        const searchHalfL = L * expScale * 0.5 + 0.5;
        const searchHalfW = W * expScale * 0.5 + 0.5;
        const maxR2 = searchHalfL * searchHalfL + searchHalfW * searchHalfW;

        const candPts = [];
        const preBoxPts = [];
        for (let i = 0; i < ptsWorld.length; i++) {
            const p = ptsWorld[i];
            const dx = p[0] - cx, dy = p[1] - cy;
            if (dx * dx + dy * dy > maxR2) continue;
            const lx = cosR * dx - sinR * dy;
            if (Math.abs(lx) > searchHalfL) continue;
            const ly = sinR * dx + cosR * dy;
            if (Math.abs(ly) > searchHalfW) continue;
            const lz = p[2] - cz;
            if (lz <= -H / 2.0 + 0.22 || lz >= H / 2.0 + 0.45) continue;
            if (wallLines.length > 0 && isWallLocal(lx, ly)) continue;
            const ptEntry = [lx, ly, lz, p[0], p[1], p[2]];
            candPts.push(ptEntry);
            if (Math.abs(lx) <= L / 2.0 + 0.15 && Math.abs(ly) <= W / 2.0 + 0.15) {
                preBoxPts.push(ptEntry);
            }
        }

        // Lọc hàng xóm gần trong bán kính quan tâm
        const nearNbs = [];
        if (neighborsFrame && neighborsFrame.length > 0) {
            for (let i = 0; i < neighborsFrame.length; i++) {
                const nb = neighborsFrame[i];
                if (Math.abs(nb.cx - cx) <= L + nb.L + 1.0 && Math.abs(nb.cy - cy) <= W + nb.W + 1.0) {
                    nearNbs.push(nb);
                }
            }
        }

        // Đánh giá carScore ngay tại prelabel gốc (để phục vụ Anchor Lock TH3 đa frame)
        const csPre = preBoxPts.length >= 40
            ? this.chamDiemGiongXe(preBoxPts, -H / 2.0, H, sx, sy)
            : { carScore: 0.5, insufficient: true };

        // Nếu không có tường, không có hàng xóm gần, và prelabel không trống -> trả sớm nhanh gọn
        let best = null;
        let ambiguous = false;
        let margin = 1.0;
        const rejectedWallBoxes = [];
        const candidates = [];

        if (candPts.length >= 25 && (wallLines.length > 0 || nearNbs.length > 0 || expScale >= 1.15 || (!csPre.insufficient && csPre.carScore < cfg.nguongCarScoreXe))) {
            const clusters = this._tachCumRoiRacBEV(candPts, L, cfg.oLuoiCum);
            const preCorners = this.layGocHop2D(cx, cy, rz, L, W);
            const areaCand = Math.max(1e-6, L * W);

            for (let ci = 0; ci < clusters.length; ci++) {
                const cl = clusters[ci];
                const csCl = this.chamDiemGiongXe(cl, -H / 2.0, H, sx, sy);

                let cMinX = Infinity, cMaxX = -Infinity, cMinY = Infinity, cMaxY = -Infinity;
                for (let k = 0; k < cl.length; k++) {
                    const pt = cl[k];
                    if (pt[0] < cMinX) cMinX = pt[0]; if (pt[0] > cMaxX) cMaxX = pt[0];
                    if (pt[1] < cMinY) cMinY = pt[1]; if (pt[1] > cMaxY) cMaxY = pt[1];
                }
                const spanX = cMaxX - cMinX, spanY = cMaxY - cMinY;
                if (!csCl.insufficient && csCl.carScore <= cfg.nguongCarScoreTuong) {
                    rejectedWallBoxes.push({ minX: cMinX - 0.12, maxX: cMaxX + 0.12, minY: cMinY - 0.12, maxY: cMaxY + 0.12 });
                    continue;
                }

                const truncMinX = (cMinX <= -searchHalfL + 0.25 && cMaxX < searchHalfL - 0.25);
                const truncMaxX = (cMaxX >= searchHalfL - 0.25 && cMinX > -searchHalfL + 0.25);
                const truncMinY = (cMinY <= -searchHalfW + 0.25 && cMaxY < searchHalfW - 0.25);
                const truncMaxY = (cMaxY >= searchHalfW - 0.25 && cMinY > -searchHalfW + 0.25);
                const hxEdge = truncMinX ? (cMaxX - L / 2.0) : (truncMaxX ? (cMinX + L / 2.0) : ((sx >= 0) ? (cMaxX - L / 2.0) : (cMinX + L / 2.0)));
                const hyEdge = truncMinY ? (cMaxY - W / 2.0) : (truncMaxY ? (cMinY + W / 2.0) : ((sy >= 0) ? (cMaxY - W / 2.0) : (cMinY + W / 2.0)));
                const hx = (!truncMinX && !truncMaxX && spanX >= L * 0.65) ? (cMinX + cMaxX) / 2.0 : hxEdge;
                const hy = (!truncMinY && !truncMaxY && spanY >= W * 0.65) ? (cMinY + cMaxY) / 2.0 : hyEdge;
                const distPre = Math.hypot(hx, hy);
                if (distPre > 2.50) continue;

                const boxPts = candPts.filter(p => Math.abs(p[0] - hx) <= L / 2.0 + 0.12 && Math.abs(p[1] - hy) <= W / 2.0 + 0.12);
                const csBox = boxPts.length >= 40 ? this.chamDiemGiongXe(boxPts, -H / 2.0, H, sx, sy) : csCl;
                if (!csBox.insufficient && csBox.carScore <= cfg.nguongCarScoreTuong) {
                    rejectedWallBoxes.push({ minX: cMinX - 0.12, maxX: cMaxX + 0.12, minY: cMinY - 0.12, maxY: cMaxY + 0.12 });
                    continue;
                }

                const wShift = this.matVecMul(rotMat, [hx, hy, 0.0]);
                const wCx = cx + wShift[0], wCy = cy + wShift[1];
                const candCorners = this.layGocHop2D(wCx, wCy, rz, L, W);

                let maxPenNb = 0.0;
                for (let ni = 0; ni < nearNbs.length; ni++) {
                    const nb = nearNbs[ni];
                    const inter = this.tinhDienTichGiaoNhau2D(candCorners, nb.corners);
                    let inNbCnt = 0;
                    if (inter > 0 || Math.hypot(wCx - nb.cx, wCy - nb.cy) < (L + nb.L) * 0.65) {
                        for (let bi = 0; bi < boxPts.length; bi++) {
                            if (this._diemTrongHop2D(boxPts[bi][3], boxPts[bi][4], nb.cx, nb.cy, nb.rz, nb.L / 2.0 + 0.10, nb.W / 2.0 + 0.10)) {
                                inNbCnt++;
                            }
                        }
                    }
                    const rNb = boxPts.length > 0 ? (inNbCnt / boxPts.length) : 0.0;
                    let pen;
                    if (nb.isVehicle) {
                        const ioa = inter / Math.max(1e-6, Math.min(areaCand, nb.L * nb.W));
                        pen = this._smoothstep(0.15, 0.50, Math.max(ioa, rNb)) * nb.tinCay;
                    } else {
                        // Hàng xóm kích thước nhỏ (xe máy / người): tránh IoA bị thổi phồng khi quẹt nhẹ góc
                        const fracSelf = inter / areaCand;
                        pen = this._smoothstep(0.25, 0.65, Math.max(fracSelf, rNb)) * 0.30 * nb.tinCay;
                    }
                    if (pen > maxPenNb) maxPenNb = pen;
                }

                const interPre = this.tinhDienTichGiaoNhau2D(candCorners, preCorners);
                const iouPre = interPre / Math.max(1e-6, 2.0 * areaCand - interPre);
                const sPrior = 0.60 * Math.exp(-(distPre * distPre) / (2.0 * 1.15 * 1.15)) + 0.40 * iouPre;
                const sCov = Math.min(1.0, (Math.min(spanX, L) / L + Math.min(spanY, W) / W) * 0.5);
                const totalScore = 0.38 * sPrior + 0.30 * csBox.carScore + 0.22 * sCov - 0.85 * maxPenNb;

                candidates.push({ hx, hy, wCx, wCy, wShiftX: wShift[0], wShiftY: wShift[1], distPre, totalScore, maxPenNb, carScore: csBox.carScore, iouPre, candCorners });
            }

            if (candidates.length > 0) {
                candidates.sort((a, b) => b.totalScore - a.totalScore);
                best = candidates[0];
                const diffCand = candidates.find(c => {
                    if (Math.hypot(c.hx - best.hx, c.hy - best.hy) <= 1.2) return false;
                    const inter = this.tinhDienTichGiaoNhau2D(c.candCorners, best.candCorners);
                    const iou = inter / Math.max(1e-6, 2.0 * areaCand - inter);
                    return iou < 0.30; // Chỉ tính là hai xe cạnh tranh nếu IoU < 0.30 (không tính mảnh cùng 1 xe)
                });
                margin = diffCand ? (best.totalScore - diffCand.totalScore) : 1.0;

                // Kiểm tra vùng mơ hồ: khi không có neighbor phân tách và hai cụm cạnh tranh quá sát nhau (< 0.08)
                if (diffCand && margin < cfg.nguongMoHoMargin && best.maxPenNb < 0.25 && diffCand.maxPenNb < 0.25 && best.distPre > 0.60) {
                    ambiguous = true;
                }
            } else if (wallLines.length > 0 && preBoxPts.length === 0) {
                ambiguous = true;
            }
        }

        // 4. Lắp tập điểm sạch ptsClean: loại tường dài, loại cụm tường ngắn, và loại điểm nằm sâu trong neighbor car
        let preShiftWorld = [0.0, 0.0];
        let winCx = cx, winCy = cy;
        if (best && !ambiguous && best.distPre >= 0.35 && (wallLines.length > 0 || nearNbs.length > 0 || expScale >= 1.15)) {
            preShiftWorld = [best.wShiftX, best.wShiftY];
            winCx = best.wCx;
            winCy = best.wCy;
        }

        const winNeighbors = [];
        for (let i = 0; i < nearNbs.length; i++) {
            const nb = nearNbs[i];
            if (nb.isVehicle && nb.tinCay >= 0.80) winNeighbors.push(nb);
        }

        const needMaskPts = (wallLines.length > 0 || rejectedWallBoxes.length > 0 || winNeighbors.length > 0);
        let ptsClean = ptsWorld;
        if (needMaskPts) {
            const wallCheckR2 = 24.0 * 24.0;
            ptsClean = [];
            for (let i = 0; i < ptsWorld.length; i++) {
                const p = ptsWorld[i];
                const dx = p[0] - cx, dy = p[1] - cy;
                const d2 = dx * dx + dy * dy;
                if (d2 <= wallCheckR2 && (wallLines.length > 0 || rejectedWallBoxes.length > 0)) {
                    const lx = cosR * dx - sinR * dy;
                    const ly = sinR * dx + cosR * dy;
                    const lz = p[2] - cz;
                    if (lz > -H / 2.0 + 0.20) {
                        if (wallLines.length > 0 && isWallLocal(lx, ly)) continue;
                        let inRej = false;
                        for (let ri = 0; ri < rejectedWallBoxes.length; ri++) {
                            const rb = rejectedWallBoxes[ri];
                            if (lx >= rb.minX && lx <= rb.maxX && ly >= rb.minY && ly <= rb.maxY) { inRej = true; break; }
                        }
                        if (inRej) continue;
                    }
                }
                if (winNeighbors.length > 0 && d2 <= maxR2 * 1.4) {
                    let inNb = false;
                    for (let ni = 0; ni < winNeighbors.length; ni++) {
                        const nb = winNeighbors[ni];
                        if (this._diemTrongHop2D(p[0], p[1], nb.cx, nb.cy, nb.rz, Math.max(0.4, nb.L / 2.0 - 0.05), Math.max(0.3, nb.W / 2.0 - 0.05))) {
                            const dWin = Math.hypot(p[0] - winCx, p[1] - winCy);
                            const dNb = Math.hypot(p[0] - nb.cx, p[1] - nb.cy);
                            if (dNb < dWin + 0.35) { inNb = true; break; }
                        }
                    }
                    if (inNb) continue;
                }
                ptsClean.push(p);
            }
        }

        const effectiveCarScore = best ? best.carScore : csPre.carScore;
        return {
            ptsClean,
            wallLines,
            vachCamY,
            vachCamX,
            preShiftWorld,
            carScore: effectiveCarScore,
            ambiguous,
            margin: parseFloat(margin.toFixed(3)),
            nNeighbors: nearNbs.length
        };
    }

    /**
     * Tra cứu cấu hình kích thước mặc định cho các phân loại cụ thể
     */
    static layDanhSachHoSoChuanQC() {
        return {
            vehicles: [
                { type: 'car', name: 'car (Xe con)', dongBo: true, L: [3.8, 5.5], W: [1.6, 2.3], H: [1.35, 2.05] },
                { type: 'truck', name: 'truck (Xe tải)', dongBo: true, L: [4.5, 14.0], W: [1.8, 2.7], H: [2.0, 4.2] },
                { type: 'bus', name: 'bus (Xe buýt)', dongBo: true, L: [6.0, 14.0], W: [2.0, 2.7], H: [2.5, 4.1] },
                { type: 'van', name: 'van (Xe bán tải / Van)', dongBo: true, L: [4.2, 7.0], W: [1.6, 2.3], H: [1.75, 2.85] },
                { type: 'pickup', name: 'pickup (Bán tải cabin)', dongBo: true, L: [4.8, 6.0], W: [1.7, 2.2], H: [1.6, 2.1] },
                { type: 'contruction', name: 'contruction (Xe công trình)', dongBo: true, L: [3.0, 14.0], W: [1.5, 3.5], H: [1.8, 4.4] },
                { type: 'Trailer', name: 'Trailer (Rơ-moóc)', dongBo: true, L: [4.0, 16.0], W: [1.8, 2.7], H: [1.5, 4.4] },
                { type: 'Tricycle', name: 'Tricycle (Xe ba gác / 3 bánh)', dongBo: true, L: [1.8, 4.5], W: [0.8, 1.8], H: [1.0, 2.2] },
                { type: 'Stroller', name: 'Stroller (Xe đẩy em bé)', dongBo: true, L: [0.55, 1.3], W: [0.4, 0.9], H: [0.7, 1.3] },
                { type: 'Wheelchair', name: 'Wheelchair (Xe lăn)', dongBo: true, L: [0.75, 1.5], W: [0.55, 1.0], H: [0.85, 1.55] },
                { type: 'other', name: 'other (Khác)', dongBo: true, L: [3.2, 14.0], W: [1.5, 2.8], H: [1.35, 4.2] }
            ],
            'two-wheels': [
                {
                    subGroup: 'motorcycle',
                    name: 'motorcycle (Xe máy)',
                    items: [
                        { ride: 'false', name: 'Không người ngồi (no_riding)', dongBo: true, L: [1.5, 2.4], W: [0.6, 1.1], H: [0.9, 1.4] },
                        { ride: 'true', name: 'Có người ngồi (riding)', dongBo: false, L: [1.5, 2.4], W: [0.6, 1.1], H: [1.3, 1.85] }
                    ]
                },
                {
                    subGroup: 'bicycle',
                    name: 'bicycle (Xe đạp)',
                    items: [
                        { ride: 'false', name: 'Không người ngồi (no_riding)', dongBo: true, L: [1.2, 2.1], W: [0.45, 0.9], H: [0.7, 1.3] },
                        { ride: 'true', name: 'Có người ngồi (riding)', dongBo: false, L: [1.2, 2.1], W: [0.45, 0.9], H: [1.25, 1.8] }
                    ]
                }
            ],
            pedestrian: [
                {
                    age: 'adult',
                    name: 'adult (Người lớn)',
                    items: [
                        { pose: 'standing', name: 'Đứng / Đi lại (standing)', dongBo: false, L: [0.45, 1.0], W: [0.45, 1.0], H: [1.4, 2.05] },
                        { pose: 'sitting', name: 'Ngồi (sitting)', dongBo: false, L: [0.55, 1.2], W: [0.45, 1.0], H: [0.8, 1.5] },
                        { pose: 'bending', name: 'Cúi người (bending)', dongBo: false, L: [0.6, 1.3], W: [0.45, 1.0], H: [0.8, 1.55] }
                    ]
                },
                {
                    age: 'child',
                    name: 'child (Trẻ em)',
                    items: [
                        { pose: 'standing', name: 'Đứng / Đi lại (standing)', dongBo: false, L: [0.4, 0.85], W: [0.4, 0.85], H: [0.75, 1.45] },
                        { pose: 'sitting', name: 'Ngồi (sitting)', dongBo: false, L: [0.45, 0.95], W: [0.4, 0.85], H: [0.5, 1.1] },
                        { pose: 'bending', name: 'Cúi người (bending)', dongBo: false, L: [0.5, 1.05], W: [0.4, 0.85], H: [0.5, 1.15] }
                    ]
                }
            ]
        };
    }

    /**
     * Tự động quét và khám phá Schema Cây Phân Cấp (Tree Hierarchy)
     * TUYỆT ĐỐI KHÔNG TẠO CLASS CHUNG CHUNG (vehicles chung / mặc định)!
     */
    static khamPhaSchemaQCTuDong(annotations, labelsMap = {}) {
        const normLabelsMap = this._normalizeLabelsMap(labelsMap);
        const discoveredClasses = new Set();
        const labelEntries = Object.values(normLabelsMap);
        for (const lbl of labelEntries) {
            if (lbl && lbl.name) discoveredClasses.add(lbl.name);
        }
        if (annotations && Array.isArray(annotations.tracks)) {
            for (const tr of annotations.tracks) {
                if (!tr) continue;
                if (normLabelsMap[tr.label_id] && normLabelsMap[tr.label_id].name) {
                    discoveredClasses.add(normLabelsMap[tr.label_id].name);
                } else if (tr.label_id !== undefined) {
                    discoveredClasses.add(this.suyLuanNhanTrack(tr, normLabelsMap));
                }
            }
        }
        if (discoveredClasses.size === 0) {
            ['vehicles', 'two-wheels', 'pedestrian'].forEach(c => discoveredClasses.add(c));
        }

        const hoSoChuan = this.layDanhSachHoSoChuanQC();
        const tree = [];
        const flatRules = [];
        const classes = Array.from(discoveredClasses).sort();

        for (const c of classes) {
            const cLower = c.toLowerCase();
            if (cLower.includes('vehi') || cLower.includes('car')) {
                const classNode = {
                    className: c,
                    icon: '🚗',
                    hasSubGroups: false,
                    children: []
                };
                for (const x of hoSoChuan.vehicles) {
                    const ruleKey = `${c}__type_${x.type.toLowerCase()}`;
                    const ruleObj = {
                        key: ruleKey,
                        className: c,
                        type: x.type,
                        displayName: x.name,
                        dongBoKichThuoc: x.dongBo,
                        minL: x.L[0], maxL: x.L[1],
                        minW: x.W[0], maxW: x.W[1],
                        minH: x.H[0], maxH: x.H[1]
                    };
                    classNode.children.push(ruleObj);
                    flatRules.push(ruleObj);
                }
                tree.push(classNode);
            } else if (cLower.includes('two-wheel') || cLower.includes('moto') || cLower.includes('bike')) {
                const classNode = {
                    className: c,
                    icon: '🏍️',
                    hasSubGroups: true,
                    subGroups: []
                };
                for (const sg of hoSoChuan['two-wheels']) {
                    const groupNode = {
                        groupKey: sg.subGroup,
                        groupName: sg.name,
                        items: []
                    };
                    for (const item of sg.items) {
                        const ruleKey = `${c}__${sg.subGroup}__ride_${item.ride}`;
                        const ruleObj = {
                            key: ruleKey,
                            className: c,
                            type: sg.subGroup,
                            ride: item.ride,
                            displayName: item.name,
                            dongBoKichThuoc: item.dongBo,
                            minL: item.L[0], maxL: item.L[1],
                            minW: item.W[0], maxW: item.W[1],
                            minH: item.H[0], maxH: item.H[1]
                        };
                        groupNode.items.push(ruleObj);
                        flatRules.push(ruleObj);
                    }
                    classNode.subGroups.push(groupNode);
                }
                tree.push(classNode);
            } else if (cLower.includes('pedes') || cLower.includes('person')) {
                const classNode = {
                    className: c,
                    icon: '🚶',
                    hasSubGroups: true,
                    subGroups: []
                };
                for (const sg of hoSoChuan.pedestrian) {
                    const groupNode = {
                        groupKey: sg.age,
                        groupName: sg.name,
                        items: []
                    };
                    for (const item of sg.items) {
                        const ruleKey = `${c}__${sg.age}__pose_${item.pose}`;
                        const ruleObj = {
                            key: ruleKey,
                            className: c,
                            age: sg.age,
                            pose: item.pose,
                            displayName: item.name,
                            dongBoKichThuoc: item.dongBo,
                            minL: item.L[0], maxL: item.L[1],
                            minW: item.W[0], maxW: item.W[1],
                            minH: item.H[0], maxH: item.H[1]
                        };
                        groupNode.items.push(ruleObj);
                        flatRules.push(ruleObj);
                    }
                    classNode.subGroups.push(groupNode);
                }
                tree.push(classNode);
            } else {
                const classNode = {
                    className: c,
                    icon: '📦',
                    hasSubGroups: false,
                    children: []
                };
                const ruleKey = `${c}__default`;
                const ruleObj = {
                    key: ruleKey,
                    className: c,
                    displayName: `${c} (Đặc tả mặc định)`,
                    dongBoKichThuoc: false,
                    minL: 0.2, maxL: 10.0,
                    minW: 0.2, maxW: 5.0,
                    minH: 0.2, maxH: 5.0
                };
                classNode.children.push(ruleObj);
                flatRules.push(ruleObj);
                tree.push(classNode);
            }
        }

        // 4 Cặp va chạm mặc định chuẩn thực tế
        const vehiCls = classes.find(c => c.toLowerCase().includes('vehi') || c.toLowerCase().includes('car')) || 'vehicles';
        const twoWheCls = classes.find(c => c.toLowerCase().includes('two-wheel') || c.toLowerCase().includes('moto') || c.toLowerCase().includes('bike')) || 'two-wheels';
        const pedesCls = classes.find(c => c.toLowerCase().includes('pedes') || c.toLowerCase().includes('person')) || 'pedestrian';

        const defaultPairs = [
            { label1: vehiCls, label2: vehiCls },
            { label1: twoWheCls, label2: twoWheCls },
            { label1: vehiCls, label2: twoWheCls },
            { label1: vehiCls, label2: pedesCls }
        ];

        return {
            tree,
            rules: flatRules,
            classes,
            collisionPairs: defaultPairs,
            yawThresholdDeg: 150
        };
    }

    /**
     * Khớp Rule chuẩn cho Shape dựa trên nhãn và thuộc tính (Hierarchy Matcher)
     */
    static timRuleChuanChoShape(tr, shape, rulesMap, labelsMap = {}) {
        const normLabelsMap = this._normalizeLabelsMap(labelsMap);
        const labelDef = (tr && tr.label_id !== undefined && normLabelsMap) ? normLabelsMap[tr.label_id] : null;
        let lName = 'vehicles';
        if (labelDef && labelDef.name) {
            lName = labelDef.name;
        } else if (tr && tr.label_id !== undefined) {
            lName = this.suyLuanNhanTrack(tr, normLabelsMap);
        }
        const lLower = String(lName || 'vehicles').toLowerCase();

        // 1. Đọc schema mặc định từ labelDef.attributes & dựng map spec_id -> name
        const attrObj = {};
        const specNameById = new Map();
        const labelAttrDefs = (labelDef && Array.isArray(labelDef.attributes)) ? labelDef.attributes : [];
        for (let i = 0; i < labelAttrDefs.length; i++) {
            const spec = labelAttrDefs[i];
            if (!spec || !spec.name) continue;
            const sName = String(spec.name).trim().toLowerCase();
            if (!sName) continue;
            if (spec.id !== undefined && spec.id !== null) {
                specNameById.set(String(spec.id), sName);
            }
            let defVal = spec.default_value !== undefined ? spec.default_value : spec.defaultValue;
            if ((defVal === undefined || defVal === null || String(defVal).trim() === '') && Array.isArray(spec.values) && spec.values.length === 1) {
                defVal = spec.values[0];
            }
            if (defVal !== undefined && defVal !== null && String(defVal).trim() !== '') {
                attrObj[sName] = String(defVal).trim().toLowerCase();
            }
        }

        // 2. Áp thuộc tính track trước, sau đó shape.attributes ghi đè tr.attributes
        const applyAttrs = (list) => {
            if (!Array.isArray(list)) return;
            for (let i = 0; i < list.length; i++) {
                const a = list[i];
                if (!a || a.value === undefined || a.value === null) continue;
                let aName = a.name ? String(a.name).trim().toLowerCase() : '';
                if (!aName && a.spec_id !== undefined && a.spec_id !== null) {
                    aName = specNameById.get(String(a.spec_id)) || '';
                }
                if (aName) {
                    const valStr = String(a.value).trim().toLowerCase();
                    if (valStr !== '') attrObj[aName] = valStr;
                }
            }
        };
        applyAttrs(tr && tr.attributes);
        applyAttrs(shape && shape.attributes);

        const getRule = (k) => (rulesMap && typeof rulesMap.get === 'function') ? rulesMap.get(k) : undefined;

        if (lLower.includes('vehi') || lLower.includes('car')) {
            const rawType = (attrObj['type'] || 'car').toLowerCase();
            const key = `${lName}__type_${rawType}`;
            const hit = getRule(key) || (rawType === 'construction' ? getRule(`${lName}__type_contruction`) : undefined);
            if (hit) return hit;

            const classFallback = getRule(`${lName}__type_car`) || getRule(`${lName}__default`);
            if (classFallback) return classFallback;

            const hoSoChuan = this.layDanhSachHoSoChuanQC();
            const staticItem = hoSoChuan.vehicles.find(v => v.type.toLowerCase() === rawType) || hoSoChuan.vehicles[0];
            return {
                key,
                className: lName,
                type: staticItem.type,
                displayName: staticItem.name,
                dongBoKichThuoc: staticItem.dongBo,
                minL: staticItem.L[0], maxL: staticItem.L[1],
                minW: staticItem.W[0], maxW: staticItem.W[1],
                minH: staticItem.H[0], maxH: staticItem.H[1]
            };
        } else if (lLower.includes('two-wheel') || lLower.includes('moto') || lLower.includes('bike')) {
            const type = (attrObj['type'] && attrObj['type'].includes('bi')) ? 'bicycle' : 'motorcycle';
            const rawRide = attrObj['ride_state'] !== undefined ? attrObj['ride_state'] : attrObj['ride'];
            let ride = 'true';
            if (rawRide === 'false' || rawRide === '0' || rawRide === 'no' || rawRide === 'no_riding') {
                ride = 'false';
            } else if (rawRide === 'true' || rawRide === '1' || rawRide === 'yes' || rawRide === 'riding') {
                ride = 'true';
            }
            const key = `${lName}__${type}__ride_${ride}`;
            const hit = getRule(key);
            if (hit) return hit;

            const classFallback = getRule(`${lName}__${type}__ride_false`) || getRule(`${lName}__motorcycle__ride_false`) || getRule(`${lName}__default`);
            if (classFallback) return classFallback;

            const hoSoChuan = this.layDanhSachHoSoChuanQC();
            const sg = hoSoChuan['two-wheels'].find(g => g.subGroup === type) || hoSoChuan['two-wheels'][0];
            const staticItem = sg.items.find(it => it.ride === ride) || sg.items[0];
            return {
                key,
                className: lName,
                type,
                ride,
                displayName: staticItem.name,
                dongBoKichThuoc: staticItem.dongBo,
                minL: staticItem.L[0], maxL: staticItem.L[1],
                minW: staticItem.W[0], maxW: staticItem.W[1],
                minH: staticItem.H[0], maxH: staticItem.H[1]
            };
        } else if (lLower.includes('pedes') || lLower.includes('person')) {
            const age = (attrObj['age'] && attrObj['age'].includes('child')) ? 'child' : 'adult';
            let pose = 'standing';
            if (attrObj['pose'] && attrObj['pose'].includes('sit')) pose = 'sitting';
            else if (attrObj['pose'] && attrObj['pose'].includes('bend')) pose = 'bending';
            const key = `${lName}__${age}__pose_${pose}`;
            const hit = getRule(key);
            if (hit) return hit;

            const classFallback = getRule(`${lName}__adult__pose_standing`) || getRule(`${lName}__default`);
            if (classFallback) return classFallback;

            const hoSoChuan = this.layDanhSachHoSoChuanQC();
            const sg = hoSoChuan.pedestrian.find(g => g.age === age) || hoSoChuan.pedestrian[0];
            const staticItem = sg.items.find(it => it.pose === pose) || sg.items[0];
            return {
                key,
                className: lName,
                age,
                pose,
                displayName: staticItem.name,
                dongBoKichThuoc: staticItem.dongBo,
                minL: staticItem.L[0], maxL: staticItem.L[1],
                minW: staticItem.W[0], maxW: staticItem.W[1],
                minH: staticItem.H[0], maxH: staticItem.H[1]
            };
        } else {
            const key = `${lName}__default`;
            return getRule(key) || { key, className: lName, dongBoKichThuoc: false, minL: 0.2, maxL: 10, minW: 0.2, maxW: 5, minH: 0.2, maxH: 5, displayName: lName };
        }
    }

    // =========================================================================
    // PHÁT HIỆN "1 OBJECT NHIỀU ID" (SPLIT-ID DETECTOR) TRONG QC TOOL
    // =========================================================================

    static get CAU_HINH_SPLIT_ID_MAC_DINH() {
        return {
            bat: true,
            K: 3,               // Tối đa số frame hở (gap = B.f0 - A.f1)
            maxOverlap: 2,      // Số frame được phép cùng active ở vùng chuyển giao
            scoreMin: 0.50,     // Ngưỡng điểm ghép cặp tối thiểu
            marginMoHo: 0.12,   // Chênh lệch điểm < 0.12 -> gắn cờ Mơ hồ
            cuaSoVanToc: 5,
            heSoTrackNgan: 1.5, // Nới dung sai khi cả 2 track đều chỉ có 1 frame
            hienDoTinCayThap: false,
            nhom: {
                'vehicles':   { d0: 1.5, kGap: 0.50, iouOk: 0.40, sizeTol: 0.25, yawTolDeg: 35,   dzTol: 0.65, dichChuyenMax: 4.8 },
                'two-wheels': { d0: 1.1, kGap: 0.35, iouOk: 0.30, sizeTol: 0.35, yawTolDeg: 50,   dzTol: 0.55, dichChuyenMax: 2.5 },
                'pedestrian': { d0: 0.95, kGap: 0.30, iouOk: 0.22, sizeTol: 0.40, yawTolDeg: null, dzTol: 0.50, dichChuyenMax: 1.0 }
            },
            trongSo: { geo: 0.55, size: 0.15, yaw: 0.10, z: 0.10, vel: 0.10 }
        };
    }

    static _mergeCauHinhSplitID(rawCfg) {
        const def = this.CAU_HINH_SPLIT_ID_MAC_DINH;
        const src = (rawCfg && typeof rawCfg === 'object') ? rawCfg : {};
        const clampNum = (v, lo, hi, fb) => {
            const n = Number(v);
            return Number.isFinite(n) && n >= lo && n <= hi ? n : fb;
        };
        const out = {
            bat: src.bat !== undefined ? Boolean(src.bat) : def.bat,
            K: Math.round(clampNum(src.K, 1, 10, def.K)),
            maxOverlap: Math.round(clampNum(src.maxOverlap, 0, 5, def.maxOverlap)),
            scoreMin: clampNum(src.scoreMin, 0.30, 0.95, def.scoreMin),
            marginMoHo: clampNum(src.marginMoHo, 0.02, 0.40, def.marginMoHo),
            cuaSoVanToc: Math.round(clampNum(src.cuaSoVanToc, 2, 10, def.cuaSoVanToc)),
            heSoTrackNgan: clampNum(src.heSoTrackNgan, 1.0, 2.5, def.heSoTrackNgan),
            hienDoTinCayThap: src.hienDoTinCayThap !== undefined ? Boolean(src.hienDoTinCayThap) : def.hienDoTinCayThap,
            nhom: {
                'vehicles': { ...def.nhom['vehicles'], ...(src.nhom?.['vehicles'] || {}) },
                'two-wheels': { ...def.nhom['two-wheels'], ...(src.nhom?.['two-wheels'] || {}) },
                'pedestrian': { ...def.nhom['pedestrian'], ...(src.nhom?.['pedestrian'] || {}) }
            },
            trongSo: { ...def.trongSo, ...(src.trongSo || {}) }
        };
        return out;
    }

    static layNhomLopSplitID(labelName, labelsMap = {}, track = null) {
        let lbl = String(labelName || '').toLowerCase();
        if (!lbl && track && labelsMap && labelsMap[track.label_id]?.name) {
            lbl = String(labelsMap[track.label_id].name).toLowerCase();
        }
        if (lbl.includes('pedes') || lbl.includes('person') || lbl === '12872' || lbl === '8661579') {
            return { nhom: 'pedestrian', laNhanLa: false };
        }
        if (lbl.includes('two') || lbl.includes('wheel') || lbl.includes('moto') || lbl.includes('bike') || lbl.includes('cycl') || lbl === '12873' || lbl === '8661580') {
            return { nhom: 'two-wheels', laNhanLa: false };
        }
        if (lbl.includes('veh') || lbl.includes('car') || lbl.includes('truck') || lbl.includes('bus') || lbl.includes('van') || lbl.includes('pickup')) {
            return { nhom: 'vehicles', laNhanLa: false };
        }
        return { nhom: 'vehicles', laNhanLa: Boolean(lbl) };
    }

    static dungSaiKhoangCachSplitID(nhomCfg, dt) {
        return nhomCfg.d0 + nhomCfg.kGap * Math.max(0, Math.abs(dt) - 1);
    }

    /**
     * Step 2: Tách 1 track thành danh sách các đoạn sống [!outside] liên tục [f0, f1]
     */
    static trichDoanSong(track, frameMax, labelsMap = {}, fallbackIdx = 0) {
        if (!track || !Array.isArray(track.shapes) || track.shapes.length === 0) return [];
        // Sort & khử trùng frame (giữ shape sau cùng nếu trùng frame)
        const byFrame = new Map();
        let shapeTrung = 0;
        for (let i = 0; i < track.shapes.length; i++) {
            const s = track.shapes[i];
            if (!s || s.frame === undefined || !Array.isArray(s.points) || s.points.length < 9) continue;
            const fn = Number(s.frame);
            if (byFrame.has(fn)) shapeTrung++;
            byFrame.set(fn, s);
        }
        const sorted = [...byFrame.values()].sort((a, b) => Number(a.frame) - Number(b.frame));
        if (sorted.length === 0) return [];

        const lName = (labelsMap && labelsMap[track.label_id]?.name) ? labelsMap[track.label_id].name : this.suyLuanNhanTrack(track, labelsMap);
        const clsRes = this.layNhomLopSplitID(lName, labelsMap, track);
        const trackId = this.layIdHienThi(track, fallbackIdx);
        const trackKey = track._qcKey || `k${fallbackIdx}`;

        const doans = [];
        let curShapes = [];
        let curStart = null;

        const closeSegment = (endFrame, outsideAfterFrame, isEndOfJob) => {
            if (curShapes.length === 0 || curStart === null || endFrame < curStart) return;
            const segIdx = doans.length;
            doans.push({
                key: `${trackKey}#${segIdx}`,
                trackId,
                trackKey,
                segIdx,
                f0: curStart,
                f1: endFrame,
                outsideAfterFrame,
                keoDenCuoiJob: Boolean(isEndOfJob),
                shapes: curShapes,
                label: lName,
                nhom: clsRes.nhom,
                laNhanLa: clsRes.laNhanLa,
                boDau: [...curShapes[0].points],
                boCuoi: [...curShapes[curShapes.length - 1].points],
                shapeTrung
            });
        };

        for (let i = 0; i < sorted.length; i++) {
            const s = sorted[i];
            const fn = Number(s.frame);
            if (!s.outside) {
                if (curStart === null) curStart = fn;
                curShapes.push(s);
            } else {
                if (curStart !== null) {
                    const lastActiveFn = Number(curShapes[curShapes.length - 1].frame);
                    // Giữ endFrame = max(lastActiveFn, fn - 1) nhưng không vượt quá outside - 1
                    const f1 = Math.max(lastActiveFn, fn - 1);
                    closeSegment(f1, fn, false);
                    curShapes = [];
                    curStart = null;
                }
            }
        }
        if (curStart !== null && curShapes.length > 0) {
            const lastActiveFn = Number(curShapes[curShapes.length - 1].frame);
            const atJobEnd = (typeof frameMax === 'number' && frameMax > 0) ? (lastActiveFn >= frameMax) : false;
            closeSegment(lastActiveFn, null, atJobEnd);
        }
        return doans;
    }

    /**
     * Step 3: Nội suy box trong đoạn sống tại frame f ∈ [f0, f1] + quy chiếu ego
     */
    static layBoTaiFrame(doan, f) {
        if (!doan || f < doan.f0 || f > doan.f1) return null;
        const shapes = doan.shapes;
        if (!shapes || shapes.length === 0) return null;
        let prev = null, next = null;
        for (let i = 0; i < shapes.length; i++) {
            const sf = Number(shapes[i].frame);
            if (sf === f) return [...shapes[i].points];
            if (sf < f) prev = shapes[i];
            else if (!next) next = shapes[i];
        }
        if (!prev) return [...shapes[0].points];
        if (!next) return [...prev.points];
        const f1 = Number(prev.frame), f2 = Number(next.frame);
        const t = (f - f1) / Math.max(1, f2 - f1);
        const out = new Array(9);
        for (let i = 0; i < 9; i++) {
            const v1 = prev.points[i] || 0, v2 = next.points[i] || 0;
            if (i >= 3 && i <= 5) out[i] = this.wrapToPi(v1 + t * this.wrapToPi(v2 - v1));
            else out[i] = v1 + t * (v2 - v1);
        }
        return out;
    }

    static _quyVeFrame(box, fFrom, fTo, egoCache) {
        if (!box || fFrom === fTo || !egoCache) return [...box];
        const ego = egoCache.layEgo(fFrom, fTo);
        if (!ego || !ego.ok) return [...box];
        const c = Math.cos(ego.th), s = Math.sin(ego.th);
        const out = [...box];
        out[0] = c * box[0] - s * box[1] + ego.tx;
        out[1] = s * box[0] + c * box[1] + ego.ty;
        out[5] = this.wrapToPi((box[5] || 0) + ego.th);
        return out;
    }

    static _iouBEV(boA, boB) {
        const areaA = Math.max(1e-6, boA[6] * boA[7]);
        const areaB = Math.max(1e-6, boB[6] * boB[7]);
        const cA = this.layGocHop2D(boA[0], boA[1], boA[5] || 0, boA[6], boA[7]);
        const cB = this.layGocHop2D(boB[0], boB[1], boB[5] || 0, boB[6], boB[7]);
        if (!this.satOverlap2D(cA, cB)) return 0.0;
        const inter = this.tinhDienTichGiaoNhau2D(cA, cB);
        return inter / Math.max(1e-6, areaA + areaB - inter);
    }

    /**
     * Step 4: Ước lượng vận tốc sau bù ego & Dự đoán box tiến/lùi cho đoạn sống
     */
    static uocLuongVanTocDoan(doan, huong /* 'cuoi' | 'dau' */, cuaSo, egoCache, origTrack = null) {
        let shapes = doan.shapes;
        // Nếu đoạn cuối/đầu bị cắt ngắn (< 3 frame) do track chớp outside giữa chừng -> mượn thêm frame active lân cận trong cùng track
        if ((!shapes || shapes.length < 3) && origTrack && Array.isArray(origTrack.shapes)) {
            const anchorF = (huong === 'cuoi') ? doan.f1 : doan.f0;
            const nearActive = origTrack.shapes
                .filter(s => s && !s.outside && s.points && s.points.length >= 9 &&
                    ((huong === 'cuoi' && s.frame <= doan.f1 && s.frame >= doan.f1 - 8) ||
                     (huong === 'dau' && s.frame >= doan.f0 && s.frame <= doan.f0 + 8)))
                .sort((a, b) => Number(a.frame) - Number(b.frame));
            if (nearActive.length > (shapes ? shapes.length : 0)) shapes = nearActive;
        }
        if (!shapes || shapes.length < 2) return { vx: 0, vy: 0, n: shapes ? shapes.length : 0, tinCay: 0 };
        const sub = (huong === 'cuoi') ? shapes.slice(-cuaSo) : shapes.slice(0, cuaSo);
        const fRef = (huong === 'cuoi') ? Number(sub[sub.length - 1].frame) : Number(sub[0].frame);

        const ts = [], xs = [], ys = [];
        for (let i = 0; i < sub.length; i++) {
            const f = Number(sub[i].frame);
            const mapped = this._quyVeFrame(sub[i].points, f, fRef, egoCache);
            ts.push(f - fRef);
            xs.push(mapped[0]);
            ys.push(mapped[1]);
        }
        let mt = 0, mx = 0, my = 0;
        for (let i = 0; i < ts.length; i++) { mt += ts[i]; mx += xs[i]; my += ys[i]; }
        mt /= ts.length; mx /= ts.length; my /= ts.length;
        let den = 0, nx = 0, ny = 0;
        for (let i = 0; i < ts.length; i++) {
            const d = ts[i] - mt;
            den += d * d;
            nx += d * (xs[i] - mx);
            ny += d * (ys[i] - my);
        }
        const vx = den > 1e-6 ? nx / den : 0;
        const vy = den > 1e-6 ? ny / den : 0;
        const tinCay = sub.length >= 3 ? 2 : 1;
        return { vx, vy, fRef, n: sub.length, tinCay };
    }

    static duDoanBoTaiFrame(doan, targetFrame, huong /* 'cuoi' | 'dau' */, cfgNhom, egoCache, allTracks, origTrack) {
        const cuaSo = 5;
        const vel = this.uocLuongVanTocDoan(doan, huong, cuaSo, egoCache, origTrack);
        const anchorFrame = (huong === 'cuoi') ? doan.f1 : doan.f0;
        const baseBox = (huong === 'cuoi') ? doan.boCuoi : doan.boDau;
        const dt = targetFrame - anchorFrame;

        // Track 1 frame (tinCay = 0) hoặc track chỉ có đúng 2 frame nhưng phải ngoại suy xa |dt| >= 3 (nhiễu dốc 2 điểm thổi gấp 3 lần): quy chiếu ego tĩnh
        if (vel.tinCay === 0 || (vel.tinCay === 1 && Math.abs(dt) >= 3)) {
            const p = this._quyVeFrame(baseBox, anchorFrame, targetFrame, egoCache);
            return { box: p, tinCay: 0, vx: 0, vy: 0, nguon: 'tinh' };
        }

        // Dự đoán tiến: thử V2 (bỏ shape outside cuối để tương đương "tạm bật active check chồng lấn")
        const NS = (typeof window !== 'undefined' && window.thuatToanNgoaiSuy)
            ? window.thuatToanNgoaiSuy
            : (typeof ThuatToanNgoaiSuy !== 'undefined' ? ThuatToanNgoaiSuy : null);

        if (huong === 'cuoi' && NS && typeof NS.tinhToanNoiSuyBoxV2 === 'function' && doan.shapes.length >= 2) {
            try {
                const refData = {};
                const sub = doan.shapes.slice(-6);
                for (let i = 0; i < sub.length; i++) refData[Number(sub[i].frame)] = [...sub[i].points];
                const shallowTrack = { ...(origTrack || {}), id: doan.trackKey, _qcKey: doan.trackKey, shapes: sub };
                const res = NS.tinhToanNoiSuyBoxV2(shallowTrack, targetFrame, refData, null, {
                    allTracks, egoCache, tatLidarEgo: true, tatLidar: true, tatZ: true, thuatToanCanChinh: this
                });
                if (res && res.length >= 9 && res.every(Number.isFinite)) {
                    const fDiff = Math.max(1, Math.abs(targetFrame - anchorFrame));
                    const dispCheck = this._quyVeFrame(baseBox, anchorFrame, targetFrame, egoCache);
                    const stepDist = Math.hypot(res[0] - dispCheck[0], res[1] - dispCheck[1]);
                    if (stepDist <= cfgNhom.dichChuyenMax * fDiff * 1.25 + 0.5) {
                        return { box: res, tinCay: vel.tinCay, vx: vel.vx, vy: vel.vy, nguon: 'v2' };
                    }
                }
            } catch (e) {}
        }

        // Fallback tuyến tính trong hệ tọa độ đã bù ego (dùng cho cả dự đoán lùi 'dau')
        const cap = cfgNhom.dichChuyenMax * Math.max(1, Math.abs(dt));
        let dx = vel.vx * dt, dy = vel.vy * dt;
        const mag = Math.hypot(dx, dy);
        if (mag > cap && mag > 1e-6) {
            dx *= (cap / mag);
            dy *= (cap / mag);
        }
        const shiftedInRef = [...baseBox];
        shiftedInRef[0] += dx;
        shiftedInRef[1] += dy;
        const predTarget = this._quyVeFrame(shiftedInRef, anchorFrame, targetFrame, egoCache);
        return { box: predTarget, tinCay: vel.tinCay, vx: vel.vx, vy: vel.vy, nguon: 'tuyenTinh' };
    }

    /**
     * Step 5: Chấm bằng chứng 2 chiều cho cặp đoạn (A -> B)
     */
    static tinhBangChungCapSplitID(dA, dB, cfg, egoCache, allTracks, trackMap, thongKe) {
        const loaiBo = (lyDo) => {
            thongKe.loaiBo[lyDo] = (thongKe.loaiBo[lyDo] || 0) + 1;
            return null;
        };

        if (dA.nhom !== dB.nhom) return loaiBo('khacNhom');
        const nhomCfg = cfg.nhom[dA.nhom] || cfg.nhom['vehicles'];

        const overlapFrames = Math.max(0, dA.f1 - dB.f0 + 1);
        if (overlapFrames > cfg.maxOverlap) return loaiBo('songSongQuaDai');
        if (dB.f0 <= dA.f0 || dB.f1 <= dA.f1) return loaiBo('thuTuKhongHopLe');

        const dt = dB.f0 - dA.f1; // có thể âm khi chồng 1..2 frame, hoặc 1..K khi hở
        if (dt < (1 - cfg.maxOverlap) || dt > cfg.K) return loaiBo('ngoaiKhoangGap');

        // Nếu có chồng 1..maxOverlap frame -> bắt buộc phải trùng nhau trên frame chồng
        if (overlapFrames > 0) {
            let sumIouOv = 0, cntOv = 0;
            for (let f = dB.f0; f <= dA.f1; f++) {
                const b1 = this.layBoTaiFrame(dA, f);
                const b2 = this.layBoTaiFrame(dB, f);
                if (b1 && b2) {
                    sumIouOv += this._iouBEV(b1, b2);
                    cntOv++;
                }
            }
            if (cntOv > 0 && (sumIouOv / cntOv) < 0.30) return loaiBo('songSongKhacVitri');
        }

        // Lọc thô trước khi gọi ngoại suy
        const bA_in_B = this._quyVeFrame(dA.boCuoi, dA.f1, dB.f0, egoCache);
        const tolDt = this.dungSaiKhoangCachSplitID(nhomCfg, Math.max(1, Math.abs(dt)));
        const rawDist = Math.hypot(bA_in_B[0] - dB.boDau[0], bA_in_B[1] - dB.boDau[1]);
        const maxCoarse = 3.0 * tolDt + nhomCfg.dichChuyenMax * Math.max(1, Math.abs(dt));
        if (rawDist > maxCoarse) return loaiBo('quaXaTho');

        const trA = trackMap.get(dA.trackKey) || null;
        const trB = trackMap.get(dB.trackKey) || null;

        // Dự đoán 2 chiều: Fwd (A -> B.f0) và Bwd (B -> A.f1)
        const predFwd = this.duDoanBoTaiFrame(dA, dB.f0, 'cuoi', nhomCfg, egoCache, allTracks, trA);
        const predBwd = this.duDoanBoTaiFrame(dB, dA.f1, 'dau', nhomCfg, egoCache, allTracks, trB);

        const dFwd = Math.hypot(predFwd.box[0] - dB.boDau[0], predFwd.box[1] - dB.boDau[1]);
        const iouFwd = this._iouBEV(predFwd.box, dB.boDau);
        const dBwd = Math.hypot(predBwd.box[0] - dA.boCuoi[0], predBwd.box[1] - dA.boCuoi[1]);
        const iouBwd = this._iouBEV(predBwd.box, dA.boCuoi);

        const flags = [];
        let okFwd = (dFwd <= tolDt) || (iouFwd >= nhomCfg.iouOk);
        let okBwd = (dBwd <= tolDt) || (iouBwd >= nhomCfg.iouOk);
        let tinCayCap = 'binhthuong';

        const hasF = predFwd.tinCay >= 1;
        const hasB = predBwd.tinCay >= 1;
        let sGeo = 0;

        const dirScore = (d, iou, tol) => Math.max(Math.max(0, 1.0 - d / Math.max(0.1, tol)), Math.min(1.0, iou / 0.50));

        if (hasF && hasB) {
            if (!okFwd || !okBwd) return loaiBo('khongNhatQuan');
            sGeo = Math.min(dirScore(dFwd, iouFwd, tolDt), dirScore(dBwd, iouBwd, tolDt));
        } else if (hasF || hasB) {
            flags.push('motChieu');
            if (hasF) {
                if (!okFwd) return loaiBo('khongKhopFwd');
                sGeo = dirScore(dFwd, iouFwd, tolDt);
            } else {
                if (!okBwd) return loaiBo('khongKhopBwd');
                sGeo = dirScore(dBwd, iouBwd, tolDt);
            }
            if (dA.shapes.length === 1 || dB.shapes.length === 1) tinCayCap = 'tb_ngan';
        } else {
            // Cả 2 đều 1 frame: kiểm tra tĩnh với hệ số nới heSoTrackNgan
            const tolShort = tolDt * cfg.heSoTrackNgan;
            const iouStatic = this._iouBEV(bA_in_B, dB.boDau);
            if (rawDist > tolShort && iouStatic < nhomCfg.iouOk) return loaiBo('trackNganKhongKhop');
            flags.push('trackNgan');
            tinCayCap = 'thap';
            sGeo = dirScore(rawDist, iouStatic, tolShort);
        }

        // Tương đồng kích thước L, W, H
        const bA = dA.boCuoi, bB = dB.boDau;
        const relL = Math.abs(bA[6] - bB[6]) / Math.max(0.2, Math.max(bA[6], bB[6]));
        const relW = Math.abs(bA[7] - bB[7]) / Math.max(0.2, Math.max(bA[7], bB[7]));
        const relH = Math.abs(bA[8] - bB[8]) / Math.max(0.2, Math.max(bA[8], bB[8]));
        const dSize = (relL + relW + relH) / 3.0;
        const sSize = dSize > nhomCfg.sizeTol ? 0.0 : (1.0 - dSize / nhomCfg.sizeTol);

        // Tương đồng cao độ đáy Z (z - H/2) — nới theo khoảng cách do độ nghiêng pitch Ego tại 60-115m làm lệch Z thô
        const zbA = bA[2] - bA[8] * 0.5;
        const zbB = bB[2] - bB[8] * 0.5;
        const dZ = Math.abs(zbA - zbB);
        const distEgo = Math.hypot(bB[0], bB[1]);
        const effDzTol = nhomCfg.dzTol + 0.018 * Math.max(0, distEgo - 20.0);
        if (dZ > effDzTol * 1.5) return loaiBo('lechCaoDoZ');
        const sZ = dZ > effDzTol ? 0.0 : (1.0 - dZ / effDzTol);

        // Tương đồng Yaw (miễn cho pedestrian)
        let dYawDeg = 0;
        let sYaw = 1.0;
        let wGeo = cfg.trongSo.geo;
        let wYaw = cfg.trongSo.yaw;
        if (nhomCfg.yawTolDeg === null) {
            wGeo += wYaw;
            wYaw = 0;
        } else {
            const rawDiff = Math.abs(this.wrapToPi(bA_in_B[5] - bB[5]));
            const flipDiff = Math.abs(this.wrapToPi(bA_in_B[5] + Math.PI - bB[5]));
            if (flipDiff < 0.45 && rawDiff > 2.2) flags.push('lat180');
            dYawDeg = Math.min(rawDiff, flipDiff) * 180.0 / Math.PI;
            if (dYawDeg > nhomCfg.yawTolDeg * 1.4 && !flags.includes('lat180')) return loaiBo('lechYaw');
            sYaw = (dYawDeg > nhomCfg.yawTolDeg) ? 0.0 : (1.0 - dYawDeg / nhomCfg.yawTolDeg);
            if (flags.includes('lat180')) sYaw *= 0.6;
        }

        // Tương đồng vận tốc (quy về frame dB.f0)
        let sVel = 0.5;
        let dV = null;
        if (hasF && hasB) {
            const egoAB = egoCache ? egoCache.layEgo(dA.f1, dB.f0) : { th: 0, ok: true };
            const thAB = (egoAB && egoAB.ok) ? egoAB.th : 0;
            const c = Math.cos(thAB), s = Math.sin(thAB);
            const vxA_B = c * predFwd.vx - s * predFwd.vy;
            const vyA_B = s * predFwd.vx + c * predFwd.vy;
            dV = Math.hypot(vxA_B - predBwd.vx, vyA_B - predBwd.vy);
            const vTol = Math.max(0.35, nhomCfg.dichChuyenMax * 0.5);
            sVel = dV > vTol ? 0.0 : (1.0 - dV / vTol);
        }

        const rawScore = wGeo * sGeo + cfg.trongSo.size * sSize + wYaw * sYaw + cfg.trongSo.z * sZ + cfg.trongSo.vel * sVel;
        const score = Math.max(0.0, Math.min(1.0, rawScore));
        if (score < cfg.scoreMin) return loaiBo('diemThap');
        if (dA.label !== dB.label) flags.push('khacNhan');

        return {
            a: dA,
            b: dB,
            dt,
            overlapFrames,
            outsideChuyenGiao: dA.outsideAfterFrame,
            score: Number(score.toFixed(3)),
            fwd: { d: Number(dFwd.toFixed(2)), iou: Number(iouFwd.toFixed(3)) },
            bwd: { d: Number(dBwd.toFixed(2)), iou: Number(iouBwd.toFixed(3)) },
            dSize: Number(dSize.toFixed(3)),
            dYawDeg: Number(dYawDeg.toFixed(1)),
            dZ: Number(dZ.toFixed(2)),
            dV: dV !== null ? Number(dV.toFixed(2)) : null,
            flags,
            tinCayCap,
            moHo: false
        };
    }

    /**
     * Step 6 & 7: Sinh ứng viên, gán 1-1 & gom chuỗi cụm Union-Find
     */
    static ganMotMotVaGomCumSplitID(canhs, doans, cfg, thongKe) {
        if (!canhs || canhs.length === 0) return [];

        // Đánh dấu mơ hồ nếu ứng viên thứ 2 từ cùng A hoặc cùng B bám sát < marginMoHo
        const outGroups = new Map();
        const inGroups = new Map();
        for (let i = 0; i < canhs.length; i++) {
            const c = canhs[i];
            if (!outGroups.has(c.a.key)) outGroups.set(c.a.key, []);
            outGroups.get(c.a.key).push(c);
            if (!inGroups.has(c.b.key)) inGroups.set(c.b.key, []);
            inGroups.get(c.b.key).push(c);
        }
        for (const list of outGroups.values()) {
            if (list.length >= 2) {
                list.sort((x, y) => y.score - x.score);
                if (list[0].score - list[1].score < cfg.marginMoHo) {
                    list[0].moHo = true;
                    list[1].moHo = true;
                }
            }
        }
        for (const list of inGroups.values()) {
            if (list.length >= 2) {
                list.sort((x, y) => y.score - x.score);
                if (list[0].score - list[1].score < cfg.marginMoHo) {
                    list[0].moHo = true;
                    list[1].moHo = true;
                }
            }
        }

        // Greedy gán 1-1 + Union-Find trên trackKey với ràng buộc tổng chồng thời gian
        const sortedCanhs = [...canhs].sort((x, y) => y.score - x.score);
        const outUsed = new Set();
        const inUsed = new Set();
        const acceptedLinks = [];

        const parent = new Map();
        const compSegments = new Map();
        for (let i = 0; i < doans.length; i++) {
            const tkey = doans[i].trackKey || String(doans[i].trackId);
            if (!parent.has(tkey)) {
                parent.set(tkey, tkey);
                compSegments.set(tkey, []);
            }
            compSegments.get(tkey).push(doans[i]);
        }
        const findRoot = (x) => {
            while (parent.get(x) !== x) {
                parent.set(x, parent.get(parent.get(x)));
                x = parent.get(x);
            }
            return x;
        };

        for (let i = 0; i < sortedCanhs.length; i++) {
            const c = sortedCanhs[i];
            if (outUsed.has(c.a.key) || inUsed.has(c.b.key)) continue;
            const kA = c.a.trackKey || String(c.a.trackId);
            const kB = c.b.trackKey || String(c.b.trackId);
            const rA = findRoot(kA);
            const rB = findRoot(kB);
            if (rA === rB) {
                thongKe.canhBiChan++;
                continue;
            }
            // Kiểm tra tổng chồng thời gian giữa mọi đoạn thuộc cụm rA và cụm rB
            const segsA = compSegments.get(rA) || [];
            const segsB = compSegments.get(rB) || [];
            let maxPairOv = 0;
            for (let ia = 0; ia < segsA.length; ia++) {
                for (let ib = 0; ib < segsB.length; ib++) {
                    const ov = Math.max(0, Math.min(segsA[ia].f1, segsB[ib].f1) - Math.max(segsA[ia].f0, segsB[ib].f0) + 1);
                    if (ov > maxPairOv) maxPairOv = ov;
                }
            }
            if (maxPairOv > cfg.maxOverlap) {
                thongKe.canhBiChan++;
                continue;
            }

            // Hợp nhất hợp lệ
            parent.set(rB, rA);
            compSegments.set(rA, [...segsA, ...segsB]);
            outUsed.add(c.a.key);
            inUsed.add(c.b.key);
            acceptedLinks.push(c);
        }

        // Gom các link thành cụm chuỗi có thứ tự thời gian
        const linksByRoot = new Map();
        for (let i = 0; i < acceptedLinks.length; i++) {
            const lk = acceptedLinks[i];
            const kA = lk.a.trackKey || String(lk.a.trackId);
            const r = findRoot(kA);
            if (!linksByRoot.has(r)) linksByRoot.set(r, []);
            linksByRoot.get(r).push(lk);
        }

        const cums = [];
        let clusterSeq = 1;
        for (const [, links] of linksByRoot.entries()) {
            const segMap = new Map();
            const trackKeysSet = new Set();
            for (let i = 0; i < links.length; i++) {
                segMap.set(links[i].a.key, links[i].a);
                segMap.set(links[i].b.key, links[i].b);
                trackKeysSet.add(links[i].a.trackKey || String(links[i].a.trackId));
                trackKeysSet.add(links[i].b.trackKey || String(links[i].b.trackId));
            }
            if (trackKeysSet.size < 2) continue;

            const chainSegs = [...segMap.values()].sort((x, y) => x.f0 - y.f0 || x.f1 - y.f1);
            const sortedLinks = [...links].sort((x, y) => x.a.f1 - y.a.f1);
            let minScore = 1.0;
            let hasMoHo = false;
            let hasNgan = false;
            for (let i = 0; i < sortedLinks.length; i++) {
                if (sortedLinks[i].score < minScore) minScore = sortedLinks[i].score;
                if (sortedLinks[i].moHo) hasMoHo = true;
                if (sortedLinks[i].tinCayCap === 'thap') hasNgan = true;
            }

            let doTinCay = 'trungbinh';
            if (hasNgan) doTinCay = 'thap';
            else if (minScore >= 0.72 && !hasMoHo) doTinCay = 'cao';

            if (doTinCay === 'thap' && !cfg.hienDoTinCayThap) continue;

            const trackIds = [];
            const trackKeys = [];
            const dedupChain = [];
            for (let i = 0; i < chainSegs.length; i++) {
                const seg = chainSegs[i];
                const sKey = seg.trackKey || String(seg.trackId);
                if (!trackKeys.includes(sKey)) {
                    trackKeys.push(sKey);
                    trackIds.push(seg.trackId);
                }
                const prevC = dedupChain.find(x => x.trackKey === sKey);
                if (prevC) {
                    prevC.f0 = Math.min(prevC.f0, seg.f0);
                    prevC.f1 = Math.max(prevC.f1, seg.f1);
                    prevC.outsideAfterFrame = seg.outsideAfterFrame;
                } else {
                    dedupChain.push({
                        trackId: seg.trackId,
                        trackKey: sKey,
                        segIdx: seg.segIdx,
                        f0: seg.f0,
                        f1: seg.f1,
                        outsideAfterFrame: seg.outsideAfterFrame,
                        label: seg.label
                    });
                }
            }

            const firstLink = sortedLinks[0];
            cums.push({
                id: `split_${clusterSeq++}_${trackKeys.join('_')}`,
                nhom: chainSegs[0].nhom,
                trackIds,
                trackKeys,
                soID: trackKeys.length,
                chain: dedupChain,
                links: sortedLinks.map(lk => ({
                    fromTrackId: lk.a.trackId,
                    toTrackId: lk.b.trackId,
                    fromTrackKey: lk.a.trackKey,
                    toTrackKey: lk.b.trackKey,
                    fromF1: lk.a.f1,
                    toF0: lk.b.f0,
                    outsideFrame: lk.outsideChuyenGiao,
                    dt: lk.dt,
                    score: lk.score,
                    fwd: lk.fwd,
                    bwd: lk.bwd,
                    dSize: lk.dSize,
                    dYawDeg: lk.dYawDeg,
                    dZ: lk.dZ,
                    flags: lk.flags,
                    moHo: lk.moHo,
                    tinCayCap: lk.tinCayCap
                })),
                diemThapNhat: Number(minScore.toFixed(3)),
                doTinCay,
                moHo: hasMoHo,
                firstTransitionFrame: firstLink.outsideChuyenGiao || firstLink.b.f0
            });
        }
        return cums;
    }

    /**
     * Step 8: Hàm tổng quét toàn job tìm "1 Object nhiều ID"
     */
    static kiemTraVoID(annotations, splitConfig = {}, labelsMap = {}, egoCache = null) {
        const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        const cfg = this._mergeCauHinhSplitID(splitConfig);
        const thongKe = { loaiBo: {}, canhBiChan: 0, nhanLa: 0, shapeTrung: 0, soCapDanhGia: 0, thoiGianMs: 0 };

        if (!cfg.bat || !annotations || !Array.isArray(annotations.tracks) || annotations.tracks.length < 2) {
            return { cums: [], soDoiTuongVoID: 0, soIDThua: 0, thongKe };
        }

        const normLabelsMap = this._normalizeLabelsMap(labelsMap);
        this.chuanHoaDinhDanhTrack(annotations);
        const tracks = annotations.tracks;
        let frameMax = 0;
        const trackMap = new Map();
        for (let i = 0; i < tracks.length; i++) {
            const tr = tracks[i];
            if (!tr) continue;
            const tkey = tr._qcKey || `k${i}`;
            trackMap.set(tkey, tr);
            const shs = tr.shapes || [];
            for (let k = 0; k < shs.length; k++) {
                if (shs[k] && !shs[k].outside && Number(shs[k].frame) > frameMax) frameMax = Number(shs[k].frame);
            }
        }

        const doans = [];
        for (let i = 0; i < tracks.length; i++) {
            const ds = this.trichDoanSong(tracks[i], frameMax, normLabelsMap, i);
            for (let k = 0; k < ds.length; k++) {
                if (ds[k].laNhanLa) thongKe.nhanLa++;
                thongKe.shapeTrung += ds[k].shapeTrung || 0;
                doans.push(ds[k]);
            }
        }

        // Khởi tạo Ego SE(2) thuần box (0ms PCD) 1 lần cho toàn bộ kiểm định
        let egoFn = egoCache;
        if (!egoFn) {
            const NS = (typeof window !== 'undefined' && window.thuatToanNgoaiSuy)
                ? window.thuatToanNgoaiSuy
                : (typeof ThuatToanNgoaiSuy !== 'undefined' ? ThuatToanNgoaiSuy : null);
            if (NS && typeof NS.taoBoDemEgo === 'function') {
                egoFn = NS.taoBoDemEgo(null, tracks, { tatLidarEgo: true });
            }
        }

        // Index các đoạn theo frame bắt đầu f0
        const byStart = new Map();
        for (let i = 0; i < doans.length; i++) {
            const d = doans[i];
            if (!byStart.has(d.f0)) byStart.set(d.f0, []);
            byStart.get(d.f0).push(d);
        }

        const canhs = [];
        for (let i = 0; i < doans.length; i++) {
            const dA = doans[i];
            if (dA.keoDenCuoiJob) continue;
            for (let dt = 1 - cfg.maxOverlap; dt <= cfg.K; dt++) {
                const targetF0 = dA.f1 + dt;
                const bList = byStart.get(targetF0);
                if (!bList || bList.length === 0) continue;
                for (let j = 0; j < bList.length; j++) {
                    const dB = bList[j];
                    if (dA.trackKey === dB.trackKey) continue;
                    thongKe.soCapDanhGia++;
                    const ev = this.tinhBangChungCapSplitID(dA, dB, cfg, egoFn, tracks, trackMap, thongKe);
                    if (ev) canhs.push(ev);
                }
            }
        }

        const cums = this.ganMotMotVaGomCumSplitID(canhs, doans, cfg, thongKe);
        let soIDThua = 0;
        for (let i = 0; i < cums.length; i++) soIDThua += Math.max(0, cums[i].soID - 1);

        const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        thongKe.thoiGianMs = Number((t1 - t0).toFixed(2));
        return { cums, soDoiTuongVoID: cums.length, soIDThua, thongKe };
    }

    /**
     * CHẠY TOÀN BỘ BỘ QUY TẮC KIỂM ĐỊNH QC (RUN QC VERIFICATION PIPELINE)
     */
    static chayKiemDinhQC(annotations, config = {}, labelsMap = {}) {
        if (!annotations || !Array.isArray(annotations.tracks)) {
            return {
                tongLoi: 0,
                soLoiDongBo: 0,
                soLoiKhoangKichThuoc: 0,
                soLoiXoayDotNgot: 0,
                soLoiChongLan: 0,
                soLoiVoID: 0,
                soIDThua: 0,
                loiDongBo: [],
                loiKhoangKichThuoc: [],
                loiXoayDotNgot: [],
                loiChongLan: [],
                loiVoID: []
            };
        }

        const normLabelsMap = this._normalizeLabelsMap(labelsMap);
        const rulesMap = new Map();
        (config.rules || []).forEach(r => {
            if (r && r.key) rulesMap.set(r.key, r);
        });

        // Tập các cặp va chạm được theo dõi (format: "cls1___cls2" đã sort)
        const activePairs = new Set();
        const activePairLabels = new Set();
        (config.collisionPairs || []).forEach(p => {
            if (p && p.label1 && p.label2) {
                activePairs.add(p.label1 <= p.label2 ? `${p.label1}___${p.label2}` : `${p.label2}___${p.label1}`);
                activePairLabels.add(p.label1);
                activePairLabels.add(p.label2);
            }
        });

        const yawThresholdDeg = Number(config.yawThresholdDeg) || 150;

        const loiDongBo = [];
        const loiKhoangKichThuoc = [];
        const loiXoayDotNgot = [];
        const loiChongLan = [];

        const getTrackLabel = (tr) => {
            if (normLabelsMap && normLabelsMap[tr.label_id] && normLabelsMap[tr.label_id].name) {
                return normLabelsMap[tr.label_id].name;
            }
            return this.suyLuanNhanTrack(tr, normLabelsMap);
        };

        const idStats = this.chuanHoaDinhDanhTrack(annotations);
        const tracks = annotations.tracks;
        const trackMetas = new Array(tracks.length);

        // 1. Quét Đồng Bộ Size, Khoảng Kích Thước & Góc Xoay Đột Ngột
        for (let idx = 0; idx < tracks.length; idx++) {
            const tr = tracks[idx];
            if (!tr) continue;
            const dispId = this.layIdHienThi(tr, idx);
            const tKey = tr._qcKey || `k${idx}`;
            const lName = getTrackLabel(tr);
            trackMetas[idx] = { tr, dispId, tKey, lName };

            const activeShapes = (tr.shapes || []).filter(s => s && !s.outside && s.points && s.points.length >= 9);
            if (activeShapes.length === 0) continue;

            activeShapes.sort((a, b) => Number(a.frame) - Number(b.frame));
            const shapeRules = activeShapes.map(s => this.timRuleChuanChoShape(tr, s, rulesMap, normLabelsMap));

            // Kiểm tra Đồng Bộ Kích Thước (Size Consistency) trên các shape có dongBoKichThuoc = true
            const dongBoShapes = [];
            let firstDongBoRule = null;
            for (let i = 0; i < activeShapes.length; i++) {
                const s = activeShapes[i];
                const sr = shapeRules[i];
                if (sr && sr.dongBoKichThuoc && Number.isFinite(s.points[6]) && Number.isFinite(s.points[7]) && Number.isFinite(s.points[8])) {
                    dongBoShapes.push(s);
                    if (!firstDongBoRule) firstDongBoRule = sr;
                }
            }

            if (dongBoShapes.length > 1 && firstDongBoRule) {
                const Ls = dongBoShapes.map(s => s.points[6]);
                const Ws = dongBoShapes.map(s => s.points[7]);
                const Hs = dongBoShapes.map(s => s.points[8]);

                const minL = Math.min(...Ls), maxL = Math.max(...Ls);
                const minW = Math.min(...Ws), maxW = Math.max(...Ws);
                const minH = Math.min(...Hs), maxH = Math.max(...Hs);

                const dL = maxL - minL;
                const dW = maxW - minW;
                const dH = maxH - minH;

                if (dL > 0.05 || dW > 0.05 || dH > 0.05) {
                    const sortedLs = [...Ls].sort((a, b) => a - b);
                    const sortedWs = [...Ws].sort((a, b) => a - b);
                    const sortedHs = [...Hs].sort((a, b) => a - b);
                    const medL = sortedLs[Math.floor(sortedLs.length / 2)];
                    const medW = sortedWs[Math.floor(sortedWs.length / 2)];
                    const medH = sortedHs[Math.floor(sortedHs.length / 2)];

                    let deviantFrames = dongBoShapes
                        .filter(s => Math.abs(s.points[6] - medL) > 0.03 || Math.abs(s.points[7] - medW) > 0.03 || Math.abs(s.points[8] - medH) > 0.03)
                        .map(s => s.frame);

                    if (deviantFrames.length === 0) {
                        let maxDev = 0;
                        for (let i = 0; i < dongBoShapes.length; i++) {
                            const dev = Math.max(
                                Math.abs(dongBoShapes[i].points[6] - medL),
                                Math.abs(dongBoShapes[i].points[7] - medW),
                                Math.abs(dongBoShapes[i].points[8] - medH)
                            );
                            if (dev > maxDev) maxDev = dev;
                        }
                        if (maxDev > 0) {
                            deviantFrames = dongBoShapes
                                .filter(s => Math.max(Math.abs(s.points[6] - medL), Math.abs(s.points[7] - medW), Math.abs(s.points[8] - medH)) >= maxDev - 1e-6)
                                .map(s => s.frame);
                        }
                    }

                    loiDongBo.push({
                        id: `size_var_${tKey}`,
                        loai: 'size_variance',
                        trackId: dispId,
                        trackKey: tKey,
                        label: lName,
                        ruleName: firstDongBoRule.displayName,
                        delta: { L: Number(dL.toFixed(2)), W: Number(dW.toFixed(2)), H: Number(dH.toFixed(2)) },
                        median: { L: medL, W: medW, H: medH },
                        range: { L: [minL, maxL], W: [minW, maxW], H: [minH, maxH] },
                        frames: deviantFrames,
                        firstFrame: deviantFrames[0] !== undefined ? deviantFrames[0] : dongBoShapes[0].frame,
                        details: `L: [${minL.toFixed(2)}-${maxL.toFixed(2)}m], W: [${minW.toFixed(2)}-${maxW.toFixed(2)}m], H: [${minH.toFixed(2)}-${maxH.toFixed(2)}m]`
                    });
                }
            }

            // Kiểm tra Kích Thước Lệch Ngưỡng & Xoay Đột Ngột
            for (let i = 0; i < activeShapes.length; i++) {
                const cur = activeShapes[i];
                const shRule = shapeRules[i];
                const [x, y, z, rx, ry, rz, L, W, H] = cur.points;

                const errs = [];
                if (L < shRule.minL - 0.02) errs.push(`L=${L.toFixed(2)}m < min ${shRule.minL}m`);
                if (L > shRule.maxL + 0.02) errs.push(`L=${L.toFixed(2)}m > max ${shRule.maxL}m`);
                if (W < shRule.minW - 0.02) errs.push(`W=${W.toFixed(2)}m < min ${shRule.minW}m`);
                if (W > shRule.maxW + 0.02) errs.push(`W=${W.toFixed(2)}m > max ${shRule.maxW}m`);
                if (H < shRule.minH - 0.02) errs.push(`H=${H.toFixed(2)}m < min ${shRule.minH}m`);
                if (H > shRule.maxH + 0.02) errs.push(`H=${H.toFixed(2)}m > max ${shRule.maxH}m`);

                if (errs.length > 0) {
                    loiKhoangKichThuoc.push({
                        id: `bound_${tKey}_${cur.frame}`,
                        loai: 'dimension_bound',
                        trackId: dispId,
                        trackKey: tKey,
                        frame: cur.frame,
                        label: lName,
                        ruleName: shRule.displayName,
                        actual: { L, W, H },
                        bounds: { minL: shRule.minL, maxL: shRule.maxL, minW: shRule.minW, maxW: shRule.maxW, minH: shRule.minH, maxH: shRule.maxH },
                        details: errs.join(', ')
                    });
                }

                if (i > 0) {
                    const prev = activeShapes[i - 1];
                    const dFrame = Number(cur.frame) - Number(prev.frame);
                    if (dFrame > 0 && dFrame <= 3) {
                        const rzPrev = Number(prev.points[5]);
                        const rzCur = Number(cur.points[5]);
                        if (Number.isFinite(rzPrev) && Number.isFinite(rzCur)) {
                            const diffRad = Math.abs(Math.atan2(Math.sin(rzCur - rzPrev), Math.cos(rzCur - rzPrev)));
                            const diffDeg = diffRad * (180 / Math.PI);
                            if (diffDeg >= yawThresholdDeg) {
                                loiXoayDotNgot.push({
                                    id: `yaw_${tKey}_${cur.frame}`,
                                    loai: 'yaw_jump',
                                    trackId: dispId,
                                    trackKey: tKey,
                                    frame: cur.frame,
                                    prevFrame: prev.frame,
                                    label: lName,
                                    angleJump: Number(diffDeg.toFixed(1)),
                                    details: `Góc xoay giật ${diffDeg.toFixed(1)}° giữa frame ${prev.frame} và ${cur.frame}`
                                });
                            }
                        }
                    }
                }
            }
        }

        // 2. Quét Chồng Lấn Box (Collision / Box Overlap có nội suy giữa các keyframe !outside)
        if (activePairs.size > 0) {
            const seenFrames = new Set();
            let minFn = Infinity, maxFn = -Infinity;
            const pairTracks = [];

            for (let idx = 0; idx < tracks.length; idx++) {
                const tr = tracks[idx];
                if (!tr || !Array.isArray(tr.shapes) || tr.shapes.length === 0) continue;
                let hasActive = false;
                for (let k = 0; k < tr.shapes.length; k++) {
                    const s = tr.shapes[k];
                    if (!s || s.frame === undefined || s.frame === null) continue;
                    const fn = Number(s.frame);
                    if (!Number.isFinite(fn)) continue;
                    seenFrames.add(fn);
                    if (fn < minFn) minFn = fn;
                    if (fn > maxFn) maxFn = fn;
                    if (!s.outside && s.points && s.points.length >= 9) hasActive = true;
                }
                if (hasActive && trackMetas[idx] && activePairLabels.has(trackMetas[idx].lName)) {
                    pairTracks.push(trackMetas[idx]);
                }
            }

            if (pairTracks.length >= 2 && seenFrames.size > 0) {
                let framesToCheck;
                if (Number.isInteger(minFn) && Number.isInteger(maxFn) && (maxFn - minFn) <= 2000) {
                    framesToCheck = [];
                    for (let fn = minFn; fn <= maxFn; fn++) framesToCheck.push(fn);
                } else {
                    framesToCheck = [...seenFrames].sort((a, b) => a - b);
                }

                for (let fIdx = 0; fIdx < framesToCheck.length; fIdx++) {
                    const fn = framesToCheck[fIdx];
                    const boxes = [];
                    for (let tIdx = 0; tIdx < pairTracks.length; tIdx++) {
                        const meta = pairTracks[tIdx];
                        const pts = this._noisuyShapeChoFrame(meta.tr, fn);
                        if (!pts || pts.length < 9) continue;
                        const x = pts[0], y = pts[1], z = pts[2], rz = pts[5] || 0;
                        const L = pts[6], W = pts[7], H = pts[8];
                        if (!(L > 0 && W > 0 && H > 0) || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
                        const cosR = Math.cos(rz), sinR = Math.sin(rz);
                        const extX = 0.5 * (Math.abs(L * cosR) + Math.abs(W * sinR));
                        const extY = 0.5 * (Math.abs(L * sinR) + Math.abs(W * cosR));
                        boxes.push({
                            trackId: meta.dispId,
                            trackKey: meta.tKey,
                            labelName: meta.lName,
                            pts,
                            minX: x - extX, maxX: x + extX,
                            minY: y - extY, maxY: y + extY,
                            minZ: z - H / 2, maxZ: z + H / 2,
                            corners: null
                        });
                    }

                    if (boxes.length < 2) continue;
                    for (let i = 0; i < boxes.length; i++) {
                        const b1 = boxes[i];
                        for (let j = i + 1; j < boxes.length; j++) {
                            const b2 = boxes[j];
                            if (b1.trackKey === b2.trackKey) continue;
                            const pairKey = b1.labelName <= b2.labelName ? `${b1.labelName}___${b2.labelName}` : `${b2.labelName}___${b1.labelName}`;
                            if (!activePairs.has(pairKey)) continue;

                            // Lọc nhanh theo AABB 2D và trục Z trước khi chạy SAT
                            if (b1.maxX < b2.minX || b2.maxX < b1.minX || b1.maxY < b2.minY || b2.maxY < b1.minY) continue;
                            const zOverlap = Math.min(b1.maxZ, b2.maxZ) - Math.max(b1.minZ, b2.minZ);
                            if (zOverlap <= 0.05) continue;

                            if (!b1.corners) b1.corners = this.layGocHop2D(b1.pts[0], b1.pts[1], b1.pts[5], b1.pts[6], b1.pts[7]);
                            if (!b2.corners) b2.corners = this.layGocHop2D(b2.pts[0], b2.pts[1], b2.pts[5], b2.pts[6], b2.pts[7]);

                            if (!this.satOverlap2D(b1.corners, b2.corners)) continue;

                            const areaInt = this.tinhDienTichGiaoNhau2D(b1.corners, b2.corners);
                            const area1 = b1.pts[6] * b1.pts[7];
                            const area2 = b2.pts[6] * b2.pts[7];
                            const denom = area1 + area2 - areaInt;
                            const iou2D = denom > 1e-9 ? (areaInt / denom) : 0;

                            if (iou2D > 0.02 || areaInt > 0.10) {
                                const ovKeys = [b1.trackKey, b2.trackKey].sort();
                                loiChongLan.push({
                                    id: `overlap_${fn}_${ovKeys[0]}_${ovKeys[1]}`,
                                    loai: 'box_overlap',
                                    frame: fn,
                                    trackId: b1.trackId,
                                    trackKey: b1.trackKey,
                                    track1: b1.trackId,
                                    track2: b2.trackId,
                                    track1Key: b1.trackKey,
                                    track2Key: b2.trackKey,
                                    label1: b1.labelName,
                                    label2: b2.labelName,
                                    iou: iou2D,
                                    overlapPct: (iou2D * 100).toFixed(1) + '%',
                                    zOverlap: zOverlap.toFixed(2) + 'm',
                                    details: `Track #${b1.trackId} (${b1.labelName}) và Track #${b2.trackId} (${b2.labelName}) đè nhau (IoU 2D: ${(iou2D * 100).toFixed(1)}%, Z overlap: ${zOverlap.toFixed(2)}m)`
                                });
                            }
                        }
                    }
                }
            }
        }

        // Kiểm tra "1 Object Nhiều ID" (Split-ID Detector)
        const loiVoID = [];
        let soIDThua = 0;
        let splitThongKe = null;
        try {
            const splitRes = this.kiemTraVoID(annotations, config.splitId || {}, normLabelsMap);
            splitThongKe = splitRes.thongKe;
            soIDThua = splitRes.soIDThua || 0;
            for (const cum of (splitRes.cums || [])) {
                const chainText = cum.chain.map(c => `#${c.trackId}(F${c.f0}..${c.f1})`).join(' → ');
                loiVoID.push({
                    id: cum.id,
                    loai: 'split_id',
                    frame: cum.firstTransitionFrame,
                    trackId: cum.trackIds[0],
                    trackKey: (cum.trackKeys && cum.trackKeys[0]) || '',
                    trackIds: cum.trackIds,
                    trackKeys: cum.trackKeys || [],
                    soID: cum.soID,
                    nhom: cum.nhom,
                    doTinCay: cum.doTinCay,
                    diemThapNhat: cum.diemThapNhat,
                    moHo: cum.moHo,
                    chiTiet: cum,
                    details: `1 Object có ${cum.soID} ID: ${chainText}`
                });
            }
        } catch (errSplit) {
            console.warn('[QC] Lỗi kiểm tra Object nhiều ID:', errSplit);
        }

        return {
            tongLoi: loiDongBo.length + loiKhoangKichThuoc.length + loiXoayDotNgot.length + loiChongLan.length + loiVoID.length,
            soLoiDongBo: loiDongBo.length,
            soLoiKhoangKichThuoc: loiKhoangKichThuoc.length,
            soLoiXoayDotNgot: loiXoayDotNgot.length,
            soLoiChongLan: loiChongLan.length,
            soLoiVoID: loiVoID.length,
            soIDThua,
            soFallbackID: idStats.soFallback,
            trungUIID: idStats.trungId,
            splitThongKe,
            loiDongBo,
            loiKhoangKichThuoc,
            loiXoayDotNgot,
            loiChongLan,
            loiVoID
        };
    }

    /**
     * Sửa Nhanh Lỗi Không Đồng Bộ Kích Thước Track (Snap to Median Size)
     */
    static suaNhanhDongBoKichThuocTrack(annotations, trackId, targetSize = null, ref = {}) {
        if (!annotations || !Array.isArray(annotations.tracks)) return false;
        const tr = this.timTrackQC(annotations, { trackKey: ref && ref.trackKey, trackId });
        if (!tr || !tr.shapes) return false;

        const activeShapes = tr.shapes.filter(s =>
            s && !s.outside && s.points && s.points.length >= 9 &&
            Number.isFinite(s.points[2]) && Number.isFinite(s.points[6]) &&
            Number.isFinite(s.points[7]) && Number.isFinite(s.points[8])
        );
        if (activeShapes.length === 0) return false;

        const hasValidTarget = targetSize &&
            Number.isFinite(Number(targetSize.L)) && Number(targetSize.L) > 0 &&
            Number.isFinite(Number(targetSize.W)) && Number(targetSize.W) > 0 &&
            Number.isFinite(Number(targetSize.H)) && Number(targetSize.H) > 0;

        let rawSize = hasValidTarget ? targetSize : null;
        if (!rawSize) {
            const sortedLs = activeShapes.map(s => s.points[6]).sort((a, b) => a - b);
            const sortedWs = activeShapes.map(s => s.points[7]).sort((a, b) => a - b);
            const sortedHs = activeShapes.map(s => s.points[8]).sort((a, b) => a - b);
            rawSize = {
                L: sortedLs[Math.floor(sortedLs.length / 2)],
                W: sortedWs[Math.floor(sortedWs.length / 2)],
                H: sortedHs[Math.floor(sortedHs.length / 2)]
            };
        }

        const finalL = parseFloat(Number(rawSize.L).toFixed(2));
        const finalW = parseFloat(Number(rawSize.W).toFixed(2));
        const finalH = parseFloat(Number(rawSize.H).toFixed(2));
        if (!(finalL > 0 && finalW > 0 && finalH > 0)) return false;

        let count = 0;
        for (const s of activeShapes) {
            const oldH = s.points[8];
            // Bảo toàn mặt đáy tiếp xúc với đúng finalH đã làm tròn: z_bottom = z - oldH/2 => z_new = z_bottom + finalH/2
            s.points[2] = parseFloat((s.points[2] - (oldH - finalH) / 2).toFixed(3));
            s.points[6] = finalL;
            s.points[7] = finalW;
            s.points[8] = finalH;
            count++;
        }

        tr._isDirty = true;
        return { soShapeDaSua: count, newSize: { L: finalL, W: finalW, H: finalH } };
    }
}

// Xuất toàn cục cho Content Script
if (typeof window !== 'undefined') {
    window.thuatToanCanChinh = ThuatToanCanChinh;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThuatToanCanChinh;
}
