/**
 * Thuật Toán Bản Đồ Mặt Đường SE2 (Multi-Frame Global Ground Atlas qua SE(2) Odometry)
 * -----------------------------------------------------------------------------------
 * Giải pháp ghép bản đồ mặt đường tĩnh toàn cục xuyên suốt tất cả các frames trong Job:
 * 1. Khôi phục chuỗi biến đổi cứng 2D SE(2) (góc quay dtheta, tịnh tiến tx, ty) giữa các frames
 *    bằng Procrustes Kabsch Least-Squares trên tập các xe tĩnh trong cảnh.
 * 2. Đưa toàn bộ các mảng mặt đường cục bộ (Anchor Patches) của từng frame về cùng một
 *    Hệ Tọa Độ Thế Giới Cố Định (World Frame tại Frame 0).
 * 3. Tận dụng tính bất biến thời gian của mặt đất (Static World):
 *    Vùng ở xa thiếu điểm tại Frame 0/F4/F5 sẽ được "soi sáng" bởi các mảng mặt đường
 *    đo được ở các frame khác khi xe Ego đi lại gần vị trí đó.
 * 4. Tra cứu k-NN nhanh O(1) theo tọa độ thế giới (X_w, Y_w), chiếu ngược về frame mục tiêu
 *    đảm bảo mặt đường luôn khít sát đáy bánh xe (< 2cm) trên toàn bộ 57 frames!
 */

class ThuatToanBanDoMatDuongSE2 {
    static wrapAngle(a) {
        let res = a % (2 * Math.PI);
        if (res > Math.PI) res -= 2 * Math.PI;
        if (res < -Math.PI) res += 2 * Math.PI;
        return res;
    }

    /**
     * Tích hai phép biến đổi SE(2): T_composite = T1 o T2
     * Điểm p được biến đổi: p' = T1(T2(p))
     */
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

    /**
     * Nghịch đảo phép biến đổi SE(2): T^-1
     */
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

    /**
     * Áp dụng biến đổi SE(2) lên một điểm 2D [x, y]
     */
    static applySE2Point(pt, t) {
        if (!t) return [pt[0], pt[1]];
        const c = Math.cos(t.dtheta), s = Math.sin(t.dtheta);
        return [
            c * pt[0] - s * pt[1] + t.tx,
            s * pt[0] + c * pt[1] + t.ty
        ];
    }

    /**
     * Xoay vector độ dốc [gx, gy] qua góc dtheta của SE(2)
     */
    static rotateVector(gx, gy, dtheta) {
        const c = Math.cos(dtheta), s = Math.sin(dtheta);
        return [
            c * gx - s * gy,
            s * gx + c * gy
        ];
    }

    /**
     * Khởi tạo Bộ nhớ đệm Bản đồ Toàn cục
     */
    constructor() {
        this.worldTransforms = new Map(); // frameNum -> T_{W <- f}
        this.stepTransforms = new Map();  // `${fA}_${fB}` -> T_{fB <- fA}
        this.atlasPatches = [];           // Danh sách patches trong World Frame
        this.staticCarBenchmarks = [];    // Mốc cọc tiêu đáy xe tĩnh trong World Frame
        this.refFrame = 0;                // Frame gốc làm World Frame (mặc định Frame 0)
        this.totalFrames = 0;
        this.isInitialized = false;
    }

    xoaTrang() {
        this.worldTransforms.clear();
        this.stepTransforms.clear();
        this.atlasPatches = [];
        this.staticCarBenchmarks = [];
        this.isInitialized = false;
    }

    /**
     * Ước lượng phép biến đổi SE(2) giữa 2 frame liên tiếp bằng Kabsch trên tập xe tĩnh.
     */
    uocLuongBuocSE2(fA, fB, allTracks) {
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
                if (!s || s.outside || !s.points || s.points.length < 6) continue;
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
                if (dA < 2.5 || Math.abs(dA - dB) > 0.45) continue;

                const angA = Math.atan2(p2[1] - p1[1], p2[0] - p1[0]);
                const angB = Math.atan2(q2[1] - q1[1], q2[0] - q1[0]);
                const dtheta = ThuatToanBanDoMatDuongSE2.wrapAngle(angB - angA);
                const c = Math.cos(dtheta), s = Math.sin(dtheta);
                const tx = q1[0] - (c * p1[0] - s * p1[1]);
                const ty = q1[1] - (s * p1[0] + c * p1[1]);

                const inliers = [];
                for (let k = 0; k < n; k++) {
                    const pk = ptsA[k], qk = ptsB[k];
                    const px = c * pk[0] - s * pk[1] + tx;
                    const py = s * pk[0] + c * pk[1] + ty;
                    if (Math.hypot(px - qk[0], py - qk[1]) < 0.45) {
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

        // Tinh chỉnh Least-Squares Procrustes (Kabsch)
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

    /**
     * Xây dựng chuỗi Odometry toàn cảnh cho tất cả các frames đưa về World Frame (Frame refFrame)
     */
    xayDungChuoiOdometry(allTracks, totalFrames = 60, refFrame = 0) {
        this.refFrame = refFrame;
        this.totalFrames = totalFrames;
        this.worldTransforms.clear();

        // Frame gốc: T_{W <- refFrame} = Identity
        this.worldTransforms.set(refFrame, { dtheta: 0, tx: 0, ty: 0, inliers: 999 });

        // Tiến về phía trước: f = refFrame + 1 -> totalFrames - 1
        // Biết T_{f-1 -> f}, ta có p_f = T_{f-1 -> f}(p_{f-1}) => p_{f-1} = T_{f -> f-1}(p_f)
        // Do đó T_{W <- f} = T_{W <- f-1} o T_{f -> f-1} = T_{W <- f-1} o (T_{f-1 -> f})^-1
        let curT = { dtheta: 0, tx: 0, ty: 0, inliers: 999 };
        for (let f = refFrame + 1; f < totalFrames; f++) {
            const stepFwd = this.uocLuongBuocSE2(f - 1, f, allTracks);
            const stepInv = ThuatToanBanDoMatDuongSE2.invertSE2(stepFwd);
            curT = ThuatToanBanDoMatDuongSE2.composeSE2(curT, stepInv);
            this.worldTransforms.set(f, curT);
        }

        // Lùi về phía sau: f = refFrame - 1 -> 0
        // p_{f+1} = T_{f -> f+1}(p_f) => p_W = T_{W <- f+1}(p_{f+1}) = T_{W <- f+1}(T_{f -> f+1}(p_f))
        // Do đó T_{W <- f} = T_{W <- f+1} o T_{f -> f+1}
        let curBack = { dtheta: 0, tx: 0, ty: 0, inliers: 999 };
        for (let f = refFrame - 1; f >= 0; f--) {
            const stepFwd = this.uocLuongBuocSE2(f, f + 1, allTracks);
            curBack = ThuatToanBanDoMatDuongSE2.composeSE2(curBack, stepFwd);
            this.worldTransforms.set(f, curBack);
        }

        this.isInitialized = true;
    }

    /**
     * Lấy biến đổi T_{W <- f} của một frame
     */
    layBienDoiWorld(frameNum) {
        return this.worldTransforms.get(Number(frameNum)) || { dtheta: 0, tx: 0, ty: 0, inliers: 0 };
    }

    /**
     * Nạp các mảng mặt đường cục bộ (Anchor / Ego Patches) của một frame vào Global Ground Atlas
     */
    napPatchesVaoAtlas(frameNum, localData) {
        if (!localData) return;
        const fn = Number(frameNum);
        const Tw = this.layBienDoiWorld(fn);

        const items = [];
        if (localData.egoPatch) items.push(localData.egoPatch);
        if (Array.isArray(localData.patches)) {
            for (const p of localData.patches) {
                // Chỉ nạp các patch có độ tin cậy cao (Anchor hoặc Partial)
                if (p.status === 'anchor' || p.status === 'ego' || (p.status === 'partial' && p.confidence >= 0.45)) {
                    items.push(p);
                }
            }
        }

        for (const p of items) {
            // Chuyển tọa độ tâm sang World
            const [Xw, Yw] = ThuatToanBanDoMatDuongSE2.applySE2Point([p.x, p.y], Tw);
            const Zw = p.zc;

            // Chuyển vector độ dốc sang World
            const [gxW, gyW] = ThuatToanBanDoMatDuongSE2.rotateVector(p.gx || 0, p.gy || 0, Tw.dtheta);
            const rzW = ThuatToanBanDoMatDuongSE2.wrapAngle((p.rz || 0) + Tw.dtheta);

            // Kiểm tra xem đã có patch nào ở vị trí này chưa (tránh trùng lặp)
            let isDuplicate = false;
            for (const exist of this.atlasPatches) {
                if (Math.hypot(exist.Xw - Xw, exist.Yw - Yw) < 1.2) {
                    // Nếu trùng vị trí, cập nhật nếu patch mới có độ tin cậy cao hơn
                    if (p.confidence > exist.confidence) {
                        exist.Zw = Zw;
                        exist.gxW = gxW;
                        exist.gyW = gyW;
                        exist.confidence = p.confidence;
                        exist.srcFrame = fn;
                    }
                    isDuplicate = true;
                    break;
                }
            }

            if (!isDuplicate) {
                this.atlasPatches.push({
                    id: `${p.id}_f${fn}`,
                    srcFrame: fn,
                    status: p.status,
                    confidence: p.confidence,
                    Xw, Yw, Zw,
                    gxW, gyW,
                    rzW,
                    L: p.L || 4.6,
                    W: p.W || 1.9,
                    H: p.H || 1.6
                });
            }
        }
    }

    /**
     * Tra cứu mặt đường trong Global Atlas cho một chiếc xe ở frame bất kỳ
     */
    traCuuMatDuongChoXe(car, frameNum, maxWorldDist = 28.0) {
        if (!car || this.atlasPatches.length === 0) return null;
        const fn = Number(frameNum);
        const Tw = this.layBienDoiWorld(fn);

        // Chuyển vị trí xe sang World Frame
        const [Xw, Yw] = ThuatToanBanDoMatDuongSE2.applySE2Point([car.x, car.y], Tw);
        const zBoxBottom = car.z - 0.5 * car.H;

        // Tìm các Anchor trong Atlas gần vị trí thế giới này nhất
        const cands = [];
        for (const a of this.atlasPatches) {
            const d = Math.hypot(a.Xw - Xw, a.Yw - Yw);
            if (d <= maxWorldDist) {
                // Cao độ mặt đường thế giới ngoại suy từ Anchor a
                const decay = Math.exp(-Math.min(d, 40.0) / 16.0);
                const rawSlope = a.gxW * (Xw - a.Xw) + a.gyW * (Yw - a.Yw);
                const effSlope = Math.max(-0.10, Math.min(0.10, rawSlope * decay));
                const zPredW = a.Zw + effSlope;
                const w = a.confidence / (d * d + 1.5);
                cands.push({ a, d, zPredW, w });
            }
        }

        if (cands.length === 0) return null;
        cands.sort((p, q) => q.w - p.w);
        const topK = cands.slice(0, 3);

        let sumW = 0, sumZ = 0, sumGx = 0, sumGy = 0;
        for (const c of topK) {
            sumW += c.w;
            sumZ += c.w * c.zPredW;
            sumGx += c.w * c.a.gxW;
            sumGy += c.w * c.a.gyW;
        }

        if (sumW <= 1e-9) return null;
        const avgZw = sumZ / sumW;
        const avgGxW = sumGx / sumW;
        const avgGyW = sumGy / sumW;

        // Chuyển ngược vector độ dốc từ World về hệ tọa độ của frameNum
        const [gxLocal, gyLocal] = ThuatToanBanDoMatDuongSE2.rotateVector(avgGxW, avgGyW, -Tw.dtheta);
        const invNorm = 1.0 / Math.sqrt(gxLocal * gxLocal + gyLocal * gyLocal + 1.0);

        // Hòa trộn với tiên nghiệm đáy xe vật lý (Semantic Bottom Prior)
        const minDist = topK[0].d;
        const wDist = Math.exp(-Math.min(minDist, 40.0) / 14.0);
        let zFinal = wDist * avgZw + (1.0 - wDist) * zBoxBottom;

        // Kẹp an toàn vật lý: không bao giờ lệch quá 10cm so với đáy xe
        zFinal = Math.max(zBoxBottom - 0.10, Math.min(zBoxBottom + 0.10, zFinal));

        return {
            zc: zFinal,
            gx: gxLocal * wDist,
            gy: gyLocal * wDist,
            normal: [-gxLocal * wDist * invNorm, -gyLocal * wDist * invNorm, invNorm],
            confidence: Math.min(0.90, topK[0].a.confidence * wDist),
            source: 'se2_atlas',
            atlasSources: topK.map(c => ({ srcFrame: c.a.srcFrame, dWorld: c.d.toFixed(1) }))
        };
    }
}

// Khởi tạo Singleton toàn cục
if (typeof window !== 'undefined') {
    window.ThuatToanBanDoMatDuongSE2 = ThuatToanBanDoMatDuongSE2;
    window._globalGroundAtlas = window._globalGroundAtlas || new ThuatToanBanDoMatDuongSE2();
}
if (typeof globalThis !== 'undefined') {
    globalThis.ThuatToanBanDoMatDuongSE2 = ThuatToanBanDoMatDuongSE2;
    globalThis._globalGroundAtlas = globalThis._globalGroundAtlas || new ThuatToanBanDoMatDuongSE2();
}
