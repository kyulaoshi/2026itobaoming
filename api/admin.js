// 관리자 API — 모든 관리자 기능은 이 서버 함수를 통해서만 실행됩니다.
// 비밀번호 검증 → HMAC 서명 HttpOnly 쿠키 발급 → 매 요청마다 서버에서 쿠키 검증
// → Supabase secret(service_role) 키로 관리자 전용 DB 함수 호출
import {
  env, rpc, HttpError, issueToken, verifyToken, checkPassword, getCookie, sessionCookie,
  sameOrigin, tooManyAttempts, recordFailure, clientIp, readBody, send,
} from './_lib.js';

const ACTIONS = {
  overview: () => rpc('admin_overview'),
  cancel: (b) => rpc('admin_cancel_reservation', { p_id: str(b.id) }),
  pickup: (b) => rpc('admin_set_pickup', { p_id: str(b.id), p_picked: !!b.picked }),
  update_reservation: (b) => rpc('admin_update_reservation', { p_id: str(b.id), p_name: str(b.name), p_phone: str(b.phone), p_memo: str(b.memo) }),
  set_seat_status: (b) => rpc('admin_set_seat_status', { p_seat_id: str(b.seatId), p_status: str(b.status) }),
  create_reservation: (b) => rpc('admin_create_reservation', { p_seat_ids: arr(b.seatIds), p_name: str(b.name), p_phone: str(b.phone), p_memo: str(b.memo) }),
  reset_pin: (b) => rpc('admin_reset_pin', { p_id: str(b.id), p_pin: str(b.pin) }),
  update_settings: (b) => rpc('admin_update_settings', { p: pickSettings(b.settings) }),
  save_layout: (b) => rpc('admin_save_layout', { p: Array.isArray(b.sections) ? b.sections : [], p_dsl: b.dsl == null ? null : String(b.dsl).slice(0, 20000) }),
};

const SETTINGS_KEYS = ['title', 'subtitle', 'kicker', 'performers', 'hosts', 'pamphlet_url', 'date_text', 'event_at', 'venue', 'venue_address', 'organizer', 'price_text',
  'pickup_text', 'program', 'notice', 'max_seats_per_person', 'hold_minutes', 'reservation_open', 'reservation_prefix'];
function pickSettings(s) {
  const out = {};
  for (const k of SETTINGS_KEYS) if (s && s[k] !== undefined) out[k] = s[k];
  return out;
}
function str(v) { return v == null ? null : String(v).slice(0, 2000); }
function arr(v) { return Array.isArray(v) ? v.slice(0, 200).map(String) : []; }

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    if (!sameOrigin(req)) throw new HttpError(403, 'FORBIDDEN');
    const e = env();
    if (!e.adminPassword || !e.sessionSecret || e.sessionSecret.length < 32) throw new HttpError(500, 'SERVER_CONFIG');

    const body = await readBody(req);
    const action = String(body.action || '');

    if (action === 'login') {
      const ip = clientIp(req);
      if (tooManyAttempts(ip)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS');
      if (!checkPassword(body.password)) {
        recordFailure(ip);
        await new Promise((r) => setTimeout(r, 800));
        throw new HttpError(401, 'BAD_PASSWORD');
      }
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(issueToken(), req) });
    }
    if (action === 'logout') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(null, req) });

    // 이하 모든 동작은 관리자 세션 필요
    if (!verifyToken(getCookie(req))) throw new HttpError(401, 'UNAUTHORIZED');
    if (action === 'me') return send(res, 200, { ok: true });

    const fn = ACTIONS[action];
    if (!fn) throw new HttpError(400, 'UNKNOWN_ACTION');
    const data = await fn(body);
    return send(res, 200, data ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { code: err.code, detail: err.detail });
    console.error(err);
    return send(res, 500, { code: 'UNKNOWN' });
  }
}
