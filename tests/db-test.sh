#!/usr/bin/env bash
# 로컬 PostgreSQL 에서 스키마의 동시성·권한을 검증하는 스크립트
# 사용: PGHOST=... PGPORT=... PGUSER=postgres bash tests/db-test.sh
set -u
PASS=0; FAIL=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
q()    { psql -X -qtA -v ON_ERROR_STOP=1 -c "$1" 2>&1; }
anon() { psql -X -qtA -c "set role anon; $1" 2>&1; }
check(){ if [ "$2" == "$3" ]; then ok "$1"; else bad "$1 (기대값: $3, 실제: $2)"; fi; }

reset() {
  q "truncate reservation_seats, reservations, seat_holds;
     update seats set status='available', hold_expires_at=null;
     alter sequence reservation_no_seq restart;
     update event_settings set max_seats_per_person=4, hold_minutes=10, reservation_open=true;" >/dev/null
}

echo "▶ 1. 권한 / 개인정보 보호"
reset
out=$(anon "select count(*) from seats;");                     [[ "$out" =~ ^[0-9]+$ ]] && ok "익명: 좌석 조회 가능 ($out석)" || bad "익명 좌석 조회 실패: $out"
out=$(anon "select * from reservations;");                     [[ "$out" == *"permission denied"* ]] && ok "익명: 예약자(개인정보) 테이블 조회 차단" || bad "reservations 노출: $out"
out=$(anon "select * from seat_holds;");                       [[ "$out" == *"permission denied"* ]] && ok "익명: 점유 세션 테이블 조회 차단" || bad "seat_holds 노출"
out=$(anon "update seats set status='available';");            [[ "$out" == *"permission denied"* ]] && ok "익명: 좌석 직접 수정 차단" || bad "seats 직접 수정 가능: $out"
out=$(anon "select admin_overview();");                        [[ "$out" == *"permission denied"* ]] && ok "익명: 관리자 함수 실행 차단" || bad "admin_overview 실행됨"
out=$(anon "select admin_cancel_reservation(gen_random_uuid());"); [[ "$out" == *"permission denied"* ]] && ok "익명: 예약 취소 함수 차단" || bad "admin_cancel 실행됨"
out=$(psql -X -qtA -c "set role service_role; select (admin_overview()->'stats'->>'total_seats');" 2>&1); [[ "$out" =~ ^[0-9]+$ ]] && ok "service_role: 관리자 함수 실행 가능" || bad "service_role 실패: $out"

echo "▶ 2. 동시에 같은 좌석 점유 시도 (100명 동시)"
reset
for i in $(seq 1 100); do
  psql -X -qtA -c "set role anon; select hold_seat('1-E-20', gen_random_uuid());" >/tmp/race_$i.txt 2>&1 &
done; wait
succ=$(grep -l '"seat_id"' /tmp/race_*.txt | wc -l); held=$(grep -l 'HELD_BY_OTHER' /tmp/race_*.txt | wc -l); rm -f /tmp/race_*.txt
check "점유 성공은 정확히 1명" "$succ" "1"
check "나머지 99명은 HELD_BY_OTHER" "$held" "99"

echo "▶ 3. 같은 좌석 최종 확정 경쟁 (온라인 확정 vs 관리자 배정 동시)"
reset
S1=$(q "select gen_random_uuid()")
q "set role anon; select hold_seat('1-A-5','$S1');" >/dev/null
psql -X -qtA -c "set role anon; select confirm_reservation('$S1', array['1-A-5'], '홍길동', '010-1234-5678', true);" >/tmp/c1.txt 2>&1 &
psql -X -qtA -c "set role service_role; select admin_create_reservation(array['1-A-5'], '관리자배정', '010-9999-0000', null);" >/tmp/c2.txt 2>&1 &
wait
n=$(q "select count(*) from reservation_seats where seat_id='1-A-5'")
check "1-A-5 의 확정 예약은 1건" "$n" "1"
w=$( (grep -c reservation_no /tmp/c1.txt; grep -c reservation_no /tmp/c2.txt) | paste -sd+ | bc)
check "두 요청 중 정확히 하나만 성공" "$w" "1"

echo "▶ 4. 중복 제출 (같은 사용자가 예약하기를 동시에 5번)"
reset
S=$(q "select gen_random_uuid()")
q "set role anon; select hold_seat('1-B-16','$S'); select hold_seat('1-B-17','$S');" >/dev/null
for i in 1 2 3 4 5; do
  psql -X -qtA -c "set role anon; select confirm_reservation('$S', array['1-B-17','1-B-16'], '김철수', '01022223333', true);" >/tmp/dup_$i.txt 2>&1 &
done; wait
check "예약은 1건만 생성" "$(q "select count(*) from reservations")" "1"
check "5번 모두 같은 예약번호 응답" "$(cat /tmp/dup_*.txt | grep -o 'ITO-[0-9]*-[0-9]*' | sort -u | wc -l)" "1"
rm -f /tmp/dup_*.txt
check "예약번호 형식" "$(q "select reservation_no ~ '^ITO-[0-9]{4}-0001$' from reservations")" "t"
check "좌석 라벨 정렬" "$(q "select array_to_string(seat_labels, ', ') from reservations")" "1층 B열 16번, 1층 B열 17번"
check "연락처 숫자만 저장" "$(q "select phone from reservations")" "01022223333"

echo "▶ 5. 임시 점유 만료"
reset
S1=$(q "select gen_random_uuid()"); S2=$(q "select gen_random_uuid()")
q "set role anon; select hold_seat('1-C-40','$S1');" >/dev/null
out=$(anon "select hold_seat('1-C-40','$S2');"); [[ "$out" == *HELD_BY_OTHER* ]] && ok "점유 중 좌석은 다른 사용자 선택 불가" || bad "$out"
q "update seats set hold_expires_at = now() - interval '1 second' where id='1-C-40'; update seat_holds set expires_at = now() - interval '1 second' where seat_id='1-C-40';" >/dev/null
out=$(anon "select confirm_reservation('$S1', array['1-C-40'], '홍길동', '01012345678', true);"); [[ "$out" == *HOLD_EXPIRED* ]] && ok "만료 후에는 예약 확정 불가" || bad "$out"
check "cleanup_expired_holds 가 1석 해제" "$(anon "select cleanup_expired_holds();")" "1"
check "만료 좌석은 다시 예약 가능 상태" "$(q "select status from seats where id='1-C-40'")" "available"
out=$(anon "select hold_seat('1-C-40','$S2');"); [[ "$out" == *seat_id* ]] && ok "다른 사용자가 이어서 점유 가능" || bad "$out"

echo "▶ 6. 1인당 좌석 수 제한"
reset
q "update event_settings set max_seats_per_person=2" >/dev/null
S=$(q "select gen_random_uuid()")
anon "select hold_seat('1-F-16','$S'); select hold_seat('1-F-17','$S');" >/dev/null
out=$(anon "select hold_seat('1-F-18','$S');"); [[ "$out" == *LIMIT_EXCEEDED* ]] && ok "세션당 최대 2석 초과 차단" || bad "$out"
anon "select confirm_reservation('$S', array['1-F-16','1-F-17'], '이영희', '010-5555-6666', true);" >/dev/null
S3=$(q "select gen_random_uuid()")
anon "select hold_seat('1-G-16','$S3');" >/dev/null
out=$(anon "select confirm_reservation('$S3', array['1-G-16'], '이영희', '01055556666', true);"); [[ "$out" == *PHONE_LIMIT* ]] && ok "같은 연락처 추가 예약 한도 차단" || bad "$out"
out=$(anon "select confirm_reservation('$S3', array['1-G-16'], '', '01055556666', true);");    [[ "$out" == *INVALID_NAME* ]] && ok "이름 누락 차단" || bad "$out"
out=$(anon "select confirm_reservation('$S3', array['1-G-16'], '박', '0212345678', true);");    [[ "$out" == *INVALID_PHONE* ]] && ok "잘못된 연락처 차단" || bad "$out"
out=$(anon "select confirm_reservation('$S3', array['1-G-16'], '박', '01012341234', false);");  [[ "$out" == *AGREE_REQUIRED* ]] && ok "개인정보 동의 누락 차단" || bad "$out"
out=$(anon "select confirm_reservation('$S', array['1-G-16'], '박', '01012341234', true);");    [[ "$out" == *HOLD_EXPIRED* ]] && ok "다른 사람이 점유한 좌석으로 확정 시도 차단" || bad "$out"

echo "▶ 7. 예약 취소 · 좌석 차단 · 현장 수령"
RID=$(q "select id from reservations limit 1")
q "set role service_role; select admin_set_pickup('$RID', true);" >/dev/null
check "현장 수령 체크" "$(q "select picked_up from reservations where id='$RID'")" "t"
q "set role service_role; select admin_cancel_reservation('$RID');" >/dev/null
check "취소 후 좌석 예약 가능" "$(q "select string_agg(status, ',') from seats where id in ('1-F-16','1-F-17')")" "available,available"
check "취소 후 연결 좌석 해제" "$(q "select count(*) from reservation_seats where reservation_id='$RID'")" "0"
q "set role service_role; select admin_set_seat_status('1-L-2','blocked');" >/dev/null
out=$(anon "select hold_seat('1-L-2', gen_random_uuid());"); [[ "$out" == *BLOCKED* ]] && ok "관리자 차단 좌석 선택 불가" || bad "$out"

echo "▶ 8. 대량 동시 예약 스트레스 (300명이 좌석 30개를 두고 동시에 점유+확정)"
reset
q "update event_settings set max_seats_per_person=4" >/dev/null
for i in $(seq 1 300); do
  ( r=$((RANDOM % 30)); rows=(A B C); row=${rows[$((r/10))]}; col=$(( r%10 + 16 ))
    psql -X -qtA -c "set role anon; do \$\$ declare s uuid := gen_random_uuid(); begin
        perform hold_seat('1-$row-$col', s);
        perform confirm_reservation(s, array['1-$row-$col'], '관객$i', '010' || lpad('$i',8,'0'), true);
      exception when others then null; end \$\$;" >/dev/null 2>&1 ) &
done; wait
check "좌석당 확정 예약 최대 1건 (중복 0건)" "$(q "select count(*) from (select unnest(seat_ids) s from reservations where status='confirmed') x group by s having count(*)>1" | wc -l)" "0"
check "reserved 좌석 수 = 확정 예약 좌석 수" "$(q "select (select count(*) from seats where status='reserved') = (select count(*) from reservation_seats)")" "t"
echo "    (확정된 예약: $(q "select count(*) from reservations")건 / 경쟁 좌석 30석)"

echo "▶ 9. 실제 공연장 좌석 데이터"
check "1층 좌석 수" "$(q "select count(*) from seats where floor=1")" "874"
check "2층 좌석 수" "$(q "select count(*) from seats where floor=2")" "436"
check "휠체어석 수" "$(q "select count(*) from seats where kind='wheelchair'")" "14"
echo "▶ 10. 좌석 배치 변경 보호"
out=$(psql -X -qtA -c "set role service_role; select admin_save_layout('[{\"code\":\"1L\",\"floor\":1,\"name\":\"x\",\"sort\":1,\"rows\":[{\"r\":\"A\",\"idx\":1,\"seats\":[5]}]}]');" 2>&1)
[[ "$out" == *LAYOUT_CONFLICT* ]] && ok "예약된 좌석을 없애는 배치 변경 거부" || bad "$out"

echo
echo "결과: 통과 $PASS / 실패 $FAIL"
[ "$FAIL" -eq 0 ]
