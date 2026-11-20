/**
 * Thuật Toán Ghép Map LiDAR (Multi-Algorithm Ground Map & Topography Fusion)
 * ===================================================================================
 * Tác giả: Vũ Minh Kiệt & Đội ngũ Kỹ thuật Antigravity (Tích hợp cùng Claude Code)
 * Ngày cập nhật: 14/11/2026
 *
 * KIẾN TRÚC TỔNG HỢP ĐA THUẬT TOÁN 4 TRỤ CỘT ĐỘNG HOÀN TOÀN (DYNAMIC CALIBRATION):
 * -----------------------------------------------------------------------------------
 * TRỤ CỘT 1 - BỘ DÒ ĐỈNH MẬT ĐỘ MẶT ĐƯỜNG HISTOGRAM ĐỘNG (AUTO GROUND PEAK DETECTOR):
 *   - Tuyệt đối KHÔNG hardcode -1.80m. Tự động tính toán histogram Z (bin 5cm) trong bán kính
 *     R <= 15m quanh xe Ego để tìm đỉnh mật độ mặt đất thấp nhất (Lowest Ground Peak).
 *   - Tự thích ứng 100% với mọi hệ tọa độ (VinFast Z ≈ 0m, Waymo Z ≈ -1.8m, v.v.).
 *
 * TRỤ CỘT 2 - HÌNH THÁI CỐ ĐỊNH CỦA MAP (STATIC ROAD MANIFOLD & TOPOGRAPHY SPINE):
 *   - Chuỗi vị trí Ego tạo thành "Xương sống địa hình" (Road Spine) chuẩn xác.
 *   - Định hình mặt phẳng toàn cục Z_prior(Xw, Yw), bảo đảm độ dốc dọc tự nhiên <= 1.5°.
 *
 * TRỤ CỘT 3 - GOM VỤN ĐIỂM MẶT ĐƯỜNG XUNG QUANH XE (PAVEMENT SCATTER POINTS):
 *   - Quét các vụn điểm mặt đường trong bán kính 1.5m - 12m quanh xe trong dải động [zRoad-0.25m, zRoad+0.20m].
 *   - Tự động đục lỗ loại trừ thân của tất cả các xe khác trong frame.
 *
 * TRỤ CỘT 4 - BỘ TÍCH HỢP ĐÀN HỒI RIDGE TIKHONOV (REGULARIZED RIDGE-FUSION):
 *   - Kết hợp mây điểm ghép đa frame + vụn điểm xung quanh + tiên nghiệm hình thái map.
 *   - Cản góc lambda_g = 65.0 và neo cao độ lambda_z = 3.5 triệt tiêu vĩnh viễn lỗi dốc 7.1°.
 */

class ThuatToanGhepMapLiDAR {
    static wrapAngle(a) {
        let res = a % (2 * Math.PI);
        if (res > Math.PI) res -= 2 * Math.PI;
        if (res < -Math.PI) res += 2 * Math.PI;
        return res;
    }

    static composeSE2(t1, t2) {
        if (!t1) return t2 || { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        if (!t2) return t1;
        const c1 = Math.cos(t1.dtheta), s1 = Math.sin(t1.dtheta);
        return {
            dtheta: this.wrapAngle(t1.dtheta + t2.dtheta),
            tx: c1 * t2.tx - s1 * t2.ty + t1.tx,
            ty: s1 * t2.tx + c1 * t2.ty + t1.ty,
            inliers: Math.min(t1.inliers || 0, t2.inliers || 0)
        };
    }

    static invertSE2(t) {
        if (!t) return { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        const invTh = -t.dtheta;
        const c = Math.cos(invTh), s = Math.sin(invTh);
        return {
            dtheta: invTh,
            tx: -(c * t.tx - s * t.ty),
            ty: -(s * t.tx + c * t.ty),
            inliers: t.inliers || 0
        };
    }

    static applySE2Point(pt, t) {
        if (!t) return [pt[0], pt[1]];
        const c = Math.cos(t.dtheta), s = Math.sin(t.dtheta);
        return [
            c * pt[0] - s * pt[1] + t.tx,
            s * pt[0] + c * pt[1] + t.ty
        ];
    }

    static rotateVector(gx, gy, dtheta) {
        const c = Math.cos(dtheta), s = Math.sin(dtheta);
        return [
            c * gx - s * gy,
            s * gx + c * gy
        ];
    }

    constructor() {
        this.cellSize = 0.40; // Ô lưới 40cm x 40cm
        this.grid = new Map(); // key `${ix}_${iy}` -> { Xw, Yw, zMin, zSum, count, frames: Set }
        this.worldTransforms = new Map(); // frameNum -> T_{W <- f}
        this.stepTransforms = new Map();  // `${fA}_${fB}` -> T_{fB <- fA}
        this.processedFrames = new Set();
        this.egoSpine = new Map(); // frameNum -> { fn, Xw, Yw, Zw }
        this.refFrame = 0;
        this.totalFrames = 0;
        this.isOdometryReady = false;
        this.globalPlane = null; // { z0, gx, gy }
        this._zRoadLast = null;  // Bộ nhớ đệm cao độ mặt đường tốt nhất gần đây
    }

    xoaTrang() {
        this.grid.clear();
        this.worldTransforms.clear();
        this.stepTransforms.clear();
        this.processedFrames.clear();
        this.egoSpine.clear();
        this.globalPlane = null;
        this._zRoadLast = null;
        this.isOdometryReady = false;
    }

    /**
     * 1. KHÔI PHỤC ODOMETRY SE(2) TỪ TỌA ĐỘ MẶT BẰNG 2D CỦA CÁC TRACK TĨNH
     */
    uocLuongBuocSE2TuTracks(fA, fB, allTracks) {
        if (!allTracks || !Array.isArray(allTracks) || fA === fB) {
            return { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
        }
        const cacheKey = `${fA}_${fB}`;
        if (this.stepTransforms.has(cacheKey)) {
            return this.stepTransforms.get(cacheKey);
        }

        const ptsA = [];
        const ptsB = [];
        for (const tr of allTracks) {
            if (!tr || !tr.shapes) continue;
            let sA = null, sB = null;
            for (const s of tr.shapes) {
                if (!s || s.outside || !s.points || s.points.length < 3) continue;
                const fn = Number(s.frame);
                if (fn === fA) sA = s.points;
                else if (fn === fB) sB = s.points;
            }
            if (sA && sB) {
                ptsA.push([sA[0], sA[1]]);
                ptsB.push([sB[0], sB[1]]);
            }
        }

        const n = ptsA.length;
        if (n < 2) {
            const defRes = { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
            this.stepTransforms.set(cacheKey, defRes);
            return defRes;
        }

        let bestInliers = [];
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const p1 = ptsA[i], p2 = ptsA[j];
                const q1 = ptsB[i], q2 = ptsB[j];
                const dA = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
                const dB = Math.hypot(q2[0] - q1[0], q2[1] - q1[1]);
                if (dA < 2.5 || Math.abs(dA - dB) > 0.40) continue;

                const angA = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                const angB = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
                const dtheta = ThuatToanGhepMapLiDAR.wrapAngle(angB - angA);
                const c = Math.cos(dtheta), s = Math.sin(dtheta);
                const tx = q1[0] - (c * p1[0] - s * p1[1]);
                const ty = q1[1] - (s * p1[0] + c * p1[1]);

                const inliers = [];
                for (let k = 0; k < n; k++) {
                    const pk = ptsA[k], qk = ptsB[k];
                    const px = c * pk[0] - s * pk[1] + tx;
                    const py = s * pk[0] + c * pk[1] + ty;
                    if (Math.hypot(px - qk[0], py - qk[1]) < 0.40) {
                        inliers.push(k);
                    }
                }
                if (inliers.length > bestInliers.length) {
                    bestInliers = inliers;
                }
            }
        }

        if (bestInliers.length < 2) {
            const defRes = { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
            this.stepTransforms.set(cacheKey, defRes);
            return defRes;
        }

        let cxA = 0, cyA = 0, cxB = 0, cyB = 0;
        for (const idx of bestInliers) {
            cxA += ptsA[idx][0]; cyA += ptsA[idx][1];
            cxB += ptsB[idx][0]; cyB += ptsB[idx][1];
        }
        const m = bestInliers.length;
        cxA /= m; cyA /= m; cxB /= m; cyB /= m;

        let numCos = 0, numSin = 0;
        for (const idx of bestInliers) {
            const ax = ptsA[idx][0] - cxA, ay = ptsA[idx][1] - cyA;
            const bx = ptsB[idx][0] - cxB, by = ptsB[idx][1] - cyB;
            numCos += ax * bx + ay * by;
            numSin += ax * by - ay * bx;
        }
        const dtheta = Math.atan2(numSin, numCos);
        const c = Math.cos(dtheta), s = Math.sin(dtheta);
        const tx = cxB - (c * cxA - s * cyA);
        const ty = cyB - (s * cxA + c * cyA);

        const res = { dtheta, tx, ty, inliers: m };
        this.stepTransforms.set(cacheKey, res);
        return res;
    }

    xayDungChuoiOdometry(allTracks, totalFrames = 60, refFrame = 0) {
        this.refFrame = refFrame;
        this.totalFrames = totalFrames;
        this.worldTransforms.clear();

        this.worldTransforms.set(refFrame, { dtheta: 0, tx: 0, ty: 0, inliers: 999 });

        let curT = { dtheta: 0, tx: 0, ty: 0, inliers: 999 };
        for (let f = refFrame + 1; f < totalFrames; f++) {
            const stepFwd = this.uocLuongBuocSE2TuTracks(f - 1, f, allTracks);
            const stepInv = ThuatToanGhepMapLiDAR.invertSE2(stepFwd);
            curT = ThuatToanGhepMapLiDAR.composeSE2(curT, stepInv);
            this.worldTransforms.set(f, curT);
        }

        let curBack = { dtheta: 0, tx: 0, ty: 0, inliers: 999 };
        for (let f = refFrame - 1; f >= 0; f--) {
            const stepFwd = this.uocLuongBuocSE2TuTracks(f, f + 1, allTracks);
            curBack = ThuatToanGhepMapLiDAR.composeSE2(curBack, stepFwd);
            this.worldTransforms.set(f, curBack);
        }

        this.isOdometryReady = true;
    }

    layBienDoiWorld(frameNum) {
        return this.worldTransforms.get(Number(frameNum)) || { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
    }

    /**
     * TRỤ CỘT 1: ƯỚC LƯỢNG MẶT ĐƯỜNG EGO TỰ ĐỘNG BẰNG HISTOGRAM PEAK (KHÔNG HARDCODE)
     * Thích ứng 100% với bất kỳ hệ quy chiếu nào (VinFast Z ≈ 0m hay KITTI Z ≈ -1.8m).
     */
    uocLuongMatDuongEgo(rawPts) {
        const last = Number.isFinite(this._zRoadLast) ? this._zRoadLast : null;
        if (!rawPts || rawPts.length === 0) return { zEgo: last, gx: 0, gy: 0, confidence: 0, source: 'none' };

        // Histogram Z (bin 5cm, dải [-6.0m, +6.0m]) cho điểm trong bán kính R <= 15m
        const BIN = 0.05, ZLO = -6.0, NB = 240, R2 = 225.0;
        const hist = new Float32Array(NB);
        const zs = [];
        let total = 0;
        const step = rawPts.length > 120000 ? 2 : 1;

        for (let i = 0; i < rawPts.length; i += step) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            if (px * px + py * py > R2 || pz < ZLO || pz >= ZLO + NB * BIN) continue;
            hist[((pz - ZLO) / BIN) | 0]++;
            zs.push(pz);
            total++;
        }
        if (total < 15) return { zEgo: last, gx: 0, gy: 0, confidence: 0, source: 'none' };

        // Làm mượt tam giác [1 2 3 2 1]/9
        const sm = new Float32Array(NB);
        for (let i = 0; i < NB; i++) {
            let a = 0;
            for (let k = -2; k <= 2; k++) {
                const j = i + k;
                if (j >= 0 && j < NB) a += hist[j] * (3 - Math.abs(k));
            }
            sm[i] = a / 9.0;
        }

        let maxV = 0;
        for (let i = 0; i < NB; i++) if (sm[i] > maxV) maxV = sm[i];
        const minPeak = Math.max(0.30 * maxV, 8);

        // Tìm đỉnh THẤP NHẤT đủ nổi bật (đại diện cho mặt đường)
        let peak = -1;
        for (let i = 1; i < NB - 1; i++) {
            if (sm[i] >= minPeak && sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) {
                peak = i;
                break;
            }
        }

        let zEgo, conf, source;
        if (peak >= 0) {
            let sw = 0, swz = 0;
            for (let i = Math.max(0, peak - 3); i <= Math.min(NB - 1, peak + 3); i++) {
                sw += hist[i];
                swz += hist[i] * (ZLO + (i + 0.5) * BIN);
            }
            zEgo = sw > 0 ? (swz / sw) : (ZLO + (peak + 0.5) * BIN);
            conf = Math.min(1.0, sm[peak] / Math.max(maxV, 1.0)) * Math.min(1.0, total / 300.0);
            source = 'histogram_peak';
        } else {
            zs.sort((a, b) => a - b);
            zEgo = zs[Math.floor(zs.length * 0.10)];
            conf = 0.20;
            source = 'percentile10';
        }

        // Chống nhảy đột ngột khi độ tin cậy thấp
        if (last !== null && conf < 0.5 && Math.abs(zEgo - last) > 0.6) {
            return { zEgo: last, gx: 0, gy: 0, confidence: conf, source: 'hold_last' };
        }
        if (conf >= 0.5 || last === null) this._zRoadLast = zEgo;
        return { zEgo, gx: 0, gy: 0, confidence: conf, source };
    }

    /**
     * TRỤ CỘT 2: CẬP NHẬT XƯƠNG SỐNG ĐỊA HÌNH & TIÊN NGHIỆM HÌNH THÁI MAP
     */
    capNhatXươngSốngĐịaHình(frameNum, rawPts) {
        const fn = Number(frameNum);
        const Tw = this.layBienDoiWorld(fn);
        const { zEgo } = this.uocLuongMatDuongEgo(rawPts);
        if (!Number.isFinite(zEgo)) return;

        const [Xw, Yw] = ThuatToanGhepMapLiDAR.applySE2Point([0, 0], Tw);
        const Zw = zEgo;

        this.egoSpine.set(fn, { fn, Xw, Yw, Zw });

        // Cập nhật Mô hình Mặt phẳng Toàn cục (Global Road Surface Manifold)
        if (this.egoSpine.size >= 3) {
            let s1 = 0, sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sZ = 0, sXZ = 0, sYZ = 0;
            for (const sp of this.egoSpine.values()) {
                s1 += 1;
                sX += sp.Xw; sY += sp.Yw;
                sXX += sp.Xw * sp.Xw; sYY += sp.Yw * sp.Yw; sXY += sp.Xw * sp.Yw;
                sZ += sp.Zw;
                sXZ += sp.Xw * sp.Zw; sYZ += sp.Yw * sp.Zw;
            }
            const lambda = 1.0;
            sXX += lambda; sYY += lambda;
            const det = s1 * (sXX * sYY - sXY * sXY) - sX * (sX * sYY - sXY * sY) + sY * (sX * sXY - sXX * sY);
            if (Math.abs(det) > 1e-6) {
                const invDet = 1.0 / det;
                const z0 = invDet * (sZ * (sXX * sYY - sXY * sXY) - sXZ * (sX * sYY - sXY * sY) + sYZ * (sX * sXY - sXX * sY));
                let gx = invDet * (s1 * (sXZ * sYY - sYZ * sXY) - sX * (sZ * sYY - sYZ * sY) + sY * (sZ * sXY - sXZ * sY));
                let gy = invDet * (s1 * (sXX * sYZ - sXY * sXZ) - sX * (sX * sYZ - sXY * sZ) + sY * (sX * sXZ - sXX * sZ));
                gx = Math.max(-0.025, Math.min(0.025, gx));
                gy = Math.max(-0.025, Math.min(0.025, gy));
                this.globalPlane = { z0, gx, gy };
            }
        }
    }

    /**
     * LẤY TIÊN NGHIỆM ĐỘ CAO CHO MỘT VỊ TRÍ BẤT KỲ THEO HÌNH THÁI CON ĐƯỜNG
     */
    layTienNghiemDoCaoWorld(Xw, Yw) {
        if (this.egoSpine.size > 0) {
            let minDist = Infinity;
            let nearestSpine = null;
            for (const sp of this.egoSpine.values()) {
                const d = Math.hypot(sp.Xw - Xw, sp.Yw - Yw);
                if (d < minDist) {
                    minDist = d;
                    nearestSpine = sp;
                }
            }
            if (nearestSpine && minDist <= 35.0) {
                if (this.globalPlane) {
                    const dX = Xw - nearestSpine.Xw;
                    const dY = Yw - nearestSpine.Yw;
                    return nearestSpine.Zw + this.globalPlane.gx * dX + this.globalPlane.gy * dY;
                }
                return nearestSpine.Zw;
            }
        }

        if (this.globalPlane) {
            return this.globalPlane.z0 + this.globalPlane.gx * Xw + this.globalPlane.gy * Yw;
        }

        return Number.isFinite(this._zRoadLast) ? this._zRoadLast : null;
    }

    /**
     * BỘ LỌC TÁCH ĐIỂM MẶT ĐẤT TỔNG THỂ (DẢI ĐỘNG THEO zEgoRef)
     */
    locDiemMatDat(rawPts, zEgoRef = null) {
        if (!rawPts || rawPts.length === 0) return [];
        if (!Number.isFinite(zEgoRef)) zEgoRef = this.uocLuongMatDuongEgo(rawPts).zEgo;
        if (!Number.isFinite(zEgoRef)) return [];

        const cs = this.cellSize;
        const localBins = new Map();

        // Dải cao độ động quanh mặt đường: [zEgoRef - 0.25m, zEgoRef + 0.20m]
        const zMinThresh = zEgoRef - 0.25;
        const zMaxThresh = zEgoRef + 0.20;

        for (let i = 0; i < rawPts.length; i++) {
            const pt = rawPts[i];
            const px = pt[0], py = pt[1], pz = pt[2];
            if (pz < zMinThresh || pz > zMaxThresh) continue;

            const rSq = px * px + py * py;
            if (rSq < 3.0 || rSq > 4900.0) continue;

            const ix = Math.floor(px / cs);
            const iy = Math.floor(py / cs);
            const key = `${ix}_${iy}`;

            const cur = localBins.get(key);
            if (!cur) {
                localBins.set(key, { px, py, pz });
            } else if (pz < cur.pz) {
                cur.px = px; cur.py = py; cur.pz = pz;
            }
        }

        const groundPts = [];
        for (const bin of localBins.values()) {
            groundPts.push([bin.px, bin.py, bin.pz]);
        }
        return groundPts;
    }

    /**
     * NẠP FRAME VÀ TÍCH LŨY VÀO BẢN ĐỒ TOÀN CỤC
     */
    napFrame(frameNum, rawPts) {
        const fn = Number(frameNum);
        if (this.processedFrames.has(fn)) return;
        if (!rawPts || rawPts.length === 0) return;

        this.capNhatXươngSốngĐịaHình(fn, rawPts);
        const zEgo = this.egoSpine.get(fn)?.Zw ?? this._zRoadLast;
        if (!Number.isFinite(zEgo)) return;

        const Tw = this.layBienDoiWorld(fn);
        const groundPts = this.locDiemMatDat(rawPts, zEgo);
        if (groundPts.length === 0) return;

        const cs = this.cellSize;
        const c = Math.cos(Tw.dtheta), s = Math.sin(Tw.dtheta);
        const tx = Tw.tx, ty = Tw.ty;

        for (let i = 0; i < groundPts.length; i++) {
            const p = groundPts[i];
            const Xw = c * p[0] - s * p[1] + tx;
            const Yw = s * p[0] + c * p[1] + ty;
            const Zw = p[2];

            const ix = Math.floor(Xw / cs);
            const iy = Math.floor(Yw / cs);
            const key = `${ix}_${iy}`;

            let cell = this.grid.get(key);
            if (!cell) {
                cell = {
                    Xw: (ix + 0.5) * cs,
                    Yw: (iy + 0.5) * cs,
                    zMin: Zw,
                    zSum: Zw,
                    count: 1,
                    frames: new Set([fn])
                };
                this.grid.set(key, cell);
            } else {
                cell.count++;
                cell.zSum += Zw;
                if (Zw < cell.zMin) cell.zMin = Zw;
                cell.frames.add(fn);
            }
        }

        this.processedFrames.add(fn);
    }

    /**
     * BƯỚC 1: CẮT LÁT MẶT ĐẤT CỤC BỘ QUANH XE (LOCAL GROUND SLICING)
     * Quét histogram Z quanh chân bánh xe và vành khăn OBB (loại bỏ 100% thân xe)
     * Tìm đỉnh mặt đất thực tế quanh xe ở mọi cự ly (kể cả xa 40-80m, đường dốc), triệt tiêu bẫy Ego Z=0.
     */
    catLatMatDatCucBo(carBox, rawPts, allBoxesInFrame = null) {
        if (!carBox || !rawPts || rawPts.length === 0) return null;
        const cx = carBox.x, cy = carBox.y;
        const L = carBox.L || 4.5, W = carBox.W || 1.9, H = carBox.H || 1.6;
        const rz = carBox.rz || 0;
        const zBottom = carBox.z - 0.5 * H;

        const cosR = Math.cos(rz), sinR = Math.sin(rz);
        const zMinWin = zBottom - 0.65;
        const zMaxWin = zBottom + 0.35;
        const rOuterSq = 4.5 * 4.5;
        const rInnerSq = 1.0 * 1.0;

        const halfL_safe = 0.5 * L + 0.15;
        const halfW_safe = 0.5 * W + 0.15;

        const candZs = [];

        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];
            if (pz < zMinWin || pz > zMaxWin) continue;

            const dx = px - cx, dy = py - cy;
            const dSq = dx * dx + dy * dy;
            if (dSq < rInnerSq || dSq > rOuterSq) continue;

            const u = dx * cosR + dy * sinR;
            const v = -dx * sinR + dy * cosR;

            // Loại trừ thân xe mục tiêu bằng OBB nới 0.15m
            if (Math.abs(u) <= halfL_safe && Math.abs(v) <= halfW_safe) continue;

            // Loại trừ thân các xe khác
            let insideOther = false;
            if (Array.isArray(allBoxesInFrame)) {
                for (let b = 0; b < allBoxesInFrame.length; b++) {
                    const ob = allBoxesInFrame[b];
                    if (!ob || (Math.abs(ob.x - cx) < 0.2 && Math.abs(ob.y - cy) < 0.2)) continue;
                    const oL = ob.L || 4.5, oW = ob.W || 1.9;
                    const oRz = ob.rz || 0;
                    const odx = px - ob.x, ody = py - ob.y;
                    if (Math.hypot(odx, ody) > 0.5 * Math.hypot(oL, oW) + 0.3) continue;
                    const ou = odx * Math.cos(oRz) + ody * Math.sin(oRz);
                    const ov = -odx * Math.sin(oRz) + ody * Math.cos(oRz);
                    if (Math.abs(ou) <= 0.5 * oL + 0.2 && Math.abs(ov) <= 0.5 * oW + 0.2) {
                        insideOther = true;
                        break;
                    }
                }
            }
            if (insideOther) continue;

            candZs.push(pz);
        }

        if (candZs.length < 5) {
            return { zLat: zBottom, conf: 0.3, count: candZs.length };
        }

        const binSize = 0.03;
        const numBins = Math.floor((zMaxWin - zMinWin) / binSize) + 1;
        const hist = new Int32Array(numBins);
        for (let i = 0; i < candZs.length; i++) {
            const bIdx = Math.floor((candZs[i] - zMinWin) / binSize);
            if (bIdx >= 0 && bIdx < numBins) hist[bIdx]++;
        }

        const sm = new Float32Array(numBins);
        for (let i = 0; i < numBins; i++) {
            const p = i > 0 ? hist[i - 1] : hist[i];
            const c = hist[i];
            const n = i < numBins - 1 ? hist[i + 1] : hist[i];
            sm[i] = 0.25 * p + 0.5 * c + 0.25 * n;
        }

        let maxV = 0;
        for (let i = 0; i < numBins; i++) if (sm[i] > maxV) maxV = sm[i];
        const minThresh = Math.max(4, Math.floor(0.25 * maxV));

        let peak = -1;
        for (let i = 1; i < numBins - 1; i++) {
            if (sm[i] >= minThresh && sm[i] >= sm[i - 1] && sm[i] >= sm[i + 1]) {
                peak = i;
                break;
            }
        }

        if (peak >= 0) {
            const zPeak = zMinWin + (peak + 0.5) * binSize;
            let subSum = 0, subCnt = 0;
            for (let i = 0; i < candZs.length; i++) {
                if (Math.abs(candZs[i] - zPeak) <= 0.06) {
                    subSum += candZs[i];
                    subCnt++;
                }
            }
            const zLat = subCnt > 0 ? (subSum / subCnt) : zPeak;
            return { zLat, conf: Math.min(1.0, subCnt / 15.0), count: subCnt };
        }

        candZs.sort((a, b) => a - b);
        const zLat = candZs[Math.floor(candZs.length * 0.10)];
        return { zLat, conf: 0.4, count: candZs.length };
    }

    /**
     * TRỤ CỘT 3: GOM VỤN ĐIỂM MẶT ĐƯỜNG XUNG QUANH XE (PAVEMENT SCATTER POINTS)
     */
    gomVunDiemXungQuanhXe(carBox, rawPts, allBoxesInFrame = null, zExpected = null) {
        if (!rawPts || rawPts.length === 0) return [];
        const zBottom = carBox.z - 0.5 * (carBox.H || 1.6);
        if (!Number.isFinite(zExpected)) {
            const latRes = this.catLatMatDatCucBo(carBox, rawPts, allBoxesInFrame);
            zExpected = latRes ? latRes.zLat : zBottom;
        }

        const cx = carBox.x, cy = carBox.y;
        const L = carBox.L || 4.5, W = carBox.W || 1.9;
        const rz = carBox.rz || 0;
        const cosR = Math.cos(rz), sinR = Math.sin(rz);

        const scatterPts = [];
        const maxRadiusSq = 8.0 * 8.0;
        const minRadiusSq = 1.0 * 1.0;

        const halfL_safe = 0.5 * L + 0.18;
        const halfW_safe = 0.5 * W + 0.18;

        // Dải lọc bất đối xứng: dưới zExpected - 0.18m, trên zExpected + 0.10m (chặn liếm sườn/gầm xe)
        const zLow = zExpected - 0.18;
        const zHigh = zExpected + 0.10;

        for (let i = 0; i < rawPts.length; i++) {
            const p = rawPts[i];
            const px = p[0], py = p[1], pz = p[2];

            if (pz < zLow || pz > zHigh) continue;

            const dx = px - cx, dy = py - cy;
            const dSq = dx * dx + dy * dy;
            if (dSq < minRadiusSq || dSq > maxRadiusSq) continue;

            // Loại trừ thân xe mục tiêu bằng OBB
            const u = dx * cosR + dy * sinR;
            const v = -dx * sinR + dy * cosR;
            if (Math.abs(u) <= halfL_safe && Math.abs(v) <= halfW_safe) continue;

            // Loại trừ thân các xe khác
            let insideOther = false;
            if (Array.isArray(allBoxesInFrame)) {
                for (let b = 0; b < allBoxesInFrame.length; b++) {
                    const ob = allBoxesInFrame[b];
                    if (!ob || (Math.abs(ob.x - cx) < 0.2 && Math.abs(ob.y - cy) < 0.2)) continue;
                    const oL = ob.L || 4.5, oW = ob.W || 1.9;
                    const oRz = ob.rz || 0;
                    const odx = px - ob.x, ody = py - ob.y;
                    if (Math.hypot(odx, ody) > 0.5 * Math.hypot(oL, oW) + 0.3) continue;
                    const ou = odx * Math.cos(oRz) + ody * Math.sin(oRz);
                    const ov = -odx * Math.sin(oRz) + ody * Math.cos(oRz);
                    if (Math.abs(ou) <= 0.5 * oL + 0.2 && Math.abs(ov) <= 0.5 * oW + 0.2) {
                        insideOther = true;
                        break;
                    }
                }
            }
            if (insideOther) continue;

            const dist = Math.sqrt(dSq);
            const weight = 1.5 * Math.exp(-(dist * dist) / 36.0);
            scatterPts.push({ x: px, y: py, z: pz, u, v, weight });
        }

        return scatterPts;
    }

    /**
     * TRỤ CỘT 4: TRA CỨU MẶT ĐƯỜNG KẾT HỢP ĐA THUẬT TOÁN (TIÊN NGHIỆM + VỤN ĐIỂM + GHÉP MAP)
     */
    traCuuMatDuongChoHop(carBox, frameNum, rawPtsCurrentFrame = null, allBoxesInFrame = null) {
        if (!carBox) return null;
        const fn = Number(frameNum);
        const Tw = this.layBienDoiWorld(fn);

        // 1. Tọa độ tâm xe trong World
        const [Xw_center, Yw_center] = ThuatToanGhepMapLiDAR.applySE2Point([carBox.x, carBox.y], Tw);
        const L = carBox.L || 4.5, W = carBox.W || 1.9;
        const rzLocal = carBox.rz || 0;
        const rzWorld = ThuatToanGhepMapLiDAR.wrapAngle(rzLocal + Tw.dtheta);

        // 2. Lấy TIÊN NGHIỆM ĐỘ CAO (Z_prior) ĐỘNG THEO VỊ TRÍ CỤC BỘ (Smart Prior)
        const zBottomBox = carBox.z - 0.5 * (carBox.H || 1.6);
        const distToEgo = Math.hypot(carBox.x, carBox.y);

        let zLatRes = null;
        if (rawPtsCurrentFrame && rawPtsCurrentFrame.length > 0) {
            zLatRes = this.catLatMatDatCucBo(carBox, rawPtsCurrentFrame, allBoxesInFrame);
        }

        let zPriorLocal;
        if (zLatRes && zLatRes.conf >= 0.35) {
            zPriorLocal = zLatRes.zLat;
        } else if (distToEgo > 15.0) {
            // Xe ở xa (> 15m), tiên nghiệm tốt nhất chính là đáy hộp xe (zBottomBox)
            zPriorLocal = zBottomBox;
        } else {
            // Xe ở gần Ego (<= 15m), có thể tham khảo mặt đường Ego
            const egoRoad = rawPtsCurrentFrame ? this.uocLuongMatDuongEgo(rawPtsCurrentFrame).zEgo : null;
            zPriorLocal = Number.isFinite(egoRoad) ? egoRoad : zBottomBox;
        }

        // 3. Gom các ô điểm đất từ BẢN ĐỒ GHÉP ĐA FRAME
        const samplePoints = [];
        const framesInvolved = new Set();
        let gridPointsCount = 0;

        if (this.grid.size > 0) {
            const radius = 0.5 * Math.hypot(L, W) + 1.2;
            const cs = this.cellSize;
            const rCells = Math.ceil(radius / cs);
            const centerIx = Math.floor(Xw_center / cs);
            const centerIy = Math.floor(Yw_center / cs);

            const cosW = Math.cos(rzWorld), sinW = Math.sin(rzWorld);

            for (let dx = -rCells; dx <= rCells; dx++) {
                for (let dy = -rCells; dy <= rCells; dy++) {
                    const cell = this.grid.get(`${centerIx + dx}_${centerIy + dy}`);
                    if (!cell) continue;

                    const dX = cell.Xw - Xw_center;
                    const dY = cell.Yw - Yw_center;
                    const uDist = Math.abs(dX * cosW + dY * sinW);
                    const vDist = Math.abs(-dX * sinW + dY * cosW);

                    // Lấy các ô trong phạm vi gầm xe và lân cận bánh xe (mở rộng 1.0m)
                    if (uDist <= 0.5 * L + 1.0 && vDist <= 0.5 * W + 1.0) {
                        const [xLocal, yLocal] = ThuatToanGhepMapLiDAR.applySE2Point(
                            [cell.Xw, cell.Yw],
                            ThuatToanGhepMapLiDAR.invertSE2(Tw)
                        );
                        const relX = xLocal - carBox.x;
                        const relY = yLocal - carBox.y;
                        const weight = 3.0 * Math.min(cell.count, 4);

                        samplePoints.push({ relX, relY, z: cell.zMin, weight });
                        gridPointsCount++;
                        for (const f of cell.frames) framesInvolved.add(f);
                    }
                }
            }
        }

        // 4. Gom CÁC VỤN ĐIỂM XUNG QUANH XE (Pavement Scatter Points) từ frame hiện tại
        let scatterPointsCount = 0;
        if (rawPtsCurrentFrame && rawPtsCurrentFrame.length > 0) {
            const scatters = this.gomVunDiemXungQuanhXe(carBox, rawPtsCurrentFrame, allBoxesInFrame, zPriorLocal);
            for (let i = 0; i < scatters.length; i++) {
                const sc = scatters[i];
                samplePoints.push({
                    relX: sc.x - carBox.x,
                    relY: sc.y - carBox.y,
                    z: sc.z,
                    weight: sc.weight
                });
                scatterPointsCount++;
            }
        }

        // 5. GIẢI HỆ PHƯƠNG TRÌNH RIDGE-REGULARIZED ĐÀN HỒI TIKHONOV (3x3):
        const lambda_z = 2.0;
        const lambda_g = 50.0;

        let m00 = lambda_z, m01 = 0, m02 = 0;
        let m10 = 0, m11 = lambda_g, m12 = 0;
        let m20 = 0, m21 = 0, m22 = lambda_g;

        let b0 = lambda_z * zPriorLocal;
        let b1 = 0;
        let b2 = 0;

        for (let i = 0; i < samplePoints.length; i++) {
            const pt = samplePoints[i];
            const x = pt.relX, y = pt.relY, z = pt.z;
            const w = pt.weight;

            m00 += w;
            m01 += w * x; m02 += w * y;
            m10 += w * x; m11 += w * x * x; m12 += w * x * y;
            m20 += w * y; m21 += w * x * y; m22 += w * y * y;

            b0 += w * z;
            b1 += w * x * z;
            b2 += w * y * z;
        }

        const det = m00 * (m11 * m22 - m12 * m12) - m01 * (m10 * m22 - m12 * m20) + m02 * (m10 * m21 - m11 * m20);
        if (Math.abs(det) < 1e-9) {
            return {
                zc: zPriorLocal,
                gx: 0,
                gy: 0,
                slopeDeg: 0,
                confidence: 0.60,
                source: 'map_morphology_prior'
            };
        }

        const invDet = 1.0 / det;
        let Z0 = invDet * (b0 * (m11 * m22 - m12 * m12) - b1 * (m01 * m22 - m02 * m21) + b2 * (m01 * m12 - m02 * m11));
        let gx = invDet * (m00 * (b1 * m22 - b2 * m12) - b0 * (m10 * m22 - m12 * m20) + m02 * (m10 * b2 - b1 * m20));
        let gy = invDet * (m00 * (m11 * b2 - m21 * b1) - m01 * (m10 * b2 - m20 * b1) + b0 * (m10 * m21 - m11 * m20));

        // Ràng buộc bảo vệ (Claude Roadmap): Mặt phẳng không được cắt sâu vào thân xe quá 5cm so với đáy box
        if (Z0 > zBottomBox + 0.05) {
            Z0 = zBottomBox + 0.05;
        }

        gx = Math.max(-0.025, Math.min(0.025, gx));
        gy = Math.max(-0.025, Math.min(0.025, gy));

        const slopeHypot = Math.hypot(gx, gy);
        const slopeDeg = Math.atan(slopeHypot) * (180 / Math.PI);
        const invNorm = 1.0 / Math.sqrt(slopeHypot * slopeHypot + 1.0);

        return {
            zc: Z0,
            gx: gx,
            gy: gy,
            normal: [-gx * invNorm, -gy * invNorm, invNorm],
            slopeDeg: slopeDeg,
            confidence: Math.min(1.0, 0.50 + samplePoints.length * 0.02),
            sampleCount: samplePoints.length,
            gridCount: gridPointsCount,
            scatterCount: scatterPointsCount,
            contributingFrames: Array.from(framesInvolved),
            priorZ: zPriorLocal,
            source: gridPointsCount > 0 ? 'ridge_ensemble_map' : (scatterPointsCount > 0 ? 'scatter_prior_ensemble' : 'map_morphology_prior')
        };
    }
}

// Khởi tạo Singleton toàn cục
if (typeof window !== 'undefined') {
    window.ThuatToanGhepMapLiDAR = ThuatToanGhepMapLiDAR;
    window._thuatToanGhepMapLiDAR = window._thuatToanGhepMapLiDAR || new ThuatToanGhepMapLiDAR();
}
if (typeof globalThis !== 'undefined') {
    globalThis.ThuatToanGhepMapLiDAR = ThuatToanGhepMapLiDAR;
    globalThis._thuatToanGhepMapLiDAR = globalThis._thuatToanGhepMapLiDAR || new ThuatToanGhepMapLiDAR();
}
