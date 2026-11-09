/* =====================================================================
 *  데이터 계층
 *  - live : Supabase (실제 서비스) — /api/config 가 제공하는 공개 설정 사용
 *  - demo : 브라우저 내 시뮬레이션 (설정이 없을 때 자동 전환, 화면 상단에 표시)
 *  두 모드는 같은 인터페이스를 제공합니다.
 * ===================================================================== */
(function () {
  'use strict';
  const ITO = (window.ITO = window.ITO || {});

  /* ---------- 공통 도우미 ---------- */
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  function safeGet(store, key) { try { return store.getItem(key); } catch (e) { return null; } }
  function safeSet(store, key, v) { try { store.setItem(key, v); } catch (e) { /* 무시 */ } }

  function sessionId() {
    let s = safeGet(sessionStorage, 'ito-session');
    if (!s) { s = uuid(); safeSet(sessionStorage, 'ito-session', s); }
    return s;
  }
  function err(code, detail) { const e = new Error(code); e.code = code; e.detail = detail; return e; }
  function fromPg(error) {
    const msg = (error && (error.message || error.msg)) || '';
    const m = msg.match(/^([A-Z_]{3,})(?::\s*(.*))?/);
    if (m) return err(m[1], m[2]);
    if (/fetch|network|Failed/i.test(msg)) return err('NETWORK', msg);
    return err('UNKNOWN', msg);
  }
  const digits = (s) => String(s || '').replace(/\D/g, '');
  function normPhone(p) {
    const d = digits(p);
    if (!/^01[016789]\d{7,8}$/.test(d)) throw err('INVALID_PHONE');
    return d;
  }
  function fmtPhone(d) {
    d = digits(d);
    if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return d;
  }
  // 본인 확인 함수는 실패 시 예외 대신 {"error":…} 를 돌려줌 (실패 횟수 기록 유지 목적)
  const unwrap = (key) => (data) => { if (data && data.error) throw err(data.error); return data ? data[key] : null; };
  ITO.uuid = uuid; ITO.sessionId = sessionId; ITO.digits = digits; ITO.fmtPhoneDigits = fmtPhone;

  function cfg() {
    const c = window.ITO_CONFIG || {};
    return c.supabaseUrl && c.supabaseKey ? c : null;
  }
  // demo  : 설정 스크립트 자체가 없음(정적 미리보기·아티팩트)
  // live  : 배포 환경 + Supabase 설정 + 라이브러리 로드 성공
  // error : 배포 환경인데 설정 누락 또는 라이브러리 로드 실패 → 데모로 바꾸지 않고 오류 표시
  ITO.backendMode = () => {
    if (!window.ITO_CONFIG) return 'demo';
    if (!cfg()) return 'error:SERVER_CONFIG';
    if (!window.supabase) return 'error:NETWORK';
    return 'live';
  };
  ITO.isLive = () => ITO.backendMode() === 'live';
  function createErrorBackend(code) {
    const fail = () => Promise.reject(err(code));
    return { mode: 'error', sessionId: null, now: () => Date.now(), load: fail, loadPublic: fail, loadSeats: fail, subscribe: () => () => {},
      hold: fail, release: fail, releaseAll: fail, myHolds: fail, confirm: fail, lookup: fail, cleanup: fail,
      login: fail, logout: fail, me: async () => false, overview: fail };
  }

  /* =================================================================
   *  LIVE — Supabase
   * ================================================================= */
  function createLivePublic() {
    const c = cfg();
    const sb = window.supabase.createClient(c.supabaseUrl, c.supabaseKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
    const sid = sessionId();
    let offset = 0;

    async function rpc(name, args) {
      let res;
      try { res = await sb.rpc(name, args); } catch (e) { throw err('NETWORK', e.message); }
      if (res.error) throw fromPg(res.error);
      return res.data;
    }
    async function syncTime() {
      try {
        const t0 = Date.now(); const t = await rpc('server_time'); const t1 = Date.now();
        offset = new Date(t).getTime() - (t0 + t1) / 2;
      } catch (e) { /* 시계 보정 실패 시 로컬 시각 사용 */ }
    }
    async function loadSeats() {
      const all = []; const page = 1000;
      for (let from = 0; ; from += page) {
        const { data, error } = await sb.from('seats')
          .select('id,section,floor,row_label,row_no,seat_no,pos_x,kind,label,status,hold_expires_at,updated_at')
          .order('id').range(from, from + page - 1);
        if (error) throw fromPg(error);
        all.push(...data);
        if (data.length < page) break;
      }
      return all;
    }

    return {
      mode: 'live',
      sessionId: sid,
      now: () => Date.now() + offset,
      async load() {
        const [settings, sections, seats] = await Promise.all([
          sb.from('event_settings').select('*').eq('id', 1).single(),
          sb.from('sections').select('*').order('sort'),
          loadSeats(),
          syncTime(),
        ]);
        if (settings.error) throw fromPg(settings.error);
        if (sections.error) throw fromPg(sections.error);
        return { settings: settings.data, sections: sections.data, seats };
      },
      async loadSeats() { return loadSeats(); },
      subscribe(onSeat, onStatus) {
        const ch = sb.channel('public:seats')
          .on('postgres_changes', { event: '*', schema: 'public', table: 'seats' }, (p) => {
            if (p.eventType === 'DELETE') onSeat({ id: p.old.id, _deleted: true });
            else onSeat(p.new);
          })
          .subscribe((status) => onStatus && onStatus(status === 'SUBSCRIBED' ? 'live' : status === 'CLOSED' ? 'closed' : 'retry'));
        return () => sb.removeChannel(ch);
      },
      hold: (seatId) => rpc('hold_seat', { p_seat_id: seatId, p_session: sid }),
      release: (seatId) => rpc('release_seat', { p_seat_id: seatId, p_session: sid }),
      releaseAll: () => rpc('release_session', { p_session: sid }),
      myHolds: () => rpc('my_holds', { p_session: sid }),
      confirm: ({ seatIds, name, phone, agree, pin }) =>
        rpc('confirm_reservation', { p_session: sid, p_seat_ids: seatIds, p_name: name, p_phone: phone, p_agree: agree, p_pin: pin }),
      lookup: (name, phone) => rpc('lookup_reservation', { p_name: name, p_phone: phone }),
      manageLogin: (name, phone, pin) => rpc('manage_login', { p_name: name, p_phone: phone, p_pin: pin }).then(unwrap('reservations')),
      updateMyInfo: (no, pin, name, phone) => rpc('update_my_info', { p_reservation_no: no, p_pin: pin, p_name: name, p_phone: phone }).then(unwrap('reservation')),
      changeMySeats: (no, pin, seatIds) => rpc('change_my_seats', { p_reservation_no: no, p_pin: pin, p_session: sid, p_seat_ids: seatIds }).then(unwrap('reservation')),
      cancelMy: (no, pin) => rpc('cancel_my_reservation', { p_reservation_no: no, p_pin: pin }).then(unwrap('ok')),
      cleanup: () => rpc('cleanup_expired_holds').catch(() => 0),
    };
  }

  function createLiveAdmin() {
    async function call(action, payload) {
      let r;
      try {
        r = await fetch('/api/admin', {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, ...(payload || {}) }),
        });
      } catch (e) { throw err('NETWORK', e.message); }
      let data = null; try { data = await r.json(); } catch (e) { /* noop */ }
      if (!r.ok) throw err((data && data.code) || (r.status === 401 ? 'UNAUTHORIZED' : 'UNKNOWN'), data && data.detail);
      return data;
    }
    const pub = createLivePublic();
    return {
      mode: 'live',
      now: pub.now,
      loadPublic: pub.load,
      subscribe: pub.subscribe,
      login: (password) => call('login', { password }),
      logout: () => call('logout'),
      me: () => call('me').then(() => true).catch(() => false),
      overview: () => call('overview'),
      cancel: (id) => call('cancel', { id }),
      pickup: (id, picked) => call('pickup', { id, picked }),
      updateReservation: (id, name, phone, memo) => call('update_reservation', { id, name, phone, memo }),
      setSeatStatus: (seatId, status) => call('set_seat_status', { seatId, status }),
      createReservation: (seatIds, name, phone, memo) => call('create_reservation', { seatIds, name, phone, memo }),
      resetPin: (id, pin) => call('reset_pin', { id, pin }),
      updateSettings: (settings) => call('update_settings', { settings }),
      saveLayout: (sections, dsl) => call('save_layout', { sections, dsl }),
    };
  }

  /* =================================================================
   *  DEMO — 브라우저 내 시뮬레이션 (실제 DB 로직을 그대로 흉내냄)
   * ================================================================= */
  const DEMO_KEY = 'ito-demo-v7';
  const DEMO_NAMES = ['김민준', '이서연', '박지호', '최하은', '정우진', '강수아', '조현우', '윤지민', '장도윤', '임채원',
    '한예준', '오유나', '서준서', '신하린', '권시우', '황소율', '안지안', '송이준', '류서아', '전태윤'];

  function demoSeed() {
    const s = {
      settings: {
        id: 1, title: '인천교사오케스트라 제9회 정기연주회', subtitle: '열한 번의 겨울이 축적한 깊이',
        kicker: 'ITO Symphony Series · The 9th Concert', performers: '지휘 이우찬 · 바순 협연 박보라',
        hosts: '주최 인천교사오케스트라 · 주관 인천광역시교육청', pamphlet_url: 'https://2026ito.netlify.app',
        date_text: '2026년 12월 9일 (수) 오후 7시', event_at: '2026-12-09T19:00:00+09:00',
        venue: '인천문화예술회관 대공연장', venue_address: '인천광역시 남동구 예술로 149', organizer: '인천교사오케스트라',
        price_text: '전석 무료', pickup_text: '공연 당일 현장 수령',
        program: 'P. I. Tchaikovsky — 발레 〈백조의 호수〉 모음곡 중 제2곡 ‘왈츠’, Op. 20\nW. A. Mozart — 바순 협주곡 내림나장조, K. 191 (바순 박보라)\nL. van Beethoven — 교향곡 제7번 가장조, Op. 92',
        notice: '티켓은 공연 당일 공연장 로비의 티켓 배부처에서 예약자 이름 또는 예약번호로 수령합니다.\n공연 중 사진·영상 촬영과 녹음은 삼가 주세요.',
        max_seats_per_person: 4, hold_minutes: 10, reservation_open: true, reservation_prefix: 'ITO',
        layout_dsl: ITO.DEFAULT_LAYOUT,
      },
      sections: [], seats: {}, holds: {}, reservations: [], seq: 0,
    };
    demoApplyLayout(s, ITO.parseLayout(ITO.DEFAULT_LAYOUT).sections);
    // 데모용 기존 예약 (가상의 관객)
    const ids = Object.keys(s.seats);
    let n = 0;
    for (const id of ids) {
      const seat = s.seats[id];
      if (seat.kind === 'wheelchair') continue;
      const front = seat.floor === 1 && seat.section === '1C' && seat.row_no <= 9 ? 0.6 : seat.floor === 1 ? 0.3 : 0.12;
      if (Math.random() < front && n < 420) {
        demoReserve(s, [id], DEMO_NAMES[n % DEMO_NAMES.length], '010' + String(10000000 + n * 7919).slice(0, 8), 'online', null, null);
        s.reservations[s.reservations.length - 1].pin = demoPin('1234');
        if (Math.random() < 0.15) s.reservations[s.reservations.length - 1].picked_up = true;
        n++;
      }
    }
    return s;
  }
  function sortIds(s, ids) { return [...ids].sort((a, b) => ITO.seatCmp(s.seats[a], s.seats[b])); }
  function demoApplyLayout(s, sections) {
    const list = ITO.layoutToSeats(sections);
    const wanted = new Map(list.map((x) => [x.id, x]));
    if (!list.length) throw err('INVALID_ROWS');
    const now = Date.now();
    const conflict = Object.values(s.seats).filter((x) => !wanted.has(x.id) &&
      (x.status === 'reserved' || (x.status === 'held' && new Date(x.hold_expires_at).getTime() > now)));
    if (conflict.length) throw err('LAYOUT_CONFLICT', conflict.slice(0, 10).map((x) => x.id).join(', '));
    s.sections = sections.map((x) => ({ code: x.code, floor: x.floor, name: x.name, sort: x.sort, breaks: x.breaks || [], rows: x.rows }));
    for (const id of Object.keys(s.seats)) if (!wanted.has(id)) { delete s.seats[id]; delete s.holds[id]; }
    for (const [id, x] of wanted) {
      const cur = s.seats[id];
      s.seats[id] = cur ? { ...cur, section: x.section, row_no: x.row_no, pos_x: x.pos_x, kind: x.kind, label: x.label } : x;
    }
    return wanted.size;
  }
  function demoReserve(s, ids, name, phone, source, memo, session) {
    s.seq += 1;
    const year = new Date(s.settings.event_at || Date.now()).getFullYear();
    const sorted = sortIds(s, ids);
    const r = {
      id: uuid(), reservation_no: `${s.settings.reservation_prefix}-${year}-${String(s.seq).padStart(4, '0')}`,
      name, phone, seat_ids: sorted, seat_labels: sorted.map((i) => s.seats[i].label), status: 'confirmed',
      picked_up: false, picked_up_at: null, source, memo: memo || null, session_id: session,
      created_at: new Date(Date.now() - (session ? 0 : Math.random() * 6 * 86400000)).toISOString(), cancelled_at: null,
    };
    s.reservations.push(r);
    for (const i of ids) { s.seats[i].status = 'reserved'; s.seats[i].hold_expires_at = null; delete s.holds[i]; }
    return r;
  }
  function demoCleanup(s) {
    const now = Date.now(); const changed = [];
    for (const seat of Object.values(s.seats)) {
      if (seat.status === 'held' && new Date(seat.hold_expires_at).getTime() <= now) {
        seat.status = 'available'; seat.hold_expires_at = null; delete s.holds[seat.id]; changed.push(seat.id);
      }
    }
    return changed;
  }

  // 한 탭 안에서 공유되는 데모 저장소 (+ 다른 탭과 localStorage 로 동기화)
  const demo = {
    s: null, listeners: new Set(), memory: null,
    read() {
      const raw = safeGet(localStorage, DEMO_KEY);
      if (raw) { try { return JSON.parse(raw); } catch (e) { /* 손상 시 재생성 */ } }
      return this.memory || null;
    },
    get() { if (!this.s) { this.s = this.read() || demoSeed(); this.write(); } return this.s; },
    write() { this.memory = this.s; safeSet(localStorage, DEMO_KEY, JSON.stringify(this.s)); },
    tx(fn) {
      this.s = this.read() || this.get();
      const before = {};
      for (const [id, x] of Object.entries(this.s.seats)) before[id] = x.status + '|' + x.hold_expires_at;
      const out = fn(this.s);
      this.write();
      const changed = [];
      for (const [id, x] of Object.entries(this.s.seats)) if (before[id] !== x.status + '|' + x.hold_expires_at) changed.push(x);
      for (const id of Object.keys(before)) if (!this.s.seats[id]) changed.push({ id, _deleted: true });
      if (changed.length) this.emit(changed);
      return out;
    },
    emit(rows) { for (const l of this.listeners) rows.forEach((r) => l(JSON.parse(JSON.stringify(r)))); },
    reset() { this.s = demoSeed(); this.write(); this.emit(Object.values(this.s.seats)); },
  };
  window.addEventListener('storage', (e) => {
    if (e.key !== DEMO_KEY || !e.newValue) return;
    const old = demo.s; try { demo.s = JSON.parse(e.newValue); } catch (x) { return; }
    const rows = Object.values(demo.s.seats).filter((x) => !old || !old.seats[x.id] ||
      old.seats[x.id].status !== x.status || old.seats[x.id].hold_expires_at !== x.hold_expires_at);
    if (rows.length) demo.emit(rows);
  });
  ITO.resetDemo = () => demo.reset();

  // 가상의 다른 관객들이 좌석을 점유·예약하는 모습을 시뮬레이션
  let botTimer = null;
  function startBots() {
    if (botTimer) return;
    botTimer = setInterval(() => {
      demo.tx((s) => {
        demoCleanup(s);
        const now = Date.now();
        // 점유 중인 가상 관객: 일부는 예약 확정
        const bots = {};
        for (const [seatId, h] of Object.entries(s.holds)) if (h.session_id.startsWith('bot-')) (bots[h.session_id] = bots[h.session_id] || []).push(seatId);
        for (const [sid, ids] of Object.entries(bots)) {
          const h = s.holds[ids[0]];
          if (now > h.decide_at) {
            if (Math.random() < 0.55) demoReserve(s, ids, DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)], '010' + Math.floor(10000000 + Math.random() * 89999999), 'online', null, sid);
            else for (const i of ids) { s.seats[i].status = 'available'; s.seats[i].hold_expires_at = null; delete s.holds[i]; }
          }
        }
        const active = Object.keys(bots).length;
        const free = Object.values(s.seats).filter((x) => x.status === 'available' && x.kind !== 'wheelchair');
        if (active < 3 && free.length > 40 && Math.random() < 0.6) {
          const start = free[Math.floor(Math.random() * free.length)];
          const n = 1 + Math.floor(Math.random() * 3);
          const sid = 'bot-' + uuid();
          const exp = new Date(now + 10 * 60000).toISOString();
          const decide = now + 8000 + Math.random() * 20000;
          for (let k = 0; k < n; k++) {
            const id = `${start.floor}-${start.row_label}-${start.seat_no + k}`;
            const seat = s.seats[id];
            if (!seat || seat.status !== 'available') break;
            seat.status = 'held'; seat.hold_expires_at = exp;
            s.holds[id] = { session_id: sid, expires_at: exp, decide_at: decide };
          }
        }
      });
    }, 3000);
  }

  function createDemoPublic() {
    const sid = sessionId();
    const delay = (v) => new Promise((res) => setTimeout(() => res(v), 120 + Math.random() * 180));
    const run = (fn) => delay().then(() => demo.tx(fn));
    const activeHolds = (s) => Object.entries(s.holds)
      .filter(([id, h]) => h.session_id === sid && s.seats[id] && s.seats[id].status === 'held' && new Date(s.seats[id].hold_expires_at).getTime() > Date.now());

    return {
      mode: 'demo',
      sessionId: sid,
      now: () => Date.now(),
      async load() {
        await delay();
        const s = demo.tx((x) => { demoCleanup(x); return x; });
        return JSON.parse(JSON.stringify({ settings: s.settings, sections: s.sections, seats: Object.values(s.seats) }));
      },
      async loadSeats() { return JSON.parse(JSON.stringify(Object.values(demo.get().seats))); },
      subscribe(onSeat, onStatus) {
        demo.listeners.add(onSeat); startBots();
        setTimeout(() => onStatus && onStatus('live'), 300);
        return () => demo.listeners.delete(onSeat);
      },
      hold: (seatId) => run((s) => {
        if (!s.settings.reservation_open) throw err('CLOSED');
        const seat = s.seats[seatId]; if (!seat) throw err('NOT_FOUND');
        if (seat.status === 'reserved') throw err('ALREADY_RESERVED');
        if (seat.status === 'blocked') throw err('BLOCKED');
        if (seat.status === 'held' && new Date(seat.hold_expires_at).getTime() > Date.now()) {
          if (s.holds[seatId] && s.holds[seatId].session_id === sid) return { seat_id: seatId, expires_at: seat.hold_expires_at };
          throw err('HELD_BY_OTHER');
        }
        const mine = activeHolds(s);
        if (mine.length >= s.settings.max_seats_per_person) throw err('LIMIT_EXCEEDED');
        const exp = mine.length ? s.seats[mine[0][0]].hold_expires_at : new Date(Date.now() + s.settings.hold_minutes * 60000).toISOString();
        s.holds[seatId] = { session_id: sid, expires_at: exp };
        seat.status = 'held'; seat.hold_expires_at = exp;
        return { seat_id: seatId, expires_at: exp };
      }),
      release: (seatId) => run((s) => {
        const h = s.holds[seatId]; if (!h || h.session_id !== sid) return false;
        delete s.holds[seatId];
        if (s.seats[seatId].status === 'held') { s.seats[seatId].status = 'available'; s.seats[seatId].hold_expires_at = null; }
        return true;
      }),
      releaseAll: () => run((s) => {
        let n = 0;
        for (const [id, h] of Object.entries(s.holds)) if (h.session_id === sid) {
          delete s.holds[id]; if (s.seats[id].status === 'held') { s.seats[id].status = 'available'; s.seats[id].hold_expires_at = null; n++; }
        }
        return n;
      }),
      myHolds: () => delay(activeHolds(demo.get()).map(([id]) => ({ seat_id: id, expires_at: demo.get().seats[id].hold_expires_at }))),
      confirm: ({ seatIds, name, phone, agree, pin }) => run((s) => {
        if (!agree) throw err('AGREE_REQUIRED');
        if (!/^\d{4,6}$/.test(pin || '')) throw err('INVALID_PIN');
        name = String(name || '').trim();
        if (name.length < 1 || name.length > 30) throw err('INVALID_NAME');
        const p = normPhone(phone);
        const ids = [...new Set(seatIds)];
        if (!ids.length) throw err('NO_SEATS');
        const dup = s.reservations.find((r) => r.session_id === sid && r.status === 'confirmed' &&
          r.seat_ids.length === ids.length && ids.every((i) => r.seat_ids.includes(i)));
        if (dup) return { reservation_no: dup.reservation_no, name: dup.name, phone: fmtPhone(dup.phone), seats: dup.seat_labels, seat_ids: dup.seat_ids, created_at: dup.created_at, duplicate: true };
        if (!s.settings.reservation_open) throw err('CLOSED');
        if (ids.length > s.settings.max_seats_per_person) throw err('LIMIT_EXCEEDED');
        const now = Date.now();
        const okCount = ids.filter((i) => s.seats[i] && s.seats[i].status === 'held' && new Date(s.seats[i].hold_expires_at).getTime() > now && s.holds[i] && s.holds[i].session_id === sid).length;
        if (okCount !== ids.length) {
          if (ids.some((i) => s.seats[i] && s.seats[i].status === 'reserved')) throw err('ALREADY_RESERVED');
          throw err('HOLD_EXPIRED');
        }
        const used = s.reservations.filter((r) => r.phone === p && r.status === 'confirmed').reduce((a, r) => a + r.seat_ids.length, 0);
        if (used + ids.length > s.settings.max_seats_per_person) throw err('PHONE_LIMIT');
        const r = demoReserve(s, ids, name, p, 'online', null, sid);
        r.pin = demoPin(pin); r.pin_fails = 0;
        return { reservation_no: r.reservation_no, name: r.name, phone: fmtPhone(r.phone), seats: r.seat_labels, seat_ids: r.seat_ids, created_at: r.created_at, duplicate: false };
      }),
      lookup: async (name, phone) => {
        const p = normPhone(phone); await delay();
        return demo.get().reservations.filter((r) => r.status === 'confirmed' && r.phone === p && r.name === String(name).trim())
          .map((r) => ({ reservation_no: r.reservation_no, name: r.name, phone: fmtPhone(r.phone), seats: r.seat_labels, picked_up: r.picked_up, created_at: r.created_at }));
      },
      cleanup: async () => demo.tx((s) => demoCleanup(s).length),
      manageLogin: (name, phone, pin) => run((s) => {
        if (!/^\d{4,6}$/.test(pin || '')) throw err('INVALID_PIN');
        const p = normPhone(phone); const list = s.reservations.filter((r) => r.status === 'confirmed' && r.phone === p && r.name === String(name).trim());
        if (list.some((r) => r.pin_locked_until > Date.now())) return { error: 'PIN_LOCKED' };
        const ok = list.filter((r) => r.pin && r.pin === demoPin(pin));
        if (!ok.length) { list.forEach((r) => { if (r.pin) { r.pin_fails = (r.pin_fails || 0) + 1; if (r.pin_fails >= 5) r.pin_locked_until = Date.now() + 15 * 60000; } }); return { error: 'PIN_MISMATCH' }; }
        ok.forEach((r) => { r.pin_fails = 0; r.pin_locked_until = 0; });
        return { reservations: ok.map(resJson) };
      }).then(unwrap('reservations')),
      updateMyInfo: (no, pin, name, phone) => run((s) => {
        const r = demoAuth(s, no, pin); if (r.error) return r;
        name = String(name || '').trim(); if (!name || name.length > 30) throw err('INVALID_NAME');
        const p = normPhone(phone);
        if (p !== r.phone) {
          const used = s.reservations.filter((x) => x.phone === p && x.status === 'confirmed' && x.id !== r.id).reduce((a, x) => a + x.seat_ids.length, 0);
          if (used + r.seat_ids.length > s.settings.max_seats_per_person) throw err('PHONE_LIMIT');
        }
        r.name = name; r.phone = p; r.updated_at = new Date().toISOString();
        return { reservation: resJson(r) };
      }).then(unwrap('reservation')),
      changeMySeats: (no, pin, seatIds) => run((s) => {
        const r = demoAuth(s, no, pin); if (r.error) return r;
        if (r.picked_up) throw err('ALREADY_PICKED_UP');
        if (!s.settings.reservation_open) throw err('CLOSED');
        const ids = [...new Set(seatIds)]; if (!ids.length) throw err('NO_SEATS');
        if (ids.length > s.settings.max_seats_per_person) throw err('LIMIT_EXCEEDED');
        const added = ids.filter((i) => !r.seat_ids.includes(i)); const dropped = r.seat_ids.filter((i) => !ids.includes(i));
        if (!added.length && !dropped.length) return { reservation: resJson(r) };
        const now = Date.now();
        if (!added.every((i) => s.seats[i] && s.seats[i].status === 'held' && new Date(s.seats[i].hold_expires_at).getTime() > now && s.holds[i] && s.holds[i].session_id === sid)) {
          if (added.some((i) => s.seats[i] && s.seats[i].status === 'reserved')) throw err('ALREADY_RESERVED');
          throw err('HOLD_EXPIRED');
        }
        const used = s.reservations.filter((x) => x.phone === r.phone && x.status === 'confirmed' && x.id !== r.id).reduce((a, x) => a + x.seat_ids.length, 0);
        if (used + ids.length > s.settings.max_seats_per_person) throw err('PHONE_LIMIT');
        for (const i of dropped) { s.seats[i].status = 'available'; s.seats[i].hold_expires_at = null; }
        for (const i of added) { s.seats[i].status = 'reserved'; s.seats[i].hold_expires_at = null; delete s.holds[i]; }
        r.seat_ids = sortIds(s, ids); r.seat_labels = r.seat_ids.map((i) => s.seats[i].label); r.updated_at = new Date().toISOString();
        return { reservation: resJson(r) };
      }).then(unwrap('reservation')),
      cancelMy: (no, pin) => run((s) => {
        const r = demoAuth(s, no, pin); if (r.error) return r;
        if (r.picked_up) throw err('ALREADY_PICKED_UP');
        for (const i of r.seat_ids) if (s.seats[i] && s.seats[i].status === 'reserved') s.seats[i].status = 'available';
        r.status = 'cancelled'; r.cancelled_at = r.updated_at = new Date().toISOString();
        return { ok: true };
      }).then(unwrap('ok')),
    };
  }
  // 데모 전용 (실제 서비스는 DB 에서 salt + SHA-256 으로 처리)
  function demoPin(pin) { let h = 7; for (const c of 'ito-demo:' + pin) h = (h * 31 + c.charCodeAt(0)) >>> 0; return 'd' + h.toString(36); }
  function resJson(r) { return { reservation_no: r.reservation_no, name: r.name, phone: fmtPhone(r.phone), seats: r.seat_labels, seat_ids: r.seat_ids, picked_up: r.picked_up, created_at: r.created_at, updated_at: r.updated_at || null }; }
  function demoAuth(s, no, pin) {
    const r = s.reservations.find((x) => x.reservation_no === String(no || '').trim().toUpperCase() && x.status === 'confirmed');
    if (!r) return { error: 'PIN_MISMATCH' };
    if (!r.pin) return { error: 'NO_PIN' };
    if (r.pin_locked_until > Date.now()) return { error: 'PIN_LOCKED' };
    if (r.pin !== demoPin(pin)) { r.pin_fails = (r.pin_fails || 0) + 1; if (r.pin_fails >= 5) { r.pin_locked_until = Date.now() + 15 * 60000; return { error: 'PIN_LOCKED' }; } return { error: 'PIN_MISMATCH' }; }
    r.pin_fails = 0; r.pin_locked_until = 0; return r;
  }

  function createDemoAdmin() {
    const pub = createDemoPublic();
    const AUTH = 'ito-demo-admin';
    const need = () => { if (safeGet(sessionStorage, AUTH) !== '1') throw err('UNAUTHORIZED'); };
    const run = (fn) => new Promise((res, rej) => setTimeout(() => { try { need(); res(demo.tx(fn)); } catch (e) { rej(e); } }, 150));
    return {
      mode: 'demo',
      now: () => Date.now(),
      loadPublic: pub.load,
      subscribe: pub.subscribe,
      async login(password) {
        await new Promise((r) => setTimeout(r, 300));
        if (password !== 'admin1234') throw err('BAD_PASSWORD');
        safeSet(sessionStorage, AUTH, '1'); return { ok: true };
      },
      async logout() { try { sessionStorage.removeItem(AUTH); } catch (e) { /* noop */ } return { ok: true }; },
      async me() { return safeGet(sessionStorage, AUTH) === '1'; },
      overview: () => run((s) => {
        demoCleanup(s);
        const seats = Object.values(s.seats); const now = Date.now();
        const conf = s.reservations.filter((r) => r.status === 'confirmed');
        return JSON.parse(JSON.stringify({
          stats: {
            total_seats: seats.length,
            available: seats.filter((x) => x.status === 'available').length,
            held: seats.filter((x) => x.status === 'held' && new Date(x.hold_expires_at).getTime() > now).length,
            reserved: seats.filter((x) => x.status === 'reserved').length,
            blocked: seats.filter((x) => x.status === 'blocked').length,
            reservations: conf.length,
            picked_up: conf.filter((r) => r.picked_up).length,
            picked_up_seats: conf.filter((r) => r.picked_up).reduce((a, r) => a + r.seat_ids.length, 0),
            cancelled: s.reservations.length - conf.length,
          },
          reservations: s.reservations.slice().sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .map((r) => ({ ...r, pin: undefined, phone: fmtPhone(r.phone), seats: r.seat_labels, has_pin: !!r.pin, pin_locked: r.pin_locked_until > Date.now() })),
          server_time: new Date().toISOString(),
        }));
      }),
      cancel: (id) => run((s) => {
        const r = s.reservations.find((x) => x.id === id); if (!r) throw err('NOT_FOUND');
        if (r.status === 'cancelled') throw err('ALREADY_CANCELLED');
        for (const i of r.seat_ids) if (s.seats[i] && s.seats[i].status === 'reserved') s.seats[i].status = 'available';
        r.status = 'cancelled'; r.cancelled_at = new Date().toISOString();
        return { ok: true };
      }),
      pickup: (id, picked) => run((s) => {
        const r = s.reservations.find((x) => x.id === id && x.status === 'confirmed'); if (!r) throw err('NOT_FOUND');
        r.picked_up = !!picked; r.picked_up_at = picked ? new Date().toISOString() : null; return { ok: true };
      }),
      updateReservation: (id, name, phone, memo) => run((s) => {
        const r = s.reservations.find((x) => x.id === id); if (!r) throw err('NOT_FOUND');
        name = String(name || '').trim(); if (!name || name.length > 30) throw err('INVALID_NAME');
        r.name = name; r.phone = normPhone(phone); r.memo = String(memo || '').trim() || null; r.updated_at = new Date().toISOString(); return { ok: true };
      }),
      setSeatStatus: (seatId, status) => run((s) => {
        const seat = s.seats[seatId]; if (!seat) throw err('NOT_FOUND');
        if (!['available', 'blocked'].includes(status)) throw err('INVALID_STATUS');
        if (seat.status === 'reserved') {
          if (status === 'blocked') throw err('RESERVED_CANCEL_FIRST');
          const r = s.reservations.find((x) => x.status === 'confirmed' && x.seat_ids.includes(seatId));
          if (r) {
            r.seat_ids = r.seat_ids.filter((x) => x !== seatId); r.seat_labels = r.seat_labels.filter((x) => x !== seat.label);
            if (!r.seat_ids.length) { r.status = 'cancelled'; r.cancelled_at = new Date().toISOString(); }
          }
        }
        delete s.holds[seatId]; seat.status = status; seat.hold_expires_at = null; return { ok: true };
      }),
      createReservation: (seatIds, name, phone, memo) => run((s) => {
        name = String(name || '').trim(); if (!name || name.length > 30) throw err('INVALID_NAME');
        const p = normPhone(phone); const ids = [...new Set(seatIds)]; if (!ids.length) throw err('NO_SEATS');
        const now = Date.now();
        if (!ids.every((i) => s.seats[i] && (['available', 'blocked'].includes(s.seats[i].status) ||
          (s.seats[i].status === 'held' && new Date(s.seats[i].hold_expires_at).getTime() <= now)))) throw err('SEAT_UNAVAILABLE');
        const r = demoReserve(s, ids, name, p, 'admin', memo, null);
        r.created_at = new Date().toISOString();
        return { ok: true, reservation_no: r.reservation_no };
      }),
      resetPin: (id, pin) => run((s) => {
        if (!/^\d{4,6}$/.test(pin || '')) throw err('INVALID_PIN');
        const r = s.reservations.find((x) => x.id === id && x.status === 'confirmed'); if (!r) throw err('NOT_FOUND');
        r.pin = demoPin(pin); r.pin_fails = 0; r.pin_locked_until = 0; return { ok: true };
      }),
      updateSettings: (settings) => run((s) => {
        const x = { ...settings };
        if (x.max_seats_per_person != null) x.max_seats_per_person = Math.max(1, Math.min(20, +x.max_seats_per_person));
        if (x.hold_minutes != null) x.hold_minutes = Math.max(2, Math.min(30, +x.hold_minutes));
        if (x.pamphlet_url && !/^https?:\/\//.test(x.pamphlet_url)) throw err('INVALID_URL');
        Object.assign(s.settings, x); return s.settings;
      }),
      saveLayout: (sections, dsl) => run((s) => { const n = demoApplyLayout(s, sections); if (dsl != null) s.settings.layout_dsl = dsl; return { ok: true, total_seats: n }; }),
    };
  }

  ITO.createPublicBackend = () => {
    const m = ITO.backendMode();
    return m === 'live' ? createLivePublic() : m === 'demo' ? createDemoPublic() : createErrorBackend(m.split(':')[1]);
  };
  ITO.createAdminBackend = () => {
    const m = ITO.backendMode();
    return m === 'live' ? createLiveAdmin() : m === 'demo' ? createDemoAdmin() : createErrorBackend(m.split(':')[1]);
  };
})();
