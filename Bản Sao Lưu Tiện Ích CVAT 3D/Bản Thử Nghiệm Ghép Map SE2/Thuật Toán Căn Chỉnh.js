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
     * Tính góc bẻ NHỎ NHẤT giữa góc gốc và góc mới theo chu kỳ đối xứng:
     * chuKy = Math.PI   : Trục thân xe 2 chiều (đầu/đuôi)   -> |delta| <= 90°
     * chuKy = Math.PI/2 : L-shape (không phân biệt dài/rộng) -> |delta| <= 45°
     */
    static gocBeNhoNhat(thetaGoc, thetaMoi, chuKy = Math.PI) {
        const d = this.wrapToPi(thetaMoi - thetaGoc);
        return d - chuKy * Math.round(d / chuKy);
    }

    /**
     * Chuẩn hóa góc mới: Chỉ bẻ góc nhỏ quanh góc hiện tại (Kiệt Rule: Bỏ hướng quay 180°, chỉ bẻ góc < 90°).
     * Nếu độ bẻ vượt quá gioiHanGoc (mặc định 28° ~ 45°) -> Phép đo không tin cậy, GIỮ NGUYÊN góc gốc!
     */
    static chuanHoaGocBeNhoNhat(thetaGoc, thetaMoi, gioiHanGoc = Math.PI / 4, chuKy = Math.PI) {
        if (!Number.isFinite(thetaGoc) || !Number.isFinite(thetaMoi)) return thetaGoc;
        const delta = this.gocBeNhoNhat(thetaGoc, thetaMoi, chuKy);
        if (Math.abs(delta) > gioiHanGoc) return thetaGoc;
        return parseFloat(this.wrapToPi(thetaGoc + delta).toFixed(3));
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
    static phanTichLopThanXeChinh(ptsRel, L, W, sx, sy, dSensor, pad = 0.05, isFirstPass = false, scanScale = 1.0) {
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
            if (!allowBin) continue;

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

    static khuLatGocTrack(track) {
        if (!track || !track.shapes) return 0;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return 0;
        const shapes = (track.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
        if (shapes.length < 2) return 0;

        shapes.sort((a, b) => a.frame - b.frame);
        let count = 0;

        // 1. Xác định hướng đại diện (Consensus Ref Yaw) bằng Medoid vòng tròn toàn track (loại bỏ lỗi góc đôi dominantYaw):
        let bestInitialYaw = shapes[0].points[5];
        let minSumDist = Infinity;
        for (let i = 0; i < shapes.length; i++) {
            const yi = shapes[i].points[5];
            let sumDist = 0.0;
            for (let j = 0; j < shapes.length; j++) {
                sumDist += Math.abs(this.wrapToPi(shapes[j].points[5] - yi));
            }
            if (sumDist < minSumDist) {
                minSumDist = sumDist;
                bestInitialYaw = yi;
            }
        }

        // Kiệt Rule: BỎ HƯỚNG QUAY YAW 180°, TUYỆT ĐỐI KHÔNG BẺ 180°!
        // Chỉ căn chỉnh góc nhỏ (< 90°), tôn trọng 100% hướng đầu/đuôi do người gán nhãn / prelabel đã đặt.
        let nghiNgo = 0;
        for (let i = 0; i < shapes.length; i++) {
            const s = shapes[i];
            const y = s.points[5];
            const diff = this.wrapToPi(y - bestInitialYaw);
            if (Math.abs(diff) > Math.PI / 2.0) {
                nghiNgo++;
            }
        }
        if (nghiNgo > 0) {
            console.warn(`[khuLatGocTrack] Có ${nghiNgo} frame lệch > 90° so với Medoid, KHÔNG tự ý lật 180° (Kiệt Rule: Bảo toàn hướng).`);
        }

        // Kiệt rule: Giữ nguyên hướng đại diện prelabel đã gán cho toàn xe (không lật cả track theo motion vector),
        // chỉ khử các frame đơn lẻ bị quay ngược 180° so với số đông còn lại (như ca Frame 32).

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
    static canChinhMatDuongHop(pos, rot, size, allPts, maxTilt = 0.08) {
        const [cx, cy, cz] = pos;
        const [rx, ry, rz] = rot;
        const [L, W, H] = size;

        if (!allPts || allPts.length < 6) {
            return {
                newPos: [...pos],
                newRot: [...rot],
                dz: 0,
                foundPlane: false,
                zRoad: cz - H / 2.0,
                zRoof: cz + H / 2.0,
                hMeas: H,
                wRoad: -H / 2.0,
                wRoof: H / 2.0,
                confidence: 0,
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
        const confidence = kieuMat * matDo * doPhang;

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
    static canChinhMatDuongRiengLe(track, pcdsMap, targetFrames = null) {
        if (!track || !Array.isArray(track.shapes)) return 0;
        if (targetFrames && !(targetFrames instanceof Set)) targetFrames = new Set(targetFrames);

        const activeShapes = track.shapes
            .filter(s => !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));
        if (activeShapes.length === 0) return 0;

        // Đo mặt đường cho toàn bộ activeShapes (để có ngữ cảnh lân cận làm mượt 3-frame), nhưng chỉ ghi vào targetFrames
        const roadResults = new Map();
        for (const s of activeShapes) {
            const fn = Number(s.frame);
            const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
            const [cx, cy, cz, rx, ry, rz, L, W, H] = s.points;
            if (pts && pts.length >= 6) {
                const res = this.canChinhMatDuongHop([cx, cy, cz], [rx || 0, ry || 0, rz || 0], [L, W, H], pts);
                if (res && Array.isArray(res.newPos)) {
                    roadResults.set(fn, {
                        zBottom: res.newPos[2] - H / 2.0,
                        newRx: res.newRot[0],
                        newRy: res.newRot[1],
                        found: Boolean(res.foundPlane && (res.confidence >= 0.35 || res.isDirectPlane)),
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

        // Sao lưu góc Yaw gốc của toàn bộ shapes để bảo toàn các frame ngoài targetFrames
        const origYawMap = new Map();
        for (const s of activeShapes) {
            origYawMap.set(Number(s.frame), s.points[5] || 0);
        }

        // Bước 1: Chạy khử lật 180° & đồng bộ chiều vận tốc trên toàn chuỗi để lấy hướng tiến chuẩn
        if (activeShapes.length >= 2) {
            this.khuLatGocTrack(track);
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
                    // Kiệt Rule: Chỉ bẻ góc nhỏ (< 25° ~ 0.44 rad) theo trục chuyển động (chuKy = Math.PI).
                    // Xe lùi hoặc góc lệch lớn tự động bỏ qua, TUYỆT ĐỐI KHÔNG lật 180° hay bẻ ngang!
                    const curY = activeShapes[i].points[5];
                    const nY = this.chuanHoaGocBeNhoNhat(curY, headingYaw, 0.44, Math.PI);
                    if (nY !== curY) {
                        activeShapes[i].points[5] = nY;
                        if (Array.isArray(activeShapes[i].rotation)) activeShapes[i].rotation[2] = nY;
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
                        // Kiệt Rule: Chỉ bẻ góc nhỏ (< 90°, cụ thể |corr| <= 45°), chu kỳ PI/2
                        // Nếu lệch 15° thì bẻ 15°, nếu L-shape đề xuất 165° thì tự động gập thành -15° (tuyệt đối không bẻ 165° hay 180°)
                        let corr = dYaw;
                        while (corr > Math.PI / 4.0) corr -= Math.PI / 2.0;
                        while (corr < -Math.PI / 4.0) corr += Math.PI / 2.0;

                        const newYaw = parseFloat(this.wrapToPi(s.points[5] + corr).toFixed(3));
                        s.points[5] = newYaw;
                        if (Array.isArray(s.rotation)) s.rotation[2] = newYaw;
                        yawKf.push({ fn, yaw: newYaw });
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
    static omKhitXeRiengLe(track, pcdsMap, labelName = 'vehicles', scanScale = 1.0, targetFrames = null, pad = 0.025) {
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

                const [cx, cy, cz, rx, ry, rz, L_star, W_star, H_star] = s.points;
                const rc = roadCache.get(fn) || { zLevel: cz, rxLevel: rx || 0, ryLevel: ry || 0, refH: H_star };
                const rotMatLevel = this.eulerXYZToMatrix(0, 0, rz || 0);

                const cluster = this.trichXuatDiemThanXeCatLop(
                    pts, cx, cy, rc.zLevel,
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
                    const ana = this.phanTichLopThanXeChinh(ptsRel, L_star, W_star, sx, sy, distS, pad, isFirstPass, scaleVal);
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
                    sx, sy
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
                    const shift = this.tinhDxDyMep(
                        fd.ex0, fd.ex1, fd.ey0, fd.ey1,
                        fd.L_star, fd.W_star, fd.sx, fd.sy,
                        pad, true, maxShift,
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

        // VÒNG LẶP HỘI TỤ TỰ ĐỘNG (Tối đa 4 vòng, thoát sớm khi hội tụ < 3mm)
        const MAX_ITERS = 4;
        const scaleVal = Math.max(1.0, Math.min(2.0, parseFloat(scanScale) || 1.0));
        const scaleFactor = (scaleVal - 1.0) / 1.0; // [0.0, 1.0]
        const baseMarginX = 0.20 + scaleFactor * (1.40 - 0.20);
        const baseMarginY = 0.10 + scaleFactor * (1.40 - 0.10);

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
                const pts = this.layDiemTuPcdsMap(pcdsMap, fn);
                if (!pts || pts.length === 0) continue;

                const pos = [s.points[0], s.points[1], s.points[2]];
                const rot = [s.points[3], s.points[4], s.points[5]];
                const size = [L_star, W_star, H_star];

                // Căn chỉnh mặt đường RANSAC 3D Tự Cân Bằng & Nóc xe
                const resRoad = this.canChinhMatDuongHop(pos, rot, size, pts);
                const pRoad = resRoad.newPos;
                const rRoad = resRoad.newRot;
                let rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);

                // [v3.1] TỐI ƯU GÓC YAW BẰNG HISTOGRAM & TLS TRÊN ĐÁM MÂY ĐIỂM THÂN XE (Đồng bộ cùng Căn Hướng Xe)
                let yawOptimized = false;
                const dSensYaw = Math.hypot(pRoad[0], pRoad[1]);
                if (isVeh && isFirstPass && (dSensYaw <= 32.0 || scaleVal > 1.05)) {
                    const preCluster = this.trichXuatDiemThanXeCatLop(
                        pts, pRoad[0], pRoad[1], pRoad[2],
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
                        let corrYaw = (typeof dYaw === 'number' && !isNaN(dYaw)) ? dYaw : 0;
                        if (corrYaw > Math.PI / 4.0) corrYaw -= Math.PI / 2.0;
                        else if (corrYaw < -Math.PI / 4.0) corrYaw += Math.PI / 2.0;
                        if (Math.abs(corrYaw) >= 0.005 && Math.abs(corrYaw) <= (38.0 * Math.PI / 180.0)) {
                            rRoad[2] = this.wrapToPi(rRoad[2] + corrYaw);
                            s.points[5] = parseFloat(rRoad[2].toFixed(3));
                            if (Array.isArray(s.rotation)) s.rotation[2] = s.points[5];
                            rotMat = this.eulerXYZToMatrix(rRoad[0], rRoad[1], rRoad[2]);
                            yawOptimized = true;
                        } else {
                            yawOptimized = true;
                        }
                    }
                }

                // [v2.6.3] Trích xuất điểm thân xe cắt lớp với cỡ phồng scanScale
                const cluster = this.trichXuatDiemThanXeCatLop(
                    pts, pRoad[0], pRoad[1], pRoad[2],
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
                    const ana = this.phanTichLopThanXeChinh(ptsRel, L_star, W_star, sx, sy, distS, pad, isFirstPass, scaleVal);
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
                const effMaxShift = isReliable ? maxShift : Math.min(maxShift, 0.20);

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
                    if (!keyframesDone[fn]) {
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

            // ĐIỀU KIỆN DỪNG VÒNG LẶP: Hội tụ dưới 3mm (0.003m) thì kết thúc ngay lập tức!
            if (iter > 0 && maxChange < 0.003) {
                break;
            }
        }

        // BƯỚC 5: Làm mượt cực nhẹ rung lắc nhỏ (< 5cm) trong phạm vi targetFrames, không phá khớp LiDAR khi xe tăng/giảm tốc
        this.lamMuotQuyDaoTrack(track, targetFrames, 0.05);

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
     * Suy luận phân loại nhãn thông minh cho Track (Smart Label Resolution):
     * 1. Tra cứu theo ID trong labelMap
     * 2. Tra cứu theo ID dự phòng chuẩn (Job 4637659: 8661578, Job 1523: 12871...)
     * 3. Đọc từ DOM phần tử đang chọn trên CVAT sidebar (nếu có)
     * 4. Suy luận theo kích thước chiều dài hình hộp (L > 2.2m -> vehicles, L > 1.2m -> two-wheels, ...)
     * TUYỆT ĐỐI KHÔNG BAO GIỜ mặc định thành pedestrian!
     */
    static suyLuanNhanTrack(track, labelMap = {}) {
        if (!track) return 'vehicles';
        const lid = track.label_id;
        if (labelMap && labelMap[lid]?.name) {
            return labelMap[lid].name;
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
    static canChinhTrackV2(track, labelName = null, pcdsMap = null, scanScale = 1.0, targetFrames = null) {
        if (!track || !track.shapes) return false;
        if (track.lock || track.khoa_track || track.khoa_toan_bo || track.khoa_chinh_tay) return false;
        let lbl = (labelName || '').toLowerCase();
        if (!lbl || lbl === 'unknown') {
            lbl = this.suyLuanNhanTrack(track, {}).toLowerCase();
        }

        if (lbl.includes('two-wheels') || lbl.includes('moto') || lbl === '12873' || lbl === '8661580') {
            return this.canChinhTrackXeHaiBanh(track, pcdsMap, null, 0.02, targetFrames);
        } else if (lbl.includes('pedestrian') || lbl === '12872' || lbl === '8661579') {
            return this.canChinhTrackNguoiDiBo(track, pcdsMap, null, 0.02, targetFrames);
        } else {
            // Xe ô tô: Áp dụng thuật toán Master theo thứ tự ưu tiên chuẩn Desktop EXE (3 Pass + Khóa mép 2cm + Enclosure Guardrail chống trôi dạt)
            return this.canChinhTrackTheoThuTuUuTien(track, pcdsMap, lbl, null, 0.025, scanScale, targetFrames);
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
            // canChinhTrackV2 tự động điều hướng: ô tô -> Master Pipeline, xe máy -> Prior 1.95m, người đi bộ -> 0.65m
            const ok = this.canChinhTrackV2(tr, lname, pcdsMap);
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
        const discoveredClasses = new Set();
        const labelEntries = Object.values(labelsMap || {});
        for (const lbl of labelEntries) {
            if (lbl && lbl.name) discoveredClasses.add(lbl.name);
        }
        if (annotations && Array.isArray(annotations.tracks)) {
            for (const tr of annotations.tracks) {
                if (labelsMap && labelsMap[tr.label_id] && labelsMap[tr.label_id].name) {
                    discoveredClasses.add(labelsMap[tr.label_id].name);
                } else if (tr.label_id !== undefined) {
                    discoveredClasses.add(this.suyLuanNhanTrack(tr, labelsMap));
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
        const twoWheCls = classes.find(c => c.toLowerCase().includes('two-wheel') || c.toLowerCase().includes('moto')) || 'two-wheels';
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
        let lName = 'vehicles';
        if (labelsMap && labelsMap[tr.label_id] && labelsMap[tr.label_id].name) {
            lName = labelsMap[tr.label_id].name;
        } else if (tr.label_id !== undefined) {
            lName = this.suyLuanNhanTrack(tr, labelsMap);
        }
        const lLower = lName.toLowerCase();

        const attrs = [...(shape && shape.attributes ? shape.attributes : []), ...(tr.attributes || [])];
        const attrObj = {};
        for (const a of attrs) {
            if (a && a.name && a.value !== undefined) {
                attrObj[a.name.toLowerCase()] = String(a.value).toLowerCase();
            }
        }

        if (lLower.includes('vehi') || lLower.includes('car')) {
            const type = attrObj['type'] || 'car';
            const key = `${lName}__type_${type}`;
            if (rulesMap.has(key)) return rulesMap.get(key);
            return rulesMap.get(`${lName}__type_car`) || rulesMap.values().next().value;
        } else if (lLower.includes('two-wheel') || lLower.includes('moto') || lLower.includes('bike')) {
            const type = (attrObj['type'] && attrObj['type'].includes('bi')) ? 'bicycle' : 'motorcycle';
            let ride = 'true';
            if (attrObj['ride'] === 'false' || attrObj['ride'] === '0' || attrObj['ride'] === 'no' || attrObj['ride'] === 'no_riding') {
                ride = 'false';
            }
            const key = `${lName}__${type}__ride_${ride}`;
            if (rulesMap.has(key)) return rulesMap.get(key);
            return rulesMap.get(`${lName}__motorcycle__ride_false`) || rulesMap.values().next().value;
        } else if (lLower.includes('pedes') || lLower.includes('person')) {
            const age = (attrObj['age'] && attrObj['age'].includes('child')) ? 'child' : 'adult';
            let pose = 'standing';
            if (attrObj['pose'] && attrObj['pose'].includes('sit')) pose = 'sitting';
            else if (attrObj['pose'] && attrObj['pose'].includes('bend')) pose = 'bending';
            const key = `${lName}__${age}__pose_${pose}`;
            if (rulesMap.has(key)) return rulesMap.get(key);
            return rulesMap.get(`${lName}__adult__pose_standing`) || rulesMap.values().next().value;
        } else {
            const key = `${lName}__default`;
            return rulesMap.get(key) || { dongBoKichThuoc: false, minL: 0.2, maxL: 10, minW: 0.2, maxW: 5, minH: 0.2, maxH: 5, displayName: lName };
        }
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
                loiDongBo: [],
                loiKhoangKichThuoc: [],
                loiXoayDotNgot: [],
                loiChongLan: []
            };
        }

        const rulesMap = new Map();
        (config.rules || []).forEach(r => rulesMap.set(r.key, r));

        // Tập các cặp va chạm được theo dõi (format: "cls1___cls2" đã sort)
        const activePairs = new Set();
        (config.collisionPairs || []).forEach(p => {
            if (p && p.label1 && p.label2) {
                activePairs.add([p.label1, p.label2].sort().join('___'));
            }
        });

        const yawThresholdDeg = Number(config.yawThresholdDeg) || 150;

        const loiDongBo = [];
        const loiKhoangKichThuoc = [];
        const loiXoayDotNgot = [];
        const loiChongLan = [];

        const getTrackLabel = (tr) => {
            if (labelsMap && labelsMap[tr.label_id] && labelsMap[tr.label_id].name) {
                return labelsMap[tr.label_id].name;
            }
            return this.suyLuanNhanTrack(tr, labelsMap);
        };

        const tracks = annotations.tracks;

        // 1. Quét Đồng Bộ Size, Khoảng Kích Thước & Góc Xoay Đột Ngột
        for (const tr of tracks) {
            const lName = getTrackLabel(tr);
            const activeShapes = (tr.shapes || []).filter(s => !s.outside && s.points && s.points.length >= 9);
            if (activeShapes.length === 0) continue;

            activeShapes.sort((a, b) => a.frame - b.frame);
            const rule = this.timRuleChuanChoShape(tr, activeShapes[0], rulesMap, labelsMap);

            // Kiểm tra Đồng Bộ Kích Thước (Size Consistency)
            if (rule.dongBoKichThuoc && activeShapes.length > 1) {
                const Ls = activeShapes.map(s => s.points[6]);
                const Ws = activeShapes.map(s => s.points[7]);
                const Hs = activeShapes.map(s => s.points[8]);

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

                    const deviantFrames = activeShapes
                        .filter(s => Math.abs(s.points[6] - medL) > 0.03 || Math.abs(s.points[7] - medW) > 0.03 || Math.abs(s.points[8] - medH) > 0.03)
                        .map(s => s.frame);

                    loiDongBo.push({
                        id: `size_var_${tr.id}`,
                        loai: 'size_variance',
                        trackId: tr.id,
                        label: lName,
                        ruleName: rule.displayName,
                        delta: { L: Number(dL.toFixed(2)), W: Number(dW.toFixed(2)), H: Number(dH.toFixed(2)) },
                        median: { L: medL, W: medW, H: medH },
                        range: { L: [minL, maxL], W: [minW, maxW], H: [minH, maxH] },
                        frames: deviantFrames,
                        firstFrame: deviantFrames[0] !== undefined ? deviantFrames[0] : activeShapes[0].frame,
                        details: `L: [${minL.toFixed(2)}-${maxL.toFixed(2)}m], W: [${minW.toFixed(2)}-${maxW.toFixed(2)}m], H: [${minH.toFixed(2)}-${maxH.toFixed(2)}m]`
                    });
                }
            }

            // Kiểm tra Kích Thước Lệch Ngưỡng & Xoay Đột Ngột
            for (let i = 0; i < activeShapes.length; i++) {
                const cur = activeShapes[i];
                const shRule = this.timRuleChuanChoShape(tr, cur, rulesMap, labelsMap);
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
                        id: `bound_${tr.id}_${cur.frame}`,
                        loai: 'dimension_bound',
                        trackId: tr.id,
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
                    const dFrame = cur.frame - prev.frame;
                    if (dFrame <= 3) {
                        const rzPrev = prev.points[5];
                        const rzCur = cur.points[5];
                        const diffRad = Math.abs(((rzCur - rzPrev + Math.PI) % (2 * Math.PI)) - Math.PI);
                        const diffDeg = diffRad * (180 / Math.PI);
                        if (diffDeg >= yawThresholdDeg) {
                            loiXoayDotNgot.push({
                                id: `yaw_${tr.id}_${cur.frame}`,
                                loai: 'yaw_jump',
                                trackId: tr.id,
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

        // 2. Quét Chồng Lấn Box (Collision / Box Overlap without outside)
        const frameBoxes = new Map();
        for (const tr of tracks) {
            const lName = getTrackLabel(tr);
            for (const s of (tr.shapes || [])) {
                if (!s.outside && s.points && s.points.length >= 9) {
                    if (!frameBoxes.has(s.frame)) frameBoxes.set(s.frame, []);
                    frameBoxes.get(s.frame).push({
                        trackId: tr.id,
                        labelName: lName,
                        shape: s
                    });
                }
            }
        }

        for (const [fn, boxes] of frameBoxes.entries()) {
            if (boxes.length < 2) continue;
            for (let i = 0; i < boxes.length; i++) {
                for (let j = i + 1; j < boxes.length; j++) {
                    const b1 = boxes[i];
                    const b2 = boxes[j];
                    if (b1.trackId === b2.trackId) continue;
                    const pairKey = [b1.labelName, b2.labelName].sort().join('___');
                    if (!activePairs.has(pairKey)) continue;

                    // Kiểm tra Z Overlap
                    const z1 = b1.shape.points[2], H1 = b1.shape.points[8];
                    const z2 = b2.shape.points[2], H2 = b2.shape.points[8];
                    const zMin1 = z1 - H1 / 2, zMax1 = z1 + H1 / 2;
                    const zMin2 = z2 - H2 / 2, zMax2 = z2 + H2 / 2;
                    const zOverlap = Math.min(zMax1, zMax2) - Math.max(zMin1, zMin2);

                    if (zOverlap <= 0.05) continue; // Không giao nhau theo trục Z

                    // Kiểm tra 2D BEV SAT
                    const c1 = this.layGocHop2D(b1.shape.points[0], b1.shape.points[1], b1.shape.points[5], b1.shape.points[6], b1.shape.points[7]);
                    const c2 = this.layGocHop2D(b2.shape.points[0], b2.shape.points[1], b2.shape.points[5], b2.shape.points[6], b2.shape.points[7]);

                    if (!this.satOverlap2D(c1, c2)) continue;

                    const areaInt = this.tinhDienTichGiaoNhau2D(c1, c2);
                    const area1 = b1.shape.points[6] * b1.shape.points[7];
                    const area2 = b2.shape.points[6] * b2.shape.points[7];
                    const iou2D = areaInt / (area1 + area2 - areaInt);

                    if (iou2D > 0.02 || areaInt > 0.10) {
                        loiChongLan.push({
                            id: `overlap_${fn}_${b1.trackId}_${b2.trackId}`,
                            loai: 'box_overlap',
                            frame: fn,
                            track1: b1.trackId,
                            track2: b2.trackId,
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

        return {
            tongLoi: loiDongBo.length + loiKhoangKichThuoc.length + loiXoayDotNgot.length + loiChongLan.length,
            soLoiDongBo: loiDongBo.length,
            soLoiKhoangKichThuoc: loiKhoangKichThuoc.length,
            soLoiXoayDotNgot: loiXoayDotNgot.length,
            soLoiChongLan: loiChongLan.length,
            loiDongBo,
            loiKhoangKichThuoc,
            loiXoayDotNgot,
            loiChongLan
        };
    }

    /**
     * Sửa Nhanh Lỗi Không Đồng Bộ Kích Thước Track (Snap to Median Size)
     */
    static suaNhanhDongBoKichThuocTrack(annotations, trackId, targetSize = null) {
        if (!annotations || !Array.isArray(annotations.tracks)) return false;
        const tr = annotations.tracks.find(t => t.id === trackId || t._trackNumber === trackId);
        if (!tr || !tr.shapes) return false;

        const activeShapes = tr.shapes.filter(s => !s.outside && s.points && s.points.length >= 9);
        if (activeShapes.length === 0) return false;

        let finalSize = targetSize;
        if (!finalSize) {
            const sortedLs = activeShapes.map(s => s.points[6]).sort((a, b) => a - b);
            const sortedWs = activeShapes.map(s => s.points[7]).sort((a, b) => a - b);
            const sortedHs = activeShapes.map(s => s.points[8]).sort((a, b) => a - b);
            finalSize = {
                L: sortedLs[Math.floor(sortedLs.length / 2)],
                W: sortedWs[Math.floor(sortedWs.length / 2)],
                H: sortedHs[Math.floor(sortedHs.length / 2)]
            };
        }

        let count = 0;
        for (const s of activeShapes) {
            const oldH = s.points[8];
            const newH = finalSize.H;
            // Bảo toàn mặt đáy tiếp xúc: z_bottom = z - oldH/2 => z_new = z_bottom + newH/2
            s.points[2] = parseFloat((s.points[2] - (oldH - newH) / 2).toFixed(3));
            s.points[6] = parseFloat(Number(finalSize.L).toFixed(2));
            s.points[7] = parseFloat(Number(finalSize.W).toFixed(2));
            s.points[8] = parseFloat(Number(finalSize.H).toFixed(2));
            count++;
        }

        tr._isDirty = true;
        return { soShapeDaSua: count, newSize: finalSize };
    }
}

// Xuất toàn cục cho Content Script
if (typeof window !== 'undefined') {
    window.thuatToanCanChinh = ThuatToanCanChinh;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThuatToanCanChinh;
}
