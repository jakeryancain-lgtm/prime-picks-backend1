/**
 * Prime Picks — MLB Picks HTTP Endpoint (Node.js)
 *
 * A lightweight HTTP wrapper around getMLBPicksHandler() suitable for:
 *   - Vercel serverless functions (export default handler)
 *   - Railway / Render (ts-node src/api/mlbPicks.endpoint.ts)
 *   - Any Node.js-compatible serverless platform
 *
 * GET  /api/mlb-picks?date=2025-06-10          — preview mode (save=false)
 * POST /api/mlb-picks  { date, save, modelVersionId }  — advanced config
 * OPTIONS /api/mlb-picks                        — CORS preflight
 *
 * Env vars required:
 *   ODDS_API_KEY                   Always required
 *   SUPABASE_URL                   Required only when save=true
 *   SUPABASE_SERVICE_ROLE_KEY      Required only when save=true
 *   PORT                           Optional, defaults to 3001
 */

import * as http from 'http';
import { assembleTeamGameStats }    from '../adapters/mlbStats.ingestion';
import { fetchMLBOdds }             from '../adapters/oddsApi.adapter';
import { buildModelProbabilityMap } from '../adapters/mlbStatsModel.adapter';
import { matchOddsToStats }         from '../adapters/mlbGameMatcher.adapter';
import { attachModelProbabilities } from '../adapters/mlbModel.adapter';
import { getMLBPicksHandler }       from './mlbPicks.handler';
import type { MLBPicksHandlerInput } from './mlbPicks.handler';

// ─────────────────────────────────────────────────────────────────────────────
// CORS headers
// ─────────────────────────────────────────────────────────────────────────────

export const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age':       '86400',
};

// ─────────────────────────────────────────────────────────────────────────────
// Response helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface EndpointResponse {
  status:  number;
  body:    unknown;
  headers: Record<string, string>;
}

function jsonResponse(status: number, body: unknown): EndpointResponse {
  return {
    status,
    body,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  };
}

function errorResponse(status: number, message: string, extra: Record<string, unknown> = {}): EndpointResponse {
  return jsonResponse(status, {
    error:             message,
    topPicks:          [],
    qualifiedPicks:    [],
    failedPicks:       [],
    noOddsPicks:       [],
    missingModelPicks: [],
    warnings:          [message],
    errors:            [message],
    summary:           null,
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase client (Node/fetch version)
// ─────────────────────────────────────────────────────────────────────────────

function createNodeSupabaseClient(url: string, key: string) {
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
                  code:    String(response.status),
                },
              };
            }
            return { data: await response.json() as unknown[], error: null };
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
// Core handler — pure function, no HTTP objects
// Exported so tests can call it directly without spinning up an HTTP server.
// ─────────────────────────────────────────────────────────────────────────────

export interface HandlerRequest {
  method:  string;
  url:     string;
  body?:   string;
}

export async function handleMLBPicksRequest(
  req: HandlerRequest,
): Promise<EndpointResponse> {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return { status: 204, body: null, headers: CORS_HEADERS };
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return errorResponse(405, `Method ${req.method} not allowed.`);
  }

  // ── Parse parameters ──────────────────────────────────────────────────────
  const url   = new URL(req.url, 'http://localhost');
  let date           = url.searchParams.get('date')           ?? new Date().toISOString().slice(0, 10);
  let modelVersionId = url.searchParams.get('modelVersionId') ?? 'mlb-stats-v1';
  let save           = url.searchParams.get('save') === 'true';

  if (req.method === 'POST' && req.body) {
    try {
      const parsed = JSON.parse(req.body) as Record<string, unknown>;
      if (typeof parsed['date']           === 'string')  date           = parsed['date'];
      if (typeof parsed['modelVersionId'] === 'string')  modelVersionId = parsed['modelVersionId'];
      if (typeof parsed['save']           === 'boolean') save           = parsed['save'];
    } catch {
      return errorResponse(400, 'Invalid JSON body.');
    }
  }

  const season = parseInt(date.slice(0, 4), 10);

  // ── Validate ODDS_API_KEY ─────────────────────────────────────────────────
  const oddsApiKey = process.env['ODDS_API_KEY'];
  if (!oddsApiKey) {
    return errorResponse(500, 'ODDS_API_KEY is not set in environment.');
  }

  // ── Fetch stats ────────────────────────────────────────────────────────────
  let statsResult;
  try {
    statsResult = await assembleTeamGameStats(date, season);
  } catch (e: unknown) {
    return errorResponse(503, `Stats ingestion failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // ── Fetch odds ─────────────────────────────────────────────────────────────
  let normalizedOddsPicks: Awaited<ReturnType<typeof fetchMLBOdds>>['picks'] = [];
  try {
    const oddsResult = await fetchMLBOdds({ markets: ['h2h'] });
    normalizedOddsPicks = oddsResult.picks;
  } catch (e: unknown) {
    return errorResponse(503, `Odds fetch failed: ${e instanceof Error ? e.message : String(e)}`);
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

  // ── Assemble handler input ────────────────────────────────────────────────
  const handlerInput: MLBPicksHandlerInput = {
    date,
    modelVersionId,
    normalizedOddsPicks: readyPicks as unknown as import("../adapters/oddsApi.adapter").NormalizedPick[],
    structuredStats:     statsResult.teamGameStats,
    save,
  };

  if (save) {
    const supabaseUrl = process.env['SUPABASE_URL'];
    const serviceKey  = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    if (supabaseUrl && serviceKey) {
      handlerInput.supabaseClient = createNodeSupabaseClient(supabaseUrl, serviceKey);
    } else {
      // Silently downgrade — warn in response but don't fail
      handlerInput.save = false;
    }
  }

  // ── Run handler ────────────────────────────────────────────────────────────
  const handlerResponse = await getMLBPicksHandler(handlerInput);

  // ── Augment with matcher metadata ─────────────────────────────────────────
  const fullResponse = {
    ...handlerResponse,
    missingModelPicks: missingModelPicks.map(p => ({
      gameId:   p.gameId,
      team:     p.team,
      opponent: p.opponent,
      betType:  p.betType,
    })),
    matcherWarnings:    matchResult.warnings.map(w => `[${w.code}] ${w.team}: ${w.message}`),
    unmatchedOddsPicks: matchResult.unmatchedOddsPicks.length,
  };

  return jsonResponse(200, fullResponse);
}

// ─────────────────────────────────────────────────────────────────────────────
// Node HTTP server — only runs when this file is the entry point
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

  const server = http.createServer(async (req, res) => {
    // Read body for POST
    let body = '';
    for await (const chunk of req) body += chunk;

    const result = await handleMLBPicksRequest({
      method: req.method ?? 'GET',
      url:    req.url    ?? '/',
      body:   body || undefined,
    });

    res.writeHead(result.status, result.headers);
    res.end(result.body !== null ? JSON.stringify(result.body) : '');
  });

  server.listen(PORT, () => {
    console.log(`\nMLB Picks endpoint listening on http://localhost:${PORT}`);
    console.log(`GET  http://localhost:${PORT}/api/mlb-picks?date=${new Date().toISOString().slice(0, 10)}`);
    console.log(`POST http://localhost:${PORT}/api/mlb-picks\n`);
  });
}
