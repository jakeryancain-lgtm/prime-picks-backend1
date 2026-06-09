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
export function mapPredictionToDbRow(pick: ProcessedMLBPick): ModelPredictionRow {
  if (!pick.modelVersionId || pick.modelVersionId.trim() === '') {
    throw new Error(
      `mapPredictionToDbRow: pick ${pick.id} is missing modelVersionId. ` +
      'Every prediction must be linked to a model version.',
    );
  }

  return {
    model_version_id:       pick.modelVersionId,
    game_id:                pick.gameId,
    sport:                  'MLB',
    league:                 'MLB',
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
  output: RankedOutput<ProcessedMLBPick>,
): ModelPredictionRow[] {
  const allPicks: ProcessedMLBPick[] = [
    ...output.topPicks,
    ...output.qualifiedPicks,
    ...output.failedPicks,
    ...output.noOddsPicks,
  ];

  return allPicks.map(mapPredictionToDbRow);
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveResult {
  savedCount: number;
  errors: Array<{ message: string; code?: string }>;
}

/**
 * Persists all rows to the model_predictions table via the provided client.
 *
 * Inserts are batched in a single call. If the insert fails, the error is
 * returned in the errors array rather than thrown, so the caller can decide
 * how to handle partial failures.
 *
 * @param rows    Already-mapped DB rows from mapPipelineOutputToDbRows()
 * @param client  Any SupabaseClientLike — real Supabase client or fake in tests
 */
export async function savePredictions(
  rows: ModelPredictionRow[],
  client: SupabaseClientLike,
): Promise<SaveResult> {
  if (rows.length === 0) {
    return { savedCount: 0, errors: [] };
  }

  const { data, error } = await client.from('model_predictions').insert(rows);

  if (error) {
    return {
      savedCount: 0,
      errors: [{ message: error.message, code: error.code }],
    };
  }

  return {
    savedCount: data?.length ?? rows.length,
    errors: [],
  };
}
