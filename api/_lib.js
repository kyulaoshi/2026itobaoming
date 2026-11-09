// 서버 전용 공통 모듈 (파일명이 _ 로 시작하므로 Vercel 이 공개 경로로 만들지 않습니다)
import crypto from 'node:crypto';

export function env() {
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    publicKey: process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '',
    secretKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.ADMIN_SESSION_SECRET || '',
  };
}

export class HttpError extends Error {
  constructor(status, code, detail) { super(code); this.status = status; this.code = code; this.detail = detail; }
}

// 새 형식 키(sb_secret_…)는 apikey 헤더로만, 기존 JWT 키(service_role)는 Authorization 에도 전달
function authHeaders(key) {
  const h = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) h.Authorization = `Bearer ${key}`;
  return h;
}

export async function rpc(fn, args) {
  const e = env();
  if (!e.url || !e.secretKey) throw new HttpError(500, 'SERVER_CONFIG');
  let r;
  try {
    r = await fetch(`${e.url}/rest/v1/rpc/${fn}`, {
      method: 'POST', headers: authHeaders(e.secretKey), body: JSON.stringify(args || {}),
    });
  } catch (err) {
    throw new HttpError(502, 'NETWORK');
  }
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const msg = (data && data.message) || '';
    const m = msg.match(/^([A-Z_]{3,})(?::\s*(.*))?/);
    if (m) throw new HttpError(400, m[1], m[2]);
    console.error('[supabase]', r.status, msg || text);
    throw new HttpError(500, 'DB_ERROR');
  }
  return data;
}

/* ---------- 관리자 세션 (HMAC 서명 쿠키) ---------- */
const COOKIE = 'ito_admin';
const TTL_SEC = 60 * 60 * 12; // 12시간

const b64u = (buf) => Buffer.from(buf).toString('base64url');
function pwVersion(pw) { return crypto.createHash('sha256').update('v1:' + pw).digest('base64url').slice(0, 12); }
function sign(payload, secret) { return crypto.createHmac('sha256', secret).update(payload).digest('base64url'); }

export function issueToken() {
  const e = env();
  const payload = b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TTL_SEC, v: pwVersion(e.adminPassword), n: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${sign(payload, e.sessionSecret)}`;
}

export function verifyToken(token) {
  const e = env();
  if (!token || !e.sessionSecret || !e.adminPassword) return false;
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  const expect = sign(payload, e.sessionSecret);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString());
    // 비밀번호를 바꾸면 기존 세션은 모두 무효화됩니다
    return p.exp > Date.now() / 1000 && p.v === pwVersion(e.adminPassword);
  } catch { return false; }
}

export function checkPassword(input) {
  const e = env();
  const a = crypto.createHash('sha256').update(String(input || '')).digest();
  const b = crypto.createHash('sha256').update(e.adminPassword).digest();
  return e.adminPassword.length > 0 && crypto.timingSafeEqual(a, b);
}

export function getCookie(req, name = COOKIE) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token, req) {
  const secure = (req.headers['x-forwarded-proto'] || 'https') === 'https' ? '; Secure' : '';
  if (!token) return `${COOKIE}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${TTL_SEC}${secure}`;
}

// 다른 사이트에서 관리자 API 를 호출하지 못하도록 Origin 확인 (CSRF 이중 방어)
export function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}

// 간단한 로그인 시도 제한 (서버 인스턴스 단위, 10분에 10회)
const attempts = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}
export function recordFailure(ip) {
  const list = attempts.get(ip) || []; list.push(Date.now()); attempts.set(ip, list);
}
export function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { return {}; }
}

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
