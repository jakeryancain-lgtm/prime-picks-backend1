// ─────────────────────────────────────────────────────────────────────────────
// Shared Supabase client interface
// ─────────────────────────────────────────────────────────────────────────────
// Generic over the row type so both results.service and settlement.service
// can define narrowly-typed fakes without clashing.

export interface SupabaseInsertResult {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

/**
 * Minimal interface over the Supabase client's insert path.
 * Production code passes a real @supabase/supabase-js client.
 * Tests pass a FakeSupabaseClient without needing real credentials.
 *
 * The insert parameter is typed as `unknown[]` so both ModelPredictionRow[]
 * and PickResultRow[] satisfy it without a separate interface per service.
 */
export interface SupabaseClientLike {
  from: (table: string) => {
    insert: (rows: unknown[]) => Promise<SupabaseInsertResult>;
  };
}
