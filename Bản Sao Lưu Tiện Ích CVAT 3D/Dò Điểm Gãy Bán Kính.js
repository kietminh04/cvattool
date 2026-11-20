/**
 * Dò Điểm Gãy Bán Kính (Radial Change-Point Detector)
 * Phát hiện dải vật cản hẹp (hàng cây, bó vỉa đứng, dải phân cách) và ranh giới đổi mặt phẳng
 * dọc theo bán kính r trong các ô gốc nghi ngờ, trả về ứng viên nhát cắt (ring | sector) cho CART.
 * Thuần TypedArray + sort số học nên bất biến 100% theo thứ tự điểm/box và không phụ thuộc cz.
 */
class DoDiemGayBanKinh {
    static _scratch = null;

    static _layScratch(totalPts, totalCells) {
        if (!this._scratch) {
            this._scratch = {
                ptsCap: 0,
                cellCap: 0,
                winCap: 0,
                zSorted: new Float32Array(0),
                cellState: new Int8Array(0), // 0: chưa sort, 1: đã sort, -1: trống
                cellZLow: new Float32Array(0),
                cellZHigh: new Float32Array(0),
                cellZP5: new Float32Array(0),
                cellZP95: new Float32Array(0),
                cellDens: new Float32Array(0),
                cellLabel: new Uint8Array(0), // 0: U, 1: W, 2: G0, 3: G1
                winBuf: new Float32Array(1024),
                segCap: 0,
                pS1: new Float64Array(0),
                pSr: new Float64Array(0),
                pSz: new Float64Array(0),
                pSrr: new Float64Array(0),
                pSrz: new Float64Array(0),
                pSzz: new Float64Array(0),
                rList: new Float64Array(64),
                zList: new Float64Array(64),
                riList: new Int32Array(64),
                colHasW: new Uint8Array(32),
                colWMeanR: new Float32Array(32),
                rW: new Int32Array(64), rG0: new Int32Array(64), rG1: new Int32Array(64),
                sW: new Int32Array(32), sG0: new Int32Array(32), sG1: new Int32Array(32),
                ringAreaBySec: new Float64Array(128)
            };
        }
        const s = this._scratch;
        if (s.ptsCap < totalPts) {
            s.ptsCap = Math.max(totalPts, 310000);
            s.zSorted = new Float32Array(s.ptsCap);
        }
        if (s.cellCap < totalCells) {
            s.cellCap = Math.max(totalCells, 16384);
            s.cellState = new Int8Array(s.cellCap);
            s.cellZLow = new Float32Array(s.cellCap);
            s.cellZHigh = new Float32Array(s.cellCap);
            s.cellZP5 = new Float32Array(s.cellCap);
            s.cellZP95 = new Float32Array(s.cellCap);
            s.cellDens = new Float32Array(s.cellCap);
            s.cellLabel = new Uint8Array(s.cellCap);
        }
        return s;
    }

    static _ensureWinBuf(sc, need) {
        if (sc.winCap < need) {
            sc.winCap = Math.max(need, 2048);
            sc.winBuf = new Float32Array(sc.winCap);
        }
        return sc.winBuf;
    }

    static _qSorted(arr, len, q) {
        if (len <= 0) return NaN;
        if (len === 1) return arr[0];
        const pos = Math.max(0, Math.min(1, q)) * (len - 1);
        const lo = Math.floor(pos);
        const hi = Math.ceil(pos);
        return arr[lo] + (pos - lo) * (arr[hi] - arr[lo]);
    }

    /**
     * Khởi tạo ngữ cảnh dùng chung cho 1 frame từ CSR đã dựng trong MatDuongDongTam.
     * Chỉ reset cờ cellState trong [0, nr*ns) (O(nr*ns) ~ vài nghìn byte), sort lười khi cần.
     */
    static taoNguCanh(zs, cellStart, cellCounts, idxSorted, ringEdges, nr, ns, cfg) {
        const nCells = nr * ns;
        const totalKept = cellStart[nCells];
        const sc = this._layScratch(totalKept, nCells);
        sc.cellState.fill(0, 0, nCells);
        const dThetaUnit = (2.0 * Math.PI) / ns;
        if (sc.ringAreaBySec.length < nr) sc.ringAreaBySec = new Float64Array(nr);
        const ringAreaBySec = sc.ringAreaBySec;
        for (let r = 0; r < nr; r++) {
            ringAreaBySec[r] = Math.max(0.02, 0.5 * (ringEdges[r + 1] * ringEdges[r + 1] - ringEdges[r] * ringEdges[r]) * dThetaUnit);
        }
        return {
            zs,
            cellStart,
            cellCounts,
            idxSorted,
            ringEdges,
            ringAreaBySec,
            nr,
            ns,
            cfg,
            sc
        };
    }

    /**
     * Sắp xếp z trong 1 ô (ri, s) duy nhất 1 lần khi ô lần đầu được dò; giữ nguyên bất biến hoán vị.
     */
    static _chuanBiO(ctx, ri, sec) {
        const { ns, zs, cellStart, cellCounts, idxSorted, ringAreaBySec, sc } = ctx;
        const sw = ((sec % ns) + ns) % ns;
        const cid = ri * ns + sw;
        const st = sc.cellState[cid];
        if (st !== 0) return cid;

        const cnt = cellCounts[cid];
        if (cnt <= 0) {
            sc.cellState[cid] = -1;
            sc.cellDens[cid] = 0;
            return cid;
        }
        const a = cellStart[cid];
        const b = a + cnt;
        const sub = sc.zSorted.subarray(a, b);
        let zMn = Infinity, zMx = -Infinity;
        for (let i = 0; i < cnt; i++) {
            const zv = zs[idxSorted[a + i]];
            sub[i] = zv;
            if (zv < zMn) zMn = zv;
            if (zv > zMx) zMx = zv;
        }
        if ((zMx - zMn) >= 0.04 && cnt > 1) {
            sub.sort();
            sc.cellZLow[cid] = this._qSorted(sub, cnt, 0.10);
            sc.cellZHigh[cid] = this._qSorted(sub, cnt, 0.90);
            sc.cellZP5[cid] = this._qSorted(sub, cnt, 0.05);
            sc.cellZP95[cid] = this._qSorted(sub, cnt, 0.95);
        } else {
            const dZ = Math.max(0, zMx - zMn);
            sc.cellZLow[cid] = zMn + 0.10 * dZ;
            sc.cellZHigh[cid] = zMn + 0.90 * dZ;
            sc.cellZP5[cid] = zMn + 0.05 * dZ;
            sc.cellZP95[cid] = zMn + 0.95 * dZ;
        }
        sc.cellDens[cid] = cnt / ringAreaBySec[ri];
        sc.cellState[cid] = 1;
        return cid;
    }

    /**
     * Đo đặc trưng cửa sổ trượt w vòng liên tiếp [ri .. ri + w - 1] trên cột góc sec.
     */
    static cuaSoVach(ctx, riStart, w, sec, rA, rB) {
        const { cellStart, cellCounts, ringEdges, ringAreaBySec, sc } = ctx;
        const riEnd = Math.min(rB, riStart + w);
        let rawTot = 0;
        let areaTot = 0;
        let zMinWin = Infinity;
        let zMaxWin = -Infinity;

        for (let r = riStart; r < riEnd; r++) {
            const cid = this._chuanBiO(ctx, r, sec);
            areaTot += ringAreaBySec[r];
            if (sc.cellState[cid] === 1) {
                const cnt = cellCounts[cid];
                rawTot += cnt;
                const a = cellStart[cid];
                const z0 = sc.zSorted[a];
                const z1 = sc.zSorted[a + cnt - 1];
                if (z0 < zMinWin) zMinWin = z0;
                if (z1 > zMaxWin) zMaxWin = z1;
            }
        }
        if (rawTot < 6 || !Number.isFinite(zMinWin)) return null;
        // Chặn nhanh cửa sổ phẳng: không cần gom/sort winBuf nếu toàn bộ z trong cửa sổ lệch < 0.14 m
        if ((zMaxWin - zMinWin) < Math.min(ctx.cfg.diemGaySpanDense ?? 0.15, 0.14)) return null;

        const zCap = zMinWin + 1.45; // chặn tán cây phía trên khỏi làm phình span
        const winBuf = this._ensureWinBuf(sc, rawTot);
        let nWin = 0;
        for (let r = riStart; r < riEnd; r++) {
            const sw = ((sec % ctx.ns) + ctx.ns) % ctx.ns;
            const cid = r * ctx.ns + sw;
            if (sc.cellState[cid] !== 1) continue;
            const a = cellStart[cid];
            const b = a + cellCounts[cid];
            for (let p = a; p < b; p++) {
                const v = sc.zSorted[p];
                if (v <= zCap) winBuf[nWin++] = v;
            }
        }
        if (nWin < 6) return null;

        const view = winBuf.subarray(0, nWin);
        view.sort();

        const zP5 = this._qSorted(view, nWin, 0.05);
        const zP95 = this._qSorted(view, nWin, 0.95);
        const span = zP95 - zP5;

        // Độ trống tối đa và độ phủ liên tục trong [zP5, zP95] (tránh lệch biên bin khi dịch Z)
        let maxGap = 0;
        let holeSum = 0;
        const fillGap = 0.06;
        let prevZ = NaN;
        for (let i = 0; i < nWin; i++) {
            const v = view[i];
            if (v < zP5) continue;
            if (v > zP95) break;
            if (Number.isFinite(prevZ)) {
                const g = v - prevZ;
                if (g > maxGap) maxGap = g;
                if (g > fillGap) holeSum += (g - fillGap);
            }
            prevZ = v;
        }
        const phu = span > 1e-4 ? Math.max(0, 1.0 - holeSum / Math.max(0.05, span)) : 0;

        // Baseline mật độ từ tối đa 3 ô liền trước trong cùng cột (không cấp phát mảng)
        let d0 = -1, d1 = -1, d2 = -1, pdCnt = 0;
        for (let r = riStart - 1; r >= rA && pdCnt < 3; r--) {
            const cidP = this._chuanBiO(ctx, r, sec);
            if (sc.cellState[cidP] === 1) {
                if (pdCnt === 0) d0 = sc.cellDens[cidP];
                else if (pdCnt === 1) d1 = sc.cellDens[cidP];
                else d2 = sc.cellDens[cidP];
                pdCnt++;
            }
        }
        if (pdCnt === 0) {
            for (let r = riEnd; r < rB && pdCnt < 3; r++) {
                const cidN = this._chuanBiO(ctx, r, sec);
                if (sc.cellState[cidN] === 1) {
                    if (pdCnt === 0) d0 = sc.cellDens[cidN];
                    else if (pdCnt === 1) d1 = sc.cellDens[cidN];
                    else d2 = sc.cellDens[cidN];
                    pdCnt++;
                }
            }
        }
        let baseDens = 1.0;
        if (pdCnt === 1) baseDens = d0;
        else if (pdCnt === 2) baseDens = 0.5 * (d0 + d1);
        else if (pdCnt === 3) {
            baseDens = Math.max(Math.min(d0, d1), Math.min(Math.max(d0, d1), d2));
        }
        const winDens = nWin / Math.max(0.05, areaTot);
        const matDo = winDens / Math.max(0.5, baseDens);
        const rMid = 0.5 * (ringEdges[riStart] + ringEdges[riEnd]);

        return { n: nWin, zP5, zP95, span, maxGap, phu, matDo, rMid };
    }

    /**
     * Detector A: Kiểm tra cửa sổ có phải vách đứng / dải hàng cây nhô cao liên tục.
     */
    static nhanDienVach(win, cfg) {
        if (!win) return false;
        const spanMin = win.matDo >= 2.0 ? (cfg.diemGaySpanDense ?? 0.15) : (cfg.diemGaySpan ?? 0.20);
        const gapMax = Math.max(cfg.diemGayMaxGapBase ?? 0.12, 0.03 * win.rMid);
        const phuMin = cfg.diemGayPhu ?? 0.55;
        return win.span >= spanMin && win.maxGap <= gapMax && win.phu >= phuMin;
    }

    /**
     * Detector B: Phát hiện bậc nhảy cao độ hoặc điểm đổi dốc mặt phẳng dọc theo profile zLow(r).
     * Quy chuẩn tâm (z - zRef, r - rRef) để triệt tiêu sai số float khi dịch toàn cloud theo Z.
     */
    static tachHaiDoan(rArr, zArr, m, sc = null) {
        if (m < 6) return null;
        if (!sc) sc = this._layScratch(0, 0);
        if (sc.segCap < m + 1) {
            sc.segCap = Math.max(m + 1, 64);
            sc.pS1 = new Float64Array(sc.segCap);
            sc.pSr = new Float64Array(sc.segCap);
            sc.pSz = new Float64Array(sc.segCap);
            sc.pSrr = new Float64Array(sc.segCap);
            sc.pSrz = new Float64Array(sc.segCap);
            sc.pSzz = new Float64Array(sc.segCap);
        }
        const pS1 = sc.pS1, pSr = sc.pSr, pSz = sc.pSz;
        const pSrr = sc.pSrr, pSrz = sc.pSrz, pSzz = sc.pSzz;
        const rRef = rArr[0], zRef = zArr[0];
        let s1 = 0, sr = 0, sz = 0, srr = 0, srz = 0, szz = 0;
        pS1[0] = 0; pSr[0] = 0; pSz[0] = 0; pSrr[0] = 0; pSrz[0] = 0; pSzz[0] = 0;
        for (let i = 0; i < m; i++) {
            const r = rArr[i] - rRef, z = zArr[i] - zRef;
            s1 += 1; sr += r; sz += z; srr += r * r; srz += r * z; szz += z * z;
            pS1[i + 1] = s1; pSr[i + 1] = sr; pSz[i + 1] = sz;
            pSrr[i + 1] = srr; pSrz[i + 1] = srz; pSzz[i + 1] = szz;
        }
        const fitSeg = (a, b) => {
            const n = pS1[b] - pS1[a];
            if (n < 3) return null;
            const rr = pSr[b] - pSr[a], zz = pSz[b] - pSz[a];
            const r2 = pSrr[b] - pSrr[a], rz = pSrz[b] - pSrz[a], z2 = pSzz[b] - pSzz[a];
            const mr = rr / n, mz = zz / n;
            const vr = r2 - n * mr * mr;
            const vrz = rz - n * mr * mz;
            const vz = z2 - n * mz * mz;
            const slope = vr > 1e-6 ? vrz / vr : 0;
            const intercept = mz - slope * mr;
            const sse = Math.max(0, vz - slope * vrz);
            return { slope, intercept, sse };
        };

        const full = fitSeg(0, m);
        if (!full) return null;
        const rms1 = Math.sqrt(full.sse / m);
        if (rms1 <= 0.038) return null; // Đã phẳng hoặc dốc đều 1 đường thẳng (ramp/tilt)

        let bestK = -1;
        let bestSse2 = Infinity;
        let bestL = null, bestR = null;
        for (let k = 3; k <= m - 3; k++) {
            const fL = fitSeg(0, k);
            const fR = fitSeg(k, m);
            if (!fL || !fR) continue;
            const sse2 = fL.sse + fR.sse;
            if (sse2 < bestSse2) {
                bestSse2 = sse2;
                bestK = k;
                bestL = fL;
                bestR = fR;
            }
        }
        if (bestK < 0 || !bestL || !bestR) return null;
        if (bestSse2 > 0.45 * full.sse) return null;
        if (Math.sqrt(bestSse2 / m) > 0.038) return null;

        const rBnd = 0.5 * ((rArr[bestK - 1] - rRef) + (rArr[bestK] - rRef));
        const dBac = (bestR.intercept + bestR.slope * rBnd) - (bestL.intercept + bestL.slope * rBnd);
        const dDoc = bestR.slope - bestL.slope;
        if (Math.abs(dBac) < 0.08 && Math.abs(dDoc) < 0.06) return null;

        return { k: bestK, sse1: full.sse, sse2: bestSse2, dBac, dDoc };
    }

    /**
     * Phân nhãn {0:U, 1:W, 2:G0, 3:G1} cho mọi ô trong [rA, rB) x [sA, sB) và tìm nhát cắt Gini tốt nhất.
     * Khi skipDetect=true (nút con đã được nút cha gán nhãn sẵn), bỏ qua quét cửa sổ A/B và chỉ đếm Gini.
     */
    static deXuatCat(ctx, rA, rB, sA, sB, canR, canS, skipDetect = false) {
        const { ns, ringEdges, cellCounts, sc, cfg } = ctx;
        if (!canR && !canS) return null;

        const rSpan = rB - rA;
        const sSpan = sB - sA;
        const minGateH = cfg.stripGateH ?? 0.12;
        if (sc.rList.length < rSpan) {
            sc.rList = new Float64Array(rSpan);
            sc.zList = new Float64Array(rSpan);
            sc.riList = new Int32Array(rSpan);
            sc.rW = new Int32Array(rSpan);
            sc.rG0 = new Int32Array(rSpan);
            sc.rG1 = new Int32Array(rSpan);
        }
        if (sc.colHasW.length < sSpan) {
            sc.colHasW = new Uint8Array(sSpan);
            sc.colWMeanR = new Float32Array(sSpan);
            sc.sW = new Int32Array(sSpan);
            sc.sG0 = new Int32Array(sSpan);
            sc.sG1 = new Int32Array(sSpan);
        }

        let hasW = false, hasG1 = false;
        const colHasW = sc.colHasW;
        const colWMeanR = sc.colWMeanR;
        const rList = sc.rList, zList = sc.zList, riList = sc.riList;
        colHasW.fill(0, 0, sSpan);
        colWMeanR.fill(0, 0, sSpan);

        if (!skipDetect) {
            // Quét nhanh theo từng cột: bỏ qua sort nếu toàn cột phẳng (zMax - zMin < 0.06m)
            const { zs, cellStart, idxSorted } = ctx;
            for (let si = 0; si < sSpan; si++) {
                const s = sA + si;
                const sw = ((s % ns) + ns) % ns;
                let colMin = Infinity, colMax = -Infinity;
                for (let ri = rA; ri < rB; ri++) {
                    const cid = ri * ns + sw;
                    const cnt = cellCounts[cid];
                    if (cnt < 2) {
                        sc.cellLabel[cid] = 0;
                        continue;
                    }
                    sc.cellLabel[cid] = 2; // mặc định G0
                    if (sc.cellState[cid] === 1) {
                        const a = cellStart[cid];
                        const z0 = sc.zSorted[a], z1 = sc.zSorted[a + cnt - 1];
                        if (z0 < colMin) colMin = z0;
                        if (z1 > colMax) colMax = z1;
                    } else {
                        const a = cellStart[cid];
                        for (let p = a; p < a + cnt; p++) {
                            const zv = zs[idxSorted[p]];
                            if (zv < colMin) colMin = zv;
                            if (zv > colMax) colMax = zv;
                        }
                    }
                }
                if (!Number.isFinite(colMin) || (colMax - colMin) < 0.06) continue;

                // Chuẩn bị (sort z) các ô trong cột có biến thiên >= 0.06m
                let zColFloor = Infinity;
                let zColCeil = -Infinity;
                for (let ri = rA; ri < rB; ri++) {
                    const cidF = this._chuanBiO(ctx, ri, s);
                    if (sc.cellState[cidF] === 1 && cellCounts[cidF] >= 2) {
                        if (sc.cellZLow[cidF] < zColFloor) zColFloor = sc.cellZLow[cidF];
                        if (sc.cellZHigh[cidF] > zColCeil) zColCeil = sc.cellZHigh[cidF];
                    }
                }

                // Detector A: trượt cửa sổ dọc theo r (bỏ qua nếu cột phẳng zColCeil - zColFloor < 0.14m)
                if (Number.isFinite(zColFloor) && (zColCeil - zColFloor) >= 0.14) {
                    let r = rA;
                    let wSumR = 0, wCntR = 0;
                    while (r < rB) {
                        const rMid = 0.5 * (ringEdges[r] + ringEdges[Math.min(rB, r + 1)]);
                        const drCell = Math.max(0.10, ringEdges[r + 1] - ringEdges[r]);
                        const drLaser = 0.004 * rMid * rMid + 0.15;
                        const winM = Math.max(0.45, Math.min(1.15, 2.0 * drLaser));
                        const w = Math.max(1, Math.min(rB - r, Math.ceil(winM / drCell)));
                        const win = this.cuaSoVach(ctx, r, w, s, rA, rB);
                        if (this.nhanDienVach(win, cfg)) {
                            const floorRef = Math.min(win.zP5, zColFloor);
                            for (let k = r; k < r + w && k < rB; k++) {
                                const cid = k * ns + sw;
                                if (sc.cellState[cid] !== 1 || cellCounts[cid] < 2) continue;
                                const spanCell = sc.cellZP95[cid] - sc.cellZP5[cid];
                                const stickUp = sc.cellZHigh[cid] - floorRef;
                                if (stickUp >= minGateH || spanCell >= 0.10) {
                                    sc.cellLabel[cid] = 1; // W
                                    hasW = true;
                                    colHasW[si] = 1;
                                    const rc = 0.5 * (ringEdges[k] + ringEdges[k + 1]);
                                    wSumR += rc; wCntR++;
                                }
                            }
                        }
                        r += 1;
                    }
                    if (wCntR > 0) {
                        colWMeanR[si] = wSumR / wCntR;
                    }
                }

                // Detector B: fit 2 đoạn thẳng trên các ô không phải W trong cột s
                let m = 0;
                let zLMin = Infinity, zLMax = -Infinity;
                for (let ri = rA; ri < rB; ri++) {
                    const cid = ri * ns + sw;
                    if (sc.cellLabel[cid] === 2 && cellCounts[cid] >= 3) {
                        const zl = sc.cellZLow[cid];
                        rList[m] = 0.5 * (ringEdges[ri] + ringEdges[ri + 1]);
                        zList[m] = zl;
                        riList[m] = ri;
                        if (zl < zLMin) zLMin = zl;
                        if (zl > zLMax) zLMax = zl;
                        m++;
                    }
                }
                const seg = (m >= 6 && (zLMax - zLMin) >= 0.06) ? this.tachHaiDoan(rList, zList, m, sc) : null;
                if (seg) {
                    const splitRi = riList[seg.k];
                    for (let ri = splitRi; ri < rB; ri++) {
                        const cid = ri * ns + sw;
                        if (sc.cellLabel[cid] === 2) {
                            sc.cellLabel[cid] = 3; // G1
                            hasG1 = true;
                        }
                    }
                }
            }
        } else {
            // Tái dùng nhãn đã gán bởi nút cha: trích xuất colHasW / colWMeanR / hasW / hasG1 trực tiếp
            for (let si = 0; si < sSpan; si++) {
                const sw = (((sA + si) % ns) + ns) % ns;
                let wSumR = 0, wCntR = 0;
                for (let ri = rA; ri < rB; ri++) {
                    const lb = sc.cellLabel[ri * ns + sw];
                    if (lb === 1) {
                        hasW = true;
                        colHasW[si] = 1;
                        wSumR += 0.5 * (ringEdges[ri] + ringEdges[ri + 1]);
                        wCntR++;
                    } else if (lb === 3) {
                        hasG1 = true;
                    }
                }
                if (wCntR > 0) colWMeanR[si] = wSumR / wCntR;
            }
        }

        if (!hasW && !hasG1) return null;

        // Gom histogram tổng [W=1, G0=2, G1=3] theo r và theo s (tái dùng scratch)
        let totW = 0, totG0 = 0, totG1 = 0;
        const rW = sc.rW, rG0 = sc.rG0, rG1 = sc.rG1;
        const sW = sc.sW, sG0 = sc.sG0, sG1 = sc.sG1;
        rW.fill(0, 0, rSpan); rG0.fill(0, 0, rSpan); rG1.fill(0, 0, rSpan);
        sW.fill(0, 0, sSpan); sG0.fill(0, 0, sSpan); sG1.fill(0, 0, sSpan);

        for (let ri = 0; ri < rSpan; ri++) {
            const row = (rA + ri) * ns;
            for (let si = 0; si < sSpan; si++) {
                const sw = (((sA + si) % ns) + ns) % ns;
                const cid = row + sw;
                const lb = sc.cellLabel[cid];
                if (lb === 0) continue;
                const n = cellCounts[cid];
                if (lb === 1) { totW += n; rW[ri] += n; sW[si] += n; }
                else if (lb === 2) { totG0 += n; rG0[ri] += n; sG0[si] += n; }
                else if (lb === 3) { totG1 += n; rG1[ri] += n; sG1[si] += n; }
            }
        }
        const totN = totW + totG0 + totG1;
        if (totN < 12) return null;

        const gini = (w, g0, g1) => {
            const sum = w + g0 + g1;
            if (sum <= 0) return 0;
            const pw = w / sum, p0 = g0 / sum, p1 = g1 / sum;
            return 1.0 - (pw * pw + p0 * p0 + p1 * p1);
        };
        const gRoot = gini(totW, totG0, totG1);
        if (gRoot <= 1e-6) return null;

        let best = null;
        const giniMin = cfg.diemGayGiniMin ?? 0.08;
        const minSidePts = 10;

        if (canR) {
            let lW = 0, lG0 = 0, lG1 = 0;
            for (let ri = 0; ri < rSpan - 1; ri++) {
                lW += rW[ri]; lG0 += rG0[ri]; lG1 += rG1[ri];
                const nL = lW + lG0 + lG1;
                const rW_ = totW - lW, rG0_ = totG0 - lG0, rG1_ = totG1 - lG1;
                const nR = totN - nL;
                if (nL < minSidePts || nR < minSidePts) continue;
                const gain = (gRoot - (nL / totN) * gini(lW, lG0, lG1) - (nR / totN) * gini(rW_, rG0_, rG1_)) / gRoot;
                if (gain >= giniMin && (!best || gain > best.gain)) {
                    best = { truc: 'r', idx: rA + ri + 1, gain };
                }
            }
        }

        if (canS) {
            const sHalf = sSpan >> 1;
            let lW = 0, lG0 = 0, lG1 = 0;
            for (let si = 0; si < sHalf; si++) {
                lW += sW[si]; lG0 += sG0[si]; lG1 += sG1[si];
            }
            const nL = lW + lG0 + lG1;
            const nR = totN - nL;
            if (nL >= minSidePts && nR >= minSidePts) {
                const gain = (gRoot - (nL / totN) * gini(lW, lG0, lG1) - (nR / totN) * gini(totW - lW, totG0 - lG0, totG1 - lG1)) / gRoot;
                // Strictly > best.gain để hòa thì ưu tiên cắt theo r
                if (gain >= giniMin && (!best || gain > best.gain + 1e-9)) {
                    best = { truc: 's', idx: sA + sHalf, gain };
                }
            }
        }

        // Xử lý dải chéo 30°-45°: nếu cả khối rộng sSpan có W ở các bán kính khác nhau giữa 2 nửa L/R
        if (!best && canS && hasW) {
            const sHalf = sSpan >> 1;
            let sumL = 0, cntL = 0, sumR = 0, cntR = 0;
            let nPtsL = 0, nPtsR = 0;
            for (let si = 0; si < sSpan; si++) {
                const nCol = sW[si] + sG0[si] + sG1[si];
                if (si < sHalf) {
                    nPtsL += nCol;
                    if (colHasW[si]) { sumL += colWMeanR[si]; cntL++; }
                } else {
                    nPtsR += nCol;
                    if (colHasW[si]) { sumR += colWMeanR[si]; cntR++; }
                }
            }
            if (nPtsL >= minSidePts && nPtsR >= minSidePts && cntL > 0 && cntR > 0) {
                const dR = Math.abs(sumL / cntL - sumR / cntR);
                if (dR >= 0.35) {
                    best = { truc: 's', idx: sA + sHalf, gain: 0.12 };
                }
            } else if (nPtsL >= minSidePts && nPtsR >= minSidePts && (cntL > 0) !== (cntR > 0)) {
                best = { truc: 's', idx: sA + sHalf, gain: 0.15 };
            }
        }

        return best;
    }
}

if (typeof window !== 'undefined') window.DoDiemGayBanKinh = DoDiemGayBanKinh;
if (typeof globalThis !== 'undefined') globalThis.DoDiemGayBanKinh = DoDiemGayBanKinh;
