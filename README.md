# Prime Picks — MLB Betting Analytics Backend

A TypeScript analytics backend for sports betting intelligence. Takes raw MLB model predictions, runs them through a multi-stage engine pipeline, ranks the best picks, tracks performance, and supports backtesting — all without a UI layer.

---

## Current status

**783 tests passing. 0 failures.**

| Suite | Tests |
|---|---|
| `odds.engine` | 56 |
| `probability.engine` | 41 |
| `edge.engine` | 53 |
| `pickGrade.engine` | 41 |
| `risk.engine` | 60 |
| `ranking.engine` | 57 |
| `mlbPipeline` (integration) | 45 |
| `results.service` | 42 |
| `settlement.engine` | 55 |
| `settlement.service` | 35 |
| `backtesting.service` | 43 |
| `supabase.config` | 26 |
| `oddsApi.adapter` | 49 |
| `mlbModel.adapter` | 48 |
| `mlbDaily.service` | 30 |
| `mlbStatsModel.adapter` | 38 |
| `mlbDailyModel.service` | 32 |
| `mlbPicks.handler` | 32 |

All engines, services, adapters, and the integration pipeline are tested independently and together. No test uses real Supabase credentials or a live odds feed.

---

## Engine flow

```
structured MLB stats
  └─▶ mlbStatsModel.adapter    deterministic probability model from team/game stats
        │
        ▼
normalized odds picks (from oddsApi.adapter)
  └─▶ mlbModel.adapter         attach modelProbability + confidence to each pick
        │
        ▼
  └─▶ odds.engine              convert American → decimal → fractional, raw implied prob
  └─▶ probability.engine       remove vig (normalization), true implied probability
  └─▶ edge.engine              edge = model prob − implied prob, tier labeling
  └─▶ risk.engine              additive risk score from 7 observable factors
  └─▶ pickGrade.engine         pre-game quality grade A+→F (0 when no live odds)
  └─▶ ranking.engine           classify into topPicks / qualifiedPicks / failedPicks / noOddsPicks
        │
        ▼
  └─▶ mlbDailyModel.service    end-to-end cycle: stats → probs → pipeline → save
        │
        ▼
  └─▶ mlbPicks.handler         JSON-safe Lovable API entry point
        │
        ▼
  └─▶ results.service          map to DB rows → save to model_predictions (optional)
        │
        └─▶ settlement.engine      post-game: profit/loss, ROI, CLV
        └─▶ settlement.service     map to DB rows → save to pick_results
        └─▶ backtesting.service    replay historical slates → aggregate metrics
```

Every pick enters the pipeline and exits in exactly one group. Nothing is silently dropped.

---

## Lovable API entry point

### `getMLBPicksHandler()` — `src/api/mlbPicks.handler.ts`

This is the single function Lovable calls to get today's MLB picks. It is the clean boundary between the backend engine layer and any frontend client.

```typescript
import { getMLBPicksHandler } from './src/api/mlbPicks.handler';

const response = await getMLBPicksHandler({
  date:                '2025-06-10',
  modelVersionId:      'mlb-stats-v1',
  normalizedOddsPicks: oddsFromAdapter,   // from oddsApi.adapter
  structuredStats:     statsForToday,     // from your data source
  save:                false,             // preview mode — no DB write
});
```

### Preview mode (`save: false`)

When `save` is `false` (the default), the handler runs the full analytics pipeline and returns all picks with grades, edge, and risk — but **nothing is written to Supabase**. Use this mode to:

- Show picks in the Lovable UI before committing them
- Validate that the pipeline is producing sensible output
- Run dry-run tests without polluting the database
- Let a human review picks before persisting

```typescript
const preview = await getMLBPicksHandler({
  date, modelVersionId, normalizedOddsPicks, structuredStats,
  save: false,   // default — safe for previewing
});
// preview.savedRows === 0
// preview.topPicks are fully graded and ranked
```

### Persistence mode (`save: true`)

When `save` is `true` and a `supabaseClient` is provided, all picks from all four groups (topPicks, qualifiedPicks, failedPicks, noOddsPicks) are saved to the `model_predictions` table. Failed picks are stored with their `failReason` for backtesting.

```typescript
import { getSupabaseClient } from './src/config/supabase';

const saved = await getMLBPicksHandler({
  date, modelVersionId, normalizedOddsPicks, structuredStats,
  save:           true,
  supabaseClient: getSupabaseClient(),
});
// saved.savedRows > 0
// All picks persisted with status, failReason, grade, edge, risk
```

### Response shape

The handler always returns a JSON-safe `MLBPicksResponse`. All values are either primitive types, arrays, or `null` — never `undefined`, never functions, never class instances. The response can always be passed directly to `JSON.stringify`.

```typescript
interface MLBPicksResponse {
  date:            string;          // input date echoed back
  modelVersionId:  string;          // input modelVersionId echoed back
  topPicks:        PickResponseItem[];  // ≤5, qualified, one per game, no +1.5/+2.5 RL
  qualifiedPicks:  PickResponseItem[];  // passed filters but didn't make Top 5
  failedPicks:     PickResponseItem[];  // blocked by ranking rules, include failReason
  noOddsPicks:     PickResponseItem[];  // no live odds — grade 0, NO_GRADE
  summary:         DailyCycleSummary;   // counts for all groups
  warnings:        string[];        // non-fatal issues (missing model records, etc.)
  errors:          string[];        // validation or cycle errors
  savedRows:       number;          // 0 when save=false
  timestamp:       string;          // ISO-8601 generation time
}
```

### Fields Lovable should consume per pick

Every `PickResponseItem` contains:

```typescript
interface PickResponseItem {
  id:                string;       // unique pick identifier
  gameId:            string;       // game identifier (use for deduplication)
  team:              string;       // team being backed
  opponent:          string;       // opposing team
  betType:           string;       // 'moneyline' | 'run_line' | 'total_over' | 'total_under'
  marketType:        string;       // 'moneyline' | 'run_line' | 'total'
  americanOdds:      number | null;   // entry odds — null for no-odds picks
  modelProbability:  number | null;   // model's win probability (0–1)
  impliedProbability: number | null;  // market's implied probability after vig removal
  edgeDecimal:       number;       // edge as decimal (e.g. 0.072 = 7.2%)
  edgePercent:       number;       // edge as percentage (e.g. 7.2)
  edgeTier:          string;       // 'NEGATIVE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'ELITE'
  riskLevel:         string;       // 'LOW' | 'MEDIUM' | 'HIGH'
  riskScore:         number;       // 0–100 composite risk score
  gradeLetter:       string;       // 'A+' | 'A' | 'B' | 'C' | 'D' | 'F' | 'NO_GRADE'
  gradeNumeric:      number;       // 0–100 composite quality score
  status:            string;       // 'QUALIFIED' | 'FAILED_FILTER' | 'NO_ODDS'
  failReason:        string | null;   // why the pick was blocked (null for QUALIFIED)
  confidence:        number;       // model confidence 0–1
}
```

**Rendering guidance:**
- Show `topPicks` as the primary card list
- Use `gradeLetter` and `edgeTier` for visual badges
- Show `riskLevel` with a colour indicator (green/amber/red)
- For `failedPicks`: show the `failReason` label (e.g. "Edge too low")
- For `noOddsPicks`: show "No odds posted" with `NO_GRADE`
- Use `edgePercent` for the displayed edge value (already multiplied by 100)
- `qualifiedPicks` can be shown as a secondary "watch list"

---

## Folder and file reference

```
src/
├── index.ts                          Public API barrel — import everything from here
├── mlbPipeline.ts                    Core orchestrator: wires all engines for a pick cycle
│
├── api/
│   └── mlbPicks.handler.ts           ← Lovable entry point: getMLBPicksHandler()
│
├── types/
│   └── mlb.ts                        All shared TypeScript interfaces, enums, and types
│
├── engines/
│   ├── odds.engine.ts                Format conversion: American ↔ decimal ↔ fractional
│   ├── probability.engine.ts         Vig removal via normalization (basic method)
│   ├── edge.engine.ts                Edge calculation and tier assignment
│   ├── risk.engine.ts                Additive risk scoring from 7 factors
│   ├── pickGrade.engine.ts           Pre-game quality grade (A+→F / NO_GRADE)
│   ├── ranking.engine.ts             Filter, classify, and sort picks into 4 groups
│   └── settlement.engine.ts          Post-game: P/L, ROI, CLV calculation
│
├── adapters/
│   ├── oddsApi.adapter.ts            Fetches and normalizes odds from The Odds API
│   ├── mlbModel.adapter.ts           Attaches model probabilities to normalized picks
│   ├── mlbStatsModel.adapter.ts      Deterministic probability model from team/game stats
│   ├── mlbDaily.service.ts           Orchestrates: odds + model attach → pipeline → save
│   └── mlbDailyModel.service.ts      Full cycle: stats + odds → probs → pipeline → save
│
├── config/
│   └── supabase.ts                   Env validation, HTTP client, getSupabaseClient() singleton
│
├── services/
│   ├── supabase.types.ts             Shared SupabaseClientLike interface (mockable)
│   ├── results.service.ts            Maps pipeline output → model_predictions DB rows
│   ├── settlement.service.ts         Maps settlement results → pick_results DB rows
│   ├── backtesting.service.ts        Historical replay: pipeline + settlement + metrics
│   └── mlbDailyModel.service.ts      End-to-end daily cycle with stats model integration
│
└── db/
    └── schema.sql                    Supabase/PostgreSQL schema reference (apply manually)

tests/
├── fixtures/
│   └── samplePicks.ts                Shared raw pick fixtures for integration tests
├── odds.engine.test.ts
├── probability.engine.test.ts
├── edge.engine.test.ts
├── pickGrade.engine.test.ts
├── risk.engine.test.ts
├── ranking.engine.test.ts
├── mlbPipeline.test.ts
├── results.service.test.ts
├── settlement.engine.test.ts
├── settlement.service.test.ts
├── backtesting.service.test.ts
├── supabase.config.test.ts
├── oddsApi.adapter.test.ts
├── mlbModel.adapter.test.ts
├── mlbDaily.service.test.ts
├── mlbStatsModel.adapter.test.ts
├── mlbDailyModel.service.test.ts
└── mlbPicks.handler.test.ts
```

---

## How to run tests

Tests use `ts-node` directly — no Jest or npm registry access required.

Run a single suite:

```bash
ts-node --project tsconfig.json tests/mlbPicks.handler.test.ts
```

Run all suites:

```bash
for f in tests/*.test.ts; do
  ts-node --project tsconfig.json "$f"
done
```

Each file prints its own pass/fail summary. Exit code is 1 on any failure.

---

## What is NOT built yet

### Lovable frontend connection
`getMLBPicksHandler()` is built and tested. The next step is wiring the Lovable frontend to call it — no backend logic changes are needed. The handler is already designed to return a JSON-safe response Lovable can render directly.

### Live odds feed connection
`oddsApi.adapter.ts` is built and the URL/normalization are implemented. To go live, set `ODDS_API_KEY` in your environment and call `fetchMLBOdds()` to get real normalized picks. No other code changes needed.

### Real Supabase writes
`supabase.ts` is built. Apply `src/db/schema.sql` to your Supabase project, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env`, and pass `getSupabaseClient()` as the `supabaseClient` parameter with `save: true`.

### Live MLB stat ingestion
`mlbStatsModel.adapter.ts` accepts `TeamGameStats[]` with the full stat schema. The probability formula is deterministic. To connect real stats, build a data ingestion layer that populates `TeamGameStats` from Baseball Reference, Statcast, or a stats API and pass the result to the handler.

### Shin method probability
The probability engine supports `'shin'` and `'power'` as enum options but only `'basic'` normalization is implemented. Shin method is a more accurate vig-removal technique for non-even markets.

### Advanced CLV
Current CLV uses raw implied probability for the closing line. A full implementation would apply vig removal to the closing line before computing the delta.

---

## Next step: connect Lovable frontend

The backend is ready. No backend code changes are needed to connect the frontend.

**What Lovable needs to call:**

```typescript
import { getMLBPicksHandler } from './src/api/mlbPicks.handler';
import { fetchMLBOdds }        from './src/adapters/oddsApi.adapter';
import { getSupabaseClient }   from './src/config/supabase';

// Example: daily picks page load
async function loadTodaysPicks(date: string) {
  // Step 1: fetch live odds (requires ODDS_API_KEY)
  const { picks: normalizedOddsPicks } = await fetchMLBOdds({ markets: ['h2h'] });

  // Step 2: provide today's stats (from your data source)
  const structuredStats = await getTodaysStats(date); // your implementation

  // Step 3: call the handler
  const response = await getMLBPicksHandler({
    date,
    modelVersionId:      'mlb-stats-v1',
    normalizedOddsPicks,
    structuredStats,
    save:                true,           // persist to Supabase
    supabaseClient:      getSupabaseClient(),
  });

  return response; // JSON-safe, ready for any UI framework
}
```

**What Lovable renders from the response:**

| UI element | Response field |
|---|---|
| Pick card list | `response.topPicks` |
| Grade badge (A+/A/B…) | `pick.gradeLetter` |
| Edge percentage | `pick.edgePercent` |
| Risk colour (green/amber/red) | `pick.riskLevel` |
| Odds display | `pick.americanOdds` |
| "Why this pick" tooltip | `pick.edgeTier`, `pick.riskScore` |
| Filter: failed picks | `response.failedPicks` + `pick.failReason` |
| "No odds yet" section | `response.noOddsPicks` |
| Watch list | `response.qualifiedPicks` |
| Stats panel | `response.summary` |
| Error banner | `response.errors` |
| Warning notice | `response.warnings` |

---

## Business rules enforced in code

| Rule | Where enforced |
|---|---|
| No `+1.5` or `+2.5` run lines in Top 5 | `ranking.engine.ts` → `EXCLUDED_RUN_LINE` |
| Live odds = verified odds (no "awaiting verification") | `pickGrade.engine.ts`: `hasLiveOdds` must be `true` |
| No odds → grade 0, `NO_GRADE`, routed to `noOddsPicks` | `pickGrade.engine.ts` + `ranking.engine.ts` |
| Top 5 never padded | `ranking.engine.ts`: returns only what qualifies |
| One pick per game in Top 5 | `ranking.engine.ts`: second pick → `DUPLICATE_GAME` |
| Failed picks stored, not deleted | Every pick exits in exactly one output group |
| `model_version_id` required | `results.service.ts`: throws if blank |
| Risk never defaults to HIGH | `risk.engine.ts`: score starts at 0, rises only with evidence |
| Grade 0 only when `americanOdds` is null | `pickGrade.engine.ts`: enforced by early return gate |
| `DUPLICATE_GAME` tagged, not silently removed | `ranking.engine.ts`: stored in `failedPicks` |
| No invented probability | `mlbModel.adapter.ts`: throws if `modelProbability` is null |
| Probability clamped [35%, 75%] | `mlbStatsModel.adapter.ts`: hard min/max bounds |

---

## Key design decisions

**All engines are pure functions.** No engine imports from another engine except through parameters. Each can be tested in total isolation.

**`SupabaseClientLike` is an interface, not a dependency.** Tests never need real credentials — the fake client is 15 lines.

**`getMLBPicksHandler` never throws.** All errors are captured in `response.errors`. Lovable can always call it safely and check the error array rather than wrapping in try/catch.

**`save: false` is the safe default.** The handler never writes to Supabase unless explicitly told to. Preview mode is always available.

**Failed picks are first-class.** A pick that fails `EDGE_TOO_LOW` is stored with its `failReason` and available to the frontend. Backtesting can measure what would have happened if the threshold were lower.

**`model_version_id` is non-negotiable.** Every prediction row carries a foreign key to `model_versions`. Model results are immutable and never mixed between versions.

**CLV is the long-run signal.** Win rate fluctuates with luck. Consistently beating the closing line is the evidence of real edge.
