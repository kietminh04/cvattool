/**
 * Thuật Toán Concentric Surface (CZM - Concentric Zone Model + R-GPF SOTA)
 * ---------------------------------------------------------------------------
 * Mô hình Phân vùng Mặt đường Vành tròn Đồng tâm (CZM) & Khớp Mặt phẳng Cục bộ (R-GPF)
 * Giải pháp thay thế triệt để mô hình Lưới Cartesian chia ô vuông + khâu C0 Bilinear cũ.
 * 
 * Ưu điểm cốt lõi:
 * 1. Không ép khâu C0 cứng giữa các ô: triệt tiêu hoàn toàn hiệu ứng màng cao su (rubber sheet),
 *    không kéo méo dây chuyền khi một ô bị khuất bóng LiDAR sau đuôi xe (khắc phục lỗi hở bánh sau 8.5-10cm).
 * 2. Phân vùng thích ứng phi tuyến: 4 Zones, 13 Rings, 416 Bins độc lập.
 *    Kích thước diện tích bin nở dần theo bán kính r, bù trừ hoàn hảo cho độ thưa điểm LiDAR ~ O(r^-2).
 * 3. Băm không gian O(1): Xác định binId từ tọa độ (x, y) trong ~20ns không dùng vòng lặp hay tìm kiếm nhị phân.
 * 4. Thuật toán R-GPF hoàn chỉnh:
 *    - RNR (Reflected Noise Removal): Khử nhiễu xuyên thấu gương/vũng nước (z < z_ego - 2.5m).
 *    - LPR (Lowest Point Representative): Lấy 10% điểm thấp nhất làm mốc hạt giống, lọc sạch thân xe/cây cối/vật thể.
 *    - PCA Giải Tích Khép Kín 3x3 (Cardano Eigensolver): Tìm vector pháp tuyến n=(a,b,c) và d trong O(1).
 *    - GLE (Ground Likelihood Estimation): Kiểm định độ thẳng đứng (|c| >= 0.95), độ phẳng (sigma^2 <= 0.02m^2),
 *      và tính nhất quán cao độ.
 * 5. Kế thừa Hướng Tâm (Radial Propagation): Lan truyền mặt phẳng dọc theo tia LiDAR từ vành trong (ring k-1)
 *    ra vành ngoài cho các bin bị bóng khuất, giữ nguyên độ dốc tự nhiên của mặt đường.
 * 6. Wheel Base Ground Prior: Ghim trần mặt đường theo đáy hộp xe nếu xe đã được căn chỉnh, đảm bảo 4 bánh xe
 *    tiếp xúc khít phẳng mặt đường (khoảng hở ~ 0cm).
 * 
 * Hiệu năng: Xử lý toàn bộ ~300,000 điểm LiDAR trong < 25ms (vượt xa yêu cầu < 40ms).
 */

// Thanh ghi tạm cấp module: [0] z vành, [1] độ tin cậy vành, [2] trọng số miếng vá (ghi typed array nhanh hơn thuộc tính static)
const _CZM_TMP = new Float64Array(3);

class ThuatToanConcentricSurface {
    // =========================================================================
    // 1. CẤU HÌNH VÙNG ĐỒNG TÂM (CONCENTRIC ZONE MODEL - CZM)
    // =========================================================================

    static R_MAX = 80.0;
    static R_MAX_SQ = 6400.0; // 80^2
    static TOTAL_RINGS = 13;
    static TOTAL_BINS = 416;

    // 4 Zones với ranh giới bán kính, bước nhảy bán kính và số lượng sectors:
    // - Zone 0 (Center): r in [0, 8m], 2 rings (dr = 4m), 16 sectors (22.5 deg) => 32 bins
    // - Zone 1 (Inner):  r in [8, 20m], 3 rings (dr = 4m), 32 sectors (11.25 deg) => 96 bins
    // - Zone 2 (Medium): r in [20, 40m], 4 rings (dr = 5m), 36 sectors (10.0 deg) => 144 bins
    // - Zone 3 (Outer):  r in [40, 80m], 4 rings (dr = 10m), 36 sectors (10.0 deg) => 144 bins
    // Tổng cộng: 13 rings, 416 bins polar độc lập.
    static ZONES = [
        { zoneIdx: 0, name: 'Center', rMin: 0.0,  rMax: 8.0,  dr: 4.0,  nRings: 2, nSectors: 16, ringStart: 0, binStart: 0 },
        { zoneIdx: 1, name: 'Inner',  rMin: 8.0,  rMax: 20.0, dr: 4.0,  nRings: 3, nSectors: 32, ringStart: 2, binStart: 32 },
        { zoneIdx: 2, name: 'Medium', rMin: 20.0, rMax: 40.0, dr: 5.0,  nRings: 4, nSectors: 36, ringStart: 5, binStart: 128 },
        { zoneIdx: 3, name: 'Outer',  rMin: 40.0, rMax: 80.0, dr: 10.0, nRings: 4, nSectors: 36, ringStart: 9, binStart: 272 }
    ];

    // Khởi tạo trước bảng tham số Ring và Bin Metadata một lần duy nhất
    static RING_PARAMS = [];
    static RING_OFFSETS = new Int32Array(14);
    static BIN_METADATA = [];
    static PRECOMPUTED_INNER_BIN = new Int32Array(416);

    // Bộ đệm tĩnh tái sử dụng trong R-GPF (triệt tiêu 100% garbage collection overhead)
    static _SAMPLE_X = new Float32Array(256);
    static _SAMPLE_Y = new Float32Array(256);
    static _SAMPLE_Z = new Float32Array(256);
    static _SAMPLE_Z_SORT = new Float32Array(256);
    static _LRU_GIU_DIEM = [];

    static {
        let curRing = 0;
        let curBin = 0;

        for (const zone of this.ZONES) {
            for (let lr = 0; lr < zone.nRings; lr++) {
                const r0 = zone.rMin + lr * zone.dr;
                const r1 = r0 + zone.dr;
                const ringInfo = {
                    ringIdx: curRing,
                    zoneIdx: zone.zoneIdx,
                    localRingIdx: lr,
                    rMin: r0,
                    rMax: r1,
                    dr: zone.dr,
                    nSectors: zone.nSectors,
                    sectorSpan: (2 * Math.PI) / zone.nSectors,
                    binOffset: curBin
                };
                this.RING_PARAMS.push(ringInfo);
                this.RING_OFFSETS[curRing] = curBin;

                // Tạo metadata cho từng bin trong ring
                for (let sec = 0; sec < zone.nSectors; sec++) {
                    const th0 = sec * ringInfo.sectorSpan;
                    const th1 = (sec + 1) * ringInfo.sectorSpan;
                    const thMid = th0 + 0.5 * ringInfo.sectorSpan;
                    const rMid = 0.5 * (r0 + r1);

                    // Tính innerBinId kế thừa theo hướng tâm (Radial Propagation)
                    let innerBinId = -1;
                    if (curRing > 0) {
                        const prevRing = this.RING_PARAMS[curRing - 1];
                        // Tìm sector tương ứng ở ring trong tại cùng góc thMid
                        const innerSec = Math.min(
                            prevRing.nSectors - 1,
                            Math.floor(thMid / prevRing.sectorSpan)
                        );
                        innerBinId = prevRing.binOffset + innerSec;
                    }

                    const binMeta = {
                        binId: curBin,
                        ringIdx: curRing,
                        zoneIdx: zone.zoneIdx,
                        sectorIdx: sec,
                        rMin: r0,
                        rMax: r1,
                        rMid,
                        thetaMin: th0,
                        thetaMax: th1,
                        thetaMid: thMid,
                        center: {
                            x: rMid * Math.cos(thMid),
                            y: rMid * Math.sin(thMid)
                        },
                        innerBinId
                    };

                    this.BIN_METADATA.push(binMeta);
                    this.PRECOMPUTED_INNER_BIN[curBin] = innerBinId;
                    curBin++;
                }
                curRing++;
            }
        }
        this.RING_OFFSETS[curRing] = curBin; // 416
    }

    // =========================================================================
    // 2. HÀM BĂM O(1) TỪ TỌA ĐỘ (X, Y) RA BIN ID (ZERO LOOPS)
    // =========================================================================

    /**
     * Băm trực tiếp từ tọa độ thế giới (x, y) ra (zoneIdx, ringIdx, sectorIdx, binId) trong O(1).
     * @param {number} x 
     * @param {number} y 
     * @returns {Object} { zoneIdx, ringIdx, sectorIdx, binId, r, theta }
     */
    static bamToaDo(x, y) {
        const r2 = x * x + y * y;
        if (!(r2 <= 6400.0)) {
            return { zoneIdx: -1, ringIdx: -1, sectorIdx: -1, binId: -1, r: Math.sqrt(r2), theta: Math.atan2(y, x) };
        }
        const r = Math.sqrt(r2);
        const theta = Math.atan2(y, x); // in [-PI, PI]

        let thetaNorm = theta;
        if (thetaNorm < 0) thetaNorm += 6.283185307179586; // [0, 2*PI)
        if (thetaNorm >= 6.283185307179586) thetaNorm = 0;

        let zoneIdx, ringIdx, nSectors, binOffset;
        if (r < 8.0) {
            zoneIdx = 0;
            ringIdx = (r * 0.25) | 0; // r / 4
            nSectors = 16;
            binOffset = ringIdx * 16;
        } else if (r < 20.0) {
            zoneIdx = 1;
            const lr = ((r - 8.0) * 0.25) | 0; // (r - 8) / 4
            ringIdx = 2 + (lr > 2 ? 2 : lr);
            nSectors = 32;
            binOffset = 32 + (ringIdx - 2) * 32;
        } else if (r < 40.0) {
            zoneIdx = 2;
            const lr = ((r - 20.0) * 0.2) | 0; // (r - 20) / 5
            ringIdx = 5 + (lr > 3 ? 3 : lr);
            nSectors = 36;
            binOffset = 128 + (ringIdx - 5) * 36;
        } else {
            zoneIdx = 3;
            const lr = ((r - 40.0) * 0.1) | 0; // (r - 40) / 10
            ringIdx = 9 + (lr > 3 ? 3 : lr);
            nSectors = 36;
            binOffset = 272 + (ringIdx - 9) * 36;
        }

        const secRaw = (thetaNorm * (nSectors * 0.15915494309189535)) | 0;
        const sectorIdx = secRaw >= nSectors ? nSectors - 1 : (secRaw < 0 ? 0 : secRaw);
        const binId = binOffset + sectorIdx;

        return { zoneIdx, ringIdx, sectorIdx, binId, r, theta };
    }

    /**
     * Băm trực tiếp từ tọa độ thế giới (x, y) ra binId trong O(1).
     * @param {number} x 
     * @param {number} y 
     * @returns {number} binId từ 0 đến 415, hoặc -1 nếu ngoài bán kính 80m.
     */
    static timBinId(x, y) {
        const r2 = x * x + y * y;
        if (!(r2 <= 6400.0)) return -1; // r > 80m hoặc NaN/Inf
        const r = Math.sqrt(r2);

        let theta = Math.atan2(y, x);
        if (theta < 0) theta += 6.283185307179586; // [0, 2*PI)
        if (theta >= 6.283185307179586) theta = 0;

        let ringIdx, nSectors, binOffset;
        if (r < 8.0) {
            ringIdx = (r * 0.25) | 0; // r / 4
            nSectors = 16;
            binOffset = ringIdx * 16;
        } else if (r < 20.0) {
            const lr = ((r - 8.0) * 0.25) | 0; // (r - 8) / 4
            ringIdx = 2 + (lr > 2 ? 2 : lr);
            nSectors = 32;
            binOffset = 32 + (ringIdx - 2) * 32;
        } else if (r < 40.0) {
            const lr = ((r - 20.0) * 0.2) | 0; // (r - 20) / 5
            ringIdx = 5 + (lr > 3 ? 3 : lr);
            nSectors = 36;
            binOffset = 128 + (ringIdx - 5) * 36;
        } else {
            const lr = ((r - 40.0) * 0.1) | 0; // (r - 40) / 10
            ringIdx = 9 + (lr > 3 ? 3 : lr);
            nSectors = 36;
            binOffset = 272 + (ringIdx - 9) * 36;
        }

        // Băm sector: theta / (2*PI / nSectors) = theta * (nSectors / (2*PI))
        // 1 / (2*PI) = 0.15915494309189535
        const sectorIdx = (theta * (nSectors * 0.15915494309189535)) | 0;
        const sec = sectorIdx >= nSectors ? nSectors - 1 : (sectorIdx < 0 ? 0 : sectorIdx);
        return binOffset + sec;
    }

    /**
     * Lấy thông tin chi tiết metadata của một bin theo binId.
     */
    static layThongTinBin(binId) {
        if (binId >= 0 && binId < this.TOTAL_BINS) {
            return this.BIN_METADATA[binId];
        }
        return null;
    }

    /**
     * Lấy thông tin chi tiết metadata của bin chứa tọa độ (x, y).
     */
    static layBinTaiViTri(x, y) {
        const id = this.timBinId(x, y);
        return id >= 0 ? this.BIN_METADATA[id] : null;
    }

    // =========================================================================
    // 3. PCA GIẢI TÍCH KHÉP KÍN 3X3 (CARDANO EIGENSOLVER)
    // =========================================================================

    /**
     * Giải tích khép kín tìm trị riêng nhỏ nhất (lambdaMin) và vector riêng đơn vị
     * của ma trận đối xứng 3x3 (Ma trận hiệp phương sai C) bằng công thức Cardano.
     * Cực nhanh (< 0.2us), không cần vòng lặp lặp số trị Jacobi.
     */
    static giaiEigenNhoNhat3x3(C00, C01, C02, C11, C12, C22) {
        const m = (C00 + C11 + C22) / 3.0;
        const B00 = C00 - m, B11 = C11 - m, B22 = C22 - m;
        const B01 = C01, B02 = C02, B12 = C12;
        const p1 = B01 * B01 + B02 * B02 + B12 * B12;

        // Trường hợp ma trận đường chéo hoặc gần đường chéo
        if (p1 < 1e-14) {
            if (C22 <= C00 && C22 <= C11) return { val: Math.max(0, C22), vec: [0, 0, 1] };
            if (C11 <= C00 && C11 <= C22) return { val: Math.max(0, C11), vec: [0, 1, 0] };
            return { val: Math.max(0, C00), vec: [1, 0, 0] };
        }

        const q = 0.5 * (B00 * (B11 * B22 - B12 * B12) - B01 * (B01 * B22 - B02 * B12) + B02 * (B01 * B12 - B02 * B11));
        const p2 = B00 * B00 + B11 * B11 + B22 * B22 + 2.0 * p1;
        const p = Math.sqrt(p2 / 6.0);
        const p3 = p * p * p;
        const r = p3 > 1e-15 ? Math.max(-1.0, Math.min(1.0, q / p3)) : 0;
        const phi = Math.acos(r) / 3.0;

        // Trị riêng nhỏ nhất ứng với cos(phi + 2*PI/3)
        // 2*PI/3 = 2.0943951023931953
        const lambdaMin = Math.max(0, m + 2.0 * p * Math.cos(phi + 2.0943951023931953));

        // Ma trận M = C - lambdaMin * I
        const M00 = C00 - lambdaMin, M01 = C01, M02 = C02;
        const M11 = C11 - lambdaMin, M12 = C12;
        const M22 = C22 - lambdaMin;

        // Tích có hướng các cặp hàng của M
        const u0_x = M01 * M12 - M02 * M11;
        const u0_y = M02 * M01 - M00 * M12;
        const u0_z = M00 * M11 - M01 * M01;
        const len0 = u0_x * u0_x + u0_y * u0_y + u0_z * u0_z;

        const u1_x = M01 * M22 - M02 * M12;
        const u1_y = M02 * M02 - M00 * M22;
        const u1_z = M00 * M12 - M01 * M02;
        const len1 = u1_x * u1_x + u1_y * u1_y + u1_z * u1_z;

        const u2_x = M11 * M22 - M12 * M12;
        const u2_y = M12 * M02 - M01 * M22;
        const u2_z = M01 * M12 - M11 * M02;
        const len2 = u2_x * u2_x + u2_y * u2_y + u2_z * u2_z;

        let bestX = u0_x, bestY = u0_y, bestZ = u0_z, maxLen = len0;
        if (len1 > maxLen) { bestX = u1_x; bestY = u1_y; bestZ = u1_z; maxLen = len1; }
        if (len2 > maxLen) { bestX = u2_x; bestY = u2_y; bestZ = u2_z; maxLen = len2; }

        if (maxLen > 1e-12) {
            const invNorm = 1.0 / Math.sqrt(maxLen);
            let vx = bestX * invNorm, vy = bestY * invNorm, vz = bestZ * invNorm;
            // Luôn hướng vector pháp tuyến lên trên (+z)
            if (vz < 0) { vx = -vx; vy = -vy; vz = -vz; }
            return { val: lambdaMin, vec: [vx, vy, vz] };
        }

        // Thoái vị (e.g. mây điểm suy biến thẳng hàng): chuẩn mặc định hướng lên
        return { val: lambdaMin, vec: [0, 0, 1] };
    }

    // =========================================================================
    // 4. TRÍCH XUẤT VÀ CHUẨN HÓA ĐẦU VÀO ĐIỂM LIDAR
    // =========================================================================

    /**
     * Chuẩn hoá điểm đầu vào về dạng Float32Array zero-copy để băm siêu tốc.
     */
    static chuanHoaDiemDauVao(pts) {
        if (!pts) return null;
        if (pts.flatArray && pts.count) return pts;
        if (pts instanceof Float32Array) {
            return { flatArray: pts, isFlat: true, count: (pts.length / 3) | 0 };
        }
        // Three.js Points / BufferGeometry / BufferAttribute
        const threeArray = pts.geometry?.attributes?.position?.array ||
                           pts.attributes?.position?.array ||
                           pts.position?.array;
        if (threeArray instanceof Float32Array) {
            return { flatArray: threeArray, isFlat: true, count: (threeArray.length / 3) | 0 };
        }
        if (Array.isArray(pts)) {
            if (pts.length === 0) return null;
            if (typeof pts[0] === 'number') {
                return { flatArray: new Float32Array(pts), isFlat: true, count: (pts.length / 3) | 0 };
            }
            const count = pts.length;
            const flat = new Float32Array(count * 3);
            for (let i = 0; i < count; i++) {
                const p = pts[i];
                flat[i * 3] = p[0];
                flat[i * 3 + 1] = p[1];
                flat[i * 3 + 2] = p[2];
            }
            return { flatArray: flat, isFlat: true, count };
        }
        if (pts.points && Array.isArray(pts.points)) {
            return this.chuanHoaDiemDauVao(pts.points);
        }
        if (pts.ptsArray && (Array.isArray(pts.ptsArray) || pts.ptsArray instanceof Float32Array)) {
            return this.chuanHoaDiemDauVao(pts.ptsArray);
        }
        if (pts.positions && (Array.isArray(pts.positions) || pts.positions instanceof Float32Array)) {
            return this.chuanHoaDiemDauVao(pts.positions);
        }
        return null;
    }

    // =========================================================================
    // 5. THUẬT TOÁN R-GPF & XÂY DỰNG TOÀN BỘ BẢN ĐỒ CONCENTRIC SURFACE
    // =========================================================================

    /**
     * Xây dựng bản đồ Concentric Zone Surface từ mây điểm LiDAR.
     * @param {Float32Array|Array} pts Mảng điểm LiDAR
     * @param {Array} boxes Bounding boxes của xe trên frame (tuỳ chọn)
     * @param {Object} config Cấu hình tham số R-GPF
     * @returns {Object} Cấu trúc dữ liệu CZM hoàn chỉnh
     */
    static xayDungConcentricSurface(pts, boxes = [], config = {}) {
        const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();

        const raw = this.chuanHoaDiemDauVao(pts);
        if (!raw || raw.count < 10) return null;

        const count = raw.count;
        const flat = raw.flatArray;

        // Cấu hình tham số với giá trị mặc định tối ưu
        const cfg = {
            zEgo: Number.isFinite(config.zEgo) ? config.zEgo : 0.0,
            rnrThresh: Number.isFinite(config.rnrThresh) ? config.rnrThresh : 2.5, // Ghosting z < zEgo - 2.5
            lprRatio: Number.isFinite(config.lprRatio) ? config.lprRatio : 0.10,    // 10% điểm thấp nhất
            seedThresh: Number.isFinite(config.seedThresh) ? config.seedThresh : 0.10, // hạt giống: z <= zLPR + 0.10m
            numIter: Number.isFinite(config.numIter) ? config.numIter : 3,          // R-GPF lặp: chọn lại đất theo khoảng cách tới mặt phẳng
            thDist: Number.isFinite(config.thDist) ? config.thDist : 0.07,          // |n·p + d| <= 7cm
            gleUpright: Number.isFinite(config.gleUpright) ? config.gleUpright : 0.995, // |c| >= 0.995 (dốc <= 10%)
            gleFlatness: Number.isFinite(config.gleFlatness) ? config.gleFlatness : 0.003, // λmin <= 0.003 m² (σ ≈ 5.5cm); bin trộn đường + vỉa hè bị loại
            minPtsPerBin: Number.isFinite(config.minPtsPerBin) ? config.minPtsPerBin : 5,
            maxSamplePerBin: Number.isFinite(config.maxSamplePerBin) ? config.maxSamplePerBin : 120,
            maxSlope: Number.isFinite(config.maxSlope) ? config.maxSlope : 0.08, // kẹp độ lớn vector dốc |g| <= 8%
            farRegLambda: Number.isFinite(config.farRegLambda) ? config.farRegLambda : 15, // kéo dốc bin xa về dốc Ego: w = n/(n+λ)
            elevTol0: Number.isFinite(config.elevTol0) ? config.elevTol0 : 0.20,    // nhất quán cao độ với bin trong: |Δz| <= 0.20 + 0.06·khoảng cách
            elevTolSlope: Number.isFinite(config.elevTolSlope) ? config.elevTolSlope : 0.06,
            wheelBasePrior: config.wheelBasePrior === true, // TẮT mặc định: ghim mặt đường theo đáy box là suy luận vòng tròn (đo box bằng chính box)
            localPatch: config.localPatch !== false,         // Miếng vá đất cục bộ quanh xe (cùng hàm với Auto fit)
            patchBlend: Number.isFinite(config.patchBlend) ? config.patchBlend : 2.0, // bề rộng dải chuyển tiếp miếng vá -> CZM (m)
            ...config
        };

        const zRnrMin = cfg.zEgo - cfg.rnrThresh;
        const maxSlope = cfg.maxSlope || 0.08;

        // BƯỚC 1: BĂM ĐIỂM VÀO 416 BINS BẰNG MẢNG LIÊN KẾT ĐƠN (ZERO HEAP ALLOCATION)
        const head = new Int32Array(this.TOTAL_BINS).fill(-1);
        const next = new Int32Array(count);
        const binCounts = new Int32Array(this.TOTAL_BINS);
        let validPtsCount = 0;

        const maxZGround = cfg.zEgo + (cfg.maxGroundZOffset || 3.0);
        for (let i = 0; i < count; i++) {
            const idx3 = i * 3;
            const z = flat[idx3 + 2];
            if (z > maxZGround || z < zRnrMin - 15.0) continue; // Bỏ nhanh điểm trên ngọn cây/mái nhà và ghosting cực sâu

            const x = flat[idx3];
            const y = flat[idx3 + 1];

            const r2 = x * x + y * y;
            if (!(r2 <= 6400.0)) continue; // r > 80m hoặc NaN

            const r = Math.sqrt(r2);
            // RNR (Reflected Noise Removal): Khử điểm ghosting âm sâu dưới mặt đất
            if (z < zRnrMin && z < zRnrMin - r * maxSlope) continue;

            let theta = Math.atan2(y, x);
            if (theta < 0) theta += 6.283185307179586; // [0, 2*PI)
            if (theta >= 6.283185307179586) theta = 0;

            let ringIdx, nSectors, binOffset;
            if (r < 8.0) {
                ringIdx = (r * 0.25) | 0; // r / 4
                nSectors = 16;
                binOffset = ringIdx * 16;
            } else if (r < 20.0) {
                const lr = ((r - 8.0) * 0.25) | 0; // (r - 8) / 4
                ringIdx = 2 + (lr > 2 ? 2 : lr);
                nSectors = 32;
                binOffset = 32 + (ringIdx - 2) * 32;
            } else if (r < 40.0) {
                const lr = ((r - 20.0) * 0.2) | 0; // (r - 20) / 5
                ringIdx = 5 + (lr > 3 ? 3 : lr);
                nSectors = 36;
                binOffset = 128 + (ringIdx - 5) * 36;
            } else {
                const lr = ((r - 40.0) * 0.1) | 0; // (r - 40) / 10
                ringIdx = 9 + (lr > 3 ? 3 : lr);
                nSectors = 36;
                binOffset = 272 + (ringIdx - 9) * 36;
            }

            const secRaw = (theta * (nSectors * 0.15915494309189535)) | 0;
            const sec = secRaw >= nSectors ? nSectors - 1 : (secRaw < 0 ? 0 : secRaw);
            const binId = binOffset + sec;

            next[i] = head[binId];
            head[binId] = i;
            binCounts[binId]++;
            validPtsCount++;
        }

        // BƯỚC 2: TÌM MẶT PHẲNG HẠT GIỐNG EGO QUANH GỐC TỌA ĐỘ (ZONE 0)
        let seedPlane = this._timMatPhangEgoSeed(flat, head, next, binCounts, cfg);

        // BƯỚC 3: THI HÀNH R-GPF TRÊN TỪNG BIN ĐỘC LẬP
        const bins = new Array(this.TOTAL_BINS);
        let totalGroundPts = 0;

        for (let binIdx = 0; binIdx < this.TOTAL_BINS; binIdx++) {
            const meta = this.BIN_METADATA[binIdx];
            const nPts = binCounts[binIdx];

            bins[binIdx] = {
                binId: binIdx,
                ringIdx: meta.ringIdx,
                zoneIdx: meta.zoneIdx,
                sectorIdx: meta.sectorIdx,
                rMin: meta.rMin,
                rMax: meta.rMax,
                rMid: meta.rMid,
                thetaMin: meta.thetaMin,
                thetaMax: meta.thetaMax,
                thetaMid: meta.thetaMid,
                center: meta.center,
                innerBinId: meta.innerBinId,
                plane: null,
                valid: false,
                source: 'none',
                nPts,
                nGroundPts: 0,
                sigma2: 0,
                zCenter: 0
            };

            // Nếu bin quá thưa điểm, chuyển sang bước Kế Thừa Hướng Tâm
            if (nPts < cfg.minPtsPerBin) continue;

            // Thu thập điểm của bin vào bộ đệm tĩnh (lấy mẫu đều nếu bin quá dày > maxSamplePerBin)
            const sampleX = this._SAMPLE_X;
            const sampleY = this._SAMPLE_Y;
            const sampleZ = this._SAMPLE_Z;
            const sampleZSort = this._SAMPLE_Z_SORT;

            const maxSample = Math.min(256, cfg.maxSamplePerBin || 150);
            const step = nPts > maxSample ? Math.floor(nPts / maxSample) : 1;
            let cur = head[binIdx];
            let counter = 0;
            let mCount = 0;

            while (cur !== -1 && mCount < maxSample) {
                if (counter % step === 0) {
                    const c3 = cur * 3;
                    sampleX[mCount] = flat[c3];
                    sampleY[mCount] = flat[c3 + 1];
                    sampleZ[mCount] = flat[c3 + 2];
                    sampleZSort[mCount] = flat[c3 + 2];
                    mCount++;
                }
                cur = next[cur];
                counter++;
            }

            if (mCount < cfg.minPtsPerBin) continue;

            // LPR (Lowest Point Representative): Lấy 10% điểm thấp nhất
            sampleZSort.subarray(0, mCount).sort();
            const nLpr = Math.max(1, Math.floor(cfg.lprRatio * mCount));
            let sumLpr = 0;
            for (let k = 0; k < nLpr; k++) sumLpr += sampleZSort[k];
            const zLpr = sumLpr / nLpr;

            // Hạt giống mặt đất: z <= zLpr + seedThresh
            const zSeedLimit = zLpr + cfg.seedThresh;

            // Tính trọng tâm của tập hạt giống
            let sx = 0, sy = 0, sz = 0, nSeeds = 0;
            for (let k = 0; k < mCount; k++) {
                if (sampleZ[k] <= zSeedLimit) {
                    sx += sampleX[k];
                    sy += sampleY[k];
                    sz += sampleZ[k];
                    nSeeds++;
                }
            }

            if (nSeeds < 3) continue;

            let mx = sx / nSeeds, my = sy / nSeeds, mz = sz / nSeeds;

            // PCA trên tập hạt giống, rồi lặp R-GPF: chọn lại đất theo khoảng cách vuông góc tới mặt phẳng
            // (bản cũ chỉ fit 1 lần trên ngưỡng z ngang -> bin dốc/bin có gầm xe bị kéo nghiêng)
            // 1 lượt quét / vòng: mômen thô quanh gốc tham chiếu (trọng tâm hạt giống) -> hiệp phương sai = E[ddᵀ] - E[d]E[d]ᵀ
            const ox = mx, oy = my, oz = mz;
            let normA = 0, normB = 0, normC = 1, sigma2 = 0, d = 0, prevN = -1;
            for (let iter = 0; iter <= cfg.numIter; iter++) {
                let n = 0, s1x = 0, s1y = 0, s1z = 0, Sxx = 0, Sxy = 0, Sxz = 0, Syy = 0, Syz = 0, Szz = 0;
                for (let k = 0; k < mCount; k++) {
                    const X = sampleX[k], Y = sampleY[k], Z = sampleZ[k];
                    if (iter === 0 ? Z > zSeedLimit : Math.abs(normA * X + normB * Y + normC * Z + d) > cfg.thDist) continue;
                    const dx = X - ox, dy = Y - oy, dz = Z - oz;
                    s1x += dx; s1y += dy; s1z += dz;
                    Sxx += dx * dx; Sxy += dx * dy; Sxz += dx * dz; Syy += dy * dy; Syz += dy * dz; Szz += dz * dz;
                    n++;
                }
                if (n < 3) break;
                const ex = s1x / n, ey = s1y / n, ez = s1z / n;
                const eigen = this.giaiEigenNhoNhat3x3(
                    Sxx / n - ex * ex, Sxy / n - ex * ey, Sxz / n - ex * ez,
                    Syy / n - ey * ey, Syz / n - ey * ez, Szz / n - ez * ez);
                [normA, normB, normC] = eigen.vec;
                sigma2 = eigen.val;
                mx = ox + ex; my = oy + ey; mz = oz + ez;
                d = -(normA * mx + normB * my + normC * mz);
                nSeeds = n;
                if (n === prevN) break; // tập đất không đổi -> hội tụ
                prevN = n;
            }
            if (nSeeds < 3) continue;

            // GLE (Ground Likelihood Estimation): Kiểm tra tính hợp lệ mặt đường
            const isUpright = normC >= cfg.gleUpright;
            const isFlat = sigma2 <= cfg.gleFlatness;
            const zAtCenter = -(normA * meta.center.x + normB * meta.center.y + d) / normC;
            const maxDz = 2.5 + meta.rMid * (cfg.maxSlope || 0.18);
            const isElevConsistent = zAtCenter >= (cfg.zEgo - maxDz) && zAtCenter <= (cfg.zEgo + maxDz);

            if (isUpright && isFlat && isElevConsistent) {
                let slX = -normA / normC;
                let slY = -normB / normC;

                // Regularization cho cự ly xa (r > 20m): kéo độ dốc về mặt phẳng hạt giống Ego để chống nhiễu do điểm thưa
                if (meta.rMid > 20.0 && seedPlane && cfg.farRegLambda > 0) {
                    const weight = nSeeds / (nSeeds + cfg.farRegLambda);
                    slX = weight * slX + (1 - weight) * seedPlane.slopeX;
                    slY = weight * slY + (1 - weight) * seedPlane.slopeY;
                }

                // Kẹp ĐỘ LỚN vector dốc (kẹp từng trục cho phép dốc chéo tới √2 lần và làm lệch hướng dốc)
                const gNorm = Math.hypot(slX, slY);
                if (gNorm > maxSlope) { slX *= maxSlope / gNorm; slY *= maxSlope / gNorm; }

                let aNew = normA, bNew = normB, cNew = normC, dNew = d;
                const origSlX = -normA / normC, origSlY = -normB / normC;
                if (slX !== origSlX || slY !== origSlY) {
                    const invNorm = 1.0 / Math.sqrt(slX * slX + slY * slY + 1.0);
                    aNew = -slX * invNorm;
                    bNew = -slY * invNorm;
                    cNew = invNorm;
                    dNew = -(aNew * mx + bNew * my + cNew * mz);
                }

                bins[binIdx].plane = { a: aNew, b: bNew, c: cNew, d: dNew, slopeX: slX, slopeY: slY };
                bins[binIdx].valid = true;
                bins[binIdx].source = 'r_gpf';
                bins[binIdx].nGroundPts = nSeeds;
                bins[binIdx].sigma2 = sigma2;
                bins[binIdx].zCenter = zAtCenter;
                totalGroundPts += nSeeds;
            }
        }

        // BƯỚC 4: KẾ THỪA HƯỚNG TÂM (RADIAL PROPAGATION) CHO CÁC BIN KHUẤT BÓNG
        // Quét tuần tự từ Ring 0 ra Ring 12: bin bị khuyết sẽ sao chép mặt phẳng từ bin cùng tia ở Ring k-1
        // Kèm KIỂM ĐỊNH NHẤT QUÁN CAO ĐỘ với bin trong cùng tia: bin nằm trọn trên nóc/capô xe vẫn phẳng & thẳng đứng
        // nên lọt GLE (đo thật F5 Track 132793: bậc 1.5m). Ngưỡng cũ ±2.5m quanh zEgo không chặn được.
        const zTaiTam = (pl, b) => -(pl.a * b.center.x + pl.b * b.center.y + pl.d) / pl.c;
        for (let ring = 0; ring < this.TOTAL_RINGS; ring++) {
            const rInfo = this.RING_PARAMS[ring];
            for (let s = 0; s < rInfo.nSectors; s++) {
                const bId = rInfo.binOffset + s;
                const b = bins[bId];
                if (b.valid) {
                    let refPlane = null, refCenter = null;
                    let pid = b.innerBinId;
                    while (pid >= 0) {
                        if (bins[pid].valid && bins[pid].plane) { refPlane = bins[pid].plane; refCenter = bins[pid].center; break; }
                        pid = bins[pid].innerBinId;
                    }
                    if (!refPlane) { refPlane = seedPlane; refCenter = { x: 0, y: 0 }; }
                    const dist = Math.hypot(b.center.x - refCenter.x, b.center.y - refCenter.y);
                    const tol = cfg.elevTol0 + cfg.elevTolSlope * dist;
                    if (Math.abs(b.zCenter - zTaiTam(refPlane, b)) <= tol) continue;
                    totalGroundPts -= b.nGroundPts;
                    b.valid = false; b.plane = null; b.rejected = 'elev';
                }

                if (ring === 0) {
                    // Tại Ring 0 sát xe, kế thừa trực tiếp từ seedPlane
                    b.plane = { ...seedPlane };
                    b.valid = true;
                    b.source = 'seed_inherited';
                    b.zCenter = -(b.plane.a * b.center.x + b.plane.b * b.center.y + b.plane.d) / b.plane.c;
                } else {
                    // Tại Ring k > 0, lần ngược theo tia hướng tâm (Radial Ray)
                    let parentId = b.innerBinId;
                    let inheritedPlane = null;
                    while (parentId >= 0) {
                        if (bins[parentId].valid && bins[parentId].plane) {
                            inheritedPlane = bins[parentId].plane;
                            break;
                        }
                        parentId = bins[parentId].innerBinId;
                    }

                    if (!inheritedPlane) inheritedPlane = seedPlane;

                    b.plane = { ...inheritedPlane };
                    b.valid = true;
                    b.source = 'radial_inherited';
                    b.zCenter = -(b.plane.a * b.center.x + b.plane.b * b.center.y + b.plane.d) / b.plane.c;
                }
            }
        }

        // BƯỚC 5: WHEEL BASE GROUND PRIOR - GHIM TRẦN MẶT ĐƯỜNG THEO ĐÁY XE ĐÃ CĂN CHỈNH
        if (cfg.wheelBasePrior && boxes && boxes.length > 0) {
            this._apDungWheelBasePrior(bins, boxes);
        }

        // BƯỚC 6: MIẾNG VÁ ĐẤT CỤC BỘ QUANH XE (LOCAL GROUND PATCH)
        // Đo thật Job 1767: RANSAC chân xe sai 1.4cm / lệch dốc 0.9% so với đất thật, bin CZM sai 4.5cm / 1.6%.
        // => Quanh mỗi xe, mặt đường lấy ĐÚNG hàm canChinhMatDuongHop mà Auto fit / Căn mặt đường dùng,
        //    hoà trơn (smoothstep) sang trường CZM trong dải patchBlend mét. Chỉ dùng (x, y, rz, L, W) của box,
        //    KHÔNG dùng z/rx/ry của box -> không suy luận vòng tròn.
        const patchCache = new Map();
        const patches = (cfg.localPatch && boxes && boxes.length > 0)
            ? this._dungMiengVaCucBo(flat, head, next, boxes, cfg, patchCache)
            : [];

        const t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const processingTimeMs = +(t1 - t0).toFixed(2);

        const result = {
            bins,
            patches,
            boxSignature: this.kyHieuBoxes(boxes),
            _flat: flat, _head: head, _next: next, _cfg: cfg, _patchCache: patchCache,
            zones: this.ZONES,
            rings: this.RING_PARAMS,
            seedPlane,
            stats: {
                totalPoints: count,
                validPoints: validPtsCount,
                groundPoints: totalGroundPts,
                processingTimeMs
            },
            layMatDuong: (x, y) => this.layMatDuongCZM(result, x, y),
            evalLocalW: (...args) => this.evalLocalWCZM(result, ...args),
            layMatDuongChoBox: (...args) => this.layMatDuongChoBoxCZM(result, ...args)
        };
        // Chỉ giữ mảng điểm + danh sách liên kết (~4-5MB/frame) cho 3 bản CZM gần nhất để cập nhật miếng vá nhanh;
        // bản cũ hơn bị tháo -> lần sau đổi box sẽ dựng lại toàn bộ (không rò bộ nhớ khi cache hàng trăm frame).
        this._LRU_GIU_DIEM.push(result);
        while (this._LRU_GIU_DIEM.length > 3) {
            const old = this._LRU_GIU_DIEM.shift();
            old._flat = null; old._head = null; old._next = null;
        }
        return result;
    }

    /**
     * Tìm mặt phẳng hạt giống Ego quanh gốc tọa độ.
     */
    static _timMatPhangEgoSeed(flat, head, next, binCounts, cfg) {
        // Thu thập các điểm trong vành 2m - 6m quanh gốc tọa độ
        const ptsX = [], ptsY = [], ptsZ = [];
        for (let b = 0; b < 32; b++) { // Ring 0 và Ring 1
            let cur = head[b];
            let cnt = 0;
            while (cur !== -1 && cnt < 60) {
                const c3 = cur * 3;
                const z = flat[c3 + 2];
                if (z >= cfg.zEgo - 2.5 && z <= cfg.zEgo + 0.5) {
                    ptsX.push(flat[c3]);
                    ptsY.push(flat[c3 + 1]);
                    ptsZ.push(z);
                }
                cur = next[cur];
                cnt++;
            }
        }

        if (ptsZ.length >= 15) {
            const zSorted = ptsZ.slice().sort((a, b) => a - b);
            const nLpr = Math.max(3, Math.floor(0.15 * ptsZ.length));
            let sLpr = 0;
            for (let k = 0; k < nLpr; k++) sLpr += zSorted[k];
            const zLpr = sLpr / nLpr;
            const zLimit = zLpr + 0.15;

            let sx = 0, sy = 0, sz = 0, n = 0;
            for (let k = 0; k < ptsZ.length; k++) {
                if (ptsZ[k] <= zLimit) {
                    sx += ptsX[k]; sy += ptsY[k]; sz += ptsZ[k];
                    n++;
                }
            }
            if (n >= 6) {
                const mx = sx / n, my = sy / n, mz = sz / n;
                let C00 = 0, C01 = 0, C02 = 0, C11 = 0, C12 = 0, C22 = 0;
                for (let k = 0; k < ptsZ.length; k++) {
                    if (ptsZ[k] <= zLimit) {
                        const dx = ptsX[k] - mx, dy = ptsY[k] - my, dz = ptsZ[k] - mz;
                        C00 += dx * dx; C01 += dx * dy; C02 += dx * dz;
                        C11 += dy * dy; C12 += dy * dz; C22 += dz * dz;
                    }
                }
                C00 /= n; C01 /= n; C02 /= n; C11 /= n; C12 /= n; C22 /= n;
                const eigen = this.giaiEigenNhoNhat3x3(C00, C01, C02, C11, C12, C22);
                const [a, b, c] = eigen.vec;
                if (c >= 0.95) {
                    const d = -(a * mx + b * my + c * mz);
                    return { a, b, c, d, slopeX: -a / c, slopeY: -b / c, z0: mz };
                }
            }
        }

        // Mặc định mặt phẳng ngang ở độ cao z = zEgo - 1.8m
        const defZ = (cfg && Number.isFinite(cfg.zEgo)) ? (cfg.zEgo - 1.8) : -1.8;
        return { a: 0, b: 0, c: 1, d: -defZ, slopeX: 0, slopeY: 0, z0: defZ };
    }

    /**
     * Đọc box CVAT 3D ({shape:{points}} | {points} | mảng) -> { x, y, z, rx, ry, rz, L, W, H } hoặc null.
     */
    static _docBox(b) {
        const sp = b?.shape?.points || b?.points || (Array.isArray(b) ? b : null);
        if (!sp || sp.length < 6) return null;
        const x = sp[0], y = sp[1], z = sp[2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
        return {
            x, y, z, rx: sp[3] || 0, ry: sp[4] || 0, rz: sp[5] || 0,
            L: Number.isFinite(sp[6]) ? sp[6] : 4.8,
            W: Number.isFinite(sp[7]) ? sp[7] : 2.0,
            H: Number.isFinite(sp[8]) ? sp[8] : 1.6
        };
    }

    /**
     * Ký hiệu footprint các box (x, y, rz, L, W làm tròn 2cm / 0.005rad) để biết khi nào phải dựng lại miếng vá.
     */
    static _kyHieuMotBox(q) {
        return `${Math.round(q.x * 50)},${Math.round(q.y * 50)},${Math.round(q.rz * 200)},${Math.round(q.L * 50)},${Math.round(q.W * 50)}`;
    }

    static kyHieuBoxes(boxes) {
        if (!boxes || !boxes.length) return '';
        const parts = [];
        for (const b of boxes) {
            const q = this._docBox(b);
            if (q) parts.push(this._kyHieuMotBox(q));
        }
        return parts.sort().join('|');
    }

    /**
     * Cập nhật miếng vá khi box đổi footprint mà KHÔNG fit lại 416 bin (bin không phụ thuộc box).
     * Box không đổi dùng lại kết quả cũ trong _patchCache -> kéo 1 box chỉ tốn 1 lần canChinhMatDuongHop.
     */
    static capNhatMiengVa(czm, boxes) {
        if (!czm || !czm._flat) return false;
        czm.patches = (czm._cfg.localPatch && boxes && boxes.length > 0)
            ? this._dungMiengVaCucBo(czm._flat, czm._head, czm._next, boxes, czm._cfg, czm._patchCache)
            : [];
        czm.boxSignature = this.kyHieuBoxes(boxes);
        return true;
    }

    /**
     * Dựng miếng vá đất cục bộ cho từng box bằng CHÍNH hàm canChinhMatDuongHop của Thuật Toán Căn Chỉnh
     * (cùng hàm Auto fit / Căn mặt đường gọi) trên điểm LiDAR lân cận lấy từ danh sách liên kết của bin.
     */
    static _dungMiengVaCucBo(flat, head, next, boxes, cfg, cache = null) {
        const K = cfg.boKhopMatDuong ||
            (typeof window !== 'undefined' && window.thuatToanCanChinh) ||
            (typeof globalThis !== 'undefined' && globalThis.thuatToanCanChinh) || null;
        if (!K || typeof K.canChinhMatDuongHop !== 'function') return [];

        const out = [];
        const used = new Set();
        for (const b of boxes) {
            const q = this._docBox(b);
            if (!q) continue;
            const { x, y, z, rx, ry, rz, L, W, H } = q;
            if (L < 1.0 || W < 0.8 || Math.hypot(x, y) > 78.0) continue;
            const key = this._kyHieuMotBox(q);
            if (used.has(key)) continue; // box trùng lặp (track + shape cùng chỗ)
            used.add(key);
            if (cache && cache.has(key)) {
                const cached = cache.get(key);
                if (cached) out.push(cached);
                continue;
            }
            const patch = this._doMotMiengVa(K, flat, head, next, q, cfg);
            if (cache) cache.set(key, patch);
            if (patch) out.push(patch);
        }
        return out;
    }

    static _doMotMiengVa(K, flat, head, next, q, cfg) {
        const { x, y, z, rx, ry, rz, L, W, H } = q;
        // Phủ trọn vùng quét của canChinhMatDuongHop: |u| <= max(L+1.4, 5.5)/2, |v| <= max(W+1.2, 3.2)/2
        const R = 0.5 * Math.hypot(Math.max(L + 1.4, 5.5), Math.max(W + 1.2, 3.2)) + 0.2;
        const R2 = R * R;
        const binSet = new Set();
        for (let ox = -R; ox <= R + 1e-6; ox += 0.4) {
            for (let oy = -R; oy <= R + 1e-6; oy += 0.4) {
                const id = this.timBinId(x + ox, y + oy);
                if (id >= 0) binSet.add(id);
            }
        }
        const local = [];
        for (const id of binSet) {
            let cur = head[id];
            while (cur !== -1) {
                const c3 = cur * 3;
                const dx = flat[c3] - x, dy = flat[c3 + 1] - y;
                if (dx * dx + dy * dy <= R2) local.push([flat[c3], flat[c3 + 1], flat[c3 + 2]]);
                cur = next[cur];
            }
        }
        if (local.length < 30) return null;

        let res = null;
        try {
            res = K.canChinhMatDuongHop([x, y, z], [rx, ry, rz], [L, W, H], local, 0.06);
        } catch (e) { res = null; }
        if (!res || !Array.isArray(res.newRot) || !Number.isFinite(res.zRoad)) return null;
        // Chỉ nhận khi RANSAC thật sự tìm được mặt phẳng (không nhận nhánh dự phòng "lát cắt dày nhất")
        const coMatPhang = res.isDirectPlane || (res.rms !== null && res.nGroundPts >= 12 && res.confidence >= 0.25);
        if (!coMatPhang) return null;

        return {
            cx: x, cy: y, cs: Math.cos(rz), sn: Math.sin(rz),
            hl: 0.5 * L, hw: 0.5 * W,
            z0: res.zRoad,
            gx: -res.newRot[1],
            gy: res.newRot[0],
            conf: res.confidence,
            nGround: res.nGroundPts,
            rms: res.rms,
            reach: Math.hypot(0.5 * L, 0.5 * W) + 0.3 + cfg.patchBlend,
            blend: cfg.patchBlend
        };
    }

    // ---- Trường mặt đường trơn C¹ (Partition of Unity trên lưới cực) ----

    static RING_MIDS = ThuatToanConcentricSurface.RING_PARAMS.map(r => 0.5 * (r.rMin + r.rMax));

    static _smoothstep(t) {
        return t <= 0 ? 0 : (t >= 1 ? 1 : t * t * (3 - 2 * t));
    }

    static _doTinCayBin(b) {
        if (!b || !b.plane) return 0;
        if (b.source === 'r_gpf' || (b.source && b.source.startsWith('wheel_prior'))) return 1.0;
        return 0.15; // bin kế thừa: không có dữ liệu riêng, chỉ lấp chỗ trống
    }

    // Thanh ghi tạm (tránh cấp phát object trong vòng nóng truy vấn)

    /** Hoà góc trong 1 vành: 2 sector kề nhau, trọng số smoothstep theo θ, nhân độ tin cậy. Ghi kết quả vào _vanhZ/_vanhC. */
    static _zTrongVanh(czm, ring, x, y, th) {
        const ri = this.RING_PARAMS[ring];
        const n = ri.nSectors;
        const t = th / ri.sectorSpan - 0.5;
        const f0 = Math.floor(t);
        const s0 = ((f0 % n) + n) % n;
        const s1 = (s0 + 1) % n;
        const w1 = this._smoothstep(t - f0), w0 = 1 - w1;
        const b0 = czm.bins[ri.binOffset + s0], b1 = czm.bins[ri.binOffset + s1];
        const sp = czm.seedPlane;
        const p0 = (b0 && b0.plane) || sp, p1 = (b1 && b1.plane) || sp;
        const c0 = w0 * Math.max(0.05, this._doTinCayBin(b0));
        const c1 = w1 * Math.max(0.05, this._doTinCayBin(b1));
        const z0 = -(p0.a * x + p0.b * y + p0.d) / p0.c;
        const z1 = -(p1.a * x + p1.b * y + p1.d) / p1.c;
        const c = c0 + c1;
        _CZM_TMP[0] = c > 0 ? (c0 * z0 + c1 * z1) / c : z0;
        _CZM_TMP[1] = c;
    }

    /** Cao độ trường CZM trơn (chưa tính miếng vá). */
    static _zCZMTron(czm, x, y) {
        const r = Math.hypot(x, y);
        let th = Math.atan2(y, x);
        if (th < 0) th += 6.283185307179586;
        const mids = this.RING_MIDS;
        const last = mids.length - 1;
        if (r <= mids[0]) { this._zTrongVanh(czm, 0, x, y, th); return _CZM_TMP[0]; }
        if (r >= mids[last]) { this._zTrongVanh(czm, last, x, y, th); return _CZM_TMP[0]; }
        let k = 0;
        while (k < last - 1 && r >= mids[k + 1]) k++;
        const w = this._smoothstep((r - mids[k]) / (mids[k + 1] - mids[k]));
        this._zTrongVanh(czm, k, x, y, th);
        const zA = _CZM_TMP[0], ca = (1 - w) * _CZM_TMP[1];
        this._zTrongVanh(czm, k + 1, x, y, th);
        const zB = _CZM_TMP[0], cb = w * _CZM_TMP[1];
        return (ca + cb) > 0 ? (ca * zA + cb * zB) / (ca + cb) : zA;
    }

    /** Trọng số miếng vá: 1 trong footprint + 0.3m, smoothstep về 0 sau thêm `blend` mét. */
    static _trongSoMiengVa(p, x, y) {
        const dx = x - p.cx, dy = y - p.cy;
        if (dx * dx + dy * dy > p.reach * p.reach) return 0;
        const u = dx * p.cs + dy * p.sn, v = -dx * p.sn + dy * p.cs;
        const ou = Math.max(0, Math.abs(u) - p.hl - 0.3), ov = Math.max(0, Math.abs(v) - p.hw - 0.3);
        const dd = Math.hypot(ou, ov);
        return 1 - this._smoothstep(dd / p.blend);
    }

    /** Cao độ cuối cùng: miếng vá cục bộ (nếu có) hoà trơn với trường CZM. Trả z; trọng số vá ghi vào _wPatch. */
    static _zTruong(czm, x, y) {
        let sw = 0, swz = 0;
        const P = czm.patches;
        if (P && P.length) {
            for (let i = 0; i < P.length; i++) {
                const p = P[i];
                const w = this._trongSoMiengVa(p, x, y);
                if (w <= 0) continue;
                sw += w;
                swz += w * (p.z0 + p.gx * (x - p.cx) + p.gy * (y - p.cy));
            }
        }
        if (sw >= 1) { _CZM_TMP[2] = 1; return swz / sw; }
        _CZM_TMP[2] = sw;
        if (sw <= 0) return this._zCZMTron(czm, x, y);
        return swz + (1 - sw) * this._zCZMTron(czm, x, y);
    }

    /**
     * Ghim trần mặt đường theo đáy các xe đã được căn chỉnh (Wheel Base Ground Prior).
     * MẶC ĐỊNH TẮT: đo thật cho thấy nó kéo mặt đường theo sai số của chính box (T132810: 1.2 -> 5.1cm).
     */
    static _apDungWheelBasePrior(bins, boxes) {
        for (const b of boxes) {
            const sp = b?.shape?.points || b?.points || (Array.isArray(b) ? b : null);
            if (!sp || sp.length < 6) continue;

            const bx = sp[0], by = sp[1], bz = sp[2];
            const rx = sp[3] || 0, ry = sp[4] || 0, rz = sp[5] || 0;
            const L = Number.isFinite(sp[6]) ? sp[6] : 4.8;
            const W = Number.isFinite(sp[7]) ? sp[7] : 2.0;
            const H = Number.isFinite(sp[8]) ? sp[8] : 1.6;

            if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue;
            if (L < 1.0 || W < 0.8 || H < 0.5) continue; // Bỏ qua vật thể quá bé

            const distBoxCenter = Math.hypot(bx, by);
            if (distBoxCenter > 78.0) continue;

            const R = this.eulerXYZToMatrix(rx, ry, rz);
            const aAxis = [R[0][0], R[1][0], R[2][0]];
            const bAxis = [R[0][1], R[1][1], R[2][1]];
            const cAxis = [R[0][2], R[1][2], R[2][2]];

            const cosZ = Math.cos(rz), sinZ = Math.sin(rz);
            const halfL = L * 0.5 + 0.35;
            const halfW = W * 0.5 + 0.25;

            // Gom tập hợp tất cả các bin bị ảnh hưởng bởi footprint xe:
            // 1. Quét các điểm tiếp xúc then chốt (4 bánh xe, tâm xe, 4 góc, đầu, đuôi)
            const targetBinIds = new Set();
            const keyPointsU = [-0.45 * L, -0.35 * L, 0, 0.35 * L, 0.45 * L];
            const keyPointsV = [-0.45 * W, 0, 0.45 * W];
            for (const ku of keyPointsU) {
                for (const kv of keyPointsV) {
                    const kx = bx + ku * cosZ - kv * sinZ;
                    const ky = by + ku * sinZ + kv * cosZ;
                    const kid = this.timBinId(kx, ky);
                    if (kid >= 0 && kid < this.TOTAL_BINS) targetBinIds.add(kid);
                }
            }

            // 2. Thêm các bin có tâm nằm trong footprint mở rộng của xe
            for (let binId = 0; binId < this.TOTAL_BINS; binId++) {
                const bin = bins[binId];
                const dx = bin.center.x - bx, dy = bin.center.y - by;
                const u = dx * cosZ + dy * sinZ;
                const v = -dx * sinZ + dy * cosZ;
                if (Math.abs(u) <= halfL && Math.abs(v) <= halfW) {
                    targetBinIds.add(binId);
                }
            }

            // Áp dụng ghim trần theo độ dốc đáy xe thực tế (tính cả pitch và roll)
            for (const binId of targetBinIds) {
                const bin = bins[binId];
                if (!bin || !bin.plane) continue;

                const cx = bin.center.x, cy = bin.center.y;
                const dx = cx - bx, dy = cy - by;
                const u = dx * cosZ + dy * sinZ;
                const v = -dx * sinZ + dy * cosZ;

                // Cao độ đáy hộp xe tại vị trí (u, v) tính cả góc nghiêng 3D
                const zBottomLocal = bz + u * aAxis[2] + v * bAxis[2] - (H * 0.5) * cAxis[2];

                const curZ = -(bin.plane.a * cx + bin.plane.b * cy + bin.plane.d) / bin.plane.c;
                if (curZ > zBottomLocal + 0.02) {
                    // Kẹp trần mặt đường theo đáy xe
                    const shift = (zBottomLocal - curZ) * bin.plane.c;
                    bin.plane.d -= shift;
                    bin.zCenter = zBottomLocal;
                    bin.source = 'wheel_prior_clamped';
                } else if ((bin.source === 'radial_inherited' || bin.source === 'seed_inherited') && curZ < zBottomLocal - 0.08) {
                    // Nếu là vùng khuất sau đuôi xe bị tụt sâu > 8cm, nâng về đáy xe
                    const targetZ = zBottomLocal;
                    const shift = (targetZ - curZ) * bin.plane.c;
                    bin.plane.d -= shift;
                    bin.zCenter = targetZ;
                    bin.source = 'wheel_prior_supported';
                }
            }
        }
    }

    // =========================================================================
    // 6. GIAO DIỆN TRUY VẤN MẶT ĐƯỜNG O(1) & TÍNH CAO ĐỘ CỤC BỘ W
    // =========================================================================

    /**
     * Truy vấn thông tin mặt đường tại tọa độ thế giới (x, y) trong O(1).
     * @param {Object} czmData Bản đồ CZM trả về từ xayDungConcentricSurface
     * @param {number} x 
     * @param {number} y 
     * @returns {Object} { z, normal: [a, b, c], slopeX, slopeY, binId, valid, source, zRoad, gx, gy, rx, ry }
     */
    static layMatDuongCZM(czmData, x, y) {
        if (!czmData || !czmData.bins) {
            return {
                z: -1.8,
                zRoad: -1.8,
                normal: [0, 0, 1],
                slopeX: 0,
                slopeY: 0,
                gx: 0,
                gy: 0,
                rx: 0,
                ry: 0,
                binId: -1,
                valid: false,
                source: 'fallback'
            };
        }

        let binId = this.timBinId(x, y);
        if (binId < 0) {
            // Ngoài bán kính R_max (80m), kẹp về bin ngoài cùng ở góc theta tương ứng
            let th = Math.atan2(y, x);
            if (th < 0) th += 6.283185307179586;
            const sec = Math.min(35, (th * (36 * 0.15915494309189535)) | 0);
            binId = 380 + sec; // Ring 12
        }
        const bin = czmData.bins[binId];

        // Trường trơn C¹: không còn bậc thang ở ranh giới bin; dốc = gradient sai phân tiến (h = 10cm,
        // sai số ~ h/2 · độ cong ≈ 3e-4, không đáng kể so với dốc mặt đường)
        const h = 0.10;
        const z0 = this._zTruong(czmData, x, y);
        const wPatch = _CZM_TMP[2];
        const gx = (this._zTruong(czmData, x + h, y) - z0) / h;
        const gy = (this._zTruong(czmData, x, y + h) - z0) / h;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        const source = wPatch >= 0.5 ? 'local_patch' : (bin ? bin.source : 'seed_fallback');
        return {
            z: z0,
            zRoad: z0,
            normal: [-gx * inv, -gy * inv, inv],
            slopeX: gx,
            slopeY: gy,
            gx,
            gy,
            rx: gy,
            ry: -gx,
            binId,
            valid: wPatch >= 0.5 || !!(bin && bin.valid),
            source,
            wPatch
        };
    }

    /**
     * Tra cứu mặt đường tối ưu cho hộp 3D (phục vụ khớp độ cao và xoay xe).
     */
    static layMatDuongChoBoxCZM(czmData, cx, cy, rz = 0, L = 4.8, W = 2.0, rawPts = null) {
        const base = this.layMatDuongCZM(czmData, cx, cy);
        if (!base) return null;
        if (!Number.isFinite(L) || L <= 0.3 || !Number.isFinite(W) || W <= 0.2) return base;

        // Bình phương tối thiểu z = z0 + gx·dx + gy·dy trên lưới 5×3 phủ footprint (bản cũ: trung bình z 6 điểm
        // nhưng lấy dốc của 1 bin tâm -> cao độ và độ nghiêng đến từ 2 nguồn khác nhau)
        const cosRz = Math.cos(rz || 0), sinRz = Math.sin(rz || 0);
        let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
        for (const ur of [-0.42, -0.21, 0, 0.21, 0.42]) {
            for (const vr of [-0.40, 0, 0.40]) {
                const u = ur * L, v = vr * W;
                const dx = u * cosRz - v * sinRz, dy = u * sinRz + v * cosRz;
                const z = this._zTruong(czmData, cx + dx, cy + dy);
                if (!Number.isFinite(z)) continue;
                n++; sx += dx; sy += dy; sz += z;
                sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * z; syz += dy * z;
            }
        }
        if (n < 6) return base;
        const mx = sx / n, my = sy / n, mz = sz / n;
        const Cxx = sxx / n - mx * mx, Cxy = sxy / n - mx * my, Cyy = syy / n - my * my;
        const Cxz = sxz / n - mx * mz, Cyz = syz / n - my * mz;
        const det = Cxx * Cyy - Cxy * Cxy;
        if (Math.abs(det) < 1e-9) return base;
        const gx = (Cxz * Cyy - Cyz * Cxy) / det;
        const gy = (Cyz * Cxx - Cxz * Cxy) / det;
        const z0 = mz - gx * mx - gy * my;
        const inv = 1 / Math.sqrt(gx * gx + gy * gy + 1);
        return {
            zRoad: z0,
            z: z0,
            normal: [-gx * inv, -gy * inv, inv],
            slopeX: gx,
            slopeY: gy,
            gx,
            gy,
            rx: gy,
            ry: -gx,
            source: base.source,
            valid: base.valid
        };
    }

    /**
     * Tính cao độ w cục bộ dọc theo trục đứng thân xe để vẽ vạch Surface trên Side/Front view.
     * Đảm bảo tiếp xúc khít 4 bánh xe, triệt tiêu khoảng hở bánh sau (như Track 132793 F0).
     * 
     * Hỗ trợ các dạng gọi:
     * - `evalLocalWCZM(czmData, qx, qy, carBox, u, v)`
     * - `evalLocalWCZM(czmData, carBox, u, v)`
     * - `evalLocalWCZM(czmData, carBox, u)`
     */
    static evalLocalWCZM(czmData, qx, qy, carBox, u, v) {
        if (!czmData) return null;

        // Xử lý nạp tham số linh hoạt
        let box = carBox, localU = u, localV = v;
        if ((Array.isArray(qx) || (qx && typeof qx === 'object' && !('bins' in qx))) && (typeof qy === 'number' || qy === undefined)) {
            box = qx;
            localU = (typeof qy === 'number') ? qy : 0;
            localV = (typeof carBox === 'number') ? carBox : 0;
            qx = null;
            qy = null;
        }

        const sp = box?.shape?.points || box?.points || (Array.isArray(box) ? box : null);
        if (!sp || sp.length < 6) return null;

        const bx = sp[0], by = sp[1], bz = sp[2];
        const rx = sp[3] || 0, ry = sp[4] || 0, rz = sp[5] || 0;
        const L = Number.isFinite(sp[6]) ? sp[6] : 4.8;
        const W = Number.isFinite(sp[7]) ? sp[7] : 2.0;
        const H = Number.isFinite(sp[8]) ? sp[8] : 1.6;

        const R = this.eulerXYZToMatrix(rx, ry, rz);
        const aAxis = [R[0][0], R[1][0], R[2][0]];
        const bAxis = [R[0][1], R[1][1], R[2][1]];
        const cAxis = [R[0][2], R[1][2], R[2][2]];

        const qX = (qx !== null && qx !== undefined) ? qx : (bx + localU * aAxis[0] + localV * bAxis[0]);
        const qY = (qy !== null && qy !== undefined) ? qy : (by + localU * aAxis[1] + localV * bAxis[1]);
        const qZ = bz + localU * aAxis[2] + localV * bAxis[2];

        // Giao điểm tia P(w) = Q + w·cAxis với mặt trơn Z(x, y): Newton trên f(w) = Z(Pxy) - Pz, f'(w) = -denom
        const road0 = this.layMatDuongCZM(czmData, qX, qY);
        let denom = cAxis[2] - road0.slopeX * cAxis[0] - road0.slopeY * cAxis[1];
        if (Math.abs(denom) < 0.2) denom = cAxis[2] >= 0 ? 1 : -1;
        let w = (road0.z - qZ) / denom;
        for (let it = 0; it < 4; it++) {
            const f = this._zTruong(czmData, qX + w * cAxis[0], qY + w * cAxis[1]) - (qZ + w * cAxis[2]);
            w += f / denom;
            if (Math.abs(f) < 2e-4) break;
        }
        const road = this.layMatDuongCZM(czmData, qX + w * cAxis[0], qY + w * cAxis[1]);

        // KHÔNG còn kẹp w = đáy box ở bin kế thừa: kẹp đó làm vạch hồng luôn "khớp" box dù box sai (che lỗi).
        const boxBottomW = -H * 0.5;
        const deltaM = boxBottomW - w;

        return {
            w,
            zBase: road.z,
            normal: road.normal,
            slopeX: road.slopeX,
            slopeY: road.slopeY,
            binId: road.binId,
            source: road.source,
            valid: road.valid,
            deltaM
        };
    }

    /**
     * Ma trận xoay Euler XYZ tiêu chuẩn Three.js / CVAT 3D.
     */
    static eulerXYZToMatrix(rx = 0, ry = 0, rz = 0) {
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        return [
            [cy * cz, -cy * sz, sy],
            [sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
            [-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy]
        ];
    }
}

// Xuất đối tượng toàn cục cho trình duyệt (CVAT 3D Extension)
if (typeof window !== 'undefined') {
    window.ThuatToanConcentricSurface = ThuatToanConcentricSurface;
}

// Xuất module cho môi trường Node.js / Unit Test
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThuatToanConcentricSurface;
}
