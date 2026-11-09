/* 관리자 페이지 */
(function () {
  'use strict';
  const { $, $$, esc } = ITO;
  const api = ITO.createAdminBackend();
  const st = {
    settings: null, sections: [], seats: new Map(), overview: null,
    seatOwner: new Map(),        // seatId -> reservation
    sel: new Set(), tab: 'list', draft: null, busy: false,
  };
  let map, preview;

  $$('[data-emblem]').forEach((el) => (el.innerHTML = ITO.emblem));
  if (api.mode === 'demo') {
    $('#demo-banner').hidden = false;
    $('#demo-reset').addEventListener('click', async () => {
      const ok = await ITO.modal({ title: '데모 초기화', body: '<p>데모 데이터를 처음 상태로 되돌립니다.</p>', actions: [{ label: '취소' }, { label: '초기화', primary: true, value: true }] });
      if (ok) { ITO.resetDemo(); location.reload(); }
    });
  }

  /* ---------- 로그인 ---------- */
  function showLogin() {
    $('#view-login').hidden = false; $('#view-dash').hidden = true; $('#admin-nav').hidden = true;
    setTimeout(() => $('#in-pw').focus(), 50);
  }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btn-login'); const pw = $('#in-pw').value;
    if (!pw) { $('#f-pw').classList.add('invalid'); $('#pw-err').textContent = '비밀번호를 입력해 주세요.'; return; }
    btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 확인 중…';
    try {
      await api.login(pw);
      $('#in-pw').value = ''; $('#f-pw').classList.remove('invalid');
      await showDash();
    } catch (err) {
      $('#f-pw').classList.add('invalid'); $('#pw-err').textContent = ITO.message(err);
      $('#in-pw').select();
    } finally { btn.disabled = false; btn.textContent = '로그인'; }
  });
  $('#in-pw').addEventListener('input', () => $('#f-pw').classList.remove('invalid'));
  $('#btn-logout').addEventListener('click', async () => { try { await api.logout(); } catch (e) { /* noop */ } location.reload(); });

  function guard(e) {
    if (e && e.code === 'UNAUTHORIZED') { ITO.toast('로그인이 만료되었습니다. 다시 로그인해 주세요.', 'warn'); showLogin(); return true; }
    ITO.toast(ITO.message(e, { max: st.settings ? st.settings.max_seats_per_person : '' }), 'error');
    return false;
  }

  /* ---------- 데이터 ---------- */
  async function loadAll() {
    const [pub, ov] = await Promise.all([api.loadPublic(), api.overview()]);
    st.settings = pub.settings; st.sections = pub.sections;
    st.seats = new Map(pub.seats.map((s) => [s.id, s]));
    setOverview(ov);
  }
  function setOverview(ov) {
    st.overview = ov;
    st.seatOwner.clear();
    for (const r of ov.reservations) if (r.status === 'confirmed') for (const id of r.seat_ids) st.seatOwner.set(id, r);
    $('#dash-updated').textContent = `최종 갱신 ${ITO.fmtDateTime(new Date().toISOString())}`;
  }
  async function refresh() {
    try { setOverview(await api.overview()); renderAll(); } catch (e) { if (e.code === 'UNAUTHORIZED') guard(e); }
  }
  let refT = null;
  const refreshSoon = () => { clearTimeout(refT); refT = setTimeout(refresh, 700); };

  async function showDash() {
    $('#view-login').hidden = true; $('#view-dash').hidden = false; $('#admin-nav').hidden = false;
    $('#kpis').innerHTML = '<div class="loading-screen" style="grid-column:1/-1;min-height:120px"><div class="spinner"></div></div>';
    try { await loadAll(); } catch (e) { if (!guard(e)) $('#kpis').innerHTML = `<p class="muted">${esc(ITO.message(e))}</p>`; return; }
    map = new ITO.SeatMap($('#seatmap'), { stateOf: adminState, onClick: toggleSel });
    preview = new ITO.SeatMap($('#preview-map'), { stateOf: () => 'free', onClick: () => {} });
    map.render(st.sections, st.seats);
    fillSettings(); resetDraft(); renderAll();
    api.subscribe((row) => {
      if (row._deleted) { st.seats.delete(row.id); } else {
        const c = st.seats.get(row.id); if (c) Object.assign(c, row); else st.seats.set(row.id, row);
      }
      if (map) map.update(row.id);
      refreshSoon();
    }, (s) => {
      const dot = $('#live-dot');
      dot.className = 'live-dot ' + (s === 'live' ? 'on' : 'warn');
      dot.textContent = s === 'live' ? '실시간 반영 중' : '재연결 중…';
    });
    setInterval(refresh, 20000);
    setInterval(() => map && map.updateAll(), 5000);
  }

  /* ---------- 공통 렌더 ---------- */
  function renderAll() { renderHead(); renderKpis(); renderRows(); renderSel(); if (map) map.updateAll(); }
  function renderHead() {
    const s = st.settings;
    $('#dash-title').textContent = s.title;
    $('#dash-date').textContent = s.date_text || '';
    $('#dash-venue').textContent = s.venue || '';
    $('#dash-open').innerHTML = s.reservation_open ? '<span class="open-on">● 예약 접수 중</span>' : '<span class="open-off">● 예약 마감</span>';
  }
  function renderKpis() {
    const k = st.overview.stats; const total = k.total_seats || 1;
    const pct = (n) => Math.round((n / total) * 100);
    $('#kpis').innerHTML = `
      <div class="kpi k-res"><span>전체 예약자 수</span><b>${k.reservations}</b><small>건 (취소 ${k.cancelled}건 제외)</small></div>
      <div class="kpi k-taken"><span>예약 완료 좌석</span><b>${k.reserved}</b><small>전체 ${k.total_seats}석 중 ${pct(k.reserved)}%</small><div class="bar"><i style="width:${pct(k.reserved)}%"></i></div></div>
      <div class="kpi k-free"><span>예약 가능 좌석</span><b>${k.available}</b><small>남은 좌석</small></div>
      <div class="kpi k-held"><span>예약 진행 중</span><b>${k.held}</b><small>임시 점유 좌석</small></div>
      <div class="kpi k-pick"><span>현장 수령 완료</span><b>${k.picked_up}</b><small>${k.picked_up_seats}석 / 예약 ${k.reserved}석</small><div class="bar"><i style="width:${k.reserved ? Math.round(k.picked_up_seats / k.reserved * 100) : 0}%;background:var(--ok)"></i></div></div>
      <div class="kpi k-block"><span>예약 불가 좌석</span><b>${k.blocked}</b><small>관리자 지정</small></div>`;
  }

  /* ---------- 탭 ---------- */
  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    st.tab = t.dataset.tab;
    $$('.tab').forEach((x) => x.classList.toggle('on', x === t));
    $$('.tab-panel').forEach((p) => (p.hidden = p.id !== 'tab-' + st.tab));
    if (st.tab === 'seats' && map) requestAnimationFrame(() => map.fit($('#map-scroll')));
    if (st.tab === 'layout') renderDraft();
  }));

  /* ---------- 예약자 목록 ---------- */
  const qEl = $('#q'), fEl = $('#filter');
  qEl.addEventListener('input', renderRows); fEl.addEventListener('change', renderRows);
  function filtered() {
    const q = qEl.value.trim().toLowerCase(); const qd = q.replace(/\D/g, ''); const f = fEl.value;
    return st.overview.reservations.filter((r) => {
      if (f === 'confirmed' && r.status !== 'confirmed') return false;
      if (f === 'waiting' && (r.status !== 'confirmed' || r.picked_up)) return false;
      if (f === 'picked' && (r.status !== 'confirmed' || !r.picked_up)) return false;
      if (f === 'cancelled' && r.status !== 'cancelled') return false;
      if (!q) return true;
      return r.name.toLowerCase().includes(q) || r.reservation_no.toLowerCase().includes(q) ||
        (qd.length >= 3 && r.phone.replace(/\D/g, '').includes(qd)) || (r.seats || []).some((s) => s.toLowerCase().includes(q));
    });
  }
  function hl(text) {
    const q = qEl.value.trim(); const t = esc(text);
    if (!q) return t;
    const i = String(text).toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return t;
    return esc(String(text).slice(0, i)) + '<mark>' + esc(String(text).slice(i, i + q.length)) + '</mark>' + esc(String(text).slice(i + q.length));
  }
  function renderRows() {
    if (!st.overview) return;
    const list = filtered();
    const seats = list.reduce((a, r) => a + (r.status === 'confirmed' ? r.seat_ids.length : 0), 0);
    $('#table-meta').textContent = `${list.length}건 · ${seats}석`;
    $('#rows').innerHTML = list.length ? list.map((r) => `
      <tr class="${r.status === 'cancelled' ? 'cancelled' : ''}" data-id="${esc(r.id)}">
        <td class="resno">${hl(r.reservation_no)}</td>
        <td class="name">${hl(r.name)}${r.source === 'admin' ? '<span class="tag admin">관리자 배정</span>' : ''}${r.updated_at && r.status === 'confirmed' ? `<span class="tag wait" title="최종 수정 ${esc(ITO.fmtDateTime(r.updated_at))}">수정됨</span>` : ''}${r.pin_locked ? '<span class="tag no">코드 잠김</span>' : ''}${r.memo ? `<div class="muted small" style="font-weight:400">${esc(r.memo)}</div>` : ''}</td>
        <td class="phone">${esc(r.phone)}</td>
        <td class="seats-cell">${(r.seats || []).map(esc).join(', ') || '<span class="muted">-</span>'}</td>
        <td class="num">${r.seat_ids.length}</td>
        <td class="when">${esc(ITO.fmtDateTime(r.created_at))}</td>
        <td class="center">${r.status === 'confirmed'
          ? `<label class="pick ${r.picked_up ? 'on' : ''}" title="${r.picked_up_at ? '수령 ' + esc(ITO.fmtDateTime(r.picked_up_at)) : ''}"><input type="checkbox" data-pick="${esc(r.id)}" ${r.picked_up ? 'checked' : ''}><span class="dot"></span>${r.picked_up ? '수령 완료' : '미수령'}</label>`
          : `<span class="tag no">취소됨</span>`}</td>
        <td class="center"><div class="row-actions">
          <button class="btn btn-ghost" data-detail="${esc(r.id)}">상세</button>
          ${r.status === 'confirmed' ? `<button class="btn btn-danger" data-cancel="${esc(r.id)}">취소</button>` : ''}
        </div></td>
      </tr>`).join('') : `<tr class="empty-row"><td colspan="8">${qEl.value ? '검색 결과가 없습니다.' : '아직 예약이 없습니다.'}</td></tr>`;
  }
  $('#rows').addEventListener('change', async (e) => {
    const cb = e.target.closest('[data-pick]'); if (!cb) return;
    const r = st.overview.reservations.find((x) => x.id === cb.dataset.pick);
    cb.disabled = true;
    try {
      await api.pickup(cb.dataset.pick, cb.checked);
      r.picked_up = cb.checked; r.picked_up_at = cb.checked ? new Date().toISOString() : null;
      ITO.toast(cb.checked ? `${r.name}님 (${r.reservation_no}) 티켓 수령 완료` : `${r.name}님 수령 체크를 해제했습니다.`, 'ok');
      refresh();
    } catch (err) { cb.checked = !cb.checked; guard(err); }
    cb.disabled = false;
  });
  $('#rows').addEventListener('click', (e) => {
    const d = e.target.closest('[data-detail]'); if (d) return openDetail(d.dataset.detail);
    const c = e.target.closest('[data-cancel]'); if (c) return confirmCancel(c.dataset.cancel);
  });

  function resetPin(r) {
    ITO.modal({
      title: `본인 확인 코드 재설정 · ${r.reservation_no}`,
      body: `<p>관객이 코드를 잊었거나 잠긴 경우, <b>본인임을 확인한 뒤</b> 새 코드를 정해 알려 주세요. 잠금도 함께 풀립니다.</p>
        <div class="field"><label for="rp-pin">새 코드 (숫자 4~6자리)</label><input class="input" id="rp-pin" inputmode="numeric" maxlength="6" autocomplete="off"></div>`,
      onOpen: (b) => $('#rp-pin', b).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); }),
      actions: [{ label: '취소' }, { label: '재설정', primary: true, onClick: async (b) => {
        const pin = $('#rp-pin', b).value;
        if (!/^\d{4,6}$/.test(pin)) { ITO.toast(ITO.message({ code: 'INVALID_PIN' }), 'error'); return false; }
        try { await api.resetPin(r.id, pin); ITO.toast(`${r.reservation_no} 의 코드를 재설정했습니다. 관객에게 새 코드를 알려 주세요.`, 'ok'); refresh(); }
        catch (e) { guard(e); throw e; }
      } }],
    });
  }

  async function confirmCancel(id) {
    const r = st.overview.reservations.find((x) => x.id === id); if (!r) return;
    const ok = await ITO.modal({
      title: '예약을 취소할까요?',
      body: `<ul class="confirm-list"><li><span>예약번호</span><span>${esc(r.reservation_no)}</span></li><li><span>신청자</span><span>${esc(r.name)} (${esc(r.phone)})</span></li><li><span>좌석</span><span>${r.seats.map(esc).join('<br>')}</span></li></ul><p>취소하면 좌석은 즉시 다시 예약 가능 상태가 됩니다. 이 작업은 되돌릴 수 없습니다.</p>`,
      actions: [{ label: '닫기' }, { label: '예약 취소', danger: true, value: true, onClick: async () => { try { await api.cancel(id); } catch (e) { guard(e); throw e; } } }],
    });
    if (ok) { ITO.toast(`${r.reservation_no} 예약을 취소했습니다.`, 'ok'); refresh(); }
    return ok;
  }

  function openDetail(id) {
    const r = st.overview.reservations.find((x) => x.id === id); if (!r) return;
    const live = r.status === 'confirmed';
    ITO.modal({
      title: `예약 상세 · ${r.reservation_no}`, wide: true,
      body: `<ul class="confirm-list">
          <li><span>상태</span><span>${live ? (r.picked_up ? '<span class="tag ok">현장 수령 완료</span> ' + esc(ITO.fmtDateTime(r.picked_up_at)) : '<span class="tag wait">미수령</span>') : '<span class="tag no">취소됨</span> ' + esc(ITO.fmtDateTime(r.cancelled_at))}</span></li>
          <li><span>예약 좌석</span><span>${r.seats.map(esc).join('<br>') || '-'}</span></li>
          <li><span>예약 일시</span><span>${esc(ITO.fmtDateTime(r.created_at))} · ${r.source === 'admin' ? '관리자 배정' : '온라인 예약'}${r.updated_at ? `<br>최종 수정 ${esc(ITO.fmtDateTime(r.updated_at))}` : ''}</span></li>
          <li><span>본인 확인 코드</span><span>${r.has_pin ? (r.pin_locked ? '<span class="tag no">잠김 (5회 오류)</span>' : '설정됨') : '없음'} <small class="muted">· 코드는 암호화되어 관리자도 볼 수 없습니다</small></span></li>
        </ul>
        <div class="grid2" style="margin-top:14px">
          <div class="field"><label for="d-name">신청자 이름</label><input class="input" id="d-name" maxlength="30" value="${esc(r.name)}" ${live ? '' : 'disabled'}></div>
          <div class="field"><label for="d-phone">연락처</label><input class="input" id="d-phone" type="tel" maxlength="13" value="${esc(r.phone)}" ${live ? '' : 'disabled'}></div>
          <div class="field span2"><label for="d-memo">관리 메모</label><input class="input" id="d-memo" maxlength="200" value="${esc(r.memo || '')}" placeholder="예) 휠체어 동반, 대리 수령 등" ${live ? '' : 'disabled'}></div>
        </div>`,
      onOpen: (b) => ITO.bindPhoneInput($('#d-phone', b)),
      actions: live ? [
        { label: '예약 취소', danger: true, onClick: async () => { const ok = await confirmCancel(id); if (!ok) return false; } },
        { label: '코드 재설정', onClick: () => { resetPin(r); return false; } },
        { label: r.picked_up ? '수령 해제' : '수령 완료 처리', onClick: async () => { try { await api.pickup(id, !r.picked_up); ITO.toast('수령 상태를 변경했습니다.', 'ok'); refresh(); } catch (e) { guard(e); throw e; } } },
        { label: '정보 저장', primary: true, onClick: async (b) => {
          try { await api.updateReservation(id, $('#d-name', b).value, $('#d-phone', b).value, $('#d-memo', b).value); ITO.toast('예약자 정보를 저장했습니다.', 'ok'); refresh(); }
          catch (e) { guard(e); throw e; }
        } },
      ] : [{ label: '닫기', primary: true }],
    });
  }

  /* ---------- 엑셀 / 출력 ---------- */
  function stamp() { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; }
  function seatSortKey(id) {
    const s = st.seats.get(id);
    if (s) return [s.floor, s.row_no, s.seat_no];
    const [f, r, k] = String(id).split('-'); return [+f || 9, r || '', +k || 0];
  }
  const cmpKey = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; };

  $('#btn-xlsx').addEventListener('click', () => {
    const all = st.overview.reservations.slice().sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    const head = ['번호', '예약번호', '신청자', '연락처', '예약 좌석', '매수', '예약 일시', '수령 여부', '수령 시각', '상태', '예약 경로', '메모', '최종 수정'];
    const rows = all.map((r, i) => [i + 1, r.reservation_no, r.name, r.phone, r.seats.join(', '), r.seat_ids.length, ITO.fmtDateTime(r.created_at),
      r.status === 'confirmed' ? (r.picked_up ? '수령 완료' : '미수령') : '-', r.picked_up_at ? ITO.fmtDateTime(r.picked_up_at) : '',
      r.status === 'confirmed' ? '예약 확정' : '취소', r.source === 'admin' ? '관리자 배정' : '온라인', r.memo || '', r.updated_at ? ITO.fmtDateTime(r.updated_at) : '']);
    const seatHead = ['좌석', '층', '열', '번호', '예약번호', '신청자', '연락처', '수령 여부'];
    const seatRows = [];
    for (const r of all) if (r.status === 'confirmed') r.seat_ids.forEach((id, i) => {
      const s = st.seats.get(id);
      seatRows.push({ k: seatSortKey(id), v: [r.seats[i] || id, s ? s.floor + '층' : '', s ? s.row_label : '', s ? s.seat_no : '', r.reservation_no, r.name, r.phone, r.picked_up ? '수령 완료' : '미수령'] });
    });
    seatRows.sort((a, b) => cmpKey(a.k, b.k));
    const fname = `인천교사오케스트라_예약자명단_${stamp()}`;
    try {
      if (!window.XLSX) throw new Error('no xlsx');
      const wb = XLSX.utils.book_new();
      const ws1 = XLSX.utils.aoa_to_sheet([head, ...rows]);
      ws1['!cols'] = [6, 16, 10, 15, 34, 6, 17, 10, 17, 10, 11, 24, 17].map((w) => ({ wch: w }));
      ws1['!autofilter'] = { ref: `A1:M${rows.length + 1}` };
      const ws2 = XLSX.utils.aoa_to_sheet([seatHead, ...seatRows.map((x) => x.v)]);
      ws2['!cols'] = [22, 6, 5, 5, 16, 10, 15, 10].map((w) => ({ wch: w }));
      XLSX.utils.book_append_sheet(wb, ws1, '예약자 목록');
      XLSX.utils.book_append_sheet(wb, ws2, '좌석별 배부표');
      XLSX.writeFile(wb, fname + '.xlsx');
    } catch (e) {
      const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
      a.download = fname + '.csv'; document.body.appendChild(a); a.click(); a.remove();
    }
    ITO.toast(api.mode === 'demo' ? '파일을 만들었습니다. (미리보기 환경에서는 다운로드가 막힐 수 있습니다)' : '엑셀 파일을 내려받았습니다.', 'ok');
  });

  $('#btn-printlist').addEventListener('click', async () => {
    const sort = await ITO.modal({
      title: '현장 배부용 명단 출력',
      body: `<p>티켓 배부처에서 사용할 명단을 A4 용지로 출력합니다. 연락처는 개인정보 보호를 위해 가운데 4자리를 가립니다.</p>
        <div class="field"><label for="p-sort">정렬 기준</label><select class="input" id="p-sort">
        <option value="name">이름 가나다순 (배부처 권장)</option><option value="no">예약번호순</option><option value="seat">좌석순</option></select></div>`,
      actions: [{ label: '취소' }, { label: '출력하기', primary: true, onClick: (b) => { st.printSort = $('#p-sort', b).value; } , value: true }],
    });
    if (!sort) return;
    const list = st.overview.reservations.filter((r) => r.status === 'confirmed');
    const by = st.printSort;
    list.sort((a, b) => by === 'name' ? a.name.localeCompare(b.name, 'ko') || a.reservation_no.localeCompare(b.reservation_no)
      : by === 'no' ? a.reservation_no.localeCompare(b.reservation_no) : cmpKey(seatSortKey(a.seat_ids[0]), seatSortKey(b.seat_ids[0])));
    const mask = (p) => p.replace(/^(\d{3})-(\d{3,4})-(\d{4})$/, (_, a, b, c) => `${a}-${'*'.repeat(b.length)}-${c}`);
    const s = st.settings; const total = list.reduce((a, r) => a + r.seat_ids.length, 0);
    $('#print-area').innerHTML = `
      <h1>${esc(s.title)} — 현장 티켓 배부 명단</h1>
      <div class="meta"><span>${esc(s.date_text || '')} · ${esc(s.venue || '')}</span><span>예약 ${list.length}건 · ${total}석 · 출력 ${esc(ITO.fmtDateTime(new Date().toISOString()))}</span></div>
      <table><thead><tr><th class="c" style="width:9mm">No</th><th style="width:20mm">이름</th><th class="nw">예약번호</th><th class="nw">연락처</th><th>좌석</th><th class="c" style="width:10mm">매수</th><th class="c" style="width:14mm">수령</th><th style="width:22mm">비고</th></tr></thead>
      <tbody>${list.map((r, i) => `<tr><td class="c">${i + 1}</td><td><b>${esc(r.name)}</b></td><td class="nw">${esc(r.reservation_no)}</td><td class="nw">${esc(mask(r.phone))}</td><td>${r.seats.map(esc).join(', ')}</td><td class="c">${r.seat_ids.length}</td><td class="c">${r.picked_up ? '<span class="done">✔</span>' : '<span class="box"></span>'}</td><td>${esc(r.memo || '')}</td></tr>`).join('')}</tbody></table>
      <div class="foot">※ 본 명단에는 개인정보가 포함되어 있습니다. 공연 종료 후 즉시 파기해 주세요. · ${esc(s.organizer)}</div>`;
    try { window.print(); } catch (e) { /* noop */ }
    if (api.mode === 'demo') ITO.toast('미리보기 환경에서는 인쇄 창이 열리지 않을 수 있습니다. 배포된 사이트에서는 정상 동작합니다.', 'warn');
  });

  /* ---------- 좌석 현황 · 관리 ---------- */
  function adminState(s) {
    if (st.sel.has(s.id)) return 'sel';
    if (s.status === 'reserved') { const r = st.seatOwner.get(s.id); return r && r.picked_up ? 'picked' : 'taken'; }
    if (s.status === 'blocked') return 'blocked';
    if (s.status === 'held' && new Date(s.hold_expires_at).getTime() > api.now()) return 'held';
    return 'free';
  }
  function baseState(s) { const had = st.sel.delete(s.id); const v = adminState(s); if (had) st.sel.add(s.id); return v; }
  function toggleSel(id) {
    if (st.sel.has(id)) st.sel.delete(id); else st.sel.add(id);
    map.update(id); renderSel();
  }
  const LBL = { free: '예약 가능', held: '진행 중', taken: '예약 완료', picked: '수령 완료', blocked: '예약 불가' };
  function renderSel() {
    const items = [...st.sel].map((id) => st.seats.get(id)).filter(Boolean).sort((a, b) => cmpKey(seatSortKey(a.id), seatSortKey(b.id)));
    $('#sel-n').textContent = items.length;
    $('#sel-list').innerHTML = items.map((s) => {
      const k = baseState(s); const r = st.seatOwner.get(s.id);
      return `<div class="sel-item"><div class="top"><b>${esc(s.label)}</b><span class="st st-${k}">${LBL[k]}</span></div>${r ? `<div class="who">${esc(r.reservation_no)} · ${esc(r.name)} · ${esc(r.phone)}</div>` : ''}</div>`;
    }).join('') || '<p class="muted small" style="margin:0">선택한 좌석이 없습니다.</p>';
    const kinds = items.map(baseState);
    $('#act-assign').disabled = !items.length || kinds.some((k) => !['free', 'blocked'].includes(k));
    $('#act-block').disabled = !items.length || kinds.some((k) => !['free', 'held'].includes(k));
    $('#act-free').disabled = !items.length || kinds.every((k) => k === 'free');
    $('#act-clear').disabled = !items.length;
  }
  function clearSel() { const ids = [...st.sel]; st.sel.clear(); ids.forEach((id) => map.update(id)); renderSel(); }
  $('#act-clear').addEventListener('click', clearSel);
  $('#zoom-in').addEventListener('click', () => map.setZoom(map.zoom + 0.15));
  $('#zoom-out').addEventListener('click', () => map.setZoom(map.zoom - 0.15));
  $('#zoom-fit').addEventListener('click', () => map.fit($('#map-scroll')));

  async function bulk(status) {
    const ids = [...st.sel];
    const reserved = ids.filter((id) => ['taken', 'picked'].includes(baseState(st.seats.get(id))));
    if (status === 'available' && reserved.length) {
      const ok = await ITO.modal({ title: '예약된 좌석이 포함되어 있습니다', body: `<p>${reserved.map((id) => esc(st.seats.get(id).label)).join(', ')} 좌석은 예약에서 제외되고 다시 예약 가능해집니다. 계속할까요?</p>`, actions: [{ label: '취소' }, { label: '계속', danger: true, value: true }] });
      if (!ok) return;
    }
    let done = 0;
    for (const id of ids) {
      try { await api.setSeatStatus(id, status); done++; } catch (e) { if (guard(e)) return; }
    }
    ITO.toast(`${done}석을 ‘${status === 'blocked' ? '예약 불가' : '예약 가능'}’으로 변경했습니다.`, 'ok');
    clearSel(); refresh();
  }
  $('#act-block').addEventListener('click', () => bulk('blocked'));
  $('#act-free').addEventListener('click', () => bulk('available'));
  $('#act-assign').addEventListener('click', () => {
    const ids = [...st.sel];
    ITO.modal({
      title: `좌석 ${ids.length}석 직접 배정`,
      body: `<p class="small">관계자석·전화 예약 등 관리자가 직접 예약을 만듭니다. (1인 매수 제한이 적용되지 않습니다)</p>
        <p>${ids.map((id) => esc(st.seats.get(id).label)).join(', ')}</p>
        <div class="field"><label for="a-name">이름</label><input class="input" id="a-name" maxlength="30"></div>
        <div class="field"><label for="a-phone">연락처</label><input class="input" id="a-phone" type="tel" maxlength="13" placeholder="010-1234-5678"></div>
        <div class="field"><label for="a-memo">메모</label><input class="input" id="a-memo" maxlength="200" placeholder="예) 협찬사 초대석"></div>`,
      onOpen: (b) => ITO.bindPhoneInput($('#a-phone', b)),
      actions: [{ label: '취소' }, { label: '배정하기', primary: true, onClick: async (b) => {
        try {
          const r = await api.createReservation(ids, $('#a-name', b).value, $('#a-phone', b).value, $('#a-memo', b).value);
          ITO.toast(`${r.reservation_no} 으로 배정했습니다.`, 'ok'); clearSel(); refresh();
        } catch (e) { guard(e); throw e; }
      } }],
    });
  });

  /* ---------- 공연 정보 ---------- */
  const SF = ['title', 'subtitle', 'kicker', 'performers', 'hosts', 'pamphlet_url', 'date_text', 'venue', 'venue_address', 'organizer', 'price_text', 'pickup_text', 'program', 'notice', 'reservation_prefix'];
  function fillSettings() {
    const s = st.settings;
    for (const k of SF) $(`#s-${k}`).value = s[k] || '';
    $('#s-max').value = s.max_seats_per_person; $('#s-hold').value = s.hold_minutes;
    $('#s-open').checked = !!s.reservation_open; $('#s-open-lbl').textContent = s.reservation_open ? '접수 중' : '마감';
    if (s.event_at) { const d = new Date(s.event_at); const p = (n) => String(n).padStart(2, '0'); $('#s-event_at').value = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
  }
  $('#s-open').addEventListener('change', (e) => ($('#s-open-lbl').textContent = e.target.checked ? '접수 중' : '마감'));
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const k of SF) out[k] = $(`#s-${k}`).value.trim();
    out.reservation_prefix = out.reservation_prefix.toUpperCase();
    if (!/^[A-Z]{2,6}$/.test(out.reservation_prefix)) { ITO.toast('예약번호 접두어는 영문 대문자 2~6자로 입력해 주세요.', 'error'); return; }
    if (!out.title) { ITO.toast('공연명을 입력해 주세요.', 'error'); return; }
    if (out.pamphlet_url && !/^https?:\/\//.test(out.pamphlet_url)) { ITO.toast(ITO.message({ code: 'INVALID_URL' }), 'error'); return; }
    out.max_seats_per_person = Math.max(1, Math.min(20, parseInt($('#s-max').value, 10) || 4));
    out.hold_minutes = Math.max(2, Math.min(30, parseInt($('#s-hold').value, 10) || 10));
    out.reservation_open = $('#s-open').checked;
    const ev = $('#s-event_at').value; out.event_at = ev ? new Date(ev).toISOString() : '';
    const btn = $('#btn-save-settings'); btn.disabled = true;
    try { st.settings = Object.assign(st.settings, await api.updateSettings(out)); fillSettings(); renderHead(); ITO.toast('공연 정보를 저장했습니다. 관객 화면에는 새로고침 시 반영됩니다.', 'ok'); }
    catch (err) { guard(err); }
    btn.disabled = false;
  });

  /* ---------- 좌석 배치 (텍스트 정의) ---------- */
  const dslEl = $('#layout-dsl');
  function resetDraft() { dslEl.value = (st.settings && st.settings.layout_dsl) || ITO.DEFAULT_LAYOUT; }
  function renderDraft() {
    const L = ITO.parseLayout(dslEl.value);
    $('#layout-total').textContent = L.total.toLocaleString();
    $('#layout-floors').textContent = Object.entries(L.floors).map(([f, n]) => `${f}층 ${n.toLocaleString()}석`).join(' · ');
    const errs = $('#layout-errors');
    errs.hidden = !L.errors.length;
    errs.innerHTML = L.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join('');
    const seats = new Map(ITO.layoutToSeats(L.sections).map((x) => [x.id, x]));
    preview.render(L.sections, seats);
    requestAnimationFrame(() => preview.fit(preview.el.parentElement));
    return L;
  }
  let dslT = null;
  dslEl.addEventListener('input', () => { clearTimeout(dslT); dslT = setTimeout(renderDraft, 350); });
  $('#btn-reset-layout').addEventListener('click', () => { resetDraft(); renderDraft(); });
  $('#btn-default-layout').addEventListener('click', () => { dslEl.value = ITO.DEFAULT_LAYOUT; renderDraft(); });
  $('#btn-save-layout').addEventListener('click', async () => {
    const L = renderDraft();
    if (L.errors.length) { ITO.toast('배치 정의에 오류가 있습니다. 빨간 안내를 확인해 주세요.', 'error'); return; }
    await ITO.modal({
      title: '좌석 배치를 저장할까요?',
      body: `<p>총 <b>${L.total.toLocaleString()}석</b> (${Object.entries(L.floors).map(([f, n]) => `${f}층 ${n}석`).join(', ')})으로 배치를 변경합니다.</p><p>이미 예약되었거나 진행 중인 좌석이 사라지는 변경은 자동으로 거부되며, 기존 예약은 그대로 유지됩니다.</p>`,
      actions: [{ label: '취소' }, { label: '저장', primary: true, onClick: async () => {
        try {
          await api.saveLayout(L.sections, dslEl.value);
          const pub = await api.loadPublic();
          st.settings = pub.settings; st.sections = pub.sections; st.seats = new Map(pub.seats.map((s) => [s.id, s]));
          map.render(st.sections, st.seats); refresh();
          ITO.toast(`좌석 배치를 저장했습니다. (총 ${L.total.toLocaleString()}석)`, 'ok');
        } catch (e) { guard(e); throw e; }
      } }],
    });
  });

  /* ---------- 시작 ---------- */
  (async () => { if (await api.me()) showDash(); else showLogin(); })();
})();
