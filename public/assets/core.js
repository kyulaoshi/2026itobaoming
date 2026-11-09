/* 공통 UI 도우미 · 좌석 배치도 렌더러 */
(function () {
  'use strict';
  const ITO = (window.ITO = window.ITO || {});

  ITO.$ = (sel, root) => (root || document).querySelector(sel);
  ITO.$$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
  ITO.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  ITO.nl2br = (s) => ITO.esc(s).replace(/\n/g, '<br>');

  ITO.formatPhoneInput = function (v) {
    const d = String(v || '').replace(/\D/g, '').slice(0, 11);
    if (d.length < 4) return d;
    if (d.length < 8) return `${d.slice(0, 3)}-${d.slice(3)}`;
    if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
    return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  };
  ITO.bindPhoneInput = function (input) {
    input.addEventListener('input', () => {
      const pos = input.selectionStart; const before = input.value.length;
      input.value = ITO.formatPhoneInput(input.value);
      const diff = input.value.length - before;
      try { input.setSelectionRange(pos + diff, pos + diff); } catch (e) { /* noop */ }
    });
  };
  ITO.validPhone = (v) => /^01[016789]\d{7,8}$/.test(String(v || '').replace(/\D/g, ''));

  ITO.fmtDateTime = function (iso) {
    if (!iso) return '';
    const d = new Date(iso); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  ITO.fmtCountdown = (ms) => {
    const t = Math.max(0, Math.ceil(ms / 1000));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  };

  const MESSAGES = {
    ALREADY_RESERVED: '이미 예약이 완료된 좌석입니다. 다른 좌석을 선택해 주세요.',
    HELD_BY_OTHER: '다른 관객이 예약을 진행 중인 좌석입니다. 잠시 후 다시 확인해 주세요.',
    BLOCKED: '예약할 수 없는 좌석입니다.',
    LIMIT_EXCEEDED: '1인당 최대 {max}석까지 예약할 수 있습니다.',
    PHONE_LIMIT: '이 연락처로 이미 예약한 좌석이 있어 1인당 최대 {max}석을 넘게 됩니다.',
    HOLD_EXPIRED: '좌석 선택 시간이 만료되었거나 다른 관객이 먼저 예약했습니다. 좌석을 다시 선택해 주세요.',
    CLOSED: '현재 좌석 예약이 마감되었습니다.',
    INVALID_PHONE: '연락처를 정확히 입력해 주세요. (예: 010-1234-5678)',
    INVALID_NAME: '신청자 이름을 입력해 주세요. (30자 이내)',
    AGREE_REQUIRED: '개인정보 수집 및 이용에 동의해 주세요.',
    NO_SEATS: '좌석을 먼저 선택해 주세요.',
    NOT_FOUND: '대상을 찾을 수 없습니다. 새로고침 후 다시 시도해 주세요.',
    NETWORK: '네트워크 연결이 원활하지 않습니다. 잠시 후 다시 시도해 주세요.',
    UNAUTHORIZED: '관리자 로그인이 필요합니다.',
    BAD_PASSWORD: '비밀번호가 올바르지 않습니다.',
    TOO_MANY_ATTEMPTS: '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.',
    SERVER_CONFIG: '서버 환경변수가 설정되지 않았습니다. README 의 배포 안내를 확인해 주세요.',
    RESERVED_CANCEL_FIRST: '예약된 좌석입니다. 먼저 해당 좌석의 예약을 취소해 주세요.',
    SEAT_UNAVAILABLE: '선택한 좌석 중 이미 예약되었거나 진행 중인 좌석이 있습니다.',
    LAYOUT_CONFLICT: '예약·진행 중인 좌석이 사라지는 배치 변경은 할 수 없습니다: {detail}',
    INVALID_ROWS: '열별 좌석 수를 확인해 주세요. (열 1~60개, 열당 0~80석)',
    INVALID_SECTION_CODE: '구역 코드는 영문 대문자 1~3자로 입력해 주세요. (예: A, B, BL)',
    ALREADY_CANCELLED: '이미 취소된 예약입니다.',
    INVALID_STATUS: '변경할 수 없는 상태입니다.',
    INVALID_URL: '팸플릿 주소는 http:// 또는 https:// 로 시작해야 합니다.',
    DUPLICATE_SEAT: '같은 좌석이 두 번 정의되었습니다: {detail}',
  };
  ITO.message = function (e, vars) {
    const code = (e && e.code) || 'UNKNOWN';
    let m = MESSAGES[code] || '일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
    const v = Object.assign({ detail: (e && e.detail) || '' }, vars || {});
    return m.replace(/\{(\w+)\}/g, (_, k) => (v[k] != null ? v[k] : ''));
  };

  /* ---------- 토스트 ---------- */
  ITO.toast = function (msg, type) {
    let wrap = ITO.$('.toasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; wrap.setAttribute('aria-live', 'polite'); document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = `toast ${type || ''}`; t.textContent = msg;
    wrap.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 4200 : 2800);
  };

  /* ---------- 모달 (alert/confirm 대체) ---------- */
  ITO.modal = function ({ title, body, actions, wide, onOpen }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'modal-backdrop';
      back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mdl-t">
        <div class="modal-head"><h3 id="mdl-t">${ITO.esc(title || '')}</h3><button class="icon-btn" data-v="" aria-label="닫기">✕</button></div>
        <div class="modal-body"></div><div class="modal-foot"></div></div>`;
      const bodyEl = ITO.$('.modal-body', back);
      if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.appendChild(body);
      const foot = ITO.$('.modal-foot', back);
      (actions || [{ label: '확인', value: true, primary: true }]).forEach((a) => {
        const b = document.createElement('button');
        b.className = `btn ${a.primary ? 'btn-gold' : a.danger ? 'btn-danger' : 'btn-ghost'}`;
        b.textContent = a.label; b.dataset.v = '1';
        b.addEventListener('click', async () => {
          if (a.onClick) {
            b.disabled = true;
            try { const r = await a.onClick(bodyEl); if (r === false) { b.disabled = false; return; } }
            catch (e) { b.disabled = false; return; }
          }
          close(a.value);
        });
        foot.appendChild(b);
      });
      const prev = document.activeElement;
      function close(v) {
        back.classList.remove('show'); document.removeEventListener('keydown', onKey);
        setTimeout(() => back.remove(), 200); if (prev && prev.focus) prev.focus(); resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      ITO.$('.icon-btn', back).addEventListener('click', () => close(null));
      back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(back);
      requestAnimationFrame(() => back.classList.add('show'));
      const f = ITO.$('input,select,textarea', bodyEl) || ITO.$('.btn-gold', foot) || ITO.$('.btn', foot);
      if (f) setTimeout(() => f.focus(), 50);
      if (onOpen) onOpen(bodyEl, close);
    });
  };

  /* ---------- 좌석 배치 정의 (텍스트 형식) ----------
   *  [블록코드 | 층 | 블록 이름]   블록 시작
   *  A 5-15                       A열 5~15번
   *  E-I 3-15                     E~I열 각각 3~15번
   *  U 3-13, w14-15               w(또는 ♿) = 휠체어석
   *  --                           바로 위 열 다음에 가로 통로
   *  # 메모                        주석
   */
  ITO.DEFAULT_LAYOUT = `# ───── 1층 (874석) ─────
[1L | 1 | 1층 좌측]
A 5-15
B 4-15
C 3-15
D 2-15
E-I 3-15
J-L 2-15
--
M-N 2-15
O-T 1-15
U 3-13, w14-15

[1C | 1 | 1층 중앙]
A-K 16-31
L w16-25
--
M-S 16-31

[1R | 1 | 1층 우측]
A 32-42
B 32-43
C 32-44
D 32-45
E-I 32-44
J-L 32-45
--
M-N 32-45
O-T 32-46
U w32-33, 34-44

# ───── 2층 (436석) ─────
[2L | 2 | 2층 좌측]
A-B 1-5
C-D 1-10
--
E-G 1-10
H 2-10
I 3-10
J 5-10
K 6-10
L 7-10

[2CL | 2 | 2층 중앙 좌측]
C-D 11-20
--
E-H 11-14
I-L 11-20

[2C | 2 | 2층 중앙]
C-D 21-30
--
E-L 21-30

[2CR | 2 | 2층 중앙 우측]
C-D 31-40
--
E-H 37-40
I-L 31-40

[2R | 2 | 2층 우측]
A-B 46-50
C-D 41-50
--
E-G 41-50
H 41-49
I 41-48
J 41-46
K 41-45
L 41-44
`;

  const rowKey = (r) => [r.length, r];
  const cmpRow = (a, b) => (a.length - b.length) || (a < b ? -1 : a > b ? 1 : 0);
  ITO.cmpRow = cmpRow;

  ITO.parseLayout = function (text) {
    const errors = []; const sections = []; let cur = null; let sort = 0;
    const seen = new Map();
    String(text || '').split(/\r?\n/).forEach((raw, i) => {
      const ln = i + 1;
      const line = raw.replace(/#.*$/, '').trim();
      if (!line) return;
      let m = line.match(/^\[\s*([A-Za-z0-9]{1,4})\s*\|\s*(\d{1,2})\s*\|\s*([^\]|]{1,30})\]$/);
      if (m) {
        const code = m[1].toUpperCase();
        if (sections.some((x) => x.code === code)) errors.push(`${ln}번째 줄: 블록 코드 ${code} 가 중복되었습니다.`);
        cur = { code, floor: +m[2], name: m[3].trim(), sort: ++sort, breaks: [], rows: [] };
        if (cur.floor < 1 || cur.floor > 9) errors.push(`${ln}번째 줄: 층은 1~9 사이 숫자로 입력하세요.`);
        sections.push(cur); return;
      }
      if (!cur) { errors.push(`${ln}번째 줄: 먼저 [코드 | 층 | 이름] 줄로 블록을 시작하세요.`); return; }
      if (/^-{2,}$/.test(line)) { const last = cur.rows[cur.rows.length - 1]; if (last && !cur.breaks.includes(last.r)) cur.breaks.push(last.r); return; }
      m = line.match(/^([A-Za-z]{1,2})(?:\s*-\s*([A-Za-z]))?\s+(.+)$/);
      if (!m) { errors.push(`${ln}번째 줄: "${line}" 형식을 이해할 수 없습니다. 예) A 5-15`); return; }
      let labels = [m[1].toUpperCase()];
      if (m[2]) {
        const a = m[1].toUpperCase().charCodeAt(0), b = m[2].toUpperCase().charCodeAt(0);
        if (m[1].length !== 1 || b < a) { errors.push(`${ln}번째 줄: 열 범위가 잘못되었습니다.`); return; }
        labels = []; for (let c = a; c <= b; c++) labels.push(String.fromCharCode(c));
      }
      const seats = [], wheel = [];
      for (const part of m[3].split(/[,\s]+/).filter(Boolean)) {
        const pm = part.match(/^(w|W|♿)?(\d{1,3})(?:-(\d{1,3}))?$/);
        if (!pm) { errors.push(`${ln}번째 줄: "${part}" 는 좌석 번호 형식이 아닙니다. 예) 3-15, w14-15`); return; }
        const a = +pm[2], b = pm[3] ? +pm[3] : a;
        if (a < 1 || b > 300 || b < a) { errors.push(`${ln}번째 줄: 좌석 번호 범위 ${part} 를 확인하세요.`); return; }
        for (let n = a; n <= b; n++) (pm[1] ? wheel : seats).push(n);
      }
      for (const r of labels) {
        let row = cur.rows.find((x) => x.r === r);
        if (!row) { row = { r, seats: [], wheel: [] }; cur.rows.push(row); }
        for (const n of seats) row.seats.push(n);
        for (const n of wheel) row.wheel.push(n);
        for (const n of [...seats, ...wheel]) {
          const k = `${cur.floor}-${r}-${n}`;
          if (seen.has(k)) errors.push(`${ln}번째 줄: ${cur.floor}층 ${r}열 ${n}번이 중복되었습니다 (${seen.get(k)}번째 줄).`);
          else seen.set(k, ln);
        }
      }
    });
    // 층별 열 순서 → 행 인덱스
    const floors = {};
    for (const sec of sections) { const f = (floors[sec.floor] = floors[sec.floor] || { labels: new Set(), seats: 0, wheel: 0 }); sec.rows.forEach((r) => { f.labels.add(r.r); f.seats += r.seats.length; f.wheel += r.wheel.length; }); }
    for (const sec of sections) {
      const order = [...floors[sec.floor].labels].sort(cmpRow);
      sec.rows.forEach((r) => { r.idx = order.indexOf(r.r) + 1; r.seats.sort((a, b) => a - b); r.wheel.sort((a, b) => a - b); });
    }
    let total = 0; const summary = {};
    for (const [f, v] of Object.entries(floors)) { summary[f] = v.seats + v.wheel; total += v.seats + v.wheel; }
    if (!sections.length) errors.push('블록이 하나도 없습니다.');
    return { sections, errors, total, floors: summary };
  };
  ITO.seatLabel = (floor, r, n, wheel) => `${floor}층 ${r}열 ${n}번${wheel ? ' (휠체어석)' : ''}`;
  // 정의 → 좌석 목록 (데모·미리보기용. 실제 DB 는 같은 규칙으로 서버에서 생성)
  ITO.layoutToSeats = function (sections) {
    const out = [];
    for (const sec of sections) for (const r of sec.rows) {
      for (const n of r.seats) out.push({ id: `${sec.floor}-${r.r}-${n}`, section: sec.code, floor: sec.floor, row_label: r.r, row_no: r.idx, seat_no: n, kind: 'normal', label: ITO.seatLabel(sec.floor, r.r, n), status: 'available', hold_expires_at: null });
      for (const n of r.wheel) out.push({ id: `${sec.floor}-${r.r}-${n}`, section: sec.code, floor: sec.floor, row_label: r.r, row_no: r.idx, seat_no: n, kind: 'wheelchair', label: ITO.seatLabel(sec.floor, r.r, n, true), status: 'available', hold_expires_at: null });
    }
    return out;
  };
  ITO.seatCmp = (a, b) => (a.floor - b.floor) || (a.row_no - b.row_no) || (a.seat_no - b.seat_no);

  /* ---------- 좌석 배치도 (도면 위치 그대로 그리드에 배치) ---------- */
  class SeatMap {
    constructor(el, opts) {
      this.el = el; this.opts = opts || {};
      this.btns = new Map();
      this.zoom = 1;
      el.addEventListener('click', (e) => {
        const b = e.target.closest('.seat'); if (!b || !el.contains(b)) return;
        this.opts.onClick && this.opts.onClick(b.dataset.id, b);
      });
    }
    render(sections, seats) {
      this.sections = sections; this.seats = seats;
      const esc = ITO.esc;
      const byFloor = new Map();
      for (const s of seats.values()) { if (!byFloor.has(s.floor)) byFloor.set(s.floor, []); byFloor.get(s.floor).push(s); }
      const floors = [...byFloor.keys()].sort((a, b) => a - b);
      let html = '';
      floors.forEach((f, fi) => {
        const list = byFloor.get(f);
        const secs = sections.filter((x) => x.floor === f).sort((a, b) => a.sort - b.sort);
        // 블록별 번호 범위
        const ext = new Map();
        for (const s of list) { const e = ext.get(s.section) || { min: Infinity, max: -Infinity }; e.min = Math.min(e.min, s.seat_no); e.max = Math.max(e.max, s.seat_no); ext.set(s.section, e); }
        const blocks = secs.filter((x) => ext.has(x.code));
        // 열 순서 및 통로
        const rowMap = new Map(); for (const s of list) rowMap.set(s.row_no, s.row_label);
        const rowNos = [...rowMap.keys()].sort((a, b) => a - b);
        const breaks = new Set(); secs.forEach((x) => (x.breaks || []).forEach((b) => breaks.add(b)));
        const gridRow = new Map(); let gr = 1; const rowTracks = [];
        rowNos.forEach((rn, i) => { gridRow.set(rn, gr++); rowTracks.push('var(--s)'); if (breaks.has(rowMap.get(rn)) && i < rowNos.length - 1) { gr++; rowTracks.push('var(--aisle)'); } });
        // 열(가로) 트랙
        const colStart = new Map(); const colTracks = ['var(--lw)']; let gc = 2;
        blocks.forEach((b, i) => {
          if (i > 0) { colTracks.push('var(--aisle)'); gc++; }
          const e = ext.get(b.code); colStart.set(b.code, gc - e.min);
          const w = e.max - e.min + 1; colTracks.push(`repeat(${w}, var(--s))`); gc += w;
        });
        colTracks.push('var(--lw)'); const lastCol = gc;
        const count = list.length;
        html += `<section class="floor" data-floor="${f}" id="floor-${f}">`;
        html += `<div class="floor-head"><b>${f}층</b><span>${count.toLocaleString()}석</span></div>`;
        if (fi === 0) html += `<div class="stage" aria-hidden="true"><span>STAGE</span><em>무대</em></div>`;
        html += `<div class="fgrid" style="grid-template-columns:${colTracks.join(' ')};grid-template-rows:${rowTracks.join(' ')}">`;
        for (const rn of rowNos) {
          const lab = esc(rowMap.get(rn)); const r = gridRow.get(rn);
          html += `<span class="rl" style="grid-area:${r}/1">${lab}</span><span class="rl" style="grid-area:${r}/${lastCol}">${lab}</span>`;
        }
        for (const s of list) {
          const c = colStart.get(s.section) + s.seat_no; const r = gridRow.get(s.row_no);
          const wc = s.kind === 'wheelchair';
          html += `<button type="button" class="seat${wc ? ' wc' : ''}" data-id="${esc(s.id)}" title="${esc(s.label)}" style="grid-area:${r}/${c}"><span>${wc ? '♿' : s.seat_no}</span></button>`;
        }
        html += `</div></section>`;
      });
      this.el.innerHTML = html || '<div class="loading-screen">좌석이 없습니다.</div>';
      this.btns.clear();
      ITO.$$('.seat', this.el).forEach((b) => this.btns.set(b.dataset.id, b));
      for (const b of this.btns.values()) b.dataset.state = '';
      this.updateAll();
    }
    update(id) {
      const b = this.btns.get(id); const s = this.seats && this.seats.get(id);
      if (!b || !s) return;
      const st = this.opts.stateOf(s);
      if (b.dataset.state !== st) {
        b.dataset.state = st;
        b.className = `seat s-${st}${s.kind === 'wheelchair' ? ' wc' : ''}`;
        const extra = { free: '예약 가능', mine: '선택함', taken: '예약 완료', held: '다른 관객 진행 중', blocked: '예약 불가', picked: '수령 완료', sel: '선택함' }[st] || '';
        b.setAttribute('aria-label', `${s.label} — ${extra}`);
        b.setAttribute('aria-pressed', st === 'mine' || st === 'sel' ? 'true' : 'false');
      }
    }
    updateAll() { for (const id of this.btns.keys()) this.update(id); }
    setZoom(z) {
      this.zoom = Math.max(0.3, Math.min(1.8, z));
      this.el.style.setProperty('--z', this.zoom);
      return this.zoom;
    }
    width() { return Math.max(0, ...ITO.$$('.fgrid', this.el).map((g) => g.scrollWidth)); }
    fit(container) {
      this.setZoom(1);
      const avail = container.clientWidth - 24; const need = this.width();
      if (need > avail) this.setZoom(avail / need);
      return this.zoom;
    }
    scrollToFloor(container, f) {
      const el = ITO.$(`#floor-${f}`, this.el); if (!el) return;
      container.scrollTo({ top: el.offsetTop - container.offsetTop - 8, behavior: 'smooth' });
    }
  }
  ITO.SeatMap = SeatMap;

  ITO.emblem = `<svg class="emblem" viewBox="0 0 64 64" aria-hidden="true">
    <circle cx="32" cy="32" r="30" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <circle cx="32" cy="32" r="25.5" fill="none" stroke="currentColor" stroke-width=".6" opacity=".6"/>
    <g stroke="currentColor" stroke-width=".7" opacity=".55"><path d="M12 27h40M12 30.5h40M12 34h40M12 37.5h40M12 41h40"/></g>
    <path d="M26 46c-4.4 0-6.3-3.6-4.2-6.4 1.9-2.6 6.7-2.3 7.7 1.3.8 2.9-1.4 5.7-4.2 5.7" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <path d="M29.6 41.4 33 14c.3-2.2 3.4-2.6 4.4-.3 1.6 3.8-1.2 8-5 10.9l-3.4 2.8c-4 3.3-4.6 8.8-.6 11.3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="41" cy="44" r="2.4" fill="currentColor"/><path d="M43.4 44V31.5" stroke="currentColor" stroke-width="1.3"/>
  </svg>`;
})();
