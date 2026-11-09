// 브라우저에 공개해도 되는 설정만 내려줍니다 (Supabase URL + 공개용 publishable/anon 키).
// 공개 키는 RLS 와 함수 권한으로 보호되며, secret/service_role 키는 절대 여기에 넣지 않습니다.
import { env } from './_lib.js';

export default function handler(req, res) {
  const e = env();
  // deployed:true 이면 프런트엔드는 절대 데모 모드로 전환하지 않습니다 (설정 누락 시 오류 표시)
  const cfg = e.url && e.publicKey ? { deployed: true, supabaseUrl: e.url, supabaseKey: e.publicKey } : { deployed: true };
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
  res.end(`window.ITO_CONFIG=${JSON.stringify(cfg)};`);
}
