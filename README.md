# 🏠 RBS Homes CRM — 설치 및 실행 가이드

## 기술 스택
- **백엔드**: Node.js + Express.js
- **데이터베이스**: PostgreSQL (Supabase - 무료 플랜)
- **인증**: JWT
- **배포**: Railway 또는 Render (무료)

---

## 1단계: Supabase 데이터베이스 설정

### 1-1. Supabase 프로젝트 생성
1. https://supabase.com 접속 → 회원가입
2. "New Project" → 프로젝트명: `rbs-homes-crm`
3. 데이터베이스 비밀번호 저장 (나중에 필요)
4. Region: **Southeast Asia (Singapore)**

### 1-2. 스키마 적용
1. Supabase 대시보드 → **SQL Editor**
2. `database/schema.sql` 파일 내용 전체 복사 → 붙여넣기 → Run

### 1-3. API 키 확인
- Settings → API → `URL` 과 `service_role` 키 복사

---

## 2단계: 백엔드 서버 설정

```bash
# 패키지 설치
cd rbs-crm-backend
npm install

# 환경변수 설정
cp .env.example .env
# .env 파일을 편집기로 열어 Supabase URL, Service Key, JWT_SECRET 입력

# 개발 서버 실행
npm run dev
# → http://localhost:4000 에서 실행

# 정상 확인
curl http://localhost:4000/health
```

---

## 3단계: 첫 로그인

schema.sql에 초기 직원 데이터가 등록되어 있습니다.
비밀번호는 초기 설정이 필요합니다:

```bash
# Use the approved administrator provisioning procedure; no default password is provided.
Do not use blanket password-update SQL. Provision the first administrator through an approved secret-management and password-reset procedure.
```

초기 로그인:
- Never commit, share, or document default passwords.

## Time-management release checks

Use Node.js 22.22 or newer. Install the root and UI lockfiles separately, build the React client into `/public/time-management`, then run the browser suite against local in-memory fixtures:

```powershell
npm ci
npm --prefix time-management-ui ci
npm run build
npm run test:e2e
```

The E2E server is local-only, disables the scheduler, blocks external browser requests, and uses deterministic fake AI/Push/API state. It does not contact Supabase, AI, email, Push, Railway, staging, or production. Read `docs/time-management-operations.md`, `docs/time-management-privacy.md`, and `docs/time-management-release-evidence.md` before any rollout.

---

## 4단계: Railway 배포 (무료)

```bash
# Railway CLI 설치
npm install -g @railway/cli

# 로그인 및 배포
railway login
railway init
railway up

# 환경변수 설정
railway variables set SUPABASE_URL=...
railway variables set SUPABASE_SERVICE_KEY=...
railway variables set JWT_SECRET=...
```

---

## API 엔드포인트 목록

### 인증
```
POST   /api/auth/login           로그인 → JWT 토큰 발급
GET    /api/auth/me              내 정보 조회
POST   /api/auth/change-password 비밀번호 변경
```

### 고객 (Contacts)
```
GET    /api/contacts             전체 조회 (type/status/agent/q 필터)
GET    /api/contacts/:id         상세 조회
POST   /api/contacts             신규 등록
PATCH  /api/contacts/:id         수정
DELETE /api/contacts/:id         비활성화
```

### 매물 (Listings)
```
GET    /api/listings             전체 조회 (type/ptype/status 필터)
GET    /api/listings/:id         상세 조회
POST   /api/listings             신규 등록
PATCH  /api/listings/:id         수정 (상태 변경 포함)
```

### 리드 (Leads)
```
GET    /api/leads                전체 조회 (status/agent 필터)
GET    /api/leads/followup       오늘 팔로업 필요 목록
GET    /api/leads/:id            상세 조회
POST   /api/leads                신규 등록
PATCH  /api/leads/:id            상태 변경 · 팔로업 업데이트
POST   /api/leads/:id/activity   활동 기록 추가
```

### 계약·커미션 (Deals)
```
GET    /api/deals/calculate      커미션 실시간 계산 (저장 전)
GET    /api/deals                목록 (period/type 필터)
GET    /api/deals/:id            상세 조회
POST   /api/deals                계약 등록 (커미션 자동 계산)
PATCH  /api/deals/:id            수정
GET    /api/deals/summary/monthly 월별 요약
```

### 회계 (Accounting)
```
GET    /api/accounting/summary   이달 P&L 요약
GET    /api/accounting/expenses  지출 목록
POST   /api/accounting/expenses  지출 추가
DELETE /api/accounting/expenses/:id 지출 삭제
GET    /api/accounting/pl        월별 손익 추이
```

### 직원 실적 (Staff)
```
GET    /api/staff                직원 목록
GET    /api/staff/performance    이달 실적 전체
GET    /api/staff/:id/deals      개인 계약 내역
```

### 대시보드
```
GET    /api/dashboard            메인 대시보드 전체 데이터
```

---

## 커미션 계산 로직

```
[임대 계약]
- Co-broke 없음: 당사 수수료 = 계약금액 × 100%
- Co-broke 있음: 당사 수수료 = 계약금액 × 50%
- 직원 인센티브 = 당사 수수료 × 10%

[매매 계약]
- Co-broke 없음: 당사 수수료 = 계약금액 × 100%
- Co-broke 있음: 당사 수수료 = 계약금액 × 50%
- 직원 인센티브 = 당사 수수료 × 15%

[커미션 귀속]
- 임대인/매도인 측 직원: owner_agent_fee 지급
- 임차인/매수인 측 직원: tenant_agent_fee 지급
- 대표 확보 매물 → May 귀속: owner_agent_user_id = May's user_id
- 타 중개사: is_external = true → fee = 0
```

---

## 폴더 구조
```
rbs-crm-backend/
├── server.js           메인 서버
├── package.json
├── .env.example        환경변수 템플릿
├── database/
│   └── schema.sql      PostgreSQL 스키마 (Supabase에 적용)
├── middleware/
│   └── auth.js         JWT 인증 미들웨어
└── routes/
    ├── auth.js         인증 API
    ├── contacts.js     고객 관리 API
    ├── listings.js     매물 관리 API
    ├── leads.js        리드·파이프라인 API
    ├── deals.js        계약·커미션 API
    ├── accounting.js   회계 API
    ├── staff.js        직원 실적 API
    └── dashboard.js    대시보드 통합 API
```
