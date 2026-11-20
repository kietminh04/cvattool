/**
 * Thuật Toán Surface v4.0 (Lưới Thích Ứng Đồng Tâm Đa Cấp 1m → 2m → 4m → 8m + 3D Overlay)
 * - Thuật toán hoàn toàn độc lập, không ảnh hưởng các nút căn chỉnh cũ.
 * - Chia bản đồ theo các vành vuông đồng tâm (chuẩn Chebyshev) theo bảng ZONES:
 *     Cận |x|,|y| < 12m: ô 1m · Trung < 28m: ô 2m · Xa < 48m: ô 4m · Rìa tới biên ext: ô 8m.
 *   Mọi ranh giới vùng là bội của ô to hơn ⇒ cân bằng 2:1 đúng theo xây dựng, id ô ổn định `Z{k}_{ix}_{iy}`.
 * - Kề cận chính xác bằng băm đoạn cạnh đơn vị 1m + băm góc; Dijkstra best-first chuẩn hoá ngưỡng theo khoảng cách tâm d_cc.
 * - Hạt giống: vành 2.5–5m quanh xe khớp mặt phẳng gốc + gán thẳng mặt phẳng gốc cho ô gầm xe [-2.5,2.5]×[-1,1]m.
 * - Khâu kín C0 tổng quát: mọi đỉnh treo trên cạnh ô to (1m|2m, 2m|4m, 4m|8m) bị ràng buộc z = nội suy tuyến tính 2 góc cha.
 * - Tự động gom nhóm các ô liền mạch thành Lớp (Mặt Đường / Vỉa Hè) và phủ trực tiếp màu hồng nhạt lên 3D CVAT.
 */

class ThuatToanSurface {
    // [LƯỚI ĐA CẤP]: Vành vuông đồng tâm theo chuẩn Chebyshev max(|x|,|y|).
    // half: nửa cạnh vùng (m) — phải là bội của s của vùng KẾ TIẾP (12 % 2, 28 % 4, 48 % 8 = 0) để 2:1 đúng theo xây dựng.
    // Vùng cuối (Rìa) luôn trải tới biên ext động (mặc định [-72,72]×[-56,56], nới theo cuboid xa).
    static ZONES = [
        { id: 'near',  half: 12, s: 1, name: 'Cận' },
        { id: 'mid',   half: 28, s: 2, name: 'Trung' },
        { id: 'far',   half: 48, s: 4, name: 'Xa' },
        { id: 'outer', half: 72, s: 8, name: 'Rìa' }
    ];

    // Biên ngoài mặc định của toàn lưới (bội của ô lớn nhất 8m)
    static OUTER_X_MIN = -72;
    static OUTER_X_MAX = 72;
    static OUTER_Y_MIN = -56;
    static OUTER_Y_MAX = 56;
    // Bước làm tròn biên ext = kích thước ô lớn nhất (vùng cuối)
    static OUTER_DX = 8;
    static OUTER_DY = 8;

    // Ngưỡng lan truyền Dijkstra quy đổi ra độ dốc theo khoảng cách tâm d_cc.
    // [CHẶN LEO XE] Siết theo dốc vật lý đường đô thị (≤ 10%): ô 1m chỉ nhận bước ≤ 13cm (v4 cũ: 25cm ⇒ leo dần lên thân xe).
    static DIJ_WIN_SLOPE = 0.12;   // cửa sổ tìm cụm: ±(0.12·d_cc + 0.06)
    static DIJ_WIN_EPS = 0.06;
    static DIJ_ACC_SLOPE = 0.10;   // chấp nhận bước nhảy: stepDelta ≤ 0.10·d_cc + 0.03
    static DIJ_ACC_EPS = 0.03;
    static DOC_MAX = 0.10;         // Clamp độ dốc từng ô (thay ±0.16)
    // Ngoại lệ bó vỉa: bước ≤ 22cm chỉ khi mặt bậc phẳng, song song và KHÔNG có vật đứng phía trên
    static BO_VIA_MAX_STEP = 0.22;
    static BO_VIA_WIN = 0.25;      // cửa sổ tìm cụm tối thiểu để còn bắt được mặt vỉa hè
    // Mask điểm theo cuboid: nới footprint 10cm, giữ điểm thấp hơn đáy hộp > 5cm (mặt đất thật)
    static MASK_XE_LE = 0.10;
    static MASK_XE_DAY = 0.05;
    // Cột vật thể đứng (thân xe/lốp/cột): bin 0.25m có biên độ z ≥ 0.40m
    static COT_BIN = 0.25;
    static COT_CAO = 0.40;

    // Hạt giống quanh xe Ego
    static SEED_RING_MIN = 2.5;
    static SEED_RING_MAX = 5.0;
    static SEED_UNDER_HALF_X = 2.5;
    static SEED_UNDER_HALF_Y = 1.0;

    // Cấu hình hồ sơ cắt & cảnh báo đáy hộp (Ưu tiên 1)
    static HOSO_CAT_CFG = Object.freeze({
        FALLBACK_TOL: 0.15,   // |zHienThiTaiLa - mS.z| tối đa cho phép
        WSOFT_HOLE: 0.50,     // Wsoft tối thiểu khi lấp lỗ không có lá sạch
        SIGMA_SOFT: 0.07,     // xe chưa duyệt σ >= 7cm => nét đứt
        SMOOTH_PASSES: 2,     // số lượt làm mượt [1,2,1]/4 cho nhánh chưa duyệt
        NPTS_CAP: 40,
        BOX_WARN: 0.30,
        BOX_SEVERE: 0.60
    });

    /** Ngưỡng λ_min của phân bố XY theo kích thước ô: giữ nguyên 0.40 @2m, 1.2 @4m của v3, co giãn ∝ s². */
    static minLambdaTheoKichThuoc(s) {
        return s <= 2 ? 0.10 * s * s : 0.075 * s * s;
    }

    /**
     * [TIER A - EGO GROUND PLANE]: Tìm mặt phẳng nền Ego của frame (bán kính R in [4m, 22m]).
     * Khóa chặt độ dốc tham chiếu gx, gy của frame, loại bỏ hoàn toàn hiện tượng bẻ dốc 7° do nhiễu.
     */
    static tinhEgoGroundPlane(rawPts) {
        if (!rawPts || rawPts.length < 50) return { z0: 0.0, gx: 0.0, gy: 0.0, valid: false };
        const ePts = [];
        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const r2 = px * px + py * py;
            if (r2 >= 16.0 && r2 <= 484.0 && pz >= -1.5 && pz <= 1.0) {
                ePts.push(p);
            }
        }
        if (ePts.length < 50) return { z0: 0.0, gx: 0.0, gy: 0.0, valid: false };

        const BIN = 0.05, ZLO = -1.5, NB = 50;
        const hist = new Int32Array(NB);
        for (let i = 0; i < ePts.length; i++) {
            const idx = Math.floor((ePts[i][2] - ZLO) / BIN);
            if (idx >= 0 && idx < NB) hist[idx]++;
        }
        let maxC = 0, pIdx = 0;
        for (let i = 0; i < NB; i++) {
            if (hist[i] > maxC) { maxC = hist[i]; pIdx = i; }
        }
        const zPeak = ZLO + (pIdx + 0.5) * BIN;

        let s1 = 0, sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sZ = 0, sXZ = 0, sYZ = 0;
        for (let i = 0; i < ePts.length; i++) {
            const p = ePts[i];
            if (Math.abs(p[2] - zPeak) <= 0.12) {
                const x = p[0], y = p[1], z = p[2];
                s1 += 1;
                sX += x; sY += y;
                sXX += x * x; sYY += y * y; sXY += x * y;
                sZ += z;
                sXZ += x * z; sYZ += y * z;
            }
        }
        if (s1 < 30) return { z0: zPeak, gx: 0.0, gy: 0.0, valid: true };

        const det = s1 * (sXX * sYY - sXY * sXY) - sX * (sX * sYY - sXY * sY) + sY * (sX * sXY - sXX * sY);
        if (Math.abs(det) < 1e-7) return { z0: zPeak, gx: 0.0, gy: 0.0, valid: true };

        const invDet = 1.0 / det;
        let z0 = invDet * (sZ * (sXX * sYY - sXY * sXY) - sX * (sXZ * sYY - sXY * sYZ) + sY * (sXZ * sXY - sXX * sYZ));
        let gx = invDet * (s1 * (sXZ * sYY - sXY * sYZ) - sZ * (sX * sYY - sXY * sY) + sY * (sX * sYZ - sXZ * sY));
        let gy = invDet * (s1 * (sXX * sYZ - sXY * sXZ) - sX * (sX * sYZ - sXY * sZ) + sZ * (sX * sXZ - sXX * sY));

        gx = Math.max(-0.045, Math.min(0.045, gx));
        gy = Math.max(-0.045, Math.min(0.045, gy));
        return { z0, gx, gy, valid: true };
    }

    /**
     * [TIER B - PER-VEHICLE WHEEL CONTACT PATCH]:
     * Ước lượng mặt phẳng tiếp xúc mặt đường tại 4 bánh xe trong cùng frame.
     * =========================================================================
     * PHASE 1 HYBRID CONFIDENCE-WEIGHTED LOCAL GROUND (Per-Frame, cz-Invariant)
     * Kết hợp 2 nguồn độc lập (mặt đường quanh/dưới gầm + hạ từ nóc xe - H + δ(R))
     * có kiểm tra chéo (Body-Cut Veto) và cô lập điểm của các xe xung quanh.
     * Tuyệt đối KHÔNG đọc cz hay zBottom của cuboid khi ước lượng mặt đường.
     * =========================================================================
     */
    static PHASE1 = {
        delta0: 0.16,              // Hiệu chuẩn bias mép trên tia LiDAR: median(zBot - (zTop - H)) ≈ 15.7cm
        deltaSlopePerM: 0.0005,    // Hiệu chỉnh độ thưa tia theo cự ly R > 60m
        roofMinPts: 25,            // Số điểm tối thiểu trong OBB cho Roof Cue
        roofMinCover: 4,           // Số ô 3x3 tối thiểu có điểm trên nóc (4/9)
        roofClusterGap: 0.25,      // Khoảng hở Z tách cụm nóc trên xuống (m)
        roofHRelMin: 0.70,         // Tỷ lệ zTop - zEgo >= 0.70*H - sigmaEgo
        classMaxH: 2.30,           // Giới hạn chiều cao lớp xe con / SUV
        classMinL: 2.40,
        classMaxL: 6.50,
        classMinW: 1.15,           // Loại xe máy (W < 1.15m), xe tải/bus (L > 6.5m || H > 2.3m)
        patchMinPts: 12,
        patchMinCells: 5,
        patchMinSectors: 3,        // Phủ tối thiểu 3/8 cung góc 45° quanh xe
        patchCellPtsMin: 4,
        patchRidgeLambda: 1.0,     // Ridge nhẹ kéo dốc về Ego (chỉ tác động gx, gy)
        maxSlopeAbs: 0.12,
        maxSlopeDevEgo: 0.06,
        otherBoxPadBase: 0.30,
        otherBoxPadPerM: 0.002,
        otherBoxCullExtra: 3.0,
        fuseMatchBase: 0.12,
        fuseMatchSigmaMul: 2.0,
        egoOutlierBase: 0.80,
        egoOutlierPerM: 0.006,
        vetoBin: 0.10,
        vetoRunMinBins: 3,
        vetoTauBase: 0.12,
        vetoTauPerM: 0.0015,
        vetoZMaxMargin: 0.08,
        vetoZMaxPerM: 0.001
    };

    static PHASE2 = {
        enabled: true,
        // Neo tin cậy
        anchorSigmaMax: 0.08,
        anchorSigmaFloor: 0.04,
        anchorTier: { 'HYBRID': 1.0, 'PATCH': 1.0, 'ROOF-H': 0.6 },
        anchorFlagMul: { OCC: 0.7, CONFLICT_P: 0.7 },
        // Trường dư cục bộ NEAR / FAR
        nearRadius: 8.0,
        nearKernel: 4.0,
        minAnchNear: 2,
        farRadius: 30.0,
        farKernel: 12.0,
        minAnchFar: 3,
        singleAnchorMaxD: 5.0,
        approvedSingleMaxD: 12.0,
        singleSigmaFloor: 0.12,
        ridgeRho: 0.5,
        ridgeRef: 5.0,
        irlsIters: 3,
        tukeyC: 2.5,
        madFloor: 0.05,
        spreadMax: 0.12,
        slopeDevMax: 0.06,
        farMinorStd: 2.0,
        sigmaFloor: 0.05,
        sigmaPerM: 0.006,
        farSigmaFloor: 0.12,
        // Nhất quán & Trọng tài
        consistK: 2.5,
        consistMinAbs: 0.08,
        keepP1Sigma: 0.04,
        // Gate PATCH re-run
        bandK: 2.5,
        bandMin: 0.12,
        bandMax: 0.30,
        maxRerunPerFrame: 14,
        // Veto & Cờ cảnh báo
        vetoCapSigma: 0.15,
        isolatedRadius: 15.0,
        isolatedMinR: 50.0,
        // Track guard (flag-only)
        trackWindow: 5,
        trackThr: 0.10,
        trackReplace: false,
        // Cache & UI interactive
        frameCacheMax: 8,
        settleMs: 150,
        ring2: false
    };

    static CO = {
        sanThanXe: true,       // Đợt 1: Bất biến sàn thân xe (mặt đường không cắt xuyên thân/lốp)
        tamLaiCuaSo: true,     // Đợt 1: Tái định tâm cửa sổ Z của patch khi lệch Ego
        polar: true,           // Đợt 2: Chuyển estimator chính sang Mặt Đường Đồng Tâm
        ngucTrack: true        // Đợt 3: Anchor-to-Fade propagation theo track + Auto-Calibrate Nóc
    };

    static PHASE3 = {
        epsSan: 0.03,
        rSlope: 0.0035,
        kMin: 0.88,
        kMax: 1.01,
        gradeMax: 0.25,
        decayS: 25.0,
        propConfMin: 0.30,
        sanMaxGapBelow: 0.65,
        anchorMaxR: 35.0,
        bottomMissRel: 0.83,
        bottomMissMinR: 30.0
    };

    static CFG_SOFT = {
        enabled: true,
        anchorMaxSigma: 0.08,
        anchorMinPts: 20,
        anchorJumpMax: 0.15,
        maxGapTwoSide: 3,
        maxGapOneSide: 2,
        twoSideSplitMax: 0.25,
        ceilPad: 0.03,
        egoReplaceSigmaMul: 3.0,
        egoReplaceMinDiff: 0.10,
        neighSigBase: 0.03,
        neighSigPerM: 0.008,
        neighSingleMul: 1.5,
        farSigBase: 0.08,
        farSigPerM: 0.01,
        boxJumpThr: 0.40
    };

    /**
     * Tính trần mềm zCeil = zMinBody + pad cho frame thiếu điểm (kể cả 2 <= nPts < 8).
     */
    static tinhTranThanXe(san, pad = null) {
        if (!san) return { valid: false, zCeil: NaN, zMinBody: NaN, nPts: 0 };
        const p = Number.isFinite(pad) ? pad : this.CFG_SOFT.ceilPad;
        if (san.valid && Number.isFinite(san.zLow)) {
            const zRef = Number.isFinite(san.zMinBody) ? Math.min(san.zLow, san.zMinBody) : san.zLow;
            return { valid: true, zCeil: san.zLow + this.PHASE3.epsSan, zMinBody: zRef, nPts: san.nPtsRaw ?? san.nPts ?? 0 };
        }
        if (Number.isFinite(san.zMinBody) && (san.nPtsRaw ?? 0) >= 2) {
            return { valid: true, zCeil: san.zMinBody + p, zMinBody: san.zMinBody, nPts: san.nPtsRaw };
        }
        return { valid: false, zCeil: NaN, zMinBody: NaN, nPts: san.nPtsRaw ?? san.nPts ?? 0 };
    }

    static _getKhoDuyet() {
        if (typeof khoDuyet !== 'undefined') return khoDuyet;
        if (typeof window !== 'undefined' && window.khoDuyet) return window.khoDuyet;
        if (typeof globalThis !== 'undefined' && globalThis.khoDuyet) return globalThis.khoDuyet;
        return null;
    }

    static _getNeoDuyet() {
        if (typeof NeoDuyet !== 'undefined') return NeoDuyet;
        if (typeof window !== 'undefined' && window.NeoDuyet) return window.NeoDuyet;
        if (typeof globalThis !== 'undefined' && globalThis.NeoDuyet) return globalThis.NeoDuyet;
        return null;
    }

    static _phienBanDuyet() {
        const k = this._getKhoDuyet();
        return k ? (k.phienBan || 1) : 1;
    }

    static _taoKetQuaDaDuyet(carBox, egoPlane = null) {
        if (!carBox) return null;
        const Neo = this._getNeoDuyet();
        const canon = this._canonicalizeBox(carBox);
        if (!canon) return null;
        const carBoxTilt = {
            x: canon.cx, y: canon.cy, z: canon.rawCz,
            L: canon.L, W: canon.W, H: canon.H,
            rx: canon.rx || 0, ry: canon.ry || 0, rz: canon.rz || 0,
            shape: canon.shape || carBox.shape || null
        };
        let pl = Neo ? Neo.matPhangDay(canon.shape?.points || carBox.shape?.points || carBoxTilt) : null;
        if (!pl && (carBoxTilt.rx !== 0 || carBoxTilt.ry !== 0)) {
            const cRx = Math.cos(carBoxTilt.rx), sRx = Math.sin(carBoxTilt.rx);
            const cRy = Math.cos(carBoxTilt.ry), sRy = Math.sin(carBoxTilt.ry);
            const c2 = cRx * cRy;
            if (Number.isFinite(c2) && c2 >= 0.7) {
                pl = {
                    zb: canon.rawCz - canon.H / (2.0 * c2),
                    a: -sRy / c2,
                    b: (sRx * cRy) / c2
                };
            }
        }
        const zApp = pl ? pl.zb : (canon.rawCz - canon.H / 2.0);
        const zEgoAtCar = (egoPlane && egoPlane.valid)
            ? (egoPlane.z0 + egoPlane.gx * canon.cx + egoPlane.gy * canon.cy)
            : zApp;
        return {
            zc: zApp,
            zRoad: zApp,
            gx: pl ? pl.a : 0,
            gy: pl ? pl.b : 0,
            sigma: 0.02,
            nhan: 'DA·DUYET',
            nguon: 'DA_DUYET',
            source: 'approved',
            count: 1,
            flags: ['DA_DUYET'],
            vetoed: false,
            locked: true,
            deltaBottom: (canon.rawCz - canon.H / 2.0) - zApp,
            zFarPred: zApp,
            zEgo: zEgoAtCar,
            patchZ: zApp,
            phase: 2
        };
    }

    static _laBoxDaDuyet(box, frame, opts = {}) {
        if (!box) return false;
        const kho = this._getKhoDuyet();
        if (kho && !kho.batNeo && !opts.ignoreBatNeo) return false;
        if (box.approved === true) return true;
        if (!kho || !Number.isFinite(Number(frame))) return false;
        const tr = box.track || box._orig?.track || null;
        const tKey = kho.trackKey(tr) || (box.tid !== undefined ? String(box.tid) : (box.trackId !== undefined ? String(box.trackId) : null));
        if (!tKey) return false;
        if (opts && opts.trackKeysMoKhoa && opts.trackKeysMoKhoa.has(tKey)) {
            return false;
        }
        return kho.laDaDuyet(tKey, Number(frame), tr, { gomTam: opts.gomTam || null });
    }

    static _thuThapNeoTuBoxes(boxes, egoPlane = null, opts = {}) {
        const Neo = this._getNeoDuyet();
        if (!Neo) return [];
        if (Array.isArray(opts.neoDuyet)) return opts.neoDuyet;

        const kho = this._getKhoDuyet();
        if (kho && !kho.batNeo) return [];

        const fn = opts.frame !== undefined ? Number(opts.frame) : NaN;
        const out = [];
        if (egoPlane && Number.isFinite(egoPlane.z0)) {
            out.push({
                kind: 'ego', trackId: '__EGO__', frame: fn,
                cx: 0, cy: 0, rz: 0, L: 0, W: 0, _cosR: 1, _sinR: 0,
                zb: egoPlane.z0, a: Number.isFinite(egoPlane.gx) ? egoPlane.gx : 0, b: Number.isFinite(egoPlane.gy) ? egoPlane.gy : 0,
                zbTam: egoPlane.z0, sigmaZ: Neo.CONFIG.sigmaEgo
            });
        }

        const carNeos = [];
        if (Array.isArray(boxes)) {
            for (let i = 0; i < boxes.length; i++) {
                const b = boxes[i];
                if (!b) continue;
                const isExplicit = b.approved === true;
                const tr = b.track || b._orig?.track || null;
                const tKey = kho ? (kho.trackKey(tr) || (b.tid !== undefined ? String(b.tid) : (b.trackId !== undefined ? String(b.trackId) : null))) : null;
                const isPerm = Boolean(kho && tKey && Number.isFinite(fn) && kho.laDaDuyet(tKey, fn, tr, null));
                const isTemp = Boolean(!isPerm && opts.gomTam && kho && tKey && Number.isFinite(fn) && kho.laDaDuyet(tKey, fn, tr, { gomTam: opts.gomTam }));
                if (!isExplicit && !isPerm && !isTemp) continue;

                // CHỈ đọc cz/shape sau khi đã xác nhận hộp này được duyệt
                const ptsSrc = b.shape?.points || b.points || b._orig?.shape?.points || {
                    cx: b.cx ?? b.x, cy: b.cy ?? b.y, cz: b.rawCz ?? b.cz ?? b.z,
                    rx: b.rx || 0, ry: b.ry || 0, rz: b.rz || 0,
                    L: b.L || 4.5, W: b.W || 1.9, H: b.H || 1.6
                };
                const plane = Neo.matPhangDay(ptsSrc);
                if (!plane) continue;
                let aOut = plane.a;
                let bOut = plane.b;
                if ((isExplicit || isPerm) && tr && Array.isArray(tr.shapes) && Number.isFinite(fn) && kho && tKey) {
                    const aList = [], bList = [];
                    for (const s of tr.shapes) {
                        if (!s || s.outside || !Array.isArray(s.points) || s.points.length < 9) continue;
                        const sf = Number(s.frame);
                        if (!Number.isFinite(sf) || Math.abs(sf - fn) > 2) continue;
                        if (sf !== fn && !kho.laDaDuyet(tKey, sf, tr, null)) continue;
                        const plWin = Neo.matPhangDay(s.points);
                        if (plWin) { aList.push(plWin.a); bList.push(plWin.b); }
                    }
                    if (aList.length >= 2) {
                        aList.sort((u, v) => u - v);
                        bList.sort((u, v) => u - v);
                        aOut = this._pQuantileSorted(aList, 0.50);
                        bOut = this._pQuantileSorted(bList, 0.50);
                    }
                }
                const kind = (isExplicit || isPerm) ? 'approved' : 'temp';
                carNeos.push({
                    kind,
                    trackId: tKey || String(i),
                    frame: fn,
                    cx: plane.cx, cy: plane.cy, rz: plane.rz, L: plane.L, W: plane.W,
                    _cosR: Math.cos(plane.rz), _sinR: Math.sin(plane.rz),
                    zb: plane.zb, a: aOut, b: bOut,
                    zbTam: (Array.isArray(ptsSrc) ? ptsSrc[2] : ptsSrc.cz) - plane.H * 0.5,
                    sigmaZ: kind === 'approved' ? Neo.CONFIG.sigmaApproved : Neo.CONFIG.sigmaTemp,
                    _boxKey: b.key || (typeof b.cx === 'number' ? this.boxKey(b) : null)
                });
            }
        }
        carNeos.sort((u, v) => {
            if (u.kind !== v.kind) return u.kind === 'approved' ? -1 : 1;
            const ru = u.cx * u.cx + u.cy * u.cy;
            const rv = v.cx * v.cx + v.cy * v.cy;
            if (ru !== rv) return ru - rv;
            return u.trackId < v.trackId ? -1 : (u.trackId > v.trackId ? 1 : 0);
        });
        const maxC = Neo.CONFIG.maxAnchors || 64;
        for (let i = 0; i < Math.min(carNeos.length, maxC); i++) out.push(carNeos[i]);
        return carNeos.length > 0 ? out : [];
    }

    static _pQuantileSorted(ascArr, q) {
        const n = ascArr ? ascArr.length : 0;
        if (n === 0) return NaN;
        if (n === 1) return ascArr[0];
        const pos = Math.max(0, Math.min(1, q)) * (n - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return ascArr[lo] + (pos - lo) * (ascArr[hi] - ascArr[lo]);
    }

    static _solve3x3(A, b) {
        const m00 = A[0][0], m01 = A[0][1], m02 = A[0][2];
        const m10 = A[1][0], m11 = A[1][1], m12 = A[1][2];
        const m20 = A[2][0], m21 = A[2][1], m22 = A[2][2];
        const det = m00 * (m11 * m22 - m12 * m21)
                  - m01 * (m10 * m22 - m12 * m20)
                  + m02 * (m10 * m21 - m11 * m20);
        if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;
        const inv = 1.0 / det;
        const b0 = b[0], b1 = b[1], b2 = b[2];
        const x0 = inv * (b0 * (m11 * m22 - m12 * m21) - b1 * (m01 * m22 - m02 * m21) + b2 * (m01 * m12 - m02 * m11));
        const x1 = inv * (m00 * (b1 * m22 - b2 * m21) - b0 * (m10 * m22 - m12 * m20) + m02 * (m10 * b2 - b1 * m20));
        const x2 = inv * (m00 * (m11 * b2 - m21 * b1) - m01 * (m10 * b2 - m20 * b1) + b0 * (m10 * m21 - m11 * m20));
        if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(x2)) return null;
        return [x0, x1, x2];
    }

    /**
     * Tạo mặt nạ 2D OBB của các xe khác trong frame để lọc điểm nhiễu từ xe lân cận.
     * Bỏ qua hoàn toàn Z để giữ bất biến theo cao độ cuboid.
     */
    static buildOtherBoxMask(frameBoxes, targetBox, opts = {}) {
        const obbs = [];
        if (!Array.isArray(frameBoxes) || frameBoxes.length === 0 || !targetBox) {
            return { obbs, testXY: () => false };
        }
        const P = this.PHASE1;
        const cxT = Number.isFinite(targetBox.x) ? targetBox.x : (targetBox.cx ?? 0);
        const cyT = Number.isFinite(targetBox.y) ? targetBox.y : (targetBox.cy ?? 0);
        const LT = targetBox.L || 4.5;
        const WT = targetBox.W || 1.9;
        const diagT = Math.hypot(LT, WT);

        for (let i = 0; i < frameBoxes.length; i++) {
            const b = frameBoxes[i];
            if (!b) continue;
            if (targetBox.track && b.track && targetBox.track === b.track) continue;
            const pts = b.shape?.points;
            const cxB = Number.isFinite(b.cx) ? b.cx : (Number.isFinite(b.x) ? b.x : (pts ? pts[0] : NaN));
            const cyB = Number.isFinite(b.cy) ? b.cy : (Number.isFinite(b.y) ? b.y : (pts ? pts[1] : NaN));
            if (!Number.isFinite(cxB) || !Number.isFinite(cyB)) continue;
            const dist = Math.hypot(cxB - cxT, cyB - cyT);
            if (dist < 0.05) continue;

            const LB = b.L || (pts ? pts[6] : 4.5) || 4.5;
            const WB = b.W || (pts ? pts[7] : 1.9) || 1.9;
            const rzB = Number.isFinite(b.rz) ? b.rz : (pts && Number.isFinite(pts[5]) ? pts[5] : 0);
            const diagB = Math.hypot(LB, WB);
            if (dist > 0.5 * (diagB + diagT) + P.otherBoxCullExtra) continue;

            const pad = opts.pad ?? (P.otherBoxPadBase + P.otherBoxPadPerM * Math.hypot(cxB, cyB));
            const halfL = LB * 0.5 + pad;
            const halfW = WB * 0.5 + pad;
            const maxR = Math.hypot(halfL, halfW);
            obbs.push({
                cx: cxB,
                cy: cyB,
                cosR: Math.cos(rzB),
                sinR: Math.sin(rzB),
                halfL,
                halfW,
                maxR2: maxR * maxR
            });
        }

        return {
            obbs,
            testXY: (px, py) => {
                for (let i = 0; i < obbs.length; i++) {
                    const o = obbs[i];
                    const dx = px - o.cx;
                    const dy = py - o.cy;
                    if (dx * dx + dy * dy > o.maxR2) continue;
                    const u = o.cosR * dx + o.sinR * dy;
                    const v = -o.sinR * dx + o.cosR * dy;
                    if (Math.abs(u) <= o.halfL && Math.abs(v) <= o.halfW) return true;
                }
                return false;
            }
        };
    }

    /**
     * Nguồn 2: Ước lượng mặt đường bằng cách đo nóc xe (zTop) và trừ đi H + δ(R).
     * Bất biến hoàn toàn theo cz/zBottom của cuboid.
     */
    static estimateRoofCue(carBox, rawPts, egoPlane, otherMask) {
        const P = this.PHASE1;
        const fail = (flag) => ({
            valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity,
            n: 0, cover: 0, zTop: NaN, flags: flag ? [flag] : []
        });
        if (!carBox || !rawPts || rawPts.length === 0) return fail('OCC');

        const cx = carBox.x, cy = carBox.y;
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;

        if (!(W >= P.classMinW && L >= P.classMinL && L <= P.classMaxL && H <= P.classMaxH)) {
            return fail('NGOAI_LOP');
        }

        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const R = Math.hypot(cx, cy);
        const sigmaEgo = 0.15 + 0.004 * R;
        const zEgoAtCar = ego.z0 + ego.gx * cx + ego.gy * cy;

        const halfL = L * 0.5, halfW = W * 0.5;
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const rMax = Math.hypot(halfL, halfW) + 0.05;
        const rMax2 = rMax * rMax;
        const hMin = -sigmaEgo - 0.30;
        const hMax = H + sigmaEgo + 0.45;

        const pts = [];
        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy > rMax2) continue;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            if (Math.abs(u) > halfL || Math.abs(v) > halfW) continue;
            if (otherMask && otherMask.testXY(px, py)) continue;
            const zEgoPt = ego.z0 + ego.gx * px + ego.gy * py;
            const h = pz - zEgoPt;
            if (h >= hMin && h <= hMax) {
                pts.push({ z: pz, u, v });
            }
        }

        if (pts.length === 0) return fail('OCC');

        pts.sort((a, b) => b.z - a.z);
        const clusters = [];
        let cur = [];
        for (let i = 0; i < pts.length; i++) {
            if (cur.length === 0 || (cur[cur.length - 1].z - pts[i].z) <= P.roofClusterGap) {
                cur.push(pts[i]);
            } else {
                clusters.push(cur);
                cur = [pts[i]];
            }
        }
        if (cur.length > 0) clusters.push(cur);

        const minC = Math.max(3, Math.floor(0.10 * pts.length));
        const topCluster = clusters.find(c => c.length >= minC);
        if (!topCluster || topCluster.length === 0) {
            return { valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity, n: pts.length, cover: 0, zTop: NaN, flags: ['OCC'] };
        }

        const ascZ = new Float64Array(topCluster.length);
        let cellMask = 0;
        let cover = 0;
        for (let i = 0; i < topCluster.length; i++) {
            const pt = topCluster[i];
            ascZ[i] = pt.z;
            const iu = Math.min(2, Math.max(0, Math.floor(((pt.u + halfL) / Math.max(1e-6, L)) * 3)));
            const iv = Math.min(2, Math.max(0, Math.floor(((pt.v + halfW) / Math.max(1e-6, W)) * 3)));
            const bit = 1 << (iu * 3 + iv);
            if ((cellMask & bit) === 0) {
                cellMask |= bit;
                cover++;
            }
        }
        ascZ.sort();
        const zTop = this._pQuantileSorted(ascZ, 0.97);

        const flags = [];
        const minCover = R > 45.0 ? 2 : P.roofMinCover;
        const isOccluded = (pts.length < P.roofMinPts)
            || (cover < minCover)
            || ((zTop - zEgoAtCar) < (P.roofHRelMin * H - sigmaEgo));
        if (isOccluded) {
            flags.push('OCC');
            return { valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity, n: pts.length, cover, zTop, flags };
        }

        const deltaR = P.delta0 + P.deltaSlopePerM * Math.max(0, R - 60);
        const z = zTop - H + deltaR;
        const gx = Math.max(-P.maxSlopeAbs, Math.min(P.maxSlopeAbs, ego.gx));
        const gy = Math.max(-P.maxSlopeAbs, Math.min(P.maxSlopeAbs, ego.gy));
        const sigma = 0.04 + 0.0005 * Math.max(0, R - 60) + (pts.length < 40 ? 0.03 : 0);

        return { valid: true, z, gx, gy, sigma, n: pts.length, cover, zTop, flags };
    }

    /**
     * Nguồn 1: Ước lượng mặt đường trực tiếp từ vành đai quanh xe + điểm sát gầm,
     * chia lưới lower-envelope (p15) + Huber IRLS + Ridge Regression chỉ kéo dốc về Ego.
     */
    static _getRobustSurfaceCfg(override = null) {
        if (!override && this._cachedRobCfg && typeof MatDuongDongTam !== 'undefined' && MatDuongDongTam.MAC_DINH?.robustSurface === this._cachedRobRef) {
            return this._cachedRobCfg;
        }
        const base = (typeof MatDuongDongTam !== 'undefined' && MatDuongDongTam.MAC_DINH?.robustSurface)
            ? MatDuongDongTam.MAC_DINH.robustSurface
            : {
                enabled: true,
                slopeCap: { lat: 0.035, long: 0.08 },
                patch: { highCellW: 0.02, highShareMax: 0.10, minLowCells: 6 },
                profile: { clampBase: 0.04, clampMax: 0.25 },
                fuseNeoSlope: true,
                crossCar: { enabled: false, radius: 10.0, decay: 6.0 }
            };
        if (!override) {
            this._cachedRobRef = base;
            this._cachedRobCfg = base;
            return base;
        }
        return {
            ...base,
            ...override,
            slopeCap: { ...(base.slopeCap || {}), ...(override.slopeCap || {}) },
            patch: { ...(base.patch || {}), ...(override.patch || {}) },
            profile: { ...(base.profile || {}), ...(override.profile || {}) },
            crossCar: { ...(base.crossCar || {}), ...(override.crossCar || {}) }
        };
    }

    static _chuanHoaTrongSoLe(wArr, dzLoArr, ngoaiDuongArr = null, cfgPatch = null) {
        const n = wArr ? wArr.length : 0;
        if (n === 0) return;
        const highCellW = cfgPatch?.highCellW ?? 0.02;
        const highShareMax = cfgPatch?.highShareMax ?? 0.10;
        const minLowCells = cfgPatch?.minLowCells ?? 6;
        let nLow = 0;
        let sumLow = 0.0;
        let sumHigh = 0.0;
        const isHigh = new Uint8Array(n);

        for (let k = 0; k < n; k++) {
            const dzLo = dzLoArr[k];
            if (ngoaiDuongArr && ngoaiDuongArr[k] && dzLo > 0.12) {
                wArr[k] = 0.0;
                continue;
            }
            if (dzLo < -0.15) {
                wArr[k] = 0.20;
                nLow++;
                sumLow += wArr[k];
            } else if (dzLo <= 0.12) {
                wArr[k] = 1.0;
                nLow++;
                sumLow += 1.0;
            } else {
                wArr[k] = highCellW;
                isHigh[k] = 1;
                sumHigh += highCellW;
            }
        }

        if (nLow < minLowCells || sumHigh <= 0 || sumLow <= 0) {
            if (nLow < minLowCells) {
                for (let k = 0; k < n; k++) if (isHigh[k]) wArr[k] = 0.05;
            }
            return;
        }
        const tot = sumLow + sumHigh;
        if (sumHigh / tot > highShareMax) {
            const scale = (highShareMax * sumLow) / (Math.max(1e-9, 1.0 - highShareMax) * sumHigh);
            for (let k = 0; k < n; k++) {
                if (isHigh[k]) wArr[k] *= scale;
            }
        }
    }

    static estimatePatchCue(carBox, rawPts, egoPlane, otherMask, zPrior = null, gate = {}) {
        const P = this.PHASE1;
        const invalidOut = (nPts = 0, nCells = 0, sectors = 0, rms = Infinity, flags = []) => ({
            valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity,
            nPts, nCells, sectors, rms, flags
        });
        if (!carBox || !rawPts || rawPts.length === 0) return invalidOut(0, 0, 0, Infinity, ['THIEU_DIEM']);

        const cx = carBox.x, cy = carBox.y;
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const R = Math.hypot(cx, cy);
        const sigmaEgo = 0.15 + 0.004 * R;
        const zEgoAtCar = ego.z0 + ego.gx * cx + ego.gy * cy;

        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const halfL = L * 0.5, halfW = W * 0.5;
        const inL = halfL + 0.15, inW = halfW + 0.15;
        const margin = Math.min(2.8, 1.8 + 0.01 * R);
        const outL = halfL + margin, outW = halfW + margin;
        const rMax = Math.hypot(outL, outW);
        const rMax2 = rMax * rMax;

        const ringCandidates = [];
        const underCandidates = [];

        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy > rMax2) continue;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            const absU = Math.abs(u), absV = Math.abs(v);
            if (absU > outL || absV > outW) continue;
            if (otherMask && otherMask.testXY(px, py)) continue;

            if (absU > inL || absV > inW) {
                ringCandidates.push([px, py, pz]);
            } else {
                const zEgoPt = ego.z0 + ego.gx * px + ego.gy * py;
                const h = pz - zEgoPt;
                if (h >= -0.80 - sigmaEgo && h <= H + 0.50 + sigmaEgo) {
                    underCandidates.push([px, py, pz, h]);
                }
            }
        }

        const candPts = ringCandidates.slice();
        if (underCandidates.length > 0) {
            underCandidates.sort((a, b) => a[3] - b[3]);
            // Chọn cụm thấp nhất (có >= 2 điểm nếu có) để tránh 1 điểm multipath lẻ bên dưới
            let clusterStartH = underCandidates[0][3];
            let runLen = 1;
            let bestStartH = clusterStartH;
            let foundCluster = false;
            for (let i = 1; i < underCandidates.length; i++) {
                if (underCandidates[i][3] - underCandidates[i - 1][3] <= 0.25) {
                    runLen++;
                } else {
                    if (runLen >= 2) { bestStartH = clusterStartH; foundCluster = true; break; }
                    clusterStartH = underCandidates[i][3];
                    runLen = 1;
                }
            }
            if (!foundCluster) bestStartH = clusterStartH;
            const hCut = bestStartH + 0.35;
            for (let i = 0; i < underCandidates.length; i++) {
                if (underCandidates[i][3] >= bestStartH - 0.15 && underCandidates[i][3] <= hCut) {
                    candPts.push([underCandidates[i][0], underCandidates[i][1], underCandidates[i][2]]);
                }
            }
        }

        if (candPts.length < P.patchMinPts) {
            return invalidOut(candPts.length, 0, 0, Infinity, ['THIEU_DIEM']);
        }

        const hasNbGate = Number.isFinite(gate?.zCenter);
        const san = gate?.san || null;
        const zGateCenter = hasNbGate ? gate.zCenter : zEgoAtCar;
        const slopeGateGx = (Array.isArray(gate?.slopeCenter) && Number.isFinite(gate.slopeCenter[0])) ? gate.slopeCenter[0] : ego.gx;
        const slopeGateGy = (Array.isArray(gate?.slopeCenter) && Number.isFinite(gate.slopeCenter[1])) ? gate.slopeCenter[1] : ego.gy;
        const baseMaxDz = Number.isFinite(gate?.halfBand) ? gate.halfBand : (gate?.maxDzEgo ?? (0.35 + 0.006 * R));
        const maxSlopeDev = Number.isFinite(gate?.maxSlopeDev) ? gate.maxSlopeDev : P.maxSlopeDevEgo;

        let curZc = Number.isFinite(zPrior) ? zPrior : (hasNbGate ? zGateCenter : zEgoAtCar);
        let tamLaiXuong = false;
        if (this.CO.tamLaiCuaSo && !hasNbGate && !Number.isFinite(zPrior) && san && san.valid && san.zLow < curZc - 0.15) {
            curZc = san.zLow - 0.12;
            tamLaiXuong = true;
        }
        let curGx = slopeGateGx;
        let curGy = slopeGateGy;
        const cellSize = 0.50 + 0.005 * R;
        const invCell = 1.0 / cellSize;

        let finalInPtsCount = 0;
        let finalCells = [];
        let finalSectors = 0;
        let finalRms = Infinity;
        let solved = false;

        for (let iter = 0; iter < 2; iter++) {
            const zLoOff = (this.CO.tamLaiCuaSo ? -0.75 : -0.60) - sigmaEgo;
            const zHiOff = 0.50 + sigmaEgo;
            let cellMap = new Map();
            let inPtsCount = 0;
            let bottomStripCount = 0;

            const gomVaoCell = (zcBase) => {
                cellMap = new Map();
                inPtsCount = 0;
                bottomStripCount = 0;
                for (let i = 0; i < candPts.length; i++) {
                    const pt = candPts[i];
                    const dx = pt[0] - cx, dy = pt[1] - cy, pz = pt[2];
                    const zRef = zcBase + curGx * dx + curGy * dy;
                    const dz = pz - zRef;
                    if (dz < zLoOff || dz > zHiOff) continue;
                    inPtsCount++;
                    if (dz < zLoOff + 0.30) bottomStripCount++;

                    const gxIdx = Math.floor(dx * invCell);
                    const gyIdx = Math.floor(dy * invCell);
                    const key = gxIdx * 10007 + gyIdx;
                    let arr = cellMap.get(key);
                    if (!arr) { arr = []; cellMap.set(key, arr); }
                    arr.push([dx, dy, pz]);
                }
            };

            gomVaoCell(curZc);

            // Step 3: Tái định tâm xuống dưới tối đa 3 bước nếu điểm dồn ở mép đáy cửa sổ Z
            if (this.CO.tamLaiCuaSo && iter === 0 && !hasNbGate && !Number.isFinite(zPrior)) {
                let shiftSteps = 0;
                while (shiftSteps < 3) {
                    const denseAtBottom = inPtsCount >= P.patchMinPts && (bottomStripCount / Math.max(1, inPtsCount)) >= 0.25;
                    let hasBelowPts = false;
                    if (inPtsCount < P.patchMinPts) {
                        let cntBelow = 0;
                        for (let i = 0; i < candPts.length; i++) {
                            const pt = candPts[i];
                            const dz = pt[2] - (curZc + curGx * (pt[0] - cx) + curGy * (pt[1] - cy));
                            if (dz < zLoOff && dz >= zLoOff - 1.20) cntBelow++;
                        }
                        hasBelowPts = cntBelow >= P.patchMinPts;
                    }
                    if (!denseAtBottom && !hasBelowPts) break;
                    curZc -= 0.40;
                    tamLaiXuong = true;
                    shiftSteps++;
                    gomVaoCell(curZc);
                }
            }

            let cells = [];
            let sectorMask = 0;
            let sectors = 0;
            for (const arr of cellMap.values()) {
                if (arr.length < P.patchCellPtsMin) continue;
                let sumX = 0, sumY = 0;
                const zs = new Float64Array(arr.length);
                for (let j = 0; j < arr.length; j++) {
                    sumX += arr[j][0];
                    sumY += arr[j][1];
                    zs[j] = arr[j][2];
                }
                zs.sort();
                const z15 = this._pQuantileSorted(zs, 0.15);
                const mx = sumX / arr.length;
                const my = sumY / arr.length;
                cells.push({ dx: mx, dy: my, z: z15 });

                const ang = Math.atan2(my, mx);
                const sec = Math.min(7, Math.max(0, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 8)));
                const sbit = 1 << sec;
                if ((sectorMask & sbit) === 0) {
                    sectorMask |= sbit;
                    sectors++;
                }
            }

            if (gate?.modeSelect && cells.length >= P.patchMinCells) {
                const sortedC = [...cells].sort((a, b) => a.z - b.z);
                const clusters = [];
                let curCl = [];
                for (const c of sortedC) {
                    if (curCl.length === 0 || (c.z - curCl[curCl.length - 1].z) <= 0.14) curCl.push(c);
                    else { clusters.push(curCl); curCl = [c]; }
                }
                if (curCl.length > 0) clusters.push(curCl);
                if (clusters.length >= 2) {
                    let bestCl = null, bestDist = Infinity;
                    for (const cl of clusters) {
                        if (cl.length < P.patchMinCells) continue;
                        const zMid = cl[Math.floor(cl.length / 2)].z;
                        const dist = Math.abs(zMid - zGateCenter);
                        if (dist <= baseMaxDz && dist < bestDist) {
                            bestDist = dist; bestCl = cl;
                        }
                    }
                    if (bestCl) {
                        let m2 = 0, s2 = 0;
                        for (const c of bestCl) {
                            const ang = Math.atan2(c.dy, c.dx);
                            const sec = Math.min(7, Math.max(0, Math.floor(((ang + Math.PI) / (2 * Math.PI)) * 8)));
                            const bit = 1 << sec;
                            if ((m2 & bit) === 0) { m2 |= bit; s2++; }
                        }
                        if (s2 >= P.patchMinSectors) {
                            cells = bestCl;
                            sectors = s2;
                        }
                    }
                }
            }

            finalInPtsCount = inPtsCount;
            finalCells = cells;
            finalSectors = sectors;

            if (inPtsCount < P.patchMinPts || cells.length < P.patchMinCells || sectors < P.patchMinSectors) {
                solved = false;
                break;
            }

            const wArr = new Float64Array(cells.length);
            // Neo vòng lặp đầu theo dải thấp nhất của mặt đường (p15) để bó vỉa/vỉa hè không kéo mặt phẳng lên
            const cellZs = new Float64Array(cells.length);
            for (let k = 0; k < cells.length; k++) cellZs[k] = cells[k].z;
            cellZs.sort();
            const zFloor = this._pQuantileSorted(cellZs, 0.15);
            const robPatchCfg = this._getRobustSurfaceCfg(gate?.robustSurface);
            if (robPatchCfg.enabled) {
                const dzLoArr = new Float64Array(cells.length);
                let ngoaiArr = null;
                if (gate?.mat && typeof gate.mat.timLa === 'function') {
                    ngoaiArr = new Uint8Array(cells.length);
                    for (let k = 0; k < cells.length; k++) {
                        dzLoArr[k] = cells[k].z - zFloor;
                        const lf = gate.mat.timLa(cx + cells[k].dx, cy + cells[k].dy);
                        if (lf && lf.ngoaiDuong) ngoaiArr[k] = 1;
                    }
                } else {
                    for (let k = 0; k < cells.length; k++) dzLoArr[k] = cells[k].z - zFloor;
                }
                this._chuanHoaTrongSoLe(wArr, dzLoArr, ngoaiArr, robPatchCfg.patch);
            } else {
                for (let k = 0; k < cells.length; k++) {
                    const dzLo = cells[k].z - zFloor;
                    if (dzLo < -0.15) wArr[k] = 0.20;
                    else if (dzLo <= 0.12) wArr[k] = 1.0;
                    else wArr[k] = 0.05;
                }
            }
            let fitZc = curZc, fitGx = slopeGateGx, fitGy = slopeGateGy;
            let fitOk = true;

            for (let irls = 0; irls < 3; irls++) {
                let sumW = 0;
                for (let k = 0; k < cells.length; k++) sumW += wArr[k];
                const lambdaG = P.patchRidgeLambda * sumW;

                let m00 = 0, m01 = 0, m02 = 0;
                let m11 = lambdaG, m12 = 0, m22 = lambdaG;
                let b0 = 0, b1 = lambdaG * slopeGateGx, b2 = lambdaG * slopeGateGy;

                for (let k = 0; k < cells.length; k++) {
                    const c = cells[k];
                    const w = wArr[k];
                    m00 += w;
                    m01 += w * c.dx;
                    m02 += w * c.dy;
                    m11 += w * c.dx * c.dx;
                    m12 += w * c.dx * c.dy;
                    m22 += w * c.dy * c.dy;
                    b0 += w * c.z;
                    b1 += w * c.dx * c.z;
                    b2 += w * c.dy * c.z;
                }

                const sol = this._solve3x3(
                    [[m00, m01, m02], [m01, m11, m12], [m02, m12, m22]],
                    [b0, b1, b2]
                );
                if (!sol) { fitOk = false; break; }
                fitZc = sol[0]; fitGx = sol[1]; fitGy = sol[2];

                const absRes = new Float64Array(cells.length);
                const resArr = new Float64Array(cells.length);
                for (let k = 0; k < cells.length; k++) {
                    const c = cells[k];
                    const r = c.z - (fitZc + fitGx * c.dx + fitGy * c.dy);
                    resArr[k] = r;
                    absRes[k] = Math.abs(r);
                }
                if (irls === 2) {
                    let wSq = 0, wTot = 0;
                    for (let k = 0; k < cells.length; k++) {
                        wSq += wArr[k] * resArr[k] * resArr[k];
                        wTot += wArr[k];
                    }
                    finalRms = wTot > 1e-6 ? Math.sqrt(wSq / wTot) : Infinity;
                } else {
                    const inlierRes = [];
                    for (let k = 0; k < cells.length; k++) {
                        if (wArr[k] >= 0.5) inlierRes.push(absRes[k]);
                    }
                    const refArr = inlierRes.length >= 3 ? new Float64Array(inlierRes).sort() : new Float64Array(absRes).sort();
                    const mad = 1.4826 * this._pQuantileSorted(refArr, 0.50);
                    const thr = Math.max(0.05, 2.5 * mad);
                    for (let k = 0; k < cells.length; k++) {
                        // Vỉa hè cao hẳn > 18cm phía trên mặt đường tiếp tục bị ép nhẹ hơn Huber đối xứng
                        if (resArr[k] > 0.18) wArr[k] = Math.min(0.10, thr / absRes[k]);
                        else wArr[k] = absRes[k] <= thr ? 1.0 : (thr / absRes[k]);
                    }
                }
            }

            if (!fitOk) { solved = false; break; }
            const dzIter = Math.abs(fitZc - curZc);
            curZc = fitZc;
            curGx = fitGx;
            curGy = fitGy;
            solved = true;
            if (dzIter < 0.01) break;
        }

        const flags = [];
        const maxDzEgo = (!hasNbGate && R > 45 && finalCells.length < 8) ? Math.min(baseMaxDz, 0.30) : baseMaxDz;
        const allowDownDev = this.CO.tamLaiCuaSo && !hasNbGate && curZc < zGateCenter
            && (tamLaiXuong || (san && san.valid && san.zLow < zGateCenter - 0.10 && curZc <= san.zLow + 0.03));
        const maxDownDz = allowDownDev ? Math.max(maxDzEgo, 1.50) : maxDzEgo;
        const dzFromGate = curZc - zGateCenter;
        const rmsMax = 0.08 + 0.0015 * R;
        const valid = solved
            && finalInPtsCount >= P.patchMinPts
            && finalCells.length >= P.patchMinCells
            && finalSectors >= P.patchMinSectors
            && finalRms <= rmsMax
            && Math.hypot(curGx, curGy) <= P.maxSlopeAbs
            && Math.hypot(curGx - slopeGateGx, curGy - slopeGateGy) <= maxSlopeDev
            && dzFromGate <= maxDzEgo
            && dzFromGate >= -maxDownDz;

        if (hasNbGate) flags.push('PRIOR_NB');
        if (valid && tamLaiXuong) flags.push('TAM_LAI');
        if (!valid) {
            if (finalCells.length < P.patchMinCells || finalInPtsCount < P.patchMinPts) flags.push('THIEU_DIEM');
            else if (finalSectors < P.patchMinSectors) flags.push('LECH_GOC');
            else flags.push('PATCH_REJECT');
        }

        const sigma = valid ? Math.max(0.04, finalRms) * Math.sqrt(5.0 / Math.max(1, finalCells.length)) : Infinity;
        return {
            valid,
            z: valid ? curZc : NaN,
            gx: valid ? curGx : 0,
            gy: valid ? curGy : 0,
            sigma,
            nPts: finalInPtsCount,
            nCells: finalCells.length,
            sectors: finalSectors,
            rms: finalRms,
            flags
        };
    }

    /**
     * Step 1 (Đợt 1): Xác định cao độ sàn thân xe thấp nhất (zLow) trong footprint co 10cm.
     * Bất biến 100% theo cz / zBottom của cuboid.
     */
    static tinhSanThanXe(carBox, rawPts, egoPlane, otherMask) {
        const inv = { valid: false, zLow: NaN, zHigh: NaN, nPts: 0 };
        if (!carBox || !rawPts || rawPts.length === 0) return inv;

        const cx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? 0);
        const cy = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? 0);
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };

        const inL = Math.max(0.10, L * 0.5 - 0.10);
        const inW = Math.max(0.10, W * 0.5 - 0.10);
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const rMax2 = (Math.hypot(inL, inW) + 0.05) ** 2;

        const zsMasked = [];
        const zsUnmasked = [];
        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy > rMax2) continue;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            if (Math.abs(u) > inL || Math.abs(v) > inW) continue;
            const zEgoPt = ego.z0 + ego.gx * px + ego.gy * py;
            const h = pz - zEgoPt;
            if (h < -3.50 || h > Math.max(6.0, H + 4.0)) continue;
            zsUnmasked.push(pz);
            if (!otherMask || !otherMask.testXY(px, py)) zsMasked.push(pz);
        }
        const zs = zsMasked.length >= 8 ? zsMasked : zsUnmasked;
        const zsMinSrc = zsMasked.length >= 2 ? [...zsMasked] : [...zsUnmasked];
        let zMinBody = NaN;
        if (zsMinSrc.length >= 2) {
            zsMinSrc.sort((a, b) => a - b);
            zMinBody = (zsMinSrc.length >= 4 && (zsMinSrc[1] - zsMinSrc[0]) > 0.35) ? zsMinSrc[1] : zsMinSrc[0];
        }
        const nPtsRaw = zsMinSrc.length;
        if (zs.length < 8) return { valid: false, zLow: NaN, zHigh: NaN, nPts: zs.length, zMinBody, nPtsRaw };

        // Loại bỏ tán cây / mái che cao phía trên thân xe dựa trên chiều cao H của box
        zs.sort((a, b) => a - b);
        const zSeedLo = this._pQuantileSorted(zs, 0.05);
        const zCutHi = zSeedLo + Math.max(1.2, H + 0.80);
        let bodyEnd = zs.length;
        while (bodyEnd > 0 && zs[bodyEnd - 1] > zCutHi) bodyEnd--;
        const bodyZs = zs.slice(0, bodyEnd);
        if (bodyZs.length < 8) return { valid: false, zLow: NaN, zHigh: NaN, nPts: bodyZs.length, zMinBody, nPtsRaw };

        const minZ = bodyZs[0], maxZ = bodyZs[bodyZs.length - 1];
        const binSize = 0.14;
        const nBins = Math.max(1, Math.floor((maxZ - minZ) / binSize) + 1);
        const counts = new Int32Array(nBins);
        for (let i = 0; i < bodyZs.length; i++) {
            const bi = Math.min(nBins - 1, Math.max(0, Math.floor((bodyZs[i] - minZ) / binSize)));
            counts[bi]++;
        }

        const occMin = bodyZs.length < 25 ? 1 : Math.max(2, Math.min(4, Math.floor(0.015 * bodyZs.length)));
        let runStart = -1, runEnd = -1, curStart = -1;
        for (let b = 0; b < nBins; b++) {
            if (counts[b] >= occMin) {
                if (curStart < 0) curStart = b;
            } else {
                if (curStart >= 0 && (b - curStart) >= 2) {
                    runStart = curStart; runEnd = b - 1; break;
                }
                curStart = -1;
            }
        }
        if (runStart < 0 && curStart >= 0 && (nBins - curStart) >= 2) {
            runStart = curStart; runEnd = nBins - 1;
        }

        let candZs;
        if (runStart >= 0) {
            const zRunLo = minZ + runStart * binSize;
            const zRunHi = minZ + (runEnd + 1) * binSize;
            candZs = [];
            for (let i = 0; i < bodyZs.length; i++) {
                if (bodyZs[i] >= zRunLo - 1e-6 && bodyZs[i] <= zRunHi + 1e-6) candZs.push(bodyZs[i]);
            }
        } else {
            const span = this._pQuantileSorted(bodyZs, 0.90) - this._pQuantileSorted(bodyZs, 0.10);
            if (span < 0.28) return { valid: false, zLow: NaN, zHigh: NaN, nPts: bodyZs.length, zMinBody, nPtsRaw };
            candZs = bodyZs;
        }
        if (!candZs || candZs.length < 6) return { valid: false, zLow: NaN, zHigh: NaN, nPts: bodyZs.length, zMinBody, nPtsRaw };
        candZs.sort((a, b) => a - b);
        const qLow = candZs.length >= 40 ? 0.015 : (candZs.length >= 20 ? 0.03 : 0.05);
        const zLow = Math.max(candZs[1] ?? candZs[0], this._pQuantileSorted(candZs, qLow));
        const zHigh = candZs[candZs.length - 1];
        if (!Number.isFinite(zMinBody)) zMinBody = zLow;
        return { valid: Number.isFinite(zLow), zLow, zHigh, nPts: candZs.length, zMinBody, nPtsRaw };
    }

    /**
     * Đợt 3: Tìm cao độ nóc xe (zTop) ĐỘC LẬP với zEgo (chịu được dốc ±1.7m+).
     * Dùng ref.zRef (sanLow -> polar.z -> p5 footprint), lưới 0.5×0.5m tìm plateau cao nhất
     * có thân xe liên tục bên dưới (loại tán cây/biển báo).
     * Bất biến 100% theo cz / zBottom và thứ tự điểm.
     */
    static timNocDocLap(carBox, rawPts, otherMask = null, ref = null) {
        const inv = { valid: false, zTop: NaN, conf: 0, cov: 0, mad: NaN, nBody: 0, nPts: 0, why: 'OCC' };
        if (!carBox || !rawPts || rawPts.length === 0) return inv;

        const cx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? 0);
        const cy = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? 0);
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;

        const inL = Math.max(0.15, L * 0.5 - 0.10);
        const inW = Math.max(0.15, W * 0.5 - 0.10);
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const rMax2 = (Math.hypot(inL, inW) + 0.05) ** 2;

        const maskedPts = [];
        const unmaskedPts = [];
        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy > rMax2) continue;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            if (Math.abs(u) > inL || Math.abs(v) > inW) continue;
            if (pz < -6.0 || pz > 10.0) continue;
            unmaskedPts.push({ u, v, z: pz });
            if (!otherMask || !otherMask.testXY(px, py)) maskedPts.push({ u, v, z: pz });
        }

        const footPts = maskedPts.length >= 12 ? maskedPts : unmaskedPts;
        if (footPts.length < 12) return { ...inv, nPts: footPts.length, why: 'OCC' };

        let zRef = (ref && Number.isFinite(ref.zRef)) ? ref.zRef : NaN;
        let refSrc = (ref && Number.isFinite(ref.zRef)) ? (ref.nguon || 'ref') : 'p5';
        if (!Number.isFinite(zRef)) {
            const allZ = footPts.map(p => p.z).sort((a, b) => a - b);
            zRef = this._pQuantileSorted(allZ, 0.05);
            refSrc = 'p5';
        }

        const zWinLo = zRef - 0.40;
        const maxAbove = (refSrc === 'sanLow') ? Math.max(0.42, 0.25 * H) : (H * 0.15 + 0.75);
        const zWinHi = zRef + H + maxAbove;
        const winPts = [];
        for (let i = 0; i < footPts.length; i++) {
            const p = footPts[i];
            if (p.z >= zWinLo && p.z <= zWinHi) winPts.push(p);
        }
        if (winPts.length < 12) return { ...inv, nPts: winPts.length, why: 'WIN_OCC' };

        const winZs = winPts.map(p => p.z).sort((a, b) => a - b);
        const evalBodySupport = (zPlat) => {
            const lo = zPlat - 0.95 * H;
            const hi = zPlat - 0.25;
            let cnt = 0;
            let nearGapCnt = 0; // khoảng trống ngay dưới nóc [zPlat-0.28, zPlat-0.08]: cành cây lơ lửng sẽ bằng 0
            let midBodyCnt = 0;
            const nearLo = zPlat - 0.28, nearHi = zPlat - 0.08;
            const midLo = zPlat - 0.55, midHi = zPlat - 0.15;
            for (let i = 0; i < winZs.length; i++) {
                const zv = winZs[i];
                if (zv >= lo && zv <= hi) cnt++;
                if (zv >= nearLo && zv <= nearHi) nearGapCnt++;
                if (zv >= midLo && zv <= midHi) midBodyCnt++;
            }
            return { nBody: cnt, nNearBelow: nearGapCnt, nMidBelow: midBodyCnt };
        };

        // Khi xe ở xa/thưa (< 80 điểm), tia LiDAR trên nóc có thể chỉ trúng 1-2 điểm/ô -> ưu tiên cluster top 1D + kiểm tra thân liên tục
        if (winPts.length < 80) {
            const zHi98 = this._pQuantileSorted(winZs, 0.97);
            const band = [];
            for (let i = 0; i < winZs.length; i++) {
                if (winZs[i] >= zHi98 - 0.18 && winZs[i] <= zHi98 + 0.04) band.push(winZs[i]);
            }
            if (band.length >= 3) {
                const zPlat = this._pQuantileSorted(band, 0.50);
                const sup = evalBodySupport(zPlat);
                const minB = winPts.length >= 30 ? 6 : 4;
                const okSan = refSrc !== 'sanLow' || ((zPlat - zRef) >= 0.55 * H && (zPlat - zRef) <= 1.18 * H + 0.12);
                if (sup.nBody >= minB && (sup.nMidBelow >= 2 || winPts.length < 25) && okSan) {
                    const zTop = this._pQuantileSorted(band, 0.95);
                    const devs = band.map(z => Math.abs(z - zPlat)).sort((a, b) => a - b);
                    const mad = this._pQuantileSorted(devs, 0.50);
                    const conf = Math.min(0.85, 0.42 + 0.03 * Math.min(14, band.length)) * (mad <= 0.045 ? 1.0 : 0.85);
                    return {
                        valid: Number.isFinite(zTop),
                        zTop,
                        conf,
                        cov: 0.50,
                        mad,
                        nBody: sup.nBody,
                        nPts: winPts.length,
                        why: null
                    };
                }
            }
        }

        const cellSize = 0.50;
        const cellMap = new Map();
        for (let i = 0; i < winPts.length; i++) {
            const p = winPts[i];
            const iu = Math.floor((p.u + inL) / cellSize);
            const iv = Math.floor((p.v + inW) / cellSize);
            const key = iu * 1000 + iv;
            let arr = cellMap.get(key);
            if (!arr) { arr = []; cellMap.set(key, arr); }
            arr.push(p.z);
        }

        const minCellPts = winPts.length >= 40 ? 3 : 2;
        const minCells = winPts.length >= 40 ? 4 : 2;
        const cells = [];
        for (const [key, zs] of cellMap.entries()) {
            if (zs.length < minCellPts) continue;
            zs.sort((a, b) => a - b);
            cells.push({
                key,
                zs,
                top: this._pQuantileSorted(zs, 0.90)
            });
        }

        if (cells.length >= minCells) {
            cells.sort((a, b) => (b.top - a.top) || (a.key - b.key));
            for (let i = 0; i < cells.length; i++) {
                const seedTop = cells[i].top;
                // Bỏ qua các điểm cao bất thường nhỏ lẻ (<25% số ô) nằm phía trên
                let nHigher = 0;
                for (let j = 0; j < cells.length; j++) {
                    if (cells[j].top > seedTop + 0.25) nHigher++;
                }
                if (nHigher > 0 && nHigher / cells.length >= 0.25) continue;

                const cluster = [];
                for (let j = 0; j < cells.length; j++) {
                    const t = cells[j].top;
                    if (t >= seedTop - 0.12 && t <= seedTop + 0.02) cluster.push(cells[j]);
                }
                const cov = cluster.length / cells.length;
                if (cov < 0.35) continue;

                const tops = cluster.map(c => c.top).sort((a, b) => a - b);
                const zPlat = this._pQuantileSorted(tops, 0.50);
                const devs = tops.map(t => Math.abs(t - zPlat)).sort((a, b) => a - b);
                const mad = this._pQuantileSorted(devs, 0.50);
                if (mad > 0.065) continue;

                const sup = evalBodySupport(zPlat);
                const minBody = winPts.length >= 30 ? 8 : 4;
                if (sup.nBody < minBody || sup.nMidBelow < 3) continue;
                // Chống cành cây/biển báo lơ lửng ngay trên nóc xe: nếu có khe không khí [zPlat-0.28, zPlat-0.08] trống mà bên dưới lại có bề mặt rõ hơn -> bỏ qua
                let nLowerStrong = 0;
                for (let j = 0; j < cells.length; j++) {
                    if (cells[j].top >= zPlat - 0.70 && cells[j].top <= zPlat - 0.22) nLowerStrong++;
                }
                if (sup.nNearBelow < 2 && nLowerStrong / cells.length >= 0.35) continue;
                if (refSrc === 'sanLow') {
                    const spanRef = zPlat - zRef;
                    if (spanRef < 0.55 * H || spanRef > 1.22 * H + 0.15) continue;
                }

                const platZs = [];
                for (let c = 0; c < cluster.length; c++) {
                    const arr = cluster[c].zs;
                    for (let k = 0; k < arr.length; k++) platZs.push(arr[k]);
                }
                platZs.sort((a, b) => a - b);
                const zTop = this._pQuantileSorted(platZs, 0.97);
                const conf = Math.min(1.0, cov / 0.60) * Math.min(1.0, sup.nBody / 20.0) * (mad <= 0.03 ? 1.0 : 0.80);
                return {
                    valid: Number.isFinite(zTop),
                    zTop,
                    conf,
                    cov,
                    mad,
                    nBody: sup.nBody,
                    nPts: winPts.length,
                    why: null
                };
            }
        }

        // Sparse fallback (xe ở xa 45..65m ít cell ngang)
        if (winPts.length >= 12) {
            const zSeed = this._pQuantileSorted(winZs, 0.92);
            const band = [];
            for (let i = 0; i < winZs.length; i++) {
                if (winZs[i] >= zSeed - 0.14 && winZs[i] <= zSeed + 0.05) band.push(winZs[i]);
            }
            if (band.length >= 3) {
                const zPlat = this._pQuantileSorted(band, 0.50);
                const sup = evalBodySupport(zPlat);
                const okSanSpan = refSrc !== 'sanLow' || ((zPlat - zRef) >= 0.55 * H && (zPlat - zRef) <= 1.22 * H + 0.15);
                if (sup.nBody >= 4 && okSanSpan) {
                    const zTop = this._pQuantileSorted(band, 0.95);
                    const devs = band.map(z => Math.abs(z - zPlat)).sort((a, b) => a - b);
                    const mad = this._pQuantileSorted(devs, 0.50);
                    const conf = Math.min(0.60, 0.35 + 0.025 * Math.min(10, band.length)) * (mad <= 0.04 ? 1.0 : 0.80);
                    return {
                        valid: Number.isFinite(zTop),
                        zTop,
                        conf,
                        cov: 0.40,
                        mad,
                        nBody: sup.nBody,
                        nPts: winPts.length,
                        why: null
                    };
                }
            }
        }

        return { ...inv, nPts: winPts.length, why: 'NO_PLATEAU' };
    }

    /**
     * Đợt 3: Giải toàn bộ 1 track bằng Anchor-to-Fade + Auto-Calibrate H_cal + Roof-Down Fallback.
     * Bất biến 100% theo cz / zBottom và thứ tự phần tử đầu vào (luôn sort theo fn tăng dần).
     * Trả về { resMap: Map<fn, res>, meta: { H_cal, nguon, nAnchors, nSoft, nFixed, anchorFns } }.
     */
    static giaiTrackPhase3(trackItems, opts = {}) {
        const P3 = this.PHASE3;
        const resMap = new Map();
        const emptyMeta = { H_cal: NaN, nguon: 'NONE', nAnchors: 0, nSoft: 0, nFixed: 0, anchorFns: [] };
        if (!Array.isArray(trackItems) || trackItems.length === 0) return { resMap, meta: emptyMeta };

        // 1. Sort xác định theo fn để bất biến hoán vị
        const items = [...trackItems]
            .filter(it => it && Number.isFinite(Number(it.fn)) && it.carBox && it.p2)
            .sort((a, b) => Number(a.fn) - Number(b.fn));
        if (items.length === 0) return { resMap, meta: emptyMeta };

        // Chuẩn bị arc-length s(fn), tọa độ cx,cy,R, và roof độc lập cho từng item
        const prepared = [];
        let sCum = 0;
        let prevX = null, prevY = null;
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const fn = Number(it.fn);
            const cb = it.carBox;
            const cx = Number.isFinite(cb.x) ? cb.x : (cb.cx ?? 0);
            const cy = Number.isFinite(cb.y) ? cb.y : (cb.cy ?? 0);
            const H = cb.H || 1.6;
            const R = Math.hypot(cx, cy);
            if (prevX !== null) sCum += Math.hypot(cx - prevX, cy - prevY);
            prevX = cx; prevY = cy;

            const san = it.san || it.p2?._san || null;
            const sanValid = !!(san && san.valid && Number.isFinite(san.zLow));
            const sanLow = sanValid ? san.zLow : NaN;
            const pol = it.polar || it.p2?._polar || null;
            const polValid = !!(pol && pol.valid && Number.isFinite(pol.z));
            const polZ = polValid ? pol.z : NaN;
            const ellip = it.ellip || it.p2?._dens || null;
            const guard = it.guard || (opts.guardMap && opts.guardMap.get(fn)) || it.p2?.trackJump || null;
            const patchZ = Number.isFinite(it.patchZ) ? it.patchZ : (Number.isFinite(it.p2?.patchZ) ? it.p2.patchZ : it.p2.zc);

            let roof = it.roof || null;
            if (!roof && it.rawPts && it.rawPts.length > 0) {
                const zRef = sanValid ? sanLow : (polValid ? polZ : NaN);
                const refArg = Number.isFinite(zRef) ? { zRef, nguon: sanValid ? 'sanLow' : 'polar' } : null;
                roof = this.timNocDocLap(cb, it.rawPts, it.otherMask || null, refArg);
            }
            if (!roof) roof = { valid: false, zTop: NaN, conf: 0 };

            prepared.push({
                it, fn, cx, cy, H, R, s: sCum,
                p2: it.p2, san, sanValid, sanLow, polValid, polZ, patchZ,
                ellip, guard, roof,
                zEgo: Number.isFinite(it.zEgo) ? it.zEgo : (Number.isFinite(it.p2?.zEgo) ? it.p2.zEgo : 0)
            });
        }

        const medianOf = (arr) => {
            if (!arr.length) return NaN;
            const s = [...arr].sort((a, b) => a - b);
            return this._pQuantileSorted(s, 0.50);
        };
        const madOf = (arr, med) => {
            if (!arr.length) return NaN;
            const d = arr.map(v => Math.abs(v - med)).sort((a, b) => a - b);
            return this._pQuantileSorted(d, 0.50);
        };

        // 2. Chọn Hard Calibration Anchors & Soft Anchors (chỉ đọc cz nếu frame ĐÃ DUYỆT)
        const anchors = [];
        const softObs = [];
        const approvedFrameSet = new Set();
        const kho = this._getKhoDuyet();
        const Neo = this._getNeoDuyet();
        for (const row of prepared) {
            const lbl = row.p2.nhan;
            const trRow = row.it?.track || row.it?.carBox?.track || null;
            const isApprovedFrame = Boolean(row.it?.approved === true || (kho && kho.batNeo && this._laBoxDaDuyet({ ...(row.it?.carBox || {}), track: trRow }, row.fn, opts)));
            if (isApprovedFrame && Neo) {
                const pl = Neo.matPhangDay(row.it?.carBox?.shape?.points || row.it?.carBox);
                if (pl) {
                    approvedFrameSet.add(row.fn);
                    const zB = pl.zb;
                    const hObsA = row.roof.valid ? (row.roof.zTop - zB) : row.H;
                    if (hObsA >= 0.80 * row.H && hObsA <= 1.15 * row.H) {
                        anchors.push({ ...row, p2: { ...row.p2, zc: zB }, hObs: hObsA, bac: 'DUYET', approvedZ: zB });
                    }
                    continue;
                }
            }
            const isAnchorLabel = (lbl === 'HYBRID' || lbl === 'PATCH+POLAR' || lbl === 'PATCH');
            const isClear = !!(row.ellip && !row.ellip.isFading && (
                row.ellip.isClearRoad || ((row.ellip.groundRatio ?? 0) >= 0.40 && (row.ellip.nGround ?? 0) >= 50 && (row.ellip.purity ?? 0) >= 0.70)
            ) && (row.ellip.groundRatio ?? 0) >= 0.40 && (row.ellip.nGround ?? 0) >= 25);
            const polClose = !row.polValid || Math.abs(row.patchZ - row.polZ) <= 0.06;
            const sanClose = row.sanValid && (row.p2.zc - row.sanLow) >= -0.05 && (row.p2.zc - row.sanLow) <= 0.12;
            const noJump = !row.guard || row.guard.flag !== 'TRACK_NHAY';
            const roofGood = !!(row.roof.valid && row.roof.conf >= 0.50);

            if (isAnchorLabel && !row.p2.vetoed && row.R <= P3.anchorMaxR && isClear && polClose && sanClose && noJump && roofGood) {
                const hObs = row.roof.zTop - row.p2.zc;
                if (hObs >= 0.80 * row.H && hObs <= 1.15 * row.H) {
                    anchors.push({ ...row, hObs, bac: 'AUTO' });
                }
            }
            if (row.roof.valid && row.roof.conf >= 0.45 && row.sanValid) {
                const hSoft = row.roof.zTop - row.sanLow;
                if (hSoft >= 0.85 * row.H && hSoft <= 1.08 * row.H) {
                    softObs.push(hSoft);
                }
            }
        }

        const baseH = prepared[0].H;
        let H_cal = NaN;
        let nguon = 'FB';
        if (anchors.length >= 2) {
            const hArr = anchors.map(a => a.hObs);
            const med = medianOf(hArr);
            const mad = madOf(hArr, med);
            if (Number.isFinite(med) && mad <= 0.05) {
                H_cal = Math.max(0.85 * baseH, Math.min(1.05 * baseH, med));
                nguon = 'ANCHOR';
            }
        } else if (anchors.length === 1 && anchors[0].roof.conf >= 0.85) {
            H_cal = Math.max(0.85 * baseH, Math.min(1.05 * baseH, anchors[0].hObs));
            nguon = 'ANCHOR';
        }

        if (nguon !== 'ANCHOR' && softObs.length >= 2) {
            const medS = medianOf(softObs);
            const madS = madOf(softObs, medS);
            if (Number.isFinite(medS) && madS <= 0.06) {
                H_cal = Math.max(0.85 * baseH, Math.min(1.08 * baseH, medS));
                nguon = 'SOFT';
            }
        }

        const anchorFnSet = new Set(anchors.map(a => a.fn));
        let nFixed = 0;

        // 3. Dự báo quỹ đạo Anchor hai chiều theo s
        const predictTrajectory = (row) => {
            if (anchors.length === 0) return NaN;
            // Tìm anchor bên trái (s <= row.s) và bên phải (s >= row.s)
            let left = null, right = null;
            for (const a of anchors) {
                if (a.fn <= row.fn) left = a;
                if (a.fn >= row.fn && !right) right = a;
            }
            if (left && right && left.fn !== right.fn) {
                const dsSpan = right.s - left.s;
                if (dsSpan > 1e-3) {
                    const grade = (right.p2.zc - left.p2.zc) / dsSpan;
                    if (Math.abs(grade) <= P3.gradeMax) {
                        return left.p2.zc + grade * (row.s - left.s);
                    }
                }
                const dL = Math.abs(row.fn - left.fn), dR = Math.abs(right.fn - row.fn);
                return (dL <= dR ? left : right).p2.zc;
            }
            const nearest = left || right;
            // Nếu chỉ có 1 phía và >= 2 anchor, ước lượng độ dốc từ 2 anchor gần row nhất
            let g = 0;
            if (anchors.length >= 2) {
                const sortedByFn = [...anchors].sort((a, b) => (Math.abs(a.fn - row.fn) - Math.abs(b.fn - row.fn)) || (a.fn - b.fn));
                const a1 = sortedByFn[0], a2 = sortedByFn[1];
                const dsA = a2.s - a1.s;
                if (Math.abs(dsA) > 0.5) {
                    const gCand = (a2.p2.zc - a1.p2.zc) / dsA;
                    if (Math.abs(gCand) <= P3.gradeMax) g = gCand;
                }
            }
            return nearest.p2.zc + g * (row.s - nearest.s);
        };

        // 4. Duyệt từng frame theo Anchor-to-Fade
        for (const row of prepared) {
            const p2 = row.p2;
            const lbl = p2.nhan;

            const aR = anchors.find(a => a.fn === row.fn);
            if (approvedFrameSet.has(row.fn) || (aR && aR.bac === 'DUYET')) {
                resMap.set(row.fn, p2); // Khóa nguyên trạng frame đã duyệt (bất biến chỉ-đọc)
                continue;
            }
            // Anchor cứng luôn giữ nguyên reference (an toàn tuyệt đối Gate B)
            if (anchorFnSet.has(row.fn)) {
                resMap.set(row.fn, p2);
                continue;
            }

            // Tính H hiệu dụng tại khoảng cách R của frame f
            let nearestAnchor = null;
            for (const a of anchors) {
                if (!nearestAnchor || Math.abs(a.fn - row.fn) < Math.abs(nearestAnchor.fn - row.fn)) {
                    nearestAnchor = a;
                }
            }
            const kappaFb = Math.max(P3.kMin, Math.min(P3.kMax, P3.kMax - P3.rSlope * Math.max(0, row.R - 25.0)));
            let Hf;
            if (nguon === 'ANCHOR' && nearestAnchor) {
                Hf = H_cal * Math.max(P3.kMin, 1.0 - P3.rSlope * Math.max(0, row.R - nearestAnchor.R));
            } else if (nguon === 'SOFT') {
                Hf = H_cal;
            } else {
                Hf = row.H * kappaFb;
            }

            const flags = Array.isArray(p2.flags) ? p2.flags : [];
            const closeSharpPatch = (lbl === 'PATCH' || lbl === 'HYBRID' || lbl === 'PATCH+POLAR')
                && row.R <= 22.0 && !p2.vetoed
                && (!row.guard || row.guard.flag !== 'TRACK_NHAY')
                && (!row.sanValid || (p2.zc - row.sanLow >= -0.05 && p2.zc - row.sanLow <= 0.12));

            const isFadingBad = !!(row.ellip && row.ellip.isFading) && !closeSharpPatch && !(nguon === 'FB' && lbl === 'ROOF-H');
            const isWeakLabel = (lbl === 'EGO·WARN' || lbl === 'BODY·FLOOR' || lbl === 'FAR·PLANE' || lbl === 'NEIGHBOR'
                || (lbl === 'ROOF-H' && nguon === 'ANCHOR'));
            const isJumpBad = (lbl !== 'HYBRID' && !(nguon === 'FB' && lbl === 'ROOF-H') && !!(row.guard && row.guard.flag === 'TRACK_NHAY') && (!row.polValid || Math.abs(p2.zc - row.polZ) > 0.06 || flags.includes('CONFLICT_P')))
                || (flags.includes('CONFLICT_P') && !(nguon === 'FB' && lbl === 'ROOF-H') && row.R >= 18.0 && (!row.polValid || Math.abs(row.patchZ - row.polZ) > 0.05) && (nguon === 'ANCHOR' || row.R >= 25.0));
            const isSlopeEgo = row.sanValid && (row.sanLow - row.zEgo > 0.35) && lbl === 'EGO·WARN';
            const isBottomOccluded = row.R > P3.bottomMissMinR
                && row.roof.valid && row.roof.conf >= 0.45
                && !(nguon === 'FB' && lbl === 'ROOF-H')
                && (row.roof.zTop - p2.zc) < P3.bottomMissRel * Hf
                && !(nguon === 'FB' && (lbl === 'HYBRID' || (lbl === 'PATCH+POLAR' && row.polValid && Math.abs(row.patchZ - row.polZ) <= 0.05)));

            const isBad = isFadingBad || isWeakLabel || isJumpBad || isSlopeEgo || isBottomOccluded;
            if (!isBad) {
                resMap.set(row.fn, p2); // Giữ nguyên reference -> Object.is Gate B 100%
                continue;
            }

            const dsNearest = nearestAnchor ? Math.abs(row.s - nearestAnchor.s) : Infinity;
            const zTraj = predictTrajectory(row);
            const propConf = Number.isFinite(dsNearest) ? Math.exp(-dsNearest / P3.decayS) : 0;

            let chosenZ = NaN;
            let chosenNhan = null;
            let chosenSrc = null;
            let roofLechFlag = false;

            const trajPolConsensus = Number.isFinite(zTraj)
                && row.polValid
                && !(row.ellip && row.ellip.isFading)
                && row.R < P3.bottomMissMinR
                && Math.abs(zTraj - row.polZ) <= 0.10;

            if (row.roof.valid && (nguon !== 'FB' || isWeakLabel || isBottomOccluded || isJumpBad)) {
                const zR = row.roof.zTop - Hf;
                if (row.polValid && (!row.ellip || !row.ellip.isFading) && Math.abs(zR - row.polZ) <= 0.12) {
                    chosenZ = 0.70 * zR + 0.30 * row.polZ;
                } else {
                    chosenZ = zR;
                }
                const trajOkSan = !row.sanValid || (zTraj >= row.sanLow - 0.22);
                const zRCloseSan = row.sanValid && Math.abs(chosenZ - row.sanLow) <= 0.12;
                chosenNhan = 'TRACK·ROOF';
                chosenSrc = 'phase3_track_roof';
                if (trajPolConsensus && row.roof.conf < 0.75 && Math.abs(chosenZ - zTraj) > 0.15 + 0.01 * dsNearest) {
                    // Cả Quỹ đạo Anchor lẫn Polar mặt đường đồng thuận (lệch <=10cm) & có điểm mặt đất -> nóc & sanLow bị vật cản phía trên làm phồng
                    chosenZ = 0.50 * zTraj + 0.50 * row.polZ;
                    chosenNhan = 'TRACK·PROP';
                    chosenSrc = 'phase3_track_prop';
                } else if (Number.isFinite(zTraj) && trajOkSan && !zRCloseSan && row.roof.conf < 0.75 && Math.abs(chosenZ - zTraj) > 0.15 + 0.01 * dsNearest) {
                    chosenZ = zTraj;
                    chosenNhan = 'TRACK·PROP';
                    chosenSrc = 'phase3_track_prop';
                }

                // Đối chiếu bề mặt sạch (bất biến cz): khi P2 yếu/nghiêm trọng (không có PATCH chắc), không để TRACK·ROOF vọt cao hơn mặt đất/neo sạch > roofLechTol
                const robP3 = this._getRobustSurfaceCfg();
                const isP2StrongPatch = (lbl === 'PATCH' || lbl === 'HYBRID' || lbl === 'PATCH+POLAR');
                if (robP3.enabled && chosenNhan === 'TRACK·ROOF' && (!isP2StrongPatch || flags.includes('CO_NEO_DUYET'))) {
                    const hasP2Surf = Number.isFinite(p2.zc) && p2.nhan !== 'EGO·WARN'
                        && (flags.includes('CO_NEO_DUYET') || flags.includes('NB_1_NEO') || p2.nhan === 'NEO·DUYET' || p2.nhan === 'NEIGHBOR');
                    const hasPolClean = row.polValid && (!row.ellip || !row.ellip.isFading) && Number.isFinite(row.polZ);
                    const zSurf = hasP2Surf ? p2.zc : (hasPolClean ? row.polZ : NaN);
                    const tolLech = robP3.roofLechTol ?? 0.15;
                    if (Number.isFinite(zSurf) && (chosenZ - zSurf) > tolLech) {
                        chosenZ = zSurf;
                        chosenNhan = (flags.includes('CO_NEO_DUYET') || p2.nhan === 'NEO·DUYET')
                            ? 'NEO·DUYET'
                            : ((Number.isFinite(zTraj) && Math.abs(zTraj - zSurf) <= 0.15) ? 'TRACK·PROP' : p2.nhan);
                        chosenSrc = 'phase3_roof_lech_surf';
                        roofLechFlag = true;
                    }
                }
            } else if (Number.isFinite(zTraj) && propConf >= P3.propConfMin) {
                chosenZ = zTraj;
                chosenNhan = 'TRACK·PROP';
                chosenSrc = 'phase3_track_prop';
            } else if (isSlopeEgo && row.sanValid) {
                // Xe leo dốc cao mất dấu nóc nhưng sàn thân xe sanLow rất sát zBot
                chosenZ = row.sanLow - 0.02;
                chosenNhan = 'TRACK·PROP';
                chosenSrc = 'phase3_san_slope';
            }

            if (!Number.isFinite(chosenZ)) {
                resMap.set(row.fn, p2);
                continue;
            }

            // Ràng buộc cuối cùng: mặt đường KHÔNG BAO GIỜ cắt lên trên sàn thân xe (+epsSan)
            if (row.sanValid) {
                chosenZ = Math.min(chosenZ, row.sanLow + P3.epsSan);
                if (chosenZ < row.sanLow - P3.sanMaxGapBelow && !isBottomOccluded && nguon === 'ANCHOR') {
                    // Ngờ roof sai nghiêm trọng -> fallback zTraj nếu hợp lệ, không thì giữ p2
                    if (Number.isFinite(zTraj) && propConf >= P3.propConfMin && zTraj >= row.sanLow - P3.sanMaxGapBelow) {
                        chosenZ = Math.min(zTraj, row.sanLow + P3.epsSan);
                        chosenNhan = 'TRACK·PROP';
                        chosenSrc = 'phase3_track_prop';
                    } else {
                        resMap.set(row.fn, p2);
                        continue;
                    }
                }
            }

            const newFlags = flags.filter(f => f !== 'TRACK_NHAY');
            if (nguon === 'FB' && !newFlags.includes('PHASE3_FB')) newFlags.push('PHASE3_FB');
            if (roofLechFlag && !newFlags.includes('ROOF_LECH')) newFlags.push('ROOF_LECH');
            const outRes = {
                ...p2,
                zc: chosenZ,
                zRoad: chosenZ,
                nhan: chosenNhan,
                source: chosenSrc,
                vetoed: false,
                flags: newFlags,
                phase3: {
                    H_cal: Hf,
                    H_calBase: Number.isFinite(H_cal) ? H_cal : Hf,
                    nguon,
                    conf: row.roof.valid ? row.roof.conf : propConf,
                    zTop: row.roof.valid ? row.roof.zTop : NaN,
                    anchorCount: anchors.length,
                    anchorFns: anchors.map(a => a.fn),
                    isBottomOccluded
                }
            };
            nFixed++;
            resMap.set(row.fn, outRes);
        }

        // 5. Cứu các frame ít điểm (2..12 pts) còn kẹt EGO·WARN bằng neo mềm + trần thân xe (CFG_SOFT)
        if (this.CFG_SOFT?.enabled) {
            nFixed += this._cuuFrameItDiemPhase3(prepared, resMap, approvedFrameSet, anchorFnSet);
        }

        const metaH = Number.isFinite(H_cal) ? H_cal : (prepared[0].H * Math.max(P3.kMin, Math.min(P3.kMax, P3.kMax - P3.rSlope * Math.max(0, prepared[0].R - 25.0))));
        return {
            resMap,
            meta: {
                H_cal: metaH,
                nguon,
                nAnchors: anchors.length,
                nSoft: softObs.length,
                nFixed,
                anchorFns: anchors.map(a => a.fn)
            }
        };
    }

    /**
     * Step 4: Dựng danh sách neo mềm & nội suy mặt phẳng / kẹp trần thân xe cho các frame EGO·WARN ít điểm.
     * Chỉ dùng kết quả không phải derived; trả số frame được cứu.
     */
    static _cuuFrameItDiemPhase3(prepared, resMap, approvedFrameSet, anchorFnSet) {
        const CFG = this.CFG_SOFT;
        if (!CFG || !CFG.enabled || !Array.isArray(prepared) || prepared.length === 0) return 0;

        const SOFT_LABELS = new Set(['PATCH', 'HYBRID', 'PATCH+POLAR', 'TRACK·ROOF', 'NEO·DUYET', 'DA·DUYET']);
        const rawCands = [];
        for (const row of prepared) {
            const r = resMap.get(row.fn) || row.p2;
            if (!r || r._softDerived || r.vetoed || !Number.isFinite(r.zc)) continue;
            if (!SOFT_LABELS.has(r.nhan)) continue;

            const isApprovedLike = (r.nhan === 'DA·DUYET' || r.nhan === 'NEO·DUYET');
            const nPtsSupport = Math.max(
                Number.isFinite(r.count) ? r.count : 0,
                Number.isFinite(row.san?.nPtsRaw) ? row.san.nPtsRaw : 0,
                Number.isFinite(row.roof?.nPts) ? row.roof.nPts : 0
            );
            if (!isApprovedLike && nPtsSupport < CFG.anchorMinPts) continue;

            const sigOk = isApprovedLike
                || (Number.isFinite(r.sigma) && r.sigma <= CFG.anchorMaxSigma)
                || (r.nhan === 'TRACK·ROOF' && (r.phase3?.conf ?? 0) >= 0.55);
            if (!sigOk) continue;

            const sigEff = (Number.isFinite(r.sigma) && r.sigma > 0) ? r.sigma : 0.05;
            const flagsR = Array.isArray(r.flags) ? r.flags : [];
            const pen = (flagsR.includes('OCC') || flagsR.includes('CAN_SAN')) ? 0.5 : 1.0;
            const gx = Math.max(-0.12, Math.min(0.12, Number.isFinite(r.gx) ? r.gx : 0));
            const gy = Math.max(-0.12, Math.min(0.12, Number.isFinite(r.gy) ? r.gy : 0));
            rawCands.push({
                fn: row.fn,
                cx: row.cx,
                cy: row.cy,
                zc: r.zc,
                gx,
                gy,
                sig: sigEff,
                w: pen / Math.max(1e-4, sigEff * sigEff),
                zMinBody: row.san?.zMinBody
            });
        }

        // Loại bỏ ứng viên nhảy đơn lẻ > anchorJumpMax so với cả 2 ứng viên kề
        const softAnchors = [];
        for (let i = 0; i < rawCands.length; i++) {
            const c = rawCands[i];
            const prev = i > 0 ? rawCands[i - 1] : null;
            const next = i + 1 < rawCands.length ? rawCands[i + 1] : null;
            if (prev && next && (next.fn - prev.fn) <= 4
                && Math.abs(prev.zc - next.zc) <= CFG.anchorJumpMax
                && Math.abs(c.zc - prev.zc) > CFG.anchorJumpMax
                && Math.abs(c.zc - next.zc) > CFG.anchorJumpMax) {
                continue;
            }
            softAnchors.push(c);
        }

        // Học độ lệch d_med = median(zMinBody - zSurf) từ các frame tin cậy (>= 3 mẫu)
        const dBodyObs = [];
        for (const a of softAnchors) {
            if (Number.isFinite(a.zMinBody)) {
                const d = a.zMinBody - a.zc;
                if (d >= -0.05 && d <= 0.45) dBodyObs.push(d);
            }
        }
        let dMed = NaN;
        if (dBodyObs.length >= 3) {
            dBodyObs.sort((u, v) => u - v);
            dMed = Math.max(0.0, Math.min(0.35, this._pQuantileSorted(dBodyObs, 0.50)));
        }

        const evalAt = (a, qx, qy) => a.zc + a.gx * (qx - a.cx) + a.gy * (qy - a.cy);

        let rescued = 0;
        for (const row of prepared) {
            if (approvedFrameSet.has(row.fn) || anchorFnSet.has(row.fn)) continue;
            const cur = resMap.get(row.fn) || row.p2;
            if (!cur || cur.locked || cur.nhan !== 'EGO·WARN') continue;

            const ceilInfo = this.tinhTranThanXe(row.san, CFG.ceilPad);
            const zCeil = ceilInfo.valid ? ceilInfo.zCeil : NaN;

            // Tìm neo mềm gần nhất ở bên trái và bên phải
            let left = null, right = null;
            for (const a of softAnchors) {
                if (a.fn < row.fn) left = a;
                else if (a.fn > row.fn && !right) right = a;
            }

            let zTrajSoft = NaN;
            let sigSoft = Infinity;
            let splitFlag = false;
            const dL = left ? (row.fn - left.fn) : Infinity;
            const dR = right ? (right.fn - row.fn) : Infinity;

            if (left && right && dL <= CFG.maxGapTwoSide && dR <= CFG.maxGapTwoSide) {
                const zL = evalAt(left, row.cx, row.cy);
                const zR = evalAt(right, row.cx, row.cy);
                const uL = left.w / Math.max(1, dL);
                const uR = right.w / Math.max(1, dR);
                if (Math.abs(zL - zR) > CFG.twoSideSplitMax) {
                    const pickL = uL >= uR;
                    zTrajSoft = pickL ? zL : zR;
                    sigSoft = Math.max(0.07, (pickL ? left.sig : right.sig) * 1.25);
                    splitFlag = true;
                } else {
                    zTrajSoft = (uL * zL + uR * zR) / Math.max(1e-9, uL + uR);
                    sigSoft = Math.max(0.06, Math.hypot(left.sig, right.sig) * 0.7);
                }
            } else if ((left && dL <= CFG.maxGapOneSide) || (right && dR <= CFG.maxGapOneSide)) {
                const pickL = (left && dL <= CFG.maxGapOneSide) && (!right || dR > CFG.maxGapOneSide || dL <= dR);
                const side = pickL ? left : right;
                const gap = pickL ? dL : dR;
                zTrajSoft = evalAt(side, row.cx, row.cy);
                sigSoft = Math.max(0.08, side.sig * (1.25 + 0.25 * gap));
            }

            const flags = Array.isArray(cur.flags) ? [...cur.flags] : [];
            const pushFlag = (f) => { if (!flags.includes(f)) flags.push(f); };
            const curZ = Number.isFinite(cur.zc) ? cur.zc : row.zEgo;
            const aboveCeil = Number.isFinite(zCeil) && curZ > zCeil;
            const egoDiff = Number.isFinite(zTrajSoft) ? Math.abs(curZ - zTrajSoft) : 0;

            if (Number.isFinite(zTrajSoft) && (egoDiff > Math.max(CFG.egoReplaceSigmaMul * sigSoft, CFG.egoReplaceMinDiff) || aboveCeil)) {
                let zFinal = zTrajSoft;
                let gxOut = cur.gx;
                let gyOut = cur.gy;
                if (left && dL <= CFG.maxGapTwoSide && (!right || dR > CFG.maxGapTwoSide || left.w >= right.w)) {
                    gxOut = left.gx; gyOut = left.gy;
                } else if (right && dR <= CFG.maxGapTwoSide) {
                    gxOut = right.gx; gyOut = right.gy;
                }
                if (Number.isFinite(zCeil) && zFinal > zCeil) {
                    zFinal = zCeil;
                    pushFlag('SAN_XE');
                }
                if (splitFlag) pushFlag('SOFT_SPLIT');
                resMap.set(row.fn, {
                    ...cur,
                    zc: zFinal,
                    zRoad: zFinal,
                    gx: gxOut,
                    gy: gyOut,
                    sigma: sigSoft,
                    nhan: 'TRAJ·SOFT',
                    source: 'phase3_traj_soft',
                    vetoed: false,
                    _softDerived: true,
                    flags
                });
                rescued++;
            } else if (aboveCeil) {
                const zBodyEst = (Number.isFinite(dMed) && Number.isFinite(ceilInfo.zMinBody))
                    ? (ceilInfo.zMinBody - dMed)
                    : NaN;
                const zFinal = Number.isFinite(zBodyEst) ? Math.min(zBodyEst, zCeil) : zCeil;
                pushFlag('SAN_XE');
                resMap.set(row.fn, {
                    ...cur,
                    zc: zFinal,
                    zRoad: zFinal,
                    sigma: Math.max(0.12, Number.isFinite(cur.sigma) ? cur.sigma : 0.15),
                    nhan: 'EGO·CLAMP',
                    source: 'phase3_ego_clamp',
                    vetoed: false,
                    _softDerived: true,
                    flags
                });
                rescued++;
            }
        }
        return rescued;
    }

    /**
     * Step 2 (Đợt 1): Khóa bất biến không cắt qua thân xe cho MỌI nguồn (kể cả EGO·WARN / FAR·PLANE).
     */
    static ganSanBatBienThanXe(zCand, san, opts = {}) {
        if (!this.CO.sanThanXe || !san || !san.valid || !Number.isFinite(san.zLow)) {
            return { z: zCand, clipped: false, retried: false, softWarn: false, flags: [] };
        }
        const defaultEps = opts.isConfidentLocal ? 0.14 : 0.06;
        const eps = opts.eps ?? defaultEps;
        const deltaMem = opts.deltaMem ?? 0.12;
        if (!Number.isFinite(zCand)) {
            return { z: san.zLow, clipped: true, retried: false, softWarn: false, flags: ['SAN_XE'] };
        }
        if (zCand > san.zLow + eps) {
            const flags = ['SAN_XE'];
            if (typeof opts.thuLai === 'function') {
                const retryOut = opts.thuLai(san.zLow);
                const zRetry = typeof retryOut === 'number' ? retryOut : retryOut?.z;
                if (Number.isFinite(zRetry) && zRetry <= san.zLow + eps) {
                    return {
                        z: zRetry,
                        clipped: true,
                        retried: true,
                        softWarn: false,
                        flags,
                        patchObj: (retryOut && typeof retryOut === 'object') ? retryOut : null
                    };
                }
            }
            return { z: san.zLow, clipped: true, retried: false, softWarn: false, flags };
        }
        const diff = zCand - san.zLow;
        return {
            z: zCand,
            clipped: false,
            retried: false,
            softWarn: diff > -deltaMem && diff <= eps,
            flags: []
        };
    }

    /**
     * Body-Cut Veto: Ngăn mặt đường ứng viên cắt ngang thân/bánh xe phía dưới.
     * Bất biến hoàn toàn theo cz/zBottom của cuboid.
     */
    static bodyCutVeto(carBox, rawPts, zCand, egoPlane, otherMask) {
        const P = this.PHASE1;
        const noVeto = { veto: false, zBodyLow: NaN, zMax: zCand, floating: false, reason: null };
        if (!carBox || !rawPts || rawPts.length === 0 || !Number.isFinite(zCand)) return noVeto;

        const cx = carBox.x, cy = carBox.y;
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const R = Math.hypot(cx, cy);
        const sigmaEgo = 0.15 + 0.004 * R;

        const inL = Math.max(0.10, L * 0.5 - 0.10);
        const inW = Math.max(0.10, W * 0.5 - 0.10);
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const rMax2 = (Math.hypot(inL, inW) + 0.05) ** 2;

        const zs = [];
        let aboveCount = 0;
        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            const dx = px - cx, dy = py - cy;
            if (dx * dx + dy * dy > rMax2) continue;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            if (Math.abs(u) > inL || Math.abs(v) > inW) continue;
            if (otherMask && otherMask.testXY(px, py)) continue;
            const zEgoPt = ego.z0 + ego.gx * px + ego.gy * py;
            const h = pz - zEgoPt;
            if (h >= -0.80 - sigmaEgo && h <= H + 0.50 + sigmaEgo) {
                zs.push(pz);
                if (pz >= zCand && pz <= zCand + 0.60) aboveCount++;
            }
        }

        const floating = zs.length > 0 && aboveCount === 0;
        if (zs.length < P.vetoRunMinBins * 2) {
            return { veto: false, zBodyLow: NaN, zMax: zCand, floating, reason: null };
        }

        let minZ = Infinity, maxZ = -Infinity;
        for (let i = 0; i < zs.length; i++) {
            if (zs[i] < minZ) minZ = zs[i];
            if (zs[i] > maxZ) maxZ = zs[i];
        }
        const binSize = P.vetoBin;
        const nBins = Math.max(1, Math.floor((maxZ - minZ) / binSize) + 1);
        const counts = new Int32Array(nBins);
        for (let i = 0; i < zs.length; i++) {
            const bi = Math.min(nBins - 1, Math.max(0, Math.floor((zs[i] - minZ) / binSize)));
            counts[bi]++;
        }

        const occMin = Math.max(2, Math.floor(0.03 * zs.length));
        let runStart = -1, runEnd = -1;
        let curStart = -1;
        for (let b = 0; b < nBins; b++) {
            if (counts[b] >= occMin) {
                if (curStart < 0) curStart = b;
            } else {
                if (curStart >= 0 && (b - curStart) >= P.vetoRunMinBins) {
                    runStart = curStart; runEnd = b - 1; break;
                }
                curStart = -1;
            }
        }
        if (runStart < 0 && curStart >= 0 && (nBins - curStart) >= P.vetoRunMinBins) {
            runStart = curStart; runEnd = nBins - 1;
        }
        if (runStart < 0) {
            return { veto: false, zBodyLow: NaN, zMax: zCand, floating, reason: null };
        }

        const zRunLo = minZ + runStart * binSize;
        const zRunHi = minZ + (runEnd + 1) * binSize;
        const runZs = [];
        for (let i = 0; i < zs.length; i++) {
            if (zs[i] >= zRunLo - 1e-6 && zs[i] <= zRunHi + 1e-6) runZs.push(zs[i]);
        }
        runZs.sort((a, b) => a - b);
        const zBodyLow = this._pQuantileSorted(runZs, 0.05);

        const tau = P.vetoTauBase + P.vetoTauPerM * R;
        const minPtsBelow = Math.max(5, Math.floor(0.08 * zs.length));
        let ptsBelow = 0;
        for (let i = 0; i < zs.length; i++) {
            if (zs[i] < zCand - tau) ptsBelow++;
        }

        const zMax = zBodyLow + P.vetoZMaxMargin + P.vetoZMaxPerM * R;
        const veto = Number.isFinite(zBodyLow)
            && ptsBelow >= minPtsBelow
            && (zCand - zBodyLow) >= 0.30;

        return {
            veto,
            zBodyLow,
            zMax,
            floating,
            reason: veto ? 'BODY_CUT' : null
        };
    }

    /**
     * Trộn trọng số nghịch đảo phương sai + xử lý xung đột giữa PATCH và ROOF-H.
     */
    static fuseRoadCues({ roof, patch, polar = null, dens = null, ego, R, zEgoAtCar, vetoFn, san = null, retryPatchFn = null }) {
        const P = this.PHASE1;
        const flags = [];
        let vetoed = false;

        const rCue = roof && roof.valid ? { ...roof } : { valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity, n: roof?.n || 0, cover: roof?.cover || 0, flags: roof?.flags || [] };
        const pCue = patch && patch.valid ? { ...patch } : { valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity, nPts: patch?.nPts || 0, nCells: patch?.nCells || 0, sectors: patch?.sectors || 0, rms: patch?.rms ?? Infinity, flags: patch?.flags || [] };
        const polCue = (this.CO.polar && polar && polar.valid && !polar.soft && polar.source !== 'NEO_MEM' && Number.isFinite(polar.z))
            ? { ...polar }
            : { valid: false, z: NaN, gx: 0, gy: 0, sigma: Infinity, nLeaves: 0, spanM: Infinity };

        if (rCue.flags?.length) {
            for (const f of rCue.flags) if (!flags.includes(f)) flags.push(f);
        }

        if (typeof vetoFn === 'function') {
            if (rCue.valid) {
                const vR = vetoFn(rCue.z);
                if (vR.veto && rCue.z > vR.zMax) {
                    rCue.z = vR.zMax;
                    rCue.sigma *= 1.5;
                    vetoed = true;
                    if (!flags.includes('VETO')) flags.push('VETO');
                }
            }
            if (pCue.valid) {
                const vP = vetoFn(pCue.z);
                if (vP.veto && pCue.z > vP.zMax) {
                    pCue.z = vP.zMax;
                    pCue.sigma *= 1.5;
                    vetoed = true;
                    if (!flags.includes('VETO')) flags.push('VETO');
                }
            }
            if (polCue.valid) {
                const vPol = vetoFn(polCue.z);
                if (vPol.veto && polCue.z > vPol.zMax) {
                    polCue.z = vPol.zMax;
                    polCue.sigma *= 1.5;
                    vetoed = true;
                    if (!flags.includes('VETO')) flags.push('VETO');
                }
            }
        }

        let zc = zEgoAtCar;
        let gx = ego.gx;
        let gy = ego.gy;
        let sigma = 0.15 + 0.004 * R;
        let nhan = 'EGO·WARN';
        let count = 0;

        // Đợt 2 Tầng A: Xe rõ nét (PATCH dày hoặc POLAR chắc chắn + nền elip không bị khuất/vỉa hè)
        const pCrisp = pCue.valid && pCue.nCells >= 8 && pCue.sectors >= 4 && (pCue.rms ?? 0) <= 0.045;
        const polCrisp = polCue.valid && polCue.sigma <= 0.06 && (polCue.spanM ?? Infinity) <= 12.0 && (polCue.nLeaves ?? 0) >= 3;
        const densClean = !dens || !dens.valid || (dens.areaOpen >= 6.0 && dens.groundRatio >= 0.30 && dens.purity >= 0.70 && dens.nGround >= 15);
        const isTierAClear = this.CO.polar && (pCrisp || polCrisp) && densClean;

        if (isTierAClear) {
            // Giảm ảnh hưởng hằng số delta0 của ROOF-H (sigma_R,eff = 0.12 -> giảm ~9x trọng số), vẫn giữ kiểm tra chéo
            const rEffSigma = 0.12;
            const wr = (rCue.valid && (!pCue.valid || Math.abs(rCue.z - pCue.z) <= 0.12)) ? (1.0 / (rEffSigma * rEffSigma)) : 0;
            if (pCue.valid && polCue.valid) {
                const matchPP = Math.max(0.08, 2.5 * Math.hypot(pCue.sigma, polCue.sigma));
                if (Math.abs(pCue.z - polCue.z) <= matchPP) {
                    const wp = 1.0 / Math.max(1e-6, pCue.sigma * pCue.sigma);
                    const wPol = 1.0 / Math.max(1e-6, polCue.sigma * polCue.sigma);
                    const wTot = wp + wPol + wr;
                    zc = (wp * pCue.z + wPol * polCue.z + wr * (rCue.valid ? rCue.z : 0)) / wTot;
                    if (pCrisp || pCue.sigma <= polCue.sigma) {
                        gx = pCue.gx; gy = pCue.gy;
                    } else {
                        gx = polCue.gx; gy = polCue.gy;
                    }
                    const sigCorr = Math.sqrt(1.0 / Math.max(1e-6, wp + wPol)) * 1.4;
                    sigma = Math.max(sigCorr, 0.8 * Math.min(pCue.sigma, polCue.sigma));
                    nhan = 'PATCH+POLAR';
                    count = pCue.nPts + (polCue.nLeaves || 0);
                } else if (pCrisp) {
                    zc = pCue.z; gx = pCue.gx; gy = pCue.gy; sigma = pCue.sigma;
                    nhan = 'PATCH'; count = pCue.nPts;
                } else {
                    zc = polCue.z; gx = polCue.gx; gy = polCue.gy; sigma = polCue.sigma;
                    nhan = 'POLAR'; count = polCue.nLeaves || 1;
                }
            } else if (pCue.valid) {
                const wp = 1.0 / Math.max(1e-6, pCue.sigma * pCue.sigma);
                zc = (wp * pCue.z + wr * (rCue.valid ? rCue.z : 0)) / (wp + wr);
                gx = pCue.gx; gy = pCue.gy;
                sigma = pCue.sigma;
                nhan = 'PATCH'; count = pCue.nPts;
            } else {
                const wPol = 1.0 / Math.max(1e-6, polCue.sigma * polCue.sigma);
                zc = (wPol * polCue.z + wr * (rCue.valid ? rCue.z : 0)) / (wPol + wr);
                gx = polCue.gx; gy = polCue.gy;
                sigma = polCue.sigma;
                nhan = 'POLAR'; count = polCue.nLeaves || 1;
            }
            if (rCue.valid && Math.abs(zc - rCue.z) > 0.12 && !flags.includes('ROOF_DISAGREE')) {
                flags.push('ROOF_DISAGREE');
            }
        } else if (pCue.valid && rCue.valid) {
            const matchThr = Math.max(P.fuseMatchBase, P.fuseMatchSigmaMul * Math.hypot(pCue.sigma, rCue.sigma));
            const canPol3 = this.CO.polar && polCue.valid && polCue.sigma <= 0.07 && (polCue.spanM ?? Infinity) <= 12.0;
            if (Math.abs(pCue.z - rCue.z) <= matchThr) {
                const wp = 1.0 / (pCue.sigma * pCue.sigma);
                const wr = 1.0 / (rCue.sigma * rCue.sigma);
                const usePol = canPol3 && Math.abs(polCue.z - rCue.z) <= matchThr;
                const wPol = usePol ? (0.5 / Math.max(1e-6, polCue.sigma * polCue.sigma)) : 0;
                zc = (wp * pCue.z + wr * rCue.z + wPol * (usePol ? polCue.z : 0)) / (wp + wr + wPol);
                gx = pCue.gx;
                gy = pCue.gy;
                sigma = 1.0 / Math.sqrt(wp + wr + wPol);
                nhan = 'HYBRID';
                count = pCue.nPts + rCue.n;
            } else if (pCue.nCells >= 8 && pCue.sectors >= 4) {
                zc = pCue.z; gx = pCue.gx; gy = pCue.gy; sigma = pCue.sigma;
                nhan = 'PATCH'; count = pCue.nPts;
                flags.push('CONFLICT_P');
            } else if (rCue.n >= 40 && rCue.cover >= 6) {
                zc = rCue.z; gx = rCue.gx; gy = rCue.gy; sigma = rCue.sigma;
                nhan = 'ROOF-H'; count = rCue.n;
                flags.push('CONFLICT_R');
            } else if (canPol3) {
                zc = polCue.z; gx = polCue.gx; gy = polCue.gy; sigma = polCue.sigma;
                nhan = 'POLAR'; count = polCue.nLeaves || 1;
                flags.push('XUNG_DOT');
            } else {
                zc = zEgoAtCar; gx = ego.gx; gy = ego.gy;
                nhan = 'EGO·WARN'; count = 0;
                flags.push('XUNG_DOT');
            }
        } else if (pCue.valid) {
            zc = pCue.z; gx = pCue.gx; gy = pCue.gy; sigma = pCue.sigma;
            nhan = 'PATCH'; count = pCue.nPts;
        } else if (rCue.valid) {
            const polStrong = this.CO.polar && polCue.valid && polCue.sigma <= 0.04 && (polCue.spanM ?? Infinity) <= 6.0;
            const polMod = this.CO.polar && polCue.valid && polCue.sigma <= 0.07 && (polCue.spanM ?? Infinity) <= 12.0;
            const matchPR = Math.max(P.fuseMatchBase, P.fuseMatchSigmaMul * Math.hypot(polCue.sigma, rCue.sigma));
            if (polStrong && Math.abs(polCue.z - rCue.z) > matchPR) {
                zc = polCue.z; gx = polCue.gx; gy = polCue.gy; sigma = polCue.sigma;
                nhan = 'POLAR'; count = polCue.nLeaves || 1;
            } else if (polMod && Math.abs(polCue.z - rCue.z) <= matchPR) {
                const wr = 1.0 / (rCue.sigma * rCue.sigma);
                const wPol = 1.0 / (polCue.sigma * polCue.sigma);
                zc = (wr * rCue.z + wPol * polCue.z) / (wr + wPol);
                gx = polCue.gx; gy = polCue.gy;
                sigma = 1.0 / Math.sqrt(wr + wPol);
                nhan = 'ROOF-H'; count = rCue.n;
            } else {
                zc = rCue.z; gx = rCue.gx; gy = rCue.gy; sigma = rCue.sigma;
                nhan = 'ROOF-H'; count = rCue.n;
            }
        } else if (this.CO.polar && polCue.valid && polCue.sigma <= 0.08 && (polCue.spanM ?? Infinity) <= 12.0) {
            zc = polCue.z; gx = polCue.gx; gy = polCue.gy; sigma = polCue.sigma;
            nhan = 'POLAR'; count = polCue.nLeaves || 1;
        } else {
            zc = zEgoAtCar; gx = ego.gx; gy = ego.gy;
            nhan = 'EGO·WARN'; count = 0;
            if (pCue.flags?.length) {
                for (const f of pCue.flags) if (!flags.includes(f)) flags.push(f);
            }
        }

        const allowDownFromEgo = this.CO.tamLaiCuaSo && san && san.valid
            && zEgoAtCar > san.zLow + 0.03 && zc <= san.zLow + 0.03;
        if (!allowDownFromEgo && Math.abs(zc - zEgoAtCar) > P.egoOutlierBase + P.egoOutlierPerM * R) {
            zc = zEgoAtCar;
            gx = ego.gx;
            gy = ego.gy;
            sigma = 0.15 + 0.004 * R;
            nhan = 'EGO·WARN';
            if (!flags.includes('LECH_EGO')) flags.push('LECH_EGO');
        }

        const isConfidentLocal = !vetoed && (nhan === 'PATCH' || nhan === 'PATCH+POLAR' || nhan === 'POLAR' || nhan === 'HYBRID' || nhan === 'ROOF-H') && sigma < 0.10;
        const sanClamp = this.ganSanBatBienThanXe(zc, san, {
            isConfidentLocal,
            deltaMem: 0.12,
            thuLai: retryPatchFn
        });
        if (sanClamp.clipped) {
            if (sanClamp.retried && sanClamp.patchObj) {
                zc = sanClamp.patchObj.z;
                gx = sanClamp.patchObj.gx;
                gy = sanClamp.patchObj.gy;
                sigma = sanClamp.patchObj.sigma;
                count = sanClamp.patchObj.nPts;
                nhan = 'PATCH';
                if (!flags.includes('TAM_LAI')) flags.push('TAM_LAI');
            } else {
                zc = sanClamp.z;
                sigma = Math.max(sigma, 0.15 + 0.004 * R);
                nhan = 'BODY·FLOOR';
            }
            if (!flags.includes('SAN_XE')) flags.push('SAN_XE');
        } else if (sanClamp.softWarn) {
            if (!flags.includes('CAN_SAN')) flags.push('CAN_SAN');
        }

        const sourceMap = {
            'PATCH': 'phase1_patch',
            'PATCH+POLAR': 'phase2_patch_polar',
            'POLAR': 'phase2_polar',
            'ROOF-H': 'phase1_roof_h',
            'HYBRID': 'phase1_hybrid',
            'BODY·FLOOR': 'body_floor',
            'EGO·WARN': 'ego_warn'
        };

        return {
            zc,
            gx,
            gy,
            sigma,
            nhan,
            source: sourceMap[nhan] || 'ego_warn',
            count,
            flags,
            vetoed,
            zRoof: rCue.valid ? rCue.z : NaN,
            zPatch: pCue.valid ? pCue.z : NaN,
            zPolar: polCue.valid ? polCue.z : NaN,
            zEgo: zEgoAtCar
        };
    }

    /**
     * 2-Tier Per-Frame Local Ground (Phase 1 Hybrid + Đợt 2 Polar + Phase 2 cue export):
     * Tích hợp Mặt đường quanh/dưới gầm (PATCH) + Hạ từ nóc xe (ROOF-H) + Body-Cut Veto + Other-Box Mask.
     */
    static _taoGatePolar(polarCue, egoP, P1, sigG, usePolarSlope, cfgRob, san = null) {
        const useRob = Boolean(cfgRob && cfgRob.enabled);
        const canFollowPolar = usePolarSlope && (!useRob || polarCue?.robust || polarCue?.source === 'RING_IDW');
        let sx = canFollowPolar ? polarCue.gx : egoP.gx;
        let sy = canFollowPolar ? polarCue.gy : egoP.gy;
        if (useRob && canFollowPolar) {
            const capMax = Math.max(cfgRob.slopeCap?.lat ?? 0.035, cfgRob.slopeCap?.long ?? 0.08);
            const gNorm = Math.hypot(sx, sy);
            if (gNorm > capMax && gNorm > 1e-9) {
                const sc = capMax / gNorm;
                sx *= sc;
                sy *= sc;
            }
        }
        return {
            zCenter: polarCue.z,
            slopeCenter: [sx, sy],
            maxSlopeDev: canFollowPolar ? Math.max(0.004, Math.min(0.0175, 3.0 * sigG)) : P1.maxSlopeDevEgo,
            halfBand: Math.max(0.06, Math.min(0.15, 2.5 * polarCue.sigma + 0.04)),
            san,
            robustSurface: cfgRob,
            _active: canFollowPolar
        };
    }

    static tinhMatDuongCucBoXe(carBox, rawPts, egoPlane, frameBoxes = null, zPriorGrid = null, phase2Ctx = null) {
        if (!carBox) return null;
        const cx = carBox.x, cy = carBox.y;
        const cz = Number.isFinite(carBox.z) ? carBox.z : 0;
        const H = carBox.H || 1.6;
        const zBottom = cz - H / 2.0;
        const R = Math.hypot(cx, cy);

        const egoP = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const zEgoAtCar = egoP.z0 + egoP.gx * cx + egoP.gy * cy;

        if (!rawPts || rawPts.length === 0) {
            return {
                zc: zEgoAtCar, gx: egoP.gx, gy: egoP.gy,
                deltaBottom: zBottom - zEgoAtCar,
                source: 'ego_fallback', nhan: 'EGO·WARN',
                count: 0, sigma: 0.15 + 0.004 * R, flags: ['KHONG_DIEM'],
                zRoof: NaN, zPatch: NaN, zPolar: NaN, zEgo: zEgoAtCar, vetoed: false,
                cues: { roof: { valid: false, flags: ['KHONG_DIEM'] }, patch: { valid: false, flags: ['KHONG_DIEM'] }, polar: null, ego: egoP }
            };
        }

        const otherMask = phase2Ctx?.otherMask || this.buildOtherBoxMask(frameBoxes, carBox);
        let localPts = phase2Ctx?.localPts;
        if (!localPts) {
            // Lọc 1 lượt theo bán kính cục bộ để rút ngắn vòng quét từ ~60k điểm xuống ~300 điểm/xe
            const L = carBox.L || 4.5, W = carBox.W || 1.9;
            const margin = Math.min(2.8, 1.8 + 0.01 * R);
            const ellipPad = this.CO.polar ? (2.5 + Math.min(2.5, 0.03 * Math.max(0, R - 20.0))) : margin;
            const rLocalMax = Math.hypot(L * 0.5 + Math.max(margin, ellipPad), W * 0.5 + Math.max(margin, ellipPad)) + 0.30;
            const rLocalMax2 = rLocalMax * rLocalMax;
            localPts = [];
            for (let i = 0; i < rawPts.length; i++) {
                const p = rawPts[i];
                const dx = p[0] - cx, dy = p[1] - cy;
                if (dx * dx + dy * dy <= rLocalMax2) localPts.push(p);
            }
        }

        const P1 = this.PHASE1;
        const robCfg = this._getRobustSurfaceCfg(phase2Ctx?.robustSurface);
        const wantDbg = Boolean(phase2Ctx?.debug);
        const mat = phase2Ctx?.mat || null;
        let polarCue = null;
        let dens = null;
        if (this.CO.polar && mat && mat.sanSang) {
            polarCue = mat.truyVanChoXe(carBox, {
                otherMask,
                ego: egoP,
                debug: wantDbg,
                robustSurface: phase2Ctx?.robustSurface,
                excludeKey: phase2Ctx?.excludeKey,
                excludeTrackId: phase2Ctx?.excludeTrackId ?? carBox.trackId ?? carBox.track?.id
            });
            const refEllip = polarCue.valid
                ? { z: polarCue.z, gx: polarCue.gx, gy: polarCue.gy }
                : { z: zEgoAtCar, gx: egoP.gx, gy: egoP.gy };
            dens = mat.tinhMatDoDatEllip(carBox, localPts, otherMask, refEllip);
        }

        const san = phase2Ctx?.san || (this.CO.sanThanXe || this.CO.tamLaiCuaSo ? this.tinhSanThanXe(carBox, localPts, egoP, otherMask) : { valid: false, zLow: NaN, zHigh: NaN, nPts: 0 });
        const roof = this.estimateRoofCue(carBox, localPts, egoP, otherMask);

        const usePolarPrior = this.CO.polar && polarCue && polarCue.valid
            && polarCue.sigma <= 0.08 && (polarCue.spanM ?? Infinity) <= 12.0;
        let patch;
        let dbgGate = null;
        if (usePolarPrior && !Number.isFinite(zPriorGrid)) {
            const halfL = (carBox.L || 4.5) * 0.5;
            const sigG = polarCue.sigma / (2.0 * (halfL + 0.5));
            const usePolarSlope = polarCue.source !== 'RING_IDW' && !polarCue.isSelfMasked;
            const gatePolar = this._taoGatePolar(polarCue, egoP, P1, sigG, usePolarSlope, robCfg, san);
            gatePolar.mat = mat;
            if (wantDbg) {
                dbgGate = { active: Boolean(gatePolar._active), source: polarCue.source, maxSlopeDev: gatePolar.maxSlopeDev };
            }
            const pPol = this.estimatePatchCue(carBox, localPts, egoP, otherMask, polarCue.z, gatePolar);
            if (pPol.valid && pPol.nCells >= 8) {
                patch = pPol;
            } else {
                const pStd = this.estimatePatchCue(carBox, localPts, egoP, otherMask, roof.valid ? roof.z : null, { san, mat, robustSurface: phase2Ctx?.robustSurface });
                patch = (pPol.valid && (!pStd.valid || pPol.nCells >= pStd.nCells)) ? pPol : pStd;
            }
        } else {
            const zPrior = Number.isFinite(zPriorGrid) ? zPriorGrid : (roof.valid ? roof.z : null);
            patch = this.estimatePatchCue(carBox, localPts, egoP, otherMask, zPrior, { san, mat, robustSurface: phase2Ctx?.robustSurface });
        }

        const vetoFn = (zCand) => this.bodyCutVeto(carBox, localPts, zCand, egoP, otherMask);
        const retryPatchFn = (zSan) => {
            const p = this.estimatePatchCue(carBox, localPts, egoP, otherMask, zSan - 0.10, {
                zCenter: zSan - 0.10,
                halfBand: 0.50,
                maxSlopeDev: P1.maxSlopeDevEgo * 1.5,
                san,
                mat,
                robustSurface: phase2Ctx?.robustSurface
            });
            return p && p.valid ? p : NaN;
        };

        const fused = this.fuseRoadCues({ roof, patch, polar: polarCue, dens, ego: egoP, R, zEgoAtCar, vetoFn, san, retryPatchFn });
        const resOut = {
            ...fused,
            deltaBottom: zBottom - fused.zc,
            cues: { roof, patch, polar: polarCue, dens, ego: egoP },
            _san: san,
            _localPts: phase2Ctx?.keepLocal ? localPts : undefined,
            _otherMask: phase2Ctx?.keepLocal ? otherMask : undefined
        };
        if (wantDbg) {
            resOut.dbg = {
                polar: polarCue?.dbg || null,
                gate: dbgGate,
                patchSlope: patch && patch.valid ? [patch.gx, patch.gy] : null
            };
        }
        return resOut;
    }

    // =========================================================================
    // PHASE 2: INTER-VEHICLE ANCHOR + FAR-FIELD REFIT + TRACK GUARD (DAG 1 CHIỀU)
    // Tuyệt đối không đọc cz / zBottom của chính box lẫn xe hàng xóm.
    // =========================================================================

    static _quant(v, step, def = 0) {
        const val = Number.isFinite(v) ? v : def;
        return (Math.round(val / step) * step).toFixed(2);
    }

    static _canonicalizeBox(b, idx = 0) {
        const pts = b?.shape?.points;
        const cx = Number.isFinite(b?.cx) ? b.cx : (Number.isFinite(b?.x) ? b.x : (pts ? pts[0] : 0));
        const cy = Number.isFinite(b?.cy) ? b.cy : (Number.isFinite(b?.y) ? b.y : (pts ? pts[1] : 0));
        const rawCz = Number.isFinite(b?.cz) ? b.cz : (Number.isFinite(b?.z) ? b.z : (pts ? pts[2] : 0));
        const rxRaw = Number.isFinite(b?.rx) ? b.rx : (pts && Number.isFinite(pts[3]) ? pts[3] : 0);
        const ryRaw = Number.isFinite(b?.ry) ? b.ry : (pts && Number.isFinite(pts[4]) ? pts[4] : 0);
        const rx = Number.isFinite(rxRaw) ? rxRaw : 0;
        const ry = Number.isFinite(ryRaw) ? ryRaw : 0;
        const rz = Number.isFinite(b?.rz) ? b.rz : (pts && Number.isFinite(pts[5]) ? pts[5] : 0);
        const L = b?.L || (pts && Number.isFinite(pts[6]) ? pts[6] : 4.5) || 4.5;
        const W = b?.W || (pts && Number.isFinite(pts[7]) ? pts[7] : 1.9) || 1.9;
        const H = b?.H || (pts && Number.isFinite(pts[8]) ? pts[8] : 1.6) || 1.6;
        const rawTid = b?.track?.id ?? b?.trackId ?? '';
        const trackId = rawTid !== '' && rawTid !== undefined && rawTid !== null ? String(rawTid) : '';
        return {
            cx, cy, rx, ry, rz, L, W, H,
            trackId,
            origIdx: idx,
            track: b?.track || null,
            shape: b?.shape || null,
            rawCz
        };
    }

    static boxKey(b) {
        const c = (b && Number.isFinite(b.cx) && Number.isFinite(b.L) && 'trackId' in b) ? b : this._quantizeTemp(b);
        return `${this._quant(c.cx, 0.02)}|${this._quant(c.cy, 0.02)}|${this._quant(c.L, 0.05)}|${this._quant(c.W, 0.05)}|${this._quant(c.H, 0.05)}|${this._quant(c.rz, 0.01)}`;
    }

    static _quantizeTemp(b) {
        return this._canonicalizeBox(b, 0);
    }

    static _fnv1aHash(str) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619) >>> 0;
        }
        return h.toString(36);
    }

    static _computeNeighborSig(canonBox, allCanon) {
        const P = this.PHASE1;
        const diagT = Math.hypot(canonBox.L, canonBox.W);
        const parts = [];
        for (let i = 0; i < allCanon.length; i++) {
            const o = allCanon[i];
            if (o === canonBox) continue;
            const d = Math.hypot(o.cx - canonBox.cx, o.cy - canonBox.cy);
            if (d < 0.05) continue;
            const diagO = Math.hypot(o.L, o.W);
            if (d > 0.5 * (diagO + diagT) + P.otherBoxCullExtra) continue;
            parts.push(`${this._quant(o.cx, 0.05)},${this._quant(o.cy, 0.05)},${this._quant(o.L, 0.05)},${this._quant(o.W, 0.05)},${this._quant(o.rz, 0.02)}`);
        }
        parts.sort();
        return this._fnv1aHash(parts.join(';'));
    }

    static _isOutsideConvexHull2D(pts, qx, qy) {
        if (!pts || pts.length < 3) {
            if (!pts || pts.length < 2) return true;
            const a = pts[0], b = pts[1];
            const vx = b.x - a.x, vy = b.y - a.y;
            const len2 = vx * vx + vy * vy;
            if (len2 < 1e-6) return true;
            const t = ((qx - a.x) * vx + (qy - a.y) * vy) / len2;
            const perp = Math.abs((qx - a.x) * vy - (qy - a.y) * vx) / Math.sqrt(len2);
            return t < -0.05 || t > 1.05 || perp > 1.5;
        }
        const sorted = [...pts].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
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
        lower.pop(); upper.pop();
        const hull = lower.concat(upper);
        if (hull.length < 3) return true;
        const qp = { x: qx, y: qy };
        for (let i = 0; i < hull.length; i++) {
            const a = hull[i], b = hull[(i + 1) % hull.length];
            if (cross(a, b, qp) < -1e-4) return true;
        }
        return false;
    }

    /**
     * Step 2: Tạo danh sách neo tin cậy chỉ từ kết quả Pass 1 (không đọc cz/zBottom).
     */
    static buildAnchorSet(items, egoPlane, opts = {}) {
        const P2 = this.PHASE2;
        if (!Array.isArray(items) || items.length === 0) return [];
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const sigmaMax = opts.anchorSigmaMax ?? P2.anchorSigmaMax;
        const rejectFlags = new Set(['PATCH_REJECT', 'THIEU_DIEM', 'LECH_GOC', 'VETO', 'LECH_EGO']);
        const rawAnchors = [];

        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const p1 = it?.p1;
            const bx = it?.box;
            if (!p1 || !bx || !Number.isFinite(p1.zc) || !Number.isFinite(p1.sigma)) continue;
            if (p1.vetoed) continue;
            const src = p1.nhan;
            if (src !== 'HYBRID' && src !== 'PATCH' && src !== 'PATCH+POLAR' && src !== 'POLAR' && src !== 'ROOF-H') continue;
            if (p1.sigma > sigmaMax) continue;
            const fList = Array.isArray(p1.flags) ? p1.flags : [];
            if (fList.some(f => rejectFlags.has(f))) continue;

            const x = Number.isFinite(bx.cx) ? bx.cx : bx.x;
            const y = Number.isFinite(bx.cy) ? bx.cy : bx.y;
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;

            const zEgo = ego.z0 + ego.gx * x + ego.gy * y;
            const delta = p1.zc - zEgo;
            const sigmaBase = (src === 'PATCH+POLAR' || src === 'POLAR') ? p1.sigma * 1.4 : p1.sigma;
            const sigmaEff = Math.max(sigmaBase, P2.anchorSigmaFloor);
            let tier = P2.anchorTier[src] ?? (src === 'PATCH+POLAR' ? 1.0 : (src === 'POLAR' ? 0.85 : 0.6));
            for (const f of fList) {
                if (P2.anchorFlagMul[f] !== undefined) tier *= P2.anchorFlagMul[f];
            }

            rawAnchors.push({
                id: it.id,
                x, y,
                R: Math.hypot(x, y),
                zc: p1.zc,
                delta,
                sigmaEff,
                tier,
                approved: false,
                src,
                flags: fList
            });
        }

        // Bổ sung các ID/Box đã duyệt làm neo cứng (sigma=0.02, tier=3.0)
        const neoList = Array.isArray(opts.neoDuyet) ? opts.neoDuyet : [];
        for (let i = 0; i < neoList.length; i++) {
            const k = neoList[i];
            if (!k || k.kind === 'ego' || !Number.isFinite(k.cx) || !Number.isFinite(k.cy) || !Number.isFinite(k.zb)) continue;
            const zEgo = ego.z0 + ego.gx * k.cx + ego.gy * k.cy;
            rawAnchors.push({
                id: k._boxKey || `__NEO__${k.trackId}_${k.frame}`,
                x: k.cx,
                y: k.cy,
                R: Math.hypot(k.cx, k.cy),
                zc: k.zb,
                delta: k.zb - zEgo,
                sigmaEff: k.sigmaZ || 0.02,
                tier: 3.0,
                approved: true,
                src: 'DA·DUYET',
                flags: ['DA_DUYET']
            });
        }

        // Sắp xếp xác định theo id trước khi khử trùng (ưu tiên neo đã duyệt thắng khi cùng vị trí)
        rawAnchors.sort((a, b) => (a.approved !== b.approved ? (a.approved ? -1 : 1) : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));

        // Khử hai neo trùng tâm (< 0.3m): giữ neo có sigmaEff nhỏ hơn (hoặc approved)
        const kept = [];
        for (const a of rawAnchors) {
            let dupIdx = -1;
            for (let j = 0; j < kept.length; j++) {
                if (Math.hypot(a.x - kept[j].x, a.y - kept[j].y) < 0.30) {
                    dupIdx = j;
                    break;
                }
            }
            if (dupIdx < 0) {
                kept.push(a);
            } else if ((a.approved && !kept[dupIdx].approved) || (a.approved === kept[dupIdx].approved && a.sigmaEff < kept[dupIdx].sigmaEff)) {
                kept[dupIdx] = a;
            }
        }
        kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return kept;
    }

    /**
     * Step 3: Hồi quy trường dư delta(x, y) = delta0 + gdx*dx + gdy*dy tại điểm truy vấn (qx, qy)
     * với leave-one-out (LOO), Ridge chỉ co dốc về 0, Tukey IRLS và kiểm tra thẳng hàng.
     */
    static fitResidualField(anchors, qx, qy, selfId, kernel, radius, opts = {}) {
        const P2 = this.PHASE2;
        const fail = (extraFlags = []) => ({
            valid: false, delta0: 0, gdx: 0, gdy: 0,
            sigmaFit: Infinity, rms: Infinity, nUsed: 0, dMin: Infinity,
            W: 0, ids: [], flags: extraFlags, outsideHull: true
        });
        if (!Array.isArray(anchors) || anchors.length === 0 || !Number.isFinite(qx) || !Number.isFinite(qy)) {
            return fail();
        }

        const cands = [];
        const inv2K2 = 1.0 / Math.max(1e-6, 2.0 * kernel * kernel);
        for (let i = 0; i < anchors.length; i++) {
            const a = anchors[i];
            if (selfId !== null && selfId !== undefined && a.id === selfId) continue;
            const dx = a.x - qx, dy = a.y - qy;
            const d = Math.hypot(dx, dy);
            if (d > radius) continue;
            const appMul = a.approved ? 5.0 : 1.0;
            const wBase = (a.tier * appMul * Math.exp(-(d * d) * inv2K2)) / (a.sigmaEff * a.sigmaEff);
            if (!Number.isFinite(wBase) || wBase <= 0) continue;
            cands.push({ a, dx, dy, d, delta: a.delta, wBase, w: wBase });
        }

        if (cands.length === 0) return fail();
        cands.sort((u, v) => (u.a.id < v.a.id ? -1 : u.a.id > v.a.id ? 1 : 0));

        // Nhánh 1 neo duy nhất (neo đã duyệt được mở tầm tâm-tới-tâm lên approvedSingleMaxD = 12m)
        if (cands.length === 1) {
            const c = cands[0];
            const singleMax = c.a.approved
                ? (opts.approvedSingleMaxD ?? P2.approvedSingleMaxD ?? 12.0)
                : (opts.singleAnchorMaxD ?? P2.singleAnchorMaxD);
            if (c.d > singleMax) return fail();
            const sig = Math.max(c.a.sigmaEff, P2.singleSigmaFloor);
            return {
                valid: true,
                delta0: c.delta,
                gdx: 0,
                gdy: 0,
                sigmaFit: sig,
                rms: 0,
                nUsed: 1,
                dMin: c.d,
                W: c.wBase,
                ids: [c.a.id],
                flags: ['NB_1_NEO', 'NB_NGOAI_SUY'],
                outsideHull: true
            };
        }

        const solveWeightedRidge = (arr) => {
            let sumW = 0;
            for (const c of arr) sumW += c.w;
            if (sumW <= 1e-12) return null;
            const lambda = P2.ridgeRho * sumW * P2.ridgeRef * P2.ridgeRef;

            let a00 = 0, a01 = 0, a02 = 0, a11 = lambda, a12 = 0, a22 = lambda;
            let b0 = 0, b1 = 0, b2 = 0;
            for (const c of arr) {
                const w = c.w;
                if (w <= 0) continue;
                a00 += w;
                a01 += w * c.dx;
                a02 += w * c.dy;
                a11 += w * c.dx * c.dx;
                a12 += w * c.dx * c.dy;
                a22 += w * c.dy * c.dy;
                b0 += w * c.delta;
                b1 += w * c.dx * c.delta;
                b2 += w * c.dy * c.delta;
            }
            const det = a00 * (a11 * a22 - a12 * a12)
                      - a01 * (a01 * a22 - a12 * a02)
                      + a02 * (a01 * a12 - a11 * a02);
            if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
                return { delta0: b0 / sumW, gdx: 0, gdy: 0, invA00: 1.0 / sumW, sumW, fellBack: true };
            }
            const sol = this._solve3x3(
                [[a00, a01, a02], [a01, a11, a12], [a02, a12, a22]],
                [b0, b1, b2]
            );
            if (!sol) {
                return { delta0: b0 / sumW, gdx: 0, gdy: 0, invA00: 1.0 / sumW, sumW, fellBack: true };
            }
            const invA00 = Math.max(0, (a11 * a22 - a12 * a12) / det);
            return { delta0: sol[0], gdx: sol[1], gdy: sol[2], invA00, sumW, fellBack: false };
        };

        let active = cands;
        let sol = solveWeightedRidge(active);
        if (!sol) return fail();

        const flags = [];
        const irlsIters = opts.irlsIters ?? P2.irlsIters;
        for (let iter = 0; iter < irlsIters; iter++) {
            const absRes = new Float64Array(active.length);
            const res = new Float64Array(active.length);
            for (let i = 0; i < active.length; i++) {
                const c = active[i];
                const r = c.delta - (sol.delta0 + sol.gdx * c.dx + sol.gdy * c.dy);
                res[i] = r;
                absRes[i] = Math.abs(r);
            }
            const sortedRes = new Float64Array(res).sort();
            const medRes = this._pQuantileSorted(sortedRes, 0.50);
            const devAbs = new Float64Array(active.length);
            for (let i = 0; i < active.length; i++) devAbs[i] = Math.abs(res[i] - medRes);
            devAbs.sort();
            const mad = 1.4826 * this._pQuantileSorted(devAbs, 0.50);
            const scale = Math.max(P2.madFloor, mad);
            const cut = P2.tukeyC * scale;

            const survivors = [];
            for (let i = 0; i < active.length; i++) {
                if ((opts.exemptApproved && active[i].a.approved) || Math.abs(res[i] - medRes) <= cut) {
                    survivors.push(active[i]);
                }
            }
            if (survivors.length < 2) break; // giữ tập trước IRLS nếu cắt dưới 2 neo
            if (survivors.length === active.length) break;
            const nextSol = solveWeightedRidge(survivors);
            if (!nextSol) break;
            active = survivors;
            sol = nextSol;
        }

        // Kiểm tra thẳng hàng theo độ lệch chuẩn trục phụ (principal minor axis)
        let nUsed = active.length;
        let mx = 0, my = 0;
        for (const c of active) { mx += c.dx; my += c.dy; }
        mx /= nUsed; my /= nUsed;
        let cxx = 0, cyy = 0, cxy = 0;
        for (const c of active) {
            const ex = c.dx - mx, ey = c.dy - my;
            cxx += ex * ex; cyy += ey * ey; cxy += ex * ey;
        }
        cxx /= nUsed; cyy /= nUsed; cxy /= nUsed;
        const lambdaMin = 0.5 * ((cxx + cyy) - Math.hypot(cxx - cyy, 2 * cxy));
        const minorStd = Math.sqrt(Math.max(0, lambdaMin));

        let delta0 = sol.delta0;
        let gdx = sol.gdx;
        let gdy = sol.gdy;
        let invA00 = sol.invA00;

        if (!opts.skipCollinearCheck && minorStd < (opts.farMinorStd ?? P2.farMinorStd)) {
            gdx = 0; gdy = 0;
            flags.push('NB_THANG_HANG');
            let sumWD = 0, sumW = 0;
            for (const c of active) { sumWD += c.w * c.delta; sumW += c.w; }
            delta0 = sumWD / sumW;
            invA00 = 1.0 / sumW;
        } else {
            const gNorm = Math.hypot(gdx, gdy);
            if (gNorm > P2.slopeDevMax) {
                const sc = P2.slopeDevMax / gNorm;
                gdx *= sc; gdy *= sc;
                flags.push('NB_DOC_CLAMP');
            }
        }

        let wSq = 0, wSum = 0, dMin = Infinity;
        const ids = [];
        const hullPts = [];
        for (const c of active) {
            const r = c.delta - (delta0 + gdx * c.dx + gdy * c.dy);
            wSq += c.w * r * r;
            wSum += c.w;
            if (c.d < dMin) dMin = c.d;
            ids.push(c.a.id);
            hullPts.push({ x: c.a.x, y: c.a.y });
        }
        const rms = wSum > 0 ? Math.sqrt(wSq / wSum) : Infinity;
        const sigmaFit = Math.sqrt(Math.max(0, invA00));
        const outsideHull = this._isOutsideConvexHull2D(hullPts, qx, qy);
        if (outsideHull) flags.push('NB_NGOAI_SUY');

        if (!Number.isFinite(delta0) || !Number.isFinite(rms) || !Number.isFinite(sigmaFit)) {
            return fail();
        }
        return {
            valid: true,
            delta0,
            gdx,
            gdy,
            sigmaFit,
            rms,
            nUsed,
            dMin,
            W: wSum,
            ids,
            flags,
            outsideHull
        };
    }

    /**
     * Step 4a: Dự đoán mặt đường từ hàng xóm NEAR (<= 8m) trước, rồi FAR (<= 30m).
     */
    static estimateNeighborCues(carBox, anchors, egoPlane, selfId, opts = {}) {
        const P2 = this.PHASE2;
        const invalid = (flags = []) => ({
            valid: false, mode: null, z: NaN, gx: 0, gy: 0, sigma: Infinity,
            nAnch: 0, dMin: Infinity, rms: Infinity, ids: [], flags
        });
        if (!carBox || !Array.isArray(anchors) || anchors.length === 0) return invalid();
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const qx = Number.isFinite(carBox.cx) ? carBox.cx : carBox.x;
        const qy = Number.isFinite(carBox.cy) ? carBox.cy : carBox.y;
        if (!Number.isFinite(qx) || !Number.isFinite(qy)) return invalid();

        const zEgo = ego.z0 + ego.gx * qx + ego.gy * qy;
        const near = this.fitResidualField(anchors, qx, qy, selfId, opts.nearKernel ?? P2.nearKernel, opts.nearRadius ?? P2.nearRadius, opts);
        const nearSingleOk = near.valid && near.nUsed === 1 && near.dMin <= P2.singleAnchorMaxD;
        const nearMultiOk = near.valid && near.nUsed >= P2.minAnchNear && near.rms <= P2.spreadMax;

        if (nearMultiOk || nearSingleOk) {
            const sigma = Math.hypot(Math.max(P2.sigmaFloor, near.sigmaFit), near.rms, P2.sigmaPerM * near.dMin);
            return {
                valid: true,
                mode: 'NEAR',
                z: zEgo + near.delta0,
                gx: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gx + near.gdx)),
                gy: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gy + near.gdy)),
                sigma,
                nAnch: near.nUsed,
                dMin: near.dMin,
                rms: near.rms,
                ids: near.ids,
                flags: near.flags
            };
        }

        const conflictFlags = [];
        if (near.valid && near.nUsed >= P2.minAnchNear && near.rms > P2.spreadMax) {
            conflictFlags.push('NB_MAU_THUAN');
        }

        const far = this.fitResidualField(anchors, qx, qy, selfId, opts.farKernel ?? P2.farKernel, opts.farRadius ?? P2.farRadius, opts);
        if (far.valid && far.nUsed >= P2.minAnchFar && far.rms <= P2.spreadMax) {
            const sigmaRaw = Math.hypot(Math.max(P2.sigmaFloor, far.sigmaFit), far.rms, P2.sigmaPerM * far.dMin);
            return {
                valid: true,
                mode: 'FAR',
                z: zEgo + far.delta0,
                gx: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gx + far.gdx)),
                gy: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gy + far.gdy)),
                sigma: Math.max(P2.farSigmaFloor, sigmaRaw),
                nAnch: far.nUsed,
                dMin: far.dMin,
                rms: far.rms,
                ids: far.ids,
                flags: far.flags
            };
        }

        if (far.valid && far.nUsed >= P2.minAnchFar && far.rms > P2.spreadMax && !conflictFlags.includes('NB_MAU_THUAN')) {
            conflictFlags.push('NB_MAU_THUAN');
        }
        // Fallback riêng tập neo đã duyệt khi neo rác làm mâu thuẫn hoặc chỉ có 1 neo duyệt ở gần (6-12m)
        const appAnchors = anchors.filter(a => a && a.approved);
        if (appAnchors.length > 0) {
            const appFit = this.fitResidualField(appAnchors, qx, qy, selfId, opts.farKernel ?? P2.farKernel, opts.farRadius ?? P2.farRadius, {
                ...opts,
                exemptApproved: true,
                approvedSingleMaxD: opts.approvedSingleMaxD ?? P2.approvedSingleMaxD ?? 12.0
            });
            if (appFit.valid && appFit.rms <= P2.spreadMax) {
                const isNearApp = appFit.dMin <= (opts.nearRadius ?? P2.nearRadius);
                const sigBase = Math.hypot(Math.max(P2.sigmaFloor, appFit.sigmaFit), appFit.rms, P2.sigmaPerM * appFit.dMin);
                return {
                    valid: true,
                    mode: isNearApp ? 'NEAR' : 'FAR',
                    nguon: 'NB_APPROVED',
                    z: zEgo + appFit.delta0,
                    gx: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gx + appFit.gdx)),
                    gy: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gy + appFit.gdy)),
                    sigma: isNearApp ? sigBase : Math.max(P2.farSigmaFloor, sigBase),
                    nAnch: appFit.nUsed,
                    dMin: appFit.dMin,
                    rms: appFit.rms,
                    ids: appFit.ids,
                    flags: [...(appFit.flags || []), 'NB_APPROVED']
                };
            }
        }
        return invalid(conflictFlags);
    }

    /**
     * Step 4b: Xây dựng Far-Field Refit toàn cục theo frame (một lần mỗi frame).
     */
    static buildFarFieldRefit(anchors, egoPlane, opts = {}) {
        const P2 = this.PHASE2;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        if (!Array.isArray(anchors) || anchors.length < P2.minAnchFar) {
            return {
                valid: false,
                predict: () => ({ valid: false, z: NaN, gx: ego.gx, gy: ego.gy, sigma: Infinity, nAnch: 0, dMin: Infinity, mode: null })
            };
        }

        // Tính một mặt phẳng dư chuẩn hóa toàn frame trên tất cả các neo xa/gần
        let cxMean = 0, cyMean = 0;
        for (const a of anchors) { cxMean += a.x; cyMean += a.y; }
        cxMean /= anchors.length; cyMean /= anchors.length;
        const globalFit = this.fitResidualField(anchors, cxMean, cyMean, null, 1000.0, 1e6, { irlsIters: P2.irlsIters, exemptApproved: true });

        return {
            valid: globalFit.valid,
            anchorsCount: anchors.length,
            predict: (x, y, selfId = null) => {
                if (!globalFit.valid || !Number.isFinite(x) || !Number.isFinite(y)) {
                    return { valid: false, z: NaN, gx: ego.gx, gy: ego.gy, sigma: Infinity, nAnch: 0, dMin: Infinity, mode: null };
                }
                const f = this.fitResidualField(anchors, x, y, selfId, 1000.0, 1e6, { ...opts, exemptApproved: true });
                if (!f.valid || f.nUsed < P2.minAnchFar) {
                    return { valid: false, z: NaN, gx: ego.gx, gy: ego.gy, sigma: Infinity, nAnch: f.nUsed, dMin: f.dMin, mode: null };
                }
                const zEgo = ego.z0 + ego.gx * x + ego.gy * y;
                const sigma = Math.max(P2.farSigmaFloor, Math.hypot(f.sigmaFit, f.rms, P2.sigmaPerM * f.dMin));
                return {
                    valid: true,
                    z: zEgo + f.delta0,
                    gx: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gx + f.gdx)),
                    gy: Math.max(-this.PHASE1.maxSlopeAbs, Math.min(this.PHASE1.maxSlopeAbs, ego.gy + f.gdy)),
                    sigma,
                    nAnch: f.nUsed,
                    dMin: f.dMin,
                    mode: 'FAR'
                };
            }
        };
    }

    /**
     * Step 6: Trọng tài hợp nhất Pass 2 theo cây quyết định 7 nhánh + Veto cuối.
     */
    static _hopNhatDoc(cur, neo, cfgRob = null) {
        if (!cur || !neo) return { gx: cur?.gx ?? 0, gy: cur?.gy ?? 0 };
        const nGx = Number.isFinite(neo.gx) ? neo.gx : neo.a;
        const nGy = Number.isFinite(neo.gy) ? neo.gy : neo.b;
        if (!Number.isFinite(nGx) || !Number.isFinite(nGy)) return { gx: cur.gx, gy: cur.gy };
        const spanC = Math.max(cur.span || 4.5, 2.0);
        const spanN = Math.max(neo.span || 4.5, 2.0);
        const sigC = Number.isFinite(cur.sigma) && cur.sigma > 0 ? cur.sigma : 0.12;
        const sigN = Number.isFinite(neo.sigma) && neo.sigma > 0 ? neo.sigma : 0.04;
        const sgC = sigC / spanC;
        const sgN = sigN / spanN;
        const invC = 1.0 / Math.max(1e-8, sgC * sgC);
        const invN = 1.0 / Math.max(1e-8, sgN * sgN);
        const dMin = Number.isFinite(neo.dist) ? Math.max(0, neo.dist) : 0;
        const omega = Math.min(0.8, (invN / (invN + invC)) * Math.exp(-dMin / 8.0));
        return {
            gx: (1.0 - omega) * cur.gx + omega * nGx,
            gy: (1.0 - omega) * cur.gy + omega * nGy
        };
    }

    static fusePhase2({ p1, nb, patch2, far, R, zEgoAtCar, vetoFn, opts = {} }) {
        const P2 = this.PHASE2;
        const p1Snap = {
            zc: p1.zc, gx: p1.gx, gy: p1.gy, sigma: p1.sigma,
            nhan: p1.nhan, flags: Array.isArray(p1.flags) ? [...p1.flags] : []
        };
        const outFlags = [...p1Snap.flags];
        const addFlag = (f) => { if (f && !outFlags.includes(f)) outFlags.push(f); };

        const hasNB = Number.isFinite(zEgoAtCar) && nb && nb.valid && Number.isFinite(nb.z);
        const nbInfo = hasNB
            ? { mode: nb.mode, nAnch: nb.nAnch, dMin: nb.dMin, rms: nb.rms, z: nb.z, sigma: nb.sigma, ids: nb.ids }
            : null;
        if (nb && Array.isArray(nb.flags)) {
            for (const f of nb.flags) {
                if (f === 'NB_MAU_THUAN') addFlag(f);
            }
        }

        const isConsistent = (zA, sigA, zB, sigB) => {
            const thr = Math.max(P2.consistMinAbs, P2.consistK * Math.hypot(sigA, sigB));
            return Math.abs(zA - zB) <= thr;
        };

        let zc = p1.zc, gx = p1.gx, gy = p1.gy, sigma = p1.sigma, nhan = p1.nhan, source = p1.source, count = p1.count;
        let vetoed = !!p1.vetoed;
        let changedFromP1 = false;

        if (p1.nhan === 'HYBRID' || p1.nhan === 'PATCH+POLAR' || p1.nhan === 'POLAR') {
            // Nhánh 1: Giữ HYBRID / PATCH+POLAR / POLAR
            if (hasNB && isConsistent(p1.zc, p1.sigma, nb.z, nb.sigma)) addFlag('NB_XAC_NHAN');
        } else if ((p1.nhan === 'PATCH' || p1.nhan === 'ROOF-H') && !p1.vetoed) {
            if (!hasNB) {
                // Nhánh 2: Giữ p1
            } else if (isConsistent(p1.zc, p1.sigma, nb.z, nb.sigma)) {
                // Nhánh 3: Giữ số p1 nguyên vẹn, gắn cờ xác nhận
                addFlag('NB_XAC_NHAN');
                const idxNg = outFlags.indexOf('NGOAI_LOP');
                if (idxNg >= 0) outFlags[idxNg] = 'LECH_EGO_XAC_NHAN';
            } else if (p1.sigma <= P2.keepP1Sigma) {
                // Nhánh 4: p1 rất chắc -> giữ p1, gắn cờ lệch
                addFlag('NB_LECH');
            } else {
                // Nhánh 5: mâu thuẫn & p1 chưa đủ chắc -> re-run patch2 hoặc hợp nhất p1+nb
                if (patch2 && patch2.valid && isConsistent(patch2.z, patch2.sigma, nb.z, nb.sigma)) {
                    zc = patch2.z; gx = patch2.gx; gy = patch2.gy; sigma = patch2.sigma;
                    nhan = 'PATCH'; source = 'phase2_patch_prior'; count = patch2.nPts;
                    addFlag('PRIOR_NB');
                    addFlag('NB_XAC_NHAN');
                    changedFromP1 = true;
                } else {
                    const w1 = 1.0 / Math.max(1e-6, p1.sigma * p1.sigma);
                    const wN = 1.0 / Math.max(1e-6, nb.sigma * nb.sigma);
                    zc = (w1 * p1.zc + wN * nb.z) / (w1 + wN);
                    gx = (w1 * p1.gx + wN * nb.gx) / (w1 + wN);
                    gy = (w1 * p1.gy + wN * nb.gy) / (w1 + wN);
                    sigma = Math.max(0.10, 1.0 / Math.sqrt(w1 + wN));
                    addFlag('NB_LECH');
                    changedFromP1 = true;
                }
            }
        } else if (p1.nhan === 'EGO·WARN' || p1.vetoed) {
            // Nhánh 6: EGO·WARN / PATCH_REJECT / p1 bị VETO
            if (hasNB && patch2 && patch2.valid && isConsistent(patch2.z, patch2.sigma, nb.z, nb.sigma)) {
                zc = patch2.z; gx = patch2.gx; gy = patch2.gy; sigma = patch2.sigma;
                nhan = 'PATCH'; source = 'phase2_patch_prior'; count = patch2.nPts;
                addFlag('PRIOR_NB');
                changedFromP1 = true;
            } else if (hasNB) {
                const rCue = p1.cues?.roof;
                const rValid = rCue && rCue.valid && !p1.vetoed;
                if (rValid && isConsistent(rCue.z, rCue.sigma, nb.z, nb.sigma)) {
                    const wR = 1.0 / Math.max(1e-6, rCue.sigma * rCue.sigma);
                    const wN = 1.0 / Math.max(1e-6, nb.sigma * nb.sigma);
                    zc = (wR * rCue.z + wN * nb.z) / (wR + wN);
                    gx = nb.gx; gy = nb.gy;
                    sigma = 1.0 / Math.sqrt(wR + wN);
                    nhan = nb.mode === 'FAR' ? 'FAR·PLANE' : 'NEIGHBOR';
                    source = nb.mode === 'FAR' ? 'phase2_far_plane' : 'phase2_neighbor';
                    count = nb.nAnch;
                } else {
                    zc = nb.z; gx = nb.gx; gy = nb.gy; sigma = nb.sigma;
                    nhan = nb.mode === 'FAR' ? 'FAR·PLANE' : 'NEIGHBOR';
                    source = nb.mode === 'FAR' ? 'phase2_far_plane' : 'phase2_neighbor';
                    count = nb.nAnch;
                }
                if (Array.isArray(nb.flags)) {
                    for (const f of nb.flags) addFlag(f);
                }
                changedFromP1 = true;
            } else if (p1.vetoed && far && far.valid) {
                // Kiểm tra far tại vị trí hiện tại (truyền qua farPred trong fusePhase2)
                if (opts.farPred && opts.farPred.valid && Number.isFinite(opts.farPred.z)) {
                    zc = opts.farPred.z;
                    gx = opts.farPred.gx;
                    gy = opts.farPred.gy;
                    sigma = Math.max(opts.farPred.sigma, P2.vetoCapSigma);
                    nhan = 'FAR·PLANE';
                    source = 'phase2_far_plane';
                    count = opts.farPred.nAnch;
                    changedFromP1 = true;
                }
            }
            // Nhánh 7: giữ p1 (EGO·WARN) nguyên vẹn nếu không có cue nào
        }

        // Veto cuối lên zFinal (khi giá trị đổi hoặc p1 vốn bị veto)
        if ((changedFromP1 || p1.vetoed) && typeof vetoFn === 'function') {
            const v = vetoFn(zc);
            if (v && v.veto && Number.isFinite(v.zMax) && zc >= v.zMax - 1e-6) {
                zc = Math.min(zc, v.zMax);
                sigma = Math.max(sigma, P2.vetoCapSigma);
                vetoed = true;
                addFlag('VETO_CAP');
            }
        }

        // Hợp nhất nguồn thứ 4: neo đã duyệt (neoPred) theo nghịch phương sai khi nằm trong tầm <= 30m
        const neoP = opts.neoPred;
        const robFuseCfg = this._getRobustSurfaceCfg(opts?.robustSurface);
        const CFG = this.CFG_SOFT;
        if (neoP && neoP.valid && Number.isFinite(neoP.z) && Number.isFinite(neoP.sigma) && neoP.sigma > 0) {
            const zNeoUse = (neoP.nguon === 'NEO_MEM' && Number.isFinite(neoP.zMem)) ? neoP.zMem : neoP.z;
            const nbDist = (nb && Number.isFinite(nb.dMin)) ? nb.dMin : 5.0;
            const nbN = (nb && Number.isFinite(nb.nAnch)) ? nb.nAnch : 1;
            const sigNeigh = (CFG.neighSigBase + CFG.neighSigPerM * nbDist) * (nbN <= 1 ? CFG.neighSingleMul : 1.0);
            const sigFar = CFG.farSigBase + CFG.farSigPerM * nbDist;
            const sigFloorCur = (nhan === 'EGO·WARN')
                ? 0.30
                : (nhan === 'BODY·FLOOR'
                    ? 0.15
                    : (nhan === 'POLAR'
                        ? 0.12
                        : (nhan === 'NEIGHBOR'
                            ? sigNeigh
                            : (nhan === 'FAR·PLANE' ? sigFar : 0))));
            let effSigCur = Number.isFinite(sigma) && sigma > 0 ? Math.max(sigma, sigFloorCur) : sigFloorCur;
            if (sigFloorCur > 0 && (outFlags.includes('OCC') || outFlags.includes('THIEU_DIEM'))) {
                effSigCur *= 1.5;
            }
            const wCur = Number.isFinite(zc) && effSigCur > 0 ? (1.0 / Math.max(1e-6, effSigCur * effSigCur)) : 0;
            const wNeo = 1.0 / Math.max(1e-6, neoP.sigma * neoP.sigma);
            if (robFuseCfg.enabled && robFuseCfg.fuseNeoSlope) {
                const blended = this._hopNhatDoc(
                    { gx, gy, sigma: effSigCur || 0.12, span: 4.5 },
                    { gx: neoP.a, gy: neoP.b, sigma: neoP.sigma, span: 4.5, dist: neoP.dMin },
                    robFuseCfg
                );
                gx = blended.gx;
                gy = blended.gy;
            }
            if (wCur > 0) {
                zc = (wCur * zc + wNeo * zNeoUse) / (wCur + wNeo);
                sigma = 1.0 / Math.sqrt(wCur + wNeo);
                if (nhan === 'NEIGHBOR' || nhan === 'FAR·PLANE') {
                    sigma = Math.max(sigma, Math.min(sigFloorCur, neoP.sigma));
                }
                if ((nhan === 'EGO·WARN' || nhan === 'NEIGHBOR' || nhan === 'FAR·PLANE') && wNeo >= 4.0 * wCur) {
                    nhan = 'NEO·DUYET';
                    source = 'phase2_neo_duyet';
                }
            } else {
                zc = zNeoUse;
                sigma = neoP.sigma;
                nhan = 'NEO·DUYET';
                source = 'phase2_neo_duyet';
            }
            addFlag('CO_NEO_DUYET');
        } else if (nhan === 'NEIGHBOR' || nhan === 'FAR·PLANE') {
            const nbDist = (nb && Number.isFinite(nb.dMin)) ? nb.dMin : 5.0;
            const nbN = (nb && Number.isFinite(nb.nAnch)) ? nb.nAnch : 1;
            const sigMin = nhan === 'NEIGHBOR'
                ? (CFG.neighSigBase + CFG.neighSigPerM * nbDist) * (nbN <= 1 ? CFG.neighSingleMul : 1.0)
                : (CFG.farSigBase + CFG.farSigPerM * nbDist);
            sigma = Number.isFinite(sigma) ? Math.max(sigma, sigMin) : sigMin;
        }

        // Bất biến sàn thân xe trên kết quả Phase 2 (kể cả khi giữ nguyên EGO·WARN / FAR·PLANE)
        const san = opts.san || p1?._san || null;
        const isConfLocal2 = !vetoed && (nhan === 'PATCH' || nhan === 'PATCH+POLAR' || nhan === 'POLAR' || nhan === 'HYBRID' || nhan === 'ROOF-H' || nhan === 'NEIGHBOR') && sigma < 0.10;
        const sanClamp2 = this.ganSanBatBienThanXe(zc, san, {
            isConfidentLocal: isConfLocal2,
            deltaMem: 0.12,
            thuLai: opts.retryPatchFn
        });
        if (sanClamp2.clipped) {
            if (sanClamp2.retried && sanClamp2.patchObj) {
                zc = sanClamp2.patchObj.z;
                gx = sanClamp2.patchObj.gx;
                gy = sanClamp2.patchObj.gy;
                sigma = sanClamp2.patchObj.sigma;
                count = sanClamp2.patchObj.nPts;
                nhan = 'PATCH';
                source = 'phase2_patch_san';
                addFlag('TAM_LAI');
            } else {
                zc = sanClamp2.z;
                sigma = Math.max(sigma, P2.vetoCapSigma);
                nhan = 'BODY·FLOOR';
                source = 'body_floor';
            }
            addFlag('SAN_XE');
        } else if (sanClamp2.softWarn) {
            addFlag('CAN_SAN');
        } else if (CFG.enabled && (nhan === 'EGO·WARN' || nhan === 'NEIGHBOR' || nhan === 'FAR·PLANE')) {
            const ceil2 = this.tinhTranThanXe(san, CFG.ceilPad);
            if (ceil2.valid && Number.isFinite(ceil2.zCeil) && zc > ceil2.zCeil) {
                zc = ceil2.zCeil;
                addFlag('SAN_XE');
                if (nhan === 'EGO·WARN') {
                    nhan = 'EGO·CLAMP';
                    source = 'phase2_ego_clamp';
                    sigma = Math.max(Number.isFinite(sigma) ? sigma : 0.15, 0.12);
                }
            }
        }

        return {
            zc,
            gx,
            gy,
            sigma,
            nhan,
            source,
            count,
            flags: outFlags,
            vetoed,
            zRoof: p1.zRoof,
            zPatch: patch2 && patch2.valid ? patch2.z : p1.zPatch,
            zPolar: p1.zPolar ?? NaN,
            zEgo: p1.zEgo,
            phase: 2,
            nbInfo,
            p1Snapshot: p1Snap
        };
    }

    /**
     * Step 11: Gắn cờ cảnh báo cho xe xa bị OCC và cô lập (không đổi số zc).
     */
    static flagIsolatedFar(items, anchors, opts = {}) {
        const P2 = this.PHASE2;
        const minR = opts.isolatedMinR ?? P2.isolatedMinR;
        const isoR = opts.isolatedRadius ?? P2.isolatedRadius;
        for (const it of items) {
            const p1 = it.p1, res = it.res || it.p2;
            if (!p1 || !res) continue;
            const x = it.box.cx, y = it.box.cy;
            const R = Math.hypot(x, y);
            if (R <= minR) continue;
            if (p1.nhan !== 'PATCH' || !Array.isArray(p1.flags) || !p1.flags.includes('OCC')) continue;
            let hasOther = false;
            for (const a of anchors) {
                if (a.id === it.id) continue;
                if (Math.hypot(a.x - x, a.y - y) <= isoR) { hasOther = true; break; }
            }
            if (!hasOther) {
                if (!res.flags.includes('CO_LAP_OCC')) res.flags.push('CO_LAP_OCC');
                res.sigma *= 1.5;
            }
        }
    }

    /**
     * Step 7: Pipeline DAG 2-pass hoàn chỉnh cho một frame.
     */
    static solveFramePhase2(frameBoxes, rawPts, egoPlane, opts = {}) {
        const P2 = this.PHASE2;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const rawList = Array.isArray(frameBoxes) ? frameBoxes : [];

        const canonList = rawList.map((b, idx) => this._canonicalizeBox(b, idx));
        // Gán khóa xác định và xử lý trùng khóa hiếm gặp
        const rawKeys = canonList.map(c => this.boxKey(c));
        const items = canonList.map((c, idx) => ({
            baseKey: rawKeys[idx],
            id: rawKeys[idx],
            box: c,
            carBox: { x: c.cx, y: c.cy, z: c.rawCz, rz: c.rz, L: c.L, W: c.W, H: c.H, track: c.track }
        }));
        items.sort((a, b) => (a.baseKey < b.baseKey ? -1 : a.baseKey > b.baseKey ? 1 : (a.box.rz - b.box.rz) || (a.box.trackId < b.box.trackId ? -1 : a.box.trackId > b.box.trackId ? 1 : 0)));
        const keyCounts = new Map();
        for (const it of items) {
            const n = keyCounts.get(it.baseKey) || 0;
            keyCounts.set(it.baseKey, n + 1);
            it.key = n === 0 ? it.baseKey : `${it.baseKey}#${n}`;
            it.id = it.key;
        }

        const neoList = this._thuThapNeoTuBoxes(canonList, ego, { ...opts, boxesRaw: rawList });
        const hasCarNeos = neoList.some(n => n && n.kind !== 'ego');
        const p1Cache = opts.p1Cache || null;
        const zPriorGridMap = opts.zPriorGridMap || null;
        let mat = opts.mat || null;
        if (this.CO.polar && (!mat || !mat.sanSang) && rawPts && rawPts.length >= 100) {
            const MatCtor = typeof MatDuongDongTam !== 'undefined'
                ? MatDuongDongTam
                : (typeof globalThis !== 'undefined' ? globalThis.MatDuongDongTam : null);
            if (MatCtor && typeof MatCtor.xayDung === 'function') {
                mat = MatCtor.xayDung(rawPts, canonList, hasCarNeos ? { neoList } : {});
            }
        } else if (mat && mat.sanSang && typeof mat.datNeo === 'function') {
            if (hasCarNeos) mat.datNeo(neoList, opts);
            else if (mat._neoState) mat.datNeo([]);
        }

        const Neo = this._getNeoDuyet();
        const neoState = (hasCarNeos && Neo)
            ? Neo.datTrangThaiNeo(neoList, (x, y) => {
                if (mat && mat.sanSang && typeof mat._zNenTai === 'function') {
                    const zm = mat._zNenTai(x, y);
                    if (Number.isFinite(zm)) return zm;
                }
                return ego.z0 + ego.gx * x + ego.gy * y;
            }, opts)
            : null;
        const solveOpts = hasCarNeos ? { ...opts, neoDuyet: neoList, neoState } : opts;

        // PASS 1: Độc lập từng box theo Phase 1 (+ Polar Đợt 2 dùng chung 1 instance mat)
        for (let i = 0; i < items.length; i++) {
            const it = items[i];
            const cachedP1 = p1Cache ? p1Cache.get(it.key) : null;
            if (cachedP1) {
                it.p1 = cachedP1;
            } else {
                const zPriorG = zPriorGridMap ? zPriorGridMap.get(it.key) : null;
                it.p1 = this.tinhMatDuongCucBoXe(
                    it.carBox, rawPts, ego, canonList, zPriorG,
                    { keepLocal: true, mat, excludeKey: it.baseKey, excludeTrackId: it.box.trackId }
                );
            }
        }

        if (!P2.enabled || items.length === 0) {
            const results = new Map();
            for (const it of items) {
                const r = { ...it.p1, deltaBottom: (it.box.rawCz - it.box.H / 2.0) - it.p1.zc };
                it.res = r;
                results.set(it.key, r);
            }
            return { items, anchors: [], far: null, results, ego, mat, neoState };
        }

        const anchors = this.buildAnchorSet(items, ego, solveOpts);
        const far = this.buildFarFieldRefit(anchors, ego, solveOpts);

        // PASS 2: Ưu tiên duyệt EGO·WARN trước rồi mới tới mâu thuẫn để bảo toàn maxRerunPerFrame xác định
        const pass2Order = [...items].sort((a, b) => {
            const pa = a.p1.nhan === 'EGO·WARN' ? 0 : 1;
            const pb = b.p1.nhan === 'EGO·WARN' ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });

        const approvedNeoMap = new Map();
        if (hasCarNeos) {
            for (const n of neoList) {
                if (n && n.kind !== 'ego' && n._boxKey) approvedNeoMap.set(n._boxKey, n);
            }
        }

        let nRerun = 0;
        const results = new Map();
        for (const it of pass2Order) {
            const p1 = it.p1;
            const R = Math.hypot(it.box.cx, it.box.cy);
            const zEgoAtCar = ego.z0 + ego.gx * it.box.cx + ego.gy * it.box.cy;

            // Box thuộc ID đã duyệt: khóa nguyên trạng làm neo cứng theo đúng đáy nghiêng Euler XYZ, không qua fusePhase2
            const appNeo = hasCarNeos ? (approvedNeoMap.get(it.baseKey) || approvedNeoMap.get(it.key)) : null;
            if (appNeo || (hasCarNeos && this._laBoxDaDuyet({ ...it.box, track: it.box.track }, opts.frame, opts))) {
                const carBoxTilt = { ...it.carBox, rx: it.box.rx || 0, ry: it.box.ry || 0, shape: it.box.shape };
                let pl = Neo ? Neo.matPhangDay(it.box.shape?.points || carBoxTilt) : null;
                if (!pl && (carBoxTilt.rx !== 0 || carBoxTilt.ry !== 0)) {
                    const cRx = Math.cos(carBoxTilt.rx), sRx = Math.sin(carBoxTilt.rx);
                    const cRy = Math.cos(carBoxTilt.ry), sRy = Math.sin(carBoxTilt.ry);
                    const c2 = cRx * cRy;
                    if (Number.isFinite(c2) && c2 >= 0.7) {
                        pl = {
                            zb: it.box.rawCz - it.box.H / (2.0 * c2),
                            a: -sRy / c2,
                            b: (sRx * cRy) / c2
                        };
                    }
                }
                const zApp = pl ? pl.zb : (appNeo ? appNeo.zb : (it.box.rawCz - it.box.H / 2.0));
                const lockedRes = {
                    zc: zApp,
                    zRoad: zApp,
                    gx: pl ? pl.a : (appNeo ? appNeo.a : 0),
                    gy: pl ? pl.b : (appNeo ? appNeo.b : 0),
                    sigma: 0.02,
                    nhan: 'DA·DUYET',
                    nguon: 'DA_DUYET',
                    source: 'approved',
                    count: 1,
                    flags: ['DA_DUYET'],
                    vetoed: false,
                    locked: true,
                    deltaBottom: (it.box.rawCz - it.box.H / 2.0) - zApp,
                    zFarPred: zApp,
                    _san: p1?._san || null,
                    _polar: p1?.cues?.polar || null,
                    _dens: p1?.cues?.dens || null,
                    zEgo: zEgoAtCar,
                    patchZ: zApp,
                    phase: 2
                };
                it.res = lockedRes;
                results.set(it.key, lockedRes);
                continue;
            }

            const nb = this.estimateNeighborCues(it.box, anchors, ego, it.id, solveOpts);

            let patch2 = null;
            if (nb.valid && rawPts && rawPts.length > 0 && nRerun < P2.maxRerunPerFrame) {
                const isConflict = (p1.nhan === 'PATCH' || p1.nhan === 'ROOF-H')
                    && !p1.vetoed
                    && p1.sigma > P2.keepP1Sigma
                    && Math.abs(p1.zc - nb.z) > Math.max(P2.consistMinAbs, P2.consistK * Math.hypot(p1.sigma, nb.sigma));
                const needRerun = p1.nhan === 'EGO·WARN' || p1.vetoed || isConflict;
                if (needRerun) {
                    nRerun++;
                    const halfBand = Math.max(P2.bandMin, Math.min(P2.bandMax, P2.bandK * Math.hypot(nb.sigma, P2.sigmaFloor)));
                    const localPts = p1._localPts || rawPts;
                    const otherMask = p1._otherMask || this.buildOtherBoxMask(canonList, it.carBox);
                    patch2 = this.estimatePatchCue(it.carBox, localPts, ego, otherMask, nb.z, {
                        zCenter: nb.z,
                        halfBand,
                        slopeCenter: [nb.gx, nb.gy],
                        maxSlopeDev: P2.slopeDevMax,
                        modeSelect: R < 25.0
                    });
                }
            }

            const localPts = p1._localPts || rawPts;
            const otherMask = p1._otherMask || this.buildOtherBoxMask(canonList, it.carBox);
            const vetoFn = (localPts && localPts.length > 0)
                ? (zCand) => this.bodyCutVeto(it.carBox, localPts, zCand, ego, otherMask)
                : null;
            const retryPatchFn = (localPts && localPts.length > 0)
                ? (zSan) => {
                    const p = this.estimatePatchCue(it.carBox, localPts, ego, otherMask, zSan - 0.10, {
                        zCenter: zSan - 0.10, halfBand: 0.50, maxSlopeDev: this.PHASE1.maxSlopeDevEgo * 1.5, san: p1._san
                    });
                    return p && p.valid ? p : NaN;
                }
                : null;
            const farPred = far && far.valid ? far.predict(it.box.cx, it.box.cy, it.id) : null;
            let neoPred = null;
            if (neoState && neoState.coNeoXe && Neo) {
                const zNenBox = Number.isFinite(p1?.zc) ? p1.zc : (farPred && farPred.valid ? farPred.z : zEgoAtCar);
                const cBoxNen = (p1?.nhan === 'HYBRID' || p1?.nhan === 'PATCH+POLAR') ? 0.6 : (p1?.nhan === 'PATCH' ? 0.45 : 0.15);
                neoPred = Neo.truyVanNeoChoBox(it.box.cx, it.box.cy, zNenBox, cBoxNen, neoState, {
                    p1Nhan: p1?.nhan,
                    p1Sigma: p1?.sigma,
                    p1Flags: p1?.flags,
                    p1PolarSoft: Boolean(p1?.cues?.polar?.soft),
                    excludeKey: it.baseKey,
                    excludeTrackId: it.box.trackId
                });
            }

            const p2 = this.fusePhase2({ p1, nb, patch2, far, R, zEgoAtCar, vetoFn, opts: { ...solveOpts, farPred, neoPred, san: p1._san, retryPatchFn } });
            p2.deltaBottom = (it.box.rawCz - it.box.H / 2.0) - p2.zc;
            p2.zFarPred = farPred && farPred.valid ? farPred.z : zEgoAtCar;
            p2._san = p1._san;
            p2._polar = p1.cues?.polar || null;
            p2._dens = p1.cues?.dens || null;
            p2.zEgo = zEgoAtCar;
            p2.patchZ = (p1.cues?.patch?.valid && Number.isFinite(p1.cues.patch.z)) ? p1.cues.patch.z : (Number.isFinite(p1.zPatch) ? p1.zPatch : p1.zc);
            it.res = p2;
            results.set(it.key, p2);
        }

        // Bước tùy chọn: ring-2 một lượt (mặc định tắt)
        if (P2.ring2) {
            const tier3 = [];
            for (const it of items) {
                const p2 = it.res;
                if ((p2.nhan === 'NEIGHBOR' || p2.nhan === 'FAR·PLANE' || (p2.nhan === 'PATCH' && p2.flags.includes('PRIOR_NB')))
                    && p2.sigma <= 0.10 && !p2.vetoed) {
                    const x = it.box.cx, y = it.box.cy;
                    const zEgo = ego.z0 + ego.gx * x + ego.gy * y;
                    tier3.push({
                        id: it.id, x, y, R: Math.hypot(x, y), zc: p2.zc, delta: p2.zc - zEgo,
                        sigmaEff: Math.max(p2.sigma, P2.anchorSigmaFloor), tier: 0.4, src: p2.nhan, flags: p2.flags
                    });
                }
            }
            if (tier3.length > 0) {
                const augAnchors = [...anchors, ...tier3];
                for (const it of items) {
                    if (it.res.nhan !== 'EGO·WARN') continue;
                    const nb2 = this.estimateNeighborCues(it.box, augAnchors, ego, it.id, opts);
                    if (!nb2.valid) continue;
                    const p2 = this.fusePhase2({
                        p1: it.p1, nb: nb2, patch2: null, far,
                        R: Math.hypot(it.box.cx, it.box.cy),
                        zEgoAtCar: ego.z0 + ego.gx * it.box.cx + ego.gy * it.box.cy,
                        vetoFn: null, opts
                    });
                    p2.deltaBottom = (it.box.rawCz - it.box.H / 2.0) - p2.zc;
                    it.res = p2;
                    results.set(it.key, p2);
                }
            }
        }

        this.flagIsolatedFar(items, anchors, opts);
        const robCrossCfg = this._getRobustSurfaceCfg(opts?.robustSurface);
        if (robCrossCfg.enabled && robCrossCfg.crossCar?.enabled && items.length > 1) {
            const carsView = items.map(it => ({
                id: it.id,
                cx: it.box.cx,
                cy: it.box.cy,
                plane: it.res ? { c: it.res.zc, a: it.res.gx, b: it.res.gy } : null,
                sigma: it.res?.sigma ?? 0.2,
                duyet: Boolean(it.res?.locked),
                occ: Array.isArray(it.res?.flags) && it.res.flags.includes('OCC'),
                _res: it.res
            }));
            this.hopNhatLienXe(carsView, robCrossCfg.crossCar);
            for (const cv of carsView) {
                if (cv._res && cv.plane) {
                    cv._res.gx = cv.plane.a;
                    cv._res.gy = cv.plane.b;
                    if (cv.inconsistent && Array.isArray(cv._res.flags) && !cv._res.flags.includes('CROSS_LECH')) {
                        cv._res.flags.push('CROSS_LECH');
                    }
                }
            }
        }
        return { items, anchors, far, results, ego, mat };
    }

    static hopNhatLienXe(cars, cfgCross = {}) {
        if (!Array.isArray(cars) || cars.length < 2) return;
        const radius = cfgCross?.radius ?? 10.0;
        const decay = Math.max(0.5, cfgCross?.decay ?? 6.0);
        const sigPullThr = cfgCross?.sigPullThr ?? 0.05;
        const r2Max = radius * radius;
        const snap = cars.map(c => (c && c.plane) ? { c: c.plane.c, a: c.plane.a, b: c.plane.b } : null);

        for (let i = 0; i < cars.length; i++) {
            const ci = cars[i];
            const si = snap[i];
            if (!ci || !si || ci.duyet || ci.sigma <= sigPullThr) continue;
            let sw = 0, sa = 0, sb = 0;
            let hasDiffWarn = false;
            for (let j = 0; j < cars.length; j++) {
                if (i === j) continue;
                const cj = cars[j];
                const sj = snap[j];
                if (!cj || !sj) continue;
                const dx = cj.cx - ci.cx;
                const dy = cj.cy - ci.cy;
                const d2 = dx * dx + dy * dy;
                if (d2 > r2Max) continue;
                const d = Math.sqrt(d2);
                const zPredAtJ = si.c + si.a * dx + si.b * dy;
                const sigComb = Math.hypot(ci.sigma || 0.05, cj.sigma || 0.05, 0.02);
                if (Math.abs(sj.c - zPredAtJ) > 3.0 * sigComb) {
                    hasDiffWarn = true;
                    continue;
                }
                const sigJ = Math.max(0.015, cj.sigma || 0.05);
                const w = Math.exp(-d / decay) / (sigJ * sigJ);
                sw += w;
                sa += w * sj.a;
                sb += w * sj.b;
            }
            if (hasDiffWarn && sw === 0) {
                ci.inconsistent = true;
                continue;
            }
            if (sw > 0) {
                const sigI = Math.max(0.02, ci.sigma || 0.08);
                const wSelf = 1.0 / (sigI * sigI);
                ci.plane.a = (wSelf * si.a + sw * (sa / sw)) / (wSelf + sw);
                ci.plane.b = (wSelf * si.b + sw * (sb / sw)) / (wSelf + sw);
            }
        }
    }

    /**
     * Step 10: Track Guard — phát hiện bước nhảy bất thường giữa các frame liên tiếp của track (chỉ gắn cờ mặc định).
     */
    static trackGuard(perFrame, opts = {}) {
        const P2 = this.PHASE2;
        const win = opts.trackWindow ?? P2.trackWindow;
        const thr = opts.trackThr ?? P2.trackThr;
        const halfW = Math.floor(win / 2);
        const out = new Map();
        if (!Array.isArray(perFrame) || perFrame.length < 4) return out;

        const sorted = [...perFrame].sort((a, b) => Number(a.fn) - Number(b.fn));
        for (let i = 0; i < sorted.length; i++) {
            const cur = sorted[i];
            if (!Number.isFinite(cur.zc) || cur.nhan === 'EGO·WARN') continue;
            const zRefCur = Number.isFinite(cur.zFarPred) ? cur.zFarPred : (Number.isFinite(cur.zEgo) ? cur.zEgo : 0);
            const rCur = cur.zc - zRefCur;

            const neighRes = [];
            for (let j = 0; j < sorted.length; j++) {
                if (j === i) continue;
                if (Math.abs(Number(sorted[j].fn) - Number(cur.fn)) > halfW) continue;
                const nb = sorted[j];
                if (!Number.isFinite(nb.zc) || nb.nhan === 'EGO·WARN') continue;
                const zRefNb = Number.isFinite(nb.zFarPred) ? nb.zFarPred : (Number.isFinite(nb.zEgo) ? nb.zEgo : 0);
                neighRes.push(nb.zc - zRefNb);
            }
            if (neighRes.length < 3) continue;
            const med = this.median(neighRes);
            const diff = Math.abs(rCur - med);
            if (diff > thr) {
                out.set(Number(cur.fn), {
                    flag: 'TRACK_NHAY',
                    residual: rCur,
                    median: med,
                    zSuggest: med + zRefCur
                });
            }
        }
        return out;
    }

    constructor() {
        this.isActive = false;
        this.selectionMode = 'layer'; // 'layer' | 'tile'
        this.cheDoChonTrenTop = false; // Bật chọn Surface trực tiếp bằng click trên View TOP
        this.panelCollapsed = false;
        this.layersListCollapsed = false;
        this._isApplying = false;
        try {
            if (typeof localStorage !== 'undefined') {
                this.panelCollapsed = localStorage.getItem('cvat_surface_panel_collapsed') === '1';
                this.layersListCollapsed = localStorage.getItem('cvat_surface_layers_collapsed') === '1';
            }
        } catch (_) {}
        this.frameCache = new Map();  // key: `${jobId}_${frameNum}` -> SurfaceData
        // Dọn dẹp cache v2 cũ (định dạng không tương thích). Cache v3 giữ nguyên: dữ liệu tự nhất quán, ô chỉnh tay khớp theo hình học.
        try {
            if (typeof localStorage !== 'undefined') {
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const k = localStorage.key(i);
                    if (k && k.startsWith('cvat_surface_v2_')) localStorage.removeItem(k);
                }
            }
        } catch (_) {}
        this.selectedTileIds = new Set();
        this.hoveredTileId = null;
        this.undoSnapshots = new Map();

        this.currentJobId = '0';
        this.currentFrame = 0; // Frame đang focus trong Extension Modal (tách với liveFrame trên 3D)
        this.liveFrame = 0;    // Frame đang hiển thị trên CVAT 3D Viewport
        this.callbacks = {};

        this._overlayObjects = []; // { scene, obj, viewKey }
        this._sharedGeoMesh = null;
        this._sharedGeoLine = null;
        this._sharedGeoPts = null;
        this._matMesh = null;
        this._matLine = null;
        this._matPts = null;
        this._tileVertexRanges = new Map(); // tileId -> { meshStart, meshCount, lineStart, lineCount, ptsStart, ptsCount }

        this._boundDomHandlers = [];
        this._frameWatcherId = null;
        this._queuedFrames = new Set();
        this._rafDrawId = null;
        this._panelEl = null;
        this._tooltipEl = null;
        this._minimizedModalByUs = false;

        // [CACHE 2-TIER GROUND PER FRAME]: Lưu mặt phẳng nền Ego & mặt đường cục bộ xe
        this.egoPlaneCache = new Map();       // fn -> { z0, gx, gy, valid }
        this.localCarGroundCache = new Map(); // `${fn}_${x}_${y}_${L}_${W}_${H}_${rz}_${nbSig}` -> localGround
        // [CACHE PHASE 2 PER FRAME]: LRU frameSolve + đóng băng neo khi kéo thả
        this.frameSolveCache = new Map();     // fn -> { sig, nBoxes, solve }
        this._ptsIdMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
        this._ptsSeq = 0;
        this._phase2Interactive = new Map();  // fn -> { timerId, frozenAnchors, far }
        this._trackGuardByBoxKey = new Map(); // `${fn}|${boxKey}` -> jumpInfo

        // [ĐỢT 1: MẶT ĐƯỜNG ĐỒNG TÂM (POLAR) & CHẾ ĐỘ HIỂN THỊ 3D]
        this._cheDoLuoi = 'dongtam'; // Mặc định hiển thị Đồng Tâm ('v4' | 'dongtam' | 'ca_hai')
        this._hienUnknownPolar = false;
        this._hienCanhNhayPolar = false;
        this._polarCache = new Map(); // `${jobId}_${fn}` -> MatDuongDongTam
        this._polarCacheModal = new Map(); // `${jobId}_${fn}` -> MatDuongDongTam (LRU 48 cho Modal)
        this._polarQueued = new Set();
        this._polarRes = null;
        this._polarStats = null;
        this._polarFail = null;
        this._polarFallback = false;
        this._polarLastToastKey = '';
        this._polarRetryState = { fn: null, count: 0, lastAt: 0 };
        this._activeOverlayMode = null;
        try {
            if (typeof localStorage !== 'undefined') {
                const m = localStorage.getItem('cvat_surface_cheDoLuoi');
                if (m === 'v4' || m === 'dongtam' || m === 'ca_hai') this._cheDoLuoi = m;
                const u = localStorage.getItem('cvat_surface_polar_unknown');
                if (u === '0' || u === '1') this._hienUnknownPolar = (u === '1');
                const j = localStorage.getItem('cvat_surface_polar_jump');
                if (j === '0' || j === '1') this._hienCanhNhayPolar = (j === '1');
            }
        } catch (_) {}

        this._canTinhLai = false;
        this._unsubDuyet = null;
        const khoInit = ThuatToanSurface._getKhoDuyet();
        if (khoInit && typeof khoInit.onThayDoi === 'function') {
            this._unsubDuyet = khoInit.onThayDoi(() => this.vohieuHoaTheoDuyet());
        }
    }

    vohieuHoaTheoDuyet() {
        this._canTinhLai = true;
        this.frameCache.clear();
        this.frameSolveCache.clear();
        this.localCarGroundCache.clear();
        if (this._trackPhase3Cache) this._trackPhase3Cache.clear();
        this._lastTrackPhase3Meta = null;

        // Cập nhật neo tức thì trên các instance Đồng Tâm đang cached mà không phải dựng lại nền LiDAR
        const updatePolarMap = (cacheMap) => {
            if (!cacheMap || cacheMap.size === 0) return;
            for (const [k, mat] of cacheMap.entries()) {
                if (!mat || !mat.sanSang || typeof mat.datNeo !== 'function') continue;
                const fnStr = String(k).split('_').pop();
                const fnNum = Number(fnStr);
                if (!Number.isFinite(fnNum)) continue;
                const boxes = this.layDanhSachBoxTrongFrame(fnNum);
                const raw = this.callbacks?.getFramePts ? this.callbacks.getFramePts(fnNum) : null;
                const ego = this.egoPlaneCache.get(fnNum) || (raw ? ThuatToanSurface.tinhEgoGroundPlane(raw) : { z0: 0, gx: 0, gy: 0, valid: true });
                const neoList = ThuatToanSurface._thuThapNeoTuBoxes(boxes, ego, { frame: fnNum });
                mat.datNeo(neoList);
                mat._canhNhay = null;
            }
        };
        updatePolarMap(this._polarCache);
        if (this._polarCacheModal) this._polarCacheModal.clear();
        if (this._polarQueued) this._polarQueued.clear();

        if (this._panelEl) {
            const recalcBtn = this._panelEl.querySelector('#surf-btn-recalc');
            if (recalcBtn) {
                recalcBtn.style.borderColor = '#fbbf24';
                recalcBtn.style.color = '#fbbf24';
                recalcBtn.title = 'Tập ID đã duyệt vừa thay đổi — bấm để tính lại lưới Surface';
            }
        }
        if (this.isActive) {
            this.veLaiToanBo(false);
        }
    }

    static SURF_UI_VER = 'dt-2';
    static _warnedNonIdMat = false;

    static _staticFrameSolveLRU = new Map();
    static _staticPtsIdMap = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
    static _staticPtsSeq = 0;

    static _getStaticPtsSig(rawPts) {
        if (!rawPts) return '0';
        if (this._staticPtsIdMap) {
            let id = this._staticPtsIdMap.get(rawPts);
            if (!id) {
                id = ++this._staticPtsSeq;
                this._staticPtsIdMap.set(rawPts, id);
            }
            return `${id}:${rawPts.length}`;
        }
        return `n:${rawPts.length}`;
    }

    static _queryInteractivePhase2(carBox, rawPts, egoPlane, frameBoxes, solve, opts = {}) {
        if (!carBox) return null;
        const P2 = this.PHASE2;
        const ego = (egoPlane && egoPlane.valid) ? egoPlane : { z0: 0.0, gx: 0.0, gy: 0.0, valid: true };
        const fnBox = carBox.frame !== undefined ? carBox.frame : carBox.shape?.frame;
        if (fnBox !== undefined && this._laBoxDaDuyet(carBox, Number(fnBox), opts)) {
            return this._taoKetQuaDaDuyet(carBox, ego);
        }
        const rawList = Array.isArray(frameBoxes) ? frameBoxes : [];
        const canonList = rawList.map((b, idx) => this._canonicalizeBox(b, idx));
        const canonTarget = this._canonicalizeBox(carBox, -1);
        const targetKey = this.boxKey(canonTarget);

        const p1 = this.tinhMatDuongCucBoXe(carBox, rawPts, ego, canonList, null, {
            keepLocal: true, mat: solve?.mat || null, excludeKey: targetKey, excludeTrackId: canonTarget.trackId
        });
        if (!p1) return null;
        if (!P2.enabled || !solve || !Array.isArray(solve.anchors) || solve.anchors.length === 0) {
            return {
                ...p1,
                deltaBottom: (canonTarget.rawCz - canonTarget.H / 2.0) - p1.zc,
                anchorCount: 0
            };
        }

        const curBaseKeys = new Set(canonList.map(c => this.boxKey(c)));
        const activeAnchors = solve.anchors.filter(a => {
            const aBase = a.id ? String(a.id).split('#')[0] : '';
            if (aBase === targetKey || a.id === targetKey) return false;
            return curBaseKeys.size === 0 || curBaseKeys.has(aBase);
        });

        const R = Math.hypot(canonTarget.cx, canonTarget.cy);
        const zEgoAtCar = ego.z0 + ego.gx * canonTarget.cx + ego.gy * canonTarget.cy;
        const nb = this.estimateNeighborCues(canonTarget, activeAnchors, ego, targetKey);
        const localPts = p1._localPts || rawPts;
        const otherMask = p1._otherMask || this.buildOtherBoxMask(canonList, carBox);

        let patch2 = null;
        if (nb.valid && localPts && localPts.length > 0) {
            const isConflict = (p1.nhan === 'PATCH' || p1.nhan === 'ROOF-H')
                && !p1.vetoed
                && p1.sigma > P2.keepP1Sigma
                && Math.abs(p1.zc - nb.z) > Math.max(P2.consistMinAbs, P2.consistK * Math.hypot(p1.sigma, nb.sigma));
            if (p1.nhan === 'EGO·WARN' || p1.vetoed || isConflict) {
                const halfBand = Math.max(P2.bandMin, Math.min(P2.bandMax, P2.bandK * Math.hypot(nb.sigma, P2.sigmaFloor)));
                patch2 = this.estimatePatchCue(carBox, localPts, ego, otherMask, nb.z, {
                    zCenter: nb.z,
                    halfBand,
                    slopeCenter: [nb.gx, nb.gy],
                    maxSlopeDev: P2.slopeDevMax,
                    modeSelect: R < 25.0
                });
            }
        }

        const vetoFn = (localPts && localPts.length > 0)
            ? (zCand) => this.bodyCutVeto(carBox, localPts, zCand, ego, otherMask)
            : null;
        const retryPatchFn = (localPts && localPts.length > 0)
            ? (zSan) => {
                const p = this.estimatePatchCue(carBox, localPts, ego, otherMask, zSan - 0.10, {
                    zCenter: zSan - 0.10, halfBand: 0.50, maxSlopeDev: this.PHASE1.maxSlopeDevEgo * 1.5, san: p1._san
                });
                return p && p.valid ? p : NaN;
            }
            : null;
        const farPred = solve.far && solve.far.valid ? solve.far.predict(canonTarget.cx, canonTarget.cy, targetKey) : null;
        const Neo = this._getNeoDuyet();
        let neoPred = null;
        if (solve.neoState && solve.neoState.coNeoXe && Neo) {
            const zNenBox = Number.isFinite(p1?.zc) ? p1.zc : (farPred && farPred.valid ? farPred.z : zEgoAtCar);
            const cBoxNen = (p1?.nhan === 'HYBRID' || p1?.nhan === 'PATCH+POLAR') ? 0.6 : (p1?.nhan === 'PATCH' ? 0.45 : 0.15);
            neoPred = Neo.truyVanNeoChoBox(canonTarget.cx, canonTarget.cy, zNenBox, cBoxNen, solve.neoState, {
                p1Nhan: p1?.nhan,
                p1Sigma: p1?.sigma,
                p1Flags: p1?.flags,
                p1PolarSoft: Boolean(p1?.cues?.polar?.soft),
                excludeKey: targetKey,
                excludeTrackId: canonTarget.trackId
            });
        }
        const p2 = this.fusePhase2({ p1, nb, patch2, far: solve.far, R, zEgoAtCar, vetoFn, opts: { farPred, neoPred, san: p1._san, retryPatchFn } });
        p2.deltaBottom = (canonTarget.rawCz - canonTarget.H / 2.0) - p2.zc;
        p2.zFarPred = farPred && farPred.valid ? farPred.z : zEgoAtCar;
        p2.anchorCount = activeAnchors.length;
        p2._san = p1._san;
        p2._polar = p1._polar;
        p2._dens = p1._dens;
        p2.zEgo = zEgoAtCar;
        p2.patchZ = (p1.nhan === 'PATCH' || p1.nhan === 'PATCH+POLAR' || p1.nhan === 'HYBRID') ? p1.zc : NaN;
        return p2;
    }

    layEgoGroundPlane(fn, rawPts) {
        if (this.egoPlaneCache.has(fn)) return this.egoPlaneCache.get(fn);
        const res = ThuatToanSurface.tinhEgoGroundPlane(rawPts);
        if (res && res.valid) this.egoPlaneCache.set(fn, res);
        return res;
    }

    _getPtsSig(rawPts) {
        if (!rawPts) return '0';
        if (this._ptsIdMap) {
            let id = this._ptsIdMap.get(rawPts);
            if (!id) {
                id = ++this._ptsSeq;
                this._ptsIdMap.set(rawPts, id);
            }
            return `${id}:${rawPts.length}`;
        }
        return `n:${rawPts.length}`;
    }

    _tinhFrameSolveSig(fn, frameBoxes, rawPts) {
        const P2 = ThuatToanSurface.PHASE2;
        const CO = ThuatToanSurface.CO;
        const ptsSig = this._getPtsSig(rawPts);
        const keys = [];
        if (Array.isArray(frameBoxes)) {
            for (const b of frameBoxes) {
                const c = ThuatToanSurface._canonicalizeBox(b);
                if (!c) continue;
                let k = ThuatToanSurface.boxKey(c);
                if (ThuatToanSurface._laBoxDaDuyet({ ...b, track: c.track }, fn)) {
                    k += `@${Math.round((c.rx || 0) * 1e5)},${Math.round((c.ry || 0) * 1e5)}`;
                }
                keys.push(k);
            }
            keys.sort();
        }
        return `${fn}|${P2.enabled ? 1 : 0}|${CO.polar ? 1 : 0}|${CO.ngucTrack ? 1 : 0}|v${ThuatToanSurface._phienBanDuyet()}|${ptsSig}|${keys.join(';')}`;
    }

    _xoaLocalCacheTheoFrame(fn) {
        const prefix = `${fn}_`;
        for (const k of this.localCarGroundCache.keys()) {
            if (String(k).startsWith(prefix)) this.localCarGroundCache.delete(k);
        }
    }

    vohieuHoaFrameSolve(fn) {
        if (this._trackPhase3Cache) this._trackPhase3Cache.clear();
        this._lastTrackPhase3Meta = null;
        if (fn === undefined || fn === null) {
            for (const inter of this._phase2Interactive.values()) {
                if (inter && inter.timerId) clearTimeout(inter.timerId);
            }
            this._phase2Interactive.clear();
            this.frameSolveCache.clear();
            this.localCarGroundCache.clear();
            if (this._polarCache) this._polarCache.clear();
            return;
        }
        const keyFn = Number.isFinite(Number(fn)) ? Number(fn) : fn;
        const inter = this._phase2Interactive.get(keyFn);
        if (inter && inter.timerId) clearTimeout(inter.timerId);
        this._phase2Interactive.delete(keyFn);
        this.frameSolveCache.delete(keyFn);
        if (this._polarCache) {
            this._polarCache.delete(keyFn);
            if (typeof this.layKeyHienTai === 'function') this._polarCache.delete(this.layKeyHienTai(keyFn));
        }
        this._xoaLocalCacheTheoFrame(keyFn);
    }

    _apDungPhase3ChoBox(fn, targetKey, rawPts, res) {
        if (!res || res.locked || res.nhan === 'DA·DUYET' || !ThuatToanSurface.CO.ngucTrack || !ThuatToanSurface.PHASE2.enabled) return res;
        const keyFn = Number.isFinite(Number(fn)) ? Number(fn) : Number(fn) || 0;
        const tr = (this.callbacks && typeof this.callbacks.getActiveTrack === 'function')
            ? this.callbacks.getActiveTrack()
            : null;
        if (!tr || !Array.isArray(tr.shapes) || tr.shapes.length < 2) return res;

        const activeShape = tr.shapes.find(s => s && !s.outside && Number(s.frame) === keyFn && s.points?.length >= 9);
        if (!activeShape) return res;
        const activeBox = {
            cx: activeShape.points[0], cy: activeShape.points[1], cz: activeShape.points[2],
            rx: activeShape.points[3] || 0, ry: activeShape.points[4] || 0,
            rz: activeShape.points[5] || 0, L: activeShape.points[6] || 4.5, W: activeShape.points[7] || 1.9, H: activeShape.points[8] || 1.6,
            shape: activeShape, track: tr
        };
        const activeCanon = ThuatToanSurface._canonicalizeBox(activeBox);
        const activeKey = activeCanon ? ThuatToanSurface.boxKey(activeCanon) : '';
        if (targetKey && activeKey && targetKey !== activeKey) {
            return res;
        }

        const tKey = String(tr.id ?? tr._trackNumber ?? tr._clientID ?? 'active');
        this._trackPhase3Cache = this._trackPhase3Cache || new Map();

        // Trong lúc đang kéo chuột tương tác: trả cache cũ ngay (0ms), đợi settle rồi tính lại
        if (this._phase2Interactive && this._phase2Interactive.has(keyFn)) {
            const cached = this._trackPhase3Cache.get(tKey);
            const hit = cached && cached.resMap && cached.resMap.get(keyFn);
            if (hit) {
                const zBot = (activeShape.points[2] ?? 0) - ((activeShape.points[8] ?? 1.6) / 2.0);
                return { ...hit, deltaBottom: zBot - hit.zc };
            }
            return res;
        }

        const getPts = (f) => {
            if (f === keyFn && rawPts && rawPts.length > 0) return rawPts;
            return (this.callbacks && typeof this.callbacks.getFramePts === 'function') ? this.callbacks.getFramePts(f) : null;
        };
        const getBoxes = (f) => (this.callbacks && typeof this.callbacks.getFrameBoxes === 'function') ? this.callbacks.getFrameBoxes(f) : [];

        const sigParts = [tKey, ThuatToanSurface.CO.ngucTrack ? '1' : '0', `v${ThuatToanSurface._phienBanDuyet()}`];
        const candShapes = tr.shapes
            .filter(s => s && !s.outside && s.points && s.points.length >= 9)
            .sort((a, b) => Number(a.frame) - Number(b.frame));

        const cachedFrames = [];
        for (const s of candShapes) {
            const fNum = Number(s.frame);
            const pts = getPts(fNum);
            if (!pts || pts.length < 10) continue;
            const bObj = {
                cx: s.points[0], cy: s.points[1], cz: s.points[2],
                rx: s.points[3] || 0, ry: s.points[4] || 0,
                rz: s.points[5] || 0, L: s.points[6] || 4.5, W: s.points[7] || 1.9, H: s.points[8] || 1.6,
                shape: s, track: tr
            };
            const qx = Math.round(bObj.cx * 20), qy = Math.round(bObj.cy * 20), qr = Math.round(bObj.rz * 114.6);
            const isAppS = ThuatToanSurface._laBoxDaDuyet({ ...bObj, track: tr }, fNum);
            const tiltTag = isAppS ? `,${Math.round(bObj.rx * 1e5)},${Math.round(bObj.ry * 1e5)}` : '';
            sigParts.push(`${fNum}:${qx},${qy},${qr},${Math.round(bObj.H * 100)}${tiltTag}:${pts.length}`);
            cachedFrames.push({ fNum, pts, bObj });
        }
        if (cachedFrames.length < 2) return res;

        const sig = sigParts.join('|');
        const oldCache = this._trackPhase3Cache.get(tKey);
        if (oldCache && oldCache.sig === sig) {
            this._lastTrackPhase3Meta = { trackKey: tKey, ...oldCache.meta };
            const hit = oldCache.resMap.get(keyFn);
            if (hit) {
                const zBot = (activeShape.points[2] ?? 0) - ((activeShape.points[8] ?? 1.6) / 2.0);
                return { ...hit, deltaBottom: zBot - hit.zc };
            }
            return res;
        }

        const trackItems = [];
        for (const cf of cachedFrames) {
            const fBoxes = getBoxes(cf.fNum);
            const slv = this.layFrameSolve(cf.fNum, fBoxes, cf.pts);
            const canon = ThuatToanSurface._canonicalizeBox(cf.bObj);
            const bk = canon ? ThuatToanSurface.boxKey(canon) : null;
            const p2 = (bk && slv && slv.results) ? slv.results.get(bk) : null;
            if (!p2) continue;
            const otherMask = ThuatToanSurface.buildOtherBoxMask(fBoxes, cf.bObj);
            const tg = (this._trackGuardByBoxKey && bk) ? this._trackGuardByBoxKey.get(`${cf.fNum}|${bk}`) : null;
            trackItems.push({
                fn: cf.fNum,
                carBox: cf.bObj,
                rawPts: cf.pts,
                otherMask,
                p2,
                guard: tg || p2.trackJump || null,
                zEgo: p2.zEgo
            });
        }

        if (trackItems.length >= 3) {
            const perFrame = trackItems.map(it => ({
                fn: it.fn, zc: it.p2.zc, zEgo: it.zEgo, zFarPred: it.p2.zFarPred, nhan: it.p2.nhan
            }));
            const jMap = ThuatToanSurface.trackGuard(perFrame);
            for (const it of trackItems) {
                const j = jMap.get(it.fn);
                if (j) it.guard = j;
            }
        }

        const p3 = ThuatToanSurface.giaiTrackPhase3(trackItems);
        if (this._trackPhase3Cache.size >= 16) {
            const firstKey = this._trackPhase3Cache.keys().next().value;
            this._trackPhase3Cache.delete(firstKey);
        }
        this._trackPhase3Cache.set(tKey, { sig, resMap: p3.resMap, meta: p3.meta });
        this._lastTrackPhase3Meta = { trackKey: tKey, ...p3.meta };

        const hit = p3.resMap.get(keyFn);
        if (hit) {
            const zBot = (activeShape.points[2] ?? 0) - ((activeShape.points[8] ?? 1.6) / 2.0);
            return { ...hit, deltaBottom: zBot - hit.zc };
        }
        return res;
    }

    layFrameSolve(fn, frameBoxes, rawPts, opts = null) {
        const P2 = ThuatToanSurface.PHASE2;
        const keyFn = Number.isFinite(Number(fn)) ? Number(fn) : fn;
        const nBoxes = Array.isArray(frameBoxes) ? frameBoxes.length : 0;
        const unlockTag = (opts?.trackKeysMoKhoa && opts.trackKeysMoKhoa.size > 0)
            ? `_unl:${[...opts.trackKeysMoKhoa].sort().join(',')}`
            : '';
        const sig = this._tinhFrameSolveSig(keyFn, frameBoxes, rawPts) + unlockTag;
        const hit = this.frameSolveCache.get(keyFn);
        if (hit && hit.sig === sig) {
            this.frameSolveCache.delete(keyFn);
            this.frameSolveCache.set(keyFn, hit);
            return hit.solve;
        }
        const ego = this.layEgoGroundPlane(keyFn, rawPts);
        let sharedMat = null;
        if (ThuatToanSurface.CO.polar && rawPts && rawPts.length >= 100) {
            const pKey = this.layKeyHienTai(keyFn);
            const pCached = this._polarCache?.get(pKey);
            if (pCached && pCached.sanSang && (!pCached._solveSig || pCached._solveSig === sig)) {
                sharedMat = pCached;
                if (!pCached._solveSig) pCached._solveSig = sig;
            } else {
                const MatCtor = typeof MatDuongDongTam !== 'undefined'
                    ? MatDuongDongTam
                    : (typeof globalThis !== 'undefined' ? globalThis.MatDuongDongTam : null);
                if (MatCtor && typeof MatCtor.xayDung === 'function') {
                    sharedMat = MatCtor.xayDung(rawPts, frameBoxes);
                    if (sharedMat && sharedMat.sanSang) {
                        sharedMat._solveSig = sig;
                        if (this._polarCache) {
                            this._polarCache.set(pKey, sharedMat);
                            while (this._polarCache.size > 12) {
                                const oldestP = this._polarCache.keys().next().value;
                                if (oldestP !== undefined) this._polarCache.delete(oldestP);
                            }
                        }
                    }
                }
            }
        }
        const solve = ThuatToanSurface.solveFramePhase2(frameBoxes, rawPts, ego, { frame: keyFn, mat: sharedMat, ...(opts || {}) });
        if (solve && Array.isArray(solve.anchors)) {
            for (const it of (solve.items || [])) {
                if (it.res && !Number.isFinite(it.res.anchorCount)) {
                    it.res.anchorCount = solve.anchors.length;
                }
            }
        }
        if (hit) this.frameSolveCache.delete(keyFn);
        this.frameSolveCache.set(keyFn, { sig, nBoxes, solve });
        const maxCap = Math.max(1, P2.frameCacheMax || 8);
        while (this.frameSolveCache.size > maxCap) {
            const oldestKey = this.frameSolveCache.keys().next().value;
            this.frameSolveCache.delete(oldestKey);
        }
        return solve;
    }

    _ganCoTrackGuardNeuCo(fn, targetKey, res) {
        if (!res) return res;
        let out = res;
        if (this._trackGuardByBoxKey && this._trackGuardByBoxKey.size > 0) {
            const tg = this._trackGuardByBoxKey.get(`${fn}|${targetKey}`);
            if (tg) {
                const flags = Array.isArray(out.flags) ? [...out.flags] : [];
                if (!flags.includes('TRACK_NHAY')) flags.push('TRACK_NHAY');
                out = { ...out, flags, trackJump: tg };
            }
        }
        return this._apDungPhase3ChoBox(fn, targetKey, null, out);
    }

    layMatDuongCucBoChoBox(fn, carBox, rawPts) {
        if (!carBox) return null;
        const P2 = ThuatToanSurface.PHASE2;
        const keyFn = Number.isFinite(Number(fn)) ? Number(fn) : fn;
        const q = (v, d = 0) => (Math.round(((Number.isFinite(v) ? v : d)) / 0.02) * 0.02).toFixed(2);
        const canonTarget = ThuatToanSurface._canonicalizeBox(carBox);
        const targetKey = ThuatToanSurface.boxKey(canonTarget);
        const zBottom = (Number.isFinite(carBox.z) ? carBox.z : 0) - (carBox.H || 1.6) / 2.0;

        const frameBoxes = this.layDanhSachBoxTrongFrame(keyFn);
        const hasBoxes = Array.isArray(frameBoxes) && frameBoxes.length > 0;
        const sig = hasBoxes ? this._tinhFrameSolveSig(keyFn, frameBoxes, rawPts) : 'noBoxes';
        const isAppTarget = ThuatToanSurface._laBoxDaDuyet(carBox, keyFn);
        if (isAppTarget) {
            const egoApp = this.layEgoGroundPlane(keyFn, rawPts);
            const appRes = ThuatToanSurface._taoKetQuaDaDuyet(carBox, egoApp);
            if (appRes) return appRes;
        }
        const tiltSuffix = isAppTarget ? `_${Math.round((canonTarget.rx || 0) * 1e5)}_${Math.round((canonTarget.ry || 0) * 1e5)}` : '';
        const localKey = `${keyFn}_${Number(canonTarget.cx).toFixed(2)}_${Number(canonTarget.cy).toFixed(2)}_${q(canonTarget.L, 4.5)}_${q(canonTarget.W, 1.9)}_${q(canonTarget.H, 1.6)}_${q(canonTarget.rz, 0)}${tiltSuffix}_${sig}`;

        if (!this._phase2Interactive.has(keyFn) && this.localCarGroundCache.has(localKey)) {
            const cached = this.localCarGroundCache.get(localKey);
            return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...cached, deltaBottom: zBottom - cached.zc });
        }

        if (P2.enabled && hasBoxes && rawPts && rawPts.length >= 10) {
            const existing = this.frameSolveCache.get(keyFn);
            const curNBoxes = frameBoxes.length;

            // Trường hợp hit chính xác frameSolveCache (gồm cả nhấp nhả huỷ drag) -> 0 rebuild
            if (existing && existing.sig === sig && existing.solve?.results?.has(targetKey)) {
                if (this._phase2Interactive.has(keyFn)) {
                    const oldInter = this._phase2Interactive.get(keyFn);
                    if (oldInter && oldInter.timerId) clearTimeout(oldInter.timerId);
                    this._phase2Interactive.delete(keyFn);
                }
                const hitRes = existing.solve.results.get(targetKey);
                this.localCarGroundCache.set(localKey, hitRes);
                return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...hitRes, deltaBottom: zBottom - hitRes.zc });
            }

            // Nếu số lượng box thay đổi -> huỷ trạng thái drag & giải lạnh ngay
            if (existing && existing.nBoxes !== curNBoxes) {
                const oldInter = this._phase2Interactive.get(keyFn);
                if (oldInter && oldInter.timerId) clearTimeout(oldInter.timerId);
                this._phase2Interactive.delete(keyFn);
                this.frameSolveCache.delete(keyFn);
                this._xoaLocalCacheTheoFrame(keyFn);
            }

            const curCached = this.frameSolveCache.get(keyFn);
            if (!curCached) {
                // Chưa có cache frame -> chạy full solveFramePhase2 một lần
                const solve = this.layFrameSolve(keyFn, frameBoxes, rawPts);
                const exactRes = solve?.results?.get(targetKey);
                if (exactRes) {
                    this.localCarGroundCache.set(localKey, exactRes);
                    return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...exactRes, deltaBottom: zBottom - exactRes.zc });
                }
                const interRes = ThuatToanSurface._queryInteractivePhase2(carBox, rawPts, solve?.ego, frameBoxes, solve);
                if (interRes) {
                    return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...interRes, deltaBottom: zBottom - interRes.zc });
                }
            } else {
                // Đã có frameSolve cho frame này nhưng toạ độ đang kéo thay đổi -> đóng băng anchors + hẹn settleMs
                let inter = this._phase2Interactive.get(keyFn);
                if (!inter) {
                    inter = {
                        timerId: null,
                        frozenSolve: curCached.solve
                    };
                    this._phase2Interactive.set(keyFn, inter);
                }
                if (inter.timerId) clearTimeout(inter.timerId);
                inter.timerId = setTimeout(() => {
                    this._phase2Interactive.delete(keyFn);
                    this.frameSolveCache.delete(keyFn);
                    this._xoaLocalCacheTheoFrame(keyFn);
                    if (this._polarCache) this._polarCache.delete(this.layKeyHienTai(keyFn));
                    if (typeof this.callbacks.requestRedraw === 'function') {
                        this.callbacks.requestRedraw(keyFn);
                    } else if (typeof this.callbacks.onSurfaceFrameReady === 'function') {
                        this.callbacks.onSurfaceFrameReady(keyFn);
                    } else if (typeof this.callbacks.onSurfaceChanged === 'function') {
                        this.callbacks.onSurfaceChanged();
                    }
                }, Math.max(20, P2.settleMs || 150));

                const ego = this.layEgoGroundPlane(keyFn, rawPts);
                const dragRes = ThuatToanSurface._queryInteractivePhase2(carBox, rawPts, ego, frameBoxes, inter.frozenSolve);
                if (dragRes) {
                    return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...dragRes, deltaBottom: zBottom - dragRes.zc });
                }
            }
        }

        const ego = this.layEgoGroundPlane(keyFn, rawPts);
        const res = ThuatToanSurface.tinhMatDuongCucBoXe(carBox, rawPts, ego, frameBoxes);
        if (res) {
            this.localCarGroundCache.set(localKey, res);
            return this._ganCoTrackGuardNeuCo(keyFn, targetKey, { ...res, deltaBottom: zBottom - res.zc });
        }
        return res;
    }

    // =========================================================================
    // 1. TIỆN ÍCH TOÁN HỌC & ĐẠI SỐ TUYẾN TÍNH
    // =========================================================================

    static median(arr) {
        if (!arr || arr.length === 0) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(s.length / 2);
        return s.length % 2 === 0 ? 0.5 * (s[mid - 1] + s[mid]) : s[mid];
    }

    static clamp(v, lo, hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    static evalTileZ(tile, x, y) {
        const tw = tile.tw || 0;
        const base = tile.zc + tile.gx * (x - tile.cx) + tile.gy * (y - tile.cy);
        if (!tw) return base;
        return base + tw * ((2 * (x - tile.cx)) / tile.w) * ((2 * (y - tile.cy)) / tile.h);
    }

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

    static solveLinear3x3(A, b) {
        // Giải A * x = b với ma trận 3x3 bằng khử Gauss có chọn trụ
        const M = [
            [A[0][0], A[0][1], A[0][2], b[0]],
            [A[1][0], A[1][1], A[1][2], b[1]],
            [A[2][0], A[2][1], A[2][2], b[2]]
        ];
        for (let col = 0; col < 3; col++) {
            let piv = col;
            for (let r = col + 1; r < 3; r++) {
                if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
            }
            if (Math.abs(M[piv][col]) < 1e-10) return null;
            if (piv !== col) {
                const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
            }
            const div = M[col][col];
            for (let c = col; c < 4; c++) M[col][c] /= div;
            for (let r = 0; r < 3; r++) {
                if (r === col) continue;
                const factor = M[r][col];
                for (let c = col; c < 4; c++) M[r][c] -= factor * M[col][c];
            }
        }
        return [M[0][3], M[1][3], M[2][3]];
    }

    /**
     * Fit mặt phẳng z = zc + gx*(x - cx) + gy*(y - cy) có chính quy hóa về prior (gx0, gy0, z0)
     */
    static fitRegularizedPlane(pts, cx, cy, priorGx = 0, priorGy = 0, priorZc = null, regSlope = 4.0, regZ = 0.05, weights = null) {
        if (!pts || pts.length < 3) return null;
        const hasPriorZ = priorZc !== null && Number.isFinite(priorZc);
        const effRegZ = hasPriorZ ? regZ : 0;
        let sxx = regSlope, syy = regSlope, sxy = 0;
        let sx = 0, sy = 0, s_res = effRegZ;
        let sxz = regSlope * priorGx, syz = regSlope * priorGy;
        let sz = hasPriorZ ? effRegZ * priorZc : 0;

        for (let i = 0; i < pts.length; i++) {
            const w = weights ? weights[i] : 1.0;
            if (w <= 0) continue;
            const dx = pts[i][0] - cx;
            const dy = pts[i][1] - cy;
            const z = pts[i][2];
            sxx += w * dx * dx; syy += w * dy * dy; sxy += w * dx * dy;
            sx += w * dx; sy += w * dy; s_res += w;
            sxz += w * dx * z; syz += w * dy * z; sz += w * z;
        }

        const sol = this.solveLinear3x3(
            [
                [sxx, sxy, sx],
                [sxy, syy, sy],
                [sx,  sy,  s_res]
            ],
            [sxz, syz, sz]
        );
        if (!sol) return null;
        return { gx: sol[0], gy: sol[1], zc: sol[2], inliers: pts.length };
    }

    /**
     * Tính thống kê phân tán 2D (lambdaMin & độ lệch tâm) của tập điểm trong mặt phẳng XY
     */
    static tinhThongKePhanBoXY(pts, cx = 0, cy = 0) {
        const n = pts ? pts.length : 0;
        if (n < 3) return { lambdaMin: 0, meanDx: 0, meanDy: 0 };
        let mx = 0, my = 0;
        for (let i = 0; i < n; i++) { mx += pts[i][0]; my += pts[i][1]; }
        mx /= n; my /= n;
        let cxx = 0, cxy = 0, cyy = 0;
        for (let i = 0; i < n; i++) {
            const ux = pts[i][0] - mx, uy = pts[i][1] - my;
            cxx += ux * ux; cxy += ux * uy; cyy += uy * uy;
        }
        cxx /= n; cxy /= n; cyy /= n;
        const tr = cxx + cyy, diff = cxx - cyy;
        const disc = Math.sqrt(Math.max(0, diff * diff + 4 * cxy * cxy));
        return { lambdaMin: 0.5 * (tr - disc), meanDx: mx - cx, meanDy: my - cy };
    }

    static tinhLambdaMinXY(pts) {
        return this.tinhThongKePhanBoXY(pts, 0, 0).lambdaMin;
    }

    // =========================================================================
    // 2. TRÍCH XUẤT TOÀN BỘ ĐIỂM LIDAR FULL MAP (ZERO-COPY)
    // =========================================================================

    static layDiemToanBanDoRaw(fallbackPts = null, allowThreeJS = true) {
        // Chỉ đọc Float32Array từ Three.js khi đúng là liveFrame hiện tại trên CVAT 3D
        if (allowThreeJS && typeof window !== 'undefined') {
            try {
                const views = window.quanLyAPICVAT?.getAnnotationState()?.canvas?.instance?.view?.views;
                if (views) {
                    let bestCloud = null;
                    let bestEffCount = 0;
                    const inspectObj = (o) => {
                        if (!o || !o.isPoints || o.visible === false) return;
                        if (typeof o.name === 'string' && o.name.startsWith('__cvat_')) return;
                        const attr = o.geometry?.attributes?.position;
                        if (!attr) return;
                        const itemSize = attr.itemSize || 3;
                        const totalVerts = Number.isFinite(attr.count)
                            ? attr.count
                            : Math.floor((attr.array?.length || 0) / itemSize);
                        if (totalVerts < 10) return;
                        const dr = o.geometry?.drawRange;
                        const drStart = Math.max(0, dr?.start || 0);
                        const drCount = dr?.count;
                        const effEnd = (Number.isFinite(drCount) && drCount >= 0 && drCount < totalVerts)
                            ? Math.min(totalVerts, drStart + drCount)
                            : totalVerts;
                        const effCount = Math.max(0, effEnd - drStart);
                        if (effCount >= 10 && effCount > bestEffCount) {
                            bestEffCount = effCount;
                            bestCloud = o;
                        }
                    };
                    for (const key of ['perspective', 'top', 'side', 'front']) {
                        const sc = views[key]?.scene;
                        if (!sc) continue;
                        if (typeof sc.traverse === 'function') sc.traverse(inspectObj);
                        else if (Array.isArray(sc.children)) sc.children.forEach(inspectObj);
                    }
                    if (bestCloud) {
                        const geo = bestCloud.geometry;
                        const attr = geo.attributes.position;
                        const itemSize = attr.itemSize || 3;
                        const dr = geo.drawRange;
                        const drStart = Math.max(0, dr?.start || 0);
                        const count = bestEffCount;

                        if (!this._warnedNonIdMat && bestCloud.matrixWorld?.elements?.length === 16) {
                            const e = bestCloud.matrixWorld.elements;
                            const idMat = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
                            let maxDiff = 0;
                            for (let k = 0; k < 16; k++) maxDiff = Math.max(maxDiff, Math.abs(e[k] - idMat[k]));
                            if (maxDiff > 1e-3) {
                                this._warnedNonIdMat = true;
                                console.warn('[Đồng Tâm] Points matrixWorld khác đơn vị (maxDiff=' + maxDiff.toFixed(3) + ') — kiểm tra hệ tọa độ');
                            }
                        }

                        let flatArray;
                        if (!attr.isInterleavedBufferAttribute && itemSize === 3 && drStart === 0 && attr.array) {
                            flatArray = attr.array;
                        } else {
                            flatArray = new Float32Array(count * 3);
                            const useGetter = typeof attr.getX === 'function' && typeof attr.getY === 'function' && typeof attr.getZ === 'function';
                            const src = attr.array;
                            for (let i = 0; i < count; i++) {
                                const si = drStart + i;
                                const di = i * 3;
                                if (useGetter) {
                                    flatArray[di] = attr.getX(si);
                                    flatArray[di + 1] = attr.getY(si);
                                    flatArray[di + 2] = attr.getZ(si);
                                } else if (src) {
                                    const sb = si * itemSize;
                                    flatArray[di] = src[sb];
                                    flatArray[di + 1] = src[sb + 1];
                                    flatArray[di + 2] = src[sb + 2];
                                }
                            }
                        }

                        const iMid = (count >> 1) * 3;
                        const iEnd = Math.max(0, count - 1) * 3;
                        const fSig = `${count}|${flatArray[0]?.toFixed(2)},${flatArray[1]?.toFixed(2)},${flatArray[2]?.toFixed(2)}|${flatArray[iMid]?.toFixed(2)},${flatArray[iMid + 2]?.toFixed(2)}|${flatArray[iEnd]?.toFixed(2)},${flatArray[iEnd + 2]?.toFixed(2)}`;
                        return {
                            flatArray,
                            isFlat: true,
                            count,
                            uuid: `${bestCloud.uuid || 'pts'}:${fSig}`,
                            source: 'three'
                        };
                    }
                }
            } catch (e) {
                console.warn('[Surface] Lỗi đọc Float32Array từ Three.js:', e);
            }
        }

        if (Array.isArray(fallbackPts) && fallbackPts.length > 0) {
            return {
                ptsArray: fallbackPts,
                isFlat: false,
                count: fallbackPts.length,
                uuid: null,
                source: 'fallback'
            };
        }
        return null;
    }

    // =========================================================================
    // 3. TẠO LƯỚI THÍCH ỨNG ĐỒNG TÂM ĐA CẤP (1m → 2m → 4m → 8m)
    // =========================================================================

    static macDinhPhamViLuoi() {
        return {
            xMin: this.OUTER_X_MIN,
            xMax: this.OUTER_X_MAX,
            yMin: this.OUTER_Y_MIN,
            yMax: this.OUTER_Y_MAX
        };
    }

    static tinhPhamViLuoi(boxes = [], margin = 16, maxHalfExtent = 240) {
        let reqXMin = this.OUTER_X_MIN;
        let reqXMax = this.OUTER_X_MAX;
        let reqYMin = this.OUTER_Y_MIN;
        let reqYMax = this.OUTER_Y_MAX;

        for (const b of (boxes || [])) {
            if (!b) continue;
            const sp = b?.shape?.points || b?.points || b?.pts;
            const bx = Array.isArray(sp) ? Number(sp[0]) : Number(b.cx);
            const by = Array.isArray(sp) ? Number(sp[1]) : Number(b.cy);
            if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
            const lVal = Array.isArray(sp) ? (Number(sp[6]) || 4) : (Number(b.L) || 4);
            const wVal = Array.isArray(sp) ? (Number(sp[7]) || 2) : (Number(b.W) || 2);
            const span = 0.5 * Math.hypot(Math.abs(lVal), Math.abs(wVal));
            reqXMin = Math.min(reqXMin, bx - span - margin);
            reqXMax = Math.max(reqXMax, bx + span + margin);
            reqYMin = Math.min(reqYMin, by - span - margin);
            reqYMax = Math.max(reqYMax, by + span + margin);
        }

        const xMin = -Math.min(maxHalfExtent, Math.max(-this.OUTER_X_MIN, Math.ceil((-reqXMin) / this.OUTER_DX) * this.OUTER_DX));
        const xMax = Math.min(maxHalfExtent, Math.max(this.OUTER_X_MAX, Math.ceil(reqXMax / this.OUTER_DX) * this.OUTER_DX));
        const yMin = -Math.min(maxHalfExtent, Math.max(-this.OUTER_Y_MIN, Math.ceil((-reqYMin) / this.OUTER_DY) * this.OUTER_DY));
        const yMax = Math.min(maxHalfExtent, Math.max(this.OUTER_Y_MAX, Math.ceil(reqYMax / this.OUTER_DY) * this.OUTER_DY));
        return { xMin, xMax, yMin, yMax };
    }

    /**
     * Sinh lưới đồng tâm đa cấp theo bảng ZONES.
     * Trả về { tiles, levels, ext } — levels[k] = { k, s, xLo, xHi, yLo, yHi, nx, ny, arr } với arr là mảng dày
     * (lỗ giữa thuộc vùng trong = null) để tra ô O(1) qua getAtGrid().
     */
    static taoDanhSachOLuoi(ext = null, zones = null) {
        const Z = zones || this.ZONES;
        const raw = ext || this.macDinhPhamViLuoi();
        // Ép biên ext ra bội của ô lớn nhất để vùng cuối không bị cắt lửng
        const sMax = Z[Z.length - 1].s;
        const bounds = {
            xMin: Math.floor(raw.xMin / sMax) * sMax,
            xMax: Math.ceil(raw.xMax / sMax) * sMax,
            yMin: Math.floor(raw.yMin / sMax) * sMax,
            yMax: Math.ceil(raw.yMax / sMax) * sMax
        };
        const tiles = [];
        const levels = [];

        const makeTile = (x0, x1, y0, y1, tier, extra) => {
            const cx = 0.5 * (x0 + x1);
            const cy = 0.5 * (y0 + y1);
            return Object.assign({
                id: '',
                x0, x1, y0, y1,
                cx, cy,
                w: x1 - x0,
                h: y1 - y0,
                dist: Math.hypot(cx, cy),
                tier, // 'near' | 'mid' | 'far' | 'outer' | 'sub'
                zone: -1,
                s: x1 - x0,
                isOuter: (x1 - x0) >= 4, // Ô thưa tia (≥4m, ngoài 28m): khoá độ nghiêng mạnh, không tách bó vỉa
                rawPts: [],
                stratPts: null,
                nbrs: null,
                pts: [],
                aboveCount: 0,
                type: 'road',          // 'road' | 'sidewalk'
                source: 'extrapolated',// 'seed' | 'measured' | 'sparse' | 'extrapolated' | 'manual'
                visible: false,
                solved: false,
                manual: false,
                zc: -1.8,
                gx: 0,
                gy: 0,
                tw: 0,
                fitZc: -1.8,
                fitGx: 0,
                fitGy: 0,
                confidence: 0,
                rms: 0,
                nGroundPts: 0,
                layerId: null
            }, extra);
        };

        let prevHalf = 0;
        for (let k = 0; k < Z.length; k++) {
            const zc = Z[k];
            const s = zc.s;
            const isLast = (k === Z.length - 1);
            // Vùng cuối trải hết ext; vùng trong cắt theo ext (phòng khi ext hẹp hơn half)
            const xLo = isLast ? bounds.xMin : Math.max(bounds.xMin, -zc.half);
            const xHi = isLast ? bounds.xMax : Math.min(bounds.xMax, zc.half);
            const yLo = isLast ? bounds.yMin : Math.max(bounds.yMin, -zc.half);
            const yHi = isLast ? bounds.yMax : Math.min(bounds.yMax, zc.half);
            const nx = Math.max(0, Math.round((xHi - xLo) / s));
            const ny = Math.max(0, Math.round((yHi - yLo) / s));
            const arr = new Array(nx * ny).fill(null);
            for (let ix = 0; ix < nx; ix++) {
                const x0 = xLo + ix * s, x1 = x0 + s;
                for (let iy = 0; iy < ny; iy++) {
                    const y0 = yLo + iy * s, y1 = y0 + s;
                    const cx = 0.5 * (x0 + x1), cy = 0.5 * (y0 + y1);
                    // Ô nằm trọn trong vùng trước (đã căn chỉnh nên tâm trong ⇔ cả ô trong) → bỏ, để lại lỗ null
                    if (k > 0 && Math.abs(cx) < prevHalf && Math.abs(cy) < prevHalf) continue;
                    const t = makeTile(x0, x1, y0, y1, zc.id, { zone: k, gi: Math.round(x0 / s), gj: Math.round(y0 / s) });
                    t.id = `Z${k}_${t.gi}_${t.gj}`;
                    arr[ix * ny + iy] = t;
                    tiles.push(t);
                }
            }
            levels.push({ k, s, xLo, xHi, yLo, yHi, nx, ny, inv: 1.0 / s, arr });
            prevHalf = zc.half;
        }

        return { tiles, levels, ext: bounds };
    }

    /** Tra ô O(1) đa cấp: vùng đầu tiên chứa (x, y) theo nửa khoảng [lo, hi). */
    static getAtGrid(grid, x, y) {
        const L = grid.levels;
        for (let k = 0; k < L.length; k++) {
            const lv = L[k];
            if (x >= lv.xLo && x < lv.xHi && y >= lv.yLo && y < lv.yHi) {
                const ix = Math.min(lv.nx - 1, ((x - lv.xLo) * lv.inv) | 0);
                const iy = Math.min(lv.ny - 1, ((y - lv.yLo) * lv.inv) | 0);
                const t = lv.arr[ix * lv.ny + iy];
                if (t) return t;
            }
        }
        return null;
    }

    /**
     * Dựng kề cận chính xác cho lưới đa cấp:
     * - Băm đoạn cạnh đơn vị 1m: hai ô chung ≥ 1 đoạn ⇒ kề cạnh (edgeNbrs).
     * - Băm điểm góc: hai ô chỉ chạm nhau tại 1 góc ⇒ kề chéo.
     * t.nbrs = kề cạnh ∪ kề chéo (giữ ngữ nghĩa lân cận 8 hướng của v3), t.edgeNbrs = Set kề cạnh.
     */
    static dungKeCanLuoi(tiles) {
        const segMap = new Map();
        const cornerMap = new Map();
        const push = (m, k, t) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(t); };
        for (const t of tiles) {
            for (let x = t.x0; x < t.x1; x++) { push(segMap, `h${x}_${t.y0}`, t); push(segMap, `h${x}_${t.y1}`, t); }
            for (let y = t.y0; y < t.y1; y++) { push(segMap, `v${t.x0}_${y}`, t); push(segMap, `v${t.x1}_${y}`, t); }
            push(cornerMap, `${t.x0}_${t.y0}`, t); push(cornerMap, `${t.x1}_${t.y0}`, t);
            push(cornerMap, `${t.x0}_${t.y1}`, t); push(cornerMap, `${t.x1}_${t.y1}`, t);
            t.nbrs = [];
            t.edgeNbrs = new Set();
        }
        for (const arr of segMap.values()) {
            if (arr.length < 2) continue;
            for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) {
                if (i !== j) arr[i].edgeNbrs.add(arr[j]);
            }
        }
        for (const t of tiles) {
            const seen = new Set(t.edgeNbrs);
            for (const n of t.edgeNbrs) t.nbrs.push(n);
            for (const k of [`${t.x0}_${t.y0}`, `${t.x1}_${t.y0}`, `${t.x0}_${t.y1}`, `${t.x1}_${t.y1}`]) {
                const arr = cornerMap.get(k);
                if (!arr) continue;
                for (const n of arr) {
                    if (n !== t && !seen.has(n)) { seen.add(n); t.nbrs.push(n); }
                }
            }
        }
    }

    static taoDanhSachOChuNhat() {
        return this.taoDanhSachOLuoi().tiles;
    }

    // =========================================================================
    // 4. THUẬT TOÁN TÁI TẠO MẶT ĐƯỜNG & VỈA HÈ TOÀN BẢN ĐỒ (V3 WATERTIGHT)
    // =========================================================================

    static timMatPhangGocRobust(pts) {
        if (!pts || pts.length < 20) return null;
        const cellMap = new Map();
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p[0] * p[0] + p[1] * p[1] > 144.0) continue;
            const key = `${Math.floor(p[0])}_${Math.floor(p[1])}`;
            let arr = cellMap.get(key);
            if (!arr) { arr = []; cellMap.set(key, arr); }
            arr.push(p);
        }

        const binSize = 0.035;
        const lo = -3.8, hi = 2.0;
        const numBins = Math.ceil((hi - lo) / binSize);
        const histVotes = new Float64Array(numBins);

        for (const cPts of cellMap.values()) {
            if (cPts.length < 2) continue;
            const p0 = cPts[0];
            const d = Math.hypot(p0[0], p0[1]);
            const w = 1.0 / (1.0 + 0.08 * d);
            const seenBins = new Set();
            for (let i = 0; i < cPts.length; i++) {
                const b = Math.floor((cPts[i][2] - lo) / binSize);
                if (b >= 0 && b < numBins && !seenBins.has(b)) {
                    seenBins.add(b);
                    histVotes[b] += w;
                }
            }
        }

        const winVotes = new Float64Array(numBins);
        let globalMaxWin = 0;
        for (let b = 0; b < numBins; b++) {
            const w = histVotes[b] + (b > 0 ? histVotes[b - 1] : 0) + (b + 1 < numBins ? histVotes[b + 1] : 0);
            winVotes[b] = w;
            if (w > globalMaxWin) globalMaxWin = w;
        }
        if (globalMaxWin <= 0) return null;

        let chosenB = -1;
        for (let b = 0; b < numBins; b++) {
            if (histVotes[b] >= 1.5 && winVotes[b] >= 0.35 * globalMaxWin) { chosenB = b; break; }
        }
        if (chosenB < 0) {
            let best = -1;
            for (let b = 0; b < numBins; b++) if (winVotes[b] > best) { best = winVotes[b]; chosenB = b; }
        }

        let peakB = chosenB, bestLocal = winVotes[chosenB];
        for (let b = chosenB + 1; b < Math.min(numBins, chosenB + 3); b++) {
            if (winVotes[b] < bestLocal * 0.55) break;
            if (winVotes[b] > bestLocal) { bestLocal = winVotes[b]; peakB = b; }
        }

        const zEst = lo + (peakB + 0.5) * binSize;
        const inliers = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            if (p[0] * p[0] + p[1] * p[1] <= 81.0 && Math.abs(p[2] - zEst) <= 0.10) inliers.push(p);
        }
        if (inliers.length < 10) return { z0: zEst, gx: 0, gy: 0 };

        const fit = this.fitRegularizedPlane(inliers, 0, 0, 0, 0, zEst, 6.0, 0.2);
        if (!fit) return { z0: zEst, gx: 0, gy: 0 };
        fit.gx = this.clamp(fit.gx, -0.08, 0.08);
        fit.gy = this.clamp(fit.gy, -0.08, 0.08);

        const tight = inliers.filter(p => Math.abs(p[2] - (fit.zc + fit.gx * p[0] + fit.gy * p[1])) <= 0.045);
        if (tight.length >= 12) {
            const fit2 = this.fitRegularizedPlane(tight, 0, 0, fit.gx, fit.gy, fit.zc, 3.0, 0.05);
            if (fit2) {
                fit.zc = fit2.zc;
                fit.gx = this.clamp(fit2.gx, -0.10, 0.10);
                fit.gy = this.clamp(fit2.gy, -0.10, 0.10);
            }
        }
        return { z0: fit.zc, gx: fit.gx, gy: fit.gy };
    }

    /**
     * [CHẶN LEO XE] Điểm (x, y) có nằm trong footprint cuboid ĐÃ XOAY rz (nới thêm lề m) không.
     * Chuyển về hệ trục hộp bằng phép quay −rz: u = dx·c − dy·s, v = dx·s + dy·c (c, s = cos/sin(−rz)).
     */
    static diemTrongFootprint(x, y, br, m = 0) {
        const c = Number.isFinite(br.cos) ? br.cos : Math.cos(-(br.rz || 0));
        const s = Number.isFinite(br.sin) ? br.sin : Math.sin(-(br.rz || 0));
        const dx = x - br.bx, dy = y - br.by;
        const u = dx * c - dy * s;
        const v = dx * s + dy * c;
        return Math.abs(u) <= 0.5 * br.bL + m && Math.abs(v) <= 0.5 * br.bW + m;
    }

    /**
     * [CHẶN LEO XE] Lưới cột 0.25m trong ô: bin là "cột vật thể" nếu có ≥ 2 điểm cao hơn đáy bin ≥ 0.40m (trong 2m trên đáy).
     * Đáy bin = điểm thấp thứ 2 (bền với 1 điểm nhiễu dưới đất). Bó vỉa 15cm / dốc không tạo cột; thân xe, lốp, cột đèn tạo cột.
     * Tính 1 lần / ô (không phụ thuộc zPred) và cache trong t._cot.
     */
    static tinhCotVatThe(t) {
        if (t._cot) return t._cot;
        const raw = t.rawPts || [];
        const B = this.COT_BIN, H = this.COT_CAO;
        const nx = Math.max(1, Math.round(t.w / B)), ny = Math.max(1, Math.round(t.h / B));
        const n = nx * ny;
        const invW = nx / t.w, invH = ny / t.h;
        const binOf = (p) => Math.min(nx - 1, Math.max(0, ((p[0] - t.x0) * invW) | 0)) * ny
            + Math.min(ny - 1, Math.max(0, ((p[1] - t.y0) * invH) | 0));
        const z1 = new Float64Array(n).fill(Infinity), z2 = new Float64Array(n).fill(Infinity);
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i], b = binOf(p), z = p[2];
            if (z < z1[b]) { z2[b] = z1[b]; z1[b] = z; }
            else if (z < z2[b]) z2[b] = z;
        }
        const nHigh = new Int32Array(n);
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i], b = binOf(p);
            const base = z2[b];
            if (!Number.isFinite(base)) continue;
            const dz = p[2] - base;
            if (dz >= H && dz <= 2.0) nHigh[b]++;
        }
        const isCol = new Uint8Array(n);
        for (let b = 0; b < n; b++) if (nHigh[b] >= 2) isCol[b] = 1;
        t._cot = { nx, ny, invW, invH, isCol, binOf };
        return t._cot;
    }

    static stratifyPoints(t) {
        const raw = t.rawPts;
        if (!raw || raw.length <= 160) return raw;
        const bins = new Array(16);
        for (let b = 0; b < 16; b++) bins[b] = [];
        const invW = 4.0 / t.w, invH = 4.0 / t.h;
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            const bx = Math.min(3, Math.max(0, ((p[0] - t.x0) * invW) | 0));
            const by = Math.min(3, Math.max(0, ((p[1] - t.y0) * invH) | 0));
            bins[bx * 4 + by].push(p);
        }
        const out = [];
        for (let b = 0; b < 16; b++) {
            const arr = bins[b];
            if (arr.length <= 12) {
                for (let k = 0; k < arr.length; k++) out.push(arr[k]);
            } else {
                const step = arr.length / 12;
                for (let k = 0; k < 12; k++) out.push(arr[(k * step) | 0]);
            }
        }
        return out;
    }

    static extractGroundStratifiedPoints(t, zPred, gxPred, gyPred, rMin, rMax) {
        const raw = t.rawPts;
        if (!raw || raw.length <= 160) return raw || [];
        const gN = (!t.isOuter && t.dist < 14.0) ? 8 : 4;
        const nCells = gN * gN;
        const bins = new Array(nCells);
        const rBins = new Array(nCells);
        for (let b = 0; b < nCells; b++) { bins[b] = []; rBins[b] = []; }

        const invW = gN / t.w, invH = gN / t.h;
        const rTop = rMax + 0.45;
        for (let i = 0; i < raw.length; i++) {
            const p = raw[i];
            const r = p[2] - (zPred + gxPred * (p[0] - t.cx) + gyPred * (p[1] - t.cy));
            if (r < rMin || r > rTop) continue;
            const bx = Math.min(gN - 1, Math.max(0, ((p[0] - t.x0) * invW) | 0));
            const by = Math.min(gN - 1, Math.max(0, ((p[1] - t.y0) * invH) | 0));
            const idxB = bx * gN + by;
            bins[idxB].push(p);
            rBins[idxB].push(r);
        }

        const cap = gN === 8 ? 5 : 14;
        const capLow = Math.max(2, cap - 2);
        const bs = 0.04;
        const nHB = Math.max(2, Math.ceil((rTop - rMin) / bs) + 1);
        const out = [];

        for (let b = 0; b < nCells; b++) {
            const arr = bins[b], rArr = rBins[b];
            if (arr.length === 0) continue;
            if (arr.length <= cap) {
                for (let k = 0; k < arr.length; k++) out.push(arr[k]);
                continue;
            }
            const hb = new Int32Array(nHB);
            for (let k = 0; k < rArr.length; k++) {
                const bin = Math.min(nHB - 1, Math.max(0, Math.floor((rArr[k] - rMin) / bs)));
                hb[bin]++;
            }
            let maxW = 0;
            for (let k = 0; k < nHB; k++) {
                const w = hb[k] + (k > 0 ? hb[k - 1] : 0) + (k + 1 < nHB ? hb[k + 1] : 0);
                if (w > maxW) maxW = w;
            }
            const minCellReq = Math.max(3, Math.min(18, Math.ceil(0.20 * maxW)));
            let floorB = -1, bestFallback = -1, bestFallbackW = -1;
            for (let k = 0; k < nHB; k++) {
                const w = hb[k] + (k > 0 ? hb[k - 1] : 0) + (k + 1 < nHB ? hb[k + 1] : 0);
                if (w > bestFallbackW) { bestFallbackW = w; bestFallback = k; }
                if (hb[k] >= 2 && w >= minCellReq) { floorB = k; break; }
            }
            if (floorB < 0) floorB = Math.max(0, bestFallback);
            const rFloor = rMin + (floorB + 0.5) * bs;

            const lowIdx = [], hiIdx = [];
            for (let k = 0; k < rArr.length; k++) {
                if (rArr[k] <= rFloor + 0.10) lowIdx.push(k);
                else hiIdx.push(k);
            }
            if (lowIdx.length > 0) {
                if (lowIdx.length <= capLow) {
                    for (let k = 0; k < lowIdx.length; k++) out.push(arr[lowIdx[k]]);
                } else {
                    const step = lowIdx.length / capLow;
                    for (let k = 0; k < capLow; k++) out.push(arr[lowIdx[(k * step) | 0]]);
                }
                const hiCap = Math.min(hiIdx.length, 2);
                if (hiCap > 0) {
                    const hStep = hiIdx.length / hiCap;
                    for (let k = 0; k < hiCap; k++) out.push(arr[hiIdx[(k * hStep) | 0]]);
                }
            } else {
                const step = arr.length / cap;
                for (let k = 0; k < cap; k++) out.push(arr[(k * step) | 0]);
            }
        }
        return out;
    }

    static timCumMatDatTrongO(t, zPred, gxPred, gyPred, maxStepDown, maxStepUp, hasBoxCover = false, boxRects = null) {
        const strat = t.stratPts || (t.stratPts = this.stratifyPoints(t));
        const rMin = -maxStepDown, rMax = maxStepUp;
        let above = 0;
        if (strat) {
            for (let i = 0; i < strat.length; i++) {
                const p = strat[i];
                const r = p[2] - (zPred + gxPred * (p[0] - t.cx) + gyPred * (p[1] - t.cy));
                if (r > rMax + 0.45 && r <= rMax + 2.1) above++;
            }
        }
        t.aboveCount = above;

        const pts = (t.rawPts && t.rawPts.length > 160)
            ? this.extractGroundStratifiedPoints(t, zPred, gxPred, gyPred, rMin, rMax)
            : strat;
        if (!pts || pts.length < 2) return null;

        const binStep = 0.035;
        const nB = Math.max(2, Math.ceil((rMax - rMin + 0.05) / binStep));
        const hist = new Int32Array(nB);

        const resR = new Float64Array(pts.length);
        const keepIdx = [];
        let inWindowCount = 0;

        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const r = p[2] - (zPred + gxPred * (p[0] - t.cx) + gyPred * (p[1] - t.cy));
            resR[i] = r;
            if (r >= rMin && r <= rMax + 0.45) {
                keepIdx.push(i);
                if (r <= rMax) {
                    inWindowCount++;
                    const b = Math.min(nB - 1, Math.max(0, Math.floor((r - rMin) / binStep)));
                    hist[b]++;
                }
            }
        }
        const minAbsPts = (pts.length >= 25) ? 4 : (pts.length >= 8 ? 3 : 2);
        // [CHẶN LEO XE] Không có cụm đất trong dải lõi [−0.10, +0.10] quanh zPred mà phía trên có vật đặc ⇒ ô vật cản
        // (gầm xe chỉ còn bậu cửa/cản/đáy lốp). Đánh dấu để nội suy Laplace, KHÔNG fit.
        let coreWinMax10 = 0;
        for (let b = 0; b < nB; b++) {
            const rb = rMin + (b + 0.5) * binStep;
            if (rb < -0.10 || rb > 0.10) continue;
            const w = hist[b] + (b > 0 ? hist[b - 1] : 0) + (b + 1 < nB ? hist[b + 1] : 0);
            if (w > coreWinMax10) coreWinMax10 = w;
        }
        if (coreWinMax10 < minAbsPts && above >= 6) { t.occlHint = true; return null; }
        if (inWindowCount < 2) return null;

        const win = new Int32Array(nB);
        let maxWin = 0;
        let coreWinMax = 0;
        for (let b = 0; b < nB; b++) {
            const w = hist[b] + (b > 0 ? hist[b - 1] : 0) + (b + 1 < nB ? hist[b + 1] : 0);
            win[b] = w;
            if (w > maxWin) maxWin = w;
            const rb = rMin + (b + 0.5) * binStep;
            if (rb >= -0.08 && rb <= 0.14 && w > coreWinMax) coreWinMax = w;
        }

        let chosenB = -1;
        for (let b = 0; b < nB; b++) {
            if (hist[b] < 1) continue;
            const rb = rMin + (b + 0.5) * binStep;
            const refMax = (rb < -0.06) ? maxWin : Math.max(minAbsPts, coreWinMax || maxWin * 0.35);
            // Bảo vệ cụm đường chính quanh zPred: chỉ cho phép nhảy xuống cụm thấp (>6cm dưới zPred) nếu cụm thấp thực sự áp đảo
            const negFrac = (coreWinMax > 0.35 * maxWin) ? 0.70 : 0.25;
            const minReq = Math.max(minAbsPts, (rb < -0.06 ? negFrac : 0.18) * refMax);
            if (win[b] >= minReq) { chosenB = b; break; }
        }
        if (chosenB < 0) return null;

        let peakB = chosenB, bestW = win[chosenB];
        for (let b = chosenB + 1; b < Math.min(nB, chosenB + 3); b++) {
            if (win[b] < bestW * 0.55) break;
            if (win[b] > bestW) { bestW = win[b]; peakB = b; }
        }
        const rPeak = rMin + (peakB + 0.5) * binStep;

        const initBand = t.isOuter ? 0.095 : 0.115;
        const candPts = [];
        for (let k = 0; k < keepIdx.length; k++) {
            const idx = keepIdx[k];
            if (Math.abs(resR[idx] - rPeak) <= initBand) candPts.push(pts[idx]);
        }
        if (candPts.length < 2) return null;

        // [CHẶN LEO XE] Kiểm tra cột đứng: mặt đất thật không có vật đặc ngay trên; bậu cửa/cản/đáy lốp thì có thân xe phía trên.
        const cot = this.tinhCotVatThe(t);
        let nCol = 0;
        for (let k = 0; k < candPts.length; k++) if (cot.isCol[cot.binOf(candPts[k])]) nCol++;
        const colFrac = nCol / candPts.length;
        if (rPeak > 0.05 && (colFrac >= 0.5 || above >= Math.max(6, 0.6 * inWindowCount))) {
            t.occlHint = true;
            return null;
        }

        const stats = this.tinhThongKePhanBoXY(candPts, t.cx, t.cy);
        const centroidEcc = Math.hypot(stats.meanDx / (0.5 * t.w), stats.meanDy / (0.5 * t.h));
        const minLam = this.minLambdaTheoKichThuoc(Math.min(t.w, t.h));
        const regSlope = (stats.lambdaMin < minLam || centroidEcc > 0.65 || candPts.length < 12)
            ? (t.isOuter ? 65.0 : 28.0) : Math.max(3.0, 2.5 + 8.0 * centroidEcc * centroidEcc);
        const regZ = (candPts.length < 8) ? 0.35 : 0.06;

        const fit = this.fitRegularizedPlane(candPts, t.cx, t.cy, gxPred, gyPred, zPred + rPeak, regSlope, regZ);
        if (!fit) return null;
        const DOC_MAX = this.DOC_MAX;
        fit.gx = this.clamp(fit.gx, -DOC_MAX, DOC_MAX);
        fit.gy = this.clamp(fit.gy, -DOC_MAX, DOC_MAX);

        let tightPts = [];
        let sumSqErr = 0;
        if (!t.isOuter && t.dist < 14.0 && t.rawPts && t.rawPts.length > 160) {
            const invW8 = 8.0 / t.w, invH8 = 8.0 / t.h;
            const cBins = new Array(64);
            for (let b = 0; b < 64; b++) cBins[b] = [];
            for (let k = 0; k < t.rawPts.length; k++) {
                const p = t.rawPts[k];
                const e = p[2] - (fit.zc + fit.gx * (p[0] - t.cx) + fit.gy * (p[1] - t.cy));
                if (Math.abs(e) <= 0.048) {
                    const bx = Math.min(7, Math.max(0, ((p[0] - t.x0) * invW8) | 0));
                    const by = Math.min(7, Math.max(0, ((p[1] - t.y0) * invH8) | 0));
                    cBins[bx * 8 + by].push(p);
                }
            }
            for (let b = 0; b < 64; b++) {
                const arr = cBins[b];
                if (arr.length <= 5) {
                    for (let k = 0; k < arr.length; k++) tightPts.push(arr[k]);
                } else {
                    const step = arr.length / 5;
                    for (let k = 0; k < 5; k++) tightPts.push(arr[(k * step) | 0]);
                }
            }
            for (let k = 0; k < tightPts.length; k++) {
                const p = tightPts[k];
                const e = p[2] - (fit.zc + fit.gx * (p[0] - t.cx) + fit.gy * (p[1] - t.cy));
                sumSqErr += e * e;
            }
        }
        if (tightPts.length < 6) {
            tightPts = [];
            sumSqErr = 0;
            for (let k = 0; k < keepIdx.length; k++) {
                const p = pts[keepIdx[k]];
                const e = p[2] - (fit.zc + fit.gx * (p[0] - t.cx) + fit.gy * (p[1] - t.cy));
                if (Math.abs(e) <= 0.05) {
                    tightPts.push(p);
                    sumSqErr += e * e;
                }
            }
        }
        let rms = tightPts.length ? Math.sqrt(sumSqErr / tightPts.length) : 0.05;

        if (tightPts.length >= 6) {
            const st2 = this.tinhThongKePhanBoXY(tightPts, t.cx, t.cy);
            const ecc2 = Math.hypot(st2.meanDx / (0.5 * t.w), st2.meanDy / (0.5 * t.h));
            const regS2 = (st2.lambdaMin < minLam || ecc2 > 0.60) ? (t.isOuter ? 65.0 : 30.0) : Math.max(2.5, 2.0 + 10.0 * ecc2 * ecc2);
            const fit2 = this.fitRegularizedPlane(tightPts, t.cx, t.cy, gxPred, gyPred, fit.zc, regS2, 0.04);
            if (fit2) {
                fit.zc = fit2.zc;
                fit.gx = this.clamp(fit2.gx, -DOC_MAX, DOC_MAX);
                fit.gy = this.clamp(fit2.gy, -DOC_MAX, DOC_MAX);
                let s2 = 0;
                for (let k = 0; k < tightPts.length; k++) {
                    const p = tightPts[k];
                    const e = p[2] - (fit.zc + fit.gx * (p[0] - t.cx) + fit.gy * (p[1] - t.cy));
                    s2 += e * e;
                }
                rms = Math.sqrt(s2 / tightPts.length);
            }
        }

        let curbSplit = null;
        if (!t.isOuter && !hasBoxCover && t.dist > 3.0 && above <= Math.max(4, keepIdx.length * 0.40) && keepIdx.length >= 10) {
            const lowIdx = [], upIdx = [];
            for (let k = 0; k < keepIdx.length; k++) {
                const idx = keepIdx[k], r = resR[idx];
                if (r >= -0.065 && r <= 0.065) lowIdx.push(idx);
                else if (r >= 0.065 && r <= 0.35) {
                    if (boxRects && boxRects.length > 0) {
                        const p = pts[idx];
                        let insideVehicle = false;
                        for (let bi = 0; bi < boxRects.length; bi++) {
                            const br = boxRects[bi];
                            const dx = p[0] - br.bx, dy = p[1] - br.by;
                            const cosR = Math.cos(-(br.rz || 0)), sinR = Math.sin(-(br.rz || 0));
                            const u = dx * cosR - dy * sinR;
                            const v = dx * sinR + dy * cosR;
                            if (Math.abs(u) <= 0.48 * br.bL && Math.abs(v) <= 0.48 * br.bW) {
                                insideVehicle = true;
                                break;
                            }
                        }
                        if (insideVehicle) continue;
                    }
                    upIdx.push(idx);
                }
            }
            if (lowIdx.length >= 4 && upIdx.length >= 4) {
                const lowR = lowIdx.map(idx => resR[idx]);
                const upR = upIdx.map(idx => resR[idx]);
                const lZ = this.median(lowR), uZ = this.median(upR);
                if (uZ - lZ >= 0.070 && uZ - lZ <= 0.35) {
                    let uSq = 0, lSq = 0, gapCount = 0;
                    const gapPts = [];
                    for (let k = 0; k < upR.length; k++) uSq += (upR[k] - uZ) * (upR[k] - uZ);
                    for (let k = 0; k < lowR.length; k++) lSq += (lowR[k] - lZ) * (lowR[k] - lZ);
                    for (let k = 0; k < keepIdx.length; k++) {
                        const r = resR[keepIdx[k]];
                        if (r > lZ + 0.035 && r < uZ - 0.035) { gapCount++; gapPts.push(pts[keepIdx[k]]); }
                    }
                    const uRms = Math.sqrt(uSq / upR.length), lRms = Math.sqrt(lSq / lowR.length);
                    // Điểm mặt đứng bó vỉa (rơi vào khe) ∝ chiều dài bó vỉa qua ô ~ s, điểm mặt đất ∝ s² ⇒ tỉ lệ khe ∝ 1/s.
                    // Giữ 6% cho ô ≥ 2m như v3, nới 12% cho ô 1m (dốc liên tục cho ~50% điểm trong khe nên vẫn bị loại).
                    let gapFrac = 0.06 * (2 / Math.max(1, Math.min(2, Math.min(t.w, t.h))));
                    // Điểm khe tạo DẢI MỎNG (√λ_min ≤ 6cm) ⇒ là mặt đứng bó vỉa, không phải dốc thoải (dốc trải đều cả ô, σ ≈ 0.29·w)
                    // ⇒ nới giới hạn khe lên 35% (ở góc tia xiên, mặt đứng 15cm có thể chiếm ~20% điểm của ô 1m).
                    if (gapPts.length >= 3) {
                        const gSt = this.tinhThongKePhanBoXY(gapPts, t.cx, t.cy);
                        if (Math.sqrt(Math.max(0, gSt.lambdaMin)) <= 0.06) gapFrac = Math.max(gapFrac, 0.35);
                    }
                    if (uRms <= 0.035 && lRms <= 0.035 && gapCount <= Math.max(2, gapFrac * (lowIdx.length + upIdx.length))) {
                        let lx = 0, ly = 0, ux = 0, uy = 0;
                        for (const idx of lowIdx) { lx += pts[idx][0]; ly += pts[idx][1]; }
                        for (const idx of upIdx) { ux += pts[idx][0]; uy += pts[idx][1]; }
                        lx /= lowIdx.length; ly /= lowIdx.length; ux /= upIdx.length; uy /= upIdx.length;
                        const dxM = Math.abs(ux - lx), dyM = Math.abs(uy - ly);

                        // CHỐNG NGHIÊNG: Khi phát hiện 2 tầng (đường + gờ), luôn fit mặt phẳng theo cụm thấp (lowFit)
                        const lowPts = lowIdx.map(idx => pts[idx]);
                        const lowFit = this.fitRegularizedPlane(lowPts, t.cx, t.cy, gxPred, gyPred, zPred + lZ, 16.0, 0.05);
                        if (lowFit) {
                            fit.zc = lowFit.zc;
                            fit.gx = this.clamp(lowFit.gx, -DOC_MAX, DOC_MAX);
                            fit.gy = this.clamp(lowFit.gy, -DOC_MAX, DOC_MAX);
                        }

                        // Chống tách giả do điểm MẶT ĐỨNG bó vỉa nằm sát mép ô (bó vỉa trùng đường lưới):
                        // cả 2 cụm phải trải rộng theo phương vuông góc đường cắt (σ ≥ 5cm), không phải một dải mỏng ~1cm.
                        const cutAxisIdx = dyM >= dxM ? 1 : 0;
                        const spreadPerp = (idxArr) => {
                            let m = 0, q = 0;
                            for (const idx of idxArr) { const u = pts[idx][cutAxisIdx]; m += u; q += u * u; }
                            m /= idxArr.length;
                            return Math.sqrt(Math.max(0, q / idxArr.length - m * m));
                        };
                        const notThinBand = spreadPerp(lowIdx) >= 0.05 && spreadPerp(upIdx) >= 0.05;
                        // Khoảng tách tâm 2 cụm: giữ 0.8m cho ô ≥ 2m như v3. Ô 1m: tách lý tưởng ≈ 0.5m nhưng điểm mặt đứng
                        // bó vỉa rơi vào cả 2 cụm kéo còn ~0.3m ⇒ ngưỡng 0.25·w (đã có chặn dải mỏng ở trên chống tách giả).
                        const minDimT = Math.min(t.w, t.h);
                        const sepMin = minDimT >= 2 ? 0.8 : 0.25 * minDimT;
                        if (notThinBand && Math.max(dxM, dyM) >= sepMin) {
                            const upPts = upIdx.map(idx => pts[idx]);
                            const strongCurb = (uRms <= 0.024 && lRms <= 0.024 && gapCount <= 1 && lowIdx.length >= 6 && upIdx.length >= 6);
                            curbSplit = {
                                axis: dyM >= dxM ? 'y' : 'x',
                                lZ: fit.zc, uZ: zPred + uZ,
                                lowerPts: lowPts,
                                upperPts: upPts,
                                strongCurb
                            };
                        }
                    }
                }
            }
        }

        return {
            fit,
            tightPts: tightPts.length >= 2 ? tightPts : candPts,
            rms,
            stepDelta: Math.abs(fit.zc - zPred),
            slopeDiff: Math.hypot(fit.gx - gxPred, fit.gy - gyPred),
            centroidEcc,
            lambdaMin: stats.lambdaMin,
            aboveCount: above,
            colFrac,
            curbSplit
        };
    }

    static sampleVertexGroundAnchor(v) {
        const zCand = [];
        const zRef = v.dataZ;
        for (let i = 0; i < v.tiles.length; i++) {
            // [CHẶN LEO XE] Ô bị che (gầm/thân xe) không có điểm đất tin cậy ⇒ không làm neo dữ liệu
            if (v.tiles[i].source === 'occluded') continue;
            const raw = v.tiles[i].pts;
            if (!raw) continue;
            for (let k = 0; k < raw.length; k++) {
                const p = raw[k];
                const d2 = (p[0] - v.x) * (p[0] - v.x) + (p[1] - v.y) * (p[1] - v.y);
                const dz = p[2] - zRef;
                if (d2 <= 1.25 && dz >= -0.10 && dz <= 0.06) zCand.push(p[2]);
            }
        }
        if (zCand.length < 4) return null;
        zCand.sort((a, b) => a - b);
        const zAnchor = zCand[Math.floor((zCand.length - 1) * 0.35)];
        return { z: zAnchor, w: Math.min(4.2, 0.35 * zCand.length) };
    }

    static stitchSameTypeGraph(tilesOfType, fallbackZ) {
        if (!tilesOfType || tilesOfType.length === 0) return;
        const vMap = new Map();
        const getV = (vx, vy) => {
            const key = `${vx}_${vy}`;
            let v = vMap.get(key);
            if (!v) {
                v = { key, x: vx, y: vy, tiles: [], z: 0, dataW: 0, dataZ: 0, isSolid: false, nbrs: [], hang: null };
                vMap.set(key, v);
            }
            return v;
        };

        for (const t of tilesOfType) {
            if (t.tier === 'sub') continue;
            for (const vx of [t.x0, t.x1]) {
                for (const vy of [t.y0, t.y1]) {
                    getV(vx, vy).tiles.push(t);
                }
            }
        }

        // ĐỈNH TREO TỔNG QUÁT (T-junction ở mọi ranh giới 1m|2m, 2m|4m, 4m|8m):
        // Đỉnh (x, y) là treo đối với ô t nếu nằm trong lòng một cạnh của t (không phải góc của t).
        // Mô hình song tuyến hạn chế lên cạnh là tuyến tính ⇒ ràng buộc z = (1-f)·z_A + f·z_B cho C0 chính xác.
        // Toạ độ ô là số nguyên (bội 1m) nên chỉ cần dò các điểm nguyên trong lòng cạnh.
        for (const t of tilesOfType) {
            if (t.tier === 'sub') continue;
            const edges = [
                [t.x0, t.y0, t.x1, t.y0], [t.x0, t.y1, t.x1, t.y1],
                [t.x0, t.y0, t.x0, t.y1], [t.x1, t.y0, t.x1, t.y1]
            ];
            for (const [ax, ay, bx, by] of edges) {
                const len = Math.round(Math.abs(bx - ax) + Math.abs(by - ay));
                if (len < 2) continue;
                const vA = vMap.get(`${ax}_${ay}`), vB = vMap.get(`${bx}_${by}`);
                if (!vA || !vB) continue;
                const sx = Math.sign(bx - ax), sy = Math.sign(by - ay);
                for (let d = 1; d < len; d++) {
                    const f = d / len;
                    const px = ax + sx * d, py = ay + sy * d; // cộng số nguyên: khoá băm chính xác, không sai số phẩy động
                    const vm = vMap.get(`${px}_${py}`);
                    if (vm && !vm.hang) vm.hang = { a: vA, b: vB, f };
                }
            }
        }

        for (const v of vMap.values()) {
            const pinnedTiles = v.tiles.filter(t => t.pinnedNeo);
            if (pinnedTiles.length > 0) {
                let zpSum = 0;
                for (const pt of pinnedTiles) {
                    zpSum += pt.fitZc + pt.fitGx * (v.x - pt.cx) + pt.fitGy * (v.y - pt.cy);
                }
                v.isSolid = true;
                v.pinnedNeo = true;
                v.dataW = 1000.0 * pinnedTiles.length;
                v.dataZ = zpSum / pinnedTiles.length;
                v.z = v.dataZ;
                continue;
            }
            v.isSolid = v.tiles.some(t => t.source === 'seed' || t.source === 'measured');
            let minSolidZt = Infinity, maxSolidZt = -Infinity;
            const zPreds = new Array(v.tiles.length);
            for (let i = 0; i < v.tiles.length; i++) {
                const t = v.tiles[i];
                const zt = t.fitZc + t.fitGx * (v.x - t.cx) + t.fitGy * (v.y - t.cy);
                zPreds[i] = zt;
                if (t.source === 'seed' || t.source === 'measured') {
                    if (zt < minSolidZt) minSolidZt = zt;
                    if (zt > maxSolidZt) maxSolidZt = zt;
                }
            }
            let refSolidZ = minSolidZt;
            const hasStepJump = v.isSolid && (maxSolidZt - minSolidZt) > 0.09;
            if (hasStepJump) {
                // Lấy điểm thực tế (stratPts) quanh góc (v.x, v.y) để phân xử khi các ô ngoại suy lệch nhau >9cm
                const cPts = [];
                for (let i = 0; i < v.tiles.length; i++) {
                    if (v.tiles[i].source === 'occluded') continue;
                    const srcArr = v.tiles[i].stratPts || v.tiles[i].pts;
                    if (!srcArr) continue;
                    for (let k = 0; k < srcArr.length; k++) {
                        const p = srcArr[k];
                        const d2 = (p[0] - v.x) * (p[0] - v.x) + (p[1] - v.y) * (p[1] - v.y);
                        if (d2 <= 1.25 && p[2] >= minSolidZt - 0.08 && p[2] <= maxSolidZt + 0.06) cPts.push(p[2]);
                    }
                }
                let bestClusterScore = -1;
                for (let i = 0; i < v.tiles.length; i++) {
                    const ti = v.tiles[i];
                    if (ti.source !== 'seed' && ti.source !== 'measured') continue;
                    let score = 0;
                    for (let j = 0; j < v.tiles.length; j++) {
                        const tj = v.tiles[j];
                        if ((tj.source === 'seed' || tj.source === 'measured') && Math.abs(zPreds[j] - zPreds[i]) <= 0.06) {
                            score += (tj.source === 'seed' ? 4.0 : Math.max(0.5, tj.confidence || 1.0));
                        }
                    }
                    let cornerSupport = 0;
                    for (let k = 0; k < cPts.length; k++) {
                        if (Math.abs(cPts[k] - zPreds[i]) <= 0.05) cornerSupport++;
                    }
                    score += Math.min(8.0, 0.5 * cornerSupport);
                    if (score > bestClusterScore || (Math.abs(score - bestClusterScore) < 0.01 && zPreds[i] < refSolidZ)) {
                        bestClusterScore = score;
                        refSolidZ = zPreds[i];
                    }
                }
            }

            let wSum = 0, wzSum = 0;
            for (let i = 0; i < v.tiles.length; i++) {
                const t = v.tiles[i];
                const zt = zPreds[i];
                let w = Math.max(0.01, t.confidence || 0.02);
                const tSolid = (t.source === 'seed' || t.source === 'measured');
                if (v.isSolid && !tSolid) w *= 0.05;
                if (hasStepJump && Math.abs(zt - refSolidZ) > 0.085) w *= 0.08;
                wSum += w;
                wzSum += w * zt;
            }
            v.dataW = wSum;
            v.dataZ = wSum > 0 ? wzSum / wSum : fallbackZ;
            const anc = this.sampleVertexGroundAnchor(v);
            if (anc) {
                v.dataZ = (v.dataW * v.dataZ + anc.w * anc.z) / (v.dataW + anc.w);
                v.dataW += anc.w;
            }
            v.z = v.dataZ;
        }

        // Không vứt dữ liệu của đỉnh treo: thế z_m = (1-f)·z_A + f·z_B vào năng lượng bình phương
        // ⇒ chia trọng số dữ liệu w_m cho 2 góc cha theo (1-f, f) (dạng Lagrange). Chuỗi treo lồng nhau được đẩy tiếp lên cha.
        const pushDataToParents = (v, w, z, depth) => {
            if (!(w > 0)) return;
            if (!v.hang || depth > 6) {
                v.dataZ = (v.dataW * v.dataZ + w * z) / (v.dataW + w);
                v.dataW += w;
                return;
            }
            pushDataToParents(v.hang.a, w * (1 - v.hang.f), z, depth + 1);
            pushDataToParents(v.hang.b, w * v.hang.f, z, depth + 1);
        };
        for (const v of vMap.values()) {
            if (!v.hang) continue;
            pushDataToParents(v.hang.a, v.dataW * (1 - v.hang.f), v.dataZ, 1);
            pushDataToParents(v.hang.b, v.dataW * v.hang.f, v.dataZ, 1);
        }

        const addEdge = (a, b, wOnA, wOnB) => {
            if (!a || !b || a === b) return;
            for (let i = 0; i < a.nbrs.length; i++) if (a.nbrs[i].v === b) return;
            a.nbrs.push({ v: b, w: wOnA });
            b.nbrs.push({ v: a, w: wOnB });
        };

        for (const t of tilesOfType) {
            if (t.tier === 'sub') continue;
            const c00 = vMap.get(`${t.x0}_${t.y0}`), c10 = vMap.get(`${t.x1}_${t.y0}`);
            const c11 = vMap.get(`${t.x1}_${t.y1}`), c01 = vMap.get(`${t.x0}_${t.y1}`);
            const tSolid = (t.source === 'seed' || t.source === 'measured');
            const wire = (u, v) => {
                if (!u || !v || u === v) return;
                const jump = Math.abs(u.dataZ - v.dataZ) > 0.11;
                let wU, wV;
                if (!tSolid) {
                    wU = u.isSolid ? 0.002 : (jump ? 0.05 : 0.25);
                    wV = v.isSolid ? 0.002 : (jump ? 0.05 : 0.25);
                } else {
                    wU = u.isSolid ? (jump ? 0.003 : 0.015) : 0.15;
                    wV = v.isSolid ? (jump ? 0.003 : 0.015) : 0.15;
                }
                addEdge(u, v, wU, wV);
            };
            wire(c00, c10); wire(c10, c11); wire(c11, c01); wire(c01, c00);
        }

        const vList = Array.from(vMap.values());
        for (let iter = 0; iter < 28; iter++) {
            for (let i = 0; i < vList.length; i++) {
                const v = vList[i];
                if (v.pinnedNeo && !v.hang) continue;
                if (v.hang) { v.z = (1 - v.hang.f) * v.hang.a.z + v.hang.f * v.hang.b.z; continue; }
                let num = v.dataW * v.dataZ, den = v.dataW;
                for (let j = 0; j < v.nbrs.length; j++) {
                    const e = v.nbrs[j];
                    num += e.w * e.v.z;
                    den += e.w;
                }
                if (den > 1e-6) {
                    let nextZ = num / den;
                    if (v.isSolid && v.dataW > 0) {
                        const devLim = 0.018 + 0.035 / Math.max(0.5, v.dataW);
                        nextZ = this.clamp(nextZ, v.dataZ - devLim, v.dataZ + devLim);
                    }
                    v.z = nextZ;
                }
            }
        }
        // Chốt chính xác ràng buộc đỉnh treo sau Gauss-Seidel (kể cả chuỗi treo lồng nhau) ⇒ |z_m − nội suy cha| = 0
        for (let pass = 0; pass < 4; pass++) {
            for (let i = 0; i < vList.length; i++) {
                const v = vList[i];
                if (v.hang) v.z = (1 - v.hang.f) * v.hang.a.z + v.hang.f * v.hang.b.z;
            }
        }

        // Góc của ô con bó vỉa (sub): nếu trùng đỉnh lưới → lấy thẳng; nếu nằm trong lòng cạnh ô cha (toạ độ không nguyên
        // hoặc giữa 2 đỉnh) → nội suy tuyến tính giữa 2 đỉnh lưới gần nhất trên cạnh cha ⇒ C0 với ô kề mọi cấp.
        const cornerZForSub = (t, vx, vy, fallbackCornerZ) => {
            const exact = vMap.get(`${vx}_${vy}`);
            if (exact) return exact.z;
            const px0 = t.px0 ?? t.x0, px1 = t.px1 ?? t.x1, py0 = t.py0 ?? t.y0, py1 = t.py1 ?? t.y1;
            const interpAlong = (fixed, lo, hi, val, isVertical) => {
                const key = (u) => isVertical ? `${fixed}_${u}` : `${u}_${fixed}`;
                let a = Math.floor(val), b = Math.ceil(val);
                if (a === b) { a -= 1; b += 1; }
                while (a > lo && !vMap.has(key(a))) a -= 1;
                while (b < hi && !vMap.has(key(b))) b += 1;
                const vA = vMap.get(key(Math.max(a, lo))), vB = vMap.get(key(Math.min(b, hi)));
                if (!vA || !vB) return null;
                const ua = Math.max(a, lo), ub = Math.min(b, hi);
                if (ub - ua < 1e-9) return null;
                const frac = (val - ua) / (ub - ua);
                return (1 - frac) * vA.z + frac * vB.z;
            };
            if ((vx === px0 || vx === px1) && vy > py0 && vy < py1) {
                const z = interpAlong(vx, py0, py1, vy, true);
                if (z !== null) return z;
            }
            if ((vy === py0 || vy === py1) && vx > px0 && vx < px1) {
                const z = interpAlong(vy, px0, px1, vx, false);
                if (z !== null) return z;
            }
            return fallbackCornerZ;
        };

        const subTiles = tilesOfType.filter(t => t.tier === 'sub');
        const subCornerAcc = new Map();
        for (const t of subTiles) {
            for (const [cx, cy] of [[t.x0, t.y0], [t.x1, t.y0], [t.x1, t.y1], [t.x0, t.y1]]) {
                const k = `${cx}_${cy}`;
                const zRaw = this.evalTileZ(t, cx, cy);
                const zLocked = cornerZForSub(t, cx, cy, null);
                if (zLocked !== null) {
                    subCornerAcc.set(k, { sum: zLocked, cnt: 1, locked: true });
                } else {
                    let e = subCornerAcc.get(k);
                    if (!e) { e = { sum: 0, cnt: 0, locked: false }; subCornerAcc.set(k, e); }
                    if (!e.locked) { e.sum += zRaw; e.cnt++; }
                }
            }
        }

        for (const t of tilesOfType) {
            if (t.tier === 'sub') {
                const z00 = subCornerAcc.get(`${t.x0}_${t.y0}`);
                const z10 = subCornerAcc.get(`${t.x1}_${t.y0}`);
                const z11 = subCornerAcc.get(`${t.x1}_${t.y1}`);
                const z01 = subCornerAcc.get(`${t.x0}_${t.y1}`);
                const c00 = z00 ? z00.sum / z00.cnt : this.evalTileZ(t, t.x0, t.y0);
                const c10 = z10 ? z10.sum / z10.cnt : this.evalTileZ(t, t.x1, t.y0);
                const c11 = z11 ? z11.sum / z11.cnt : this.evalTileZ(t, t.x1, t.y1);
                const c01 = z01 ? z01.sum / z01.cnt : this.evalTileZ(t, t.x0, t.y1);
                t.zc = 0.25 * (c00 + c10 + c11 + c01);
                t.gx = ((c10 + c11) - (c00 + c01)) / (2 * t.w);
                t.gy = ((c01 + c11) - (c00 + c10)) / (2 * t.h);
                t.tw = 0.25 * (c00 - c10 + c11 - c01);
                continue;
            }
            const c00 = vMap.get(`${t.x0}_${t.y0}`)?.z ?? t.zc;
            const c10 = vMap.get(`${t.x1}_${t.y0}`)?.z ?? t.zc;
            const c11 = vMap.get(`${t.x1}_${t.y1}`)?.z ?? t.zc;
            const c01 = vMap.get(`${t.x0}_${t.y1}`)?.z ?? t.zc;
            t.zc = 0.25 * (c00 + c10 + c11 + c01);
            t.gx = ((c10 + c11) - (c00 + c01)) / (2 * t.w);
            t.gy = ((c01 + c11) - (c00 + c10)) / (2 * t.h);
            t.tw = 0.25 * (c00 - c10 + c11 - c01);
        }
    }

    static kiemDinhRoadSidewalk(data) {
        if (!data || !data.seedPlane) return { ok: true, dz: 0 };
        const sp = data.seedPlane;
        const e = [];
        let aR = 0, aS = 0, aR6 = 0, aS6 = 0;
        for (const t of (data.tiles || [])) {
            if (t.source === 'extrapolated' || t.source === 'occluded' || t.dist > 30) continue;
            const a = t.w * t.h;
            if (t.type === 'sidewalk') {
                aS += a;
                if (t.dist <= 6.0) aS6 += a;
                e.push(t.zc - (sp.z0 + sp.gx * t.cx + sp.gy * t.cy));
            } else {
                aR += a;
                if (t.dist <= 6.0) aR6 += a;
            }
        }
        const fracS = aS / Math.max(1e-6, aR + aS);
        return { ok: !(fracS >= 0.70 && aS6 >= aR6), dz: e.length ? this.median(e) : 0 };
    }

    static xayDungSurfaceBanDoAnToan(rawData, boxes = [], opts = {}) {
        const ext = this.tinhPhamViLuoi(boxes);
        let data = this.xayDungSurfaceBanDo(rawData, boxes, { ...opts, ext });
        let shift = 0;
        for (let k = 0; data && k < 2; k++) {
            const chk = this.kiemDinhRoadSidewalk(data);
            if (chk.ok || Math.abs(chk.dz) < 0.03) break;
            shift += chk.dz;
            const next = this.xayDungSurfaceBanDo(rawData, boxes, { ...opts, seedShift: shift, ext });
            if (!next) break;
            next.seedPlane.healed = k + 1;
            data = next;
        }
        return data;
    }

    static xayDungSurfaceBanDo(rawData, boxes = [], opts = {}) {
        if (!rawData) return null;

        // [CHẶN LEO XE] Cuboid đầy đủ: tâm (bx, by, bz), kích thước L×W×H, góc xoay rz (cos/sin của −rz tính sẵn)
        const boxRects = [];
        for (const b of (boxes || [])) {
            const sp = b?.shape?.points || b?.points || b?.pts || [b?.cx || 0, b?.cy || 0, Number.isFinite(b?.cz) ? b.cz : 0, 0, 0, 0, b?.L || 4, b?.W || 2, 1.5];
            const bx = +sp[0], by = +sp[1];
            if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
            const bz = Number.isFinite(+sp[2]) ? +sp[2] : 0;
            const bL = +sp[6] || 4, bW = +sp[7] || 2, bH = +sp[8] || 1.5;
            const rz = Number.isFinite(+sp[5]) ? +sp[5] : 0;
            const pad = Math.max(bL, bW) * 0.65 + 0.5;
            boxRects.push({ bx, by, bz, bL, bW, bH, rz, cos: Math.cos(-rz), sin: Math.sin(-rz), zDay: bz - 0.5 * bH, pad });
        }
        // Ô bị xe phủ: tâm ô nằm trong footprint ĐÃ XOAY của cuboid (thay luật 35% bỏ qua góc xoay)
        const tileCoveredByBox = (t) => {
            for (let i = 0; i < boxRects.length; i++) {
                if (this.diemTrongFootprint(t.cx, t.cy, boxRects[i], 0)) return true;
            }
            return false;
        };
        const ext = (opts && opts.ext) ? opts.ext : this.tinhPhamViLuoi(boxes);

        // Băm AABB (đã nới lề) của cuboid vào ô 4m ⇒ mỗi điểm chỉ thử các hộp cùng ô băm
        const MASK_LE = this.MASK_XE_LE, MASK_DAY = this.MASK_XE_DAY;
        const HB = 4.0;
        const hashKey = (ix, iy) => (ix + 32768) * 65536 + (iy + 32768);
        const boxHash = new Map();
        for (let i = 0; i < boxRects.length; i++) {
            const br = boxRects[i];
            const ac = Math.abs(br.cos), as = Math.abs(br.sin);
            const hx = ac * 0.5 * br.bL + as * 0.5 * br.bW + MASK_LE;
            const hy = as * 0.5 * br.bL + ac * 0.5 * br.bW + MASK_LE;
            const ix0 = Math.floor((br.bx - hx) / HB), ix1 = Math.floor((br.bx + hx) / HB);
            const iy0 = Math.floor((br.by - hy) / HB), iy1 = Math.floor((br.by + hy) / HB);
            if (ix1 - ix0 > 64 || iy1 - iy0 > 64) continue; // hộp lỗi kích thước bất thường
            for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) {
                const k = hashKey(ix, iy);
                let arr = boxHash.get(k);
                if (!arr) { arr = []; boxHash.set(k, arr); }
                arr.push(br);
            }
        }
        // Điểm thuộc thân xe: trong footprint (+10cm) VÀ không thấp hơn đáy hộp quá 5cm
        const diemThuocXe = (x, y, z) => {
            const arr = boxHash.get(hashKey(Math.floor(x / HB), Math.floor(y / HB)));
            if (!arr) return false;
            for (let i = 0; i < arr.length; i++) {
                const br = arr[i];
                if (z >= br.zDay - MASK_DAY && this.diemTrongFootprint(x, y, br, MASK_LE)) return true;
            }
            return false;
        };
        let soDiemXe = 0;

        // Bước 1: Thu thập toàn bộ điểm hợp lệ trong khung OUTER động & ứng viên Mặt Đường Gốc quanh Ego (r <= 12m)
        const ptsAll = [];
        const seedCand = [];
        const pushPt = (x, y, z) => {
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
            if (x < ext.xMin || x >= ext.xMax || y < ext.yMin || y >= ext.yMax) return;
            const r2 = x * x + y * y;
            if (r2 < 3.0625 || z < -6.0 || z > 4.0) return; // r >= 1.75m bỏ thân xe LiDAR
            if (boxHash.size > 0 && diemThuocXe(x, y, z)) { soDiemXe++; return; }
            ptsAll.push([x, y, z]);
            if (r2 <= 144.0 && z >= -4.5 && z <= 2.5) seedCand.push([x, y, z]);
        };

        if (Array.isArray(rawData)) {
            for (let i = 0; i < rawData.length; i++) {
                const p = rawData[i];
                if (p && p.length >= 3) pushPt(p[0], p[1], p[2]);
            }
        } else if (rawData.isFlat) {
            const arr = rawData.flatArray;
            for (let i = 0; i < arr.length; i += 3) {
                pushPt(arr[i], arr[i + 1], arr[i + 2]);
            }
        } else if (rawData.ptsArray) {
            const arr = rawData.ptsArray;
            for (let i = 0; i < arr.length; i++) {
                const p = arr[i];
                if (p && p.length >= 3) pushPt(p[0], p[1], p[2]);
            }
        }

        if (ptsAll.length < 20) return null;

        // Bước 2: Tìm Mặt Đường Gốc quanh xe LiDAR (hỗ trợ seedShift cho vòng kiểm định an toàn)
        const seedSource = seedCand.length >= 20 ? seedCand : ptsAll;
        const seed = this.timMatPhangGocRobust(seedSource) || { z0: -1.8, gx: 0, gy: 0 };
        if (opts && Number.isFinite(opts.seedShift) && opts.seedShift !== 0) {
            seed.z0 += opts.seedShift;
            seed.gx = 0;
            seed.gy = 0;
            const shiftedInliers = seedSource.filter(p => Math.abs(p[2] - seed.z0) <= 0.06);
            if (shiftedInliers.length >= 10) {
                const fitShift = this.fitRegularizedPlane(shiftedInliers, 0, 0, 0, 0, seed.z0, 4.0, 0.05);
                if (fitShift) {
                    seed.z0 = fitShift.zc;
                    seed.gx = this.clamp(fitShift.gx, -0.10, 0.10);
                    seed.gy = this.clamp(fitShift.gy, -0.10, 0.10);
                }
            }
        }

        // Bước 3: Phân bổ điểm O(1) vào lưới đồng tâm đa cấp (1m/2m/4m/8m, vùng Rìa mở rộng theo cuboid xa nhất) và dựng đồ thị lân cận
        const grid = this.taoDanhSachOLuoi(ext, opts && opts.zones ? opts.zones : null);
        const getAt = (x, y) => this.getAtGrid(grid, x, y);

        for (let i = 0; i < ptsAll.length; i++) {
            const p = ptsAll[i];
            const target = getAt(p[0], p[1]);
            if (target) target.rawPts.push(p);
        }

        // Kề cận chính xác bằng băm đoạn cạnh đơn vị + băm góc (thay dò điểm thăm dò & nhánh edgeOutX của v3)
        this.dungKeCanLuoi(grid.tiles);

        // [CHẶN LEO XE] Ô có tâm trong footprint cuboid ⇒ occluded: không bao giờ fit, chỉ nội suy Laplace từ ô sạch xung quanh
        if (boxRects.length > 0) {
            for (const t of grid.tiles) if (tileCoveredByBox(t)) t.occluded = true;
        }
        const laNguonSach = (n) => n.solved && n.source !== 'extrapolated' && n.source !== 'occluded';
        const DOC_MAX = this.DOC_MAX;
        // Luật chấp nhận bước nhảy chung cho Dijkstra & Bước 5: dốc vật lý, hoặc ngoại lệ bó vỉa (mặt bậc phẳng, song song, không vật đứng phía trên)
        const laBoVia = (res) => res.aboveCount <= 3 && res.rms <= 0.03 && res.slopeDiff <= 0.04 && res.colFrac < 0.2;
        const chapNhanBuoc = (res, dcc) => !!res && (
            res.stepDelta <= this.DIJ_ACC_SLOPE * dcc + this.DIJ_ACC_EPS ||
            (res.stepDelta <= this.BO_VIA_MAX_STEP && laBoVia(res)));
        const cuaSoTim = (dcc) => Math.max(this.DIJ_WIN_SLOPE * dcc + this.DIJ_WIN_EPS, this.BO_VIA_WIN);

        const predictFromNeighbors = (t) => {
            let sw = 0, sz = 0, sgx = 0, sgy = 0, mCnt = 0, dMin = Infinity;
            for (let i = 0; i < t.nbrs.length; i++) {
                const n = t.nbrs[i];
                if (!laNguonSach(n)) continue;
                const ddx = t.cx - n.cx, ddy = t.cy - n.cy;
                const d2 = ddx * ddx + ddy * ddy;
                const w = (n.confidence || 0.2) / (d2 + 4.0);
                sw += w; sz += w * (n.fitZc + n.fitGx * ddx + n.fitGy * ddy);
                sgx += w * n.fitGx; sgy += w * n.fitGy; mCnt++;
                if (d2 < dMin) dMin = d2;
            }
            if (mCnt === 0) {
                for (let i = 0; i < t.nbrs.length; i++) {
                    const n = t.nbrs[i];
                    if (!n.solved) continue;
                    const ddx = t.cx - n.cx, ddy = t.cy - n.cy;
                    const d2 = ddx * ddx + ddy * ddy;
                    const w = 0.05 / (d2 + 4.0);
                    sw += w; sz += w * (n.fitZc + n.fitGx * ddx + n.fitGy * ddy);
                    sgx += w * n.fitGx; sgy += w * n.fitGy;
                    if (d2 < dMin) dMin = d2;
                }
            }
            // dcc: khoảng cách tâm tới ô cha gần nhất góp vào dự đoán (lưới đều 2m ⇒ 2.0, khớp stepScale = 4 của v3)
            return sw > 0 ? { zPred: sz / sw, gxPred: sgx / sw, gyPred: sgy / sw, dcc: Math.sqrt(dMin) } : null;
        };

        // Bước 4: Gieo hạt giống quanh xe LiDAR rồi lan truyền Dijkstra Best-First theo dốc liên tục
        //  (a) Vành 2.5 ≤ r ≤ 5m: ô có cụm đất khớp mặt phẳng gốc (|Δz| ≤ 6cm, |Δdốc| ≤ 5%) → source 'seed'.
        //      Ô lệch (bó vỉa / vật cản sát xe) KHÔNG ép làm hạt giống mà để Dijkstra phân xử.
        //  (b) Ô gầm xe (tâm trong [-2.5,2.5]×[-1,1]m, không có tia) → gán thẳng mặt phẳng gốc, source 'seed'.
        const egoSeeds = [];
        const rMinSeed = this.SEED_RING_MIN, rMaxSeed = this.SEED_RING_MAX;
        const uhx = this.SEED_UNDER_HALF_X, uhy = this.SEED_UNDER_HALF_Y;
        const sMinGrid = grid.levels.length ? grid.levels[0].s : 1;
        const makeSeedFromPlane = (t) => {
            const zp = seed.z0 + seed.gx * t.cx + seed.gy * t.cy;
            t.solved = true; t.visible = true; t.type = 'road'; t.source = 'seed'; t.occluded = false;
            t.fitZc = zp; t.fitGx = seed.gx; t.fitGy = seed.gy; t.confidence = 1.2;
            t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
            egoSeeds.push(t);
        };
        for (const t of grid.tiles) {
            if (t.s !== sMinGrid) continue;
            const underCar = Math.abs(t.cx) <= uhx + 1e-9 && Math.abs(t.cy) <= uhy + 1e-9;
            if (underCar) { makeSeedFromPlane(t); continue; }
            if (t.dist < rMinSeed || t.dist > rMaxSeed || t.occluded) continue;
            const zp = seed.z0 + seed.gx * t.cx + seed.gy * t.cy;
            const res = this.timCumMatDatTrongO(t, zp, seed.gx, seed.gy, 0.25, 0.25, false, boxRects);
            if (!res || Math.abs(res.fit.zc - zp) > 0.06 || Math.hypot(res.fit.gx - seed.gx, res.fit.gy - seed.gy) > 0.05) continue;
            t.solved = true; t.visible = true; t.type = 'road'; t.source = 'seed';
            t.fitZc = res.fit.zc; t.fitGx = res.fit.gx; t.fitGy = res.fit.gy;
            t.pts = res.tightPts; t.nGroundPts = res.tightPts.length; t.rms = res.rms;
            t.confidence = Math.min(3.5, 1.0 + t.nGroundPts / 30);
            t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
            egoSeeds.push(t);
        }
        // Lưới không có ô nào trong vùng hạt giống (cấu hình ZONES thô) → lùi về 4 ô bao gốc toạ độ
        if (egoSeeds.length === 0) {
            for (const [x, y] of [[-0.01, -0.01], [0.01, -0.01], [-0.01, 0.01], [0.01, 0.01]]) {
                const t = getAt(x, y);
                if (t && !t.solved) makeSeedFromPlane(t);
            }
        }

        const pq = [];
        const cachedCost = new Map();
        const pushPQ = (item) => {
            pq.push(item);
            let i = pq.length - 1;
            while (i > 0) {
                const p = (i - 1) >> 1;
                if (pq[p].cost <= pq[i].cost) break;
                const tmp = pq[p]; pq[p] = pq[i]; pq[i] = tmp; i = p;
            }
        };
        const popPQ = () => {
            const top = pq[0], last = pq.pop();
            if (pq.length) {
                pq[0] = last;
                let i = 0;
                for (;;) {
                    let s = i, l = 2 * i + 1, r = l + 1;
                    if (l < pq.length && pq[l].cost < pq[s].cost) s = l;
                    if (r < pq.length && pq[r].cost < pq[s].cost) s = r;
                    if (s === i) break;
                    const tmp = pq[s]; pq[s] = pq[i]; pq[i] = tmp; i = s;
                }
            }
            return top;
        };

        const evalAndQueue = (n) => {
            if (n.solved || n.occluded || n.rawPts.length < 2) return;
            const pred = predictFromNeighbors(n);
            if (!pred) return;
            const prev = cachedCost.get(n.id);
            if (prev && Math.abs(pred.zPred - prev.zp) < 0.035 && Math.hypot(pred.gxPred - prev.gxp, pred.gyPred - prev.gyp) < 0.015) return;
            // Ngưỡng chuẩn hoá theo khoảng cách tâm d_cc; cửa sổ mở tối thiểu 0.25m chỉ để nhánh ngoại lệ bó vỉa bắt được mặt vỉa hè
            const dcc = Math.max(0.5, Number.isFinite(pred.dcc) ? pred.dcc : n.w);
            const win = cuaSoTim(dcc);
            const res = this.timCumMatDatTrongO(n, pred.zPred, pred.gxPred, pred.gyPred, win, win, false, boxRects);
            if (!chapNhanBuoc(res, dcc)) return;
            const eccPen = Math.max(0, res.centroidEcc - 0.5) * 2.0;
            // Chi phí bước nhảy theo độ dốc tương đương (stepDelta / d_cc) + phạt riêng bước ĐI LÊN (chống leo dần lên thân xe)
            const cost = (res.stepDelta / dcc) * 16.0 + 8.0 * Math.max(0, res.fit.zc - pred.zPred) / dcc
                + res.rms * 4.0 + eccPen + 0.04 * n.dist;
            if (!prev || cost < prev.cost) {
                cachedCost.set(n.id, { res, cost, zp: pred.zPred, gxp: pred.gxPred, gyp: pred.gyPred });
                pushPQ({ tile: n, cost, res });
            }
        };
        for (const t of egoSeeds) for (const n of t.nbrs) evalAndQueue(n);

        while (pq.length > 0) {
            const { tile: t, res } = popPQ();
            if (t.solved) continue;
            t.solved = true; t.visible = true;
            t._res = res;
            t.type = 'road';
            t.fitZc = res.fit.zc; t.fitGx = res.fit.gx; t.fitGy = res.fit.gy;
            t.pts = res.tightPts; t.nGroundPts = res.tightPts.length; t.rms = res.rms;
            t.source = (t.nGroundPts >= (t.isOuter ? 12 : 8) && res.centroidEcc < 0.72) ? 'measured' : 'sparse';
            const densityFactor = Math.min(2.2, 0.45 + t.nGroundPts / (t.isOuter ? 24 : 16));
            const geomFactor = Math.max(0.15, 1.0 - Math.max(0, res.centroidEcc - 0.35));
            t.confidence = densityFactor * geomFactor * (t.source === 'sparse' ? 0.50 : 1.0);
            t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
            for (const n of t.nbrs) evalAndQueue(n);
        }

        // Bước 5: Điền nốt các vùng thưa điểm / khuất xe bằng dự đoán rộng và nội suy đa lân cận
        const byDist = grid.tiles.slice().sort((a, b) => a.dist - b.dist);
        const solvedList = grid.tiles.filter(t => t.solved);
        const predictFromWideRoad = (t, maxR = 42.0) => {
            let sw = 0, sz = 0, sgx = 0, sgy = 0;
            const r2Max = maxR * maxR;
            for (let i = 0; i < solvedList.length; i++) {
                const n = solvedList[i];
                if (n.type !== 'road' || n.source === 'extrapolated' || n.source === 'occluded') continue;
                const ddx = t.cx - n.cx, ddy = t.cy - n.cy;
                const d2 = ddx * ddx + ddy * ddy;
                if (d2 > r2Max) continue;
                const w = (n.confidence || 0.4) / (d2 + 8.0);
                sw += w; sz += w * (n.fitZc + n.fitGx * ddx + n.fitGy * ddy);
                sgx += w * n.fitGx; sgy += w * n.fitGy;
            }
            return sw > 0 ? { zPred: sz / sw, gxPred: sgx / sw, gyPred: sgy / sw } : null;
        };

        for (let pass = 0; pass < 3; pass++) {
            for (const t of byDist) {
                if (t.solved || t.occluded) continue; // ô bị cuboid che: để nội suy Laplace, không fit
                const nPred = predictFromNeighbors(t);
                const pred = nPred || (pass >= 1 && t.rawPts.length >= 2 ? predictFromWideRoad(t, 42.0) : null);
                if (!pred) continue;
                // [CHẶN LEO XE] Bỏ cửa sổ 0.45 / ngưỡng 0.38 cố định ⇒ cùng luật dốc vật lý + ngoại lệ bó vỉa như Dijkstra
                const dcc5 = Math.max(0.5, (nPred && Number.isFinite(nPred.dcc)) ? nPred.dcc : Math.max(2.0, t.w));
                const win5 = cuaSoTim(dcc5);
                const res = t.rawPts.length >= 2 ? this.timCumMatDatTrongO(t, pred.zPred, pred.gxPred, pred.gyPred, win5, win5, false, boxRects) : null;
                if (chapNhanBuoc(res, dcc5)) {
                    t.solved = true; t.visible = true; t._res = res; t.type = 'road';
                    t.fitZc = res.fit.zc; t.fitGx = res.fit.gx; t.fitGy = res.fit.gy;
                    t.pts = res.tightPts; t.nGroundPts = res.tightPts.length; t.rms = res.rms;
                    t.source = (nPred && t.nGroundPts >= 8 && res.centroidEcc < 0.7) ? 'measured' : 'sparse';
                    t.confidence = (t.source === 'sparse' ? 0.45 : 1.0);
                    t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
                    solvedList.push(t);
                } else if (pass === 2) {
                    if (t.occlHint) continue; // ô vật cản (cột đứng / không có đất lõi): để nội suy Laplace
                    const mNbrs = t.nbrs.filter(laNguonSach).length;
                    if (mNbrs >= 2 || (mNbrs >= 1 && t.dist <= 28)) {
                        t.solved = true; t.visible = true; t.type = 'road'; t.source = 'extrapolated';
                        t.fitZc = pred.zPred; t.fitGx = pred.gxPred; t.fitGy = pred.gyPred;
                        t.confidence = 0.04; t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
                        solvedList.push(t);
                    }
                }
            }
        }

        // Bước 5a [CHẶN LEO XE]: Nội suy Laplace qua ô bị che (gầm/thân xe) thay vì fit điểm vật thể.
        //   Tập O = ô trong footprint cuboid + ô bị loại do cột đứng/không có đất lõi mà chưa giải được.
        //   Biên Dirichlet = ô sạch đã giải (seed/measured/sparse). Lặp Jacobi ≤ 60 vòng, dừng khi max |Δz| < 2mm:
        //   z_t ← Σ w_n·(z_n + g_n·(c_t − c_n)) / Σ w_n, w_n = conf_n / (d² + 1); gradient = trung bình có trọng số, clamp DOC_MAX.
        const oTiles = grid.tiles.filter(t => !t.solved && (t.occluded || t.occlHint));
        if (oTiles.length > 0) {
            const inO = new Map();
            for (let i = 0; i < oTiles.length; i++) inO.set(oTiles[i], i);
            const nO = oTiles.length;
            const zO = new Float64Array(nO), gxO = new Float64Array(nO), gyO = new Float64Array(nO);
            const okO = new Uint8Array(nO);
            const zN = new Float64Array(nO), gxN = new Float64Array(nO), gyN = new Float64Array(nO);
            const okN = new Uint8Array(nO);
            const C_O = 0.5; // trọng số ô O lân cận (nội bộ vùng che) — biên sạch thường nặng hơn (conf 0.5–2.2)
            for (let it = 0; it < 60; it++) {
                for (let i = 0; i < nO; i++) {
                    const t = oTiles[i];
                    let sw = 0, sz = 0, sgx = 0, sgy = 0;
                    for (const n of t.nbrs) {
                        let zn, gxn, gyn, c;
                        const j = inO.get(n);
                        if (j !== undefined) {
                            if (!okO[j]) continue;
                            zn = zO[j]; gxn = gxO[j]; gyn = gyO[j]; c = C_O;
                        } else if (laNguonSach(n)) {
                            zn = n.fitZc; gxn = n.fitGx; gyn = n.fitGy;
                            c = Math.min(2.5, Math.max(0.1, n.confidence || 0.2));
                        } else continue;
                        const ddx = t.cx - n.cx, ddy = t.cy - n.cy;
                        const w = c / (ddx * ddx + ddy * ddy + 1.0);
                        sw += w; sz += w * (zn + gxn * ddx + gyn * ddy);
                        sgx += w * gxn; sgy += w * gyn;
                    }
                    if (sw > 0) {
                        zN[i] = sz / sw;
                        gxN[i] = this.clamp(sgx / sw, -DOC_MAX, DOC_MAX);
                        gyN[i] = this.clamp(sgy / sw, -DOC_MAX, DOC_MAX);
                        okN[i] = 1;
                    } else okN[i] = 0;
                }
                let maxD = 0, moi = 0;
                for (let i = 0; i < nO; i++) {
                    if (!okN[i]) continue;
                    if (okO[i]) { const d = Math.abs(zN[i] - zO[i]); if (d > maxD) maxD = d; }
                    else moi++;
                    zO[i] = zN[i]; gxO[i] = gxN[i]; gyO[i] = gyN[i]; okO[i] = 1;
                }
                if (moi === 0 && maxD < 0.002) break;
            }
            for (let i = 0; i < nO; i++) {
                if (!okO[i]) continue; // vùng che không chạm ô sạch nào ⇒ để Bước 5b xử lý
                const t = oTiles[i];
                t.solved = true; t.visible = true; t.type = 'road'; t.source = 'occluded';
                t.fitZc = zO[i]; t.fitGx = gxO[i]; t.fitGy = gyO[i];
                t.pts = []; t.nGroundPts = 0; t.rms = 0;
                t.confidence = 0.05; t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
                solvedList.push(t);
            }
        }

        // Bước 5b: Nối cầu mượt qua vùng không gian thưa/trống tới mọi cuboid ở xa + vành mở rộng ~12m xung quanh
        if (boxRects.length > 0) {
            const tileNearAnyBoxHalo = (t) => {
                for (let i = 0; i < boxRects.length; i++) {
                    const br = boxRects[i];
                    if (Math.abs(br.bx - t.cx) <= 0.5 * t.w + br.pad + 12.0 &&
                        Math.abs(br.by - t.cy) <= 0.5 * t.h + br.pad + 12.0) {
                        return true;
                    }
                }
                return false;
            };
            const haloTargets = [];
            for (let i = 0; i < grid.tiles.length; i++) {
                const t = grid.tiles[i];
                if (!t.solved && tileNearAnyBoxHalo(t)) haloTargets.push(t);
            }
            if (haloTargets.length > 0) {
                const sharesEdge = (a, b) => {
                    const xo = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
                    const yo = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
                    const tx = Math.abs(Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)) < 0.05;
                    const ty = Math.abs(Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)) < 0.05;
                    return (tx && yo > 0.5) || (ty && xo > 0.5);
                };
                const hopDist = new Map();
                const parentMap = new Map();
                const q = [];
                for (let i = 0; i < grid.tiles.length; i++) {
                    const t = grid.tiles[i];
                    if (t.solved) {
                        hopDist.set(t, 0);
                        q.push(t);
                    }
                }
                for (let head = 0; head < q.length; head++) {
                    const cur = q[head];
                    const nextHop = hopDist.get(cur) + 1;
                    for (const n of cur.nbrs) {
                        if (hopDist.has(n) || !sharesEdge(cur, n)) continue;
                        hopDist.set(n, nextHop);
                        parentMap.set(n, cur);
                        q.push(n);
                    }
                }
                const fillSet = new Set();
                for (const tg of haloTargets) {
                    let cur = tg;
                    while (cur && !cur.solved && parentMap.has(cur) && !fillSet.has(cur)) {
                        fillSet.add(cur);
                        cur = parentMap.get(cur);
                    }
                }
                const fillOrdered = [...fillSet].sort((a, b) => (hopDist.get(a) || 0) - (hopDist.get(b) || 0));
                for (const t of fillOrdered) {
                    const pred = predictFromNeighbors(t) || { zPred: seed.z0 + seed.gx * t.cx + seed.gy * t.cy, gxPred: seed.gx, gyPred: seed.gy };
                    t.solved = true; t.visible = true; t.type = 'road'; t.source = 'extrapolated';
                    t.fitZc = pred.zPred; t.fitGx = pred.gxPred; t.fitGy = pred.gyPred;
                    t.confidence = 0.03; t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
                    solvedList.push(t);
                }
            }
        }

        // Bước 6: Tách đôi ô cắt ngang bó vỉa (4m×2m / 2m×4m) khi >= 2 ô liền kề cùng xác nhận bó vỉa hoặc ô có bằng chứng gờ mạnh (strongCurb)
        for (const t of byDist) {
            if (!t.solved || !t._res?.curbSplit || t.isOuter) continue;
            const myAxis = t._res.curbSplit.axis;
            const hasPartner = t.nbrs.some(n => n.solved && n._res?.curbSplit && n._res.curbSplit.axis === myAxis);
            const isStrong = t._res.curbSplit.strongCurb === true;
            if (!hasPartner && !isStrong) t._res.curbSplit = null;
        }

        const finalTiles = [];
        for (const t of byDist) {
            if (!t.solved) continue;
            if (t._res && t._res.curbSplit && !t.isOuter) {
                const sp = t._res.curbSplit;
                const pred = predictFromNeighbors(t) || { gxPred: t.fitGx, gyPred: t.fitGy };
                const gx = pred.gxPred, gy = pred.gyPred;
                const isYSplit = (sp.axis === 'y');
                // Bước lượng tử vị trí cắt: 1m cho ô ≥ 2m (v3: ô 2m luôn cắt giữa), 0.5m cho ô 1m ⇒ ô con 1m×0.5m
                const cutU = Math.min(1.0, 0.5 * (isYSplit ? t.h : t.w));
                let cutPos;
                if (isYSplit) {
                    const maxLowY = sp.lowerPts.reduce((m, p) => p[1] > m ? p[1] : m, -Infinity);
                    const minUpY = sp.upperPts.reduce((m, p) => p[1] < m ? p[1] : m, Infinity);
                    const minLowY = sp.lowerPts.reduce((m, p) => p[1] < m ? p[1] : m, Infinity);
                    const maxUpY = sp.upperPts.reduce((m, p) => p[1] > m ? p[1] : m, -Infinity);
                    const rawCut = (minLowY < minUpY) ? 0.5 * (maxLowY + minUpY) : 0.5 * (minLowY + maxUpY);
                    cutPos = Math.min(t.y1 - cutU, Math.max(t.y0 + cutU, Math.round(rawCut / cutU) * cutU));
                } else {
                    const maxLowX = sp.lowerPts.reduce((m, p) => p[0] > m ? p[0] : m, -Infinity);
                    const minUpX = sp.upperPts.reduce((m, p) => p[0] < m ? p[0] : m, Infinity);
                    const minLowX = sp.lowerPts.reduce((m, p) => p[0] < m ? p[0] : m, Infinity);
                    const maxUpX = sp.upperPts.reduce((m, p) => p[0] > m ? p[0] : m, -Infinity);
                    const rawCut = (minLowX < minUpX) ? 0.5 * (maxLowX + minUpX) : 0.5 * (minLowX + maxUpX);
                    cutPos = Math.min(t.x1 - cutU, Math.max(t.x0 + cutU, Math.round(rawCut / cutU) * cutU));
                }
                const lowM = isYSplit
                    ? sp.lowerPts.reduce((s, p) => s + p[1], 0) / sp.lowerPts.length
                    : sp.lowerPts.reduce((s, p) => s + p[0], 0) / sp.lowerPts.length;
                const lowFirst = isYSplit ? (lowM < cutPos) : (lowM < cutPos);

                const makeSub = (sfx, sx0, sx1, sy0, sy1, subType, zC, sPts) => {
                    const scx = 0.5 * (sx0 + sx1), scy = 0.5 * (sy0 + sy1);
                    const szc = zC + gx * (scx - t.cx) + gy * (scy - t.cy);
                    return {
                        id: `${t.id}_${sfx}`, tier: 'sub', isOuter: false, parentId: t.id, zone: t.zone, s: t.s,
                        px0: t.x0, px1: t.x1, py0: t.y0, py1: t.y1,
                        x0: sx0, x1: sx1, y0: sy0, y1: sy1, cx: scx, cy: scy, w: sx1 - sx0, h: sy1 - sy0,
                        dist: Math.hypot(scx, scy), zc: szc, gx, gy, tw: 0,
                        fitZc: szc, fitGx: gx, fitGy: gy, confidence: 1.0, rms: 0,
                        type: subType, source: 'measured', pts: sPts, nGroundPts: sPts.length, aboveCount: 0,
                        layerId: null, manual: false, solved: true, visible: true
                    };
                };
                if (isYSplit) {
                    finalTiles.push(makeSub('S1', t.x0, t.x1, t.y0, cutPos, lowFirst ? 'road' : 'sidewalk', lowFirst ? sp.lZ : sp.uZ, lowFirst ? sp.lowerPts : sp.upperPts));
                    finalTiles.push(makeSub('S2', t.x0, t.x1, cutPos, t.y1, lowFirst ? 'sidewalk' : 'road', lowFirst ? sp.uZ : sp.lZ, lowFirst ? sp.upperPts : sp.lowerPts));
                } else {
                    finalTiles.push(makeSub('S1', t.x0, cutPos, t.y0, t.y1, lowFirst ? 'road' : 'sidewalk', lowFirst ? sp.lZ : sp.uZ, lowFirst ? sp.lowerPts : sp.upperPts));
                    finalTiles.push(makeSub('S2', cutPos, t.x1, t.y0, t.y1, lowFirst ? 'sidewalk' : 'road', lowFirst ? sp.uZ : sp.lZ, lowFirst ? sp.upperPts : sp.lowerPts));
                }
            } else {
                finalTiles.push(t);
            }
        }

        // Lan truyền nhãn Vỉa Hè từ phần cao sau bó vỉa và giữ toàn bộ đường nối mượt về Ego là Road
        const subSw = finalTiles.filter(t => t.tier === 'sub' && t.type === 'sidewalk');
        const fullTiles = finalTiles.filter(t => t.tier !== 'sub');
        const splitSet = new Set(byDist.filter(t => t._res?.curbSplit && !t.isOuter));

        for (const sw of subSw) {
            for (const cand of fullTiles) {
                if (cand.type === 'sidewalk' || cand.source === 'seed' || cand.source === 'extrapolated' || cand.source === 'occluded') continue;
                const xo = Math.min(sw.x1, cand.x1) - Math.max(sw.x0, cand.x0);
                const yo = Math.min(sw.y1, cand.y1) - Math.max(sw.y0, cand.y0);
                const touching = (Math.abs(cand.cx - sw.cx) <= 0.5 * (cand.w + sw.w) + 0.1) && (Math.abs(cand.cy - sw.cy) <= 0.5 * (cand.h + sw.h) + 0.1) && (xo > 0.5 || yo > 0.5);
                if (!touching) continue;
                const zSwPred = sw.zc + sw.gx * (cand.cx - sw.cx) + sw.gy * (cand.cy - sw.cy);
                if (Math.abs(cand.fitZc - zSwPred) <= 0.06 && Math.hypot(cand.fitGx - sw.gx, cand.fitGy - sw.gy) <= 0.03) {
                    cand.type = 'sidewalk';
                }
            }
        }

        let swCh = true;
        while (swCh) {
            swCh = false;
            for (const a of fullTiles) {
                if (a.type !== 'sidewalk') continue;
                for (const b of a.nbrs) {
                    if (!b.solved || splitSet.has(b) || b.type === 'sidewalk' || b.source === 'seed' || b.source === 'extrapolated' || b.source === 'occluded') continue;
                    const zP = a.fitZc + a.fitGx * (b.cx - a.cx) + a.fitGy * (b.cy - a.cy);
                    if (Math.abs(b.fitZc - zP) <= 0.055 && Math.hypot(b.fitGx - a.fitGx, b.fitGy - a.fitGy) <= 0.028) {
                        b.type = 'sidewalk';
                        swCh = true;
                    }
                }
            }
        }

        const reachableFromEgo = new Set(egoSeeds);
        const rQueue = [...egoSeeds];
        while (rQueue.length) {
            const cur = rQueue.shift();
            for (const n of (cur.nbrs || [])) {
                if (!n.solved || reachableFromEgo.has(n) || splitSet.has(n) || n.source === 'extrapolated' || n.source === 'occluded') continue;
                // Chỉ đi qua kề cạnh (mọi cấp ô), bỏ kề chéo chỉ chạm góc
                if (!cur.edgeNbrs || !cur.edgeNbrs.has(n)) continue;
                const step = Math.abs(n.fitZc - (cur.fitZc + cur.fitGx * (n.cx - cur.cx) + cur.fitGy * (n.cy - cur.cy)));
                const sameParallelJump = (step >= 0.065 && Math.hypot(n.fitGx - cur.fitGx, n.fitGy - cur.fitGy) <= 0.04);
                if (!sameParallelJump && step < 0.085) {
                    reachableFromEgo.add(n);
                    rQueue.push(n);
                }
            }
        }
        for (const t of fullTiles) {
            if (t.type === 'sidewalk' && reachableFromEgo.has(t)) t.type = 'road';
        }

        // Bước 6.5 (Neo Duyệt): Ghim ô thuộc footprint đã duyệt & lan truyền phần dư Gaussian C^1 ra vùng thưa/xa
        const NeoV4 = this._getNeoDuyet();
        const neoListV4 = this._thuThapNeoTuBoxes(boxes, seed, opts);
        const carNeosV4 = neoListV4.filter(n => n && n.kind !== 'ego');
        if (NeoV4 && carNeosV4.length > 0) {
            const tileNenFn = (qx, qy) => {
                for (let k = 0; k < finalTiles.length; k++) {
                    const tk = finalTiles[k];
                    if (qx >= tk.x0 && qx <= tk.x1 && qy >= tk.y0 && qy <= tk.y1) {
                        return tk.fitZc + tk.fitGx * (qx - tk.cx) + tk.fitGy * (qy - tk.cy);
                    }
                }
                return seed.z0 + seed.gx * qx + seed.gy * qy;
            };
            const neoStV4 = NeoV4.datTrangThaiNeo(neoListV4, tileNenFn, opts);
            if (neoStV4 && neoStV4.coNeoXe) {
                for (let i = 0; i < finalTiles.length; i++) {
                    const t = finalTiles[i];
                    const baseConf = t.source === 'seed' || t.source === 'measured' ? Math.min(0.90, t.confidence || 0.85) : (t.source === 'sparse' ? 0.40 : 0.05);
                    const qC = NeoV4.zTaiDiem(t.cx, t.cy, t.fitZc, baseConf, neoStV4);

                    // Với ô lớn (>=2m) mà footprint chỉ phủ một phần -> lấy mẫu 3x3 kiểm tra độ phủ
                    let wMax = qC.W;
                    let sumZ = 0, sumW = 0;
                    if (Math.max(t.w, t.h) >= 1.9 && qC.dMin <= Math.max(t.w, t.h) + 1.5) {
                        for (let sx = -1; sx <= 1; sx++) {
                            for (let sy = -1; sy <= 1; sy++) {
                                const px = t.cx + sx * 0.35 * t.w;
                                const py = t.cy + sy * 0.35 * t.h;
                                const zNenS = t.fitZc + t.fitGx * (px - t.cx) + t.fitGy * (py - t.cy);
                                const qs = NeoV4.zTaiDiem(px, py, zNenS, baseConf, neoStV4);
                                if (qs.W > wMax) wMax = qs.W;
                                sumZ += qs.z;
                                sumW += 1;
                            }
                        }
                    }

                    if (qC.W >= 0.999) {
                        // Tâm ô nằm gọn trong footprint đã duyệt -> ghim cứng + lấy đúng độ dốc cuboid
                        let bestA = t.fitGx, bestB = t.fitGy, bestD = Infinity;
                        for (const kn of neoStV4.carNeos) {
                            const dk = NeoV4.khoangCachChan(t.cx, t.cy, kn);
                            if (dk <= 0.05 && dk < bestD) { bestD = dk; bestA = kn.a; bestB = kn.b; }
                        }
                        t.pinnedNeo = true;
                        t.type = 'road';
                        t.source = 'approved_anchor';
                        t.fitZc = qC.z; t.zc = qC.z;
                        t.fitGx = bestA; t.gx = bestA;
                        t.fitGy = bestB; t.gy = bestB;
                        t.confidence = 10.0;
                    } else if (wMax > 0.25 && sumW > 0) {
                        const avgZ = sumZ / sumW;
                        t.fitZc = avgZ; t.zc = avgZ;
                        if (qC.W > 0.5) t.type = 'road';
                    } else if (Math.abs(qC.z - t.fitZc) > 1e-6) {
                        t.fitZc = qC.z; t.zc = qC.z;
                    }
                }
            }
        }

        // Bước 7: Khâu kín đỉnh góc song tuyến tính (C0 Watertight Stitching) riêng biệt cho Road & Sidewalk
        const roadGroup = finalTiles.filter(t => t.type === 'road');
        const swGroup = finalTiles.filter(t => t.type === 'sidewalk');
        this.stitchSameTypeGraph(roadGroup, seed.z0);
        this.stitchSameTypeGraph(swGroup, seed.z0 + 0.15);

        for (const t of finalTiles) {
            delete t.pinnedNeo;
            delete t._res;
            delete t._cot;
            delete t.occlHint;
            delete t.rawPts;
            delete t.stratPts;
            delete t.nbrs;
            delete t.edgeNbrs;
        }

        const data = {
            tiles: finalTiles,
            allTiles: finalTiles,
            seedPlane: seed,
            ext,
            soDiemXeDaLoai: soDiemXe,
            layers: []
        };
        this.gomNhomThanhLop(data);
        return data;
    }

    /**
     * Region Growing BFS gom các ô cùng loại & đồng phẳng thành từng Lớp trực quan
     */
    static gomNhomThanhLop(surfaceData) {
        if (!surfaceData || !surfaceData.tiles) return;
        const tiles = surfaceData.tiles;
        const visited = new Set();
        const layers = [];

        const areNeighbors = (a, b) => {
            const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
            const yOverlap = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
            const touchX = Math.abs(Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1)) < 0.05;
            const touchY = Math.abs(Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1)) < 0.05;
            return (touchX && yOverlap > 0.4) || (touchY && xOverlap > 0.4);
        };

        const areCoplanar = (a, b, seed) => {
            if (a.type !== b.type) return false;
            const mx = 0.5 * (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1));
            const my = 0.5 * (Math.max(a.y0, b.y0) + Math.min(a.y1, b.y1));
            const edgeDiff = Math.abs(this.evalTileZ(a, mx, my) - this.evalTileZ(b, mx, my));
            const stepSlope = Math.hypot(a.gx - b.gx, a.gy - b.gy);
            const totalSlope = Math.hypot(b.gx - seed.gx, b.gy - seed.gy);
            return edgeDiff <= 0.045 && stepSlope <= 0.045 && totalSlope <= 0.08;
        };

        const sorted = [...tiles].sort((a, b) => a.dist - b.dist);
        let layerSeq = 1;

        for (const seed of sorted) {
            if (visited.has(seed.id)) continue;
            const queue = [seed];
            visited.add(seed.id);
            const groupTiles = [];

            while (queue.length > 0) {
                const cur = queue.shift();
                groupTiles.push(cur);
                if (groupTiles.length >= 60) continue;

                for (const cand of sorted) {
                    if (visited.has(cand.id)) continue;
                    if (Math.abs(cand.cx - cur.cx) > 14 || Math.abs(cand.cy - cur.cy) > 14) continue;
                    if (areNeighbors(cur, cand) && areCoplanar(cur, cand, seed)) {
                        visited.add(cand.id);
                        queue.push(cand);
                    }
                }
            }

            const layerId = `L${layerSeq++}`;
            let sumZ = 0, sumGx = 0, sumGy = 0, sumCy = 0, sumDist = 0, minD = 999, maxD = 0;
            for (const gt of groupTiles) {
                gt.layerId = layerId;
                sumZ += gt.zc;
                sumGx += gt.gx;
                sumGy += gt.gy;
                sumCy += gt.cy;
                sumDist += gt.dist;
                if (gt.dist < minD) minD = gt.dist;
                if (gt.dist > maxD) maxD = gt.dist;
            }
            const m = groupTiles.length;
            const avgCy = sumCy / m;
            const avgD = sumDist / m;
            let name = '';
            if (seed.type === 'sidewalk') {
                name = `Vỉa Hè ${avgCy >= 1.5 ? 'Trái' : (avgCy <= -1.5 ? 'Phải' : 'Giữa')} (${Math.round(minD)}–${Math.round(maxD)}m)`;
            } else if (minD <= 10) {
                name = `Mặt Đường Gốc (${Math.round(minD)}–${Math.round(maxD)}m)`;
            } else {
                const sideTag = avgCy > 5 ? 'Trái' : (avgCy < -5 ? 'Phải' : 'Giữa');
                name = `Mặt Đường ${sideTag} (${Math.round(minD)}–${Math.round(maxD)}m)`;
            }

            layers.push({
                id: layerId,
                name,
                type: seed.type,
                tileIds: groupTiles.map(t => t.id),
                count: m,
                avgZ: sumZ / m,
                avgGx: sumGx / m,
                avgGy: sumGy / m,
                minDist: minD,
                maxDist: maxD,
                avgDist: avgD
            });
        }

        layers.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'road' ? -1 : 1;
            return a.minDist - b.minDist;
        });

        surfaceData.layers = layers;
        this.xayDungChiMucGrid2M(surfaceData);
    }

    static xayDungChiMucGrid2M(surfaceData) {
        if (!surfaceData || !Array.isArray(surfaceData.tiles)) return;
        const ext = surfaceData.ext || this.macDinhPhamViLuoi();
        const tiles = surfaceData.tiles;
        // Độ phân giải chỉ mục = cạnh ô nguyên nhỏ nhất (1m với lưới đa cấp, 2m với dữ liệu v3 cũ),
        // nới lên 2m nếu ext quá rộng (> 200k ô nhớ). Ô không khớp chính xác được timOTaiViTri dò bổ sung.
        let res = Infinity;
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            if (t.tier === 'sub') continue;
            const m = Math.min(t.w, t.h);
            if (m > 0 && m < res) res = m;
        }
        if (!Number.isFinite(res)) res = 2;
        res = Math.max(1, res);
        if (((ext.xMax - ext.xMin) / res) * ((ext.yMax - ext.yMin) / res) > 200000) res = Math.max(res, 2);
        const inv = 1.0 / res;
        const NX = Math.max(1, Math.round((ext.xMax - ext.xMin) * inv));
        const NY = Math.max(1, Math.round((ext.yMax - ext.yMin) * inv));
        const grid = new Int32Array(NX * NY);
        grid.fill(-1);

        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i];
                const isSub = (t.tier === 'sub');
                if ((pass === 0 && isSub) || (pass === 1 && !isSub)) continue;
                const ix0 = Math.max(0, Math.floor((t.x0 - ext.xMin) * inv + 1e-9));
                const ix1 = Math.min(NX - 1, Math.ceil((t.x1 - ext.xMin) * inv - 1e-9) - 1);
                const iy0 = Math.max(0, Math.floor((t.y0 - ext.yMin) * inv + 1e-9));
                const iy1 = Math.min(NY - 1, Math.ceil((t.y1 - ext.yMin) * inv - 1e-9) - 1);
                for (let ix = ix0; ix <= ix1; ix++) {
                    const rowBase = ix * NY;
                    for (let iy = iy0; iy <= iy1; iy++) {
                        grid[rowBase + iy] = i;
                    }
                }
            }
        }
        surfaceData._grid2m = grid;
        surfaceData._g2NX = NX;
        surfaceData._g2NY = NY;
        surfaceData._g2Ext = ext;
        surfaceData._g2Res = res;
    }

    static timOTaiViTri(surfaceData, x, y) {
        if (!surfaceData || !Array.isArray(surfaceData.tiles)) return null;
        const ext = surfaceData._g2Ext || surfaceData.ext || this.macDinhPhamViLuoi();
        if (x < ext.xMin || x > ext.xMax || y < ext.yMin || y > ext.yMax) return null;

        if (!surfaceData._grid2m) this.xayDungChiMucGrid2M(surfaceData);
        const grid = surfaceData._grid2m;
        if (grid) {
            const inv = 1.0 / (surfaceData._g2Res || 2);
            const NX = surfaceData._g2NX || Math.max(1, Math.round((ext.xMax - ext.xMin) * inv));
            const NY = surfaceData._g2NY || Math.max(1, Math.round((ext.yMax - ext.yMin) * inv));
            const ix = Math.min(NX - 1, Math.max(0, Math.floor((x - ext.xMin) * inv)));
            const iy = Math.min(NY - 1, Math.max(0, Math.floor((y - ext.yMin) * inv)));
            const idx = grid[ix * NY + iy];
            if (idx < 0) return null;
            const t = surfaceData.tiles[idx];
            if (t && x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) return t;
            // Ô nhớ chứa nhiều ô (2 nửa ô bó vỉa, hoặc chỉ mục nới 2m) → dò tuyến tính, ưu tiên ô con 'sub'
        }

        let exact = null;
        for (let i = 0; i < surfaceData.tiles.length; i++) {
            const t = surfaceData.tiles[i];
            if (x >= t.x0 && x <= t.x1 && y >= t.y0 && y <= t.y1) {
                if (!exact || t.tier === 'sub') exact = t;
            }
        }
        return exact;
    }

    static caoDoTai(surfaceData, x, y) {
        if (!surfaceData) return null;
        const tile = this.timOTaiViTri(surfaceData, x, y);
        if (tile) return this.evalTileZ(tile, x, y);
        if (surfaceData.seedPlane) {
            const sp = surfaceData.seedPlane;
            return sp.z0 + sp.gx * x + sp.gy * y;
        }
        return null;
    }

    /**
     * Tra cứu độ cao Z và độ nghiêng mặt đường Surface tại tọa độ (x, y) bất kỳ
     */
    static layMatDuongTaiViTri(surfaceData, x, y) {
        if (!surfaceData) return null;
        const tiles = surfaceData.tiles || surfaceData.allTiles || [];
        const exact = this.timOTaiViTri(surfaceData, x, y);
        let nearest = null;
        let bestD = 1e9;

        if (!exact) {
            for (let i = 0; i < tiles.length; i++) {
                const t = tiles[i];
                const d = Math.hypot(x - t.cx, y - t.cy);
                if (d < bestD) { bestD = d; nearest = t; }
            }
        }

        const chosen = exact || (bestD <= 14.0 ? nearest : null);
        if (chosen) {
            return {
                zRoad: this.evalTileZ(chosen, x, y),
                rx: chosen.gy,
                ry: -chosen.gx,
                gx: chosen.gx,
                gy: chosen.gy,
                type: chosen.type,
                source: chosen.source,
                tile: chosen
            };
        }
        if (surfaceData.seedPlane) {
            const sp = surfaceData.seedPlane;
            return {
                zRoad: sp.z0 + sp.gx * x + sp.gy * y,
                rx: sp.gy,
                ry: -sp.gx,
                gx: sp.gx,
                gy: sp.gy,
                type: 'road',
                source: 'seed',
                tile: null
            };
        }
        return null;
    }

    /**
     * Fit mặt phẳng tiếp xúc mặt đường theo toàn bộ footprint (L × W) của box trên Surface,
     * khắc phục lệch mép ô và xoắn song tuyến (tw) khi hạ cuboid xuống đường.
     */
    static layMatDuongChoBox(surfaceData, cx, cy, rz = 0, L = 4.4, W = 1.9, rawPts = null, H = 1.6, cz = null, frameBoxes = null, frameSolve = null, opts = null) {
        // [ƯU TIÊN 1 - PHASE 1/2 HYBRID PER-FRAME LOCAL GROUND]: Tính trực tiếp theo điểm LiDAR của chính frame đó (hoạt động cả khi surfaceData == null)
        if (rawPts && rawPts.length >= 10) {
            const P2 = this.PHASE2;
            const egoPlane = (frameSolve && frameSolve.ego) ? frameSolve.ego : this.tinhEgoGroundPlane(rawPts);
            const carBox = { x: cx, y: cy, z: Number.isFinite(cz) ? cz : 0, rz, L, W, H, track: opts?.carTrack || opts?.track || null };
            const zBottom = (Number.isFinite(cz) ? cz : 0) - (H || 1.6) / 2.0;

            let local = null;
            let solve = frameSolve;
            if (P2.enabled && ((solve && solve.results) || (Array.isArray(frameBoxes) && frameBoxes.length > 0))) {
                if (!solve) {
                    const ptsSig = this._getStaticPtsSig(rawPts);
                    const keys = frameBoxes.map(b => this.boxKey(this._canonicalizeBox(b))).sort();
                    const unlockTag = (opts?.trackKeysMoKhoa && opts.trackKeysMoKhoa.size > 0) ? `_unl:${[...opts.trackKeysMoKhoa].sort().join(',')}` : '';
                    const lruKey = `${P2.enabled ? 1 : 0}|${ptsSig}|${keys.join(';')}${unlockTag}`;
                    const cached = this._staticFrameSolveLRU.get(lruKey);
                    if (cached) {
                        this._staticFrameSolveLRU.delete(lruKey);
                        this._staticFrameSolveLRU.set(lruKey, cached);
                        solve = cached;
                    } else {
                        solve = this.solveFramePhase2(frameBoxes, rawPts, egoPlane, opts || null);
                        this._staticFrameSolveLRU.set(lruKey, solve);
                        while (this._staticFrameSolveLRU.size > 4) {
                            const oldest = this._staticFrameSolveLRU.keys().next().value;
                            this._staticFrameSolveLRU.delete(oldest);
                        }
                    }
                }
                const canonTarget = this._canonicalizeBox(carBox);
                const targetKey = this.boxKey(canonTarget);
                local = solve?.results?.get(targetKey) || null;
                if (!local) {
                    local = this._queryInteractivePhase2(carBox, rawPts, egoPlane, frameBoxes, solve, opts || {});
                }
            } else {
                local = this.tinhMatDuongCucBoXe(carBox, rawPts, egoPlane, frameBoxes, null, opts || null);
            }

            if (local && Number.isFinite(local.zc)) {
                const nAnchTotal = local.anchorCount ?? (solve?.anchors?.length ?? 0);
                return {
                    zRoad: local.zc,
                    rx: local.gy,
                    ry: -local.gx,
                    gx: local.gx,
                    gy: local.gy,
                    type: 'road',
                    source: local.source,
                    nhan: local.nhan,
                    sigma: local.sigma,
                    flags: local.flags,
                    vetoed: local.vetoed,
                    zRoof: local.zRoof,
                    zPatch: local.zPatch,
                    zEgo: local.zEgo,
                    zFarPred: local.zFarPred,
                    deltaBottom: zBottom - local.zc,
                    count: local.count,
                    phase: local.phase || (P2.enabled ? 2 : 1),
                    nbInfo: local.nbInfo || null,
                    p1Snapshot: local.p1Snapshot || null,
                    anchorCount: nAnchTotal
                };
            }
        }

        if (!surfaceData) return null;
        const base = this.layMatDuongTaiViTri(surfaceData, cx, cy);
        if (!base) return null;
        if (!(Number.isFinite(L) && L > 0.3 && Number.isFinite(W) && W > 0.2)) return base;

        const cosRz = Math.cos(rz || 0), sinRz = Math.sin(rz || 0);
        const uRatios = [-0.42, -0.21, 0, 0.21, 0.42];
        const vRatios = [-0.40, 0, 0.40];
        const pts = [];
        const weights = [];

        for (let i = 0; i < uRatios.length; i++) {
            const u = uRatios[i] * L;
            const uW = (Math.abs(uRatios[i]) > 0.15) ? 1.15 : 1.0;
            for (let j = 0; j < vRatios.length; j++) {
                const v = vRatios[j] * W;
                const px = cx + u * cosRz - v * sinRz;
                const py = cy + u * sinRz + v * cosRz;
                const q = this.layMatDuongTaiViTri(surfaceData, px, py);
                if (!q || !Number.isFinite(q.zRoad)) continue;
                let w = uW * ((q.source === 'extrapolated' || q.source === 'occluded') ? 0.25 : (q.source === 'sparse' ? 0.55 : 1.0));
                if (q.type !== base.type || Math.abs(q.zRoad - base.zRoad) > 0.12) w *= 0.10;
                pts.push([px, py, q.zRoad]);
                weights.push(w);
            }
        }
        if (pts.length < 4) return base;

        const fit = this.fitRegularizedPlane(pts, cx, cy, base.gx || 0, base.gy || 0, base.zRoad, 0.25, 0.05, weights);
        if (!fit) return base;
        const gx = this.clamp(fit.gx, -0.16, 0.16);
        const gy = this.clamp(fit.gy, -0.16, 0.16);
        const surfResult = {
            zRoad: fit.zc,
            rx: gy,
            ry: -gx,
            gx,
            gy,
            type: base.type,
            source: base.source,
            tile: base.tile
        };
        if (rawPts && rawPts.length >= 40 && Math.hypot(cx, cy) <= 22.0) {
            return this._tinhChinhLocalBoxTheoSurface(surfResult, cx, cy, rz, L, W, rawPts);
        }
        return surfResult;
    }

    /**
     * Vi chỉnh cục bộ theo điểm LiDAR dày quanh đáy xe gần Ego (r <= 22m), giữ neo chặt vào Surface
     * để ôm sát độ cong/bẻ dốc dưới 4 bánh mà không bị lệch khi một đầu xe bị che khuất.
     */
    static _tinhChinhLocalBoxTheoSurface(baseFit, cx, cy, rz, L, W, rawPts) {
        const cosRz = Math.cos(rz || 0), sinRz = Math.sin(rz || 0);
        const halfU = 0.62 * L, halfV = 0.72 * W;
        const inv2U = 1 / (2 * halfU), inv2V = 1 / (2 * halfV);
        const nU = 6, nV = 3;
        const cells = Array.from({ length: nU * nV }, () => []);

        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const dx = p[0] - cx, dy = p[1] - cy;
            const u = dx * cosRz + dy * sinRz;
            const v = -dx * sinRz + dy * cosRz;
            if (Math.abs(u) > halfU || Math.abs(v) > halfV) continue;

            const zSurf = baseFit.zRoad + baseFit.gx * dx + baseFit.gy * dy;
            const dz = p[2] - zSurf;
            if (dz < -0.105 || dz > 0.085) continue;
            if (Math.abs(u) <= 0.48 * L && Math.abs(v) <= 0.46 * W && dz > 0.065) continue;
            // Bỏ các điểm gờ vỉa hè nhô cao ở dải ngoài hông xe (|v| > 0.46 * W và dz > 0.05) để tránh đội RMS
            if (Math.abs(v) > 0.46 * W && dz > 0.050) continue;

            const iu = Math.min(nU - 1, Math.max(0, Math.floor((u + halfU) * inv2U * nU)));
            const iv = Math.min(nV - 1, Math.max(0, Math.floor((v + halfV) * inv2V * nV)));
            cells[iu * nV + iv].push(p);
        }

        const reps = [], repW = [];
        let rearCells = 0, frontCells = 0;
        for (let iu = 0; iu < nU; iu++) {
            for (let iv = 0; iv < nV; iv++) {
                const arr = cells[iu * nV + iv];
                if (arr.length < 2) continue;
                arr.sort((a, b) => a[2] - b[2]);
                reps.push(arr[Math.floor((arr.length - 1) * 0.45)]);
                repW.push(Math.min(2.0, 0.7 + 0.15 * Math.sqrt(arr.length)));
                if (iu < nU / 2) rearCells++;
                else frontCells++;
            }
        }
        if (reps.length < 5 || rearCells < 2 || frontCells < 2) return baseFit;

        const st = this.tinhThongKePhanBoXY(reps, cx, cy);
        if (st.lambdaMin < 0.22) return baseFit;

        const fit = this.fitRegularizedPlane(reps, cx, cy, baseFit.gx, baseFit.gy, baseFit.zRoad, 1.0, 0.08, repW);
        if (!fit) return baseFit;

        let s2 = 0;
        for (let i = 0; i < reps.length; i++) {
            const p = reps[i];
            const e = p[2] - (fit.zc + fit.gx * (p[0] - cx) + fit.gy * (p[1] - cy));
            s2 += e * e;
        }
        if (Math.sqrt(s2 / reps.length) > 0.032) return baseFit;

        const zRoad = baseFit.zRoad + this.clamp(fit.zc - baseFit.zRoad, -0.025, 0.025);
        const gx = this.clamp(baseFit.gx + this.clamp(fit.gx - baseFit.gx, -0.045, 0.045), -0.16, 0.16);
        const gy = this.clamp(baseFit.gy + this.clamp(fit.gy - baseFit.gy, -0.045, 0.045), -0.16, 0.16);
        return {
            zRoad,
            rx: gy,
            ry: -gx,
            gx,
            gy,
            type: baseFit.type,
            source: baseFit.source,
            tile: baseFit.tile
        };
    }

    // =========================================================================
    // 5. BỘ VẼ THREE.JS LÊN BẢN ĐỒ 3D CVAT (KHÔNG CẦN window.THREE)
    // =========================================================================

    layThongTinThreeJS() {
        if (typeof window === 'undefined' || typeof document === 'undefined') return null;
        const ann = window.quanLyAPICVAT?.getAnnotationState?.();
        const canvas = ann?.canvas?.instance;
        const views = canvas?.view?.views;
        if (!views) return null;

        let BufferGeoCtor = null;
        let BufferAttrCtor = null;
        let MeshCtor = null;
        let MatMeshTemplate = null;
        let LineSegCtor = null;
        let MatLineTemplate = null;
        let PointsCtor = null;
        let MatPtsTemplate = null;
        let vertexColorVal = true;

        const scanScene = (scene) => {
            if (!scene || typeof scene.traverse !== 'function') return;
            scene.traverse((o) => {
                if (!o) return;
                if (o.isPoints && o.geometry) {
                    if (!PointsCtor) PointsCtor = o.constructor;
                    if (!BufferGeoCtor) BufferGeoCtor = o.geometry.constructor;
                    const posAttr = o.geometry.attributes?.position;
                    if (posAttr && !BufferAttrCtor) BufferAttrCtor = posAttr.constructor;
                    if (o.material && !MatPtsTemplate) {
                        MatPtsTemplate = o.material;
                        if (o.material.vertexColors !== undefined) vertexColorVal = o.material.vertexColors || true;
                    }
                }
                if (o.isMesh && o.material) {
                    const m = Array.isArray(o.material) ? o.material[0] : o.material;
                    if (
                        m &&
                        !m.isShaderMaterial &&
                        !m.isMeshStandardMaterial &&
                        !m.isMeshLambertMaterial &&
                        !m.isMeshPhongMaterial &&
                        (m.type === 'MeshBasicMaterial' || m.isMeshBasicMaterial)
                    ) {
                        MeshCtor = o.constructor;
                        MatMeshTemplate = m;
                    }
                    if (!BufferGeoCtor && o.geometry) BufferGeoCtor = o.geometry.constructor;
                    const posAttr = o.geometry?.attributes?.position;
                    if (posAttr && !BufferAttrCtor) BufferAttrCtor = posAttr.constructor;
                }
                if (o.isLineSegments && o.material) {
                    const m = Array.isArray(o.material) ? o.material[0] : o.material;
                    if (
                        m &&
                        !m.isShaderMaterial &&
                        !m.isLineDashedMaterial &&
                        (m.type === 'LineBasicMaterial' || m.isLineBasicMaterial || !MatLineTemplate)
                    ) {
                        LineSegCtor = o.constructor;
                        MatLineTemplate = m;
                    }
                }
            });
        };

        for (const k of ['perspective', 'top', 'side', 'front']) {
            if (views[k]?.scene) scanScene(views[k].scene);
        }

        if (!BufferGeoCtor || !BufferAttrCtor) return null;

        return {
            canvas,
            views,
            BufferGeoCtor,
            BufferAttrCtor,
            MeshCtor,
            MatMeshTemplate,
            LineSegCtor,
            MatLineTemplate,
            PointsCtor,
            MatPtsTemplate,
            vertexColorVal
        };
    }

    xoaOverlay3D() {
        for (const entry of this._overlayObjects) {
            try {
                entry.scene?.remove?.(entry.obj);
            } catch (e) {}
        }
        this._overlayObjects = [];

        const disposeRes = (r) => { try { r?.dispose?.(); } catch (e) {} };
        disposeRes(this._sharedGeoMesh);
        disposeRes(this._sharedGeoLine);
        disposeRes(this._sharedGeoPts);
        disposeRes(this._matMesh);
        disposeRes(this._matLine);
        disposeRes(this._matPts);

        this._sharedGeoMesh = null;
        this._sharedGeoLine = null;
        this._sharedGeoPts = null;
        this._matMesh = null;
        this._matLine = null;
        this._matPts = null;
        if (this._polarRes) {
            disposeRes(this._polarRes.geoMesh);
            disposeRes(this._polarRes.geoLine);
            disposeRes(this._polarRes.matMesh);
            disposeRes(this._polarRes.matLine);
            this._polarRes = null;
        }
        this._activeOverlayMode = null;
        this._tileVertexRanges.clear();

        this.kichHoatRenderCVAT();
    }

    kichHoatRenderCVAT() {
        if (typeof window === 'undefined') return;
        try {
            const ann = window.quanLyAPICVAT?.getAnnotationState?.();
            const canvas = ann?.canvas?.instance;
            if (canvas && typeof canvas.render === 'function') {
                canvas.render();
            }
            const views = canvas?.view?.views;
            if (views) {
                for (const k of ['perspective', 'top', 'side', 'front']) {
                    const v = views[k];
                    if (v?.renderer && v?.scene && v?.camera) {
                        v.renderer.render(v.scene, v.camera);
                    }
                }
            }
        } catch (e) {}
    }

    static layMauOTile(tile, isSelected, isHovered, layerIdx = 0) {
        // Màu hồng nhạt chủ đạo theo yêu cầu của Kiệt
        if (isSelected) {
            return {
                fill: [0.96, 0.25, 0.58],  // Hồng neon rực
                line: [1.00, 0.92, 0.97]   // Viền trắng hồng sáng
            };
        }
        if (isHovered) {
            return {
                fill: [0.98, 0.45, 0.72],  // Hồng sáng khi rê chuột
                line: [1.00, 0.65, 0.85]
            };
        }
        if (tile.type === 'sidewalk') {
            // Vỉa hè: Hồng san hô / tím oải hương nhạt để phân biệt rõ ràng với lòng đường
            return {
                fill: [0.93, 0.55, 0.86],
                line: [0.88, 0.35, 0.80]
            };
        }
        if (tile.source === 'extrapolated' || tile.source === 'occluded') {
            // Vùng bị che khuất máy tự đoán: hồng phấn mờ hơn
            return {
                fill: [0.98, 0.78, 0.88],
                line: [0.85, 0.48, 0.68]
            };
        }

        // Mặt đường chính: Hồng nhạt (#f9a8d4) thay đổi sắc độ nhẹ theo từng Lớp đồng phẳng
        const shades = [
            [0.98, 0.66, 0.83], // #f9a8d4
            [0.99, 0.73, 0.87], // #fbcfe8
            [0.96, 0.58, 0.78], // hồng đào nhạt
            [0.98, 0.69, 0.81]  // hồng cánh sen nhạt
        ];
        const fill = shades[layerIdx % shades.length];
        const line = tile.manual ? [1.00, 0.85, 0.35] : [0.95, 0.45, 0.71]; // Ô đã sửa tay có viền ánh vàng
        return { fill, line };
    }

    static MAU_POLAR = {
        roadFill3d: [0.133, 0.827, 0.933],
        roadLine3d: [0.000, 0.898, 1.000],
        roadStroke2d: '#00e5ff',
        roadFillPrefix: 'rgba(34, 211, 238, ',
        coralFill3d: [0.984, 0.443, 0.522],
        coralLine3d: [1.000, 0.231, 0.361],
        coralStroke2d: '#ff3b5c',
        coralFillPrefix: 'rgba(251, 113, 133, ',
        unk3d: [0.753, 0.518, 0.988],
        unkStroke2d: '#c084fc',
        jump13d: [0.984, 0.573, 0.235],
        jump1Stroke2d: '#fb923c',
        jump23d: [0.937, 0.267, 0.267],
        jump2Stroke2d: '#ef4444'
    };

    chuyenCheDoLuoi(mode) {
        const nextMode = (mode === 'dongtam' || mode === 'ca_hai' || mode === 'v4') ? mode : 'dongtam';
        if (nextMode !== this._cheDoLuoi) {
            this._cheDoLuoi = nextMode;
            this._polarFallback = false;
            this._polarFail = null;
            this._polarLastToastKey = '';
            try {
                if (typeof localStorage !== 'undefined') localStorage.setItem('cvat_surface_cheDoLuoi', nextMode);
            } catch (_) {}
            this.xoaOverlay3D();
        }
        if (this.isActive) this.veLaiToanBo(true);
        else this.capNhatBangSurfaceUI();
        return this._cheDoLuoi;
    }

    static _moTaLyDoPolar(reason) {
        if (!reason) return 'chưa có dữ liệu';
        if (reason === 'no_cloud') return 'chưa nạp đám mây điểm LiDAR';
        if (reason === 'cloud_stale') return 'đám mây frame mới đang đồng bộ';
        if (reason === 'few_pts') return 'ít điểm LiDAR (<100)';
        if (reason === 'few_kept') return 'ít điểm mặt đường quanh xe';
        if (reason === 'no_leaf') return 'không tách được lá mặt đường';
        if (reason === 'no_three_mat') return 'thiếu material Three.js';
        if (reason === 'no_mat_class') return 'chưa nạp lớp MatDuongDongTam';
        return String(reason);
    }

    _capNhatPolarDiag(env, extra = {}) {
        if (typeof window === 'undefined') return;
        try {
            window.__cvatPolarDiag = {
                mode: this._cheDoLuoi,
                fallback: !!this._polarFallback,
                reason: this._polarFail?.reason || null,
                liveFrame: this.liveFrame,
                stats: this._polarStats || null,
                attrCtor: env?.BufferAttrCtor?.name || null,
                attrShared: this._polarRes?.attrShared ?? null,
                matMeshType: env?.MatMeshTemplate?.type || null,
                matLineType: env?.MatLineTemplate?.type || null,
                objects: this._overlayObjects?.length || 0,
                vertMesh: this._polarStats?.vertMesh || 0,
                vertLine: this._polarStats?.vertLine || 0,
                skipped: this._polarStats?.skipped || 0,
                ...extra
            };
        } catch (_) {}
    }

    layMatDongTamFrame(fn, forceRecalc = false) {
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum)) return null;
        const MatCtor = typeof MatDuongDongTam !== 'undefined'
            ? MatDuongDongTam
            : (typeof globalThis !== 'undefined' ? globalThis.MatDuongDongTam : null);
        if (!MatCtor || typeof MatCtor.xayDung !== 'function') {
            this._polarFail = { fn: frameNum, reason: 'no_mat_class' };
            return null;
        }

        const key = this.layKeyHienTai(frameNum);
        if (!forceRecalc && this._polarCache.has(key)) {
            const hit = this._polarCache.get(key);
            if (hit && hit.sanSang) {
                this._polarCache.delete(key);
                this._polarCache.set(key, hit);
                return hit;
            }
            this._polarCache.delete(key);
        }

        const boxes = this.layDanhSachBoxTrongFrame(frameNum);
        const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
        const allowThreeJS = (frameNum === this.liveFrame);
        const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
        if (!raw || !(raw.count >= 100)) {
            this._polarFail = { fn: frameNum, reason: raw ? 'few_pts' : 'no_cloud' };
            return null;
        }

        // Chống dùng nhầm cloud của frame trước khi CVAT chưa kịp swap buffer lúc chuyển frame
        if (raw.source === 'three' && raw.uuid && !forceRecalc) {
            for (const [cKey, cVal] of this._polarCache.entries()) {
                if (cKey !== key && cVal && cVal._cloudUuid === raw.uuid) {
                    this._polarFail = { fn: frameNum, reason: 'cloud_stale' };
                    return null;
                }
            }
        }

        let mat = null;
        try {
            const egoP = this.egoPlaneCache.get(frameNum) || ThuatToanSurface.tinhEgoGroundPlane(raw.ptsArray || null);
            const neoList = ThuatToanSurface._thuThapNeoTuBoxes(boxes, egoP, { frame: frameNum });
            const polarOpts = neoList.length > 0 ? { neoList } : {};
            if (this._diemGayOverBudget) polarOpts.diemGay = false;
            mat = MatCtor.xayDung(raw, boxes, polarOpts);
        } catch (e) {
            console.error('[Đồng Tâm] Lỗi xayDung:', e);
            this._polarFail = { fn: frameNum, reason: 'exception: ' + (e?.message || e) };
            return null;
        }
        if (!mat || !mat.sanSang) {
            const d = mat?.diag;
            const r = !d || d.totalRawPts < 100 ? 'few_pts' : (d.keptPts < 100 ? 'few_kept' : 'no_leaf');
            this._polarFail = { fn: frameNum, reason: r };
            return null;
        }

        mat._cloudUuid = raw.uuid || null;
        this._polarCache.set(key, mat);
        if (this._polarCache.size > 12) {
            const oldest = this._polarCache.keys().next().value;
            if (oldest !== undefined) this._polarCache.delete(oldest);
        }
        return mat;
    }

    static layMauLa(leaf, isSel = false, isHov = false) {
        const P = ThuatToanSurface.MAU_POLAR;
        if (!leaf || leaf.loai === 'UNKNOWN') {
            return {
                fill: P.unk3d,
                line: isSel ? [0.992, 0.878, 0.278] : P.unk3d
            };
        }
        const densT = Math.min(1, Math.log1p(leaf.nDiem || 0) / Math.log1p(120));
        const br = 0.68 + 0.32 * densT;
        const baseFill = leaf.ngoaiDuong ? P.coralFill3d : P.roadFill3d;
        let fill = [baseFill[0] * br, baseFill[1] * br, baseFill[2] * br];
        let line = leaf.ngoaiDuong ? P.coralLine3d : P.roadLine3d;
        if (isSel) {
            fill = [0.992, 0.878, 0.278];
            line = [1.000, 0.920, 0.350];
        } else if (isHov) {
            fill = [Math.min(1, fill[0] + 0.25), Math.min(1, fill[1] + 0.15), Math.min(1, fill[2] + 0.10)];
            line = [1.000, 0.960, 0.500];
        }
        return { fill, line };
    }

    static layCanhNhay(mat) {
        if (!mat || !mat.sanSang) return [];
        if (Array.isArray(mat._canhNhay)) return mat._canhNhay;
        const leaves = mat.layDanhSachLa();
        const out = [];
        const seen = new Set();

        const checkEdge = (xA, yA, zA, xB, yB, zB, nx, ny) => {
            if (!Number.isFinite(xA + yA + zA + xB + yB + zB)) return;
            const mx = 0.5 * (xA + xB), my = 0.5 * (yA + yB);
            const k = `${Math.round(mx * 20)},${Math.round(my * 20)}`;
            if (seen.has(k)) return;
            seen.add(k);
            const zIn = mat.zTai(mx - nx * 0.02, my - ny * 0.02);
            const zOut = mat.zTai(mx + nx * 0.02, my + ny * 0.02);
            if (!Number.isFinite(zIn) || !Number.isFinite(zOut)) return;
            const dz = Math.abs(zOut - zIn);
            if (dz >= 0.03) {
                out.push({ x1: xA, y1: yA, z1: zA, x2: xB, y2: yB, z2: zB, level: 2 });
            } else if (dz >= 0.01) {
                out.push({ x1: xA, y1: yA, z1: zA, x2: xB, y2: yB, z2: zB, level: 1 });
            }
        };

        for (let i = 0; i < leaves.length; i++) {
            const lf = leaves[i];
            if (!lf || lf.loai !== 'LEAF') continue;
            if (!Number.isFinite(lf.r0 + lf.r1 + lf.t0 + lf.t1) || lf.r1 <= lf.r0) continue;
            const c0 = Math.cos(lf.t0), s0 = Math.sin(lf.t0);
            const c1 = Math.cos(lf.t1), s1 = Math.sin(lf.t1);
            const ax0 = lf.r0 * c0, ay0 = lf.r0 * s0, az0 = mat.zTaiLa(lf, ax0, ay0);
            const ax1 = lf.r1 * c0, ay1 = lf.r1 * s0, az1 = mat.zTaiLa(lf, ax1, ay1);
            const bx0 = lf.r0 * c1, by0 = lf.r0 * s1, bz0 = mat.zTaiLa(lf, bx0, by0);
            const bx1 = lf.r1 * c1, by1 = lf.r1 * s1, bz1 = mat.zTaiLa(lf, bx1, by1);
            const tm = 0.5 * (lf.t0 + lf.t1), cm = Math.cos(tm), sm = Math.sin(tm);
            checkEdge(ax1, ay1, az1, bx1, by1, bz1, cm, sm);
            checkEdge(bx0, by0, bz0, bx1, by1, bz1, -s1, c1);
            if (Math.abs(lf.t0 + Math.PI) > 1e-4) {
                checkEdge(ax0, ay0, az0, ax1, ay1, az1, -s0, c0);
            }
        }
        mat._canhNhay = out;
        return out;
    }

    _damBaoTaiNguyenPolar(env) {
        if (this._polarRes) return this._polarRes;
        const MAX_VERT = 120000;
        const meshPosRaw = new Float32Array(MAX_VERT * 3);
        const meshColRaw = new Float32Array(MAX_VERT * 3);
        const linePosRaw = new Float32Array(MAX_VERT * 3);
        const lineColRaw = new Float32Array(MAX_VERT * 3);

        const setAttr = (geo, name, arr) => {
            const attr = new env.BufferAttrCtor(arr, 3);
            if (typeof geo.setAttribute === 'function') geo.setAttribute(name, attr);
            else if (typeof geo.addAttribute === 'function') geo.addAttribute(name, attr);
            const stored = geo.attributes?.[name]?.array;
            return { arr: stored || arr, shared: stored ? (stored === arr) : true };
        };

        let geoMesh = null, matMesh = null;
        let meshPos = meshPosRaw, meshCol = meshColRaw;
        let attrShared = null;
        if (env.MeshCtor && env.MatMeshTemplate) {
            geoMesh = new env.BufferGeoCtor();
            const rP = setAttr(geoMesh, 'position', meshPosRaw);
            const rC = setAttr(geoMesh, 'color', meshColRaw);
            meshPos = rP.arr;
            meshCol = rC.arr;
            attrShared = rP.shared;
            matMesh = env.MatMeshTemplate.clone();
            try {
                if (matMesh.color?.setHex) matMesh.color.setHex(0xffffff);
                matMesh.vertexColors = env.vertexColorVal;
                matMesh.transparent = true;
                matMesh.opacity = 0.42;
                matMesh.side = 2;
                matMesh.depthWrite = false;
                matMesh.depthTest = true;
                matMesh.wireframe = false;
                matMesh.polygonOffset = true;
                matMesh.polygonOffsetFactor = -1;
                matMesh.polygonOffsetUnits = -1;
                if ('toneMapped' in matMesh) matMesh.toneMapped = false;
                if ('fog' in matMesh) matMesh.fog = false;
                if ('map' in matMesh) matMesh.map = null;
                matMesh.needsUpdate = true;
            } catch (_) {}
        }

        let geoLine = null, matLine = null;
        let linePos = linePosRaw, lineCol = lineColRaw;
        if (env.LineSegCtor && env.MatLineTemplate) {
            geoLine = new env.BufferGeoCtor();
            const rLP = setAttr(geoLine, 'position', linePosRaw);
            const rLC = setAttr(geoLine, 'color', lineColRaw);
            linePos = rLP.arr;
            lineCol = rLC.arr;
            if (attrShared === null) attrShared = rLP.shared;
            matLine = env.MatLineTemplate.clone();
            try {
                if (matLine.color?.setHex) matLine.color.setHex(0xffffff);
                matLine.vertexColors = env.vertexColorVal;
                matLine.transparent = true;
                matLine.opacity = 1.0;
                matLine.depthWrite = false;
                if ('toneMapped' in matLine) matLine.toneMapped = false;
                if ('fog' in matLine) matLine.fog = false;
                matLine.needsUpdate = true;
            } catch (_) {}
        }

        this._polarRes = {
            maxVert: MAX_VERT,
            attrShared,
            geoMesh, geoLine, matMesh, matLine,
            meshPos, meshCol, linePos, lineCol
        };
        return this._polarRes;
    }

    _dungHinhDongTam(env, drawV4Wire = false) {
        const mat = this.layMatDongTamFrame(this.liveFrame, false);
        if (!mat || !mat.sanSang) {
            this._polarStats = { nLa: 0, nLeafValid: 0, nUnknown: 0, nCanhNhayCam: 0, nCanhNhayDo: 0, buildMs: 0, drawMs: 0, skipped: 0, vertMesh: 0, vertLine: 0 };
            this._capNhatPolarDiag(env);
            return false;
        }
        const res = this._damBaoTaiNguyenPolar(env);
        if (!res.geoMesh && !res.geoLine) {
            this._polarFail = { fn: this.liveFrame, reason: 'no_three_mat' };
            this._polarStats = { nLa: mat.diag.nLa, nLeafValid: mat.diag.nLeafValid, nUnknown: mat.diag.nUnknown, nCanhNhayCam: 0, nCanhNhayDo: 0, buildMs: mat.diag.buildMs || 0, drawMs: 0, skipped: 0, vertMesh: 0, vertLine: 0 };
            this._capNhatPolarDiag(env);
            return false;
        }
        const tDraw0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        const expectedMode = drawV4Wire ? 'ca_hai' : 'dongtam';
        const needAttach = this._activeOverlayMode !== expectedMode
            || this._overlayObjects.length === 0
            || !this._overlayObjects.every(item => item.obj && item.scene && item.obj.parent === item.scene);
        if (needAttach) {
            this.xoaOverlay3D();
            this._activeOverlayMode = expectedMode;
        }

        const resActive = this._damBaoTaiNguyenPolar(env);
        const MAX_VERT = resActive.maxVert;
        const leaves = mat.layDanhSachLa();
        const zBias = 0.012;
        const egoRaw = this.egoPlaneCache?.get(this.liveFrame);
        const egoFallback = {
            z0: Number.isFinite(egoRaw?.z0) ? egoRaw.z0 : 0,
            gx: Number.isFinite(egoRaw?.gx) ? egoRaw.gx : 0,
            gy: Number.isFinite(egoRaw?.gy) ? egoRaw.gy : 0
        };

        // Tính bước chia cung thích ứng bảo đảm võng dây cung <= eps và không vượt MAX_VERT
        const calcSegs = (leaf, eps) => {
            const dTheta = Math.max(1e-4, leaf.t1 - leaf.t0);
            const rOut = Math.max(0.5, leaf.r1);
            const cosVal = Math.max(-0.99, 1.0 - eps / rOut);
            const maxStepSag = 2.0 * Math.acos(cosVal);
            const maxStep = Math.min(maxStepSag, 0.22);
            return Math.max(1, Math.min(24, Math.ceil(dTheta / Math.max(0.02, maxStep))));
        };

        let chosenEps = 0.02;
        for (const candEps of [0.02, 0.04, 0.08]) {
            let estM = 0, estL = 0;
            for (let i = 0; i < leaves.length; i++) {
                const lf = leaves[i];
                if (!Number.isFinite(lf.r0 + lf.r1 + lf.t0 + lf.t1) || lf.r1 <= lf.r0) continue;
                const ns = calcSegs(lf, candEps);
                if (lf.loai === 'LEAF') {
                    estM += ns * 6;
                    estL += (ns * 2 + 2) * 2;
                } else if (this._hienUnknownPolar) {
                    estL += (ns * 2 + 2) * 2;
                }
            }
            chosenEps = candEps;
            if (estM <= MAX_VERT - 600 && estL <= MAX_VERT - 4000) break;
        }

        let mVert = 0;
        let lVert = 0;
        let skipped = 0;
        let nCanhNhayCam = 0;
        let nCanhNhayDo = 0;
        const mPos = resActive.meshPos, mCol = resActive.meshCol;
        const lPos = resActive.linePos, lCol = resActive.lineCol;

        const pushTri = (x1, y1, z1, x2, y2, z2, x3, y3, z3, col) => {
            if (!resActive.geoMesh) return true;
            if (mVert + 3 > MAX_VERT) return false;
            if (!Number.isFinite(x1 + y1 + z1 + x2 + y2 + z2 + x3 + y3 + z3)) return false;
            const b = mVert * 3;
            mPos[b] = x1; mPos[b + 1] = y1; mPos[b + 2] = z1;
            mPos[b + 3] = x2; mPos[b + 4] = y2; mPos[b + 5] = z2;
            mPos[b + 6] = x3; mPos[b + 7] = y3; mPos[b + 8] = z3;
            for (let v = 0; v < 3; v++) {
                mCol[b + v * 3] = col[0];
                mCol[b + v * 3 + 1] = col[1];
                mCol[b + v * 3 + 2] = col[2];
            }
            mVert += 3;
            return true;
        };
        const pushSeg = (x1, y1, z1, x2, y2, z2, col) => {
            if (!resActive.geoLine) return true;
            if (lVert + 2 > MAX_VERT) return false;
            if (!Number.isFinite(x1 + y1 + z1 + x2 + y2 + z2)) return false;
            const b = lVert * 3;
            lPos[b] = x1; lPos[b + 1] = y1; lPos[b + 2] = z1;
            lPos[b + 3] = x2; lPos[b + 4] = y2; lPos[b + 5] = z2;
            lCol[b] = col[0]; lCol[b + 1] = col[1]; lCol[b + 2] = col[2];
            lCol[b + 3] = col[0]; lCol[b + 4] = col[1]; lCol[b + 5] = col[2];
            lVert += 2;
            return true;
        };

        const evalVisZ = (leaf, x, y) => {
            const fallbackZ = egoFallback.z0 + egoFallback.gx * x + egoFallback.gy * y;
            return ThuatToanSurface._evalPolarHienThiZ(mat, leaf, x, y, fallbackZ) + zBias;
        };

        for (let i = 0; i < leaves.length; i++) {
            const lf = leaves[i];
            if (!lf || !Number.isFinite(lf.r0 + lf.r1 + lf.t0 + lf.t1) || lf.r1 <= lf.r0 || lf.t1 <= lf.t0) {
                skipped++;
                continue;
            }
            const isUnknown = lf.loai === 'UNKNOWN';
            if (isUnknown && !this._hienUnknownPolar) continue;

            const nSeg = calcSegs(lf, chosenEps);
            const needM = isUnknown ? 0 : nSeg * 6;
            const needL = isUnknown ? (nSeg * 2 + 4) : (nSeg * 2 + 2) * 2;
            if (mVert + needM > MAX_VERT || lVert + needL > MAX_VERT) {
                skipped++;
                continue;
            }

            const { fill, line } = ThuatToanSurface.layMauLa(lf, false, false);
            const dt = (lf.t1 - lf.t0) / nSeg;

            for (let s = 0; s < nSeg; s++) {
                const ta = lf.t0 + s * dt;
                const tb = lf.t0 + (s + 1) * dt;
                const ca = Math.cos(ta), sa = Math.sin(ta);
                const cb = Math.cos(tb), sb = Math.sin(tb);

                const x00 = lf.r0 * ca, y00 = lf.r0 * sa, z00 = evalVisZ(lf, x00, y00);
                const x10 = lf.r1 * ca, y10 = lf.r1 * sa, z10 = evalVisZ(lf, x10, y10);
                const x11 = lf.r1 * cb, y11 = lf.r1 * sb, z11 = evalVisZ(lf, x11, y11);
                const x01 = lf.r0 * cb, y01 = lf.r0 * sb, z01 = evalVisZ(lf, x01, y01);

                if (!isUnknown) {
                    const zMaxQ = Math.max(z00, z10, z11, z01);
                    const zMinQ = Math.min(z00, z10, z11, z01);
                    if ((zMaxQ - zMinQ) <= 0.20) {
                        pushTri(x00, y00, z00, x10, y10, z10, x11, y11, z11, fill);
                        pushTri(x00, y00, z00, x11, y11, z11, x01, y01, z01, fill);
                    }
                    pushSeg(x00, y00, z00, x01, y01, z01, line);
                    pushSeg(x10, y10, z10, x11, y11, z11, line);
                } else {
                    // UNKNOWN: KHÔNG đổ fill mesh, chỉ vẽ viền nét đứt xám (#94a3b8)
                    if (s % 2 === 0 || nSeg === 1) {
                        const mx0 = nSeg === 1 ? 0.5 * (x00 + x01) : x01;
                        const my0 = nSeg === 1 ? 0.5 * (y00 + y01) : y01;
                        const mz0 = nSeg === 1 ? 0.5 * (z00 + z01) : z01;
                        const mx1 = nSeg === 1 ? 0.5 * (x10 + x11) : x11;
                        const my1 = nSeg === 1 ? 0.5 * (y10 + y11) : y11;
                        const mz1 = nSeg === 1 ? 0.5 * (z10 + z11) : z11;
                        pushSeg(x00, y00, z00, mx0, my0, mz0, line);
                        pushSeg(x10, y10, z10, mx1, my1, mz1, line);
                    }
                }
            }

            // Hai cạnh bán kính trái/phải của lá
            const c0 = Math.cos(lf.t0), s0 = Math.sin(lf.t0);
            const c1 = Math.cos(lf.t1), s1 = Math.sin(lf.t1);
            const ax0 = lf.r0 * c0, ay0 = lf.r0 * s0, az0 = evalVisZ(lf, ax0, ay0);
            const ax1 = lf.r1 * c0, ay1 = lf.r1 * s0, az1 = evalVisZ(lf, ax1, ay1);
            const bx0 = lf.r0 * c1, by0 = lf.r0 * s1, bz0 = evalVisZ(lf, bx0, by0);
            const bx1 = lf.r1 * c1, by1 = lf.r1 * s1, bz1 = evalVisZ(lf, bx1, by1);
            if (!isUnknown) {
                pushSeg(ax0, ay0, az0, ax1, ay1, az1, line);
                pushSeg(bx0, by0, bz0, bx1, by1, bz1, line);
            } else {
                const m1x = 0.5 * (ax0 + ax1), m1y = 0.5 * (ay0 + ay1), m1z = 0.5 * (az0 + az1);
                const m2x = 0.5 * (bx0 + bx1), m2y = 0.5 * (by0 + by1), m2z = 0.5 * (bz0 + bz1);
                pushSeg(ax0, ay0, az0, m1x, m1y, m1z, line);
                pushSeg(bx0, by0, bz0, m2x, m2y, m2z, line);
            }
        }

        // Highlight cạnh nhảy Z giữa các lá kề nhau (dùng chung layCanhNhay, zBias cao hơn để nổi rõ)
        if (this._hienCanhNhayPolar) {
            const jumpEdges = ThuatToanSurface.layCanhNhay(mat);
            const P = ThuatToanSurface.MAU_POLAR;
            const zJ = zBias + 0.020;
            for (let i = 0; i < jumpEdges.length; i++) {
                const e = jumpEdges[i];
                const col = e.level === 2 ? P.jump23d : P.jump13d;
                if (pushSeg(e.x1, e.y1, e.z1 + zJ, e.x2, e.y2, e.z2 + zJ, col)) {
                    if (e.level === 2) nCanhNhayDo++;
                    else nCanhNhayCam++;
                }
            }
        }

        // Chế độ "Cả hai": vẽ thêm wireframe hồng v4 nhẹ để đối chiếu trực quan với đồng tâm
        if (drawV4Wire) {
            const v4Data = this.laySurfaceFrame(this.liveFrame);
            const v4Tiles = v4Data?.tiles || [];
            const wireCol = [0.957, 0.447, 0.714]; // #f472b6
            for (let i = 0; i < v4Tiles.length && lVert + 8 <= MAX_VERT; i++) {
                const t = v4Tiles[i];
                const z00 = ThuatToanSurface.evalTileZ(t, t.x0, t.y0) + 0.006;
                const z10 = ThuatToanSurface.evalTileZ(t, t.x1, t.y0) + 0.006;
                const z11 = ThuatToanSurface.evalTileZ(t, t.x1, t.y1) + 0.006;
                const z01 = ThuatToanSurface.evalTileZ(t, t.x0, t.y1) + 0.006;
                pushSeg(t.x0, t.y0, z00, t.x1, t.y0, z10, wireCol);
                pushSeg(t.x1, t.y0, z10, t.x1, t.y1, z11, wireCol);
                pushSeg(t.x1, t.y1, z11, t.x0, t.y1, z01, wireCol);
                pushSeg(t.x0, t.y1, z01, t.x0, t.y0, z00, wireCol);
            }
        }

        if (mVert > Math.floor(0.8 * MAX_VERT) || lVert > Math.floor(0.8 * MAX_VERT)) {
            if (!this._polarVertWarned) {
                this._polarVertWarned = true;
                console.warn(`[Đồng Tâm] Cảnh báo đỉnh vượt 80% MAX_VERT (${mVert}/${lVert}), tự tắt diemGay ở lần dựng kế tiếp.`);
            }
            this._diemGayOverBudget = true;
        }
        if (mVert === 0 && lVert === 0) {
            this._polarFail = { fn: this.liveFrame, reason: 'no_leaf' };
            this._capNhatPolarDiag(env);
            return false;
        }

        if (resActive.geoMesh) {
            if (typeof resActive.geoMesh.setDrawRange === 'function') resActive.geoMesh.setDrawRange(0, mVert);
            if (resActive.geoMesh.attributes?.position) resActive.geoMesh.attributes.position.needsUpdate = true;
            if (resActive.geoMesh.attributes?.color) resActive.geoMesh.attributes.color.needsUpdate = true;
            try { resActive.geoMesh.computeBoundingSphere?.(); } catch (_) {}
        }
        if (resActive.geoLine) {
            if (typeof resActive.geoLine.setDrawRange === 'function') resActive.geoLine.setDrawRange(0, lVert);
            if (resActive.geoLine.attributes?.position) resActive.geoLine.attributes.position.needsUpdate = true;
            if (resActive.geoLine.attributes?.color) resActive.geoLine.attributes.color.needsUpdate = true;
            try { resActive.geoLine.computeBoundingSphere?.(); } catch (_) {}
        }

        if (needAttach) {
            if (resActive.geoMesh && env.MeshCtor && resActive.matMesh) {
                for (const vk of ['perspective', 'top']) {
                    const sc = env.views[vk]?.scene;
                    if (sc) {
                        const mObj = new env.MeshCtor(resActive.geoMesh, resActive.matMesh);
                        mObj.name = '__cvat_polar_mesh__';
                        mObj.frustumCulled = false;
                        mObj.renderOrder = 2;
                        sc.add(mObj);
                        this._overlayObjects.push({ scene: sc, obj: mObj, viewKey: vk });
                    }
                }
            }
            if (resActive.geoLine && env.LineSegCtor && resActive.matLine) {
                for (const vk of ['perspective', 'top', 'side', 'front']) {
                    const sc = env.views[vk]?.scene;
                    if (sc) {
                        const lObj = new env.LineSegCtor(resActive.geoLine, resActive.matLine);
                        lObj.name = '__cvat_polar_lines__';
                        lObj.frustumCulled = false;
                        lObj.renderOrder = 3;
                        sc.add(lObj);
                        this._overlayObjects.push({ scene: sc, obj: lObj, viewKey: vk });
                    }
                }
            }
        }

        const tDraw1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        this._polarStats = {
            nLa: mat.diag.nLa,
            nLeafValid: mat.diag.nLeafValid,
            nUnknown: mat.diag.nUnknown,
            nCanhNhayCam,
            nCanhNhayDo,
            buildMs: mat.diag.buildMs || 0,
            drawMs: tDraw1 - tDraw0,
            skipped,
            vertMesh: mVert,
            vertLine: lVert,
            eps: chosenEps
        };
        this._polarFail = null;
        this._capNhatPolarDiag(env);
        this.kichHoatRenderCVAT();
        return true;
    }

    veSurfaceLen3D() {
        const env = this.layThongTinThreeJS();
        if (!env) return;

        if (this._cheDoLuoi === 'dongtam' || this._cheDoLuoi === 'ca_hai') {
            const ok = this._dungHinhDongTam(env, this._cheDoLuoi === 'ca_hai');
            if (ok) {
                const wasFallback = this._polarFallback;
                this._polarFallback = false;
                const st = this._polarStats;
                const toastKey = `ok:${this.liveFrame}:${this._cheDoLuoi}`;
                if (wasFallback || this._polarLastToastKey !== toastKey) {
                    this._polarLastToastKey = toastKey;
                    console.info(`[Đồng Tâm] F${this.liveFrame}: ${st.nLa} lá (${st.nLeafValid} LEAF, ${st.nUnknown} UNKNOWN), ${st.vertMesh}v/${st.vertLine}l, attrShared=${this._polarRes?.attrShared}`);
                    if (wasFallback) {
                        this.hienToast(`🧭 Đồng Tâm: ${st.nLa} lá (${st.nLeafValid} LEAF · ${st.nUnknown} UNKNOWN) · ${st.buildMs.toFixed(0)}ms`);
                    }
                }
                return;
            }
            this._polarFallback = true;
            const reason = this._polarFail?.reason || 'unknown';
            const toastKey = `fail:${this.liveFrame}:${reason}`;
            if (this._polarLastToastKey !== toastKey) {
                this._polarLastToastKey = toastKey;
                const desc = ThuatToanSurface._moTaLyDoPolar(reason);
                console.warn(`[Đồng Tâm] F${this.liveFrame} chưa dựng được (${reason}) → tạm hiện v4`);
                this.hienToast(`🧭 Đồng Tâm chưa dựng được (${desc}) → tạm hiện v4`);
            }
            this._capNhatPolarDiag(env);
        } else {
            this._polarFallback = false;
        }
        if (this._activeOverlayMode && this._activeOverlayMode !== 'v4') {
            this.xoaOverlay3D();
        }
        this._activeOverlayMode = 'v4';

        const data = this.laySurfaceFrame(this.liveFrame);
        if (!data || !data.tiles || data.tiles.length === 0) return;

        // Nếu buffer đã tồn tại cùng số lượng tiles -> cập nhật tại chỗ 0ms!
        const tiles = data.tiles;
        const n = tiles.length;
        const expectedMeshVerts = n * 6;
        const expectedLineVerts = n * 8;
        const showSel3D = (Number(this.liveFrame) === Number(this.currentFrame));

        const canUpdateInPlace = (
            this._overlayObjects.length > 0 &&
            this._overlayObjects.every(item => item.obj && item.scene && item.obj.parent === item.scene) &&
            this._sharedGeoLine &&
            this._sharedGeoLine.attributes?.position?.count === expectedLineVerts
        );

        const layerIdxMap = new Map();
        (data.layers || []).forEach((l, idx) => layerIdxMap.set(l.id, idx));

        const zBias = 0.008; // Nâng nhẹ 8mm chống Z-fighting với lưới mặc định của CVAT

        if (canUpdateInPlace) {
            const linePos = this._sharedGeoLine.attributes.position.array;
            const lineCol = this._sharedGeoLine.attributes.color.array;
            const meshPos = this._sharedGeoMesh?.attributes?.position?.array;
            const meshCol = this._sharedGeoMesh?.attributes?.color?.array;
            const ptsPos = this._sharedGeoPts?.attributes?.position?.array;
            const ptsCol = this._sharedGeoPts?.attributes?.color?.array;

            for (let i = 0; i < n; i++) {
                const t = tiles[i];
                const isSel = showSel3D && this.selectedTileIds.has(t.id);
                const isHov = (this.hoveredTileId === t.id);
                const lIdx = layerIdxMap.get(t.layerId) || 0;
                const { fill, line } = ThuatToanSurface.layMauOTile(t, isSel, isHov, lIdx);

                const z00 = ThuatToanSurface.evalTileZ(t, t.x0, t.y0) + zBias;
                const z10 = ThuatToanSurface.evalTileZ(t, t.x1, t.y0) + zBias;
                const z11 = ThuatToanSurface.evalTileZ(t, t.x1, t.y1) + zBias;
                const z01 = ThuatToanSurface.evalTileZ(t, t.x0, t.y1) + zBias;

                // Cập nhật Mesh (6 đỉnh)
                if (meshPos && meshCol) {
                    const mb = i * 18;
                    const coords = [
                        t.x0, t.y0, z00,  t.x1, t.y0, z10,  t.x1, t.y1, z11,
                        t.x0, t.y0, z00,  t.x1, t.y1, z11,  t.x0, t.y1, z01
                    ];
                    for (let k = 0; k < 18; k++) meshPos[mb + k] = coords[k];
                    for (let v = 0; v < 6; v++) {
                        meshCol[mb + v * 3] = fill[0];
                        meshCol[mb + v * 3 + 1] = fill[1];
                        meshCol[mb + v * 3 + 2] = fill[2];
                    }
                }

                // Cập nhật LineSegments (8 đỉnh)
                const lb = i * 24;
                const lCoords = [
                    t.x0, t.y0, z00,  t.x1, t.y0, z10,
                    t.x1, t.y0, z10,  t.x1, t.y1, z11,
                    t.x1, t.y1, z11,  t.x0, t.y1, z01,
                    t.x0, t.y1, z01,  t.x0, t.y0, z00
                ];
                for (let k = 0; k < 24; k++) linePos[lb + k] = lCoords[k];
                for (let v = 0; v < 8; v++) {
                    lineCol[lb + v * 3] = line[0];
                    lineCol[lb + v * 3 + 1] = line[1];
                    lineCol[lb + v * 3 + 2] = line[2];
                }

                // Cập nhật Fallback Points (9 điểm lưới trong ô) nếu không có Mesh
                if (ptsPos && ptsCol) {
                    let pb = i * 27;
                    for (let sx = 0; sx < 3; sx++) {
                        const px = t.x0 + ((sx + 0.5) / 3.0) * t.w;
                        for (let sy = 0; sy < 3; sy++) {
                            const py = t.y0 + ((sy + 0.5) / 3.0) * t.h;
                            const pz = ThuatToanSurface.evalTileZ(t, px, py) + zBias;
                            ptsPos[pb] = px; ptsPos[pb + 1] = py; ptsPos[pb + 2] = pz;
                            ptsCol[pb] = fill[0]; ptsCol[pb + 1] = fill[1]; ptsCol[pb + 2] = fill[2];
                            pb += 3;
                        }
                    }
                }
            }

            if (this._sharedGeoMesh) {
                this._sharedGeoMesh.attributes.position.needsUpdate = true;
                this._sharedGeoMesh.attributes.color.needsUpdate = true;
            }
            this._sharedGeoLine.attributes.position.needsUpdate = true;
            this._sharedGeoLine.attributes.color.needsUpdate = true;
            if (this._sharedGeoPts) {
                this._sharedGeoPts.attributes.position.needsUpdate = true;
                this._sharedGeoPts.attributes.color.needsUpdate = true;
            }

            this.kichHoatRenderCVAT();
            return;
        }

        // Tạo mới hoàn toàn BufferGeometry & Objects
        this.xoaOverlay3D();

        const setGeoAttr = (geo, name, arr) => {
            const attr = new env.BufferAttrCtor(arr, 3);
            if (typeof geo.setAttribute === 'function') geo.setAttribute(name, attr);
            else if (typeof geo.addAttribute === 'function') geo.addAttribute(name, attr);
        };

        const meshPosArr = new Float32Array(expectedMeshVerts * 3);
        const meshColArr = new Float32Array(expectedMeshVerts * 3);
        const linePosArr = new Float32Array(expectedLineVerts * 3);
        const lineColArr = new Float32Array(expectedLineVerts * 3);
        const usePtsFallback = !env.MeshCtor;
        const ptsPosArr = usePtsFallback ? new Float32Array(n * 9 * 3) : null;
        const ptsColArr = usePtsFallback ? new Float32Array(n * 9 * 3) : null;

        for (let i = 0; i < n; i++) {
            const t = tiles[i];
            const isSel = showSel3D && this.selectedTileIds.has(t.id);
            const isHov = (this.hoveredTileId === t.id);
            const lIdx = layerIdxMap.get(t.layerId) || 0;
            const { fill, line } = ThuatToanSurface.layMauOTile(t, isSel, isHov, lIdx);

            const z00 = ThuatToanSurface.evalTileZ(t, t.x0, t.y0) + zBias;
            const z10 = ThuatToanSurface.evalTileZ(t, t.x1, t.y0) + zBias;
            const z11 = ThuatToanSurface.evalTileZ(t, t.x1, t.y1) + zBias;
            const z01 = ThuatToanSurface.evalTileZ(t, t.x0, t.y1) + zBias;

            const mb = i * 18;
            const mCoords = [
                t.x0, t.y0, z00,  t.x1, t.y0, z10,  t.x1, t.y1, z11,
                t.x0, t.y0, z00,  t.x1, t.y1, z11,  t.x0, t.y1, z01
            ];
            for (let k = 0; k < 18; k++) meshPosArr[mb + k] = mCoords[k];
            for (let v = 0; v < 6; v++) {
                meshColArr[mb + v * 3] = fill[0];
                meshColArr[mb + v * 3 + 1] = fill[1];
                meshColArr[mb + v * 3 + 2] = fill[2];
            }

            const lb = i * 24;
            const lCoords = [
                t.x0, t.y0, z00,  t.x1, t.y0, z10,
                t.x1, t.y0, z10,  t.x1, t.y1, z11,
                t.x1, t.y1, z11,  t.x0, t.y1, z01,
                t.x0, t.y1, z01,  t.x0, t.y0, z00
            ];
            for (let k = 0; k < 24; k++) linePosArr[lb + k] = lCoords[k];
            for (let v = 0; v < 8; v++) {
                lineColArr[lb + v * 3] = line[0];
                lineColArr[lb + v * 3 + 1] = line[1];
                lineColArr[lb + v * 3 + 2] = line[2];
            }

            if (usePtsFallback) {
                let pb = i * 27;
                for (let sx = 0; sx < 3; sx++) {
                    const px = t.x0 + ((sx + 0.5) / 3.0) * t.w;
                    for (let sy = 0; sy < 3; sy++) {
                        const py = t.y0 + ((sy + 0.5) / 3.0) * t.h;
                        const pz = ThuatToanSurface.evalTileZ(t, px, py) + zBias;
                        ptsPosArr[pb] = px; ptsPosArr[pb + 1] = py; ptsPosArr[pb + 2] = pz;
                        ptsColArr[pb] = fill[0]; ptsColArr[pb + 1] = fill[1]; ptsColArr[pb + 2] = fill[2];
                        pb += 3;
                    }
                }
            }
        }

        // 1. Tạo Mesh màu hồng nhạt bán trong suốt cho Perspective & Top
        if (env.MeshCtor && env.MatMeshTemplate) {
            this._sharedGeoMesh = new env.BufferGeoCtor();
            setGeoAttr(this._sharedGeoMesh, 'position', meshPosArr);
            setGeoAttr(this._sharedGeoMesh, 'color', meshColArr);
            try { this._sharedGeoMesh.computeBoundingSphere?.(); } catch (e) {}

            this._matMesh = env.MatMeshTemplate.clone();
            try {
                if (this._matMesh.color?.setHex) this._matMesh.color.setHex(0xffffff);
                this._matMesh.vertexColors = env.vertexColorVal;
                this._matMesh.transparent = true;
                this._matMesh.opacity = 0.36;
                this._matMesh.side = 2; // DoubleSide
                this._matMesh.depthWrite = false;
                this._matMesh.depthTest = true;
                this._matMesh.wireframe = false;
                if ('map' in this._matMesh) this._matMesh.map = null;
                this._matMesh.needsUpdate = true;
            } catch (e) {}

            for (const vk of ['perspective', 'top']) {
                const sc = env.views[vk]?.scene;
                if (sc) {
                    const mObj = new env.MeshCtor(this._sharedGeoMesh, this._matMesh);
                    mObj.name = '__cvat_surface_mesh__';
                    mObj.frustumCulled = false;
                    mObj.renderOrder = 2;
                    sc.add(mObj);
                    this._overlayObjects.push({ scene: sc, obj: mObj, viewKey: vk });
                }
            }
        } else if (usePtsFallback && env.PointsCtor && env.MatPtsTemplate) {
            this._sharedGeoPts = new env.BufferGeoCtor();
            setGeoAttr(this._sharedGeoPts, 'position', ptsPosArr);
            setGeoAttr(this._sharedGeoPts, 'color', ptsColArr);
            this._matPts = env.MatPtsTemplate.clone();
            try {
                if (this._matPts.color?.setHex) this._matPts.color.setHex(0xffffff);
                this._matPts.vertexColors = env.vertexColorVal;
                this._matPts.size = 4.0;
                this._matPts.transparent = true;
                this._matPts.opacity = 0.75;
                this._matPts.needsUpdate = true;
            } catch (e) {}
            const sc = env.views.perspective?.scene;
            if (sc) {
                const pObj = new env.PointsCtor(this._sharedGeoPts, this._matPts);
                pObj.name = '__cvat_surface_pts__';
                pObj.frustumCulled = false;
                sc.add(pObj);
                this._overlayObjects.push({ scene: sc, obj: pObj, viewKey: 'perspective' });
            }
        }

        // 2. Tạo viền lưới chữ nhật hồng cho CẢ 4 góc nhìn (Perspective, Top, Side, Front)
        if (env.LineSegCtor && env.MatLineTemplate) {
            this._sharedGeoLine = new env.BufferGeoCtor();
            setGeoAttr(this._sharedGeoLine, 'position', linePosArr);
            setGeoAttr(this._sharedGeoLine, 'color', lineColArr);
            try { this._sharedGeoLine.computeBoundingSphere?.(); } catch (e) {}

            this._matLine = env.MatLineTemplate.clone();
            try {
                if (this._matLine.color?.setHex) this._matLine.color.setHex(0xffffff);
                this._matLine.vertexColors = env.vertexColorVal;
                this._matLine.transparent = true;
                this._matLine.opacity = 0.88;
                this._matLine.depthWrite = false;
                this._matLine.needsUpdate = true;
            } catch (e) {}

            for (const vk of ['perspective', 'top', 'side', 'front']) {
                const sc = env.views[vk]?.scene;
                if (sc) {
                    const lObj = new env.LineSegCtor(this._sharedGeoLine, this._matLine);
                    lObj.name = '__cvat_surface_lines__';
                    lObj.frustumCulled = false;
                    lObj.renderOrder = 3;
                    sc.add(lObj);
                    this._overlayObjects.push({ scene: sc, obj: lObj, viewKey: vk });
                }
            }
        }

        this.kichHoatRenderCVAT();
    }

    // =========================================================================
    // 6. TƯƠNG TÁC CHUỘT 3D RAY-PLANE TRỰC TIẾP TRÊN MAP CVAT (KHÔNG CẦN THREE.Raycaster)
    // =========================================================================

    static invertMat4(m) {
        // Nghịch đảo ma trận 4x4 column-major (Float32Array 16 phần tử)
        const inv = new Float32Array(16);
        inv[0]  =  m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
        inv[4]  = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
        inv[8]  =  m[4]*m[9]*m[15]  - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
        inv[12] = -m[4]*m[9]*m[14]  + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
        inv[1]  = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
        inv[5]  =  m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
        inv[9]  = -m[0]*m[9]*m[15]  + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
        inv[13] =  m[0]*m[9]*m[14]  - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
        inv[2]  =  m[1]*m[6]*m[15]  - m[1]*m[7]*m[14]  - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7]  - m[13]*m[3]*m[6];
        inv[6]  = -m[0]*m[6]*m[15]  + m[0]*m[7]*m[14]  + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7]  + m[12]*m[3]*m[6];
        inv[10] =  m[0]*m[5]*m[15]  - m[0]*m[7]*m[13]  - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7]  - m[12]*m[3]*m[5];
        inv[14] = -m[0]*m[5]*m[14]  + m[0]*m[6]*m[13]  + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6]  + m[12]*m[2]*m[5];
        inv[3]  = -m[1]*m[6]*m[11]  + m[1]*m[7]*m[10]  + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7]   + m[9]*m[3]*m[6];
        inv[7]  =  m[0]*m[6]*m[11]  - m[0]*m[7]*m[10]  - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7]   - m[8]*m[3]*m[6];
        inv[11] = -m[0]*m[5]*m[11]  + m[0]*m[7]*m[9]   + m[4]*m[1]*m[11] - m[4]*m[3]*m[9]  - m[8]*m[1]*m[7]   + m[8]*m[3]*m[5];
        inv[15] =  m[0]*m[5]*m[10]  - m[0]*m[6]*m[9]   - m[4]*m[1]*m[10] + m[4]*m[2]*m[9]  + m[8]*m[1]*m[6]   - m[8]*m[2]*m[5];
        let det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
        if (Math.abs(det) < 1e-12) return null;
        det = 1.0 / det;
        for (let i = 0; i < 16; i++) inv[i] *= det;
        return inv;
    }

    static unprojectPoint(ndcX, ndcY, ndcZ, projInv, matWorld) {
        // p_view = projInv * [ndcX, ndcY, ndcZ, 1]
        const vx = projInv[0]*ndcX + projInv[4]*ndcY + projInv[8]*ndcZ + projInv[12];
        const vy = projInv[1]*ndcX + projInv[5]*ndcY + projInv[9]*ndcZ + projInv[13];
        const vz = projInv[2]*ndcX + projInv[6]*ndcY + projInv[10]*ndcZ + projInv[14];
        const vw = projInv[3]*ndcX + projInv[7]*ndcY + projInv[11]*ndcZ + projInv[15];
        if (Math.abs(vw) < 1e-9) return null;
        const px = vx / vw, py = vy / vw, pz = vz / vw;
        // p_world = matWorld * [px, py, pz, 1]
        return [
            matWorld[0]*px + matWorld[4]*py + matWorld[8]*pz + matWorld[12],
            matWorld[1]*px + matWorld[5]*py + matWorld[9]*pz + matWorld[13],
            matWorld[2]*px + matWorld[6]*py + matWorld[10]*pz + matWorld[14]
        ];
    }

    raycastTileTrenView(view, clientX, clientY) {
        const data = this.laySurfaceFrame(this.liveFrame);
        if (!data || !view?.renderer?.domElement || !view?.camera) return null;

        const dom = view.renderer.domElement;
        const rect = dom.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const ndcX = ((clientX - rect.left) / rect.width) * 2 - 1;
        const ndcY = -((clientY - rect.top) / rect.height) * 2 + 1;

        const cam = view.camera;
        const matWorld = cam.matrixWorld?.elements;
        let projInv = cam.projectionMatrixInverse?.elements;
        if (!projInv && cam.projectionMatrix?.elements) {
            projInv = ThuatToanSurface.invertMat4(cam.projectionMatrix.elements);
        }
        if (!matWorld || !projInv) return null;

        const pNear = ThuatToanSurface.unprojectPoint(ndcX, ndcY, -1, projInv, matWorld);
        const pFar = ThuatToanSurface.unprojectPoint(ndcX, ndcY, 1, projInv, matWorld);
        if (!pNear || !pFar) return null;

        const dx = pFar[0] - pNear[0], dy = pFar[1] - pNear[1], dz = pFar[2] - pNear[2];
        const len = Math.hypot(dx, dy, dz);
        if (len < 1e-8) return null;
        const dir = [dx / len, dy / len, dz / len];

        let bestTile = null;
        let bestT = 1e9;
        for (const t of data.tiles) {
            // Giao tia P(t) = O + t*D với mặt phẳng z = zc + gx*(x - cx) + gy*(y - cy)
            const denom = dir[2] - t.gx * dir[0] - t.gy * dir[1];
            if (Math.abs(denom) < 1e-6) continue;
            const numer = (t.zc - t.gx * t.cx - t.gy * t.cy) - (pNear[2] - t.gx * pNear[0] - t.gy * pNear[1]);
            const tHit = numer / denom;
            if (tHit <= 0 || tHit >= bestT) continue;

            const hx = pNear[0] + tHit * dir[0];
            const hy = pNear[1] + tHit * dir[1];
            if (hx >= t.x0 && hx <= t.x1 && hy >= t.y0 && hy <= t.y1) {
                bestT = tHit;
                bestTile = t;
            }
        }
        return bestTile;
    }

    ganTuongTacChuot3D() {
        this.goTuongTacChuot3D();
        const env = this.layThongTinThreeJS();
        if (!env || !env.views) return;

        for (const vk of ['perspective', 'top']) {
            const view = env.views[vk];
            const dom = view?.renderer?.domElement;
            if (!dom) continue;

            let downPos = null;
            let suppressClick = false;
            const canPickEvent = (e) => !!(this.isActive && e.button === 0 && (e.altKey || this.cheDoChonTrenTop));

            const onDown = (e) => {
                if (!this.isActive || e.button !== 0) return;
                const canPick = canPickEvent(e);
                downPos = { x: e.clientX, y: e.clientY, canPick };
                if (e.altKey && this.raycastTileTrenView(view, e.clientX, e.clientY)) {
                    suppressClick = true;
                    e.preventDefault();
                    e.stopPropagation();
                }
            };

            const onMouseDown = (e) => {
                if (e.button === 0 && this.isActive && e.altKey && this.raycastTileTrenView(view, e.clientX, e.clientY)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            };

            const onMove = (e) => {
                if (!this.isActive) return;
                const hit = this.raycastTileTrenView(view, e.clientX, e.clientY);
                const newHoverId = hit ? hit.id : null;
                if (newHoverId !== this.hoveredTileId) {
                    this.hoveredTileId = newHoverId;
                    this.veSurfaceLen3D();
                }
                this.capNhatTooltipChuot(hit, e.clientX, e.clientY);
            };

            const onUp = (e) => {
                if (!this.isActive || e.button !== 0 || !downPos) return;
                const moveDist = Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y);
                const hadPickIntent = downPos.canPick || canPickEvent(e);
                downPos = null;
                if (!hadPickIntent || moveDist > 5) return;

                const hit = this.raycastTileTrenView(view, e.clientX, e.clientY);
                if (!hit) return;

                suppressClick = true;
                e.preventDefault();
                e.stopPropagation();

                if (Number(this.liveFrame) !== Number(this.currentFrame)) {
                    this.currentFrame = Number(this.liveFrame);
                    this.selectedTileIds.clear();
                }
                this.chonOTuClick(hit, true);
            };

            const onClick = (e) => {
                if (suppressClick || (canPickEvent(e) && this.raycastTileTrenView(view, e.clientX, e.clientY))) {
                    suppressClick = false;
                    e.preventDefault();
                    e.stopPropagation();
                }
            };

            const onLeave = () => {
                if (this.hoveredTileId !== null) {
                    this.hoveredTileId = null;
                    this.veSurfaceLen3D();
                }
                if (this._tooltipEl) this._tooltipEl.style.display = 'none';
            };

            dom.addEventListener('pointerdown', onDown, true);
            dom.addEventListener('mousedown', onMouseDown, true);
            dom.addEventListener('pointermove', onMove, true);
            dom.addEventListener('pointerup', onUp, true);
            dom.addEventListener('click', onClick, true);
            dom.addEventListener('pointerleave', onLeave, true);
            this._boundDomHandlers.push(
                { dom, ev: 'pointerdown', fn: onDown },
                { dom, ev: 'mousedown', fn: onMouseDown },
                { dom, ev: 'pointermove', fn: onMove },
                { dom, ev: 'pointerup', fn: onUp },
                { dom, ev: 'click', fn: onClick },
                { dom, ev: 'pointerleave', fn: onLeave }
            );
        }
    }

    goTuongTacChuot3D() {
        for (const h of this._boundDomHandlers) {
            try { h.dom.removeEventListener(h.ev, h.fn, true); } catch (e) {}
        }
        this._boundDomHandlers = [];
        if (this._tooltipEl) this._tooltipEl.style.display = 'none';
    }

    // =========================================================================
    // 7. QUẢN LÝ CACHE FRAME, CHỌN LỚP & CHỈNH SỬA THỜI GIAN THỰC
    // =========================================================================

    layKeyHienTai(fn = this.currentFrame) {
        if (this.callbacks && typeof this.callbacks.getJobId === 'function') {
            const jid = this.callbacks.getJobId();
            if (jid !== undefined && jid !== null && jid !== '') {
                this.currentJobId = String(jid);
            }
        }
        return `${this.currentJobId}_${fn}`;
    }

    laySurfaceFrame(fn = this.currentFrame) {
        const key = this.layKeyHienTai(fn);
        if (this.frameCache.has(key)) return this.frameCache.get(key);
        const saved = this.napTuLocalStorageFrame(key);
        if (saved) {
            this.frameCache.set(key, saved);
            return saved;
        }
        return null;
    }

    laySurfaceHienTai() {
        return this.laySurfaceFrame(this.currentFrame);
    }

    luuLocalStorageFrame(key, data) {
        if (typeof localStorage === 'undefined') return;
        const lsKey = `cvat_surface_v3_${key}`;
        try {
            if (!data || !Array.isArray(data.tiles)) return;
            // Chỉ lưu vào localStorage những frame có ô chỉnh tay để không làm đầy quota 5MB của CVAT
            const hasManual = data.tiles.some(t => t.manual);
            if (!hasManual) {
                localStorage.removeItem(lsKey);
                return;
            }
            const compact = {
                seedPlane: data.seedPlane,
                ext: data.ext || ThuatToanSurface.macDinhPhamViLuoi(),
                tiles: data.tiles.map(t => ({
                    id: t.id, x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1,
                    cx: t.cx, cy: t.cy, w: t.w, h: t.h, dist: t.dist, tier: t.tier,
                    type: t.type, source: t.source, visible: t.visible, solved: t.solved,
                    manual: t.manual, zc: t.zc, gx: t.gx, gy: t.gy, tw: +(t.tw || 0).toFixed(5),
                    confidence: t.confidence, nGroundPts: t.nGroundPts, layerId: t.layerId
                }))
            };
            localStorage.setItem(lsKey, JSON.stringify(compact));
        } catch (e) {}
    }

    napTuLocalStorageFrame(key) {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(`cvat_surface_v3_${key}`);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !Array.isArray(parsed.tiles) || parsed.tiles.length === 0) return null;
            parsed.ext = parsed.ext || ThuatToanSurface.macDinhPhamViLuoi();
            parsed.allTiles = parsed.tiles;
            parsed.layers = [];
            ThuatToanSurface.gomNhomThanhLop(parsed);
            return parsed;
        } catch (e) {
            return null;
        }
    }

    layDanhSachBoxTrongFrame(frameNum) {
        try {
            if (typeof this.callbacks.getFrameBoxes === 'function') {
                const res = this.callbacks.getFrameBoxes(frameNum);
                if (Array.isArray(res)) return res;
            }
            const boxes = [];
            const anns = this.callbacks.getAnnotations ? this.callbacks.getAnnotations() : null;
            if (anns && Array.isArray(anns.tracks)) {
                for (const tr of anns.tracks) {
                    const sh = (tr.shapes || []).find(s => Number(s.frame) === Number(frameNum) && !s.outside && s.points?.length >= 9);
                    if (sh) {
                        boxes.push({ track: tr, shape: sh, cx: sh.points[0], cy: sh.points[1], cz: sh.points[2], isDirect: true });
                    }
                }
            }
            if (anns && Array.isArray(anns.shapes)) {
                for (const sh of anns.shapes) {
                    if (Number(sh?.frame) === Number(frameNum) && !sh.outside && sh.points?.length >= 9) {
                        boxes.push({ track: null, shape: sh, cx: sh.points[0], cy: sh.points[1], cz: sh.points[2], isDirect: true });
                    }
                }
            }
            return boxes;
        } catch (e) {}
        return [];
    }

    tinhSurfaceSachChoFrame(fn) {
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum)) return null;
        const boxes = this.layDanhSachBoxTrongFrame(frameNum);
        const allowThreeJS = (frameNum === this.liveFrame);
        const fullPts = !allowThreeJS && typeof this.callbacks.getFullFramePts === 'function'
            ? this.callbacks.getFullFramePts(frameNum)
            : null;
        let raw = null;
        if (fullPts && (fullPts.isFlat || Array.isArray(fullPts.ptsArray)) && (fullPts.count ?? 0) >= 100) {
            raw = fullPts;
        } else {
            const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
            raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
        }
        if (!raw) return null;
        this._canTinhLai = false;
        if (this._panelEl) {
            const rb = this._panelEl.querySelector('#surf-btn-recalc');
            if (rb) {
                rb.style.borderColor = '';
                rb.style.color = '';
                rb.title = 'Tính lại sạch toàn bộ Surface Frame này từ LiDAR gốc (xóa mọi chỉnh tay)';
            }
        }
        return ThuatToanSurface.xayDungSurfaceBanDoAnToan(raw, boxes, { frame: frameNum });
    }

    tinhSurfaceChoFrame(fn, forceRecalc = false, keepManual = true) {
        this.currentJobId = this.callbacks.getJobId ? String(this.callbacks.getJobId()) : '0';
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum)) return null;
        const key = this.layKeyHienTai(frameNum);
        const boxes = this.layDanhSachBoxTrongFrame(frameNum);
        const reqExt = ThuatToanSurface.tinhPhamViLuoi(boxes);

        const prevCached = this.laySurfaceFrame(frameNum);
        if (!forceRecalc && prevCached) {
            const curExt = prevCached.ext || ThuatToanSurface.macDinhPhamViLuoi();
            const covers = curExt.xMin <= reqExt.xMin && curExt.xMax >= reqExt.xMax &&
                           curExt.yMin <= reqExt.yMin && curExt.yMax >= reqExt.yMax;
            if (covers) return prevCached;
        }

        const data = this.tinhSurfaceSachChoFrame(frameNum);
        if (!data) return null;

        if (keepManual && prevCached) {
            const manualByGeo = new Map();
            const manualById = new Map();
            (prevCached.tiles || []).forEach(pt => {
                if (pt.manual) {
                    manualByGeo.set(`${pt.x0}_${pt.y0}_${pt.w}_${pt.h}`, pt);
                    manualById.set(pt.id, pt);
                }
            });
            if (manualByGeo.size > 0) {
                data.tiles.forEach(t => {
                    const m = manualByGeo.get(`${t.x0}_${t.y0}_${t.w}_${t.h}`) || manualById.get(t.id);
                    if (m) {
                        t.zc = m.zc; t.gx = m.gx; t.gy = m.gy; t.tw = m.tw || 0;
                        t.type = m.type; t.manual = true; t.source = 'manual';
                    }
                });
                ThuatToanSurface.gomNhomThanhLop(data);
            }
        }

        this.frameCache.set(key, data);
        this.luuLocalStorageFrame(key, data);
        return data;
    }

    tinhHoacNapSurfaceFrame(forceRecalc = false, keepManual = true) {
        this.currentJobId = this.callbacks.getJobId ? String(this.callbacks.getJobId()) : '0';
        if (this.callbacks.getFocusFrame) {
            const fFocus = Number(this.callbacks.getFocusFrame());
            if (Number.isInteger(fFocus)) this.currentFrame = fFocus;
        } else if (this.callbacks.getCurrentFrame) {
            const fCur = Number(this.callbacks.getCurrentFrame());
            if (Number.isInteger(fCur)) this.currentFrame = fCur;
        }
        return this.tinhSurfaceChoFrame(this.currentFrame, forceRecalc, keepManual);
    }

    scheduleTinhFrame(fn) {
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum) || this._queuedFrames.has(frameNum)) return;
        const hasPts = !!(this.callbacks.getFramePts && this.callbacks.getFramePts(frameNum)?.length >= 20) || (frameNum === this.liveFrame);
        if (!hasPts) return;

        this._queuedFrames.add(frameNum);
        const runJob = () => {
            this._queuedFrames.delete(frameNum);
            if (!this.isActive) return;
            const d = this.tinhSurfaceChoFrame(frameNum, false);
            if (d) {
                if (typeof this.callbacks.onSurfaceFrameReady === 'function') {
                    this.callbacks.onSurfaceFrameReady(frameNum);
                }
                if (frameNum === this.currentFrame) this.capNhatBangSurfaceUI();
                if (frameNum === this.liveFrame) this.veSurfaceLen3D();
            }
        };

        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(runJob, { timeout: 220 });
        } else {
            setTimeout(runJob, 16);
        }
    }

    laySurfaceChoVe(fn) {
        if (!this.isActive) return null;
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum)) return null;

        const exact = this.laySurfaceFrame(frameNum);
        if (exact) return { data: exact, srcFrame: frameNum, borrowed: false };

        this.scheduleTinhFrame(frameNum);

        // Tạm mượn frame lân cận gần nhất (≤ 10 frame) trong lúc đang tính nền
        let bestData = null;
        let bestF = frameNum;
        let bestGap = 11;
        for (let d = 1; d <= 10; d++) {
            for (const candF of [frameNum - d, frameNum + d]) {
                if (candF < 0) continue;
                const cd = this.frameCache.get(this.layKeyHienTai(candF));
                if (cd && d < bestGap) {
                    bestGap = d;
                    bestData = cd;
                    bestF = candF;
                    return { data: bestData, srcFrame: bestF, borrowed: true };
                }
            }
        }
        return null;
    }

    datFrameFocus(fn) {
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum) || frameNum === this.currentFrame) return;
        this.currentFrame = frameNum;
        this.selectedTileIds.clear();
        this.tinhSurfaceChoFrame(frameNum, false);
        this.veLaiToanBo(false);
    }

    veLaiToanBo(syncModal = true) {
        const doDraw = () => {
            this._rafDrawId = null;
            this.veSurfaceLen3D();
            this.capNhatBangSurfaceUI();
            if (syncModal && typeof this.callbacks.onSurfaceChanged === 'function') {
                this.callbacks.onSurfaceChanged();
            }
        };
        if (typeof requestAnimationFrame === 'function' && typeof window !== 'undefined') {
            if (this._rafDrawId) cancelAnimationFrame(this._rafDrawId);
            this._rafDrawId = requestAnimationFrame(doDraw);
        } else {
            doDraw();
        }
    }

    luuUndoSurface() {
        const key = this.layKeyHienTai();
        const data = this.laySurfaceHienTai();
        if (!data) return;
        const stack = this.undoSnapshots.get(key) || [];
        stack.push(data.tiles.map(t => ({
            id: t.id, zc: t.zc, gx: t.gx, gy: t.gy, tw: t.tw || 0, type: t.type, manual: t.manual, source: t.source, layerId: t.layerId
        })));
        if (stack.length > 30) stack.shift();
        this.undoSnapshots.set(key, stack);
    }

    hoanTacSurface() {
        const key = this.layKeyHienTai();
        const data = this.laySurfaceHienTai();
        const stack = this.undoSnapshots.get(key);
        if (!data || !stack || stack.length === 0) {
            this.hienToast('Không có thao tác Surface nào để hoàn tác!');
            return;
        }
        const snap = stack.pop();
        const map = new Map(snap.map(it => [it.id, it]));
        for (const t of data.tiles) {
            const s = map.get(t.id);
            if (s) {
                t.zc = s.zc; t.gx = s.gx; t.gy = s.gy; t.tw = s.tw || 0;
                t.type = s.type; t.manual = s.manual; t.source = s.source; t.layerId = s.layerId;
            }
        }
        ThuatToanSurface.gomNhomThanhLop(data);
        this.luuLocalStorageFrame(key, data);
        this.veLaiToanBo(true);
        this.hienToast('↩ Đã hoàn tác chỉnh sửa Surface!');
    }

    chonOTuClick(tile, additive = false) {
        const data = this.laySurfaceHienTai();
        if (!data || !tile) return;

        if (!additive) this.selectedTileIds.clear();

        if (this.selectionMode === 'layer' && tile.layerId) {
            const layer = (data.layers || []).find(l => l.id === tile.layerId);
            const ids = layer ? layer.tileIds : [tile.id];
            const allAlreadySel = additive && ids.every(id => this.selectedTileIds.has(id));
            ids.forEach(id => {
                if (allAlreadySel) this.selectedTileIds.delete(id);
                else this.selectedTileIds.add(id);
            });
        } else {
            if (additive && this.selectedTileIds.has(tile.id)) this.selectedTileIds.delete(tile.id);
            else this.selectedTileIds.add(tile.id);
        }

        this.veLaiToanBo(true);
    }

    chonOTaiToaDoTheGioi(fn, x, y, additive = true) {
        const frameNum = Number(fn);
        if (Number.isFinite(frameNum) && frameNum !== this.currentFrame) {
            this.currentFrame = frameNum;
            this.selectedTileIds.clear();
            additive = true;
        }
        const data = this.tinhSurfaceChoFrame(this.currentFrame, false) || this.laySurfaceHienTai();
        if (!data) return null;
        const tile = ThuatToanSurface.timOTaiViTri(data, x, y);
        if (!tile) {
            if (!additive && this.selectedTileIds.size > 0) {
                this.selectedTileIds.clear();
                this.veLaiToanBo(true);
            }
            return null;
        }
        this.chonOTuClick(tile, additive);
        return tile;
    }

    chonLopTheoId(layerId, additive = false) {
        const data = this.laySurfaceHienTai();
        if (!data) return;
        const layer = (data.layers || []).find(l => l.id === layerId);
        if (!layer) return;
        if (!additive) this.selectedTileIds.clear();
        const allSel = additive && layer.tileIds.every(id => this.selectedTileIds.has(id));
        layer.tileIds.forEach(id => {
            if (allSel) this.selectedTileIds.delete(id);
            else this.selectedTileIds.add(id);
        });
        this.veLaiToanBo(true);
    }

    chonTheoKhoangKhoangCach(rMin, rMax, filterType = 'all') {
        const data = this.laySurfaceHienTai();
        if (!data) return;
        this.selectedTileIds.clear();
        for (const t of data.tiles) {
            if (t.dist >= rMin && t.dist <= rMax) {
                if (filterType === 'all' || t.type === filterType) {
                    this.selectedTileIds.add(t.id);
                }
            }
        }
        this.veLaiToanBo(true);
    }

    boChonTatCa() {
        if (this.selectedTileIds.size === 0) return;
        this.selectedTileIds.clear();
        this.veLaiToanBo(true);
    }

    chinhSuaCacODangChon({ dz = 0, dGx = 0, dGy = 0, newType = null }) {
        const data = this.laySurfaceHienTai();
        if (!data || this.selectedTileIds.size === 0) {
            this.hienToast('⚠️ Chưa chọn lớp hoặc ô mặt đường nào!');
            return;
        }
        this.luuUndoSurface();

        const selected = data.tiles.filter(t => this.selectedTileIds.has(t.id));
        let pivotX = 0, pivotY = 0;
        selected.forEach(t => { pivotX += t.cx; pivotY += t.cy; });
        pivotX /= selected.length;
        pivotY /= selected.length;

        for (const t of selected) {
            if (dz !== 0) t.zc += dz;
            if (dGx !== 0 || dGy !== 0) {
                t.gx = ThuatToanSurface.clamp(t.gx + dGx, -0.25, 0.25);
                t.gy = ThuatToanSurface.clamp(t.gy + dGy, -0.25, 0.25);
                t.zc += dGx * (t.cx - pivotX) + dGy * (t.cy - pivotY);
            }
            if (newType === 'road' || newType === 'sidewalk') {
                t.type = newType;
            }
            t.manual = true;
            t.source = 'manual';
        }

        if (newType) ThuatToanSurface.gomNhomThanhLop(data);
        else this.capNhatThongKeLop(data);

        this.luuLocalStorageFrame(this.layKeyHienTai(), data);
        this.veLaiToanBo(true);
    }

    datLaiGocCacODangChon() {
        const data = this.laySurfaceHienTai();
        if (!data || this.selectedTileIds.size === 0) {
            this.hienToast('⚠️ Chưa chọn lớp hoặc ô mặt đường nào để đặt lại theo LiDAR!');
            return 0;
        }
        const clean = this.tinhSurfaceSachChoFrame(this.currentFrame);
        if (!clean || !Array.isArray(clean.tiles)) {
            this.hienToast('⚠️ Không có dữ liệu LiDAR gốc cho Frame này!');
            return 0;
        }

        this.luuUndoSurface();

        const cleanByGeo = new Map();
        for (const ct of clean.tiles) {
            cleanByGeo.set(`${ct.x0}_${ct.y0}_${ct.w}_${ct.h}`, ct);
        }

        let restored = 0;
        for (const t of data.tiles) {
            if (!this.selectedTileIds.has(t.id)) continue;
            const ct = cleanByGeo.get(`${t.x0}_${t.y0}_${t.w}_${t.h}`) || ThuatToanSurface.timOTaiViTri(clean, t.cx, t.cy);
            if (!ct) continue;
            t.zc = ct.zc;
            t.gx = ct.gx;
            t.gy = ct.gy;
            t.tw = ct.tw || 0;
            t.fitZc = ct.fitZc !== undefined ? ct.fitZc : ct.zc;
            t.fitGx = ct.fitGx !== undefined ? ct.fitGx : ct.gx;
            t.fitGy = ct.fitGy !== undefined ? ct.fitGy : ct.gy;
            t.nGroundPts = ct.nGroundPts;
            t.nTotalPts = ct.nTotalPts;
            t.confidence = ct.confidence;
            t.type = ct.type;
            t.manual = false;
            t.source = ct.source;
            restored++;
        }

        if (restored === 0) {
            this.hienToast('⚠️ Không khớp được ô nào với bản tính LiDAR gốc!');
            return 0;
        }

        ThuatToanSurface.gomNhomThanhLop(data);
        this.luuLocalStorageFrame(this.layKeyHienTai(), data);
        this.veLaiToanBo(true);
        this.hienToast(`♻️ Đã đặt lại ${restored} ô đang chọn về đúng mặt đường tính toán LiDAR gốc!`);
        return restored;
    }

    noiSuyLaiCacODangChon() {
        const data = this.laySurfaceHienTai();
        if (!data || this.selectedTileIds.size === 0) {
            this.hienToast('⚠️ Chưa chọn ô nào để nội suy lại!');
            return;
        }
        this.luuUndoSurface();

        const anchors = data.tiles.filter(t => !this.selectedTileIds.has(t.id) && t.type === 'road');
        const pool = anchors.length > 0 ? anchors : [{ cx: 0, cy: 0, zc: data.seedPlane.z0, gx: data.seedPlane.gx, gy: data.seedPlane.gy, confidence: 1 }];

        for (const t of data.tiles) {
            if (!this.selectedTileIds.has(t.id)) continue;
            let sumW = 0, sumZ = 0, sumGx = 0, sumGy = 0;
            for (const a of pool) {
                const d2 = (t.cx - a.cx) ** 2 + (t.cy - a.cy) ** 2;
                const w = (a.confidence || 0.5) / (d2 + 4.0);
                sumW += w;
                sumZ += w * (a.zc + a.gx * (t.cx - a.cx) + a.gy * (t.cy - a.cy));
                sumGx += w * a.gx;
                sumGy += w * a.gy;
            }
            if (sumW > 0) {
                t.zc = sumZ / sumW;
                t.gx = sumGx / sumW;
                t.gy = sumGy / sumW;
                t.tw = 0;
                t.fitZc = t.zc;
                t.fitGx = t.gx;
                t.fitGy = t.gy;
                t.type = 'road';
                t.manual = false;
                t.source = 'extrapolated';
            }
        }

        ThuatToanSurface.gomNhomThanhLop(data);
        this.luuLocalStorageFrame(this.layKeyHienTai(), data);
        this.veLaiToanBo(true);
        this.hienToast('🔄 Đã nội suy lại vùng chọn theo các lớp mặt đường xung quanh!');
    }

    // =========================================================================
    // 7B. BỘ VẼ SURFACE LÊN CANVAS 2D CỦA EXTENSION (TOP | SIDE | FRONT)
    // =========================================================================

    static mauCanvas(tile, isSel, borrowed) {
        const aFill = borrowed ? 0.14 : (isSel ? 0.44 : ((tile.source === 'extrapolated' || tile.source === 'occluded') ? 0.14 : 0.22));
        if (tile.type === 'sidewalk') {
            return {
                fill: isSel ? 'rgba(217, 70, 239, 0.44)' : `rgba(217, 70, 239, ${aFill + 0.04})`,
                stroke: isSel ? '#ffffff' : (tile.manual ? '#fde047' : 'rgba(232, 121, 249, 0.72)')
            };
        }
        return {
            fill: isSel ? 'rgba(236, 72, 153, 0.45)' : `rgba(249, 168, 212, ${aFill})`,
            stroke: isSel ? '#ffffff' : (tile.manual ? '#fde047' : 'rgba(244, 114, 182, 0.62)')
        };
    }

    static giaiChieuPixelTop(proj, mx, my, zAt = null) {
        if (!proj || !proj.box || !proj.S) return null;
        const { S, cx, cy, viewYaw = 0, viewPitch = 0, rotAngle = 0, box } = proj;
        const [bx, by, bz, rz = 0, H = 1.6] = box;
        const cosP = Math.cos(viewPitch);
        if (Math.abs(cosP) < 0.15) return null;

        const sinP = Math.sin(viewPitch);
        const cosY = Math.cos(viewYaw);
        const sinY = Math.sin(viewYaw);
        const cRot = Math.cos(rotAngle);
        const sRot = Math.sin(rotAngle);
        const coRz = Math.cos(rz);
        const siRz = Math.sin(rz);

        const xc = (mx - cx) / S;
        const yc = (cy - my) / S;
        let w = -H * 0.5;
        let wx = bx, wy = by;

        const iters = Math.abs(viewPitch) > 0.005 && zAt ? 4 : 1;
        for (let it = 0; it < iters; it++) {
            const v2 = (Math.abs(viewPitch) > 1e-5) ? (yc - w * sinP) / cosP : yc;
            const ru = cosY * xc + sinY * v2;
            const rv = -sinY * xc + cosY * v2;
            const u = rotAngle !== 0 ? (cRot * ru - sRot * rv) : ru;
            const v = rotAngle !== 0 ? (sRot * ru + cRot * rv) : rv;
            wx = bx + coRz * u - siRz * v;
            wy = by + siRz * u + coRz * v;
            if (!zAt) break;
            const zNew = zAt(wx, wy);
            if (zNew === null || zNew === undefined || !Number.isFinite(zNew)) break;
            w = zNew - bz;
        }
        return { x: wx, y: wy, w };
    }

    static _chuanBiMat2D(mat) {
        if (!mat || !mat.sanSang) return null;
        if (mat._cv2d) return mat._cv2d;
        const leaves = mat.layDanhSachLa();
        const items = [];
        for (let i = 0; i < leaves.length; i++) {
            const lf = leaves[i];
            if (!lf || !Number.isFinite(lf.r0 + lf.r1 + lf.t0 + lf.t1) || lf.r1 <= lf.r0 || lf.t1 <= lf.t0) continue;
            const dT = lf.t1 - lf.t0;
            const c0 = Math.cos(lf.t0), s0 = Math.sin(lf.t0);
            const c1 = Math.cos(lf.t1), s1 = Math.sin(lf.t1);
            const tm = 0.5 * (lf.t0 + lf.t1);
            const cm = Math.cos(tm), sm = Math.sin(tm);
            const nD = lf.nDiem || 0;
            const densTier = nD >= 60 ? 2 : (nD >= 18 ? 1 : 0);
            items.push({
                lf,
                r0: lf.r0, r1: lf.r1,
                t0: lf.t0, t1: lf.t1,
                dTheta: dT,
                c0, s0, c1, s1, cm, sm,
                isUnknown: lf.loai === 'UNKNOWN',
                ngoaiDuong: !!lf.ngoaiDuong,
                densTier
            });
        }
        mat._cv2d = { items, totalLeaves: leaves.length };
        return mat._cv2d;
    }

    lenLichDungDongTam(fn) {
        const frameNum = Number(fn);
        if (!this.isActive || !Number.isFinite(frameNum)) return;
        if (this.callbacks?.getJobId) this.currentJobId = String(this.callbacks.getJobId());
        const baseKey = this.layKeyHienTai(frameNum);
        const fullData = typeof this.callbacks.getFullFramePts === 'function' ? this.callbacks.getFullFramePts(frameNum) : null;
        const hasFull = Boolean(fullData && (fullData.isFlat || Array.isArray(fullData.ptsArray) || Array.isArray(fullData)) && (fullData.count ?? fullData.length ?? 0) >= 100);
        const fallbackPts = !hasFull && this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
        if (!hasFull && (!Array.isArray(fallbackPts) || fallbackPts.length < 100)) return;

        const cacheKey = `${baseKey}_${hasFull ? 'full' : 'sparse'}`;
        if (this._polarQueued.has(cacheKey)) return;

        this._polarQueued.add(cacheKey);
        const runJob = () => {
            this._polarQueued.delete(cacheKey);
            if (!this.isActive) return;
            const MatCtor = typeof MatDuongDongTam !== 'undefined'
                ? MatDuongDongTam
                : (typeof globalThis !== 'undefined' ? globalThis.MatDuongDongTam : null);
            if (!MatCtor || typeof MatCtor.xayDung !== 'function') return;
            const boxes = this.layDanhSachBoxTrongFrame(frameNum);
            let raw = null;
            if (hasFull) {
                raw = Array.isArray(fullData)
                    ? { ptsArray: fullData, isFlat: false, count: fullData.length, source: 'full_pcd' }
                    : fullData;
            } else {
                raw = { ptsArray: fallbackPts, isFlat: false, count: fallbackPts.length, source: 'fallback' };
            }
            let mat = null;
            try {
                const egoFallback = this.egoPlaneCache.get(frameNum) || (Array.isArray(fallbackPts) ? ThuatToanSurface.tinhEgoGroundPlane(fallbackPts) : null);
                const neoList = ThuatToanSurface._thuThapNeoTuBoxes(boxes, egoFallback, { frame: frameNum });
                mat = MatCtor.xayDung(raw, boxes, neoList.length > 0 ? { neoList } : {});
            } catch (_) {
                return;
            }
            if (!mat || !mat.sanSang) return;
            mat._fromSparse = !hasFull;
            mat._sourceTag = hasFull ? 'full' : 'sparse';
            if (hasFull) this._polarCacheModal.delete(`${baseKey}_sparse`);
            this._polarCacheModal.delete(cacheKey);
            this._polarCacheModal.set(cacheKey, mat);
            if (this._polarCacheModal.size > 48) {
                const oldest = this._polarCacheModal.keys().next().value;
                if (oldest !== undefined) this._polarCacheModal.delete(oldest);
            }
            const d = mat.diag || {};
            console.info(`[Đồng Tâm Modal] F${frameNum}: src=${mat._sourceTag} in=${d.totalRawPts || raw.count} kept=${d.keptPts || 0} nLa=${d.nLa || 0} stuck=${d.nStuckRoots || 0} (${(d.buildMs || 0).toFixed(1)}ms)`);
            if (typeof this.callbacks.onSurfaceFrameReady === 'function') {
                this.callbacks.onSurfaceFrameReady(frameNum);
            }
        };

        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            window.requestIdleCallback(runJob, { timeout: 220 });
        } else {
            setTimeout(runJob, 16);
        }
    }

    layMatDongTamChoVe(fn, allowBuildLive = true) {
        if (!this.isActive) return null;
        const frameNum = Number(fn);
        if (!Number.isFinite(frameNum)) return null;
        if (this.callbacks?.getJobId) this.currentJobId = String(this.callbacks.getJobId());
        const key = this.layKeyHienTai(frameNum);

        if (this._polarCache.has(key)) {
            const hit = this._polarCache.get(key);
            if (hit && hit.sanSang) {
                this._polarCache.delete(key);
                this._polarCache.set(key, hit);
                return hit;
            }
        }
        const kFull = `${key}_full`;
        const kSparse = `${key}_sparse`;
        for (const mk of [kFull, kSparse, key]) {
            if (this._polarCacheModal.has(mk)) {
                const hit = this._polarCacheModal.get(mk);
                if (hit && hit.sanSang) {
                    this._polarCacheModal.delete(mk);
                    this._polarCacheModal.set(mk, hit);
                    // Nếu đang dùng bản sparse nhưng nay đã có full PCD buffer -> lên lịch nâng cấp nền
                    if (mk === kSparse && allowBuildLive && typeof this.callbacks.getFullFramePts === 'function') {
                        this.lenLichDungDongTam(frameNum);
                    }
                    return hit;
                }
            }
        }
        if (frameNum === this.liveFrame && allowBuildLive && this._polarFail?.fn !== frameNum) {
            const built = this.layMatDongTamFrame(frameNum, false);
            if (built && built.sanSang) return built;
        }
        if (allowBuildLive) {
            this.lenLichDungDongTam(frameNum);
        }
        return null;
    }

    static coPolarHienThi(mat) {
        return Boolean(
            mat
            && mat.sanSang
            && typeof mat.timLa === 'function'
            && typeof mat.layDanhSachLa === 'function'
            && (typeof mat.zHienThiTaiLa === 'function' || typeof mat.zTaiLa === 'function')
        );
    }

    static zHienThiThongNhat(mat, x, y, fb = null, lfHint = null) {
        if (!mat || !Number.isFinite(x) || !Number.isFinite(y)) {
            return { z: NaN, loai: 'NONE', leaf: null };
        }
        const lf = lfHint || (typeof mat.timLa === 'function' ? mat.timLa(x, y) : null);
        const fbZ = fb ? ((fb.zE0 ?? 0) + (fb.gEx ?? 0) * x + (fb.gEy ?? 0) * y) : NaN;
        if (!lf) {
            return { z: lfHint ? (Number.isFinite(fbZ) ? fbZ : 0) : NaN, loai: 'NONE', leaf: null };
        }
        let z = NaN;
        if (typeof mat.zHienThiTaiLa === 'function') {
            z = mat.zHienThiTaiLa(lf, x, y);
        }
        if (!Number.isFinite(z)) {
            if (lfHint) {
                z = ThuatToanSurface._evalPolarHienThiZ(mat, lf, x, y, fbZ);
            } else {
                z = ThuatToanSurface._evalPolarHienThiZ(mat, lf, x, y, NaN);
                if (!Number.isFinite(z) && lf.loai !== 'UNKNOWN') {
                    z = Number.isFinite(fbZ) ? fbZ : NaN;
                }
            }
        }
        if (!Number.isFinite(z)) {
            return { z: NaN, loai: 'NONE', leaf: lf };
        }
        const loai = lf.ngoaiDuong
            ? 'NGOAI_DUONG'
            : (lf.loai === 'UNKNOWN' ? 'UNKNOWN' : 'LEAF');
        return { z, loai, leaf: lf };
    }

    static _evalPolarHienThiZ(mat, leaf, x, y, fallbackZ = 0) {
        if (mat && leaf) {
            if (typeof mat.zHienThiTaiLa === 'function') {
                const z = mat.zHienThiTaiLa(leaf, x, y);
                if (Number.isFinite(z)) return z;
            } else {
                if (leaf.loai === 'LEAF' && typeof mat.zTaiLa === 'function') {
                    const z = mat.zTaiLa(leaf, x, y);
                    if (Number.isFinite(z)) return z;
                } else if (mat._neoState && mat._neoState.coNeoXe && typeof mat.zTai === 'function') {
                    const zN = mat.zTai(x, y);
                    if (Number.isFinite(zN)) return zN;
                }
                if (Number.isFinite(leaf.zGoiY)) return leaf.zGoiY;
            }
        }
        return Number.isFinite(fallbackZ) ? fallbackZ : 0;
    }

    _thuThapVePolar2D(mat, fn, box, project, cw, ch, skipJump = false) {
        const prep = ThuatToanSurface._chuanBiMat2D(mat);
        if (!prep || prep.items.length === 0) return null;

        const [bx, by, bz, , , rz = 0] = box;
        const co = Math.cos(rz), si = Math.sin(rz);
        const egoRaw = this.egoPlaneCache?.get(Number(fn));
        const zE0 = Number.isFinite(egoRaw?.z0) ? egoRaw.z0 : (bz - 0.8);
        const gEx = Number.isFinite(egoRaw?.gx) ? egoRaw.gx : 0;
        const gEy = Number.isFinite(egoRaw?.gy) ? egoRaw.gy : 0;

        const fb = { zE0, gEx, gEy };
        const P = (x, y, zVal) => {
            const dx = x - bx, dy = y - by;
            const u = co * dx + si * dy;
            const v = -si * dx + co * dy;
            return project(u, v, zVal - bz);
        };
        const evalZ = (lf, x, y) => ThuatToanSurface.zHienThiThongNhat(mat, x, y, fb, lf).z;

        const o0 = project(0, 0, 0);
        const o1 = project(1, 0, 0);
        const pxScale = Math.max(4, Math.hypot(o1.x - o0.x, o1.y - o0.y));
        const maxSegCap = prep.totalLeaves > 500 ? 6 : 24;

        const makeBucket = () => {
            if (typeof Path2D !== 'undefined') return new Path2D();
            const ops = [];
            return {
                _ops: ops,
                moveTo: (x, y) => ops.push(['M', x, y]),
                lineTo: (x, y) => ops.push(['L', x, y]),
                closePath: () => ops.push(['Z'])
            };
        };

        const fills = [
            makeBucket(), makeBucket(), makeBucket(), // road tier 0,1,2
            makeBucket(), makeBucket(), makeBucket()  // coral tier 0,1,2
        ];
        const strokes = {
            road: makeBucket(),
            coral: makeBucket(),
            unk: makeBucket(),
            jump1: makeBucket(),
            jump2: makeBucket()
        };

        let nDraw = 0;
        const pad = 20;
        for (let i = 0; i < prep.items.length; i++) {
            const it = prep.items[i];
            if (it.isUnknown && !this._hienUnknownPolar) continue;

            // Bbox 6 điểm thế giới chiếu màn hình để cull chuẩn khi zoom gần
            const pts6 = [
                P(it.r0 * it.c0, it.r0 * it.s0, evalZ(it.lf, it.r0 * it.c0, it.r0 * it.s0)),
                P(it.r0 * it.cm, it.r0 * it.sm, evalZ(it.lf, it.r0 * it.cm, it.r0 * it.sm)),
                P(it.r0 * it.c1, it.r0 * it.s1, evalZ(it.lf, it.r0 * it.c1, it.r0 * it.s1)),
                P(it.r1 * it.c0, it.r1 * it.s0, evalZ(it.lf, it.r1 * it.c0, it.r1 * it.s0)),
                P(it.r1 * it.cm, it.r1 * it.sm, evalZ(it.lf, it.r1 * it.cm, it.r1 * it.sm)),
                P(it.r1 * it.c1, it.r1 * it.s1, evalZ(it.lf, it.r1 * it.c1, it.r1 * it.s1))
            ];
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            let valid6 = true;
            for (let k = 0; k < 6; k++) {
                const q = pts6[k];
                if (!Number.isFinite(q.x) || !Number.isFinite(q.y)) { valid6 = false; break; }
                if (q.x < minX) minX = q.x;
                if (q.x > maxX) maxX = q.x;
                if (q.y < minY) minY = q.y;
                if (q.y > maxY) maxY = q.y;
            }
            if (!valid6) continue;
            if (maxX < -pad || minX > cw + pad || maxY < -pad || minY > ch + pad) continue;
            if ((maxX - minX) < 1.5 && (maxY - minY) < 1.5) continue;

            nDraw++;
            const cosS = Math.max(-0.99, 1.0 - 0.8 / Math.max(1.0, it.r1 * pxScale));
            const step = Math.max(0.02, Math.min(0.4, 2.0 * Math.acos(cosS)));
            const nSeg = Math.max(1, Math.min(maxSegCap, Math.ceil(it.dTheta / step)));
            const dt = it.dTheta / nSeg;

            const addSectorPath = (pathObj) => {
                for (let s = 0; s <= nSeg; s++) {
                    const ang = it.t0 + s * dt;
                    const ca = Math.cos(ang), sa = Math.sin(ang);
                    const wx = it.r1 * ca, wy = it.r1 * sa;
                    const p = P(wx, wy, evalZ(it.lf, wx, wy));
                    if (s === 0) pathObj.moveTo(p.x, p.y);
                    else pathObj.lineTo(p.x, p.y);
                }
                for (let s = nSeg; s >= 0; s--) {
                    const ang = it.t0 + s * dt;
                    const ca = Math.cos(ang), sa = Math.sin(ang);
                    const wx = it.r0 * ca, wy = it.r0 * sa;
                    const p = P(wx, wy, evalZ(it.lf, wx, wy));
                    pathObj.lineTo(p.x, p.y);
                }
                pathObj.closePath();
            };

            if (!it.isUnknown) {
                const fillBucket = fills[(it.ngoaiDuong ? 3 : 0) + it.densTier];
                addSectorPath(fillBucket);
                addSectorPath(it.ngoaiDuong ? strokes.coral : strokes.road);
            } else {
                addSectorPath(strokes.unk);
            }
        }

        if (!skipJump && this._hienCanhNhayPolar) {
            const jEdges = ThuatToanSurface.layCanhNhay(mat);
            for (let i = 0; i < jEdges.length; i++) {
                const e = jEdges[i];
                const p1 = P(e.x1, e.y1, e.z1);
                const p2 = P(e.x2, e.y2, e.z2);
                if (!Number.isFinite(p1.x + p1.y + p2.x + p2.y)) continue;
                if ((p1.x < -pad && p2.x < -pad) || (p1.x > cw + pad && p2.x > cw + pad) ||
                    (p1.y < -pad && p2.y < -pad) || (p1.y > ch + pad && p2.y > ch + pad)) {
                    continue;
                }
                const jb = e.level === 2 ? strokes.jump2 : strokes.jump1;
                jb.moveTo(p1.x, p1.y);
                jb.lineTo(p2.x, p2.y);
            }
        }

        return { fills, strokes, nDraw };
    }

    static _vePathOrFallback(ctx, pathObj, mode) {
        if (!pathObj) return;
        if (typeof Path2D !== 'undefined' && pathObj instanceof Path2D) {
            if (mode === 'fill') ctx.fill(pathObj);
            else ctx.stroke(pathObj);
            return;
        }
        const ops = pathObj._ops;
        if (!ops || ops.length === 0) return;
        ctx.beginPath();
        for (let i = 0; i < ops.length; i++) {
            const op = ops[i];
            if (op[0] === 'M') ctx.moveTo(op[1], op[2]);
            else if (op[0] === 'L') ctx.lineTo(op[1], op[2]);
            else if (op[0] === 'Z') ctx.closePath();
        }
        if (mode === 'fill') ctx.fill();
        else ctx.stroke();
    }

    veLenCanvasTop(ctx, { fn, box, project, cw, ch }) {
        if (!this.isActive || !ctx || !box || !project) return;
        const [bx, by, bz, , , rz = 0] = box;
        const co = Math.cos(rz), si = Math.sin(rz);
        const P = (x, y, t) => {
            const dx = x - bx, dy = y - by;
            const u = co * dx + si * dy;
            const v = -si * dx + co * dy;
            const zt = ThuatToanSurface.evalTileZ(t, x, y);
            return project(u, v, zt - bz);
        };

        const isPolar = (this._cheDoLuoi === 'dongtam' || this._cheDoLuoi === 'ca_hai');
        if (isPolar) {
            const mat = this.layMatDongTamChoVe(fn, true);
            if (mat && mat.sanSang) {
                const pack = this._thuThapVePolar2D(mat, fn, box, project, cw, ch, true);
                if (pack) {
                    const PM = ThuatToanSurface.MAU_POLAR;
                    const alphas = [0.24, 0.30, 0.38];
                    ctx.save();
                    for (let tier = 0; tier < 3; tier++) {
                        ctx.fillStyle = PM.roadFillPrefix + alphas[tier] + ')';
                        ThuatToanSurface._vePathOrFallback(ctx, pack.fills[tier], 'fill');
                        ctx.fillStyle = PM.coralFillPrefix + alphas[tier] + ')';
                        ThuatToanSurface._vePathOrFallback(ctx, pack.fills[3 + tier], 'fill');
                    }
                    // Nếu chế độ "Cả hai": vẽ thêm wireframe hồng v4 nhẹ (không tô nền)
                    if (this._cheDoLuoi === 'ca_hai') {
                        const resV4 = this.laySurfaceChoVe(fn);
                        const tiles = resV4?.data?.tiles || [];
                        if (tiles.length > 0) {
                            ctx.beginPath();
                            for (const t of tiles) {
                                const q = [P(t.x0, t.y0, t), P(t.x1, t.y0, t), P(t.x1, t.y1, t), P(t.x0, t.y1, t)];
                                if (q.every(p => p.x < -20) || q.every(p => p.x > cw + 20) ||
                                    q.every(p => p.y < -20) || q.every(p => p.y > ch + 20)) continue;
                                ctx.moveTo(q[0].x, q[0].y);
                                ctx.lineTo(q[1].x, q[1].y);
                                ctx.lineTo(q[2].x, q[2].y);
                                ctx.lineTo(q[3].x, q[3].y);
                                ctx.closePath();
                            }
                            ctx.setLineDash([3, 3]);
                            ctx.lineWidth = 0.85;
                            ctx.strokeStyle = 'rgba(244, 114, 182, 0.55)';
                            ctx.stroke();
                        }
                    }
                    ctx.restore();
                }
                return;
            }
            // Fallback tạm sang v4 nếu Đồng Tâm của frame này chưa sẵn sàng
            const resFb = this.laySurfaceChoVe(fn);
            if (!resFb || !resFb.data || !resFb.data.tiles || resFb.data.tiles.length === 0) {
                const tagTxt = `⏳ Đang dựng Đồng Tâm F${fn}...`;
                ctx.save();
                ctx.font = 'bold 10px "Segoe UI", sans-serif';
                const tw = ctx.measureText(tagTxt).width + 12;
                const bxLbl = 8, byLbl = ch - 24;
                ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
                ctx.strokeStyle = 'rgba(34, 211, 238, 0.70)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.rect(bxLbl, byLbl, tw, 18);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = '#a5f3fc';
                ctx.fillText(tagTxt, bxLbl + 6, byLbl + 12);
                ctx.restore();
                return;
            }
        }

        const res = this.laySurfaceChoVe(fn);
        if (!res || !res.data || !res.data.tiles || res.data.tiles.length === 0) return;

        const { data, srcFrame, borrowed } = res;
        const showSelection = (!borrowed && Number(fn) === this.currentFrame);

        const vis = [];
        for (const t of data.tiles) {
            const q = [P(t.x0, t.y0, t), P(t.x1, t.y0, t), P(t.x1, t.y1, t), P(t.x0, t.y1, t)];
            if (q.every(p => p.x < -20) || q.every(p => p.x > cw + 20) ||
                q.every(p => p.y < -20) || q.every(p => p.y > ch + 20)) {
                continue;
            }
            const isSel = showSelection && this.selectedTileIds.has(t.id);
            vis.push({ t, q, isSel });
        }
        if (vis.length === 0) return;

        ctx.save();
        // Lượt 1: Tô nền hồng nhạt (không chọn trước, chọn sau)
        for (const passSel of [false, true]) {
            for (const item of vis) {
                if (item.isSel !== passSel) continue;
                const { t, q } = item;
                const { fill } = ThuatToanSurface.mauCanvas(t, passSel, borrowed);
                ctx.beginPath();
                ctx.moveTo(q[0].x, q[0].y);
                ctx.lineTo(q[1].x, q[1].y);
                ctx.lineTo(q[2].x, q[2].y);
                ctx.lineTo(q[3].x, q[3].y);
                ctx.closePath();
                ctx.fillStyle = fill;
                ctx.fill();
            }
        }

        // Lượt 2: Kẻ viền lưới chữ nhật
        for (const item of vis) {
            if (item.isSel) continue;
            const { t, q } = item;
            const { stroke } = ThuatToanSurface.mauCanvas(t, false, borrowed);
            ctx.beginPath();
            ctx.moveTo(q[0].x, q[0].y);
            ctx.lineTo(q[1].x, q[1].y);
            ctx.lineTo(q[2].x, q[2].y);
            ctx.lineTo(q[3].x, q[3].y);
            ctx.closePath();
            ctx.setLineDash((borrowed || t.source === 'extrapolated' || t.source === 'occluded') ? [4, 4] : []);
            ctx.lineWidth = t.manual ? 1.5 : 0.9;
            ctx.strokeStyle = stroke;
            ctx.stroke();
        }

        // Lượt 3: Viền nổi bật cho các ô đang chọn
        for (const item of vis) {
            if (!item.isSel) continue;
            const { q } = item;
            ctx.beginPath();
            ctx.moveTo(q[0].x, q[0].y);
            ctx.lineTo(q[1].x, q[1].y);
            ctx.lineTo(q[2].x, q[2].y);
            ctx.lineTo(q[3].x, q[3].y);
            ctx.closePath();
            ctx.setLineDash([]);
            ctx.lineWidth = 2.2;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.setLineDash([5, 4]);
            ctx.lineWidth = 1.4;
            ctx.strokeStyle = '#fde047';
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // Nhãn trạng thái nhỏ ở góc dưới trái của TOP View
        const cRoad = ThuatToanSurface.layMatDuongTaiViTri(data, bx, by);
        const waitPolarPrefix = isPolar ? '≈v4 tạm • ' : '';
        const tagTxt = `${waitPolarPrefix}Surface ${borrowed ? `≈F${srcFrame}` : `F${fn}`}${cRoad ? ` • Z:${cRoad.zRoad.toFixed(2)}m` : ''}`;
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        const tw = ctx.measureText(tagTxt).width + 12;
        const bxLbl = 8, byLbl = ch - 24;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
        ctx.strokeStyle = 'rgba(244, 114, 182, 0.65)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bxLbl, byLbl, tw, 18);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fbcfe8';
        ctx.fillText(tagTxt, bxLbl + 6, byLbl + 12);
        ctx.restore();
    }

    veVienDongTamTop(ctx, { fn, box, project, cw, ch, skipJump = false }) {
        if (!this.isActive || !ctx || !box || !project) return;
        if (this._cheDoLuoi !== 'dongtam' && this._cheDoLuoi !== 'ca_hai') return;
        const mat = this.layMatDongTamChoVe(fn, false);
        if (!mat || !mat.sanSang) return;

        const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const pack = this._thuThapVePolar2D(mat, fn, box, project, cw, ch, skipJump);
        if (!pack) return;

        const PM = ThuatToanSurface.MAU_POLAR;
        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Vẽ 2 lớp (viền đen halo + viền màu rực) để nổi bật sắc nét trên mây điểm LiDAR trắng
        const strokeWithHalo = (pathObj, color, width, dash = []) => {
            if (!pathObj) return;
            ctx.setLineDash(dash);
            ctx.lineWidth = width + 1.8;
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.68)';
            ThuatToanSurface._vePathOrFallback(ctx, pathObj, 'stroke');
            ctx.lineWidth = width;
            ctx.strokeStyle = color;
            ThuatToanSurface._vePathOrFallback(ctx, pathObj, 'stroke');
        };

        if (this._hienUnknownPolar) {
            strokeWithHalo(pack.strokes.unk, PM.unkStroke2d, 1.2, [4, 4]);
        }
        strokeWithHalo(pack.strokes.road, PM.roadStroke2d, 1.4, []);
        strokeWithHalo(pack.strokes.coral, PM.coralStroke2d, 1.4, []);
        if (!skipJump && this._hienCanhNhayPolar) {
            strokeWithHalo(pack.strokes.jump1, PM.jump1Stroke2d, 2.4, []);
            strokeWithHalo(pack.strokes.jump2, PM.jump2Stroke2d, 2.4, []);
        }
        ctx.setLineDash([]);

        // Nhãn trạng thái ở góc dưới trái
        const [bx, by] = box;
        const zCar = mat.zTai(bx, by);
        let zSoftCar = NaN;
        let isSoftZ = false;
        if (!Number.isFinite(zCar) && mat._neoState && mat._neoState.coNeoXe) {
            const Neo = ThuatToanSurface._getNeoDuyet();
            if (Neo && typeof Neo.zMem === 'function') {
                const mCar = Neo.zMem(bx, by, mat._neoState, {});
                if (mCar && mCar.valid && (mCar.Wsoft || 0) >= (Neo.CONFIG?.WsoftMin ?? 0.20) && Number.isFinite(mCar.z)) {
                    zSoftCar = mCar.z;
                    isSoftZ = true;
                }
            }
        }
        const zStr = Number.isFinite(zCar) ? ` · Z:${zCar.toFixed(2)}m` : '';
        const zSoftStr = (!Number.isFinite(zCar) && isSoftZ) ? ` · ~Z:${zSoftCar.toFixed(2)}m` : '';
        const sparseStr = mat._fromSparse ? ' · mây thưa' : '';
        const modePrefix = this._cheDoLuoi === 'ca_hai' ? 'Đồng Tâm + v4' : 'Đồng Tâm';
        const baseTxt = `${modePrefix} F${fn} · ${mat.diag.nLeafValid} lá${zStr}`;
        const tailTxt = `${zSoftStr}${sparseStr}`;
        const tagTxt = `${baseTxt}${tailTxt}`;
        ctx.font = 'bold 10px "Segoe UI", sans-serif';
        const tw = ctx.measureText(tagTxt).width + 12;
        const bxLbl = 8, byLbl = ch - 24;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
        ctx.strokeStyle = 'rgba(34, 211, 238, 0.80)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bxLbl, byLbl, tw, 18);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#a5f3fc';
        if (isSoftZ) {
            ctx.fillText(baseTxt, bxLbl + 6, byLbl + 12);
            const baseW = ctx.measureText(baseTxt).width;
            ctx.fillStyle = '#94a3b8';
            ctx.fillText(zSoftStr, bxLbl + 6 + baseW, byLbl + 12);
            if (sparseStr) {
                const softW = ctx.measureText(zSoftStr).width;
                ctx.fillStyle = '#a5f3fc';
                ctx.fillText(sparseStr, bxLbl + 6 + baseW + softW, byLbl + 12);
            }
        } else {
            ctx.fillText(tagTxt, bxLbl + 6, byLbl + 12);
        }
        ctx.restore();

        const dtMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
        if (typeof window !== 'undefined' && window.__cvatPolarDiag) {
            window.__cvatPolarDiag.top = { ms: Number(dtMs.toFixed(2)), nDraw: pack.nDraw };
        }
        if (dtMs > 2.0) {
            console.warn(`[Đồng Tâm TOP] F${fn} render ${dtMs.toFixed(2)}ms (${pack.nDraw} lá)`);
        }
    }

    static _laSachChoFallback(q, lf) {
        const bad = (o) => Boolean(o && (o.ngoaiDuong === true || o.coarse === true || o.outlier === true || o.vatCan === true));
        if (!lf || lf.loai !== 'LEAF' || !Number.isFinite(lf.z0)) return false;
        if (bad(q) || bad(lf) || bad(q?.leaf)) return false;
        return true;
    }

    static _lamMuot121(arr, mutable, passes = 2) {
        const n = arr ? arr.length : 0;
        if (n < 5 || !mutable || passes <= 0) return;
        const tmp = new Float64Array(n);
        for (let pass = 0; pass < passes; pass++) {
            tmp.set(arr);
            for (let i = 1; i < n - 1; i++) {
                if (mutable[i]) {
                    arr[i] = 0.25 * (tmp[i - 1] + 2.0 * tmp[i] + tmp[i + 1]);
                }
            }
        }
    }

    static demDiemTrongHop(rawPts, carBox, cap = ThuatToanSurface.HOSO_CAT_CFG.NPTS_CAP) {
        if (!rawPts || !carBox) return undefined;
        const bx = Number.isFinite(carBox.x) ? carBox.x : carBox.cx;
        const by = Number.isFinite(carBox.y) ? carBox.y : carBox.cy;
        const bz = Number.isFinite(carBox.z) ? carBox.z : carBox.cz;
        const L = carBox.L, W = carBox.W, H = carBox.H;
        const rz = carBox.rz || 0;
        if (![bx, by, bz, L, W, H, rz].every(Number.isFinite)) return undefined;

        const len = rawPts.length;
        if (!Number.isFinite(len)) return undefined;
        if (len === 0) return 0;

        const p0 = rawPts[0];
        let mode = 0; // 1: array-like [x,y,z], 2: object {x,y,z}
        if (Array.isArray(p0) || (ArrayBuffer.isView(p0) && Number.isFinite(p0.length) && p0.length >= 3)) mode = 1;
        else if (p0 && typeof p0 === 'object' && Number.isFinite(p0.x) && Number.isFinite(p0.y) && Number.isFinite(p0.z)) mode = 2;
        else return undefined;

        if (!this._demDiemCache) this._demDiemCache = new WeakMap();
        const canCache = (typeof rawPts === 'object' && rawPts !== null);
        let boxMap = canCache ? this._demDiemCache.get(rawPts) : null;
        const sig = `${Math.round(bx * 1000)}_${Math.round(by * 1000)}_${Math.round(bz * 1000)}_${Math.round(L * 1000)}_${Math.round(W * 1000)}_${Math.round(H * 1000)}_${Math.round(rz * 1000)}_${cap}`;
        if (boxMap && boxMap.has(sig)) return boxMap.get(sig);

        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const hL = L * 0.5 + 0.10;
        const hW = W * 0.5 + 0.10;
        const rBound = Math.hypot(hL, hW);
        const zMin = bz - H * 0.5 - 0.30;
        const zMax = bz + H * 0.5;
        let cnt = 0;
        if (mode === 1) {
            for (let i = 0; i < len; i++) {
                const p = rawPts[i];
                if (!p) continue;
                const dx = p[0] - bx;
                if (dx < -rBound || dx > rBound) continue;
                const dy = p[1] - by;
                if (dy < -rBound || dy > rBound) continue;
                const pz = p[2];
                if (pz < zMin || pz > zMax) continue;
                const u = dx * cosR + dy * sinR;
                if (u < -hL || u > hL) continue;
                const v = -dx * sinR + dy * cosR;
                if (v < -hW || v > hW) continue;
                cnt++;
                if (cnt >= cap) break;
            }
        } else {
            for (let i = 0; i < len; i++) {
                const p = rawPts[i];
                if (!p) continue;
                const dx = p.x - bx;
                if (dx < -rBound || dx > rBound) continue;
                const dy = p.y - by;
                if (dy < -rBound || dy > rBound) continue;
                const pz = p.z;
                if (pz < zMin || pz > zMax) continue;
                const u = dx * cosR + dy * sinR;
                if (u < -hL || u > hL) continue;
                const v = -dx * sinR + dy * cosR;
                if (v < -hW || v > hW) continue;
                cnt++;
                if (cnt >= cap) break;
            }
        }
        if (canCache) {
            if (!boxMap) {
                boxMap = new Map();
                this._demDiemCache.set(rawPts, boxMap);
            } else if (boxMap.size > 256) {
                boxMap.clear();
            }
            boxMap.set(sig, cnt);
        }
        return cnt;
    }

    static latCatHienThiDongBo(mat, box, truc = 'SIDE', opts = {}) {
        if (!ThuatToanSurface.coPolarHienThi(mat) || !Array.isArray(box) || box.length < 6) {
            return { ok: false, pts: [], doan: [], zCenter: NaN, loaiCenter: 'NONE' };
        }
        const [bx, by, bz, rx = 0, ry = 0, rz = 0] = box;
        if (![bx, by, bz, rx, ry, rz].every(Number.isFinite)) {
            return { ok: false, pts: [], doan: [], zCenter: NaN, loaiCenter: 'NONE' };
        }
        const isSide = (truc === 'SIDE' || truc === 'side');
        const sMin = Number.isFinite(opts.sMin) ? opts.sMin : (Number.isFinite(opts.range) ? -Math.abs(opts.range) : -12);
        const sMax = Number.isFinite(opts.sMax) ? opts.sMax : (Number.isFinite(opts.range) ? Math.abs(opts.range) : 12);
        if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMax <= sMin) {
            return { ok: false, pts: [], doan: [], zCenter: NaN, loaiCenter: 'NONE' };
        }
        const dsReq = (Number.isFinite(opts.ds) && opts.ds > 0) ? opts.ds : 0.05;
        const step = Math.max(dsReq, (sMax - sMin) / 600);
        const n = Math.max(2, Math.floor((sMax - sMin) / step) + 1);
        const R = ThuatToanSurface.eulerXYZToMatrix(rx, ry, rz);
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const dxDir = isSide ? cosR : -sinR;
        const dyDir = isSide ? sinR : cosR;
        const fb = opts.fb || null;

        const pts = new Array(n);
        const doan = [];
        let segStart = -1;
        let segLoai = null;
        let validCnt = 0;

        for (let i = 0; i < n; i++) {
            const s = (i === n - 1) ? sMax : (sMin + i * step);
            const qx = bx + s * dxDir;
            const qy = by + s * dyDir;
            const ev = ThuatToanSurface.zHienThiThongNhat(mat, qx, qy, fb, null);
            if (ev.loai !== 'NONE' && Number.isFinite(ev.z)) {
                const dx = qx - bx, dy = qy - by, dz = ev.z - bz;
                const uLoc = dx * R[0][0] + dy * R[1][0] + dz * R[2][0];
                const vLoc = dx * R[0][1] + dy * R[1][1] + dz * R[2][1];
                const wLoc = dx * R[0][2] + dy * R[1][2] + dz * R[2][2];
                pts[i] = { s, qx, qy, z: ev.z, u: isSide ? uLoc : vLoc, w: wLoc, loai: ev.loai };
                validCnt++;
                if (segStart < 0) {
                    segStart = i;
                    segLoai = ev.loai;
                } else if (ev.loai !== segLoai) {
                    doan.push({ i0: segStart, i1: i, loai: segLoai });
                    segStart = i;
                    segLoai = ev.loai;
                }
            } else {
                pts[i] = { s, qx, qy, z: NaN, u: s, w: NaN, loai: 'NONE' };
                if (segStart >= 0) {
                    if (i - 1 > segStart) doan.push({ i0: segStart, i1: i - 1, loai: segLoai });
                    segStart = -1;
                    segLoai = null;
                }
            }
        }
        if (segStart >= 0 && n - 1 > segStart) {
            doan.push({ i0: segStart, i1: n - 1, loai: segLoai });
        }
        const ev0 = ThuatToanSurface.zHienThiThongNhat(mat, bx, by, fb, null);
        return {
            ok: validCnt >= 2 && doan.length > 0,
            pts,
            doan,
            zCenter: ev0.z,
            loaiCenter: ev0.loai
        };
    }

    /**
     * Step 8 (Đợt 2): Tính mặt cắt Polar mượt C^1 dọc lát cắt SIDE / FRONT.
     * Bên trong footprint xe (|s| <= half + 0.4) omega=0 -> giữ nguyên mặt phẳng carGround.
     */
    static tinhHoSoCat(mat, carGround, carBox, axis, sMin, sMax, ds = 0.25, dirVec = null, opts = null) {
        if (!mat || !mat.sanSang || typeof mat.truyVan !== 'function' || !carGround || !Number.isFinite(carGround.zc) || !carBox) return null;
        if (!Number.isFinite(sMin) || !Number.isFinite(sMax) || sMax <= sMin) return null;
        const bx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? 0);
        const by = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? 0);
        const L = carBox.L || 4.5, W = carBox.W || 1.9, rz = carBox.rz || 0;
        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const isSide = (axis === 'side');
        const ux = dirVec ? dirVec[0] : (isSide ? cosR : -sinR);
        const uy = dirVec ? dirVec[1] : (isSide ? sinR : cosR);
        const half = (isSide ? L : W) * 0.5;
        const Tb = isSide ? 2.0 : 1.0;
        const step = Math.max(0.05, ds);
        const n = Math.max(2, Math.floor((sMax - sMin) / step) + 1);
        const limitSlope = Boolean(
            (opts && opts.limitSlope)
            || carGround.nhan === 'DA·DUYET'
            || (opts && Number.isFinite(opts.nPts) && opts.nPts < 40)
        );
        const robProfCfg = this._getRobustSurfaceCfg(opts?.robustSurface);
        const useDynClamp = Boolean(!limitSlope && robProfCfg.enabled && opts?.robustSurface !== false);
        const dynSlopeRate = isSide ? (robProfCfg.slopeCap?.long ?? 0.08) : (robProfCfg.slopeCap?.lat ?? 0.035);
        const dynClampBase = robProfCfg.profile?.clampBase ?? 0.04;
        const dynClampMax = robProfCfg.profile?.clampMax ?? 0.25;

        const cfgCat = ThuatToanSurface.HOSO_CAT_CFG;
        const sArr = new Float64Array(n);
        const rRaw = new Float64Array(n);
        const validArr = new Uint8Array(n);
        const confArr = new Uint8Array(n);
        const clippedArr = new Uint8Array(n);
        const clippedDownArr = new Uint8Array(n);
        const rawDiffArr = new Float64Array(n);
        const cgFlags = Array.isArray(carGround.flags) ? carGround.flags : [];
        const skipDownClamp = cgFlags.includes('ROOF_LECH') || cgFlags.includes('ROOF_KEP');
        const capAt = (s) => {
            const dOut = Math.max(0, Math.abs(s) - (half + 0.4));
            if (limitSlope) return 0.03 + 0.12 * dOut;
            if (useDynClamp) return Math.min(dynClampMax, dynClampBase + dynSlopeRate * dOut);
            return Infinity;
        };
        let firstValid = -1, lastValid = -1;
        let usedLeafCount = 0;
        let maxAbsRaw = 0;

        for (let i = 0; i < n; i++) {
            const s = sMin + i * step;
            sArr[i] = s;
            const qx = bx + s * ux;
            const qy = by + s * uy;
            const zCar = carGround.zc + carGround.gx * (qx - bx) + carGround.gy * (qy - by);
            const q = mat.truyVan(qx, qy);
            const isOk = Boolean(
                q && q.nguon === 'LEAF' && Number.isFinite(q.z)
                && q.sigma <= 0.08 && (q.spanM ?? 0) <= 12.0
                && !q.coarse && !q.outlier && !q.leaf?.ngoaiDuong && !q.ngoaiDuong && !q.leaf?.vatCan
            );
            let zSample = isOk ? q.z : NaN;
            let conf = isOk
                ? ((q.loai === 'UNKNOWN' || q.loai === 'NONE' || q.leaf?.loai === 'UNKNOWN') ? 1 : 2)
                : 0;
            if (!isOk && mat._neoState && mat._neoState.coNeoXe && typeof mat.zHienThiTaiLa === 'function') {
                const Neo = ThuatToanSurface._getNeoDuyet();
                const mS = (Neo && typeof Neo.zMem === 'function') ? Neo.zMem(qx, qy, mat._neoState, {}) : null;
                const wMin = Neo?.CONFIG?.WsoftMin ?? 0.20;
                if (mS && mS.valid && Number.isFinite(mS.z) && (mS.Wsoft || 0) >= wMin) {
                    const lf = q?.leaf || (typeof mat.timLa === 'function' ? mat.timLa(qx, qy) : null);
                    const bad = (o) => Boolean(o && (o.ngoaiDuong === true || o.coarse === true || o.outlier === true || o.vatCan === true));
                    if (!bad(q) && !bad(q?.leaf) && !bad(lf)) {
                        if (lf && lf.loai === 'LEAF') {
                            if (ThuatToanSurface._laSachChoFallback(q, lf)) {
                                let zH = mat.zHienThiTaiLa(lf, qx, qy);
                                if (!Number.isFinite(zH) || Math.abs(zH - mS.z) > cfgCat.FALLBACK_TOL) zH = mS.z;
                                zSample = zH;
                                conf = 1;
                            }
                        } else if ((!lf || lf.loai === 'UNKNOWN') && (mS.Wsoft || 0) >= cfgCat.WSOFT_HOLE) {
                            zSample = mS.z;
                            conf = 1;
                        }
                    }
                }
            }
            confArr[i] = conf;
            if (conf > 0) {
                validArr[i] = 1;
                usedLeafCount++;
                const rawDiff = zSample - zCar;
                rawDiffArr[i] = rawDiff;
                let rVal = (skipDownClamp && rawDiff < 0)
                    ? rawDiff
                    : Math.max(-0.25, Math.min(0.25, rawDiff));
                if (limitSlope || useDynClamp) {
                    const capC = capAt(s);
                    if (rawDiff > capC) clippedArr[i] = 1;
                    else if (rawDiff < -capC) clippedDownArr[i] = 1;
                    if (rVal > capC) rVal = capC;
                    else if (!skipDownClamp && rVal < -capC) rVal = -capC;
                }
                rRaw[i] = rVal;
                if (Math.abs(rVal) > maxAbsRaw) maxAbsRaw = Math.abs(rVal);
                if (firstValid < 0) firstValid = i;
                lastValid = i;
            }
        }
        if (opts && opts.diagFn !== undefined && opts.nPts !== undefined && opts.nPts < 40) {
            if (!ThuatToanSurface._hoSoCatDiagLogged) ThuatToanSurface._hoSoCatDiagLogged = new Set();
            const dKey = `${opts.diagFn}_${axis}`;
            if (!ThuatToanSurface._hoSoCatDiagLogged.has(dKey)) {
                ThuatToanSurface._hoSoCatDiagLogged.add(dKey);
                console.info(`[HoSoCat F${opts.diagFn} ${axis}] leaves=${usedLeafCount}, max|rRaw|=${maxAbsRaw.toFixed(3)}m, nPts=${opts.nPts}, zCar0=${carGround.zc.toFixed(3)}m`);
            }
        }
        if (firstValid < 0) return null;

        // Nội suy khoảng khuyết giữa hai điểm hợp lệ và giữ phẳng (hold) ở hai đuôi ngoài biên
        const rFill = new Float64Array(n);
        const tailMode = opts?.tailMode ?? 'hold';
        const edgeVal = (idx) => (Math.abs(sArr[idx]) <= half + 0.4 ? 0 : rRaw[idx]);
        const rLo = edgeVal(firstValid);
        const rHi = edgeVal(lastValid);
        for (let i = 0; i < firstValid; i++) {
            const dist = (firstValid - i) * step;
            rFill[i] = tailMode === 'decay'
                ? rRaw[firstValid] * Math.max(0, 1.0 - dist / 3.0)
                : (tailMode === 'half' ? rLo * (1.0 - 0.5 * Math.min(1.0, dist / 4.0)) : rLo);
        }
        for (let i = lastValid + 1; i < n; i++) {
            const dist = (i - lastValid) * step;
            rFill[i] = tailMode === 'decay'
                ? rRaw[lastValid] * Math.max(0, 1.0 - dist / 3.0)
                : (tailMode === 'half' ? rHi * (1.0 - 0.5 * Math.min(1.0, dist / 4.0)) : rHi);
        }
        if (tailMode !== 'decay') {
            for (let i = 0; i < firstValid; i++) {
                const c = capAt(sArr[i]);
                if (rFill[i] > c) rFill[i] = c;
                else if (!skipDownClamp && rFill[i] < -c) rFill[i] = -c;
            }
            for (let i = lastValid + 1; i < n; i++) {
                const c = capAt(sArr[i]);
                if (rFill[i] > c) rFill[i] = c;
                else if (!skipDownClamp && rFill[i] < -c) rFill[i] = -c;
            }
        }
        let prevIdx = firstValid;
        rFill[firstValid] = rRaw[firstValid];
        for (let i = firstValid + 1; i <= lastValid; i++) {
            if (validArr[i]) {
                rFill[i] = rRaw[i];
                const gap = i - prevIdx;
                for (let j = prevIdx + 1; j < i; j++) {
                    const t = (j - prevIdx) / gap;
                    rFill[j] = rRaw[prevIdx] + t * (rRaw[i] - rRaw[prevIdx]);
                }
                prevIdx = i;
            }
        }

        // Làm mượt nhẹ [1,2,1]/4 chỉ cho nhánh chưa duyệt (không chạm DA·DUYET và footprint)
        if (useDynClamp && opts?.smooth !== false) {
            const mutable = new Uint8Array(n);
            for (let i = 0; i < n; i++) {
                if (Math.abs(sArr[i]) > half + 0.4) mutable[i] = 1;
            }
            ThuatToanSurface._lamMuot121(rFill, mutable, cfgCat.SMOOTH_PASSES);
            for (let i = 1; i < n - 1; i++) {
                if (!mutable[i]) continue;
                const c = capAt(sArr[i]);
                if (rFill[i] > c) rFill[i] = c;
                else if (!skipDownClamp && rFill[i] < -c) rFill[i] = -c;
            }
        }

        // Median 3 điểm khử gai ranh giới lá
        const rMed = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = rFill[Math.max(0, i - 1)];
            const b = rFill[i];
            const c = rFill[Math.min(n - 1, i + 1)];
            rMed[i] = a <= b ? (b <= c ? b : (a <= c ? c : a)) : (a <= c ? a : (b <= c ? c : b));
        }

        // Gaussian sigma = 0.75m khử răng cưa
        const sigG = 0.75;
        const rad = Math.max(1, Math.ceil((2.5 * sigG) / step));
        const inv2Sig2 = 1.0 / (2.0 * sigG * sigG);
        const offsetArr = new Float64Array(n);
        const zArr = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            let sw = 0, swR = 0;
            const j0 = Math.max(0, i - rad), j1 = Math.min(n - 1, i + rad);
            for (let j = j0; j <= j1; j++) {
                const d = (j - i) * step;
                const w = Math.exp(-d * d * inv2Sig2);
                sw += w;
                swR += w * rMed[j];
            }
            const rawSmooth = sw > 0 ? swR / sw : rMed[i];
            const rSmooth = skipDownClamp
                ? Math.min(0.25, rawSmooth)
                : Math.max(-0.25, Math.min(0.25, rawSmooth));
            const s = sArr[i];
            const dFoot = Math.max(0, Math.abs(s) - (half + 0.4));
            const t = Math.min(1.0, dFoot / Tb);
            const omega = t * t * (3.0 - 2.0 * t);
            const off = omega * rSmooth;
            offsetArr[i] = off;
            const qx = bx + s * ux, qy = by + s * uy;
            zArr[i] = carGround.zc + carGround.gx * (qx - bx) + carGround.gy * (qy - by) + off;
        }

        const evalAtS = (s) => {
            if (!Number.isFinite(s)) return { offset: 0, valid: false, conf: 0, soft: false };
            const pos = (s - sMin) / step;
            const i0 = Math.max(0, Math.min(n - 1, Math.floor(pos)));
            const i1 = Math.min(n - 1, i0 + 1);
            const frac = Math.max(0, Math.min(1, pos - i0));
            const offset = offsetArr[i0] + frac * (offsetArr[i1] - offsetArr[i0]);
            const inFoot = Math.abs(s) <= half + 0.4;
            const rIdx = Math.round(pos);
            const cIdx = rIdx < n ? Math.max(0, rIdx) : n - 1;
            const conf = inFoot ? 2 : confArr[cIdx];
            const valid = inFoot || conf > 0;
            return { offset, valid, conf, soft: conf === 1 };
        };

        return { sArr, zArr, offsetArr, validArr, confArr, clippedArr, clippedDownArr, rawDiffArr, ds: step, sMin, evalAtS };
    }

    static _wCucBo(carGround, box, R, u, v, zOff = 0) {
        if (!carGround || !Number.isFinite(carGround.zc) || !Array.isArray(box) || !R) return NaN;
        const bx = box[0], by = box[1], bz = box[2];
        const a = [R[0][0], R[1][0], R[2][0]];
        const b = [R[0][1], R[1][1], R[2][1]];
        const c = [R[0][2], R[1][2], R[2][2]];
        const qx = bx + u * a[0] + v * b[0];
        const qy = by + u * a[1] + v * b[1];
        const qz = bz + u * a[2] + v * b[2];
        let denom = c[2] - carGround.gx * c[0] - carGround.gy * c[1];
        if (Math.abs(denom) < 0.2) denom = c[2] >= 0 ? 1 : -1;
        const zBase = carGround.zc + carGround.gx * (qx - bx) + carGround.gy * (qy - by) + zOff;
        return (zBase - qz) / denom;
    }

    veLenCanvasCat(ctx, { view, fn, box, toPx, sMin, sMax, halfDepth = 0.8, boxS = 0, boxBottomW = -0.8, S = 40, ch = 200, dongBoTop = true }) {
        if (!this.isActive || !ctx || !box || !toPx) return;
        const res = this.laySurfaceChoVe(fn);
        const data = res?.data || null;
        const srcFrame = res?.srcFrame ?? fn;
        const borrowed = !!res?.borrowed;

        const [bx, by, bz, rx = 0, ry = 0, rz = 0] = box;
        const R = ThuatToanSurface.eulerXYZToMatrix(rx, ry, rz);
        const a = [R[0][0], R[1][0], R[2][0]];
        const b = [R[0][1], R[1][1], R[2][1]];
        const c = [R[0][2], R[1][2], R[2][2]];
        const seed = data?.seedPlane || null;

        const rawPts = (this.callbacks.getFramePts ? this.callbacks.getFramePts(fn) : null)
            || (typeof window !== 'undefined' && window.pcdFrameCache?.get(fn))
            || data?.rawPoints
            || null;

        const activeTr = (this.callbacks && typeof this.callbacks.getActiveTrack === 'function')
            ? this.callbacks.getActiveTrack()
            : null;
        const activeSh = (activeTr && Array.isArray(activeTr.shapes))
            ? activeTr.shapes.find(s => s && !s.outside && Number(s.frame) === Number(fn))
            : null;
        const activeTid = activeTr
            ? (activeTr._displayId ?? activeTr._trackNumber ?? activeTr._clientID ?? activeTr.clientID ?? activeTr.id)
            : undefined;
        const carBoxObj = {
            x: bx, y: by, z: bz,
            rx: rx, ry: ry, rz: rz,
            L: Number.isFinite(box[6]) ? box[6] : 4.5,
            W: Number.isFinite(box[7]) ? box[7] : 1.9,
            H: Number.isFinite(box[8]) ? box[8] : 1.6,
            frame: Number(fn),
            shape: { points: box, outside: Boolean(activeSh?.outside), frame: Number(fn) },
            ...(activeTr ? { track: activeTr, trackId: activeTid } : {})
        };

        const carGround = this.layMatDuongCucBoChoBox(fn, carBoxObj, rawPts);

        // Nếu không có cả carGround lẫn lưới Surface tiles thì mới thoát
        if (!carGround && (!data || !data.tiles || data.tiles.length === 0)) return;

        // Mặt cắt Polar C^1 dọc lát cắt SIDE / FRONT khi dùng Đồng Tâm hoặc Cả hai
        const isPolarMode = (this._cheDoLuoi === 'dongtam' || this._cheDoLuoi === 'ca_hai');
        const matCat = (ThuatToanSurface.CO.polar && isPolarMode)
            ? (this.layMatDongTamChoVe(fn, false) || (rawPts ? this.layMatDongTamFrame(fn, false) : null))
            : null;
        const dirAxis = (view === 'side') ? a : b;
        const nBoxPts = ThuatToanSurface.demDiemTrongHop(rawPts, carBoxObj);
        const dongBo = Boolean(dongBoTop !== false && isPolarMode && ThuatToanSurface.coPolarHienThi(matCat));
        let fbDongBo = null;
        if (dongBo) {
            const egoRawC = this.egoPlaneCache?.get(Number(fn))
                || (rawPts && typeof this.layEgoGroundPlane === 'function' ? this.layEgoGroundPlane(fn, rawPts) : null);
            fbDongBo = {
                zE0: Number.isFinite(egoRawC?.z0) ? egoRawC.z0 : (bz - 0.8),
                gEx: Number.isFinite(egoRawC?.gx) ? egoRawC.gx : 0,
                gEy: Number.isFinite(egoRawC?.gy) ? egoRawC.gy : 0
            };
        }
        const lc = dongBo
            ? ThuatToanSurface.latCatHienThiDongBo(matCat, box, view === 'side' ? 'SIDE' : 'FRONT', {
                sMin, sMax, ds: Math.max(0.05, 4.0 / Math.max(10, S)), fb: fbDongBo
            })
            : null;
        const hoSoCat = (matCat && matCat.sanSang && carGround && Number.isFinite(carGround.zc))
            ? ThuatToanSurface.tinhHoSoCat(matCat, carGround, carBoxObj, view === 'side' ? 'side' : 'front', sMin, sMax, 0.25, dirAxis, {
                limitSlope: carGround.nhan === 'DA·DUYET',
                nPts: nBoxPts,
                diagFn: fn
            })
            : null;

        const evalLocalW = (u, v) => {
            // [ƯU TIÊN 1 - 2-TIER LOCAL GROUND PATCH + MẶT CẮT POLAR NGOÀI FOOTPRINT]:
            if (carGround && Number.isFinite(carGround.zc)) {
                let zOff = 0;
                let isExtPol = false;
                let confPol = 2;
                if (hoSoCat) {
                    const sCoord = (view === 'side') ? u : v;
                    const ev = hoSoCat.evalAtS(sCoord);
                    zOff = ev.offset;
                    isExtPol = !ev.valid;
                    confPol = Number.isFinite(ev.conf) ? ev.conf : (ev.valid ? 2 : 0);
                }
                const w = ThuatToanSurface._wCucBo(carGround, box, R, u, v, zOff);
                return { w, tile: null, isLocalPatch: true, carGround, isExtPol, confPol };
            }

            if (!data) return { w: bz - 0.8, tile: null, isLocalPatch: false };
            const qx = bx + u * a[0] + v * b[0];
            const qy = by + u * a[1] + v * b[1];
            const qz = bz + u * a[2] + v * b[2];
            let tile = ThuatToanSurface.timOTaiViTri(data, qx, qy);
            let gx = tile ? tile.gx : (seed ? seed.gx : 0);
            let gy = tile ? tile.gy : (seed ? seed.gy : 0);
            let zBase = tile ? ThuatToanSurface.evalTileZ(tile, qx, qy) : (seed ? seed.z0 + gx * qx + gy * qy : bz - 0.8);
            let denom = c[2] - gx * c[0] - gy * c[1];
            if (Math.abs(denom) < 0.2) denom = c[2] >= 0 ? 1 : -1;
            let w = (zBase - qz) / denom;

            // Tinh chỉnh 1 bước tại điểm giao thực Q + w*c nếu trượt sang ô kế bên
            const pxW = qx + w * c[0], pyW = qy + w * c[1];
            const t2 = ThuatToanSurface.timOTaiViTri(data, pxW, pyW);
            if (t2 && t2 !== tile) {
                tile = t2;
                denom = c[2] - t2.gx * c[0] - t2.gy * c[1];
                if (Math.abs(denom) >= 0.2) {
                    w = (ThuatToanSurface.evalTileZ(t2, qx, qy) - qz) / denom;
                }
            }
            return { w, tile, isLocalPatch: false };
        };

        const useSyncedPolar = Boolean(dongBo && lc && lc.ok);
        const depths = halfDepth > 0.05 ? [-halfDepth, 0, halfDepth] : [0];
        const stepS = Math.max(0.03, 4.0 / Math.max(10, S));
        const samples = [];
        const showSelection = (!borrowed && Number(fn) === this.currentFrame);

        if (!useSyncedPolar) {
            for (let s = sMin; s <= sMax + 1e-6; s += stepS) {
                let minW = Infinity, maxW = -Infinity;
                let midRes = null;
                for (const d of depths) {
                    const u = view === 'side' ? s : d;
                    const v = view === 'side' ? d : s;
                    const r = evalLocalW(u, v);
                    if (d === 0) midRes = r;
                    if (r.w < minW) minW = r.w;
                    if (r.w > maxW) maxW = r.w;
                }
                if (!midRes) continue;
                const pMid = view === 'side' ? toPx(s, 0, midRes.w) : toPx(0, s, midRes.w);
                const pHi = view === 'side' ? toPx(s, 0, maxW) : toPx(0, s, maxW);
                const pLo = view === 'side' ? toPx(s, 0, minW) : toPx(0, s, minW);
                const midCls = midRes.isLocalPatch
                    ? (midRes.confPol === 2 ? 'hard' : (midRes.confPol === 1 ? 'soft' : 'ext'))
                    : ((!midRes.tile || midRes.tile.source === 'extrapolated' || midRes.tile.source === 'occluded' || borrowed) ? 'ext' : 'hard');
                samples.push({
                    s,
                    pMid,
                    pHi,
                    pLo,
                    tile: midRes.tile,
                    isLocal: !!midRes.isLocalPatch,
                    isSw: midRes.tile?.type === 'sidewalk',
                    isSel: !!(showSelection && midRes.tile && this.selectedTileIds.has(midRes.tile.id)),
                    cls: midCls,
                    isExt: midCls === 'ext'
                });
            }
            if (samples.length < 2) return;
        }

        ctx.save();
        // Vẽ dải băng mặt cắt độ nghiêng ngang (mỏng tối thiểu 5px cho dễ nhìn)
        let segStart = 0;
        const nhanPalette = {
            'PATCH':       { stroke: '#34d399', fill: 'rgba(52, 211, 153, 0.20)',  wheel: '#059669' },
            'PATCH+POLAR': { stroke: '#22d3ee', fill: 'rgba(34, 211, 238, 0.22)',  wheel: '#0891b2' },
            'POLAR':       { stroke: '#06b6d4', fill: 'rgba(6, 182, 212, 0.22)',   wheel: '#0e7490' },
            'TRACK·ROOF':  { stroke: '#2dd4bf', fill: 'rgba(45, 212, 191, 0.24)',  wheel: '#0d9488' },
            'TRACK·PROP':  { stroke: '#c084fc', fill: 'rgba(192, 132, 252, 0.22)', wheel: '#9333ea' },
            'TRAJ·SOFT':   { stroke: '#38bdf8', fill: 'rgba(56, 189, 248, 0.20)',  wheel: '#0284c7' },
            'ROOF-H':      { stroke: '#60a5fa', fill: 'rgba(96, 165, 250, 0.20)',  wheel: '#2563eb' },
            'HYBRID':      { stroke: '#a78bfa', fill: 'rgba(167, 139, 250, 0.20)', wheel: '#7c3aed' },
            'NEIGHBOR':    { stroke: '#38bdf8', fill: 'rgba(56, 189, 248, 0.20)',  wheel: '#0284c7' },
            'FAR·PLANE':   { stroke: '#a78bfa', fill: 'rgba(167, 139, 250, 0.20)', wheel: '#7c3aed' },
            'BODY·FLOOR':  { stroke: '#fb923c', fill: 'rgba(251, 146, 60, 0.22)',  wheel: '#ea580c' },
            'DA·DUYET':    { stroke: '#4ade80', fill: 'rgba(74, 222, 128, 0.22)',  wheel: '#16a34a' },
            'NEO·DUYET':   { stroke: '#34d399', fill: 'rgba(52, 211, 153, 0.22)',  wheel: '#059669' },
            'EGO·CLAMP':   { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.20)',  wheel: '#d97706' },
            'EGO·WARN':    { stroke: '#fbbf24', fill: 'rgba(251, 191, 36, 0.20)',  wheel: '#d97706' }
        };
        const pal = (carGround && (nhanPalette[carGround.nhan] || nhanPalette['EGO·WARN'])) || nhanPalette['PATCH'];
        const cfgCat = ThuatToanSurface.HOSO_CAT_CFG;
        const carSoft = Boolean(carGround && carGround.nhan !== 'DA·DUYET' && (
            (Number.isFinite(carGround.sigma) && carGround.sigma >= cfgCat.SIGMA_SOFT)
            || carGround.nhan === 'TRAJ·SOFT'
            || carGround.nhan === 'EGO·CLAMP'
            || (Array.isArray(carGround.flags) && carGround.flags.includes('CAN_SAN'))
        ));

        if (useSyncedPolar) {
            // [ĐỒNG BỘ 1:1 VỚI TOP]: Vẽ đúng lát cắt Polar đang hiển thị trên TOP (cyan/xanh lá cho LEAF, đứt cho UNKNOWN, đỏ san hô cho NGOAI_DUONG)
            const prevAlphaSync = ctx.globalAlpha;
            const mainCol = (carGround && carGround.nhan === 'DA·DUYET') ? '#4ade80' : '#22d3ee';
            for (const seg of lc.doan) {
                if (seg.i1 <= seg.i0) continue;
                ctx.beginPath();
                let started = false;
                for (let i = seg.i0; i <= seg.i1; i++) {
                    const p = lc.pts[i];
                    if (!p || !Number.isFinite(p.w)) continue;
                    const px = view === 'side' ? toPx(p.u, 0, p.w) : toPx(0, p.u, p.w);
                    if (!px || !Number.isFinite(px.x) || !Number.isFinite(px.y)) continue;
                    if (!started) { ctx.moveTo(px.x, px.y); started = true; }
                    else ctx.lineTo(px.x, px.y);
                }
                if (!started) continue;
                if (seg.loai === 'NGOAI_DUONG') {
                    ctx.setLineDash([4, 3]);
                    ctx.globalAlpha = prevAlphaSync * 0.90;
                    ctx.lineWidth = 2.0;
                    ctx.strokeStyle = '#fb7185';
                } else if (seg.loai === 'UNKNOWN') {
                    ctx.setLineDash([5, 4]);
                    ctx.globalAlpha = prevAlphaSync * 0.60;
                    ctx.lineWidth = 1.7;
                    ctx.strokeStyle = mainCol;
                } else {
                    ctx.setLineDash([]);
                    ctx.globalAlpha = prevAlphaSync;
                    ctx.lineWidth = 2.2;
                    ctx.strokeStyle = mainCol;
                }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            ctx.globalAlpha = prevAlphaSync;

            // Vẽ thanh tham chiếu ngắn carGround (FIT→...) chỉ khi solver khác mặt Polar > 3cm
            if (carGround && Number.isFinite(carGround.zc) && Number.isFinite(lc.zCenter) && Math.abs(carGround.zc - lc.zCenter) > 0.03) {
                const halfFit = (view === 'side' ? carBoxObj.L : carBoxObj.W) * 0.5;
                const wFL = ThuatToanSurface._wCucBo(carGround, box, R, view === 'side' ? -halfFit : 0, view === 'side' ? 0 : -halfFit, 0);
                const wFR = ThuatToanSurface._wCucBo(carGround, box, R, view === 'side' ? halfFit : 0, view === 'side' ? 0 : halfFit, 0);
                const pFL = view === 'side' ? toPx(-halfFit, 0, wFL) : toPx(0, -halfFit, wFL);
                const pFR = view === 'side' ? toPx(halfFit, 0, wFR) : toPx(0, halfFit, wFR);
                if (pFL && pFR && Number.isFinite(pFL.x) && Number.isFinite(pFL.y) && Number.isFinite(pFR.x) && Number.isFinite(pFR.y)) {
                    ctx.save();
                    ctx.strokeStyle = pal.stroke;
                    ctx.fillStyle = pal.stroke;
                    ctx.lineWidth = 2.0;
                    ctx.setLineDash([4, 3]);
                    ctx.beginPath();
                    ctx.moveTo(pFL.x, pFL.y);
                    ctx.lineTo(pFR.x, pFR.y);
                    ctx.moveTo(pFL.x, pFL.y - 3);
                    ctx.lineTo(pFL.x, pFL.y + 3);
                    ctx.moveTo(pFR.x, pFR.y - 3);
                    ctx.lineTo(pFR.x, pFR.y + 3);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.font = 'bold 9px "Segoe UI", sans-serif';
                    const fitTag = `FIT→${carGround.nhan || 'PATCH'}`;
                    const yFit = Math.max(10, Math.min(ch - 28, Math.min(pFL.y, pFR.y) - 4));
                    ctx.fillText(fitTag, pFL.x + 2, yFit);
                    ctx.restore();
                }
            }
        } else {
            const flushBand = (aIdx, bIdx, smp) => {
                if (bIdx <= aIdx) return;
                ctx.beginPath();
                for (let i = aIdx; i <= bIdx; i++) {
                    const pt = samples[i].pHi;
                    if (i === aIdx) ctx.moveTo(pt.x, pt.y);
                    else ctx.lineTo(pt.x, pt.y);
                }
                for (let i = bIdx; i >= aIdx; i--) {
                    const ptLo = samples[i].pLo;
                    const ptHi = samples[i].pHi;
                    const yBot = Math.max(ptLo.y, ptHi.y + 5);
                    ctx.lineTo(ptLo.x, yBot);
                }
                ctx.closePath();
                ctx.fillStyle = smp.isLocal
                    ? pal.fill
                    : (smp.isSel
                        ? 'rgba(236, 72, 153, 0.36)'
                        : (smp.isSw ? 'rgba(217, 70, 239, 0.24)' : 'rgba(249, 168, 212, 0.22)'));
                ctx.fill();

                // Đường tâm d = 0 theo mức tin cậy: hard liền, soft đứt [6,4], ext chấm thưa [2,4] mờ 0.55
                ctx.beginPath();
                for (let i = aIdx; i <= bIdx; i++) {
                    const pm = samples[i].pMid;
                    if (i === aIdx) ctx.moveTo(pm.x, pm.y);
                    else ctx.lineTo(pm.x, pm.y);
                }
                const prevAlpha = ctx.globalAlpha;
                if (smp.cls === 'ext') {
                    ctx.setLineDash([2, 4]);
                    ctx.globalAlpha = prevAlpha * 0.55;
                } else if (smp.isLocal && (smp.cls === 'soft' || carSoft)) {
                    ctx.setLineDash([6, 4]);
                } else {
                    ctx.setLineDash([]);
                }
                ctx.lineWidth = smp.isLocal ? 2.2 : (smp.isSel ? 2.4 : 1.7);
                ctx.strokeStyle = smp.isLocal
                    ? pal.stroke
                    : (smp.isSel ? '#fde047' : (smp.isSw ? '#e879f9' : '#f9a8d4'));
                ctx.stroke();
                ctx.globalAlpha = prevAlpha;
            };

            for (let i = 1; i <= samples.length; i++) {
                const cur = samples[i];
                const prev = samples[segStart];
                const changed = !cur || cur.isSw !== prev.isSw || cur.isSel !== prev.isSel || cur.cls !== prev.cls;
                if (changed) {
                    flushBand(segStart, Math.min(samples.length - 1, i), prev);
                    segStart = i;
                }
            }
            ctx.setLineDash([]);
        }

        if (view === 'front' && hoSoCat && hoSoCat.clippedArr && hoSoCat.rawDiffArr && carGround && Number.isFinite(carGround.zc)) {
            ctx.fillStyle = 'rgba(251, 146, 60, 0.90)';
            for (let i = 0; i < hoSoCat.clippedArr.length; i++) {
                if (!hoSoCat.clippedArr[i]) continue;
                const sc = hoSoCat.sArr[i];
                const uM = 0;
                const vM = sc;
                const wRaw = ThuatToanSurface._wCucBo(carGround, box, R, uM, vM, hoSoCat.rawDiffArr[i]);
                if (!Number.isFinite(wRaw)) continue;
                const ptCurb = toPx(0, sc, wRaw);
                if (ptCurb && Number.isFinite(ptCurb.x) && Number.isFinite(ptCurb.y)) {
                    ctx.beginPath();
                    ctx.rect(ptCurb.x - 1.5, ptCurb.y - 1.5, 3, 3);
                    ctx.fill();
                }
            }
        }

        // Hiện khoảng hở đáy box so với mặt đường Surface (chuẩn ôm lốp: ~ -1.2cm)
        const midUnder = evalLocalW(view === 'side' ? boxS : 0, view === 'side' ? 0 : boxS);
        if (midUnder && Number.isFinite(midUnder.w)) {
            const deltaM = boxBottomW - midUnder.w;
            const cm = (deltaM * 100).toFixed(1);
            const sign = deltaM > 0 ? '+' : '';
            const slopeDeg = carGround ? (Math.atan(Math.hypot(carGround.gx, carGround.gy)) * 180 / Math.PI).toFixed(1) : null;
            const flags = Array.isArray(carGround?.flags) ? carGround.flags : [];
            const hasPriorNb = flags.includes('PRIOR_NB');
            const isApprovedDrift = Boolean(carGround && carGround.nhan === 'DA·DUYET' && Math.abs(deltaM) > 0.002);
            const needsWarnDash = isApprovedDrift || flags.some(f => f === 'VETO_CAP' || f === 'CO_LAP_OCC' || f === 'TRACK_NHAY' || f === 'NB_LECH');
            const isWarn = carGround && (carGround.nhan === 'EGO·WARN' || carGround.nhan === 'EGO·CLAMP');

            // Step 7: Phát hiện nhảy bất thường của cuboid raw (> 0.40m) giữa các frame kề (chỉ gắn cờ hiển thị BOX?)
            let hasBoxJump = false;
            if (carGround && carGround.nhan !== 'DA·DUYET' && activeTr && Array.isArray(activeTr.shapes)) {
                const jumpThr = ThuatToanSurface.CFG_SOFT?.boxJumpThr ?? 0.40;
                const p3Map = this._trackPhase3Cache?.get(String(activeTr.id ?? activeTr._trackNumber ?? activeTr._clientID ?? 'active'))?.resMap;
                for (const adjFn of [Number(fn) - 1, Number(fn) + 1]) {
                    const adjSh = activeTr.shapes.find(s => s && !s.outside && Number(s.frame) === adjFn && s.points?.length >= 9);
                    if (!adjSh) continue;
                    const adjC = ThuatToanSurface._canonicalizeBox({ shape: adjSh, track: activeTr });
                    const adjK = adjC ? ThuatToanSurface.boxKey(adjC) : null;
                    const adjRes = p3Map?.get(adjFn) || (adjK ? this.frameSolveCache.get(adjFn)?.solve?.results?.get(adjK) : null);
                    if (adjRes && Number.isFinite(adjRes.zc)) {
                        const adjDelta = (adjSh.points[2] - (adjSh.points[8] || 1.6) * 0.5) - adjRes.zc;
                        if (Math.abs(deltaM - adjDelta) > jumpThr) {
                            hasBoxJump = true;
                            break;
                        }
                    }
                }
            }

            // Step 8 (Ưu tiên 1): Ghost bar cảnh báo đáy hộp lệch (> 0.30m hoặc nhảy frame), giữ nguyên box gốc
            const zKyVong = midUnder.w;
            const boxLech = Boolean(Number.isFinite(deltaM) && Number.isFinite(boxBottomW) && (hasBoxJump || Math.abs(deltaM) > cfgCat.BOX_WARN));
            const ghostCol = Math.abs(deltaM) > cfgCat.BOX_SEVERE ? '#ff453a' : '#ff9f0a';
            this._lastCatBoxLech = boxLech ? { fn, view, boxLech: true, deltaM, zKyVong, zDay: boxBottomW } : null;
            if (boxLech) {
                const boxHalf = (view === 'side' ? carBoxObj.L : carBoxObj.W) * 0.5;
                const ptG = (sPos, wPos) => (view === 'side' ? toPx(sPos, 0, wPos) : toPx(0, sPos, wPos));
                const pBarL = ptG(boxS - boxHalf, zKyVong);
                const pBarR = ptG(boxS + boxHalf, zKyVong);
                const pMidG = ptG(boxS, zKyVong);
                const pDay = ptG(boxS, boxBottomW);
                const cwG = ctx.canvas?.width || 360;
                const dCmInt = Math.round(deltaM * 100);
                const dTxt = `Δ ${dCmInt > 0 ? '+' : ''}${dCmInt}cm`;

                ctx.save();
                ctx.globalAlpha = 0.95;
                ctx.strokeStyle = ghostCol;
                ctx.fillStyle = ghostCol;
                if (pMidG && Number.isFinite(pMidG.x) && Number.isFinite(pMidG.y)) {
                    if (pMidG.y < 3 || pMidG.y > ch - 3) {
                        const isTop = pMidG.y < 3;
                        const yTip = isTop ? 3 : ch - 3;
                        const yBase = isTop ? 9 : ch - 9;
                        ctx.beginPath();
                        ctx.moveTo(pMidG.x, yTip);
                        ctx.lineTo(pMidG.x - 4, yBase);
                        ctx.lineTo(pMidG.x + 4, yBase);
                        ctx.closePath();
                        ctx.fill();
                        ctx.font = 'bold 10px monospace';
                        const lw = ctx.measureText(dTxt).width;
                        const pxL = Math.max(4, Math.min(cwG - lw - 10, pMidG.x + 6));
                        const pyT = isTop ? 12 : ch - 12;
                        ctx.fillStyle = 'rgba(0,0,0,0.55)';
                        ctx.beginPath();
                        ctx.rect(pxL - 2, pyT - 9, lw + 4, 12);
                        ctx.fill();
                        ctx.fillStyle = ghostCol;
                        ctx.fillText(dTxt, pxL, pyT);
                    } else {
                        if (pBarL && pBarR && Number.isFinite(pBarL.x) && Number.isFinite(pBarL.y) && Number.isFinite(pBarR.x) && Number.isFinite(pBarR.y)) {
                            ctx.lineWidth = 1.5;
                            ctx.setLineDash([5, 3]);
                            ctx.beginPath();
                            ctx.moveTo(pBarL.x, pBarL.y);
                            ctx.lineTo(pBarR.x, pBarR.y);
                            ctx.moveTo(pBarL.x, pBarL.y - 3);
                            ctx.lineTo(pBarL.x, pBarL.y + 3);
                            ctx.moveTo(pBarR.x, pBarR.y - 3);
                            ctx.lineTo(pBarR.x, pBarR.y + 3);
                            ctx.stroke();
                            ctx.setLineDash([]);
                        }
                        if (pDay && Number.isFinite(pDay.x) && Number.isFinite(pDay.y)) {
                            ctx.lineWidth = 1.0;
                            ctx.beginPath();
                            ctx.moveTo(pDay.x, pDay.y);
                            ctx.lineTo(pMidG.x, pMidG.y);
                            ctx.stroke();
                            const dyArrow = pMidG.y - pDay.y;
                            const dirY = dyArrow >= 0 ? 1 : -1;
                            ctx.beginPath();
                            ctx.moveTo(pMidG.x, pMidG.y);
                            ctx.lineTo(pMidG.x - 3, pMidG.y - dirY * 5);
                            ctx.lineTo(pMidG.x + 3, pMidG.y - dirY * 5);
                            ctx.closePath();
                            ctx.fill();
                            ctx.font = 'bold 10px monospace';
                            const lw = ctx.measureText(dTxt).width;
                            const mx = 0.5 * (pDay.x + pMidG.x);
                            const my = Math.max(12, Math.min(ch - 28, 0.5 * (pDay.y + pMidG.y)));
                            let pxL = mx + 6;
                            if (pxL + lw + 4 > cwG - 4) pxL = mx - 6 - lw - 4;
                            pxL = Math.max(4, Math.min(cwG - lw - 8, pxL));
                            ctx.fillStyle = 'rgba(0,0,0,0.55)';
                            ctx.beginPath();
                            ctx.rect(pxL - 2, my - 9, lw + 4, 12);
                            ctx.fill();
                            ctx.fillStyle = ghostCol;
                            ctx.fillText(dTxt, pxL, my);
                        }
                    }
                }
                ctx.restore();
            }

            let lbl;
            if (carGround) {
                const nhan = carGround.nhan || 'PATCH';
                const warnPrefix = isWarn ? '⚠ ' : (needsWarnDash ? '? ' : '');
                const sigTxt = Number.isFinite(carGround.sigma) ? ` · σ:${(carGround.sigma * 100).toFixed(0)}cm` : '';
                const nbTxt = carGround.nbInfo
                    ? ` · ${carGround.nbInfo.mode === 'NEAR' ? 'N' : 'F'}${carGround.nbInfo.nAnch}(${carGround.nbInfo.dMin.toFixed(0)}m)`
                    : (Number.isFinite(carGround.anchorCount) && carGround.phase === 2 ? ` · A${carGround.anchorCount}` : '');
                const showFlags = flags.filter(f =>
                    f === 'OCC' || f === 'VETO' || f === 'VETO_CAP' || f === 'CO_LAP_OCC'
                    || f === 'SAN_XE' || f === 'TAM_LAI' || f === 'CAN_SAN' || f === 'ROOF_LECH' || f === 'ROOF_KEP'
                    || f === 'TRACK_NHAY' || f === 'NB_LECH' || f === 'NB_1_NEO' || f === 'NB_NGOAI_SUY' || f === 'NB_MAU_THUAN' || f === 'SOFT_SPLIT'
                );
                if (hasBoxJump && !showFlags.includes('BOX?')) showFlags.push('BOX?');
                const showTrim = showFlags.slice(0, 3);
                const flagStr = showTrim.length > 0 ? ` [${showTrim.join(',')}]` : '';
                const p1Txt = (carGround.p1Snapshot && carGround.p1Snapshot.nhan !== nhan) ? ` · P1:${carGround.p1Snapshot.nhan}` : '';
                lbl = `${warnPrefix}${nhan} · Δđáy:${sign}${cm}cm | Dốc:${slopeDeg}°${sigTxt}${nbTxt}${p1Txt}${flagStr}`;
            } else {
                lbl = `${borrowed ? `≈F${srcFrame} ` : ''}Δđáy:${sign}${cm}cm`;
            }
            ctx.font = 'bold 10px "Segoe UI", sans-serif';
            const dotOffset = hasPriorNb ? 8 : 0;
            const maxW = Math.max(80, (ctx.canvas?.width || 360) - 16);
            if (carGround && ctx.measureText(lbl).width + 12 + dotOffset > maxW) {
                const nhan = carGround.nhan || 'PATCH';
                const warnPrefix = isWarn ? '⚠ ' : (needsWarnDash ? '? ' : '');
                const sigTxt = Number.isFinite(carGround.sigma) ? ` σ${(carGround.sigma * 100).toFixed(0)}` : '';
                const showFlags = flags.filter(f => f === 'VETO_CAP' || f === 'CO_LAP_OCC' || f === 'TRACK_NHAY' || f === 'NB_LECH' || f === 'OCC').slice(0, 2);
                const flagStr = showFlags.length > 0 ? ` [${showFlags.join(',')}]` : '';
                lbl = `${warnPrefix}${nhan} · Δ:${sign}${cm}cm | ${slopeDeg}°${sigTxt}${flagStr}`;
            }
            const tw = ctx.measureText(lbl).width + 12 + dotOffset;
            const isGood = !isWarn && Math.abs(deltaM) <= 0.025; // Chuẩn khít phẳng mặt đường ~0cm
            ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
            ctx.strokeStyle = (boxLech && !isWarn) ? ghostCol : ((isWarn || needsWarnDash) ? 'rgba(251, 191, 36, 0.90)' : (carGround ? pal.stroke : (isGood ? 'rgba(74, 222, 128, 0.85)' : 'rgba(244, 114, 182, 0.75)')));
            ctx.lineWidth = needsWarnDash ? 1.5 : 1.2;
            ctx.setLineDash(needsWarnDash ? [4, 3] : []);
            ctx.beginPath();
            ctx.rect(8, ch - 23, tw, 17);
            ctx.fill();
            ctx.stroke();
            ctx.setLineDash([]);
            if (hasPriorNb) {
                ctx.beginPath();
                ctx.arc(14, ch - 14.5, 2.5, 0, Math.PI * 2);
                ctx.fillStyle = '#38bdf8';
                ctx.fill();
            }
            ctx.fillStyle = (isWarn || needsWarnDash) ? '#fde68a' : (isGood ? '#86efac' : (carGround ? '#e2e8f0' : '#fbcfe8'));
            ctx.fillText(lbl, 13 + dotOffset, ch - 11);

            if (useSyncedPolar && carGround && Number.isFinite(carGround.zc) && Number.isFinite(lc.zCenter) && Math.abs(carGround.zc - lc.zCenter) > 0.03) {
                const dPolCm = Math.round((carGround.zc - lc.zCenter) * 100);
                const pTxt = `Δ Polar:${dPolCm > 0 ? '+' : ''}${dPolCm}cm`;
                ctx.font = 'bold 9px "Segoe UI", sans-serif';
                ctx.fillStyle = '#67e8f9';
                ctx.fillText(pTxt, 12, ch - 27);
            }
        }
        ctx.restore();
    }

    capNhatThongKeLop(data) {
        const byLayer = new Map();
        for (const t of data.tiles) {
            if (!byLayer.has(t.layerId)) byLayer.set(t.layerId, []);
            byLayer.get(t.layerId).push(t);
        }
        for (const l of data.layers) {
            const arr = byLayer.get(l.id) || [];
            if (arr.length > 0) {
                l.avgZ = arr.reduce((s, t) => s + t.zc, 0) / arr.length;
                l.avgGx = arr.reduce((s, t) => s + t.gx, 0) / arr.length;
                l.avgGy = arr.reduce((s, t) => s + t.gy, 0) / arr.length;
            }
        }
    }

    // =========================================================================
    // 8. ÁP DỤNG SURFACE XUỐNG CÁC BOX (HẠ KHÍT ĐÁY 1.2CM ÔM LỐP)
    // =========================================================================

    async apDungSurfaceXuongBoxes(mode = 'active_track', opts = {}) {
        if (this._isApplying) return;
        this._isApplying = true;
        try {
            const trActive = this.callbacks.getActiveTrack ? this.callbacks.getActiveTrack() : null;
            if (mode === 'active_track' && (!trActive || !Array.isArray(trActive.shapes))) {
                this.hienToast('⚠️ Không tìm thấy Track đang mở!');
                return;
            }
            const khoApply = ThuatToanSurface._getKhoDuyet();
            const unlockedKeys = (opts && opts.trackKeysMoKhoa)
                ? opts.trackKeysMoKhoa
                : (typeof this.callbacks.getUnlockedTrackKeys === 'function' ? this.callbacks.getUnlockedTrackKeys() : null);

            const unlockEff = new Set(unlockedKeys || []);
            const optsWithUnlock = { ...opts, trackKeysMoKhoa: unlockEff };

            const isModalOpen = !!(this.callbacks.isModalOpen && this.callbacks.isModalOpen());
            const rawTarget = (typeof this.callbacks.getTargetFrames === 'function')
                ? this.callbacks.getTargetFrames()
                : null;

            let framesToApply = [];
            if (rawTarget instanceof Set && rawTarget.size > 0) {
                framesToApply = [...rawTarget].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
            } else if (isModalOpen && typeof this.callbacks.getAllModalFrames === 'function') {
                framesToApply = (this.callbacks.getAllModalFrames() || []).map(Number).filter(Number.isFinite);
            } else if (isModalOpen && trActive && Array.isArray(trActive.shapes)) {
                framesToApply = [...new Set(
                    trActive.shapes
                        .filter(s => s && !s.outside && s.points?.length >= 9)
                        .map(s => Number(s.frame))
                        .filter(Number.isFinite)
                )].sort((a, b) => a - b);
            }
            if (framesToApply.length === 0) {
                framesToApply = [this.currentFrame];
            }

            // 'all_ids' luôn hạ tất cả ID trên các frame mục tiêu; chỉ 'region' (tường minh) mới lọc theo vùng ô đang chọn
            let hasSel = false;
            let selRects = [];
            if (mode === 'region' && this.selectedTileIds.size > 0) {
                hasSel = true;
                const focusData = this.laySurfaceHienTai() || this.tinhSurfaceChoFrame(this.currentFrame, false);
                if (focusData && Array.isArray(focusData.tiles)) {
                    selRects = focusData.tiles
                        .filter(t => this.selectedTileIds.has(t.id))
                        .map(t => ({ x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1 }));
                }
                if (selRects.length === 0) {
                    this.hienToast('⚠️ Không xác định được vùng Surface đã chọn!');
                    return;
                }
            }

            // Nạp LiDAR cho các frame chưa có điểm trong cache trước khi hạ
            const needLoad = framesToApply.some(fn => {
                const pts = this.callbacks.getFramePts ? this.callbacks.getFramePts(fn) : null;
                return !(pts && pts.length >= 20) && fn !== this.liveFrame;
            });
            if (needLoad && typeof this.callbacks.napLiDAR === 'function') {
                await this.callbacks.napLiDAR(new Set(framesToApply));
            }

            const matches = [];
            const affectedFrames = new Set();

            for (let idx = 0; idx < framesToApply.length; idx++) {
                const fn = framesToApply[idx];
                const framePts = this.callbacks.getFramePts ? this.callbacks.getFramePts(fn) : null;
                let frameData = this.tinhSurfaceChoFrame(fn, false);
                if (!frameData) {
                    frameData = this.laySurfaceChoVe(fn)?.data || null;
                }
                const hasPts = Boolean(framePts && framePts.length >= 10);
                if (!frameData && !hasPts) continue;

                const frameBoxes = this.layDanhSachBoxTrongFrame(fn);
                const frameSolve = (hasPts && ThuatToanSurface.PHASE2.enabled)
                    ? this.layFrameSolve(fn, frameBoxes, framePts, optsWithUnlock)
                    : null;

                if (mode === 'active_track') {
                    const sh = trActive.shapes.find(s => Number(s.frame) === fn && !s.outside && s.points?.length >= 9);
                    if (!sh) continue;
                    const H = sh.points[8] || 1.6;
                    const cz = sh.points[2];
                    const info = ThuatToanSurface.layMatDuongChoBox(
                        frameData, sh.points[0], sh.points[1], sh.points[5] || 0,
                        sh.points[6] || 4.4, sh.points[7] || 1.9, framePts, H, cz,
                        frameBoxes, frameSolve, { ...optsWithUnlock, carTrack: trActive, frame: fn }
                    );
                    if (info) {
                        matches.push({ frame: fn, track: trActive, shape: sh, info, materialize: false });
                        affectedFrames.add(fn);
                    }
                } else {
                    for (const b of frameBoxes) {
                        if (hasSel) {
                            const inRect = selRects.some(
                                r => b.cx >= r.x0 - 1e-6 && b.cx <= r.x1 + 1e-6 && b.cy >= r.y0 - 1e-6 && b.cy <= r.y1 + 1e-6
                            );
                            if (!inRect) continue;
                        }
                        const H = b.shape.points[8] || 1.6;
                        const cz = b.shape.points[2];
                        const info = ThuatToanSurface.layMatDuongChoBox(
                            frameData, b.cx, b.cy, b.shape.points[5] || 0,
                            b.shape.points[6] || 4.4, b.shape.points[7] || 1.9, framePts, H, cz,
                            frameBoxes, frameSolve, { ...optsWithUnlock, carTrack: b.track, frame: fn }
                        );
                        if (!info) continue;
                        const needMat = Boolean(b.track && Array.isArray(b.track.shapes) && !b.track.shapes.includes(b.shape));
                        matches.push({ frame: fn, track: b.track, shape: b.shape, info, materialize: needMat });
                        affectedFrames.add(fn);
                    }
                }

                if ((idx & 7) === 7 && typeof setTimeout === 'function') {
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (matches.length === 0) {
                const msg = mode === 'active_track'
                    ? (framesToApply.length > 1 ? '⚠️ Không tìm thấy box hợp lệ trên các Frame đã chọn!' : `⚠️ Track đang chọn không có box tại Frame ${framesToApply[0]}!`)
                    : (mode === 'all_ids'
                        ? '⚠️ Không tìm thấy box của ID nào hợp lệ trên các Frame mục tiêu!'
                        : '⚠️ Không có box nào nằm trong vùng Surface đã chọn!');
                this.hienToast(msg);
                return;
            }

            // Step 10: Track Guard (mặc định chỉ gắn cờ TRACK_NHAY, giữ nguyên zRoad trừ khi bật PHASE2.trackReplace)
            let trackJumpCount = 0;
            if (ThuatToanSurface.PHASE2.enabled) {
                const byTrack = new Map();
                for (const m of matches) {
                    const tKey = m.track || '__single__';
                    if (!byTrack.has(tKey)) byTrack.set(tKey, []);
                    byTrack.get(tKey).push(m);
                }
                for (const arr of byTrack.values()) {
                    if (arr.length < 4) continue;
                    const perFrame = arr.map(m => ({
                        fn: m.frame,
                        zc: m.info.zRoad,
                        zEgo: m.info.zEgo,
                        zFarPred: m.info.zFarPred,
                        nhan: m.info.nhan
                    }));
                    const jumpMap = ThuatToanSurface.trackGuard(perFrame);
                    if (jumpMap.size > 0) {
                        for (const m of arr) {
                            const jInfo = jumpMap.get(Number(m.frame));
                            if (!jInfo) continue;
                            trackJumpCount++;
                            if (!Array.isArray(m.info.flags)) m.info.flags = [];
                            if (!m.info.flags.includes('TRACK_NHAY')) m.info.flags.push('TRACK_NHAY');
                            m.info.trackJump = jInfo;
                            const canon = ThuatToanSurface._canonicalizeBox(m.shape);
                            const bk = ThuatToanSurface.boxKey(canon);
                            this._trackGuardByBoxKey.set(`${Number(m.frame)}|${bk}`, jInfo);
                            if (ThuatToanSurface.PHASE2.trackReplace && Number.isFinite(jInfo.zSuggest)) {
                                m.info.zRoad = jInfo.zSuggest;
                            }
                        }
                    }

                    // Đợt 3: Anchor-to-Fade + Auto-Calibrate Nóc Track + Roof-Down Fallback
                    if (ThuatToanSurface.CO.ngucTrack) {
                        const trackItems = [];
                        for (const m of arr) {
                            const fNum = Number(m.frame);
                            const pts = this.callbacks.getFramePts ? this.callbacks.getFramePts(fNum) : null;
                            const fBoxes = this.callbacks.getFrameBoxes ? this.callbacks.getFrameBoxes(fNum) : [];
                            const sh = m.shape;
                            if (!pts || !sh || !sh.points || sh.points.length < 9) continue;
                            const bObj = {
                                cx: sh.points[0], cy: sh.points[1], cz: sh.points[2],
                                rz: sh.points[5] || 0, L: sh.points[6] || 4.5, W: sh.points[7] || 1.9, H: sh.points[8] || 1.6
                            };
                            const otherMask = ThuatToanSurface.buildOtherBoxMask(fBoxes, bObj);
                            trackItems.push({
                                fn: fNum,
                                carBox: bObj,
                                rawPts: pts,
                                otherMask,
                                p2: m.info,
                                guard: jumpMap.get(fNum) || m.info?.trackJump || null,
                                zEgo: m.info?.zEgo
                            });
                        }
                        if (trackItems.length >= 2) {
                            const p3Out = ThuatToanSurface.giaiTrackPhase3(trackItems, { guardMap: jumpMap });
                            if (tr === trActive && p3Out.meta) {
                                const tKey = String(tr.id ?? tr._trackNumber ?? tr._clientID ?? 'active');
                                this._lastTrackPhase3Meta = { trackKey: tKey, ...p3Out.meta };
                            }
                            for (const m of arr) {
                                const r3 = p3Out.resMap.get(Number(m.frame));
                                if (r3 && (r3.nhan === 'TRACK·ROOF' || r3.nhan === 'TRACK·PROP') && Number.isFinite(r3.zc)) {
                                    m.info.zRoad = r3.zc;
                                    m.info.zc = r3.zc;
                                    m.info.nhan = r3.nhan;
                                    m.info.flags = r3.flags;
                                    m.info.phase3 = r3.phase3;
                                    m.info.phase3Fixed = true;
                                }
                            }
                        }
                    }
                }
            }

            const touchedTracks = [...new Set(matches.map(m => m.track).filter(Boolean))];
            if (this.callbacks.saveUndo) this.callbacks.saveUndo(touchedTracks);

            let updatedCount = 0;
            let skippedApprovedCount = 0;
            for (const m of matches) {
                const mKey = khoApply ? khoApply.trackKey(m.track) : null;
                const isUnlockedM = Boolean(mKey && unlockEff.has(mKey));
                if (!isUnlockedM && ThuatToanSurface._laBoxDaDuyet({ ...m.shape, track: m.track }, m.frame, optsWithUnlock)) {
                    skippedApprovedCount++;
                    continue;
                }
                let targetShape = m.shape;
                if (m.materialize && m.track && Array.isArray(m.track.shapes)) {
                    targetShape = {
                        type: m.shape.type || 'cuboid',
                        frame: m.frame,
                        occluded: !!m.shape.occluded,
                        outside: false,
                        z_order: m.shape.z_order || 0,
                        rotation: Array.isArray(m.shape.rotation) ? [...m.shape.rotation] : [0, 0, m.shape.points[5] || 0],
                        points: [...m.shape.points],
                        attributes: m.shape.attributes ? JSON.parse(JSON.stringify(m.shape.attributes)) : []
                    };
                    m.track.shapes.push(targetShape);
                    m.track.shapes.sort((a, b) => Number(a.frame) - Number(b.frame));
                }

                const H = targetShape.points[8];
                targetShape.points[2] = parseFloat((m.info.zRoad - 0.012 + H / 2.0).toFixed(3));
                targetShape.points[3] = parseFloat(m.info.rx.toFixed(3));
                targetShape.points[4] = parseFloat(m.info.ry.toFixed(3));
                if (Array.isArray(targetShape.rotation)) {
                    targetShape.rotation[0] = targetShape.points[3];
                    targetShape.rotation[1] = targetShape.points[4];
                }
                if (m.track) {
                    m.track._isDirty = true;
                    delete m.track._origShapesBackup;
                }
                updatedCount++;
            }

            const updatedFramesArr = [...affectedFrames];
            if (this.callbacks.onShapesUpdated) {
                this.callbacks.onShapesUpdated(updatedFramesArr.length === 1 ? updatedFramesArr[0] : updatedFramesArr);
            }
            if (typeof window !== 'undefined') {
                window.quanLyAPICVAT?.refreshView?.(trActive || undefined);
                setTimeout(() => {
                    if (this.isActive && (this._overlayObjects.length === 0 || this._overlayObjects.some(item => !item.obj || !item.scene || item.obj.parent !== item.scene))) {
                        this.veSurfaceLen3D();
                    }
                }, 140);
            }
            const fTxt = affectedFrames.size > 1
                ? `${affectedFrames.size} frames`
                : `Frame ${updatedFramesArr[0]}`;
            const p3Count = matches.filter(m => m.info && m.info.phase3Fixed).length;
            const p3Txt = p3Count > 0 ? ` · ◎ Track Nóc/Lan truyền: ${p3Count}f` : '';
            const tgTxt = trackJumpCount > 0 ? ` (⚠️ ${trackJumpCount} frame nghi nhảy TRACK_NHAY)` : '';
            const appTxt = skippedApprovedCount > 0 ? ` · 🔒 Giữ nguyên ${skippedApprovedCount}f đã duyệt` : '';
            if (updatedCount === 0 && skippedApprovedCount > 0) {
                this.hienToast(`⚠️ Đã bỏ qua ${skippedApprovedCount} box đã duyệt (khóa bảo vệ). Để hạ, hãy mở ID đó trong Modal hoặc dùng "Hạ ID Đang Chọn"!`);
            } else {
                this.hienToast(`🌸 Đã hạ khít ${updatedCount} box (${fTxt}) theo mặt đường Surface!${p3Txt}${tgTxt}${appTxt}`);
            }
        } finally {
            this._isApplying = false;
        }
    }

    // =========================================================================
    // 9. GIAO DIỆN NỔI SURFACE PANEL + TOOLTIP 3D (GLASSMORPHISM DARK MODE)
    // =========================================================================

    damBaoStyleTonTai() {
        if (typeof document === 'undefined') return;
        const oldStyle = document.getElementById('cvat-surface-style');
        if (oldStyle && oldStyle.dataset.ver === ThuatToanSurface.SURF_UI_VER) return;
        if (oldStyle) oldStyle.remove();
        const style = document.createElement('style');
        style.id = 'cvat-surface-style';
        style.dataset.ver = ThuatToanSurface.SURF_UI_VER;
        style.textContent = `
            .modal-actions-menu-row .btn-m-surface {
                background: linear-gradient(135deg, rgba(244, 114, 182, 0.22), rgba(219, 39, 119, 0.34)) !important;
                border: 1px solid rgba(249, 168, 212, 0.65) !important;
                color: #fbcfe8 !important;
                font-weight: 700 !important;
            }
            .modal-actions-menu-row .btn-m-surface:hover {
                background: linear-gradient(135deg, rgba(244, 114, 182, 0.4), rgba(219, 39, 119, 0.55)) !important;
                border-color: #f9a8d4 !important;
                color: #ffffff !important;
            }
            .modal-actions-menu-row .btn-m-surface.is-active {
                background: linear-gradient(135deg, #ec4899, #be185d) !important;
                border: 1px solid #f9a8d4 !important;
                color: #ffffff !important;
                box-shadow: 0 0 12px rgba(236, 72, 153, 0.7) !important;
            }
            body.surf-pick-top canvas.canvas-top {
                cursor: cell !important;
                outline: 1.5px dashed rgba(244, 114, 182, 0.8) !important;
                outline-offset: -2px;
            }
            #cvat-surface-panel {
                position: fixed;
                top: 84px;
                right: 16px;
                width: 348px;
                max-height: calc(100vh - 110px);
                background: rgba(15, 23, 42, 0.94);
                backdrop-filter: blur(12px);
                border: 1.5px solid rgba(244, 114, 182, 0.65);
                border-radius: 10px;
                color: #f8fafc;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                font-size: 11px;
                z-index: 100000010;
                box-shadow: 0 12px 34px rgba(0, 0, 0, 0.7), 0 0 18px rgba(236, 72, 153, 0.25);
                display: none;
                flex-direction: column;
                overflow: hidden;
                user-select: none;
            }
            #cvat-surface-panel.is-collapsed {
                width: 326px;
                min-width: 300px;
                max-width: 348px;
                height: auto !important;
            }
            #cvat-surface-panel.is-collapsed .surf-body {
                display: none !important;
            }
            .surf-quickbar {
                display: flex; flex-direction: column; gap: 4px;
                padding: 6px 10px;
                border-bottom: 1px solid rgba(244, 114, 182, 0.28);
                background: rgba(15, 23, 42, 0.72);
            }
            #cvat-surface-panel.is-collapsed .surf-quickbar {
                border-bottom: none;
            }
            #surf-grid-status {
                font-size: 9.5px; color: #94a3b8;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
            }
            .surf-header {
                display: flex; align-items: center; justify-content: space-between;
                padding: 8px 10px;
                background: linear-gradient(90deg, rgba(236, 72, 153, 0.28), rgba(30, 41, 59, 0.92));
                border-bottom: 1px solid rgba(244, 114, 182, 0.35);
                cursor: move;
                gap: 6px;
            }
            .surf-title { font-weight: 800; font-size: 12px; color: #f9a8d4; letter-spacing: 0.3px; }
            .surf-body { padding: 9px 11px; overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
            .surf-sec {
                background: rgba(30, 41, 59, 0.68);
                border: 1px solid rgba(148, 163, 184, 0.22);
                border-radius: 7px; padding: 7px 8px;
                display: flex; flex-direction: column; gap: 6px;
            }
            .surf-sec-title { font-size: 10px; font-weight: 800; color: #f472b6; text-transform: uppercase; letter-spacing: 0.4px; }
            .surf-row { display: flex; align-items: center; justify-content: space-between; gap: 5px; flex-wrap: wrap; }
            .surf-btn {
                background: #1e293b; border: 1px solid #475569; color: #e2e8f0;
                border-radius: 5px; padding: 4px 7px; font-size: 10.5px; font-weight: 700; cursor: pointer;
                transition: all 0.12s; pointer-events: auto;
            }
            .surf-btn:hover { background: #334155; border-color: #f472b6; color: #fff; }
            .surf-btn.is-active { background: #db2777; border-color: #f9a8d4; color: #fff; }
            .surf-apply-grid {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 6px;
                align-items: stretch;
            }
            .surf-btn-apply {
                height: 36px;
                width: 100%;
                padding: 4px 6px;
                font-size: 11px;
                font-weight: 700;
                line-height: 1.15;
                border-radius: 6px;
                border: 1px solid #f472b6;
                cursor: pointer;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                text-align: center;
                box-sizing: border-box;
                transition: all 0.12s;
            }
            .surf-btn-apply-primary {
                background: linear-gradient(135deg, #db2777, #be185d);
                color: #fff;
                font-weight: 800;
            }
            .surf-btn-apply-primary:hover { filter: brightness(1.12); }
            .surf-btn-apply-secondary {
                background: #1e293b;
                color: #fbcfe8;
            }
            .surf-btn-apply-secondary:hover { background: #334155; color: #fff; }
            .surf-btn-collapse {
                min-width: 24px;
                padding: 4px 8px;
                border-color: rgba(244, 114, 182, 0.55);
                color: #fbcfe8;
            }
            .surf-layers-list {
                max-height: 165px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px;
            }
            .surf-sec.is-layers-collapsed .surf-layers-list { display: none; }
            .surf-layers-toggle {
                display: inline-flex; align-items: center; gap: 5px; cursor: pointer; user-select: none;
            }
            .surf-btn-arrow {
                padding: 1px 6px; font-size: 11px; line-height: 1.2; min-width: 20px;
                border-color: rgba(244, 114, 182, 0.45); color: #fbcfe8;
            }
            .surf-layer-item {
                display: flex; align-items: center; justify-content: space-between;
                padding: 5px 7px; border-radius: 5px; cursor: pointer;
                background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(71, 85, 105, 0.6);
                transition: all 0.12s;
            }
            .surf-layer-item:hover { border-color: #f472b6; background: rgba(244, 114, 182, 0.14); }
            .surf-layer-item.is-selected { border-color: #ec4899; background: rgba(236, 72, 153, 0.25); box-shadow: 0 0 8px rgba(236, 72, 153, 0.3); }
            .surf-inp-num {
                width: 48px; background: #0f172a; border: 1px solid #475569; color: #fbcfe8;
                border-radius: 4px; padding: 2px 4px; text-align: center; font-weight: 700; font-size: 11px;
            }
            .surf-seg {
                display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px;
                background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(71, 85, 105, 0.7);
                border-radius: 6px; padding: 2px;
            }
            .surf-seg .surf-btn {
                border: none; background: transparent; padding: 4px 5px; font-size: 10px;
                white-space: nowrap; text-align: center;
            }
            .surf-seg .surf-btn.is-active {
                background: #0891b2; color: #ecfeff; box-shadow: 0 0 6px rgba(34, 211, 238, 0.35);
            }
            .surf-chk {
                display: inline-flex; align-items: center; gap: 4px; font-size: 10px; color: #cbd5e1;
                cursor: pointer; user-select: none;
            }
            #cvat-surface-tooltip {
                position: fixed; pointer-events: none; z-index: 100000020;
                background: rgba(15, 23, 42, 0.94); border: 1px solid #f472b6; color: #fbcfe8;
                padding: 5px 8px; border-radius: 6px; font-size: 11px; font-weight: 600;
                box-shadow: 0 4px 12px rgba(0,0,0,0.6); display: none; white-space: nowrap;
            }
        `;
        document.head.appendChild(style);
    }

    damBaoBangSurfaceTonTai() {
        this.damBaoStyleTonTai();
        if (typeof document === 'undefined') return null;
        if (!this._tooltipEl || !this._tooltipEl.isConnected) {
            document.getElementById('cvat-surface-tooltip')?.remove();
            this._tooltipEl = document.createElement('div');
            this._tooltipEl.id = 'cvat-surface-tooltip';
            document.body.appendChild(this._tooltipEl);
        }
        if (this._panelEl && this._panelEl.isConnected && this._panelEl.dataset.ver === ThuatToanSurface.SURF_UI_VER) {
            return this._panelEl;
        }
        if (this._panelEl) {
            try { this._panelEl.remove(); } catch (_) {}
            this._panelEl = null;
        }
        document.getElementById('cvat-surface-panel')?.remove();

        const panel = document.createElement('div');
        panel.id = 'cvat-surface-panel';
        panel.dataset.ver = ThuatToanSurface.SURF_UI_VER;
        panel.innerHTML = `
            <div class="surf-header" id="surf-drag-header">
                <div style="min-width:0;flex:1;">
                    <div class="surf-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">SURFACE • MẶT ĐƯỜNG</div>
                    <div id="surf-subtitle" style="font-size:10px;color:#cbd5e1;margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Frame 0 • Hồng nhạt = Đường | Tím = Vỉa hè</div>
                </div>
                <div style="display:flex;gap:3px;flex-shrink:0;">
                    <button class="surf-btn" id="surf-btn-toggle-3d" title="Thu nhỏ / Hiện Modal để soi trên CVAT 3D">👁️ 3D</button>
                    <button class="surf-btn" id="surf-btn-undo" title="Hoàn tác chỉnh sửa Surface">↩</button>
                    <button class="surf-btn" id="surf-btn-recalc" title="Tính lại sạch toàn bộ Surface Frame này từ LiDAR gốc (xóa mọi chỉnh tay)">🔄</button>
                    <button class="surf-btn surf-btn-collapse" id="surf-btn-collapse" title="Thu gọn / Mở rộng bảng Surface">Thu gọn</button>
                    <button class="surf-btn" id="surf-btn-close" title="Tắt hiển thị Surface">✕</button>
                </div>
            </div>
            <div class="surf-quickbar" id="surf-quickbar">
                <div class="surf-seg">
                    <button class="surf-btn is-active" id="surf-grid-dongtam" type="button" title="Hiển thị mặt đường theo cung tròn đồng tâm (r, theta)">◎ Đồng Tâm</button>
                    <button class="surf-btn" id="surf-grid-v4" type="button" title="Hiển thị lưới ô vuông Cartesian v4">▦ v4</button>
                    <button class="surf-btn" id="surf-grid-ca_hai" type="button" title="Hiển thị Đồng Tâm + wireframe ô vuông v4 để đối chiếu">◈ Cả hai</button>
                </div>
                <div id="surf-grid-status" title="Surface UI build dt-2">⏳ Đang chờ điểm LiDAR...</div>
            </div>
            <div class="surf-body">
                <div class="surf-sec" id="surf-grid-sec">
                    <div class="surf-row">
                        <span class="surf-sec-title">0. Tùy chọn Lưới Đồng Tâm</span>
                        <span id="surf-polar-badge" style="font-size:9.5px;color:#22d3ee;font-weight:700;"></span>
                    </div>
                    <div id="surf-polar-options" style="display:flex;flex-direction:column;gap:4px;">
                        <div class="surf-row" style="justify-content:flex-start;gap:10px;">
                            <label class="surf-chk"><input type="checkbox" id="surf-polar-chk-unknown" /> Hiện UNKNOWN</label>
                            <label class="surf-chk"><input type="checkbox" id="surf-polar-chk-jump" /> Hiện cạnh nhảy</label>
                        </div>
                        <div id="surf-polar-stats" style="font-size:10px;color:#94a3b8;">Đang chờ dựng lưới đồng tâm...</div>
                        <div id="surf-track-cal-status" style="font-size:10px;color:#5eead4;display:none;"></div>
                    </div>
                </div>

                <div class="surf-sec">
                    <div class="surf-row">
                        <span class="surf-sec-title">1. Chọn lớp / ô</span>
                        <div style="display:flex;gap:4px;">
                            <button class="surf-btn is-active" id="surf-mode-layer" title="Click vào 1 mảng hồng sẽ chọn cả Lớp đồng phẳng">Chọn Lớp</button>
                            <button class="surf-btn" id="surf-mode-tile" title="Click chọn từng ô chữ nhật riêng lẻ">Chọn Ô Lẻ</button>
                        </div>
                    </div>
                    <div class="surf-row" style="gap:4px;">
                        <button class="surf-btn" id="surf-btn-pick-top" style="flex:1;white-space:nowrap;" title="Bật để click trực tiếp lên ô hồng mà không cần giữ Alt (hoặc giữ Alt + Click bất kỳ lúc nào: chưa chọn = chọn, ấn lại = bỏ chọn)">🖱️ Click Chọn (Alt + Click)</button>
                        <button class="surf-btn" id="surf-btn-clear-sel" style="white-space:nowrap;" title="Bỏ chọn toàn bộ các ô / lớp đang chọn">Bỏ Chọn Tất Cả</button>
                    </div>
                    <div class="surf-row" style="font-size:10px;color:#94a3b8;">
                        <span>Khoảng cách (m):</span>
                        <input type="number" class="surf-inp-num" id="surf-r-min" value="0" min="0" max="80" step="2" />
                        <span>→</span>
                        <input type="number" class="surf-inp-num" id="surf-r-max" value="40" min="0" max="100" step="2" />
                        <button class="surf-btn" id="surf-btn-sel-range">Chọn Vùng</button>
                    </div>
                </div>

                <div class="surf-sec" id="surf-layers-sec">
                    <div class="surf-row">
                        <div class="surf-layers-toggle" id="surf-layers-toggle-wrap" title="Ẩn / Hiện danh sách các lớp">
                            <button class="surf-btn surf-btn-arrow" id="surf-btn-toggle-layers" type="button" title="Ẩn / Hiện danh sách các lớp">▾</button>
                            <span class="surf-sec-title">2. Danh sách các Lớp (<span id="surf-layer-count">0</span>)</span>
                        </div>
                        <span id="surf-sel-info" style="font-size:10px;color:#f9a8d4;font-weight:700;">Chưa chọn</span>
                    </div>
                    <div class="surf-layers-list" id="surf-layers-list"></div>
                </div>

                <div class="surf-sec">
                    <span class="surf-sec-title">3. Tùy chỉnh lớp / khoảng đang chọn</span>
                    <div class="surf-row">
                        <span>Độ cao Z:</span>
                        <div style="display:flex;gap:3px;">
                            <button class="surf-btn" id="surf-z-m5">-5cm</button>
                            <button class="surf-btn" id="surf-z-m1">-1cm</button>
                            <button class="surf-btn" id="surf-z-p1">+1cm</button>
                            <button class="surf-btn" id="surf-z-p5">+5cm</button>
                        </div>
                    </div>
                    <div class="surf-row">
                        <span>Dốc dọc (Pitch):</span>
                        <div style="display:flex;gap:3px;">
                            <button class="surf-btn" id="surf-pitch-m">-0.4°</button>
                            <button class="surf-btn" id="surf-pitch-p">+0.4°</button>
                        </div>
                    </div>
                    <div class="surf-row">
                        <span>Nghiêng (Roll):</span>
                        <div style="display:flex;gap:3px;">
                            <button class="surf-btn" id="surf-roll-m">-0.4°</button>
                            <button class="surf-btn" id="surf-roll-p">+0.4°</button>
                        </div>
                    </div>
                    <div class="surf-row" style="gap:4px;">
                        <button class="surf-btn" id="surf-set-road" style="flex:1;">Đặt Mặt Đường</button>
                        <button class="surf-btn" id="surf-set-sidewalk" style="flex:1;">Đặt Vỉa Hè</button>
                    </div>
                    <div class="surf-row" style="gap:4px;">
                        <button class="surf-btn" id="surf-reset-sel" style="flex:1;" title="Đặt lại vùng / lớp đang chọn về đúng mặt đường tính toán LiDAR gốc (xóa chỉnh tay)">↺ Đặt Lại LiDAR</button>
                        <button class="surf-btn" id="surf-refit-sel" style="flex:1;" title="Nội suy mượt vùng đang chọn từ các ô mặt đường lân cận (dùng khi vùng đó thiếu điểm LiDAR)">~ Nội Suy Lân Cận</button>
                    </div>
                </div>

                <div class="surf-sec">
                    <span class="surf-sec-title">4. Áp dụng xuống Box 3D</span>
                    <div class="surf-apply-grid">
                        <button class="surf-btn-apply surf-btn-apply-primary" id="surf-apply-active" title="Hạ khít toàn bộ frame của ID (Track) đang mở ở bên trái theo Surface">Hạ ID Đang Chọn</button>
                        <button class="surf-btn-apply surf-btn-apply-secondary" id="surf-apply-region" title="Hạ khít toàn bộ mọi ID (xe, xe máy, người...) trên các frame mục tiêu theo Surface">Hạ Tất Cả ID</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(panel);
        this._panelEl = panel;
        this.ganSuKienBangSurface(panel);
        this.datThuGonPanel(this.panelCollapsed);
        this.datAnHienDanhSachLop(this.layersListCollapsed);
        return panel;
    }

    datThuGonPanel(collapsed) {
        this.panelCollapsed = Boolean(collapsed);
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('cvat_surface_panel_collapsed', this.panelCollapsed ? '1' : '0');
            }
        } catch (_) {}
        if (!this._panelEl) return;
        this._panelEl.classList.toggle('is-collapsed', this.panelCollapsed);
        const cBtn = this._panelEl.querySelector('#surf-btn-collapse');
        if (cBtn) {
            cBtn.textContent = this.panelCollapsed ? 'Mở' : 'Thu gọn';
            cBtn.title = this.panelCollapsed ? 'Mở rộng bảng Surface' : 'Thu gọn bảng Surface';
        }
    }

    datAnHienDanhSachLop(collapsed) {
        this.layersListCollapsed = Boolean(collapsed);
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem('cvat_surface_layers_collapsed', this.layersListCollapsed ? '1' : '0');
            }
        } catch (_) {}
        if (!this._panelEl) return;
        const sec = this._panelEl.querySelector('#surf-layers-sec');
        if (sec) sec.classList.toggle('is-layers-collapsed', this.layersListCollapsed);
        const aBtn = this._panelEl.querySelector('#surf-btn-toggle-layers');
        if (aBtn) {
            aBtn.textContent = this.layersListCollapsed ? '▸' : '▾';
            aBtn.title = this.layersListCollapsed ? 'Hiện danh sách các lớp' : 'Ẩn danh sách các lớp';
        }
    }

    ganSuKienBangSurface(panel) {
        const hdr = panel.querySelector('#surf-drag-header');
        let dragSt = null;
        hdr?.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button, input, select')) return;
            const r = panel.getBoundingClientRect();
            dragSt = { dx: e.clientX - r.left, dy: e.clientY - r.top };
        });
        hdr?.querySelectorAll('button').forEach((btn) => {
            btn.addEventListener('pointerdown', (e) => e.stopPropagation());
            btn.addEventListener('mousedown', (e) => e.stopPropagation());
        });
        panel.querySelectorAll('#surf-quickbar button').forEach((btn) => {
            btn.addEventListener('pointerdown', (e) => e.stopPropagation());
            btn.addEventListener('mousedown', (e) => e.stopPropagation());
        });
        hdr?.addEventListener('dblclick', (e) => {
            if (e.target.closest('button, input, select')) return;
            this.datThuGonPanel(!this.panelCollapsed);
        });
        window.addEventListener('pointermove', (e) => {
            if (!dragSt) return;
            panel.style.left = `${Math.max(0, Math.min(window.innerWidth - 100, e.clientX - dragSt.dx))}px`;
            panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 60, e.clientY - dragSt.dy))}px`;
            panel.style.right = 'auto';
        });
        window.addEventListener('pointerup', () => { dragSt = null; });

        panel.querySelector('#surf-btn-close')?.addEventListener('click', (e) => {
            e.stopPropagation();
            this.tat();
        });
        panel.querySelector('#surf-btn-collapse')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.datThuGonPanel(!this.panelCollapsed);
        }, true);
        panel.querySelector('#surf-btn-toggle-3d')?.addEventListener('click', () => {
            if (typeof this.callbacks.toggleModal3D === 'function') {
                const state = this.callbacks.toggleModal3D(this.currentFrame);
                this._minimizedModalByUs = (state === 'minimized');
                this.capNhatBangSurfaceUI();
            }
        });
        panel.querySelector('#surf-btn-undo')?.addEventListener('click', () => this.hoanTacSurface());
        panel.querySelector('#surf-btn-recalc')?.addEventListener('click', () => {
            this.luuUndoSurface();
            this.selectedTileIds.clear();
            this._polarCache?.delete(this.layKeyHienTai(this.currentFrame));
            this._polarCache?.delete(this.layKeyHienTai(this.liveFrame));
            for (const fClr of [this.currentFrame, this.liveFrame]) {
                const kClr = this.layKeyHienTai(fClr);
                this._polarCacheModal?.delete(kClr);
                this._polarCacheModal?.delete(`${kClr}_full`);
                this._polarCacheModal?.delete(`${kClr}_sparse`);
                this._polarQueued?.delete(`${kClr}_full`);
                this._polarQueued?.delete(`${kClr}_sparse`);
            }
            this._polarFail = null;
            this._polarLastToastKey = '';
            const d = this.tinhHoacNapSurfaceFrame(true, false);
            this.veLaiToanBo(true);
            if (d) {
                const seedInfo = d.seedPlane ? ` (Z₀=${d.seedPlane.z0.toFixed(2)}m)` : '';
                this.hienToast(`🔄 Đã tính lại sạch Surface Frame ${this.currentFrame} theo LiDAR gốc${seedInfo}!`);
            }
        });

        panel.querySelector('#surf-grid-dongtam')?.addEventListener('click', () => this.chuyenCheDoLuoi('dongtam'));
        panel.querySelector('#surf-grid-v4')?.addEventListener('click', () => this.chuyenCheDoLuoi('v4'));
        panel.querySelector('#surf-grid-ca_hai')?.addEventListener('click', () => this.chuyenCheDoLuoi('ca_hai'));

        panel.querySelector('#surf-polar-chk-unknown')?.addEventListener('change', (e) => {
            this._hienUnknownPolar = Boolean(e.target?.checked);
            try { if (typeof localStorage !== 'undefined') localStorage.setItem('cvat_surface_polar_unknown', this._hienUnknownPolar ? '1' : '0'); } catch (_) {}
            if (this.isActive && this._cheDoLuoi !== 'v4') this.veLaiToanBo(true);
            else this.capNhatBangSurfaceUI();
        });
        panel.querySelector('#surf-polar-chk-jump')?.addEventListener('change', (e) => {
            this._hienCanhNhayPolar = Boolean(e.target?.checked);
            try { if (typeof localStorage !== 'undefined') localStorage.setItem('cvat_surface_polar_jump', this._hienCanhNhayPolar ? '1' : '0'); } catch (_) {}
            if (this.isActive && this._cheDoLuoi !== 'v4') this.veLaiToanBo(true);
            else this.capNhatBangSurfaceUI();
        });

        panel.querySelector('#surf-layers-toggle-wrap')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.datAnHienDanhSachLop(!this.layersListCollapsed);
        });

        panel.querySelector('#surf-mode-layer')?.addEventListener('click', () => {
            this.selectionMode = 'layer';
            panel.querySelector('#surf-mode-layer')?.classList.add('is-active');
            panel.querySelector('#surf-mode-tile')?.classList.remove('is-active');
        });
        panel.querySelector('#surf-mode-tile')?.addEventListener('click', () => {
            this.selectionMode = 'tile';
            panel.querySelector('#surf-mode-tile')?.classList.add('is-active');
            panel.querySelector('#surf-mode-layer')?.classList.remove('is-active');
        });

        panel.querySelector('#surf-btn-pick-top')?.addEventListener('click', () => {
            this.cheDoChonTrenTop = !this.cheDoChonTrenTop;
            this.capNhatBangSurfaceUI();
            this.hienToast(this.cheDoChonTrenTop
                ? '🖱️ Đã bật Click chọn thẳng (không cần giữ Alt) — bấm ô chưa chọn để chọn, bấm lại để bỏ chọn!'
                : 'Đã tắt Click chọn thẳng (vẫn giữ Alt + Click bất kỳ lúc nào trên TOP & 3D)');
        });

        panel.querySelector('#surf-btn-clear-sel')?.addEventListener('click', () => this.boChonTatCa());

        panel.querySelector('#surf-btn-sel-range')?.addEventListener('click', () => {
            const rMin = parseFloat(panel.querySelector('#surf-r-min')?.value || '0') || 0;
            const rMax = parseFloat(panel.querySelector('#surf-r-max')?.value || '40') || 40;
            this.chonTheoKhoangKhoangCach(rMin, rMax, 'all');
        });

        const degStep = 0.4 * Math.PI / 180.0;
        panel.querySelector('#surf-z-m5')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dz: -0.05 }));
        panel.querySelector('#surf-z-m1')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dz: -0.01 }));
        panel.querySelector('#surf-z-p1')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dz: 0.01 }));
        panel.querySelector('#surf-z-p5')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dz: 0.05 }));

        panel.querySelector('#surf-pitch-m')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dGx: degStep }));
        panel.querySelector('#surf-pitch-p')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dGx: -degStep }));
        panel.querySelector('#surf-roll-m')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dGy: -degStep }));
        panel.querySelector('#surf-roll-p')?.addEventListener('click', () => this.chinhSuaCacODangChon({ dGy: degStep }));

        panel.querySelector('#surf-set-road')?.addEventListener('click', () => this.chinhSuaCacODangChon({ newType: 'road' }));
        panel.querySelector('#surf-set-sidewalk')?.addEventListener('click', () => this.chinhSuaCacODangChon({ newType: 'sidewalk' }));
        panel.querySelector('#surf-reset-sel')?.addEventListener('click', () => this.datLaiGocCacODangChon());
        panel.querySelector('#surf-refit-sel')?.addEventListener('click', () => this.noiSuyLaiCacODangChon());

        panel.querySelector('#surf-apply-active')?.addEventListener('click', () => this.apDungSurfaceXuongBoxes('active_track'));
        panel.querySelector('#surf-apply-region')?.addEventListener('click', () => this.apDungSurfaceXuongBoxes('all_ids'));
    }

    capNhatTooltipChuot(tile, x, y) {
        if (!this._tooltipEl) return;
        if (!tile) {
            this._tooltipEl.style.display = 'none';
            return;
        }
        const data = this.laySurfaceFrame(this.liveFrame);
        const layer = data?.layers?.find(l => l.id === tile.layerId);
        const typeTxt = tile.type === 'sidewalk' ? 'Vỉa Hè' : 'Mặt Đường';
        const srcTxt = tile.source === 'extrapolated' ? 'Nội suy' : tile.source === 'occluded' ? 'Nội suy gầm xe' : (tile.manual ? 'Chỉnh tay' : `${tile.nGroundPts}đ`);
        this._tooltipEl.textContent = `${layer ? layer.name : tile.id} • ${typeTxt} | Z=${tile.zc.toFixed(2)}m (${srcTxt})`;
        this._tooltipEl.style.left = `${x + 14}px`;
        this._tooltipEl.style.top = `${y + 14}px`;
        this._tooltipEl.style.display = 'block';
    }

    capNhatBangSurfaceUI() {
        if (typeof document !== 'undefined') {
            document.body?.classList?.toggle('surf-pick-top', !!(this.isActive && this.cheDoChonTrenTop));
        }
        if (!this._panelEl) return;
        const data = this.laySurfaceHienTai();
        const sub = this._panelEl.querySelector('#surf-subtitle');
        const cntEl = this._panelEl.querySelector('#surf-layer-count');
        const selEl = this._panelEl.querySelector('#surf-sel-info');
        const listEl = this._panelEl.querySelector('#surf-layers-list');
        const pickBtn = this._panelEl.querySelector('#surf-btn-pick-top');
        const btn3d = this._panelEl.querySelector('#surf-btn-toggle-3d');

        if (pickBtn) pickBtn.classList.toggle('is-active', !!this.cheDoChonTrenTop);
        if (btn3d) {
            const isMin = !!(this.callbacks.isModalMinimized && this.callbacks.isModalMinimized());
            btn3d.textContent = isMin ? '🗖 Ext' : '👁️ 3D';
            btn3d.classList.toggle('is-active', isMin);
        }
        this.datThuGonPanel(this.panelCollapsed);
        this.datAnHienDanhSachLop(this.layersListCollapsed);

        const gBtnDt = this._panelEl.querySelector('#surf-grid-dongtam');
        const gBtnV4 = this._panelEl.querySelector('#surf-grid-v4');
        const gBtnBoth = this._panelEl.querySelector('#surf-grid-ca_hai');
        if (gBtnDt) gBtnDt.classList.toggle('is-active', this._cheDoLuoi === 'dongtam');
        if (gBtnV4) gBtnV4.classList.toggle('is-active', this._cheDoLuoi === 'v4');
        if (gBtnBoth) gBtnBoth.classList.toggle('is-active', this._cheDoLuoi === 'ca_hai');

        const polarOptsEl = this._panelEl.querySelector('#surf-polar-options');
        const polarBadgeEl = this._panelEl.querySelector('#surf-polar-badge');
        const chkUnk = this._panelEl.querySelector('#surf-polar-chk-unknown');
        const chkJmp = this._panelEl.querySelector('#surf-polar-chk-jump');
        const polarStatsEl = this._panelEl.querySelector('#surf-polar-stats');
        const gridStatusEl = this._panelEl.querySelector('#surf-grid-status');
        if (chkUnk) chkUnk.checked = !!this._hienUnknownPolar;
        if (chkJmp) chkJmp.checked = !!this._hienCanhNhayPolar;
        if (polarOptsEl) polarOptsEl.style.display = this._cheDoLuoi === 'v4' ? 'none' : 'flex';
        if (polarBadgeEl) polarBadgeEl.textContent = this._cheDoLuoi === 'dongtam' ? 'Polar Cyan' : (this._cheDoLuoi === 'ca_hai' ? 'Polar + v4' : 'v4');

        const st = this._polarStats;
        if (gridStatusEl) {
            if (this._cheDoLuoi === 'v4') {
                gridStatusEl.textContent = '▦ Chế độ v4 (ô vuông Cartesian)';
                gridStatusEl.style.color = '#94a3b8';
            } else if (this._polarFallback) {
                const desc = ThuatToanSurface._moTaLyDoPolar(this._polarFail?.reason);
                gridStatusEl.textContent = `⚠ ${desc} → v4 tạm`;
                gridStatusEl.style.color = '#fbbf24';
            } else if (st && st.nLa > 0) {
                const jmp = st.nCanhNhayCam + st.nCanhNhayDo;
                gridStatusEl.textContent = `● ${st.nLa} lá (${st.nLeafValid} LEAF · ${st.nUnknown} UNK) · ${jmp} nhảy · ${st.buildMs.toFixed(0)}ms`;
                gridStatusEl.style.color = '#22d3ee';
            } else {
                gridStatusEl.textContent = '⏳ Đang chờ điểm LiDAR...';
                gridStatusEl.style.color = '#94a3b8';
            }
        }
        if (polarStatsEl && this._cheDoLuoi !== 'v4') {
            if (st && st.nLa > 0) {
                const jmp = st.nCanhNhayCam + st.nCanhNhayDo;
                polarStatsEl.textContent = `${st.nLa} lá (${st.nLeafValid} LEAF · ${st.nUnknown} UNKNOWN) · ${jmp} nhảy (${st.buildMs.toFixed(1)}ms)`;
            } else if (this._polarFallback) {
                polarStatsEl.textContent = `Tạm hiện v4: ${ThuatToanSurface._moTaLyDoPolar(this._polarFail?.reason)}`;
            } else {
                polarStatsEl.textContent = 'Đang chờ điểm LiDAR cho lưới đồng tâm...';
            }
        }
        const trackCalEl = this._panelEl.querySelector('#surf-track-cal-status');
        if (trackCalEl) {
            const tm = this._lastTrackPhase3Meta;
            if (ThuatToanSurface.CO.ngucTrack && tm && Number.isFinite(tm.H_cal)) {
                trackCalEl.style.display = 'block';
                if (tm.nguon === 'ANCHOR') {
                    trackCalEl.style.color = '#2dd4bf';
                    trackCalEl.textContent = `◎ H_cal=${tm.H_cal.toFixed(2)}m (ANCHOR ${tm.nAnchors}f · sửa ${tm.nFixed}f)`;
                } else if (tm.nguon === 'SOFT') {
                    trackCalEl.style.color = '#a78bfa';
                    trackCalEl.textContent = `◎ H_cal=${tm.H_cal.toFixed(2)}m (SOFT ${tm.nSoft}f · sửa ${tm.nFixed}f)`;
                } else {
                    trackCalEl.style.color = '#fbbf24';
                    trackCalEl.textContent = `⚠ H_cal≈${tm.H_cal.toFixed(2)}m (FB · chưa có Anchor cận)`;
                }
            } else {
                trackCalEl.style.display = 'none';
            }
        }

        if (!data) {
            if (sub) sub.textContent = `Frame ${this.currentFrame} (3D: F${this.liveFrame}) • Đang chờ điểm LiDAR`;
            if (cntEl) cntEl.textContent = '0';
            if (selEl) selEl.textContent = 'Chưa chọn';
            if (listEl) listEl.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:8px;">Chưa nạp được điểm LiDAR cho Frame này</div>';
            return;
        }

        if (sub) sub.textContent = `F${this.currentFrame} (3D: F${this.liveFrame}) • ${data.tiles.length} ô • ${data.layers.length} lớp`;
        if (cntEl) cntEl.textContent = String(data.layers.length);
        if (selEl) selEl.textContent = this.selectedTileIds.size > 0 ? `Đang chọn ${this.selectedTileIds.size} ô` : 'Chưa chọn';

        if (listEl) {
            listEl.innerHTML = '';
            for (const l of data.layers) {
                const isSel = l.tileIds.some(id => this.selectedTileIds.has(id));
                const item = document.createElement('div');
                item.className = `surf-layer-item ${isSel ? 'is-selected' : ''}`;
                const badgeColor = l.type === 'sidewalk' ? '#e879f9' : '#f472b6';
                item.innerHTML = `
                    <div style="display:flex;align-items:center;gap:6px;">
                        <span style="width:9px;height:9px;border-radius:2px;background:${badgeColor};display:inline-block;"></span>
                        <span style="font-weight:700;color:#f8fafc;">${l.name}</span>
                    </div>
                    <span style="color:#cbd5e1;font-size:10px;">Z:${l.avgZ.toFixed(2)}m • ${l.count}ô</span>
                `;
                item.addEventListener('click', (e) => this.chonLopTheoId(l.id, e.altKey));
                listEl.appendChild(item);
            }
        }
    }

    hienToast(msg) {
        if (typeof this.callbacks.toast === 'function') this.callbacks.toast(msg);
        else console.log('[Surface]', msg);
    }

    // =========================================================================
    // 10. BẬT / TẮT CHẾ ĐỘ SURFACE & THEO DÕI CHUYỂN FRAME
    // =========================================================================

    async bat(callbacks = {}) {
        this.callbacks = { ...this.callbacks, ...callbacks };
        this.isActive = true;
        this.currentJobId = this.callbacks.getJobId ? String(this.callbacks.getJobId()) : '0';
        this.liveFrame = this.callbacks.getLiveFrame ? Number(this.callbacks.getLiveFrame()) : (this.callbacks.getCurrentFrame ? Number(this.callbacks.getCurrentFrame()) : 0);
        const fFocus = this.callbacks.getFocusFrame ? Number(this.callbacks.getFocusFrame()) : NaN;
        this.currentFrame = Number.isInteger(fFocus) ? fFocus : this.liveFrame;

        if (typeof document !== 'undefined') {
            document.getElementById('modal-btn-surface')?.classList.add('is-active');
        }

        this.damBaoBangSurfaceTonTai();
        if (this._panelEl) {
            this._panelEl.style.display = 'flex';
            this.datThuGonPanel(this.panelCollapsed);
        }

        this.selectedTileIds.clear();
        const dataFocus = this.tinhSurfaceChoFrame(this.currentFrame, false);
        if (this.liveFrame !== this.currentFrame) {
            this.tinhSurfaceChoFrame(this.liveFrame, false);
        }

        this.veSurfaceLen3D();
        this.ganTuongTacChuot3D();
        this.capNhatBangSurfaceUI();
        if (typeof this.callbacks.onSurfaceChanged === 'function') {
            this.callbacks.onSurfaceChanged();
        }

        this._polarRetryState = { fn: this.liveFrame, count: 0, lastAt: Date.now() };
        if (this._cheDoLuoi !== 'v4' && !this._polarFallback && this._polarStats?.nLa > 0) {
            this.hienToast(`🧭 Đã phủ Lưới Đồng Tâm (${this._polarStats.nLa} lá · ${this._polarStats.nLeafValid} LEAF · ${this._polarStats.buildMs.toFixed(0)}ms) lên 3D!`);
        } else if (dataFocus) {
            this.hienToast(`🌸 Đã phủ Surface (${dataFocus.tiles.length} mảng chữ nhật, ${dataFocus.layers.length} lớp) lên Extension & 3D!`);
        } else {
            this.hienToast('🌸 Đã bật Surface (đang nạp dữ liệu LiDAR theo từng frame...)');
        }

        // Theo dõi chuyển frame trên CVAT 3D / Modal và đồng bộ overlay
        if (this._frameWatcherId) clearInterval(this._frameWatcherId);
        this._frameWatcherId = setInterval(() => {
            if (!this.isActive) return;
            if (typeof document !== 'undefined') {
                const modalEl = document.getElementById('cvat-detail-modal');
                if (modalEl && modalEl.style.display === 'none') {
                    this._minimizedModalByUs = false;
                    this.tat();
                    return;
                }
            }

            if (this._minimizedModalByUs && this.callbacks.isModalMinimized && !this.callbacks.isModalMinimized()) {
                this._minimizedModalByUs = false;
                this.capNhatBangSurfaceUI();
            }

            const liveF = this.callbacks.getLiveFrame ? Number(this.callbacks.getLiveFrame()) : (this.callbacks.getCurrentFrame ? Number(this.callbacks.getCurrentFrame()) : this.liveFrame);
            if (Number.isInteger(liveF) && liveF !== this.liveFrame) {
                this.liveFrame = liveF;
                this._polarRetryState = { fn: liveF, count: 0, lastAt: Date.now() };
                this.xoaOverlay3D();
                this.tinhSurfaceChoFrame(liveF, false);
                this.veSurfaceLen3D();
                this.ganTuongTacChuot3D();
                // Nếu Modal cũng đang theo dõi hoặc đang ở frame cũ thì đồng bộ focus nhẹ nhàng
                const curFocus = this.callbacks.getFocusFrame ? Number(this.callbacks.getFocusFrame()) : liveF;
                if (Number.isInteger(curFocus) && curFocus === this.currentFrame) {
                    this.datFrameFocus(liveF);
                } else {
                    this.capNhatBangSurfaceUI();
                }
            } else {
                const focusF = this.callbacks.getFocusFrame ? Number(this.callbacks.getFocusFrame()) : this.currentFrame;
                if (Number.isInteger(focusF) && focusF !== this.currentFrame) {
                    this.datFrameFocus(focusF);
                }
                const detached = this._overlayObjects.some(item => !item.obj || !item.scene || item.obj.parent !== item.scene);
                if ((this._cheDoLuoi !== 'v4' || this.laySurfaceFrame(this.liveFrame)) && detached) {
                    this.veSurfaceLen3D();
                    this.capNhatBangSurfaceUI();
                } else if (this._cheDoLuoi !== 'v4' && (this._polarFallback || this._overlayObjects.length === 0)) {
                    const st = this._polarRetryState || { fn: this.liveFrame, count: 0, lastAt: 0 };
                    const now = Date.now();
                    if (st.fn === this.liveFrame && st.count < 10 && now - st.lastAt >= 1200) {
                        st.count++;
                        st.lastAt = now;
                        this._polarRetryState = st;
                        this.veSurfaceLen3D();
                        this.capNhatBangSurfaceUI();
                    }
                }
            }
        }, 300);
    }

    tat() {
        this.isActive = false;
        this.cheDoChonTrenTop = false;
        this._queuedFrames.clear();
        this._polarQueued?.clear();
        this.vohieuHoaFrameSolve();
        this._trackGuardByBoxKey.clear();
        if (this._trackPhase3Cache) this._trackPhase3Cache.clear();
        this._lastTrackPhase3Meta = null;
        if (this._rafDrawId && typeof cancelAnimationFrame === 'function') {
            cancelAnimationFrame(this._rafDrawId);
            this._rafDrawId = null;
        }
        if (typeof document !== 'undefined') {
            document.body?.classList?.remove('surf-pick-top');
            document.getElementById('modal-btn-surface')?.classList.remove('is-active');
        }
        if (this._frameWatcherId) {
            clearInterval(this._frameWatcherId);
            this._frameWatcherId = null;
        }
        this.goTuongTacChuot3D();
        this.xoaOverlay3D();
        if (this._panelEl) this._panelEl.style.display = 'none';

        if (typeof this.callbacks.restoreModal === 'function') {
            const isMin = this.callbacks.isModalMinimized
                ? this.callbacks.isModalMinimized()
                : !!document.querySelector('#cvat-detail-modal .cvat-modal-dialog.is-minimized');
            if (isMin && this._minimizedModalByUs) {
                this.callbacks.restoreModal();
            }
        }
        this._minimizedModalByUs = false;
        if (typeof this.callbacks.onSurfaceChanged === 'function') {
            this.callbacks.onSurfaceChanged();
        }
        this.hienToast('Đã tắt lớp phủ Surface');
    }

    toggle(callbacks = {}) {
        if (this.isActive) this.tat();
        else this.bat(callbacks);
    }
}

if (typeof window !== 'undefined') {
    window.ThuatToanSurface = ThuatToanSurface;
    window.thuatToanSurface = window.thuatToanSurface || new ThuatToanSurface();
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThuatToanSurface;
}
