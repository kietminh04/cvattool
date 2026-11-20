/**
 * Neo Duyệt (Approved Ground & Geometry Anchors)
 * Module dùng chung toán học điểm neo từ các ID đã duyệt (và duyệt tạm scoped):
 * - Tạo mặt phẳng đáy từ cuboid CVAT (tính cả pitch/roll theo Euler XYZ).
 * - SDF footprint + làm mượt C^1 biên 1.0m + lan truyền phần dư Gaussian ra vùng thưa/xa.
 * - Khi chưa có ID duyệt nào (hoặc khoDuyet.batNeo === false), mọi hàm là no-op bit-exact.
 */
class NeoDuyet {
    static CONFIG = {
        Rf: 1.0,            // vành mờ chuyển tiếp C^1 quanh footprint (m)
        Rinf: 8.0,          // tầm ảnh hưởng mềm quanh footprint (m)
        d0: 1.5,            // tham số làm phẳng Shepard 1/(d^2 + d0^2) (m)
        Rp: 5.0,            // bán kính kẹp ngoại suy độ dốc tính từ tâm neo (m)
        slopeCap: 0.06,     // kẹp độ dốc mặt phẳng neo (<= ~3.4°) khi suy diễn vùng gần
        WsoftMin: 0.20,     // ngưỡng Wsoft tối thiểu để trả NEO_MEM ở vùng khuyết LiDAR
        sigmaProp0: 8.0,    // bán kính lan truyền phần dư cơ sở (m)
        kappa0: 0.15,       // prior kéo phần dư về 0 ở quá xa neo
        maxResidual: 2.50,  // kẹp phần dư tối đa (m) đủ phủ dốc ±2.5m nhưng chặn outlier >2.5m
        flatDeg: 0.3,       // dưới 0.3° coi như đáy phẳng
        maxTiltDeg: 15.0,   // trên 15° coi như xoay bất thường -> ép phẳng
        sigmaEgo: 0.05,
        sigmaApproved: 0.02,
        sigmaTemp: 0.04,
        maxAnchors: 64
    };

    static _getKho(opts = null) {
        if (opts && opts.khoDuyet) return opts.khoDuyet;
        if (typeof window !== 'undefined' && window.khoDuyet) return window.khoDuyet;
        if (typeof globalThis !== 'undefined' && globalThis.khoDuyet) return globalThis.khoDuyet;
        return null;
    }

    /**
     * Cột thứ 3 (trục Z cục bộ hướng lên của cuboid) theo chuẩn Euler XYZ (R = Rx * Ry * Rz),
     * đồng nhất 100% với ThuatToanSurface.eulerXYZToMatrix(rx, ry, rz). Không phụ thuộc rz.
     */
    static cotZ(rx = 0, ry = 0) {
        const sx = Math.sin(rx), cX = Math.cos(rx);
        const sy = Math.sin(ry), cY = Math.cos(ry);
        return [sy, -sx * cY, cX * cY];
    }

    /**
     * Tính mặt phẳng đáy cuboid theo chuẩn Euler XYZ của CVAT (cùng hệ eulerXYZToMatrix).
     * Quy ước:
     * - Pb = C - (H/2)*n là tâm hình học của mặt đáy hộp (Pb.z = cz - (H/2)*c2).
     * - z(x, y) = zb + a*(x - cx) + b*(y - cy) là mặt phẳng chứa Pb với pháp tuyến n = [nx, ny, nz]:
     *   gx = a = -nx / nz, gy = b = -ny / nz, và zb = z(cx, cy) = cz - (H/2) / nz.
     */
    static matPhangDay(boxOrPts) {
        if (!boxOrPts) return null;
        let cx, cy, cz, rx = 0, ry = 0, rz = 0, L = 4.5, W = 1.9, H = 1.6;
        if (Array.isArray(boxOrPts)) {
            if (boxOrPts.length < 9) return null;
            [cx, cy, cz, rx, ry, rz, L, W, H] = boxOrPts;
        } else if (Array.isArray(boxOrPts.points) && boxOrPts.points.length >= 9) {
            [cx, cy, cz, rx, ry, rz, L, W, H] = boxOrPts.points;
        } else {
            cx = Number.isFinite(boxOrPts.cx) ? boxOrPts.cx : boxOrPts.x;
            cy = Number.isFinite(boxOrPts.cy) ? boxOrPts.cy : boxOrPts.y;
            cz = Number.isFinite(boxOrPts.cz) ? boxOrPts.cz : boxOrPts.z;
            rx = boxOrPts.rx || 0;
            ry = boxOrPts.ry || 0;
            rz = boxOrPts.rz || 0;
            L = boxOrPts.L || 4.5;
            W = boxOrPts.W || 1.9;
            H = boxOrPts.H || 1.6;
        }
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || !Number.isFinite(H) || H <= 0) {
            return null;
        }
        const flatRad = (this.CONFIG.flatDeg * Math.PI) / 180.0;
        if (Math.abs(rx) < flatRad && Math.abs(ry) < flatRad) {
            return { cx, cy, rz: rz || 0, L, W, H, zb: cz - H * 0.5, a: 0, b: 0 };
        }
        const [nx, ny, nz] = this.cotZ(rx, ry);
        const maxSlope = Math.tan((this.CONFIG.maxTiltDeg * Math.PI) / 180.0);
        if (!Number.isFinite(nz) || nz < 0.5) {
            return { cx, cy, rz: rz || 0, L, W, H, zb: cz - H * 0.5, a: 0, b: 0 };
        }
        const a = -nx / nz;
        const b = -ny / nz;
        if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > maxSlope || Math.abs(b) > maxSlope) {
            return { cx, cy, rz: rz || 0, L, W, H, zb: cz - H * 0.5, a: 0, b: 0 };
        }
        const zb = cz - (H * 0.5) / nz;
        return { cx, cy, rz: rz || 0, L, W, H, zb, a, b };
    }

    /**
     * Khoảng cách có dấu (SDF) từ (x, y) tới hình chữ nhật đáy (cx, cy, rz, L, W).
     * d <= 0 nghĩa là nằm bên trong footprint; d > 0 là khoảng cách Euclid tới mép gần nhất.
     */
    static khoangCachChan(x, y, anchor) {
        if (!anchor || anchor.kind === 'ego' || anchor.L <= 0 || anchor.W <= 0) {
            return Math.hypot(x - (anchor?.cx || 0), y - (anchor?.cy || 0));
        }
        const dx = x - anchor.cx;
        const dy = y - anchor.cy;
        const c = anchor._cosR !== undefined ? anchor._cosR : Math.cos(anchor.rz || 0);
        const s = anchor._sinR !== undefined ? anchor._sinR : Math.sin(anchor.rz || 0);
        const u = c * dx + s * dy;
        const v = -s * dx + c * dy;
        const qx = Math.abs(u) - anchor.L * 0.5;
        const qy = Math.abs(v) - anchor.W * 0.5;
        const mx = qx > 0 ? qx : 0;
        const my = qy > 0 ? qy : 0;
        const outD = Math.hypot(mx, my);
        const inD = Math.min(Math.max(qx, qy), 0);
        return outD + inD;
    }

    static thuThapNeo(allTracks, frame, egoPlane = null, opts = {}) {
        const cfg = this.CONFIG;
        const fn = Number(frame);
        const out = [];

        if (egoPlane && Number.isFinite(egoPlane.z0)) {
            out.push({
                kind: 'ego',
                trackId: '__EGO__',
                frame: fn,
                cx: 0,
                cy: 0,
                rz: 0,
                L: 0,
                W: 0,
                _cosR: 1,
                _sinR: 0,
                zb: egoPlane.z0,
                a: Number.isFinite(egoPlane.gx) ? egoPlane.gx : 0,
                b: Number.isFinite(egoPlane.gy) ? egoPlane.gy : 0,
                zbTam: egoPlane.z0,
                sigmaZ: cfg.sigmaEgo
            });
        }

        const kho = this._getKho(opts);
        if (!kho || !kho.batNeo) return out;

        const gomTam = opts.gomTam || null;
        const toiDa = opts.toiDa ?? cfg.maxAnchors;
        const carAnchors = [];

        if (Array.isArray(allTracks) && Number.isFinite(fn)) {
            const exKey = opts.excludeTrackKey ? String(opts.excludeTrackKey) : null;
            const exFrame = opts.excludeFrame !== undefined && opts.excludeFrame !== null ? Number(opts.excludeFrame) : fn;
            for (let i = 0; i < allTracks.length; i++) {
                const tr = allTracks[i];
                if (!tr || !Array.isArray(tr.shapes)) continue;
                const tKey = kho.trackKey(tr);
                if (!tKey) continue;
                if (opts.excludeSelfFrame && exKey && tKey === exKey && fn === exFrame) continue;
                const sh = tr.shapes.find(s => s && Number(s.frame) === fn && !s.outside && Array.isArray(s.points) && s.points.length >= 9);
                if (!sh) continue;

                const isPerm = kho.laDaDuyet(tKey, fn, tr, null);
                const isTemp = !isPerm && gomTam && kho.laDaDuyet(tKey, fn, tr, { gomTam });
                if (!isPerm && !isTemp) continue;

                const plane = this.matPhangDay(sh.points);
                if (!plane) continue;

                carAnchors.push({
                    kind: isPerm ? 'approved' : 'temp',
                    trackId: tKey,
                    frame: fn,
                    cx: plane.cx,
                    cy: plane.cy,
                    rz: plane.rz,
                    L: plane.L,
                    W: plane.W,
                    _cosR: Math.cos(plane.rz),
                    _sinR: Math.sin(plane.rz),
                    zb: plane.zb,
                    a: plane.a,
                    b: plane.b,
                    zbTam: sh.points[2] - (plane.H * 0.5),
                    sigmaZ: isPerm ? cfg.sigmaApproved : cfg.sigmaTemp
                });
            }
        }

        if (Array.isArray(opts.extraTempAnchors) && opts.extraTempAnchors.length > 0) {
            for (const ex of opts.extraTempAnchors) {
                if (!ex || !Number.isFinite(ex.cx) || !Number.isFinite(ex.cy) || !Number.isFinite(ex.zb)) continue;
                const rz = ex.rz || 0;
                carAnchors.push({
                    kind: 'temp',
                    trackId: String(ex.trackId ?? '__TEMP__'),
                    frame: fn,
                    cx: ex.cx,
                    cy: ex.cy,
                    rz,
                    L: ex.L || 4.5,
                    W: ex.W || 1.9,
                    _cosR: Math.cos(rz),
                    _sinR: Math.sin(rz),
                    zb: ex.zb,
                    a: ex.a || 0,
                    b: ex.b || 0,
                    zbTam: ex.zb,
                    sigmaZ: ex.sigmaZ ?? cfg.sigmaTemp
                });
            }
        }

        // Sắp xếp xác định (bất biến theo thứ tự danh sách track)
        carAnchors.sort((u, v) => {
            if (u.kind !== v.kind) return u.kind === 'approved' ? -1 : 1;
            const ru = u.cx * u.cx + u.cy * u.cy;
            const rv = v.cx * v.cx + v.cy * v.cy;
            if (ru !== rv) return ru - rv;
            return u.trackId < v.trackId ? -1 : (u.trackId > v.trackId ? 1 : 0);
        });

        const lim = Math.min(carAnchors.length, Math.max(0, toiDa));
        for (let i = 0; i < lim; i++) out.push(carAnchors[i]);
        return out;
    }

    static datTrangThaiNeo(neoList, nenGocFn = null, opts = {}) {
        const cfg = this.CONFIG;
        const list = Array.isArray(neoList) ? neoList : [];
        const carNeos = [];
        let egoNeo = null;

        for (let i = 0; i < list.length; i++) {
            const n = list[i];
            if (!n || !Number.isFinite(n.zb)) continue;
            if (n.kind === 'ego') {
                egoNeo = n;
                continue;
            }
            const cloned = { ...n };
            if (cloned._cosR === undefined) cloned._cosR = Math.cos(cloned.rz || 0);
            if (cloned._sinR === undefined) cloned._sinR = Math.sin(cloned.rz || 0);

            let zNenK = NaN;
            if (typeof nenGocFn === 'function') {
                try { zNenK = Number(nenGocFn(cloned.cx, cloned.cy)); } catch (e) { zNenK = NaN; }
            }
            const r = Number.isFinite(zNenK) ? (cloned.zb - zNenK) : 0;
            cloned.zNen = zNenK;
            cloned.r = r;
            cloned.lanTruyen = Number.isFinite(zNenK) && Math.abs(r) <= (opts.maxResidual ?? cfg.maxResidual);
            carNeos.push(cloned);
        }

        let egoClone = null;
        if (egoNeo && carNeos.length > 0 && typeof nenGocFn === 'function') {
            let zNen0 = NaN;
            try { zNen0 = Number(nenGocFn(egoNeo.cx, egoNeo.cy)); } catch (e) { zNen0 = NaN; }
            if (Number.isFinite(zNen0)) {
                const rE = egoNeo.zb - zNen0;
                if (Math.abs(rE) >= 1e-9 && Math.abs(rE) <= (opts.maxResidual ?? cfg.maxResidual)) {
                    egoClone = { ...egoNeo, r: rE };
                }
            }
        }

        return {
            coNeoXe: carNeos.length > 0,
            soNeo: carNeos.length,
            carNeos,
            egoNeo: egoClone,
            Rf: opts.Rf ?? cfg.Rf,
            sigmaProp0: opts.sigmaProp0 ?? cfg.sigmaProp0,
            kappa0: opts.kappa0 ?? cfg.kappa0,
            lanTruyenDoDoc: Boolean(opts.lanTruyenDoDoc)
        };
    }

    static zTaiDiem(x, y, zNen, conf = 0.5, neoState = null) {
        if (!neoState || !neoState.coNeoXe || !Number.isFinite(x) || !Number.isFinite(y)) {
            return { z: zNen, conf, nguon: 'NEN', W: 0, dMin: Infinity };
        }
        const cars = neoState.carNeos;
        const Rf = neoState.Rf;
        const cClamped = Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0;
        const sigProp = neoState.sigmaProp0 * (1.0 + 1.5 * (1.0 - cClamped));
        const twoSig2 = 2.0 * sigProp * sigProp;

        let oneMinusW = 1.0;
        let sumAnchW = 0.0;
        let sumAnchZ = 0.0;
        let sumAnchA = 0.0;
        let sumAnchB = 0.0;
        let nInFootprint = 0;
        let dMin = Infinity;

        let sumKappa = neoState.kappa0;
        let sumKappaR = 0.0;
        if (neoState.egoNeo) {
            const dE2 = x * x + y * y;
            const kE = Math.exp(-dE2 / twoSig2) * 0.25;
            sumKappa += kE;
            sumKappaR += kE * neoState.egoNeo.r;
        }

        let zNearest = NaN;
        let aNearest = NaN;
        let bNearest = NaN;
        let sumDistW = 0.0;
        let sumDistZ = 0.0;
        let sumDistA = 0.0;
        let sumDistB = 0.0;

        for (let i = 0; i < cars.length; i++) {
            const k = cars[i];
            const d = this.khoangCachChan(x, y, k);
            if (d < dMin) {
                dMin = d;
                zNearest = k.zb + k.a * (x - k.cx) + k.b * (y - k.cy);
                aNearest = k.a;
                bNearest = k.b;
            }

            let wk = 0;
            if (d <= 0) {
                wk = 1.0;
                nInFootprint++;
            } else if (d < Rf) {
                const t = d / Rf;
                wk = 1.0 - t * t * (3.0 - 2.0 * t);
            }
            if (wk > 0) {
                const zk = k.zb + k.a * (x - k.cx) + k.b * (y - k.cy);
                const invVar = 1.0 / (k.sigmaZ * k.sigmaZ);
                const wv = wk * invVar;
                oneMinusW *= (1.0 - wk);
                sumAnchW += wv;
                sumAnchZ += wv * zk;
                if (Number.isFinite(k.a)) sumAnchA += wv * k.a;
                if (Number.isFinite(k.b)) sumAnchB += wv * k.b;
            }

            if (k.lanTruyen && Number.isFinite(k.r)) {
                const D = d > 0 ? d : 0;
                const priMul = k.kind === 'approved' ? 1.0 : 0.4;
                const kap = Math.exp(-(D * D) / twoSig2) * priMul;
                sumKappa += kap;
                sumKappaR += kap * k.r;
            }

            // Hỗ trợ dự phòng khi caller không truyền zNen (zNen = NaN)
            const Dfb = d > 0 ? d : 0;
            const wFb = Math.exp(-(Dfb * Dfb) / twoSig2) / (k.sigmaZ * k.sigmaZ);
            sumDistW += wFb;
            sumDistZ += wFb * (k.zb + k.a * (x - k.cx) + k.b * (y - k.cy));
            if (Number.isFinite(k.a)) sumDistA += wFb * k.a;
            if (Number.isFinite(k.b)) sumDistB += wFb * k.b;
        }

        const W = Math.max(0, Math.min(1, 1.0 - oneMinusW));
        const zAnchorBlend = sumAnchW > 0 ? (sumAnchZ / sumAnchW) : (Number.isFinite(zNearest) ? zNearest : zNen);
        const aAnch = sumAnchW > 0 ? (sumAnchA / sumAnchW) : (sumDistW > 0 ? (sumDistA / sumDistW) : aNearest);
        const bAnch = sumAnchW > 0 ? (sumAnchB / sumAnchW) : (sumDistW > 0 ? (sumDistB / sumDistW) : bNearest);
        const delta = sumKappa > 0 ? (sumKappaR / sumKappa) : 0.0;

        if (!Number.isFinite(zNen)) {
            const zOut = W >= 0.999 ? zAnchorBlend : (sumDistW > 0 ? (sumDistZ / sumDistW) : zAnchorBlend);
            const nguon = nInFootprint > 1 ? 'NEO_CHONG' : (W > 0 ? 'NEO_CUNG' : 'NEO_LAN');
            return { z: zOut, a: aAnch, b: bAnch, conf: Math.max(cClamped, W), nguon, W, dMin, delta };
        }

        const zProp = zNen + (1.0 - cClamped) * delta;
        const zOut = W >= 1.0 - 1e-12
            ? zAnchorBlend
            : (W * zAnchorBlend + (1.0 - W) * zProp);

        let nguon = 'NEN';
        if (nInFootprint > 1) nguon = 'NEO_CHONG';
        else if (W > 0.999) nguon = 'NEO_CUNG';
        else if (W > 0) nguon = 'NEO_BIEN';
        else if (Math.abs(delta) > 1e-6) nguon = 'NEO_LAN';

        return {
            z: zOut,
            a: aAnch,
            b: bAnch,
            conf: Math.max(cClamped, W),
            nguon,
            W,
            dMin,
            delta
        };
    }

    /**
     * Kênh ảnh hưởng mềm (C^\infty) của các neo đã duyệt ra vùng khuyết/lân cận (tầm Rinf = 8m):
     * - 1 neo gần: mặt đất xung quanh tương đồng theo mặt đáy kiểm định (kẹp dốc trong Rp).
     * - Nhiều neo gần: nội suy trọng số Shepard 1/(d^2 + d0^2), càng gần neo nào trọng số càng cao.
     */
    static zMem(x, y, neoState, opts = {}) {
        const invalid = { valid: false, z: NaN, a: 0, b: 0, Wsoft: 0, sigma: Infinity, dMin: Infinity, nNeo: 0 };
        if (!neoState || !neoState.coNeoXe || !Array.isArray(neoState.carNeos) || neoState.carNeos.length === 0) {
            return invalid;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) return invalid;

        const cfg = this.CONFIG;
        const Rf = neoState.Rf ?? cfg.Rf;
        const Rinf = cfg.Rinf;
        const invRinf2 = 1.0 / (Rinf * Rinf);
        const d02 = cfg.d0 * cfg.d0;
        const Rp = cfg.Rp;
        const slopeCap = cfg.slopeCap;
        const maxRange = 2.0 * Rinf;

        const exKey = opts && opts.excludeKey ? String(opts.excludeKey) : null;
        const exTid = opts && opts.excludeTrackId !== undefined && opts.excludeTrackId !== null && opts.excludeTrackId !== ''
            ? String(opts.excludeTrackId)
            : null;

        let sumW = 0.0, sumZ = 0.0, sumA = 0.0, sumB = 0.0;
        let oneMinusSoft = 1.0;
        let oneMinusHard = 1.0;
        let dMin = Infinity;
        let nNeo = 0;
        const samples = neoState.carNeos.length > 1 ? [] : null;

        const cars = neoState.carNeos;
        for (let i = 0; i < cars.length; i++) {
            const k = cars[i];
            if (!k || !Number.isFinite(k.zb)) continue;
            if (exKey && (k._boxKey === exKey || k.trackId === exKey)) continue;
            if (exTid && String(k.trackId) === exTid) continue;

            const rawD = this.khoangCachChan(x, y, k);
            const dk = rawD > 0 ? rawD : 0;
            if (!Number.isFinite(dk) || dk > maxRange) continue;

            const dx = x - k.cx;
            const dy = y - k.cy;
            const r = Math.hypot(dx, dy);
            const s = r > Rp ? (Rp / r) : 1.0;
            const effCap = dk > 3.0 ? Math.min(slopeCap, 0.03) : slopeCap;
            const ak = Math.max(-effCap, Math.min(effCap, Number.isFinite(k.a) ? k.a : 0));
            const bk = Math.max(-effCap, Math.min(effCap, Number.isFinite(k.b) ? k.b : 0));
            let dzSlope = ak * dx * s + bk * dy * s;
            if (dk > 3.0) dzSlope = Math.max(-0.12, Math.min(0.12, dzSlope));
            const zk = k.zb + dzSlope;
            if (!Number.isFinite(zk)) continue;

            const confK = k.kind === 'temp' ? 0.65 : 1.0;
            const wk = confK / (dk * dk + d02);
            const gk = confK * Math.exp(-(dk * dk) * invRinf2);

            let wkHard = 0.0;
            if (rawD <= 0) wkHard = 1.0;
            else if (rawD < Rf) {
                const t = rawD / Rf;
                wkHard = 1.0 - t * t * (3.0 - 2.0 * t);
            }
            oneMinusHard *= (1.0 - wkHard);
            oneMinusSoft *= (1.0 - gk);
            sumW += wk;
            sumZ += wk * zk;
            sumA += wk * ak;
            sumB += wk * bk;
            if (dk < dMin) dMin = dk;
            nNeo++;
            if (samples) samples.push({ wk, zk });
        }

        if (nNeo === 0 || sumW <= 0) return invalid;

        const z = sumZ / sumW;
        const a = sumA / sumW;
        const b = sumB / sumW;
        const WHard = Math.max(0, Math.min(1, 1.0 - oneMinusHard));
        let Wsoft = Math.max(WHard, Math.max(0, Math.min(1, 1.0 - oneMinusSoft)));

        if (opts && opts.zRefTrusted && Number.isFinite(opts.zRef)) {
            const dzG = Math.abs(z - opts.zRef);
            const thrG = 0.10 + 0.03 * dMin;
            if (dzG > thrG) {
                const over = (dzG - thrG) / Math.max(0.10, thrG);
                const att = 1.0 / (1.0 + 2.3 * over * over);
                Wsoft = Math.max(WHard, Wsoft * Math.min(0.30, att));
            }
        }

        let spread = 0.0;
        if (nNeo >= 2 && samples) {
            let varNum = 0.0;
            for (let i = 0; i < samples.length; i++) {
                const dz = samples[i].zk - z;
                varNum += samples[i].wk * dz * dz;
            }
            spread = Math.sqrt(Math.max(0, varNum / sumW));
        }

        const sigBase = (0.03 + 0.015 * Math.max(0, dMin)) / Math.sqrt(Math.max(0.04, Wsoft)) + spread;
        const slopeUnc = Math.hypot(a, b) > 0.005 ? (0.008 * Math.max(0, dMin)) : 0.0;
        const sigma = Math.hypot(sigBase, slopeUnc);
        if (!Number.isFinite(z) || !Number.isFinite(Wsoft) || !Number.isFinite(sigma)) return invalid;

        return { valid: true, z, a, b, Wsoft, sigma, dMin, nNeo };
    }

    /**
     * Tính độ cao neo & sigma gợi ý cho box ngoài tại (x, y) (dùng cho Phase 2 & Căn chỉnh).
     */
    static truyVanNeoChoBox(x, y, zNen, conf, neoState, opts = {}) {
        if (!neoState || !neoState.coNeoXe || !Number.isFinite(x) || !Number.isFinite(y)) {
            return { valid: false, z: NaN, sigma: Infinity, dMin: Infinity, W: 0 };
        }
        const q = this.zTaiDiem(x, y, zNen, conf, neoState);
        const SIGMA_SAN = {
            'HYBRID': 0.04,
            'PATCH': 0.05,
            'PATCH+POLAR': 0.05,
            'POLAR': 0.12,
            'BODY·FLOOR': 0.15,
            'EGO': 0.20,
            'EGO·WARN': 0.30
        };
        const p1Nhan = opts?.p1Nhan || '';
        const p1Flags = Array.isArray(opts?.p1Flags) ? opts.p1Flags : [];
        const hasWeakFlag = p1Flags.includes('OCC') || p1Flags.includes('THIEU_DIEM');
        let sigP = Math.max(Number.isFinite(opts?.p1Sigma) ? opts.p1Sigma : 0, SIGMA_SAN[p1Nhan] ?? 0.20);
        if (hasWeakFlag) sigP *= 1.5;

        const zRefTrusted = Boolean(
            (p1Nhan === 'HYBRID' || p1Nhan === 'PATCH' || p1Nhan === 'PATCH+POLAR')
            && (Number.isFinite(opts?.p1Sigma) ? opts.p1Sigma <= 0.04 : sigP <= 0.05)
            && !p1Flags.includes('OCC')
        );

        const skipMem = Boolean(opts?.p1PolarSoft || opts?.p1Nguon === 'NEO_MEM');
        const m = skipMem
            ? { valid: false }
            : this.zMem(x, y, neoState, {
                excludeKey: opts?.excludeKey,
                excludeTrackId: opts?.excludeTrackId,
                zRef: zNen,
                zRefTrusted
            });

        if (m && m.valid && m.Wsoft > 0 && q.W < 0.999) {
            const isStrongLiDAR = (p1Nhan === 'HYBRID' || p1Nhan === 'PATCH' || p1Nhan === 'PATCH+POLAR') && sigP <= 0.05;
            const outThr = 3.0 * Math.hypot(sigP, m.sigma);
            const isOutlier = isStrongLiDAR && Number.isFinite(zNen) && Math.abs(zNen - m.z) > outThr;
            if (!isOutlier) {
                const isWeakHue = sigP >= 0.12 || p1Nhan === 'EGO·WARN' || p1Nhan === 'BODY·FLOOR' || p1Nhan === 'POLAR';
                const zBase = (isWeakHue && Number.isFinite(zNen)) ? zNen : (Number.isFinite(q.z) ? q.z : zNen);
                const invM2 = 1.0 / Math.max(1e-6, m.sigma * m.sigma);
                const invP2 = Number.isFinite(zBase) ? (1.0 / Math.max(1e-6, sigP * sigP)) : 0.0;
                const lam = invM2 / (invM2 + invP2);
                const zMixed = invP2 > 0 ? ((1.0 - lam) * zBase + lam * m.z) : m.z;
                return {
                    valid: true,
                    z: zMixed,
                    zMem: m.z,
                    a: m.a,
                    b: m.b,
                    sigma: m.sigma,
                    dMin: m.dMin,
                    W: Math.max(q.W, m.Wsoft),
                    Wsoft: m.Wsoft,
                    lambda: lam,
                    nguon: 'NEO_MEM'
                };
            }
        }

        if (!Number.isFinite(q.z) || !Number.isFinite(q.dMin) || q.dMin > 30.0) {
            return { valid: false, z: NaN, sigma: Infinity, dMin: q.dMin, W: q.W };
        }
        const sigma = 0.03 + 0.015 * Math.max(0, q.dMin);
        return {
            valid: true,
            z: q.z,
            a: q.a,
            b: q.b,
            sigma,
            dMin: q.dMin,
            W: q.W,
            nguon: q.nguon
        };
    }
}

if (typeof window !== 'undefined') {
    window.NeoDuyet = NeoDuyet;
}
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    globalThis.NeoDuyet = NeoDuyet;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = NeoDuyet;
}
