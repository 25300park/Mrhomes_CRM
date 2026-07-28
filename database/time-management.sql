-- MrHOMES CRM time-management schema.
-- Apply only after the existing CRM users/contacts/listings/leads/deals tables exist.

BEGIN;
SET LOCAL search_path = public, pg_temp;

-- PostgreSQL 13 introduced gen_random_uuid() as a core UUID function in
-- pg_catalog. Supabase-supported PostgreSQL versions satisfy this contract.
DO $$
BEGIN
  IF current_setting('server_version_num')::INTEGER < 130000 THEN
    RAISE EXCEPTION 'PostgreSQL 13 or newer is required';
  END IF;
  IF pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL THEN
    RAISE EXCEPTION 'pg_catalog.gen_random_uuid() is required';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS time_standard_categories (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_focus BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS time_personal_categories (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_standard_category_id UUID NOT NULL REFERENCES time_standard_categories(id),
  name VARCHAR(100) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, parent_standard_category_id),
  UNIQUE (id, user_id, parent_standard_category_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS time_personal_categories_user_name_uq
  ON time_personal_categories (user_id, lower(name));

CREATE TABLE IF NOT EXISTS time_daily_plans (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  available_minutes INTEGER NOT NULL CHECK (available_minutes >= 0),
  is_completed BOOLEAN NOT NULL DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_date),
  UNIQUE (id, user_id),
  UNIQUE (id, user_id, business_date),
  CONSTRAINT time_daily_plans_completion_ck CHECK (is_completed = (completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS time_plan_allocations (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  daily_plan_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  standard_category_id UUID NOT NULL REFERENCES time_standard_categories(id),
  personal_category_id UUID,
  planned_minutes INTEGER NOT NULL CHECK (planned_minutes >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_plan_allocations_plan_owner_fk
    FOREIGN KEY (daily_plan_id, user_id)
    REFERENCES time_daily_plans(id, user_id) ON DELETE CASCADE,
  CONSTRAINT time_plan_allocations_personal_owner_fk
    FOREIGN KEY (personal_category_id, user_id, standard_category_id)
    REFERENCES time_personal_categories(id, user_id, parent_standard_category_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS time_plan_allocations_standard_uq
  ON time_plan_allocations (daily_plan_id, standard_category_id)
  WHERE personal_category_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS time_plan_allocations_personal_uq
  ON time_plan_allocations (daily_plan_id, personal_category_id)
  WHERE personal_category_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS time_entries (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  daily_plan_id UUID,
  standard_category_id UUID NOT NULL REFERENCES time_standard_categories(id),
  personal_category_id UUID,
  entry_type VARCHAR(20) NOT NULL CHECK (entry_type IN ('TIMER', 'MANUAL')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,
  notes TEXT,
  request_id TEXT,
  previous_entry_id UUID,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
  linked_entity_type VARCHAR(20) CHECK (linked_entity_type IN ('CONTACT', 'LISTING', 'LEAD', 'DEAL')),
  linked_entity_id UUID,
  linked_entity_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  CONSTRAINT time_entries_plan_owner_date_fk
    FOREIGN KEY (daily_plan_id, user_id, business_date)
    REFERENCES time_daily_plans(id, user_id, business_date),
  FOREIGN KEY (personal_category_id, user_id, standard_category_id)
    REFERENCES time_personal_categories(id, user_id, parent_standard_category_id),
  FOREIGN KEY (previous_entry_id, user_id) REFERENCES time_entries(id, user_id),
  CONSTRAINT time_entries_end_after_start_ck CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT time_entries_duration_nonnegative_ck CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  CONSTRAINT time_entries_type_state_ck CHECK (
    (entry_type = 'MANUAL' AND ended_at IS NOT NULL AND duration_seconds IS NOT NULL)
    OR (entry_type = 'TIMER' AND (
      (ended_at IS NULL AND duration_seconds IS NULL)
      OR (ended_at IS NOT NULL AND duration_seconds IS NOT NULL)
    ))
  ),
  CHECK (request_id IS NULL OR btrim(request_id) <> ''),
  CONSTRAINT time_entries_single_crm_link_ck
    CHECK (num_nonnulls(contact_id, listing_id, lead_id, deal_id) <= 1),
  CONSTRAINT time_entries_crm_snapshot_pair_ck CHECK (
    (linked_entity_type IS NULL AND linked_entity_id IS NULL)
    OR (linked_entity_type IS NOT NULL AND linked_entity_id IS NOT NULL)
  ),
  CONSTRAINT time_entries_crm_snapshot_ck CHECK (
    (
      num_nonnulls(contact_id, listing_id, lead_id, deal_id) = 0
      AND linked_entity_type IS NULL
      AND linked_entity_id IS NULL
      AND linked_entity_label IS NULL
    )
    OR (
      num_nonnulls(contact_id, listing_id, lead_id, deal_id) = 1
      AND
      linked_entity_id = COALESCE(contact_id, listing_id, lead_id, deal_id)
      AND linked_entity_label IS NOT NULL
      AND btrim(linked_entity_label) <> ''
      AND linked_entity_type = CASE
        WHEN contact_id IS NOT NULL THEN 'CONTACT'
        WHEN listing_id IS NOT NULL THEN 'LISTING'
        WHEN lead_id IS NOT NULL THEN 'LEAD'
        WHEN deal_id IS NOT NULL THEN 'DEAL'
      END
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS time_entries_active_user_uq
  ON time_entries (user_id)
  WHERE entry_type = 'TIMER' AND ended_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS time_entries_request_uq
  ON time_entries (user_id, request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS time_entries_user_started_idx
  ON time_entries (user_id, started_at DESC);

CREATE INDEX IF NOT EXISTS time_entries_user_business_date_idx
  ON time_entries (user_id, business_date, started_at DESC);

CREATE TABLE IF NOT EXISTS time_commands (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL CHECK (btrim(request_id) <> ''),
  command_type VARCHAR(10) NOT NULL CHECK (command_type IN ('START', 'SWITCH', 'STOP')),
  request_payload JSONB NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  response_payload JSONB NOT NULL CHECK (jsonb_typeof(response_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, request_id)
);

CREATE TABLE IF NOT EXISTS time_entry_revisions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  entry_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  changed_by UUID NOT NULL REFERENCES users(id),
  before_value JSONB NOT NULL,
  after_value JSONB NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (entry_id, user_id) REFERENCES time_entries(id, user_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS time_entry_revisions_entry_idx
  ON time_entry_revisions (entry_id, changed_at DESC);

CREATE TABLE IF NOT EXISTS time_reflections (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  reflection_text TEXT NOT NULL CHECK (btrim(reflection_text) <> ''),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_date),
  UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS time_ai_reviews (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reflection_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reflection_version INTEGER NOT NULL CHECK (reflection_version > 0),
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keywords) = 'array'),
  summary TEXT NOT NULL,
  wins JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(wins) = 'array'),
  blockers JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(blockers) = 'array'),
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(next_actions) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (reflection_id, user_id) REFERENCES time_reflections(id, user_id) ON DELETE CASCADE,
  UNIQUE (reflection_id, reflection_version)
);

CREATE TABLE IF NOT EXISTS time_daily_metrics (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_date DATE NOT NULL,
  planned_minutes INTEGER NOT NULL DEFAULT 0 CHECK (planned_minutes >= 0),
  tracked_minutes INTEGER NOT NULL DEFAULT 0 CHECK (tracked_minutes >= 0),
  completed_entry_count INTEGER NOT NULL DEFAULT 0 CHECK (completed_entry_count >= 0),
  focus_ratio NUMERIC(6,5) CHECK (focus_ratio >= 0 AND focus_ratio <= 1),
  category_minutes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(category_minutes) = 'object'),
  calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, business_date)
);

CREATE TABLE IF NOT EXISTS time_team_keyword_aggregates (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  keyword TEXT NOT NULL CHECK (btrim(keyword) <> ''),
  contributor_count INTEGER NOT NULL CHECK (contributor_count >= 3),
  occurrence_count INTEGER NOT NULL CHECK (occurrence_count >= contributor_count),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  UNIQUE (period_start, period_end, keyword)
);

CREATE TABLE IF NOT EXISTS time_reminder_preferences (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_time_zone TEXT NOT NULL DEFAULT 'Asia/Seoul'
    CONSTRAINT time_reminder_preferences_zone_ck CHECK (business_time_zone = 'Asia/Seoul'),
  work_end_time TIME NOT NULL DEFAULT '18:00',
  reminder_time TIME,
  in_app_enabled BOOLEAN NOT NULL DEFAULT true,
  push_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE IF NOT EXISTS time_push_subscriptions (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth_secret TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_error_code VARCHAR(30),
  ownership_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (endpoint)
);

CREATE TABLE IF NOT EXISTS time_jobs (
  id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  job_type VARCHAR(30) NOT NULL CHECK (job_type IN ('AI_REVIEW', 'DAILY_METRICS', 'TEAM_KEYWORDS', 'REMINDER_PUSH')),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED')),
  dedupe_key TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  result JSONB,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  ready_at TIMESTAMPTZ DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  lease_until TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error_code VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT time_jobs_attempts_ck CHECK (attempts <= max_attempts),
  CONSTRAINT time_jobs_worker_nonblank_ck CHECK (locked_by IS NULL OR btrim(locked_by) <> ''),
  CONSTRAINT time_jobs_state_fields_ck CHECK (
    (status = 'PENDING' AND ready_at IS NOT NULL AND locked_at IS NULL
      AND locked_by IS NULL AND lease_until IS NULL AND completed_at IS NULL)
    OR (status = 'PROCESSING' AND ready_at IS NULL AND locked_at IS NOT NULL
      AND locked_by IS NOT NULL AND lease_until IS NOT NULL AND completed_at IS NULL)
    OR (status = 'FAILED' AND locked_at IS NULL AND locked_by IS NULL
      AND lease_until IS NULL AND completed_at IS NULL
      AND ((attempts < max_attempts AND ready_at IS NOT NULL)
        OR (attempts = max_attempts AND ready_at IS NULL)))
    OR (status = 'COMPLETED' AND ready_at IS NULL AND locked_at IS NULL
      AND locked_by IS NULL AND lease_until IS NULL AND completed_at IS NOT NULL)
  ),
  UNIQUE (job_type, dedupe_key)
);

CREATE INDEX IF NOT EXISTS time_jobs_ready_idx
  ON time_jobs (ready_at, created_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX IF NOT EXISTS time_jobs_stale_lease_idx
  ON time_jobs (lease_until)
  WHERE status = 'PROCESSING';

-- The browser must never query these tables through Supabase. No RLS policy is
-- created; only the Supabase service_role (used by Express) receives grants.
ALTER TABLE time_standard_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_standard_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE time_personal_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_personal_categories FORCE ROW LEVEL SECURITY;
ALTER TABLE time_daily_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_daily_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE time_plan_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_plan_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE time_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE time_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_commands FORCE ROW LEVEL SECURITY;
ALTER TABLE time_entry_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_entry_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE time_reflections ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_reflections FORCE ROW LEVEL SECURITY;
ALTER TABLE time_ai_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_ai_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE time_daily_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_daily_metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE time_team_keyword_aggregates ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_team_keyword_aggregates FORCE ROW LEVEL SECURITY;
ALTER TABLE time_reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_reminder_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE time_push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_push_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE time_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE time_jobs FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  time_standard_categories,
  time_personal_categories,
  time_daily_plans,
  time_plan_allocations,
  time_entries,
  time_commands,
  time_entry_revisions,
  time_reflections,
  time_ai_reviews,
  time_daily_metrics,
  time_team_keyword_aggregates,
  time_reminder_preferences,
  time_push_subscriptions,
  time_jobs
FROM PUBLIC;

DO $$
DECLARE
  v_tables CONSTANT TEXT :=
    'time_standard_categories, time_personal_categories, time_daily_plans, '
    'time_plan_allocations, time_entries, time_commands, time_entry_revisions, '
    'time_reflections, time_ai_reviews, time_daily_metrics, '
    'time_team_keyword_aggregates, time_reminder_preferences, '
    'time_push_subscriptions, time_jobs';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON TABLE ' || v_tables || ' FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON TABLE ' || v_tables || ' FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ' || v_tables || ' TO service_role';
  END IF;
END;
$$;

COMMIT;
