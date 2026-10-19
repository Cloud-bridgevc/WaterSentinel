-- WaterSentinel schema: Aurora PostgreSQL 16 (Serverless v2, Data API enabled).
-- Meter readings use native range partitioning by month (pg_partman manages partitions);
-- Aurora does not offer TimescaleDB, and hourly data at portfolio scale fits comfortably here.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_partman;

-- Organisations and sites ------------------------------------------------------------
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  segment       text NOT NULL CHECK (segment IN ('facility_manager','property_group','utility','service_operator','other')),
  hubspot_company_id text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  id            text PRIMARY KEY,                 -- short code, e.g. 'HP'
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  site_type     text NOT NULL,
  city          text,
  timezone      text NOT NULL DEFAULT 'UTC',
  area_m2       numeric CHECK (area_m2 > 0),
  occupants     integer CHECK (occupants > 0),
  criticality   numeric NOT NULL DEFAULT 0.5 CHECK (criticality BETWEEN 0 AND 1),
  detector_config jsonb,                          -- per-site overrides of DetectorConfig
  priority_weights jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Authorized integrations: readings are accepted only through an active authorization.
CREATE TABLE meter_integrations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  kind          text NOT NULL CHECK (kind IN ('utility_portal','ami_headend','bms','data_logger','file_drop','simulated')),
  provider      text NOT NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','revoked')),
  authorized_by text,                              -- person who granted access on the owner's side
  authorization_ref text,                          -- contract / data-sharing agreement reference
  authorization_expires_at timestamptz,
  credentials_secret_arn text,                     -- Secrets Manager; never stored in the DB
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'active' OR (authorized_by IS NOT NULL AND authorization_ref IS NOT NULL AND authorization_expires_at IS NOT NULL))
);

CREATE TABLE meters (
  id            text PRIMARY KEY,                  -- e.g. 'LV-M01'
  site_id       text NOT NULL REFERENCES sites(id),
  integration_id uuid REFERENCES meter_integrations(id),
  name          text NOT NULL,
  serial        text,
  size_mm       integer NOT NULL,
  profile       text,
  register_offset_m3 numeric NOT NULL DEFAULT 0,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Time series ------------------------------------------------------------------------
CREATE TABLE meter_readings (
  meter_id      text NOT NULL REFERENCES meters(id),
  ts            timestamptz NOT NULL,              -- start of the hourly interval, UTC
  litres        double precision,                  -- NULL = reported missing
  quality       text NOT NULL DEFAULT 'ok' CHECK (quality IN ('ok','suspect','missing','estimated')),
  source_integration_id uuid,
  received_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (meter_id, ts)
) PARTITION BY RANGE (ts);

SELECT partman.create_parent(p_parent_table => 'public.meter_readings', p_control => 'ts', p_interval => '1 month', p_premake => 3);
CREATE INDEX ON meter_readings (ts);

CREATE MATERIALIZED VIEW meter_readings_daily AS
SELECT meter_id, date_trunc('day', ts) AS day,
       sum(litres) AS litres,
       count(*) FILTER (WHERE litres IS NULL) AS missing_hours,
       min(litres) FILTER (WHERE extract(hour FROM ts) BETWEEN 1 AND 4) AS min_night_flow_lph
FROM meter_readings GROUP BY 1, 2;
CREATE UNIQUE INDEX ON meter_readings_daily (meter_id, day);
-- Refreshed CONCURRENTLY by the analysis Lambda after each run.

-- Detection --------------------------------------------------------------------------
CREATE TABLE anomalies (
  event_id      text PRIMARY KEY,                  -- '<meter>-<YYYYMMDDHH of start>'
  meter_id      text NOT NULL REFERENCES meters(id),
  start_ts      timestamptz NOT NULL,
  end_ts        timestamptz NOT NULL,
  span_hours    integer NOT NULL,
  flagged_hours integer NOT NULL,
  night_hours   integer NOT NULL,
  peak_z        double precision NOT NULL,
  peak_lph      double precision NOT NULL,
  excess_litres double precision NOT NULL,
  mean_ratio    double precision NOT NULL,
  ongoing       boolean NOT NULL,
  pattern       text NOT NULL,                     -- observational description, never a cause
  recurrence    integer NOT NULL DEFAULT 0,
  priority_score integer NOT NULL,
  priority_band text NOT NULL CHECK (priority_band IN ('P1','P2','P3')),
  detector_config jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON anomalies (meter_id, start_ts DESC);
CREATE INDEX ON anomalies (priority_score DESC) WHERE ongoing;

CREATE TABLE anomaly_briefs (
  id            bigserial PRIMARY KEY,
  event_id      text NOT NULL REFERENCES anomalies(event_id),
  evidence      jsonb NOT NULL,
  brief         jsonb NOT NULL,
  model_id      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Investigation workflow -------------------------------------------------------------
-- 'verified_leak' may only be set from a completed inspection task (enforced by trigger).
CREATE TABLE investigations (
  event_id      text PRIMARY KEY REFERENCES anomalies(event_id),
  status        text NOT NULL DEFAULT 'detected' CHECK (status IN
                ('detected','reviewing','inspection_scheduled','verified_leak','no_leak_found','explained_operational','inconclusive','dismissed')),
  owner_email   text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE investigation_notes (
  id            bigserial PRIMARY KEY,
  event_id      text NOT NULL REFERENCES anomalies(event_id),
  author_email  text NOT NULL,
  body          text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE technicians (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id),
  name          text NOT NULL,
  team          text,
  email         text
);

CREATE TABLE inspection_tasks (
  id            bigserial PRIMARY KEY,
  event_id      text NOT NULL REFERENCES anomalies(event_id),
  title         text NOT NULL,
  assignee_id   uuid REFERENCES technicians(id),
  due_date      date,
  state         text NOT NULL DEFAULT 'open' CHECK (state IN ('open','in_progress','completed','cancelled')),
  outcome       text CHECK (outcome IN ('verified_leak','no_leak_found','explained_operational','inconclusive')),
  outcome_note  text,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'completed') = (outcome IS NOT NULL)),
  CHECK (outcome IS NULL OR length(coalesce(outcome_note, '')) >= 10)
);

CREATE FUNCTION guard_verified_leak() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'verified_leak' AND NOT EXISTS (
       SELECT 1 FROM inspection_tasks t WHERE t.event_id = NEW.event_id AND t.state = 'completed' AND t.outcome = 'verified_leak') THEN
    RAISE EXCEPTION 'verified_leak requires a completed inspection task with that outcome';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER investigations_guard BEFORE INSERT OR UPDATE ON investigations
  FOR EACH ROW EXECUTE FUNCTION guard_verified_leak();

-- Reports, CRM sync and audit --------------------------------------------------------
CREATE TABLE reports (
  id            bigserial PRIMARY KEY,
  s3_key        text NOT NULL UNIQUE,
  report_type   text NOT NULL,
  params        jsonb NOT NULL,
  requested_by  text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE crm_sync_log (
  id            bigserial PRIMARY KEY,
  object_type   text NOT NULL,                     -- contact | company | deal | ticket
  local_ref     text,
  hubspot_id    text,
  action        text NOT NULL,
  ok            boolean NOT NULL,
  detail        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  actor         text NOT NULL,
  action        text NOT NULL,
  entity        text NOT NULL,
  entity_id     text NOT NULL,
  before        jsonb,
  after         jsonb,
  at            timestamptz NOT NULL DEFAULT now()
);
