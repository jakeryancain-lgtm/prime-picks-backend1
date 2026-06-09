import type { EdgeResult } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type EdgeTier = 'NEGATIVE' | 'LOW' | 'MEDIUM' | 'HIGH' | 'ELITE';

export interface EdgeInput {
  modelProbability: number;
  /** Raw implied probability (with vig). Used only when noVigProbability is absent. */
  rawImpliedProbability?: number;
  /** Vig-removed implied probability. Preferred over rawImpliedProbability when present. */
  noVigImpliedProbability?: number;
  /** Minimum edge required to qualify. Defaults to DEFAULT_MIN_EDGE (0.03). */
  minEdgeThreshold?: number;
}

export interface EdgeCalculation extends EdgeResult {
  /** edgeDecimal is the same as edge — explicit alias for clarity in consumers. */
  edgeDecimal: number;
  /** Edge expressed as a percentage (e.g. 0.05 → 5.00). */
  edgePercent: number;
  hasPositiveEdge: boolean;
  edgeTier: EdgeTier;
  /** Which probability was used: 'no-vig' | 'raw' */
  probabilitySource: 'no-vig' | 'raw';
  /** The implied probability value that was actually used in the calculation. */
  impliedProbabilityUsed: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_MIN_EDGE = 0.03;

// Edge tier boundaries (inclusive lower, exclusive upper except ELITE)
const TIER_LOW_MIN    = 0;
const TIER_MEDIUM_MIN = 0.02;
const TIER_HIGH_MIN   = 0.04;
const TIER_ELITE_MIN  = 0.07;

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function validateProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(
      `Invalid ${label}: ${value}. Must be a finite number strictly between 0 and 1.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge tier
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a numeric edge value to a descriptive tier.
 *
 * NEGATIVE : edge < 0
 * LOW      : 0.0000 – 0.0199
 * MEDIUM   : 0.0200 – 0.0399
 * HIGH     : 0.0400 – 0.0699
 * ELITE    : 0.0700+
 */
export function getEdgeTier(edge: number): EdgeTier {
  if (edge < TIER_LOW_MIN)    return 'NEGATIVE';
  if (edge < TIER_MEDIUM_MIN) return 'LOW';
  if (edge < TIER_HIGH_MIN)   return 'MEDIUM';
  if (edge < TIER_ELITE_MIN)  return 'HIGH';
  return 'ELITE';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates edge for a single pick.
 *
 * Edge = modelProbability − impliedProbability
 *
 * Probability selection (in priority order):
 *   1. noVigImpliedProbability — preferred, represents the true market price
 *   2. rawImpliedProbability   — fallback when no-vig is unavailable
 *
 * At least one of rawImpliedProbability or noVigImpliedProbability must be
 * provided, otherwise an error is thrown.
 *
 * This function only calculates and tags. It never discards or filters picks.
 * The meetsMinimumEdge flag is informational — ranking.engine enforces the
 * filter and stores the pick as FAILED_FILTER if it doesn't qualify.
 *
 * @throws if modelProbability is not in (0, 1)
 * @throws if the resolved implied probability is not in (0, 1)
 * @throws if neither implied probability is provided
 */
export function calculateEdge(input: EdgeInput): EdgeCalculation {
  const {
    modelProbability,
    rawImpliedProbability,
    noVigImpliedProbability,
    minEdgeThreshold = DEFAULT_MIN_EDGE,
  } = input;

  // Validate model probability
  validateProbability(modelProbability, 'modelProbability');

  // Resolve which implied probability to use
  let impliedProbabilityUsed: number;
  let probabilitySource: 'no-vig' | 'raw';

  if (noVigImpliedProbability !== undefined) {
    validateProbability(noVigImpliedProbability, 'noVigImpliedProbability');
    impliedProbabilityUsed = noVigImpliedProbability;
    probabilitySource = 'no-vig';
  } else if (rawImpliedProbability !== undefined) {
    validateProbability(rawImpliedProbability, 'rawImpliedProbability');
    impliedProbabilityUsed = rawImpliedProbability;
    probabilitySource = 'raw';
  } else {
    throw new Error(
      'calculateEdge requires at least one of rawImpliedProbability or noVigImpliedProbability.',
    );
  }

  // Core edge formula
  const edge = modelProbability - impliedProbabilityUsed;
  const edgePercent = parseFloat((edge * 100).toFixed(4));
  const hasPositiveEdge = edge > 0;
  const meetsMinimum = edge >= minEdgeThreshold;
  const tier = getEdgeTier(edge);

  return {
    // EdgeResult fields
    edge,
    modelProbability,
    impliedProbability: impliedProbabilityUsed,
    meetsThreshold: meetsMinimum,
    threshold: minEdgeThreshold,
    // EdgeCalculation extensions
    edgeDecimal: edge,
    edgePercent,
    hasPositiveEdge,
    edgeTier: tier,
    probabilitySource,
    impliedProbabilityUsed,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: produce edge from both probability inputs explicitly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates edge twice — once using raw implied probability and once using
 * no-vig implied probability — and returns both for comparison.
 *
 * Useful in backtesting to measure the impact of vig removal on edge estimates.
 */
export interface DualEdgeResult {
  noVig: EdgeCalculation;
  raw: EdgeCalculation;
  /** Difference: noVig.edge − raw.edge. Positive means vig removal increased edge. */
  vigImpact: number;
}

export function calculateDualEdge(
  modelProbability: number,
  rawImpliedProbability: number,
  noVigImpliedProbability: number,
  minEdgeThreshold = DEFAULT_MIN_EDGE,
): DualEdgeResult {
  const noVig = calculateEdge({
    modelProbability,
    noVigImpliedProbability,
    minEdgeThreshold,
  });
  const raw = calculateEdge({
    modelProbability,
    rawImpliedProbability,
    minEdgeThreshold,
  });
  return {
    noVig,
    raw,
    vigImpact: noVig.edge - raw.edge,
  };
}
