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
    manage: null,           // { name, phone, pin, list } — 메모리에만 보관 (새로고침 시 다시 인증)
    change: null,           // { res, keep:Set } — 좌석 변경 모드
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
    if (state.change && state.change.res.seat_ids.includes(s.id)) return state.change.keep.has(s.id) ? 'mine' : 'free';
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
    const ids = new Set([...state.mine.keys(), ...state.pending, ...(state.change ? state.change.keep : [])]);
    return [...ids].map((id) => state.seats.get(id)).filter(Boolean).sort(ITO.seatCmp);
  }
  const selCount = () => state.mine.size + state.pending.size + (state.change ? state.change.keep.size : 0);
  function changeDirty() {
    const c = state.change; if (!c) return false;
    return state.mine.size > 0 || c.keep.size !== c.res.seat_ids.length;
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
    const ready = n > 0 && state.pending.size === 0 && (!state.change || changeDirty());
    $('#btn-next').disabled = !ready; $('#mb-next').disabled = !ready;
    $('#btn-next').textContent = state.change ? '좌석 변경 완료' : '예약 정보 입력하기';
    $('#mb-next').textContent = state.change ? '변경 완료' : '정보 입력하기';
    $('#btn-clear').hidden = !n || !!state.change;
    $('#mb-count').textContent = `${n}석 선택`;
    if (!n) $('#mb-sub').textContent = `예약 가능 ${c.free}석 · 최대 ${max()}석`;
    const s = state.settings;
    const hero = $('#hero-avail');
    if (s && !s.reservation_open) { hero.innerHTML = '<span class="closed-pill">현재 좌석 예약이 마감되었습니다.</span>'; }
    else if (state.loaded) {
      const fl = {};
      for (const x of state.seats.values()) { const f = (fl[x.floor] = fl[x.floor] || 0); if (stateOf(x) === 'free') fl[x.floor] = f + 1; }
      const per = Object.keys(fl).sort().map((f) => `${f}층 ${fl[f].toLocaleString()}`).join(' · ');
      hero.innerHTML = `현재 예약 가능 좌석 <b>${c.free.toLocaleString()}</b>석 / 전체 ${c.total.toLocaleString()}석` + (Object.keys(fl).length > 1 ? `<br><span style="font-size:13px;color:var(--muted)">${per}</span>` : '');
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
    if (state.change && state.change.res.seat_ids.includes(id)) {
      const k = state.change.keep;
      if (k.has(id)) k.delete(id);
      else if (selCount() >= max()) { ITO.toast(ITO.message({ code: 'LIMIT_EXCEEDED' }, { max: max() }), 'error'); return; }
      else k.add(id);
      map.update(id); renderSummary(); return;
    }
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
    if (selCount() >= max()) { ITO.toast(ITO.message({ code: 'LIMIT_EXCEEDED' }, { max: max() }), 'error'); return; }

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
  const VIEWS = ['home', 'about', 'seats', 'form', 'done', 'manage'];
  function go(v) { if (location.hash.slice(1) === v) route(); else location.hash = v === 'home' ? '' : v; }
  function route() {
    let v = location.hash.slice(1) || 'home';
    if (!VIEWS.includes(v)) v = 'home';
    if (v === 'form' && (!state.mine.size || state.change)) v = 'seats';
    if (v === 'manage' && !state.manage) {
      // 코드는 메모리에만 두므로 새로고침하면 다시 본인 확인
      v = 'home'; history.replaceState(null, '', location.pathname + location.search);
      setTimeout(() => openLookup(), 50);
    }
    if (state.change && v !== 'seats') endChange(true);
    if (v === 'done' && !state.result) {
      try { state.result = JSON.parse(localStorage.getItem('ito-last-reservation') || 'null'); } catch (e) { state.result = null; }
      if (!state.result) v = 'home';
    }
    state.view = v;
    const booking = ['seats', 'form', 'done', 'manage'].includes(v);
    $('#view-home').hidden = booking; $('#view-booking').hidden = !booking;
    $('#panel-seats').hidden = v !== 'seats'; $('#panel-form').hidden = v !== 'form'; $('#panel-done').hidden = v !== 'done';
    $('#panel-manage').hidden = v !== 'manage';
    $('.stepper').hidden = v === 'manage' || !!state.change;
    $('#change-banner').hidden = !state.change;
    if (v === 'manage') renderManage();
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
  const toForm = () => {
    if (state.change) { submitChange(); return; }
    if (state.mine.size && !state.pending.size) go('form');
  };
  $('#btn-next').addEventListener('click', toForm);
  $('#mb-next').addEventListener('click', toForm);

  /* ---------- 정보 입력 ---------- */
  const inName = $('#in-name'), inPhone = $('#in-phone'), inAgree = $('#in-agree'), inPin = $('#in-pin');
  const validPin = (v) => /^\d{4,6}$/.test(v || '');
  inPin.addEventListener('input', () => { inPin.value = inPin.value.replace(/\D/g, '').slice(0, 6); if (validPin(inPin.value)) setInvalid('#f-pin', false); });
  $('#pin-eye').addEventListener('click', () => { const show = inPin.type === 'password'; inPin.type = show ? 'text' : 'password'; $('#pin-eye').textContent = show ? '숨기기' : '보기'; });
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
    const name = inName.value.trim(), phone = inPhone.value.trim(), agree = inAgree.checked, pin = inPin.value;
    const bad = { name: !name || name.length > 30, phone: !ITO.validPhone(phone), pin: !validPin(pin), agree: !agree };
    setInvalid('#f-name', bad.name); setInvalid('#f-phone', bad.phone); setInvalid('#f-pin', bad.pin); setInvalid('#f-agree', bad.agree);
    if (bad.name || bad.phone || bad.pin || bad.agree) {
      const first = bad.name ? inName : bad.phone ? inPhone : bad.pin ? inPin : inAgree;
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
        <li><span>본인 확인 코드</span><span><b style="letter-spacing:.2em;color:var(--gold-2)">${esc(pin)}</b><br><small style="color:var(--muted)">수정·취소할 때 필요합니다. 꼭 기억해 두세요.</small></span></li>
        <li><span>선택 좌석</span><span>${seats.map((s) => esc(s.label)).join('<br>')}</span></li>
        <li><span>예약 비용</span><span>0원 (무료)</span></li>
        <li><span>티켓 수령</span><span>${esc(state.settings.pickup_text)}</span></li>
      </ul><p style="font-size:13.5px">예약한 뒤에도 상단 ‘예약 확인·변경’에서 본인 확인 코드로 좌석 변경·정보 수정·취소를 할 수 있습니다.</p>`,
      actions: [{ label: '수정하기' }, { label: '예약 확정', primary: true, value: true }],
    });
    if (!ok) return;
    if (!state.mine.size) { ITO.toast(ITO.message({ code: 'HOLD_EXPIRED' }), 'error'); go('seats'); return; }
    await submit(name, phone, agree, seats.map((s) => s.id), pin);
  });

  async function submit(name, phone, agree, seatIds, pin) {
    state.submitting = true;
    const btn = $('#btn-submit'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 예약 처리 중…';
    try {
      const r = await api.confirm({ seatIds, name, phone, agree, pin });
      state.result = { ...r, title: state.settings.title, date_text: state.settings.date_text, venue: state.settings.venue };
      try { localStorage.setItem('ito-last-reservation', JSON.stringify(state.result)); } catch (e) { /* noop */ }
      for (const id of seatIds) { const s = state.seats.get(id); if (s) { s.status = 'reserved'; s.hold_expires_at = null; } state.mine.delete(id); map.update(id); }
      renderSummary();
      inName.value = ''; inPhone.value = ''; inAgree.checked = false; inPin.value = '';
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
        if (e.code === 'INVALID_PIN') setInvalid('#f-pin', true);
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
  $('#btn-manage').addEventListener('click', () => openLookup(state.result && state.result.name, state.result && state.result.phone));

  /* ---------- 예약 확인 · 변경 ---------- */
  function openLookup(preName, prePhone) {
    ITO.modal({
      title: '예약 확인 · 변경',
      body: `<p style="font-size:14px">예약할 때 입력한 정보를 넣어 주세요. <b>본인 확인 코드</b>까지 입력하면 좌석 변경·정보 수정·취소를 할 수 있습니다.</p>
        <div class="field"><label for="lk-name">이름</label><input class="input" id="lk-name" autocomplete="name" maxlength="30" value="${esc(preName || '')}"></div>
        <div class="field"><label for="lk-phone">연락처</label><input class="input" id="lk-phone" type="tel" inputmode="numeric" maxlength="13" placeholder="010-1234-5678" value="${esc(prePhone || '')}"></div>
        <div class="field"><label for="lk-pin">본인 확인 코드 <span style="color:var(--muted);font-weight:400">(수정하려면 입력)</span></label><input class="input pin-input" id="lk-pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off" placeholder="숫자 4~6자리"></div>
        <div id="lk-out"></div>`,
      onOpen: (b, close) => {
        ITO.bindPhoneInput($('#lk-phone', b));
        $('#lk-pin', b).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
        b.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); b.closest('.modal').querySelector('.btn-gold').click(); } });
        b._close = close;
        if (preName) setTimeout(() => $('#lk-pin', b).focus(), 60);
      },
      actions: [{ label: '닫기' }, {
        label: '확인', primary: true, onClick: async (b) => {
          const name = $('#lk-name', b).value.trim(), phone = $('#lk-phone', b).value, pin = $('#lk-pin', b).value;
          const out = $('#lk-out', b);
          if (!name || !ITO.validPhone(phone)) { out.innerHTML = '<p style="color:#ff9b93;font-size:14px">이름과 연락처를 정확히 입력해 주세요.</p>'; return false; }
          if (pin && !/^\d{4,6}$/.test(pin)) { out.innerHTML = `<p style="color:#ff9b93;font-size:14px">${esc(ITO.message({ code: 'INVALID_PIN' }))}</p>`; return false; }
          try {
            if (pin) {
              const list = await api.manageLogin(name, phone, pin);
              state.manage = { name, phone, pin, list };
              b._close(true); go('manage');
              return false;
            }
            const list = await api.lookup(name, phone);
            out.innerHTML = list.length ? list.map((r) => `<div class="lookup-item"><b>${esc(r.reservation_no)}</b>${r.picked_up ? '<span class="tag ok">수령 완료</span>' : '<span class="tag wait">현장 수령 예정</span>'}
              <p>${(r.seats || []).map(esc).join(', ')}</p><p style="color:var(--muted);font-size:12.5px">예약 일시 ${esc(ITO.fmtDateTime(r.created_at))}</p></div>`).join('') +
              '<p style="font-size:13px;color:var(--gold-2);margin-top:10px">수정하려면 본인 확인 코드를 입력하고 다시 ‘확인’을 눌러 주세요.</p>'
              : '<p style="font-size:14px">일치하는 예약이 없습니다. 이름과 연락처를 다시 확인해 주세요.</p>';
          } catch (e) { out.innerHTML = `<p style="color:#ff9b93;font-size:14px">${esc(ITO.message(e))}</p>`; }
          return false;
        },
      }],
    });
  }
  $('#btn-lookup').addEventListener('click', () => openLookup());
  $$('[data-lookup]').forEach((b) => b.addEventListener('click', () => openLookup()));

  /* ---------- 내 예약 관리 ---------- */
  function renderManage() {
    const m = state.manage; if (!m) return;
    const list = m.list.filter((r) => !r._cancelled);
    $('#manage-list').innerHTML = list.length ? list.map((r) => `
      <article class="card manage-card" data-no="${esc(r.reservation_no)}">
        <div class="mc-top"><span class="mc-no">${esc(r.reservation_no)}</span>${r.picked_up ? '<span class="tag ok">현장 수령 완료</span>' : '<span class="tag wait">현장 수령 예정</span>'}</div>
        <dl>
          <dt>예약자</dt><dd>${esc(r.name)}</dd>
          <dt>연락처</dt><dd>${esc(r.phone)}</dd>
          <dt>좌석</dt><dd><b>${(r.seats || []).map(esc).join('<br>')}</b></dd>
          <dt>예약 일시</dt><dd>${esc(ITO.fmtDateTime(r.created_at))}${r.updated_at ? ` · 최종 수정 ${esc(ITO.fmtDateTime(r.updated_at))}` : ''}</dd>
        </dl>
        <div class="mc-actions">
          <button type="button" class="btn btn-gold btn-sm" data-act="seats" ${r.picked_up ? 'disabled' : ''}>좌석 변경</button>
          <button type="button" class="btn btn-ghost btn-sm" data-act="info">예약자 정보 수정</button>
          <button type="button" class="btn btn-danger btn-sm" data-act="cancel" ${r.picked_up ? 'disabled' : ''}>예약 취소</button>
        </div>
        ${r.picked_up ? '<p class="mc-note">티켓을 이미 받으셔서 좌석 변경·취소는 현장 배부처에서만 가능합니다.</p>' : ''}
      </article>`).join('') : '<div class="card manage-card" style="text-align:center"><p style="margin:0">관리할 예약이 없습니다.</p></div>';
  }
  function updateManaged(r) {
    const m = state.manage; const i = m.list.findIndex((x) => x.reservation_no === r.reservation_no);
    if (i >= 0) m.list[i] = r;
    if (state.result && state.result.reservation_no === r.reservation_no) {
      Object.assign(state.result, { name: r.name, phone: r.phone, seats: r.seats, seat_ids: r.seat_ids });
      try { localStorage.setItem('ito-last-reservation', JSON.stringify(state.result)); } catch (e) { /* noop */ }
    }
  }
  function manageFail(e) {
    if (['PIN_MISMATCH', 'PIN_LOCKED', 'NO_PIN'].includes(e.code)) {
      state.manage = null;
      ITO.modal({ title: '본인 확인이 필요합니다', body: `<p>${esc(ITO.message(e))}</p>`, actions: [{ label: '확인', primary: true, value: true }] });
      go('home'); return true;
    }
    ITO.toast(ITO.message(e, { max: max() }), 'error'); return false;
  }
  $('#manage-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const no = b.closest('[data-no]').dataset.no; const m = state.manage; const r = m.list.find((x) => x.reservation_no === no);
    if (b.dataset.act === 'info') {
      ITO.modal({
        title: '예약자 정보 수정',
        body: `<div class="field"><label for="mi-name">신청자 이름</label><input class="input" id="mi-name" maxlength="30" value="${esc(r.name)}"></div>
          <div class="field"><label for="mi-phone">연락처</label><input class="input" id="mi-phone" type="tel" inputmode="numeric" maxlength="13" value="${esc(r.phone)}"></div>
          <p style="font-size:13px">현장에서 티켓을 받을 때 이 이름과 연락처로 확인합니다.</p>`,
        onOpen: (bd) => ITO.bindPhoneInput($('#mi-phone', bd)),
        actions: [{ label: '취소' }, { label: '저장', primary: true, onClick: async (bd) => {
          const name = $('#mi-name', bd).value.trim(), phone = $('#mi-phone', bd).value;
          if (!name || !ITO.validPhone(phone)) { ITO.toast('이름과 연락처를 정확히 입력해 주세요.', 'error'); return false; }
          try {
            const nr = await api.updateMyInfo(no, m.pin, name, phone);
            updateManaged(nr); m.name = nr.name; m.phone = nr.phone; renderManage();
            ITO.toast('예약자 정보를 수정했습니다.', 'ok');
          } catch (err) { if (manageFail(err)) return; throw err; }
        } }],
      });
    }
    if (b.dataset.act === 'cancel') {
      const ok = await ITO.modal({
        title: '예약을 취소할까요?',
        body: `<ul class="confirm-list"><li><span>예약번호</span><span>${esc(r.reservation_no)}</span></li><li><span>좌석</span><span>${r.seats.map(esc).join('<br>')}</span></li></ul><p>취소하면 좌석은 즉시 다른 관객에게 열립니다. 되돌릴 수 없습니다.</p>`,
        actions: [{ label: '닫기' }, { label: '예약 취소', danger: true, value: true, onClick: async () => {
          try { await api.cancelMy(no, m.pin); } catch (err) { if (manageFail(err)) return; throw err; }
        } }],
      });
      if (!ok || !state.manage) return;
      r._cancelled = true;
      if (state.result && state.result.reservation_no === no) { state.result = null; try { localStorage.removeItem('ito-last-reservation'); } catch (x) { /* noop */ } }
      for (const id of r.seat_ids) { const s = state.seats.get(id); if (s) { s.status = 'available'; map.update(id); } }
      renderSummary(); renderManage();
      ITO.toast(`${no} 예약을 취소했습니다.`, 'ok');
    }
    if (b.dataset.act === 'seats') startChange(r);
  });
  $('#btn-manage-exit').addEventListener('click', () => { state.manage = null; go('home'); });

  /* ---------- 좌석 변경 모드 ---------- */
  async function startChange(r) {
    if (state.mine.size) { const ids = [...state.mine.keys()]; state.mine.clear(); ids.forEach((id) => map.update(id)); api.releaseAll().catch(() => {}); }
    state.change = { res: r, keep: new Set(r.seat_ids) };
    $('#cb-no').textContent = r.reservation_no;
    $('#cb-old').textContent = r.seats.join(', ');
    r.seat_ids.forEach((id) => map.update(id));
    go('seats'); renderSummary();
    setTimeout(() => { const b = map.btns.get(r.seat_ids[0]); if (b) b.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' }); }, 300);
  }
  function endChange(silent) {
    const c = state.change; if (!c) return;
    state.change = null;
    c.res.seat_ids.forEach((id) => map.update(id));
    if (state.mine.size) { const ids = [...state.mine.keys()]; state.mine.clear(); ids.forEach((id) => map.update(id)); api.releaseAll().catch(() => {}); }
    $('#change-banner').hidden = true; $('.stepper').hidden = false;
    renderSummary();
    if (!silent) go('manage');
  }
  $('#btn-change-cancel').addEventListener('click', () => endChange(false));
  async function submitChange() {
    const c = state.change; const m = state.manage; if (!c || !m || state.submitting) return;
    const after = sortedMine();
    const ok = await ITO.modal({
      title: '좌석을 변경할까요?',
      body: `<ul class="confirm-list"><li><span>예약번호</span><span>${esc(c.res.reservation_no)}</span></li>
        <li><span>기존 좌석</span><span>${c.res.seats.map(esc).join('<br>')}</span></li>
        <li><span>변경 후</span><span><b style="color:#8fe6b8">${after.map((x) => esc(x.label)).join('<br>')}</b></span></li></ul>
        <p style="font-size:13.5px">예약번호는 그대로이며, 놓은 좌석은 바로 다른 관객에게 열립니다.</p>`,
      actions: [{ label: '다시 고르기' }, { label: '변경 확정', primary: true, value: true }],
    });
    if (!ok || !state.change) return;
    state.submitting = true;
    try {
      const nr = await api.changeMySeats(c.res.reservation_no, m.pin, after.map((x) => x.id));
      for (const id of c.res.seat_ids) if (!nr.seat_ids.includes(id)) { const s = state.seats.get(id); if (s) s.status = 'available'; }
      for (const id of nr.seat_ids) { const s = state.seats.get(id); if (s) { s.status = 'reserved'; s.hold_expires_at = null; } }
      state.mine.clear();
      updateManaged(nr);
      endChange(false);
      map.updateAll();
      ITO.toast('좌석을 변경했습니다.', 'ok');
    } catch (e) {
      if (!manageFail(e) && ['HOLD_EXPIRED', 'ALREADY_RESERVED'].includes(e.code)) resync(false);
    } finally { state.submitting = false; }
  }

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
