-- Candor schema. Idempotent; applied by src/db/migrate.ts.
-- Money never appears here: stakes/P&L are paper units (numeric).

CREATE TABLE IF NOT EXISTS fixtures (
  fixture_id      BIGINT PRIMARY KEY,
  start_time      TIMESTAMPTZ NOT NULL,
  competition     TEXT NOT NULL,
  competition_id  INT NOT NULL,
  participant1    TEXT NOT NULL,
  participant1_id INT NOT NULL,
  participant2    TEXT NOT NULL,
  participant2_id INT NOT NULL,
  p1_is_home      BOOLEAN NOT NULL,
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_update     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Live per-match state derived from the scores stream (StatusId phase model).
CREATE TABLE IF NOT EXISTS match_state (
  fixture_id    BIGINT PRIMARY KEY REFERENCES fixtures(fixture_id),
  status_id     INT,
  game_state    TEXT,
  clock_seconds INT,
  last_seq      BIGINT NOT NULL DEFAULT 0,
  score         JSONB,
  stats         JSONB,
  finalised_seq BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Latest quote per unique market line.
CREATE TABLE IF NOT EXISTS odds_latest (
  fixture_id        BIGINT NOT NULL,
  super_odds_type   TEXT NOT NULL,
  market_period     TEXT NOT NULL DEFAULT '',   -- '' = full match
  market_parameters TEXT NOT NULL DEFAULT '',
  ts                BIGINT NOT NULL,
  message_id        TEXT NOT NULL,
  in_running        BOOLEAN NOT NULL,
  price_names       TEXT[] NOT NULL,
  prices            INT[] NOT NULL,
  pct               TEXT[] NOT NULL,
  PRIMARY KEY (fixture_id, super_odds_type, market_period, market_parameters)
);

-- Append-only tick history (movement signals + closing-line capture).
CREATE TABLE IF NOT EXISTS odds_history (
  id                BIGSERIAL PRIMARY KEY,
  fixture_id        BIGINT NOT NULL,
  ts                BIGINT NOT NULL,
  message_id        TEXT NOT NULL,
  super_odds_type   TEXT NOT NULL,
  market_period     TEXT NOT NULL DEFAULT '',
  market_parameters TEXT NOT NULL DEFAULT '',
  in_running        BOOLEAN NOT NULL,
  prices            INT[] NOT NULL,
  pct               TEXT[] NOT NULL
);
CREATE INDEX IF NOT EXISTS odds_history_line_ts
  ON odds_history (fixture_id, super_odds_type, market_period, market_parameters, ts);

-- Every decision the agent takes, including "no trade". The audit trail.
CREATE TABLE IF NOT EXISTS signals (
  id            BIGSERIAL PRIMARY KEY,
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  fixture_id    BIGINT NOT NULL,
  family        TEXT NOT NULL,            -- divergence | movement
  market_key    TEXT NOT NULL,            -- type|period|params
  side          TEXT,
  model_price   NUMERIC,
  market_price  NUMERIC,
  edge          NUMERIC,
  decision      TEXT NOT NULL,            -- enter | pass
  reason        TEXT NOT NULL,
  inputs        JSONB NOT NULL,
  position_id   BIGINT
);

CREATE TABLE IF NOT EXISTS positions (
  id                BIGSERIAL PRIMARY KEY,
  opened_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  fixture_id        BIGINT NOT NULL REFERENCES fixtures(fixture_id),
  market_key        TEXT NOT NULL,        -- type|period|params (odds line key)
  scope             TEXT NOT NULL DEFAULT 'full',      -- full | half1
  side              TEXT NOT NULL,
  family            TEXT NOT NULL DEFAULT 'divergence',
  price_taken       NUMERIC NOT NULL,     -- decimal odds
  model_prob        NUMERIC NOT NULL,
  market_prob       NUMERIC NOT NULL,
  stake_units       NUMERIC NOT NULL,
  kelly_fraction    NUMERIC NOT NULL,
  bankroll_before   NUMERIC NOT NULL,
  entry_goals1      INT NOT NULL DEFAULT 0,            -- scope goals at entry (AH grading)
  entry_goals2      INT NOT NULL DEFAULT 0,
  decided_ts        BIGINT NOT NULL,      -- stream-time of the decision (deterministic clock)
  reason            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'open',  -- open | settled | void
  -- accountability
  payload_canonical TEXT NOT NULL,
  payload_hash      TEXT NOT NULL,
  params_hash       TEXT NOT NULL,
  prev_commit_sig   TEXT,                 -- hash chain; set by the commit layer
  commit_sig        TEXT,
  commit_status     TEXT NOT NULL DEFAULT 'pending' -- pending | committed | failed
);
CREATE INDEX IF NOT EXISTS positions_fixture ON positions (fixture_id);

CREATE TABLE IF NOT EXISTS settlements (
  position_id    BIGINT PRIMARY KEY REFERENCES positions(id),
  settled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome        TEXT NOT NULL,           -- won | lost | void | push
  pnl_units      NUMERIC NOT NULL,
  bankroll_after NUMERIC,
  closing_price  NUMERIC,                 -- decimal odds of the side at line close
  closing_prob   NUMERIC,                 -- demargined prob of the side at line close
  clv            NUMERIC,                 -- closing_prob - entry market_prob, in points
  evidence       JSONB NOT NULL           -- the settlement stats slice used
);

CREATE TABLE IF NOT EXISTS proofs (
  id            BIGSERIAL PRIMARY KEY,
  position_id   BIGINT NOT NULL REFERENCES positions(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | proven | proof_unavailable
  stat_keys     INT[] NOT NULL,
  target_ts     BIGINT,
  strategy      JSONB NOT NULL,
  result        BOOLEAN,
  broadcast_sig TEXT,
  error         TEXT
);
CREATE INDEX IF NOT EXISTS proofs_position ON proofs (position_id);

CREATE TABLE IF NOT EXISTS agent_state (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotent column additions for databases created before these columns existed.
ALTER TABLE positions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'full';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS family TEXT NOT NULL DEFAULT 'divergence';
ALTER TABLE positions ADD COLUMN IF NOT EXISTS model_prob NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS market_prob NUMERIC;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_goals1 INT NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS entry_goals2 INT NOT NULL DEFAULT 0;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS decided_ts BIGINT;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT '';
ALTER TABLE positions DROP COLUMN IF EXISTS model_price;
ALTER TABLE positions ALTER COLUMN prev_commit_sig DROP NOT NULL;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS bankroll_after NUMERIC;
ALTER TABLE settlements ADD COLUMN IF NOT EXISTS closing_prob NUMERIC;
-- validate_stat_v3 adoption (2026-07-13): which oracle method produced each
-- proof row (validate_stat_v3 | validate_stat_v2; NULL on void rows).
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS method TEXT;
-- Backfill rows proven before the column existed (all were validate_stat_v2;
-- post-adoption code always writes the method, so this cannot mislabel new rows).
UPDATE proofs SET method = 'validate_stat_v2' WHERE method IS NULL AND status = 'proven';
