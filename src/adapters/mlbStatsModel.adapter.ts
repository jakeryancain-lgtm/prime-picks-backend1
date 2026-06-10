import { buildModelKey, type ModelProbabilityMap } from './mlbModel.adapter';

// =============================================================================
// MLB Stats Model Adapter
// =============================================================================
// Produces modelProbability and confidence for each team/game from structured
// MLB statistics using deterministic weighted formulas.
//
// DESIGN PRINCIPLES:
//   - No external API calls — caller supplies all stats
//   - No invented or guessed probabilities
//   - All formulas are transparent and auditable
//   - Starts at 50% and adjusts based on measurable advantages
//   - Probability clamped to [35%, 75%] — no extreme values
//   - Confidence is earned by data presence and factor agreement
//   - Every output field explains its own calculation
//
// FORMULA OVERVIEW:
//   base = 0.50
//   adjustments += winPctAdj + pitcherAdj + bullpenAdj + opsAdj + formAdj
//                + homeAdj + injuryAdj + weatherAdj
//   raw = base + adjustments
//   probability = clamp(raw, 0.35, 0.75)
//   confidence = baseConfidence(dataPresence) × agreementMultiplier
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────────────────────────────────────

export interface TeamGameStats {
  // ── Identifiers ────────────────────────────────────────────────────────────
  gameId:    string;
  team:      string;
  opponent:  string;
  betType:   string;
  marketType: string;
  /** true = this team is the home team */
  isHome:    boolean;

  // ── Season win percentage ────────────────────────────────────────────────
  /** Team win percentage (0–1). e.g. 0.556 for a 90-win pace team. */
  teamWinPct?:     number;
  /** Opponent win percentage (0–1). */
  opponentWinPct?: number;

  // ── Starting pitcher ERA ─────────────────────────────────────────────────
  /** Team's SP ERA or xERA. Lower is better. */
  spEra?:         number;
  /** Opponent's SP ERA or xERA. */
  opponentSpEra?: number;

  // ── Bullpen ERA ──────────────────────────────────────────────────────────
  /** Team bullpen ERA. */
  bullpenEra?:         number;
  /** Opponent bullpen ERA. */
  opponentBullpenEra?: number;

  // ── Offense: OPS ─────────────────────────────────────────────────────────
  /** Team OPS (on-base + slugging). League average ≈ 0.720. */
  teamOps?:     number;
  /** Opponent OPS. */
  opponentOps?: number;

  // ── Recent form ──────────────────────────────────────────────────────────
  /** Team wins in last 10 games (0–10). */
  recentFormWins?:     number;
  /** Opponent wins in last 10 games (0–10). */
  opponentFormWins?:   number;

  // ── Contextual flags ─────────────────────────────────────────────────────
  /**
   * Injury adjustment for this team (negative = key player out).
   * Range: -0.06 to +0.02. Caller's responsibility to quantify.
   */
  injuryAdjustment?:  number;
  /**
   * Weather adjustment (negative = bad weather hurts offense, lowers implied total).
   * Range: -0.03 to +0.01. Typically negative for wind/rain.
   */
  weatherAdjustment?: number;

  /**
   * Official MLB game status from the Stats API e.g. "Scheduled", "In Progress", "Final".
   * Used by mlbGameFilter.ts to exclude live/final games before ranking.
   */
  gameStatus?:  string;

  /**
   * ISO-8601 UTC game start time from the MLB Stats API.
   * Used by mlbGameFilter.ts to exclude games that have already started by wall-clock time.
   */
  gameDateTime?: string;

  /**
   * Effective sample size for confidence and risk scoring.
   * Populated by mlbStats.ingestion.ts as min(teamGamesPlayed, pitcherSeasonStarts).
   * Falls back to teamGamesPlayed alone when pitcher data is unavailable.
   * Undefined means sample size is unknown — risk engine will not penalise it.
   * Risk engine flags sampleSize < 30 with +10 risk points when it IS defined.
   */
  sampleSize?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output types
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelFactorBreakdown {
  base:           number;
  winPctAdj:      number;
  pitcherAdj:     number;
  bullpenAdj:     number;
  opsAdj:         number;
  formAdj:        number;
  homeAdj:        number;
  injuryAdj:      number;
  weatherAdj:     number;
  rawTotal:       number;
  clampedTotal:   number;
}

export interface ModelProbabilityOutput {
  gameId:           string;
  team:             string;
  opponent:         string;
  betType:          string;
  marketType:       string;
  modelProbability: number;   // always a number, never null
  confidence:       number;   // always a number, never null
  modelVersionId:   string;
  /** Number of factors that had data (max 8). */
  dataPointsUsed:   number;
  /** Number of factors that agreed directionally. */
  factorsAgreeing:  number;
  /** Passed through from TeamGameStats — undefined when not provided by ingestion. */
  sampleSize?:      number;
  factors:          ModelFactorBreakdown;
  /** Human-readable explanation for debugging. */
  explanation:      string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const BASE_PROBABILITY     = 0.50;
const PROB_MIN             = 0.35;
const PROB_MAX             = 0.75;
const HOME_FIELD_ADVANTAGE = 0.025;  // home teams win ~53.5% historically

// Factor weights — how many probability points each maximal advantage is worth
const WEIGHT_WIN_PCT  = 0.08;  // 8% edge for large win% gap
const WEIGHT_PITCHER  = 0.07;  // 7% edge for pitcher ERA gap
const WEIGHT_BULLPEN  = 0.04;  // 4% edge for bullpen ERA gap
const WEIGHT_OPS      = 0.04;  // 4% edge for OPS gap
const WEIGHT_FORM     = 0.04;  // 4% edge for recent form gap

// ─────────────────────────────────────────────────────────────────────────────
// Individual factor calculators
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Win percentage advantage.
 * Difference is scaled so a 20-point win% gap (e.g. .560 vs .440) ≈ WEIGHT_WIN_PCT.
 */
function winPctAdjustment(teamWinPct?: number, opponentWinPct?: number): number {
  if (teamWinPct === undefined || opponentWinPct === undefined) return 0;
  const diff = teamWinPct - opponentWinPct;  // e.g. 0.560 - 0.440 = 0.120
  return (diff / 0.20) * WEIGHT_WIN_PCT;     // normalize to ±WEIGHT_WIN_PCT
}

/**
 * Starting pitcher ERA advantage.
 * A 2-run ERA gap (e.g. 3.00 vs 5.00) ≈ WEIGHT_PITCHER.
 * ERA differential is inverted: lower ERA = better.
 */
function pitcherAdjustment(spEra?: number, opponentSpEra?: number): number {
  if (spEra === undefined || opponentSpEra === undefined) return 0;
  const diff = opponentSpEra - spEra;  // positive when team has better pitcher
  return (diff / 2.0) * WEIGHT_PITCHER;
}

/**
 * Bullpen ERA advantage.
 * A 1.5-run ERA gap (e.g. 3.00 vs 4.50) ≈ WEIGHT_BULLPEN.
 */
function bullpenAdjustment(bullpenEra?: number, opponentBullpenEra?: number): number {
  if (bullpenEra === undefined || opponentBullpenEra === undefined) return 0;
  const diff = opponentBullpenEra - bullpenEra;
  return (diff / 1.5) * WEIGHT_BULLPEN;
}

/**
 * OPS advantage.
 * A 0.060-point OPS gap (e.g. 0.760 vs 0.700) ≈ WEIGHT_OPS.
 */
function opsAdjustment(teamOps?: number, opponentOps?: number): number {
  if (teamOps === undefined || opponentOps === undefined) return 0;
  const diff = teamOps - opponentOps;
  return (diff / 0.060) * WEIGHT_OPS;
}

/**
 * Recent form advantage.
 * A 4-game gap (e.g. 7-3 vs 3-7) ≈ WEIGHT_FORM.
 */
function formAdjustment(recentFormWins?: number, opponentFormWins?: number): number {
  if (recentFormWins === undefined || opponentFormWins === undefined) return 0;
  const diff = recentFormWins - opponentFormWins;  // e.g. 7-3 = +4
  return (diff / 4.0) * WEIGHT_FORM;
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidence calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates confidence from data presence and factor agreement.
 *
 * Base confidence: starts at 0.40 (floor for sparse data), gains 0.075 per
 * data point present (max 8 points → base 1.0 before cap).
 *
 * Agreement multiplier: applied additively when factors agree directionally.
 * More factors pointing the same direction = more confident.
 *
 * Final confidence is clamped to (0, 1) exclusive.
 */
function calculateConfidence(
  dataPointsUsed: number,
  factorsAgreeing: number,
  totalFactors: number,
): number {
  // Base: 0.40 minimum, +0.075 per data point available (up to 8 points)
  const dataBase = 0.40 + Math.min(dataPointsUsed, 8) * 0.075;

  // Agreement bonus: up to +0.10 when ≥60% of factors agree
  const agreementRatio  = totalFactors > 0 ? factorsAgreeing / totalFactors : 0;
  const agreementBonus  = agreementRatio >= 0.6 ? 0.05 : 0;
  const disagreementPenalty = agreementRatio <= 0.3 ? -0.05 : 0;

  const raw = dataBase + agreementBonus + disagreementPenalty;

  // Clamp strictly within (0, 1)
  return Math.min(0.99, Math.max(0.01, raw));
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: calculateModelProbability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates model probability and confidence for a single team-game.
 *
 * All adjustments are additive from a 50% base. Each factor is normalized
 * so its maximum contribution equals its stated weight. Adjustments are
 * clamped before adding so no single extreme stat dominates.
 */
export function calculateModelProbability(
  stats:          TeamGameStats,
  modelVersionId: string,
): ModelProbabilityOutput {
  // ── Individual adjustments ────────────────────────────────────────────────
  const winPctAdj = clampAdj(
    winPctAdjustment(stats.teamWinPct, stats.opponentWinPct),
    WEIGHT_WIN_PCT,
  );
  const pitcherAdj = clampAdj(
    pitcherAdjustment(stats.spEra, stats.opponentSpEra),
    WEIGHT_PITCHER,
  );
  const bullpenAdj = clampAdj(
    bullpenAdjustment(stats.bullpenEra, stats.opponentBullpenEra),
    WEIGHT_BULLPEN,
  );
  const opsAdj = clampAdj(
    opsAdjustment(stats.teamOps, stats.opponentOps),
    WEIGHT_OPS,
  );
  const formAdj = clampAdj(
    formAdjustment(stats.recentFormWins, stats.opponentFormWins),
    WEIGHT_FORM,
  );
  const homeAdj    = stats.isHome ? HOME_FIELD_ADVANTAGE : 0;
  const injuryAdj  = stats.injuryAdjustment  !== undefined
    ? Math.max(-0.06, Math.min(0.02, stats.injuryAdjustment))
    : 0;
  const weatherAdj = stats.weatherAdjustment !== undefined
    ? Math.max(-0.03, Math.min(0.01, stats.weatherAdjustment))
    : 0;

  const rawTotal = BASE_PROBABILITY
    + winPctAdj + pitcherAdj + bullpenAdj
    + opsAdj + formAdj + homeAdj
    + injuryAdj + weatherAdj;

  const clampedTotal = Math.min(PROB_MAX, Math.max(PROB_MIN, rawTotal));

  // ── Data presence and agreement ───────────────────────────────────────────
  const dataFlags = [
    stats.teamWinPct !== undefined && stats.opponentWinPct !== undefined,
    stats.spEra !== undefined && stats.opponentSpEra !== undefined,
    stats.bullpenEra !== undefined && stats.opponentBullpenEra !== undefined,
    stats.teamOps !== undefined && stats.opponentOps !== undefined,
    stats.recentFormWins !== undefined && stats.opponentFormWins !== undefined,
    stats.injuryAdjustment !== undefined,
    stats.weatherAdjustment !== undefined,
    stats.isHome !== undefined,  // always present but count it
  ];

  const dataPointsUsed = dataFlags.filter(Boolean).length;

  // Factor agreements: count factors that push in the same direction as the net
  const netDirection = clampedTotal >= BASE_PROBABILITY ? 1 : -1;
  const adjustments  = [winPctAdj, pitcherAdj, bullpenAdj, opsAdj, formAdj, homeAdj];
  const nonZeroAdjs  = adjustments.filter(a => Math.abs(a) > 0.001);
  const factorsAgreeing = nonZeroAdjs.filter(
    a => Math.sign(a) === netDirection,
  ).length;

  const confidence = calculateConfidence(
    dataPointsUsed,
    factorsAgreeing,
    nonZeroAdjs.length,
  );

  // ── Explanation ───────────────────────────────────────────────────────────
  const parts: string[] = [
    `base 50%`,
    winPctAdj !== 0  ? `winPct ${fmt(winPctAdj)}`   : null,
    pitcherAdj !== 0 ? `pitcher ${fmt(pitcherAdj)}`  : null,
    bullpenAdj !== 0 ? `bullpen ${fmt(bullpenAdj)}`  : null,
    opsAdj !== 0     ? `OPS ${fmt(opsAdj)}`          : null,
    formAdj !== 0    ? `form ${fmt(formAdj)}`        : null,
    homeAdj !== 0    ? `home ${fmt(homeAdj)}`        : null,
    injuryAdj !== 0  ? `injury ${fmt(injuryAdj)}`   : null,
    weatherAdj !== 0 ? `weather ${fmt(weatherAdj)}` : null,
  ].filter((s): s is string => s !== null);

  const explanation =
    `${(clampedTotal * 100).toFixed(1)}% = ${parts.join(' + ')}` +
    (rawTotal !== clampedTotal ? ` (clamped from ${(rawTotal * 100).toFixed(1)}%)` : '');

  return {
    gameId:           stats.gameId,
    team:             stats.team,
    opponent:         stats.opponent,
    betType:          stats.betType,
    marketType:       stats.marketType,
    modelProbability: clampedTotal,
    confidence,
    modelVersionId,
    dataPointsUsed,
    factorsAgreeing,
    sampleSize:       stats.sampleSize,
    explanation,
    factors: {
      base:         BASE_PROBABILITY,
      winPctAdj,
      pitcherAdj,
      bullpenAdj,
      opsAdj,
      formAdj,
      homeAdj,
      injuryAdj,
      weatherAdj,
      rawTotal,
      clampedTotal,
    },
  };
}

/** Clamps a factor adjustment to ±maxWeight so no single factor dominates. */
function clampAdj(value: number, maxWeight: number): number {
  return Math.max(-maxWeight, Math.min(maxWeight, value));
}

/** Formats an adjustment as a signed percentage string e.g. "+3.2%" */
function fmt(adj: number): string {
  const sign = adj >= 0 ? '+' : '';
  return `${sign}${(adj * 100).toFixed(1)}%`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch: buildModelProbabilityMap
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildMapResult {
  map:     ModelProbabilityMap;
  outputs: ModelProbabilityOutput[];
  errors:  Array<{ gameId: string; team: string; message: string }>;
}

/**
 * Converts an array of TeamGameStats into a ModelProbabilityMap compatible
 * with mlbModel.adapter.ts.
 *
 * Each entry is keyed by buildModelKey(gameId, team, betType, marketType).
 * Errors on individual entries are captured without crashing the batch.
 */
export function buildModelProbabilityMap(
  statsList:      TeamGameStats[],
  modelVersionId: string,
): BuildMapResult {
  const map:     ModelProbabilityMap          = {};
  const outputs: ModelProbabilityOutput[]     = [];
  const errors:  BuildMapResult['errors']     = [];

  for (const stats of statsList) {
    try {
      const output = calculateModelProbability(stats, modelVersionId);
      const key    = buildModelKey(
        output.gameId,
        output.team,
        output.betType,
        output.marketType,
      );
      map[key] = {
        modelProbability: output.modelProbability,
        confidence:       output.confidence,
        modelVersionId:   output.modelVersionId,
        sampleSize:       output.sampleSize,
      };
      outputs.push(output);
    } catch (e: unknown) {
      errors.push({
        gameId:  stats.gameId,
        team:    stats.team,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { map, outputs, errors };
}
