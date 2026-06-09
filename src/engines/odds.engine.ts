import type { AmericanOdds, DecimalOdds, FractionalOdds, OddsConversion } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * American odds must be an integer, ≥ +100 or ≤ -100.
 * 0, -1 through -99, and +1 through +99 are invalid.
 */
export function isValidAmericanOdds(odds: number): boolean {
  if (!Number.isFinite(odds)) return false;
  if (odds === 0) return false;
  if (odds > 0 && odds < 100) return false;
  if (odds < 0 && odds > -100) return false;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// American → Decimal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts American odds to decimal odds.
 *
 * Positive (underdog): decimal = (odds / 100) + 1
 * Negative (favourite): decimal = (100 / |odds|) + 1
 *
 * Decimal odds are always > 1.0.
 */
export function americanToDecimal(odds: AmericanOdds): DecimalOdds {
  if (!isValidAmericanOdds(odds)) {
    throw new Error(`Invalid American odds: ${odds}. Must be ≥ +100 or ≤ -100.`);
  }
  if (odds > 0) {
    return odds / 100 + 1;
  }
  return 100 / Math.abs(odds) + 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decimal → American
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts decimal odds back to American odds.
 *
 * Decimal ≥ 2.0 → underdog: (decimal - 1) * 100
 * Decimal < 2.0 → favourite: -100 / (decimal - 1)
 *
 * Returns a rounded integer.
 */
export function decimalToAmerican(decimal: DecimalOdds): AmericanOdds {
  if (!Number.isFinite(decimal) || decimal <= 1) {
    throw new Error(`Invalid decimal odds: ${decimal}. Must be > 1.0.`);
  }
  if (decimal >= 2) {
    return Math.round((decimal - 1) * 100);
  }
  return Math.round(-100 / (decimal - 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// American → Fractional
// ─────────────────────────────────────────────────────────────────────────────

/** Greatest common divisor via Euclidean algorithm. */
function gcd(a: number, b: number): number {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a === 0 ? 1 : a;
}

/**
 * Converts American odds to fractional odds.
 *
 * Positive (underdog): numerator = odds, denominator = 100
 * Negative (favourite): numerator = 100, denominator = |odds|
 *
 * Both are reduced by their GCD.
 */
export function americanToFractional(odds: AmericanOdds): FractionalOdds {
  if (!isValidAmericanOdds(odds)) {
    throw new Error(`Invalid American odds: ${odds}. Must be ≥ +100 or ≤ -100.`);
  }
  let numerator: number;
  let denominator: number;

  if (odds > 0) {
    numerator = odds;
    denominator = 100;
  } else {
    numerator = 100;
    denominator = Math.abs(odds);
  }

  const divisor = gcd(numerator, denominator);
  return {
    numerator: numerator / divisor,
    denominator: denominator / divisor,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw implied probability (before vig removal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the raw implied probability from American odds.
 * This retains the bookmaker's margin (vig). Use probability.engine for vig removal.
 *
 * Positive (underdog): prob = 100 / (odds + 100)
 * Negative (favourite): prob = |odds| / (|odds| + 100)
 */
export function americanToRawImpliedProbability(odds: AmericanOdds): number {
  if (!isValidAmericanOdds(odds)) {
    throw new Error(`Invalid American odds: ${odds}. Must be ≥ +100 or ≤ -100.`);
  }
  if (odds > 0) {
    return 100 / (odds + 100);
  }
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full conversion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts American odds into all formats simultaneously.
 * This is the primary function callers should use.
 *
 * @throws if odds are invalid (e.g. 0, +50, -75)
 */
export function convertOdds(odds: AmericanOdds): OddsConversion {
  return {
    american: odds,
    decimal: americanToDecimal(odds),
    fractional: americanToFractional(odds),
    rawImpliedProbability: americanToRawImpliedProbability(odds),
  };
}
