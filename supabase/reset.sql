-- ⚠ 이전 버전 schema.sql 을 이미 실행했거나, 모든 데이터를 지우고 처음부터 다시 설치할 때만 사용하세요.
--   예약 데이터가 모두 삭제됩니다. 실행 후 schema.sql 을 다시 실행하세요.
do $$ begin perform cron.unschedule('ito-cleanup-expired-holds'); exception when others then null; end $$;
drop table if exists public.reservation_seats, public.reservations, public.seat_holds, public.seats, public.sections, public.event_settings cascade;
drop sequence if exists public.reservation_no_seq;
drop function if exists public.admin_save_layout(jsonb);
drop function if exists public.admin_save_layout(jsonb, text);
