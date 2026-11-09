# 인천교사오케스트라 정기연주회 · 무료 좌석 예약 사이트

관객이 영화관 예매처럼 좌석을 직접 골라 무료로 예약하고, 공연 당일 현장에서 티켓을 받는 공개 웹사이트입니다.

- **관객 화면** `/` : 공연 안내 → 좌석 선택 → 정보 입력(본인 확인 코드 포함) → 예약 확인서(예약번호 발급) · **예약 확인·변경**(이름+연락처+코드로 좌석 변경·정보 수정·취소)
- **관리자 화면** `/admin` : 비밀번호 로그인, 예약 현황, 예약자 목록·검색, 예약 취소, 현장 수령 체크, 좌석 차단·직접 배정, 공연 정보·좌석 배치 변경, 엑셀 다운로드, 현장 배부용 명단 출력
- **구성** : 정적 웹페이지 + Vercel 서버 함수(관리자 API) + Supabase(PostgreSQL · Realtime)
- 빌드 도구나 npm 패키지 설치가 **필요 없습니다.** 파일을 그대로 올리면 배포됩니다.

---

## 1. 동작 원리 (중복 예약이 생기지 않는 이유)

| 단계 | 처리 | 보장 장치 |
|---|---|---|
| 좌석 클릭 | `hold_seat` DB 함수가 좌석 행을 `FOR UPDATE` 로 잠그고 임시 점유 | 한 순간에 한 요청만 그 좌석을 바꿀 수 있음 |
| 임시 점유 | 기본 10분(관리자 설정 2~30분). 한 사람의 좌석은 같은 만료 시각 공유 | 만료되면 다른 관객이 바로 선택 가능, `pg_cron`이 1분마다 정리 |
| 예약 확정 | `confirm_reservation` 이 좌석들을 id 순서로 잠근 뒤, **내가 점유 중인지** 확인하고 한 트랜잭션으로 확정 | 전부 성공하거나 전부 실패(원자적). `reservation_seats.seat_id` PRIMARY KEY 가 최종 안전장치 |
| 화면 반영 | `seats` 테이블 변경을 Supabase Realtime 으로 모든 접속자에게 전송 | 연결이 끊기면 8초 간격 자동 새로고침으로 전환 |
| 중복 제출 | 같은 사용자가 예약하기를 여러 번 눌러도 같은 예약번호를 돌려줌 | 버튼 잠금 + DB 단 멱등 처리 |

**개인정보 보호**

- 관객 브라우저가 쓰는 공개 키(publishable/anon)로는 `seats`·`sections`·`event_settings`(공개 정보)만 읽을 수 있습니다.
- 예약자 이름·연락처가 있는 `reservations` 테이블과 점유 세션 테이블은 RLS 와 권한 회수로 **공개 키 접근이 완전히 차단**됩니다.
- 관리자 기능은 Vercel 서버 함수 `/api/admin` 에서만 실행됩니다. 비밀번호를 서버에서 검증한 뒤 HMAC 서명된 `HttpOnly · Secure · SameSite=Strict` 쿠키(12시간)를 발급하고, 매 요청마다 서버가 쿠키를 검증한 뒤에만 secret 키로 관리자 전용 DB 함수를 호출합니다.
- secret 키·관리자 비밀번호는 **Vercel 환경변수에만** 저장되며 코드에 들어 있지 않습니다.
- 내 예약 조회는 이름과 연락처가 **모두** 일치해야 결과가 나옵니다.
- **본인 확인 코드(숫자 4~6자리)** 는 원문을 저장하지 않고 예약마다 다른 무작위 값(salt)을 섞은 SHA-256 해시로만 저장합니다. 관리자도 코드를 볼 수 없습니다.
  - 이름+연락처+코드가 맞아야 좌석 변경·정보 수정·취소가 가능하고, **5회 연속 틀리면 15분 잠금**됩니다.
  - 좌석 변경은 "기존 좌석 중 유지할 것 + 새로 임시 점유한 좌석"을 한 트랜잭션으로 바꿔, 변경 도중 다른 관객이 끼어들 수 없습니다. 예약번호는 그대로 유지됩니다.
  - 현장에서 티켓을 받은(수령 체크된) 예약은 좌석 변경·취소가 막힙니다.
  - 관객이 코드를 잊으면 관리자 화면 → 예약 상세 → **코드 재설정**으로 새 코드를 정해 알려 주세요(잠금도 해제).

---

## 2. 배포하기 (약 20분)

### ① Supabase 프로젝트 만들기

1. <https://supabase.com> 가입 → **New project**
   - Region: **Northeast Asia (Seoul)** 권장
   - Database password 는 안전한 곳에 보관
2. 왼쪽 메뉴 **SQL Editor** → **New query** → `supabase/schema.sql` 내용 전체를 붙여넣고 **Run**
   - 이미 `schema.sql` 을 실행한 프로젝트에 새 버전을 적용할 때는 **새 schema.sql 을 그대로 다시 실행**하면 됩니다(예약 데이터 유지). 좌석 체계를 바꾸기 전의 아주 초기 버전(A구역 방식)을 실행했다면 `supabase/reset.sql` 을 먼저 실행하세요. (모든 데이터 삭제)
   - 끝에 `pg_cron 설정을 건너뜀` 알림이 보이면: **Database → Extensions** 에서 `pg_cron` 을 켠 뒤 `schema.sql` 을 **한 번 더 실행**하세요. (다시 실행해도 데이터는 안전합니다)
3. 확인
   - **Table Editor → seats** 에 1,310개 좌석(1층 874 · 2층 436)이 생겼는지
   - **Database → Publications → supabase_realtime** 에 `seats` 가 포함되어 있는지
4. **Project Settings → API Keys** 에서 두 키를 복사
   - `Publishable key` (`sb_publishable_…`) → 공개용
   - `Secret key` (`sb_secret_…`) → **서버 전용, 절대 공개 금지**
   - (기존 프로젝트라면 Legacy 탭의 `anon` / `service_role` 키를 써도 됩니다)
5. **Project Settings → Data API** 에서 Project URL 복사 (`https://xxxx.supabase.co`)

### ② GitHub 에 올리기

이 폴더 전체를 새 GitHub 저장소(Private 권장)에 올립니다. `.env` 파일은 만들지도, 올리지도 마세요.

### ③ Vercel 에 배포

1. <https://vercel.com> → **Add New → Project** → 위 저장소 **Import**
2. Framework Preset: **Other** (Build Command 비움, Output Directory 는 `vercel.json` 이 `public` 으로 지정)
3. **Environment Variables** 에 아래 5개 입력 (`.env.example` 참고)

| 이름 | 값 |
|---|---|
| `SUPABASE_URL` | Supabase Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key (또는 legacy anon key) |
| `SUPABASE_SECRET_KEY` | Secret key (또는 legacy service_role key) |
| `ADMIN_PASSWORD` | 관리자 비밀번호 (12자 이상, 추측 어려운 문장 권장) |
| `ADMIN_SESSION_SECRET` | 32자 이상 무작위 문자열 — 터미널에서 `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |

4. **Deploy** → 발급된 `https://프로젝트명.vercel.app` 주소가 공개 URL 입니다. HTTPS 는 자동 적용됩니다.
5. 도메인을 쓰려면 Vercel **Settings → Domains** 에서 연결합니다.

> 환경변수를 바꾼 뒤에는 **Deployments → Redeploy** 해야 반영됩니다.
> 관리자 비밀번호를 바꾸면 기존 관리자 로그인은 모두 자동 로그아웃됩니다.

### ④ 배포 후 확인

1. `https://주소/` 접속 → 상단에 **데모 모드** 띠가 **없어야** 정상입니다. 좌석 배치도 오른쪽 위에 "실시간 연결됨"이 보이면 Realtime 도 정상입니다.
2. `https://주소/admin` → 비밀번호 로그인
3. **두 사람 동시 예약 테스트** — 컴퓨터에서 Node 20 이상으로 실행(설치 불필요):

```bash
SUPABASE_URL=https://xxxx.supabase.co \
SUPABASE_PUBLISHABLE_KEY=sb_publishable_xxx \
node tests/race-test.mjs 50
```

50명이 동시에 같은 좌석을 누르면 정확히 1명만 성공하는지, 공개 키로 개인정보·관리자 기능에 접근할 수 없는지 검사합니다. (좌석은 검사 직후 해제되며 예약은 생기지 않습니다)

4. 브라우저 두 개(또는 PC + 휴대폰)로 같은 좌석을 눌러 보세요. 한쪽이 초록색이 되면 다른 쪽은 곧바로(보통 1초 이내) 노란색으로 바뀝니다.

---

## 3. 공개 전 준비

1. **관리자 → 공연 정보 · 운영 설정** : 공연명, 일시, 장소, 프로그램, 관람 안내, 1인당 최대 좌석 수, 점유 시간 입력
2. **좌석 배치** : 공연장 좌석배치도(2026.02.05)를 그대로 옮겨 **1층 874석(휠체어석 14) + 2층 436석 = 1,310석**이 기본으로 들어가 있습니다.
   - 좌석 이름은 공연장 표기 그대로 `1층 A열 16번` 형식입니다.
   - 도면이 바뀌면 **관리자 → 좌석 배치 설정**에서 텍스트로 고칩니다. 오른쪽 미리보기에 즉시 반영되고, 오류는 줄 번호와 함께 표시됩니다.

     ```
     [1L | 1 | 1층 좌측]     ← 블록 시작 [코드 | 층 | 이름]
     A 5-15                 ← A열 5~15번
     E-I 3-15               ← E~I열 각각 3~15번
     U 3-13, w14-15         ← w = 휠체어석
     --                     ← 가로 통로
     ```
   - 휠체어석은 선택 시 "휠체어 이용 관객 전용" 안내가 뜹니다. 온라인 예약을 막고 전화로만 받으려면 좌석 현황에서 "예약 불가"로 지정하세요.
3. **관리자 → 좌석 현황 · 관리** : 관계자석·장애인석·음향 콘솔 자리 등은 "예약 불가로 지정", 초대석은 "직접 배정"
4. 테스트 예약을 모두 지우고 예약번호를 0001부터 다시 시작하려면 SQL Editor 에서:

```sql
truncate public.reservation_seats, public.reservations, public.seat_holds;
update public.seats set status = 'available', hold_expires_at = null where status in ('reserved','held');
alter sequence public.reservation_no_seq restart;
```

5. 예약 마감 시: **관리자 → 운영 설정 → 예약 접수** 끄기

---

## 4. 공연 당일 운영

- **현장 배부용 출력** : 이름 가나다순 / 예약번호순 / 좌석순 A4 명단 (연락처 가운데 4자리 가림, 수령 체크 칸 포함)
- **엑셀 다운로드** : `예약자 목록` + `좌석별 배부표` 두 시트로 된 .xlsx
- 배부처에서 노트북·태블릿으로 관리자 화면을 열고 이름이나 예약번호로 검색 → **현장 수령** 체크. 여러 명이 동시에 체크해도 20초 이내 서로의 화면에 반영됩니다.

## 5. 공연 후 개인정보 파기

예약 화면 안내대로 공연 종료 후 1개월 이내에 파기하세요. 엑셀로 보관이 필요하면 먼저 내려받은 뒤 실행합니다.

```sql
update public.reservations set name = '(파기)', phone = '00000000000', memo = null;
-- 또는 전체 삭제: truncate public.reservation_seats, public.reservations;
```

출력한 종이 명단도 함께 파기하세요.

---

## 6. 알아두면 좋은 점 (한계와 대응)

- **Supabase 무료 플랜**
  - 1주일 동안 활동이 없으면 프로젝트가 **일시정지**됩니다. 예약 오픈 전과 공연 전에 대시보드에서 상태를 꼭 확인하세요. 예약 기간에 Pro 플랜($25/월)을 쓰면 정지되지 않습니다.
  - 실시간 동시 연결은 **200명**까지입니다(Pro 500명). 초과한 접속자는 자동으로 8초 간격 새로고침 방식으로 동작하며, 중복 예약 방지는 DB 에서 처리하므로 영향이 없습니다.
- **악의적 대량 점유** : 회원가입이 없는 무료 예약 특성상, 스크립트로 좌석을 계속 점유하는 공격을 완전히 막지는 못합니다. 1인 최대 좌석 수, 같은 연락처 합계 제한, 점유 시간 만료로 피해를 줄이며, 필요하면 Vercel **Firewall** 의 Rate Limit / Attack Challenge Mode 를 켜세요.
- **관리자 로그인 시도 제한**은 서버 인스턴스 단위(10분 10회)입니다. 비밀번호는 길고 추측하기 어렵게 정하세요.
- 연락처 형식은 휴대전화(010·011·016~019)만 받습니다. 일반 전화가 필요하면 `schema.sql` 의 `_norm_phone` 과 `public/assets/core.js` 의 `validPhone` 을 함께 수정하세요.

---

## 7. 파일 구조

```
├─ public/                 정적 웹사이트 (Vercel 출력 폴더)
│  ├─ index.html           관객 화면
│  ├─ admin.html           관리자 화면
│  └─ assets/
│     ├─ style.css         공통 디자인 (검정·짙은 남색·골드)
│     ├─ admin.css         관리자 화면 디자인 · 명단 인쇄 양식
│     ├─ core.js           공통 UI · 좌석 배치도 렌더러
│     ├─ backend.js        데이터 계층 (Supabase / 데모)
│     ├─ app.js            좌석 선택 · 예약 흐름
│     └─ admin.js          관리자 기능
├─ api/
│  ├─ config.js            브라우저용 공개 설정 (URL + 공개 키만)
│  ├─ admin.js             관리자 API (인증 · 관리자 DB 함수 호출)
│  └─ _lib.js              서버 공통 모듈 (공개 경로 아님)
├─ supabase/schema.sql     테이블 · RLS · 원자적 예약 함수 · Realtime · pg_cron · 공연장 좌석 1,310석
├─ supabase/reset.sql      (재설치용) 전체 삭제
├─ tests/
│  ├─ race-test.mjs        배포 후 실제 DB 동시성 · 보안 검사
│  └─ db-test.sh           로컬 PostgreSQL 용 상세 검사 (56개 항목)
├─ vercel.json             보안 헤더(CSP·HSTS 등) · 라우팅
└─ .env.example            환경변수 목록
```

**데모 모드** : `public/index.html` 을 그냥 열거나 `/api/config` 가 없는 곳(미리보기)에서 열면, 브라우저 안에서만 동작하는 데모로 실행되고 화면 상단에 "데모 모드"가 표시됩니다. 배포 환경에서는 설정이 빠져 있어도 데모로 바뀌지 않고 오류를 표시합니다.

---

## 8. 검증 내역

제작 과정에서 PostgreSQL 16 에 `schema.sql` 을 적용해 다음을 확인했습니다.

- 공연장 좌석 데이터: 1층 874석(휠체어석 14) · 2층 436석 · 합계 1,310석이 도면 표기와 일치
- 본인 확인 코드: 해시 저장, 틀린 코드 거부·실패 횟수 기록, 5회 잠금, 관리자 재설정, 좌석 변경(1석 유지+1석 교체), 남의 좌석·미점유 좌석으로 변경 거부, 변경과 신규 예약이 같은 좌석에서 동시에 일어나도 1건만 성공, 수령 후 취소 불가
- 100명이 같은 좌석을 동시에 선택 → 1명만 성공, 99명 `HELD_BY_OTHER`
- 300명이 30개 좌석을 두고 동시에 선택+확정 → 좌석당 확정 예약 최대 1건, 중복 0건
- 온라인 확정과 관리자 배정이 같은 좌석에서 동시에 발생 → 1건만 성공
- 같은 사용자가 예약하기를 동시에 5번 → 예약 1건, 모두 같은 예약번호 응답
- 점유 만료 후 확정 불가, 만료 좌석 자동 반환, 1인·연락처별 매수 제한, 필수값·동의 누락 거부
- 공개 키로 예약자·점유 테이블 조회, 좌석 직접 수정, 관리자 함수 실행 → 모두 차단
- 관리자 API: 비밀번호 오류·위조 쿠키·다른 사이트 요청 차단, 취소·수령·배정·설정 변경 동작
- 브라우저 두 개로 실제 화면에서 같은 좌석 동시 클릭 → 한쪽만 선택, 다른 쪽은 노란색 + 안내, 예약 완료 즉시 빨간색 반영, 새로고침 후 선택 유지

로컬 검사 재현: `PGHOST=… PGUSER=postgres bash tests/db-test.sh` (Supabase 의 `anon`·`authenticated`·`service_role` 역할을 만든 PostgreSQL 에서 실행)
