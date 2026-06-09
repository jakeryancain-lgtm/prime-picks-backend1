import type { RawMLBPick } from '../mlbPipeline';

// =============================================================================
// Odds API Adapter
// =============================================================================
// Fetches live MLB odds from The Odds API (https://the-odds-api.com) and
// normalises them into the RawMLBPick format expected by mlbPipeline.
//
// WHAT THIS ADAPTER DOES:
//   - Reads the ODDS_API_KEY environment variable
//   - Builds the correct API URL for MLB odds
//   - Fetches odds via injected fetch (real or fake in tests)
//   - Normalises the external response into RawMLBPick[]
//
// WHAT THIS ADAPTER DOES NOT DO:
//   - Calculate edge              (edge.engine responsibility)
//   - Grade picks                 (pickGrade.engine responsibility)
//   - Rank picks                  (ranking.engine responsibility)
//   - Invent model probability    (MLB stats adapter responsibility)
//
// modelProbability and confidence are set to null here because this adapter
// only knows about market odds, not model predictions. They must be filled in
// by the MLB stats adapter before the pipeline can calculate edge.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const ENV_ODDS_API_KEY = 'ODDS_API_KEY';

const ODDS_API_BASE_URL = 'https://api.the-odds-api.com/v4';
const ODDS_API_SPORT    = 'baseball_mlb';
const ODDS_API_REGIONS  = 'us';
const ODDS_API_ODDS_FORMAT = 'american';

export interface OddsApiConfig {
  apiKey: string;
}

/**
 * Reads and validates the ODDS_API_KEY environment variable.
 *
 * @throws if ODDS_API_KEY is missing or blank
 */
export function readOddsApiConfig(): OddsApiConfig {
  const apiKey = process.env[ENV_ODDS_API_KEY];
  if (!apiKey || apiKey.trim() === '') {
    throw new Error(
      `Missing environment variable: ${ENV_ODDS_API_KEY}. ` +
      'Get a key at https://the-odds-api.com and set it in your .env file.',
    );
  }
  return { apiKey: apiKey.trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// URL builder
// ─────────────────────────────────────────────────────────────────────────────

export type OddsMarket = 'h2h' | 'spreads' | 'totals';

export interface OddsApiUrlOptions {
  apiKey:  string;
  markets: OddsMarket[];
  /** Optional date filter (ISO-8601 date string, e.g. '2025-06-10'). */
  commenceTimeFrom?: string;
  commenceTimeTo?:   string;
}

/**
 * Builds the full Odds API URL for MLB odds.
 *
 * Query parameters included:
 *   - apiKey
 *   - sport (baseball_mlb)
 *   - regions (us)
 *   - markets (h2h, spreads, totals — comma-joined)
 *   - oddsFormat (american)
 *   - optional date range filters
 */
export function buildOddsApiUrl(options: OddsApiUrlOptions): string {
  const params = new URLSearchParams({
    apiKey:      options.apiKey,
    regions:     ODDS_API_REGIONS,
    markets:     options.markets.join(','),
    oddsFormat:  ODDS_API_ODDS_FORMAT,
  });

  if (options.commenceTimeFrom) params.set('commenceTimeFrom', options.commenceTimeFrom);
  if (options.commenceTimeTo)   params.set('commenceTimeTo',   options.commenceTimeTo);

  return `${ODDS_API_BASE_URL}/sports/${ODDS_API_SPORT}/odds?${params.toString()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// External API response shape (The Odds API v4)
// ─────────────────────────────────────────────────────────────────────────────

export interface OddsApiOutcome {
  name:  string;
  price: number;          // American odds integer
  point?: number;         // spread / total line
}

export interface OddsApiMarket {
  key:      OddsMarket;
  outcomes: OddsApiOutcome[];
}

export interface OddsApiBookmaker {
  key:     string;
  title:   string;
  markets: OddsApiMarket[];
}

export interface OddsApiGame {
  id:            string;   // Odds API game ID (used as gameId)
  sport_key:     string;
  commence_time: string;   // ISO-8601
  home_team:     string;
  away_team:     string;
  bookmakers:    OddsApiBookmaker[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Normalisation helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Preferred bookmaker order for price selection. First available wins. */
const PREFERRED_BOOKMAKERS = [
  'draftkings', 'fanduel', 'betmgm', 'caesars', 'pointsbet', 'williamhill_us',
];

/**
 * Picks the best available bookmaker from a game's bookmakers list.
 * Falls back to the first bookmaker if none of the preferred ones are present.
 */
function selectBookmaker(bookmakers: OddsApiBookmaker[]): OddsApiBookmaker | null {
  if (bookmakers.length === 0) return null;
  for (const preferred of PREFERRED_BOOKMAKERS) {
    const found = bookmakers.find(b => b.key === preferred);
    if (found) return found;
  }
  return bookmakers[0]!;
}

function findMarket(
  bookmaker: OddsApiBookmaker,
  key: OddsMarket,
): OddsApiMarket | undefined {
  return bookmaker.markets.find(m => m.key === key);
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeOddsApiResponse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A normalized pick from the Odds API — all market data populated,
 * model fields explicitly null until the MLB stats adapter fills them in.
 */
export interface NormalizedPick {
  gameId:                string;
  team:                  string;
  opponent:              string;
  betType:               RawMLBPick['betType'];
  marketType:            RawMLBPick['marketType'];
  americanOdds:          number | null;
  oppositeAmericanOdds?: number;
  runLineSpread?:        RawMLBPick['runLineSpread'];
  /** Explicitly null — this adapter does not produce model predictions. */
  modelProbability:      null;
  /** Explicitly null — this adapter does not produce confidence scores. */
  confidence:            null;
}

/**
 * Converts an array of Odds API game objects into normalized pick objects.
 *
 * One pick is produced per team per market per game.
 * Both sides of each market are included — the caller can filter by team.
 *
 * modelProbability and confidence are explicitly null — this adapter only
 * knows about market odds. They must be populated by the MLB stats adapter
 * before passing to mlbPipeline.
 *
 * Rules:
 * - Uses the preferred bookmaker (first available from PREFERRED_BOOKMAKERS list)
 * - Skips games with no bookmakers
 * - Skips markets where either side has no price
 * - For run lines: attaches runLineSpread from the outcome point
 * - oppositeAmericanOdds is set to the other side's price when both exist
 */
export function normalizeOddsApiResponse(games: OddsApiGame[]): NormalizedPick[] {
  const picks: NormalizedPick[] = [];

  for (const game of games) {
    const bookmaker = selectBookmaker(game.bookmakers);
    if (!bookmaker) continue;

    const gameId   = game.id;
    const homeTeam = game.home_team;
    const awayTeam = game.away_team;

    // ── h2h (moneyline) ───────────────────────────────────────────────────
    const h2h = findMarket(bookmaker, 'h2h');
    if (h2h) {
      const home = h2h.outcomes.find(o => o.name === homeTeam);
      const away = h2h.outcomes.find(o => o.name === awayTeam);

      if (home?.price !== undefined && away?.price !== undefined) {
        picks.push({
          gameId,
          team:                 homeTeam,
          opponent:             awayTeam,
          betType:              'moneyline',
          marketType:           'moneyline',
          americanOdds:         home.price,
          oppositeAmericanOdds: away.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        undefined,
        });
        picks.push({
          gameId,
          team:                 awayTeam,
          opponent:             homeTeam,
          betType:              'moneyline',
          marketType:           'moneyline',
          americanOdds:         away.price,
          oppositeAmericanOdds: home.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        undefined,
        });
      }
    }

    // ── spreads (run line) ────────────────────────────────────────────────
    const spreads = findMarket(bookmaker, 'spreads');
    if (spreads) {
      const home = spreads.outcomes.find(o => o.name === homeTeam);
      const away = spreads.outcomes.find(o => o.name === awayTeam);

      if (
        home?.price !== undefined && home.point !== undefined &&
        away?.price !== undefined && away.point !== undefined
      ) {
        picks.push({
          gameId,
          team:                 homeTeam,
          opponent:             awayTeam,
          betType:              'run_line',
          marketType:           'run_line',
          americanOdds:         home.price,
          oppositeAmericanOdds: away.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        home.point as RawMLBPick['runLineSpread'],
        });
        picks.push({
          gameId,
          team:                 awayTeam,
          opponent:             homeTeam,
          betType:              'run_line',
          marketType:           'run_line',
          americanOdds:         away.price,
          oppositeAmericanOdds: home.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        away.point as RawMLBPick['runLineSpread'],
        });
      }
    }

    // ── totals (over/under) ───────────────────────────────────────────────
    const totals = findMarket(bookmaker, 'totals');
    if (totals) {
      const over  = totals.outcomes.find(o => o.name.toLowerCase() === 'over');
      const under = totals.outcomes.find(o => o.name.toLowerCase() === 'under');

      if (over?.price !== undefined && under?.price !== undefined) {
        picks.push({
          gameId,
          team:                 homeTeam,
          opponent:             awayTeam,
          betType:              'total_over',
          marketType:           'total',
          americanOdds:         over.price,
          oppositeAmericanOdds: under.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        undefined,
        });
        picks.push({
          gameId,
          team:                 homeTeam,
          opponent:             awayTeam,
          betType:              'total_under',
          marketType:           'total',
          americanOdds:         under.price,
          oppositeAmericanOdds: over.price,
          modelProbability:     null,
          confidence:           null,
          runLineSpread:        undefined,
        });
      }
    }
  }

  return picks;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch function type — injectable for tests
// ─────────────────────────────────────────────────────────────────────────────

export type FetchFn = (url: string) => Promise<{
  ok:     boolean;
  status: number;
  json:   () => Promise<unknown>;
  text:   () => Promise<string>;
}>;

// ─────────────────────────────────────────────────────────────────────────────
// fetchMLBOdds
// ─────────────────────────────────────────────────────────────────────────────

export interface FetchMLBOddsOptions {
  markets?:          OddsMarket[];
  commenceTimeFrom?: string;
  commenceTimeTo?:   string;
  /** Override the fetch implementation (for tests). Defaults to global fetch. */
  fetchFn?:          FetchFn;
}

export interface FetchMLBOddsResult {
  picks:  NormalizedPick[];
  errors: string[];
}

/**
 * Fetches live MLB odds from The Odds API and returns normalised picks.
 *
 * Uses injectable `fetchFn` so tests can provide a fake without hitting the
 * real API. Defaults to the global `fetch` (Node 18+).
 *
 * HTTP errors and network failures are captured in `errors` rather than
 * thrown, so the caller can decide how to handle partial failures.
 *
 * @throws if ODDS_API_KEY is not set (validation is not suppressed)
 */
export async function fetchMLBOdds(
  options: FetchMLBOddsOptions = {},
): Promise<FetchMLBOddsResult> {
  const { apiKey }  = readOddsApiConfig();
  const markets     = options.markets ?? ['h2h', 'spreads', 'totals'];
  const fetchFn     = options.fetchFn ?? (fetch as FetchFn);

  const url = buildOddsApiUrl({
    apiKey,
    markets,
    commenceTimeFrom: options.commenceTimeFrom,
    commenceTimeTo:   options.commenceTimeTo,
  });

  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await fetchFn(url);
  } catch (e: unknown) {
    return {
      picks:  [],
      errors: [`Network error: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      picks:  [],
      errors: [`Odds API error ${response.status}: ${body}`],
    };
  }

  let games: OddsApiGame[];
  try {
    games = (await response.json()) as OddsApiGame[];
  } catch (e: unknown) {
    return {
      picks:  [],
      errors: [`Failed to parse Odds API response: ${e instanceof Error ? e.message : String(e)}`],
    };
  }

  const picks = normalizeOddsApiResponse(games);
  return { picks, errors: [] };
}
