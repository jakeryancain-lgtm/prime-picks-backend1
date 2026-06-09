import type { SupabaseClientLike, SupabaseInsertResult } from '../services/supabase.types';

// =============================================================================
// Supabase Client Configuration
// =============================================================================
// This module validates required environment variables and provides a
// singleton Supabase client compatible with the SupabaseClientLike interface.
//
// CONNECTING THE REAL SDK
// -----------------------
// When @supabase/supabase-js is installed (npm install @supabase/supabase-js),
// replace the HttpSupabaseClient class below with:
//
//   import { createClient } from '@supabase/supabase-js';
//   return createClient(url, key);
//
// The real client satisfies SupabaseClientLike structurally — no other changes
// required in any engine or service.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Environment variable names
// ─────────────────────────────────────────────────────────────────────────────

const ENV_URL = 'SUPABASE_URL';
const ENV_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

// ─────────────────────────────────────────────────────────────────────────────
// Config validation
// ─────────────────────────────────────────────────────────────────────────────

export interface SupabaseConfig {
  url:            string;
  serviceRoleKey: string;
}

/**
 * Reads and validates Supabase environment variables.
 *
 * @throws if SUPABASE_URL is missing or blank
 * @throws if SUPABASE_SERVICE_ROLE_KEY is missing or blank
 */
export function readSupabaseConfig(): SupabaseConfig {
  const url = process.env[ENV_URL];
  if (!url || url.trim() === '') {
    throw new Error(
      `Missing environment variable: ${ENV_URL}. ` +
      'Set it to your Supabase project URL (e.g. https://xyz.supabase.co).',
    );
  }

  const serviceRoleKey = process.env[ENV_KEY];
  if (!serviceRoleKey || serviceRoleKey.trim() === '') {
    throw new Error(
      `Missing environment variable: ${ENV_KEY}. ` +
      'Set it to your Supabase service role key. Never commit this value.',
    );
  }

  return { url: url.trim(), serviceRoleKey: serviceRoleKey.trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-based Supabase client (no SDK dependency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Supabase REST client that satisfies SupabaseClientLike.
 *
 * Uses the Supabase REST API directly via the built-in Node.js fetch (v18+).
 * This removes the @supabase/supabase-js SDK as a hard dependency while
 * keeping the interface identical — swap in the real SDK whenever available.
 *
 * Covers the insert path only (the only operation the pipeline currently uses).
 * Query and update operations belong in a future data-access layer.
 */
class HttpSupabaseClient implements SupabaseClientLike {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  from(table: string) {
    const { url, key } = this;

    return {
      insert: async (rows: unknown[]): Promise<SupabaseInsertResult> => {
        if (rows.length === 0) {
          return { data: [], error: null };
        }

        let response: Response;
        try {
          response = await fetch(`${url}/rest/v1/${table}`, {
            method:  'POST',
            headers: {
              'Content-Type':  'application/json',
              'apikey':         key,
              'Authorization': `Bearer ${key}`,
              'Prefer':        'return=representation',
            },
            body: JSON.stringify(rows),
          });
        } catch (e: unknown) {
          return {
            data:  null,
            error: {
              message: e instanceof Error ? e.message : String(e),
              code:    'NETWORK_ERROR',
            },
          };
        }

        if (!response.ok) {
          let errorBody: { message?: string; code?: string } = {};
          try {
            errorBody = await response.json() as { message?: string; code?: string };
          } catch {
            // Response body not JSON — use HTTP status text
          }
          return {
            data:  null,
            error: {
              message: errorBody.message ?? `HTTP ${response.status}: ${response.statusText}`,
              code:    errorBody.code ?? String(response.status),
            },
          };
        }

        const data = await response.json() as unknown[];
        return { data, error: null };
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new Supabase client from the provided config.
 *
 * Prefer `getSupabaseClient()` for production use (singleton).
 * Use `createSupabaseClient()` directly when you need a fresh client,
 * e.g. in tests that inject specific credentials.
 *
 * @throws if config validation fails (missing env vars)
 */
export function createSupabaseClient(
  config?: SupabaseConfig,
): SupabaseClientLike {
  const resolved = config ?? readSupabaseConfig();
  return new HttpSupabaseClient(resolved.url, resolved.serviceRoleKey);
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton
// ─────────────────────────────────────────────────────────────────────────────

let _instance: SupabaseClientLike | null = null;

/**
 * Returns the shared Supabase client instance.
 * Creates it on the first call; returns the cached instance on every
 * subsequent call within the same process.
 *
 * Call `resetSupabaseClient()` in tests to clear the singleton between cases.
 *
 * @throws if SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are not set
 */
export function getSupabaseClient(): SupabaseClientLike {
  if (!_instance) {
    _instance = createSupabaseClient();
  }
  return _instance;
}

/**
 * Clears the singleton instance.
 * Intended for use in tests — allows each test to exercise the
 * creation path independently without process restarts.
 */
export function resetSupabaseClient(): void {
  _instance = null;
}
