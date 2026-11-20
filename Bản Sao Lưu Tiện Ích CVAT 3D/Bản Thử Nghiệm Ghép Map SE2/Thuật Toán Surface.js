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

    /** Ngưỡng λ_min của phân bố XY theo kích thước ô: giữ nguyên 0.40 @2m, 1.2 @4m của v3, co giãn ∝ s². */
    static minLambdaTheoKichThuoc(s) {
        return s <= 2 ? 0.10 * s * s : 0.075 * s * s;
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
                    if (k && (k.startsWith('cvat_surface_v2_') || k.startsWith('cvat_surface_v3_'))) localStorage.removeItem(k);
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
                    for (const key of ['perspective', 'top', 'side', 'front']) {
                        const cloud = views[key]?.scene?.children?.find(
                            o => o?.isPoints && o.geometry?.attributes?.position?.array?.length >= 30
                        );
                        if (cloud) {
                            return {
                                flatArray: cloud.geometry.attributes.position.array,
                                isFlat: true,
                                count: Math.floor(cloud.geometry.attributes.position.array.length / 3)
                            };
                        }
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
                count: fallbackPts.length
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
     * [NEO BÁNH XE] Mặt tiếp xúc P(x, y) = zc + gx·(x − bx) + gy·(y − by) dưới cuboid br.
     * Điểm đất lấy trong vành 0.3–2.5m ngoài footprint đã xoay; bỏ điểm cao hơn zLow + 0.05 (bậc vỉa, vật thể khác).
     * Histogram 3.5cm → cửa sổ 3 bin đỉnh → fit phẳng khoá dốc ±0.06 → fit lại dải ±4cm. Trần vật lý zc ≤ zLow + 0.03.
     * Trả {zc, gx, gy, n} hoặc null.
     */
    static tinhMatTiepXucXe(br, grid) {
        if (!br || !grid || !grid.tiles) return null;
        const zLow = br.zLow;
        const coZLow = Number.isFinite(zLow);
        const RIN = 0.3, ROUT = 2.5, BIN = 0.035, DOC = 0.06;
        const ac = Math.abs(br.cos), as = Math.abs(br.sin);
        const hx = ac * 0.5 * br.bL + as * 0.5 * br.bW + ROUT;
        const hy = as * 0.5 * br.bL + ac * 0.5 * br.bW + ROUT;
        const xMin = br.bx - hx, xMax = br.bx + hx, yMin = br.by - hy, yMax = br.by + hy;

        const pts = [];
        for (const t of grid.tiles) {
            if (!t.rawPts || t.rawPts.length === 0) continue;
            if (t.x1 < xMin || t.x0 > xMax || t.y1 < yMin || t.y0 > yMax) continue;
            for (const p of t.rawPts) {
                if (p[0] < xMin || p[0] > xMax || p[1] < yMin || p[1] > yMax) continue;
                if (coZLow && p[2] > zLow + 0.05) continue;
                if (!this.diemTrongFootprint(p[0], p[1], br, ROUT) || this.diemTrongFootprint(p[0], p[1], br, RIN)) continue;
                pts.push(p);
            }
        }
        const duPhong = () => coZLow ? { zc: zLow - 0.01, gx: 0, gy: 0, n: pts.length } : null;
        if (pts.length < 12) return duPhong();

        // Histogram 3.5cm (Map ⇒ không phụ thuộc biên độ z), chọn cửa sổ 3 bin nhiều phiếu nhất
        const hist = new Map();
        for (const p of pts) {
            const b = Math.floor(p[2] / BIN);
            hist.set(b, (hist.get(b) || 0) + 1);
        }
        let bestB = 0, bestCnt = -1;
        for (const b of hist.keys()) {
            const c = (hist.get(b - 1) || 0) + hist.get(b) + (hist.get(b + 1) || 0);
            if (c > bestCnt || (c === bestCnt && b < bestB)) { bestCnt = c; bestB = b; }
        }
        let sPk = 0, nPk = 0;
        for (const p of pts) {
            const b = Math.floor(p[2] / BIN);
            if (b >= bestB - 1 && b <= bestB + 1) { sPk += p[2]; nPk++; }
        }
        const zPeak = nPk > 0 ? sPk / nPk : (bestB + 0.5) * BIN;

        const band1 = pts.filter(p => Math.abs(p[2] - zPeak) <= 0.06);
        if (band1.length < 12) return duPhong();
        const fit1 = this.fitRegularizedPlane(band1, br.bx, br.by, 0, 0, zPeak, 8.0, 0.05);
        if (!fit1) return duPhong();
        let zc = fit1.zc, gx = this.clamp(fit1.gx, -DOC, DOC), gy = this.clamp(fit1.gy, -DOC, DOC);

        const band2 = band1.filter(p => Math.abs(p[2] - (zc + gx * (p[0] - br.bx) + gy * (p[1] - br.by))) <= 0.04);
        let dung = band1;
        if (band2.length >= 12) {
            const fit2 = this.fitRegularizedPlane(band2, br.bx, br.by, gx, gy, zc, 8.0, 0.05);
            if (fit2) {
                zc = fit2.zc; gx = this.clamp(fit2.gx, -DOC, DOC); gy = this.clamp(fit2.gy, -DOC, DOC);
                dung = band2;
            }
        }

        // Độ phủ: ≥ 2 phía của footprint (hệ trục hộp) và phân tán 2D đủ rộng (λmin)
        const c = br.cos, s = br.sin, hL = 0.5 * br.bL, hW = 0.5 * br.bW;
        const phia = [0, 0, 0, 0];
        for (const p of dung) {
            const dx = p[0] - br.bx, dy = p[1] - br.by;
            const u = dx * c - dy * s, v = dx * s + dy * c;
            if (u > hL) phia[0]++;
            if (u < -hL) phia[1]++;
            if (v > hW) phia[2]++;
            if (v < -hW) phia[3]++;
        }
        const soPhia = phia.filter(k => k >= 3).length;
        const lamMin = this.tinhThongKePhanBoXY(dung, br.bx, br.by).lambdaMin;
        if (dung.length < 12 || soPhia < 2 || lamMin < 0.2) return duPhong();

        if (coZLow) zc = Math.min(zc, zLow + 0.03); // lốp chạm đất: mặt đất không thể cao hơn điểm thấp nhất của xe
        return { zc, gx, gy, n: dung.length };
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

    static stitchSameTypeGraph(tilesOfType, fallbackZ, contactCaps = null) {
        if (!tilesOfType || tilesOfType.length === 0) return;
        // [NEO BÁNH XE] Ô neo bánh xe (contact) là nguồn tin cậy ngang ô đo thật
        const laSolid = (t) => t.source === 'seed' || t.source === 'measured' || t.contact === true;
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
            v.isSolid = v.tiles.some(laSolid);
            let minSolidZt = Infinity, maxSolidZt = -Infinity;
            const zPreds = new Array(v.tiles.length);
            for (let i = 0; i < v.tiles.length; i++) {
                const t = v.tiles[i];
                const zt = t.fitZc + t.fitGx * (v.x - t.cx) + t.fitGy * (v.y - t.cy);
                zPreds[i] = zt;
                if (laSolid(t)) {
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
                    if (!laSolid(ti)) continue;
                    let score = 0;
                    for (let j = 0; j < v.tiles.length; j++) {
                        const tj = v.tiles[j];
                        if (laSolid(tj) && Math.abs(zPreds[j] - zPreds[i]) <= 0.06) {
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
                const tSolid = laSolid(t);
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
            const tSolid = laSolid(t);
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

        // [NEO BÁNH XE] Chiếu Kaczmarz CHỈ HẠ (không nâng): tại mỗi điểm mẫu dưới xe, Surface song tuyến ≤ zMax.
        //   Vi phạm e ⇒ hạ góc k một lượng e·w_k/Σw²; góc treo chuyển xuống 2 đỉnh cha theo nghiệm chuẩn nhỏ nhất (1−f, f).
        if (Array.isArray(contactCaps) && contactCaps.length > 0) {
            const fullTiles = tilesOfType.filter(t => t.tier !== 'sub');
            const zOf = (v, depth = 0) => (v.hang && depth < 6)
                ? (1 - v.hang.f) * zOf(v.hang.a, depth + 1) + v.hang.f * zOf(v.hang.b, depth + 1)
                : v.z;
            const haV = (v, d, depth = 0) => {
                if (v.hang && depth < 6) {
                    const f = v.hang.f, den = (1 - f) * (1 - f) + f * f;
                    haV(v.hang.a, d * (1 - f) / den, depth + 1);
                    haV(v.hang.b, d * f / den, depth + 1);
                } else v.z -= d;
            };
            const capCells = [];
            for (const cap of contactCaps) {
                if (!cap || !Number.isFinite(cap.x) || !Number.isFinite(cap.y) || !Number.isFinite(cap.zMax)) continue;
                const t = fullTiles.find(q => cap.x >= q.x0 && cap.x < q.x1 && cap.y >= q.y0 && cap.y < q.y1);
                if (!t) continue;
                const cs = [
                    vMap.get(`${t.x0}_${t.y0}`), vMap.get(`${t.x1}_${t.y0}`),
                    vMap.get(`${t.x1}_${t.y1}`), vMap.get(`${t.x0}_${t.y1}`)
                ];
                if (cs.some(v => !v)) continue;
                const fx = (cap.x - t.x0) / t.w, fy = (cap.y - t.y0) / t.h;
                const ws = [(1 - fx) * (1 - fy), fx * (1 - fy), fx * fy, (1 - fx) * fy];
                capCells.push({ cs, ws, w2: ws.reduce((s, w) => s + w * w, 0), zMax: cap.zMax });
            }
            for (let it = 0; it < 12 && capCells.length > 0; it++) {
                let maxE = 0;
                for (const cc of capCells) {
                    let z = 0;
                    for (let k = 0; k < 4; k++) z += cc.ws[k] * zOf(cc.cs[k]);
                    const e = z - cc.zMax;
                    if (e <= 1e-4 || cc.w2 < 1e-9) continue;
                    if (e > maxE) maxE = e;
                    for (let k = 0; k < 4; k++) if (cc.ws[k] > 0) haV(cc.cs[k], e * cc.ws[k] / cc.w2);
                }
                if (maxE < 0.001) break;
            }
            for (let pass = 0; pass < 4; pass++) {
                for (let i = 0; i < vList.length; i++) {
                    const v = vList[i];
                    if (v.hang) v.z = (1 - v.hang.f) * v.hang.a.z + v.hang.f * v.hang.b.z;
                }
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

    static xayDungSurfaceBanDoAnToan(rawData, boxes = []) {
        const ext = this.tinhPhamViLuoi(boxes);
        let data = this.xayDungSurfaceBanDo(rawData, boxes, { ext });
        let shift = 0;
        for (let k = 0; data && k < 2; k++) {
            const chk = this.kiemDinhRoadSidewalk(data);
            if (chk.ok || Math.abs(chk.dz) < 0.03) break;
            shift += chk.dz;
            const next = this.xayDungSurfaceBanDo(rawData, boxes, { seedShift: shift, ext });
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
            boxRects.push({ bx, by, bz, bL, bW, bH, rz, cos: Math.cos(-rz), sin: Math.sin(-rz), zDay: bz - 0.5 * bH, pad, lowZ: [], zLow: NaN, matTiepXuc: null });
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
                if (z >= br.zDay - MASK_DAY && this.diemTrongFootprint(x, y, br, MASK_LE)) {
                    // [NEO BÁNH XE] Giữ 5 z thấp nhất của điểm xe trong footprint co vào 0.15m (chèn có sắp xếp, O(1))
                    if (this.diemTrongFootprint(x, y, br, -0.15)) {
                        const lz = br.lowZ;
                        if (lz.length < 5 || z < lz[lz.length - 1]) {
                            let k = lz.length < 5 ? lz.length : 4;
                            while (k > 0 && lz[k - 1] > z) { lz[k] = lz[k - 1]; k--; }
                            lz[k] = z;
                            if (lz.length > 5) lz.length = 5;
                        }
                    }
                    return true;
                }
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

        // [NEO BÁNH XE] zLow = điểm xe thấp thứ 3 (chống nhiễu 1–2 điểm lạc); < 3 điểm ⇒ NaN
        for (const br of boxRects) br.zLow = br.lowZ.length >= 3 ? br.lowZ[2] : NaN;

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
                        // Hãm khuếch đại dốc: Δc 4m × sai số dốc không được đẩy lệch quá ±12cm
                        sw += w; sz += w * (zn + this.clamp(gxn * ddx + gyn * ddy, -0.12, 0.12));
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

        // Bước 5c [NEO BÁNH XE]: Tiêm mặt tiếp xúc P của từng xe vào các ô occluded dưới footprint.
        //   Giữ source = 'occluded' (mọi luồng lọc 'occluded' khác không đổi), đánh dấu contact + confidence 1.5 để Bước 7 coi là nguồn solid.
        for (const br of boxRects) {
            const P = this.tinhMatTiepXucXe(br, grid);
            br.matTiepXuc = P;
            if (!P) continue;
            for (const t of grid.tiles) {
                if (!t.occluded || !this.diemTrongFootprint(t.cx, t.cy, br, 0)) continue;
                const daGiai = t.solved;
                t.solved = true; t.visible = true; t.type = 'road'; t.source = 'occluded';
                t.fitZc = P.zc + P.gx * (t.cx - br.bx) + P.gy * (t.cy - br.by);
                t.fitGx = P.gx; t.fitGy = P.gy;
                t.pts = []; t.nGroundPts = 0; t.rms = 0;
                t.contact = true; t.confidence = 1.5;
                t.zc = t.fitZc; t.gx = t.fitGx; t.gy = t.fitGy;
                if (!daGiai) solvedList.push(t);
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

        // Bước 7: Khâu kín đỉnh góc song tuyến tính (C0 Watertight Stitching) riêng biệt cho Road & Sidewalk
        const roadGroup = finalTiles.filter(t => t.type === 'road');
        const swGroup = finalTiles.filter(t => t.type === 'sidewalk');
        // [NEO BÁNH XE] 9 điểm mẫu / xe: 4 bánh (u = ±0.36L, v = ±0.40W), tâm, 4 trung điểm cạnh; zMax = P(x, y) + 0.02
        const contactCaps = [];
        for (const br of boxRects) {
            const P = br.matTiepXuc;
            if (!P) continue;
            const hL = 0.5 * br.bL, hW = 0.5 * br.bW;
            const mau = [
                [0.36 * br.bL, 0.40 * br.bW], [0.36 * br.bL, -0.40 * br.bW],
                [-0.36 * br.bL, 0.40 * br.bW], [-0.36 * br.bL, -0.40 * br.bW],
                [0, 0], [hL, 0], [-hL, 0], [0, hW], [0, -hW]
            ];
            // Hệ hộp → thế giới: quay +rz (br.cos = cos(−rz), br.sin = sin(−rz))
            const c = br.cos, s = br.sin;
            for (const [u, v] of mau) {
                const x = br.bx + u * c + v * s;
                const y = br.by - u * s + v * c;
                contactCaps.push({ x, y, zMax: P.zc + P.gx * (x - br.bx) + P.gy * (y - br.by) + 0.02 });
            }
        }
        this.stitchSameTypeGraph(roadGroup, seed.z0, contactCaps);
        this.stitchSameTypeGraph(swGroup, seed.z0 + 0.15, contactCaps);

        for (const t of finalTiles) {
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
    static layMatDuongChoBox(surfaceData, cx, cy, rz = 0, L = 4.4, W = 1.9, rawPts = null) {
        if (surfaceData && surfaceData.localPatchesData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            try {
                const localInfo = ThuatToanSurfaceCucBo.layMatDuongChoBox(surfaceData.localPatchesData, cx, cy);
                if (localInfo && Number.isFinite(localInfo.zRoad)) return localInfo;
            } catch (e) {}
        }
        if (surfaceData && surfaceData.czmData && typeof ThuatToanConcentricSurface !== 'undefined') {
            try {
                const czmInfo = ThuatToanConcentricSurface.layMatDuongChoBoxCZM(surfaceData.czmData, cx, cy, rz, L, W, rawPts);
                if (czmInfo && Number.isFinite(czmInfo.zRoad)) return czmInfo;
            } catch (e) {}
        }
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
            tile: baseFit.tile,
            localFit: true
        };
    }

    // =========================================================================
    // 4b. ĐỘ CAO TƯƠNG ĐỐI SO VỚI MẶT PHẲNG EGO + LÀM MƯỢT HAI CHIỀU DỌC TRACK
    //     (Ego-Relative Elevation Smoother: Kalman [h, p] xuôi + RTS ngược)
    // =========================================================================

    /**
     * Điểm LiDAR thấp thứ 3 trong footprint box (trần vật lý: mặt đường không thể cao hơn đáy xe).
     * Trả null nếu quá ít điểm để tin cậy.
     */
    static _zThapTrongFootprint(pts, cx, cy, rz, L, W, zBottom, H) {
        if (!pts || pts.length < 20) return null;
        const c = Math.cos(rz || 0), s = Math.sin(rz || 0);
        const hu = L / 2, hv = W / 2;
        const zLo = zBottom - 0.6, zHi = zBottom + H + 0.3;
        const low = [];
        let n = 0;
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const z = p[2];
            if (z < zLo || z > zHi) continue;
            const dx = p[0] - cx, dy = p[1] - cy;
            if (Math.abs(dx * c + dy * s) > hu || Math.abs(-dx * s + dy * c) > hv) continue;
            n++;
            if (low.length < 3) { low.push(z); low.sort((a, b) => a - b); }
            else if (z < low[2]) { low[2] = z; low.sort((a, b) => a - b); }
        }
        return n >= 8 ? low[2] : null;
    }

    /**
     * Đo độ cao tương đối của mặt đường dưới box so với mặt phẳng Ego (seedPlane):
     *   h = zRoad − E_ego(bx, by),  E_ego = z0 + gx·bx + gy·by
     *   p = (gx − gx_ego)·cos rz + (gy − gy_ego)·sin rz   (dốc dọc theo hướng xe)
     *   r = −(gx − gx_ego)·sin rz + (gy − gy_ego)·cos rz  (dốc ngang)
     *   σ: contact 0.02 | measured 0.04 | sparse 0.07 | occluded/extrapolated 0.15 (+ d·0.003)
     * box = { cx, cy, rz, L, W, H, zBottom, pts }
     */
    static doDoCaoTuongDoi(data, info, box) {
        if (!data || !info || !box || !Number.isFinite(info.zRoad)) return null;
        const sp = data.seedPlane || { z0: info.zRoad, gx: 0, gy: 0 };
        const bx = box.cx, by = box.cy, rz = box.rz || 0;
        const E = sp.z0 + sp.gx * bx + sp.gy * by;
        const dgx = (info.gx || 0) - sp.gx, dgy = (info.gy || 0) - sp.gy;
        const c = Math.cos(rz), s = Math.sin(rz);
        const d = Math.hypot(bx, by);

        const t = info.tile;
        let sig, sigP;
        if (info.localFit || (t && t.contact)) { sig = 0.02; sigP = 0.015; }
        else if (info.source === 'measured' || info.source === 'manual') { sig = 0.04; sigP = 0.02; }
        else if (info.source === 'sparse' || info.source === 'seed') { sig = 0.07; sigP = 0.035; }
        else { sig = 0.15; sigP = 0.06; }
        sig += d * 0.003;
        sigP += d * 0.0008;

        let hMax = null;
        if (box.pts && Number.isFinite(box.zBottom) && Number.isFinite(box.H)) {
            const zLow = this._zThapTrongFootprint(box.pts, bx, by, rz, box.L || 4.4, box.W || 1.9, box.zBottom, box.H);
            if (zLow !== null) hMax = zLow + 0.03 - E;
        }

        return {
            h: info.zRoad - E,
            p: dgx * c + dgy * s,
            r: -dgx * s + dgy * c,
            sigma: sig,
            sigmaP: sigP,
            hMax,
            ego: { z0: sp.z0, gx: sp.gx, gy: sp.gy },
            E, d, x: bx, y: by, rz
        };
    }

    /**
     * Làm mượt hai chiều chuỗi độ cao tương đối dọc Track.
     * samples (đã sắp theo frame): { frame, x, y, rz, h, p, r, sigma, sigmaP, hMax }
     * - Kalman 2 trạng thái [h, p] xuôi theo quãng đường s (h_{k+1} = h_k + p·Δs) + RTS ngược.
     * - Cổng Mahalanobis χ² ≤ 9 (3σ) loại outlier; 2 lần loại liên tiếp cùng dấu → coi là đổi địa hình thật, nhận lại.
     * - Kẹp độ dốc |Δh/Δs| ≤ 0.05 lan từ mỏ neo tin cậy nhất ra hai phía, rồi áp trần vật lý hMax.
     * Trả về mảng { h, p, r, rejected, sigmaPost } cùng thứ tự.
     */
    static lamMuotTuongDoiTrack(samples, opts = {}) {
        const n = Array.isArray(samples) ? samples.length : 0;
        if (n === 0) return [];
        const MAX_SLOPE = opts.maxSlope ?? 0.05;
        const GATE = opts.gate ?? 9;
        const QH = opts.qh ?? 0.015 * 0.015;   // m²/m
        const QP = opts.qp ?? 0.01 * 0.01;     // (m/m)²/m
        const QR = opts.qr ?? 0.01 * 0.01;
        const P_LIM = 0.08;

        // Quãng đường: Δs có dấu dọc hướng xe (cho động học h += p·Δs), |Δs| có sàn 0.5m/frame (cho nhiễu & kẹp dốc)
        const dsS = new Float64Array(n), dsA = new Float64Array(n);
        for (let k = 1; k < n; k++) {
            const a = samples[k - 1], b = samples[k];
            const dx = b.x - a.x, dy = b.y - a.y;
            const hd = Number.isFinite(b.rz) ? b.rz : (a.rz || 0);
            const df = Math.max(1, Math.abs((b.frame ?? k) - (a.frame ?? (k - 1))));
            dsS[k] = dx * Math.cos(hd) + dy * Math.sin(hd);
            dsA[k] = Math.max(Math.hypot(dx, dy), 0.5 * df);
        }

        // Khởi tạo: trung vị có trọng số của ≤3 mẫu đầu
        const head = samples.slice(0, Math.min(3, n)).map(s => ({ v: s.h, w: 1 / (s.sigma * s.sigma) })).sort((a, b) => a.v - b.v);
        const wSum = head.reduce((acc, q) => acc + q.w, 0);
        let acc = 0, h0 = head[0].v;
        for (const q of head) { acc += q.w; if (acc >= wSum / 2) { h0 = q.v; break; } }

        // ---- Lượt xuôi ----
        const xp = [], Pp = [], xf = [], Pf = [];
        const rejected = new Array(n).fill(false);
        let x = [h0, this.clamp(samples[0].p || 0, -P_LIM, P_LIM)];
        let P = [[Math.max(samples[0].sigma ** 2, 0.05 ** 2), 0], [0, 0.04 ** 2]];
        let lastRejSign = 0;

        for (let k = 0; k < n; k++) {
            const sm = samples[k];
            if (k > 0) {
                const ds = dsS[k];
                x = [x[0] + x[1] * ds, x[1]];
                const a = P[0][0] + 2 * ds * P[0][1] + ds * ds * P[1][1];
                const b = P[0][1] + ds * P[1][1];
                P = [[a + QH * dsA[k], b], [b, P[1][1] + QP * dsA[k]]];
            }
            xp.push([...x]);
            Pp.push([[...P[0]], [...P[1]]]);

            // Cập nhật h (cổng Mahalanobis)
            const R = sm.sigma * sm.sigma;
            let inn = sm.h - x[0];
            let S = P[0][0] + R;
            if ((inn * inn) / S > GATE) {
                const sg = Math.sign(inn);
                if (lastRejSign === sg) {
                    // Hai lần lệch cùng phía liên tiếp → địa hình thật đã đổi: nới hiệp phương sai rồi nhận đo
                    P[0][0] += inn * inn;
                    S = P[0][0] + R;
                    lastRejSign = 0;
                } else {
                    rejected[k] = true;
                    lastRejSign = sg;
                }
            } else {
                lastRejSign = 0;
            }
            if (!rejected[k]) {
                const K0 = P[0][0] / S, K1 = P[1][0] / S;
                x = [x[0] + K0 * inn, x[1] + K1 * inn];
                P = [
                    [P[0][0] - K0 * P[0][0], P[0][1] - K0 * P[0][1]],
                    [P[1][0] - K1 * P[0][0], P[1][1] - K1 * P[0][1]]
                ];
                // Cập nhật p (đo dốc dọc của ô mặt đường)
                if (Number.isFinite(sm.p) && Number.isFinite(sm.sigmaP)) {
                    const Rp = sm.sigmaP * sm.sigmaP;
                    const innP = sm.p - x[1];
                    const Sp = P[1][1] + Rp;
                    if ((innP * innP) / Sp <= GATE) {
                        const L0 = P[0][1] / Sp, L1 = P[1][1] / Sp;
                        x = [x[0] + L0 * innP, x[1] + L1 * innP];
                        P = [
                            [P[0][0] - L0 * P[1][0], P[0][1] - L0 * P[1][1]],
                            [P[1][0] - L1 * P[1][0], P[1][1] - L1 * P[1][1]]
                        ];
                    }
                }
            }
            x[1] = this.clamp(x[1], -P_LIM, P_LIM);
            P[0][1] = P[1][0] = 0.5 * (P[0][1] + P[1][0]);
            xf.push([...x]);
            Pf.push([[...P[0]], [...P[1]]]);
        }

        // ---- Lượt ngược RTS ----
        const xs = new Array(n), Ps = new Array(n);
        xs[n - 1] = xf[n - 1];
        Ps[n - 1] = Pf[n - 1];
        for (let k = n - 2; k >= 0; k--) {
            const ds = dsS[k + 1];
            const A = [[1, ds], [0, 1]];
            const Pk = Pf[k], Pn = Pp[k + 1];
            // C = Pk · Aᵀ · inv(Pn)
            const det = Pn[0][0] * Pn[1][1] - Pn[0][1] * Pn[1][0];
            if (Math.abs(det) < 1e-14) { xs[k] = xf[k]; Ps[k] = Pk; continue; }
            const iPn = [[Pn[1][1] / det, -Pn[0][1] / det], [-Pn[1][0] / det, Pn[0][0] / det]];
            const PAt = [
                [Pk[0][0] * A[0][0] + Pk[0][1] * A[0][1], Pk[0][0] * A[1][0] + Pk[0][1] * A[1][1]],
                [Pk[1][0] * A[0][0] + Pk[1][1] * A[0][1], Pk[1][0] * A[1][0] + Pk[1][1] * A[1][1]]
            ];
            const C = [
                [PAt[0][0] * iPn[0][0] + PAt[0][1] * iPn[1][0], PAt[0][0] * iPn[0][1] + PAt[0][1] * iPn[1][1]],
                [PAt[1][0] * iPn[0][0] + PAt[1][1] * iPn[1][0], PAt[1][0] * iPn[0][1] + PAt[1][1] * iPn[1][1]]
            ];
            const e0 = xs[k + 1][0] - xp[k + 1][0], e1 = xs[k + 1][1] - xp[k + 1][1];
            xs[k] = [xf[k][0] + C[0][0] * e0 + C[0][1] * e1, this.clamp(xf[k][1] + C[1][0] * e0 + C[1][1] * e1, -P_LIM, P_LIM)];
            const D = [[Ps[k + 1][0][0] - Pn[0][0], Ps[k + 1][0][1] - Pn[0][1]], [Ps[k + 1][1][0] - Pn[1][0], Ps[k + 1][1][1] - Pn[1][1]]];
            const CD00 = C[0][0] * D[0][0] + C[0][1] * D[1][0], CD01 = C[0][0] * D[0][1] + C[0][1] * D[1][1];
            const CD10 = C[1][0] * D[0][0] + C[1][1] * D[1][0], CD11 = C[1][0] * D[0][1] + C[1][1] * D[1][1];
            Ps[k] = [
                [Pk[0][0] + CD00 * C[0][0] + CD01 * C[0][1], Pk[0][1] + CD00 * C[1][0] + CD01 * C[1][1]],
                [Pk[1][0] + CD10 * C[0][0] + CD11 * C[0][1], Pk[1][1] + CD10 * C[1][0] + CD11 * C[1][1]]
            ];
        }

        // ---- Dốc ngang r: Kalman/RTS vô hướng (bước ngẫu nhiên) có cổng ----
        const rS = new Array(n).fill(0);
        {
            const rf = [], vf = [], vp = [];
            let rx = this.clamp(samples[0].r || 0, -P_LIM, P_LIM), v = 0.04 ** 2;
            for (let k = 0; k < n; k++) {
                if (k > 0) v += QR * dsA[k];
                vp.push(v);
                const sm = samples[k];
                if (Number.isFinite(sm.r) && Number.isFinite(sm.sigmaP)) {
                    const R = sm.sigmaP * sm.sigmaP, inn = sm.r - rx, S = v + R;
                    if ((inn * inn) / S <= GATE) { const K = v / S; rx += K * inn; v *= (1 - K); }
                }
                rf.push(rx); vf.push(v);
            }
            rS[n - 1] = rf[n - 1];
            for (let k = n - 2; k >= 0; k--) {
                const C = vf[k] / vp[k + 1];
                rS[k] = this.clamp(rf[k] + C * (rS[k + 1] - rf[k]), -P_LIM, P_LIM);
            }
        }

        // ---- Kẹp độ dốc |Δh/Δs| ≤ MAX_SLOPE lan từ mỏ neo (phương sai hậu nghiệm nhỏ nhất) ----
        const h = xs.map(v => v[0]);
        let anchor = 0;
        for (let k = 1; k < n; k++) if (Ps[k][0][0] < Ps[anchor][0][0]) anchor = k;
        for (let k = anchor + 1; k < n; k++) {
            const lim = MAX_SLOPE * dsA[k];
            h[k] = this.clamp(h[k], h[k - 1] - lim, h[k - 1] + lim);
        }
        for (let k = anchor - 1; k >= 0; k--) {
            const lim = MAX_SLOPE * dsA[k + 1];
            h[k] = this.clamp(h[k], h[k + 1] - lim, h[k + 1] + lim);
        }

        // ---- Trần vật lý: mặt đường không được cao hơn đáy xe đo được ----
        for (let k = 0; k < n; k++) {
            const hm = samples[k].hMax;
            if (Number.isFinite(hm) && h[k] > hm) h[k] = hm;
        }

        return h.map((hv, k) => ({
            h: hv,
            p: xs[k][1],
            r: rS[k],
            rejected: rejected[k],
            sigmaPost: Math.sqrt(Math.max(0, Ps[k][0][0]))
        }));
    }

    // =========================================================================
    // 5. BỘ VẼ THREE.JS LÊN BẢN ĐỒ 3D CVAT (KHÔNG CẦN window.THREE)
    // =========================================================================

    layThongTinThreeJS() {
        if (typeof window === 'undefined') return null;
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
                    if (m && !m.isShaderMaterial && (!MatMeshTemplate || m.type === 'MeshBasicMaterial')) {
                        MeshCtor = o.constructor;
                        MatMeshTemplate = m;
                    }
                    if (!BufferGeoCtor && o.geometry) BufferGeoCtor = o.geometry.constructor;
                    const posAttr = o.geometry?.attributes?.position;
                    if (posAttr && !BufferAttrCtor) BufferAttrCtor = posAttr.constructor;
                }
                if (o.isLineSegments && o.material) {
                    const m = Array.isArray(o.material) ? o.material[0] : o.material;
                    if (m && !m.isShaderMaterial && (!MatLineTemplate || m.type === 'LineBasicMaterial')) {
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

    _veOverlayPatchesCucBo(env, localData, zBias = 0.008) {
        this.xoaOverlay3D();

        const setGeoAttr = (geo, name, arr) => {
            const attr = new env.BufferAttrCtor(arr, 3);
            if (typeof geo.setAttribute === 'function') geo.setAttribute(name, attr);
            else if (typeof geo.addAttribute === 'function') geo.addAttribute(name, attr);
        };

        const items = [];
        if (localData.egoPatch) items.push(localData.egoPatch);
        for (const p of localData.patches) items.push(p);
        if (items.length === 0) return;

        const n = items.length;
        const meshPosArr = new Float32Array(n * 6 * 3);
        const meshColArr = new Float32Array(n * 6 * 3);
        const linePosArr = new Float32Array(n * 8 * 3);
        const lineColArr = new Float32Array(n * 8 * 3);

        const pad = ThuatToanSurfaceCucBo.PATCH_VIS_PAD || 0.35;
        const colorOf = (status) => {
            if (status === 'ego') return { fill: [0.22, 0.74, 0.97], line: [0.45, 0.85, 1.00] };
            if (status === 'anchor') return { fill: [0.06, 0.73, 0.51], line: [0.20, 0.90, 0.65] };
            if (status === 'partial') return { fill: [0.96, 0.62, 0.04], line: [1.00, 0.78, 0.25] };
            return { fill: [0.66, 0.33, 0.97], line: [0.80, 0.55, 1.00] };
        };

        for (let i = 0; i < n; i++) {
            const p = items[i];
            const { fill, line } = colorOf(p.status);
            const hl = 0.5 * p.L + pad;
            const hw = 0.5 * p.W + pad;
            const cosR = p.cosRz ?? Math.cos(p.rz || 0);
            const sinR = p.sinRz ?? Math.sin(p.rz || 0);

            const corner = (u, v) => {
                const wx = p.x + u * cosR - v * sinR;
                const wy = p.y + u * sinR + v * cosR;
                const wz = ThuatToanSurfaceCucBo.evalPatchZ(p, wx, wy) + zBias;
                return [wx, wy, wz];
            };

            const c0 = corner(-hl, -hw);
            const c1 = corner( hl, -hw);
            const c2 = corner( hl,  hw);
            const c3 = corner(-hl,  hw);

            const mb = i * 18;
            const mCoords = [
                c0[0], c0[1], c0[2],  c1[0], c1[1], c1[2],  c2[0], c2[1], c2[2],
                c0[0], c0[1], c0[2],  c2[0], c2[1], c2[2],  c3[0], c3[1], c3[2]
            ];
            for (let k = 0; k < 18; k++) meshPosArr[mb + k] = mCoords[k];
            for (let v = 0; v < 6; v++) {
                meshColArr[mb + v * 3] = fill[0];
                meshColArr[mb + v * 3 + 1] = fill[1];
                meshColArr[mb + v * 3 + 2] = fill[2];
            }

            const lb = i * 24;
            const lCoords = [
                c0[0], c0[1], c0[2],  c1[0], c1[1], c1[2],
                c1[0], c1[1], c1[2],  c2[0], c2[1], c2[2],
                c2[0], c2[1], c2[2],  c3[0], c3[1], c3[2],
                c3[0], c3[1], c3[2],  c0[0], c0[1], c0[2]
            ];
            for (let k = 0; k < 24; k++) linePosArr[lb + k] = lCoords[k];
            for (let v = 0; v < 8; v++) {
                lineColArr[lb + v * 3] = line[0];
                lineColArr[lb + v * 3 + 1] = line[1];
                lineColArr[lb + v * 3 + 2] = line[2];
            }
        }

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
                this._matMesh.opacity = 0.42;
                this._matMesh.side = 2;
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
        }

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
                this._matLine.opacity = 0.92;
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

    veSurfaceLen3D() {
        const data = this.laySurfaceFrame(this.liveFrame);
        if (!data) return;

        const env = this.layThongTinThreeJS();
        if (!env) return;

        // Đồng bộ & ưu tiên hiển thị các mảng mặt đường cục bộ (Per-Vehicle Local Ground Patches)
        if (typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const boxes = this.layDanhSachBoxTrongFrame(this.liveFrame);
            const sigLocal = ThuatToanSurfaceCucBo.kyHieuBoxes(boxes);
            if (!data.localPatchesData || data.localPatchesData.boxSignature !== sigLocal) {
                if (data.localPatchesData && data.localPatchesData._flat) {
                    try { data.localPatchesData = ThuatToanSurfaceCucBo.capNhat(data.localPatchesData, boxes); } catch (e) {}
                } else {
                    const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(this.liveFrame) : null;
                    const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, true);
                    if (raw) {
                        try { data.localPatchesData = ThuatToanSurfaceCucBo.xayDung(raw, boxes); } catch (e) {}
                    }
                }
            }
            if (data.localPatchesData && data.localPatchesData.patches && data.localPatchesData.patches.length > 0) {
                this._veOverlayPatchesCucBo(env, data.localPatchesData, 0.008);
                return;
            }
            // Trong chế độ Surface Cục Bộ: KHÔNG BAO GIỜ vẽ lưới 1649 ô cũ lên 3D
            this.xoaOverlay3D();
            this.kichHoatRenderCVAT();
            return;
        }

        if (!data.tiles || data.tiles.length === 0) return;

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
        const lsKey = `cvat_surface_v4_${key}`;
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
                    confidence: t.confidence, nGroundPts: t.nGroundPts, layerId: t.layerId,
                    contact: t.contact === true || undefined
                }))
            };
            localStorage.setItem(lsKey, JSON.stringify(compact));
        } catch (e) {}
    }

    napTuLocalStorageFrame(key) {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(`cvat_surface_v4_${key}`);
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
        const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
        const allowThreeJS = (frameNum === this.liveFrame);
        const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
        if (!raw) return null;
        const data = ThuatToanSurface.xayDungSurfaceBanDoAnToan(raw, boxes);
        if (data && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            try {
                data.localPatchesData = ThuatToanSurfaceCucBo.xayDung(raw, boxes);
            } catch (errLocal) {
                console.warn('[Surface] Lỗi tạo localPatchesData:', errLocal);
            }
        }
        if (data && typeof ThuatToanConcentricSurface !== 'undefined') {
            try {
                data.czmData = ThuatToanConcentricSurface.xayDungConcentricSurface(raw, boxes);
            } catch (errCzm) {
                console.warn('[Surface] Lỗi tạo czmData:', errCzm);
            }
        }
        return data;
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
        if (exact) {
            if (typeof ThuatToanSurfaceCucBo !== 'undefined') {
                const boxes = this.layDanhSachBoxTrongFrame(frameNum);
                const sigLocal = ThuatToanSurfaceCucBo.kyHieuBoxes(boxes);
                if (exact.localPatchesData && exact.localPatchesData.boxSignature !== sigLocal && exact.localPatchesData._flat) {
                    try { exact.localPatchesData = ThuatToanSurfaceCucBo.capNhat(exact.localPatchesData, boxes); } catch (eLoc) {}
                } else if (!exact.localPatchesData || exact.localPatchesData.boxSignature !== sigLocal) {
                    const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
                    const allowThreeJS = (frameNum === this.liveFrame);
                    const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
                    if (raw) {
                        try {
                            exact.localPatchesData = ThuatToanSurfaceCucBo.xayDung(raw, boxes);
                            if (typeof window !== 'undefined' && window._globalGroundAtlas && exact.localPatchesData) {
                                window._globalGroundAtlas.napPatchesVaoAtlas(frameNum, exact.localPatchesData);
                            }
                        } catch (eLoc) {}
                    }
                    if (!exact.localPatchesData) {
                        const refData = this.laySurfaceFrame(this.liveFrame)?.localPatchesData || this._layLocalPatchesMau();
                        if (refData) {
                            exact.localPatchesData = ThuatToanSurfaceCucBo.muonLocalPatches(refData, boxes, frameNum);
                        }
                    }
                }
            }
            if (typeof ThuatToanConcentricSurface !== 'undefined') {
                // Dựng lại CZM khi chưa có HOẶC footprint box đã đổi (sau Auto fit / kéo tay): miếng vá đất cục bộ
                // phải đo lại tại vị trí box mới, nếu không vạch hồng bám theo vị trí cũ.
                const boxes = this.layDanhSachBoxTrongFrame(frameNum);
                const sig = ThuatToanConcentricSurface.kyHieuBoxes(boxes);
                if (exact.czmData && exact.czmData.boxSignature !== sig && exact.czmData._flat) {
                    try { ThuatToanConcentricSurface.capNhatMiengVa(exact.czmData, boxes); } catch (eVa) {}
                } else if (!exact.czmData || exact.czmData.boxSignature !== sig) {
                    const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
                    const allowThreeJS = (frameNum === this.liveFrame);
                    const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
                    if (raw) {
                        try {
                            exact.czmData = ThuatToanConcentricSurface.xayDungConcentricSurface(raw, boxes);
                        } catch (eCzm) {}
                    }
                }
            }
            return { data: exact, srcFrame: frameNum, borrowed: false };
        }

        this.scheduleTinhFrame(frameNum);

        // Tạm mượn frame lân cận gần nhất (≤ 10 frame) trong lúc đang tính nền
        let bestData = null;
        let bestF = frameNum;
        for (let d = 1; d <= 10 && !bestData; d++) {
            for (const candF of [frameNum - d, frameNum + d]) {
                if (candF < 0) continue;
                const cd = this.frameCache.get(this.layKeyHienTai(candF));
                if (cd) { bestData = cd; bestF = candF; break; }
            }
        }
        if (!bestData) return null;

        // Ưu tiên mượn Local Patches cho các box của frame này
        if (typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const boxes = this.layDanhSachBoxTrongFrame(frameNum);
            const refData = bestData?.localPatchesData || this.laySurfaceFrame(this.liveFrame)?.localPatchesData || this._layLocalPatchesMau();
            if (refData) {
                const borrowedPatches = ThuatToanSurfaceCucBo.muonLocalPatches(refData, boxes, frameNum);
                return { data: { ...bestData, localPatchesData: borrowedPatches }, srcFrame: bestF, borrowed: true };
            }
        }

        const own = this._layCZMRieng(frameNum);
        if (own) return { data: { ...bestData, czmData: own }, srcFrame: frameNum, borrowed: false };
        return { data: bestData, srcFrame: bestF, borrowed: true };
    }

    _layLocalPatchesMau() {
        for (const cd of this.frameCache.values()) {
            if (cd && cd.localPatchesData && cd.localPatchesData.patches && cd.localPatchesData.patches.length > 0) {
                return cd.localPatchesData;
            }
        }
        return null;
    }

    _layCZMRieng(frameNum) {
        if (typeof ThuatToanConcentricSurface === 'undefined') return null;
        if (!this._czmRieng) this._czmRieng = new Map();
        const key = this.layKeyHienTai(frameNum);
        const boxes = this.layDanhSachBoxTrongFrame(frameNum);
        const sig = ThuatToanConcentricSurface.kyHieuBoxes(boxes);
        let czm = this._czmRieng.get(key);
        if (czm && czm.boxSignature !== sig) {
            try { if (!ThuatToanConcentricSurface.capNhatMiengVa(czm, boxes)) czm = null; } catch (e) { czm = null; }
        }
        if (czm) return czm;
        const fallbackPts = this.callbacks.getFramePts ? this.callbacks.getFramePts(frameNum) : null;
        const allowThreeJS = (frameNum === this.liveFrame);
        if (!allowThreeJS && !(fallbackPts && fallbackPts.length >= 20)) return null;
        const raw = ThuatToanSurface.layDiemToanBanDoRaw(fallbackPts, allowThreeJS);
        if (!raw) return null;
        try { czm = ThuatToanConcentricSurface.xayDungConcentricSurface(raw, boxes); } catch (e) { czm = null; }
        if (!czm) return null;
        this._czmRieng.set(key, czm);
        while (this._czmRieng.size > 8) this._czmRieng.delete(this._czmRieng.keys().next().value);
        return czm;
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
            t.contact = ct.contact === true;
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

    veLenCanvasTop(ctx, { fn, box, project, cw, ch }) {
        if (!this.isActive || !ctx || !box || !project) return;
        const res = this.laySurfaceChoVe(fn);
        if (!res || !res.data) return;

        const { data, srcFrame, borrowed } = res;
        const [bx, by, bz, , , rz = 0] = box;
        const co = Math.cos(rz), si = Math.sin(rz);

        // Chế độ Per-Vehicle Local Ground Patches trên Canvas 2D TOP View
        let localData = data.localPatchesData;
        if (!localData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const refData = this.laySurfaceFrame(this.liveFrame)?.localPatchesData || this._layLocalPatchesMau();
            if (refData) {
                localData = ThuatToanSurfaceCucBo.muonLocalPatches(refData, this.layDanhSachBoxTrongFrame(fn), fn);
                data.localPatchesData = localData;
            }
        }

        if (localData && localData.patches && localData.patches.length > 0 && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const items = [];
            if (localData.egoPatch) items.push(localData.egoPatch);
            for (const p of localData.patches) items.push(p);

            const projPt = (wx, wy, wz) => {
                const dx = wx - bx, dy = wy - by;
                const u = co * dx + si * dy;
                const v = -si * dx + co * dy;
                return project(u, v, wz - bz);
            };

            const pad = ThuatToanSurfaceCucBo.PATCH_VIS_PAD || 0.35;
            const styleOf = (status) => {
                if (status === 'ego') return { fill: 'rgba(56, 189, 248, 0.24)', stroke: '#38bdf8', dash: [] };
                if (status === 'anchor') return { fill: 'rgba(16, 185, 129, 0.26)', stroke: '#10b981', dash: [] };
                if (status === 'partial') return { fill: 'rgba(245, 158, 11, 0.26)', stroke: '#f59e0b', dash: [6, 3] };
                return { fill: 'rgba(168, 85, 247, 0.26)', stroke: '#a855f7', dash: [5, 4] };
            };

            ctx.save();
            // 1. Vẽ từng mảng cục bộ phẳng dưới mỗi xe (KHÔNG vẽ dây nối tham chiếu)
            let nAnc = 0, nPrt = 0, nRef = 0;
            for (const p of items) {
                if (p.status === 'anchor') nAnc++;
                else if (p.status === 'partial') nPrt++;
                else if (p.status === 'reference') nRef++;

                const hl = 0.5 * p.L + pad;
                const hw = 0.5 * p.W + pad;
                const cR = p.cosRz ?? Math.cos(p.rz || 0);
                const sR = p.sinRz ?? Math.sin(p.rz || 0);
                const corner = (lu, lv) => {
                    const wx = p.x + lu * cR - lv * sR;
                    const wy = p.y + lu * sR + lv * cR;
                    return projPt(wx, wy, ThuatToanSurfaceCucBo.evalPatchZ(p, wx, wy));
                };
                const q = [corner(-hl, -hw), corner(hl, -hw), corner(hl, hw), corner(-hl, hw)];
                if (q.every(pt => pt.x < -30) || q.every(pt => pt.x > cw + 30) ||
                    q.every(pt => pt.y < -30) || q.every(pt => pt.y > ch + 30)) {
                    continue;
                }

                const st = styleOf(p.status);
                ctx.beginPath();
                ctx.moveTo(q[0].x, q[0].y);
                ctx.lineTo(q[1].x, q[1].y);
                ctx.lineTo(q[2].x, q[2].y);
                ctx.lineTo(q[3].x, q[3].y);
                ctx.closePath();
                ctx.fillStyle = st.fill;
                ctx.fill();
                ctx.setLineDash(st.dash);
                ctx.lineWidth = 1.6;
                ctx.strokeStyle = st.stroke;
                ctx.stroke();
            }
            ctx.setLineDash([]);

            const curPatch = ThuatToanSurfaceCucBo.timPatchGanNhat(localData, bx, by);
            const zHere = curPatch ? ThuatToanSurfaceCucBo.evalPatchZ(curPatch, bx, by).toFixed(2) : '--';
            const tagTxt = `Surface Cục Bộ ${borrowed ? `≈F${srcFrame}` : `F${fn}`} • ${nAnc} ANC / ${nPrt} PRT / ${nRef} REF • Z:${zHere}m`;
            ctx.font = 'bold 10px "Segoe UI", sans-serif';
            const tw = ctx.measureText(tagTxt).width + 12;
            const bxLbl = 8, byLbl = ch - 24;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.86)';
            ctx.strokeStyle = 'rgba(16, 185, 129, 0.75)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.rect(bxLbl, byLbl, tw, 18);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = '#a7f3d0';
            ctx.fillText(tagTxt, bxLbl + 6, byLbl + 12);
            ctx.restore();
            return;
        }

        // Nếu đã bật Surface Cục Bộ: KHÔNG vẽ lưới 1649 ô hồng cũ
        if (typeof ThuatToanSurfaceCucBo !== 'undefined') return;

        if (!res.data.tiles || res.data.tiles.length === 0) return;
        const showSelection = (!borrowed && Number(fn) === this.currentFrame);

        const P = (x, y, t) => {
            const dx = x - bx, dy = y - by;
            const u = co * dx + si * dy;
            const v = -si * dx + co * dy;
            const zt = ThuatToanSurface.evalTileZ(t, x, y);
            return project(u, v, zt - bz);
        };

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
        const tagTxt = `Surface ${borrowed ? `≈F${srcFrame}` : `F${fn}`}${cRoad ? ` • Z:${cRoad.zRoad.toFixed(2)}m` : ''}`;
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

    veLenCanvasCat(ctx, { view, fn, box, toPx, sMin, sMax, halfDepth = 0.8, boxS = 0, boxBottomW = -0.8, S = 40, ch = 200 }) {
        if (!this.isActive || !ctx || !box || !toPx) return;
        const res = this.laySurfaceChoVe(fn);
        if (!res || !res.data) return;

        const { data, srcFrame, borrowed } = res;
        const [bx, by, bz, rx = 0, ry = 0, rz = 0] = box;
        const R = ThuatToanSurface.eulerXYZToMatrix(rx, ry, rz);
        const a = [R[0][0], R[1][0], R[2][0]];
        const b = [R[0][1], R[1][1], R[2][1]];
        const c = [R[0][2], R[1][2], R[2][2]];
        const seed = data.seedPlane;

        const rawPtsFn = (typeof window !== 'undefined' && window.pcdFrameCache?.get(fn)) || data?.rawPoints || null;
        const allBoxesFn = this.layDanhSachBoxTrongFrame(fn);

        const evalLocalW = (u, v) => {
            // [ƯU TIÊN 1 - TỔNG HỢP ĐA THUẬT TOÁN ENSEMBLE]: Tiên nghiệm hình thái map + vụn điểm xung quanh + ghép map
            if (typeof window !== 'undefined' && window._thuatToanGhepMapLiDAR) {
                const carBoxObj = {
                    x: bx, y: by, z: bz,
                    L: Number.isFinite(box[6]) ? box[6] : 4.5,
                    W: Number.isFinite(box[7]) ? box[7] : 1.9,
                    H: Number.isFinite(box[8]) ? box[8] : 1.6,
                    rz: rz
                };
                const mapRes = window._thuatToanGhepMapLiDAR.traCuuMatDuongChoHop(carBoxObj, fn, rawPtsFn, allBoxesFn);
                if (mapRes && Number.isFinite(mapRes.zc)) {
                    const qx = bx + u * a[0] + v * b[0];
                    const qy = by + u * a[1] + v * b[1];
                    const qz = bz + u * a[2] + v * b[2];
                    const zBase = mapRes.zc + (mapRes.gx || 0) * (qx - bx) + (mapRes.gy || 0) * (qy - by);
                    let denom = c[2] - (mapRes.gx || 0) * c[0] - (mapRes.gy || 0) * c[1];
                    if (Math.abs(denom) < 0.2) denom = c[2] >= 0 ? 1 : -1;
                    const w = (zBase - qz) / denom;
                    return {
                        w,
                        tile: {
                            id: `MAP_STITCH`,
                            type: 'road',
                            source: mapRes.source,
                            zc: mapRes.zc,
                            gx: mapRes.gx,
                            gy: mapRes.gy,
                            inlierCount: mapRes.sampleCount,
                            frames: mapRes.contributingFrames,
                            slopeDeg: mapRes.slopeDeg
                        }
                    };
                }
            }

            if (data && data.localPatchesData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
                const qx = bx + u * a[0] + v * b[0];
                const qy = by + u * a[1] + v * b[1];
                const locRes = ThuatToanSurfaceCucBo.evalLocalW(data.localPatchesData, qx, qy, box, u, v);
                if (locRes && Number.isFinite(locRes.w)) {
                    return {
                        w: locRes.w,
                        tile: {
                            id: `PATCH_${locRes.patchId}`,
                            type: 'road',
                            source: locRes.source || 'anchor',
                            zc: locRes.zBase,
                            gx: locRes.slopeX,
                            gy: locRes.slopeY
                        }
                    };
                }
            }
            if (data && data.czmData && typeof ThuatToanConcentricSurface !== 'undefined') {
                const qx = bx + u * a[0] + v * b[0];
                const qy = by + u * a[1] + v * b[1];
                const czmRes = ThuatToanConcentricSurface.evalLocalWCZM(data.czmData, qx, qy, box, u, v);
                if (czmRes && Number.isFinite(czmRes.w)) {
                    return {
                        w: czmRes.w,
                        tile: {
                            id: `CZM_${czmRes.binId}`,
                            type: 'road',
                            source: czmRes.source || 'czm',
                            zc: czmRes.zBase,
                            gx: czmRes.slopeX,
                            gy: czmRes.slopeY
                        }
                    };
                }
            }
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
            return { w, tile };
        };

        // [MẶT ĐƯỜNG CỤC BỘ DƯỚI XE]: CHỈ VẼ ĐOẠN THẲNG PHẲNG LÌ DƯỚI GẦM XE (CHUẨN ẢNH 1)
        let localData = data.localPatchesData;
        if (!localData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const refData = this.laySurfaceFrame(this.liveFrame)?.localPatchesData || this._layLocalPatchesMau();
            if (refData) {
                localData = ThuatToanSurfaceCucBo.muonLocalPatches(refData, this.layDanhSachBoxTrongFrame(fn), fn);
                data.localPatchesData = localData;
            }
        }

        if (localData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
            const patchActive = ThuatToanSurfaceCucBo.timPatchGanNhat(localData, bx, by);
            const allPatches = Array.isArray(localData.patches) ? localData.patches : [];
            const patchesToDraw = [...allPatches];
            if (patchActive && !patchesToDraw.includes(patchActive)) {
                patchesToDraw.push(patchActive);
            }

            if (patchesToDraw.length > 0) {
                ctx.save();

                // Chiếu tọa độ thế giới sang hệ (u, v, w) cục bộ của xe active
                const toLocalUVW = (wx, wy, wz) => {
                    const dx = wx - bx, dy = wy - by, dz = wz - bz;
                    return {
                        u: dx * a[0] + dy * a[1] + dz * a[2],
                        v: dx * b[0] + dy * b[1] + dz * b[2],
                        w: dx * c[0] + dy * c[1] + dz * c[2]
                    };
                };

                // Vẽ mặt đường phẳng lì cho TỪNG XE trong tầm nhìn (chuẩn 100% Ảnh 1)
                for (let i = 0; i < patchesToDraw.length; i++) {
                    const p = patchesToDraw[i];
                    if (!p) continue;

                    const isActive = (p === patchActive);
                    const Lbox = (isActive && Number.isFinite(box[6]) && box[6] > 0.2) ? box[6] : (p.L || 4.6);
                    const Wbox = (isActive && Number.isFinite(box[7]) && box[7] > 0.2) ? box[7] : (p.W || 1.9);

                    const carCenterX = isActive ? bx : p.x;
                    const carCenterY = isActive ? by : p.y;
                    const carRz = isActive ? rz : (p.rz || 0);
                    const cosR = Math.cos(carRz);
                    const sinR = Math.sin(carRz);

                    let X0, Y0, Z0, X1, Y1, Z1;
                    const zBotExpected = (isActive ? bz : (p.zBox || bz)) - 0.5 * (isActive ? ((Number.isFinite(box[8]) && box[8] > 0.2) ? box[8] : (p.H || 1.6)) : (p.H || 1.6));

                    // [TỔNG HỢP ĐA THUẬT TOÁN ENSEMBLE]: Mặt đường từ Hình thái map + Vụn điểm + Ghép map
                    let mapGround = null;
                    if (typeof window !== 'undefined' && window._thuatToanGhepMapLiDAR) {
                        const qBox = isActive ? {
                            x: bx, y: by, z: bz,
                            L: Lbox, W: Wbox, H: (Number.isFinite(box[8]) && box[8] > 0.2) ? box[8] : (p.H || 1.6),
                            rz: rz
                        } : {
                            x: p.x, y: p.y, z: p.zc || bz,
                            L: p.L || 4.6, W: p.W || 1.9, H: p.H || 1.6,
                            rz: p.rz || 0
                        };
                        mapGround = window._thuatToanGhepMapLiDAR.traCuuMatDuongChoHop(qBox, fn, rawPtsFn, allBoxesFn);
                    }

                    if (view === 'side') {
                        // View SIDE: Đoạn thẳng chạy dọc chiều dài xe
                        const halfSpan = 0.5 * Lbox + (isActive ? 0.35 : 0.25);
                        X0 = carCenterX - halfSpan * cosR;
                        Y0 = carCenterY - halfSpan * sinR;
                        X1 = carCenterX + halfSpan * cosR;
                        Y1 = carCenterY + halfSpan * sinR;
                        if (mapGround && Number.isFinite(mapGround.zc)) {
                            Z0 = mapGround.zc + (mapGround.gx || 0) * (X0 - carCenterX) + (mapGround.gy || 0) * (Y0 - carCenterY);
                            Z1 = mapGround.zc + (mapGround.gx || 0) * (X1 - carCenterX) + (mapGround.gy || 0) * (Y1 - carCenterY);
                        } else {
                            Z0 = ThuatToanSurfaceCucBo.evalPatchZ(p, X0, Y0);
                            Z1 = ThuatToanSurfaceCucBo.evalPatchZ(p, X1, Y1);
                            if (Math.abs(Z0 - zBotExpected) > 0.08) Z0 = Math.max(zBotExpected - 0.08, Math.min(zBotExpected + 0.08, Z0));
                            if (Math.abs(Z1 - zBotExpected) > 0.08) Z1 = Math.max(zBotExpected - 0.08, Math.min(zBotExpected + 0.08, Z1));
                        }
                    } else {
                        // View FRONT: Đoạn thẳng chạy ngang chiều rộng xe
                        const halfSpan = 0.5 * Wbox + (isActive ? 0.30 : 0.20);
                        X0 = carCenterX - halfSpan * (-sinR);
                        Y0 = carCenterY - halfSpan * cosR;
                        X1 = carCenterX + halfSpan * (-sinR);
                        Y1 = carCenterY + halfSpan * cosR;
                        if (mapGround && Number.isFinite(mapGround.zc)) {
                            Z0 = mapGround.zc + (mapGround.gx || 0) * (X0 - carCenterX) + (mapGround.gy || 0) * (Y0 - carCenterY);
                            Z1 = mapGround.zc + (mapGround.gx || 0) * (X1 - carCenterX) + (mapGround.gy || 0) * (Y1 - carCenterY);
                        } else {
                            Z0 = ThuatToanSurfaceCucBo.evalPatchZ(p, X0, Y0);
                            Z1 = ThuatToanSurfaceCucBo.evalPatchZ(p, X1, Y1);
                            if (Math.abs(Z0 - zBotExpected) > 0.08) Z0 = Math.max(zBotExpected - 0.08, Math.min(zBotExpected + 0.08, Z0));
                            if (Math.abs(Z1 - zBotExpected) > 0.08) Z1 = Math.max(zBotExpected - 0.08, Math.min(zBotExpected + 0.08, Z1));
                        }
                    }

                    const uvw0 = toLocalUVW(X0, Y0, Z0);
                    const uvw1 = toLocalUVW(X1, Y1, Z1);

                    // Lọc theo tầm nhìn:
                    // Chiều sâu (vuông góc lát cắt):
                    const depth = (view === 'side') ? Math.abs(0.5 * (uvw0.v + uvw1.v)) : Math.abs(0.5 * (uvw0.u + uvw1.u));
                    if (depth > 12.0) continue; // Xe ở quá xa ngoài lát cắt

                    // Chiều ngang màn hình:
                    const s0 = (view === 'side') ? uvw0.u : uvw0.v;
                    const s1 = (view === 'side') ? uvw1.u : uvw1.v;
                    if (Math.max(s0, s1) < sMin - 4 || Math.min(s0, s1) > sMax + 4) continue;

                    // Chiếu sang pixel màn hình
                    const p0 = toPx(uvw0.u, uvw0.v, uvw0.w);
                    const p1 = toPx(uvw1.u, uvw1.v, uvw1.w);
                    if (!p0 || !p1 || !Number.isFinite(p0.x) || !Number.isFinite(p0.y) || !Number.isFinite(p1.x) || !Number.isFinite(p1.y)) continue;

                    // 1. Dải mờ tiếp xúc mặt đất dưới đáy xe
                    ctx.beginPath();
                    ctx.moveTo(p0.x, p0.y);
                    ctx.lineTo(p1.x, p1.y);
                    ctx.lineTo(p1.x, p1.y + (isActive ? 6 : 4));
                    ctx.lineTo(p0.x, p0.y + (isActive ? 6 : 4));
                    ctx.closePath();
                    ctx.fillStyle = isActive
                        ? (p.status === 'anchor' ? 'rgba(16, 185, 129, 0.20)' : (p.status === 'partial' ? 'rgba(245, 158, 11, 0.20)' : 'rgba(168, 85, 247, 0.20)'))
                        : 'rgba(239, 68, 68, 0.18)';
                    ctx.fill();

                    // 2. Đoạn thẳng tiếp xúc phẳng lì
                    ctx.beginPath();
                    ctx.moveTo(p0.x, p0.y);
                    ctx.lineTo(p1.x, p1.y);
                    ctx.lineWidth = isActive ? 2.6 : 2.2;
                    ctx.strokeStyle = isActive
                        ? (p.status === 'anchor' ? '#10b981' : (p.status === 'partial' ? '#f59e0b' : '#c084fc'))
                        : '#ef4444'; // Đỏ tươi nổi bật chuẩn Ảnh 1 cho xe khác
                    ctx.stroke();

                    // 3. Hai chấm trắng ở hai đầu mút (chuẩn Ảnh 1)
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(p0.x - 2.5, p0.y - 2.5, 5, 5);
                    ctx.fillRect(p1.x - 2.5, p1.y - 2.5, 5, 5);
                }

                // 4. Hiện thông tin độ lệch đáy cho xe active trên HUD
                // 4. Hiện thông tin độ lệch đáy cho xe active trên HUD
                const midRes = evalLocalW(view === 'side' ? boxS : 0, view === 'side' ? 0 : boxS);
                if (midRes && Number.isFinite(midRes.w)) {
                    const deltaM = boxBottomW - midRes.w;
                    const cm = (deltaM * 100).toFixed(1);
                    const sign = deltaM > 0 ? '+' : '';
                    let patchTag = 'PATCH·REF ';
                    const tileSrc = midRes.tile?.source;
                    if (tileSrc === 'ridge_ensemble_map' || tileSrc === 'lidar_map_stitching') {
                        const fc = Array.isArray(midRes.tile.frames) ? midRes.tile.frames.length : 1;
                        patchTag = `MAP·STITCH(${fc}F) `;
                    } else if (tileSrc === 'scatter_prior_ensemble') {
                        patchTag = `MAP·SCATTER `;
                    } else if (tileSrc === 'map_morphology_prior') {
                        patchTag = `MAP·PRIOR `;
                    } else if (patchActive) {
                        patchTag = patchActive.status === 'anchor' ? 'PATCH·ANC ' : (patchActive.status === 'partial' ? 'PATCH·PRT ' : 'PATCH·REF ');
                    }

                    let tiltTxt = '';
                    const effGx = (midRes.tile && Number.isFinite(midRes.tile.gx)) ? midRes.tile.gx : (patchActive?.gx || 0);
                    const effGy = (midRes.tile && Number.isFinite(midRes.tile.gy)) ? midRes.tile.gy : (patchActive?.gy || 0);
                    if (Number.isFinite(effGx) && Number.isFinite(effGy)) {
                        const tgx = effGx, tgy = effGy;
                        const crz = Math.cos(rz), srz = Math.sin(rz);
                        const dw_ds = (view === 'side')
                            ? ((tgx + ry) * crz + (tgy - rx) * srz)
                            : (-(tgx + ry) * srz + (tgy - rx) * crz);
                        const tiltDeg = Math.atan(dw_ds) * (180 / Math.PI);
                        if (Math.abs(tiltDeg) >= 0.5) {
                            tiltTxt = ` | Dốc:${Math.abs(tiltDeg).toFixed(1)}°`;
                        }
                    }

                    const lbl = `${patchTag}Δđáy:${sign}${cm}cm${tiltTxt}`;
                    ctx.font = 'bold 10px "Segoe UI", sans-serif';
                    const tw = ctx.measureText(lbl).width + 10;
                    const isEnsemble = tileSrc && (tileSrc.startsWith('ridge') || tileSrc.startsWith('scatter') || tileSrc.startsWith('map') || tileSrc === 'lidar_map_stitching');
                    const isGood = Math.abs(deltaM) <= 0.025 && !tiltTxt;
                    ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
                    ctx.strokeStyle = isEnsemble ? 'rgba(52, 211, 153, 0.85)' : (isGood ? 'rgba(74, 222, 128, 0.7)' : 'rgba(244, 114, 182, 0.75)');
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.rect(8, ch - 23, tw, 17);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = isEnsemble ? '#34d399' : (isGood ? '#86efac' : '#fbcfe8');
                    ctx.fillText(lbl, 13, ch - 11);
                }

                ctx.restore();
                return;
            }
        }
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

    /**
     * [ĐỘ CAO TƯƠNG ĐỐI] Gom (h, p, r, σ) của chuỗi frame trong track → lamMuotTuongDoiTrack →
     * tái tạo m.info: zRoad = E_ego(bx, by) + ĥ, (gx, gy) = dốc Ego + quay ngược (p̂, r̂) theo rz.
     * matches phải cùng một track, đã sắp theo frame tăng dần.
     */
    lamMuotMatchesTheoDoCaoTuongDoi(matches) {
        const samples = [], owners = [];
        for (const m of matches) {
            const P = m.shape.points;
            const H = P[8];
            const smp = ThuatToanSurface.doDoCaoTuongDoi(m.data, m.info, {
                cx: P[0], cy: P[1], rz: P[5] || 0, L: P[6] || 4.4, W: P[7] || 1.9,
                H, zBottom: P[2] - H / 2, pts: m.pts
            });
            if (!smp) continue;
            smp.frame = m.frame;
            samples.push(smp);
            owners.push(m);
        }
        if (samples.length < 2) return 0;

        const out = ThuatToanSurface.lamMuotTuongDoiTrack(samples);
        for (let k = 0; k < out.length; k++) {
            const o = out[k], smp = samples[k], m = owners[k];
            const c = Math.cos(smp.rz), s = Math.sin(smp.rz);
            const gx = ThuatToanSurface.clamp(smp.ego.gx + o.p * c - o.r * s, -0.16, 0.16);
            const gy = ThuatToanSurface.clamp(smp.ego.gy + o.p * s + o.r * c, -0.16, 0.16);
            m.info = { ...m.info, zRoad: smp.E + o.h, gx, gy, rx: gy, ry: -gx, smoothed: true, rejected: o.rejected };
        }
        return out.length;
    }

    async apDungSurfaceXuongBoxes(mode = 'active_track') {
        if (this._isApplying) return;
        this._isApplying = true;
        try {
            const trActive = this.callbacks.getActiveTrack ? this.callbacks.getActiveTrack() : null;
            if (mode === 'active_track' && (!trActive || !Array.isArray(trActive.shapes))) {
                this.hienToast('⚠️ Không tìm thấy Track đang mở!');
                return;
            }

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

            // [ĐỘ CAO TƯƠNG ĐỐI] active_track: đo thêm các frame ngữ cảnh ±3 của track để làm mượt, nhưng chỉ ghi vào frame mục tiêu
            const targetSet = new Set(framesToApply);
            let framesToMeasure = framesToApply;
            if (mode === 'active_track') {
                const ctx = new Set(framesToApply);
                for (const s of trActive.shapes) {
                    if (!s || s.outside || !(s.points?.length >= 9)) continue;
                    const f = Number(s.frame);
                    if (Number.isFinite(f) && framesToApply.some(t => Math.abs(t - f) <= 3)) ctx.add(f);
                }
                framesToMeasure = [...ctx].sort((a, b) => a - b);
            }

            // Nạp LiDAR cho các frame chưa có điểm trong cache trước khi hạ
            const needLoad = framesToMeasure.some(fn => {
                const pts = this.callbacks.getFramePts ? this.callbacks.getFramePts(fn) : null;
                return !(pts && pts.length >= 20) && fn !== this.liveFrame;
            });
            if (needLoad && typeof this.callbacks.napLiDAR === 'function') {
                await this.callbacks.napLiDAR(new Set(framesToMeasure));
            }

            let matches = [];
            const affectedFrames = new Set();

            for (let idx = 0; idx < framesToMeasure.length; idx++) {
                const fn = framesToMeasure[idx];
                let frameData = this.tinhSurfaceChoFrame(fn, false);
                if (!frameData) {
                    frameData = this.laySurfaceChoVe(fn)?.data || null;
                }
                if (!frameData) continue;

                const framePts = this.callbacks.getFramePts ? this.callbacks.getFramePts(fn) : null;

                if (mode === 'active_track') {
                    const sh = trActive.shapes.find(s => Number(s.frame) === fn && !s.outside && s.points?.length >= 9);
                    if (!sh) continue;
                    const info = ThuatToanSurface.layMatDuongChoBox(frameData, sh.points[0], sh.points[1], sh.points[5] || 0, sh.points[6] || 4.4, sh.points[7] || 1.9, framePts);
                    if (info) {
                        const write = targetSet.has(fn);
                        matches.push({ frame: fn, track: trActive, shape: sh, info, materialize: false, data: frameData, pts: framePts, write });
                        if (write) affectedFrames.add(fn);
                    }
                } else {
                    const boxes = this.layDanhSachBoxTrongFrame(fn);
                    for (const b of boxes) {
                        if (hasSel) {
                            const inRect = selRects.some(
                                r => b.cx >= r.x0 - 1e-6 && b.cx <= r.x1 + 1e-6 && b.cy >= r.y0 - 1e-6 && b.cy <= r.y1 + 1e-6
                            );
                            if (!inRect) continue;
                        }
                        const info = ThuatToanSurface.layMatDuongChoBox(frameData, b.cx, b.cy, b.shape.points[5] || 0, b.shape.points[6] || 4.4, b.shape.points[7] || 1.9, framePts);
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

            if (mode === 'active_track') {
                this.lamMuotMatchesTheoDoCaoTuongDoi(matches);
                matches = matches.filter(m => m.write);
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

            const touchedTracks = [...new Set(matches.map(m => m.track).filter(Boolean))];
            if (this.callbacks.saveUndo) this.callbacks.saveUndo(touchedTracks);

            let updatedCount = 0;
            for (const m of matches) {
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
            this.hienToast(`🌸 Đã hạ khít ${updatedCount} box (${fTxt}) theo mặt đường Surface!`);
        } finally {
            this._isApplying = false;
        }
    }

    // =========================================================================
    // 9. GIAO DIỆN NỔI SURFACE PANEL + TOOLTIP 3D (GLASSMORPHISM DARK MODE)
    // =========================================================================

    damBaoStyleTonTai() {
        if (typeof document === 'undefined' || document.getElementById('cvat-surface-style')) return;
        const style = document.createElement('style');
        style.id = 'cvat-surface-style';
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
                width: auto;
                min-width: 245px;
                max-width: 315px;
                height: auto !important;
            }
            #cvat-surface-panel.is-collapsed .surf-body {
                display: none !important;
            }
            #cvat-surface-panel.is-collapsed .surf-header {
                border-bottom: none;
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
        if (!this._tooltipEl) {
            this._tooltipEl = document.createElement('div');
            this._tooltipEl.id = 'cvat-surface-tooltip';
            document.body.appendChild(this._tooltipEl);
        }
        if (this._panelEl) return this._panelEl;

        const panel = document.createElement('div');
        panel.id = 'cvat-surface-panel';
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
            <div class="surf-body">
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
            const d = this.tinhHoacNapSurfaceFrame(true, false);
            this.veLaiToanBo(true);
            if (d) {
                const seedInfo = d.seedPlane ? ` (Z₀=${d.seedPlane.z0.toFixed(2)}m)` : '';
                this.hienToast(`🔄 Đã tính lại sạch Surface Frame ${this.currentFrame} theo LiDAR gốc${seedInfo}!`);
            }
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
        const srcTxt = tile.contact ? 'Neo bánh xe' : tile.source === 'extrapolated' ? 'Nội suy' : tile.source === 'occluded' ? 'Nội suy gầm xe' : (tile.manual ? 'Chỉnh tay' : `${tile.nGroundPts}đ`);
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

        if (!data) {
            if (sub) sub.textContent = `Frame ${this.currentFrame} (3D: F${this.liveFrame}) • Đang chờ điểm LiDAR`;
            if (cntEl) cntEl.textContent = '0';
            if (selEl) selEl.textContent = 'Chưa chọn';
            if (listEl) listEl.innerHTML = '<div style="color:#94a3b8;text-align:center;padding:8px;">Chưa nạp được điểm LiDAR cho Frame này</div>';
            return;
        }

        if (sub) {
            if (data.localPatchesData && typeof ThuatToanSurfaceCucBo !== 'undefined') {
                const lp = data.localPatchesData;
                sub.textContent = `F${this.currentFrame} (3D: F${this.liveFrame}) • ${lp.patches.length} xe • ${lp.anchorsCount} Anchor (Mặt Đường Cục Bộ)`;
            } else {
                sub.textContent = `F${this.currentFrame} (3D: F${this.liveFrame}) • ${data.tiles.length} ô • ${data.layers.length} lớp`;
            }
        }
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

        if (dataFocus) {
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
                if (this.laySurfaceFrame(this.liveFrame) && this._overlayObjects.some(item => !item.obj || !item.scene || item.obj.parent !== item.scene)) {
                    this.veSurfaceLen3D();
                }
            }
        }, 300);
    }

    tat() {
        this.isActive = false;
        this.cheDoChonTrenTop = false;
        this._queuedFrames.clear();
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
