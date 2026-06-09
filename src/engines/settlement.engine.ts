import { americanToRawImpliedProbability, isValidAmericanOdds } from './odds.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type SettlementOutcome = 'WIN' | 'LOSS' | 'PUSH';

export interface SettlementInput {
  /** The prediction being settled — used for duplicate-detection. */
  predictionId: string;
  /** American odds at the time the pick was made (entry odds). */
  americanOdds: number;
  /** American odds at game start (closing line). */
  closingOdds: number;
  /** Stake in units. Must be > 0. */
  stake: number;
  /** Post-game result. */
  outcome: SettlementOutcome;
  /**
   * The implied probability that was used at prediction time (after vig removal
   * when available, otherwise raw). This is the "our price" side of CLV.
   */
  originalImpliedProbability: number;
}

export interface SettlementResult {
  predictionId: string;
  result:                    SettlementOutcome;
  stake:                     number;
  profitLoss:                number;
  roi:                       number;
  closingOdds:               number;
  closingImpliedProbability: number;
  /**
   * Closing Line Value.
   * CLV = originalImpliedProbability − closingImpliedProbability
   * Positive = we got a better price than the closing line (good).
   * Negative = market moved against us (we paid more than fair value at close).
   */
  clvDecimal: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Profit/loss calculation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculates profit/loss from a single settled bet.
 *
 * WIN with positive odds  (underdog): stake × (odds / 100)
 * WIN with negative odds (favourite): stake × (100 / |odds|)
 * LOSS:                               −stake
 * PUSH:                               0
 */
export function calculateProfitLoss(
  outcome: SettlementOutcome,
  americanOdds: number,
  stake: number,
): number {
  switch (outcome) {
    case 'WIN':
      if (americanOdds > 0) {
        return stake * (americanOdds / 100);
      }
      return stake * (100 / Math.abs(americanOdds));

    case 'LOSS':
      return -stake;

    case 'PUSH':
      return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

function validateSettlementInput(input: SettlementInput): void {
  if (!input.predictionId || input.predictionId.trim() === '') {
    throw new Error('settlement: predictionId is required.');
  }

  if (!Number.isFinite(input.stake) || input.stake <= 0) {
    throw new Error(
      `settlement: stake must be a finite number greater than 0. Got: ${input.stake}`,
    );
  }

  if (!isValidAmericanOdds(input.americanOdds)) {
    throw new Error(
      `settlement: invalid americanOdds ${input.americanOdds}. Must be ≥ +100 or ≤ −100.`,
    );
  }

  if (!isValidAmericanOdds(input.closingOdds)) {
    throw new Error(
      `settlement: invalid closingOdds ${input.closingOdds}. Must be ≥ +100 or ≤ −100.`,
    );
  }

  if (
    !Number.isFinite(input.originalImpliedProbability) ||
    input.originalImpliedProbability <= 0 ||
    input.originalImpliedProbability >= 1
  ) {
    throw new Error(
      `settlement: originalImpliedProbability must be in (0, 1). Got: ${input.originalImpliedProbability}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Core settlement function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Settles a single prediction post-game.
 *
 * This function is POST-GAME only. It reads pre-game data (americanOdds,
 * originalImpliedProbability) but does not modify or return any pre-game
 * fields (grade, edge, risk). Those are immutable once set by the pipeline.
 *
 * @throws if stake ≤ 0, odds are invalid, or predictionId is blank.
 */
export function settlePrediction(input: SettlementInput): SettlementResult {
  validateSettlementInput(input);

  const profitLoss               = calculateProfitLoss(input.outcome, input.americanOdds, input.stake);
  const roi                      = profitLoss / input.stake;
  const closingImpliedProbability = americanToRawImpliedProbability(input.closingOdds);
  const clvDecimal               = input.originalImpliedProbability - closingImpliedProbability;

  return {
    predictionId:              input.predictionId,
    result:                    input.outcome,
    stake:                     input.stake,
    profitLoss,
    roi,
    closingOdds:               input.closingOdds,
    closingImpliedProbability,
    clvDecimal,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Batch settlement with duplicate guard
// ─────────────────────────────────────────────────────────────────────────────

export interface BatchSettlementResult {
  settled: SettlementResult[];
  duplicates: string[];
  errors: Array<{ predictionId: string; message: string }>;
}

/**
 * Settles multiple predictions in a single call.
 *
 * Duplicate-detection: if the same predictionId appears more than once in the
 * input array, only the first occurrence is settled. Subsequent occurrences
 * are recorded in the `duplicates` array and skipped — they are never settled.
 *
 * Errors on individual picks are caught and recorded in `errors`; processing
 * continues for the remaining picks.
 */
export function settleMany(inputs: SettlementInput[]): BatchSettlementResult {
  const settled:    SettlementResult[]                            = [];
  const duplicates: string[]                                      = [];
  const errors:     Array<{ predictionId: string; message: string }> = [];
  const seen        = new Set<string>();

  for (const input of inputs) {
    if (seen.has(input.predictionId)) {
      duplicates.push(input.predictionId);
      continue;
    }
    seen.add(input.predictionId);

    try {
      settled.push(settlePrediction(input));
    } catch (e: unknown) {
      errors.push({
        predictionId: input.predictionId,
        message:      e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { settled, duplicates, errors };
}
