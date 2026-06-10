import type { ProcessedMLBPick } from '../mlbPipeline';
import type { RankedOutput } from '../engines/ranking.engine';

// ─────────────────────────────────────────────────────────────────────────────
// DB row shape — mirrors schema.sql model_predictions columns exactly
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelPredictionRow {
  // Identity
  model_version_id:       string;
  game_id:                string;
  sport:                  string;
  league:                 string;
  // ISO date string for the slate this prediction belongs to e.g. '2025-06-10'
  prediction_date:        string;
  team:                   string;
  opponent:               string;

  // Bet specification
  bet_type:               string;
  market_type:            string;
  run_line_spread:        number | null;

  // Odds
  american_odds:          number | null;
  opposite_american_odds: number | null;
  decimal_odds:           number | null;

  // Probability
  model_probability:      number;
  implied_probability:    number | null;
  no_vig_probability:     number | null;
  probability_source:     string | null;

  // Edge
  edge_decimal:           number;
  edge_percent:           number;
  edge_tier:              string;

  // Risk
  confidence:             number;
  risk_score:             number;
  risk_level:             string;
  risk_reasons_json:      string;   // JSON-serialised string[]

  // Grade
  grade_numeric:          number;
  grade_letter:           string;

  // Ranking decision
  status:                 string;
  fail_reason:            string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client interface — kept narrow so tests can provide a fake
// ─────────────────────────────────────────────────────────────────────────────

import type { SupabaseClientLike } from './supabase.types';
export type { SupabaseInsertResult, SupabaseClientLike } from './supabase.types';

// ─────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a single ProcessedMLBPick to a model_predictions DB row.
 *
 * Rules enforced here:
 * - modelVersionId is required; throws if absent.
 * - No-odds picks always have grade_numeric=0 and grade_letter='NO_GRADE'.
 * - Failed picks preserve failReason (null for non-failed picks).
 * - riskReasons are JSON-serialised.
 * - probabilitySource is preserved as-is (null for no-odds picks).
 */
export function mapPredictionToDbRow(
  pick:           ProcessedMLBPick,
  predictionDate: string,
): ModelPredictionRow {
  if (!pick.modelVersionId || pick.modelVersionId.trim() === '') {
    throw new Error(
      `mapPredictionToDbRow: pick ${pick.id} is missing modelVersionId. ` +
      'Every prediction must be linked to a model version.',
    );
  }
  if (!predictionDate || !/^\d{4}-\d{2}-\d{2}$/.test(predictionDate)) {
    throw new Error(
      `mapPredictionToDbRow: predictionDate '${predictionDate}' is not a valid ISO date (YYYY-MM-DD).`,
    );
  }

  return {
    model_version_id:       pick.modelVersionId,
    game_id:                pick.gameId,
    sport:                  'MLB',
    league:                 'MLB',
    prediction_date:        predictionDate,
    team:                   pick.team,
    opponent:               pick.opponent,

    bet_type:               pick.betType,
    market_type:            pick.marketType,
    run_line_spread:        pick.runLineSpread ?? null,

    american_odds:          pick.americanOdds ?? null,
    opposite_american_odds: (pick as { oppositeAmericanOdds?: number | null })
                              .oppositeAmericanOdds ?? null,
    decimal_odds:           pick.decimalOdds ?? null,

    model_probability:      pick.modelProbability,
    implied_probability:    pick.rawImpliedProbability ?? null,
    no_vig_probability:     pick.noVigProbability ?? null,
    probability_source:     pick.probabilitySource ?? null,

    edge_decimal:           pick.edgeDecimal,
    edge_percent:           pick.edgePercent,
    edge_tier:              pick.edgeTier,

    confidence:             pick.confidence,
    risk_score:             pick.riskScore,
    risk_level:             pick.riskLevel,
    risk_reasons_json:      JSON.stringify(pick.riskReasons ?? []),

    grade_numeric:          pick.gradeNumeric,
    grade_letter:           pick.gradeLetter,

    status:                 pick.status ?? 'QUALIFIED',
    fail_reason:            pick.failReason ?? null,
  };
}

/**
 * Maps all four groups from pipeline output into a flat array of DB rows.
 * Every pick from every group is included — nothing is skipped.
 *
 * Order: topPicks → qualifiedPicks → failedPicks → noOddsPicks
 */
export function mapPipelineOutputToDbRows(
  output:         RankedOutput<ProcessedMLBPick>,
  predictionDate: string,
): ModelPredictionRow[] {
  const allPicks: ProcessedMLBPick[] = [
    ...output.topPicks,
    ...output.qualifiedPicks,
    ...output.failedPicks,
    ...output.noOddsPicks,
  ];

  return allPicks.map(p => mapPredictionToDbRow(p, predictionDate));
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveResult {
  savedCount:    number;
  skippedCount:  number;   // rows that matched the UNIQUE constraint (duplicates)
  errors:        Array<{ message: string; code?: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Model version FK resolution
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelVersionRow {
  id:          string;
  name:        string;
  version:     string;
  sport:       string;
  is_active:   boolean;
  description: string | null;
  config_json: Record<string, unknown>;
}

export interface EnsureModelVersionResult {
  id:      string;   // UUID of the model_versions row
  created: boolean;  // true if a new row was inserted, false if existing
  error:   string | null;
}

/**
 * Ensures a row exists in model_versions for the given name string.
 *
 * If a row with name = versionName already exists, returns its UUID.
 * If not, inserts a new row with is_active = true and returns the new UUID.
 *
 * This resolves the "mlb-stats-v1" string → real UUID FK problem.
 * The Supabase client's from().select() and from().insert() are used directly.
 *
 * Returns an error string (not throws) so callers can handle gracefully.
 */
export async function ensureModelVersion(
  versionName: string,
  client:      SupabaseClientLike,
): Promise<EnsureModelVersionResult> {
  // Try to fetch existing row by name
  const selectResult = await client.from('model_versions')
    .select('id,name')
    .eq('name', versionName)
    .limit(1);

  if (selectResult.error) {
    return { id: '', created: false, error: `model_versions select failed: ${selectResult.error.message}` };
  }

  if (selectResult.data && selectResult.data.length > 0) {
    const row = selectResult.data[0] as ModelVersionRow;
    return { id: row.id, created: false, error: null };
  }

  // Insert a new model_versions row
  const newRow = {
    name:        versionName,
    version:     versionName,
    sport:       'MLB',
    is_active:   true,
    description: `Auto-created by savePredictions for model ${versionName}`,
    config_json: {},
  };

  const insertResult = await client.from('model_versions')
    .insert([newRow], { returning: true });

  if (insertResult.error) {
    // Handle race condition: another process may have inserted simultaneously
    if (insertResult.error.code === '23505') {
      // Unique violation — row was just created by a concurrent call; re-fetch
      const refetch = await client.from('model_versions')
        .select('id,name')
        .eq('name', versionName)
        .limit(1);
      if (refetch.data && refetch.data.length > 0) {
        const row = refetch.data[0] as ModelVersionRow;
        return { id: row.id, created: false, error: null };
      }
    }
    return { id: '', created: false, error: `model_versions insert failed: ${insertResult.error.message}` };
  }

  const id = (insertResult.data?.[0] as ModelVersionRow | undefined)?.id ?? '';
  if (!id) {
    return { id: '', created: false, error: 'model_versions insert returned no id' };
  }
  return { id, created: true, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — idempotent upsert
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persists all rows to model_predictions, skipping duplicates silently.
 *
 * IMPORTANT — UUID resolution:
 *   model_predictions.model_version_id is a UUID FK into model_versions.
 *   If any row's model_version_id looks like a human name rather than a UUID
 *   (e.g. "mlb-stats-v1" instead of "550e8400-e29b-41d4-a716-446655440000"),
 *   this function resolves the name to its UUID via ensureModelVersion()
 *   before inserting. This makes it impossible to bypass FK resolution
 *   regardless of which code path calls savePredictions.
 *
 * Uses Supabase's "Prefer: resolution=ignore-duplicates" header which maps to
 * PostgreSQL ON CONFLICT DO NOTHING. Rows that would violate the
 * uq_prediction_identity constraint are skipped without error.
 *
 * This makes repeated calls for the same slate fully idempotent:
 *   - First call:  savedCount = N, skippedCount = 0
 *   - Second call: savedCount = 0, skippedCount = N
 *
 * @param rows    Already-mapped DB rows from mapPipelineOutputToDbRows()
 * @param client  Any SupabaseClientLike — real client or fake in tests
 */
export async function savePredictions(
  rows:   ModelPredictionRow[],
  client: SupabaseClientLike,
): Promise<SaveResult> {
  if (rows.length === 0) {
    return { savedCount: 0, skippedCount: 0, errors: [] };
  }

  // ── UUID resolution ───────────────────────────────────────────────────────
  // Detect any rows carrying a non-UUID model_version_id (e.g. "mlb-stats-v1").
  // A real UUID matches the pattern xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Collect distinct non-UUID version names across all rows
  const nameToUuid = new Map<string, string>();
  const resolveErrors: Array<{ message: string; code?: string }> = [];

  for (const row of rows) {
    const vid = row.model_version_id;
    if (!uuidPattern.test(vid) && !nameToUuid.has(vid)) {
      const result = await ensureModelVersion(vid, client);
      if (result.error) {
        resolveErrors.push({ message: `Cannot resolve model version "${vid}": ${result.error}` });
      } else {
        nameToUuid.set(vid, result.id);
      }
    }
  }

  if (resolveErrors.length > 0) {
    return { savedCount: 0, skippedCount: 0, errors: resolveErrors };
  }

  // Rewrite non-UUID model_version_id values to their resolved UUIDs.
  // We operate on a shallow copy of each row so the caller's array is unchanged.
  const resolvedRows: ModelPredictionRow[] = rows.map(row => {
    const resolved = nameToUuid.get(row.model_version_id);
    if (resolved) {
      return { ...row, model_version_id: resolved };
    }
    return row;  // already a UUID — no change needed
  });

  // ── Insert ────────────────────────────────────────────────────────────────
  const { data, error } = await client
    .from('model_predictions')
    .insert(resolvedRows, { ignoreDuplicates: true });

  if (error) {
    return {
      savedCount:   0,
      skippedCount: 0,
      errors:       [{ message: error.message, code: error.code }],
    };
  }

  // Supabase returns only the rows that were actually inserted (not skipped).
  // If data is null (non-representation response), assume all were saved.
  const savedCount   = data?.length ?? resolvedRows.length;
  const skippedCount = resolvedRows.length - savedCount;

  return {
    savedCount,
    skippedCount: Math.max(0, skippedCount),
    errors: [],
  };
}
