import type { NormalizedPick } from './oddsApi.adapter';

// =============================================================================
// MLB Model Adapter
// =============================================================================
// Takes normalized odds picks (from oddsApi.adapter) and attaches
// modelProbability and confidence from a caller-supplied model record map.
//
// WHAT THIS ADAPTER DOES:
//   - Joins odds picks with model prediction records by a deterministic key
//   - Validates probability and confidence values before attaching
//   - Returns pipeline-ready picks, picks missing model records, and errors
//
// WHAT THIS ADAPTER DOES NOT DO:
//   - Invent model probability from odds or any other derivation
//   - Guess, estimate, or approximate model probability
//   - Modify any odds fields (americanOdds, oppositeAmericanOdds, runLineSpread)
//   - Call any external API or statistical model
//
// Model probability must come entirely from the caller — a real statistical
// model, historical calibration data, or a third-party prediction service.
// If a pick has no matching record it is moved to missingModelPicks.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A single model prediction record keyed by buildModelKey(). */
export interface ModelProbabilityRecord {
  /** Win probability for this side from the statistical model. Must be in (0, 1). */
  modelProbability: number;
  /** Model confidence in this prediction. Must be in (0, 1). */
  confidence:       number;
  /** Optional: model version that produced this record. */
  modelVersionId?:  string;
  /**
   * Effective sample size from the ingestion layer.
   * min(teamGamesPlayed, pitcherSeasonStarts) — or undefined when unknown.
   * Passed through to the risk engine: < 30 triggers SMALL_SAMPLE risk.
   */
  sampleSize?:      number;
}

/**
 * Map from model key → prediction record.
 * Keys are produced by buildModelKey().
 */
export type ModelProbabilityMap = Record<string, ModelProbabilityRecord>;

/** A normalized odds pick with model fields now populated — ready for mlbPipeline. */
export type PipelineReadyPick = Omit<NormalizedPick, 'modelProbability' | 'confidence'> & {
  modelProbability: number;   // no longer null
  confidence:       number;   // no longer null
  modelVersionId:   string;
  /** Passed from ModelProbabilityRecord — undefined when not populated by ingestion. */
  sampleSize?:      number;
};

export interface AttachModelProbabilitiesResult {
  /** Picks with modelProbability and confidence attached — safe to pass to mlbPipeline. */
  readyPicks:        PipelineReadyPick[];
  /** Picks for which no model record was found in the map. Not passed to pipeline. */
  missingModelPicks: NormalizedPick[];
  /** Per-pick errors (invalid probability values, etc.). Do not crash the batch. */
  errors:            Array<{ pickKey: string; message: string }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Key construction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a deterministic lookup key from the four fields that uniquely
 * identify a side of a market within a game.
 *
 * Key format: `{gameId}|{team}|{betType}|{marketType}`
 *
 * All parts are lower-cased and trimmed for stability — the same game/team
 * combination always produces the same key regardless of case.
 *
 * @example
 * buildModelKey('game-001', 'New York Yankees', 'moneyline', 'moneyline')
 * // → 'game-001|new york yankees|moneyline|moneyline'
 */
export function buildModelKey(
  gameId:     string,
  team:       string,
  betType:    string,
  marketType: string,
): string {
  return [
    gameId.trim().toLowerCase(),
    team.trim().toLowerCase(),
    betType.trim().toLowerCase(),
    marketType.trim().toLowerCase(),
  ].join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  valid:    boolean;
  message?: string;
}

/**
 * Validates a model probability record.
 *
 * Both modelProbability and confidence must be:
 *   - A finite number
 *   - Strictly greater than 0
 *   - Strictly less than 1
 *
 * Returns { valid: true } on success or { valid: false, message } on failure.
 * This function never throws — errors are returned as structured values so
 * the batch processor can collect them without crashing.
 */
export function validateModelProbabilityRecord(record: ModelProbabilityRecord): ValidationResult {
  const { modelProbability, confidence } = record;

  if (!Number.isFinite(modelProbability) || modelProbability <= 0 || modelProbability >= 1) {
    return {
      valid:   false,
      message: `Invalid modelProbability: ${modelProbability}. Must be a finite number strictly between 0 and 1.`,
    };
  }

  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    return {
      valid:   false,
      message: `Invalid confidence: ${confidence}. Must be a finite number strictly between 0 and 1.`,
    };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Core: attachModelProbabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attaches modelProbability and confidence to each normalized odds pick.
 *
 * Each pick is looked up in `modelMap` by the key produced from
 * buildModelKey(pick.gameId, pick.team, pick.betType, pick.marketType).
 *
 * Processing rules (in order):
 *   1. Build the lookup key for the pick.
 *   2. If no record exists in modelMap → add pick to missingModelPicks.
 *   3. Validate the record values.
 *   4. If invalid → add to errors (with pickKey and message), skip pick.
 *   5. If valid → attach modelProbability and confidence → add to readyPicks.
 *
 * Odds fields are never modified:
 *   - americanOdds
 *   - oppositeAmericanOdds
 *   - runLineSpread
 *   - betType
 *   - marketType
 *   - gameId
 *
 * @param normalizedPicks  Picks from oddsApi.adapter (modelProbability: null)
 * @param modelMap         Prediction records keyed by buildModelKey()
 * @param defaultModelVersionId  Fallback modelVersionId when record has none
 */
export function attachModelProbabilities(
  normalizedPicks:       NormalizedPick[],
  modelMap:              ModelProbabilityMap,
  defaultModelVersionId: string,
): AttachModelProbabilitiesResult {
  const readyPicks:        PipelineReadyPick[]                              = [];
  const missingModelPicks: NormalizedPick[]                                 = [];
  const errors:            Array<{ pickKey: string; message: string }>      = [];

  for (const pick of normalizedPicks) {
    const key    = buildModelKey(pick.gameId, pick.team, pick.betType, pick.marketType);
    const record = modelMap[key];

    // No record — pick goes to missingModelPicks, not an error
    if (record === undefined) {
      missingModelPicks.push(pick);
      continue;
    }

    // Validate the record values
    const validation = validateModelProbabilityRecord(record);
    if (!validation.valid) {
      errors.push({ pickKey: key, message: validation.message! });
      continue;
    }

    // Attach model fields without touching any odds field
    const readyPick: PipelineReadyPick = {
      // Spread all odds fields from the normalized pick — preserves everything
      ...pick,
      // Override the null placeholders with real values
      modelProbability: record.modelProbability,
      confidence:       record.confidence,
      modelVersionId:   record.modelVersionId ?? defaultModelVersionId,
      // Pass through sampleSize — undefined when not set by ingestion layer
      sampleSize:       record.sampleSize,
    };

    readyPicks.push(readyPick);
  }

  return { readyPicks, missingModelPicks, errors };
}
