import type { NormalizedPick }      from './oddsApi.adapter';
import {
  attachModelProbabilities,
  type ModelProbabilityMap,
  type PipelineReadyPick,
} from './mlbModel.adapter';
import { runMLBPipeline, type PipelineConfig } from '../mlbPipeline';
import type { RankedOutput }                   from '../engines/ranking.engine';
import type { ProcessedMLBPick }               from '../mlbPipeline';
import {
  mapPipelineOutputToDbRows,
  savePredictions,
  type SaveResult,
} from '../services/results.service';
import type { SupabaseClientLike } from '../services/supabase.types';

// =============================================================================
// MLB Daily Service
// =============================================================================
// Orchestrates the complete daily pick cycle. This service owns no computation.
//
// Stages (in order):
//   1. Attach model probabilities to normalized odds picks (mlbModel.adapter)
//   2. Run the full engine pipeline (mlbPipeline)
//   3. Persist all picks to Supabase (results.service) — optional
//
// If the Supabase client is omitted, the cycle runs in-memory and returns
// results without saving. Useful for previewing picks or dry runs.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyCycleInput {
  /** Normalized odds picks from oddsApi.adapter — model fields are null. */
  normalizedPicks:  NormalizedPick[];
  /** Model prediction records keyed by buildModelKey(). */
  modelProbabilities: ModelProbabilityMap;
  /** Model version that produced the modelProbabilities records. */
  modelVersionId:   string;
  /** When provided, all picks are saved to model_predictions via results.service. */
  supabaseClient?:  SupabaseClientLike;
  /** Pipeline config overrides (minimumEdge, maxNegativeOdds, maxTopPicks). */
  pipelineConfig?:  PipelineConfig;
}

export interface DailyCycleSummary {
  totalOddsPicks:     number;
  readyPicks:         number;
  missingModelPicks:  number;
  topPicks:           number;
  qualifiedPicks:     number;
  failedPicks:        number;
  noOddsPicks:        number;
  savedRows:          number;
}

export interface DailyCycleResult {
  pipelineOutput:    RankedOutput<ProcessedMLBPick>;
  missingModelPicks: NormalizedPick[];
  modelErrors:       Array<{ pickKey: string; message: string }>;
  /** Only present when a Supabase client was provided and the save was attempted. */
  saveResult?:       SaveResult;
  summary:           DailyCycleSummary;
}

// ─────────────────────────────────────────────────────────────────────────────
// runDailyMLBCycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full daily MLB pick cycle.
 *
 * Stage 1 — Attach model probabilities
 *   Joins normalized odds picks with model records via mlbModel.adapter.
 *   Picks without a matching model record go to missingModelPicks.
 *   Picks with invalid model records go to modelErrors.
 *   Neither crashes the cycle.
 *
 * Stage 2 — Run pipeline
 *   readyPicks (those with valid model probabilities) are run through
 *   mlbPipeline. The pipeline classifies every pick into one of four groups:
 *   topPicks, qualifiedPicks, failedPicks, noOddsPicks.
 *
 * Stage 3 — Persist (optional)
 *   If a Supabase client is provided, all picks from all four groups are
 *   saved via results.service.savePredictions(). If no client is provided,
 *   the cycle returns results without saving.
 *
 * @throws never — all errors are captured in the result shape
 */
export async function runDailyMLBCycle(input: DailyCycleInput): Promise<DailyCycleResult> {
  // ── Stage 1: attach model probabilities ──────────────────────────────────
  const {
    readyPicks,
    missingModelPicks,
    errors: modelErrors,
  } = attachModelProbabilities(
    input.normalizedPicks,
    input.modelProbabilities,
    input.modelVersionId,
  );

  // ── Stage 2: run pipeline ─────────────────────────────────────────────────
  // Converts PipelineReadyPick[] → RawMLBPick[] shape expected by mlbPipeline.
  // The pipeline requires id and modelVersionId — inject them here since
  // normalized picks don't carry ids.
  const rawPicks = readyPicks.map((p: PipelineReadyPick, i: number) => ({
    ...p,
    id:             `${input.modelVersionId}:${p.gameId}:${p.team}:${p.betType}:${i}`,
    modelVersionId: p.modelVersionId ?? input.modelVersionId,
    // modelProbability and confidence are now numbers (validated by mlbModel.adapter)
    modelProbability: p.modelProbability as number,
    confidence:       p.confidence as number,
  }));

  const { output: pipelineOutput } = runMLBPipeline(rawPicks, input.pipelineConfig);

  // ── Stage 3: persist (optional) ───────────────────────────────────────────
  let saveResult: SaveResult | undefined;

  if (input.supabaseClient) {
    const rows = mapPipelineOutputToDbRows(pipelineOutput);
    saveResult  = await savePredictions(rows, input.supabaseClient);
  }

  // ── Build summary ─────────────────────────────────────────────────────────
  const summary: DailyCycleSummary = {
    totalOddsPicks:    input.normalizedPicks.length,
    readyPicks:        readyPicks.length,
    missingModelPicks: missingModelPicks.length,
    topPicks:          pipelineOutput.topPicks.length,
    qualifiedPicks:    pipelineOutput.qualifiedPicks.length,
    failedPicks:       pipelineOutput.failedPicks.length,
    noOddsPicks:       pipelineOutput.noOddsPicks.length,
    savedRows:         saveResult?.savedCount ?? 0,
  };

  return {
    pipelineOutput,
    missingModelPicks,
    modelErrors,
    saveResult,
    summary,
  };
}
