import type {
  SupabaseClientLike,
  SupabaseInsertResult,
  SupabaseSelectResult,
  SupabaseQueryBuilder,
  SupabaseTableRef,
  InsertOptions,
} from '../services/supabase.types';

// =============================================================================
// Supabase Client Configuration
// =============================================================================

const ENV_URL = 'SUPABASE_URL';
const ENV_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

export interface SupabaseConfig {
  url:            string;
  serviceRoleKey: string;
}

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
// HTTP-based Supabase client
// ─────────────────────────────────────────────────────────────────────────────

class HttpSupabaseClient implements SupabaseClientLike {
  constructor(
    private readonly url: string,
    private readonly key: string,
  ) {}

  from(table: string): SupabaseTableRef {
    const { url, key } = this;

    // ── select().eq().limit() ─────────────────────────────────────────────
    const select = (cols: string): SupabaseQueryBuilder => {
      const filters: Array<{ col: string; val: string }> = [];
      let _cols = cols;

      const builder: SupabaseQueryBuilder = {
        eq(col: string, val: string): SupabaseQueryBuilder {
          filters.push({ col, val });
          return builder;
        },

        async limit(n: number): Promise<SupabaseSelectResult> {
          // Build query string: ?select=col1,col2&col=eq.val&limit=n
          const params = new URLSearchParams();
          if (_cols && _cols !== '*') params.set('select', _cols);
          for (const f of filters) params.set(f.col, `eq.${f.val}`);
          params.set('limit', String(n));

          let response: Response;
          try {
            response = await fetch(`${url}/rest/v1/${table}?${params.toString()}`, {
              method:  'GET',
              headers: {
                'apikey':         key,
                'Authorization': `Bearer ${key}`,
                'Accept':        'application/json',
              },
            });
          } catch (e: unknown) {
            return {
              data:  null,
              error: { message: e instanceof Error ? e.message : String(e) },
            };
          }

          if (!response.ok) {
            let errBody: { message?: string } = {};
            try { errBody = await response.json() as { message?: string }; } catch { /**/ }
            return {
              data:  null,
              error: { message: errBody.message ?? `HTTP ${response.status}: ${response.statusText}` },
            };
          }

          const data = await response.json() as unknown[];
          return { data, error: null };
        },
      };

      return builder;
    };

    // ── insert ────────────────────────────────────────────────────────────
    const insert = async (
      rows:    unknown[],
      options?: InsertOptions,
    ): Promise<SupabaseInsertResult> => {
      if (rows.length === 0) return { data: [], error: null };

      const preferParts: string[] = [];
      if (options?.ignoreDuplicates) preferParts.push('resolution=ignore-duplicates');
      preferParts.push('return=representation');
      const prefer = preferParts.join(',');

      // When ignoring duplicates on model_predictions, PostgREST needs the
      // on_conflict query parameter pointing to the composite UNIQUE constraint
      // columns. Without it, PostgREST defaults to the primary key (id), finds
      // no conflict (every new row has a new UUID), inserts all rows, and then
      // the DB itself raises the unique constraint violation.
      // The on_conflict columns must exactly match the uq_prediction_identity
      // constraint defined in schema.sql.
      let endpoint = `${url}/rest/v1/${table}`;
      if (options?.ignoreDuplicates && table === 'model_predictions') {
        const onConflict = [
          'model_version_id',
          'sport',
          'league',
          'game_id',
          'team',
          'bet_type',
          'market_type',
          'prediction_date',
        ].join(',');
        endpoint = `${endpoint}?on_conflict=${onConflict}`;
      }

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'apikey':         key,
            'Authorization': `Bearer ${key}`,
            'Prefer':        prefer,
          },
          body: JSON.stringify(rows),
        });
      } catch (e: unknown) {
        return {
          data:  null,
          error: { message: e instanceof Error ? e.message : String(e), code: 'NETWORK_ERROR' },
        };
      }

      if (!response.ok) {
        let errorBody: { message?: string; code?: string } = {};
        try { errorBody = await response.json() as { message?: string; code?: string }; } catch { /**/ }
        return {
          data:  null,
          error: {
            message: errorBody.message ?? `HTTP ${response.status}: ${response.statusText}`,
            code:    errorBody.code    ?? String(response.status),
          },
        };
      }

      const data = await response.json() as unknown[];
      return { data, error: null };
    };

    return { select, insert };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory + singleton
// ─────────────────────────────────────────────────────────────────────────────

export function createSupabaseClient(config?: SupabaseConfig): SupabaseClientLike {
  const resolved = config ?? readSupabaseConfig();
  return new HttpSupabaseClient(resolved.url, resolved.serviceRoleKey);
}

let _instance: SupabaseClientLike | null = null;

export function getSupabaseClient(): SupabaseClientLike {
  if (!_instance) _instance = createSupabaseClient();
  return _instance;
}

export function resetSupabaseClient(): void {
  _instance = null;
}
