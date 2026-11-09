/* 관람객 예약 화면 */
(function () {
  'use strict';
  const { $, $$, esc } = ITO;
  const api = ITO.createPublicBackend();

  const state = {
    settings: null, sections: [], seats: new Map(),
    mine: new Map(),        // seatId -> 만료시각(ms)
    pending: new Set(),     // 서버 응답 대기 중
    result: null, submitting: false, view: 'home', loaded: false,
  };
  let map;

  /* ---------- 장식 ---------- */
  $$('[data-emblem]').forEach((el) => (el.innerHTML = ITO.emblem));
  (function pipes() {
    const svg = $('#pipes'); if (!svg) return;
    let h = ''; const n = 41; const w = 1100 / n;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(i - (n - 1) / 2);
      const ht = 300 - d * 9 - (i % 2) * 22;
      const x = i * w + w * 0.18;
      h += `<rect x="${x.toFixed(1)}" y="${(320 - ht).toFixed(1)}" width="${(w * 0.64).toFixed(1)}" height="${ht}" rx="${(w * 0.32).toFixed(1)}" fill="none" stroke="currentColor" stroke-width="1.2"/>`;
      h += `<path d="M${(x + w * 0.16).toFixed(1)} ${(320 - ht + 26).toFixed(1)}h${(w * 0.32).toFixed(1)}" stroke="currentColor" stroke-width="1"/>`;
    }
    svg.innerHTML = h;
  })();

  if (api.mode === 'demo') {
    $('#demo-banner').hidden = false;
    $('#demo-reset').addEventListener('click', async () => {
      const ok = await ITO.modal({ title: '데모 초기화', body: '<p>데모 좌석·예약 데이터를 처음 상태로 되돌립니다.</p>', actions: [{ label: '취소' }, { label: '초기화', primary: true, value: true }] });
      if (ok) { ITO.resetDemo(); state.mine.clear(); location.hash = ''; location.reload(); }
    });
  }

  /* ---------- 좌석 상태 ---------- */
  const now = () => api.now();
  const expMs = (s) => (s.hold_expires_at ? new Date(s.hold_expires_at).getTime() : 0);
  function stateOf(s) {
    if (state.pending.has(s.id) || state.mine.has(s.id)) return 'mine';
    if (s.status === 'reserved') return 'taken';
    if (s.status === 'blocked') return 'blocked';
    if (s.status === 'held' && expMs(s) > now()) return 'held';
    return 'free';
  }
  const max = () => (state.settings ? state.settings.max_seats_per_person : 4);

  function counts() {
    let free = 0, taken = 0, held = 0;
    for (const s of state.seats.values()) {
      const st = state.mine.has(s.id) || state.pending.has(s.id) ? 'mine' : stateOf(s);
      if (st === 'free') free++; else if (st === 'taken') taken++; else if (st === 'held') held++;
    }
    return { free, taken, held, total: state.seats.size };
  }
  function sortedMine() {
    return [...state.mine.keys(), ...state.pending].map((id) => state.seats.get(id)).filter(Boolean).sort(ITO.seatCmp);
  }
  function deadline() { let d = Infinity; for (const v of state.mine.values()) d = Math.min(d, v); return d; }

  /* ---------- 화면 갱신 ---------- */
  function bindSettings() {
    const s = state.settings; if (!s) return;
    $$('[data-bind]').forEach((el) => { const v = s[el.dataset.bind]; if (v != null && v !== '') el.textContent = v; });
    document.title = `${s.title} · 무료 좌석 예약`;
    const prog = String(s.program || '').split('\n').map((x) => x.trim()).filter(Boolean);
    $('#program-card').hidden = !prog.length;
    $('#program-list').innerHTML = prog.map((p) => {
      const i = p.indexOf(' — ');
      return i > 0 ? `<li><small class="composer">${esc(p.slice(0, i))}</small>${esc(p.slice(i + 3))}</li>` : `<li>${esc(p)}</li>`;
    }).join('');
    const url = /^https?:\/\//.test(s.pamphlet_url || '') ? s.pamphlet_url : '';
    $$('[data-pamphlet]').forEach((a) => { a.hidden = !url; if (url) a.href = url; });
    $$('.performers').forEach((el) => (el.hidden = !s.performers));
    const notes = String(s.notice || '').split('\n').map((x) => x.trim()).filter(Boolean);
    $('#notice-card').hidden = !notes.length;
    $('#notice-list').innerHTML = notes.map((p) => `<li>${esc(p)}</li>`).join('');
  }

  function renderSummary() {
    const c = counts(); const list = sortedMine(); const n = list.length;
    $('#st-mine').textContent = n; $('#sel-count-inline').textContent = n;
    $('#st-free').textContent = c.free; $('#st-taken').textContent = c.taken; $('#st-held').textContent = c.held;
    const chips = $('#sel-chips');
    chips.innerHTML = n ? list.map((s) => `<span class="chip">${esc(s.label)}<button type="button" data-rm="${esc(s.id)}" aria-label="${esc(s.label)} 선택 취소">✕</button></span>`).join('')
      : '<span class="empty">좌석 배치도에서 원하는 좌석을 눌러 주세요.</span>';
    const ready = n > 0 && state.pending.size === 0;
    $('#btn-next').disabled = !ready; $('#mb-next').disabled = !ready;
    $('#btn-clear').hidden = !n;
    $('#mb-count').textContent = `${n}석 선택`;
    if (!n) $('#mb-sub').textContent = `예약 가능 ${c.free}석 · 최대 ${max()}석`;
    const s = state.settings;
    const hero = $('#hero-avail');
    if (s && !s.reservation_open) { hero.innerHTML = '<span class="closed-pill">현재 좌석 예약이 마감되었습니다.</span>'; }
    else if (state.loaded) {
      const fl = {};
      for (const x of state.seats.values()) { const f = (fl[x.floor] = fl[x.floor] || 0); if (stateOf(x) === 'free') fl[x.floor] = f + 1; }
      const per = Object.keys(fl).sort().map((f) => `${f}층 ${fl[f].toLocaleString()}`).join(' · ');
      hero.innerHTML = `현재 예약 가능 좌석 <b>${c.free.toLocaleString()}</b>석 / 전체 ${c.total.toLocaleString()}석<br><span style="font-size:13px;color:var(--muted)">${per}</span>`;
    }
  }

  function tick() {
    const d = deadline();
    const has = state.mine.size > 0;
    $('#timer').hidden = !has;
    if (has) {
      const left = d - now();
      if (left <= 0) { expireSelection(); return; }
      const t = ITO.fmtCountdown(left);
      $('#timer-v').textContent = t; $('#timer2-v').textContent = t;
      $('#timer').classList.toggle('warn', left < 60000); $('#timer2').classList.toggle('warn', left < 60000);
      $('#mb-sub').innerHTML = `남은 시간 <span class="t">${t}</span>`;
    }
    // 다른 관객의 점유가 만료되면 즉시 회색으로
    for (const s of state.seats.values()) if (s.status === 'held' && expMs(s) <= now()) map && map.update(s.id);
  }

  function expireSelection() {
    const ids = [...state.mine.keys()];
    state.mine.clear();
    ids.forEach((id) => map.update(id));
    renderSummary();
    api.releaseAll().catch(() => {});
    ITO.toast('좌석 선택 시간이 만료되어 선택이 해제되었습니다. 다시 선택해 주세요.', 'warn');
    if (state.view === 'form') go('seats');
  }

  /* ---------- 좌석 클릭 ---------- */
  async function onSeatClick(id, btn) {
    const s = state.seats.get(id); if (!s) return;
    const st = stateOf(s);
    if (state.pending.has(id)) return;
    if (st === 'mine') {
      state.mine.delete(id); map.update(id); renderSummary();
      try { await api.release(id); } catch (e) { /* 만료되어도 무방 */ }
      return;
    }
    if (st !== 'free') {
      btn.classList.remove('flash'); void btn.offsetWidth; btn.classList.add('flash');
      const code = st === 'taken' ? 'ALREADY_RESERVED' : st === 'held' ? 'HELD_BY_OTHER' : 'BLOCKED';
      ITO.toast(ITO.message({ code }), 'error');
      return;
    }
    if (state.settings && !state.settings.reservation_open) { ITO.toast(ITO.message({ code: 'CLOSED' }), 'error'); return; }
    if (state.mine.size + state.pending.size >= max()) { ITO.toast(ITO.message({ code: 'LIMIT_EXCEEDED' }, { max: max() }), 'error'); return; }

    if (s.kind === 'wheelchair') {
      const ok = await ITO.modal({ title: '휠체어석 안내', body: `<p><b>${esc(s.label)}</b>은 휠체어를 이용하는 관객을 위한 공간입니다. 의자가 없는 휠체어 전용 자리이므로, 휠체어 이용 관객이 아니시라면 일반석을 선택해 주세요.</p>`, actions: [{ label: '다른 좌석 선택' }, { label: '휠체어석 선택', primary: true, value: true }] });
      if (!ok || stateOf(s) !== 'free') return;
    }
    state.pending.add(id); map.update(id); renderSummary();
    try {
      const r = await api.hold(id);
      state.pending.delete(id);
      state.mine.set(id, new Date(r.expires_at).getTime());
      // 같은 사용자의 좌석은 만료 시각을 공유
      const d = new Date(r.expires_at).getTime();
      for (const k of state.mine.keys()) state.mine.set(k, Math.min(state.mine.get(k), d));
    } catch (e) {
      state.pending.delete(id);
      if (e.code === 'ALREADY_RESERVED') s.status = 'reserved';
      if (e.code === 'HELD_BY_OTHER') { s.status = 'held'; if (expMs(s) < now()) s.hold_expires_at = new Date(now() + 60000).toISOString(); }
      ITO.toast(ITO.message(e, { max: max() }), 'error');
    }
    map.update(id); renderSummary(); tick();
  }

  /* ---------- 실시간 반영 ---------- */
  function applySeat(row) {
    if (row._deleted) { state.seats.delete(row.id); return scheduleRerender(); }
    const cur = state.seats.get(row.id);
    if (!cur) { state.seats.set(row.id, row); return scheduleRerender(); }
    Object.assign(cur, row);
    // 내 좌석이 다른 상태로 바뀌었다면(관리자 처리 등) 내 선택에서 제거
    if (state.mine.has(row.id) && row.status !== 'held') {
      state.mine.delete(row.id);
      ITO.toast(`선택했던 ${cur.label} 좌석의 선택 시간이 만료되어 해제되었습니다.`, 'warn');
      if (state.view === 'form' && !state.mine.size) go('seats'); else if (state.view === 'form') renderForm();
    }
    map.update(row.id); scheduleSummary();
  }
  let sumT = null, rerT = null;
  function scheduleSummary() { if (!sumT) sumT = requestAnimationFrame(() => { sumT = null; renderSummary(); }); }
  function scheduleRerender() { clearTimeout(rerT); rerT = setTimeout(() => resync(true), 400); }

  let pollT = null;
  function setLive(status) {
    const dot = $('#live-dot');
    dot.className = 'live-dot ' + (status === 'live' ? 'on' : 'warn');
    dot.textContent = status === 'live' ? (api.mode === 'demo' ? '실시간 (데모)' : '실시간 연결됨') : '재연결 중…';
    clearInterval(pollT);
    if (status !== 'live') pollT = setInterval(() => resync(false), 8000);
  }

  async function resync(full) {
    try {
      if (full) {
        const d = await api.load();
        state.settings = d.settings; state.sections = d.sections;
        state.seats = new Map(d.seats.map((s) => [s.id, s]));
        bindSettings(); map.render(state.sections, state.seats); floorNav();
      } else {
        const rows = await api.loadSeats();
        const seen = new Set();
        for (const r of rows) { seen.add(r.id); const c = state.seats.get(r.id); if (c) Object.assign(c, r); else return resync(true); }
        if (seen.size !== state.seats.size) return resync(true);
        map.updateAll();
      }
      const stale = [...state.seats.values()].some((s) => s.status === 'held' && expMs(s) < now() - 90000);
      if (stale && api.cleanup) api.cleanup();
      renderSummary();
    } catch (e) { /* 다음 주기에 재시도 */ }
  }

  /* ---------- 라우팅 ---------- */
  const VIEWS = ['home', 'about', 'seats', 'form', 'done'];
  function go(v) { if (location.hash.slice(1) === v) route(); else location.hash = v === 'home' ? '' : v; }
  function route() {
    let v = location.hash.slice(1) || 'home';
    if (!VIEWS.includes(v)) v = 'home';
    if (v === 'form' && !state.mine.size) v = 'seats';
    if (v === 'done' && !state.result) {
      try { state.result = JSON.parse(localStorage.getItem('ito-last-reservation') || 'null'); } catch (e) { state.result = null; }
      if (!state.result) v = 'home';
    }
    state.view = v;
    const booking = ['seats', 'form', 'done'].includes(v);
    $('#view-home').hidden = booking; $('#view-booking').hidden = !booking;
    $('#panel-seats').hidden = v !== 'seats'; $('#panel-form').hidden = v !== 'form'; $('#panel-done').hidden = v !== 'done';
    $('#mobile-bar').hidden = v !== 'seats';
    const order = ['seats', 'form', 'done'];
    $$('.stepper li').forEach((li) => {
      const i = order.indexOf(li.dataset.step), cur = order.indexOf(v);
      li.className = i === cur ? 'on' : i < cur ? 'done' : '';
    });
    if (v === 'about') { requestAnimationFrame(() => $('#about').scrollIntoView({ behavior: 'smooth' })); return; }
    window.scrollTo({ top: 0 });
    if (v === 'seats' && state.loaded) requestAnimationFrame(centerMap);
    if (v === 'form') renderForm();
    if (v === 'done') renderDone();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-go]'); if (!a) return;
    e.preventDefault(); go(a.dataset.go);
  });

  /* ---------- 좌석 배치도 ---------- */
  map = new ITO.SeatMap($('#seatmap'), { stateOf, onClick: onSeatClick });
  let centered = false;
  function centerMap() {
    const sc = $('#map-scroll');
    if (!centered) { if (window.innerWidth > 720) map.fit(sc); else map.setZoom(0.72); centered = true; }
    sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2;
  }
  function floorNav() {
    const fs = [...new Set([...state.seats.values()].map((x) => x.floor))].sort();
    $('#floor-nav').innerHTML = fs.length > 1 ? fs.map((f) => `<button type="button" class="icon-btn fit" data-floor="${f}">${f}층</button>`).join('') : '';
  }
  $('#floor-nav').addEventListener('click', (e) => { const b = e.target.closest('[data-floor]'); if (b) map.scrollToFloor($('#map-scroll'), +b.dataset.floor); });
  $('#zoom-in').addEventListener('click', () => map.setZoom(map.zoom + 0.15));
  $('#zoom-out').addEventListener('click', () => map.setZoom(map.zoom - 0.15));
  $('#zoom-fit').addEventListener('click', () => { map.fit($('#map-scroll')); const sc = $('#map-scroll'); sc.scrollLeft = (sc.scrollWidth - sc.clientWidth) / 2; });
  $('#sel-chips').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]'); if (b) onSeatClick(b.dataset.rm, map.btns.get(b.dataset.rm));
  });
  $('#btn-clear').addEventListener('click', async () => {
    const ids = [...state.mine.keys()]; state.mine.clear(); ids.forEach((id) => map.update(id)); renderSummary();
    try { await api.releaseAll(); } catch (e) { /* noop */ }
  });
  const toForm = () => { if (state.mine.size && !state.pending.size) go('form'); };
  $('#btn-next').addEventListener('click', toForm);
  $('#mb-next').addEventListener('click', toForm);

  /* ---------- 정보 입력 ---------- */
  const inName = $('#in-name'), inPhone = $('#in-phone'), inAgree = $('#in-agree');
  ITO.bindPhoneInput(inPhone);
  function renderForm() {
    $('#form-seats').innerHTML = sortedMine().map((s) => `<span>${esc(s.label)}</span>`).join('');
    tick();
    setTimeout(() => { if (!inName.value) inName.focus({ preventScroll: true }); }, 60);
  }
  function setInvalid(fid, bad) { $(fid).classList.toggle('invalid', !!bad); }
  inName.addEventListener('input', () => setInvalid('#f-name', false));
  inPhone.addEventListener('input', () => { if (ITO.validPhone(inPhone.value)) setInvalid('#f-phone', false); });
  inPhone.addEventListener('blur', () => { if (inPhone.value) setInvalid('#f-phone', !ITO.validPhone(inPhone.value)); });
  inAgree.addEventListener('change', () => setInvalid('#f-agree', false));
  $('#btn-back').addEventListener('click', () => go('seats'));

  $('#res-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (state.submitting) return;
    const name = inName.value.trim(), phone = inPhone.value.trim(), agree = inAgree.checked;
    const bad = { name: !name || name.length > 30, phone: !ITO.validPhone(phone), agree: !agree };
    setInvalid('#f-name', bad.name); setInvalid('#f-phone', bad.phone); setInvalid('#f-agree', bad.agree);
    if (bad.name || bad.phone || bad.agree) {
      const first = bad.name ? inName : bad.phone ? inPhone : inAgree;
      first.focus();
      ITO.toast('필수 정보를 확인해 주세요.', 'error');
      return;
    }
    if (!state.mine.size) { go('seats'); return; }
    const seats = sortedMine();
    const ok = await ITO.modal({
      title: '예약 내용을 확인해 주세요',
      body: `<ul class="confirm-list">
        <li><span>신청자 이름</span><span>${esc(name)}</span></li>
        <li><span>연락처</span><span>${esc(ITO.formatPhoneInput(phone))}</span></li>
        <li><span>선택 좌석</span><span>${seats.map((s) => esc(s.label)).join('<br>')}</span></li>
        <li><span>예약 비용</span><span>0원 (무료)</span></li>
        <li><span>티켓 수령</span><span>${esc(state.settings.pickup_text)}</span></li>
      </ul><p style="font-size:13.5px">예약 확정 후에는 좌석 변경이 어렵습니다. 변경이 필요하면 주최 측에 문의해 주세요.</p>`,
      actions: [{ label: '수정하기' }, { label: '예약 확정', primary: true, value: true }],
    });
    if (!ok) return;
    if (!state.mine.size) { ITO.toast(ITO.message({ code: 'HOLD_EXPIRED' }), 'error'); go('seats'); return; }
    await submit(name, phone, agree, seats.map((s) => s.id));
  });

  async function submit(name, phone, agree, seatIds) {
    state.submitting = true;
    const btn = $('#btn-submit'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 예약 처리 중…';
    try {
      const r = await api.confirm({ seatIds, name, phone, agree });
      state.result = { ...r, title: state.settings.title, date_text: state.settings.date_text, venue: state.settings.venue };
      try { localStorage.setItem('ito-last-reservation', JSON.stringify(state.result)); } catch (e) { /* noop */ }
      for (const id of seatIds) { const s = state.seats.get(id); if (s) { s.status = 'reserved'; s.hold_expires_at = null; } state.mine.delete(id); map.update(id); }
      renderSummary();
      inName.value = ''; inPhone.value = ''; inAgree.checked = false;
      history.replaceState(null, '', location.pathname + location.search + '#done'); route();
    } catch (e) {
      if (['HOLD_EXPIRED', 'ALREADY_RESERVED'].includes(e.code)) {
        const ids = [...state.mine.keys()]; state.mine.clear(); ids.forEach((id) => map.update(id));
        api.releaseAll().catch(() => {});
        await ITO.modal({ title: '예약하지 못했습니다', body: `<p>${esc(ITO.message(e, { max: max() }))}</p>`, actions: [{ label: '좌석 다시 선택', primary: true, value: true }] });
        go('seats'); resync(false);
      } else {
        ITO.toast(ITO.message(e, { max: max() }), 'error');
        if (e.code === 'INVALID_PHONE') setInvalid('#f-phone', true);
        if (e.code === 'INVALID_NAME') setInvalid('#f-name', true);
      }
    } finally {
      state.submitting = false; btn.disabled = false; btn.textContent = '예약하기';
    }
  }

  /* ---------- 완료 ---------- */
  function renderDone() {
    const r = state.result; if (!r) return;
    $('#t-name').textContent = r.name; $('#t-phone').textContent = r.phone;
    $('#t-seats').innerHTML = (r.seats || []).map(esc).join('<br>');
    $('#t-no').textContent = r.reservation_no;
    $('#t-count').textContent = `좌석 ${(r.seats || []).length}매 · 0원`;
    const t = $('#ticket');
    if (r.title) $('[data-bind="title"]', t).textContent = r.title;
    if (r.date_text) $('[data-bind="date_text"]', t).textContent = r.date_text;
    if (r.venue) $('[data-bind="venue"]', t).textContent = r.venue;
  }
  $('#btn-print').addEventListener('click', () => {
    try { window.print(); } catch (e) { /* noop */ }
    if (api.mode === 'demo') ITO.toast('인쇄 창이 열리지 않는 환경이면 화면을 캡처해 저장해 주세요.', 'warn');
  });
  $('#btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.result.reservation_no); ITO.toast('예약번호를 복사했습니다.', 'ok'); }
    catch (e) { ITO.toast(`예약번호: ${state.result.reservation_no}`, 'ok'); }
  });
  $('#btn-home').addEventListener('click', () => go('home'));

  /* ---------- 예약 확인 ---------- */
  $('#btn-lookup').addEventListener('click', () => {
    ITO.modal({
      title: '내 예약 확인',
      body: `<p style="font-size:14px">예약할 때 입력한 이름과 연락처를 입력해 주세요.</p>
        <div class="field"><label for="lk-name">이름</label><input class="input" id="lk-name" autocomplete="name" maxlength="30"></div>
        <div class="field"><label for="lk-phone">연락처</label><input class="input" id="lk-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="010-1234-5678"></div>
        <div id="lk-out"></div>`,
      onOpen: (b) => {
        ITO.bindPhoneInput($('#lk-phone', b));
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); b.closest('.modal').querySelector('.btn-gold').click(); } });
      },
      actions: [{ label: '닫기' }, {
        label: '조회', primary: true, onClick: async (b) => {
          const name = $('#lk-name', b).value.trim(), phone = $('#lk-phone', b).value;
          const out = $('#lk-out', b);
          if (!name || !ITO.validPhone(phone)) { out.innerHTML = '<p style="color:#ff9b93;font-size:14px">이름과 연락처를 정확히 입력해 주세요.</p>'; return false; }
          try {
            const list = await api.lookup(name, phone);
            out.innerHTML = list.length ? list.map((r) => `<div class="lookup-item"><b>${esc(r.reservation_no)}</b>${r.picked_up ? '<span class="tag ok">수령 완료</span>' : '<span class="tag wait">현장 수령 예정</span>'}
              <p>${(r.seats || []).map(esc).join(', ')}</p><p style="color:var(--muted);font-size:12.5px">예약 일시 ${esc(ITO.fmtDateTime(r.created_at))}</p></div>`).join('')
              : '<p style="font-size:14px">일치하는 예약이 없습니다. 이름과 연락처를 다시 확인해 주세요.</p>';
          } catch (e) { out.innerHTML = `<p style="color:#ff9b93;font-size:14px">${esc(ITO.message(e))}</p>`; }
          return false;
        },
      }],
    });
  });

  /* ---------- 시작 ---------- */
  async function start() {
    route();
    try {
      const d = await api.load();
      state.settings = d.settings; state.sections = d.sections;
      state.seats = new Map(d.seats.map((s) => [s.id, s]));
      bindSettings();
      map.render(state.sections, state.seats); floorNav();
      // 새로고침 전에 선택했던 좌석 복원
      try {
        const holds = await api.myHolds();
        for (const h of holds) state.mine.set(h.seat_id, new Date(h.expires_at).getTime());
        if (holds.length) { map.updateAll(); ITO.toast(`이전에 선택한 좌석 ${holds.length}석을 불러왔습니다.`, 'ok'); }
      } catch (e) { /* noop */ }
      state.loaded = true;
      renderSummary(); route();
      api.subscribe(applySeat, setLive);
      setInterval(tick, 1000);
      setInterval(() => resync(false), 60000);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(false); });
    } catch (e) {
      $('#seatmap').innerHTML = `<div class="loading-screen">좌석 정보를 불러오지 못했습니다.<br>${esc(ITO.message(e))}<button class="btn btn-ghost btn-sm" id="btn-reload">다시 시도</button></div>`;
      $('#btn-reload').addEventListener('click', () => location.reload());
      $('#hero-avail').textContent = '좌석 정보를 불러오지 못했습니다.';
    }
  }
  start();
})();
