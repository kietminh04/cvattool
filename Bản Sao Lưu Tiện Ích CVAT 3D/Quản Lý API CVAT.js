/**

 * Quản Lý API CVAT (CVAT REST API Manager)

 * Đảm nhiệm trích xuất Job ID, token CSRF, nạp và lưu Annotations chuẩn xác

 * Đảm bảo 100% tuân thủ cấu trúc CVAT REST API: bỏ trường id thừa, gán source="manual"

 */




class QuanLyAPICVAT {

    constructor() {

        this.jobId = this.layJobIdTuURL();

        this.cacheAnnotations = null;

        this.cacheTime = 0;

    }



    /**

     * Tự động trích xuất Job ID từ URL hiện tại

     * Ví dụ: https://cvat.../tasks/1526/jobs/1523 -> 1523

     */

    layJobIdTuURL() {

        const url = window.location.href;

        const match = url.match(/\/jobs\/(\d+)/);

        if (match && match[1]) {

            return parseInt(match[1], 10);

        }

        return null;

    }



    /**

     * Lấy CSRF Token từ Cookie hoặc Meta tag

     */

    layCSRFToken() {

        const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);

        if (match && match[1]) {

            return match[1];

        }

        const meta = document.querySelector('meta[name="csrf-token"]');

        if (meta) return meta.getAttribute('content');

        return '';

    }

    /**
     * Lấy Bearer / Token xác thực CVAT REST API chuẩn
     */
    layAuthHeader() {

        // 2. Nếu người dùng chủ động cấu hình qua cvat_token
        try {
            const v = localStorage.getItem('cvat_token');
            if (v && typeof v === 'string' && v.trim().length > 10) {
                const val = v.trim();
                return val.startsWith('Bearer ') ? val : `Bearer ${val}`;
            }
        } catch (_) {}
        // 3. app.cvat.ai và các host khác: Sử dụng Cookie phiên Django (sessionid) tự nhiên của trình duyệt
        return null;
    }



    /**

     * Nạp toàn bộ Annotations từ máy chủ CVAT

     */

    async taiAnnotations(forceReload = false) {

        if (!this.jobId) {

            this.jobId = this.layJobIdTuURL();

        }

        if (!this.jobId) {

            throw new Error("Không tìm thấy Job ID trên thanh địa chỉ URL.");

        }



        const now = Date.now();

        if (!forceReload && this.cacheAnnotations && (now - this.cacheTime < 10000)) {

            return JSON.parse(JSON.stringify(this.cacheAnnotations));

        }



        const authH = this.layAuthHeader();
        const headers = {
            'Accept': 'application/vnd.cvat+json',
            'Cache-Control': 'no-cache'
        };
        if (authH) {
            headers['Authorization'] = authH;
        }

        let response = await fetch(`/api/jobs/${this.jobId}/annotations`, {
            method: 'GET',
            credentials: 'include',
            headers: headers
        });
        if (response.status === 401 && headers['Authorization']) {
            console.warn("[Quản Lý API CVAT] 401 với Authorization header. Tự động thử lại bằng Session Cookie...");
            delete headers['Authorization'];
            response = await fetch(`/api/jobs/${this.jobId}/annotations`, {
                method: 'GET',
                credentials: 'include',
                headers: headers
            });
        }



        if (!response.ok) {

            const errText = await response.text().catch(() => '');

            throw new Error(`Lỗi tải dữ liệu CVAT (HTTP ${response.status}): ${errText || response.statusText}`);

        }



        const data = await response.json();
        if (data && Array.isArray(data.tracks)) {
            data.tracks.forEach((tr, idx) => {
                if (tr._trackNumber === undefined) tr._trackNumber = idx + 1;
                if (tr._index === undefined) tr._index = idx;
                if (tr._serverId === undefined && tr.id !== undefined) tr._serverId = tr.id;
            });
        }

        this.cacheAnnotations = JSON.parse(JSON.stringify(data));

        this.cacheTime = now;



        // Lưu backup nguyên bản (Pristine) vào sessionStorage nếu chưa có

        try {

            const keyPristine = 'cvat_pristine_backup_' + this.jobId;

            if (!sessionStorage.getItem(keyPristine)) {

                // Kiểm tra sơ bộ: nếu dữ liệu có phân phối Z hợp lý (> -1.0m) thì lưu làm bản chuẩn

                sessionStorage.setItem(keyPristine, JSON.stringify(data));

            }

        } catch (e) {

            console.warn("[Quản Lý API CVAT] Không thể lưu pristine backup vào sessionStorage:", e);

        }



        return data;

    }



    /**

     * Tải danh mục nhãn (Labels Schema) từ CVAT Server

     */

    async taiLabels() {

        if (!this.jobId) this.jobId = this.layJobIdTuURL();



        // 1. Thử đọc trực tiếp từ instance job của CVAT SDK (0ms, chính xác nhất)

        try {

            const job = this.getJobInstance();

            if (job && Array.isArray(job.labels) && job.labels.length > 0) {

                const map = {};

                for (const item of job.labels) {
                    if (item && item.id !== undefined) {
                        const normAttrs = (item.attributes || []).map(a => ({
                            id: a.id,
                            name: a.name,
                            mutable: Boolean(a.mutable),
                            input_type: a.input_type || a.inputType || 'select',
                            default_value: a.default_value !== undefined ? a.default_value : (a.defaultValue !== undefined ? a.defaultValue : ''),
                            values: Array.isArray(a.values) ? [...a.values] : (a.values ? [String(a.values)] : [])
                        }));
                        map[item.id] = { name: item.name, color: item.color, attributes: normAttrs };
                    }
                }

                if (Object.keys(map).length > 0) {

                    return map;

                }

            }

        } catch (e) {

            console.warn("[Quản Lý API CVAT] Lỗi đọc labels từ Job instance:", e);

        }



        // 2. Tải qua REST API với header Accept: application/vnd.cvat+json

        if (this.jobId) {

            try {

                const response = await fetch(`/api/labels?job_id=${this.jobId}`, {

                    method: 'GET',

                    credentials: 'include',

                    headers: {

                        'Accept': 'application/vnd.cvat+json, application/json',

                        'Cache-Control': 'no-cache'

                    }

                });

                if (response.ok) {

                    const data = await response.json();

                    const list = Array.isArray(data) ? data : (data.results || []);

                    if (list.length > 0) {

                        const map = {};

                        for (const item of list) {

                            if (item && item.id !== undefined) {

                                map[item.id] = { name: item.name, color: item.color, attributes: item.attributes || [] };

                            }

                        }

                        if (Object.keys(map).length > 0) {

                            return map;

                        }

                    }

                }

            } catch (e) {

                console.warn("[Quản Lý API CVAT] Lỗi tải labels schema:", e);

            }

        }



        // 3. Fallback schema mặc định nếu API labels không phản hồi (Bao gồm Job 4637659 & Job 1523)

        return {

            8661578: { name: 'vehicles', color: '#10a0c0' },

            8661579: { name: 'pedestrian', color: '#80e060' },

            8661580: { name: 'two-wheels', color: '#f59331' },

            12871: { name: 'vehicles', color: '#10a0c0' },

            12872: { name: 'pedestrian', color: '#80e060' },

            12873: { name: 'two-wheels', color: '#f59331' },

            12874: { name: 'Animal', color: '#c00000' },

            12875: { name: 'Obstacle', color: '#cbf015' }

        };

    }



        /**
     * Ánh xạ và chuẩn hóa thuộc tính (spec_id, value)
     * Tuyệt đối không gửi trường 'id' trong attribute để tránh lỗi CVAT REST API (id must be absent)
     */
    mapAttribute(labelId, attr) {
        if (!attr) return null;
        const oldSpecId = attr.spec_id;
        const oldVal = attr.value;
        const valLower = String(oldVal !== undefined && oldVal !== null ? oldVal : '').toLowerCase().trim();

        // 1. Ánh xạ khi spec_id là ID giả lập fallback (1816, 1817, 1818, 1819)
        if (oldSpecId === 1816 && (labelId === 8661578 || labelId === 12871)) {
            const vehMap = {
                'truck': 'Truck', 'van': 'Van', 'bus': 'Bus', 'pickup': 'Pickup',
                'contruction': 'Contruction', 'construction': 'Contruction',
                'trailer': 'Trailer', 'tricycle': 'Tricycle',
                'stroller': 'Stroller', 'wheelchair': 'Wheelchair',
                'other': 'Other', 'car': 'Car'
            };
            const mappedVal = vehMap[valLower] || (valLower ? valLower.charAt(0).toUpperCase() + valLower.slice(1) : 'Car');
            return { spec_id: 2716448, value: mappedVal };
        } else if ((oldSpecId === 1817 || oldSpecId === 1818) && (labelId === 8661579 || labelId === 12872)) {
            if (oldSpecId === 1817) {
                return { spec_id: 2716452, value: valLower.includes('child') ? 'Child' : 'Adult' };
            }
            if (oldSpecId === 1818) {
                let poseVal = 'Standing';
                if (valLower.includes('walk')) poseVal = 'Walking';
                else if (valLower.includes('sit')) poseVal = 'Sitting';
                else if (valLower.includes('bend')) poseVal = 'Bending';
                return { spec_id: 2716453, value: poseVal };
            }
        } else if (oldSpecId === 1819 && (labelId === 8661580 || labelId === 12873)) {
            if (valLower === 'true' || valLower === 'false') {
                return { spec_id: 2716457, value: valLower };
            }
            const twoWheelMap = { 'bicycle': 'Bicycle', 'motorcycle': 'Motorcycle' };
            return { spec_id: 2716457, value: twoWheelMap[valLower] || 'Motorcycle' };
        }

        // 2. Mặc định: giữ nguyên spec_id và value thực tế của người dùng, loại bỏ 'id'
        return {
            spec_id: oldSpecId,
            value: oldVal !== undefined && oldVal !== null ? String(oldVal) : ''
        };
    }

    /**
     * Làm sạch dữ liệu trước khi đẩy lên CVAT (Bỏ id, chuẩn hóa source="manual")
     * Tránh lỗi Django DB IntegrityError / Validation error
     */
    chuanHoaDuLieuLuu(duLieuGoc) {
        // Chuẩn hóa payload cho action=put: CVAT yêu cầu tuyệt đối KHÔNG gửi trường 'id' (id must be absent)
        const rawTracks = duLieuGoc.tracks || [];
        const cleanedTracks = [];

        for (const tr of rawTracks) {
            const lid = tr.label_id;
            const mappedTrAttrs = (tr.attributes || [])
                .map(a => this.mapAttribute(lid, a))
                .filter(Boolean);

            const trClean = {
                label_id: lid,
                frame: tr.frame !== undefined ? tr.frame : 0,
                group: tr.group || 0,
                attributes: mappedTrAttrs,
                source: "manual",
                shapes: []
            };

            for (const s of (tr.shapes || [])) {
                const mappedShAttrs = (s.attributes || [])
                    .map(a => this.mapAttribute(lid, a))
                    .filter(Boolean);

                // Chuẩn hóa type hợp lệ cho 3D
                let shType = s.type;
                if (!shType || shType === 'box') {
                    shType = 'cuboid';
                }

                // Chuẩn hóa rotation (bắt buộc là số float, tránh mảng [0,0,rz])
                let rotVal = 0.0;
                if (typeof s.rotation === 'number' && !isNaN(s.rotation)) {
                    rotVal = s.rotation;
                }

                // Chuẩn hóa points: đủ 16 phần tử
                let pts = Array.isArray(s.points) ? s.points.map(p => Number(p) || 0.0) : [];
                while (pts.length < 16) {
                    pts.push(0.0);
                }

                trClean.shapes.push({
                    type: shType,
                    frame: s.frame,
                    points: pts,
                    rotation: rotVal,
                    outside: !!s.outside,
                    occluded: !!s.occluded,
                    attributes: mappedShAttrs,
                    source: "manual"
                });
            }
            cleanedTracks.push(trClean);
        }

        const cleanedShapes = [];
        for (const s of (duLieuGoc.shapes || [])) {
            const mappedAttrs = (s.attributes || [])
                .map(a => this.mapAttribute(s.label_id, a))
                .filter(Boolean);

            let shType = s.type;
            if (!shType || shType === 'box') {
                shType = 'cuboid';
            }
            let rotVal = 0.0;
            if (typeof s.rotation === 'number' && !isNaN(s.rotation)) {
                rotVal = s.rotation;
            }
            let pts = Array.isArray(s.points) ? s.points.map(p => Number(p) || 0.0) : [];
            while (pts.length < 16) {
                pts.push(0.0);
            }

            cleanedShapes.push({
                type: shType,
                frame: s.frame,
                points: pts,
                rotation: rotVal,
                outside: !!s.outside,
                occluded: !!s.occluded,
                attributes: mappedAttrs,
                source: "manual"
            });
        }

        const cleanedTags = [];
        for (const tg of (duLieuGoc.tags || [])) {
            const mappedAttrs = (tg.attributes || [])
                .map(a => this.mapAttribute(tg.label_id, a))
                .filter(Boolean);

            cleanedTags.push({
                frame: tg.frame,
                label_id: tg.label_id,
                attributes: mappedAttrs,
                source: "manual"
            });
        }

        return {
            version: duLieuGoc.version || 0,
            tags: cleanedTags,
            shapes: cleanedShapes,
            tracks: cleanedTracks
        };
    }



    /**

     * Đẩy Annotations lên CVAT qua REST API với action=put

     */

    async luuAnnotations(duLieuAnnotations) {

        if (!this.jobId) {

            this.jobId = this.layJobIdTuURL();

        }

        if (!this.jobId) {

            throw new Error("Không thể xác định Job ID từ URL.");

        }



        // Lưu bản backup ngay trước thao tác này

        try {

            if (this.cacheAnnotations) {

                sessionStorage.setItem('cvat_last_backup_' + this.jobId, JSON.stringify(this.cacheAnnotations));

            }

        } catch (e) {}



        const csrf = this.layCSRFToken();

        const payload = this.chuanHoaDuLieuLuu(duLieuAnnotations);



        const authH = this.layAuthHeader();
        const headers = {
            'Content-Type': 'application/json',
            'X-CSRFToken': csrf,
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (authH) {
            headers['Authorization'] = authH;
        }

        let response = await fetch(`/api/jobs/${this.jobId}/annotations?action=put`, {
            method: 'PUT',
            credentials: 'include',
            headers: headers,
            body: JSON.stringify(payload)
        });
        if (response.status === 401 && headers['Authorization']) {
            console.warn("[Quản Lý API CVAT] 401 với Authorization header khi lưu. Tự động thử lại bằng Session Cookie...");
            delete headers['Authorization'];
            response = await fetch(`/api/jobs/${this.jobId}/annotations?action=put`, {
                method: 'PUT',
                credentials: 'include',
                headers: headers,
                body: JSON.stringify(payload)
            });
        }



        if (!response.ok) {

            const errText = await response.text().catch(() => '');

            throw new Error(`Lỗi lưu lên CVAT (HTTP ${response.status}): ${errText || response.statusText}`);

        }



        const resData = await response.json();

        this.cacheAnnotations = JSON.parse(JSON.stringify(resData));

        this.cacheTime = Date.now();

        try { await this.refreshView(duLieuAnnotations?._activeTrack || null); } catch (e) {}

        return resData;

    }



    /**

     * KHÔI PHỤC DỮ LIỆU GỐC (RESTORE RAW ANNOTATIONS)

     * Tự động lấy từ gói bundle Dữ Liệu Gốc Job 1523.json, pristine sessionStorage,

     * hoặc nhận trực tiếp từ file thô do người dùng chọn.

     */

    async khoiPhucDuLieuGoc(duLieuRaw = null) {

        if (!this.jobId) {

            this.jobId = this.layJobIdTuURL();

        }

        if (!this.jobId) {

            throw new Error("Không thể xác định Job ID từ URL.");

        }



        let dataToRestore = duLieuRaw;



        // Nếu chưa có file do người dùng nạp, thử các kênh tự động

        if (!dataToRestore) {



            // Nguồn 2: Pristine backup trong sessionStorage

            if (!dataToRestore) {

                try {

                    const stored = sessionStorage.getItem('cvat_pristine_backup_' + this.jobId);

                    if (stored) {

                        const parsed = JSON.parse(stored);

                        dataToRestore = parsed.annotations || parsed;

                    }

                } catch (e) {}

            }

        }



        if (!dataToRestore || !dataToRestore.tracks) {

            throw new Error("Chưa tìm thấy bản Dữ Liệu Thô hợp lệ. Vui lòng chọn tệp Dữ Liệu Thô.json từ máy tính!");

        }



        return await this.luuAnnotations(dataToRestore);

    }



    // =========================================================================

    // CƠ CHẾ CẬP NHẬT TRỰC TIẾP REDUX / THREE.JS 3D CANVAS (KHÔNG CẦN F5!)

    // Đồng bộ chuẩn công nghệ trích xuất React Fiber & Redux Dispatch

    // =========================================================================



    /**

     * Tìm Redux store của CVAT thông qua React Fiber tree

     */

    findStoreFromFiber() {

        if (typeof document === 'undefined') return null;

        const selectors = [

            '.cvat-canvas-container',

            '.cvat-objects-sidebar',

            '.cvat-player-frame-selector',

            '.cvat-annotation-header',

            '#root > *',

            '#root'

        ];

        for (const sel of selectors) {

            const el = document.querySelector(sel);

            if (!el) continue;

            const key = Object.keys(el).find(k => 

                k.startsWith('__reactFiber$') || 

                k.startsWith('__reactInternalInstance$') || 

                k.startsWith('__reactContainer$')

            );

            if (!key) continue;

            let fiber = el[key];

            if (fiber?.current) fiber = fiber.current;

            for (let depth = 0; fiber && depth < 1000; depth++) {

                const props = fiber.memoizedProps;

                const store = props?.store || props?.value?.store;

                if (store && typeof store.getState === 'function' && store.getState()?.annotation) {

                    return store;

                }

                fiber = fiber.return;

            }

        }

        return null;

    }



    getStore() {

        if (this._cachedStore && typeof this._cachedStore.getState === 'function' && this._cachedStore.getState()?.annotation) {

            return this._cachedStore;

        }

        if (typeof window.store !== 'undefined' && typeof window.store.getState === 'function' && window.store.getState()?.annotation) {

            this._cachedStore = window.store;

            return this._cachedStore;

        }

        this._cachedStore = this.findStoreFromFiber();

        return this._cachedStore;

    }



    getAnnotationState() {

        return this.getStore()?.getState()?.annotation || null;

    }



    getJobInstance() {

        const job = this.getAnnotationState()?.job?.instance;

        return job && typeof job.annotations?.get === 'function' ? job : null;

    }

    /**
     * Đọc trực tiếp Track mới tạo từ CVAT Core RAM Collection (0ms, không chờ lưu hay API)
     */
    layTrackLiveTuRAM(trackId) {
        try {
            const job = this.getJobInstance();
            if (!job || !job.annotations) return null;
            const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
            if (!coll) return null;

            const targetNum = parseInt(trackId, 10);
            const tracks = coll.tracks || coll._tracks || [];
            const trackList = Array.isArray(tracks) ? tracks : Object.values(tracks);

            const matched = trackList.find(t => t && (t.clientID === targetNum || t.serverID === targetNum || t.id === targetNum));
            if (!matched) return null;

            const rawShapes = matched.shapes || matched._shapes || [];
            const shapeList = Array.isArray(rawShapes) ? rawShapes : Object.values(rawShapes);
            const exportedShapes = shapeList.map(s => ({
                frame: Number(s.frame),
                points: [...(s.points || [])],
                outside: !!s.outside,
                attributes: Array.isArray(s.attributes) ? [...s.attributes] : []
            })).filter(s => s.points && s.points.length >= 9);

            return {
                id: matched.serverID || matched.clientID || targetNum,
                _clientID: matched.clientID || targetNum,
                _trackNumber: targetNum,
                frame: matched.frame !== undefined ? Number(matched.frame) : (exportedShapes[0]?.frame || 0),
                label_id: matched.label?.id || matched.label_id,
                attributes: Array.isArray(matched.attributes) ? [...matched.attributes] : [],
                shapes: exportedShapes
            };
        } catch (e) {
            console.warn("[Quản Lý API CVAT] Lỗi đọc track live từ RAM:", e);
            return null;
        }
    }

    /**
     * Đọc toàn bộ danh sách Tracks trực tiếp từ CVAT Core RAM Collection (0ms, phản ánh ngay lập tức các tracks mới)
     */
    layTatCaTracksLiveTuRAM() {
        try {
            const job = this.getJobInstance();
            if (!job || !job.annotations) return null;
            const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
            if (!coll) return null;

            const tracks = coll.tracks || coll._tracks || [];
            const trackList = Array.isArray(tracks) ? tracks : Object.values(tracks);
            if (!Array.isArray(trackList) || trackList.length === 0) return null;

            return trackList.map((matched, idx) => {
                if (!matched) return null;
                const targetNum = matched.clientID || matched.serverID || (idx + 1);
                const rawShapes = matched.shapes || matched._shapes || [];
                const shapeList = Array.isArray(rawShapes) ? rawShapes : Object.values(rawShapes);
                const exportedShapes = shapeList.map(s => ({
                    frame: Number(s.frame),
                    points: [...(s.points || [])],
                    outside: !!s.outside,
                    attributes: Array.isArray(s.attributes) ? [...s.attributes] : []
                })).filter(s => s.points && s.points.length >= 9);

                return {
                    id: matched.serverID || matched.clientID || targetNum,
                    _clientID: matched.clientID || targetNum,
                    _trackNumber: targetNum,
                    frame: matched.frame !== undefined ? Number(matched.frame) : (exportedShapes[0]?.frame || 0),
                    label_id: matched.label?.id || matched.label_id,
                    attributes: Array.isArray(matched.attributes) ? [...matched.attributes] : [],
                    shapes: exportedShapes
                };
            }).filter(Boolean);
        } catch (e) {
            console.warn("[Quản Lý API CVAT] Lỗi đọc toàn bộ tracks live từ RAM:", e);
            return null;
        }
    }



    getCurrentFrameNumber() {

        const n = this.getAnnotationState()?.player?.frame?.number;

        if (Number.isInteger(n)) return n;

        if (typeof document === 'undefined') return 0;

        const input = document.querySelector('.cvat-player-frame-selector input') || document.querySelector('input.cvat-player-frame-selector');

        const v = parseInt(input?.value, 10);

        return Number.isInteger(v) ? v : 0;

    }



    /**

     * Làm mới canvas và sidebar 3D trực tiếp qua Redux Store trong 0ms (KHÔNG CẦN F5!)

     */

    async refreshViaStore() {

        try {

            const store = this.getStore();

            const job = this.getJobInstance();

            const frame = this.getCurrentFrameNumber();

            if (!store || !job || !Number.isInteger(frame)) return false;



            const root = store.getState();

            const ann = root.annotation?.annotations;

            if (!ann) return false;



            const showAll = !!root.settings?.workspace?.showAllInterpolationTracks;

            const states = await job.annotations.get(frame, showAll, ann.filters || []);

            const history = typeof job.actions?.get === 'function' ? await job.actions.get() : ann.history;



            store.dispatch({

                type: 'FETCH_ANNOTATIONS_SUCCESS',

                payload: {

                    states,

                    history,

                    minZ: ann.zLayer?.min ?? 0,

                    maxZ: ann.zLayer?.max ?? 0

                }

            });

            console.log("[Quản Lý API CVAT] ✅ Đã làm mới 3D Canvas thành công qua Redux (0ms, Không cần F5)!");

            return true;

        } catch (e) {

            console.warn("[Quản Lý API CVAT] Lỗi refreshViaStore:", e);

            return false;

        }

    }



    /**

     * Dự phòng làm mới: Đổi frame lân cận và quay lại trong 100ms

     */

    async bounceFrame() {
        try {
            const curFrame = this.getCurrentFrameNumber();
            const otherFrame = curFrame > 0 ? curFrame - 1 : curFrame + 1;

            const store = this.getStore();
            if (store) {
                store.dispatch({ type: 'CHANGE_FRAME', payload: { frame: otherFrame } });
                await new Promise(r => setTimeout(r, 60));
                store.dispatch({ type: 'CHANGE_FRAME', payload: { frame: curFrame } });
            }

            const input = (typeof document !== 'undefined')
                ? (document.querySelector('.cvat-player-frame-selector input') || document.querySelector('input.cvat-player-frame-selector'))
                : null;
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    input.focus();
                    setter.call(input, String(otherFrame));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));

                    await new Promise(r => setTimeout(r, 60));

                    setter.call(input, String(curFrame));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    input.blur();
                }
            }

            return true;
        } catch (e) {
            return false;
        }
    }



    /**

     * Làm mới toàn bộ góc nhìn 3D (Thử Store trước, nếu không được thì Bounce Frame)

     */

    async refreshView(activeTrack = null) {
        if (activeTrack && activeTrack.shapes) {
            try {
                const job = this.getJobInstance();
                const trackId = activeTrack._trackNumber || activeTrack._clientID || activeTrack.id;

                if (job && job.annotations) {
                    // Cập nhật trực tiếp tọa độ vào bộ nhớ RAM cvat-core collection (0ms, tuyệt đối KHÔNG gọi clear() hay st.save())
                    const coll = job.annotations._collection || (typeof job.annotations.getCollection === 'function' ? job.annotations.getCollection() : null) || job.annotations.collection;
                    if (coll) {
                        const tracks = coll.tracks || coll._tracks || [];
                        const trackList = Array.isArray(tracks) ? tracks : Object.values(tracks);
                        let targetTrack = trackList.find(tr => {
                            return tr.clientID === trackId || tr.serverID === activeTrack.id || tr.clientID === activeTrack.id || (tr.id && tr.id === activeTrack.id);
                        });
                        if (!targetTrack && Number.isInteger(activeTrack._trackNumber) && trackList[activeTrack._trackNumber - 1]) {
                            targetTrack = trackList[activeTrack._trackNumber - 1];
                        }
                        if (targetTrack) {
                            if (Array.isArray(activeTrack.attributes)) {
                                if (Array.isArray(targetTrack.attributes)) {
                                    targetTrack.attributes = JSON.parse(JSON.stringify(activeTrack.attributes));
                                } else if (targetTrack.attributes && typeof targetTrack.attributes === 'object') {
                                    for (const a of activeTrack.attributes) {
                                        if (a && a.spec_id !== undefined) {
                                            targetTrack.attributes[a.spec_id] = String(a.value);
                                        }
                                    }
                                }
                            }
                            const trackShapes = targetTrack.shapes || targetTrack._shapes || [];
                            const shapeList = Array.isArray(trackShapes) ? trackShapes : Object.values(trackShapes);
                            for (const s of activeTrack.shapes) {
                                const matchedShape = shapeList.find(item => Number(item.frame) === Number(s.frame));
                                if (matchedShape && s.points) {
                                    matchedShape.points = [...s.points];
                                    matchedShape.outside = !!s.outside;
                                    if (Array.isArray(s.attributes) && matchedShape.attributes) {
                                        if (Array.isArray(matchedShape.attributes)) {
                                            matchedShape.attributes = JSON.parse(JSON.stringify(s.attributes));
                                        } else if (typeof matchedShape.attributes === 'object') {
                                            for (const a of s.attributes) {
                                                if (a && a.spec_id !== undefined) {
                                                    matchedShape.attributes[a.spec_id] = String(a.value);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[Quản Lý API CVAT] Lỗi cập nhật RAM collection:", e);
            }
        }

        try {
            const ann = this.getAnnotationState();
            const canvas = ann?.canvas?.instance;
            if (canvas && typeof canvas.render === 'function') {
                canvas.render();
            }
        } catch (e) {}

        try { await this.refreshViaStore(); } catch (e) {}

        return await this.bounceFrame();
    }



    /**

     * Trích xuất mảng điểm LiDAR trực tiếp từ Three.js BufferGeometry trong RAM (0ms!)

     * Giữ nguyên 100% điểm trong bán kính 5m quanh vật thể (không bị decimate làm mất điểm)

     */

    
    layDiemLiDARThreeJS(frame = null, targetCenter = null) {

        try {

            // Tự động tìm targetCenter nếu chưa được truyền vào

            if (!targetCenter && typeof activeModalTrack !== 'undefined' && activeModalTrack?.shapes) {

                const fn = Number.isInteger(frame) ? frame : this.getCurrentFrameNumber();

                const sh = activeModalTrack.shapes.find(s => Number(s.frame) === fn) || activeModalTrack.shapes[0];

                if (sh && sh.points && sh.points.length >= 3) {

                    targetCenter = [sh.points[0], sh.points[1], sh.points[2]];

                }

            }

            if (!targetCenter) {

                try {

                    const ann = this.getAnnotationState();

                    const states = ann?.annotations?.states;

                    const activatedId = ann?.activatedStateID;

                    if (Array.isArray(states)) {

                        const activeObj = states.find(st => st.clientID === activatedId || st.serverID === activatedId) || states[0];

                        if (activeObj && Array.isArray(activeObj.points) && activeObj.points.length >= 3) {

                            targetCenter = [activeObj.points[0], activeObj.points[1], activeObj.points[2]];

                        }

                    }

                } catch (e) {}

            }



            const views = this.getAnnotationState()?.canvas?.instance?.view?.views;

            if (!views) return null;

            for (const key of ['perspective', 'top', 'side', 'front']) {

                const cloud = views[key]?.scene?.children?.find(

                    o => o?.isPoints && o.geometry?.attributes?.position?.array?.length

                );

                if (cloud && cloud.geometry?.attributes?.position?.array) {

                    const arr = cloud.geometry.attributes.position.array;

                    const pts = [];

                    const step = Math.max(1, Math.floor(arr.length / (3 * 35000)));
                    const colArr = cloud.geometry?.attributes?.color?.array;
                    const intArr = cloud.geometry?.attributes?.intensity?.array;

                    const tinhMauDiem = (idx) => {
                        let r = 235, g = 240, b = 250;
                        if (colArr && idx + 2 < colArr.length) {
                            const rawR = colArr[idx], rawG = colArr[idx + 1], rawB = colArr[idx + 2];
                            const cR = rawR <= 1.0 ? Math.round(rawR * 255) : Math.round(rawR);
                            const cG = rawG <= 1.0 ? Math.round(rawG * 255) : Math.round(rawG);
                            const cB = rawB <= 1.0 ? Math.round(rawB * 255) : Math.round(rawB);
                            if (Math.abs(cR - cG) > 15 || Math.abs(cG - cB) > 15) {
                                r = cR; g = cG; b = cB;
                            } else {
                                const norm = Math.max(0, Math.min(1, rawR <= 1.0 ? rawR : rawR / 255.0));
                                const val = Math.round(218 + norm * 37);
                                r = val; g = val; b = Math.min(255, val + 5);
                            }
                        } else if (intArr && (idx / 3) < intArr.length) {
                            const intVal = intArr[idx / 3];
                            const norm = Math.max(0, Math.min(1, intVal <= 1.0 ? intVal : intVal / 255.0));
                            const val = Math.round(218 + norm * 37);
                            r = val; g = val; b = Math.min(255, val + 5);
                        }
                        return [r, g, b];
                    };

                    if (targetCenter && targetCenter.length >= 3) {
                        const [tcx, tcy, tcz] = targetCenter;
                        const distThreshSq = 6.0 * 6.0; // Bán kính 6 mét quanh xe
                        for (let i = 0; i < arr.length; i += 3) {
                            const px = arr[i];
                            const py = arr[i + 1];
                            const pz = arr[i + 2];
                            const dx = px - tcx;
                            const dy = py - tcy;
                            const dz = pz - tcz;
                            const distSq = dx * dx + dy * dy + dz * dz;

                            const [r, g, b] = tinhMauDiem(i);

                            if (distSq <= distThreshSq) {
                                pts.push([px, py, pz, r, g, b]);
                            } else if ((i / 3) % step === 0 && distSq <= 100.0 * 100.0) {
                                pts.push([px, py, pz, r, g, b]);
                            }
                        }
                    } else {
                        for (let i = 0; i < arr.length; i += 3 * step) {
                            const [r, g, b] = tinhMauDiem(i);
                            pts.push([arr[i], arr[i + 1], arr[i + 2], r, g, b]);
                        }
                    }
                    return pts;

                }

            }

        } catch (e) {}

        return null;

    }



    /**

     * Làm mới giao diện CVAT: Tự động cập nhật tức thì (KHÔNG CẦN F5!)

     */

    async kichHoatLamMoiGiaoDien(reloadTrangSauGiay = 0) {

        if (reloadTrangSauGiay > 0) {

            // Ưu tiên làm mới tức thì qua Redux / Three.js

            const ok = await this.refreshView();

            if (ok) return;

            // Nếu trình duyệt bị cô lập hoàn toàn mới fallback reload

            setTimeout(() => {

                window.location.reload();

            }, reloadTrangSauGiay * 1000);

            return;

        }



        const ok = await this.refreshView();

        if (ok) return;



        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', keyCode: 70, bubbles: true }));

        setTimeout(() => {

            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', keyCode: 68, bubbles: true }));

        }, 120);

    }


    /**
     * Chuyển timeline CVAT sang frame chỉ định (kết hợp Redux & DOM input)
     */
    async changeFrame(frameNumber) {
        try {
            const frame = parseInt(frameNumber, 10);
            if (!Number.isInteger(frame)) return false;

            const store = this.getStore();
            if (store) {
                store.dispatch({ type: 'CHANGE_FRAME', payload: { frame } });
            }

            const input = document.querySelector('.cvat-player-frame-selector input') ||
                          document.querySelector('input.cvat-player-frame-selector') ||
                          document.querySelector('.cvat-player-frame-selector input[type="number"]');
            if (input) {
                const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
                if (setter) {
                    input.focus();
                    setter.call(input, String(frame));
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                    input.blur();
                }
            }
            return true;
        } catch (e) {
            console.warn('[Quản Lý API CVAT] Lỗi changeFrame:', e);
            return false;
        }
    }

    /**
     * Kích hoạt & Focus vào Track trên CVAT (mở 3 views Top/Side/Front & căn giữa Camera 3D PCD)
     * @param {number|string} trackId - Mã hiển thị (clientID) hoặc database ID của Track
     * @param {number|null} targetFrame - Frame cụ thể cần kích hoạt (nếu có)
     * @param {object|null} allAnnotations - Dữ liệu annotations để tra cứu frame xuất hiện nếu cần
     */
    async kichHoatVaFocusTrackCVAT(trackId, targetFrame = null, allAnnotations = null, ref = {}) {
        try {
            const numId = parseInt(trackId, 10);
            if (isNaN(numId)) return false;

            const tracks = (allAnnotations && Array.isArray(allAnnotations.tracks)) ? allAnnotations.tracks : [];
            let matchedTr = null;
            if (tracks.length > 0) {
                if (ref && ref.trackKey !== undefined && ref.trackKey !== null && ref.trackKey !== '') {
                    matchedTr = tracks.find(t => t && t._qcKey === ref.trackKey) || null;
                }
                if (!matchedTr) matchedTr = tracks.find(t => t && Number(t._displayId) === numId) || null;
                if (!matchedTr) matchedTr = tracks.find(t => t && Number(t._trackNumber) === numId) || null;
                if (!matchedTr) matchedTr = tracks.find(t => t && Number(t._clientID) === numId) || null;
                if (!matchedTr && ref && ref.choPhepServerId === true) {
                    matchedTr = tracks.find(t => t && Number(t.id) === numId) || null;
                }
            }

            const expectedClientID = (matchedTr && Number.isFinite(Number(matchedTr._clientID)) && Number(matchedTr._clientID) > 0)
                ? Number(matchedTr._clientID)
                : ((matchedTr && Number.isFinite(Number(matchedTr._displayId)) && Number(matchedTr._displayId) > 0)
                    ? Number(matchedTr._displayId)
                    : numId);
            const expectedServerID = (matchedTr && matchedTr._serverId !== undefined && matchedTr._serverId !== null)
                ? Number(matchedTr._serverId)
                : ((matchedTr && matchedTr.id !== undefined && matchedTr.id !== null) ? Number(matchedTr.id) : null);

            const curFrame = this.getCurrentFrameNumber();
            let desiredFrame = targetFrame;

            // Nếu chưa chỉ định targetFrame, kiểm tra xem track có xuất hiện/active ở frame hiện tại không
            if (desiredFrame === null || desiredFrame === undefined) {
                const ann = this.getAnnotationState()?.annotations;
                const states = ann?.states || [];
                const existInCur = states.some(s => s && (
                    s.clientID === expectedClientID ||
                    (expectedServerID !== null && s.serverID === expectedServerID) ||
                    (ref && ref.choPhepServerId === true && s.serverID === numId)
                ));

                if (!existInCur && matchedTr && Array.isArray(matchedTr.shapes) && matchedTr.shapes.length > 0) {
                    const actShape = matchedTr.shapes.find(s => s && !s.outside) || matchedTr.shapes[0];
                    if (actShape && Number.isInteger(actShape.frame)) {
                        desiredFrame = actShape.frame;
                    }
                }
            }

            // Nếu cần đổi sang frame khác trước khi kích hoạt
            if (Number.isInteger(desiredFrame) && desiredFrame !== curFrame) {
                console.log(`[Quản Lý API CVAT] ⏭️ Chuyển timeline CVAT từ Frame ${curFrame} sang Frame ${desiredFrame} để chọn Track #${numId}`);
                await this.changeFrame(desiredFrame);
                // Đợi CVAT nạp state của frame mới
                await new Promise(r => setTimeout(r, 220));
            }

            // Tìm clientID chuẩn xác từ states của frame hiện tại
            let clientID = expectedClientID;
            const curAnn = this.getAnnotationState()?.annotations;
            if (curAnn && Array.isArray(curAnn.states)) {
                const matchedState =
                    curAnn.states.find(s => s && s.clientID === expectedClientID) ||
                    (expectedServerID !== null ? curAnn.states.find(s => s && s.serverID === expectedServerID) : null) ||
                    ((ref && ref.choPhepServerId === true) ? curAnn.states.find(s => s && s.serverID === numId) : null);
                if (matchedState && matchedState.clientID !== undefined && matchedState.clientID !== null) {
                    clientID = matchedState.clientID;
                }
            }

            console.log(`[Quản Lý API CVAT] 🎯 Kích hoạt & Focus Track #${numId} (clientID: ${clientID})`);

            // Hàm thực thi kích hoạt đa lớp
            const thucThiKichHoat = () => {
                // Lớp 1: Canvas3D instance (Mở 3 views Top, Side, Front & Focus camera perspective 3D)
                const canvasInstance = this.getAnnotationState()?.canvas?.instance;
                if (canvasInstance) {
                    try {
                        if (typeof canvasInstance.activate === 'function') {
                            canvasInstance.activate(clientID);
                        }
                        if (typeof canvasInstance.focus === 'function') {
                            canvasInstance.focus(clientID);
                        } else if (canvasInstance.view && typeof canvasInstance.view.focusObjectByClientId === 'function') {
                            canvasInstance.view.focusObjectByClientId(clientID, true);
                        }
                    } catch (eCanv) {
                        console.warn('[Quản Lý API CVAT] Lỗi tương tác canvasInstance:', eCanv);
                    }
                }

                // Lớp 2: Redux Store (Cập nhật activatedStateID & expand item)
                const store = this.getStore();
                if (store) {
                    try {
                        store.dispatch({
                            type: 'ACTIVATE_OBJECT',
                            payload: {
                                activatedStateID: clientID,
                                activatedElementID: null,
                                activatedAttributeID: null,
                            },
                        });
                        const stList = this.getAnnotationState()?.annotations?.states;
                        if (Array.isArray(stList)) {
                            const tgt = stList.find(s => s && s.clientID === clientID);
                            if (tgt) {
                                store.dispatch({
                                    type: 'COLLAPSE_OBJECT_ITEMS',
                                    payload: { states: [tgt], collapsed: false },
                                });
                            }
                        }
                    } catch (eRedux) {
                        console.warn('[Quản Lý API CVAT] Lỗi Redux dispatch:', eRedux);
                    }
                }

                // Lớp 3: DOM Sidebar của CVAT (Scroll tới thẻ & trigger click/mouseenter)
                const sidebarItem = document.getElementById(`cvat-objects-sidebar-state-item-${clientID}`) ||
                                    document.querySelector(`[data-client-id="${clientID}"]`);
                if (sidebarItem) {
                    sidebarItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    sidebarItem.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                    sidebarItem.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                }
            };

            // Kích hoạt ngay lập tức
            thucThiKichHoat();

            // Chạy nhịp đệm sau 160ms để Three.js và React đồng bộ hoàn toàn
            setTimeout(thucThiKichHoat, 160);

            return true;
        } catch (e) {
            console.warn('[Quản Lý API CVAT] Lỗi tổng quát trong kichHoatVaFocusTrackCVAT:', e);
            return false;
        }
    }

}

// Khởi tạo instance toàn cục
window.quanLyAPICVAT = new QuanLyAPICVAT();
