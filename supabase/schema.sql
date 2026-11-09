-- =====================================================================
--  인천교사오케스트라 정기연주회 무료 좌석 예약 시스템 — Supabase 스키마
--  Supabase 대시보드 > SQL Editor 에 전체를 붙여넣고 한 번 실행하세요.
--  (다시 실행해도 안전하도록 작성되어 있습니다. 단, 좌석 기본 배치는
--   좌석이 하나도 없을 때만 생성됩니다.)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 공연 정보 및 운영 설정 (단일 행)
create table if not exists public.event_settings (
  id                   int primary key default 1 check (id = 1),
  title                text not null default '인천교사오케스트라 제9회 정기연주회',
  subtitle             text default '열한 번의 겨울이 축적한 깊이',
  kicker               text default 'ITO Symphony Series · The 9th Concert',
  performers           text default '지휘 이우찬 · 바순 협연 박보라',
  hosts                text default '주최 인천교사오케스트라 · 주관 인천광역시교육청',
  pamphlet_url         text default 'https://2026ito.netlify.app',
  date_text            text default '2026년 12월 9일 (수) 오후 7시',
  event_at             timestamptz default '2026-12-09 19:00:00+09',
  venue                text default '인천문화예술회관 대공연장',
  venue_address        text default '인천광역시 남동구 예술로 149',
  organizer            text not null default '인천교사오케스트라',
  price_text           text not null default '전석 무료',
  pickup_text          text not null default '공연 당일 현장 수령',
  program              text default E'P. I. Tchaikovsky — 발레 〈백조의 호수〉 모음곡 중 제2곡 ‘왈츠’, Op. 20\nW. A. Mozart — 바순 협주곡 내림나장조, K. 191 (바순 박보라)\nL. van Beethoven — 교향곡 제7번 가장조, Op. 92',
  notice               text default E'티켓은 공연 당일 공연장 로비의 티켓 배부처에서 예약자 이름 또는 예약번호로 수령합니다.\n공연 중 사진·영상 촬영과 녹음은 삼가 주세요.',
  max_seats_per_person int  not null default 4  check (max_seats_per_person between 1 and 20),
  hold_minutes         int  not null default 10 check (hold_minutes between 2 and 30),
  reservation_open     boolean not null default true,
  reservation_prefix   text not null default 'ITO' check (reservation_prefix ~ '^[A-Z]{2,6}$'),
  layout_dsl           text,
  updated_at           timestamptz not null default now()
);

-- 좌석 블록 (도면의 좌측·중앙·우측 덩어리). rows = [{"r":"A","idx":1,"seats":[5,…],"wheel":[…]}, …]
create table if not exists public.sections (
  code   text primary key check (code ~ '^[A-Z0-9]{1,4}$'),
  floor  int  not null check (floor between 1 and 9),
  name   text not null,
  sort   int  not null default 0,
  breaks text[] not null default '{}',     -- 이 열 다음에 가로 통로
  rows   jsonb not null
);

-- 좌석 (공개 테이블: 개인정보 없음, Realtime 대상)
create table if not exists public.seats (
  id              text primary key,               -- 예: '1-A-16'  (층-열-번호)
  section         text not null references public.sections(code),
  floor           int  not null,
  row_label       text not null,                  -- 예: 'A'
  row_no          int  not null,                  -- 층 안에서 열 순서 (A=1 …)
  seat_no         int  not null,
  kind            text not null default 'normal' check (kind in ('normal','wheelchair')),
  label           text not null,                  -- 예: '1층 A열 16번'
  status          text not null default 'available'
                  check (status in ('available','held','reserved','blocked')),
  hold_expires_at timestamptz,
  updated_at      timestamptz not null default now(),
  unique (floor, row_label, seat_no)
);

-- 임시 점유 (비공개: 누가 점유했는지는 노출하지 않음)
create table if not exists public.seat_holds (
  seat_id    text primary key references public.seats(id) on delete cascade,
  session_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists seat_holds_session_idx on public.seat_holds(session_id);

-- 예약 (비공개: 개인정보)
create sequence if not exists public.reservation_no_seq;

create table if not exists public.reservations (
  id             uuid primary key default gen_random_uuid(),
  reservation_no text not null unique,
  name           text not null,
  phone          text not null,                 -- 숫자만 저장 (01012345678)
  seat_ids       text[] not null,
  seat_labels    text[] not null,
  status         text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  picked_up      boolean not null default false,
  picked_up_at   timestamptz,
  source         text not null default 'online' check (source in ('online','admin')),
  memo           text,
  session_id     uuid,
  agreed_at      timestamptz,
  pin_salt       text,                          -- 본인 확인 코드: 원문은 저장하지 않고
  pin_hash       text,                          --   무작위 salt + SHA-256 해시만 저장
  pin_fails      int not null default 0,        -- 연속 실패 횟수 (5회 → 15분 잠금)
  pin_locked_until timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  cancelled_at   timestamptz
);
alter table public.reservations add column if not exists pin_salt text,
  add column if not exists pin_hash text, add column if not exists pin_fails int not null default 0,
  add column if not exists pin_locked_until timestamptz, add column if not exists updated_at timestamptz;
create index if not exists reservations_phone_idx on public.reservations(phone) where status = 'confirmed';
create index if not exists reservations_session_idx on public.reservations(session_id);

-- 좌석 ↔ 예약 연결. seat_id 가 PRIMARY KEY 이므로
-- "한 좌석에 확정 예약은 단 하나" 가 데이터베이스 차원에서 보장됩니다.
create table if not exists public.reservation_seats (
  seat_id        text primary key references public.seats(id),
  reservation_id uuid not null references public.reservations(id) on delete cascade
);
create index if not exists reservation_seats_res_idx on public.reservation_seats(reservation_id);

-- 이전 버전에서 업그레이드할 때 새 항목 추가
alter table public.event_settings add column if not exists kicker text,
  add column if not exists performers text, add column if not exists hosts text,
  add column if not exists pamphlet_url text, add column if not exists layout_dsl text;

insert into public.event_settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. 권한 / RLS — 익명 사용자는 공개 정보만 읽고, 쓰기는 RPC 로만
-- ---------------------------------------------------------------------
alter table public.event_settings    enable row level security;
alter table public.sections          enable row level security;
alter table public.seats             enable row level security;
alter table public.seat_holds        enable row level security;
alter table public.reservations      enable row level security;
alter table public.reservation_seats enable row level security;

revoke all on public.event_settings, public.sections, public.seats, public.seat_holds,
              public.reservations, public.reservation_seats from anon, authenticated;
revoke all on sequence public.reservation_no_seq from anon, authenticated;

grant select on public.event_settings, public.sections, public.seats to anon, authenticated;

drop policy if exists "public read settings" on public.event_settings;
drop policy if exists "public read sections" on public.sections;
drop policy if exists "public read seats"    on public.seats;
create policy "public read settings" on public.event_settings for select to anon, authenticated using (true);
create policy "public read sections" on public.sections       for select to anon, authenticated using (true);
create policy "public read seats"    on public.seats          for select to anon, authenticated using (true);
-- seat_holds / reservations / reservation_seats 에는 정책이 없으므로
-- anon·authenticated 는 어떤 행도 읽거나 쓸 수 없습니다 (service_role 만 가능).

-- ---------------------------------------------------------------------
-- 3. 내부 도우미
-- ---------------------------------------------------------------------
create or replace function public._fmt_phone(p text) returns text
language sql immutable as $$
  select case
    when length(p) = 11 then substr(p,1,3)||'-'||substr(p,4,4)||'-'||substr(p,8,4)
    when length(p) = 10 then substr(p,1,3)||'-'||substr(p,4,3)||'-'||substr(p,7,4)
    else p end
$$;

create or replace function public._norm_phone(p text) returns text
language plpgsql immutable as $$
declare d text := regexp_replace(coalesce(p,''), '[^0-9]', '', 'g');
begin
  if d !~ '^01[016789][0-9]{7,8}$' then
    raise exception 'INVALID_PHONE';
  end if;
  return d;
end $$;

create or replace function public._session_lock(p_session uuid) returns void
language sql as $$ select pg_advisory_xact_lock(hashtext('ito-session:' || p_session::text)) $$;

-- 좌석 정렬 순서(층 → 열 → 번호)
create or replace function public._sorted_labels(p_ids text[]) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.label order by s.floor, s.row_no, s.seat_no), '{}')
  from public.seats s where s.id = any(p_ids)
$$;

create or replace function public._sorted_ids(p_ids text[]) returns text[]
language sql stable as $$
  select coalesce(array_agg(s.id order by s.floor, s.row_no, s.seat_no), '{}')
  from public.seats s where s.id = any(p_ids)
$$;

create or replace function public._next_reservation_no() returns text
language plpgsql as $$
declare cfg public.event_settings; y text;
begin
  select * into cfg from public.event_settings where id = 1;
  y := to_char(coalesce(cfg.event_at, now()) at time zone 'Asia/Seoul', 'YYYY');
  return cfg.reservation_prefix || '-' || y || '-' || lpad(nextval('public.reservation_no_seq')::text, 4, '0');
end $$;

-- 본인 확인 코드 해시
create or replace function public._pin_hash(p_salt text, p_pin text) returns text
language sql immutable as $$ select encode(sha256(convert_to(p_salt || ':' || p_pin, 'UTF8')), 'hex') $$;

create or replace function public._check_pin(p_pin text) returns void
language plpgsql immutable as $$
begin
  if coalesce(p_pin, '') !~ '^[0-9]{4,6}$' then raise exception 'INVALID_PIN'; end if;
end $$;

-- 관객에게 돌려줄 예약 정보
create or replace function public._res_json(r public.reservations) returns jsonb
language sql stable as $$
  select jsonb_build_object('reservation_no', r.reservation_no, 'name', r.name, 'phone', public._fmt_phone(r.phone),
    'seats', to_jsonb(r.seat_labels), 'seat_ids', to_jsonb(r.seat_ids), 'picked_up', r.picked_up,
    'created_at', r.created_at, 'updated_at', r.updated_at)
$$;

-- 예약번호 + 코드 인증. 실패해도 예외를 던지지 않고 {"error":…} 를 돌려줘야
-- 실패 횟수 증가가 롤백되지 않습니다. 성공 시 {"id":…} (해당 행은 잠금 상태)
create or replace function public._auth_reservation(p_no text, p_pin text) returns jsonb
language plpgsql as $$
declare r public.reservations;
begin
  select * into r from public.reservations
   where reservation_no = upper(btrim(coalesce(p_no, ''))) and status = 'confirmed' for update;
  if not found then return jsonb_build_object('error', 'PIN_MISMATCH'); end if;
  if r.pin_hash is null then return jsonb_build_object('error', 'NO_PIN'); end if;
  if r.pin_locked_until > now() then return jsonb_build_object('error', 'PIN_LOCKED'); end if;
  if public._pin_hash(r.pin_salt, coalesce(p_pin, '')) <> r.pin_hash then
    update public.reservations
       set pin_fails = pin_fails + 1,
           pin_locked_until = case when pin_fails + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
     where id = r.id;
    return jsonb_build_object('error', case when r.pin_fails + 1 >= 5 then 'PIN_LOCKED' else 'PIN_MISMATCH' end);
  end if;
  if r.pin_fails > 0 then update public.reservations set pin_fails = 0, pin_locked_until = null where id = r.id; end if;
  return jsonb_build_object('id', r.id);
end $$;

-- ---------------------------------------------------------------------
-- 4. 공개 RPC (anon 실행 가능)
-- ---------------------------------------------------------------------

-- 서버 시각 (클라이언트 시계 보정용)
create or replace function public.server_time() returns timestamptz
language sql stable as $$ select now() $$;

-- 만료된 임시 점유 해제 (pg_cron 이 1분마다 실행, 누구나 호출해도 무해)
create or replace function public.cleanup_expired_holds() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  with expired as (
    update public.seats
       set status = 'available', hold_expires_at = null, updated_at = now()
     where status = 'held' and hold_expires_at <= now()
     returning id
  )
  delete from public.seat_holds h using expired e where h.seat_id = e.id;
  get diagnostics n = row_count;
  -- 좌석 상태와 어긋난 점유 기록 정리
  delete from public.seat_holds h using public.seats s
   where s.id = h.seat_id and s.status <> 'held';
  return n;
end $$;

-- 좌석 임시 점유
create or replace function public.hold_seat(p_seat_id text, p_session uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg public.event_settings;
  s   public.seats;
  cnt int;
  exp timestamptz;
begin
  if p_session is null then raise exception 'INVALID_SESSION'; end if;
  select * into cfg from public.event_settings where id = 1;
  if not cfg.reservation_open then raise exception 'CLOSED'; end if;

  perform public._session_lock(p_session);               -- ① 같은 사용자 요청 직렬화
  select * into s from public.seats where id = p_seat_id for update;  -- ② 좌석 행 잠금
  if not found then raise exception 'NOT_FOUND'; end if;
  if s.status = 'reserved' then raise exception 'ALREADY_RESERVED'; end if;
  if s.status = 'blocked'  then raise exception 'BLOCKED'; end if;

  if s.status = 'held' and s.hold_expires_at > now() then
    if exists (select 1 from public.seat_holds where seat_id = p_seat_id and session_id = p_session) then
      return jsonb_build_object('seat_id', p_seat_id, 'expires_at', s.hold_expires_at);
    end if;
    raise exception 'HELD_BY_OTHER';
  end if;

  select count(*), max(x.hold_expires_at) into cnt, exp
    from public.seat_holds h join public.seats x on x.id = h.seat_id
   where h.session_id = p_session and x.status = 'held' and x.hold_expires_at > now();
  if cnt >= cfg.max_seats_per_person then raise exception 'LIMIT_EXCEEDED'; end if;

  -- 한 사용자의 좌석은 같은 만료 시각을 공유 (첫 좌석 선택 시점부터 타이머 시작)
  exp := coalesce(exp, now() + make_interval(mins => cfg.hold_minutes));

  insert into public.seat_holds (seat_id, session_id, expires_at)
  values (p_seat_id, p_session, exp)
  on conflict (seat_id) do update
    set session_id = excluded.session_id, expires_at = excluded.expires_at, created_at = now();

  update public.seats set status = 'held', hold_expires_at = exp, updated_at = now()
   where id = p_seat_id;

  return jsonb_build_object('seat_id', p_seat_id, 'expires_at', exp);
end $$;

-- 내 점유 좌석 1개 해제
create or replace function public.release_seat(p_seat_id text, p_session uuid) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public._session_lock(p_session);
  perform 1 from public.seats where id = p_seat_id for update;
  delete from public.seat_holds where seat_id = p_seat_id and session_id = p_session;
  if not found then return false; end if;
  update public.seats set status = 'available', hold_expires_at = null, updated_at = now()
   where id = p_seat_id and status = 'held';
  return true;
end $$;

-- 내 점유 좌석 전체 해제
create or replace function public.release_session(p_session uuid) returns int
language plpgsql security definer set search_path = public as $$
declare ids text[]; n int;
begin
  perform public._session_lock(p_session);
  select array_agg(seat_id order by seat_id) into ids from public.seat_holds where session_id = p_session;
  if ids is null then return 0; end if;
  perform 1 from public.seats where id = any(ids) order by id for update;
  delete from public.seat_holds where session_id = p_session and seat_id = any(ids);
  update public.seats set status = 'available', hold_expires_at = null, updated_at = now()
   where id = any(ids) and status = 'held';
  get diagnostics n = row_count;
  return n;
end $$;

-- 내가 점유 중인 좌석 (새로고침 후 복원용)
create or replace function public.my_holds(p_session uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('seat_id', s.id, 'expires_at', s.hold_expires_at)), '[]'::jsonb)
    from public.seat_holds h join public.seats s on s.id = h.seat_id
   where h.session_id = p_session and s.status = 'held' and s.hold_expires_at > now()
$$;

-- 예약 확정 (원자적)
drop function if exists public.confirm_reservation(uuid, text[], text, text, boolean);
create or replace function public.confirm_reservation(
  p_session uuid, p_seat_ids text[], p_name text, p_phone text, p_agree boolean, p_pin text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  cfg    public.event_settings;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text;
  ids    text[];
  n      int;
  ok     int;
  used   int;
  r      public.reservations;
begin
  if p_session is null then raise exception 'INVALID_SESSION'; end if;
  if not coalesce(p_agree, false) then raise exception 'AGREE_REQUIRED'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 30 then raise exception 'INVALID_NAME'; end if;
  v_phone := public._norm_phone(p_phone);
  perform public._check_pin(p_pin);

  select array_agg(distinct x order by x) into ids from unnest(p_seat_ids) x where x is not null;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then raise exception 'NO_SEATS'; end if;

  select * into cfg from public.event_settings where id = 1;

  perform public._session_lock(p_session);
  perform pg_advisory_xact_lock(hashtext('ito-phone:' || v_phone));

  -- 중복 제출(같은 세션·같은 좌석) → 기존 예약 그대로 반환
  select * into r from public.reservations
   where session_id = p_session and status = 'confirmed' and seat_ids @> ids and ids @> seat_ids
   limit 1;
  if found then
    return jsonb_build_object('reservation_no', r.reservation_no, 'name', r.name,
      'phone', public._fmt_phone(r.phone), 'seats', to_jsonb(r.seat_labels),
      'seat_ids', to_jsonb(r.seat_ids), 'created_at', r.created_at, 'duplicate', true);
  end if;

  if not cfg.reservation_open then raise exception 'CLOSED'; end if;
  if n > cfg.max_seats_per_person then raise exception 'LIMIT_EXCEEDED'; end if;

  -- 좌석 행 잠금 (항상 id 순서로 잠가 교착 방지)
  perform 1 from public.seats where id = any(ids) order by id for update;

  select count(*) into ok
    from public.seats s join public.seat_holds h on h.seat_id = s.id
   where s.id = any(ids) and s.status = 'held' and s.hold_expires_at > now()
     and h.session_id = p_session;
  if ok <> n then
    if exists (select 1 from public.seats where id = any(ids) and status = 'reserved') then
      raise exception 'ALREADY_RESERVED';
    end if;
    raise exception 'HOLD_EXPIRED';
  end if;

  -- 같은 연락처로 받을 수 있는 총 좌석 수 제한
  select coalesce(sum(cardinality(seat_ids)), 0) into used
    from public.reservations where phone = v_phone and status = 'confirmed';
  if used + n > cfg.max_seats_per_person then raise exception 'PHONE_LIMIT'; end if;

  insert into public.reservations (reservation_no, name, phone, seat_ids, seat_labels, session_id, agreed_at, pin_salt)
  values (public._next_reservation_no(), v_name, v_phone, public._sorted_ids(ids), public._sorted_labels(ids), p_session, now(),
          gen_random_uuid()::text)
  returning * into r;
  update public.reservations set pin_hash = public._pin_hash(pin_salt, p_pin) where id = r.id;

  -- PRIMARY KEY(seat_id) 가 최종 안전장치: 이미 확정된 좌석이면 여기서 실패 → 전체 롤백
  insert into public.reservation_seats (seat_id, reservation_id)
  select x, r.id from unnest(ids) x;

  update public.seats set status = 'reserved', hold_expires_at = null, updated_at = now()
   where id = any(ids);
  delete from public.seat_holds where seat_id = any(ids);

  return jsonb_build_object('reservation_no', r.reservation_no, 'name', r.name,
    'phone', public._fmt_phone(r.phone), 'seats', to_jsonb(r.seat_labels),
    'seat_ids', to_jsonb(r.seat_ids), 'created_at', r.created_at, 'duplicate', false);
end $$;

-- 내 예약 조회 (이름 + 연락처가 모두 일치해야 함)
create or replace function public.lookup_reservation(p_name text, p_phone text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_phone text;
begin
  v_phone := public._norm_phone(p_phone);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'reservation_no', reservation_no, 'name', name, 'phone', public._fmt_phone(phone),
             'seats', to_jsonb(seat_labels), 'picked_up', picked_up, 'created_at', created_at)
           order by created_at)
      from public.reservations
     where status = 'confirmed' and phone = v_phone and name = btrim(p_name)
  ), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------
-- 4-2. 관객 본인 예약 수정 (이름 + 연락처 + 본인 확인 코드)
-- ---------------------------------------------------------------------

-- 로그인: 일치하는 예약 목록. 실패 시 {"error":"PIN_MISMATCH"|"PIN_LOCKED"}
create or replace function public.manage_login(p_name text, p_phone text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_phone text; v_name text := btrim(coalesce(p_name, '')); matched jsonb;
begin
  perform public._check_pin(p_pin);
  v_phone := public._norm_phone(p_phone);
  perform 1 from public.reservations where status = 'confirmed' and phone = v_phone and name = v_name order by id for update;
  if exists (select 1 from public.reservations where status = 'confirmed' and phone = v_phone and name = v_name
              and pin_locked_until > now()) then
    return jsonb_build_object('error', 'PIN_LOCKED');
  end if;
  select jsonb_agg(public._res_json(r) order by r.created_at) into matched
    from public.reservations r
   where status = 'confirmed' and phone = v_phone and name = v_name
     and pin_hash is not null and pin_hash = public._pin_hash(pin_salt, p_pin);
  if matched is null then
    update public.reservations
       set pin_fails = pin_fails + 1,
           pin_locked_until = case when pin_fails + 1 >= 5 then now() + interval '15 minutes' else pin_locked_until end
     where status = 'confirmed' and phone = v_phone and name = v_name and pin_hash is not null;
    return jsonb_build_object('error', 'PIN_MISMATCH');
  end if;
  update public.reservations set pin_fails = 0, pin_locked_until = null
   where status = 'confirmed' and phone = v_phone and name = v_name and pin_fails > 0
     and pin_hash = public._pin_hash(pin_salt, p_pin);
  return jsonb_build_object('reservations', matched);
end $$;

-- 예약자 이름·연락처 수정
create or replace function public.update_my_info(p_reservation_no text, p_pin text, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb; r public.reservations; cfg public.event_settings; v_phone text; v_name text := btrim(coalesce(p_name, '')); used int;
begin
  a := public._auth_reservation(p_reservation_no, p_pin);
  if a ? 'error' then return a; end if;
  select * into r from public.reservations where id = (a->>'id')::uuid;
  if char_length(v_name) not between 1 and 30 then raise exception 'INVALID_NAME'; end if;
  v_phone := public._norm_phone(p_phone);
  if v_phone <> r.phone then
    select * into cfg from public.event_settings where id = 1;
    perform pg_advisory_xact_lock(hashtext('ito-phone:' || v_phone));
    select coalesce(sum(cardinality(seat_ids)), 0) into used
      from public.reservations where phone = v_phone and status = 'confirmed' and id <> r.id;
    if used + cardinality(r.seat_ids) > cfg.max_seats_per_person then raise exception 'PHONE_LIMIT'; end if;
  end if;
  update public.reservations set name = v_name, phone = v_phone, updated_at = now() where id = r.id returning * into r;
  return jsonb_build_object('reservation', public._res_json(r));
end $$;

-- 좌석 변경 (원자적): p_seat_ids = 변경 후 전체 좌석.
-- 기존 좌석 중 유지할 좌석 + 이번 세션이 임시 점유한 새 좌석만 허용
create or replace function public.change_my_seats(p_reservation_no text, p_pin text, p_session uuid, p_seat_ids text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  a jsonb; r public.reservations; cfg public.event_settings;
  ids text[]; new_ids text[]; dropped text[]; n int; ok int; used int;
begin
  a := public._auth_reservation(p_reservation_no, p_pin);
  if a ? 'error' then return a; end if;
  select * into r from public.reservations where id = (a->>'id')::uuid;
  if r.picked_up then raise exception 'ALREADY_PICKED_UP'; end if;
  if p_session is null then raise exception 'INVALID_SESSION'; end if;
  select * into cfg from public.event_settings where id = 1;
  if not cfg.reservation_open then raise exception 'CLOSED'; end if;

  select array_agg(distinct x order by x) into ids from unnest(p_seat_ids) x where x is not null;
  n := coalesce(array_length(ids, 1), 0);
  if n = 0 then raise exception 'NO_SEATS'; end if;
  if n > cfg.max_seats_per_person then raise exception 'LIMIT_EXCEEDED'; end if;

  perform public._session_lock(p_session);
  perform pg_advisory_xact_lock(hashtext('ito-phone:' || r.phone));
  perform 1 from public.seats where id = any(ids || r.seat_ids) order by id for update;

  select coalesce(array_agg(x), '{}') into new_ids from unnest(ids) x where not (x = any(r.seat_ids));
  select coalesce(array_agg(x), '{}') into dropped from unnest(r.seat_ids) x where not (x = any(ids));

  if cardinality(new_ids) = 0 and cardinality(dropped) = 0 then
    return jsonb_build_object('reservation', public._res_json(r), 'unchanged', true);
  end if;

  if cardinality(new_ids) > 0 then
    select count(*) into ok
      from public.seats s join public.seat_holds h on h.seat_id = s.id
     where s.id = any(new_ids) and s.status = 'held' and s.hold_expires_at > now() and h.session_id = p_session;
    if ok <> cardinality(new_ids) then
      if exists (select 1 from public.seats where id = any(new_ids) and status = 'reserved') then
        raise exception 'ALREADY_RESERVED';
      end if;
      raise exception 'HOLD_EXPIRED';
    end if;
  end if;

  select coalesce(sum(cardinality(seat_ids)), 0) into used
    from public.reservations where phone = r.phone and status = 'confirmed' and id <> r.id;
  if used + n > cfg.max_seats_per_person then raise exception 'PHONE_LIMIT'; end if;

  -- 놓는 좌석 반환
  delete from public.reservation_seats where reservation_id = r.id and seat_id = any(dropped);
  update public.seats set status = 'available', hold_expires_at = null, updated_at = now()
   where id = any(dropped) and status = 'reserved';
  -- 새 좌석 확정 (PRIMARY KEY 가 최종 안전장치)
  insert into public.reservation_seats (seat_id, reservation_id) select x, r.id from unnest(new_ids) x;
  update public.seats set status = 'reserved', hold_expires_at = null, updated_at = now() where id = any(new_ids);
  delete from public.seat_holds where seat_id = any(new_ids);

  update public.reservations
     set seat_ids = public._sorted_ids(ids), seat_labels = public._sorted_labels(ids), updated_at = now()
   where id = r.id returning * into r;
  return jsonb_build_object('reservation', public._res_json(r));
end $$;

-- 본인 예약 취소
create or replace function public.cancel_my_reservation(p_reservation_no text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a jsonb; r public.reservations;
begin
  a := public._auth_reservation(p_reservation_no, p_pin);
  if a ? 'error' then return a; end if;
  select * into r from public.reservations where id = (a->>'id')::uuid;
  if r.picked_up then raise exception 'ALREADY_PICKED_UP'; end if;
  perform 1 from public.seats where id = any(r.seat_ids) order by id for update;
  delete from public.reservation_seats where reservation_id = r.id;
  update public.seats set status = 'available', hold_expires_at = null, updated_at = now()
   where id = any(r.seat_ids) and status = 'reserved';
  update public.reservations set status = 'cancelled', cancelled_at = now(), updated_at = now() where id = r.id;
  return jsonb_build_object('ok', true, 'reservation_no', r.reservation_no);
end $$;

-- ---------------------------------------------------------------------
-- 5. 관리자 RPC (service_role 전용 — Vercel 서버 함수에서만 호출)
-- ---------------------------------------------------------------------

create or replace function public.admin_overview() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'stats', (
      select jsonb_build_object(
        'total_seats',     count(*),
        'available',       count(*) filter (where status = 'available' or (status = 'held' and hold_expires_at <= now())),
        'held',            count(*) filter (where status = 'held' and hold_expires_at > now()),
        'reserved',        count(*) filter (where status = 'reserved'),
        'blocked',         count(*) filter (where status = 'blocked'),
        'reservations',    (select count(*) from public.reservations where status = 'confirmed'),
        'picked_up',       (select count(*) from public.reservations where status = 'confirmed' and picked_up),
        'picked_up_seats', (select coalesce(sum(cardinality(seat_ids)),0) from public.reservations where status = 'confirmed' and picked_up),
        'cancelled',       (select count(*) from public.reservations where status = 'cancelled'))
      from public.seats),
    'reservations', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', id, 'reservation_no', reservation_no, 'name', name, 'phone', public._fmt_phone(phone),
        'seat_ids', to_jsonb(seat_ids), 'seats', to_jsonb(seat_labels), 'status', status,
        'picked_up', picked_up, 'picked_up_at', picked_up_at, 'source', source, 'memo', memo,
        'has_pin', pin_hash is not null, 'pin_locked', coalesce(pin_locked_until > now(), false),
        'created_at', created_at, 'updated_at', updated_at, 'cancelled_at', cancelled_at) order by created_at desc)
      from public.reservations), '[]'::jsonb),
    'server_time', now())
$$;

create or replace function public.admin_cancel_reservation(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.reservations;
begin
  select * into r from public.reservations where id = p_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;
  if r.status = 'cancelled' then raise exception 'ALREADY_CANCELLED'; end if;
  perform 1 from public.seats where id = any(r.seat_ids) order by id for update;
  delete from public.reservation_seats where reservation_id = r.id;
  update public.seats set status = 'available', hold_expires_at = null, updated_at = now()
   where id = any(r.seat_ids) and status = 'reserved';
  update public.reservations set status = 'cancelled', cancelled_at = now() where id = r.id;
  return jsonb_build_object('ok', true, 'released', to_jsonb(r.seat_ids));
end $$;

create or replace function public.admin_set_pickup(p_id uuid, p_picked boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  update public.reservations
     set picked_up = p_picked, picked_up_at = case when p_picked then now() else null end
   where id = p_id and status = 'confirmed';
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_update_reservation(p_id uuid, p_name text, p_phone text, p_memo text) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 30 then raise exception 'INVALID_NAME'; end if;
  update public.reservations
     set name = btrim(p_name), phone = public._norm_phone(p_phone), memo = nullif(btrim(coalesce(p_memo,'')), ''),
         updated_at = now()
   where id = p_id;
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end $$;

-- 좌석 상태 변경: 'blocked'(예약 불가 지정) / 'available'(해제, 예약석이면 해당 좌석만 취소)
create or replace function public.admin_set_seat_status(p_seat_id text, p_status text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.seats; rid uuid;
begin
  if p_status not in ('available','blocked') then raise exception 'INVALID_STATUS'; end if;
  select * into s from public.seats where id = p_seat_id for update;
  if not found then raise exception 'NOT_FOUND'; end if;

  if s.status = 'reserved' then
    if p_status = 'blocked' then raise exception 'RESERVED_CANCEL_FIRST'; end if;
    select reservation_id into rid from public.reservation_seats where seat_id = p_seat_id;
    delete from public.reservation_seats where seat_id = p_seat_id;
    update public.reservations
       set seat_ids = array_remove(seat_ids, p_seat_id),
           seat_labels = array_remove(seat_labels, s.label)
     where id = rid;
    update public.reservations set status = 'cancelled', cancelled_at = now()
     where id = rid and cardinality(seat_ids) = 0;
  end if;

  delete from public.seat_holds where seat_id = p_seat_id;
  update public.seats set status = p_status, hold_expires_at = null, updated_at = now() where id = p_seat_id;
  return jsonb_build_object('ok', true);
end $$;

-- 관리자 직접 배정 (관계자석·전화 예약 등). 1인 제한 적용 안 함.
create or replace function public.admin_create_reservation(p_seat_ids text[], p_name text, p_phone text, p_memo text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids text[]; n int; ok int; r public.reservations; v_phone text;
begin
  if char_length(btrim(coalesce(p_name,''))) not between 1 and 30 then raise exception 'INVALID_NAME'; end if;
  v_phone := public._norm_phone(p_phone);
  select array_agg(distinct x order by x) into ids from unnest(p_seat_ids) x where x is not null;
  n := coalesce(array_length(ids,1), 0);
  if n = 0 then raise exception 'NO_SEATS'; end if;

  perform 1 from public.seats where id = any(ids) order by id for update;
  select count(*) into ok from public.seats
   where id = any(ids)
     and (status in ('available','blocked') or (status = 'held' and hold_expires_at <= now()));
  if ok <> n then raise exception 'SEAT_UNAVAILABLE'; end if;

  insert into public.reservations (reservation_no, name, phone, seat_ids, seat_labels, source, memo)
  values (public._next_reservation_no(), btrim(p_name), v_phone, public._sorted_ids(ids), public._sorted_labels(ids),
          'admin', nullif(btrim(coalesce(p_memo,'')), ''))
  returning * into r;
  insert into public.reservation_seats (seat_id, reservation_id) select x, r.id from unnest(ids) x;
  delete from public.seat_holds where seat_id = any(ids);
  update public.seats set status = 'reserved', hold_expires_at = null, updated_at = now() where id = any(ids);
  return jsonb_build_object('ok', true, 'reservation_no', r.reservation_no);
end $$;

-- 관객이 코드를 잊었을 때 관리자가 새 코드로 재설정 (잠금도 해제)
create or replace function public.admin_reset_pin(p_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_salt text := gen_random_uuid()::text;
begin
  perform public._check_pin(p_pin);
  update public.reservations
     set pin_salt = v_salt, pin_hash = public._pin_hash(v_salt, p_pin), pin_fails = 0, pin_locked_until = null
   where id = p_id and status = 'confirmed';
  if not found then raise exception 'NOT_FOUND'; end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_update_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p->>'pamphlet_url','') <> '' and (p->>'pamphlet_url') !~ '^https?://' then raise exception 'INVALID_URL'; end if;
  update public.event_settings set
    title                = coalesce(p->>'title', title),
    subtitle             = coalesce(p->>'subtitle', subtitle),
    kicker               = coalesce(p->>'kicker', kicker),
    performers           = coalesce(p->>'performers', performers),
    hosts                = coalesce(p->>'hosts', hosts),
    pamphlet_url         = case when p ? 'pamphlet_url' then nullif(p->>'pamphlet_url','') else pamphlet_url end,
    date_text            = coalesce(p->>'date_text', date_text),
    event_at             = case when p ? 'event_at' then nullif(p->>'event_at','')::timestamptz else event_at end,
    venue                = coalesce(p->>'venue', venue),
    venue_address        = coalesce(p->>'venue_address', venue_address),
    organizer            = coalesce(p->>'organizer', organizer),
    price_text           = coalesce(p->>'price_text', price_text),
    pickup_text          = coalesce(p->>'pickup_text', pickup_text),
    program              = coalesce(p->>'program', program),
    notice               = coalesce(p->>'notice', notice),
    max_seats_per_person = coalesce((p->>'max_seats_per_person')::int, max_seats_per_person),
    hold_minutes         = coalesce((p->>'hold_minutes')::int, hold_minutes),
    reservation_open     = coalesce((p->>'reservation_open')::boolean, reservation_open),
    reservation_prefix   = coalesce(p->>'reservation_prefix', reservation_prefix),
    updated_at           = now()
  where id = 1;
  return (select to_jsonb(e) from public.event_settings e where id = 1);
end $$;

-- 좌석 배치 저장
-- p = [{"code":"1L","floor":1,"name":"1층 좌측","sort":1,"breaks":["L"],
--       "rows":[{"r":"A","idx":1,"seats":[5,6,…],"wheel":[]}, …]}, …]
-- 관리자 화면이 텍스트 정의를 이 형식으로 바꿔 보냅니다. 예약·점유 중인 좌석이 사라지는 변경은 거부합니다.
drop function if exists public.admin_save_layout(jsonb);
create or replace function public.admin_save_layout(p jsonb, p_dsl text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  conflict text[]; dup text; v_total int;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 then raise exception 'INVALID_LAYOUT'; end if;

  lock table public.seats in share row exclusive mode;   -- 배치 변경 중 다른 변경 차단

  drop table if exists _w;
  create temp table _w (id text, section text, floor int, row_label text, row_no int, seat_no int, kind text) on commit drop;
  insert into _w
  select sec->>'floor' || '-' || (r->>'r') || '-' || q.sn::text, sec->>'code', (sec->>'floor')::int, r->>'r', (r->>'idx')::int, q.sn, q.kd
    from jsonb_array_elements(p) sec,
         jsonb_array_elements(sec->'rows') r,
         lateral (select x::text::int sn, 'normal' kd from jsonb_array_elements(coalesce(r->'seats','[]')) x
                  union all
                  select x::text::int, 'wheelchair' from jsonb_array_elements(coalesce(r->'wheel','[]')) x) q;

  if exists (select 1 from jsonb_array_elements(p) sec where coalesce(sec->>'code','') !~ '^[A-Z0-9]{1,4}$') then raise exception 'INVALID_SECTION_CODE'; end if;
  if exists (select 1 from _w where floor not between 1 and 9 or row_label !~ '^[A-Z]{1,2}$' or seat_no not between 1 and 300 or row_no < 1) then
    raise exception 'INVALID_ROWS';
  end if;
  if (select count(*) from _w) = 0 or (select count(*) from _w) > 5000 then raise exception 'INVALID_ROWS'; end if;
  select id into dup from _w group by id having count(*) > 1 limit 1;
  if dup is not null then raise exception 'DUPLICATE_SEAT: %', dup; end if;

  select array_agg(id order by id) into conflict from public.seats
   where id not in (select id from _w) and (status = 'reserved' or (status = 'held' and hold_expires_at > now()));
  if conflict is not null then
    raise exception 'LAYOUT_CONFLICT: %', array_to_string(conflict[1:10], ', ');
  end if;

  delete from public.seat_holds where seat_id not in (select id from _w);
  delete from public.seats where id not in (select id from _w);

  insert into public.sections (code, floor, name, sort, breaks, rows)
  select sec->>'code', (sec->>'floor')::int, coalesce(nullif(sec->>'name',''), sec->>'code'),
         coalesce((sec->>'sort')::int, 0),
         coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(sec->'breaks','[]')) x), '{}'),
         sec->'rows'
    from jsonb_array_elements(p) sec
  on conflict (code) do update set floor = excluded.floor, name = excluded.name, sort = excluded.sort,
         breaks = excluded.breaks, rows = excluded.rows;

  insert into public.seats (id, section, floor, row_label, row_no, seat_no, kind, label)
  select id, section, floor, row_label, row_no, seat_no, kind, '' from _w
  on conflict (id) do update set section = excluded.section, row_no = excluded.row_no, kind = excluded.kind;

  delete from public.sections where code not in (select distinct section from _w);

  update public.seats s
     set label = s.floor || '층 ' || s.row_label || '열 ' || s.seat_no || '번' || case when s.kind = 'wheelchair' then ' (휠체어석)' else '' end
   where s.id in (select id from _w);

  if p_dsl is not null then update public.event_settings set layout_dsl = p_dsl where id = 1; end if;

  select count(*) into v_total from _w;
  return jsonb_build_object('ok', true, 'total_seats', v_total);
end $$;

-- ---------------------------------------------------------------------
-- 6. 함수 실행 권한
-- ---------------------------------------------------------------------
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.server_time()                                       to anon, authenticated;
grant execute on function public.cleanup_expired_holds()                             to anon, authenticated;
grant execute on function public.hold_seat(text, uuid)                               to anon, authenticated;
grant execute on function public.release_seat(text, uuid)                            to anon, authenticated;
grant execute on function public.release_session(uuid)                               to anon, authenticated;
grant execute on function public.my_holds(uuid)                                      to anon, authenticated;
grant execute on function public.confirm_reservation(uuid, text[], text, text, boolean, text) to anon, authenticated;
grant execute on function public.manage_login(text, text, text)                      to anon, authenticated;
grant execute on function public.update_my_info(text, text, text, text)              to anon, authenticated;
grant execute on function public.change_my_seats(text, text, uuid, text[])           to anon, authenticated;
grant execute on function public.cancel_my_reservation(text, text)                   to anon, authenticated;
grant execute on function public.lookup_reservation(text, text)                      to anon, authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on all functions in schema public to service_role;
    grant all on all tables in schema public to service_role;
    grant usage on all sequences in schema public to service_role;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. 실시간 동기화 (Supabase Realtime) — 좌석 테이블만 공개 브로드캐스트
-- ---------------------------------------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'seats') then
    alter publication supabase_realtime add table public.seats;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 8. 만료 점유 자동 해제 (pg_cron, 1분 간격)
--    ※ 실패해도 스키마 적용은 계속됩니다. 이 경우 README 의 안내대로
--      Database > Extensions 에서 pg_cron 을 켠 뒤 이 블록만 다시 실행하세요.
-- ---------------------------------------------------------------------
do $$ begin
  create extension if not exists pg_cron;
  perform cron.schedule('ito-cleanup-expired-holds', '* * * * *', 'select public.cleanup_expired_holds()');
exception when others then
  raise notice 'pg_cron 설정을 건너뜀: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------
-- 9. 기본 좌석 배치 (좌석이 없을 때만) — 공연장 좌석배치도(2026.02.05) 기준
--    1층 874석 (휠체어석 14 포함) + 2층 436석 = 총 1,310석
--    관리자 페이지 > 좌석 배치 설정 에서 수정할 수 있습니다.
-- ---------------------------------------------------------------------
do $seed$ begin
  if not exists (select 1 from public.seats) then
    perform public.admin_save_layout($J$[{"code":"1L","floor":1,"name":"1층 좌측","sort":1,"breaks":["L"],"rows":[{"r":"A","seats":[5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":1},{"r":"B","seats":[4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":2},{"r":"C","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":3},{"r":"D","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":4},{"r":"E","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":5},{"r":"F","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":6},{"r":"G","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":7},{"r":"H","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":8},{"r":"I","seats":[3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":9},{"r":"J","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":10},{"r":"K","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":11},{"r":"L","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":12},{"r":"M","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":13},{"r":"N","seats":[2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":14},{"r":"O","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":15},{"r":"P","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":16},{"r":"Q","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":17},{"r":"R","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":18},{"r":"S","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":19},{"r":"T","seats":[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15],"wheel":[],"idx":20},{"r":"U","seats":[3,4,5,6,7,8,9,10,11,12,13],"wheel":[14,15],"idx":21}]},{"code":"1C","floor":1,"name":"1층 중앙","sort":2,"breaks":["L"],"rows":[{"r":"A","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":1},{"r":"B","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":2},{"r":"C","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":3},{"r":"D","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":4},{"r":"E","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":5},{"r":"F","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":6},{"r":"G","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":7},{"r":"H","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":8},{"r":"I","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":9},{"r":"J","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":10},{"r":"K","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":11},{"r":"L","seats":[],"wheel":[16,17,18,19,20,21,22,23,24,25],"idx":12},{"r":"M","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":13},{"r":"N","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":14},{"r":"O","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":15},{"r":"P","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":16},{"r":"Q","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":17},{"r":"R","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":18},{"r":"S","seats":[16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31],"wheel":[],"idx":19}]},{"code":"1R","floor":1,"name":"1층 우측","sort":3,"breaks":["L"],"rows":[{"r":"A","seats":[32,33,34,35,36,37,38,39,40,41,42],"wheel":[],"idx":1},{"r":"B","seats":[32,33,34,35,36,37,38,39,40,41,42,43],"wheel":[],"idx":2},{"r":"C","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":3},{"r":"D","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":4},{"r":"E","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":5},{"r":"F","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":6},{"r":"G","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":7},{"r":"H","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":8},{"r":"I","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44],"wheel":[],"idx":9},{"r":"J","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":10},{"r":"K","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":11},{"r":"L","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":12},{"r":"M","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":13},{"r":"N","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45],"wheel":[],"idx":14},{"r":"O","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":15},{"r":"P","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":16},{"r":"Q","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":17},{"r":"R","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":18},{"r":"S","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":19},{"r":"T","seats":[32,33,34,35,36,37,38,39,40,41,42,43,44,45,46],"wheel":[],"idx":20},{"r":"U","seats":[34,35,36,37,38,39,40,41,42,43,44],"wheel":[32,33],"idx":21}]},{"code":"2L","floor":2,"name":"2층 좌측","sort":4,"breaks":["D"],"rows":[{"r":"A","seats":[1,2,3,4,5],"wheel":[],"idx":1},{"r":"B","seats":[1,2,3,4,5],"wheel":[],"idx":2},{"r":"C","seats":[1,2,3,4,5,6,7,8,9,10],"wheel":[],"idx":3},{"r":"D","seats":[1,2,3,4,5,6,7,8,9,10],"wheel":[],"idx":4},{"r":"E","seats":[1,2,3,4,5,6,7,8,9,10],"wheel":[],"idx":5},{"r":"F","seats":[1,2,3,4,5,6,7,8,9,10],"wheel":[],"idx":6},{"r":"G","seats":[1,2,3,4,5,6,7,8,9,10],"wheel":[],"idx":7},{"r":"H","seats":[2,3,4,5,6,7,8,9,10],"wheel":[],"idx":8},{"r":"I","seats":[3,4,5,6,7,8,9,10],"wheel":[],"idx":9},{"r":"J","seats":[5,6,7,8,9,10],"wheel":[],"idx":10},{"r":"K","seats":[6,7,8,9,10],"wheel":[],"idx":11},{"r":"L","seats":[7,8,9,10],"wheel":[],"idx":12}]},{"code":"2CL","floor":2,"name":"2층 중앙 좌측","sort":5,"breaks":["D"],"rows":[{"r":"C","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":3},{"r":"D","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":4},{"r":"E","seats":[11,12,13,14],"wheel":[],"idx":5},{"r":"F","seats":[11,12,13,14],"wheel":[],"idx":6},{"r":"G","seats":[11,12,13,14],"wheel":[],"idx":7},{"r":"H","seats":[11,12,13,14],"wheel":[],"idx":8},{"r":"I","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":9},{"r":"J","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":10},{"r":"K","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":11},{"r":"L","seats":[11,12,13,14,15,16,17,18,19,20],"wheel":[],"idx":12}]},{"code":"2C","floor":2,"name":"2층 중앙","sort":6,"breaks":["D"],"rows":[{"r":"C","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":3},{"r":"D","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":4},{"r":"E","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":5},{"r":"F","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":6},{"r":"G","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":7},{"r":"H","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":8},{"r":"I","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":9},{"r":"J","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":10},{"r":"K","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":11},{"r":"L","seats":[21,22,23,24,25,26,27,28,29,30],"wheel":[],"idx":12}]},{"code":"2CR","floor":2,"name":"2층 중앙 우측","sort":7,"breaks":["D"],"rows":[{"r":"C","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":3},{"r":"D","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":4},{"r":"E","seats":[37,38,39,40],"wheel":[],"idx":5},{"r":"F","seats":[37,38,39,40],"wheel":[],"idx":6},{"r":"G","seats":[37,38,39,40],"wheel":[],"idx":7},{"r":"H","seats":[37,38,39,40],"wheel":[],"idx":8},{"r":"I","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":9},{"r":"J","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":10},{"r":"K","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":11},{"r":"L","seats":[31,32,33,34,35,36,37,38,39,40],"wheel":[],"idx":12}]},{"code":"2R","floor":2,"name":"2층 우측","sort":8,"breaks":["D"],"rows":[{"r":"A","seats":[46,47,48,49,50],"wheel":[],"idx":1},{"r":"B","seats":[46,47,48,49,50],"wheel":[],"idx":2},{"r":"C","seats":[41,42,43,44,45,46,47,48,49,50],"wheel":[],"idx":3},{"r":"D","seats":[41,42,43,44,45,46,47,48,49,50],"wheel":[],"idx":4},{"r":"E","seats":[41,42,43,44,45,46,47,48,49,50],"wheel":[],"idx":5},{"r":"F","seats":[41,42,43,44,45,46,47,48,49,50],"wheel":[],"idx":6},{"r":"G","seats":[41,42,43,44,45,46,47,48,49,50],"wheel":[],"idx":7},{"r":"H","seats":[41,42,43,44,45,46,47,48,49],"wheel":[],"idx":8},{"r":"I","seats":[41,42,43,44,45,46,47,48],"wheel":[],"idx":9},{"r":"J","seats":[41,42,43,44,45,46],"wheel":[],"idx":10},{"r":"K","seats":[41,42,43,44,45],"wheel":[],"idx":11},{"r":"L","seats":[41,42,43,44],"wheel":[],"idx":12}]}]$J$::jsonb, $L$# ───── 1층 (874석) ─────
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
$L$);
  end if;
end $seed$;
