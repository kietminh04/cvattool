/**
 * Thuật Toán Surface Cục Bộ (Per-Vehicle Local Ground Patch + Reference Graph)
 * ---------------------------------------------------------------------------
 * Thay thế tư duy "1 tấm bạt lồi lõm toàn bản đồ" bằng các mảng mặt đường cục bộ
 * riêng biệt dưới mỗi xe:
 * 1. Mỗi xe có 1 Local Tangent Plane riêng, lấy mẫu đối xứng 4 góc phần tư quanh OBB.
 * 2. Chấm điểm Confidence C in [0, 1] dựa trên mật độ điểm, độ phủ 4 góc, λ_min(XY), độ phẳng σ_z.
 * 3. Phân 3 trạng thái:
 *    - 'anchor'    (C >= 0.70): Tự đo trực tiếp từ LiDAR, đủ tin cậy để làm nguồn tham chiếu.
 *    - 'partial'   (0.30 <= C < 0.70): Giữ cao độ z thật tại chỗ, mượn độ nghiêng (n) từ Anchor gần.
 *    - 'reference' (C < 0.30): Xe ở quá xa/khuất, ngoại suy mặt phẳng từ k=3 Anchor gần nhất.
 * 4. Ego Patch tại (0, 0) luôn đóng vai trò Anchor dự phòng ổn định nhất.
 */

class ThuatToanSurfaceCucBo {
    static SKIRT_MARGIN = 1.6;        // Vành đai lấy mẫu mở rộng quanh OBB xe (m)
    static PATCH_VIS_PAD = 0.35;      // Phần nới hiển thị 3D quanh đáy xe để dễ soi 4 bánh (m)
    static MAX_SLOPE = 0.12;          // Kẹp độ dốc vật lý tối đa (12%)
    static REF_MAX_DIST = 80.0;       // Bán kính tìm kiếm Anchor tối đa (m)
    static REF_TOP_K = 3;             // Số lượng Anchor tối đa dùng để trộn tham chiếu
    static OUTLIER_Z_TOL = 0.25;      // Ngưỡng loại Anchor ngoại lai (vỉa hè / cầu vượt) (m)

    static eulerXYZToMatrix(rx, ry, rz) {
        const cx = Math.cos(rx), sx = Math.sin(rx);
        const cy = Math.cos(ry), sy = Math.sin(ry);
        const cz = Math.cos(rz), sz = Math.sin(rz);
        return [
            [cy * cz, cz * sx * sy - cx * sz, cx * cz * sy + sx * sz],
            [cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - cz * sx],
            [-sy,     cy * sx,                cx * cy]
        ];
    }

    static chuanHoaDiem(pts) {
        if (!pts) return null;
        if (pts.flatArray && Number.isFinite(pts.count)) {
            return { flat: pts.flatArray, count: pts.count };
        }
        if (pts instanceof Float32Array || pts instanceof Float64Array) {
            return { flat: pts, count: Math.floor(pts.length / 3) };
        }
        if (Array.isArray(pts) && pts.length > 0) {
            const n = pts.length;
            const flat = new Float32Array(n * 3);
            let c = 0;
            for (let i = 0; i < n; i++) {
                const p = pts[i];
                if (!p) continue;
                const x = Array.isArray(p) ? p[0] : p.x;
                const y = Array.isArray(p) ? p[1] : p.y;
                const z = Array.isArray(p) ? p[2] : p.z;
                if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
                    flat[c * 3] = x;
                    flat[c * 3 + 1] = y;
                    flat[c * 3 + 2] = z;
                    c++;
                }
            }
            return { flat, count: c };
        }
        return null;
    }

    static _docBox(b, idx = 0) {
        const sp = b?.shape?.points || b?.points || (Array.isArray(b) ? b : null);
        if (!sp || sp.length < 6) return null;
        const x = sp[0], y = sp[1], z = sp[2];
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
        const L = Number.isFinite(sp[6]) && sp[6] > 0.2 ? sp[6] : 4.6;
        const W = Number.isFinite(sp[7]) && sp[7] > 0.2 ? sp[7] : 1.9;
        const H = Number.isFinite(sp[8]) && sp[8] > 0.2 ? sp[8] : 1.6;
        const rz = sp[5] || 0;
        const id = b?.id ?? b?.trackId ?? b?.shape?.id ?? `box_${idx}`;
        return {
            id: String(id),
            x, y, z,
            rx: sp[3] || 0,
            ry: sp[4] || 0,
            rz,
            L, W, H,
            cosRz: Math.cos(rz),
            sinRz: Math.sin(rz)
        };
    }

    static kyHieuBoxes(boxes) {
        if (!boxes || !boxes.length) return '';
        const parts = [];
        for (let i = 0; i < boxes.length; i++) {
            const q = this._docBox(boxes[i], i);
            if (!q) continue;
            parts.push(`${q.id}:${Math.round(q.x * 50)},${Math.round(q.y * 50)},${Math.round(q.rz * 200)},${Math.round(q.L * 50)},${Math.round(q.W * 50)}`);
        }
        return parts.sort().join('|');
    }

    static median(arr) {
        if (!arr || arr.length === 0) return 0;
        const s = Float64Array.from(arr).sort();
        const mid = s.length >> 1;
        return (s.length & 1) ? s[mid] : 0.5 * (s[mid - 1] + s[mid]);
    }

    /**
     * Fit mặt phẳng z = zc + gx*(x - cx) + gy*(y - cy) bằng Weighted Least Squares + 2 vòng IRLS Huber
     * để kháng nhiễu gờ vỉa hè, đá dăm và điểm thân xe còn sót.
     */
    static _fitMatPhangIRLS(xs, ys, zs, cx, cy) {
        const n = xs.length;
        if (n < 3) return null;

        const weights = new Float64Array(n).fill(1.0);
        let gx = 0, gy = 0, zc = this.median(zs);

        for (let iter = 0; iter < 3; iter++) {
            let sw = 0, sx = 0, sy = 0, sz = 0;
            let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;

            for (let i = 0; i < n; i++) {
                const w = weights[i];
                if (w <= 1e-6) continue;
                const dx = xs[i] - cx;
                const dy = ys[i] - cy;
                const z = zs[i];
                sw += w;
                sx += w * dx;
                sy += w * dy;
                sz += w * z;
                sxx += w * dx * dx;
                sxy += w * dx * dy;
                syy += w * dy * dy;
                sxz += w * dx * z;
                syz += w * dy * z;
            }
            if (sw < 1e-6) break;

            const mx = sx / sw, my = sy / sw, mz = sz / sw;
            const Cxx = sxx / sw - mx * mx;
            const Cxy = sxy / sw - mx * my;
            const Cyy = syy / sw - my * my;
            const Cxz = sxz / sw - mx * mz;
            const Cyz = syz / sw - my * mz;
            const det = Cxx * Cyy - Cxy * Cxy;

            if (det > 1e-6) {
                const ngx = (Cxz * Cyy - Cyz * Cxy) / det;
                const ngy = (Cyz * Cxx - Cxz * Cxy) / det;
                // Kẹp độ dốc vật lý để không bao giờ bị dựng đứng khi thiếu điểm
                const gMag = Math.hypot(ngx, ngy);
                if (gMag <= this.MAX_SLOPE) {
                    gx = ngx; gy = ngy;
                } else if (gMag > 1e-6) {
                    const scale = this.MAX_SLOPE / gMag;
                    gx = ngx * scale; gy = ngy * scale;
                }
                zc = mz - gx * mx - gy * my;
            } else {
                gx = 0; gy = 0; zc = mz;
            }

            // Cập nhật trọng số Huber cho vòng lặp tiếp theo
            const delta = 0.04; // 4cm
            for (let i = 0; i < n; i++) {
                const r = Math.abs(zs[i] - (zc + gx * (xs[i] - cx) + gy * (ys[i] - cy)));
                weights[i] = r <= delta ? 1.0 : (delta / r);
            }
        }

        // Tính λ_min của hiệp phương sai XY và độ lệch chuẩn σ_z
        let mx = 0, my = 0;
        for (let i = 0; i < n; i++) { mx += xs[i] - cx; my += ys[i] - cy; }
        mx /= n; my /= n;
        let cxx = 0, cxy = 0, cyy = 0, ssRes = 0;
        for (let i = 0; i < n; i++) {
            const dx = (xs[i] - cx) - mx;
            const dy = (ys[i] - cy) - my;
            cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
            const res = zs[i] - (zc + gx * (xs[i] - cx) + gy * (ys[i] - cy));
            ssRes += res * res;
        }
        cxx /= n; cxy /= n; cyy /= n;
        const trace = cxx + cyy;
        const disc = Math.sqrt(Math.max(0, (cxx - cyy) * (cxx - cyy) + 4 * cxy * cxy));
        const lambdaMinXY = 0.5 * (trace - disc);
        const sigmaZ = Math.sqrt(ssRes / n);

        const inv = 1.0 / Math.sqrt(gx * gx + gy * gy + 1.0);
        return {
            zc,
            gx,
            gy,
            normal: [-gx * inv, -gy * inv, inv],
            lambdaMinXY,
            sigmaZ
        };
    }

    /**
     * Lọc LPR theo 4 góc phần tư quanh xe: chọn 25% điểm thấp nhất ở mỗi góc (tối thiểu 3 điểm nếu có)
     * để tránh hiện tượng điểm tập trung ở 1 phía sườn xe làm nghiêng mặt phẳng.
     */
    static _chonLPR4Goc(quadBuckets) {
        const xs = [], ys = [], zs = [];
        let activeQuads = 0;

        for (let q = 0; q < 4; q++) {
            const b = quadBuckets[q];
            if (!b || b.length === 0) continue;
            // b chứa [x, y, z, ...] stride 3
            const pts = [];
            for (let i = 0; i < b.length; i += 3) {
                pts.push({ x: b[i], y: b[i + 1], z: b[i + 2] });
            }
            pts.sort((a, c) => a.z - c.z);

            // [KHÁNG GHOSTING TẦNG DƯỚI]: Nhảy qua các điểm phản xạ ngầm cô lập dưới lòng đất
            let baseIdx = 0;
            if (pts.length >= 6) {
                for (let k = 0; k < Math.min(4, pts.length - 2); k++) {
                    if (pts[k + 1].z - pts[k].z > 0.08) {
                        baseIdx = k + 1;
                    }
                }
            }

            const zLowest = pts[baseIdx].z;
            const keepCount = Math.min(25, Math.max(4, Math.ceil(pts.length * 0.30)));
            let qCount = 0;
            for (let i = baseIdx; i < pts.length && qCount < keepCount; i++) {
                if (pts[i].z <= zLowest + 0.14) {
                    xs.push(pts[i].x);
                    ys.push(pts[i].y);
                    zs.push(pts[i].z);
                    qCount++;
                }
            }
            if (qCount >= 2) activeQuads++;
        }
        return { xs, ys, zs, activeQuads };
    }

    static _tinhConfidence(nPts, activeQuads, lambdaMinXY, sigmaZ, nz) {
        if (nPts < 3 || nz < 0.96) return 0;
        const cPts = Math.min(1.0, nPts / 20.0);
        const cQuad = activeQuads / 4.0;
        const cSpread = Math.min(1.0, lambdaMinXY / 0.20);
        const cFlat = Math.exp(-(sigmaZ * sigmaZ) / (2.0 * 0.035 * 0.035));
        return Math.max(0, Math.min(1, cPts * (0.35 + 0.65 * cQuad) * (0.30 + 0.70 * cSpread) * cFlat));
    }

    /**
     * Fit mặt phẳng bằng Histogram không gian 2.5cm: tìm lát cắt độ cao có độ phủ ô (u, v) rộng nhất
     * để loại sạch 100% ghosting phản xạ âm dưới lòng đường.
     */
    static _fitHistogramKhongGian(quadBuckets, car) {
        const pts = [];
        for (let q = 0; q < 4; q++) {
            const b = quadBuckets[q];
            for (let i = 0; i < b.length; i += 3) {
                pts.push({ x: b[i], y: b[i + 1], z: b[i + 2] });
            }
        }
        if (pts.length < 8) return null;

        const cosR = car.cosRz, sinR = car.sinRz;
        const local = [];
        for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const dx = p.x - car.x, dy = p.y - car.y;
            const u = dx * cosR + dy * sinR;
            const v = -dx * sinR + dy * cosR;
            const w = p.z - car.zBottom;
            local.push({ x: p.x, y: p.y, z: p.z, u, v, w });
        }

        const binSize = 0.025; // 2.5cm
        const wMin = -0.50;
        const numBins = Math.ceil((0.35 - wMin) / binSize);
        if (numBins <= 0) return null;

        const bins = Array.from({ length: numBins }, () => ({ pts: [], cells: new Set() }));
        for (let i = 0; i < local.length; i++) {
            const pt = local[i];
            if (pt.w < wMin || pt.w > 0.35) continue;
            const bIdx = Math.floor((pt.w - wMin) / binSize);
            if (bIdx >= 0 && bIdx < numBins) {
                bins[bIdx].pts.push(pt);
                bins[bIdx].cells.add(`${Math.floor(pt.u / 0.40)}_${Math.floor(pt.v / 0.40)}`);
            }
        }

        let bestScore = -1, bestBin = -1;
        for (let b = 1; b < numBins - 1; b++) {
            const winPts = bins[b - 1].pts.length + bins[b].pts.length + bins[b + 1].pts.length;
            const allCells = new Set([...bins[b - 1].cells, ...bins[b].cells, ...bins[b + 1].cells]);
            if (allCells.size >= 3 && winPts >= 5) {
                const score = winPts * allCells.size;
                if (score > bestScore) {
                    bestScore = score;
                    bestBin = b;
                }
            }
        }
        if (bestBin === -1) return null;

        const wPeak = wMin + (bestBin + 0.5) * binSize;
        const zPeak = car.zBottom + wPeak;
        const inliers = local.filter(pt => Math.abs(pt.z - zPeak) <= 0.045);
        if (inliers.length < 4) return null;

        const res = this._fitMatPhangIRLS(inliers.map(p => p.x), inliers.map(p => p.y), inliers.map(p => p.z), car.x, car.y);
        if (res) res.nPtsInliers = inliers.length;
        return res;
    }

    /**
     * Xây dựng toàn bộ các mảng mặt đường cục bộ (Per-Vehicle Patches + Ego + Reference Graph).
     */
    static xayDung(pts, boxes = [], config = {}) {
        const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        const raw = this.chuanHoaDiem(pts);
        if (!raw || raw.count < 10) return null;

        const flat = raw.flat;
        const count = raw.count;
        const skirt = Number.isFinite(config.skirt) ? config.skirt : this.SKIRT_MARGIN;

        // 1. Chuẩn hóa danh sách xe (loại trùng lặp track/shape cùng vị trí)
        const cars = [];
        const seenKey = new Set();
        for (let i = 0; i < (boxes ? boxes.length : 0); i++) {
            const q = this._docBox(boxes[i], i);
            if (!q) continue;
            const k = `${Math.round(q.x * 20)},${Math.round(q.y * 20)}`;
            if (seenKey.has(k)) continue;
            seenKey.add(k);

            const halfU = 0.5 * q.L + skirt;
            const halfV = 0.5 * q.W + skirt;
            const rBound = Math.hypot(halfU, halfV);
            const zBottom = q.z - 0.5 * q.H;
            cars.push({
                ...q,
                halfU,
                halfV,
                innerHalfU: 0.5 * q.L + 0.08,
                innerHalfV: 0.5 * q.W + 0.08,
                rBound,
                zBottom,
                zMin: zBottom - 1.25,
                zMax: zBottom + 0.55,
                quads: [[], [], [], []]
            });
        }

        // Bucket cho Ego Anchor quanh (0,0) bán kính 2.2m..6.5m
        const egoQuads = [[], [], [], []];

        // 2. PASS 1: Duyệt 300k điểm LiDAR 1 lần duy nhất
        for (let i = 0; i < count; i++) {
            const idx3 = i * 3;
            const px = flat[idx3];
            const py = flat[idx3 + 1];
            const pz = flat[idx3 + 2];
            if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(pz)) continue;
            if (pz < -4.5 || pz > 4.0) continue;

            // Kiểm tra xem điểm có nằm bên trong thân cứng của xe nào không (để không lấy nhầm gầm/lốp xe khác)
            let insideAnyBody = false;
            for (let c = 0; c < cars.length; c++) {
                const car = cars[c];
                const dx = px - car.x;
                const dy = py - car.y;
                if (Math.abs(dx) > car.rBound || Math.abs(dy) > car.rBound) continue;

                const u = dx * car.cosRz + dy * car.sinRz;
                const v = -dx * car.sinRz + dy * car.cosRz;

                // Nếu nằm lọt trong footprint thân xe và cao hơn đáy xe + 0.20m -> coi là thân/lốp xe
                if (Math.abs(u) <= car.innerHalfU && Math.abs(v) <= car.innerHalfV && pz > car.zBottom + 0.20) {
                    insideAnyBody = true;
                }

                // Thu thập vào vành đai lấy mẫu của xe c (ưu tiên ngoài thân xe hoặc sát mặt đất)
                if (Math.abs(u) <= car.halfU && Math.abs(v) <= car.halfV && pz >= car.zMin && pz <= car.zMax) {
                    const isBodyPt = (Math.abs(u) <= 0.5 * car.L - 0.12 && Math.abs(v) <= 0.5 * car.W - 0.12 && pz > car.zBottom + 0.22);
                    if (!isBodyPt) {
                        const qIdx = (u >= 0 ? 0 : 1) + (v >= 0 ? 0 : 2);
                        car.quads[qIdx].push(px, py, pz);
                    }
                }
            }

            if (!insideAnyBody) {
                const r2 = px * px + py * py;
                if (r2 >= 4.84 && r2 <= 42.25 && pz >= -2.8 && pz <= 0.5) {
                    const qIdx = (px >= 0 ? 0 : 1) + (py >= 0 ? 0 : 2);
                    egoQuads[qIdx].push(px, py, pz);
                }
            }
        }

        // 3. PASS 2: Fit mặt phẳng & chấm điểm Confidence cho Ego + từng xe
        const egoLPR = this._chonLPR4Goc(egoQuads);
        const egoFit = this._fitMatPhangIRLS(egoLPR.xs, egoLPR.ys, egoLPR.zs, 0, 0);
        const egoPatch = egoFit ? {
            id: '__EGO__',
            isEgo: true,
            x: 0, y: 0, rz: 0, L: 4.5, W: 2.0, H: 1.5,
            zc: egoFit.zc,
            gx: egoFit.gx,
            gy: egoFit.gy,
            normal: egoFit.normal,
            sigmaZ: egoFit.sigmaZ,
            nPts: egoLPR.xs.length,
            activeQuads: egoLPR.activeQuads,
            confidence: Math.max(0.80, this._tinhConfidence(egoLPR.xs.length, egoLPR.activeQuads, egoFit.lambdaMinXY, egoFit.sigmaZ, egoFit.normal[2])),
            status: 'ego',
            refSources: []
        } : null;

        const patches = [];
        const anchors = [];
        if (egoPatch) anchors.push(egoPatch);

        for (let c = 0; c < cars.length; c++) {
            const car = cars[c];

            // Gom tất cả điểm từ 4 góc vành đai quanh xe
            const ptsAroundCar = [];
            let activeQuads = 0;
            for (let q = 0; q < 4; q++) {
                const b = car.quads[q];
                if (!b || b.length === 0) continue;
                if (b.length >= 6) activeQuads++;
                for (let i = 0; i < b.length; i += 3) {
                    ptsAroundCar.push([b[i], b[i + 1], b[i + 2]]);
                }
            }

            let fit = null;
            let conf = 0;

            // [TIER 1]: Gọi ThuatToanCanChinh.canChinhMatDuongHop
            const zBoxBottom = car.z - 0.5 * car.H;
            if (typeof ThuatToanCanChinh !== 'undefined' && typeof ThuatToanCanChinh.canChinhMatDuongHop === 'function' && ptsAroundCar.length >= 15) {
                try {
                    const resCanChinh = ThuatToanCanChinh.canChinhMatDuongHop(
                        [car.x, car.y, car.z],
                        [car.rx || 0, car.ry || 0, car.rz || 0],
                        [car.L, car.W, car.H],
                        ptsAroundCar,
                        this.MAX_SLOPE
                    );

                    // [PHYSICS SANITY CHECK]: Chỉ công nhận Anchor khi thực sự có mặt phẳng đất (foundPlane)
                    // và độ cao mặt đường đo được KHÔNG ĐƯỢC LỆCH QUÁ 12CM so với đáy hộp xe (chống bắt nhầm vào thân/sàn xe)!
                    if (resCanChinh && resCanChinh.foundPlane && resCanChinh.nGroundPts >= 15) {
                        const zc = resCanChinh.zRoad;
                        const devFromBottom = Math.abs(zc - zBoxBottom);
                        if (devFromBottom <= 0.12 && activeQuads >= 2) {
                            const nRx = resCanChinh.newRot ? resCanChinh.newRot[0] : 0;
                            const nRy = resCanChinh.newRot ? resCanChinh.newRot[1] : 0;
                            const gx = -nRy;
                            const gy = nRx;
                            const invNorm = 1.0 / Math.sqrt(gx * gx + gy * gy + 1.0);
                            const normal = [-gx * invNorm, -gy * invNorm, invNorm];

                            fit = {
                                zc,
                                gx,
                                gy,
                                normal,
                                sigmaZ: resCanChinh.rms || 0.02,
                                nPts: resCanChinh.nGroundPts,
                                activeQuads,
                                lambdaMinXY: 1.0
                            };
                            conf = Math.min(1.0, Math.max(0.70, resCanChinh.confidence || 0.75));
                        }
                    }
                } catch (err) {
                    console.warn('[SurfaceCucBo] canChinhMatDuongHop error:', err);
                }
            }

            // [TIER 2]: Fallback IRLS nếu Tier 1 không bắt được
            if (!fit && ptsAroundCar.length >= 10) {
                const lpr = this._chonLPR4Goc(car.quads);
                const fitIRLS = this._fitMatPhangIRLS(lpr.xs, lpr.ys, lpr.zs, car.x, car.y);
                if (fitIRLS && Math.abs(fitIRLS.zc - zBoxBottom) <= 0.12) {
                    fit = fitIRLS;
                    conf = this._tinhConfidence(lpr.xs.length, lpr.activeQuads, fit.lambdaMinXY, fit.sigmaZ, fit.normal[2]);
                }
            }

            let status = 'reference';
            if (conf >= 0.70 && fit) status = 'anchor';
            else if (conf >= 0.30 && fit) status = 'partial';
            else {
                // Không có mặt phẳng đất tin cậy: Mặc định khóa vào đáy tiếp xúc thật của xe!
                conf = 0.10;
                status = 'reference';
            }

            const patch = {
                id: car.id,
                isEgo: false,
                x: car.x,
                y: car.y,
                zBox: car.z,
                rz: car.rz,
                L: car.L,
                W: car.W,
                H: car.H,
                cosRz: car.cosRz,
                sinRz: car.sinRz,
                zc: fit ? fit.zc : (car.z - 0.5 * car.H),
                zLocalMedian: fit ? fit.zc : null,
                gx: fit ? fit.gx : 0,
                gy: fit ? fit.gy : 0,
                normal: fit ? fit.normal : [0, 0, 1],
                sigmaZ: fit ? fit.sigmaZ : 99,
                nPts: fit ? fit.nPts : 0,
                activeQuads: fit ? fit.activeQuads : activeQuads,
                confidence: conf,
                status,
                refSources: []
            };
            patches.push(patch);
            if (status === 'anchor') anchors.push(patch);
        }

        // 4. PASS 3: Reference Graph Propagation cho các xe 'partial' và 'reference'
        for (let i = 0; i < patches.length; i++) {
            const p = patches[i];
            if (p.status === 'anchor' || anchors.length === 0) continue;

            const cands = [];
            for (let j = 0; j < anchors.length; j++) {
                const a = anchors[j];
                const dx = a.x - p.x;
                const dy = a.y - p.y;
                // Khoảng cách bất đẳng hướng: ưu tiên xe cùng trục/làn dọc hơn là làn ngang
                const du = dx * p.cosRz + dy * p.sinRz;
                const dv = -dx * p.sinRz + dy * p.cosRz;
                const dEff = Math.hypot(du, 1.8 * dv);
                if (dEff > this.REF_MAX_DIST) continue;

                // [SLOPE SHRINKAGE]: Co cụm độ dốc theo khoảng cách, chống đòn bẩy làm vênh mặt đường ở xa
                const decay = Math.exp(-Math.min(dEff, 60.0) / 15.0);
                const rawSlope = a.gx * (p.x - a.x) + a.gy * (p.y - a.y);
                const effSlope = Math.max(-0.10, Math.min(0.10, rawSlope * decay));
                const zPred = a.zc + effSlope;
                const w = a.confidence / (dEff * dEff + 2.0);
                cands.push({ anchor: a, dEff, zPred, w });
            }

            if (cands.length === 0) continue;
            cands.sort((a, b) => b.w - a.w);
            const topK = cands.slice(0, this.REF_TOP_K);

            // Lọc ngoại lai theo độ cao ngoại suy (tránh lấy nhầm xe trên vỉa hè)
            let filtered = topK;
            if (topK.length >= 2) {
                const zMed = this.median(topK.map(t => t.zPred));
                const kept = topK.filter(t => Math.abs(t.zPred - zMed) <= this.OUTLIER_Z_TOL);
                if (kept.length > 0) filtered = kept;
            }

            let sumW = 0, sumGx = 0, sumGy = 0, sumZ = 0;
            const refs = [];
            for (const item of filtered) {
                sumW += item.w;
                sumGx += item.w * item.anchor.gx;
                sumGy += item.w * item.anchor.gy;
                sumZ += item.w * item.zPred;
                refs.push({
                    id: item.anchor.id,
                    x: item.anchor.x,
                    y: item.anchor.y,
                    z: item.anchor.zc,
                    weight: item.w
                });
            }

            if (sumW > 1e-9) {
                const gx = sumGx / sumW;
                const gy = sumGy / sumW;
                const inv = 1.0 / Math.sqrt(gx * gx + gy * gy + 1.0);
                p.gx = gx;
                p.gy = gy;
                p.normal = [-gx * inv, -gy * inv, inv];
                p.refSources = refs;

                const zBoxBottom = p.zBox - 0.5 * p.H;
                const minDist = filtered.length > 0 ? Math.min(...filtered.map(t => t.dEff)) : 99;
                const decayMin = Math.exp(-Math.min(minDist, 60.0) / 15.0);
                p.gx = (sumGx / sumW) * decayMin;
                p.gy = (sumGy / sumW) * decayMin;
                const invNorm = 1.0 / Math.sqrt(p.gx * p.gx + p.gy * p.gy + 1.0);
                p.normal = [-p.gx * invNorm, -p.gy * invNorm, invNorm];

                if (p.status === 'partial' && Number.isFinite(p.zLocalMedian)) {
                    // Partial: giữ z cục bộ đo được tại xe, chỉ mượn độ nghiêng từ Anchor gần
                    p.zc = p.zLocalMedian;
                } else {
                    // [HYBRID SEMANTIC PRIOR]: Hòa trộn ngoại suy với đáy xe thật, triệt tiêu sai số đòn bẩy
                    const wRef = Math.exp(-Math.min(minDist, 50.0) / 12.0);
                    let zMerged = wRef * (sumZ / sumW) + (1.0 - wRef) * zBoxBottom;
                    // Kẹp an toàn vật lý: không bao giờ lệch quá 10cm so với đáy xe
                    p.zc = Math.max(zBoxBottom - 0.10, Math.min(zBoxBottom + 0.10, zMerged));
                }
            }
        }

        const elapsedMs = ((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0;
        return {
            patches,
            egoPatch,
            anchorsCount: anchors.length,
            boxSignature: this.kyHieuBoxes(boxes),
            _flat: flat,
            _count: count,
            elapsedMs
        };
    }

    static capNhat(prevData, boxes) {
        if (!prevData || !prevData._flat) return null;
        return this.xayDung({ flatArray: prevData._flat, count: prevData._count }, boxes);
    }

    /**
     * Mượn và thích ứng mặt phẳng mặt đường từ frame khác (như liveFrame F0) sang frame này
     * khi frame này chưa nạp đủ điểm LiDAR để tính độc lập.
     */
    static muonLocalPatches(refLocalData, boxes = [], targetFrame = null) {
        if (!refLocalData) return null;
        if (!boxes || boxes.length === 0) return refLocalData;

        const anchors = [];
        if (refLocalData.egoPatch) anchors.push(refLocalData.egoPatch);
        if (Array.isArray(refLocalData.patches)) {
            for (const p of refLocalData.patches) {
                if (p.status === 'anchor' || p.status === 'ego') anchors.push(p);
            }
        }
        if (anchors.length === 0 && Array.isArray(refLocalData.patches) && refLocalData.patches.length > 0) {
            anchors.push(...refLocalData.patches);
        }

        const patches = [];
        for (let i = 0; i < boxes.length; i++) {
            const car = this._docBox(boxes[i], i);
            if (!car) continue;

            // [TIER 1 SOTA SE(2) GLOBAL ATLAS]: Tra cứu trực tiếp từ Bản Đồ Mặt Đường Tĩnh Đa Frame
            let atlasPatch = null;
            if (targetFrame !== null && typeof window !== 'undefined' && window._globalGroundAtlas && window._globalGroundAtlas.isInitialized) {
                atlasPatch = window._globalGroundAtlas.traCuuMatDuongChoXe(car, targetFrame);
            }

            if (atlasPatch) {
                patches.push({
                    id: car.id,
                    isEgo: false,
                    x: car.x,
                    y: car.y,
                    zBox: car.z,
                    rz: car.rz,
                    L: car.L,
                    W: car.W,
                    H: car.H,
                    cosRz: car.cosRz,
                    sinRz: car.sinRz,
                    zc: atlasPatch.zc,
                    gx: atlasPatch.gx,
                    gy: atlasPatch.gy,
                    normal: atlasPatch.normal,
                    sigmaZ: 0.015,
                    nPts: 30,
                    activeQuads: 4,
                    confidence: atlasPatch.confidence,
                    status: 'anchor', // Nâng cấp thành Anchor từ bản đồ SE(2) toàn Job!
                    source: 'se2_atlas',
                    refSources: atlasPatch.atlasSources || []
                });
                continue;
            }

            let bestA = null, bestD2 = Infinity;
            for (const a of anchors) {
                const d2 = (a.x - car.x) * (a.x - car.x) + (a.y - car.y) * (a.y - car.y);
                if (d2 < bestD2) { bestD2 = d2; bestA = a; }
            }
            const a = bestA || refLocalData.egoPatch;
            const zBoxBottom = car.z - 0.5 * car.H;
            const dist = Math.sqrt(bestD2);

            // [SLOPE SHRINKAGE & HYBRID SEMANTIC PRIOR]:
            // Càng ra xa Anchor, độ dốc càng co cụm về 0 và cao độ càng khóa chặt vào đáy xe
            const decay = Math.exp(-Math.min(dist, 60.0) / 15.0);
            const rawSlopeZ = a ? (a.gx * (car.x - a.x) + a.gy * (car.y - a.y)) : 0;
            const effSlopeZ = Math.max(-0.10, Math.min(0.10, rawSlopeZ * decay));
            const zExtrapolate = a ? (a.zc + effSlopeZ) : zBoxBottom;

            // Hòa trộn Soft-Weight: gần (< 10m) tin Anchor, xa (> 25m) tin đáy xe
            const wAnchor = Math.exp(-Math.min(dist, 50.0) / 12.0);
            let zPred = a ? (wAnchor * zExtrapolate + (1.0 - wAnchor) * zBoxBottom) : zBoxBottom;

            // Kẹp an toàn vật lý: Bánh xe không thể lơ lửng trên không hay chìm dưới đất quá 10cm
            zPred = Math.max(zBoxBottom - 0.10, Math.min(zBoxBottom + 0.10, zPred));

            const gxEff = (a ? a.gx : 0) * decay;
            const gyEff = (a ? a.gy : 0) * decay;
            const invNorm = 1.0 / Math.sqrt(gxEff * gxEff + gyEff * gyEff + 1.0);

            patches.push({
                id: car.id,
                isEgo: false,
                x: car.x,
                y: car.y,
                zBox: car.z,
                rz: car.rz,
                L: car.L,
                W: car.W,
                H: car.H,
                cosRz: car.cosRz,
                sinRz: car.sinRz,
                zc: zPred,
                gx: gxEff,
                gy: gyEff,
                normal: [-gxEff * invNorm, -gyEff * invNorm, invNorm],
                sigmaZ: 0,
                nPts: 0,
                activeQuads: 0,
                confidence: a ? Math.min(0.65, a.confidence * 0.9) : 0.5,
                status: 'reference',
                refSources: []
            });
        }

        return {
            patches,
            egoPatch: refLocalData.egoPatch,
            anchorsCount: anchors.length,
            boxSignature: this.kyHieuBoxes(boxes),
            _flat: refLocalData._flat || null,
            _count: refLocalData._count || 0,
            borrowed: true
        };
    }

    static evalPatchZ(patch, x, y) {
        return patch.zc + patch.gx * (x - patch.x) + patch.gy * (y - patch.y);
    }

    static timPatchGanNhat(data, cx, cy) {
        if (!data || !data.patches) return data?.egoPatch || null;
        let best = null;
        let bestD2 = Infinity;
        for (let i = 0; i < data.patches.length; i++) {
            const p = data.patches[i];
            const d2 = (p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy);
            if (d2 < bestD2) {
                bestD2 = d2;
                best = p;
            }
        }
        if (best && bestD2 <= 36.0) return best; // khớp xe trong bán kính 6m
        return data.egoPatch || best;
    }

    static layMatDuongChoBox(data, cx, cy) {
        const p = this.timPatchGanNhat(data, cx, cy);
        if (!p) return null;
        const zRoad = this.evalPatchZ(p, cx, cy);
        return {
            zRoad,
            z: zRoad,
            normal: p.normal,
            slopeX: p.gx,
            slopeY: p.gy,
            gx: p.gx,
            gy: p.gy,
            rx: p.gy,
            ry: -p.gx,
            source: p.status,
            confidence: p.confidence,
            valid: true,
            patch: p
        };
    }

    static evalLocalW(data, qx, qy, carBox, u, v) {
        if (!data) return null;
        const sp = carBox?.shape?.points || carBox?.points || (Array.isArray(carBox) ? carBox : null);
        if (!sp || sp.length < 6) return null;

        const bx = sp[0], by = sp[1], bz = sp[2];
        const rx = sp[3] || 0, ry = sp[4] || 0, rz = sp[5] || 0;
        const R = this.eulerXYZToMatrix(rx, ry, rz);
        const aAxis = [R[0][0], R[1][0], R[2][0]];
        const bAxis = [R[0][1], R[1][1], R[2][1]];
        const cAxis = [R[0][2], R[1][2], R[2][2]];

        const qX = (qx !== null && qx !== undefined) ? qx : (bx + (u || 0) * aAxis[0] + (v || 0) * bAxis[0]);
        const qY = (qy !== null && qy !== undefined) ? qy : (by + (u || 0) * aAxis[1] + (v || 0) * bAxis[1]);
        const qZ = bz + (u || 0) * aAxis[2] + (v || 0) * bAxis[2];

        const p = this.timPatchGanNhat(data, bx, by);
        if (!p) return null;
        let zBase = this.evalPatchZ(p, qX, qY);
        
        // [FAIL-SAFE GROUND GUARD]: Mặt đường dưới gầm xe BẮT BUỘC phải tiếp xúc đáy xe
        // Không một xe ô tô nào có mặt đất nằm cao hơn đáy xe > 8cm (chống bắt nhầm sàn/thân xe)
        const Hbox = sp.length > 8 && Number.isFinite(sp[8]) ? sp[8] : (p.H || 1.6);
        const zBoxBot = bz - 0.5 * Hbox;
        if (Math.abs(zBase - zBoxBot) > 0.08) {
            zBase = Math.max(zBoxBot - 0.08, Math.min(zBoxBot + 0.08, zBase));
        }
        let denom = cAxis[2] - p.gx * cAxis[0] - p.gy * cAxis[1];
        if (Math.abs(denom) < 0.2) denom = cAxis[2] >= 0 ? 1 : -1;
        return {
            w: (zBase - qZ) / denom,
            zBase,
            slopeX: p.gx,
            slopeY: p.gy,
            source: p.status,
            patchId: p.id
        };
    }
}

if (typeof window !== 'undefined') window.ThuatToanSurfaceCucBo = ThuatToanSurfaceCucBo;
if (typeof globalThis !== 'undefined') globalThis.ThuatToanSurfaceCucBo = ThuatToanSurfaceCucBo;
