// ─────────────────────────────────────────────────────────────────────────────
// Shared Supabase client interface
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseInsertResult {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

export interface SupabaseSelectResult {
  data: unknown[] | null;
  error: { message: string; code?: string } | null;
}

export interface InsertOptions {
  /** When true, inserts use ON CONFLICT DO NOTHING — duplicate rows are silently skipped. */
  ignoreDuplicates?: boolean;
  /** When true, pass "Prefer: return=representation" to get inserted rows back. */
  returning?: boolean;
}

/**
 * Minimal interface over the Supabase client covering:
 *   - insert (all save paths)
 *   - select().eq().limit() chain (ensureModelVersion lookup)
 *
 * Production: HttpSupabaseClient in src/config/supabase.ts
 * Tests: FakeSupabaseClient in each test file
 */
export interface SupabaseQueryBuilder {
  eq:    (col: string, val: string) => SupabaseQueryBuilder;
  limit: (n: number)                => Promise<SupabaseSelectResult>;
}

export interface SupabaseTableRef {
  insert: (rows: unknown[], options?: InsertOptions) => Promise<SupabaseInsertResult>;
  select: (cols: string)                              => SupabaseQueryBuilder;
}

export interface SupabaseClientLike {
  from: (table: string) => SupabaseTableRef;
}
