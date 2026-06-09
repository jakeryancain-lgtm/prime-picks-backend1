import type { RiskLevel } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type MarketType = 'moneyline' | 'run_line' | 'total';
export type BetType    = 'moneyline' | 'run_line' | 'total_over' | 'total_under';

export interface RiskInput {
  /** American odds for the selected side. Required — odds are the anchor of risk. */
  americanOdds: number;
  /** Edge from edge.engine (decimal). */
  edgeDecimal: number;
  /** Model confidence 0–1. */
  confidence: number;
  /** Market type. */
  marketType: MarketType;
  /** Bet type. */
  betType: BetType;
  /**
   * Line movement as a percentage change since open.
   * Negative = line moved against this side (bad for the bettor).
   * e.g. -5 means the line moved 5% against us since open.
   */
  lineMovementPercent?: number;
  /**
   * Number of games in the model's training sample for this context.
   * Omitting means unknown — treated neutrally, not as small.
   */
  sampleSize?: number;
  /** True if a key player injury is flagged for this game. */
  injuryFlag?: boolean;
  /** True if adverse weather conditions are flagged (wind, rain, etc.). */
  weatherFlag?: boolean;
}

export interface RiskResult {
  riskScore: number;
  riskLevel: RiskLevel;
  /** Human-readable explanations for each factor that raised risk. */
  riskReasons: string[];
  /** Per-factor contributions for transparency. */
  factors: {
    juicePoints:          number;
    edgePoints:           number;
    confidencePoints:     number;
    samplePoints:         number;
    lineMovementPoints:   number;
    injuryPoints:         number;
    weatherPoints:        number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Thresholds & point values
// ─────────────────────────────────────────────────────────────────────────────

// Factor thresholds
const JUICE_THRESHOLD            = -170;   // American odds worse than this = heavy juice
const EDGE_LOW_THRESHOLD         = 0.03;   // Edge below 3% = low edge risk
const CONFIDENCE_LOW_THRESHOLD   = 0.60;   // Confidence below 60% = low confidence risk
const SAMPLE_SMALL_THRESHOLD     = 30;     // Sample below 30 games = small sample risk
const LINE_MOVEMENT_BAD_THRESHOLD = -3;    // Moved worse than -3% against us = bad movement

// Risk points awarded per factor trigger (additive)
// Total of ALL factors firing simultaneously must be ≤ 100
const POINTS_HEAVY_JUICE          = 20;
const POINTS_LOW_EDGE             = 20;
const POINTS_LOW_CONFIDENCE       = 15;
const POINTS_SMALL_SAMPLE         = 10;
const POINTS_BAD_LINE_MOVEMENT    = 15;
const POINTS_INJURY               = 10;
const POINTS_WEATHER              = 10;
// Max theoretical: 20+20+15+10+15+10+10 = 100 ✓

// Risk level bands
const RISK_HIGH_THRESHOLD   = 70;
const RISK_MEDIUM_THRESHOLD = 35;

// ─────────────────────────────────────────────────────────────────────────────
// Level mapping
// ─────────────────────────────────────────────────────────────────────────────

function riskLevelFromScore(score: number): RiskLevel {
  if (score >= RISK_HIGH_THRESHOLD)   return 'HIGH';
  if (score >= RISK_MEDIUM_THRESHOLD) return 'MEDIUM';
  return 'LOW';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates risk for a pick from measurable, observable factors.
 *
 * Risk is ADDITIVE: each factor that crosses its threshold contributes a fixed
 * number of points. The score starts at 0 and only rises when evidence exists.
 * This guarantees risk never defaults to HIGH — a pick with no risk signals
 * scores 0 and returns LOW.
 *
 * Optional fields (lineMovementPercent, sampleSize, injuryFlag, weatherFlag)
 * that are absent contribute 0 points. They are never assumed to be risky.
 *
 * This function only scores and tags. It never discards picks.
 */
export function calculateRisk(input: RiskInput): RiskResult {
  const {
    americanOdds,
    edgeDecimal,
    confidence,
    lineMovementPercent,
    sampleSize,
    injuryFlag  = false,
    weatherFlag = false,
  } = input;

  let score = 0;
  const reasons: string[]  = [];
  let juicePoints          = 0;
  let edgePoints           = 0;
  let confidencePoints     = 0;
  let samplePoints         = 0;
  let lineMovementPoints   = 0;
  let injuryPoints         = 0;
  let weatherPoints        = 0;

  // ── Heavy juice ─────────────────────────────────────────────────────────
  // Odds more negative than the threshold (e.g. -200) indicate a heavy
  // favourite where the payoff is poor relative to the probability.
  if (americanOdds < JUICE_THRESHOLD) {
    juicePoints = POINTS_HEAVY_JUICE;
    score += juicePoints;
    reasons.push(
      `Heavy juice: odds ${americanOdds} are worse than ${JUICE_THRESHOLD} threshold`,
    );
  }

  // ── Low edge ─────────────────────────────────────────────────────────────
  if (edgeDecimal < EDGE_LOW_THRESHOLD) {
    edgePoints = POINTS_LOW_EDGE;
    score += edgePoints;
    reasons.push(
      `Low edge: ${(edgeDecimal * 100).toFixed(2)}% is below the ${EDGE_LOW_THRESHOLD * 100}% minimum`,
    );
  }

  // ── Low confidence ────────────────────────────────────────────────────────
  if (confidence < CONFIDENCE_LOW_THRESHOLD) {
    confidencePoints = POINTS_LOW_CONFIDENCE;
    score += confidencePoints;
    reasons.push(
      `Low confidence: ${(confidence * 100).toFixed(0)}% is below the ${CONFIDENCE_LOW_THRESHOLD * 100}% threshold`,
    );
  }

  // ── Small sample ─────────────────────────────────────────────────────────
  // Only flags if sampleSize is explicitly provided and below the threshold.
  // Absent sampleSize is treated as unknown, not as small.
  if (sampleSize !== undefined && sampleSize < SAMPLE_SMALL_THRESHOLD) {
    samplePoints = POINTS_SMALL_SAMPLE;
    score += samplePoints;
    reasons.push(
      `Small sample: ${sampleSize} games is below the ${SAMPLE_SMALL_THRESHOLD}-game minimum`,
    );
  }

  // ── Bad line movement ─────────────────────────────────────────────────────
  // Only flags if lineMovementPercent is explicitly provided.
  if (lineMovementPercent !== undefined && lineMovementPercent < LINE_MOVEMENT_BAD_THRESHOLD) {
    lineMovementPoints = POINTS_BAD_LINE_MOVEMENT;
    score += lineMovementPoints;
    reasons.push(
      `Adverse line movement: ${lineMovementPercent}% movement against this side`,
    );
  }

  // ── Injury flag ───────────────────────────────────────────────────────────
  if (injuryFlag) {
    injuryPoints = POINTS_INJURY;
    score += injuryPoints;
    reasons.push('Injury flag: key player availability concern for this game');
  }

  // ── Weather flag ──────────────────────────────────────────────────────────
  if (weatherFlag) {
    weatherPoints = POINTS_WEATHER;
    score += weatherPoints;
    reasons.push('Weather flag: adverse conditions may affect game play');
  }

  // Score is bounded by the sum of all factors (max 100 by design).
  // Clamp defensively in case future factors are added without updating the max.
  const riskScore = Math.min(100, Math.max(0, score));

  return {
    riskScore,
    riskLevel: riskLevelFromScore(riskScore),
    riskReasons: reasons,
    factors: {
      juicePoints,
      edgePoints,
      confidencePoints,
      samplePoints,
      lineMovementPoints,
      injuryPoints,
      weatherPoints,
    },
  };
}
