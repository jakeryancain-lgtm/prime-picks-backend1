// ─────────────────────────────────────────────────────────────────────────────
// Odds formats
// ─────────────────────────────────────────────────────────────────────────────

/** American odds as an integer. Positive = underdog, negative = favourite. */
export type AmericanOdds = number;

/** Decimal (European) odds. Always > 1.0. */
export type DecimalOdds = number;

/** Fractional odds expressed as { numerator, denominator }. */
export interface FractionalOdds {
  numerator: number;
  denominator: number;
}

/** All three representations of the same line, plus the raw American input. */
export interface OddsConversion {
  american: AmericanOdds;
  decimal: DecimalOdds;
  fractional: FractionalOdds;
  /** Raw implied probability before vig removal (0–1). */
  rawImpliedProbability: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Probability
// ─────────────────────────────────────────────────────────────────────────────

/** Vig-removal methods supported by probability.engine. */
export type VigMethod = 'basic' | 'shin' | 'power';

export interface ImpliedProbabilityResult {
  /** True implied probability after vig removal (0–1). */
  impliedProbability: number;
  /** Total overround / vig of the two-sided market (e.g. 0.046 = 4.6% vig). */
  vig: number;
  method: VigMethod;
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge
// ─────────────────────────────────────────────────────────────────────────────

export interface EdgeResult {
  /** model probability − implied probability (can be negative). */
  edge: number;
  modelProbability: number;
  impliedProbability: number;
  /** Whether edge meets the configured minimum threshold. */
  meetsThreshold: boolean;
  /** Threshold that was used for the meetsThreshold evaluation. */
  threshold: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Risk
// ─────────────────────────────────────────────────────────────────────────────

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskInput {
  /** Edge value (0–1). Higher edge → lower risk. */
  edge: number;
  /** Absolute juice on the line in American odds points (e.g. 10 for -110 vs -110). */
  juice: number;
  /**
   * Line movement since open, in American odds points.
   * Positive = moved toward favourite, negative = moved toward underdog.
   */
  lineMovement: number;
  /**
   * Confidence score from the model (0–1). Higher = more confident.
   * When absent, defaults to 0.5 (neutral, never forces HIGH).
   */
  modelConfidence?: number;
  /** Number of historical games the model was trained/calibrated on. */
  sampleSize?: number;
}

export interface RiskResult {
  level: RiskLevel;
  /** Normalized composite score 0–100. Lower = less risky. */
  score: number;
  /** Per-factor breakdown for transparency. */
  factors: {
    edgeScore: number;
    juiceScore: number;
    lineMovementScore: number;
    confidenceScore: number;
    sampleScore: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick grade (PRE-GAME)
// ─────────────────────────────────────────────────────────────────────────────

/** Pre-game pick quality grade. 0 only when odds are null. */
export type PickGrade = 0 | 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';

export interface PickGradeInput {
  edge: number;
  modelConfidence: number;
  /** Decimal odds for the selected side. Null when no live odds exist. */
  decimalOdds: number | null;
  riskLevel: RiskLevel;
}

export interface PickGradeResult {
  grade: PickGrade;
  /** Composite score 0–100 used to derive the grade. */
  score: number;
  /** Human-readable reason when grade is 0. */
  gradeReason?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter / fail reasons
// ─────────────────────────────────────────────────────────────────────────────

export type FailReason =
  | 'EDGE_TOO_LOW'
  | 'NO_LIVE_ODDS'
  | 'BAD_ODDS_RANGE'
  | 'EXCLUDED_RUN_LINE'
  | 'HIGH_RISK'
  | 'DUPLICATE_GAME';

export type PickStatus = 'QUALIFIED' | 'FAILED_FILTER' | 'NO_ODDS';

// ─────────────────────────────────────────────────────────────────────────────
// MLB bet types
// ─────────────────────────────────────────────────────────────────────────────

export type BetType =
  | 'moneyline'
  | 'run_line'
  | 'total_over'
  | 'total_under';

/** Run line spread values. +1.5 and +2.5 are excluded from Top 5. */
export type RunLineSpread = -1.5 | -2.5 | 1.5 | 2.5;

// ─────────────────────────────────────────────────────────────────────────────
// Core pick shape
// ─────────────────────────────────────────────────────────────────────────────

export interface MLBPick {
  id: string;
  modelVersionId: string;
  gameId: string;
  /** e.g. "NYY", "BOS" */
  team: string;
  opponent: string;
  betType: BetType;
  /** Only set when betType is 'run_line'. */
  runLineSpread?: RunLineSpread;
  /** Live (verified) American odds. Null when not yet posted. */
  americanOdds: AmericanOdds | null;
  /** Model's win probability for this side (0–1). */
  modelProbability: number;
  /** ISO-8601 timestamp of when the prediction was generated. */
  createdAt: string;

  // ── Computed fields (populated by engines) ──
  oddsConversion?: OddsConversion;
  impliedProbability?: ImpliedProbabilityResult;
  edgeResult?: EdgeResult;
  riskResult?: RiskResult;
  pickGradeResult?: PickGradeResult;

  // ── Filter outcome ──
  status?: PickStatus;
  failReason?: FailReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ranking output
// ─────────────────────────────────────────────────────────────────────────────

export interface RankedOutput {
  /** ≤5 picks. No +1.5/+2.5 run lines. One pick per game. Sorted by edge desc. */
  topPicks: MLBPick[];
  /** Passed all filters but didn't make the top 5 cutoff. */
  qualifiedPicks: MLBPick[];
  /** status === 'FAILED_FILTER'. Always stored, never surfaced in Top 5. */
  failedPicks: MLBPick[];
  /** status === 'NO_ODDS'. grade === 0. */
  noOddsPicks: MLBPick[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Engine config
// ─────────────────────────────────────────────────────────────────────────────

export interface EngineConfig {
  /** Minimum edge to qualify a pick (default 0.03 = 3%). */
  minEdgeThreshold: number;
  /** Vig removal method to use in probability engine. */
  vigMethod: VigMethod;
  /** American odds below this absolute value are considered bad range (default -600). */
  maxFavouriteOdds: number;
  /** American odds above this value are considered bad range (default +500). */
  maxUnderdogOdds: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  minEdgeThreshold: 0.03,
  vigMethod: 'basic',
  maxFavouriteOdds: -600,
  maxUnderdogOdds: 500,
};
