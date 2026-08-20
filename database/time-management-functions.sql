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
  v_effective_command_at TIMESTAMPTZ;
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
  IF p_business_time_zone IS DISTINCT FROM 'Asia/Seoul' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported business time zone';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = p_user_id AND is_active = true
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active user not found';
  END IF;

  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
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
  ));

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

  v_effective_command_at := COALESCE(p_command_at, pg_catalog.now());
  v_business_date := (v_effective_command_at AT TIME ZONE p_business_time_zone)::DATE;

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
  IF v_active_entry_id IS NOT NULL AND v_effective_command_at < v_active_started_at THEN
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
    SET ended_at = v_effective_command_at,
        duration_seconds = pg_catalog.floor(
          EXTRACT(epoch FROM (v_effective_command_at - started_at))
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
      p_personal_category_id, 'TIMER', v_effective_command_at, p_request_id,
      v_active_entry_id, p_contact_id, p_listing_id, p_lead_id, p_deal_id,
      v_linked_entity_type, v_linked_entity_id, p_linked_entity_label
    )
    RETURNING id INTO started_entry_id;
  END IF;

  replayed := false;
  v_response := pg_catalog.jsonb_build_object(
    'stoppedEntryId', stopped_entry_id,
    'startedEntryId', started_entry_id,
    'effectiveCommandAt', v_effective_command_at
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
  p_started_at TIMESTAMPTZ DEFAULT NULL,
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
  p_started_at TIMESTAMPTZ DEFAULT NULL,
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
  p_stopped_at TIMESTAMPTZ DEFAULT NULL,
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
  p_business_time_zone TEXT,
  p_actor_role TEXT
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_active_entry_id UUID;
  v_active_started_at TIMESTAMPTZ;
  v_effective_command_at TIMESTAMPTZ;
  v_business_date DATE;
  v_request JSONB;
  v_existing_response JSONB;
  v_response JSONB;
  v_link_type TEXT;
  v_link_id UUID;
  v_label TEXT;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'request_id is required';
  END IF;
  IF p_command_type NOT IN ('START', 'SWITCH', 'STOP') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported timer command';
  END IF;
  IF p_business_time_zone IS DISTINCT FROM 'Asia/Seoul' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unsupported business time zone';
  END IF;
  IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only one CRM entity may be linked',
      CONSTRAINT = 'time_entries_single_crm_link_ck';
  END IF;
  v_link_type := CASE WHEN p_contact_id IS NOT NULL THEN 'CONTACT'
    WHEN p_listing_id IS NOT NULL THEN 'LISTING' WHEN p_lead_id IS NOT NULL THEN 'LEAD'
    WHEN p_deal_id IS NOT NULL THEN 'DEAL' END;
  v_link_id := COALESCE(p_contact_id, p_listing_id, p_lead_id, p_deal_id);
  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'standardCategoryId', p_standard_category_id,
    'personalCategoryId', p_personal_category_id,
    'dailyPlanId', p_daily_plan_id,
    'crmLink', CASE WHEN v_link_id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object('type', v_link_type, 'id', v_link_id) END,
    'commandAt', p_command_at,
    'businessTimeZone', p_business_time_zone
  ));

  SELECT replay.response_payload INTO v_existing_response
  FROM public.time_get_command_replay(p_user_id, p_request_id, p_command_type, v_request) replay;
  IF FOUND THEN
    stopped_entry_id := NULLIF(v_existing_response ->> 'stopped_entry_id', '')::UUID;
    started_entry_id := NULLIF(v_existing_response ->> 'started_entry_id', '')::UUID;
    replayed := true; RETURN NEXT; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users actor WHERE actor.id = p_user_id
    AND actor.is_active = true AND actor.role = p_actor_role AND actor.role IN ('admin', 'agent')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active actor not found';
  END IF;
  IF v_link_id IS NOT NULL THEN
    SELECT resolved.label INTO v_label
    FROM public.time_resolve_crm_link(p_user_id, p_actor_role, v_link_type, v_link_id) resolved;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'CRM link not found';
    END IF;
  END IF;

  v_effective_command_at := COALESCE(p_command_at, pg_catalog.now());
  v_business_date := (v_effective_command_at AT TIME ZONE p_business_time_zone)::DATE;

  SELECT entry.id, entry.started_at INTO v_active_entry_id, v_active_started_at
  FROM public.time_entries entry
  WHERE entry.user_id = p_user_id AND entry.entry_type = 'TIMER' AND entry.ended_at IS NULL
  FOR UPDATE;
  IF p_command_type = 'START' AND v_active_entry_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'an active timer already exists',
      CONSTRAINT = 'time_entries_active_user_uq';
  END IF;
  IF p_command_type IN ('SWITCH', 'STOP') AND v_active_entry_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active timer not found';
  END IF;
  IF v_active_entry_id IS NOT NULL AND v_effective_command_at < v_active_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22007', MESSAGE = 'command time precedes active timer start';
  END IF;

  IF p_command_type IN ('START', 'SWITCH') THEN
    IF NOT EXISTS (SELECT 1 FROM public.time_standard_categories category
      WHERE category.id = p_standard_category_id AND category.is_active = true) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
    END IF;
    IF p_personal_category_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.time_personal_categories category
      WHERE category.id = p_personal_category_id AND category.user_id = p_user_id
        AND category.parent_standard_category_id = p_standard_category_id AND category.is_active = true
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user';
    END IF;
    IF p_daily_plan_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.time_daily_plans plan WHERE plan.id = p_daily_plan_id
        AND plan.user_id = p_user_id AND plan.business_date = v_business_date
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'daily plan does not match owner and business date',
        CONSTRAINT = 'time_entries_plan_owner_date_fk';
    END IF;
  END IF;

  IF p_command_type IN ('SWITCH', 'STOP') THEN
    UPDATE public.time_entries SET
      ended_at = v_effective_command_at,
      duration_seconds = pg_catalog.floor(EXTRACT(epoch FROM (v_effective_command_at - started_at)))::INTEGER,
      updated_at = pg_catalog.now()
    WHERE id = v_active_entry_id AND user_id = p_user_id;
    stopped_entry_id := v_active_entry_id;
  END IF;

  IF p_command_type IN ('START', 'SWITCH') THEN
    INSERT INTO public.time_entries (
      user_id, business_date, daily_plan_id, standard_category_id, personal_category_id,
      entry_type, started_at, request_id, previous_entry_id,
      contact_id, listing_id, lead_id, deal_id,
      linked_entity_type, linked_entity_id, linked_entity_label
    ) VALUES (
      p_user_id, v_business_date, p_daily_plan_id, p_standard_category_id, p_personal_category_id,
      'TIMER', v_effective_command_at, p_request_id, v_active_entry_id,
      p_contact_id, p_listing_id, p_lead_id, p_deal_id,
      v_link_type, v_link_id, v_label
    ) RETURNING time_entries.id INTO started_entry_id;
  END IF;
  replayed := false;
  v_response := pg_catalog.jsonb_build_object(
    'stopped_entry_id', stopped_entry_id, 'started_entry_id', started_entry_id
  );
  INSERT INTO public.time_commands (user_id, request_id, command_type, request_payload, response_payload)
  VALUES (p_user_id, p_request_id, p_command_type, v_request, v_response);
  RETURN NEXT;
END;
$$;

DROP FUNCTION IF EXISTS public.time_start_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT
);
CREATE OR REPLACE FUNCTION public.time_start_timer(
  p_user_id UUID, p_actor_role TEXT, p_request_id TEXT, p_standard_category_id UUID,
  p_personal_category_id UUID DEFAULT NULL, p_daily_plan_id UUID DEFAULT NULL,
  p_contact_id UUID DEFAULT NULL, p_listing_id UUID DEFAULT NULL,
  p_lead_id UUID DEFAULT NULL, p_deal_id UUID DEFAULT NULL,
  p_linked_entity_label TEXT DEFAULT NULL, p_started_at TIMESTAMPTZ DEFAULT NULL,
  p_business_time_zone TEXT DEFAULT 'Asia/Seoul'
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'START', p_standard_category_id,
    p_personal_category_id, p_daily_plan_id, p_contact_id, p_listing_id,
    p_lead_id, p_deal_id, p_linked_entity_label, p_started_at,
    p_business_time_zone, p_actor_role
  );
$$;

DROP FUNCTION IF EXISTS public.time_switch_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT
);
CREATE OR REPLACE FUNCTION public.time_switch_timer(
  p_user_id UUID, p_actor_role TEXT, p_request_id TEXT, p_standard_category_id UUID,
  p_personal_category_id UUID DEFAULT NULL, p_daily_plan_id UUID DEFAULT NULL,
  p_contact_id UUID DEFAULT NULL, p_listing_id UUID DEFAULT NULL,
  p_lead_id UUID DEFAULT NULL, p_deal_id UUID DEFAULT NULL,
  p_linked_entity_label TEXT DEFAULT NULL, p_started_at TIMESTAMPTZ DEFAULT NULL,
  p_business_time_zone TEXT DEFAULT 'Asia/Seoul'
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'SWITCH', p_standard_category_id,
    p_personal_category_id, p_daily_plan_id, p_contact_id, p_listing_id,
    p_lead_id, p_deal_id, p_linked_entity_label, p_started_at,
    p_business_time_zone, p_actor_role
  );
$$;

DROP FUNCTION IF EXISTS public.time_stop_timer(UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT);
CREATE OR REPLACE FUNCTION public.time_stop_timer(
  p_user_id UUID, p_actor_role TEXT, p_request_id TEXT,
  p_stopped_at TIMESTAMPTZ, p_business_time_zone TEXT
)
RETURNS TABLE (stopped_entry_id UUID, started_entry_id UUID, replayed BOOLEAN)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp
AS $$
  SELECT * FROM public.time_apply_timer_command(
    p_user_id, p_request_id, 'STOP', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, p_stopped_at, p_business_time_zone,
    p_actor_role
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
      lease_token = NULL,
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
      lease_token = pg_catalog.gen_random_uuid(),
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
  p_lease_token UUID,
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
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'lease_token is required';
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
      lease_token = NULL,
      last_error_code = pg_catalog.left(COALESCE(p_error_code, 'UNKNOWN'), 100),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id
    AND status = 'PROCESSING'
    AND locked_by = pg_catalog.btrim(p_worker_id)
    AND lease_token = p_lease_token
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
  p_lease_token UUID,
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
  IF p_lease_token IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'lease_token is required';
  END IF;
  UPDATE public.time_jobs
  SET status = 'COMPLETED',
      result = p_result,
      ready_at = NULL,
      locked_at = NULL,
      locked_by = NULL,
      lease_until = NULL,
      lease_token = NULL,
      completed_at = pg_catalog.now(),
      updated_at = pg_catalog.now()
  WHERE id = p_job_id
    AND status = 'PROCESSING'
    AND locked_by = pg_catalog.btrim(p_worker_id)
    AND lease_token = p_lease_token
    AND lease_until > pg_catalog.now()
  RETURNING * INTO v_job;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'job lease is not owned by worker';
  END IF;
  RETURN v_job;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_save_daily_plan(
  p_user_id UUID,
  p_business_date DATE,
  p_available_minutes INTEGER,
  p_allocations JSONB
)
RETURNS TABLE (
  id UUID, user_id UUID, business_date DATE,
  available_minutes INTEGER, allocation_total INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_plan_id UUID;
  v_allocation JSONB;
  v_standard_id UUID;
  v_personal_id UUID;
  v_minutes INTEGER;
BEGIN
  IF p_business_date IS NULL OR p_available_minutes < 0 OR p_available_minutes > 1440
    OR p_allocations IS NULL OR pg_catalog.jsonb_typeof(p_allocations) <> 'array' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid daily plan';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE users.id = p_user_id AND users.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active user not found';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::TEXT || ':' || p_business_date::TEXT, 0));

  FOR v_allocation IN SELECT value FROM pg_catalog.jsonb_array_elements(p_allocations)
  LOOP
    v_standard_id := (v_allocation ->> 'standardCategoryId')::UUID;
    v_personal_id := NULLIF(v_allocation ->> 'personalCategoryId', '')::UUID;
    v_minutes := (v_allocation ->> 'plannedMinutes')::INTEGER;
    IF v_standard_id IS NULL OR v_minutes IS NULL OR v_minutes < 0 OR v_minutes > 1440
      OR NOT EXISTS (SELECT 1 FROM public.time_standard_categories category WHERE category.id = v_standard_id AND category.is_active = true) THEN
      RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
    END IF;
    IF v_personal_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.time_personal_categories category
      WHERE category.id = v_personal_id AND category.user_id = p_user_id
        AND category.parent_standard_category_id = v_standard_id AND category.is_active = true
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user';
    END IF;
  END LOOP;

  INSERT INTO public.time_daily_plans (user_id, business_date, available_minutes, updated_at)
  VALUES (p_user_id, p_business_date, p_available_minutes, pg_catalog.now())
  ON CONFLICT ON CONSTRAINT time_daily_plans_user_id_business_date_key DO UPDATE
    SET available_minutes = EXCLUDED.available_minutes, updated_at = pg_catalog.now()
  RETURNING time_daily_plans.id INTO v_plan_id;

  DELETE FROM public.time_plan_allocations allocation
  WHERE allocation.daily_plan_id = v_plan_id AND allocation.user_id = p_user_id;

  FOR v_allocation IN SELECT value FROM pg_catalog.jsonb_array_elements(p_allocations)
  LOOP
    INSERT INTO public.time_plan_allocations (
      daily_plan_id, user_id, standard_category_id, personal_category_id, planned_minutes
    ) VALUES (
      v_plan_id, p_user_id,
      (v_allocation ->> 'standardCategoryId')::UUID,
      NULLIF(v_allocation ->> 'personalCategoryId', '')::UUID,
      (v_allocation ->> 'plannedMinutes')::INTEGER
    );
  END LOOP;

  RETURN QUERY SELECT plan.id, plan.user_id, plan.business_date, plan.available_minutes,
    COALESCE((SELECT pg_catalog.sum(allocation.planned_minutes)::INTEGER
      FROM public.time_plan_allocations allocation WHERE allocation.daily_plan_id = plan.id), 0)
  FROM public.time_daily_plans plan WHERE plan.id = v_plan_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_crm_actor_can(
  p_actor_user_id UUID,
  p_actor_role TEXT,
  p_action TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT p_action = 'LINK_READ'
    AND EXISTS (
      SELECT 1 FROM public.users actor
      WHERE actor.id = p_actor_user_id
        AND actor.is_active = true
        AND actor.role = p_actor_role
        AND actor.role IN ('admin', 'agent')
    );
$$;

CREATE OR REPLACE FUNCTION public.time_get_command_replay(
  p_user_id UUID,
  p_request_id TEXT,
  p_command_type TEXT,
  p_request_payload JSONB
)
RETURNS TABLE (response_payload JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_existing_type TEXT;
  v_existing_request JSONB;
  v_incoming_request JSONB;
  v_key TEXT;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = ''
    OR p_command_type NOT IN ('START', 'SWITCH', 'STOP', 'MANUAL', 'REVISE')
    OR p_request_payload IS NULL
    OR pg_catalog.jsonb_typeof(p_request_payload) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid command replay request';
  END IF;

  v_incoming_request := pg_catalog.jsonb_strip_nulls(p_request_payload) - 'linkedEntityLabel';
  FOREACH v_key IN ARRAY ARRAY['commandAt', 'startedAt', 'endedAt']
  LOOP
    IF v_incoming_request ? v_key THEN
      v_incoming_request := pg_catalog.jsonb_set(
        v_incoming_request, ARRAY[v_key],
        pg_catalog.to_jsonb((v_incoming_request ->> v_key)::TIMESTAMPTZ)
      );
    END IF;
  END LOOP;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::TEXT, 0));
  SELECT command.command_type, command.request_payload, command.response_payload
    INTO v_existing_type, v_existing_request, response_payload
  FROM public.time_commands command
  WHERE command.user_id = p_user_id AND command.request_id = p_request_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_existing_request := pg_catalog.jsonb_strip_nulls(v_existing_request) - 'linkedEntityLabel';
  FOREACH v_key IN ARRAY ARRAY['commandAt', 'startedAt', 'endedAt']
  LOOP
    IF v_existing_request ? v_key THEN
      v_existing_request := pg_catalog.jsonb_set(
        v_existing_request, ARRAY[v_key],
        pg_catalog.to_jsonb((v_existing_request ->> v_key)::TIMESTAMPTZ)
      );
    END IF;
  END LOOP;

  IF v_existing_type <> p_command_type OR v_existing_request <> v_incoming_request THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505', MESSAGE = 'request_id was already used with different command data',
      CONSTRAINT = 'time_commands_user_id_request_id_key';
  END IF;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_resolve_crm_link(p_type TEXT, p_id UUID)
RETURNS TABLE (id UUID, type TEXT, label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT contact.id, 'CONTACT'::TEXT, contact.name::TEXT
  FROM public.contacts contact WHERE pg_catalog.upper(p_type) = 'CONTACT' AND contact.id = p_id
  UNION ALL
  SELECT listing.id, 'LISTING'::TEXT, listing.name::TEXT
  FROM public.listings listing WHERE pg_catalog.upper(p_type) = 'LISTING' AND listing.id = p_id
  UNION ALL
  SELECT lead.id, 'LEAD'::TEXT, contact.name::TEXT
  FROM public.leads lead JOIN public.contacts contact ON contact.id = lead.contact_id
  WHERE pg_catalog.upper(p_type) = 'LEAD' AND lead.id = p_id
  UNION ALL
  SELECT deal.id, 'DEAL'::TEXT, listing.name::TEXT || ' ??' || deal.contract_date::TEXT
  FROM public.deals deal JOIN public.listings listing ON listing.id = deal.listing_id
  WHERE pg_catalog.upper(p_type) = 'DEAL' AND deal.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.time_resolve_crm_link(
  p_actor_user_id UUID,
  p_actor_role TEXT,
  p_type TEXT,
  p_id UUID
)
RETURNS TABLE (id UUID, type TEXT, label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT contact.id, 'CONTACT'::TEXT, contact.name::TEXT
  FROM public.contacts contact
  WHERE public.time_crm_actor_can(p_actor_user_id, p_actor_role, 'LINK_READ')
    AND pg_catalog.upper(p_type) = 'CONTACT' AND contact.id = p_id
  UNION ALL
  SELECT listing.id, 'LISTING'::TEXT, listing.name::TEXT
  FROM public.listings listing
  WHERE public.time_crm_actor_can(p_actor_user_id, p_actor_role, 'LINK_READ')
    AND pg_catalog.upper(p_type) = 'LISTING' AND listing.id = p_id
  UNION ALL
  SELECT lead.id, 'LEAD'::TEXT, contact.name::TEXT
  FROM public.leads lead JOIN public.contacts contact ON contact.id = lead.contact_id
  WHERE public.time_crm_actor_can(p_actor_user_id, p_actor_role, 'LINK_READ')
    AND pg_catalog.upper(p_type) = 'LEAD' AND lead.id = p_id
  UNION ALL
  SELECT deal.id, 'DEAL'::TEXT, listing.name::TEXT || ' — ' || deal.contract_date::TEXT
  FROM public.deals deal JOIN public.listings listing ON listing.id = deal.listing_id
  WHERE public.time_crm_actor_can(p_actor_user_id, p_actor_role, 'LINK_READ')
    AND pg_catalog.upper(p_type) = 'DEAL' AND deal.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.time_create_manual_entry(
  p_user_id UUID, p_request_id TEXT, p_standard_category_id UUID,
  p_personal_category_id UUID, p_daily_plan_id UUID,
  p_contact_id UUID, p_listing_id UUID, p_lead_id UUID, p_deal_id UUID,
  p_linked_entity_label TEXT, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ,
  p_notes TEXT, p_business_time_zone TEXT
)
RETURNS TABLE (entry_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business_date DATE;
  v_request JSONB;
  v_response JSONB;
  v_existing_type TEXT;
  v_existing_request JSONB;
  v_existing_response JSONB;
  v_linked_type TEXT;
  v_linked_id UUID;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' OR p_business_time_zone IS DISTINCT FROM 'Asia/Seoul'
    OR p_started_at IS NULL OR p_ended_at IS NULL OR p_ended_at <= p_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid manual entry';
  END IF;
  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'standardCategoryId', p_standard_category_id, 'personalCategoryId', p_personal_category_id,
    'dailyPlanId', p_daily_plan_id, 'contactId', p_contact_id, 'listingId', p_listing_id,
    'leadId', p_lead_id, 'dealId', p_deal_id, 'linkedEntityLabel', p_linked_entity_label,
    'startedAt', p_started_at, 'endedAt', p_ended_at, 'notes', p_notes,
    'businessTimeZone', p_business_time_zone));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::TEXT, 0));
  SELECT command.command_type, command.request_payload, command.response_payload
    INTO v_existing_type, v_existing_request, v_existing_response
  FROM public.time_commands command WHERE command.user_id = p_user_id AND command.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing_type <> 'MANUAL' OR v_existing_request <> v_request THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'request_id was already used with different command data', CONSTRAINT = 'time_commands_user_id_request_id_key';
    END IF;
    entry_id := (v_existing_response ->> 'entryId')::UUID;
    replayed := true; RETURN NEXT; RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE users.id = p_user_id AND users.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_standard_categories category WHERE category.id = p_standard_category_id AND category.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
  END IF;
  IF p_personal_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_personal_categories category WHERE category.id = p_personal_category_id
      AND category.user_id = p_user_id AND category.parent_standard_category_id = p_standard_category_id AND category.is_active = true
  ) THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user'; END IF;
  v_business_date := (p_started_at AT TIME ZONE p_business_time_zone)::DATE;
  IF p_daily_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_daily_plans plan WHERE plan.id = p_daily_plan_id
      AND plan.user_id = p_user_id AND plan.business_date = v_business_date
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'daily plan does not match owner and business date'; END IF;
  IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only one CRM link is allowed', CONSTRAINT = 'time_entries_single_crm_link_ck';
  END IF;
  v_linked_type := CASE WHEN p_contact_id IS NOT NULL THEN 'CONTACT' WHEN p_listing_id IS NOT NULL THEN 'LISTING' WHEN p_lead_id IS NOT NULL THEN 'LEAD' WHEN p_deal_id IS NOT NULL THEN 'DEAL' END;
  v_linked_id := COALESCE(p_contact_id, p_listing_id, p_lead_id, p_deal_id);
  IF v_linked_id IS NOT NULL AND (p_linked_entity_label IS NULL OR pg_catalog.btrim(p_linked_entity_label) = '') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CRM snapshot label is required', CONSTRAINT = 'time_entries_crm_snapshot_ck';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_entries existing WHERE existing.user_id = p_user_id
    AND pg_catalog.tstzrange(existing.started_at, COALESCE(existing.ended_at, 'infinity'::TIMESTAMPTZ), '[)')
      && pg_catalog.tstzrange(p_started_at, p_ended_at, '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'time entry overlaps an existing entry', CONSTRAINT = 'time_entries_user_time_overlap';
  END IF;
  INSERT INTO public.time_entries (
    user_id, business_date, daily_plan_id, standard_category_id, personal_category_id,
    entry_type, started_at, ended_at, duration_seconds, notes, request_id,
    contact_id, listing_id, lead_id, deal_id, linked_entity_type, linked_entity_id, linked_entity_label
  ) VALUES (
    p_user_id, v_business_date, p_daily_plan_id, p_standard_category_id, p_personal_category_id,
    'MANUAL', p_started_at, p_ended_at, pg_catalog.floor(EXTRACT(epoch FROM (p_ended_at - p_started_at)))::INTEGER,
    p_notes, p_request_id, p_contact_id, p_listing_id, p_lead_id, p_deal_id, v_linked_type, v_linked_id, p_linked_entity_label
  ) RETURNING time_entries.id INTO entry_id;
  replayed := false;
  v_response := pg_catalog.jsonb_build_object('entryId', entry_id);
  INSERT INTO public.time_commands (user_id, request_id, command_type, request_payload, response_payload)
  VALUES (p_user_id, p_request_id, 'MANUAL', v_request, v_response);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_create_manual_entry(
  p_user_id UUID, p_request_id TEXT, p_standard_category_id UUID,
  p_personal_category_id UUID, p_daily_plan_id UUID,
  p_contact_id UUID, p_listing_id UUID, p_lead_id UUID, p_deal_id UUID,
  p_linked_entity_label TEXT, p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ,
  p_notes TEXT, p_business_time_zone TEXT, p_actor_role TEXT
)
RETURNS TABLE (entry_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_business_date DATE;
  v_request JSONB;
  v_existing_response JSONB;
  v_response JSONB;
  v_link_type TEXT;
  v_link_id UUID;
  v_label TEXT;
BEGIN
  IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only one CRM entity may be linked',
      CONSTRAINT = 'time_entries_single_crm_link_ck';
  END IF;
  v_link_type := CASE WHEN p_contact_id IS NOT NULL THEN 'CONTACT'
    WHEN p_listing_id IS NOT NULL THEN 'LISTING' WHEN p_lead_id IS NOT NULL THEN 'LEAD'
    WHEN p_deal_id IS NOT NULL THEN 'DEAL' END;
  v_link_id := COALESCE(p_contact_id, p_listing_id, p_lead_id, p_deal_id);
  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'standardCategoryId', p_standard_category_id,
    'personalCategoryId', p_personal_category_id,
    'dailyPlanId', p_daily_plan_id,
    'crmLink', CASE WHEN v_link_id IS NULL THEN NULL ELSE
      pg_catalog.jsonb_build_object('type', v_link_type, 'id', v_link_id) END,
    'startedAt', p_started_at, 'endedAt', p_ended_at, 'notes', p_notes,
    'businessTimeZone', p_business_time_zone
  ));
  SELECT command.response_payload INTO v_existing_response
  FROM public.time_get_command_replay(p_user_id, p_request_id, 'MANUAL', v_request) command;
  IF FOUND THEN
    entry_id := (v_existing_response ->> 'entry_id')::UUID;
    replayed := true; RETURN NEXT; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users actor WHERE actor.id = p_user_id
    AND actor.is_active = true AND actor.role = p_actor_role AND actor.role IN ('admin', 'agent')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active actor not found';
  END IF;
  IF v_link_id IS NOT NULL THEN
    SELECT resolved.label INTO v_label
    FROM public.time_resolve_crm_link(p_user_id, p_actor_role, v_link_type, v_link_id) resolved;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'CRM link not found'; END IF;
  END IF;

  IF p_business_time_zone IS DISTINCT FROM 'Asia/Seoul'
    OR p_started_at IS NULL OR p_ended_at IS NULL OR p_ended_at <= p_started_at THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid manual entry';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_standard_categories category
    WHERE category.id = p_standard_category_id AND category.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
  END IF;
  IF p_personal_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_personal_categories category
    WHERE category.id = p_personal_category_id AND category.user_id = p_user_id
      AND category.parent_standard_category_id = p_standard_category_id AND category.is_active = true
  ) THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user'; END IF;
  v_business_date := (p_started_at AT TIME ZONE p_business_time_zone)::DATE;
  IF p_daily_plan_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_daily_plans plan WHERE plan.id = p_daily_plan_id
      AND plan.user_id = p_user_id AND plan.business_date = v_business_date
  ) THEN RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'daily plan does not match owner and business date'; END IF;
  IF EXISTS (SELECT 1 FROM public.time_entries existing WHERE existing.user_id = p_user_id
    AND pg_catalog.tstzrange(existing.started_at, COALESCE(existing.ended_at, 'infinity'::TIMESTAMPTZ), '[)')
      && pg_catalog.tstzrange(p_started_at, p_ended_at, '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'time entry overlaps an existing entry',
      CONSTRAINT = 'time_entries_user_time_overlap';
  END IF;
  INSERT INTO public.time_entries (
    user_id, business_date, daily_plan_id, standard_category_id, personal_category_id,
    entry_type, started_at, ended_at, duration_seconds, notes, request_id,
    contact_id, listing_id, lead_id, deal_id, linked_entity_type, linked_entity_id, linked_entity_label
  ) VALUES (
    p_user_id, v_business_date, p_daily_plan_id, p_standard_category_id, p_personal_category_id,
    'MANUAL', p_started_at, p_ended_at,
    pg_catalog.floor(EXTRACT(epoch FROM (p_ended_at - p_started_at)))::INTEGER,
    p_notes, p_request_id, p_contact_id, p_listing_id, p_lead_id, p_deal_id,
    v_link_type, v_link_id, v_label
  ) RETURNING time_entries.id INTO entry_id;
  replayed := false;
  v_response := pg_catalog.jsonb_build_object('entry_id', entry_id);
  INSERT INTO public.time_commands (user_id, request_id, command_type, request_payload, response_payload)
  VALUES (p_user_id, p_request_id, 'MANUAL', v_request, v_response);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_revise_entry(
  p_user_id UUID, p_entry_id UUID, p_request_id TEXT,
  p_standard_category_id UUID, p_personal_category_id UUID,
  p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_notes TEXT,
  p_patch_fields TEXT[], p_contact_id UUID, p_listing_id UUID,
  p_lead_id UUID, p_deal_id UUID, p_linked_entity_label TEXT
)
RETURNS TABLE (entry_id UUID, revision_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_before public.time_entries%ROWTYPE;
  v_after JSONB;
  v_request JSONB;
  v_response JSONB;
  v_existing_type TEXT;
  v_existing_request JSONB;
  v_existing_response JSONB;
  v_standard UUID; v_personal UUID; v_start TIMESTAMPTZ; v_end TIMESTAMPTZ; v_notes TEXT;
  v_contact UUID; v_listing UUID; v_lead UUID; v_deal UUID; v_label TEXT; v_link_type TEXT; v_link_id UUID;
BEGIN
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' OR p_patch_fields IS NULL
    OR pg_catalog.cardinality(p_patch_fields) = 0
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(p_patch_fields) field WHERE field NOT IN ('standardCategoryId','personalCategoryId','startedAt','endedAt','notes','crmLink')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid revision request';
  END IF;
  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'entryId', p_entry_id, 'standardCategoryId', p_standard_category_id,
    'personalCategoryId', p_personal_category_id, 'startedAt', p_started_at,
    'endedAt', p_ended_at, 'notes', p_notes, 'patchFields', p_patch_fields,
    'contactId', p_contact_id, 'listingId', p_listing_id, 'leadId', p_lead_id,
    'dealId', p_deal_id, 'linkedEntityLabel', p_linked_entity_label));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user_id::TEXT, 0));
  SELECT command.command_type, command.request_payload, command.response_payload
    INTO v_existing_type, v_existing_request, v_existing_response
  FROM public.time_commands command WHERE command.user_id = p_user_id AND command.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing_type <> 'REVISE' OR v_existing_request <> v_request THEN
      RAISE EXCEPTION USING ERRCODE = '23505', MESSAGE = 'request_id was already used with different command data', CONSTRAINT = 'time_commands_user_id_request_id_key';
    END IF;
    entry_id := (v_existing_response ->> 'entryId')::UUID;
    revision_id := (v_existing_response ->> 'revisionId')::UUID;
    replayed := true; RETURN NEXT; RETURN;
  END IF;
  SELECT * INTO v_before FROM public.time_entries existing
    WHERE existing.id = p_entry_id AND existing.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'entry is not available'; END IF;
  IF v_before.ended_at IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active timer cannot be revised'; END IF;
  v_standard := CASE WHEN 'standardCategoryId' = ANY(p_patch_fields) THEN p_standard_category_id ELSE v_before.standard_category_id END;
  v_personal := CASE WHEN 'personalCategoryId' = ANY(p_patch_fields) THEN p_personal_category_id ELSE v_before.personal_category_id END;
  v_start := CASE WHEN 'startedAt' = ANY(p_patch_fields) THEN p_started_at ELSE v_before.started_at END;
  v_end := CASE WHEN 'endedAt' = ANY(p_patch_fields) THEN p_ended_at ELSE v_before.ended_at END;
  v_notes := CASE WHEN 'notes' = ANY(p_patch_fields) THEN p_notes ELSE v_before.notes END;
  v_contact := CASE WHEN 'crmLink' = ANY(p_patch_fields) THEN p_contact_id ELSE v_before.contact_id END;
  v_listing := CASE WHEN 'crmLink' = ANY(p_patch_fields) THEN p_listing_id ELSE v_before.listing_id END;
  v_lead := CASE WHEN 'crmLink' = ANY(p_patch_fields) THEN p_lead_id ELSE v_before.lead_id END;
  v_deal := CASE WHEN 'crmLink' = ANY(p_patch_fields) THEN p_deal_id ELSE v_before.deal_id END;
  v_label := CASE WHEN 'crmLink' = ANY(p_patch_fields) THEN p_linked_entity_label ELSE v_before.linked_entity_label END;
  IF v_start IS NULL OR v_end IS NULL OR v_end <= v_start OR (v_start AT TIME ZONE 'Asia/Seoul')::DATE <> v_before.business_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid revision time range';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_standard_categories category WHERE category.id = v_standard AND category.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
  END IF;
  IF v_personal IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.time_personal_categories category
    WHERE category.id = v_personal AND category.user_id = p_user_id
      AND category.parent_standard_category_id = v_standard AND category.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user';
  END IF;
  IF pg_catalog.num_nonnulls(v_contact, v_listing, v_lead, v_deal) > 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only one CRM link is allowed', CONSTRAINT = 'time_entries_single_crm_link_ck';
  END IF;
  v_link_type := CASE WHEN v_contact IS NOT NULL THEN 'CONTACT' WHEN v_listing IS NOT NULL THEN 'LISTING' WHEN v_lead IS NOT NULL THEN 'LEAD' WHEN v_deal IS NOT NULL THEN 'DEAL' END;
  v_link_id := COALESCE(v_contact, v_listing, v_lead, v_deal);
  IF v_link_id IS NOT NULL AND (v_label IS NULL OR pg_catalog.btrim(v_label) = '') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'CRM snapshot label is required', CONSTRAINT = 'time_entries_crm_snapshot_ck';
  END IF;
  IF EXISTS (SELECT 1 FROM public.time_entries existing WHERE existing.user_id = p_user_id AND existing.id <> p_entry_id
    AND pg_catalog.tstzrange(existing.started_at, COALESCE(existing.ended_at, 'infinity'::TIMESTAMPTZ), '[)')
      && pg_catalog.tstzrange(v_start, v_end, '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'time entry overlaps an existing entry', CONSTRAINT = 'time_entries_user_time_overlap';
  END IF;
  UPDATE public.time_entries SET standard_category_id = v_standard, personal_category_id = v_personal,
    started_at = v_start, ended_at = v_end,
    duration_seconds = pg_catalog.floor(EXTRACT(epoch FROM (v_end - v_start)))::INTEGER,
    notes = v_notes, contact_id = v_contact, listing_id = v_listing, lead_id = v_lead, deal_id = v_deal,
    linked_entity_type = v_link_type, linked_entity_id = v_link_id, linked_entity_label = v_label,
    updated_at = pg_catalog.now()
  WHERE time_entries.id = p_entry_id AND time_entries.user_id = p_user_id
  RETURNING pg_catalog.to_jsonb(time_entries) INTO v_after;
  INSERT INTO public.time_entry_revisions (entry_id, user_id, changed_by, before_value, after_value)
  VALUES (p_entry_id, p_user_id, p_user_id, pg_catalog.to_jsonb(v_before), v_after)
  RETURNING time_entry_revisions.id INTO revision_id;
  entry_id := p_entry_id; replayed := false;
  v_response := pg_catalog.jsonb_build_object('entryId', entry_id, 'revisionId', revision_id);
  INSERT INTO public.time_commands (user_id, request_id, command_type, request_payload, response_payload)
  VALUES (p_user_id, p_request_id, 'REVISE', v_request, v_response);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_revise_entry(
  p_user_id UUID, p_entry_id UUID, p_request_id TEXT,
  p_standard_category_id UUID, p_personal_category_id UUID,
  p_started_at TIMESTAMPTZ, p_ended_at TIMESTAMPTZ, p_notes TEXT,
  p_patch_fields TEXT[], p_contact_id UUID, p_listing_id UUID,
  p_lead_id UUID, p_deal_id UUID, p_linked_entity_label TEXT,
  p_actor_role TEXT
)
RETURNS TABLE (entry_id UUID, revision_id UUID, replayed BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_before public.time_entries%ROWTYPE;
  v_proposed public.time_entries%ROWTYPE;
  v_after JSONB;
  v_request JSONB;
  v_existing_response JSONB;
  v_response JSONB;
  v_patch_fields TEXT[];
  v_link_type TEXT;
  v_link_id UUID;
  v_label TEXT;
  v_updated_at TIMESTAMPTZ;
BEGIN
  SELECT pg_catalog.array_agg(field ORDER BY field) INTO v_patch_fields
  FROM (SELECT DISTINCT field FROM pg_catalog.unnest(p_patch_fields) field) canonical;
  IF p_request_id IS NULL OR pg_catalog.btrim(p_request_id) = '' OR v_patch_fields IS NULL
    OR pg_catalog.cardinality(v_patch_fields) = 0
    OR EXISTS (SELECT 1 FROM pg_catalog.unnest(v_patch_fields) field
      WHERE field NOT IN ('standardCategoryId','personalCategoryId','startedAt','endedAt','notes','crmLink')) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'invalid revision request';
  END IF;

  IF 'crmLink' = ANY(v_patch_fields) THEN
    IF pg_catalog.num_nonnulls(p_contact_id, p_listing_id, p_lead_id, p_deal_id) > 1 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'only one CRM link is allowed',
        CONSTRAINT = 'time_entries_single_crm_link_ck';
    END IF;
    v_link_type := CASE WHEN p_contact_id IS NOT NULL THEN 'CONTACT'
      WHEN p_listing_id IS NOT NULL THEN 'LISTING' WHEN p_lead_id IS NOT NULL THEN 'LEAD'
      WHEN p_deal_id IS NOT NULL THEN 'DEAL' END;
    v_link_id := COALESCE(p_contact_id, p_listing_id, p_lead_id, p_deal_id);
  END IF;

  v_request := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
    'entryId', p_entry_id, 'standardCategoryId', p_standard_category_id,
    'personalCategoryId', p_personal_category_id, 'startedAt', p_started_at,
    'endedAt', p_ended_at, 'notes', p_notes, 'patchFields', v_patch_fields,
    'crmLink', CASE WHEN 'crmLink' = ANY(v_patch_fields) AND v_link_id IS NOT NULL
      THEN pg_catalog.jsonb_build_object('type', v_link_type, 'id', v_link_id) ELSE NULL END
  ));
  SELECT command.response_payload INTO v_existing_response
  FROM public.time_get_command_replay(p_user_id, p_request_id, 'REVISE', v_request) command;
  IF FOUND THEN
    entry_id := (v_existing_response ->> 'entry_id')::UUID;
    revision_id := (v_existing_response ->> 'revision_id')::UUID;
    replayed := true; RETURN NEXT; RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.users actor WHERE actor.id = p_user_id
    AND actor.is_active = true AND actor.role = p_actor_role AND actor.role IN ('admin', 'agent')) THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'active actor not found';
  END IF;
  SELECT * INTO v_before FROM public.time_entries existing
  WHERE existing.id = p_entry_id AND existing.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'entry is not available'; END IF;
  IF v_before.ended_at IS NULL THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'active timer cannot be revised'; END IF;

  v_proposed := v_before;
  IF 'standardCategoryId' = ANY(v_patch_fields) THEN v_proposed.standard_category_id := p_standard_category_id; END IF;
  IF 'personalCategoryId' = ANY(v_patch_fields) THEN v_proposed.personal_category_id := p_personal_category_id; END IF;
  IF 'startedAt' = ANY(v_patch_fields) THEN v_proposed.started_at := p_started_at; END IF;
  IF 'endedAt' = ANY(v_patch_fields) THEN v_proposed.ended_at := p_ended_at; END IF;
  IF 'notes' = ANY(v_patch_fields) THEN v_proposed.notes := p_notes; END IF;

  IF v_proposed.started_at IS NULL OR v_proposed.ended_at IS NULL
    OR v_proposed.ended_at <= v_proposed.started_at
    OR (v_proposed.started_at AT TIME ZONE 'Asia/Seoul')::DATE <> v_before.business_date THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'invalid revision time range';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.time_standard_categories category
    WHERE category.id = v_proposed.standard_category_id AND category.is_active = true) THEN
    RAISE EXCEPTION USING ERRCODE = '23503', MESSAGE = 'active standard category not found';
  END IF;
  IF v_proposed.personal_category_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.time_personal_categories category
    WHERE category.id = v_proposed.personal_category_id AND category.user_id = p_user_id
      AND category.parent_standard_category_id = v_proposed.standard_category_id
      AND category.is_active = true
  ) THEN RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'personal category is not owned by user'; END IF;

  IF 'crmLink' = ANY(v_patch_fields) THEN
    IF v_link_id IS NOT NULL THEN
      SELECT resolved.label INTO v_label
      FROM public.time_resolve_crm_link(p_user_id, p_actor_role, v_link_type, v_link_id) resolved;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0003', MESSAGE = 'CRM link not found'; END IF;
    END IF;
    v_proposed.contact_id := p_contact_id;
    v_proposed.listing_id := p_listing_id;
    v_proposed.lead_id := p_lead_id;
    v_proposed.deal_id := p_deal_id;
    v_proposed.linked_entity_type := v_link_type;
    v_proposed.linked_entity_id := v_link_id;
    v_proposed.linked_entity_label := v_label;
    v_proposed.linked_entity_detached_at := NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM public.time_entries existing
    WHERE existing.user_id = p_user_id AND existing.id <> p_entry_id
      AND pg_catalog.tstzrange(existing.started_at, COALESCE(existing.ended_at, 'infinity'::TIMESTAMPTZ), '[)')
        && pg_catalog.tstzrange(v_proposed.started_at, v_proposed.ended_at, '[)')) THEN
    RAISE EXCEPTION USING ERRCODE = '23P01', MESSAGE = 'time entry overlaps an existing entry',
      CONSTRAINT = 'time_entries_user_time_overlap';
  END IF;

  v_updated_at := pg_catalog.now();
  v_proposed.duration_seconds := pg_catalog.floor(
    EXTRACT(epoch FROM (v_proposed.ended_at - v_proposed.started_at))
  )::INTEGER;
  v_proposed.updated_at := v_updated_at;
  v_after := pg_catalog.to_jsonb(v_proposed);
  INSERT INTO public.time_entry_revisions (entry_id, user_id, changed_by, before_value, after_value)
  VALUES (p_entry_id, p_user_id, p_user_id, pg_catalog.to_jsonb(v_before), v_after)
  RETURNING time_entry_revisions.id INTO revision_id;

  UPDATE public.time_entries SET
    standard_category_id = v_proposed.standard_category_id,
    personal_category_id = v_proposed.personal_category_id,
    started_at = v_proposed.started_at,
    ended_at = v_proposed.ended_at,
    duration_seconds = v_proposed.duration_seconds,
    notes = v_proposed.notes,
    contact_id = v_proposed.contact_id,
    listing_id = v_proposed.listing_id,
    lead_id = v_proposed.lead_id,
    deal_id = v_proposed.deal_id,
    linked_entity_type = v_proposed.linked_entity_type,
    linked_entity_id = v_proposed.linked_entity_id,
    linked_entity_label = v_proposed.linked_entity_label,
    linked_entity_detached_at = v_proposed.linked_entity_detached_at,
    updated_at = v_updated_at
  WHERE time_entries.id = p_entry_id AND time_entries.user_id = p_user_id;

  entry_id := p_entry_id; replayed := false;
  v_response := pg_catalog.jsonb_build_object('entry_id', entry_id, 'revision_id', revision_id);
  INSERT INTO public.time_commands (user_id, request_id, command_type, request_payload, response_payload)
  VALUES (p_user_id, p_request_id, 'REVISE', v_request, v_response);
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_reject_revision_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'time entry revisions are immutable';
END;
$$;

DROP TRIGGER IF EXISTS time_entry_revisions_immutable_trg ON public.time_entry_revisions;
CREATE TRIGGER time_entry_revisions_immutable_trg
  BEFORE UPDATE OR DELETE ON public.time_entry_revisions
  FOR EACH ROW EXECUTE FUNCTION public.time_reject_revision_mutation();

CREATE OR REPLACE FUNCTION public.time_search_crm_links(
  p_query TEXT DEFAULT '',
  p_types TEXT[] DEFAULT ARRAY['CONTACT', 'LISTING', 'LEAD', 'DEAL'],
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (id UUID, type TEXT, label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH args AS (
    SELECT
      LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50) AS result_limit,
      ARRAY(
        SELECT pg_catalog.upper(candidate)
        FROM pg_catalog.unnest(COALESCE(p_types, ARRAY['CONTACT', 'LISTING', 'LEAD', 'DEAL'])) AS candidate
        WHERE pg_catalog.upper(candidate) IN ('CONTACT', 'LISTING', 'LEAD', 'DEAL')
      ) AS selected_types,
      pg_catalog.replace(
        pg_catalog.replace(
          pg_catalog.replace(COALESCE(p_query, ''), E'\\', E'\\\\'),
          '%', E'\\%'
        ),
        '_', E'\\_'
      ) AS escaped_query
  ), candidates AS (
    SELECT contact.id, 'CONTACT'::TEXT AS type, contact.name::TEXT AS label
    FROM public.contacts AS contact CROSS JOIN args
    WHERE 'CONTACT' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR contact.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT listing.id, 'LISTING'::TEXT, listing.name::TEXT
    FROM public.listings AS listing CROSS JOIN args
    WHERE 'LISTING' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR listing.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT lead.id, 'LEAD'::TEXT, contact.name::TEXT
    FROM public.leads AS lead
    JOIN public.contacts AS contact ON contact.id = lead.contact_id
    CROSS JOIN args
    WHERE 'LEAD' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR contact.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT deal.id, 'DEAL'::TEXT, listing.name::TEXT || ' — ' || deal.contract_date::TEXT
    FROM public.deals AS deal
    JOIN public.listings AS listing ON listing.id = deal.listing_id
    CROSS JOIN args
    WHERE 'DEAL' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR listing.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
  )
  SELECT candidates.id, candidates.type, candidates.label
  FROM candidates
  ORDER BY candidates.label, candidates.type, candidates.id
  LIMIT (SELECT result_limit FROM args);
$$;

CREATE OR REPLACE FUNCTION public.time_search_crm_links(
  p_actor_user_id UUID,
  p_actor_role TEXT,
  p_query TEXT DEFAULT '',
  p_types TEXT[] DEFAULT ARRAY['CONTACT', 'LISTING', 'LEAD', 'DEAL'],
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (id UUID, type TEXT, label TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH actor_gate AS (
    SELECT public.time_crm_actor_can(p_actor_user_id, p_actor_role, 'LINK_READ') AS allowed
  ), args AS (
    SELECT
      LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50) AS result_limit,
      ARRAY(
        SELECT pg_catalog.upper(candidate)
        FROM pg_catalog.unnest(COALESCE(p_types, ARRAY['CONTACT', 'LISTING', 'LEAD', 'DEAL'])) candidate
        WHERE pg_catalog.upper(candidate) IN ('CONTACT', 'LISTING', 'LEAD', 'DEAL')
      ) AS selected_types,
      pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(
        COALESCE(p_query, ''), E'\\', E'\\\\'), '%', E'\\%'), '_', E'\\_') AS escaped_query
  ), candidates AS (
    SELECT contact.id, 'CONTACT'::TEXT AS type, contact.name::TEXT AS label
    FROM public.contacts contact CROSS JOIN args CROSS JOIN actor_gate
    WHERE actor_gate.allowed AND 'CONTACT' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR contact.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT listing.id, 'LISTING'::TEXT, listing.name::TEXT
    FROM public.listings listing CROSS JOIN args CROSS JOIN actor_gate
    WHERE actor_gate.allowed AND 'LISTING' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR listing.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT lead.id, 'LEAD'::TEXT, contact.name::TEXT
    FROM public.leads lead JOIN public.contacts contact ON contact.id = lead.contact_id
    CROSS JOIN args CROSS JOIN actor_gate
    WHERE actor_gate.allowed AND 'LEAD' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR contact.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
    UNION ALL
    SELECT deal.id, 'DEAL'::TEXT, listing.name::TEXT || ' — ' || deal.contract_date::TEXT
    FROM public.deals deal JOIN public.listings listing ON listing.id = deal.listing_id
    CROSS JOIN args CROSS JOIN actor_gate
    WHERE actor_gate.allowed AND 'DEAL' = ANY(args.selected_types)
      AND (args.escaped_query = '' OR listing.name ILIKE '%' || args.escaped_query || '%' ESCAPE E'\\')
  )
  SELECT candidates.id, candidates.type, candidates.label FROM candidates
  ORDER BY candidates.label, candidates.type, candidates.id
  LIMIT (SELECT result_limit FROM args);
$$;

DROP FUNCTION IF EXISTS public.time_search_crm_links(TEXT, TEXT[], INTEGER);
DROP FUNCTION IF EXISTS public.time_resolve_crm_link(TEXT, UUID);
DROP FUNCTION IF EXISTS public.time_start_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
);
DROP FUNCTION IF EXISTS public.time_switch_timer(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
);
DROP FUNCTION IF EXISTS public.time_stop_timer(UUID, TEXT, TIMESTAMPTZ, TEXT);
DROP FUNCTION IF EXISTS public.time_create_manual_entry(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT
);
DROP FUNCTION IF EXISTS public.time_revise_entry(
  UUID, UUID, TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], UUID, UUID, UUID, UUID, TEXT
);
DROP FUNCTION IF EXISTS public.time_apply_timer_command(
  UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
);

REVOKE ALL ON FUNCTION public.time_prevent_entry_business_date_update() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_track_push_owner_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_claim_jobs(INTEGER, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_fail_job(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_complete_job(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_save_daily_plan(UUID, DATE, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_reject_revision_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_crm_actor_can(UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_get_command_replay(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_resolve_crm_link(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_search_crm_links(UUID, TEXT, TEXT, TEXT[], INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_apply_timer_command(
  UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_start_timer(
  UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_switch_timer(
  UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_stop_timer(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_create_manual_entry(
  UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.time_revise_entry(
  UUID, UUID, TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], UUID, UUID, UUID, UUID, TEXT, TEXT
) FROM PUBLIC;

DO $$
DECLARE
  v_functions CONSTANT TEXT :=
    'public.time_claim_jobs(INTEGER, TEXT, INTEGER), '
    'public.time_fail_job(UUID, TEXT, UUID, TEXT), '
    'public.time_complete_job(UUID, TEXT, UUID, JSONB), '
    'public.time_save_daily_plan(UUID, DATE, INTEGER, JSONB), '
    'public.time_get_command_replay(UUID, TEXT, TEXT, JSONB), '
    'public.time_resolve_crm_link(UUID, TEXT, TEXT, UUID), '
    'public.time_search_crm_links(UUID, TEXT, TEXT, TEXT[], INTEGER), '
    'public.time_start_timer(UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_switch_timer(UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_stop_timer(UUID, TEXT, TEXT, TIMESTAMPTZ, TEXT), '
    'public.time_create_manual_entry(UUID, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT), '
    'public.time_revise_entry(UUID, UUID, TEXT, UUID, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT[], UUID, UUID, UUID, UUID, TEXT, TEXT)';
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
