-- ═══════════════════════════════════════════════════════════
-- RBS Homes CRM · 최종 수정 스키마 v2
-- 모든 SQL 오류 수정 완료
-- ═══════════════════════════════════════════════════════════

-- STEP 1: 기존 내용 전체 정리
DROP VIEW  IF EXISTS v_leads_followup        CASCADE;
DROP VIEW  IF EXISTS v_monthly_pl            CASCADE;
DROP VIEW  IF EXISTS v_staff_commission_monthly CASCADE;
DROP TABLE IF EXISTS visa_clients            CASCADE;
DROP TABLE IF EXISTS activities              CASCADE;
DROP TABLE IF EXISTS expenses                CASCADE;
DROP TABLE IF EXISTS deals                   CASCADE;
DROP TABLE IF EXISTS lead_participants       CASCADE;
DROP TABLE IF EXISTS leads                   CASCADE;
DROP TABLE IF EXISTS listings                CASCADE;
DROP TABLE IF EXISTS contacts                CASCADE;
DROP TABLE IF EXISTS users                   CASCADE;
DROP FUNCTION IF EXISTS generate_listing_code() CASCADE;
DROP FUNCTION IF EXISTS calc_deal_commission()  CASCADE;
DROP FUNCTION IF EXISTS set_expense_period()    CASCADE;

-- STEP 2: 확장 기능
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ───────────────────────────────────────
-- 1. USERS (직원)
-- ───────────────────────────────────────
CREATE TABLE users (
  id              UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  name            VARCHAR(100)  NOT NULL,
  email           VARCHAR(255)  UNIQUE NOT NULL,
  password_hash   VARCHAR(255)  NOT NULL,
  role            VARCHAR(20)   DEFAULT 'agent' CHECK (role IN ('admin','agent')),
  work_mode       VARCHAR(20)   DEFAULT 'full-time',
  base_salary     DECIMAL(10,2) DEFAULT 0,
  commission_rent DECIMAL(5,4)  DEFAULT 0.10,
  commission_sale DECIMAL(5,4)  DEFAULT 0.15,
  is_active       BOOLEAN       DEFAULT true,
  created_at      TIMESTAMP     DEFAULT NOW(),
  updated_at      TIMESTAMP     DEFAULT NOW()
);

-- ───────────────────────────────────────
-- 2. CONTACTS (고객)
-- ───────────────────────────────────────
CREATE TABLE contacts (
  id               UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  name             VARCHAR(200) NOT NULL,
  type             VARCHAR(20)  NOT NULL CHECK (type IN ('OWNER','TENANT','BUYER','SELLER')),
  mobile           VARCHAR(30),
  email            VARCHAR(255),
  nationality      VARCHAR(50)  DEFAULT 'Korean',
  platform         VARCHAR(50),
  assigned_user_id UUID REFERENCES users(id),
  status           VARCHAR(20)  DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  source           VARCHAR(50),
  remarks          TEXT,
  created_at       TIMESTAMP    DEFAULT NOW(),
  updated_at       TIMESTAMP    DEFAULT NOW()
);

-- ───────────────────────────────────────
-- 3. LISTINGS (매물)
-- ───────────────────────────────────────
CREATE TABLE listings (
  id                 UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  code               VARCHAR(50) UNIQUE,
  transaction_type   VARCHAR(10) NOT NULL CHECK (transaction_type IN ('RENT','SALE')),
  property_type      VARCHAR(30) CHECK (property_type IN ('CONDO','OFFICE','COMMERCIAL','BUILDING','LAND','OTHER')),
  name               VARCHAR(255) NOT NULL,
  unit_no            VARCHAR(50),
  address            TEXT,
  floor              VARCHAR(20),
  area_sqm           DECIMAL(8,2),
  bedrooms           INTEGER DEFAULT 0,
  bathrooms          INTEGER DEFAULT 0,
  parking            INTEGER DEFAULT 0,
  price              DECIMAL(12,2),
  is_furnished       BOOLEAN DEFAULT false,
  pet_friendly       BOOLEAN DEFAULT false,
  status             VARCHAR(20) DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON-HOLD','CONTRACTED','CLOSED')),
  listing_source_id  UUID REFERENCES contacts(id),
  assigned_user_id   UUID REFERENCES users(id),
  photo_url          TEXT,
  hyperlink          TEXT,
  remarks            TEXT,
  created_at         TIMESTAMP DEFAULT NOW(),
  updated_at         TIMESTAMP DEFAULT NOW()
);

-- 매물 코드 자동 생성
CREATE OR REPLACE FUNCTION generate_listing_code()
RETURNS TRIGGER AS $$
BEGIN
  NEW.code := 'L-' || TO_CHAR(NOW(), 'YYMM') || '-' || LOWER(SUBSTRING(NEW.id::TEXT, 1, 4));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_listing_code
  BEFORE INSERT ON listings
  FOR EACH ROW
  WHEN (NEW.code IS NULL)
  EXECUTE FUNCTION generate_listing_code();

-- ───────────────────────────────────────
-- 4. LEADS (문의·리드)
-- ───────────────────────────────────────
CREATE TABLE leads (
  id               UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  contact_id       UUID REFERENCES contacts(id) ON DELETE SET NULL,
  request_type     VARCHAR(10) CHECK (request_type IN ('RENT','BUY')),
  property_type    VARCHAR(30),
  status           VARCHAR(30) DEFAULT 'NEW'
                     CHECK (status IN ('NEW','SEARCHING','OFFER_SENT','NEGOTIATING','CLOSED_WON','CLOSED_LOST')),
  budget           DECIMAL(12,2),
  location_pref    VARCHAR(255),
  bedrooms_min     INTEGER,
  bedrooms_max     INTEGER,
  area_min         DECIMAL(8,2),
  area_max         DECIMAL(8,2),
  is_furnished     BOOLEAN,
  pet_allowed      BOOLEAN,
  target_move_in   DATE,
  assigned_user_id UUID REFERENCES users(id),
  next_followup_at DATE,
  remarks          TEXT,
  closed_reason    TEXT,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ───────────────────────────────────────
-- 5. LEAD_PARTICIPANTS (다중 에이전트)
-- ───────────────────────────────────────
CREATE TABLE lead_participants (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  lead_id     UUID REFERENCES leads(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id),
  role_code   VARCHAR(30) CHECK (role_code IN ('OWNER_AGENT','TENANT_AGENT','SELLER_AGENT','BUYER_AGENT')),
  is_external BOOLEAN DEFAULT false,
  joined_at   TIMESTAMP DEFAULT NOW(),
  is_active   BOOLEAN DEFAULT true
);

-- ───────────────────────────────────────
-- 6. DEALS (계약 + 커미션 자동계산)
-- ───────────────────────────────────────
CREATE TABLE deals (
  id                       UUID    DEFAULT uuid_generate_v4() PRIMARY KEY,
  listing_id               UUID REFERENCES listings(id),
  contract_type            VARCHAR(10) NOT NULL CHECK (contract_type IN ('RENT','SALE')),
  contract_date            DATE NOT NULL,
  move_in_date             DATE,
  contract_end_date        DATE,
  contract_months          INTEGER,
  monthly_rent             DECIMAL(12,2),
  sale_price               DECIMAL(12,2),
  gross_commission         DECIMAL(12,2) NOT NULL,
  is_co_broke              BOOLEAN DEFAULT false,
  company_share            DECIMAL(12,2),
  commission_rate          DECIMAL(5,4),
  owner_contact_id         UUID REFERENCES contacts(id),
  owner_agent_user_id      UUID REFERENCES users(id),
  owner_agent_is_external  BOOLEAN DEFAULT false,
  owner_agent_fee          DECIMAL(12,2) DEFAULT 0,
  tenant_contact_id        UUID REFERENCES contacts(id),
  tenant_agent_user_id     UUID REFERENCES users(id),
  tenant_agent_is_external BOOLEAN DEFAULT false,
  tenant_agent_fee         DECIMAL(12,2) DEFAULT 0,
  total_agent_fees         DECIMAL(12,2) DEFAULT 0,
  net_company_income       DECIMAL(12,2),
  status                   VARCHAR(20) DEFAULT 'ACTIVE',
  renewal_count            INTEGER DEFAULT 0,
  remarks                  TEXT,
  created_by               UUID REFERENCES users(id),
  created_at               TIMESTAMP DEFAULT NOW(),
  updated_at               TIMESTAMP DEFAULT NOW()
);

-- 커미션 자동 계산 트리거
CREATE OR REPLACE FUNCTION calc_deal_commission()
RETURNS TRIGGER AS $$
BEGIN
  -- Co-broke 처리
  IF NEW.is_co_broke THEN
    NEW.company_share := NEW.gross_commission * 0.5;
  ELSE
    NEW.company_share := NEW.gross_commission;
  END IF;

  -- 커미션율
  IF NEW.contract_type = 'RENT' THEN
    NEW.commission_rate := 0.10;
  ELSE
    NEW.commission_rate := 0.15;
  END IF;

  -- 에이전트 수수료
  IF NEW.owner_agent_is_external THEN
    NEW.owner_agent_fee := 0;
  ELSE
    NEW.owner_agent_fee := COALESCE(NEW.company_share * NEW.commission_rate, 0);
  END IF;

  IF NEW.tenant_agent_is_external THEN
    NEW.tenant_agent_fee := 0;
  ELSE
    NEW.tenant_agent_fee := COALESCE(NEW.company_share * NEW.commission_rate, 0);
  END IF;

  NEW.total_agent_fees  := NEW.owner_agent_fee + NEW.tenant_agent_fee;
  NEW.net_company_income := NEW.company_share - NEW.total_agent_fees;

  -- 계약 만료일 자동 계산 (임대 계약)
  IF NEW.contract_type = 'RENT'
     AND NEW.move_in_date IS NOT NULL
     AND NEW.contract_months IS NOT NULL THEN
    NEW.contract_end_date := NEW.move_in_date + make_interval(months => NEW.contract_months);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auto_calc_commission
  BEFORE INSERT OR UPDATE ON deals
  FOR EACH ROW
  EXECUTE FUNCTION calc_deal_commission();

-- ───────────────────────────────────────
-- 7. EXPENSES (지출)
-- ───────────────────────────────────────
CREATE TABLE expenses (
  id          UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  category    VARCHAR(50) NOT NULL,
  description VARCHAR(255),
  amount      DECIMAL(12,2) NOT NULL,
  date        DATE NOT NULL,
  period      VARCHAR(7),
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMP DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION set_expense_period()
RETURNS TRIGGER AS $$
BEGIN
  NEW.period := TO_CHAR(NEW.date, 'YYYY-MM');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_period
  BEFORE INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION set_expense_period();

-- ───────────────────────────────────────
-- 8. ACTIVITIES (활동 기록)
-- ───────────────────────────────────────
CREATE TABLE activities (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  type             VARCHAR(30) CHECK (type IN ('CALL','MESSAGE','VISIT','OFFER','CONTRACT','OTHER')),
  contact_id       UUID REFERENCES contacts(id),
  lead_id          UUID REFERENCES leads(id),
  listing_id       UUID REFERENCES listings(id),
  result_code      VARCHAR(50),
  notes            TEXT,
  next_followup_at DATE,
  created_by       UUID REFERENCES users(id),
  created_at       TIMESTAMP DEFAULT NOW()
);

-- ───────────────────────────────────────
-- 9. VISA_CLIENTS (은퇴비자 - May 전담)
-- ───────────────────────────────────────
CREATE TABLE visa_clients (
  id               UUID DEFAULT uuid_generate_v4() PRIMARY KEY,
  contact_id       UUID REFERENCES contacts(id),
  visa_type        VARCHAR(50) DEFAULT 'SRRV',
  status           VARCHAR(30) DEFAULT 'NEW'
                     CHECK (status IN ('NEW','DOCUMENTS','SUBMITTED','PROCESSING','APPROVED','REJECTED','RENEWAL')),
  service_fee      DECIMAL(10,2),
  service_type     VARCHAR(20) CHECK (service_type IN ('NEW','RENEWAL','CANCELLATION')),
  submitted_at     DATE,
  approved_at      DATE,
  expiry_at        DATE,
  assigned_user_id UUID REFERENCES users(id),
  remarks          TEXT,
  created_at       TIMESTAMP DEFAULT NOW(),
  updated_at       TIMESTAMP DEFAULT NOW()
);

-- ───────────────────────────────────────
-- VIEWS (CTE 방식으로 수정 - 오류 없음)
-- ───────────────────────────────────────

-- 직원별 월별 커미션
CREATE OR REPLACE VIEW v_staff_commission_monthly AS
SELECT
  u.id,
  u.name,
  u.base_salary,
  TO_CHAR(d.contract_date, 'YYYY-MM') AS period,
  COUNT(DISTINCT d.id) AS deal_count,
  COALESCE(SUM(CASE WHEN d.owner_agent_user_id  = u.id THEN d.owner_agent_fee  ELSE 0 END), 0) AS owner_commission,
  COALESCE(SUM(CASE WHEN d.tenant_agent_user_id = u.id THEN d.tenant_agent_fee ELSE 0 END), 0) AS tenant_commission,
  COALESCE(SUM(
    CASE WHEN d.owner_agent_user_id  = u.id THEN d.owner_agent_fee  ELSE 0 END +
    CASE WHEN d.tenant_agent_user_id = u.id THEN d.tenant_agent_fee ELSE 0 END
  ), 0) AS total_commission
FROM users u
LEFT JOIN deals d ON (d.owner_agent_user_id = u.id OR d.tenant_agent_user_id = u.id)
WHERE u.role = 'agent' AND u.is_active = true
GROUP BY u.id, u.name, u.base_salary, TO_CHAR(d.contract_date, 'YYYY-MM');

-- 월별 P&L (CTE 방식 - 서브쿼리 오류 수정)
CREATE OR REPLACE VIEW v_monthly_pl AS
WITH deal_summary AS (
  SELECT
    TO_CHAR(contract_date, 'YYYY-MM') AS period,
    SUM(gross_commission)   AS gross_income,
    SUM(total_agent_fees)   AS agent_payouts,
    SUM(net_company_income) AS net_from_deals,
    COUNT(*)                AS deal_count
  FROM deals
  GROUP BY TO_CHAR(contract_date, 'YYYY-MM')
),
expense_summary AS (
  SELECT period, SUM(amount) AS total_expenses
  FROM expenses
  GROUP BY period
)
SELECT
  ds.period,
  ds.gross_income,
  ds.agent_payouts,
  ds.net_from_deals,
  ds.deal_count,
  COALESCE(es.total_expenses, 0)                     AS total_expenses,
  ds.net_from_deals - COALESCE(es.total_expenses, 0) AS operating_profit
FROM deal_summary ds
LEFT JOIN expense_summary es ON ds.period = es.period
ORDER BY ds.period DESC;

-- 팔로업 필요 리드
CREATE OR REPLACE VIEW v_leads_followup AS
SELECT
  l.*,
  c.name   AS contact_name,
  c.mobile AS contact_mobile,
  u.name   AS agent_name
FROM leads l
LEFT JOIN contacts c ON l.contact_id       = c.id
LEFT JOIN users    u ON l.assigned_user_id = u.id
WHERE l.status NOT IN ('CLOSED_WON','CLOSED_LOST')
  AND l.next_followup_at <= CURRENT_DATE
ORDER BY l.next_followup_at ASC;

-- ───────────────────────────────────────
-- 인덱스
-- ───────────────────────────────────────
CREATE INDEX idx_contacts_type    ON contacts(type);
CREATE INDEX idx_contacts_agent   ON contacts(assigned_user_id);
CREATE INDEX idx_listings_status  ON listings(status);
CREATE INDEX idx_listings_type    ON listings(transaction_type);
CREATE INDEX idx_leads_status     ON leads(status);
CREATE INDEX idx_leads_followup   ON leads(next_followup_at);
CREATE INDEX idx_deals_date       ON deals(contract_date);
CREATE INDEX idx_expenses_period  ON expenses(period);
CREATE INDEX idx_activities_contact ON activities(contact_id);

-- ───────────────────────────────────────
-- 초기 직원 데이터
-- ───────────────────────────────────────
INSERT INTO users (name, email, password_hash, role, work_mode, base_salary) VALUES
('Park Yongsik', 'admin@rbshomes.ph', '$2b$10$placeholder_hash_admin', 'admin', 'full-time',  0),
('May Vecino',   'may@rbshomes.ph',   '$2b$10$placeholder_hash_may',   'agent', 'full-time', 25000),
('Raissa Gomez', 'rai@rbshomes.ph',   '$2b$10$placeholder_hash_rai',   'agent', 'hybrid',    18000),
('Grace',        'grace@rbshomes.ph', '$2b$10$placeholder_hash_grace', 'agent', 'full-time', 25000);
