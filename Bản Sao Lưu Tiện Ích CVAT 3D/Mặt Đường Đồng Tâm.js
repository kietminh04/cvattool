/**
 * Mặt Đường Đồng Tâm (Adaptive Polar Annular Sector Ground Model)
 * Thiết kế theo hình học quét LiDAR đồng tâm (r, theta):
 * - Chia vành khuyên theo cấp số nhân rho (gần dày, xa rộng) & cung phương vị.
 * - Cây CART (r, theta) tự tách mảng nơi đường biến thiên rõ/đủ điểm, giữ mảng lớn/UNKNOWN nơi che khuất.
 * - Tuyệt đối KHÔNG đọc cz / zBottom của cuboid (bất biến 100% theo cao độ box đang gán nhãn).
 */
const GOIY_DMAX = 8;        // số lớp viền tối đa tìm quanh bbox lá UNKNOWN
const GOIY_KMAX = 4;        // số LEAF láng giềng tối đa dùng để gợi ý cao độ hiển thị
const GOIY_SAMPLES = 48;    // số ô lấy mẫu tối đa mỗi lớp viền
const GOIY_EPS2 = 1.0;      // m^2, làm mềm trọng số khoảng cách 1/d^2
const GOIY_PRIOR_W = 0.0005; // trọng số dự phòng rất nhẹ cho ringRefZ khi cô lập hoàn toàn
const GOIY_CLAMP = 0.65;    // m, chặn ngoại suy độ dốc gu/gv của LEAF kề (~5m * 0.12)
const REJECT_NGOAI_OPTS = Object.freeze({ rejectNgoaiDuong: true });

function _backfillRingRef(rawSmoothed, nr) {
    const out = new Float32Array(nr);
    out.fill(NaN);
    let first = -1, last = -1;
    for (let r = 0; r < nr; r++) {
        const v = rawSmoothed[r];
        if (Number.isFinite(v)) {
            out[r] = v;
            if (first < 0) first = r;
            last = r;
        }
    }
    if (first < 0) return out;
    const zFirst = out[first];
    for (let r = 0; r < first; r++) out[r] = zFirst;
    const zLast = out[last];
    for (let r = last + 1; r < nr; r++) out[r] = zLast;
    let a = first;
    while (a < last) {
        let b = a + 1;
        while (b <= last && !Number.isFinite(out[b])) b++;
        if (b > a + 1 && b <= last) {
            const za = out[a], zb = out[b];
            const span = b - a;
            for (let r = a + 1; r < b; r++) {
                out[r] = za + (zb - za) * ((r - a) / span);
            }
        }
        a = b;
    }
    return out;
}

class MatDuongDongTam {
    static MAC_DINH = {
        rMin: 4.0,
        rMaxCap: 80.0,
        rho: 1.10,
        NS: 128,                // 2.8125° mỗi cung nền
        rootRingSpan: 4,        // gộp 4 vòng làm 1 nút gốc
        rootSecSpan: 8,         // gộp 8 cung (22.5°) làm 1 nút gốc
        otherPad: 0.30,
        zPassMargin: 0.70,
        // Tham số fit lá (Step 5)
        nEffMin3P: 25,
        nEffMin1P: 10,
        ridgeLambdaPts: 8.0,
        maxSlopeAbs: 0.12,
        maxSlopeDevParent: 0.06,
        minEigRatio: 0.02,
        // Tham số chia/gộp CART (Step 6)
        splitMinNEff: 50,
        splitRmsThr: 0.05,
        splitP95Thr: 0.12,
        splitMinSseGainRatio: 0.15,
        minArcMeters: 2.0,
        pruneRmsMul: 1.10,
        pruneRmsMax: 0.055,
        ngoaiDuongSlopeThr: 0.095,
        // Tham số vòng ngoài & bất định truy vấn (Đợt 2)
        rFarCap: 35.0,
        spanCapRatio: 0.25,
        spanCapMinM: 8.0,
        spanCapMaxM: 14.0,
        zPassMarginFar: 0.30,
        sigmaSlopeUncert: 0.01,
        sigmaFarSlopePerM: 0.0007,
        // Tham số lưới mịn gần xe & dò điểm gãy bán kính (vật cản hẹp / đổi mặt phẳng)
        luoiMin: true,
        drMin: 0.30,
        rFineMax: 14.0,
        minArcMetersNear: 1.0,
        ringSmoothKNear: 5,
        diemGay: true,
        stripGateH: 0.12,
        stripGateSoft: 0.04,
        stripGateSlopeK: 0.03,
        stripGateSlopeCap: 0.10,
        stripMinFrac: 0.10,
        stripMinN: 8,
        stripLeafFrac: 0.55,
        stripMinH: 0.18,
        stripMaxDepth: 4,
        stripLeafBudget: 120,
        maxLeaves: 900,
        diemGaySpan: 0.20,
        diemGaySpanDense: 0.15,
        diemGayPhu: 0.55,
        diemGayMaxGapBase: 0.12,
        diemGayGiniMin: 0.08,
        vatCanTinhNgoaiDuong: false,
        // Tham số làm bền mặt phẳng dự đoán quanh xe (chống vỉa hè/lề kéo lệch dốc)
        robustSurface: {
            enabled: true,
            rejectNgoaiDuong: true,
            irls: { iter: 3, k: 2.5, zeroAt: 2.5, sigmaFloor: 0.015, minInlier: 3 },
            ring: { step: 0.25, stopDz: 0.12, m2Min: 0.40 },
            slopeCap: { lat: 0.035, long: 0.08 },
            lateralRidgeBoost: 3.0,
            patch: { highCellW: 0.02, highShareMax: 0.10, minLowCells: 6 },
            profile: { clampBase: 0.04, clampMax: 0.25 },
            fuseNeoSlope: true,
            crossCar: { enabled: false, radius: 10.0, decay: 6.0 },
            nhayTolBase: 0.12,
            nhayTolDoc: 0.08,
            daoLaMax: 4,
            neoTamXa: 4.0,
            roofLechTol: 0.15
        }
    };

    static _pQuantileSorted(sorted, q) {
        const n = sorted ? sorted.length : 0;
        if (n === 0) return NaN;
        if (n === 1) return sorted[0];
        const pos = Math.max(0, Math.min(1, q)) * (n - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
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
     * Mặt nạ 2D footprint của TẤT CẢ box trong frame (bỏ qua hoàn toàn Z/cz để đảm bảo bất biến cz).
     */
    static buildFootprintMask(frameBoxes, pad = 0.30) {
        const obbs = [];
        if (Array.isArray(frameBoxes)) {
            for (let i = 0; i < frameBoxes.length; i++) {
                const b = frameBoxes[i];
                if (!b) continue;
                const pts = b.shape?.points;
                const cx = Number.isFinite(b.cx) ? b.cx : (Number.isFinite(b.x) ? b.x : (pts ? pts[0] : NaN));
                const cy = Number.isFinite(b.cy) ? b.cy : (Number.isFinite(b.y) ? b.y : (pts ? pts[1] : NaN));
                if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
                const L = b.L || (pts ? pts[6] : 4.5) || 4.5;
                const W = b.W || (pts ? pts[7] : 1.9) || 1.9;
                const rz = Number.isFinite(b.rz) ? b.rz : (pts && Number.isFinite(pts[5]) ? pts[5] : 0);
                const halfL = L * 0.5 + pad;
                const halfW = W * 0.5 + pad;
                const maxR = Math.hypot(halfL, halfW);
                obbs.push({
                    cx, cy,
                    cosR: Math.cos(rz),
                    sinR: Math.sin(rz),
                    halfL, halfW,
                    maxR2: maxR * maxR,
                    minX: cx - maxR, maxX: cx + maxR,
                    minY: cy - maxR, maxY: cy + maxR
                });
            }
        }
        return {
            obbs,
            testXY: (px, py) => {
                for (let i = 0; i < obbs.length; i++) {
                    const o = obbs[i];
                    if (px < o.minX || px > o.maxX || py < o.minY || py > o.maxY) continue;
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

    static _fadeVatCan(rMid, cfg) {
        const rEnd = cfg.rStripEnd ?? 22.0;
        const rFade = cfg.rStripFade ?? 6.0;
        if (rMid <= rEnd) return 1.0;
        if (rMid >= rEnd + rFade) return 0.0;
        return 1.0 - (rMid - rEnd) / Math.max(1e-6, rFade);
    }

    static _minArcTaiR(rMid, cfg) {
        const rNear = cfg.rFineMax ?? 14.0;
        const rFar = rNear + 10.0;
        const aNear = cfg.luoiMin ? (cfg.minArcMetersNear ?? 1.0) : cfg.minArcMeters;
        if (rMid <= rNear) return aNear;
        if (rMid >= rFar) return cfg.minArcMeters;
        const t = (rMid - rNear) / (rFar - rNear);
        return aNear + (cfg.minArcMeters - aNear) * t;
    }

    /**
     * Dựng lưới vòng mịn ở gần xe như tập cha (superset) của edgesCoarse để giữ nguyên ranh giới gốc.
     */
    static dungRingEdgesMin(edgesCoarse, cfg) {
        const nrCoarse = edgesCoarse.length - 1;
        const drMin = cfg.drMin ?? 0.25;
        const rFineMax = cfg.rFineMax ?? 14.0;
        const out = [edgesCoarse[0]];
        const coarseToFine = new Int16Array(nrCoarse + 1);
        coarseToFine[0] = 0;

        for (let c = 0; c < nrCoarse; c++) {
            const a = edgesCoarse[c];
            const b = edgesCoarse[c + 1];
            const span = b - a;
            if (b <= rFineMax && span > 1.5 * drMin) {
                const nSub = Math.max(2, Math.ceil(span / drMin));
                const step = span / nSub;
                for (let k = 1; k < nSub; k++) {
                    out.push(a + k * step);
                }
            }
            out.push(b);
            coarseToFine[c + 1] = out.length - 1;
        }
        return { edges: new Float64Array(out), coarseToFine };
    }

    static _fitScratch = null;

    static _layFitScratch(need) {
        if (!this._fitScratch) {
            this._fitScratch = {
                cap: 0,
                zSamp: new Float32Array(256),
                gArr: new Float32Array(0),
                gZ: new Float32Array(0),
                absRes: new Float32Array(0),
                abBuf: new Float32Array(1024),
                qLo: new Int32Array(64),
                qHi: new Int32Array(64)
            };
        }
        const s = this._fitScratch;
        if (s.cap < need) {
            s.cap = Math.max(need, 2048);
            s.gArr = new Float32Array(s.cap);
            s.gZ = new Float32Array(s.cap);
            s.absRes = new Float32Array(s.cap);
        }
        return s;
    }

    /** Sắp xếp nhanh cặp (z, g) tại chỗ bằng mảng stack cố định, không cấp phát/callback comparator. */
    static _sortZPair(zArr, gArr, len, sc) {
        if (len <= 1) return;
        const loSt = sc.qLo, hiSt = sc.qHi;
        let top = 0;
        loSt[top] = 0; hiSt[top] = len - 1; top++;
        while (top > 0) {
            top--;
            const lo = loSt[top], hi = hiSt[top];
            if (hi - lo <= 16) {
                for (let i = lo + 1; i <= hi; i++) {
                    const zv = zArr[i], gv = gArr[i];
                    let j = i - 1;
                    while (j >= lo && zArr[j] > zv) {
                        zArr[j + 1] = zArr[j];
                        gArr[j + 1] = gArr[j];
                        j--;
                    }
                    zArr[j + 1] = zv;
                    gArr[j + 1] = gv;
                }
                continue;
            }
            const mid = (lo + hi) >> 1;
            const piv = zArr[mid];
            let i = lo, j = hi;
            while (i <= j) {
                while (zArr[i] < piv) i++;
                while (zArr[j] > piv) j--;
                if (i <= j) {
                    const tz = zArr[i]; zArr[i] = zArr[j]; zArr[j] = tz;
                    const tg = gArr[i]; gArr[i] = gArr[j]; gArr[j] = tg;
                    i++; j--;
                }
            }
            if (lo < j) { loSt[top] = lo; hiSt[top] = j; top++; }
            if (i < hi) { loSt[top] = i; hiSt[top] = hi; top++; }
        }
    }

    /**
     * Fit mặt phẳng lá bằng trọng số bất đối xứng (envelope dưới), hỗ trợ cổng vật cản mềm (opts.gate).
     * Trả về: { valid, z0, gu, gv, cx, cy, rms, p95, sse, nEff, nDiem, rank, fracAbove, nAbove, hAboveMed, toanVatCan }
     */
    static _fitLa(ptsX, ptsY, ptsZ, indices, parentPlane, opts, fitOpts = null) {
        const n = indices ? indices.length : 0;
        const pGu = parentPlane ? parentPlane.gu : 0.0;
        const pGv = parentPlane ? parentPlane.gv : 0.0;
        const fail = (toanVatCan = false) => ({
            valid: false, z0: NaN, gu: pGu, gv: pGv, cx: 0, cy: 0,
            rms: Infinity, p95: Infinity, sse: Infinity, nEff: 0, nDiem: n, rank: 0,
            fracAbove: 0, nAbove: 0, hAboveMed: 0, toanVatCan
        });
        if (n < opts.nEffMin1P) return fail(false);

        const gate = fitOpts && fitOpts.gate && fitOpts.gate.fade > 0 && fitOpts.gate.plane ? fitOpts.gate : null;
        const calcStripStats = Boolean(fitOpts && fitOpts.calcStripStats);

        // Nếu đang xử lý vùng gần có cổng mềm/dò vạch, không bỏ mẫu stride ở nút <= 2048 để bảo toàn bất biến hoán vị
        const stride = (gate || calcStripStats)
            ? (n > 2048 ? Math.max(1, Math.floor(n / 1024)) : 1)
            : (n > 512 ? Math.max(1, Math.floor(n / 512)) : 1);
        const fSc = this._layFitScratch(Math.ceil(n / stride) + 4);

        let sx = 0, sy = 0, usedN = 0;
        const zSamp = fSc.zSamp;
        const sampCap = Math.min(256, Math.ceil(n / stride));
        let sampCount = 0;
        const sampStep = Math.max(stride, Math.floor(n / sampCap));
        for (let i = 0; i < n; i += stride) {
            const idx = indices[i];
            sx += ptsX[idx];
            sy += ptsY[idx];
            usedN++;
        }
        if (!gate) {
            for (let i = 0; i < n && sampCount < sampCap; i += sampStep) {
                zSamp[sampCount++] = ptsZ[indices[i]];
            }
        }
        const cx = sx / usedN;
        const cy = sy / usedN;
        let z0 = NaN;

        // Cổng mềm theo parentPlane (tái dùng scratch, không cấp phát mảng)
        let gArr = null;
        if (gate) {
            const gp = gate.plane;
            const gpCx = Number.isFinite(gp.cx) ? gp.cx : cx;
            const gpCy = Number.isFinite(gp.cy) ? gp.cy : cy;
            const gHBase = opts.stripGateH ?? 0.12;
            const gSoft = Math.max(1e-4, opts.stripGateSoft ?? 0.04);
            const gSlopeK = opts.stripGateSlopeK ?? 0.03;
            const gSlopeCap = opts.stripGateSlopeCap ?? 0.10;
            const fade = gate.fade;

            gArr = fSc.gArr;
            const gZ = fSc.gZ;
            const gWCopy = fSc.absRes; // tạm mượn để sort cặp (gZ, gWCopy)
            let sumG = 0;
            let k = 0;
            for (let i = 0; i < n; i += stride) {
                const idx = indices[i];
                const dxP = ptsX[idx] - gpCx;
                const dyP = ptsY[idx] - gpCy;
                const dPar = ptsZ[idx] - (gp.z0 + gp.gu * dxP + gp.gv * dyP);
                const h = gHBase + Math.min(gSlopeK * Math.hypot(dxP, dyP), gSlopeCap);
                let t = (dPar - h) / gSoft;
                if (t < 0) t = 0;
                else if (t > 1) t = 1;
                const gi = 1.0 - fade * (t * t * (3.0 - 2.0 * t));
                gArr[k] = gi;
                gWCopy[k] = gi;
                gZ[k] = ptsZ[idx];
                sumG += gi;
                k++;
            }
            if (sumG * stride < Math.min(3.0, opts.nEffMin1P * 0.3)) return fail(true);
            this._sortZPair(gZ, gWCopy, k, fSc);
            const targetG = 0.15 * sumG;
            let accG = 0;
            z0 = gZ[0];
            for (let m = 0; m < k; m++) {
                accG += gWCopy[m];
                if (accG >= targetG) { z0 = gZ[m]; break; }
            }
        } else {
            const zView = zSamp.subarray(0, sampCount);
            zView.sort();
            z0 = this._pQuantileSorted(zView, 0.15);
        }
        if (!Number.isFinite(z0)) return fail(false);
        let gu = pGu;
        let gv = pGv;

        // Xác định điều kiện hạng XY một lần (trọng số gArr nếu có cổng mềm, chặn fit 3D trên dải quá mảnh < 0.65m)
        let cxx = 0, cyy = 0, cxy = 0, swXY = 0;
        let gIdx = 0;
        for (let i = 0; i < n; i += stride) {
            const idx = indices[i];
            const wg = gArr ? gArr[gIdx++] : 1.0;
            if (wg <= 0.05) continue;
            const dx = ptsX[idx] - cx;
            const dy = ptsY[idx] - cy;
            cxx += wg * dx * dx;
            cyy += wg * dy * dy;
            cxy += wg * dx * dy;
            swXY += wg;
        }
        const tr = cxx + cyy;
        const disc = Math.sqrt(Math.max(0, (cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy));
        const lamMax = 0.5 * (tr + disc);
        const lamMin = 0.5 * (tr - disc);
        const varMin = swXY > 0 ? (lamMin / swXY) : 0;
        const xyWellSpread = lamMax > 1e-4 && (lamMin / lamMax) >= opts.minEigRatio && (varMin >= 0.035 || !parentPlane);

        let rank = 1;
        let lastNEff = 0;
        const scaleW = stride;

        for (let iter = 0; iter < 3; iter++) {
            let sw = 0, swDx = 0, swDy = 0, swDx2 = 0, swDy2 = 0, swDxDy = 0;
            let swZ = 0, swDxZ = 0, swDyZ = 0;
            let nEff = 0;
            let giCursor = 0;

            for (let i = 0; i < n; i += stride) {
                const idx = indices[i];
                const wg = gArr ? gArr[giCursor++] : 1.0;
                if (wg <= 1e-4) continue;
                const dx = ptsX[idx] - cx;
                const dy = ptsY[idx] - cy;
                const pz = ptsZ[idx];
                const zPred = z0 + gu * dx + gv * dy;
                const d = pz - zPred;

                let w = 0;
                if (d >= -0.08 && d <= 0.06) {
                    w = 1.0;
                } else if (d > 0.06) {
                    if (d < 0.35) {
                        const t = (d - 0.06) / 0.08;
                        w = Math.exp(-t * t);
                    }
                } else if (d > -0.35) {
                    w = 0.30;
                }
                w *= wg;
                if (w <= 1e-4) continue;
                const ws = w * scaleW;
                nEff += ws;
                sw += ws;
                swDx += ws * dx;
                swDy += ws * dy;
                swDx2 += ws * dx * dx;
                swDy2 += ws * dy * dy;
                swDxDy += ws * dx * dy;
                swZ += ws * pz;
                swDxZ += ws * dx * pz;
                swDyZ += ws * dy * pz;
            }

            lastNEff = nEff;
            if (sw < opts.nEffMin1P) return fail(Boolean(gate));

            if (nEff >= opts.nEffMin3P && xyWellSpread) {
                const lamR = opts.ridgeLambdaPts;
                const A = [
                    [sw, swDx, swDy],
                    [swDx, swDx2 + lamR, swDxDy],
                    [swDy, swDxDy, swDy2 + lamR]
                ];
                const B = [
                    swZ,
                    swDxZ + lamR * pGu,
                    swDyZ + lamR * pGv
                ];
                const sol = this._solve3x3(A, B);
                if (sol) {
                    z0 = sol[0];
                    const rawGu = Math.max(pGu - opts.maxSlopeDevParent, Math.min(pGu + opts.maxSlopeDevParent, sol[1]));
                    const rawGv = Math.max(pGv - opts.maxSlopeDevParent, Math.min(pGv + opts.maxSlopeDevParent, sol[2]));
                    gu = Math.max(-opts.maxSlopeAbs, Math.min(opts.maxSlopeAbs, rawGu));
                    gv = Math.max(-opts.maxSlopeAbs, Math.min(opts.maxSlopeAbs, rawGv));
                    rank = 3;
                } else {
                    z0 = (swZ - gu * swDx - gv * swDy) / sw;
                    rank = 1;
                }
            } else {
                z0 = (swZ - pGu * swDx - pGv * swDy) / sw;
                gu = pGu;
                gv = pGv;
                rank = 1;
            }
        }

        // Chống fit bám nhầm lên đỉnh vật cản dù đã có cổng mềm
        if (gate && gate.plane) {
            const gp = gate.plane;
            const gpCx = Number.isFinite(gp.cx) ? gp.cx : cx;
            const gpCy = Number.isFinite(gp.cy) ? gp.cy : cy;
            const zParAtC = gp.z0 + gp.gu * (cx - gpCx) + gp.gv * (cy - gpCy);
            if (z0 - zParAtC > (opts.stripGateH ?? 0.12) + 0.06) {
                return fail(true);
            }
        }

        // Tính RMS & p95|resid| trên inliers cuối (dùng scratch fSc.absRes)
        let sse = 0, swFin = 0, nEffFin = 0;
        const absResBuf = fSc.absRes;
        let absResLen = 0;
        let giFin = 0;
        for (let i = 0; i < n; i += stride) {
            const idx = indices[i];
            const wg = gArr ? gArr[giFin++] : 1.0;
            if (wg <= 1e-4) continue;
            const dx = ptsX[idx] - cx;
            const dy = ptsY[idx] - cy;
            const d = ptsZ[idx] - (z0 + gu * dx + gv * dy);
            let w = 0;
            if (d >= -0.08 && d <= 0.06) w = 1.0;
            else if (d > 0.06 && d < 0.35) {
                const t = (d - 0.06) / 0.08;
                w = Math.exp(-t * t);
            } else if (d > -0.35 && d < -0.08) {
                w = 0.30;
            }
            w *= wg;
            if (w <= 1e-4) continue;
            const ws = w * scaleW;
            nEffFin += ws;
            swFin += ws;
            sse += ws * d * d;
            if (w >= 0.25) absResBuf[absResLen++] = d < 0 ? -d : d;
        }

        if (nEffFin < opts.nEffMin1P || swFin <= 1e-6) return fail(Boolean(gate));
        const absView = absResBuf.subarray(0, absResLen);
        absView.sort();
        const rms = Math.sqrt(sse / swFin);
        const p95 = absResLen > 0 ? this._pQuantileSorted(absView, 0.95) : rms;
        const sigma = Math.max(0.03, rms / Math.sqrt(Math.max(1, nEffFin)));

        let nAbove = 0, fracAbove = 0, hAboveMed = 0;
        if (calcStripStats && n > 0) {
            const hThr = opts.stripGateH ?? 0.12;
            const abBuf = fSc.abBuf;
            const stepS = n > 2048 ? Math.max(1, Math.floor(n / 1024)) : 1;
            let totS = 0, abLen = 0;
            for (let i = 0; i < n; i += stepS) {
                const idx = indices[i];
                const dOwn = ptsZ[idx] - (z0 + gu * (ptsX[idx] - cx) + gv * (ptsY[idx] - cy));
                totS++;
                if (dOwn > hThr) {
                    nAbove += stepS;
                    if (abLen < abBuf.length) abBuf[abLen++] = dOwn;
                }
            }
            fracAbove = totS > 0 ? abLen / totS : 0;
            if (abLen > 0 && fracAbove >= (opts.stripLeafFrac ?? 0.55) * 0.85) {
                const abV = abBuf.subarray(0, abLen);
                abV.sort();
                hAboveMed = this._pQuantileSorted(abV, 0.50);
            }
        }

        return {
            valid: true,
            z0, gu, gv, cx, cy,
            rms, p95, sse,
            nEff: nEffFin,
            nDiem: n,
            sigma,
            rank,
            lastNEff,
            fracAbove,
            nAbove,
            hAboveMed,
            toanVatCan: false
        };
    }

    static _layScratch(capPts, capCells) {
        if (!this._scratch) this._scratch = { ptsCap: 0, cellCap: 0 };
        const s = this._scratch;
        if (s.ptsCap < capPts) {
            s.ptsCap = Math.max(capPts, 310000);
            s.xs = new Float32Array(s.ptsCap);
            s.ys = new Float32Array(s.ptsCap);
            s.zs = new Float32Array(s.ptsCap);
            s.cellIds = new Int32Array(s.ptsCap);
            s.idxSorted = new Int32Array(s.ptsCap);
        }
        if (s.cellCap < capCells) {
            s.cellCap = Math.max(capCells, 4096);
            s.cellCounts = new Int32Array(s.cellCap);
            s.cellStart = new Int32Array(s.cellCap + 1);
            s.writeCursor = new Int32Array(s.cellCap);
        }
        return s;
    }

    constructor(opts = {}) {
        const baseRob = MatDuongDongTam.MAC_DINH.robustSurface;
        const userRob = (opts && opts.robustSurface) ? opts.robustSurface : null;
        this.opts = {
            ...MatDuongDongTam.MAC_DINH,
            ...opts,
            robustSurface: userRob
                ? {
                    ...baseRob,
                    ...userRob,
                    irls: { ...baseRob.irls, ...(userRob.irls || {}) },
                    ring: { ...baseRob.ring, ...(userRob.ring || {}) },
                    slopeCap: { ...baseRob.slopeCap, ...(userRob.slopeCap || {}) },
                    patch: { ...baseRob.patch, ...(userRob.patch || {}) },
                    profile: { ...baseRob.profile, ...(userRob.profile || {}) },
                    crossCar: { ...baseRob.crossCar, ...(userRob.crossCar || {}) }
                }
                : { ...baseRob }
        };
        this._ringCache = new Map();
        this.phienBan = 1;
        this.nr = 0;
        this.ns = this.opts.NS;
        this.ringEdges = new Float64Array(0);
        this.ringDens = new Float32Array(0);
        this.ringMedZ = new Float32Array(0);
        this.leafOf = new Int16Array(0);
        this.leaves = [];
        this.sanSang = false;
        this.diag = {
            buildMs: 0, gridMs: 0, treeMs: 0,
            totalRawPts: 0, keptPts: 0, nLa: 0, nLeafValid: 0, nUnknown: 0, rMax: 0
        };
    }

    static xayDung(rawPts, frameBoxes = [], opts = {}) {
        const tStart = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const model = new MatDuongDongTam(opts);
        const cfg = model.opts;

        let isFlat = false;
        let flatArr = null;
        let arrPts = null;
        let totalRaw = 0;
        if (Array.isArray(rawPts)) {
            arrPts = rawPts;
            totalRaw = rawPts.length;
        } else if (rawPts && rawPts.isFlat && rawPts.flatArray) {
            isFlat = true;
            flatArr = rawPts.flatArray;
            totalRaw = rawPts.count ?? Math.floor(flatArr.length / 3);
        } else if (rawPts && Array.isArray(rawPts.ptsArray)) {
            arrPts = rawPts.ptsArray;
            totalRaw = rawPts.count ?? arrPts.length;
        }
        model.diag.totalRawPts = totalRaw;

        if (totalRaw < 100) {
            model.diag.buildMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStart;
            return model;
        }

        const rMin = cfg.rMin;
        const rMin2 = rMin * rMin;
        const mask = this.buildFootprintMask(frameBoxes, cfg.otherPad);

        const stepCoarse = Math.max(1, Math.floor(totalRaw / 24000));
        const maxSamp = Math.ceil(totalRaw / stepCoarse) + 2;
        const rSampBuf = new Float32Array(maxSamp);
        const rTmpBuf = new Float32Array(maxSamp);
        const zTmpBuf = new Float32Array(maxSamp);
        let rSampN = 0, tmpN = 0;

        for (let i = 0; i < totalRaw; i += stepCoarse) {
            let px, py, pz;
            if (isFlat) {
                const b = i * 3;
                px = flatArr[b]; py = flatArr[b + 1]; pz = flatArr[b + 2];
            } else {
                const p = arrPts[i];
                if (!p || p.length < 3) continue;
                px = p[0]; py = p[1]; pz = p[2];
            }
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            const r2 = px * px + py * py;
            if (r2 < rMin2) continue;
            const r = Math.sqrt(r2);
            rSampBuf[rSampN++] = r;
            if (r <= cfg.rMaxCap) {
                rTmpBuf[tmpN] = r2;
                zTmpBuf[tmpN] = pz;
                tmpN++;
            }
        }
        if (rSampN < 20) {
            model.diag.buildMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStart;
            return model;
        }
        const rView = rSampBuf.subarray(0, rSampN);
        rView.sort();
        const rP995 = this._pQuantileSorted(rView, 0.995);
        const rMax = Math.max(20.0, Math.min(cfg.rMaxCap, rP995));
        model.diag.rMax = rMax;

        // Dựng biên các vòng tròn đồng tâm theo cấp số nhân rho (tập cha mịn ở gần nếu luoiMin bật)
        const edgesList = [rMin];
        let curR = rMin;
        while (curR < rMax) {
            curR = curR * cfg.rho;
            edgesList.push(curR);
        }
        const edgesCoarse = new Float64Array(edgesList);
        const nrCoarse = edgesCoarse.length - 1;
        let ringEdges = edgesCoarse;
        let coarseToFine = null;
        if (cfg.luoiMin) {
            const minRes = this.dungRingEdgesMin(edgesCoarse, cfg);
            ringEdges = minRes.edges;
            coarseToFine = minRes.coarseToFine;
        }
        const nr = ringEdges.length - 1;
        const ns = cfg.NS;
        const ringEdges2 = new Float64Array(nr + 1);
        for (let i = 0; i <= nr; i++) ringEdges2[i] = ringEdges[i] * ringEdges[i];
        const r2Min = ringEdges2[0];
        const r2Max = ringEdges2[nr];

        // Tìm nhanh chỉ số vòng bằng phân nhánh theo rFineMax + tìm kiếm nhị phân trên r^2
        let fineSplitIdx = nr >> 1;
        while (fineSplitIdx < nr && ringEdges[fineSplitIdx] < (cfg.rFineMax ?? 14.0)) fineSplitIdx++;
        const r2Split = ringEdges2[fineSplitIdx];
        const findRing = (r2) => {
            if (r2 < r2Min || r2 >= r2Max) return -1;
            let lo, hi;
            if (r2 < r2Split) { lo = 0; hi = fineSplitIdx - 1; }
            else { lo = fineSplitIdx; hi = nr - 1; }
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (r2 < ringEdges2[mid]) hi = mid - 1;
                else if (r2 >= ringEdges2[mid + 1]) lo = mid + 1;
                else return mid;
            }
            return -1;
        };

        // Pass thô: p10(r) lọc trần điểm cao theo edgesCoarse (bền với xáo trộn điểm trên lưới mịn)
        const nrFilter = coarseToFine ? nrCoarse : nr;
        const filterEdges2 = new Float64Array(nrFilter + 1);
        for (let i = 0; i <= nrFilter; i++) {
            const rv = coarseToFine ? edgesCoarse[i] : ringEdges[i];
            filterEdges2[i] = rv * rv;
        }
        const fR2Min = filterEdges2[0];
        const fR2Max = filterEdges2[nrFilter];
        const findCoarseRing = (r2) => {
            if (r2 < fR2Min || r2 >= fR2Max) return -1;
            let lo = 0, hi = nrFilter - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (r2 < filterEdges2[mid]) hi = mid - 1;
                else if (r2 >= filterEdges2[mid + 1]) lo = mid + 1;
                else return mid;
            }
            return -1;
        };

        const coarseCounts = new Int32Array(nrFilter);
        const tmpRi = new Int16Array(tmpN);
        for (let i = 0; i < tmpN; i++) {
            const ri = findCoarseRing(rTmpBuf[i]);
            tmpRi[i] = ri;
            if (ri >= 0) coarseCounts[ri]++;
        }
        const coarseByRing = new Array(nrFilter);
        for (let r = 0; r < nrFilter; r++) coarseByRing[r] = new Float32Array(coarseCounts[r]);
        const coarseCur = new Int32Array(nrFilter);
        for (let i = 0; i < tmpN; i++) {
            const ri = tmpRi[i];
            if (ri >= 0) coarseByRing[ri][coarseCur[ri]++] = zTmpBuf[i];
        }

        const zCut = new Float64Array(nr);
        const ringMedZ = new Float32Array(nr);
        const rawCoarseMed = new Float32Array(nrFilter);
        const cleanCoarseMed = new Float32Array(nrFilter);
        let lastValidCut = 1.5;
        let lastValidMed = 0.0;
        const zPassMarginAtR = (r) => {
            if (r <= 20.0) return cfg.zPassMargin;
            if (r >= 60.0) return cfg.zPassMarginFar;
            return cfg.zPassMargin - (cfg.zPassMargin - cfg.zPassMarginFar) * ((r - 20.0) / 40.0);
        };
        for (let r = 0; r < nrFilter; r++) {
            const arr = coarseByRing[r];
            if (arr.length >= 6) {
                arr.sort();
                rawCoarseMed[r] = this._pQuantileSorted(arr, 0.10);
            } else {
                rawCoarseMed[r] = NaN;
            }
        }
        // Làm mượt gai ghosting đơn lẻ giữa 3 vòng thô lân cận trước khi ánh xạ xuống vòng mịn
        for (let r = 0; r < nrFilter; r++) {
            const v = rawCoarseMed[r];
            if (!Number.isFinite(v)) {
                cleanCoarseMed[r] = NaN;
                continue;
            }
            const nb = [];
            if (r > 0 && Number.isFinite(rawCoarseMed[r - 1])) nb.push(rawCoarseMed[r - 1]);
            nb.push(v);
            if (r + 1 < nrFilter && Number.isFinite(rawCoarseMed[r + 1])) nb.push(rawCoarseMed[r + 1]);
            nb.sort((a, b) => a - b);
            const med3 = nb[nb.length >> 1];
            const rA_c = coarseToFine ? edgesCoarse[r] : ringEdges[r];
            const rB_c = coarseToFine ? edgesCoarse[r + 1] : ringEdges[r + 1];
            const ringW = rB_c - rA_c;
            const maxJump = Math.max(0.18, cfg.maxSlopeAbs * ringW * 2.0);
            cleanCoarseMed[r] = Math.abs(v - med3) > maxJump ? med3 : v;
        }
        if (coarseToFine) {
            for (let c = 0; c < nrFilter; c++) {
                const cm = cleanCoarseMed[c];
                const fA = coarseToFine[c], fB = coarseToFine[c + 1];
                for (let rf = fA; rf < fB; rf++) {
                    if (Number.isFinite(cm)) {
                        const rMidF = 0.5 * (ringEdges[rf] + ringEdges[rf + 1]);
                        zCut[rf] = cm + zPassMarginAtR(rMidF);
                        ringMedZ[rf] = cm;
                    } else {
                        zCut[rf] = NaN;
                        ringMedZ[rf] = NaN;
                    }
                }
            }
        } else {
            for (let r = 0; r < nr; r++) {
                const cm = cleanCoarseMed[r];
                if (Number.isFinite(cm)) {
                    const rMidCoarse = 0.5 * (ringEdges[r] + ringEdges[r + 1]);
                    zCut[r] = cm + zPassMarginAtR(rMidCoarse);
                    ringMedZ[r] = cm;
                } else {
                    zCut[r] = NaN;
                    ringMedZ[r] = NaN;
                }
            }
        }
        const ringRefZ = _backfillRingRef(ringMedZ, nr);
        for (let r = 0; r < nr; r++) {
            if (Number.isFinite(zCut[r])) {
                lastValidCut = zCut[r];
                lastValidMed = ringMedZ[r];
            } else {
                zCut[r] = lastValidCut;
                ringMedZ[r] = lastValidMed;
            }
        }

        // Pass chính: lọc điểm thuộc dải đường, trừ footprint mọi box (zero cz!), băm cellId
        const nCells = nr * ns;
        const sc = MatDuongDongTam._layScratch(totalRaw, nCells);
        const xs = sc.xs, ys = sc.ys, zs = sc.zs, cellIds = sc.cellIds;
        const cellCounts = sc.cellCounts;
        const ringKeepCounts = new Int32Array(nr);
        cellCounts.fill(0, 0, nCells);

        const invTwoPiNS = ns / (2.0 * Math.PI);
        const hasMask = mask.obbs.length > 0;
        let kept = 0;

        for (let i = 0; i < totalRaw; i++) {
            let px, py, pz;
            if (isFlat) {
                const b = i * 3;
                px = flatArr[b]; py = flatArr[b + 1]; pz = flatArr[b + 2];
            } else {
                const p = arrPts[i];
                if (!p || p.length < 3) continue;
                px = p[0]; py = p[1]; pz = p[2];
            }
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            const r2 = px * px + py * py;
            const ri = findRing(r2);
            if (ri < 0) continue;
            if (pz > zCut[ri]) continue;
            if (hasMask && mask.testXY(px, py)) continue;

            let sec = Math.floor((Math.atan2(py, px) + Math.PI) * invTwoPiNS);
            if (sec < 0) sec = 0;
            else if (sec >= ns) sec = ns - 1;

            const cid = ri * ns + sec;
            xs[kept] = px;
            ys[kept] = py;
            zs[kept] = pz;
            cellIds[kept] = cid;
            cellCounts[cid]++;
            ringKeepCounts[ri]++;
            kept++;
        }

        if (kept < 100) {
            model.nr = nr;
            model.ringEdges = ringEdges;
            model.ringMedZ = ringMedZ;
            model.ringRefZ = ringRefZ;
            model.diag.keptPts = kept;
            model.diag.buildMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - tStart;
            return model;
        }

        // Pass chính: Counting sort tạo CSR cellStart / idxSorted
        const cellStart = sc.cellStart;
        cellStart[0] = 0;
        for (let c = 0; c < nCells; c++) {
            cellStart[c + 1] = cellStart[c] + cellCounts[c];
        }
        const writeCursor = sc.writeCursor;
        writeCursor.set(cellStart.subarray(0, nCells));
        const idxSorted = sc.idxSorted;
        for (let i = 0; i < kept; i++) {
            const cid = cellIds[i];
            idxSorted[writeCursor[cid]++] = i;
        }

        const tGrid = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        model.diag.gridMs = tGrid - tStart;
        model.diag.keptPts = kept;

        // Mật độ kỳ vọng điểm/m^2 theo từng ring (cho Step 11 & chuẩn hóa sau này)
        const ringDens = new Float32Array(nr);
        for (let r = 0; r < nr; r++) {
            const area = Math.PI * (ringEdges[r + 1] * ringEdges[r + 1] - ringEdges[r] * ringEdges[r]);
            ringDens[r] = area > 0 ? ringKeepCounts[r] / area : 0;
        }

        // Helper gom mảng index thuộc hình chữ nhật (rA..rB-1, sA..sB-1)
        const collectIndices = (rA, rB, sA, sB) => {
            let tot = 0;
            for (let r = rA; r < rB; r++) {
                const row = r * ns;
                for (let s = sA; s < sB; s++) {
                    const c = row + (s % ns);
                    tot += cellCounts[c];
                }
            }
            const out = new Int32Array(tot);
            let k = 0;
            for (let r = rA; r < rB; r++) {
                const row = r * ns;
                for (let s = sA; s < sB; s++) {
                    const c = row + (s % ns);
                    const a = cellStart[c], b = cellStart[c + 1];
                    for (let p = a; p < b; p++) out[k++] = idxSorted[p];
                }
            }
            return out;
        };

        const dThetaUnit = (2.0 * Math.PI) / ns;
        const minSecSpanAtR = (rMid) => {
            const arcM = this._minArcTaiR(rMid, cfg);
            const rawSpan = arcM / (Math.max(1.0, rMid) * dThetaUnit);
            let pow2 = 1;
            while (pow2 < rawSpan && pow2 < ns) pow2 <<= 1;
            return pow2;
        };

        const dgCtx = (cfg.diemGay && typeof DoDiemGayBanKinh !== 'undefined')
            ? DoDiemGayBanKinh.taoNguCanh(zs, cellStart, cellCounts, idxSorted, ringEdges, nr, ns, cfg)
            : null;
        let stripBudget = cfg.stripLeafBudget ?? 120;
        let estLeaves = Math.ceil(nrCoarse / Math.max(1, cfg.rootRingSpan)) * Math.ceil(ns / Math.max(1, cfg.rootSecSpan));
        const maxLeavesCap = cfg.maxLeaves ?? 900;
        const rFineMax = cfg.rFineMax ?? 14.0;
        const stripMaxDepth = cfg.stripMaxDepth ?? 4;

        // Đệ quy CART trên (r, theta) tái sử dụng preIndices/preFit của nút con thắng (splitMinNEff co giãn khi mây thưa)
        const effSplitMin = kept < 60000
            ? Math.max(24, Math.min(cfg.splitMinNEff, Math.round(kept / 1200)))
            : cfg.splitMinNEff;
        let nStuckRoots = 0;
        const spanCapAtR = (rMid) => Math.max(cfg.spanCapMinM, Math.min(cfg.spanCapMaxM, cfg.spanCapRatio * rMid));
        const makeFitOpts = (rMidVal, r0Val, pPlane, needStats = false, useGate = false) => {
            if (!dgCtx) return null;
            const fade = (useGate && pPlane) ? this._fadeVatCan(rMidVal, cfg) : 0;
            const calcStrip = Boolean(needStats && r0Val < rFineMax);
            if (!calcStrip && fade <= 0) return null;
            return {
                gate: (pPlane && fade > 0) ? { plane: pPlane, fade } : null,
                calcStripStats: calcStrip
            };
        };

        const buildNode = (rA, rB, sA, sB, parentPlane, preIndices = null, preFit = null, depth = 0, stripDepth = 0, detectDone = false, allowStrip = true) => {
            const indices = preIndices || collectIndices(rA, rB, sA, sB);
            const rMid = 0.5 * (ringEdges[rA] + ringEdges[rB]);
            const fit = preFit || this._fitLa(xs, ys, zs, indices, parentPlane, cfg, makeFitOpts(rMid, ringEdges[rA], parentPlane, stripDepth > 0, stripDepth > 0));
            const rawSlope = fit.valid ? Math.hypot(fit.gu, fit.gv) : 0;
            const rMidIdxNode = Math.min(nr - 1, Math.floor(0.5 * (rA + rB)));
            const ringZSafe = Number.isFinite(ringMedZ[rMidIdxNode]) ? ringMedZ[rMidIdxNode] : 0;
            let nodePlane;
            if (fit.valid && rawSlope <= 0.085) {
                nodePlane = { cx: fit.cx, cy: fit.cy, gu: fit.gu, gv: fit.gv, z0: fit.z0 };
            } else if (parentPlane && Math.hypot(parentPlane.gu, parentPlane.gv) <= 0.085) {
                nodePlane = parentPlane;
            } else {
                const cAng = -Math.PI + 0.5 * (sA + sB) * dThetaUnit;
                nodePlane = { cx: rMid * Math.cos(cAng), cy: rMid * Math.sin(cAng), gu: 0, gv: 0, z0: ringZSafe };
            }
            const rSpan = rB - rA;
            const sSpan = sB - sA;
            const minSec = minSecSpanAtR(rMid);
            const radSpanM = ringEdges[rB] - ringEdges[rA];
            const arcSpanM = rMid * sSpan * dThetaUnit;
            const spanM = Math.max(radSpanM, arcSpanM);
            const spanCap = spanCapAtR(rMid);
            const forceCapSplit = (rMid >= cfg.rFarCap) && (spanM > spanCap);

            const canSplitR = rSpan >= 2;
            const canSplitS = sSpan >= 2 * minSec;
            const rmsOrP95Want = (fit.rms > cfg.splitRmsThr || fit.p95 > cfg.splitP95Thr);
            const canStripHere = Boolean(
                allowStrip
                && dgCtx
                && ringEdges[rA] < rFineMax
                && stripDepth < stripMaxDepth
                && stripBudget > 0
                && estLeaves < maxLeavesCap
                && (canSplitR || canSplitS)
                && (rmsOrP95Want || !fit.valid)
            );
            const wantSplit = (fit.valid && fit.nEff >= effSplitMin && (rmsOrP95Want || forceCapSplit) && (canSplitR || canSplitS))
                || canStripHere;
            if (depth === 0 && fit.valid && rmsOrP95Want && !wantSplit && (canSplitR || canSplitS)) {
                nStuckRoots++;
            }

            let childSplitFailed = false;
            if (wantSplit) {
                let bestAxis = null;
                let bestGain = -Infinity;
                let bestChildren = null;
                let bestIdx0 = null, bestIdx1 = null, bestF0 = null, bestF1 = null;
                let usedStripSplit = false;
                let nextDetectDone = detectDone;
                let childAllowStrip = allowStrip;

                if (canStripHere) {
                    const cand = DoDiemGayBanKinh.deXuatCat(dgCtx, rA, rB, sA, sB, canSplitR, canSplitS, detectDone);
                    nextDetectDone = true;
                    if (cand) {
                        stripBudget--;
                        estLeaves++;
                        usedStripSplit = true;
                        bestAxis = cand.truc;
                        if (cand.truc === 'r') {
                            bestChildren = [[rA, cand.idx, sA, sB], [cand.idx, rB, sA, sB]];
                        } else {
                            bestChildren = [[rA, rB, sA, cand.idx], [rA, rB, cand.idx, sB]];
                        }
                    } else {
                        // Đã dò toàn vùng này mà không có nhát cắt Gini hợp lệ -> không dò lại ở con SSE
                        childAllowStrip = false;
                    }
                }

                if (!usedStripSplit && fit.valid && fit.nEff >= effSplitMin && (rmsOrP95Want || forceCapSplit)) {
                    if (canSplitS) {
                        const sMid = sA + (sSpan >> 1);
                        const idxL = collectIndices(rA, rB, sA, sMid);
                        const idxR = collectIndices(rA, rB, sMid, sB);
                        const fL = this._fitLa(xs, ys, zs, idxL, nodePlane, cfg, makeFitOpts(rMid, ringEdges[rA], nodePlane));
                        const fR = this._fitLa(xs, ys, zs, idxR, nodePlane, cfg, makeFitOpts(rMid, ringEdges[rA], nodePlane));
                        if (fL.valid && fR.valid) {
                            const gain = fit.sse - (fL.sse + fR.sse);
                            const allowS = (forceCapSplit && arcSpanM >= radSpanM)
                                || (gain > 0 && gain >= cfg.splitMinSseGainRatio * fit.sse);
                            if (allowS && gain > bestGain) {
                                bestGain = gain;
                                bestAxis = 's';
                                bestChildren = [[rA, rB, sA, sMid], [rA, rB, sMid, sB]];
                                bestIdx0 = idxL; bestIdx1 = idxR; bestF0 = fL; bestF1 = fR;
                            }
                        }
                    }

                    if (canSplitR) {
                        const rMidIdx = rA + (rSpan >> 1);
                        const idxIn = collectIndices(rA, rMidIdx, sA, sB);
                        const idxOut = collectIndices(rMidIdx, rB, sA, sB);
                        const rMidIn = 0.5 * (ringEdges[rA] + ringEdges[rMidIdx]);
                        const rMidOut = 0.5 * (ringEdges[rMidIdx] + ringEdges[rB]);
                        const fIn = this._fitLa(xs, ys, zs, idxIn, nodePlane, cfg, makeFitOpts(rMidIn, ringEdges[rA], nodePlane));
                        const fOut = this._fitLa(xs, ys, zs, idxOut, nodePlane, cfg, makeFitOpts(rMidOut, ringEdges[rMidIdx], nodePlane));
                        if (fIn.valid && fOut.valid) {
                            const gain = fit.sse - (fIn.sse + fOut.sse);
                            const allowR = (forceCapSplit && (radSpanM > arcSpanM || !canSplitS || !bestAxis))
                                || (gain > 0 && gain >= cfg.splitMinSseGainRatio * fit.sse);
                            if (allowR && gain > bestGain) {
                                bestGain = gain;
                                bestAxis = 'r';
                                bestChildren = [[rA, rMidIdx, sA, sB], [rMidIdx, rB, sA, sB]];
                                bestIdx0 = idxIn; bestIdx1 = idxOut; bestF0 = fIn; bestF1 = fOut;
                            }
                        }
                    }
                }

                if (bestAxis && bestChildren) {
                    const nextStripDepth = usedStripSplit ? (stripDepth + 1) : stripDepth;
                    const c0 = buildNode(bestChildren[0][0], bestChildren[0][1], bestChildren[0][2], bestChildren[0][3], nodePlane, bestIdx0, bestF0, depth + 1, nextStripDepth, nextDetectDone, childAllowStrip);
                    const c1 = buildNode(bestChildren[1][0], bestChildren[1][1], bestChildren[1][2], bestChildren[1][3], nodePlane, bestIdx1, bestF1, depth + 1, nextStripDepth, nextDetectDone, childAllowStrip);
                    if (!forceCapSplit && !usedStripSplit && c0.isLeaf && c1.isLeaf && c0.fit.valid && c1.fit.valid && fit.valid && !c0.vatCan && !c1.vatCan) {
                        const maxChildRms = Math.max(c0.fit.rms, c1.fit.rms);
                        if (fit.rms <= cfg.pruneRmsMul * maxChildRms && fit.rms <= cfg.pruneRmsMax) {
                            return { isLeaf: true, rA, rB, sA, sB, fit, parentPlane, coarse: false, vatCan: false };
                        }
                    }
                    return { isLeaf: false, c0, c1, rA, rB, sA, sB, fit };
                }
                if (forceCapSplit) childSplitFailed = true;
            }

            let isVatCan = Boolean(fit && (fit.toanVatCan || (fit.valid && fit.fracAbove >= (cfg.stripLeafFrac ?? 0.55) && fit.hAboveMed >= (cfg.stripMinH ?? 0.18))));
            if (!isVatCan && dgCtx && detectDone && stripDepth > 0) {
                let wPts = 0, totLabelPts = 0;
                const scLbl = dgCtx.sc.cellLabel;
                for (let rr = rA; rr < rB; rr++) {
                    const row = rr * ns;
                    for (let ss = sA; ss < sB; ss++) {
                        const cid = row + (((ss % ns) + ns) % ns);
                        const cN = cellCounts[cid];
                        if (cN <= 0) continue;
                        totLabelPts += cN;
                        if (scLbl[cid] === 1) wPts += cN;
                    }
                }
                if (totLabelPts > 0 && (wPts / totLabelPts) >= (cfg.stripLeafFrac ?? 0.55)) {
                    isVatCan = true;
                }
            }
            return { isLeaf: true, rA, rB, sA, sB, fit, parentPlane, coarse: forceCapSplit || childSplitFailed, vatCan: isVatCan };
        };

        // Gốc: nhóm gần dùng rootRingSpan x rootSecSpan trên lưới thô (ánh xạ coarseToFine khi luoiMin bật)
        const leavesRaw = [];
        const collectLeaves = (node) => {
            if (!node) return;
            if (node.isLeaf) {
                leavesRaw.push(node);
            } else {
                collectLeaves(node.c0);
                collectLeaves(node.c1);
            }
        };

        let cA = 0;
        while (cA < nrCoarse) {
            const rStart = edgesCoarse[cA];
            let cStep = cfg.rootRingSpan;
            let sStep = cfg.rootSecSpan;
            if (rStart >= cfg.rFarCap) {
                const cap = spanCapAtR(rStart);
                cStep = Math.max(1, Math.min(cfg.rootRingSpan, Math.floor(Math.log(1.0 + cap / Math.max(1.0, rStart)) / Math.log(cfg.rho)) || 1));
                const rawS = Math.max(1, Math.floor(cap / (Math.max(1.0, rStart) * dThetaUnit)));
                let p2 = 1;
                while ((p2 << 1) <= rawS && (p2 << 1) <= cfg.rootSecSpan) p2 <<= 1;
                sStep = Math.max(2, p2);
            }
            const cB = Math.min(nrCoarse, cA + cStep);
            const rA = coarseToFine ? coarseToFine[cA] : cA;
            const rB = coarseToFine ? coarseToFine[cB] : cB;
            for (let sA = 0; sA < ns; sA += sStep) {
                const sB = Math.min(ns, sA + sStep);
                const root = buildNode(rA, rB, sA, sB, null);
                collectLeaves(root);
            }
            cA = cB;
        }

        // Chuyển thành mảng lá theo đúng hợp đồng 4.1 + bảng tra leafOf[r*NS+s]
        const leafOf = new Int16Array(nCells);
        leafOf.fill(-1);
        const leaves = [];
        let nLeafValid = 0;
        let nUnknown = 0;

        for (let id = 0; id < leavesRaw.length; id++) {
            const nd = leavesRaw[id];
            const fit = nd.fit;
            const r0 = ringEdges[nd.rA];
            const r1 = ringEdges[nd.rB];
            const t0 = -Math.PI + nd.sA * dThetaUnit;
            const t1 = -Math.PI + nd.sB * dThetaUnit;
            const isValid = Boolean(fit && fit.valid);
            const loai = isValid ? 'LEAF' : 'UNKNOWN';
            if (isValid) nLeafValid++;
            else nUnknown++;

            const slopeMag = isValid ? Math.hypot(fit.gu, fit.gv) : 0;
            const isVatCan = Boolean(nd.vatCan);
            const ngoaiDuong = (isValid && slopeMag > cfg.ngoaiDuongSlopeThr) || Boolean(cfg.vatCanTinhNgoaiDuong && isVatCan);

            // Gợi ý cao độ cho lá UNKNOWN từ ringRefZ (không lấy 0.0) và post-pass láng giềng bên dưới
            const rMidIdx = Math.min(nr - 1, Math.floor(0.5 * (nd.rA + nd.rB)));
            const zRing = Number.isFinite(ringRefZ[rMidIdx]) ? ringRefZ[rMidIdx] : NaN;
            const zGoiY = isValid ? fit.z0 : zRing;

            const rMidLeaf = 0.5 * (r0 + r1);
            const radSpanM = r1 - r0;
            const arcSpanM = rMidLeaf * (t1 - t0);
            const spanM = Math.max(radSpanM, arcSpanM);
            const area = 0.5 * (r1 * r1 - r0 * r0) * (t1 - t0);

            const leaf = {
                id,
                r0, r1, t0, t1,
                rA: nd.rA, rB: nd.rB, sA: nd.sA, sB: nd.sB,
                spanM,
                area,
                coarse: Boolean(nd.coarse || (rMidLeaf >= cfg.rFarCap && spanM > spanCapAtR(rMidLeaf) * 1.15)),
                outlier: false,
                loai,
                z0: isValid ? fit.z0 : NaN,
                gu: isValid ? fit.gu : 0,
                gv: isValid ? fit.gv : 0,
                cx: isValid ? fit.cx : (rMidLeaf * Math.cos(0.5 * (t0 + t1))),
                cy: isValid ? fit.cy : (rMidLeaf * Math.sin(0.5 * (t0 + t1))),
                nDiem: fit ? fit.nDiem : 0,
                nEff: fit ? fit.nEff : 0,
                rmse: isValid ? fit.rms : Infinity,
                sigma: isValid ? fit.sigma : 0.35,
                thuCong: false,
                ngoaiDuong,
                vatCan: isVatCan,
                lyDo: (!isValid && isVatCan) ? 'VAT_CAN' : undefined,
                zRing,
                goiYIds: null,
                zGoiY
            };
            leaves.push(leaf);

            for (let r = nd.rA; r < nd.rB; r++) {
                const row = r * ns;
                for (let s = nd.sA; s < nd.sB; s++) {
                    leafOf[row + (s % ns)] = id;
                }
            }
        }

        // Lọc đảo lá nổi cô lập trên toàn dải bán kính (trước khi kiểm tra vòng ngoài rFarCap)
        const robBuildCfg = cfg.robustSurface;
        let daoDowngraded = 0;
        if (robBuildCfg && robBuildCfg.enabled) {
            daoDowngraded = MatDuongDongTam._locDaoLaNoi(leaves, leafOf, nr, ns, opts?.neoList, robBuildCfg);
            if (daoDowngraded > 0) {
                nLeafValid = Math.max(0, nLeafValid - daoDowngraded);
                nUnknown += daoDowngraded;
            }
        }

        // Kiểm tra ngoại lai vòng ngoài (r >= rFarCap) so với median LEAF các vòng trong kề
        for (let i = 0; i < leaves.length; i++) {
            const lf = leaves[i];
            if (lf.loai !== 'LEAF') continue;
            const rMid = 0.5 * (lf.r0 + lf.r1);
            if (rMid < cfg.rFarCap) continue;
            const nbZs = [];
            for (let j = 0; j < leaves.length; j++) {
                if (i === j) continue;
                const o = leaves[j];
                if (o.loai !== 'LEAF') continue;
                const rO = 0.5 * (o.r0 + o.r1);
                if (rO > rMid + 2.0 || rO < rMid * 0.55) continue;
                const dth = Math.atan2(Math.sin(0.5 * (lf.t0 + lf.t1) - 0.5 * (o.t0 + o.t1)), Math.cos(0.5 * (lf.t0 + lf.t1) - 0.5 * (o.t0 + o.t1)));
                if (Math.abs(dth) <= 0.45) nbZs.push(o.z0);
            }
            if (nbZs.length >= 2) {
                nbZs.sort((a, b) => a - b);
                const medNb = this._pQuantileSorted(nbZs, 0.50);
                if (Math.abs(lf.z0 - medNb) > 0.20) {
                    lf.outlier = true;
                    lf.sigma = Math.max(0.14, lf.sigma * 2.5);
                }
            }
        }

        const tEnd = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        model.nr = nr;
        model.ringEdges = ringEdges;
        model.ringDens = ringDens;
        model.ringMedZ = ringMedZ;
        model.ringRefZ = ringRefZ;
        model.leafOf = leafOf;
        model.leaves = leaves;
        const tGoiY0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        model._tinhGoiYUnknown(leaves, leafOf, nr, ns, ringRefZ);
        const tGoiY1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        model.sanSang = nLeafValid > 0;
        model.diag.treeMs = tEnd - tGrid;
        model.diag.goiYMs = tGoiY1 - tGoiY0;
        model.diag.buildMs = tGoiY1 - tStart;
        model.diag.nLa = leaves.length;
        model.diag.nLeafValid = nLeafValid;
        model.diag.nUnknown = nUnknown;
        model.diag.nStuckRoots = nStuckRoots;
        model._neoState = null;
        model._neoVer = 0;
        if (opts && Array.isArray(opts.neoList) && opts.neoList.length > 0) {
            model.datNeo(opts.neoList, opts);
        }
        return model;
    }

    _tinhGoiYUnknown(leaves, leafOf, nr, ns, ringRefZ) {
        if (!Array.isArray(leaves) || leaves.length === 0 || !leafOf) return;
        const stamp = new Int32Array(leaves.length);
        const candIds = new Int32Array(GOIY_KMAX);
        const candD2 = new Float64Array(GOIY_KMAX);

        for (let id = 0; id < leaves.length; id++) {
            const lf = leaves[id];
            if (!lf || lf.loai === 'LEAF') continue;
            const mark = id + 1;
            stamp[id] = mark;
            let nFound = 0;
            const cxU = lf.cx, cyU = lf.cy;
            const rA = lf.rA, rB = lf.rB, sA = lf.sA, sB = lf.sB;

            const tryCell = (r, sRaw) => {
                const sw = ((sRaw % ns) + ns) % ns;
                const nid = leafOf[r * ns + sw];
                if (nid < 0 || stamp[nid] === mark) return;
                stamp[nid] = mark;
                const nb = leaves[nid];
                if (!nb || nb.loai !== 'LEAF' || nb.outlier || nb.ngoaiDuong || nb.vatCan || !Number.isFinite(nb.z0)) return;
                const dx = cxU - nb.cx, dy = cyU - nb.cy;
                const d2 = dx * dx + dy * dy;
                let pos = nFound;
                if (nFound === GOIY_KMAX) {
                    const lastIdx = GOIY_KMAX - 1;
                    if (d2 > candD2[lastIdx] || (d2 === candD2[lastIdx] && nid >= candIds[lastIdx])) return;
                    pos = lastIdx;
                } else {
                    nFound++;
                }
                while (pos > 0 && (d2 < candD2[pos - 1] || (d2 === candD2[pos - 1] && nid < candIds[pos - 1]))) {
                    candD2[pos] = candD2[pos - 1];
                    candIds[pos] = candIds[pos - 1];
                    pos--;
                }
                candD2[pos] = d2;
                candIds[pos] = nid;
            };

            const dMaxLim = this.opts?.luoiMin ? Math.max(GOIY_DMAX, 12) : GOIY_DMAX;
            for (let d = 1; d <= dMaxLim; d++) {
                const rLo = rA - d;
                const rHi = rB - 1 + d;
                const sLo = sA - d;
                const rawSW = (sB - 1 + d) - sLo + 1;
                const sCount = Math.min(ns, Math.max(1, rawSW));
                const rIntStart = Math.max(0, rLo + 1);
                const rIntEnd = Math.min(nr - 1, rHi - 1);
                const intRows = rIntEnd >= rIntStart ? (rIntEnd - rIntStart + 1) : 0;
                const perim = (rLo >= 0 ? sCount : 0) + (rHi < nr ? sCount : 0) + (sCount < ns ? intRows * 2 : 0);
                if (perim <= 0) break;
                const stride = Math.max(1, Math.ceil(perim / GOIY_SAMPLES));
                let stepIdx = 0;

                if (rLo >= 0) {
                    for (let k = 0; k < sCount; k++) {
                        if (stride === 1 || (stepIdx % stride) === 0) tryCell(rLo, sLo + k);
                        stepIdx++;
                    }
                }
                if (rHi < nr) {
                    for (let k = 0; k < sCount; k++) {
                        if (stride === 1 || (stepIdx % stride) === 0) tryCell(rHi, sLo + k);
                        stepIdx++;
                    }
                }
                if (sCount < ns && intRows > 0) {
                    const sHi = sLo + sCount - 1;
                    for (let r = rIntStart; r <= rIntEnd; r++) {
                        if (stride === 1 || (stepIdx % stride) === 0) tryCell(r, sLo);
                        stepIdx++;
                        if (stride === 1 || (stepIdx % stride) === 0) tryCell(r, sHi);
                        stepIdx++;
                    }
                }
                if (nFound >= GOIY_KMAX) break;
            }

            const rMidIdx = Math.min(nr - 1, Math.floor(0.5 * (rA + rB)));
            lf.zRing = Number.isFinite(ringRefZ?.[rMidIdx]) ? ringRefZ[rMidIdx] : lf.zRing;
            lf.goiYIds = nFound > 0 ? Array.from(candIds.subarray(0, nFound)) : [];
            lf.zGoiY = this._zGoiYTai(lf, cxU, cyU);
        }
    }

    _zGoiYTai(leaf, x, y) {
        if (!leaf || !Number.isFinite(x) || !Number.isFinite(y)) return NaN;
        let sw = 0.0, sz = 0.0;
        const ids = leaf.goiYIds;
        if (Array.isArray(ids) && ids.length > 0 && Array.isArray(this.leaves)) {
            for (let i = 0; i < ids.length; i++) {
                const nb = this.leaves[ids[i]];
                if (!nb || nb.loai !== 'LEAF' || !Number.isFinite(nb.z0)) continue;
                let z = this._zNenTaiLa(nb, x, y);
                if (!Number.isFinite(z)) continue;
                const dz = z - nb.z0;
                if (dz > GOIY_CLAMP) z = nb.z0 + GOIY_CLAMP;
                else if (dz < -GOIY_CLAMP) z = nb.z0 - GOIY_CLAMP;
                const conf = Math.max(0.1, Math.min(1.0, (nb.nDiem || 0) / 30.0));
                const dx = x - nb.cx, dy = y - nb.cy;
                const d2 = dx * dx + dy * dy;
                const w = conf / (d2 + GOIY_EPS2);
                sw += w;
                sz += w * z;
            }
        }
        if (Number.isFinite(leaf.zRing)) {
            sw += GOIY_PRIOR_W;
            sz += GOIY_PRIOR_W * leaf.zRing;
        }
        return sw > 0 ? sz / sw : NaN;
    }

    static _getNeoCtor() {
        if (typeof NeoDuyet !== 'undefined') return NeoDuyet;
        if (typeof window !== 'undefined' && window.NeoDuyet) return window.NeoDuyet;
        if (typeof globalThis !== 'undefined' && globalThis.NeoDuyet) return globalThis.NeoDuyet;
        return null;
    }

    _zNenTaiLa(leaf, x, y) {
        if (!leaf || !Number.isFinite(x) || !Number.isFinite(y)) return NaN;
        if (leaf.loai === 'LEAF' && Number.isFinite(leaf.z0)) {
            return leaf.z0 + leaf.gu * (x - leaf.cx) + leaf.gv * (y - leaf.cy);
        }
        return NaN;
    }

    _zNenTai(x, y) {
        const leaf = this.timLa(x, y);
        return leaf ? this._zNenTaiLa(leaf, x, y) : NaN;
    }

    static _diemBienChung(lu, lv) {
        const TWO_PI = 2.0 * Math.PI;
        const tMid = (a0, a1, b0, b1) => {
            const ovLo = Math.max(a0, b0);
            const ovHi = Math.min(a1, b1);
            if (ovHi > ovLo) return 0.5 * (ovLo + ovHi);
            const cA = 0.5 * (a0 + a1), cB = 0.5 * (b0 + b1);
            const d = Math.atan2(Math.sin(cB - cA), Math.cos(cB - cA));
            return cA + 0.5 * d;
        };
        let rBnd, thBnd;
        if (lu.rB === lv.rA || lv.rB === lu.rA) {
            rBnd = (lu.rB === lv.rA) ? lu.r1 : lu.r0;
            thBnd = tMid(lu.t0, lu.t1, lv.t0, lv.t1);
        } else {
            const rLo = Math.max(lu.r0, lv.r0);
            const rHi = Math.min(lu.r1, lv.r1);
            rBnd = rHi > rLo ? 0.5 * (rLo + rHi) : 0.25 * (lu.r0 + lu.r1 + lv.r0 + lv.r1);
            const d01 = Math.abs(Math.atan2(Math.sin(lu.t0 - lv.t1), Math.cos(lu.t0 - lv.t1)));
            const d10 = Math.abs(Math.atan2(Math.sin(lu.t1 - lv.t0), Math.cos(lu.t1 - lv.t0)));
            const w01 = Math.abs(Math.atan2(Math.sin(lu.t0 + TWO_PI - lv.t1), Math.cos(lu.t0 + TWO_PI - lv.t1)));
            const w10 = Math.abs(Math.atan2(Math.sin(lu.t1 - TWO_PI - lv.t0), Math.cos(lu.t1 - TWO_PI - lv.t0)));
            thBnd = Math.min(d01, w01) <= Math.min(d10, w10) ? lu.t0 : lu.t1;
        }
        return [rBnd * Math.cos(thBnd), rBnd * Math.sin(thBnd)];
    }

    static _locDaoLaNoi(leaves, leafOf, nr, ns, neoList = null, robCfg = null) {
        const nL = Array.isArray(leaves) ? leaves.length : 0;
        if (nL === 0 || !leafOf || nr <= 0 || ns <= 0) return 0;

        const tolBase = robCfg?.nhayTolBase ?? 0.12;
        const tolEdgePerM = 0.015;
        const daoMax = Math.max(1, robCfg?.daoLaMax ?? 4);
        const neoTamXa = robCfg?.neoTamXa ?? 4.0;

        const origZ = new Float64Array(nL);
        const origGu = new Float64Array(nL);
        const origGv = new Float64Array(nL);
        origZ.fill(NaN);
        for (let i = 0; i < nL; i++) {
            const lf = leaves[i];
            if (lf && lf.loai === 'LEAF' && !lf.thuCong && Number.isFinite(lf.z0)) {
                origZ[i] = lf.z0;
                origGu[i] = Number.isFinite(lf.gu) ? lf.gu : 0;
                origGv[i] = Number.isFinite(lf.gv) ? lf.gv : 0;
            }
        }

        const edgeDiff = (u, v) => {
            const lu = leaves[u], lv = leaves[v];
            const [mx, my] = MatDuongDongTam._diemBienChung(lu, lv);
            const zu = origZ[u] + origGu[u] * (mx - lu.cx) + origGv[u] * (my - lu.cy);
            const zv = origZ[v] + origGu[v] * (mx - lv.cx) + origGv[v] * (my - lv.cy);
            const d = Math.hypot(lu.cx - lv.cx, lu.cy - lv.cy);
            return { dz: zu - zv, tol: tolBase + tolEdgePerM * d };
        };

        const stamp = new Int32Array(nL);
        let mark = 0;
        const visited = new Uint8Array(nL);
        const queue = new Int32Array(nL);
        const comp = new Int32Array(nL);
        const adj = new Array(nL);

        for (let i = 0; i < nL; i++) {
            if (!Number.isFinite(origZ[i])) continue;
            const lf = leaves[i];
            const rLo = Math.max(0, lf.rA - 1);
            const rHi = Math.min(nr - 1, lf.rB);
            const sLo = lf.sA - 1;
            const sHi = lf.sB;
            mark++;
            stamp[i] = mark;
            const list = [];
            for (let r = rLo; r <= rHi; r++) {
                const row = r * ns;
                for (let sRaw = sLo; sRaw <= sHi; sRaw++) {
                    const sw = ((sRaw % ns) + ns) % ns;
                    const nid = leafOf[row + sw];
                    if (nid < 0 || stamp[nid] === mark || !Number.isFinite(origZ[nid])) continue;
                    stamp[nid] = mark;
                    list.push(nid);
                }
            }
            adj[i] = list;
        }

        const appNeos = [];
        if (Array.isArray(neoList) && neoList.length > 0) {
            for (let k = 0; k < neoList.length; k++) {
                const nk = neoList[k];
                if (nk && nk.kind === 'approved' && Number.isFinite(nk.zb) && Number.isFinite(nk.cx) && Number.isFinite(nk.cy)) {
                    appNeos.push(nk);
                }
            }
        }
        const Neo = appNeos.length > 0 ? MatDuongDongTam._getNeoCtor() : null;

        let downgraded = 0;
        const toReject = [];
        for (let i = 0; i < nL; i++) {
            if (visited[i] || !Number.isFinite(origZ[i])) continue;
            visited[i] = 1;
            let qHead = 0, qTail = 0;
            queue[qTail++] = i;
            let compLen = 0;

            while (qHead < qTail) {
                const u = queue[qHead++];
                comp[compLen++] = u;
                const nbList = adj[u];
                if (!nbList) continue;
                for (let j = 0; j < nbList.length; j++) {
                    const v = nbList[j];
                    if (visited[v]) continue;
                    const ed = edgeDiff(u, v);
                    if (Math.abs(ed.dz) <= ed.tol) {
                        visited[v] = 1;
                        queue[qTail++] = v;
                    }
                }
            }

            if (compLen > daoMax) continue;

            // Thành phần nhỏ <= daoMax: kiểm tra có phải đảo nổi cao hơn MỌI biên ngoài & neo gần không
            mark++;
            for (let t = 0; t < compLen; t++) stamp[comp[t]] = mark;

            let extLowerCount = 0;
            let hasHigherOrNonLower = false;
            let hasLowerNeo = false;

            for (let t = 0; t < compLen; t++) {
                const u = comp[t];
                const lu = leaves[u];
                const zu = origZ[u];
                const nbList = adj[u];
                if (nbList) {
                    for (let j = 0; j < nbList.length; j++) {
                        const v = nbList[j];
                        if (stamp[v] === mark) continue;
                        stamp[v] = mark;
                        const ed = edgeDiff(u, v);
                        if (ed.dz > ed.tol) {
                            extLowerCount++;
                        } else {
                            hasHigherOrNonLower = true;
                            break;
                        }
                    }
                }
                if (hasHigherOrNonLower) break;

                for (let k = 0; k < appNeos.length; k++) {
                    const nk = appNeos[k];
                    const dEdge = (Neo && typeof Neo.khoangCachChan === 'function')
                        ? Math.max(0, Neo.khoangCachChan(lu.cx, lu.cy, nk))
                        : Math.hypot(lu.cx - nk.cx, lu.cy - nk.cy);
                    if (dEdge > neoTamXa) continue;
                    const zNeoU = nk.zb + (nk.a || 0) * (lu.cx - nk.cx) + (nk.b || 0) * (lu.cy - nk.cy);
                    const tolN = tolBase + 0.02 * dEdge;
                    if (zu - zNeoU > tolN) {
                        hasLowerNeo = true;
                        extLowerCount++;
                    } else if (zNeoU > zu) {
                        hasHigherOrNonLower = true;
                        break;
                    }
                }
                if (hasHigherOrNonLower) break;
            }

            if (!hasHigherOrNonLower && (extLowerCount >= 2 || hasLowerNeo)) {
                for (let t = 0; t < compLen; t++) toReject.push(comp[t]);
            }
        }

        for (let t = 0; t < toReject.length; t++) {
            const lf = leaves[toReject[t]];
            lf.z0Goc = lf.z0;
            lf.loai = 'UNKNOWN';
            lf.lyDo = 'DAO_NOI';
            lf.z0 = NaN;
            lf.gu = 0;
            lf.gv = 0;
            lf.sigma = 0.35;
            lf.zGoiY = lf.zRing;
            downgraded++;
        }
        return downgraded;
    }

    datNeo(neoList, opts = {}) {
        this._neoVer = (this._neoVer || 0) + 1;
        this._cv2d = null;
        this._canhNhay = null;
        if (this.sanSang && this.opts?.robustSurface?.enabled && Array.isArray(neoList) && neoList.length > 0) {
            const extraDown = MatDuongDongTam._locDaoLaNoi(this.leaves, this.leafOf, this.nr, this.ns, neoList, this.opts.robustSurface);
            if (extraDown > 0) {
                this.diag.nLeafValid = Math.max(0, (this.diag.nLeafValid || 0) - extraDown);
                this.diag.nUnknown = (this.diag.nUnknown || 0) + extraDown;
                this._tinhGoiYUnknown(this.leaves, this.leafOf, this.nr, this.ns, this.ringRefZ);
            }
        }
        const Neo = MatDuongDongTam._getNeoCtor();
        if (!Neo || !Array.isArray(neoList) || neoList.length === 0) {
            this._neoState = null;
            return { soNeo: 0, residuals: [] };
        }
        const st = Neo.datTrangThaiNeo(neoList, (x, y) => this._zNenTai(x, y), opts);
        this._neoState = (st && st.coNeoXe) ? st : null;
        const residuals = this._neoState
            ? this._neoState.carNeos.map(k => ({ trackId: k.trackId, r: k.r, lanTruyen: k.lanTruyen }))
            : [];
        return { soNeo: this._neoState ? this._neoState.soNeo : 0, residuals };
    }

    _zSauNeo(x, y, zNen, conf = 0.5, opts = null) {
        const st = (opts && opts.neoState) ? opts.neoState : this._neoState;
        if (!st || !st.coNeoXe) return { z: zNen, conf, nguon: 'NEN', W: 0, dMin: Infinity };
        const Neo = MatDuongDongTam._getNeoCtor();
        if (!Neo) return { z: zNen, conf, nguon: 'NEN', W: 0, dMin: Infinity };
        return Neo.zTaiDiem(x, y, zNen, conf, st);
    }

    layDanhSachLa() {
        return this.leaves;
    }

    _chiSoVong(r) {
        if (!Number.isFinite(r) || this.nr <= 0) return -1;
        const edges = this.ringEdges;
        if (r < edges[0] || r >= edges[this.nr]) return -1;
        let lo = 0, hi = this.nr - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (r < edges[mid]) hi = mid - 1;
            else if (r >= edges[mid + 1]) lo = mid + 1;
            else return mid;
        }
        return -1;
    }

    timLa(x, y) {
        if (!this.sanSang || !Number.isFinite(x) || !Number.isFinite(y)) return null;
        const r = Math.hypot(x, y);
        const ri = this._chiSoVong(r);
        if (ri < 0) return null;

        let sec = Math.floor(((Math.atan2(y, x) + Math.PI) / (2.0 * Math.PI)) * this.ns);
        if (sec < 0) sec = 0;
        else if (sec >= this.ns) sec = this.ns - 1;
        const lid = this.leafOf[ri * this.ns + sec];
        return lid >= 0 ? this.leaves[lid] : null;
    }

    zTaiLa(leaf, x, y) {
        if (!leaf || !Number.isFinite(x) || !Number.isFinite(y)) return NaN;
        if (leaf.loai === 'LEAF' && Number.isFinite(leaf.z0)) {
            const zNen = this._zNenTaiLa(leaf, x, y);
            if (!this._neoState || !this._neoState.coNeoXe) return zNen;
            const conf = Math.min(1.0, (leaf.nDiem || 0) / 30.0);
            return this._zSauNeo(x, y, zNen, conf).z;
        }
        if (this._neoState && this._neoState.coNeoXe) {
            const qNeo = this._zSauNeo(x, y, NaN, 0.0);
            if (qNeo.W > 0 && Number.isFinite(qNeo.z)) return qNeo.z;
        }
        return NaN;
    }

    zTai(x, y) {
        const leaf = this.timLa(x, y);
        if (leaf) return this.zTaiLa(leaf, x, y);
        if (this._neoState && this._neoState.coNeoXe && Number.isFinite(x) && Number.isFinite(y)) {
            const qNeo = this._zSauNeo(x, y, NaN, 0.0);
            if (qNeo.W > 0 && Number.isFinite(qNeo.z)) return qNeo.z;
        }
        return NaN;
    }

    zHienThiTaiLa(leaf, x, y) {
        if (!leaf || !Number.isFinite(x) || !Number.isFinite(y)) return NaN;
        if (leaf.loai === 'LEAF' && Number.isFinite(leaf.z0)) {
            return this.zTaiLa(leaf, x, y);
        }
        const zRefRaw = this._zGoiYTai(leaf, x, y);
        const zRef = Number.isFinite(zRefRaw) ? zRefRaw : (Number.isFinite(leaf.zGoiY) ? leaf.zGoiY : NaN);
        if (this._neoState && this._neoState.coNeoXe) {
            const Neo = MatDuongDongTam._getNeoCtor();
            const q = this._zSauNeo(x, y, NaN, 0.0);
            const WHard = Math.max(0, Math.min(1, q.W || 0));
            const m = (Neo && typeof Neo.zMem === 'function')
                ? Neo.zMem(x, y, this._neoState, { zRef, zRefTrusted: false })
                : null;
            const Wsoft = (m && m.valid) ? Math.max(WHard, m.Wsoft || 0) : WHard;
            const zSoft = (m && m.valid && Number.isFinite(m.z)) ? m.z : q.z;
            const zBase = (Wsoft > 0 && Number.isFinite(zSoft))
                ? (Number.isFinite(zRef) ? (1.0 - Wsoft) * zRef + Wsoft * zSoft : zSoft)
                : zRef;
            if (WHard > 0 && Number.isFinite(q.z)) {
                return Number.isFinite(zBase) ? (1.0 - WHard) * zBase + WHard * q.z : q.z;
            }
            return zBase;
        }
        return zRef;
    }

    sigmaTaiLa(leaf, x, y) {
        if (!leaf || leaf.loai === 'UNKNOWN') return 0.35;
        const dQ = (Number.isFinite(x) && Number.isFinite(y)) ? Math.hypot(x - leaf.cx, y - leaf.cy) : 0;
        const rQ = (Number.isFinite(x) && Number.isFinite(y)) ? Math.hypot(x, y) : 0.5 * (leaf.r0 + leaf.r1);
        const spanM = Number.isFinite(leaf.spanM)
            ? leaf.spanM
            : Math.max(leaf.r1 - leaf.r0, 0.5 * (leaf.r0 + leaf.r1) * (leaf.t1 - leaf.t0));
        const kS = this.opts.sigmaSlopeUncert ?? 0.01;
        const sFar = (this.opts.sigmaFarSlopePerM ?? 0.0007) * Math.max(0, rQ - 30.0);
        let s = Math.hypot(leaf.sigma || 0.03, kS * dQ, kS * 0.5 * spanM, sFar);
        if (leaf.coarse) s = Math.max(s, 0.11);
        if (leaf.outlier) s = Math.max(s, 0.15);
        return s;
    }

    sigmaAt(x, y) {
        const leaf = this.timLa(x, y);
        return this.sigmaTaiLa(leaf, x, y);
    }

    truyVan(x, y, skipNeo = false, opts = {}) {
        const leaf = this.timLa(x, y);
        if (!leaf || leaf.loai === 'UNKNOWN') {
            if (!skipNeo && this._neoState && this._neoState.coNeoXe && Number.isFinite(x) && Number.isFinite(y)) {
                const qNeo = this._zSauNeo(x, y, NaN, 0.0);
                if (qNeo.W > 0 && Number.isFinite(qNeo.z)) {
                    return {
                        z: qNeo.z, sigma: 0.02 + 0.08 * (1.0 - qNeo.W), sigmaFit: 0.02, spanM: 0, dQ: 0,
                        coarse: false, outlier: false, conf: Math.max(0.5, qNeo.W), nguon: 'LEAF',
                        ngoaiDuong: false, loai: leaf ? leaf.loai : 'NONE', leaf: leaf || null
                    };
                }
            }
            return {
                z: NaN, sigma: 0.35, sigmaFit: 0.35, spanM: 0, dQ: 0,
                coarse: false, outlier: false, conf: 0.1, nguon: 'UNKNOWN',
                ngoaiDuong: false, loai: leaf ? leaf.loai : 'NONE', leaf: leaf || null
            };
        }
        if (opts && opts.rejectNgoaiDuong && (leaf.ngoaiDuong || leaf.vatCan)) {
            return {
                z: NaN, sigma: 0.35, sigmaFit: 0.35, spanM: 0, dQ: 0,
                coarse: Boolean(leaf.coarse), outlier: Boolean(leaf.outlier), conf: 0.1,
                nguon: 'REJECT', ngoaiDuong: true, loai: leaf.loai, leaf
            };
        }
        const zNen = this._zNenTaiLa(leaf, x, y);
        const dQ = Math.hypot(x - leaf.cx, y - leaf.cy);
        const spanM = Number.isFinite(leaf.spanM) ? leaf.spanM : 0;
        const sigma = this.sigmaTaiLa(leaf, x, y);
        const baseConf = Math.max(0.1, Math.min(1.0, 1.0 - sigma * 2.0));
        if (skipNeo || !this._neoState || !this._neoState.coNeoXe) {
            return {
                z: zNen,
                sigma,
                sigmaFit: leaf.sigma,
                spanM,
                dQ,
                coarse: Boolean(leaf.coarse),
                outlier: Boolean(leaf.outlier),
                conf: baseConf,
                nguon: leaf.loai,
                ngoaiDuong: Boolean(leaf.ngoaiDuong),
                loai: leaf.loai,
                leaf
            };
        }
        const confPts = Math.min(1.0, (leaf.nDiem || 0) / 30.0);
        const qNeo = this._zSauNeo(x, y, zNen, confPts);
        const sigmaOut = qNeo.W > 0.99 ? 0.02 : (qNeo.W > 0 ? Math.min(sigma, 0.04) : sigma);
        return {
            z: qNeo.z,
            sigma: sigmaOut,
            sigmaFit: leaf.sigma,
            spanM,
            dQ,
            coarse: Boolean(leaf.coarse),
            outlier: Boolean(leaf.outlier),
            conf: Math.max(baseConf, qNeo.W),
            nguon: leaf.loai,
            ngoaiDuong: Boolean(leaf.ngoaiDuong),
            loai: leaf.loai,
            leaf
        };
    }

    static _medianSmall(arr) {
        const n = arr ? arr.length : 0;
        if (n === 0) return NaN;
        const cp = Float64Array.from(arr).sort();
        const mid = n >> 1;
        return (n & 1) ? cp[mid] : 0.5 * (cp[mid - 1] + cp[mid]);
    }

    _chonBanKinhChuVi(carBox, huong, cfgRing, zRefInit = NaN) {
        const m1 = 0.55;
        const m2Max = 1.40;
        if (!cfgRing || !carBox) return { m1, m2: m2Max, blocked: false };
        const cx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? 0);
        const cy = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? 0);
        const rz = carBox.rz || 0;
        const W = carBox.W || 1.9;
        const halfW = W * 0.5;
        const sinR = Math.sin(rz);
        const cosR = Math.cos(rz);
        const step = Math.max(0.10, cfgRing.step || 0.25);
        const stopDz = cfgRing.stopDz ?? 0.12;
        const m2Min = cfgRing.m2Min ?? 0.40;

        let zBase = zRefInit;
        let out = { m1, m2: m2Max, blocked: false };
        for (let d = m1; d <= m2Max + 1e-6; d += step) {
            const v = huong * (halfW + d);
            const wx = cx - sinR * v;
            const wy = cy + cosR * v;
            const q = this.truyVan(wx, wy, true, REJECT_NGOAI_OPTS);
            const isStepCurb = Boolean(
                q && q.nguon === 'LEAF' && Number.isFinite(q.z)
                && Number.isFinite(zBase) && Math.abs(q.z - zBase) > stopDz
            );
            const isReject = Boolean(q && q.nguon === 'REJECT');
            const isElevatedNgoai = Boolean(
                isReject && q && q.leaf && Number.isFinite(q.leaf.z0)
                && Number.isFinite(zBase) && (q.leaf.z0 - zBase) > stopDz * 0.65
            );
            if (d === m1) {
                if (isStepCurb || isElevatedNgoai) {
                    out = { m1, m2: m2Min, blocked: true };
                    break;
                }
                const qRaw = (isReject && q.leaf && Number.isFinite(q.leaf.z0)) ? q.leaf.z0 : q?.z;
                if (Number.isFinite(qRaw) && !Number.isFinite(zBase)) {
                    zBase = qRaw;
                }
            } else {
                if (isReject || isStepCurb) {
                    out = { m1, m2: Math.max(m2Min, Math.min(m2Max, d - step)), blocked: false };
                    break;
                }
                if (!Number.isFinite(zBase) && q && q.nguon === 'LEAF' && Number.isFinite(q.z)) {
                    zBase = q.z;
                }
            }
        }
        return out;
    }

    static _docDuPhong(cLeaf, prior, cfgCap, cosR, sinR) {
        const capLong = cfgCap?.long ?? 0.08;
        const capLat = cfgCap?.lat ?? 0.035;
        const g0u = Number.isFinite(prior?.gu0) ? prior.gu0 : 0;
        const g0v = Number.isFinite(prior?.gv0) ? prior.gv0 : 0;
        const clampU = (v) => Math.max(-capLong, Math.min(capLong, v));
        const clampV = (v) => Math.max(-capLat, Math.min(capLat, v));
        if (!cLeaf || cLeaf.loai !== 'LEAF' || cLeaf.ngoaiDuong || cLeaf.outlier) {
            return { gu: clampU(g0u), gv: clampV(g0v), conf: 'LOW' };
        }
        const gLeafU = cosR * (cLeaf.gu || 0) + sinR * (cLeaf.gv || 0);
        const gLeafV = -sinR * (cLeaf.gu || 0) + cosR * (cLeaf.gv || 0);
        return {
            gu: clampU(g0u + 0.5 * (gLeafU - g0u)),
            gv: clampV(g0v + 0.5 * (gLeafV - g0v)),
            conf: 'LOW'
        };
    }

    static _fitPlaneIrls(samples, prior, cfgIrls, cfgCap) {
        const n = samples ? samples.length : 0;
        const gu0 = Number.isFinite(prior?.gu0) ? prior.gu0 : 0;
        const gv0 = Number.isFinite(prior?.gv0) ? prior.gv0 : 0;
        if (n === 0) {
            return { c: NaN, a: gu0, b: gv0, nInlier: 0, nLeft: 0, nRight: 0, sigmaRobust: Infinity, wFinal: [], residuals: [], rmsRes: Infinity, ok: false };
        }

        const cInitArr = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const s = samples[i];
            cInitArr[i] = s.z - gu0 * s.u - gv0 * s.v;
        }
        let c = MatDuongDongTam._medianSmall(cInitArr);
        let a = gu0;
        let b = gv0;

        const iterMax = Math.max(1, cfgIrls?.iter ?? 3);
        const kBase = cfgIrls?.k ?? 2.5;
        const zeroMul = Math.max(1.05, cfgIrls?.zeroAt ?? 2.5);
        const sigmaFloor = cfgIrls?.sigmaFloor ?? 0.015;
        const minInlier = cfgIrls?.minInlier ?? 3;
        const capLong = cfgCap?.long ?? 0.08;
        const capLat = cfgCap?.lat ?? 0.035;
        const sw0 = Math.max(1e-9, prior?.sw0 ?? 1.0);

        const wFinal = new Float64Array(n);
        const residuals = new Float64Array(n);
        const absRes = new Float64Array(n);
        let nInlier = n, nLeft = 0, nRight = 0, sigmaRobust = sigmaFloor;
        let ok = false;

        const wRobArr = new Float64Array(n);
        for (let iter = 0; iter < iterMax; iter++) {
            for (let i = 0; i < n; i++) {
                const s = samples[i];
                const r = s.z - (c + a * s.u + b * s.v);
                residuals[i] = r;
                absRes[i] = Math.abs(r);
            }
            const mad = 1.4826 * MatDuongDongTam._medianSmall(absRes);
            sigmaRobust = Math.max(mad, sigmaFloor);

            let swEff = 0;
            nInlier = 0;
            nLeft = 0;
            nRight = 0;
            let allFullWeight = true;

            for (let i = 0; i < n; i++) {
                const s = samples[i];
                const r = residuals[i];
                const ar = absRes[i];
                const kEff = r > 0 ? 0.8 * kBase : kBase;
                const thr1 = kEff * sigmaRobust;
                const thr2 = zeroMul * thr1;
                let wRob = 1.0;
                if (n >= 4 && ar > thr1) {
                    allFullWeight = false;
                    wRob = ar >= thr2 ? 0.0 : (thr2 - ar) / Math.max(1e-9, thr2 - thr1);
                }
                wFinal[i] = wRob;
                wRobArr[i] = wRob;
                if (wRob > 0.1) {
                    nInlier++;
                    if (s.sideBit === 2) nLeft++;
                    else if (s.sideBit === 3) nRight++;
                }
                swEff += s.wBase * wRob;
            }

            if (nInlier < minInlier || swEff <= 1e-9) {
                ok = false;
                break;
            }
            const scaleLam = allFullWeight ? 1.0 : (swEff / sw0);
            const lamU = (prior?.lamU ?? 0.25 * sw0) * scaleLam;
            const lamV = (prior?.lamV ?? 0.25 * sw0) * scaleLam;

            let m00 = 0, m01 = 0, m02 = 0;
            let m11 = lamU, m12 = 0, m22 = lamV;
            let b0 = 0, b1 = lamU * gu0, b2 = lamV * gv0;
            for (let i = 0; i < n; i++) {
                const s = samples[i];
                const wEff = s.wBase * wRobArr[i];
                if (wEff <= 0) continue;
                m00 += wEff;
                m01 += wEff * s.u;
                m02 += wEff * s.v;
                m11 += wEff * s.u * s.u;
                m12 += wEff * s.u * s.v;
                m22 += wEff * s.v * s.v;
                b0 += wEff * s.z;
                b1 += wEff * s.u * s.z;
                b2 += wEff * s.v * s.z;
            }

            const sol = MatDuongDongTam._solve3x3(
                [
                    [m00, m01, m02],
                    [m01, m11, m12],
                    [m02, m12, m22]
                ],
                [b0, b1, b2]
            );
            if (!sol) {
                ok = false;
                break;
            }
            const nextC = sol[0];
            const nextA = sol[1];
            const nextB = sol[2];
            const diff = Math.max(Math.abs(nextC - c), Math.abs(nextA - a), Math.abs(nextB - b));
            c = nextC;
            a = nextA;
            b = nextB;
            ok = true;
            if (allFullWeight || diff < 1e-9) break;
        }

        if (ok) {
            const clampedA = Math.max(-capLong, Math.min(capLong, a));
            const clampedB = Math.max(-capLat, Math.min(capLat, b));
            if (clampedA !== a || clampedB !== b) {
                a = clampedA;
                b = clampedB;
                let swE = 0, swC = 0;
                for (let i = 0; i < n; i++) {
                    const s = samples[i];
                    const wE = s.wBase * wFinal[i];
                    if (wE <= 0) continue;
                    swE += wE;
                    swC += wE * (s.z - a * s.u - b * s.v);
                }
                if (swE > 1e-9) c = swC / swE;
            }
        }

        let sse = 0, nR = 0;
        for (let i = 0; i < n; i++) {
            const s = samples[i];
            const r = s.z - (c + a * s.u + b * s.v);
            residuals[i] = r;
            if (wFinal[i] > 0.1) {
                sse += r * r;
                nR++;
            }
        }
        const rmsRes = nR > 0 ? Math.sqrt(sse / Math.max(1, nR - 3)) : Infinity;

        return {
            c, a, b, nInlier, nLeft, nRight, sigmaRobust,
            wFinal,
            residuals,
            rmsRes,
            ok
        };
    }

    /**
     * Truy vấn mặt đường đồng tâm quanh OBB xe (chỉ dùng cx, cy, L, W, rz — bất biến 100% theo cz).
     * Khi tâm xe bị tự che khuất (UNKNOWN do mask footprint), nội suy IDW/WLS từ vành lá láng giềng.
     */
    truyVanChoXe(carBox, opts = {}) {
        const baseRob = this.opts?.robustSurface || MatDuongDongTam.MAC_DINH.robustSurface;
        const userRob = (opts && opts.robustSurface) ? opts.robustSurface : null;
        const robCfg = userRob
            ? {
                ...baseRob,
                ...userRob,
                irls: { ...(baseRob.irls || {}), ...(userRob.irls || {}) },
                ring: { ...(baseRob.ring || {}), ...(userRob.ring || {}) },
                slopeCap: { ...(baseRob.slopeCap || {}), ...(userRob.slopeCap || {}) }
            }
            : baseRob;
        const useRob = Boolean(robCfg && robCfg.enabled);
        const wantDbg = Boolean(opts && opts.debug);

        const invalid = {
            valid: false, z: NaN, gu: 0, gv: 0, gx: 0, gy: 0,
            sigma: 0.35, conf: 0, nLeaves: 0, spanM: Infinity,
            sidesCovered: 0, isSelfMasked: true, source: 'NONE', robust: false
        };
        if (!this.sanSang || !carBox) return invalid;
        const cx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? NaN);
        const cy = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? NaN);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return invalid;

        const L = carBox.L || 4.5;
        const W = carBox.W || 1.9;
        const rz = carBox.rz || 0;
        const halfL = L * 0.5;
        const halfW = W * 0.5;
        const cosR = Math.cos(rz);
        const sinR = Math.sin(rz);
        const otherMask = opts.otherMask || null;

        const egoGx = Number.isFinite(opts?.ego?.gx) ? opts.ego.gx : 0;
        const egoGy = Number.isFinite(opts?.ego?.gy) ? opts.ego.gy : 0;
        const egoGu0 = cosR * egoGx + sinR * egoGy;
        const egoGv0 = -sinR * egoGx + cosR * egoGy;

        const queryOpts = (useRob && robCfg.rejectNgoaiDuong) ? REJECT_NGOAI_OPTS : undefined;
        const qCenter = this.truyVan(cx, cy, true, queryOpts);
        const isSelfMasked = !qCenter || qCenter.nguon !== 'LEAF' || !Number.isFinite(qCenter.z);

        const ringL = useRob ? this._chonBanKinhChuVi(carBox, +1, robCfg.ring, !isSelfMasked ? qCenter.z : NaN) : null;
        const ringR = useRob ? this._chonBanKinhChuVi(carBox, -1, robCfg.ring, !isSelfMasked ? qCenter.z : NaN) : null;

        // 10 hướng mẫu cố định (3 đầu, 3 đuôi, 2 trái, 2 phải), dự phòng bước 2 nếu mép 1 còn kẹt trong cell tự che
        const m1 = opts.margin ?? 0.55;
        const m2Default = Math.max(m1 + 0.85, 1.40);
        const offsets = [
            [1, 0, -0.6, 0], [1, 0, 0, 0], [1, 0, 0.6, 0],
            [-1, 0, -0.6, 1], [-1, 0, 0, 1], [-1, 0, 0.6, 1],
            [0, 1, 0, 2, -0.4], [0, 1, 0, 2, 0.4],
            [0, -1, 0, 3, -0.4], [0, -1, 0, 3, 0.4]
        ];

        const byLeaf = new Map();
        let sideMask = 0;
        let dbgNgoaiDuong = 0, dbgOutlier = 0, dbgCoarse = 0;
        const dbgNgoaiFlags = wantDbg ? [] : null;

        for (let i = 0; i < offsets.length; i++) {
            const o = offsets[i];
            if (useRob && o[3] === 2 && ringL && ringL.blocked) continue;
            if (useRob && o[3] === 3 && ringR && ringR.blocked) continue;
            const m2Side = useRob
                ? (o[3] === 2 ? Math.max(m1, ringL?.m2 ?? m2Default) : (o[3] === 3 ? Math.max(m1, ringR?.m2 ?? m2Default) : m2Default))
                : m2Default;
            const marginPair = (Math.abs(m2Side - m1) < 1e-6) ? [m1] : [m1, m2Side];

            let chosen = null;
            for (const m of marginPair) {
                const u = o[0] !== 0 ? o[0] * (halfL + m) : (o[4] * halfL);
                const v = o[1] !== 0 ? o[1] * (halfW + m) : (o[2] * halfW);
                const wx = cx + cosR * u - sinR * v;
                const wy = cy + sinR * u + cosR * v;
                if (otherMask && otherMask.testXY(wx, wy)) continue;
                const q = this.truyVan(wx, wy, true, queryOpts);
                if (q && q.leaf) {
                    if (q.ngoaiDuong || q.nguon === 'REJECT') dbgNgoaiDuong++;
                    if (q.outlier) dbgOutlier++;
                    if (q.coarse) dbgCoarse++;
                }
                if (q && q.nguon === 'LEAF' && Number.isFinite(q.z) && q.leaf) {
                    const d = Math.hypot(u, v);
                    chosen = { leafId: q.leaf.id, u, v, d, z: q.z, sigma: q.sigma, spanM: q.spanM, leaf: q.leaf, sideBit: o[3] };
                    if (wantDbg) dbgNgoaiFlags.push(Boolean(q.leaf.ngoaiDuong));
                    break;
                }
            }
            if (!chosen) continue;
            sideMask |= (1 << chosen.sideBit);
            const prev = byLeaf.get(chosen.leafId);
            if (!prev || chosen.d < prev.d) byLeaf.set(chosen.leafId, chosen);
        }

        const samples = Array.from(byLeaf.values()).sort((a, b) => a.leafId - b.leafId);
        let sidesCovered = 0;
        for (let b = 0; b < 4; b++) if (sideMask & (1 << b)) sidesCovered++;

        const attachDbg = (outObj, branch, residuals = [], extra = {}) => {
            if (!wantDbg) return outObj;
            outObj.dbg = {
                nSamples: samples.length,
                nNgoaiDuong: dbgNgoaiDuong,
                nOutlier: dbgOutlier,
                nCoarse: dbgCoarse,
                sidesCovered,
                branch,
                gu: outObj.gu,
                gv: outObj.gv,
                residuals,
                ngoaiDuongFlag: dbgNgoaiFlags || [],
                ...extra
            };
            return outObj;
        };

        const finalizeRes = (baseRes) => {
            const activeNeo = (opts && opts.neoState) ? opts.neoState : this._neoState;
            if (!activeNeo || !activeNeo.coNeoXe) return baseRes;
            const bValid = Boolean(baseRes && baseRes.valid && Number.isFinite(baseRes.z));
            const bConf = bValid ? Math.min(0.85, baseRes.conf || 0.5) : 0.0;
            const qNeo = this._zSauNeo(cx, cy, bValid ? baseRes.z : NaN, bConf, opts);

            const blendNeoSlope = (resObj) => {
                if (!useRob || !robCfg.fuseNeoSlope) return resObj;
                if (!(qNeo.W > 0.1 && qNeo.W < 0.999 && Number.isFinite(qNeo.a) && Number.isFinite(qNeo.b))) return resObj;
                const tW = Math.max(0, Math.min(1, (qNeo.W - 0.1) / 0.899));
                const sW = tW * tW * (3.0 - 2.0 * tW);
                const baseGx = Number.isFinite(resObj.gx) ? resObj.gx : 0;
                const baseGy = Number.isFinite(resObj.gy) ? resObj.gy : 0;
                const nx = (1.0 - sW) * baseGx + sW * qNeo.a;
                const ny = (1.0 - sW) * baseGy + sW * qNeo.b;
                return {
                    ...resObj,
                    gx: nx,
                    gy: ny,
                    gu: cosR * nx + sinR * ny,
                    gv: -sinR * nx + cosR * ny
                };
            };

            if (qNeo.W >= 0.999) {
                const Neo = MatDuongDongTam._getNeoCtor();
                let bestSlopeA = Number.isFinite(qNeo.a) ? qNeo.a : (baseRes.gx || 0);
                let bestSlopeB = Number.isFinite(qNeo.b) ? qNeo.b : (baseRes.gy || 0);
                if (Neo) {
                    let bestD = Infinity;
                    for (const k of activeNeo.carNeos) {
                        const d = Neo.khoangCachChan(cx, cy, k);
                        if (d <= 0.05 && d < bestD) { bestD = d; bestSlopeA = k.a; bestSlopeB = k.b; }
                    }
                }
                return {
                    ...baseRes,
                    valid: true,
                    z: qNeo.z,
                    gu: cosR * bestSlopeA + sinR * bestSlopeB,
                    gv: -sinR * bestSlopeA + cosR * bestSlopeB,
                    gx: bestSlopeA,
                    gy: bestSlopeB,
                    sigma: 0.02,
                    conf: 1.0,
                    nLeaves: Math.max(1, baseRes.nLeaves || 0),
                    sidesCovered: Math.max(1, baseRes.sidesCovered || 0),
                    source: qNeo.nguon === 'NEO_CHONG' ? 'NEO_CHONG' : 'NEO_CUNG'
                };
            }
            if (bValid) {
                return blendNeoSlope({
                    ...baseRes,
                    z: qNeo.z,
                    sigma: qNeo.W > 0 ? Math.min(baseRes.sigma, 0.04 + 0.08 * (1.0 - qNeo.W)) : baseRes.sigma,
                    conf: Math.max(baseRes.conf || 0, qNeo.W)
                });
            }
            if (qNeo.W > 0.1) {
                const useNeoSlope = (useRob && robCfg.fuseNeoSlope && Number.isFinite(qNeo.a) && Number.isFinite(qNeo.b));
                const gxQ = useNeoSlope ? qNeo.a : (baseRes.gx || 0);
                const gyQ = useNeoSlope ? qNeo.b : (baseRes.gy || 0);
                return {
                    ...baseRes,
                    valid: true,
                    z: qNeo.z,
                    gx: gxQ,
                    gy: gyQ,
                    gu: cosR * gxQ + sinR * gyQ,
                    gv: -sinR * gxQ + cosR * gyQ,
                    sigma: 0.03 + 0.015 * Math.max(0, qNeo.dMin),
                    conf: Math.max(0.5, qNeo.W),
                    nLeaves: Math.max(1, baseRes.nLeaves || 0),
                    sidesCovered: Math.max(1, baseRes.sidesCovered || 0),
                    source: qNeo.nguon
                };
            }
            const Neo = MatDuongDongTam._getNeoCtor();
            if (Neo && typeof Neo.zMem === 'function') {
                const exKey = opts?.excludeKey || null;
                const exTid = opts?.excludeTrackId ?? carBox.trackId ?? carBox.track?.id ?? null;
                const m = Neo.zMem(cx, cy, activeNeo, { excludeKey: exKey, excludeTrackId: exTid });
                const wMin = Neo.CONFIG?.WsoftMin ?? 0.20;
                if (m && m.valid && m.Wsoft >= wMin && Number.isFinite(m.z)) {
                    return {
                        ...baseRes,
                        valid: true,
                        soft: true,
                        z: m.z,
                        gu: cosR * m.a + sinR * m.b,
                        gv: -sinR * m.a + cosR * m.b,
                        gx: m.a,
                        gy: m.b,
                        sigma: 0.15 + 0.05 * Math.max(0, m.dMin),
                        conf: Math.max(0.25, m.Wsoft),
                        nLeaves: Math.max(1, baseRes.nLeaves || 0),
                        sidesCovered: Math.max(1, baseRes.sidesCovered || 0),
                        nguon: 'NEO_MEM',
                        source: 'NEO_MEM',
                        robust: false
                    };
                }
            }
            if (qNeo.dMin <= 2.0 && Number.isFinite(qNeo.z)) {
                return blendNeoSlope({
                    ...baseRes,
                    valid: true,
                    z: qNeo.z,
                    sigma: 0.03 + 0.015 * Math.max(0, qNeo.dMin),
                    conf: Math.max(0.5, qNeo.W),
                    nLeaves: Math.max(1, baseRes.nLeaves || 0),
                    sidesCovered: Math.max(1, baseRes.sidesCovered || 0),
                    source: qNeo.nguon
                });
            }
            return baseRes;
        };

        // Ca không bị tự che và tâm có lá rõ (<3 lá xung quanh vẫn dùng được lá tâm)
        if (!isSelfMasked && (samples.length < 2 || sidesCovered < 2)) {
            const cLeaf = qCenter.leaf;
            let gxC = (cLeaf && cLeaf.loai === 'LEAF') ? cLeaf.gu : 0;
            let gyC = (cLeaf && cLeaf.loai === 'LEAF') ? cLeaf.gv : 0;
            let guC = cosR * gxC + sinR * gyC;
            let gvC = -sinR * gxC + cosR * gyC;
            if (useRob) {
                const dp = MatDuongDongTam._docDuPhong(cLeaf, { gu0: egoGu0, gv0: egoGv0 }, robCfg.slopeCap, cosR, sinR);
                guC = dp.gu;
                gvC = dp.gv;
                gxC = cosR * guC - sinR * gvC;
                gyC = sinR * guC + cosR * gvC;
            }
            const spanC = qCenter.spanM || 0;
            const validC = qCenter.sigma <= 0.14 && !(cLeaf && cLeaf.outlier);
            const outLow = finalizeRes({
                valid: validC,
                z: qCenter.z,
                gu: guC,
                gv: gvC,
                gx: gxC,
                gy: gyC,
                sigma: qCenter.sigma,
                conf: qCenter.conf,
                nLeaves: 1,
                spanM: spanC,
                sidesCovered: Math.max(1, sidesCovered),
                isSelfMasked: false,
                source: 'LEAF_CENTER',
                robust: false
            });
            return attachDbg(outLow, 'LOW_SAMPLE', [], { ringL, ringR });
        }

        if (samples.length === 0) {
            return attachDbg(finalizeRes(invalid), isSelfMasked ? 'SELF_MASKED' : 'LOW_SAMPLE', [], { ringL, ringR });
        }

        let nLeaves = samples.length;
        let maxSpanM = 0;
        let sw = 0, swZ = 0, swGu = 0, swGv = 0;
        let statSum = 0;
        let nLeft = 0, nRight = 0;
        for (let i = 0; i < nLeaves; i++) {
            const s = samples[i];
            if (s.spanM > maxSpanM) maxSpanM = s.spanM;
            const w = 1.0 / ((s.d * s.d + 0.5) * s.sigma * s.sigma);
            s.wBase = w;
            const k = 1.0 / (1.0 + (s.d / 3.0) * (s.d / 3.0));
            sw += w;
            swZ += w * s.z;
            swGu += w * s.leaf.gu;
            swGv += w * s.leaf.gv;
            statSum += k / (s.sigma * s.sigma);
            if (s.sideBit === 2) nLeft++;
            else if (s.sideBit === 3) nRight++;
        }

        let zRing = swZ / sw;
        let gxW = swGu / sw;
        let gyW = swGv / sw;
        let gu = cosR * gxW + sinR * gyW;
        let gv = -sinR * gxW + cosR * gyW;
        let rmsRes = 0;
        let robustFit = false;
        let dbgBranch = 'RING_MEAN';
        let dbgResiduals = [];

        if (nLeaves >= 3 && sidesCovered >= 2) {
            const gu0 = gu, gv0 = gv;
            const lamSlope = 0.25 * sw;
            if (useRob) {
                dbgBranch = 'OLS3';
                const hasBothLat = (nLeft >= 1 && nRight >= 1 && !ringL?.blocked && !ringR?.blocked);
                const hasCurbOrEgo = Boolean(opts?.ego || ringL?.blocked || ringR?.blocked || dbgNgoaiDuong > 0 || opts?.forceLateralRidge);
                const balance = (hasBothLat || !hasCurbOrEgo) ? 1.0 : 0.0;
                const lamV = lamSlope * (1.0 + (robCfg.lateralRidgeBoost ?? 3.0) * (1.0 - balance));
                const capLong = robCfg.slopeCap?.long ?? 0.08;
                const capLat = robCfg.slopeCap?.lat ?? 0.035;
                const gu0Clamped = Math.max(-capLong, Math.min(capLong, gu0));
                const gv0Mixed = balance * gv0 + (1.0 - balance) * egoGv0;
                const gv0Clamped = Math.max(-capLat, Math.min(capLat, gv0Mixed));
                const irlsRes = MatDuongDongTam._fitPlaneIrls(
                    samples,
                    { gu0: gu0Clamped, gv0: gv0Clamped, lamU: lamSlope, lamV, sw0: sw },
                    robCfg.irls,
                    robCfg.slopeCap
                );
                dbgResiduals = irlsRes.residuals;
                if (irlsRes.ok) {
                    zRing = irlsRes.c;
                    gu = irlsRes.a;
                    gv = irlsRes.b;
                    gxW = cosR * gu - sinR * gv;
                    gyW = sinR * gu + cosR * gv;
                    rmsRes = irlsRes.rmsRes;
                    robustFit = (irlsRes.nInlier >= 6 && irlsRes.nLeft >= 1 && irlsRes.nRight >= 1);
                } else {
                    const dp = MatDuongDongTam._docDuPhong(isSelfMasked ? null : qCenter.leaf, { gu0: egoGu0, gv0: egoGv0 }, robCfg.slopeCap, cosR, sinR);
                    gu = dp.gu;
                    gv = dp.gv;
                    gxW = cosR * gu - sinR * gv;
                    gyW = sinR * gu + cosR * gv;
                    const zMedArr = samples.map(s => s.z - gu * s.u - gv * s.v);
                    zRing = MatDuongDongTam._medianSmall(zMedArr);
                    rmsRes = 0.08;
                    robustFit = false;
                }
            } else {
                dbgBranch = 'OLS3';
                let m00 = sw, m01 = 0, m02 = 0, m11 = lamSlope, m12 = 0, m22 = lamSlope;
                let b0 = swZ, b1 = lamSlope * gu0, b2 = lamSlope * gv0;
                for (let i = 0; i < nLeaves; i++) {
                    const s = samples[i];
                    const w = s.wBase;
                    m01 += w * s.u;
                    m02 += w * s.v;
                    m11 += w * s.u * s.u;
                    m12 += w * s.u * s.v;
                    m22 += w * s.v * s.v;
                    b1 += w * s.u * s.z;
                    b2 += w * s.v * s.z;
                }
                const sol = MatDuongDongTam._solve3x3([[m00, m01, m02], [m01, m11, m12], [m02, m12, m22]], [b0, b1, b2]);
                if (sol) {
                    const maxSl = this.opts.maxSlopeAbs || 0.12;
                    zRing = sol[0];
                    gu = Math.max(-maxSl, Math.min(maxSl, sol[1]));
                    gv = Math.max(-maxSl, Math.min(maxSl, sol[2]));
                    gxW = cosR * gu - sinR * gv;
                    gyW = sinR * gu + cosR * gv;
                }
                let sseR = 0;
                for (let i = 0; i < nLeaves; i++) {
                    const s = samples[i];
                    const r = s.z - (zRing + gu * s.u + gv * s.v);
                    if (wantDbg) dbgResiduals.push(r);
                    sseR += r * r;
                }
                rmsRes = Math.sqrt(sseR / Math.max(1, nLeaves - 3));
                robustFit = (nLeaves >= 6 && nLeft >= 1 && nRight >= 1);
            }
        } else if (useRob) {
            const capLong = robCfg.slopeCap?.long ?? 0.08;
            const capLat = robCfg.slopeCap?.lat ?? 0.035;
            gu = Math.max(-capLong, Math.min(capLong, gu));
            gv = Math.max(-capLat, Math.min(capLat, gv));
            gxW = cosR * gu - sinR * gv;
            gyW = sinR * gu + cosR * gv;
        }

        const sigStat = statSum > 1e-6 ? 1.0 / Math.sqrt(statSum) : 0.20;
        const sigRing = Math.hypot(sigStat, rmsRes, 0.02);

        let zFinal = zRing;
        let sigmaFinal = sigRing;
        let source = isSelfMasked ? 'RING_IDW' : 'LEAF_CENTER';
        if (!isSelfMasked) {
            maxSpanM = Math.max(maxSpanM, qCenter.spanM || 0);
            if (Math.abs(qCenter.z - zRing) <= 0.08) {
                const wc = 1.0 / (qCenter.sigma * qCenter.sigma);
                const wr = 1.0 / (sigRing * sigRing);
                zFinal = (wc * qCenter.z + wr * zRing) / (wc + wr);
                sigmaFinal = Math.min(Math.max(qCenter.sigma, 0.025), sigRing);
                source = 'LEAF_CENTER';
            } else if (sigRing <= qCenter.sigma) {
                zFinal = zRing;
                sigmaFinal = sigRing;
                source = 'RING_IDW';
            } else {
                zFinal = qCenter.z;
                sigmaFinal = qCenter.sigma;
                if (useRob) {
                    const dp = MatDuongDongTam._docDuPhong(qCenter.leaf, { gu0: egoGu0, gv0: egoGv0 }, robCfg.slopeCap, cosR, sinR);
                    gu = dp.gu;
                    gv = dp.gv;
                    gxW = cosR * gu - sinR * gv;
                    gyW = sinR * gu + cosR * gv;
                    robustFit = false;
                } else {
                    gxW = qCenter.leaf.gu;
                    gyW = qCenter.leaf.gv;
                    gu = cosR * gxW + sinR * gyW;
                    gv = -sinR * gxW + cosR * gyW;
                }
                source = 'LEAF_CENTER';
            }
        }

        const valid = (nLeaves >= 2 && sidesCovered >= 2 && sigmaFinal <= 0.15)
            || (!isSelfMasked && sigmaFinal <= 0.12 && !qCenter.outlier);
        const conf = Math.min(1.0, nLeaves / 6.0) * Math.exp(-sigmaFinal / 0.08) * (sidesCovered / 4.0);

        const outFinal = finalizeRes({
            valid,
            z: valid ? zFinal : NaN,
            gu, gv, gx: gxW, gy: gyW,
            sigma: sigmaFinal,
            conf,
            nLeaves,
            spanM: maxSpanM,
            sidesCovered,
            isSelfMasked,
            source,
            robust: valid && robustFit
        });
        return attachDbg(outFinal, isSelfMasked ? 'SELF_MASKED' : dbgBranch, dbgResiduals, { nLeft, nRight, ringL, ringR });
    }

    matDoKyVong(r) {
        if (!this.sanSang || !Number.isFinite(r) || this.nr <= 0) return 0;
        const rLo = r / 1.3;
        const rHi = r * 1.3;
        const densList = [];
        for (let i = 0; i < this.leaves.length; i++) {
            const lf = this.leaves[i];
            if (!lf || lf.loai !== 'LEAF' || lf.outlier) continue;
            const rMid = 0.5 * (lf.r0 + lf.r1);
            if (rMid < rLo || rMid > rHi) continue;
            const area = lf.area || (0.5 * (lf.r1 * lf.r1 - lf.r0 * lf.r0) * (lf.t1 - lf.t0));
            if (area > 0.25 && lf.nDiem > 0) densList.push(lf.nDiem / area);
        }
        if (densList.length >= 2) {
            densList.sort((a, b) => a - b);
            return MatDuongDongTam._pQuantileSorted(densList, 0.50);
        }
        const rClamp = Math.max(this.ringEdges[0], Math.min(this.ringEdges[this.nr] - 1e-9, r));
        const ri = this._chiSoVong(rClamp);
        if (ri >= 0 && this.ringDens[ri] > 0) return this.ringDens[ri];
        return 2.5 * Math.pow(Math.max(4.0, r) / 10.0, -2.5);
    }

    /**
     * Step 3: Mật độ mặt đất quanh vùng Elip mở rộng quanh xe (không dùng cz/zBottom).
     */
    tinhMatDoDatEllip(carBox, rawPts, otherMask = null, ref = null) {
        const emptyOut = {
            valid: false, nGround: 0, nAbove: 0, nBelow: 0,
            areaOpen: 0, densReal: 0, densExp: 0, groundRatio: 0,
            purity: 0, isClearRoad: false, isFading: true
        };
        if (!carBox) return emptyOut;
        const cx = Number.isFinite(carBox.x) ? carBox.x : (carBox.cx ?? NaN);
        const cy = Number.isFinite(carBox.y) ? carBox.y : (carBox.cy ?? NaN);
        if (!Number.isFinite(cx) || !Number.isFinite(cy)) return emptyOut;

        const L = carBox.L || 4.5;
        const W = carBox.W || 1.9;
        const rz = carBox.rz || 0;
        const halfL = L * 0.5;
        const halfW = W * 0.5;
        const R = Math.hypot(cx, cy);
        const padFar = Math.min(2.5, 0.03 * Math.max(0, R - 20.0));
        const a = halfL + 2.5 + padFar;
        const b = halfW + 1.8 + padFar;
        const invA2 = 1.0 / (a * a);
        const invB2 = 1.0 / (b * b);
        const selfExL = halfL + 0.15;
        const selfExW = halfW + 0.15;
        const cosR = Math.cos(rz);
        const sinR = Math.sin(rz);

        let z0 = NaN, gx = 0, gy = 0;
        if (ref && Number.isFinite(ref.z)) {
            z0 = ref.z;
            gx = Number.isFinite(ref.gx) ? ref.gx : 0;
            gy = Number.isFinite(ref.gy) ? ref.gy : 0;
        } else if (this.sanSang) {
            const qCar = this.truyVanChoXe(carBox, { otherMask });
            if (qCar && qCar.valid && Number.isFinite(qCar.z)) {
                z0 = qCar.z; gx = qCar.gx; gy = qCar.gy;
            }
        }
        if (!Number.isFinite(z0)) return emptyOut;

        // Raster cố định bước 0.25m tính diện tích mở quanh xe trong elip
        const step = 0.25;
        let openCells = 0;
        for (let u = -a + 0.5 * step; u <= a; u += step) {
            const uu = u * u * invA2;
            if (uu > 1.0) continue;
            const absU = Math.abs(u);
            for (let v = -b + 0.5 * step; v <= b; v += step) {
                if (uu + v * v * invB2 > 1.0) continue;
                if (absU <= selfExL && Math.abs(v) <= selfExW) continue;
                if (otherMask) {
                    const wx = cx + cosR * u - sinR * v;
                    const wy = cy + sinR * u + cosR * v;
                    if (otherMask.testXY(wx, wy)) continue;
                }
                openCells++;
            }
        }
        const areaOpen = openCells * step * step;
        if (areaOpen < 0.25) return emptyOut;

        let nGround = 0, nAbove = 0, nBelow = 0;
        const maxR2 = (a + 0.2) * (a + 0.2);
        const countPt = (px, py, pz) => {
            const dx = px - cx;
            const dy = py - cy;
            if (dx * dx + dy * dy > maxR2) return;
            const u = cosR * dx + sinR * dy;
            const v = -sinR * dx + cosR * dy;
            if (u * u * invA2 + v * v * invB2 > 1.0) return;
            if (Math.abs(u) <= selfExL && Math.abs(v) <= selfExW) return;
            if (otherMask && otherMask.testXY(px, py)) return;
            const dz = pz - (z0 + gx * dx + gy * dy);
            if (dz >= -0.18 && dz <= 0.18) nGround++;
            else if (dz > 0.18 && dz <= 1.00) nAbove++;
            else if (dz >= -0.80 && dz < -0.18) nBelow++;
        };

        if (Array.isArray(rawPts)) {
            for (let i = 0; i < rawPts.length; i++) {
                const p = rawPts[i];
                if (!p || p.length < 3) continue;
                countPt(p[0], p[1], p[2]);
            }
        } else if (rawPts && rawPts.isFlat && rawPts.flatArray) {
            const fl = rawPts.flatArray;
            const n = rawPts.count ?? Math.floor(fl.length / 3);
            for (let i = 0; i < n; i++) {
                const k = i * 3;
                countPt(fl[k], fl[k + 1], fl[k + 2]);
            }
        }

        const densReal = nGround / areaOpen;
        const densExp = this.matDoKyVong(R);
        const groundRatio = densExp > 1e-5 ? densReal / densExp : (nGround >= 15 ? 1.0 : 0.0);
        const purity = (nGround + nAbove) > 0 ? nGround / (nGround + nAbove) : 0.0;
        const isClearRoad = areaOpen >= 6.0 && groundRatio >= 0.60 && purity >= 0.70;
        const isFading = groundRatio < 0.25 || nGround < 15;

        return {
            valid: true,
            nGround, nAbove, nBelow,
            areaOpen, densReal, densExp, groundRatio,
            purity, isClearRoad, isFading
        };
    }
}

if (typeof globalThis !== 'undefined') {
    globalThis.MatDuongDongTam = MatDuongDongTam;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MatDuongDongTam;
}
