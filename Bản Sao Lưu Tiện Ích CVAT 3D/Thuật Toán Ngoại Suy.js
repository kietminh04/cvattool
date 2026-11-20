/**
 * THUẬT TOÁN NGOẠI SUY & NỘI SUY QUỸ ĐẠO 3D V2 (CHUẨN HÓA ĐỘNG HỌC & LIDAR L-SHAPE)
 * -------------------------------------------------------------------------------
 * Kiến trúc thuần hàm (không phụ thuộc DOM), dùng được cả trên Chrome Extension,
 * CVAT Localhost (`cvat-ui`), và Node.js kiểm thử hồi quy:
 * 1. Ego SE(2) bền 2 tầng: RANSAC 1 điểm trên box tĩnh + BEV LiDAR Chamfer-DT Scan Matching + Đồ thị cache.
 * 2. Lọc mẫu ngoại lai Leave-One-Out Theil-Sen (khử yaw nhảy 180°, Z rác) & phân loại tĩnh/chậm/nhanh theo ý nghĩa 3σ.
 * 3. Động học Huber CV + Cung tròn CTRV (+ gia tốc có kiểm soát), không kẹp trần vận tốc 1.8 m/frame.
 * 4. Tinh chỉnh LiDAR L-shape sau dự đoán: dùng lại `chonVaLocNguCanhFrame`, `phanTichLopThanXeChinh`, `tinhDxDyMep`
 *    với bán kính thích ứng σ(dt) và cổng an toàn "không làm tệ hơn" (Do-No-Harm Gate).
 * 5. Khớp cao độ Z & Pitch/Roll theo mặt đất thực (`canChinhMatDuongHop` + `NeoDuyet`), bỏ `vz * dt` gây văng Z.
 */

class ThuatToanNgoaiSuy {

    static get CAU_HINH() {
        return {
            lidarGridCell: 0.25,     // Đồng bộ với VOX = 0.25m (lưới 336x336 quanh ±42m)
            lidarVoxelSize: 0.25,
            lidarGridHalf: 42.0,     // ±42m quanh xe LiDAR
            lidarTruncDist: 1.80,
            lidarGridMaxPts: 12000,  // Dựng gridA đầy đủ (không bị rớt điểm)
            lidarMaxPts: 2800,       // Tập query B phân tầng lồng nhau (600 / 1400 / 2800)
            lidarFarQuotaMin: 0.25,  // Dành >= 25% query B cho vành xa 20..42m để khóa góc quay
            maxEgoCacheEdges: 512,
            maxDtLuoiCache: 24
        };
    }

    static wrapAngle(a) {
        if (!Number.isFinite(a)) return 0.0;
        let res = a % (2.0 * Math.PI);
        if (res > Math.PI) res -= 2.0 * Math.PI;
        if (res < -Math.PI) res += 2.0 * Math.PI;
        return res;
    }

    static applySE2(pt, se2) {
        if (!se2) return [pt[0], pt[1], this.wrapAngle(pt[2] || 0)];
        const c = Math.cos(se2.th);
        const s = Math.sin(se2.th);
        return [
            c * pt[0] - s * pt[1] + se2.tx,
            s * pt[0] + c * pt[1] + se2.ty,
            this.wrapAngle((pt[2] || 0) + se2.th)
        ];
    }

    static composeSE2(a, b) {
        // Áp dụng b trước rồi a: T_total(p) = a(b(p))
        const ca = Math.cos(a.th), sa = Math.sin(a.th);
        return {
            tx: ca * b.tx - sa * b.ty + a.tx,
            ty: sa * b.tx + ca * b.ty + a.ty,
            th: this.wrapAngle(a.th + b.th),
            conf: Math.min(a.conf ?? 1, b.conf ?? 1),
            ok: Boolean(a.ok && b.ok)
        };
    }

    static invertSE2(se2) {
        if (!se2) return { tx: 0, ty: 0, th: 0, conf: 0, ok: false };
        const c = Math.cos(-se2.th), s = Math.sin(-se2.th);
        return {
            tx: -(c * se2.tx - s * se2.ty),
            ty: -(s * se2.tx + c * se2.ty),
            th: -se2.th,
            conf: se2.conf ?? 0.5,
            ok: Boolean(se2.ok)
        };
    }

    static _median(arr) {
        if (!arr || arr.length === 0) return 0;
        const s = [...arr].sort((a, b) => a - b);
        const m = Math.floor(s.length / 2);
        return (s.length % 2 === 1) ? s[m] : 0.5 * (s[m - 1] + s[m]);
    }

    static _weightedMedian(vals, weights) {
        if (!vals || vals.length === 0) return 0;
        const pairs = vals.map((v, i) => ({ v, w: Math.max(1e-6, weights[i] ?? 1) })).sort((a, b) => a.v - b.v);
        const total = pairs.reduce((s, p) => s + p.w, 0);
        let acc = 0;
        for (let i = 0; i < pairs.length; i++) {
            acc += pairs[i].w;
            if (acc >= total * 0.5) return pairs[i].v;
        }
        return pairs[pairs.length - 1].v;
    }

    static _circularMedian(angles, modPi = false) {
        if (!angles || angles.length === 0) return 0;
        const mult = modPi ? 2.0 : 1.0;
        let sc = 0, ss = 0;
        for (let i = 0; i < angles.length; i++) {
            sc += Math.cos(angles[i] * mult);
            ss += Math.sin(angles[i] * mult);
        }
        let meanA = Math.atan2(ss, sc) / mult;
        // Tinh chỉnh thành trung vị quanh meanA
        const diffs = angles.map(a => {
            let d = this.wrapAngle(a - meanA);
            if (modPi) {
                const alt = this.wrapAngle(a + Math.PI - meanA);
                if (Math.abs(alt) < Math.abs(d)) d = alt;
            }
            return d;
        });
        return this.wrapAngle(meanA + this._median(diffs));
    }

    static _diemTrongObb(px, py, box, margin = 0.0) {
        // box có thể là {cx, cy, rz, L, W} hoặc mảng CVAT 9 phần tử
        const cx = Array.isArray(box) ? box[0] : box.cx;
        const cy = Array.isArray(box) ? box[1] : box.cy;
        const rz = Array.isArray(box) ? (box[5] || 0) : (box.rz || 0);
        const L = Array.isArray(box) ? box[6] : box.L;
        const W = Array.isArray(box) ? box[7] : box.W;
        const dx = px - cx, dy = py - cy;
        const c = Math.cos(-rz), s = Math.sin(-rz);
        const lx = c * dx - s * dy;
        if (Math.abs(lx) > L * 0.5 + margin) return false;
        const ly = s * dx + c * dy;
        return Math.abs(ly) <= W * 0.5 + margin;
    }

    static _layShapeTrongTrack(track, frame) {
        if (!track || !Array.isArray(track.shapes)) return null;
        for (let i = 0; i < track.shapes.length; i++) {
            const s = track.shapes[i];
            if (s && Number(s.frame) === Number(frame) && !s.outside && s.points && s.points.length >= 9) {
                return s.points;
            }
        }
        return null;
    }

    // =========================================================================
    // STEP 1: EGO SE(2) TỪ BOX BỀN (RANSAC 1 ĐIỂM 3-DOF + WEIGHTED KABSCH)
    // Trả phép biến đổi B -> A: p_A = R(th) * p_B + t
    // =========================================================================
    static uocLuongEgoTuHop(fA, fB, allTracks, opts = {}) {
        if (!Array.isArray(allTracks) || fA === fB) {
            return { tx: 0, ty: 0, th: 0, nInl: 0, conf: fA === fB ? 1 : 0, cov: [0, 0, 0], ok: fA === fB };
        }
        const excludeTrack = opts.excludeTrack || null;
        const kho = opts.khoDuyet || (typeof window !== 'undefined' ? window.khoDuyet : null);
        const cands = [];

        for (let i = 0; i < allTracks.length; i++) {
            const tr = allTracks[i];
            if (!tr || tr === excludeTrack) continue;
            if (excludeTrack && tr.id !== undefined && tr.id === excludeTrack.id && tr._trackNumber === excludeTrack._trackNumber) continue;

            const pA = this._layShapeTrongTrack(tr, fA);
            const pB = this._layShapeTrongTrack(tr, fB);
            if (!pA || !pB) continue;

            // Prior tĩnh theo kích thước/loại: xe con/tải nhẹ đáng tin hơn xe máy/người
            const L = pA[6] || 4.3;
            let priorW = (L >= 2.2 && L <= 6.2) ? 1.0 : (L > 6.2 ? 0.65 : 0.25);
            if (kho && kho.batNeo && kho.laDaDuyet(tr, fA, tr, null) && kho.laDaDuyet(tr, fB, tr, null)) {
                priorW *= 2.5;
            }
            cands.push({
                xA: pA[0], yA: pA[1], yawA: pA[5] || 0,
                xB: pB[0], yB: pB[1], yawB: pB[5] || 0,
                w: priorW,
                dist: Math.hypot(pA[0], pA[1])
            });
        }

        const n = cands.length;
        if (n < 1) return { tx: 0, ty: 0, th: 0, nInl: 0, conf: 0, cov: [10, 10, 1], ok: false };

        let bestInl = [];
        let bestScore = -1;
        const maxChecks = Math.min(n, 200);

        // RANSAC 1 điểm: mỗi cặp box (cùng yaw) sinh đủ 3 DOF (tx, ty, th)
        for (let i = 0; i < maxChecks; i++) {
            const h = cands[i];
            // Thử trực tiếp dYaw và kiểm tra khả năng prelabel flip 180°
            const dth = this.wrapAngle(h.yawA - h.yawB);
            const c = Math.cos(dth), s = Math.sin(dth);
            const tx = h.xA - (c * h.xB - s * h.yB);
            const ty = h.yA - (s * h.xB + c * h.yB);

            const inl = [];
            let score = 0;
            for (let k = 0; k < n; k++) {
                const ck = cands[k];
                const px = c * ck.xB - s * ck.yB + tx;
                const py = s * ck.xB + c * ck.yB + ty;
                const posErr = Math.hypot(px - ck.xA, py - ck.yA);
                const yawErr = Math.abs(this.wrapAngle(ck.yawA - (ck.yawB + dth)));
                const posTol = 0.28 + 0.012 * ck.dist;
                if (posErr <= posTol && yawErr <= 0.14) { // <= ~8°
                    inl.push(k);
                    score += ck.w;
                }
            }
            if (score > bestScore || (score === bestScore && inl.length > bestInl.length)) {
                bestScore = score;
                bestInl = inl;
            }
        }

        if (bestInl.length === 0) {
            return { tx: 0, ty: 0, th: 0, nInl: 0, conf: 0, cov: [10, 10, 1], ok: false };
        }

        // Weighted Kabsch: kết hợp tâm xe + cặp điểm ảo ±1m dọc trục xe để ổn định góc ngay cả khi ít inlier
        const pList = [], qList = [], wList = [];
        for (let ii = 0; ii < bestInl.length; ii++) {
            const ck = cands[bestInl[ii]];
            pList.push([ck.xB, ck.yB]); qList.push([ck.xA, ck.yA]); wList.push(ck.w);
            const cB = Math.cos(ck.yawB), sB = Math.sin(ck.yawB);
            const cA = Math.cos(ck.yawA), sA = Math.sin(ck.yawA);
            pList.push([ck.xB + 1.0 * cB, ck.yB + 1.0 * sB]);
            qList.push([ck.xA + 1.0 * cA, ck.yA + 1.0 * sA]);
            wList.push(ck.w * 0.45);
        }

        let wSum = 0, mxP = 0, myP = 0, mxQ = 0, myQ = 0;
        for (let i = 0; i < pList.length; i++) {
            const w = wList[i];
            wSum += w;
            mxP += w * pList[i][0]; myP += w * pList[i][1];
            mxQ += w * qList[i][0]; myQ += w * qList[i][1];
        }
        mxP /= wSum; myP /= wSum; mxQ /= wSum; myQ /= wSum;

        let numCos = 0, numSin = 0;
        for (let i = 0; i < pList.length; i++) {
            const w = wList[i];
            const ax = pList[i][0] - mxP, ay = pList[i][1] - myP;
            const bx = qList[i][0] - mxQ, by = qList[i][1] - myQ;
            numCos += w * (ax * bx + ay * by);
            numSin += w * (ax * by - ay * bx);
        }
        const th = Math.atan2(numSin, numCos);
        const c = Math.cos(th), s = Math.sin(th);
        const tx = mxQ - (c * mxP - s * myP);
        const ty = myQ - (s * mxP + c * myP);

        // Tính residual thực tế
        let errSqSum = 0, spanSq = 0;
        let meanX = 0, meanY = 0;
        for (let ii = 0; ii < bestInl.length; ii++) {
            meanX += cands[bestInl[ii]].xA;
            meanY += cands[bestInl[ii]].yA;
        }
        meanX /= bestInl.length; meanY /= bestInl.length;
        for (let ii = 0; ii < bestInl.length; ii++) {
            const ck = cands[bestInl[ii]];
            const px = c * ck.xB - s * ck.yB + tx;
            const py = s * ck.xB + c * ck.yB + ty;
            errSqSum += (px - ck.xA) ** 2 + (py - ck.yA) ** 2;
            spanSq += (ck.xA - meanX) ** 2 + (ck.yA - meanY) ** 2;
        }
        const rms = Math.max(0.08, Math.sqrt(errSqSum / Math.max(1, bestInl.length)));
        const nInl = bestInl.length;
        const covT = (rms * rms) / nInl;
        const covTh = (rms * rms) / Math.max(4.0, spanSq);
        // Nếu chỉ có 1 inlier -> hạ mạnh độ tin cậy để Step 2 ưu tiên LiDAR
        const conf = nInl >= 4 ? Math.min(0.95, 0.55 + 0.08 * nInl) : (nInl >= 2 ? 0.55 : 0.20);

        return { tx, ty, th, nInl, conf, cov: [covT, covT, covTh], ok: nInl >= 1 };
    }

    // =========================================================================
    // STEP 2: EGO LIDAR BEV CHAMFER DISTANCE TRANSFORM SCAN MATCHING + FUSION
    // =========================================================================
    static _uocLuongMatDatNhanh(pts) {
        const gZs = [];
        const nearGZs = [];
        const stepG = Math.max(1, Math.floor(pts.length / 1500));
        for (let i = 0; i < pts.length; i += stepG) {
            const p = pts[i];
            const px = p[0], py = p[1], pz = p[2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            const r2 = px * px + py * py;
            if (r2 >= 16.0 && r2 <= 400.0 && pz >= -2.5 && pz <= 1.2) gZs.push(pz);
            if (r2 >= 9.0 && r2 <= 64.0 && pz >= -0.8 && pz <= 0.8) nearGZs.push(pz);
        }
        gZs.sort((a, b) => a - b);
        const usedFallback = gZs.length < 10;
        let gZ = !usedFallback ? gZs[Math.floor(gZs.length * 0.20)] : 0.0;
        if (Math.abs(gZ) > 0.25) gZ = 0.0;

        let gNear = 0.0;
        if (nearGZs.length >= 10) {
            nearGZs.sort((a, b) => a - b);
            gNear = nearGZs[Math.floor(nearGZs.length * 0.20)];
        }
        return { gZ, gNear, usedFallback };
    }

    static trichDiemTinhBEV(pts, dynamicBoxes = null, opts = null) {
        const traDayDu = Boolean(opts && opts.traDayDu);
        if (!pts || pts.length < 30) {
            return traDayDu
                ? { allXY: new Float32Array(0), queryXY: new Float32Array(0), gZ: 0.0, gNear: 0.0, usedFallback: true, nVoxels: 0 }
                : new Float32Array(0);
        }
        const cfg = this.CAU_HINH;
        const half = cfg.lidarGridHalf;
        const maxR2 = half * half;
        const { gZ, gNear, usedFallback } = this._uocLuongMatDatNhanh(pts);

        // Lọc điểm kiến trúc tĩnh (z trên mặt đường 0.75..5.5m) + loại điểm trong box vật thể di động + trọng tâm voxel 0.25m
        const vox = new Map();
        const VOX = cfg.lidarVoxelSize || 0.25;
        const stride = Math.max(1, Math.floor(pts.length / 60000));
        for (let i = 0; i < pts.length; i += stride) {
            const p = pts[i];
            const x = p[0], y = p[1], z = p[2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            const r2 = x * x + y * y;
            if (r2 < 9.0 || r2 > maxR2) continue;
            const zRel = z - gZ;
            if (zRel < 0.75 || zRel > 5.5) continue;

            if (dynamicBoxes && dynamicBoxes.length > 0) {
                let inside = false;
                for (let bi = 0; bi < dynamicBoxes.length; bi++) {
                    if (this._diemTrongObb(x, y, dynamicBoxes[bi], 0.30)) { inside = true; break; }
                }
                if (inside) continue;
            }
            const ix = Math.floor(x / VOX), iy = Math.floor(y / VOX);
            const k = (ix + 512) * 1024 + (iy + 512);
            let cell = vox.get(k);
            if (!cell) {
                vox.set(k, { sumX: x, sumY: y, cnt: 1, ix, iy, r2 });
            } else {
                cell.sumX += x;
                cell.sumY += y;
                cell.cnt++;
            }
        }

        const nTotal = vox.size;
        if (nTotal === 0) {
            return traDayDu
                ? { allXY: new Float32Array(0), queryXY: new Float32Array(0), gZ, gNear, usedFallback, nVoxels: 0 }
                : new Float32Array(0);
        }

        // 1. Mảng allXY đầy đủ cho gridA (trần an toàn 12000)
        const gridCap = Math.min(nTotal, cfg.lidarGridMaxPts || 12000);
        const allXY = new Float32Array(gridCap * 2);
        const takeAll = nTotal > gridCap ? (nTotal / gridCap) : 1;

        // 2. Chọn mẫu phân tầng xác định cho query B: 3 dải cự ly (<10 / 10..20 / 20..42m) × 16 cung phương vị
        const N_BANDS = 3, N_SEC = 16;
        const bins = Array.from({ length: N_BANDS * N_SEC }, () => []);
        const bandLists = [[], [], []];
        let idxA = 0, accA = 0, cntA = 0;

        for (const v of vox.values()) {
            const mx = v.sumX / v.cnt;
            const my = v.sumY / v.cnt;
            const mr2 = mx * mx + my * my;
            const h = (((v.ix * 73856093) ^ (v.iy * 19349663)) >>> 0);
            if (cntA >= accA && idxA < gridCap) {
                allXY[idxA * 2] = mx;
                allXY[idxA * 2 + 1] = my;
                idxA++;
                accA += takeAll;
            }
            cntA++;

            const band = mr2 < 100.0 ? 0 : (mr2 < 400.0 ? 1 : 2);
            const sec = Math.floor(((Math.atan2(my, mx) + Math.PI) / (2.0 * Math.PI)) * N_SEC) & 15;
            const item = { x: mx, y: my, h, band };
            bins[band * N_SEC + sec].push(item);
        }

        for (let bi = 0; bi < bins.length; bi++) {
            const arr = bins[bi];
            if (arr.length > 1) arr.sort((a, b) => a.h - b.h);
        }

        // Lấy round-robin theo cung trong từng dải để đảm bảo lồng nhau ở 600 / 1400 / 2800
        for (let b = 0; b < N_BANDS; b++) {
            const ptrs = new Int32Array(N_SEC);
            let added = true;
            while (added) {
                added = false;
                for (let s = 0; s < N_SEC; s++) {
                    const arr = bins[b * N_SEC + s];
                    if (ptrs[s] < arr.length) {
                        bandLists[b].push(arr[ptrs[s]++]);
                        added = true;
                    }
                }
            }
        }

        // Tạo thứ tự lồng nhau qua các mốc [600, 1400, 2800]:
        // Tỉ lệ trong từng lát cắt: dải gần 25%, dải giữa 40%, dải xa (>= 35% -> luôn vượt ngưỡng >= 25% vành xa)
        const queryCap = Math.min(nTotal, cfg.lidarMaxPts || 2800);
        const queryXY = new Float32Array(queryCap * 2);
        const bPtr = [0, 0, 0];
        const bShares = [0.25, 0.40, 0.35];
        const tierEnds = [Math.min(600, queryCap), Math.min(1400, queryCap), queryCap];
        let qIdx = 0;

        for (let ti = 0; ti < tierEnds.length; ti++) {
            const targetEnd = tierEnds[ti];
            const tierNeed = targetEnd - qIdx;
            if (tierNeed <= 0) continue;
            const bandQuota = [
                Math.round(tierNeed * bShares[0]),
                Math.round(tierNeed * bShares[1]),
                tierNeed - Math.round(tierNeed * bShares[0]) - Math.round(tierNeed * bShares[1])
            ];
            for (let b = 0; b < N_BANDS; b++) {
                const take = Math.min(bandQuota[b], bandLists[b].length - bPtr[b]);
                for (let k = 0; k < take && qIdx < targetEnd; k++) {
                    const pt = bandLists[b][bPtr[b]++];
                    queryXY[qIdx * 2] = pt.x;
                    queryXY[qIdx * 2 + 1] = pt.y;
                    qIdx++;
                }
            }
            // Nếu dải nào thiếu điểm, bù dần từ các dải còn lại (ưu tiên xa -> giữa -> gần)
            while (qIdx < targetEnd) {
                let progressed = false;
                for (let b = N_BANDS - 1; b >= 0 && qIdx < targetEnd; b--) {
                    if (bPtr[b] < bandLists[b].length) {
                        const pt = bandLists[b][bPtr[b]++];
                        queryXY[qIdx * 2] = pt.x;
                        queryXY[qIdx * 2 + 1] = pt.y;
                        qIdx++;
                        progressed = true;
                    }
                }
                if (!progressed) break;
            }
        }

        const allSub = allXY.subarray(0, idxA * 2);
        const qSub = queryXY.subarray(0, qIdx * 2);
        if (traDayDu) {
            return { allXY: allSub, queryXY: qSub, gZ, gNear, usedFallback, nVoxels: nTotal };
        }
        return qSub;
    }

    static dungLuoiKhoangCach(ptsXY, cellOverride = null, truncOverride = null) {
        const cfg = this.CAU_HINH;
        const cell = cellOverride || cfg.lidarGridCell;
        const half = cfg.lidarGridHalf;
        const n = Math.floor((2.0 * half) / cell);
        const trunc = truncOverride || cfg.lidarTruncDist;
        const dt = new Float32Array(n * n);
        dt.fill(trunc);

        for (let i = 0; i < ptsXY.length; i += 2) {
            const gx = Math.floor((ptsXY[i] + half) / cell);
            const gy = Math.floor((ptsXY[i + 1] + half) / cell);
            if (gx >= 0 && gx < n && gy >= 0 && gy < n) {
                dt[gy * n + gx] = 0.0;
            }
        }

        // Chamfer 2-pass Distance Transform
        const dOrth = cell;
        const dDiag = cell * 1.41421356;
        for (let y = 0; y < n; y++) {
            const row = y * n;
            const prevRow = (y - 1) * n;
            for (let x = 0; x < n; x++) {
                const curIdx = row + x;
                let v = dt[curIdx];
                if (v === 0) continue;
                if (x > 0) v = Math.min(v, dt[curIdx - 1] + dOrth);
                if (y > 0) {
                    v = Math.min(v, dt[prevRow + x] + dOrth);
                    if (x > 0) v = Math.min(v, dt[prevRow + x - 1] + dDiag);
                    if (x < n - 1) v = Math.min(v, dt[prevRow + x + 1] + dDiag);
                }
                dt[curIdx] = v;
            }
        }
        for (let y = n - 1; y >= 0; y--) {
            const row = y * n;
            const nextRow = (y + 1) * n;
            for (let x = n - 1; x >= 0; x--) {
                const curIdx = row + x;
                let v = dt[curIdx];
                if (v === 0) continue;
                if (x < n - 1) v = Math.min(v, dt[curIdx + 1] + dOrth);
                if (y < n - 1) {
                    v = Math.min(v, dt[nextRow + x] + dOrth);
                    if (x < n - 1) v = Math.min(v, dt[nextRow + x + 1] + dDiag);
                    if (x > 0) v = Math.min(v, dt[nextRow + x - 1] + dDiag);
                }
                dt[curIdx] = v;
            }
        }
        return { dt, n, cell, half, trunc };
    }

    static dungLuoiDaTang(allXY) {
        if (!allXY || allXY.length < 30) return null;
        return {
            g0: this.dungLuoiKhoangCach(allXY, 1.00, 6.0),
            g1: this.dungLuoiKhoangCach(allXY, 0.50, 3.0),
            g2: this.dungLuoiKhoangCach(allXY, this.CAU_HINH.lidarGridCell || 0.25, this.CAU_HINH.lidarTruncDist || 1.8)
        };
    }

    static _sampleDT(luoi, x, y) {
        const fx = (x + luoi.half) / luoi.cell - 0.5;
        const fy = (y + luoi.half) / luoi.cell - 0.5;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        if (x0 < 0 || x0 >= luoi.n - 1 || y0 < 0 || y0 >= luoi.n - 1) {
            return { d: luoi.trunc, gx: 0, gy: 0, valid: false };
        }
        const tx = fx - x0, ty = fy - y0;
        const idx = y0 * luoi.n + x0;
        const d00 = luoi.dt[idx], d10 = luoi.dt[idx + 1];
        const d01 = luoi.dt[idx + luoi.n], d11 = luoi.dt[idx + luoi.n + 1];
        const d = (1 - ty) * ((1 - tx) * d00 + tx * d10) + ty * ((1 - tx) * d01 + tx * d11);
        const gx = ((1 - ty) * (d10 - d00) + ty * (d11 - d01)) / luoi.cell;
        const gy = ((1 - tx) * (d01 - d00) + tx * (d11 - d10)) / luoi.cell;
        return { d, gx, gy, valid: true };
    }

    static _solve3x3(H, g) {
        // Giải H * dx = -g bằng khử Gauss có partial pivoting
        const A = [
            [H[0], H[1], H[2], -g[0]],
            [H[3], H[4], H[5], -g[1]],
            [H[6], H[7], H[8], -g[2]]
        ];
        for (let col = 0; col < 3; col++) {
            let piv = col;
            for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
            if (Math.abs(A[piv][col]) < 1e-9) return null;
            if (piv !== col) { const tmp = A[col]; A[col] = A[piv]; A[piv] = tmp; }
            const inv = 1.0 / A[col][col];
            for (let j = col; j < 4; j++) A[col][j] *= inv;
            for (let r = 0; r < 3; r++) {
                if (r === col) continue;
                const f = A[r][col];
                for (let j = col; j < 4; j++) A[r][j] -= f * A[col][j];
            }
        }
        return [A[0][3], A[1][3], A[2][3]];
    }

    static canChinhEgoLidarBEV(luoiA, ptsB_in, init = { tx: 0, ty: 0, th: 0 }, opts = {}) {
        const ptsB_xy = (ptsB_in && ptsB_in.queryXY) ? ptsB_in.queryXY : ptsB_in;
        if (!luoiA || !ptsB_xy || ptsB_xy.length < 300) {
            return { tx: init.tx || 0, ty: init.ty || 0, th: init.th || 0, inlierFrac: 0, ok: false };
        }
        const isMulti = Boolean(luoiA.g2);
        const g0 = isMulti ? luoiA.g0 : luoiA;
        const g1 = isMulti ? luoiA.g1 : luoiA;
        const g2 = isMulti ? luoiA.g2 : luoiA;

        const tx0 = init.tx || 0, ty0 = init.ty || 0, th0 = init.th || 0;
        const nPts = ptsB_xy.length >> 1;
        const hasSeed = Boolean(opts && opts.hasSeed);

        const runGN = (grid, maxFloats, curTx, curTy, curTh, iters, truncCut, lossMode, lossK) => {
            let x = curTx, y = curTy, r = curTh;
            let lastH = [1, 0, 0, 0, 1, 0, 0, 0, 1];
            const lim = Math.min(ptsB_xy.length, maxFloats);
            const invK = 1.0 / Math.max(lossK, 1e-4);

            for (let it = 0; it < iters; it++) {
                const c = Math.cos(r), s = Math.sin(r);
                const H = [0, 0, 0, 0, 0, 0, 0, 0, 0];
                const g = [0, 0, 0];
                let active = 0;
                for (let i = 0; i < lim; i += 2) {
                    const bx = ptsB_xy[i], by = ptsB_xy[i + 1];
                    const rx = c * bx - s * by;
                    const ry = s * bx + c * by;
                    const samp = this._sampleDT(grid, rx + x, ry + y);
                    if (!samp.valid) continue;
                    const d = samp.d;
                    if (d >= truncCut) continue;
                    let w;
                    if (lossMode === 'tukey') {
                        if (d >= lossK) continue;
                        const u = d * invK;
                        const t = 1.0 - u * u;
                        w = t * t;
                    } else {
                        w = d <= lossK ? 1.0 : (lossK / Math.max(d, 1e-4));
                    }
                    active++;
                    const j0 = samp.gx;
                    const j1 = samp.gy;
                    const j2 = samp.gx * (-ry) + samp.gy * rx;
                    g[0] += w * d * j0; g[1] += w * d * j1; g[2] += w * d * j2;
                    H[0] += w * j0 * j0; H[1] += w * j0 * j1; H[2] += w * j0 * j2;
                    H[4] += w * j1 * j1; H[5] += w * j1 * j2; H[8] += w * j2 * j2;
                }
                if (active < 40) break;
                H[3] = H[1]; H[6] = H[2]; H[7] = H[5];
                H[0] += 1e-2; H[4] += 1e-2; H[8] += 1e-2;
                lastH = H;
                const step = this._solve3x3(H, g);
                if (!step) break;
                const sLen = Math.hypot(step[0], step[1]);
                const scale = sLen > 0.6 ? (0.6 / sLen) : 1.0;
                x += step[0] * scale;
                y += step[1] * scale;
                r = this.wrapAngle(r + Math.max(-0.08, Math.min(0.08, step[2])));
                if (sLen < 2e-3 && Math.abs(step[2]) < 5e-4) break;
            }
            return { tx: x, ty: y, th: r, H: lastH };
        };

        const evalCostAndStats = (grid, maxFloats, x, y, r, lossK = 0.45) => {
            const c = Math.cos(r), s = Math.sin(r);
            const lim = Math.min(ptsB_xy.length, maxFloats);
            let inliers = 0, used = 0, lossSum = 0;
            const kSq = lossK * lossK;
            for (let i = 0; i < lim; i += 2) {
                const bx = ptsB_xy[i], by = ptsB_xy[i + 1];
                const px = c * bx - s * by + x;
                const py = s * bx + c * by + y;
                const sp = this._sampleDT(grid, px, py);
                if (!sp.valid) continue;
                used++;
                const d = sp.d;
                if (d <= 0.35) inliers++;
                lossSum += d <= lossK ? (0.5 * d * d) : (lossK * d - 0.5 * kSq);
            }
            return {
                inlierFrac: used > 0 ? inliers / used : 0,
                meanCost: used >= 80 ? (lossSum / used) : 1e9,
                used
            };
        };

        const searchCoarseL0 = (cTx, cTy, cTh, wideMode) => {
            // wideMode: 0 = hẹp quanh seed, 1 = rộng 1 frame (±4.5m, ±10°), 2 = cực rộng 2+ frame (±8.25m, ±3m, ±25°)
            const n0 = Math.min(wideMode === 2 ? 360 : 480, nPts);
            const deg = Math.PI / 180;
            const dthList = wideMode === 2
                ? [-25, -20, -15, -10, -5, 0, 5, 10, 15, 20, 25]
                : (wideMode === 1
                    ? [-10, -7.5, -5, -2.5, 0, 2.5, 5, 7.5, 10]
                    : [-6, -4, -2, 0, 2, 4, 6]);
            const dxMin = wideMode === 2 ? -8.25 : (wideMode === 1 ? -4.5 : -2.0);
            const dxMax = wideMode === 2 ? 8.30 : (wideMode === 1 ? 4.55 : 2.05);
            const dyMin = wideMode === 2 ? -3.0 : (wideMode === 1 ? -1.5 : -1.0);
            const dyMax = wideMode === 2 ? 3.05 : (wideMode === 1 ? 1.55 : 1.05);
            const stepXY = wideMode === 2 ? 0.75 : 0.5;

            const nGrid = g0.n, dt = g0.dt, invC = 1.0 / g0.cell, half = g0.half;
            const rotX = new Float32Array(n0), rotY = new Float32Array(n0);
            const hits = [];

            for (let ai = 0; ai < dthList.length; ai++) {
                const th = this.wrapAngle(cTh + dthList[ai] * deg);
                const c = Math.cos(th), s = Math.sin(th);
                for (let k = 0; k < n0; k++) {
                    const bx = ptsB_xy[k << 1], by = ptsB_xy[(k << 1) + 1];
                    rotX[k] = c * bx - s * by;
                    rotY[k] = s * bx + c * by;
                }
                for (let ddx = dxMin; ddx <= dxMax; ddx += stepXY) {
                    const ttx = cTx + ddx;
                    for (let ddy = dyMin; ddy <= dyMax; ddy += stepXY) {
                        const tty = cTy + ddy;
                        let score = 0, valid = 0;
                        for (let k = 0; k < n0; k++) {
                            const ix = ((rotX[k] + ttx + half) * invC) | 0;
                            if (ix < 0 || ix >= nGrid) continue;
                            const iy = ((rotY[k] + tty + half) * invC) | 0;
                            if (iy < 0 || iy >= nGrid) continue;
                            valid++;
                            const d = dt[iy * nGrid + ix];
                            if (d < 2.2) score += (2.2 - d);
                        }
                        if (valid >= n0 * 0.35) {
                            hits.push({ tx: ttx, ty: tty, th, score: score / valid });
                        }
                    }
                }
            }
            hits.sort((a, b) => b.score - a.score);
            const peaks = [];
            for (let i = 0; i < hits.length && peaks.length < 3; i++) {
                const h = hits[i];
                let far = true;
                for (let j = 0; j < peaks.length; j++) {
                    const p = peaks[j];
                    if (Math.hypot(h.tx - p.tx, h.ty - p.ty) < 1.0 &&
                        Math.abs(this.wrapAngle(h.th - p.th)) < 4 * deg) {
                        far = false; break;
                    }
                }
                if (far) peaks.push({ tx: h.tx, ty: h.ty, th: h.th });
            }
            return peaks;
        };

        const runMultiStage = (wideMode) => {
            const cands = [];
            const pushCand = (p) => {
                if (!p) return;
                for (let i = 0; i < cands.length; i++) {
                    if (Math.hypot(cands[i].tx - p.tx, cands[i].ty - p.ty) < 0.25 &&
                        Math.abs(this.wrapAngle(cands[i].th - p.th)) < 0.017) return;
                }
                cands.push({ tx: p.tx, ty: p.ty, th: this.wrapAngle(p.th) });
            };

            pushCand({ tx: tx0, ty: ty0, th: th0 });
            if (opts && opts.eBox && opts.eBox.ok) pushCand(opts.eBox);
            const peaks = searchCoarseL0(tx0, ty0, th0, wideMode);
            for (let i = 0; i < peaks.length; i++) pushCand(peaks[i]);

            // Stage L1: 1400 pts trên lưới 0.5m
            const l1Res = [];
            const l1Lim = Math.min(ptsB_xy.length, 2800);
            for (let i = 0; i < cands.length; i++) {
                const c = cands[i];
                const r1 = runGN(g1, l1Lim, c.tx, c.ty, c.th, 8, 2.8, 'huber', 0.60);
                const st1 = evalCostAndStats(g1, l1Lim, r1.tx, r1.ty, r1.th, 0.55);
                l1Res.push({ tx: r1.tx, ty: r1.ty, th: r1.th, meanCost: st1.meanCost, inlierFrac: st1.inlierFrac });
            }
            l1Res.sort((a, b) => a.meanCost - b.meanCost);

            // Chọn Top-2 phân biệt cho Stage L2
            const top2 = [];
            for (let i = 0; i < l1Res.length && top2.length < 2; i++) {
                const cur = l1Res[i];
                if (top2.length === 0 ||
                    Math.hypot(cur.tx - top2[0].tx, cur.ty - top2[0].ty) >= 0.20 ||
                    Math.abs(this.wrapAngle(cur.th - top2[0].th)) >= 0.015) {
                    top2.push(cur);
                }
            }

            // Stage L2: tới 2800 pts trên lưới 0.25m, giảm dần truncation -> Tukey
            const l2Lim = Math.min(ptsB_xy.length, 5600);
            const l2Finals = [];
            for (let i = 0; i < top2.length; i++) {
                const s = top2[i];
                const a = runGN(g2, l2Lim, s.tx, s.ty, s.th, 8, Math.min(1.8, g2.trunc - 0.05), 'huber', 0.45);
                const b = runGN(g2, l2Lim, a.tx, a.ty, a.th, 6, 0.90, 'huber', 0.35);
                // Kiểm tra trước số điểm hợp lệ cho Tukey để tránh suy biến
                const preTukey = evalCostAndStats(g2, l2Lim, b.tx, b.ty, b.th, 0.35);
                const useTukey = preTukey.used >= 200 && preTukey.inlierFrac >= 0.20;
                const c = useTukey
                    ? runGN(g2, l2Lim, b.tx, b.ty, b.th, 6, 0.60, 'tukey', 0.50)
                    : runGN(g2, l2Lim, b.tx, b.ty, b.th, 4, 0.65, 'huber', 0.30);
                // Tính Hessian ổn định và stats cuối cùng trên toàn bộ queryXY
                const finalG = runGN(g2, l2Lim, c.tx, c.ty, c.th, 1, 0.65, 'huber', 0.35);
                const st2 = evalCostAndStats(g2, l2Lim, finalG.tx, finalG.ty, finalG.th, 0.40);
                l2Finals.push({
                    tx: finalG.tx, ty: finalG.ty, th: finalG.th,
                    H: finalG.H,
                    inlierFrac: st2.inlierFrac,
                    meanCost: st2.meanCost,
                    used: st2.used
                });
            }
            l2Finals.sort((a, b) => a.meanCost - b.meanCost);
            return l2Finals;
        };

        let finals = runMultiStage(hasSeed ? 0 : 1);
        let best = finals[0];

        // Tự động mở rộng tìm kiếm rộng nếu có seed hẹp mà khớp kém (< 0.40)
        if (hasSeed && (!best || best.inlierFrac < 0.40)) {
            const wideFinals = runMultiStage(1);
            if (wideFinals[0] && (!best || wideFinals[0].inlierFrac > best.inlierFrac + 0.03 ||
                (wideFinals[0].inlierFrac >= best.inlierFrac - 0.01 && wideFinals[0].meanCost < best.meanCost))) {
                finals = wideFinals;
                best = finals[0];
            }
        }

        // Cứu hộ cực rộng (cầu nối 2+ frame hoặc cua gắt > 10° / > 4.5m): chỉ chạy khi vẫn khớp kém (< 0.50)
        if (!best || best.inlierFrac < 0.50) {
            const superFinals = runMultiStage(2);
            if (superFinals[0] && (!best || superFinals[0].inlierFrac > best.inlierFrac + 0.03 ||
                (superFinals[0].inlierFrac >= best.inlierFrac - 0.01 && superFinals[0].meanCost < best.meanCost))) {
                finals = superFinals;
                best = finals[0];
            }
        }

        if (!best) {
            return { tx: tx0, ty: ty0, th: th0, inlierFrac: 0, ok: false };
        }

        // Kiểm tra mơ hồ (ambiguity): nếu nhánh thứ 2 tách > 0.30m hoặc > 1° mà cost chỉ kém <= 10%
        let ambiguous = false;
        if (finals.length >= 2) {
            const alt = finals[1];
            const distSep = Math.hypot(alt.tx - best.tx, alt.ty - best.ty);
            const angSep = Math.abs(this.wrapAngle(alt.th - best.th));
            if ((distSep > 0.30 || angSep > Math.PI / 180) && alt.meanCost <= best.meanCost * 1.10) {
                ambiguous = true;
                const prior = (opts && opts.eBox && opts.eBox.ok) ? opts.eBox : (hasSeed ? { tx: tx0, ty: ty0, th: th0 } : null);
                if (prior) {
                    const dBest = Math.hypot(best.tx - prior.tx, best.ty - prior.ty) + 2.0 * Math.abs(this.wrapAngle(best.th - prior.th));
                    const dAlt = Math.hypot(alt.tx - prior.tx, alt.ty - prior.ty) + 2.0 * Math.abs(this.wrapAngle(alt.th - prior.th));
                    if (dAlt < dBest && alt.inlierFrac >= best.inlierFrac - 0.05) {
                        best = alt;
                    }
                }
            }
        }

        // Kiểm tra suy biến hành lang theo tỉ số trace/det phần tịnh tiến 2x2
        const h00 = best.H[0], h01 = best.H[1], h11 = best.H[4];
        const tr2 = h00 + h11;
        const det2 = h00 * h11 - h01 * h01;
        const disc = Math.sqrt(Math.max(0, tr2 * tr2 - 4 * det2));
        const lMax = 0.5 * (tr2 + disc), lMin = 0.5 * (tr2 - disc);
        const condRatio = lMax > 1e-6 ? (lMin / lMax) : 0;

        return {
            tx: best.tx, ty: best.ty, th: best.th,
            inlierFrac: best.inlierFrac,
            H: best.H,
            condRatio,
            ambiguous,
            ok: best.used >= 80 && best.inlierFrac >= 0.25
        };
    }

    static hopNhatEgo(egoBox, egoLidar) {
        if (!egoLidar || !egoLidar.ok) return egoBox;
        if (!egoBox || !egoBox.ok) {
            return { tx: egoLidar.tx, ty: egoLidar.ty, th: egoLidar.th, conf: Math.min(0.95, 0.4 + 0.6 * egoLidar.inlierFrac), ok: true, nguon: 'lidar' };
        }
        // Khi LiDAR khỏe & không suy biến hành lang -> kết hợp information fusion với độ ưu tiên LiDAR theo condRatio
        const dxDiff = Math.hypot(egoLidar.tx - egoBox.tx, egoLidar.ty - egoBox.ty);
        const dthDiff = Math.abs(this.wrapAngle(egoLidar.th - egoBox.th));
        if (egoLidar.condRatio >= 0.04 && egoLidar.inlierFrac >= 0.38) {
            // Nếu box ít inlier (<=2) hoặc lệch nhẹ -> tin LiDAR; ngược lại hòa nhẹ tránh nhảy
            const wB = (egoBox.nInl >= 4 && dxDiff < 0.8 && dthDiff < 0.08) ? 0.20 : 0.05;
            return {
                tx: (1 - wB) * egoLidar.tx + wB * egoBox.tx,
                ty: (1 - wB) * egoLidar.ty + wB * egoBox.ty,
                th: this.wrapAngle(egoLidar.th + wB * this.wrapAngle(egoBox.th - egoLidar.th)),
                conf: Math.min(0.98, 0.5 + 0.5 * egoLidar.inlierFrac),
                ok: true,
                nguon: 'fusion'
            };
        }
        // Suy biến hành lang: hợp nhất theo Hessian 3x3
        const invC = [
            1.0 / Math.max(1e-3, egoBox.cov ? egoBox.cov[0] : 0.2),
            1.0 / Math.max(1e-3, egoBox.cov ? egoBox.cov[1] : 0.2),
            1.0 / Math.max(1e-4, egoBox.cov ? egoBox.cov[2] : 0.02)
        ];
        // Scale H_lidar tương đương 1/(0.08^2) độ phân giải chuẩn
        const sL = 0.05;
        const HL = egoLidar.H;
        const Hsum = [
            HL[0] * sL + invC[0], HL[1] * sL, HL[2] * sL,
            HL[3] * sL, HL[4] * sL + invC[1], HL[5] * sL,
            HL[6] * sL, HL[7] * sL, HL[8] * sL + invC[2]
        ];
        const rhs = [
            -(HL[0] * sL * egoLidar.tx + HL[1] * sL * egoLidar.ty + HL[2] * sL * egoLidar.th + invC[0] * egoBox.tx),
            -(HL[3] * sL * egoLidar.tx + HL[4] * sL * egoLidar.ty + HL[5] * sL * egoLidar.th + invC[1] * egoBox.ty),
            -(HL[6] * sL * egoLidar.tx + HL[7] * sL * egoLidar.ty + HL[8] * sL * egoLidar.th + invC[2] * egoBox.th)
        ];
        const sol = this._solve3x3(Hsum, rhs);
        if (!sol) return egoBox;
        return { tx: sol[0], ty: sol[1], th: this.wrapAngle(sol[2]), conf: Math.max(egoBox.conf, 0.65), ok: true, nguon: 'info_fusion' };
    }

    // =========================================================================
    // STEP 3: BỘ ĐỆM ĐỒ THỊ EGO SE(2) THEO JOB + DIJKSTRA
    // =========================================================================
    static taoBoDemEgo(layPtsFn, allTracks, opts = {}) {
        const edgeCache = new Map();
        const dtGridCache = new Map();
        const staticPtsCache = new Map();

        const getStaticPts = (fn) => {
            if (staticPtsCache.has(fn)) return staticPtsCache.get(fn);
            const raw = typeof layPtsFn === 'function' ? layPtsFn(fn) : null;
            if (!raw || raw.length < 30) { staticPtsCache.set(fn, null); return null; }
            // Lọc sơ bộ các box có mặt ở frame này (chủ yếu loại xe lớn đang chạy gây nhiễu)
            const dynBoxes = [];
            if (Array.isArray(allTracks)) {
                for (let i = 0; i < allTracks.length; i++) {
                    const p = this._layShapeTrongTrack(allTracks[i], fn);
                    if (p) dynBoxes.push(p);
                }
            }
            const sPts = this.trichDiemTinhBEV(raw, dynBoxes, { traDayDu: true });
            const validPts = (sPts && sPts.queryXY && sPts.queryXY.length >= 300) ? sPts : null;
            if (staticPtsCache.size > 48) staticPtsCache.delete(staticPtsCache.keys().next().value);
            staticPtsCache.set(fn, validPts);
            return validPts;
        };

        const getDTGrid = (fn) => {
            if (dtGridCache.has(fn)) return dtGridCache.get(fn);
            const sPts = getStaticPts(fn);
            if (!sPts || !sPts.allXY || sPts.allXY.length < 300) { dtGridCache.set(fn, null); return null; }
            const g = this.dungLuoiDaTang(sPts.allXY);
            if (dtGridCache.size > this.CAU_HINH.maxDtLuoiCache) {
                dtGridCache.delete(dtGridCache.keys().next().value);
            }
            dtGridCache.set(fn, g);
            return g;
        };

        const getVelocitySeed = (fA, fB) => {
            const step = fB - fA;
            const lookup = (pA, pB) => {
                const k1 = `${pA}>${pB}`;
                if (edgeCache.has(k1)) {
                    const e = edgeCache.get(k1);
                    return (e && e.ok && (e.conf ?? 0.5) >= 0.45) ? e : null;
                }
                const k2 = `${pB}>${pA}`;
                if (edgeCache.has(k2)) {
                    const e = edgeCache.get(k2);
                    return (e && e.ok && (e.conf ?? 0.5) >= 0.45) ? this.invertSE2(e) : null;
                }
                return null;
            };
            const adj = lookup(fA - step, fB - step) || lookup(fA + step, fB + step);
            if (adj) return adj;
            if (Math.abs(step) === 2) {
                const dir = step > 0 ? 1 : -1;
                const eA = lookup(fA, fA + dir);
                const eB = lookup(fA + dir, fB);
                if (eA && eB) return this.composeSE2(eA, eB);
                const e1 = eA || eB;
                if (e1) return this.composeSE2(e1, e1);
            }
            return null;
        };

        const getEdge = (fA, fB) => {
            if (fA === fB) return { tx: 0, ty: 0, th: 0, conf: 1, ok: true };
            const key = `${fA}>${fB}`;
            if (edgeCache.has(key)) return edgeCache.get(key);
            const revKey = `${fB}>${fA}`;
            if (edgeCache.has(revKey)) {
                const inv = this.invertSE2(edgeCache.get(revKey));
                edgeCache.set(key, inv);
                return inv;
            }
            const eBox = this.uocLuongEgoTuHop(fA, fB, allTracks, opts);
            let eFinal = eBox;
            if (!opts.tatLidarEgo) {
                const gridA = getDTGrid(fA);
                const ptsB = getStaticPts(fB);
                if (gridA && ptsB && ptsB.queryXY && ptsB.queryXY.length >= 300) {
                    const vSeed = getVelocitySeed(fA, fB);
                    const initSeed = vSeed || (eBox.ok ? eBox : { tx: 0, ty: 0, th: 0 });
                    const eLid = this.canChinhEgoLidarBEV(gridA, ptsB.queryXY, initSeed, {
                        hasSeed: Boolean(vSeed || eBox.ok),
                        eBox: eBox.ok ? eBox : null
                    });
                    eFinal = this.hopNhatEgo(eBox, eLid);
                }
            }
            if (edgeCache.size > this.CAU_HINH.maxEgoCacheEdges) edgeCache.clear();
            edgeCache.set(key, eFinal);
            return eFinal;
        };

        const layEgo = (fFrom, fTo) => {
            if (fFrom === fTo) return { tx: 0, ty: 0, th: 0, conf: 1, ok: true };
            const dir = fFrom < fTo ? 1 : -1;
            const span = Math.abs(fTo - fFrom);
            if (span === 1) return getEdge(fTo, fFrom); // p_to = T * p_from => lấy fB=fFrom -> fA=fTo

            // Chuỗi Dijkstra đơn giản trên dải [minF, maxF] cho phép bước nhảy 1 hoặc 2 (bắc cầu nếu thiếu frame giữa)
            const distMap = new Map();
            const prevMap = new Map();
            const seMap = new Map();
            const visited = new Set();
            distMap.set(fFrom, 0);

            const nodes = [];
            for (let f = fFrom; dir > 0 ? f <= fTo : f >= fTo; f += dir) nodes.push(f);
            if (nodes.length > 35) return getEdge(fTo, fFrom); // Quá xa: khớp trực tiếp hoặc fallback

            while (true) {
                let u = null, bestD = Infinity;
                for (let i = 0; i < nodes.length; i++) {
                    const nd = nodes[i];
                    if (!visited.has(nd) && (distMap.get(nd) ?? Infinity) < bestD) {
                        bestD = distMap.get(nd); u = nd;
                    }
                }
                if (u === null || u === fTo) break;
                visited.add(u);

                for (let step = 1; step <= 2; step++) {
                    const v = u + dir * step;
                    if (dir > 0 ? v > fTo : v < fTo) continue;
                    const e = getEdge(v, u); // ánh xạ điểm từ u -> v
                    const cost = e.ok ? (step / Math.max(0.15, e.conf)) : 50.0;
                    const cand = bestD + cost;
                    if (cand < (distMap.get(v) ?? Infinity)) {
                        distMap.set(v, cand);
                        prevMap.set(v, u);
                        seMap.set(`${u}>${v}`, e);
                    }
                }
            }

            if (!prevMap.has(fTo)) return getEdge(fTo, fFrom);
            const pathEdges = [];
            let cur = fTo;
            while (cur !== fFrom) {
                const p = prevMap.get(cur);
                pathEdges.push(seMap.get(`${p}>${cur}`));
                cur = p;
            }
            // pathEdges đang đi ngược từ fTo -> fFrom; ghép từ đầu đến cuối
            let acc = { tx: 0, ty: 0, th: 0, conf: 1, ok: true };
            for (let i = pathEdges.length - 1; i >= 0; i--) {
                acc = this.composeSE2(pathEdges[i], acc);
            }
            return acc;
        };

        return { layEgo, getEdge };
    }

    // =========================================================================
    // STEP 4: QUY VỀ KHUNG NEO, LOẠI NHIỄU LEAVE-ONE-OUT & PHÂN LOẠI CHUYỂN ĐỘNG
    // =========================================================================
    static quyVeKhungNeo(refData, refFrames, egoCache, fAnchor) {
        const samples = [];
        for (let i = 0; i < refFrames.length; i++) {
            const f = refFrames[i];
            const raw = refData[f];
            if (!raw || raw.length < 9) continue;
            const ego = egoCache ? egoCache.layEgo(f, fAnchor) : { tx: 0, ty: 0, th: 0, conf: 1, ok: true };
            const mapped = this.applySE2([raw[0], raw[1], raw[5] || 0], ego);
            samples.push({
                f,
                x: mapped[0], y: mapped[1], z: raw[2],
                rx: raw[3] || 0, ry: raw[4] || 0,
                yaw: mapped[2],
                L: raw[6], W: raw[7], H: raw[8],
                w: Math.max(0.2, ego ? (ego.conf ?? 0.8) : 0.8),
                bad: false
            });
        }
        // Unwrap yaw liên tục qua các mẫu
        if (samples.length > 0) {
            let curY = samples[0].yaw;
            samples[0].yawUnwrap = curY;
            for (let i = 1; i < samples.length; i++) {
                let dA = this.wrapAngle(samples[i].yaw - curY);
                const altA = this.wrapAngle(samples[i].yaw + Math.PI - curY);
                if (Math.abs(altA) < Math.abs(dA) && Math.abs(dA) > 2.2) dA = altA;
                curY += dA;
                samples[i].yawUnwrap = curY;
            }
        }
        return samples;
    }

    static _theilSen1D(ts, ys) {
        const slopes = [];
        for (let i = 0; i < ts.length; i++) {
            for (let j = i + 1; j < ts.length; j++) {
                const dt = ts[j] - ts[i];
                if (Math.abs(dt) >= 1) slopes.push((ys[j] - ys[i]) / dt);
            }
        }
        const m = slopes.length > 0 ? this._median(slopes) : 0;
        const ints = ts.map((t, i) => ys[i] - m * t);
        const b = ints.length > 0 ? this._median(ints) : 0;
        return { m, b };
    }

    static loaiMauNhieu(samples) {
        const n = samples.length;
        if (n < 4) {
            return { samples, sigmaXY: 0.12, sigmaYaw: 0.15 };
        }
        const ts = samples.map(s => s.f);
        const xs = samples.map(s => s.x);
        const ys = samples.map(s => s.y);
        const zs = samples.map(s => s.z);

        // Leave-one-out Theil-Sen để phát hiện mẫu prelabel nhảy bậy (như Track #16 F3..6)
        const resPos = new Array(n).fill(0);
        const resZ = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
            const oT = [], oX = [], oY = [], oZ = [];
            for (let j = 0; j < n; j++) {
                if (j === i) continue;
                oT.push(ts[j]); oX.push(xs[j]); oY.push(ys[j]); oZ.push(zs[j]);
            }
            const fx = this._theilSen1D(oT, oX);
            const fy = this._theilSen1D(oT, oY);
            const fz = this._theilSen1D(oT, oZ);
            resPos[i] = Math.hypot(xs[i] - (fx.m * ts[i] + fx.b), ys[i] - (fy.m * ts[i] + fy.b));
            resZ[i] = Math.abs(zs[i] - (fz.m * ts[i] + fz.b));
        }

        const madPos = Math.max(0.06, 1.4826 * this._median(resPos));
        const posThresh = Math.max(0.45, 3.5 * madPos + 0.18);
        const medYaw = this._circularMedian(samples.map(s => s.yaw), true);

        let cleanCount = 0;
        for (let i = 0; i < n; i++) {
            const dYaw = Math.min(
                Math.abs(this.wrapAngle(samples[i].yaw - medYaw)),
                Math.abs(this.wrapAngle(samples[i].yaw + Math.PI - medYaw))
            );
            // Đánh dấu mẫu nhiễu nếu lệch vị trí bất thường, hoặc Z nhảy > 0.6m, hoặc Yaw văng > 40° (chỉ khi đã đủ mẫu khác)
            if (resPos[i] > posThresh || resZ[i] > 0.60 || dYaw > 0.70) {
                samples[i].bad = true;
            } else {
                cleanCount++;
            }
        }
        // Bảo đảm giữ ít nhất 2 mẫu tốt nhất nếu bị lọc quá tay
        if (cleanCount < 2) {
            const idxOrder = samples.map((_, i) => i).sort((a, b) => resPos[a] - resPos[b]);
            for (const s of samples) s.bad = true;
            samples[idxOrder[0]].bad = false;
            samples[idxOrder[1]].bad = false;
        }
        return { samples, sigmaXY: madPos, sigmaYaw: 0.12 };
    }

    static phanLoaiChuyenDong(samples, sigmaXY = 0.12) {
        const clean = samples.filter(s => !s.bad);
        if (clean.length < 2) return { loai: 'do', v: 0, vx: 0, vy: 0, sigmaV: 0.1, dung: true };

        const ts = clean.map(s => s.f);
        const fx = this._theilSen1D(ts, clean.map(s => s.x));
        const fy = this._theilSen1D(ts, clean.map(s => s.y));
        const speed = Math.hypot(fx.m, fy.m);
        const span = Math.max(1, ts[ts.length - 1] - ts[0]);

        // Residual độ dịch dọc trục
        const resArr = clean.map((s, i) => Math.hypot(s.x - (fx.m * s.f + fx.b), s.y - (fy.m * s.f + fy.b)));
        const sigPos = Math.max(0.05, 1.4826 * this._median(resArr), sigmaXY);
        const totalDisp = speed * span;

        // Kiểm tra hướng chạy có khớp với trục dọc thân xe (yaw mod π) không -> chặn nhiễu dịch ngang
        const medYaw = this._circularMedian(clean.map(s => s.yaw), true);
        let dirMatch = 1.0;
        if (speed > 0.02) {
            const moveAng = Math.atan2(fy.m, fx.m);
            const diffModPi = Math.min(
                Math.abs(this.wrapAngle(moveAng - medYaw)),
                Math.abs(this.wrapAngle(moveAng - (medYaw + Math.PI)))
            );
            dirMatch = Math.cos(diffModPi); // < 0.42 ~ lệch > 65°
        }

        // Bỏ bẫy 0.40 m/frame: xe đỗ khi tổng độ dịch qua cả span không vượt 3*sigma (tối thiểu 0.22m),
        // HOẶC dịch ngang vô lý (dirMatch < 0.40) với tốc độ rất nhỏ (< 0.15 m/frame)
        const dung = (totalDisp < Math.max(3.0 * sigPos, 0.24)) || (dirMatch < 0.40 && speed < 0.15);
        const loai = dung ? 'do' : (speed < 0.45 ? 'cham' : 'nhanh');
        return { loai, v: speed, vx: fx.m, vy: fy.m, sigmaV: sigPos / Math.max(1, span * 0.5), dung, sigPos };
    }

    // =========================================================================
    // STEP 5: KHỚP ĐỘNG HỌC BỀN (HUBER CV + CTRV CUNG TRÒN + AN TOÀN NGOẠI SUY)
    // =========================================================================
    static khopMoHinhChuyenDong(samples, phanLoai, fAnchor) {
        const clean = samples.filter(s => !s.bad);
        const anchorS = clean.reduce((b, c) => (Math.abs(c.f - fAnchor) < Math.abs(b.f - fAnchor) ? c : b), clean[0]);

        if (phanLoai.dung || clean.length < 2) {
            const near = [...clean].sort((a, b) => Math.abs(a.f - fAnchor) - Math.abs(b.f - fAnchor)).slice(0, 3);
            const ws = near.map(s => s.w);
            return {
                mo: 'tinh',
                p: {
                    x0: this._weightedMedian(near.map(s => s.x), ws),
                    y0: this._weightedMedian(near.map(s => s.y), ws),
                    th0: this._circularMedian(near.map(s => s.yaw), false),
                    v: 0, om: 0, vx: 0, vy: 0, t0: fAnchor
                },
                sigma: Math.max(0.08, phanLoai.sigPos || 0.10),
                sigmaV: 0.03,
                span: 1
            };
        }

        const t0 = anchorS.f;
        const ts = clean.map(s => s.f - t0);
        const xs = clean.map(s => s.x);
        const ys = clean.map(s => s.y);
        const span = Math.max(1, Math.max(...ts) - Math.min(...ts));

        // 1. IRLS Huber CV (3 vòng) khởi tạo từ Theil-Sen
        let vx = phanLoai.vx, vy = phanLoai.vy;
        let x0 = anchorS.x, y0 = anchorS.y;
        const huberC = 0.35;
        for (let it = 0; it < 3; it++) {
            let sw = 0, st = 0, sx = 0, sy = 0;
            const wArr = new Array(clean.length);
            for (let i = 0; i < clean.length; i++) {
                const r = Math.hypot(xs[i] - (x0 + vx * ts[i]), ys[i] - (y0 + vy * ts[i]));
                const rw = r <= huberC ? 1.0 : (huberC / Math.max(r, 1e-4));
                const timeDecay = Math.exp(-0.18 * Math.abs(ts[i]));
                const wi = clean[i].w * rw * timeDecay;
                wArr[i] = wi;
                sw += wi; st += wi * ts[i]; sx += wi * xs[i]; sy += wi * ys[i];
            }
            const mt = st / sw, mx = sx / sw, my = sy / sw;
            let den = 0, nx = 0, ny = 0;
            for (let i = 0; i < clean.length; i++) {
                const d = ts[i] - mt;
                den += wArr[i] * d * d;
                nx += wArr[i] * d * (xs[i] - mx);
                ny += wArr[i] * d * (ys[i] - my);
            }
            if (den > 1e-6) { vx = nx / den; vy = ny / den; }
            x0 = mx - vx * mt;
            y0 = my - vy * mt;
        }

        const cvSpeed = Math.hypot(vx, vy);
        // Cận vận tốc thích ứng từ dữ liệu (không kẹp 1.8 m/frame!)
        const pairSpeeds = [];
        for (let i = 1; i < clean.length; i++) {
            const dt = clean[i].f - clean[i - 1].f;
            if (dt > 0) pairSpeeds.push(Math.hypot(clean[i].x - clean[i - 1].x, clean[i].y - clean[i - 1].y) / dt);
        }
        const vObsMax = pairSpeeds.length > 0 ? Math.max(...pairSpeeds, cvSpeed) : cvSpeed;
        const vCap = Math.min(8.0, Math.max(2.5, 1.5 * vObsMax + 0.4));
        if (cvSpeed > vCap) {
            const fScale = vCap / cvSpeed;
            vx *= fScale; vy *= fScale;
        }

        let cvResSq = 0;
        const cvResList = [];
        for (let i = 0; i < clean.length; i++) {
            const err = Math.hypot(xs[i] - (x0 + vx * ts[i]), ys[i] - (y0 + vy * ts[i]));
            cvResSq += err * err;
            cvResList.push(err);
        }
        const sigmaCV = Math.max(0.06, 1.4826 * this._median(cvResList));

        // 2. Xác định hướng chuyển động so với yaw xe (lái tiến hay lùi, khử flip 180°)
        const moveHeading = Math.atan2(vy, vx);
        const yawAnchor = anchorS.yaw;
        const isReverse = Math.abs(this.wrapAngle(moveHeading - yawAnchor)) > Math.PI * 0.5;
        const thStart = isReverse ? this.wrapAngle(moveHeading) : moveHeading;

        // Ước lượng tốc độ góc ω từ chuỗi yaw sạch
        const yawFit = this._theilSen1D(ts, clean.map(s => s.yawUnwrap));
        let om = Math.max(-0.22, Math.min(0.22, yawFit.m));
        if (Math.abs(om) < 0.008) om = 0;

        let chosenMo = 'CV';
        let bestCTRV = null;
        // Chỉ xét CTRV nếu góc cua tích lũy > 3.5° và xe thực sự đang chạy
        if (clean.length >= 4 && Math.abs(om) * span > 0.06 && cvSpeed >= 0.20) {
            let cx0 = anchorS.x, cy0 = anchorS.y, cth = moveHeading, cv = Math.min(cvSpeed, vCap), com = om;
            const evalCTRV = (px, py, pth, pv, pom, t) => {
                if (Math.abs(pom) < 1e-4) return [px + pv * Math.cos(pth) * t, py + pv * Math.sin(pth) * t];
                return [
                    px + (pv / pom) * (Math.sin(pth + pom * t) - Math.sin(pth)),
                    py + (pv / pom) * (-Math.cos(pth + pom * t) + Math.cos(pth))
                ];
            };
            // Gauss-Newton nhẹ 5 vòng tinh chỉnh (px, py, pv, pom)
            for (let it = 0; it < 5; it++) {
                let errSum = 0;
                const JTJ = new Array(16).fill(0), JTr = new Array(4).fill(0);
                const eps = [1e-3, 1e-3, 1e-3, 1e-4];
                for (let i = 0; i < clean.length; i++) {
                    const t = ts[i];
                    const p0 = evalCTRV(cx0, cy0, cth, cv, com, t);
                    const rx = xs[i] - p0[0], ry = ys[i] - p0[1];
                    const d = Math.hypot(rx, ry);
                    errSum += d * d;
                    const wi = clean[i].w * (d <= huberC ? 1.0 : huberC / Math.max(d, 1e-4));
                    const par = [cx0, cy0, cv, com];
                    const Jx = [0, 0, 0, 0], Jy = [0, 0, 0, 0];
                    for (let k = 0; k < 4; k++) {
                        const tmp = [...par]; tmp[k] += eps[k];
                        const pk = evalCTRV(tmp[0], tmp[1], cth, tmp[2], tmp[3], t);
                        Jx[k] = (pk[0] - p0[0]) / eps[k];
                        Jy[k] = (pk[1] - p0[1]) / eps[k];
                    }
                    for (let r = 0; r < 4; r++) {
                        JTr[r] += wi * (Jx[r] * rx + Jy[r] * ry);
                        for (let c = 0; c < 4; c++) JTJ[r * 4 + c] += wi * (Jx[r] * Jx[c] + Jy[r] * Jy[c]);
                    }
                }
                for (let d = 0; d < 4; d++) JTJ[d * 4 + d] += 1e-2;
                // Khử Gauss 4x4 đơn giản
                const M = [0, 1, 2, 3].map(r => [JTJ[r * 4], JTJ[r * 4 + 1], JTJ[r * 4 + 2], JTJ[r * 4 + 3], JTr[r]]);
                let ok4 = true;
                for (let col = 0; col < 4; col++) {
                    let piv = col;
                    for (let r = col + 1; r < 4; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
                    if (Math.abs(M[piv][col]) < 1e-9) { ok4 = false; break; }
                    if (piv !== col) { const t = M[col]; M[col] = M[piv]; M[piv] = t; }
                    const inv = 1.0 / M[col][col];
                    for (let j = col; j < 5; j++) M[col][j] *= inv;
                    for (let r = 0; r < 4; r++) {
                        if (r === col) continue;
                        const f = M[r][col];
                        for (let j = col; j < 5; j++) M[r][j] -= f * M[col][j];
                    }
                }
                if (!ok4) break;
                cx0 += Math.max(-0.5, Math.min(0.5, M[0][4]));
                cy0 += Math.max(-0.5, Math.min(0.5, M[1][4]));
                cv = Math.max(0.0, Math.min(vCap, cv + Math.max(-0.5, Math.min(0.5, M[2][4]))));
                com = Math.max(-0.22, Math.min(0.22, com + Math.max(-0.04, Math.min(0.04, M[3][4]))));
            }
            let ctrvSq = 0;
            for (let i = 0; i < clean.length; i++) {
                const p = evalCTRV(cx0, cy0, cth, cv, com, ts[i]);
                ctrvSq += (xs[i] - p[0]) ** 2 + (ys[i] - p[1]) ** 2;
            }
            if (ctrvSq < cvResSq * 0.72) {
                chosenMo = 'CTRV';
                bestCTRV = { x0: cx0, y0: cy0, th0: cth, v: cv, om: com, isReverse, yawAnchor, t0, span };
            }
        }

        if (chosenMo === 'CTRV' && bestCTRV) {
            return { mo: 'CTRV', p: bestCTRV, sigma: sigmaCV * 0.85, sigmaV: Math.max(0.04, phanLoai.sigmaV), span };
        }
        return {
            mo: 'CV',
            p: { x0, y0, vx, vy, th0: thStart, yawAnchor, isReverse, om, t0, span },
            sigma: sigmaCV,
            sigmaV: Math.max(0.04, phanLoai.sigmaV),
            span
        };
    }

    static duDoanTuMoHinh(mh, fTarget) {
        const p = mh.p;
        if (mh.mo === 'tinh') {
            return { x: p.x0, y: p.y0, yaw: p.th0, sigmaXY: mh.sigma, sigmaYaw: 0.08 };
        }
        const dt = fTarget - p.t0;
        const absDt = Math.abs(dt);
        const tau = Math.max(3.0, p.span || 5.0);
        const sigXY = Math.sqrt(mh.sigma * mh.sigma + (mh.sigmaV * absDt) * (mh.sigmaV * absDt));
        const sigYaw = Math.min(0.45, 0.06 + 0.025 * absDt);

        if (mh.mo === 'CTRV') {
            // Suy giảm nhẹ omega khi ngoại suy xa để không tự cuộn vòng tròn vô hạn
            const damp = absDt <= 2 ? 1.0 : Math.exp(-(absDt - 2) / (tau * 1.5));
            const effOm = p.om * damp;
            let dAng = effOm * dt;
            if (Math.abs(dAng) > Math.PI * 0.45) dAng = Math.sign(dAng) * Math.PI * 0.45;
            const effOmCapped = Math.abs(dt) > 1e-3 ? dAng / dt : 0;

            let x, y;
            if (Math.abs(effOmCapped) < 1e-4) {
                x = p.x0 + p.v * Math.cos(p.th0) * dt;
                y = p.y0 + p.v * Math.sin(p.th0) * dt;
            } else {
                x = p.x0 + (p.v / effOmCapped) * (Math.sin(p.th0 + dAng) - Math.sin(p.th0));
                y = p.y0 + (p.v / effOmCapped) * (-Math.cos(p.th0 + dAng) + Math.cos(p.th0));
            }
            const moveDir = this.wrapAngle(p.th0 + dAng);
            const carYaw = p.isReverse ? this.wrapAngle(moveDir + Math.PI) : moveDir;
            return { x, y, yaw: carYaw, sigmaXY: sigXY, sigmaYaw: sigYaw };
        }

        // CV: giữ góc thân xe đồng bộ hướng chuyển động (hoặc +π nếu lùi) + quay nhẹ nếu có ω
        const x = p.x0 + p.vx * dt;
        const y = p.y0 + p.vy * dt;
        let dYaw = (p.om || 0) * dt * Math.exp(-absDt / (tau * 2.0));
        if (Math.abs(dYaw) > Math.PI * 0.35) dYaw = Math.sign(dYaw) * Math.PI * 0.35;
        const baseMoveYaw = p.isReverse ? this.wrapAngle(p.th0 + Math.PI) : p.th0;
        // Pha trộn giữa hướng chuyển động và yawAnchor để xe đi thẳng không lệch yaw
        const diffAnchor = this.wrapAngle(p.yawAnchor - baseMoveYaw);
        const startYaw = (Math.abs(diffAnchor) < 0.35) ? this.wrapAngle(baseMoveYaw + 0.5 * diffAnchor) : p.yawAnchor;
        return { x, y, yaw: this.wrapAngle(startYaw + dYaw), sigmaXY: sigXY, sigmaYaw: sigYaw };
    }

    // =========================================================================
    // STEP 6: TINH CHỈNH LIDAR L-SHAPE ĐÓN TIA + CHỐNG TƯỜNG + HÀNG XÓM + DO-NO-HARM
    // =========================================================================
    static tinhChinhLidarSauDuDoan(pred, ptsTarget, neighborBoxes = [], sig = { xy: 0.4, yaw: 0.12 }, opts = {}) {
        const TT = opts.thuatToanCanChinh || (typeof window !== 'undefined' ? window.thuatToanCanChinh : null);
        if (!TT || !ptsTarget || ptsTarget.length < 15) {
            return { x: pred.x, y: pred.y, yaw: pred.yaw, thanhCong: false, loai: 'giuNguyen' };
        }

        const rXY = Math.max(0.45, Math.min(2.20, 2.5 * (sig.xy || 0.3)));
        const rYaw = Math.max(0.05, Math.min(0.30, 2.2 * (sig.yaw || 0.10)));
        const { x: px, y: py, z: pz, yaw: prz, L, W, H } = pred;

        // Prefilter 1 lần bán kính 25m quanh điểm dự đoán -> tăng tốc 5-8x
        const roiR2 = 25.0 * 25.0;
        const ptsRoi = [];
        for (let i = 0; i < ptsTarget.length; i++) {
            const pt = ptsTarget[i];
            const dx = pt[0] - px, dy = pt[1] - py;
            if (dx * dx + dy * dy <= roiR2) ptsRoi.push(pt);
        }

        // 1. Lọc ngữ cảnh thông minh (chống tường dài RANSAC, chống tường ngắn carScore, lọc OBB hàng xóm)
        let ptsClean = ptsRoi;
        let ctxRes = null;
        if (typeof TT.chonVaLocNguCanhFrame === 'function') {
            ctxRes = TT.chonVaLocNguCanhFrame(ptsRoi, px, py, pz, prz, L, W, H, neighborBoxes, Math.max(1.20, 1.0 + rXY / Math.max(2.0, L)));
            if (ctxRes && ctxRes.ambiguous) {
                return { x: px, y: py, yaw: prz, thanhCong: false, loai: 'giuNguyen_moHo' };
            }
            if (ctxRes && ctxRes.ptsClean) ptsClean = ctxRes.ptsClean;
        }

        // Tâm khởi tạo (cập nhật nhẹ nếu chonVaLocNguCanhFrame cứu khỏi cụm tường/hàng xóm)
        let curX = px, curY = py;
        if (ctxRes && ctxRes.preShiftWorld && Math.hypot(ctxRes.preShiftWorld[0], ctxRes.preShiftWorld[1]) > 0.25 &&
            Math.hypot(ctxRes.preShiftWorld[0], ctxRes.preShiftWorld[1]) <= rXY) {
            curX += ctxRes.preShiftWorld[0];
            curY += ctxRes.preShiftWorld[1];
        }

        // 2. Loại điểm thuộc hàng xóm bằng OBB xoay 2D (thay hình vuông thô bản cũ)
        const filteredPts = [];
        const searchR = Math.max(L, W) * 0.65 + rXY + 0.8;
        const sr2 = searchR * searchR;
        for (let i = 0; i < ptsClean.length; i++) {
            const pt = ptsClean[i];
            const dx = pt[0] - curX, dy = pt[1] - curY;
            if (dx * dx + dy * dy > sr2) continue;
            let inNb = false;
            if (neighborBoxes && neighborBoxes.length > 0) {
                for (let ni = 0; ni < neighborBoxes.length; ni++) {
                    if (this._diemTrongObb(pt[0], pt[1], neighborBoxes[ni], 0.05)) { inNb = true; break; }
                }
            }
            if (!inNb) filteredPts.push(pt);
        }

        const distEgo = Math.hypot(curX, curY);
        const minPtsNeeded = distEgo > 40 ? 6 : (distEgo > 25 ? 10 : 14);
        if (filteredPts.length < minPtsNeeded) {
            return { x: px, y: py, yaw: prz, thanhCong: false, loai: 'giuNguyen_thieuDiem' };
        }

        // 3. Chạy L-shape Slicing (`phanTichLopThanXeChinh` + `tinhDxDyMep`) lặp 2 vòng
        let curYaw = prz;
        const scaleVal = Math.max(1.0, Math.min(1.5, 1.0 + rXY / Math.max(3.5, L)));
        const scanMX = Math.min(1.3, 0.25 + rXY * 0.55);
        const scanMY = Math.min(1.1, 0.18 + rXY * 0.45);

        let lastNPts = 0;
        for (let it = 0; it < 2; it++) {
            const cl = TT.trichXuatDiemThanXeCatLop(
                filteredPts, curX, curY, pz, 0, 0, curYaw,
                L, W, H, true, it === 0 ? scanMX : 0.22, it === 0 ? scanMY : 0.14, false
            );
            lastNPts = cl.xp.length;
            if (lastNPts < minPtsNeeded) break;

            const rotMat = TT.eulerXYZToMatrix(0, 0, curYaw);
            // Ở vòng 0, thử quét nhẹ yaw nếu sig.yaw đáng kể và có đủ điểm
            if (it === 0 && lastNPts >= 25 && rYaw >= 0.07 && typeof TT.quetGocYawToiUu === 'function') {
                const pts2D = [];
                for (let k = 0; k < lastNPts; k++) {
                    if (cl.zp[k] >= -H * 0.30 && cl.zp[k] <= H * 0.35 && Math.abs(cl.xp[k]) <= L * 0.65 && Math.abs(cl.yp[k]) <= W * 0.65) {
                        pts2D.push([cl.xp[k], cl.yp[k]]);
                    }
                }
                if (pts2D.length >= 20) {
                    const dyaw = TT.quetGocYawToiUu(pts2D, L, W, 0.40);
                    if (typeof dyaw === 'number' && !isNaN(dyaw) && Math.abs(dyaw) <= rYaw) {
                        curYaw = this.wrapAngle(curYaw + dyaw);
                    }
                }
            }

            const toSensor = TT.vectorMatMul([-curX, -curY, -pz], rotMat);
            const sx = toSensor[0], sy = toSensor[1], distS = Math.hypot(sx, sy);
            const ptsRel = new Array(lastNPts);
            for (let k = 0; k < lastNPts; k++) ptsRel[k] = [cl.xp[k], cl.yp[k], cl.zp[k]];
            const ana = TT.phanTichLopThanXeChinh(ptsRel, L, W, sx, sy, distS, 0.025, it === 0, scaleVal,
                ctxRes ? { vachCamY: ctxRes.vachCamY, vachCamX: ctxRes.vachCamX } : null);
            const shift = TT.tinhDxDyMep(
                ana.ex0, ana.ex1, ana.ey0, ana.ey1, L, W, sx, sy,
                0.025, true, rXY, ana.bestRearX, ana.bestFrontX, ana.bestFlankY
            );
            const rotFin = TT.eulerXYZToMatrix(0, 0, curYaw);
            const wShift = TT.matVecMul(rotFin, [shift.dx, shift.dy, 0.0]);
            curX += wShift[0];
            curY += wShift[1];
        }

        // 4. Cổng chấp nhận (Do-No-Harm Gate)
        const totalShift = Math.hypot(curX - px, curY - py);
        const totalYawDiff = Math.abs(this.wrapAngle(curYaw - prz));
        if (lastNPts < minPtsNeeded || totalShift > rXY * 1.15 || totalYawDiff > rYaw * 1.15) {
            return { x: px, y: py, yaw: prz, thanhCong: false, loai: 'giuNguyen_vuotBien' };
        }

        // Kiểm tra không va chạm nặng vào hàng xóm (IoA <= 0.35)
        if (neighborBoxes && neighborBoxes.length > 0 && typeof TT.layGocHop2D === 'function') {
            const cRef = TT.layGocHop2D(curX, curY, curYaw, L, W);
            for (let ni = 0; ni < neighborBoxes.length; ni++) {
                const nb = neighborBoxes[ni];
                if (!nb.isVehicle) continue;
                const inter = TT.tinhDienTichGiaoNhau2D(cRef, nb.corners);
                const ioa = inter / Math.max(1e-6, Math.min(L * W, nb.L * nb.W));
                if (ioa > 0.35) {
                    return { x: px, y: py, yaw: prz, thanhCong: false, loai: 'giuNguyen_chamHangXom' };
                }
            }
        }

        // Pha trộn mềm khi thưa điểm để tránh giật
        const blendW = lastNPts / (lastNPts + 12.0);
        return {
            x: px + blendW * (curX - px),
            y: py + blendW * (curY - py),
            yaw: this.wrapAngle(prz + blendW * this.wrapAngle(curYaw - prz)),
            thanhCong: true,
            soDiem: lastNPts,
            dich: totalShift,
            loai: 'lshape'
        };
    }

    // =========================================================================
    // STEP 7: CAO ĐỘ Z & PITCH/ROLL BỀN TRÊN DỐC (TÁCH QUỸ ĐẠO VS MẶT ĐƯỜNG)
    // =========================================================================
    static duDoanZTheoQuyDao(pred, cleanSamples, opts = {}) {
        const samples = Array.isArray(cleanSamples) && cleanSamples.length > 0
            ? cleanSamples
            : [{ f: opts.fTarget ?? 0, z: pred.z, rx: pred.rx || 0, ry: pred.ry || 0 }];
        const anchorS = samples.reduce((b, c) => (Math.abs(c.f - opts.fTarget) < Math.abs(b.f - opts.fTarget) ? c : b), samples[0]);

        const refZMed = this._median(samples.map(s => s.z));
        const refRxMed = this._median(samples.map(s => s.rx || 0));
        const refRyMed = this._median(samples.map(s => s.ry || 0));
        const zNearest = anchorS ? anchorS.z : pred.z;

        let zOut = zNearest;
        if (samples.length >= 3) {
            const ts = samples.map(s => s.f);
            const fz = this._theilSen1D(ts, samples.map(s => s.z));
            const dt = (opts.fTarget ?? anchorS.f) - anchorS.f;
            const dZ = Math.max(-0.025 * Math.abs(dt), Math.min(0.025 * Math.abs(dt), fz.m * dt * Math.exp(-Math.abs(dt) / 4.0)));
            zOut = anchorS.z + dZ;
        } else {
            zOut = 0.7 * zNearest + 0.3 * refZMed;
        }
        return {
            z: zOut,
            rx: refRxMed,
            ry: refRyMed,
            zNearest,
            refRxMed,
            refRyMed,
            nguon: 'quyDao',
            conf: 0.50
        };
    }

    static epZTheoMatDuong(pred, zQuyDaoRes, ptsTarget, opts = {}) {
        const TT = opts.thuatToanCanChinh || (typeof window !== 'undefined' ? window.thuatToanCanChinh : null);
        const zNearest = (zQuyDaoRes && Number.isFinite(zQuyDaoRes.zNearest)) ? zQuyDaoRes.zNearest : pred.z;
        const refRxMed = (zQuyDaoRes && Number.isFinite(zQuyDaoRes.refRxMed)) ? zQuyDaoRes.refRxMed : (pred.rx || 0);
        const refRyMed = (zQuyDaoRes && Number.isFinite(zQuyDaoRes.refRyMed)) ? zQuyDaoRes.refRyMed : (pred.ry || 0);
        const baseZ = (zQuyDaoRes && Number.isFinite(zQuyDaoRes.z)) ? zQuyDaoRes.z : pred.z;

        // Thử fit mặt đất thực từ PCD tại (pred.x, pred.y) bằng canChinhMatDuongHop
        if (TT && typeof TT.canChinhMatDuongHop === 'function' && ptsTarget && ptsTarget.length > 20) {
            const roiPts = [];
            const colZs = [];
            for (let i = 0; i < ptsTarget.length; i++) {
                const pt = ptsTarget[i];
                const d2 = (pt[0] - pred.x) ** 2 + (pt[1] - pred.y) ** 2;
                if (d2 <= 196.0) {
                    roiPts.push(pt);
                    if (d2 <= 25.0 && Math.abs(pt[2] - zNearest) <= 2.2) colZs.push(pt[2]);
                }
            }
            const usePts = roiPts.length >= 15 ? roiPts : ptsTarget;
            const maxDz = Math.max(0.45, 0.25 * Math.abs(opts.dt || 1));

            // Thử 1: Fit trực tiếp quanh zNearest trước (an toàn tuyệt đối khi độ cao gần mốc)
            let roadRes = TT.canChinhMatDuongHop(
                [pred.x, pred.y, zNearest], [refRxMed, refRyMed, pred.yaw],
                [pred.L, pred.W, pred.H], usePts, 0.08,
                opts.neoDuyet ? { neoDuyet: opts.neoDuyet } : null
            );
            let okRoad = roadRes && roadRes.foundPlane && (roadRes.nGroundPts || 0) >= 8 &&
                Number.isFinite(roadRes.newPos?.[2]) && Math.abs(roadRes.newPos[2] - zNearest) <= 0.65;

            // Thử 2 (Fallback khi lệch pitch Ego lớn >0.6m ở xa): tìm sàn cột cục bộ quanh (pred.x, pred.y)
            if (!okRoad && colZs.length >= 20) {
                colZs.sort((a, b) => a - b);
                const gCol = colZs[Math.floor(colZs.length * 0.12)];
                const zCol = gCol + pred.H * 0.5;
                if (Math.abs(zCol - zNearest) > 0.35 && Math.abs(zCol - zNearest) <= Math.min(1.50, maxDz + 0.45)) {
                    const roadRes2 = TT.canChinhMatDuongHop(
                        [pred.x, pred.y, zCol], [refRxMed, refRyMed, pred.yaw],
                        [pred.L, pred.W, pred.H], usePts, 0.08,
                        opts.neoDuyet ? { neoDuyet: opts.neoDuyet } : null
                    );
                    if (roadRes2 && roadRes2.foundPlane && (roadRes2.nGroundPts || 0) >= 12 && Number.isFinite(roadRes2.newPos?.[2])) {
                        roadRes = roadRes2;
                        okRoad = Math.abs(roadRes.newPos[2] - zNearest) <= 1.40;
                    }
                }
            }

            if (okRoad) {
                const newZ = roadRes.newPos[2];
                const nGroundPts = roadRes.nGroundPts || 0;
                return {
                    z: newZ,
                    rx: roadRes.newRot ? roadRes.newRot[0] : refRxMed,
                    ry: roadRes.newRot ? roadRes.newRot[1] : refRyMed,
                    nguon: 'matDuong',
                    conf: 0.90,
                    info: {
                        boQua: false,
                        nDiemDat: nGroundPts,
                        sigma: Number.isFinite(roadRes.sigma) ? roadRes.sigma : null,
                        occ: Boolean(roadRes.occ || nGroundPts < 15),
                        dZ: Number((newZ - baseZ).toFixed(4)),
                        nguon: 'matDuong'
                    }
                };
            }
        }

        // Thử NeoDuyet nếu có sẵn
        const Neo = opts.neoDuyetLib || (typeof window !== 'undefined' ? window.NeoDuyet : null);
        if (Neo && opts.neoList && opts.neoList.some(n => n && n.kind !== 'ego')) {
            const st = Neo.datTrangThaiNeo(opts.neoList, null);
            const q = Neo.truyVanNeoChoBox(pred.x, pred.y, NaN, 0, st);
            if (q && q.valid && Number.isFinite(q.z)) {
                const zNeo = q.z + pred.H * 0.5;
                if (Math.abs(zNeo - zNearest) <= 0.80) {
                    return {
                        z: zNeo,
                        rx: refRxMed,
                        ry: refRyMed,
                        nguon: 'neoDuyet',
                        conf: 0.75,
                        info: {
                            boQua: false,
                            nDiemDat: 0,
                            sigma: null,
                            occ: false,
                            dZ: Number((zNeo - baseZ).toFixed(4)),
                            nguon: 'neoDuyet'
                        }
                    };
                }
            }
        }

        return {
            z: baseZ,
            rx: refRxMed,
            ry: refRyMed,
            nguon: 'ref',
            conf: 0.50,
            info: {
                boQua: true,
                nDiemDat: 0,
                sigma: null,
                occ: Boolean(ptsTarget && ptsTarget.length > 0 && ptsTarget.length < 25),
                dZ: 0,
                nguon: 'quyDao',
                lyDo: 'thieuDiemDat'
            }
        };
    }

    static duDoanCaoDoVaNghieng(pred, cleanSamples, ptsTarget, opts = {}) {
        const zQuyDao = this.duDoanZTheoQuyDao(pred, cleanSamples, opts);
        if (opts && opts.chiQuyDao === true) {
            return { z: zQuyDao.z, rx: zQuyDao.rx, ry: zQuyDao.ry, nguon: 'ref', conf: zQuyDao.conf };
        }
        return this.epZTheoMatDuong(pred, zQuyDao, ptsTarget, opts);
    }

    // =========================================================================
    // STEP 8: HÀM ĐIỀU PHỐI PHÂN TẦNG `tinhToanNoiSuyDaPhuongAn` & `tinhToanNoiSuyBoxV2`
    // =========================================================================
    static _chayPipelineV2(track, targetFrame, refData, rawGlobalPts = null, opts = {}) {
        const frames = Object.keys(refData || {}).map(Number).sort((a, b) => a - b);
        if (frames.length === 0) return null;

        const reqMode = (opts && opts.phuongAn) ? String(opts.phuongAn).toUpperCase() : 'ALL';
        const needB = reqMode === 'ALL' || reqMode.includes('B') || reqMode.includes('C');
        const needC = reqMode === 'ALL' || reqMode.includes('C');

        let nearestF = frames[0], minDist = Math.abs(targetFrame - frames[0]);
        for (let i = 1; i < frames.length; i++) {
            const d = Math.abs(targetFrame - frames[i]);
            if (d < minDist) { minDist = d; nearestF = frames[i]; }
        }
        const nearP = refData[nearestF];
        const refL = (nearP && nearP[6] > 0.2) ? nearP[6] : ((track && track._refL) || 4.5);
        const refW = (nearP && nearP[7] > 0.2) ? nearP[7] : ((track && track._refW) || 1.9);
        const refH = (nearP && nearP[8] > 0.2) ? nearP[8] : ((track && track._refH) || 1.6);

        if (frames.length === 1) {
            const boxA = [nearP[0], nearP[1], nearP[2], nearP[3] || 0, nearP[4] || 0, nearP[5] || 0, refL, refW, refH];
            return {
                A: boxA,
                B: needB ? boxA.slice() : null,
                C: needC ? boxA.slice() : null,
                meta: {
                    lidar: { boQua: true, nPts: 0, gatePass: false, loai: 'motMoc' },
                    surface: needC ? { boQua: true, nDiemDat: 0, dZ: 0, lyDo: 'motMoc' } : null
                }
            };
        }

        const tat = opts.tatModule || {};
        const allTracks = opts.allTracks || (typeof window !== 'undefined' && window.currentAnnotations?.tracks) || [];
        const egoCache = opts.egoCache || (!tat.ego ? this.taoBoDemEgo(opts.layPtsFn, allTracks, { excludeTrack: track, khoDuyet: opts.khoDuyet, tatLidarEgo: opts.tatLidarEgo }) : null);

        // Nhánh Nội suy kẹp giữa (frames[0] <= targetFrame <= frames[last])
        if (frames[0] <= targetFrame && targetFrame <= frames[frames.length - 1]) {
            if (refData[targetFrame]) {
                const exact = [...refData[targetFrame]];
                return {
                    A: exact,
                    B: needB ? exact.slice() : null,
                    C: needC ? exact.slice() : null,
                    meta: {
                        lidar: { boQua: true, nPts: 0, gatePass: false, loai: 'trungMoc' },
                        surface: needC ? { boQua: true, nDiemDat: 0, dZ: 0, lyDo: 'trungMoc' } : null
                    }
                };
            }
            let prevF = frames[0], nextF = frames[frames.length - 1];
            for (let i = 0; i < frames.length; i++) {
                if (frames[i] < targetFrame) prevF = frames[i];
                else { nextF = frames[i]; break; }
            }
            const p1 = refData[prevF], p2 = refData[nextF];
            const t = (targetFrame - prevF) / Math.max(1, nextF - prevF);
            const ego1 = egoCache ? egoCache.layEgo(prevF, targetFrame) : { tx: 0, ty: 0, th: 0, ok: true };
            const ego2 = egoCache ? egoCache.layEgo(nextF, targetFrame) : { tx: 0, ty: 0, th: 0, ok: true };
            const m1 = this.applySE2([p1[0], p1[1], p1[5] || 0], ego1);
            const m2 = this.applySE2([p2[0], p2[1], p2[5] || 0], ego2);
            const ix = m1[0] + (m2[0] - m1[0]) * t;
            const iy = m1[1] + (m2[1] - m1[1]) * t;
            const irz = this.wrapAngle(m1[2] + this.wrapAngle(m2[2] - m1[2]) * t);
            const iz = p1[2] + (p2[2] - p1[2]) * t;
            const irx = (p1[3] || 0) + ((p2[3] || 0) - (p1[3] || 0)) * t;
            const iry = (p1[4] || 0) + ((p2[4] || 0) - (p1[4] || 0)) * t;
            const iL = (p1[6] || refL) * (1 - t) + (p2[6] || refL) * t;
            const iW = (p1[7] || refW) * (1 - t) + (p2[7] || refW) * t;
            const iH = (p1[8] || refH) * (1 - t) + (p2[8] || refH) * t;

            const boxA = [ix, iy, iz, irx, iry, irz, iL, iW, iH];
            const boxB = needB ? boxA.slice() : null;
            let boxC = null;
            let surfInfo = null;
            if (needC) {
                boxC = boxA.slice();
                if (!tat.z) {
                    const interpSamples = [
                        { f: prevF, z: p1[2], rx: p1[3], ry: p1[4] },
                        { f: nextF, z: p2[2], rx: p2[3], ry: p2[4] }
                    ];
                    const zBase = this.duDoanZTheoQuyDao(
                        { x: ix, y: iy, z: iz, rx: irx, ry: iry, yaw: irz, L: refL, W: refW, H: refH },
                        interpSamples,
                        { ...opts, fTarget: targetFrame }
                    );
                    const zMat = this.epZTheoMatDuong(
                        { x: ix, y: iy, z: iz, yaw: irz, L: refL, W: refW, H: refH },
                        { ...zBase, z: iz },
                        rawGlobalPts,
                        { ...opts, fTarget: targetFrame, dt: Math.min(targetFrame - prevF, nextF - targetFrame) }
                    );
                    boxC[2] = zMat.z;
                    boxC[3] = zMat.rx;
                    boxC[4] = zMat.ry;
                    surfInfo = zMat.info || null;
                } else {
                    surfInfo = { boQua: true, nDiemDat: 0, dZ: 0, lyDo: 'tatZ' };
                }
            }
            return {
                A: boxA,
                B: boxB,
                C: boxC,
                meta: {
                    isInterpolation: true,
                    lidar: { boQua: true, nPts: 0, gatePass: false, loai: 'noiSuyKepGiua' },
                    surface: surfInfo
                }
            };
        }

        // Ngoại suy Tiến hoặc Lùi
        const isForward = targetFrame > frames[frames.length - 1];
        const kWin = Math.min(frames.length, 8);
        const subFrames = isForward ? frames.slice(frames.length - kWin) : frames.slice(0, kWin);
        const fAnchor = isForward ? subFrames[subFrames.length - 1] : subFrames[0];

        // 1. Quy mọi ref về khung neo fAnchor
        const samples = this.quyVeKhungNeo(refData, subFrames, egoCache, fAnchor);
        const outRes = !tat.dongHoc ? this.loaiMauNhieu(samples) : { samples, sigmaXY: 0.12, sigmaYaw: 0.12 };
        const cleanSamples = outRes.samples.filter(s => !s.bad);

        // 2. Phân loại + Khớp mô hình động học tại khung neo
        let predAnchor;
        if (!tat.dongHoc) {
            const cls = this.phanLoaiChuyenDong(outRes.samples, outRes.sigmaXY);
            const mh = this.khopMoHinhChuyenDong(outRes.samples, cls, fAnchor);
            predAnchor = this.duDoanTuMoHinh(mh, targetFrame);
        } else {
            predAnchor = { x: samples[samples.length - 1].x, y: samples[samples.length - 1].y, yaw: samples[samples.length - 1].yaw, sigmaXY: 0.5, sigmaYaw: 0.15 };
        }

        // 3. Biến đổi dự đoán từ khung neo fAnchor sang hệ tọa độ targetFrame
        const egoAnchorToTarget = egoCache ? egoCache.layEgo(fAnchor, targetFrame) : { tx: 0, ty: 0, th: 0, ok: true };
        const predInTarget = this.applySE2([predAnchor.x, predAnchor.y, predAnchor.yaw], egoAnchorToTarget);

        // Phương án A (Thuần Quỹ Đạo): KHÔNG đụng LiDAR đích & KHÔNG đụng Mặt đường
        const boxA = [
            predInTarget[0],
            predInTarget[1],
            nearP[2],
            nearP[3] || 0,
            nearP[4] || 0,
            predInTarget[2],
            refL, refW, refH
        ];

        let zQuyDaoRes = null;
        if (!tat.z && cleanSamples.length > 0) {
            zQuyDaoRes = this.duDoanZTheoQuyDao(
                { x: boxA[0], y: boxA[1], z: boxA[2], rx: boxA[3], ry: boxA[4], yaw: boxA[5], L: refL, W: refW, H: refH },
                cleanSamples,
                { ...opts, fTarget: targetFrame, dt: targetFrame - fAnchor }
            );
            boxA[2] = zQuyDaoRes.z;
            boxA[3] = zQuyDaoRes.rx;
            boxA[4] = zQuyDaoRes.ry;
        }

        // Cắt sẵn 1 ROI bán kính 25m quanh điểm dự đoán để Step 6 & Step 7 dùng chung
        let ptsNearTarget = rawGlobalPts;
        if ((needB || needC) && rawGlobalPts && rawGlobalPts.length > 500) {
            ptsNearTarget = [];
            for (let i = 0; i < rawGlobalPts.length; i++) {
                const p = rawGlobalPts[i];
                const dx = p[0] - boxA[0], dy = p[1] - boxA[1];
                if (dx * dx + dy * dy <= 625.0) ptsNearTarget.push(p);
            }
        }

        // Phương án B (Quỹ đạo + LiDAR L-shape, giữ Z quỹ đạo)
        let boxB = null;
        let lidarMeta = { boQua: true, nPts: ptsNearTarget ? ptsNearTarget.length : 0, gatePass: false, loai: 'tatLidar' };
        if (needB) {
            boxB = boxA.slice();
            if (!tat.lidar && ptsNearTarget && ptsNearTarget.length >= 15) {
                let neighborBoxes = opts.neighborBoxes || [];
                if ((!neighborBoxes || neighborBoxes.length === 0) && allTracks.length > 0) {
                    const TT = opts.thuatToanCanChinh || (typeof window !== 'undefined' ? window.thuatToanCanChinh : null);
                    if (TT && typeof TT.layNeighborBoxesTuAnnotations === 'function') {
                        const dict = TT.layNeighborBoxesTuAnnotations({ tracks: allTracks, shapes: [] }, track, new Set([targetFrame]), opts.labelsMap || null);
                        neighborBoxes = dict.get(targetFrame) || [];
                    }
                }
                const lidarRes = this.tinhChinhLidarSauDuDoan(
                    { x: boxB[0], y: boxB[1], z: boxB[2], yaw: boxB[5], L: refL, W: refW, H: refH },
                    ptsNearTarget, neighborBoxes,
                    { xy: predAnchor.sigmaXY, yaw: predAnchor.sigmaYaw }, opts
                );
                if (lidarRes && lidarRes.thanhCong) {
                    boxB[0] = lidarRes.x;
                    boxB[1] = lidarRes.y;
                    boxB[5] = lidarRes.yaw;
                    lidarMeta = {
                        boQua: false,
                        nPts: lidarRes.soDiem || ptsNearTarget.length,
                        gatePass: true,
                        dich: lidarRes.dich || 0,
                        loai: lidarRes.loai || 'lshape'
                    };
                } else {
                    lidarMeta = {
                        boQua: true,
                        nPts: ptsNearTarget.length,
                        gatePass: false,
                        loai: (lidarRes && lidarRes.loai) ? lidarRes.loai : 'tuChoiGate'
                    };
                }
            } else {
                lidarMeta = {
                    boQua: true,
                    nPts: ptsNearTarget ? ptsNearTarget.length : 0,
                    gatePass: false,
                    loai: tat.lidar ? 'tatLidar' : 'thieuDiem'
                };
            }
        }

        // Phương án C (Quỹ đạo + LiDAR + Mặt đường / Surface Z)
        let boxC = null;
        let surfaceMeta = null;
        if (needC) {
            boxC = (boxB || boxA).slice();
            if (!tat.z && cleanSamples.length > 0) {
                const zBase = zQuyDaoRes || this.duDoanZTheoQuyDao(
                    { x: boxC[0], y: boxC[1], z: boxC[2], rx: boxC[3], ry: boxC[4], yaw: boxC[5], L: refL, W: refW, H: refH },
                    cleanSamples,
                    { ...opts, fTarget: targetFrame }
                );
                const zMat = this.epZTheoMatDuong(
                    { x: boxC[0], y: boxC[1], z: boxC[2], yaw: boxC[5], L: refL, W: refW, H: refH },
                    zBase, ptsNearTarget,
                    { ...opts, fTarget: targetFrame, dt: targetFrame - fAnchor }
                );
                boxC[2] = zMat.z;
                boxC[3] = zMat.rx;
                boxC[4] = zMat.ry;
                surfaceMeta = zMat.info || null;
            } else {
                surfaceMeta = { boQua: true, nDiemDat: 0, dZ: 0, lyDo: tat.z ? 'tatZ' : 'thieuMau' };
            }
        }

        return {
            A: boxA,
            B: boxB,
            C: boxC,
            meta: {
                isInterpolation: false,
                lidar: lidarMeta,
                surface: surfaceMeta
            }
        };
    }

    static tinhToanNoiSuyDaPhuongAn(track, targetFrame, refData, rawGlobalPts = null, opts = {}) {
        const res = this._chayPipelineV2(track, targetFrame, refData, rawGlobalPts, {
            ...(opts || {}),
            phuongAn: (opts && opts.phuongAn) ? opts.phuongAn : 'AB'
        });
        if (!res) return null;
        return {
            A: res.A ? res.A.slice() : null,
            B: res.B ? res.B.slice() : null,
            C: res.C ? res.C.slice() : null,
            meta: res.meta
        };
    }

    static tinhToanNoiSuyBoxV2(track, targetFrame, refData, rawGlobalPts = null, opts = {}) {
        const res = this._chayPipelineV2(track, targetFrame, refData, rawGlobalPts, opts);
        if (!res) return null;
        const p = (opts && opts.phuongAn) ? String(opts.phuongAn).toUpperCase() : 'ALL';
        if (p === 'A') return res.A;
        if (p === 'B') return res.B || res.A;
        return res.C || res.B || res.A;
    }
}

if (typeof window !== 'undefined') {
    window.thuatToanNgoaiSuy = ThuatToanNgoaiSuy;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ThuatToanNgoaiSuy;
}
