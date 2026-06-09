-- =============================================================================
-- Prime Picks — MLB Database Schema
-- =============================================================================
-- Reference file only. Apply via Supabase dashboard or migrations runner.
-- All tables use UUID primary keys and timestamptz for time fields.
-- Row-level security (RLS) policies are not defined here — apply per environment.
-- =============================================================================


-- =============================================================================
-- EXTENSIONS
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "pg_trgm";    -- trigram indexes for text search


-- =============================================================================
-- ENUM TYPES
-- =============================================================================

-- Supported sports (MLB first; schema is sport-aware for future expansion)
create type sport_type as enum ('MLB', 'NFL', 'NBA', 'NHL');

-- Bet types supported in the engine layer
create type bet_type as enum (
  'moneyline',
  'run_line',
  'total_over',
  'total_under'
);

-- Market categories (broader than bet_type)
create type market_type as enum (
  'moneyline',
  'run_line',
  'total'
);

-- Vig-removal method used for probability calculation
create type probability_source as enum (
  'no-vig',  -- opposite odds provided; normalization applied
  'raw'      -- only one side available; vig not removed
);

-- Edge quality tier from edge.engine
create type edge_tier as enum (
  'NEGATIVE',
  'LOW',
  'MEDIUM',
  'HIGH',
  'ELITE'
);

-- Risk level from risk.engine
create type risk_level as enum (
  'LOW',
  'MEDIUM',
  'HIGH'
);

-- Pre-game letter grade from pickGrade.engine
create type grade_letter as enum (
  'A+',
  'A',
  'B',
  'C',
  'D',
  'F',
  'NO_GRADE'  -- assigned when no live odds exist at grading time
);

-- Pick lifecycle status (set by ranking.engine)
create type pick_status as enum (
  'QUALIFIED',       -- passed all filters; in topPicks or qualifiedPicks
  'FAILED_FILTER',   -- blocked by one of the ranking rules
  'NO_ODDS'          -- no live odds at prediction time
);

-- Reason a pick was blocked (only set when status = FAILED_FILTER)
create type fail_reason as enum (
  'EDGE_TOO_LOW',
  'NO_LIVE_ODDS',
  'BAD_ODDS_RANGE',
  'EXCLUDED_RUN_LINE',
  'HIGH_RISK',
  'DUPLICATE_GAME'
);

-- Post-game result of a settled pick
create type pick_result as enum (
  'WIN',
  'LOSS',
  'PUSH',
  'VOID'    -- game cancelled, bet refunded
);


-- =============================================================================
-- TABLE 1: model_versions
-- =============================================================================
-- Tracks every distinct model build used to generate predictions.
-- Every prediction is tagged with a model_version_id so results can be
-- attributed to the exact model that produced them. Old model results are
-- never overwritten — retiring a model sets is_active = false.
-- =============================================================================

create table model_versions (
  id            uuid        primary key default gen_random_uuid(),

  -- Human-readable identifier e.g. "mlb-logistic-v2"
  name          text        not null,

  -- Optional prose description of what changed in this version
  description   text,

  -- Sport this model is calibrated for
  sport         sport_type  not null default 'MLB',

  -- Semantic version string e.g. "2.1.0"
  version       text        not null,

  -- Arbitrary model hyperparameters, feature flags, thresholds used at training
  -- time. Stored as JSON so it is self-documenting and does not require schema
  -- changes when the model changes.
  config_json   jsonb       not null default '{}',

  -- When this model version was registered
  created_at    timestamptz not null default now(),

  -- Only one model per sport should be active at a time for production picks.
  -- Retiring a model: set is_active = false; never delete.
  is_active     boolean     not null default false,

  -- Prevent duplicate (sport, version) pairs
  constraint uq_model_versions_sport_version unique (sport, version)
);

comment on table  model_versions                is 'Registry of every model build. Predictions are forever linked to the version that produced them.';
comment on column model_versions.config_json    is 'Hyperparameters and feature configuration at training time. Immutable after creation.';
comment on column model_versions.is_active      is 'Only the active model generates new picks. Setting false retires a model without deleting history.';


-- =============================================================================
-- TABLE 2: model_predictions
-- =============================================================================
-- One row per pick generated by the model pipeline. This table is append-only:
-- predictions are never updated after creation to preserve audit integrity.
-- The status and fail_reason columns capture the ranking engine decision.
-- Post-game settlement data lives in pick_results (separate table).
-- =============================================================================

create table model_predictions (
  id                      uuid             primary key default gen_random_uuid(),

  -- Every prediction is permanently linked to the model that produced it
  model_version_id        uuid             not null
                          references model_versions (id) on delete restrict,

  -- ── Game identification ─────────────────────────────────────────────────
  game_id                 text             not null,
  sport                   sport_type       not null default 'MLB',
  league                  text             not null default 'MLB',

  -- Team being bet on and their opponent
  team                    text             not null,
  opponent                text             not null,

  -- ── Bet specification ────────────────────────────────────────────────────
  bet_type                bet_type         not null,
  market_type             market_type      not null,

  -- Run line spread (+1.5, -1.5, +2.5, -2.5). NULL for non-run-line bets.
  run_line_spread         numeric(4,1),

  -- ── Odds at prediction time (live = verified) ────────────────────────────
  -- NULL means no live odds existed when the prediction was generated.
  american_odds           integer,
  opposite_american_odds  integer,
  decimal_odds            numeric(8,4),

  -- ── Probability layer ────────────────────────────────────────────────────
  -- The model's estimated win probability for this side
  model_probability       numeric(6,4)     not null
                          check (model_probability > 0 and model_probability < 1),

  -- Raw implied probability (vig-inclusive, derived from american_odds)
  implied_probability     numeric(6,4)
                          check (implied_probability is null or
                                 (implied_probability > 0 and implied_probability < 1)),

  -- Vig-removed implied probability (requires opposite_american_odds)
  no_vig_probability      numeric(6,4)
                          check (no_vig_probability is null or
                                 (no_vig_probability > 0 and no_vig_probability < 1)),

  -- Which probability was used for edge calculation
  probability_source      probability_source,

  -- ── Edge layer ───────────────────────────────────────────────────────────
  edge_decimal            numeric(7,4)     not null default 0,
  edge_percent            numeric(7,4)     not null default 0,
  edge_tier               edge_tier        not null default 'NEGATIVE',

  -- ── Confidence and risk ──────────────────────────────────────────────────
  confidence              numeric(5,4)     not null
                          check (confidence >= 0 and confidence <= 1),

  risk_score              smallint         not null default 0
                          check (risk_score >= 0 and risk_score <= 100),

  risk_level              risk_level       not null default 'LOW',

  -- Array of human-readable risk factor descriptions from risk.engine
  risk_reasons_json       jsonb            not null default '[]',

  -- ── Pre-game grade ───────────────────────────────────────────────────────
  -- 0 when no live odds exist at grading time (NO_GRADE path)
  grade_numeric           numeric(5,1)     not null default 0
                          check (grade_numeric >= 0 and grade_numeric <= 100),

  grade_letter            grade_letter     not null default 'NO_GRADE',

  -- ── Ranking engine decision ──────────────────────────────────────────────
  status                  pick_status      not null,
  fail_reason             fail_reason,

  -- Constraint: fail_reason must be set iff status = FAILED_FILTER
  constraint ck_fail_reason_requires_failed_filter
    check (
      (status = 'FAILED_FILTER' and fail_reason is not null) or
      (status <> 'FAILED_FILTER' and fail_reason is null)
    ),

  -- Constraint: grade must be 0 / NO_GRADE when no odds exist
  constraint ck_no_odds_grade
    check (
      american_odds is not null or
      (grade_numeric = 0 and grade_letter = 'NO_GRADE')
    ),

  -- ── Audit ────────────────────────────────────────────────────────────────
  -- Append-only: created_at is set once and never changed.
  created_at              timestamptz      not null default now()
);

comment on table  model_predictions                  is 'Append-only log of every pick the pipeline generates. Never updated — settlement lives in pick_results.';
comment on column model_predictions.model_version_id is 'Links this prediction to the exact model build that produced it. Required; cannot be NULL.';
comment on column model_predictions.status           is 'QUALIFIED = passed all filters. FAILED_FILTER = blocked by ranking engine. NO_ODDS = no live odds at time of prediction.';
comment on column model_predictions.fail_reason      is 'Populated only when status = FAILED_FILTER. Documents why the pick was blocked for backtesting.';
comment on column model_predictions.risk_reasons_json is 'JSON array of human-readable strings from risk.engine explaining which risk factors fired.';
comment on column model_predictions.grade_numeric    is '0–100 composite pre-game quality score. Always 0 when american_odds is NULL.';
comment on column model_predictions.no_vig_probability is 'NULL when opposite_american_odds was not available at prediction time.';


-- =============================================================================
-- TABLE 3: pick_results
-- =============================================================================
-- Post-game settlement for a prediction. One row per settled prediction.
-- Only predictions that were graded (QUALIFIED or FAILED_FILTER) will have
-- a corresponding pick_result — NO_ODDS picks are not settled.
-- CLV is recorded here: closing_odds at game start vs. our entry odds.
-- =============================================================================

create table pick_results (
  id                          uuid        primary key default gen_random_uuid(),

  -- Link back to the original prediction (one-to-one)
  prediction_id               uuid        not null unique
                              references model_predictions (id) on delete restrict,

  -- ── Settlement ───────────────────────────────────────────────────────────
  result                      pick_result not null,

  -- ── Closing line value (CLV) ─────────────────────────────────────────────
  -- American odds at market close (game start). NULL if not captured.
  closing_odds                integer,

  -- Implied probability of closing odds (raw, no vig removal for CLV)
  closing_implied_probability numeric(6,4)
                              check (closing_implied_probability is null or
                                     (closing_implied_probability > 0 and
                                      closing_implied_probability < 1)),

  -- CLV = our implied probability − closing implied probability.
  -- Positive = we beat the closing line (good). Negative = closing moved against us.
  clv_decimal                 numeric(7,4),

  -- ── Financials ───────────────────────────────────────────────────────────
  -- Stake in units (e.g. 1.0 = one unit)
  stake                       numeric(10,4) not null default 1.0
                              check (stake > 0),

  -- Profit/loss in units. Positive = profit, negative = loss, 0 = push.
  profit_loss                 numeric(10,4) not null,

  -- Return on investment: profit_loss / stake
  roi                         numeric(8,4)  not null,

  -- ── Audit ────────────────────────────────────────────────────────────────
  settled_at                  timestamptz not null default now()
);

comment on table  pick_results                           is 'Post-game settlement for predictions. Append-only; one row per settled prediction.';
comment on column pick_results.prediction_id             is 'One-to-one with model_predictions. The UNIQUE constraint prevents double-settling.';
comment on column pick_results.clv_decimal               is 'Closing line value: our implied prob − closing implied prob. Positive means we beat the close.';
comment on column pick_results.closing_odds              is 'Market odds at game start. Captured for CLV calculation.';
comment on column pick_results.profit_loss               is 'In units. Calculated at settlement from result and american_odds.';
comment on column pick_results.roi                       is 'profit_loss / stake. Used in backtesting aggregations.';


-- =============================================================================
-- TABLE 4: backtests
-- =============================================================================
-- Aggregated results of running a model version against a historical date range.
-- Each backtest is associated with a specific model_version_id so results from
-- different model versions are never mixed. Multiple backtests can run for the
-- same model over different date ranges.
-- =============================================================================

create table backtests (
  id                  uuid        primary key default gen_random_uuid(),

  -- The model version being evaluated
  model_version_id    uuid        not null
                      references model_versions (id) on delete restrict,

  sport               sport_type  not null default 'MLB',

  -- Date range of predictions included in this backtest
  start_date          date        not null,
  end_date            date        not null,

  constraint ck_backtest_date_order
    check (end_date >= start_date),

  -- ── Prediction counts ────────────────────────────────────────────────────
  -- All predictions the model generated in the date range
  total_predictions   integer     not null default 0
                      check (total_predictions >= 0),

  -- Predictions that passed all filters (QUALIFIED)
  total_qualified     integer     not null default 0
                      check (total_qualified >= 0),

  -- Predictions that made it into topPicks
  total_top_picks     integer     not null default 0
                      check (total_top_picks >= 0),

  constraint ck_backtest_pick_counts
    check (
      total_top_picks <= total_qualified and
      total_qualified <= total_predictions
    ),

  -- ── Performance metrics ──────────────────────────────────────────────────
  -- Win rate across settled qualified picks (0–1)
  win_rate            numeric(6,4)
                      check (win_rate is null or (win_rate >= 0 and win_rate <= 1)),

  -- Total ROI across all settled qualified picks
  roi                 numeric(8,4),

  -- Total profit/loss in units
  profit_loss         numeric(12,4),

  -- Average CLV across settled picks (positive = consistently beat closing line)
  avg_clv             numeric(7,4),

  -- ── Configuration snapshot ──────────────────────────────────────────────
  -- The pipeline config used for this backtest (minimumEdge, maxNegativeOdds, etc.)
  config_json         jsonb       not null default '{}',

  -- When the backtest was computed
  created_at          timestamptz not null default now()
);

comment on table  backtests                   is 'Aggregated performance summaries for a model version over a date range. Never overwrites — append new rows for new runs.';
comment on column backtests.model_version_id  is 'Which model version produced the predictions being evaluated.';
comment on column backtests.avg_clv           is 'Average closing line value across settled picks. Positive CLV is the primary indicator of a +EV model.';
comment on column backtests.config_json       is 'Pipeline config (edge threshold, odds limits, etc.) used when running this backtest.';
comment on column backtests.total_qualified   is 'Predictions that passed all ranking filters. Subset of total_predictions.';


-- =============================================================================
-- INDEXES
-- =============================================================================

-- model_predictions: primary query patterns
create index idx_predictions_model_version
  on model_predictions (model_version_id);

create index idx_predictions_sport
  on model_predictions (sport);

create index idx_predictions_game_id
  on model_predictions (game_id);

create index idx_predictions_status
  on model_predictions (status);

create index idx_predictions_fail_reason
  on model_predictions (fail_reason)
  where fail_reason is not null;          -- partial: only failed picks

create index idx_predictions_created_at
  on model_predictions (created_at desc); -- DESC: most recent picks first

create index idx_predictions_edge_tier
  on model_predictions (edge_tier);

create index idx_predictions_risk_level
  on model_predictions (risk_level);

-- Compound: fetch all qualified picks for a model version ordered by grade
create index idx_predictions_version_status_grade
  on model_predictions (model_version_id, status, grade_numeric desc);

-- Compound: all predictions for a specific game across model versions
create index idx_predictions_game_sport
  on model_predictions (game_id, sport);

-- Compound: dashboard query — recent qualified picks for active sport
create index idx_predictions_sport_status_created
  on model_predictions (sport, status, created_at desc);

-- pick_results: settlement and CLV queries
create index idx_results_prediction_id
  on pick_results (prediction_id);

create index idx_results_settled_at
  on pick_results (settled_at desc);

create index idx_results_result
  on pick_results (result);

create index idx_results_clv
  on pick_results (clv_decimal desc)
  where clv_decimal is not null;          -- partial: only picks with CLV captured

-- backtests: version comparison queries
create index idx_backtests_model_version
  on backtests (model_version_id);

create index idx_backtests_sport_created
  on backtests (sport, created_at desc);


-- =============================================================================
-- VIEWS (convenience — not required, but useful for reporting)
-- =============================================================================

-- Active model version per sport
create view active_model_versions as
  select *
  from   model_versions
  where  is_active = true;

-- All qualified top picks with no settlement yet (open positions)
create view open_top_picks as
  select   p.*
  from     model_predictions p
  left join pick_results r on r.prediction_id = p.id
  where    p.status = 'QUALIFIED'
  and      r.id is null
  order by p.created_at desc;

-- Failed picks with their reasons (for filter analysis)
create view failed_pick_summary as
  select
    p.model_version_id,
    p.sport,
    p.fail_reason,
    p.edge_tier,
    p.risk_level,
    count(*)              as pick_count,
    avg(p.edge_decimal)   as avg_edge,
    avg(p.confidence)     as avg_confidence,
    min(p.created_at)     as earliest,
    max(p.created_at)     as latest
  from   model_predictions p
  where  p.status = 'FAILED_FILTER'
  group  by p.model_version_id, p.sport, p.fail_reason, p.edge_tier, p.risk_level;

-- CLV summary per model version
create view clv_summary_by_model as
  select
    p.model_version_id,
    p.sport,
    count(r.id)                  as settled_count,
    avg(r.clv_decimal)           as avg_clv,
    sum(case when r.clv_decimal > 0 then 1 else 0 end)
                                 as positive_clv_count,
    avg(r.roi)                   as avg_roi,
    sum(r.profit_loss)           as total_profit_loss
  from   model_predictions p
  join   pick_results       r on r.prediction_id = p.id
  where  p.status = 'QUALIFIED'
  group  by p.model_version_id, p.sport;

-- Profitability breakdown by edge tier
create view profitability_by_edge_tier as
  select
    p.model_version_id,
    p.sport,
    p.edge_tier,
    count(r.id)         as settled_count,
    avg(r.roi)          as avg_roi,
    sum(r.profit_loss)  as total_profit_loss,
    avg(r.clv_decimal)  as avg_clv,
    sum(case when r.result = 'WIN' then 1 else 0 end)::float
      / nullif(count(case when r.result in ('WIN','LOSS') then 1 end), 0)
                        as win_rate
  from   model_predictions p
  join   pick_results       r on r.prediction_id = p.id
  group  by p.model_version_id, p.sport, p.edge_tier;
