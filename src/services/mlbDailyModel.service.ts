import {
  buildModelProbabilityMap,
  type TeamGameStats,
} from '../adapters/mlbStatsModel.adapter';
import {
  attachModelProbabilities,
  type ModelProbabilityMap,
} from '../adapters/mlbModel.adapter';
import type { NormalizedPick } from '../adapters/oddsApi.adapter';
import { runMLBPipeline, type PipelineConfig } from '../mlbPipeline';
import { filterPregameOnly, buildLiveGameWarning } from '../adapters/mlbGameFilter';
import type { RankedOutput }     from '../engines/ranking.engine';
import type { ProcessedMLBPick } from '../mlbPipeline';
import {
  mapPipelineOutputToDbRows,
  savePredictions,
  type SaveResult,
} from './results.service';
import type { SupabaseClientLike } from './supabase.types';

// =============================================================================
// MLB Daily Model Service
// =============================================================================
// End-to-end daily cycle combining structured MLB stats, normalized odds picks,
// the deterministic stats model, and the full analysis pipeline.
//
// Flow:
//   1. structuredStats → mlbStatsModel.adapter → ModelProbabilityMap
//   2. normalizedOddsPicks + ModelProbabilityMap → mlbModel.adapter → readyPicks
//   3. readyPicks → mlbPipeline → RankedOutput
//   4. RankedOutput → results.service → Supabase (optional)
//
// This service owns no computation — every step delegates to its module.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface DailyModelCycleInput {
  /** ISO date string for this slate e.g. '2025-06-10'. Used as prediction_date. */
  date?:                string;
  modelVersionId:       string;
  normalizedOddsPicks:  NormalizedPick[];
  structuredStats:      TeamGameStats[];
  supabaseClient?:      SupabaseClientLike;
  pipelineConfig?:      PipelineConfig;
}

export interface DailyModelCycleSummary {
  totalOddsPicks:      number;
  totalModelRecords:   number;
  totalPipelineInputs: number;
  topPicks:            number;
  qualifiedPicks:      number;
  failedPicks:         number;
  noOddsPicks:         number;
  savedRows:           number;
  excludedLiveGames:   number;
}

export interface DailyModelCycleResult {
  pipelineOutput:      RankedOutput<ProcessedMLBPick>;
  modelProbabilityMap: ModelProbabilityMap;
  modelBuildErrors:    Array<{ gameId: string; team: string; message: string }>;
  missingModelPicks:   NormalizedPick[];
  modelAttachErrors:   Array<{ pickKey: string; message: string }>;
  saveResult?:         SaveResult;
  summary:             DailyModelCycleSummary;
  excludedLiveGameWarning: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// runDailyMLBModelCycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the complete MLB daily model cycle.
 *
 * Stage 1 — Build model probabilities from structured stats
 *   mlbStatsModel.adapter.buildModelProbabilityMap()
 *   Errors are captured in modelBuildErrors without crashing.
 *
 * Stage 2 — Attach probabilities to normalized odds picks
 *   mlbModel.adapter.attachModelProbabilities()
 *   Picks without a matching model record → missingModelPicks.
 *   Picks with invalid probabilities → modelAttachErrors.
 *
 * Stage 3 — Run the full analytics pipeline
 *   mlbPipeline.runMLBPipeline() assigns ids, computes edge/risk/grade,
 *   and classifies every pick into topPicks/qualifiedPicks/failedPicks/noOddsPicks.
 *
 * Stage 4 — Persist (optional)
 *   If supabaseClient is provided, all picks from all groups are saved.
 *   If not, the cycle runs dry and saveResult is undefined.
 */
export async function runDailyMLBModelCycle(
  input: DailyModelCycleInput,
): Promise<DailyModelCycleResult> {
  // ── Stage 1: build model probability map from stats ───────────────────────
  const {
    map:     modelProbabilityMap,
    errors:  modelBuildErrors,
  } = buildModelProbabilityMap(input.structuredStats, input.modelVersionId);

  // ── Stage 2: attach model probabilities to normalized odds picks ──────────
  const {
    readyPicks,
    missingModelPicks,
    errors: modelAttachErrors,
  } = attachModelProbabilities(
    input.normalizedOddsPicks,
    modelProbabilityMap,
    input.modelVersionId,
  );

  // ── Stage 2.5: filter out live / non-pregame picks ───────────────────────
  const filterResult = filterPregameOnly(readyPicks);
  const pregamePicks = filterResult.allowed;
  const excludedLiveGameWarning = buildLiveGameWarning(filterResult.excludedCount);

  // ── Stage 3: run pipeline ─────────────────────────────────────────────────
  const rawPicks = pregamePicks.map((p, i) => ({
    ...p,
    id:              `${input.modelVersionId}:${p.gameId}:${p.team}:${p.betType}:${i}`,
    modelVersionId:  p.modelVersionId ?? input.modelVersionId,
    modelProbability: p.modelProbability as number,
    confidence:       p.confidence as number,
  }));

  const { output: pipelineOutput } = runMLBPipeline(rawPicks, input.pipelineConfig);

  // ── Stage 4: persist (optional) ───────────────────────────────────────────
  let saveResult: SaveResult | undefined;

  if (input.supabaseClient) {
    const rows = mapPipelineOutputToDbRows(pipelineOutput, input.date ?? new Date().toISOString().slice(0, 10));
    saveResult  = await savePredictions(rows, input.supabaseClient);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  const totalPipelineInputs =
    pipelineOutput.topPicks.length +
    pipelineOutput.qualifiedPicks.length +
    pipelineOutput.failedPicks.length +
    pipelineOutput.noOddsPicks.length;

  const summary: DailyModelCycleSummary = {
    totalOddsPicks:      input.normalizedOddsPicks.length,
    totalModelRecords:   Object.keys(modelProbabilityMap).length,
    totalPipelineInputs,
    topPicks:            pipelineOutput.topPicks.length,
    qualifiedPicks:      pipelineOutput.qualifiedPicks.length,
    failedPicks:         pipelineOutput.failedPicks.length,
    noOddsPicks:         pipelineOutput.noOddsPicks.length,
    savedRows:           saveResult?.savedCount ?? 0,
    excludedLiveGames:   filterResult.excludedCount,
  };

  return {
    pipelineOutput,
    modelProbabilityMap,
    modelBuildErrors,
    missingModelPicks,
    modelAttachErrors,
    saveResult,
    summary,
    excludedLiveGameWarning,
  };
}
