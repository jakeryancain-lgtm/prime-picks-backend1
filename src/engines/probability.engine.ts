import { americanToRawImpliedProbability } from './odds.engine';
import type { AmericanOdds, ImpliedProbabilityResult, VigMethod } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Single-side raw implied probability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the raw implied probability for a single American odds line.
 * This retains the bookmaker's vig — use calculateNoVigProbability for
 * vig-removed probabilities.
 *
 * Delegates to odds.engine to avoid duplicating the formula.
 *
 * @throws if odds are invalid (0, between -100 and +100 exclusive, NaN, etc.)
 */
export function calculateRawProbability(odds: AmericanOdds): number {
  return americanToRawImpliedProbability(odds);
}

// ─────────────────────────────────────────────────────────────────────────────
// Market overround
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates the total overround (vig) of a two-sided market.
 *
 * In a fair market the two raw probabilities would sum to exactly 1.0.
 * Any excess above 1.0 is the bookmaker's margin.
 *
 * overround = rawProbSide1 + rawProbSide2
 * vig       = overround - 1.0
 *
 * Example: -110 / -110 market
 *   raw(-110) = 110/220 ≈ 0.5238
 *   overround = 0.5238 + 0.5238 = 1.0476
 *   vig       = 0.0476 ≈ 4.76%
 *
 * @throws if either set of odds is invalid
 */
export function calculateOverround(oddsA: AmericanOdds, oddsB: AmericanOdds): number {
  return calculateRawProbability(oddsA) + calculateRawProbability(oddsB);
}

// ─────────────────────────────────────────────────────────────────────────────
// Vig removal — basic normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Removes the bookmaker's vig from a two-sided market using simple normalization.
 *
 * Formula:
 *   noVigProb(side) = rawProb(side) / overround
 *
 * The two resulting probabilities will sum to exactly 1.0.
 *
 * This is the "basic" / "multiplicative" vig-removal method. It is the
 * simplest defensible approach and makes both sides equally responsible for
 * carrying the vig — appropriate for balanced markets (moneylines, run lines,
 * totals with symmetric juice).
 *
 * Applies to:
 *   - Moneyline (team A vs team B)
 *   - Run line (-1.5 / +1.5  or  -2.5 / +2.5)
 *   - Total (over / under)
 *
 * @param oddsA  American odds for side A (favourite or over or home)
 * @param oddsB  American odds for side B (underdog or under or away)
 * @returns      Result for side A (use symmetry for side B: 1 - noVigProb)
 *
 * @throws if either set of odds is invalid
 */
export function calculateNoVigProbability(
  oddsA: AmericanOdds,
  oddsB: AmericanOdds,
): ImpliedProbabilityResult {
  const rawA = calculateRawProbability(oddsA);
  const rawB = calculateRawProbability(oddsB);
  const overround = rawA + rawB;
  const vig = overround - 1;

  // noVigProb normalizes side A's raw probability against the full overround
  const noVigProb = rawA / overround;

  return {
    impliedProbability: noVigProb,
    vig,
    method: 'basic' as VigMethod,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-side result (no opposite line available)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * When only one side of a market is available (e.g. a prop with no listed
 * opposite), returns the raw probability without vig removal.
 *
 * vig is reported as undefined because it cannot be computed from one side.
 * method is reported as 'basic' for consistency.
 *
 * Callers should treat this probability as an upper bound — it is inflated
 * by an unknown amount of vig.
 *
 * @throws if odds are invalid
 */
export function calculateSingleSideProbability(odds: AmericanOdds): ImpliedProbabilityResult {
  return {
    impliedProbability: calculateRawProbability(odds),
    vig: 0,
    method: 'basic' as VigMethod,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: both sides in one call
// ─────────────────────────────────────────────────────────────────────────────

export interface TwoSidedProbabilityResult {
  sideA: ImpliedProbabilityResult;
  sideB: ImpliedProbabilityResult;
  overround: number;
  vig: number;
}

/**
 * Calculates vig-removed probabilities for both sides of a market simultaneously.
 *
 * Guarantees: sideA.impliedProbability + sideB.impliedProbability === 1.0
 *
 * @throws if either set of odds is invalid
 */
export function calculateTwoSidedProbability(
  oddsA: AmericanOdds,
  oddsB: AmericanOdds,
): TwoSidedProbabilityResult {
  const rawA = calculateRawProbability(oddsA);
  const rawB = calculateRawProbability(oddsB);
  const overround = rawA + rawB;
  const vig = overround - 1;

  const noVigA = rawA / overround;
  const noVigB = rawB / overround;

  return {
    sideA: { impliedProbability: noVigA, vig, method: 'basic' },
    sideB: { impliedProbability: noVigB, vig, method: 'basic' },
    overround,
    vig,
  };
}
