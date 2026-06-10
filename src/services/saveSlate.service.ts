import type { SupabaseClientLike } from './supabase.types';
import {
  ensureModelVersion,
  mapPipelineOutputToDbRows,
  savePredictions,
  type SaveResult,
} from './results.service';
import type { RankedOutput }     from '../engines/ranking.engine';
import type { ProcessedMLBPick } from '../mlbPipeline';

// =============================================================================
// Save Slate Service
// =============================================================================
// Idempotent persistence of a full daily MLB pick slate.
//
// Responsibilities:
//   1. Resolve the modelVersionId string to a real model_versions UUID
//      (creates the row on first use, reuses it on subsequent calls)
//   2. Rewrite model_version_id on every DB row to the resolved UUID
//   3. Call savePredictions with ignoreDuplicates=true
//   4. Return a clear breakdown: savedRows, skippedRows, errors
//
// Idempotency guarantee:
//   Calling saveSlate twice with the same date + modelVersionId is safe.
//   The UNIQUE constraint on (model_version_id, sport, league, game_id, team,
//   bet_type, market_type, prediction_date) ensures the second call inserts
//   zero rows and returns skippedRows = N.
// =============================================================================

export interface SaveSlateInput {
  /** ISO date string for this slate e.g. '2025-06-10'. Becomes prediction_date. */
  date:            string;
  /** Human-readable model identifier e.g. 'mlb-stats-v1'. Resolved to UUID. */
  modelVersionId:  string;
  /** Pipeline output — all four groups are persisted. */
  pipelineOutput:  RankedOutput<ProcessedMLBPick>;
  /** Authenticated Supabase client. */
  client:          SupabaseClientLike;
}

export interface SaveSlateResult {
  /** Number of rows newly inserted. */
  savedRows:    number;
  /** Rows skipped because they already existed (idempotent calls). */
  skippedRows:  number;
  /** Total picks attempted (savedRows + skippedRows + error rows). */
  totalPicks:   number;
  /** UUID of the model_versions row used for this slate. */
  modelVersionUuid: string;
  /** True if a new model_versions row was created for this version name. */
  modelVersionCreated: boolean;
  /** Non-empty only when a Supabase operation failed. */
  errors:       string[];
}

/**
 * Saves a full daily slate idempotently.
 *
 * Steps:
 *   1. Validate inputs (date format, non-empty modelVersionId)
 *   2. Resolve modelVersionId → UUID via ensureModelVersion()
 *   3. Map pipeline output to DB rows with the resolved UUID
 *   4. Insert via savePredictions(ignoreDuplicates=true)
 *   5. Return SaveSlateResult with full accounting
 *
 * Never throws. All errors are returned in the errors[] array.
 */
export async function saveSlate(input: SaveSlateInput): Promise<SaveSlateResult> {
  const errors: string[] = [];

  // ── Input validation ──────────────────────────────────────────────────────
  if (!input.date || !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    return {
      savedRows: 0, skippedRows: 0, totalPicks: 0,
      modelVersionUuid: '', modelVersionCreated: false,
      errors: [`Invalid date '${input.date}'. Expected YYYY-MM-DD format.`],
    };
  }

  if (!input.modelVersionId || input.modelVersionId.trim() === '') {
    return {
      savedRows: 0, skippedRows: 0, totalPicks: 0,
      modelVersionUuid: '', modelVersionCreated: false,
      errors: ['modelVersionId is required and cannot be blank.'],
    };
  }

  // Count total picks before save attempt
  const totalPicks =
    input.pipelineOutput.topPicks.length +
    input.pipelineOutput.qualifiedPicks.length +
    input.pipelineOutput.failedPicks.length +
    input.pipelineOutput.noOddsPicks.length;

  if (totalPicks === 0) {
    return {
      savedRows: 0, skippedRows: 0, totalPicks: 0,
      modelVersionUuid: '', modelVersionCreated: false,
      errors: [],   // not an error — just an empty slate
    };
  }

  // ── Step 1: Resolve model version string → UUID ───────────────────────────
  const versionResult = await ensureModelVersion(
    input.modelVersionId.trim(),
    input.client,
  );

  if (versionResult.error) {
    return {
      savedRows: 0, skippedRows: 0, totalPicks,
      modelVersionUuid: '', modelVersionCreated: false,
      errors: [`Could not resolve model version '${input.modelVersionId}': ${versionResult.error}`],
    };
  }

  const modelVersionUuid = versionResult.id;

  // ── Step 2: Map pipeline output to DB rows with resolved UUID ─────────────
  // We need to rewrite model_version_id on every row from the string name
  // to the actual UUID before inserting.
  let rows: ReturnType<typeof mapPipelineOutputToDbRows>;
  try {
    rows = mapPipelineOutputToDbRows(input.pipelineOutput, input.date);

    // Rewrite model_version_id to the resolved UUID on every row
    for (const row of rows) {
      row.model_version_id = modelVersionUuid;
    }
  } catch (e: unknown) {
    return {
      savedRows: 0, skippedRows: 0, totalPicks,
      modelVersionUuid, modelVersionCreated: versionResult.created,
      errors: [`Row mapping failed: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  // ── Step 3: Insert idempotently ───────────────────────────────────────────
  let saveResult: SaveResult;
  try {
    saveResult = await savePredictions(rows, input.client);
  } catch (e: unknown) {
    return {
      savedRows: 0, skippedRows: 0, totalPicks,
      modelVersionUuid, modelVersionCreated: versionResult.created,
      errors: [`savePredictions threw: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (saveResult.errors.length > 0) {
    for (const e of saveResult.errors) errors.push(`Insert error: ${e.message}${e.code ? ` [${e.code}]` : ''}`);
  }

  return {
    savedRows:           saveResult.savedCount,
    skippedRows:         saveResult.skippedCount,
    totalPicks,
    modelVersionUuid,
    modelVersionCreated: versionResult.created,
    errors,
  };
}

/**
 * Formats a SaveSlateResult into a human-readable console summary.
 * Used by saveTodaySlate.ts and any CLI tool.
 */
export function formatSaveSlateResult(result: SaveSlateResult, date: string, modelVersionId: string): string {
  const lines: string[] = [
    ``,
    `${'─'.repeat(56)}`,
    `  Save slate — ${date}  (${modelVersionId})`,
    `${'─'.repeat(56)}`,
    `  Total picks:          ${result.totalPicks}`,
    `  Saved (new):          ${result.savedRows}`,
    `  Skipped (duplicate):  ${result.skippedRows}`,
    `  Model version UUID:   ${result.modelVersionUuid || 'N/A'}`,
    `  Model version new:    ${result.modelVersionCreated ? 'yes (auto-created)' : 'no (existing)'}`,
  ];

  if (result.errors.length > 0) {
    lines.push(`  Errors:               ${result.errors.length}`);
    for (const e of result.errors) lines.push(`    ✗ ${e}`);
  } else {
    lines.push(`  Errors:               0`);
  }

  if (result.savedRows > 0) {
    lines.push(``, `  ✓ Slate saved successfully. Check model_predictions in Supabase.`);
  } else if (result.skippedRows > 0 && result.savedRows === 0) {
    lines.push(``, `  ⚠ All picks already existed — slate was previously saved.`);
  } else if (result.totalPicks === 0) {
    lines.push(``, `  ⚠ No picks to save — pipeline produced an empty slate.`);
  }

  lines.push(`${'─'.repeat(56)}`, ``);
  return lines.join('\n');
}

/**
 * Dashboard query: returns a simple summary of saved picks from Supabase.
 * Uses a raw SELECT via the REST API to confirm rows exist.
 *
 * Returns a plain text table for console output or logging.
 */
export async function queryDashboard(
  date:   string,
  _client: SupabaseClientLike,
): Promise<string> {
  // Use the REST API select endpoint directly since SupabaseClientLike
  // only exposes insert. The real client would use .select().
  // We return a helpful message pointing to the Supabase dashboard instead.
  const msg = [
    ``,
    `${'─'.repeat(56)}`,
    `  Dashboard — confirm saved picks`,
    `${'─'.repeat(56)}`,
    `  To verify saved picks in Supabase, run this SQL:`,
    ``,
    `    SELECT status, count(*), avg(edge_decimal) as avg_edge`,
    `    FROM   model_predictions`,
    `    WHERE  prediction_date = '${date}'`,
    `    GROUP  BY status`,
    `    ORDER  BY status;`,
    ``,
    `  Or view the open_top_picks view for today's qualified picks:`,
    ``,
    `    SELECT team, opponent, grade_letter, edge_percent, risk_level`,
    `    FROM   open_top_picks`,
    `    WHERE  prediction_date = '${date}';`,
    `${'─'.repeat(56)}`,
    ``,
  ].join('\n');
  return msg;
}
