import type { SettlementResult } from '../engines/settlement.engine';
import type { SupabaseClientLike } from './supabase.types';
export type { SupabaseClientLike } from './supabase.types';

// ─────────────────────────────────────────────────────────────────────────────
// DB row shape — mirrors schema.sql pick_results columns exactly
// ─────────────────────────────────────────────────────────────────────────────

export interface PickResultRow {
  prediction_id:               string;
  result:                      string;   // 'WIN' | 'LOSS' | 'PUSH' | 'VOID'
  closing_odds:                number | null;
  closing_implied_probability: number | null;
  clv_decimal:                 number | null;
  stake:                       number;
  profit_loss:                 number;
  roi:                         number;
  settled_at:                  string;   // ISO-8601 timestamp
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-export so callers only need one import
// ─────────────────────────────────────────────────────────────────────────────



// ─────────────────────────────────────────────────────────────────────────────
// Mapping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps a SettlementResult (from settlement.engine) to a pick_results DB row.
 *
 * @throws if predictionId is missing or blank — the foreign key is required.
 */
export function mapSettlementToDbRow(
  settlement: SettlementResult,
  settledAt: string = new Date().toISOString(),
): PickResultRow {
  if (!settlement.predictionId || settlement.predictionId.trim() === '') {
    throw new Error(
      'mapSettlementToDbRow: predictionId is required. ' +
      'Every settlement must reference a prediction.',
    );
  }

  return {
    prediction_id:               settlement.predictionId,
    result:                      settlement.result,
    closing_odds:                settlement.closingOdds,
    closing_implied_probability: settlement.closingImpliedProbability,
    clv_decimal:                 settlement.clvDecimal,
    stake:                       settlement.stake,
    profit_loss:                 settlement.profitLoss,
    roi:                         settlement.roi,
    settled_at:                  settledAt,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate detection
// ─────────────────────────────────────────────────────────────────────────────

export interface DuplicateCheckResult {
  unique: SettlementResult[];
  duplicates: string[];
}

/**
 * Splits an array of settlement results into unique (first-occurrence) and
 * duplicate (subsequent-occurrence) sets based on predictionId.
 *
 * A duplicate in this context means the same predictionId appears more than
 * once in the batch being submitted. This is distinct from a DB-level conflict
 * (predictionId already persisted), which is handled by Supabase's UNIQUE
 * constraint and surfaces as an error from the insert call.
 */
export function deduplicateSettlements(
  settlements: SettlementResult[],
): DuplicateCheckResult {
  const seen       = new Set<string>();
  const unique:     SettlementResult[] = [];
  const duplicates: string[]           = [];

  for (const s of settlements) {
    if (seen.has(s.predictionId)) {
      duplicates.push(s.predictionId);
    } else {
      seen.add(s.predictionId);
      unique.push(s);
    }
  }

  return { unique, duplicates };
}

// ─────────────────────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface SaveSettlementResult {
  insertedCount: number;
  duplicatesSkipped: string[];
  errors: Array<{ message: string; code?: string }>;
}

/**
 * Persists settlement results to the pick_results table.
 *
 * Duplicate predictionIds within the batch are removed before the insert —
 * only the first occurrence of each id is saved. The skipped ids are reported
 * in `duplicatesSkipped` so callers can log or investigate.
 *
 * The database's UNIQUE constraint on prediction_id is the final guard against
 * double-settlement of a prediction that was already persisted in a prior call.
 * When that constraint fires, Supabase returns an error (code '23505') which
 * is captured in `errors` rather than crashing.
 *
 * All valid rows are inserted in a single batched call. No partial inserts
 * — if the insert fails the whole batch is in the error and nothing is written.
 *
 * @param settlements  Array of SettlementResult from settlement.engine
 * @param client       SupabaseClientLike — real client or fake in tests
 * @param settledAt    Optional override for settled_at timestamp (useful in tests)
 */
export async function saveSettlementResults(
  settlements: SettlementResult[],
  client: SupabaseClientLike,
  settledAt?: string,
): Promise<SaveSettlementResult> {
  if (settlements.length === 0) {
    return { insertedCount: 0, duplicatesSkipped: [], errors: [] };
  }

  // ── Step 1: remove in-batch duplicates ───────────────────────────────────
  const { unique, duplicates } = deduplicateSettlements(settlements);

  if (unique.length === 0) {
    return {
      insertedCount:     0,
      duplicatesSkipped: duplicates,
      errors:            [],
    };
  }

  // ── Step 2: map to DB rows ────────────────────────────────────────────────
  const timestamp = settledAt ?? new Date().toISOString();
  let rows: PickResultRow[];

  try {
    rows = unique.map(s => mapSettlementToDbRow(s, timestamp));
  } catch (e: unknown) {
    // Mapping validation failed (e.g. blank predictionId in one of the unique items)
    throw e; // Re-throw — this is a programming error, not a DB error
  }

  // ── Step 3: single batched insert ─────────────────────────────────────────
  const { error } = await client.from('pick_results').insert(rows);

  if (error) {
    return {
      insertedCount:     0,
      duplicatesSkipped: duplicates,
      errors:            [{ message: error.message, code: error.code }],
    };
  }

  return {
    insertedCount:     rows.length,
    duplicatesSkipped: duplicates,
    errors:            [],
  };
}
