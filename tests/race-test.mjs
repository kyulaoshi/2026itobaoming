// 배포 후 실제 Supabase 에서 "동시에 같은 좌석" 상황과 개인정보 보호를 검증합니다.
// 사용법 (Node 20 이상, 설치 필요 없음):
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx node tests/race-test.mjs
//   (선택) 사용자 수 지정: ... node tests/race-test.mjs 50
// ※ 테스트는 좌석을 잠시 점유했다가 바로 해제합니다. 예약은 만들지 않습니다.

const URL_ = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const N = Math.max(2, Math.min(200, parseInt(process.argv[2] || '30', 10)));
if (!URL_ || !KEY) { console.error('SUPABASE_URL 과 SUPABASE_PUBLISHABLE_KEY 환경변수를 설정해 주세요.'); process.exit(1); }

const H = { apikey: KEY, 'Content-Type': 'application/json', ...(KEY.startsWith('sb_') ? {} : { Authorization: `Bearer ${KEY}` }) };
const rpc = async (fn, args) => {
  const r = await fetch(`${URL_}/rest/v1/rpc/${fn}`, { method: 'POST', headers: H, body: JSON.stringify(args) });
  const j = await r.json().catch(() => null);
  return { ok: r.ok, data: j, code: !r.ok ? String((j && j.message) || '').match(/^[A-Z_]+/)?.[0] || (j && j.message) : null };
};
let pass = 0, fail = 0;
const check = (c, m) => { c ? pass++ : fail++; console.log(`  ${c ? '✅' : '❌'} ${m}`); };

console.log(`대상: ${URL_}`);
const seatRes = await fetch(`${URL_}/rest/v1/seats?select=id,label&status=eq.available&order=id&limit=1`, { headers: H });
const [seat] = await seatRes.json();
if (!seat) { console.error('예약 가능한 좌석이 없습니다.'); process.exit(1); }

console.log(`\n▶ ${N}명이 동시에 「${seat.label}」 좌석 선택`);
const sessions = Array.from({ length: N }, () => crypto.randomUUID());
const results = await Promise.all(sessions.map((s) => rpc('hold_seat', { p_seat_id: seat.id, p_session: s })));
const winners = results.map((r, i) => (r.ok ? sessions[i] : null)).filter(Boolean);
const codes = results.filter((r) => !r.ok).reduce((a, r) => ((a[r.code] = (a[r.code] || 0) + 1), a), {});
check(winners.length === 1, `점유 성공 ${winners.length}명 (기대값 1명)`);
console.log('     실패 사유:', codes);

console.log('\n▶ 패자가 같은 좌석으로 예약 확정 시도');
const loser = sessions.find((s) => s !== winners[0]);
const c = await rpc('confirm_reservation', { p_session: loser, p_seat_ids: [seat.id], p_name: '테스트', p_phone: '01000000000', p_agree: true });
check(!c.ok && c.code === 'HOLD_EXPIRED', `점유하지 않은 좌석 확정 거부 (${c.code})`);

console.log('\n▶ 개인정보 · 관리자 기능 보호');
const pr = await fetch(`${URL_}/rest/v1/reservations?select=*&limit=1`, { headers: H });
const pj = await pr.json().catch(() => null);
check(!pr.ok || (Array.isArray(pj) && pj.length === 0), `공개 키로 예약자 테이블 조회 차단 (HTTP ${pr.status})`);
const hr = await fetch(`${URL_}/rest/v1/seat_holds?select=*&limit=1`, { headers: H });
check(!hr.ok, `공개 키로 점유 세션 테이블 조회 차단 (HTTP ${hr.status})`);
const ad = await rpc('admin_overview', {});
check(!ad.ok, `공개 키로 관리자 함수 실행 차단 (${String(ad.code || '').slice(0, 40)})`);
const up = await fetch(`${URL_}/rest/v1/seats?id=eq.${encodeURIComponent(seat.id)}`, { method: 'PATCH', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify({ status: 'blocked' }) });
const uj = await up.json().catch(() => null);
check(!up.ok || (Array.isArray(uj) && uj.length === 0), `공개 키로 좌석 상태 직접 수정 차단 (HTTP ${up.status})`);

console.log('\n▶ 정리');
if (winners[0]) { const r = await rpc('release_seat', { p_seat_id: seat.id, p_session: winners[0] }); check(r.ok && r.data === true, '테스트 좌석 점유 해제'); }

console.log(`\n결과: 통과 ${pass} / 실패 ${fail}`);
process.exit(fail ? 1 : 0);
