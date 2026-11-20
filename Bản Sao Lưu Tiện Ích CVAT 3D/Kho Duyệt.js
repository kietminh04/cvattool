/**
 * Kho Duyệt (Approval Store) — Quản lý trạng thái duyệt ID / Frame (vĩnh viễn & tạm thời)
 * - Lưu bền vững ngoài payload CVAT (RAM + localStorage theo jobId) để tránh lỗi schema PUT.
 * - Mỗi frame duyệt kèm chữ ký hình học FNV-1a (`sig`): sửa box sau duyệt sẽ tự thành `LECH`.
 * - Duyệt tạm thời (`voiTamThoi`) chỉ tồn tại trong 1 phép gọi async (try/finally), không rò sang ID khác hay bản đồ toàn cục.
 */
class KhoDuyet {
    constructor() {
        this.jobId = null;
        this.phienBan = 1;
        this._store = { v: 1, jobId: null, capNhat: null, tracks: {} };
        this._pending = new Map(); // trackKey -> { phamVi: 'track'|'frame', frame: number|null }
        this._listeners = new Set();
        this._tamCtx = null;
        this._tamToken = null;
        this._batNeoOverride = null;
        this._phien = new Map();
        this._storageBound = false;
        this._boundOnStorage = (e) => this._onStorageEvent(e);
    }

    get STORAGE_PREFIX() {
        return 'cvat3d.duyet.v1:';
    }

    get BAT_NEO_KEY() {
        return 'cvat3d.neoDuyet.bat';
    }

    get batNeo() {
        if (this._batNeoOverride !== null) return this._batNeoOverride;
        try {
            if (typeof localStorage !== 'undefined') {
                const v = localStorage.getItem(this.BAT_NEO_KEY);
                if (v === '0' || v === 'false') return false;
            }
        } catch (e) {}
        return true;
    }

    set batNeo(val) {
        const b = Boolean(val);
        this._batNeoOverride = b;
        try {
            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(this.BAT_NEO_KEY, b ? '1' : '0');
            }
        } catch (e) {}
        this._bump('toggle_neo');
    }

    trackKey(trackOrId) {
        if (trackOrId === null || trackOrId === undefined) return null;
        if (typeof trackOrId === 'object') {
            const cand = trackOrId._displayId ?? trackOrId._trackNumber ?? trackOrId._clientID ?? trackOrId.clientID ?? trackOrId.id;
            if (cand === null || cand === undefined || cand === '') return null;
            return String(cand);
        }
        const s = String(trackOrId).trim();
        return s.length > 0 ? s : null;
    }

    sigShape(shape) {
        if (!shape || shape.outside) return '';
        const pts = shape.points;
        if (!Array.isArray(pts) || pts.length < 9) return '';
        const vals = new Array(9);
        for (let i = 0; i < 9; i++) {
            const v = Number(pts[i]);
            if (!Number.isFinite(v)) return '';
            vals[i] = Math.round(v * 1e4);
        }
        const str = vals.join(',');
        // FNV-1a 32-bit hex
        let h = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(16).padStart(8, '0');
    }

    static hopNhatKhoang(intervals) {
        if (!Array.isArray(intervals) || intervals.length === 0) return [];
        const clean = [];
        for (const it of intervals) {
            if (!Array.isArray(it) || it.length < 2) continue;
            let a = Math.trunc(Number(it[0]));
            let b = Math.trunc(Number(it[1]));
            if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) continue;
            if (a > b) { const tmp = a; a = b; b = tmp; }
            clean.push([a, b]);
        }
        if (clean.length === 0) return [];
        clean.sort((x, y) => (x[0] - y[0]) || (x[1] - y[1]));
        const out = [clean[0].slice()];
        for (let i = 1; i < clean.length; i++) {
            const cur = clean[i];
            const last = out[out.length - 1];
            if (cur[0] <= last[1] + 1) {
                if (cur[1] > last[1]) last[1] = cur[1];
            } else {
                out.push(cur.slice());
            }
        }
        return out;
    }

    phanTichKhoang(str) {
        if (Array.isArray(str)) return KhoDuyet.hopNhatKhoang(str);
        if (typeof str !== 'string') return [];
        const cleaned = str.replace(/[\u2013\u2014]/g, '-').trim();
        if (!cleaned) return [];
        const parts = cleaned.split(/[,;]+/);
        const raw = [];
        for (const p of parts) {
            const tok = p.trim();
            if (!tok) continue;
            const mRange = tok.match(/^(\d+)\s*-\s*(\d+)$/);
            if (mRange) {
                const a = parseInt(mRange[1], 10);
                const b = parseInt(mRange[2], 10);
                if (Number.isFinite(a) && Number.isFinite(b) && Math.abs(b - a) <= 50000) {
                    raw.push([Math.min(a, b), Math.max(a, b)]);
                }
                continue;
            }
            const mSingle = tok.match(/^(\d+)$/);
            if (mSingle) {
                const f = parseInt(mSingle[1], 10);
                if (Number.isFinite(f)) raw.push([f, f]);
            }
        }
        return KhoDuyet.hopNhatKhoang(raw);
    }

    _bungKhoangThanhSet(khoangInput) {
        const set = new Set();
        const intervals = this.phanTichKhoang(khoangInput);
        for (const [a, b] of intervals) {
            for (let f = a; f <= b; f++) set.add(f);
        }
        return set;
    }

    _khoangChuaFrame(frList, fn) {
        if (!Array.isArray(frList) || frList.length === 0) return false;
        const f = Number(fn);
        if (!Number.isFinite(f)) return false;
        for (let i = 0; i < frList.length; i++) {
            const iv = frList[i];
            if (f >= iv[0] && f <= iv[1]) return true;
        }
        return false;
    }

    _storageKey(jobId = this.jobId) {
        return `${this.STORAGE_PREFIX}${String(jobId ?? 'default')}`;
    }

    _docTuStorage(jobId) {
        try {
            if (typeof localStorage === 'undefined') return null;
            const raw = localStorage.getItem(this._storageKey(jobId));
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || typeof parsed.tracks !== 'object') return null;
            const normTracks = {};
            for (const [tid, rec] of Object.entries(parsed.tracks)) {
                if (!rec || typeof rec !== 'object') continue;
                normTracks[String(tid)] = {
                    fr: KhoDuyet.hopNhatKhoang(rec.fr || []),
                    sig: (rec.sig && typeof rec.sig === 'object') ? { ...rec.sig } : {},
                    luc: rec.luc || null,
                    ...(rec.suaLuc ? { suaLuc: rec.suaLuc } : {}),
                    ...(Number.isFinite(rec.lanSua) ? { lanSua: rec.lanSua } : {})
                };
            }
            return {
                v: 1,
                jobId: String(jobId),
                capNhat: parsed.capNhat || null,
                tracks: normTracks
            };
        } catch (e) {
            return null;
        }
    }

    _ghiStorage() {
        try {
            if (typeof localStorage === 'undefined' || !this.jobId) return { ok: true };
            this._store.capNhat = new Date().toISOString();
            localStorage.setItem(this._storageKey(this.jobId), JSON.stringify(this._store));
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e };
        }
    }

    _onStorageEvent(e) {
        if (!e || !this.jobId) return;
        if (e.key === this._storageKey(this.jobId)) {
            const loaded = this._docTuStorage(this.jobId);
            this._store = loaded || { v: 1, jobId: String(this.jobId), capNhat: null, tracks: {} };
            this._bump('storage_sync');
        } else if (e.key === this.BAT_NEO_KEY) {
            this._batNeoOverride = null;
            this._bump('storage_neo');
        }
    }

    _bump(reason = 'change') {
        this.phienBan++;
        const payload = { phienBan: this.phienBan, reason, jobId: this.jobId };
        for (const fn of Array.from(this._listeners)) {
            try { fn(payload); } catch (e) { console.warn('[KhoDuyet listener]', e); }
        }
    }

    khoiTao(jobId) {
        const jKey = (jobId !== null && jobId !== undefined && jobId !== '') ? String(jobId) : 'default';
        this.jobId = jKey;
        const loaded = this._docTuStorage(jKey);
        this._store = loaded || { v: 1, jobId: jKey, capNhat: null, tracks: {} };
        this._pending.clear();
        this._phien.clear();
        if (!this._storageBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('storage', this._boundOnStorage);
            this._storageBound = true;
        }
        this._bump('init');
    }

    onThayDoi(fn) {
        if (typeof fn !== 'function') return () => {};
        this._listeners.add(fn);
        return () => { this._listeners.delete(fn); };
    }

    // --- Máy trạng thái thuần ---
    chuyenTrangThai(tt, suKien) {
        switch (suKien) {
            case 'DUYET':
                if (tt === 'CHUA') return { tt: 'CHO', hanhDong: ['dat_cho'] };
                if (tt === 'CHO') return { tt: 'CHUA', hanhDong: ['bo_cho'] };
                if (tt === 'DA') return { tt: 'CHUA', hanhDong: ['xac_nhan_huy'] };
                if (tt === 'LECH') return { tt: 'CHO', hanhDong: ['dat_cho'] };
                return { tt, hanhDong: [] };
            case 'LUU_OK':
                if (tt === 'CHO') return { tt: 'DA', hanhDong: ['chot_duyet'] };
                return { tt, hanhDong: [] };
            case 'LUU_ERR':
                return { tt, hanhDong: ['bao_loi'] };
            case 'DONG_MODAL':
            case 'DOI_TRACK':
            case 'RELOAD':
                if (tt === 'CHO') return { tt: 'CHUA', hanhDong: ['huy_cho'] };
                return { tt, hanhDong: [] };
            case 'SUA_HOP':
                if (tt === 'DA') return { tt: 'LECH', hanhDong: ['mat_hieu_luc_tam'] };
                return { tt, hanhDong: [] };
            case 'SUA_LAI_KHOP':
                if (tt === 'LECH') return { tt: 'DA', hanhDong: ['khoi_phuc_da'] };
                return { tt, hanhDong: [] };
            case 'HUY_DUYET':
                return { tt: 'CHUA', hanhDong: ['huy_duyet'] };
            default:
                return { tt, hanhDong: [] };
        }
    }

    // --- Chờ Lưu (RAM) ---
    datCho(trackOrId, opts = {}) {
        const key = this.trackKey(trackOrId);
        if (!key) return false;
        const phamVi = opts.phamVi === 'frame' ? 'frame' : 'track';
        const frame = (phamVi === 'frame' && Number.isFinite(Number(opts.frame))) ? Number(opts.frame) : null;
        this._pending.set(key, { phamVi, frame });
        return true;
    }

    boCho(trackOrId = null) {
        if (trackOrId === null || trackOrId === undefined) {
            const had = this._pending.size > 0;
            this._pending.clear();
            return had;
        }
        const key = this.trackKey(trackOrId);
        return key ? this._pending.delete(key) : false;
    }

    dangCho(trackOrId) {
        const key = this.trackKey(trackOrId);
        return key ? this._pending.has(key) : false;
    }

    layCho(trackOrId) {
        const key = this.trackKey(trackOrId);
        return key ? (this._pending.get(key) || null) : null;
    }

    // --- Truy vấn trạng thái ---
    laDaDuyet(trackOrId, frame, track = null, opts = null) {
        const key = this.trackKey(trackOrId);
        if (!key) return false;
        const fn = Number(frame);
        if (!Number.isFinite(fn)) return false;

        // 1. Kiểm tra duyệt vĩnh viễn
        const rec = this._store.tracks[key];
        if (rec && this._khoangChuaFrame(rec.fr, fn)) {
            const savedSig = rec.sig ? rec.sig[String(fn)] : null;
            if (savedSig) {
                if (track && Array.isArray(track.shapes)) {
                    const sh = track.shapes.find(s => s && Number(s.frame) === fn);
                    if (!sh || sh.outside) return false;
                    if (this.sigShape(sh) === savedSig) return true;
                } else {
                    return true;
                }
            }
        }

        // 2. Duyệt tạm thời: chỉ thấy khi opts.gomTam mang đúng token đang chạy voiTamThoi
        if (opts && opts.gomTam && this._tamCtx && opts.gomTam === this._tamCtx && opts.gomTam.token === this._tamToken) {
            if (String(this._tamCtx.trackKey) === key && this._tamCtx.frames.has(fn)) {
                if (track && Array.isArray(track.shapes)) {
                    const sh = track.shapes.find(s => s && Number(s.frame) === fn);
                    return Boolean(sh && !sh.outside && Array.isArray(sh.points) && sh.points.length >= 9);
                }
                return true;
            }
        }
        return false;
    }

    dsFrameDaDuyet(trackOrId, track = null, opts = null) {
        const key = this.trackKey(trackOrId);
        if (!key) return [];
        const candSet = new Set();
        const rec = this._store.tracks[key];
        if (rec && Array.isArray(rec.fr)) {
            for (const [a, b] of rec.fr) {
                for (let f = a; f <= b; f++) candSet.add(f);
            }
        }
        if (opts && opts.gomTam && this._tamCtx && opts.gomTam === this._tamCtx && opts.gomTam.token === this._tamToken && String(this._tamCtx.trackKey) === key) {
            for (const f of this._tamCtx.frames) candSet.add(f);
        }
        const out = [];
        for (const f of candSet) {
            if (this.laDaDuyet(key, f, track, opts)) out.push(f);
        }
        out.sort((a, b) => a - b);
        return out;
    }

    trangThaiTrack(track, focusFrame = null) {
        const key = this.trackKey(track);
        const pending = key ? (this._pending.get(key) || null) : null;
        if (!key) return { tt: 'CHUA', approvedCount: 0, driftedCount: 0, totalValid: 0, pending: null };

        const validShapes = (track && Array.isArray(track.shapes))
            ? track.shapes.filter(s => s && !s.outside && Array.isArray(s.points) && s.points.length >= 9)
            : [];
        const rec = this._store.tracks[key];
        let approvedCount = 0;
        let driftedCount = 0;
        if (rec) {
            for (const s of validShapes) {
                const fn = Number(s.frame);
                if (!this._khoangChuaFrame(rec.fr, fn)) continue;
                const savedSig = rec.sig ? rec.sig[String(fn)] : null;
                if (!savedSig) continue;
                if (this.sigShape(s) === savedSig) approvedCount++;
                else driftedCount++;
            }
        }

        if (pending) {
            return { tt: 'CHO', approvedCount, driftedCount, totalValid: validShapes.length, pending };
        }
        if (driftedCount > 0) {
            if (focusFrame !== null && Number.isFinite(Number(focusFrame))) {
                const fn = Number(focusFrame);
                const shF = validShapes.find(s => Number(s.frame) === fn);
                const sSig = rec?.sig?.[String(fn)];
                if (shF && rec && this._khoangChuaFrame(rec.fr, fn) && sSig && this.sigShape(shF) !== sSig) {
                    return { tt: 'LECH', approvedCount, driftedCount, totalValid: validShapes.length, pending: null };
                }
            }
            if (approvedCount === 0) {
                return { tt: 'LECH', approvedCount, driftedCount, totalValid: validShapes.length, pending: null };
            }
            return { tt: 'LECH', approvedCount, driftedCount, totalValid: validShapes.length, pending: null };
        }
        if (approvedCount > 0) {
            return { tt: 'DA', approvedCount, driftedCount: 0, totalValid: validShapes.length, pending: null };
        }
        return { tt: 'CHUA', approvedCount: 0, driftedCount: 0, totalValid: validShapes.length, pending: null };
    }

    // --- Chốt & Hủy duyệt vĩnh viễn ---
    chotDuyet(trackOrId, track, opts = { phamVi: 'track', frame: null }) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        if (!key || !track || !Array.isArray(track.shapes)) return { ok: false, count: 0 };

        const phamVi = opts?.phamVi === 'frame' ? 'frame' : 'track';
        const targetFrame = Number(opts?.frame);
        const existing = this._store.tracks[key] || { fr: [], sig: {}, luc: null };
        const newIntervals = [...(existing.fr || [])];
        const newSig = { ...(existing.sig || {}) };

        let count = 0;
        for (const s of track.shapes) {
            if (!s || s.outside) continue;
            const fn = Number(s.frame);
            if (!Number.isFinite(fn)) continue;
            if (phamVi === 'frame' && fn !== targetFrame) continue;
            const sig = this.sigShape(s);
            if (!sig) continue;
            newIntervals.push([fn, fn]);
            newSig[String(fn)] = sig;
            count++;
        }

        if (count === 0) return { ok: false, count: 0 };

        this._store.tracks[key] = {
            fr: KhoDuyet.hopNhatKhoang(newIntervals),
            sig: newSig,
            luc: new Date().toISOString()
        };
        this._pending.delete(key);
        const persist = this._ghiStorage();
        this._bump('chot_duyet');
        return { ok: true, count, storageOk: persist.ok };
    }

    huyDuyet(trackOrId, opts = {}) {
        const key = this.trackKey(trackOrId);
        if (!key) return false;
        this._pending.delete(key);
        const rec = this._store.tracks[key];
        if (!rec) {
            return false;
        }
        const fOpt = opts && opts.frame !== undefined && opts.frame !== null ? Number(opts.frame) : null;
        if (fOpt === null || !Number.isFinite(fOpt)) {
            delete this._store.tracks[key];
        } else {
            const expanded = [];
            for (const [a, b] of (rec.fr || [])) {
                if (fOpt < a || fOpt > b) {
                    expanded.push([a, b]);
                } else {
                    if (fOpt > a) expanded.push([a, fOpt - 1]);
                    if (fOpt < b) expanded.push([fOpt + 1, b]);
                }
            }
            if (rec.sig) delete rec.sig[String(fOpt)];
            const merged = KhoDuyet.hopNhatKhoang(expanded);
            if (merged.length === 0) delete this._store.tracks[key];
            else rec.fr = merged;
        }
        this._ghiStorage();
        if (this._phien.has(key)) {
            const ph = this._phien.get(key);
            if (fOpt === null || !Number.isFinite(fOpt)) {
                this._phien.delete(key);
            } else {
                ph.frDuyetGoc.delete(fOpt);
                ph.frLechGoc.delete(fOpt);
                if (ph.frDuyetGoc.size === 0) this._phien.delete(key);
            }
        }
        this._bump('huy_duyet');
        return true;
    }

    // --- Mở khóa chỉnh sửa chủ động trong phiên Modal (giữ trạng thái Đã duyệt) ---
    laKhoaChoSua(trackOrId, frame, track = null, opts = null) {
        if (!this.batNeo) return false;
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        if (!key) return false;
        if (opts && opts.trackKeysMoKhoa && opts.trackKeysMoKhoa.has(key)) return false;
        return this.laDaDuyet(key, frame, track, opts);
    }

    moPhien(trackOrId, track) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        if (!key || !track || !Array.isArray(track.shapes)) return null;
        const rec = this._store.tracks[key];
        if (!rec || !Array.isArray(rec.fr) || rec.fr.length === 0) return null;

        const frDuyetGoc = new Set();
        const frLechGoc = new Set();
        const snapshot = new Map();

        for (const s of track.shapes) {
            if (!s || s.frame === undefined) continue;
            const fn = Number(s.frame);
            if (!Number.isFinite(fn)) continue;
            if (Array.isArray(s.points) && s.points.length >= 9) {
                snapshot.set(fn, {
                    points: [...s.points],
                    outside: Boolean(s.outside),
                    rotation: Array.isArray(s.rotation) ? [...s.rotation] : s.rotation
                });
            }
            if (!this._khoangChuaFrame(rec.fr, fn)) continue;
            const savedSig = rec.sig ? rec.sig[String(fn)] : null;
            if (!savedSig) continue;
            if (!s.outside && Array.isArray(s.points) && s.points.length >= 9 && this.sigShape(s) === savedSig) {
                frDuyetGoc.add(fn);
            } else {
                frLechGoc.add(fn);
            }
        }
        if (frDuyetGoc.size === 0) return null;

        const phien = {
            key,
            jobId: this.jobId,
            frDuyetGoc,
            frLechGoc,
            snapshot,
            dirty: false
        };
        this._phien.set(key, phien);
        return phien;
    }

    layPhien(trackOrId) {
        const key = this.trackKey(trackOrId);
        return key ? (this._phien.get(key) || null) : null;
    }

    danhDauBan(trackOrId, track = null) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        if (!key) return false;
        const ph = this._phien.get(key);
        if (!ph) return false;
        ph.dirty = true;
        return true;
    }

    capNhatDirtyTuTrack(trackOrId, track) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        const ph = key ? this._phien.get(key) : null;
        if (!ph || !track || !Array.isArray(track.shapes)) return false;
        let isDirty = false;
        for (const s of track.shapes) {
            if (!s || s.frame === undefined) continue;
            const fn = Number(s.frame);
            const snap = ph.snapshot.get(fn);
            if (!snap) {
                if (!s.outside && Array.isArray(s.points) && s.points.length >= 9) { isDirty = true; break; }
                continue;
            }
            if (Boolean(s.outside) !== snap.outside) { isDirty = true; break; }
            if (!Array.isArray(s.points) || s.points.length < 9) { isDirty = true; break; }
            for (let i = 0; i < 9; i++) {
                if (Math.abs(Number(s.points[i]) - Number(snap.points[i])) > 1e-6) {
                    isDirty = true;
                    break;
                }
            }
            if (isDirty) break;
        }
        ph.dirty = isDirty;
        return isDirty;
    }

    huyDuyetTrongPhien(trackOrId, frames = null) {
        const key = this.trackKey(trackOrId);
        if (!key) return false;
        const ph = this._phien.get(key);
        if (!ph) return false;
        if (frames === null || frames === undefined) {
            this._phien.delete(key);
            return true;
        }
        const fList = Array.isArray(frames) || frames instanceof Set ? frames : [frames];
        for (const f of fList) ph.frDuyetGoc.delete(Number(f));
        if (ph.frDuyetGoc.size === 0) this._phien.delete(key);
        return true;
    }

    khoiPhucSnapshot(trackOrId, track) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        const ph = key ? this._phien.get(key) : null;
        if (!ph || !track || !Array.isArray(track.shapes)) return false;
        for (const s of track.shapes) {
            if (!s || s.frame === undefined) continue;
            const snap = ph.snapshot.get(Number(s.frame));
            if (snap) {
                s.points = [...snap.points];
                s.outside = snap.outside;
                if (snap.rotation !== undefined) {
                    s.rotation = Array.isArray(snap.rotation) ? [...snap.rotation] : snap.rotation;
                }
            }
        }
        ph.dirty = false;
        this._bump('khoi_phuc_snapshot');
        return true;
    }

    ttHienThi(track, focusFrame = null, opts = null) {
        const key = this.trackKey(track);
        const base = this.trangThaiTrack(track, focusFrame);
        const ph = (opts && opts.phien) || (key ? this._phien.get(key) : null);
        if (!ph || !key) {
            return { ...base, ttHien: base.tt, dirty: false, coPhien: false };
        }
        const dirty = Boolean(ph.dirty);
        if (base.tt !== 'LECH') {
            return { ...base, ttHien: base.tt, dirty, coPhien: true };
        }
        // Kiểm tra tất cả các frame lệch đều nằm trong frDuyetGoc (và không có frLechGoc từ trước)
        const rec = this._store.tracks[key];
        let lechNgoaiGoc = ph.frLechGoc && ph.frLechGoc.size > 0;
        if (!lechNgoaiGoc && rec && Array.isArray(track?.shapes)) {
            for (const s of track.shapes) {
                if (!s || s.outside || !Array.isArray(s.points) || s.points.length < 9) continue;
                const fn = Number(s.frame);
                if (!this._khoangChuaFrame(rec.fr, fn)) continue;
                const savedSig = rec.sig ? rec.sig[String(fn)] : null;
                if (!savedSig) continue;
                if (this.sigShape(s) !== savedSig && !ph.frDuyetGoc.has(fn)) {
                    lechNgoaiGoc = true;
                    break;
                }
            }
        }
        const ttHien = lechNgoaiGoc ? 'LECH' : 'DA_DANG_SUA';
        return { ...base, ttHien, dirty: true, coPhien: true };
    }

    dongBoLaiSig(trackOrId, track) {
        const key = this.trackKey(trackOrId) || this.trackKey(track);
        if (!key || !track || !Array.isArray(track.shapes)) return { ok: false, count: 0 };
        const ph = this._phien.get(key);
        const rec = this._store.tracks[key];
        // Ràng buộc bất biến: chỉ ký lại trên bản ghi rec đã tồn tại và trên tập frDuyetGoc
        if (!ph || !rec || ph.frDuyetGoc.size === 0) return { ok: false, count: 0 };

        const byFrame = new Map();
        for (const s of track.shapes) {
            if (!s || s.frame === undefined) continue;
            byFrame.set(Number(s.frame), s);
        }

        const removedFrames = new Set();
        let count = 0;
        for (const fn of ph.frDuyetGoc) {
            const sh = byFrame.get(fn);
            if (!sh || sh.outside || !Array.isArray(sh.points) || sh.points.length < 9) {
                if (rec.sig) delete rec.sig[String(fn)];
                removedFrames.add(fn);
                continue;
            }
            const sig = this.sigShape(sh);
            if (!sig) continue;
            rec.sig = rec.sig || {};
            rec.sig[String(fn)] = sig;
            count++;
        }

        if (removedFrames.size > 0) {
            const expanded = [];
            for (const [a, b] of (rec.fr || [])) {
                for (let f = a; f <= b; f++) {
                    if (!removedFrames.has(f)) expanded.push([f, f]);
                }
            }
            rec.fr = KhoDuyet.hopNhatKhoang(expanded);
            for (const rf of removedFrames) ph.frDuyetGoc.delete(rf);
            if (rec.fr.length === 0) {
                delete this._store.tracks[key];
            }
        }

        if (this._store.tracks[key]) {
            rec.suaLuc = new Date().toISOString();
            rec.lanSua = (Number(rec.lanSua) || 0) + 1;
        }
        // Làm mới snapshot cho lần sửa tiếp theo nếu phiên vẫn mở
        ph.snapshot.clear();
        for (const s of track.shapes) {
            if (!s || s.frame === undefined || !Array.isArray(s.points) || s.points.length < 9) continue;
            ph.snapshot.set(Number(s.frame), {
                points: [...s.points],
                outside: Boolean(s.outside),
                rotation: Array.isArray(s.rotation) ? [...s.rotation] : s.rotation
            });
        }
        ph.dirty = false;

        const persist = this._ghiStorage();
        this._bump('dong_bo_sig');
        return { ok: true, count, storageOk: persist.ok };
    }

    dongPhien(trackOrId, opts = { luu: false, track: null }) {
        const key = this.trackKey(trackOrId) || this.trackKey(opts?.track);
        if (!key) return false;
        const ph = this._phien.get(key);
        if (!ph) return false;
        if (opts && opts.luu && opts.track) {
            this.dongBoLaiSig(key, opts.track);
        }
        this._phien.delete(key);
        return true;
    }

    // --- Duyệt tạm thời scoped đúng 1 phép suy luận ---
    async voiTamThoi(trackOrId, khoang, fnAsync) {
        if (typeof fnAsync !== 'function') return undefined;
        if (this._tamCtx !== null) {
            throw new Error('Không hỗ trợ gọi lồng voiTamThoi()');
        }
        const key = this.trackKey(trackOrId);
        const frames = this._bungKhoangThanhSet(khoang);
        const token = Symbol('tamDuyet');
        const ctx = { trackKey: key, frames, token };
        this._tamCtx = ctx;
        this._tamToken = token;
        try {
            return await fnAsync(ctx);
        } finally {
            if (this._tamToken === token) {
                this._tamCtx = null;
                this._tamToken = null;
            }
        }
    }

    tamDangBat() {
        return Boolean(this._tamCtx);
    }

    resetAll(keepJob = false) {
        const jId = keepJob ? this.jobId : null;
        this._store = { v: 1, jobId: jId, capNhat: null, tracks: {} };
        this._pending.clear();
        this._phien.clear();
        this._tamCtx = null;
        this._tamToken = null;
        this._ghiStorage();
        this._bump('reset');
    }
}

if (typeof window !== 'undefined') {
    window.KhoDuyet = KhoDuyet;
    window.khoDuyet = window.khoDuyet || new KhoDuyet();
}
if (typeof globalThis !== 'undefined' && typeof window === 'undefined') {
    globalThis.KhoDuyet = KhoDuyet;
    globalThis.khoDuyet = globalThis.khoDuyet || new KhoDuyet();
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = KhoDuyet;
}
