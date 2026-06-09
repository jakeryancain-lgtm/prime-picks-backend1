import type { RiskLevel } from '../types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GradeLetter = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F' | 'NO_GRADE';

export interface PickGradeInput {
  /** Edge from edge.engine (decimal, e.g. 0.07 = 7%). Can be negative. */
  edgeDecimal: number;
  /**
   * Model confidence in this prediction (0–1).
   * Represents how certain the model is — not the same as modelProbability.
   */
  confidence: number;
  /**
   * Odds quality score (0–1).
   * Reflects how sharp / liquid / well-lined the market is.
   * 1.0 = tight, sharp market. 0.0 = stale, illiquid, or extreme line.
   */
  oddsQuality: number;
  /** Risk level from risk.engine. */
  riskLevel: RiskLevel;
  /** Whether live (verified) odds exist for this pick. */
  hasLiveOdds: boolean;
  /** American odds for the selected side. Null when no live odds. */
  americanOdds: number | null;
}

export interface PickGradeResult {
  /** 0–100 composite score. Always 0 when hasLiveOdds is false or americanOdds is null. */
  gradeNumeric: number;
  /** Letter grade derived from gradeNumeric. NO_GRADE when no odds exist. */
  gradeLetter: GradeLetter;
  /** Per-component scores before weighting, for transparency. */
  components: {
    edgeScore: number;
    confidenceScore: number;
    oddsQualityScore: number;
    riskAdjustment: number;
  };
  /** Weighted subtotals before risk adjustment, 0–100. */
  baseScore: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Weights must sum to 1.0
const WEIGHT_EDGE         = 0.40;
const WEIGHT_CONFIDENCE   = 0.30;
const WEIGHT_ODDS_QUALITY = 0.20;
const WEIGHT_RISK         = 0.10;

// Edge scoring boundaries (decimal)
// Maps edge value to a 0–100 score
const EDGE_SCORE_CEILING = 0.12; // 12% edge → 100 score (ELITE+)
const EDGE_SCORE_FLOOR   = 0;    // 0% edge → 0 score (negative edge also → 0)

// Risk adjustments (added to / subtracted from final score, 0–100 scale)
const RISK_LOW_BONUS      =  5;
const RISK_MEDIUM_ADJUST  =  0;
const RISK_HIGH_PENALTY   = -10;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Clamps a value to [0, 100]. */
function clamp100(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/**
 * Maps edgeDecimal to a 0–100 score.
 * Negative edge → 0. Edge ≥ ceiling → 100. Linear in between.
 */
function scoreEdge(edgeDecimal: number): number {
  if (edgeDecimal <= EDGE_SCORE_FLOOR) return 0;
  return clamp100((edgeDecimal / EDGE_SCORE_CEILING) * 100);
}

/**
 * Maps a 0–1 input to a 0–100 score.
 * Used for confidence and oddsQuality, which are already normalised 0–1.
 */
function scoreNormalized(value: number): number {
  return clamp100(value * 100);
}

/** Maps risk level to a numeric adjustment on the 0–100 scale. */
function riskAdjustment(riskLevel: RiskLevel): number {
  switch (riskLevel) {
    case 'LOW':    return RISK_LOW_BONUS;
    case 'MEDIUM': return RISK_MEDIUM_ADJUST;
    case 'HIGH':   return RISK_HIGH_PENALTY;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Grade letter mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a numeric score (0–100) to a letter grade.
 *
 * 90–100 → A+
 * 80–89  → A
 * 70–79  → B
 * 60–69  → C
 * 50–59  → D
 * 0–49   → F
 */
export function gradeLetterFromScore(score: number): GradeLetter {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// ─────────────────────────────────────────────────────────────────────────────
// Core grading function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grades a pick PRE-GAME based on edge, confidence, odds quality, and risk.
 *
 * Grade is 0 / NO_GRADE when:
 *   - hasLiveOdds is false, OR
 *   - americanOdds is null
 *
 * This function never discards picks. It only produces a grade.
 * The caller (mlb.service or ranking.engine) decides what to do with it.
 *
 * Scoring formula:
 *   baseScore = (edgeScore × 0.40)
 *             + (confidenceScore × 0.30)
 *             + (oddsQualityScore × 0.20)
 *             + (riskAdjustment × 0.10)   ← weighted contribution of risk
 *   gradeNumeric = clamp(baseScore + riskAdjustment, 0, 100)
 *
 * Risk is applied in two ways:
 *   1. As a weighted component (10% of baseScore via the risk sub-score)
 *   2. As a direct adjustment to the final score (bonus/penalty in points)
 *
 * This double-application ensures HIGH risk meaningfully lowers the grade
 * even when the other three inputs are perfect, without requiring artificial
 * floor/ceiling manipulation.
 */
export function gradePickPreGame(input: PickGradeInput): PickGradeResult {
  const { edgeDecimal, confidence, oddsQuality, riskLevel, hasLiveOdds, americanOdds } = input;

  // ── NO_GRADE path ──────────────────────────────────────────────────────────
  if (!hasLiveOdds || americanOdds === null) {
    return {
      gradeNumeric: 0,
      gradeLetter: 'NO_GRADE',
      components: {
        edgeScore: 0,
        confidenceScore: 0,
        oddsQualityScore: 0,
        riskAdjustment: 0,
      },
      baseScore: 0,
    };
  }

  // ── Component scores (all 0–100) ───────────────────────────────────────────
  const edgeScore         = scoreEdge(edgeDecimal);
  const confidenceScore   = scoreNormalized(confidence);
  const oddsQualityScore  = scoreNormalized(oddsQuality);
  const riskAdj           = riskAdjustment(riskLevel);

  // Risk sub-score (0–100) for the weighted component:
  //   LOW = 100, MEDIUM = 50, HIGH = 0
  const riskSubScore = riskLevel === 'LOW' ? 100 : riskLevel === 'MEDIUM' ? 50 : 0;

  // ── Weighted base score ────────────────────────────────────────────────────
  const baseScore = (edgeScore * WEIGHT_EDGE)
    + (confidenceScore * WEIGHT_CONFIDENCE)
    + (oddsQualityScore * WEIGHT_ODDS_QUALITY)
    + (riskSubScore * WEIGHT_RISK);

  // ── Final score: base + direct risk adjustment, clamped ───────────────────
  const gradeNumeric = clamp100(baseScore + riskAdj);
  const gradeLetter  = gradeLetterFromScore(gradeNumeric);

  return {
    gradeNumeric,
    gradeLetter,
    components: {
      edgeScore,
      confidenceScore,
      oddsQualityScore,
      riskAdjustment: riskAdj,
    },
    baseScore,
  };
}
