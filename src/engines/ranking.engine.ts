import type { FailReason, PickStatus } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Minimum shape a pick must have for the ranking engine to process it. */
export interface RankablePick {
  id: string;
  gameId: string;
  betType: string;
  /** +1.5, +2.5, -1.5, -2.5 — only set when betType is 'run_line'. */
  runLineSpread?: number | null;
  /** American odds. Null or undefined = no live odds. */
  americanOdds: number | null | undefined;
  /** Edge from edge.engine (decimal). */
  edgeDecimal: number;
  /** Model confidence (0–1). */
  confidence: number;
  /** Pre-game grade numeric score (0–100). */
  gradeNumeric: number;
  /** Risk level from risk.engine. */
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  /** Current status — may have been pre-set; ranking engine may update it. */
  status?: PickStatus;
  /** Existing failReason if any — ranking engine adds its own. */
  failReason?: FailReason;
}

export interface RankingConfig {
  /** Maximum number of top picks to return. Default: 5. */
  maxTopPicks?: number;
  /** Minimum edge for a pick to qualify. Default: 0.03. */
  minimumEdge?: number;
  /**
   * Absolute value of the most negative American odds allowed.
   * Picks with odds more negative than this are BAD_ODDS_RANGE.
   * Default: -170 (stored as -170; comparison: odds < maxNegativeOdds).
   */
  maxNegativeOdds?: number;
}

export interface RankedOutput<T extends RankablePick> {
  /** ≤ maxTopPicks. No +1.5/+2.5 run lines. One pick per gameId. Sorted by grade → edge → confidence. */
  topPicks: T[];
  /** Passed all filters but didn't make Top N (overflow or at-capacity cutoff). */
  qualifiedPicks: T[];
  /** status === FAILED_FILTER. Always stored. Never in Top N. */
  failedPicks: T[];
  /** No live odds. grade === 0 by convention. */
  noOddsPicks: T[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOP_PICKS    = 5;
const DEFAULT_MIN_EDGE         = 0.03;
const DEFAULT_MAX_NEGATIVE_ODDS = -170;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function isExcludedRunLine(pick: RankablePick): boolean {
  if (pick.betType !== 'run_line') return false;
  const spread = pick.runLineSpread;
  return spread === 1.5 || spread === 2.5;
}

function markFailed<T extends RankablePick>(pick: T, reason: FailReason): T {
  return { ...pick, status: 'FAILED_FILTER' as PickStatus, failReason: reason };
}

function markNoOdds<T extends RankablePick>(pick: T): T {
  return { ...pick, status: 'NO_ODDS' as PickStatus };
}

function markQualified<T extends RankablePick>(pick: T): T {
  return { ...pick, status: 'QUALIFIED' as PickStatus };
}

/**
 * Comparator: sorts qualified picks by gradeNumeric DESC, then edgeDecimal DESC,
 * then confidence DESC. Higher is always better.
 */
function qualifiedComparator(a: RankablePick, b: RankablePick): number {
  if (b.gradeNumeric !== a.gradeNumeric) return b.gradeNumeric - a.gradeNumeric;
  if (b.edgeDecimal  !== a.edgeDecimal)  return b.edgeDecimal  - a.edgeDecimal;
  return b.confidence - a.confidence;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core ranking function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Organises pre-scored picks into four mutually exclusive groups.
 *
 * This engine does NOT calculate odds, edge, risk, or grade.
 * It only classifies and sorts picks that have already been scored.
 *
 * Processing order (each pick takes the first matching path):
 *   1. No live odds → noOddsPicks
 *   2. BAD_ODDS_RANGE (odds too negative) → failedPicks
 *   3. EXCLUDED_RUN_LINE (+1.5 / +2.5 spread) → failedPicks
 *   4. EDGE_TOO_LOW (edge < minimumEdge) → failedPicks
 *   5. HIGH_RISK → failedPicks
 *   6. Otherwise → qualified pool
 *
 * From the qualified pool:
 *   - Sort by gradeNumeric DESC, edgeDecimal DESC, confidence DESC
 *   - Take first maxTopPicks unique gameIds → topPicks
 *   - Second pick from a game already in topPicks → failedPicks (DUPLICATE_GAME)
 *   - Remaining qualified picks that didn't make top → qualifiedPicks
 *
 * No pick is ever deleted. Every input pick appears in exactly one output group.
 */
export function rankPicks<T extends RankablePick>(
  picks: T[],
  config: RankingConfig = {},
): RankedOutput<T> {
  const maxTopPicks     = config.maxTopPicks     ?? DEFAULT_MAX_TOP_PICKS;
  const minimumEdge     = config.minimumEdge     ?? DEFAULT_MIN_EDGE;
  const maxNegativeOdds = config.maxNegativeOdds ?? DEFAULT_MAX_NEGATIVE_ODDS;

  const topPicks:     T[] = [];
  const qualifiedPicks: T[] = [];
  const failedPicks:  T[] = [];
  const noOddsPicks:  T[] = [];

  // ── Pass 1: classify each pick into a preliminary bucket ──────────────────
  const qualifiedPool: T[] = [];

  for (const pick of picks) {
    // 1. No live odds
    if (pick.americanOdds === null || pick.americanOdds === undefined) {
      noOddsPicks.push(markNoOdds(pick));
      continue;
    }

    // 2. Bad odds range — only applies to negative (favourite) odds
    if (pick.americanOdds < maxNegativeOdds) {
      failedPicks.push(markFailed(pick, 'BAD_ODDS_RANGE'));
      continue;
    }

    // 3. Excluded run line (+1.5 or +2.5)
    if (isExcludedRunLine(pick)) {
      failedPicks.push(markFailed(pick, 'EXCLUDED_RUN_LINE'));
      continue;
    }

    // 4. Edge too low
    if (pick.edgeDecimal < minimumEdge) {
      failedPicks.push(markFailed(pick, 'EDGE_TOO_LOW'));
      continue;
    }

    // 5. High risk
    if (pick.riskLevel === 'HIGH') {
      failedPicks.push(markFailed(pick, 'HIGH_RISK'));
      continue;
    }

    // 6. Qualified
    qualifiedPool.push(markQualified(pick));
  }

  // ── Pass 2: sort qualified pool ───────────────────────────────────────────
  qualifiedPool.sort(qualifiedComparator);

  // ── Pass 3: select top picks (one per game, up to maxTopPicks) ────────────
  const seenGameIds = new Set<string>();

  for (const pick of qualifiedPool) {
    if (topPicks.length >= maxTopPicks) {
      // At capacity — remaining qualified picks go to qualifiedPicks overflow
      qualifiedPicks.push(pick);
      continue;
    }

    if (seenGameIds.has(pick.gameId)) {
      // Second pick from same game → DUPLICATE_GAME
      failedPicks.push(markFailed(pick, 'DUPLICATE_GAME'));
      continue;
    }

    seenGameIds.add(pick.gameId);
    topPicks.push(pick);
  }

  return { topPicks, qualifiedPicks, failedPicks, noOddsPicks };
}
