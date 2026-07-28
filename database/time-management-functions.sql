-- Atomic time-management commands and queue leasing.
-- All data references are schema-qualified and no argument reaches dynamic SQL.

BEGIN;
SET LOCAL search_path = public, pg_temp;

CREATE OR REPLACE FUNCTION public.time_apply_timer_command(
  p_user_id UUID,
  p_request_id TEXT,
  p_command_type TEXT,
  p_standard_category_id UUID,
  p_personal_category_id UUID,
  p_daily_plan_id UUID,
  p_contact_id UUID,
  p_listing_id UUID,
  p_lead_id UUID,
  p_deal_id UUID,
  p_linked_entity_label TEXT,
  p_command_at TIMESTAMPTZ,
  p_business_time_zone TEXT
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active_entry_id UUID;
  v_active_started_at TIMESTAMPTZ;
  v_business_date DATE;
  v_linked_entity_type VARCHAR(20);
  v_linked_entity_id UUID;
  v_request JSONB;
  v_response JSONB;
  v_existing_type TEXT;
  v_existing_request JSONB;
  v_existing_response JSONB;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'request_id is required';
  END IF;
  IF p_command_type NOT IN ('START', 'SWITCH', 'STOP') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported timer command';
  END IF;
  IF p_command_at IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'command timestamp is required';
  END IF;
  IF p_business_time_zone IS DISTINCT FROM 'Asia/Seoul' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported business time zone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_user_id AND is_active = true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active user not found';
  END IF;

  v_business_date := (p_command_at AT TIME ZONE p_business_time_zone)::DATE;
  v_request := pg_catalog.jsonb_build_object(
    'commandType', p_command_type,
    'standardCategoryId', p_standard_category_id,
    'personalCategoryId', p_personal_category_id,
    'dailyPlanId', p_daily_plan_id,
    'contactId', p_contact_id,
    'listingId', p_listing_id,
    'leadId', p_lead_id,
    'dealId', p_deal_id,
    'linkedEntityLabel', p_linked_entity_label,
    'commandAt', p_command_at,
    'businessTimeZone', p_business_time_zone
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::TEXT, 0));

  SELECT command_type, request_payload, response_payload
    INTO v_existing_type, v_existing_request, v_existing_response
  FROM public.time_commands
  WHERE user_id = p_user_id AND request_id = p_request_id;

  IF FOUND THEN
    IF v_existing_type <> p_command_type OR v_existing_request <> v_request THEN
      RAISE EXCEPTION USING
        ERRCODE = '23505',
        MESSAGE = 'request_id was already used with different command data',
        CONSTRAINT = 'time_commands_user_id_request_id_key';
    END IF;
    stopped_entry_id := NULLIF(v_existing_response ->> 'stoppedEntryId', '')::UUID;
    started_entry_id := NULLIF(v_existing_response ->> 'startedEntryId', '')::UUID;
    replayed := true;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT id, started_at
    INTO v_active_entry_id, v_active_started_at
  FROM public.time_entries
  WHERE user_id = p_user_id AND entry_type = 'TIMER' AND ended_at IS NULL
  FOR UPDATE;

  IF p_command_type = 'START' AND v_active_entry_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'an active timer already exists',
      CONSTRAINT = 'time_entries_active_user_uq';
  END IF;
  IF p_command_type IN ('SWITCH', 'STOP') AND v_active_entry_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active timer not found';
  END IF;
  IF v_active_entry_id IS NOT NULL AND p_command_at < v_active_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = 'command time precedes active timer start';
  END IF;

  IF p_command_type IN ('START', 'SWITCH') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.time_standard_categories
      WHERE id = p_standard_category_id AND is_active = true
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
    END IF;
    IF p_personal_category_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.time_personal_categories
      WHERE id = p_personal_category_id
        AND user_id = p_user_id
        AND parent_standard_category_id = p_standard_category_id
        AND is_active = true
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user';
    END IF;
    IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) > 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'only one CRM entity may be linked',
        CONSTRAINT = 'time_entries_single_crm_link_ck';
    END IF;
    IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) = 1
      AND (p_linked_entity_label IS NULL OR pg_catalog.btrim(p_linked_entity_label) = '') THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514', MESSAGE = 'CRM link snapshot label is required',
        CONSTRAINT = 'time_entries_crm_snapshot_ck';
    END IF;
  END IF;

  IF p_command_type IN ('SWITCH', 'STOP') THEN
    UPDATE public.time_entries
    SET ended_at = p_command_at,
        duration_seconds = pg_catalog.floor(
          EXTRACT(epoch FROM (p_command_at - started_at))
        )::INTEGER,
        updated_at = pg_catalog.now()
    WHERE id = v_active_entry_id AND user_id = p_user_id;
    stopped_entry_id := v_active_entry_id;
  END IF;

  IF p_command_type IN ('START', 'SWITCH') THEN
    v_linked_entity_type := CASE
      WHEN p_contact_id IS NOT NULL THEN 'CONTACT'
      WHEN p_listing_id IS NOT NULL THEN 'LISTING'
      WHEN p_lead_id IS NOT NULL THEN 'LEAD'
      WHEN p_deal_id IS NOT NULL THEN 'DEAL'
      ELSE NULL
    END;
    v_linked_entity_id := COALESCE(
      p_contact_id, p_listing_id, p_lead_id, p_deal_id
    );

    INSERT INTO public.time_entries (
      user_id, business_date, daily_plan_id, standard_category_id,
      personal_category_id, entry_type, started_at, request_id,
      previous_entry_id, contact_id, listing_id, lead_id, deal_id,
      linked_entity_type, linked_entity_id, linked_entity_label
    ) VALUES (
      p_user_id, v_business_date, p_daily_plan_id, p_standard_category_id,
      p_personal_category_id, 'TIMER', p_command_at, p_request_id,
      v_active_entry_id, p_contact_id, p_listing_id, p_lead_id, p_deal_id,
      v_linked_entity_type, v_linked_entity_id, p_linked_entity_label
    )
    RETURNING id INTO started_entry_id;
  END IF;

  replayed := false;
  v_response := pg_catalog.jsonb_build_object(
    'stoppedEntryId', stopped_entry_id,
    'startedEntryId', started_entry_id
  );
  INSERT INTO public.time_commands (
    user_id, request_id, command_type, request_payload, response_payload
  ) VALUES (
    p_user_id, p_request_id, p_command_type, v_request, v_response
  );
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_start_timer(
  p_user_id UUID,
  p_request_id TEXT,
  p_standard_category_id UUID,
  p_personal_category_id UUID DEFAULT NULL,
  p_daily_plan_id UUID DEFAULT NULL,
  p_contact_id UUID DEFAULT NULL,
  p_listing_id UUID DEFAULT NULL,
  p_lead_id UUID DEFAULT NULL,
  p_deal_id UUID DEFAULT NULL,
  p_linked_entity_label TEXT DEFAULT NULL,
  p_started_at TIMESTAMPTZ DEFAULT pg_catalog.now(),
  p_business_time_zone TEXT DEFAULT 'Asia/Seoul'
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'START', p_standard_category_id,
    p_personal_category_id, p_daily_plan_id, p_contact_id, p_listing_id,
    p_lead_id, p_deal_id, p_linked_entity_label, p_started_at,
    p_business_time_zone
  );
$$;

CREATE OR REPLACE FUNCTION public.time_switch_timer(
  p_user_id UUID,
  p_request_id TEXT,
  p_standard_category_id UUID,
  p_personal_category_id UUID DEFAULT NULL,
  p_daily_plan_id UUID DEFAULT NULL,
  p_contact_id UUID DEFAULT NULL,
  p_listing_id UUID DEFAULT NULL,
  p_lead_id UUID DEFAULT NULL,
  p_deal_id UUID DEFAULT NULL,
  p_linked_entity_label TEXT DEFAULT NULL,
  p_started_at TIMESTAMPTZ DEFAULT pg_catalog.now(),
  p_business_time_zone TEXT DEFAULT 'Asia/Seoul'
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'SWITCH', p_standard_category_id,
    p_personal_category_id, p_daily_plan_id, p_contact_id, p_listing_id,
    p_lead_id, p_deal_id, p_linked_entity_label, p_started_at,
    p_business_time_zone
  );
$$;

CREATE OR REPLACE FUNCTION public.time_stop_timer(
  p_user_id UUID,
  p_request_id TEXT,
  p_stopped_at TIMESTAMPTZ DEFAULT pg_catalog.now(),
  p_business_time_zone TEXT DEFAULT 'Asia/Seoul'
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'STOP', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, p_stopped_at, p_business_time_zone
  );
$$;

CREATE OR REPLACE FUNCTION public.time_prevent_entry_business_date_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.business_date IS DISTINCT FROM OLD.business_date THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514', MESSAGE = 'business_date is immutable',
      CONSTRAINT = 'time_entries_business_date_immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_entries_business_date_immutable_trg
  ON public.time_entries;
CREATE TRIGGER time_entries_business_date_immutable_trg
  BEFORE UPDATE OF business_date ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.time_prevent_entry_business_date_update();

CREATE OR REPLACE FUNCTION public.time_track_push_owner_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    NEW.ownership_changed_at := pg_catalog.now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_push_subscription_owner_change_trg
  ON public.time_push_subscriptions;
CREATE TRIGGER time_push_subscription_owner_change_trg
  BEFORE UPDATE OF user_id ON public.time_push_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.time_track_push_owner_change();

CREATE OR REPLACE FUNCTION public.time_claim_jobs(
  p_limit INTEGER DEFAULT 10,
  p_worker_id TEXT DEFAULT NULL,
  p_lease_seconds INTEGER DEFAULT 60
)
RETURNS SETOF public.time_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'worker_id is required';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 15 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'lease_seconds must be between 15 and 900';
  END IF;

  -- A crashed final attempt cannot be reclaimed, so close its stale lease.
  UPDATE public.time_jobs
  SET status = 'FAILED',
      ready_at = NULL,
      locked_at = NULL,
      locked_by = NULL,
      lease_until = NULL,
      updated_at = pg_catalog.now()
  WHERE status = 'PROCESSING'
    AND lease_until <= pg_catalog.now()
    AND attempts >= max_attempts;

  RETURN QUERY
  WITH ready AS (
    SELECT id
    FROM public.time_jobs
    WHERE attempts < max_attempts
      AND (
        (status IN ('PENDING', 'FAILED') AND ready_at <= pg_catalog.now())
        OR (status = 'PROCESSING' AND lease_until <= pg_catalog.now())
      )
    ORDER BY COALESCE(ready_at, lease_until), created_at, id
    FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100)
  )
  UPDATE public.time_jobs AS jobs
  SET status = 'PROCESSING',
      attempts = jobs.attempts + 1,
      ready_at = NULL,
      locked_at = pg_catalog.now(),
      locked_by = pg_catalog.btrim(p_worker_id),
      lease_until = pg_catalog.now() + pg_catalog.make_interval(secs => p_lease_seconds),
      completed_at = NULL,
      updated_at = pg_catalog.now()
  FROM ready
  WHERE jobs.id = ready.id
  RETURNING jobs.*;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_fail_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_error_code TEXT
)
RETURNS public.time_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job public.time_jobs;
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'worker_id is required';
  END IF;
  UPDATE public.time_jobs
  SET status = 'FAILED',
      ready_at = CASE
        WHEN attempts >= max_attempts THEN NULL
        WHEN attempts = 1 THEN pg_catalog.now() + INTERVAL '1 minute'
        WHEN attempts = 2 THEN pg_catalog.now() + INTERVAL '5 minutes'
        ELSE pg_catalog.now() + INTERVAL '30 minutes'
      END,
      locked_at = NULL,
      locked_by = NULL,
      lease_until = NULL,
      last_error_code = pg_catalog.left(COALESCE(p_error_code, 'UNKNOWN'), 100),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id
    AND status = 'PROCESSING'
    AND locked_by = pg_catalog.btrim(p_worker_id)
    AND lease_until > pg_catalog.now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'job lease is not owned by worker';
  END IF;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_complete_job(
  p_job_id UUID,
  p_worker_id TEXT,
  p_result JSONB DEFAULT NULL
)
RETURNS public.time_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_job public.time_jobs;
BEGIN
  IF p_worker_id IS NULL OR pg_catalog.btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'worker_id is required';
  END IF;
  UPDATE public.time_jobs
  SET status = 'COMPLETED',
      result = p_result,
      ready_at = NULL,
      locked_at = NULL,
      locked_by = NULL,
      lease_until = NULL,
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id
    AND status = 'PROCESSING'
    AND locked_by = pg_catalog.btrim(p_worker_id)
    AND lease_until > pg_catalog.now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'job lease is not owned by worker';
  END IF;
  RETURN v_job;
END;
$$;

REVOKE ALL ON FUNCTION public.time_apply_timer_command(
  UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_start_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_switch_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_stop_timer(UUID, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_prevent_entry_business_date_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_track_push_owner_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_claim_jobs(INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_fail_job(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_complete_job(UUID, TEXT, JSONB) FROM PUBLIC;

DO $$
DECLARE
  v_functions CONSTANT TEXT :=
    'public.time_start_timer(UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_switch_timer(UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_stop_timer(UUID, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_claim_jobs(INTEGER, TEXT, INTEGER), '
    'public.time_fail_job(UUID, TEXT, TEXT), '
    'public.time_complete_job(UUID, TEXT, JSONB)';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION ' || v_functions || ' FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION ' || v_functions || ' FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION ' || v_functions || ' TO service_role';
  END IF;
END;
$$;

COMMIT;
