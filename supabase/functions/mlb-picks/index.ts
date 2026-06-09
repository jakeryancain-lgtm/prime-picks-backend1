/**
 * Supabase Edge Function: mlb-picks
 *
 * Exposes getMLBPicksHandler() as an HTTP endpoint Lovable can call.
 *
 * GET  /functions/v1/mlb-picks?date=2025-06-10&save=false   — preview mode
 * POST /functions/v1/mlb-picks                              — advanced config
 * OPTIONS /functions/v1/mlb-picks                           — CORS preflight
 *
 * Environment variables (set in Supabase dashboard → Edge Functions → Secrets):
 *   ODDS_API_KEY              Required always
 *   SUPABASE_URL              Required only when save=true
 *   SUPABASE_SERVICE_ROLE_KEY Required only when save=true
 *
 * The service role key is never forwarded to the frontend.
 * The endpoint never executes any betting logic — it only orchestrates the
 * backend modules that already exist and are tested.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Imports — Deno-compatible, no npm: prefix needed for stdlib
// ─────────────────────────────────────────────────────────────────────────────

// These imports resolve at deploy time via Supabase's Deno environment.
// For local type-checking, the paths resolve via the import map in deno.json.
import { assembleTeamGameStats }  from '../../src/adapters/mlbStats.ingestion.ts';
import { fetchMLBOdds }           from '../../src/adapters/oddsApi.adapter.ts';
import { buildModelProbabilityMap } from '../../src/adapters/mlbStatsModel.adapter.ts';
import { matchOddsToStats }       from '../../src/adapters/mlbGameMatcher.adapter.ts';
import { attachModelProbabilities } from '../../src/adapters/mlbModel.adapter.ts';
import { getMLBPicksHandler }     from '../../src/api/mlbPicks.handler.ts';
import type { MLBPicksHandlerInput } from '../../src/api/mlbPicks.handler.ts';

// ─────────────────────────────────────────────────────────────────────────────
// CORS
// ─────────────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
  'Access-Control-Max-Age':       '86400',
};

function corsResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Request parsing
// ─────────────────────────────────────────────────────────────────────────────

interface EndpointInput {
  date?:           string;
  modelVersionId?: string;
  save?:           boolean;
}

function parseGetParams(url: URL): EndpointInput {
  return {
    date:           url.searchParams.get('date')           ?? undefined,
    modelVersionId: url.searchParams.get('modelVersionId') ?? undefined,
    save:           url.searchParams.get('save') === 'true',
  };
}

async function parsePostBody(req: Request): Promise<EndpointInput> {
  try {
    const body = await req.json() as EndpointInput;
    return {
      date:           typeof body.date           === 'string'  ? body.date           : undefined,
      modelVersionId: typeof body.modelVersionId === 'string'  ? body.modelVersionId : undefined,
      save:           typeof body.save           === 'boolean' ? body.save           : false,
    };
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment validation
// ─────────────────────────────────────────────────────────────────────────────

function getRequiredEnv(key: string): string | null {
  // Deno.env.get is available in Supabase Edge Functions
  return (Deno as unknown as { env: { get(k: string): string | undefined } })
    .env.get(key) ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client factory (only when save=true)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a minimal Supabase-compatible client using fetch.
 * The service role key is read from env and NEVER sent to the frontend.
 * Returns null when credentials are not configured.
 */
function createEdgeSupabaseClient(url: string, key: string) {
  return {
    from(table: string) {
      return {
        async insert(rows: unknown[]) {
          if (rows.length === 0) return { data: [], error: null };
          try {
            const response = await fetch(`${url}/rest/v1/${table}`, {
              method:  'POST',
              headers: {
                'Content-Type':  'application/json',
                'apikey':         key,
                'Authorization': `Bearer ${key}`,
                'Prefer':        'return=representation',
              },
              body: JSON.stringify(rows),
            });
            if (!response.ok) {
              const errBody = await response.json().catch(() => ({})) as Record<string, unknown>;
              return {
                data:  null,
                error: {
                  message: String(errBody['message'] ?? `HTTP ${response.status}`),
                  code:    String(errBody['code']    ?? response.status),
                },
              };
            }
            const data = await response.json();
            return { data, error: null };
          } catch (e: unknown) {
            return {
              data:  null,
              error: { message: e instanceof Error ? e.message : String(e), code: 'NETWORK_ERROR' },
            };
          }
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only accept GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return corsResponse(405, { error: `Method ${req.method} not allowed. Use GET or POST.` });
  }

  // ── Parse input ────────────────────────────────────────────────────────────
  const url    = new URL(req.url);
  const input  = req.method === 'POST' ? await parsePostBody(req) : parseGetParams(url);

  const date           = input.date           ?? new Date().toISOString().slice(0, 10);
  const modelVersionId = input.modelVersionId ?? 'mlb-stats-v1';
  const save           = input.save           ?? false;
  const season         = parseInt(date.slice(0, 4), 10);

  // ── Validate ODDS_API_KEY ─────────────────────────────────────────────────
  const oddsApiKey = getRequiredEnv('ODDS_API_KEY');
  if (!oddsApiKey) {
    return corsResponse(500, {
      error:    'ODDS_API_KEY is not configured in edge function secrets.',
      topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
      missingModelPicks: [], warnings: [], errors: ['ODDS_API_KEY missing'], summary: null,
    });
  }

  // Inject the key into the process environment so readOddsApiConfig() can find it
  (Deno as unknown as { env: { set(k: string, v: string): void } }).env.set('ODDS_API_KEY', oddsApiKey);

  // ── Fetch stats ────────────────────────────────────────────────────────────
  let statsResult = { teamGameStats: [] as ReturnType<typeof assembleTeamGameStats> extends Promise<infer R> ? R extends { teamGameStats: infer T } ? T : never : never, warnings: [] as unknown[], errors: [] as unknown[] };

  try {
    const result = await assembleTeamGameStats(date, season);
    statsResult = result as typeof statsResult;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse(503, {
      error: `Stats ingestion failed: ${msg}`,
      topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
      missingModelPicks: [], warnings: [], errors: [msg], summary: null,
    });
  }

  // ── Fetch odds ─────────────────────────────────────────────────────────────
  let normalizedOddsPicks: Awaited<ReturnType<typeof fetchMLBOdds>>['picks'] = [];

  try {
    const oddsResult = await fetchMLBOdds({ markets: ['h2h'] });
    normalizedOddsPicks = oddsResult.picks;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return corsResponse(503, {
      error: `Odds fetch failed: ${msg}`,
      topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
      missingModelPicks: [], warnings: [], errors: [msg], summary: null,
    });
  }

  // ── Match odds to stats ────────────────────────────────────────────────────
  const gameDateByOddsGameId = new Map(normalizedOddsPicks.map(p => [p.gameId, date]));
  const matchResult = matchOddsToStats(
    normalizedOddsPicks,
    statsResult.teamGameStats,
    gameDateByOddsGameId,
  );

  // ── Build model map ────────────────────────────────────────────────────────
  const { map: modelProbabilityMap } = buildModelProbabilityMap(
    statsResult.teamGameStats,
    modelVersionId,
  );

  // ── Attach probabilities ───────────────────────────────────────────────────
  const { readyPicks, missingModelPicks } = attachModelProbabilities(
    matchResult.matchedPicks,
    modelProbabilityMap,
    modelVersionId,
  );

  // ── Build handler input ────────────────────────────────────────────────────
  const handlerInput: MLBPicksHandlerInput = {
    date,
    modelVersionId,
    normalizedOddsPicks: readyPicks,
    structuredStats:     statsResult.teamGameStats,
    save,
  };

  // Attach Supabase client only if save=true and credentials are available
  if (save) {
    const supabaseUrl = getRequiredEnv('SUPABASE_URL');
    const serviceKey  = getRequiredEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (supabaseUrl && serviceKey) {
      handlerInput.supabaseClient = createEdgeSupabaseClient(supabaseUrl, serviceKey);
    } else {
      // Downgrade save to false and add a warning — don't crash
      handlerInput.save = false;
    }
  }

  // ── Run handler ────────────────────────────────────────────────────────────
  const response = await getMLBPicksHandler(handlerInput);

  // ── Augment response with matcher data ────────────────────────────────────
  const fullResponse = {
    ...response,
    missingModelPicks: missingModelPicks.map(p => ({
      gameId:   p.gameId,
      team:     p.team,
      opponent: p.opponent,
      betType:  p.betType,
    })),
    matcherWarnings: matchResult.warnings.map(w => `[${w.code}] ${w.team}: ${w.message}`),
    unmatchedOddsPicks: matchResult.unmatchedOddsPicks.length,
  };

  return corsResponse(200, fullResponse);
});
