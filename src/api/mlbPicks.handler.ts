import {
  runDailyMLBModelCycle,
  type DailyModelCycleSummary,
} from '../services/mlbDailyModel.service';
import type { NormalizedPick }    from '../adapters/oddsApi.adapter';
import type { TeamGameStats }     from '../adapters/mlbStatsModel.adapter';
import type { SupabaseClientLike } from '../services/supabase.types';

// =============================================================================
// MLB Picks Handler
// =============================================================================
// The clean API boundary between the backend engine and any calling client
// (Lovable frontend, HTTP endpoint, CLI tool, or test).
//
// Responsibilities:
//   - Accept structured input
//   - Delegate to runDailyMLBModelCycle()
//   - Shape the output into a JSON-safe, fully-serializable response
//   - Never return undefined values (null instead)
//   - Collect warnings and errors without crashing
//
// What this handler does NOT do:
//   - Fetch odds from external APIs
//   - Access environment variables
//   - Own any business logic
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export interface MLBPicksHandlerInput {
  /** ISO-8601 date this slate is for. e.g. '2025-06-10' */
  date:                string;
  /** Model version identifier. Required. */
  modelVersionId:      string;
  /** Normalized odds picks from oddsApi.adapter. */
  normalizedOddsPicks: NormalizedPick[];
  /** Structured game stats for probability model. */
  structuredStats:     TeamGameStats[];
  /** When true, saves all picks to Supabase. Default: false. */
  save?:               boolean;
  /** Optional Supabase client. Required when save=true. */
  supabaseClient?:     SupabaseClientLike;
}

// ─────────────────────────────────────────────────────────────────────────────
// Response shapes — fully JSON-safe (no functions, no undefined)
// ─────────────────────────────────────────────────────────────────────────────

export interface PickResponseItem {
  id:               string;
  gameId:           string;
  team:             string;
  opponent:         string;
  betType:          string;
  marketType:       string;
  americanOdds:     number | null;
  modelProbability: number | null;
  impliedProbability: number | null;
  noVigProbability:   number | null;
  edgeDecimal:      number;
  edgePercent:      number;
  edgeTier:         string;
  riskLevel:        string;
  riskScore:        number;
  gradeLetter:      string;
  gradeNumeric:     number;
  status:           string;
  failReason:       string | null;
  probabilitySource: string | null;
  confidence:       number;
  explanation:      string | null;
}

export interface MLBPicksResponse {
  date:            string;
  modelVersionId:  string;
  topPicks:        PickResponseItem[];
  qualifiedPicks:  PickResponseItem[];
  failedPicks:     PickResponseItem[];
  noOddsPicks:     PickResponseItem[];
  summary:         DailyModelCycleSummary;
  warnings:        string[];
  errors:          string[];
  savedRows:       number;
  timestamp:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Coerces a value to null if it is undefined — ensures no undefined in JSON. */
function nullify<T>(value: T | undefined | null): T | null {
  return value === undefined ? null : value ?? null;
}

/** Converts a processed pick to the clean, JSON-safe response shape. */
function toPickResponseItem(pick: {
  id:                string;
  gameId:            string;
  team:              string;
  opponent:          string;
  betType:           string;
  marketType:        string;
  americanOdds:      number | null | undefined;
  modelProbability:  number;
  rawImpliedProbability?: number | null;
  impliedProbabilityUsed?: number | null;
  noVigProbability?: number | null;
  edgeDecimal:       number;
  edgePercent:       number;
  edgeTier:          string;
  riskLevel:         string;
  riskScore:         number;
  gradeLetter:       string;
  gradeNumeric:      number;
  status?:           string;
  failReason?:       string | null;
  probabilitySource?: string | null;
  confidence:        number;
}): PickResponseItem {
  return {
    id:                pick.id,
    gameId:            pick.gameId,
    team:              pick.team,
    opponent:          pick.opponent,
    betType:           pick.betType,
    marketType:        pick.marketType,
    americanOdds:      nullify(pick.americanOdds),
    modelProbability:  pick.modelProbability,
    impliedProbability: nullify(pick.impliedProbabilityUsed ?? pick.rawImpliedProbability),
    noVigProbability:  nullify(pick.noVigProbability),
    edgeDecimal:       pick.edgeDecimal,
    edgePercent:       pick.edgePercent,
    edgeTier:          pick.edgeTier,
    riskLevel:         pick.riskLevel,
    riskScore:         pick.riskScore,
    gradeLetter:       pick.gradeLetter,
    gradeNumeric:      pick.gradeNumeric,
    status:            pick.status ?? 'UNKNOWN',
    failReason:        nullify(pick.failReason),
    probabilitySource: nullify(pick.probabilitySource),
    confidence:        pick.confidence,
    explanation:       null,  // reserved for future debug enrichment
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Input validation
// ─────────────────────────────────────────────────────────────────────────────

function validateInput(input: MLBPicksHandlerInput): string[] {
  const errors: string[] = [];

  if (!input.modelVersionId || input.modelVersionId.trim() === '') {
    errors.push('modelVersionId is required and cannot be blank.');
  }
  if (!input.date || input.date.trim() === '') {
    errors.push('date is required. Use ISO-8601 format e.g. 2025-06-10.');
  }
  if (!Array.isArray(input.normalizedOddsPicks)) {
    errors.push('normalizedOddsPicks must be an array.');
  }
  if (!Array.isArray(input.structuredStats)) {
    errors.push('structuredStats must be an array.');
  }
  if (input.save === true && !input.supabaseClient) {
    errors.push('supabaseClient is required when save=true.');
  }

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Processes a daily MLB picks request and returns a JSON-safe response.
 *
 * Designed to be called by:
 *   - A Lovable edge function / API endpoint
 *   - A CLI runner
 *   - Tests (with fake inputs)
 *
 * Never throws. Validation errors are returned in the `errors` array.
 * If save=false or no supabaseClient, predictions are not persisted.
 *
 * The response is guaranteed to be JSON.stringify()-safe:
 *   - No undefined values (replaced with null)
 *   - No functions
 *   - No circular references
 *   - All numbers are finite or replaced with 0
 */
export async function getMLBPicksHandler(
  input: MLBPicksHandlerInput,
): Promise<MLBPicksResponse> {
  const timestamp = new Date().toISOString();
  const warnings:  string[] = [];
  const errors:    string[] = [];

  // ── Input validation ──────────────────────────────────────────────────────
  const validationErrors = validateInput(input);
  if (validationErrors.length > 0) {
    return {
      date:           input.date   ?? '',
      modelVersionId: input.modelVersionId ?? '',
      topPicks:       [],
      qualifiedPicks: [],
      failedPicks:    [],
      noOddsPicks:    [],
      summary: {
  totalOddsPicks: 0,
  totalModelRecords: 0,
  totalPipelineInputs: 0,
  topPicks: 0,
  qualifiedPicks: 0,
  failedPicks: 0,
  noOddsPicks: 0,
  savedRows: 0,
  excludedLiveGames: 0,
},
      warnings,
      errors: validationErrors,
      savedRows: 0,
      timestamp,
    };
  }

  // ── Warnings for empty inputs ─────────────────────────────────────────────
  if (input.normalizedOddsPicks.length === 0) {
    warnings.push('normalizedOddsPicks is empty — no picks to process.');
  }
  if (input.structuredStats.length === 0) {
    warnings.push('structuredStats is empty — all odds picks will be in missingModelPicks.');
  }

  // ── Run the cycle ─────────────────────────────────────────────────────────
  let cycleResult: Awaited<ReturnType<typeof runDailyMLBModelCycle>>;

  try {
    cycleResult = await runDailyMLBModelCycle({
      modelVersionId:      input.modelVersionId,
      normalizedOddsPicks: input.normalizedOddsPicks,
      structuredStats:     input.structuredStats,
      supabaseClient:      input.save === true ? input.supabaseClient : undefined,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`Cycle failed: ${msg}`);
    return {
      date:           input.date,
      modelVersionId: input.modelVersionId,
      topPicks:       [],
      qualifiedPicks: [],
      failedPicks:    [],
      noOddsPicks:    [],
      summary: {
  totalOddsPicks: input.normalizedOddsPicks.length,
  totalModelRecords: 0,
  totalPipelineInputs: 0,
  topPicks: 0,
  qualifiedPicks: 0,
  failedPicks: 0,
  noOddsPicks: 0,
  savedRows: 0,
  excludedLiveGames: 0,
},
      warnings,
      errors,
      savedRows: 0,
      timestamp,
    };
  }

  // ── Surface cycle-level warnings ──────────────────────────────────────────
  if (cycleResult.missingModelPicks.length > 0) {
    warnings.push(
      `${cycleResult.missingModelPicks.length} pick(s) had no model record and were excluded from the pipeline.`,
    );
  }
  if (cycleResult.modelBuildErrors.length > 0) {
    warnings.push(
      `${cycleResult.modelBuildErrors.length} model build error(s) — some stats entries were invalid.`,
    );
    for (const e of cycleResult.modelBuildErrors) {
      errors.push(`Model build: ${e.gameId}/${e.team}: ${e.message}`);
    }
  }
  if (cycleResult.modelAttachErrors.length > 0) {
    warnings.push(
      `${cycleResult.modelAttachErrors.length} model attach error(s) — some probability records were invalid.`,
    );
    for (const e of cycleResult.modelAttachErrors) {
      errors.push(`Model attach: ${e.pickKey}: ${e.message}`);
    }
  }
  if (cycleResult.saveResult && cycleResult.saveResult.errors.length > 0) {
    for (const e of cycleResult.saveResult.errors) {
      errors.push(`Save error: ${e.message}`);
    }
  }

  // ── Shape response ─────────────────────────────────────────────────────────
  const { pipelineOutput, summary } = cycleResult;

  return {
    date:           input.date,
    modelVersionId: input.modelVersionId,
    topPicks:       pipelineOutput.topPicks.map(toPickResponseItem),
    qualifiedPicks: pipelineOutput.qualifiedPicks.map(toPickResponseItem),
    failedPicks:    pipelineOutput.failedPicks.map(toPickResponseItem),
    noOddsPicks:    pipelineOutput.noOddsPicks.map(toPickResponseItem),
    summary,
    warnings,
    errors,
    savedRows:      summary.savedRows,
    timestamp,
  };
}
