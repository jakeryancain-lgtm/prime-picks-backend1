import type { TeamGameStats } from './mlbStatsModel.adapter';

// =============================================================================
// MLB Stats Ingestion
// =============================================================================
// Fetches structured team/game statistics from MLB's public Stats API
// (statsapi.mlb.com — no API key required) and assembles TeamGameStats[]
// ready to pass into mlbStatsModel.adapter.
//
// API endpoints used (all free, unauthenticated):
//   GET /v1/schedule?sportId=1&date={date}&hydrate=team,probablePitcher
//   GET /v1/standings?leagueId=103,104&season={season}
//   GET /v1/teams/{teamId}/stats?stats=season&group=hitting&season={season}
//   GET /v1/teams/{teamId}/stats?stats=season&group=pitching&season={season}
//   GET /v1/people/{pitcherId}?hydrate=stats(group=pitching,type=season,season={season})
//
// sampleSize merge rule:
//   When both teamGamesPlayed and pitcherSeasonStarts are available:
//     sampleSize = Math.min(teamGamesPlayed, pitcherSeasonStarts)
//   When only teamGamesPlayed is available:
//     sampleSize = teamGamesPlayed
//   When neither is available:
//     sampleSize = undefined  →  MISSING_SAMPLE_SIZE warning emitted
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Injectable fetch type (same pattern as oddsApi.adapter)
// ─────────────────────────────────────────────────────────────────────────────

export type FetchFn = (url: string) => Promise<{
  ok:     boolean;
  status: number;
  json:   () => Promise<unknown>;
  text:   () => Promise<string>;
}>;

const MLB_STATS_BASE = 'https://statsapi.mlb.com/api/v1';

// ─────────────────────────────────────────────────────────────────────────────
// Raw API response shapes (minimal — only fields we need)
// ─────────────────────────────────────────────────────────────────────────────

interface RawProbablePitcher {
  id:       number;
  fullName: string;
}

interface RawTeamRef {
  id:   number;
  name: string;
}

interface RawScheduleTeamEntry {
  team:             RawTeamRef;
  probablePitcher?: RawProbablePitcher;
  isWinner?:        boolean;
}

interface RawScheduleGame {
  gamePk:    number;
  gameDate:  string;
  status?: {
    abstractGameState?: string;  // "Preview", "Live", "Final"
    detailedState?:     string;  // "Scheduled", "In Progress", "Final", "Postponed", etc.
    codedGameState?:    string;
    statusCode?:        string;
  };
  teams: {
    home: RawScheduleTeamEntry;
    away: RawScheduleTeamEntry;
  };
}

interface RawScheduleDate {
  date:  string;
  games: RawScheduleGame[];
}

interface RawScheduleResponse {
  dates: RawScheduleDate[];
}

interface RawStandingsTeamEntry {
  team:             RawTeamRef;
  wins:             number;
  losses:           number;
  gamesPlayed:      number;
  winningPercentage: string;
  records?: {
    splitRecords?: Array<{
      type: string;
      wins: number;
      losses: number;
    }>;
  };
}

interface RawStandingsRecord {
  teamRecords: RawStandingsTeamEntry[];
}

interface RawStandingsResponse {
  records: RawStandingsRecord[];
}

interface RawTeamStat {
  stat: Record<string, unknown>;
}

interface RawTeamStatsResponse {
  stats: Array<{
    splits: RawTeamStat[];
  }>;
}

interface RawPitcherSeason {
  gamesStarted: number;
  era:          string;
  inningsPitched: string;
}

interface RawPitcherResponse {
  people: Array<{
    stats: Array<{
      splits: Array<{
        stat: RawPitcherSeason;
      }>;
    }>;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processed intermediate types
// ─────────────────────────────────────────────────────────────────────────────

export interface GameScheduleEntry {
  gamePk:           number;
  /** ISO-8601 UTC game start time (same as gameDate from MLB API). */
  gameDate:         string;
  /** The MLB official detailedState e.g. "Scheduled", "In Progress", "Final". */
  gameStatus?:      string;
  homeTeamId:       number;
  homeTeamName:     string;
  awayTeamId:       number;
  awayTeamName:     string;
  homePitcherId?:   number;
  homePitcherName?: string;
  awayPitcherId?:   number;
  awayPitcherName?: string;
}

export interface TeamStandingsEntry {
  teamId:          number;
  teamName:        string;
  wins:            number;
  losses:          number;
  gamesPlayed:     number;
  winPct:          number;
  last10Wins:      number | undefined;
}

export interface TeamSeasonStats {
  teamId:     number;
  ops:        number | undefined;
  teamEra:    number | undefined;
}

export interface PitcherSeasonStats {
  pitcherId: number;
  era:       number | undefined;
  starts:    number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion result
// ─────────────────────────────────────────────────────────────────────────────

export type IngestionWarningCode = 'MISSING_SAMPLE_SIZE' | 'MISSING_PITCHER_ERA' | 'MISSING_TEAM_STATS' | 'MISSING_STANDINGS';

export interface IngestionWarning {
  code:    IngestionWarningCode;
  gameId:  string;
  team:    string;
  message: string;
}

export interface IngestionError {
  stage:   string;
  gameId?: string;
  team?:   string;
  message: string;
}

export interface AssembleResult {
  teamGameStats: TeamGameStats[];
  warnings:      IngestionWarning[];
  errors:        IngestionError[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual fetch functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches today's schedule with probable pitchers embedded.
 * Returns one entry per game (both teams included in each entry).
 */
export async function fetchTodaysGames(
  date:    string,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<GameScheduleEntry[]> {
  const url = `${MLB_STATS_BASE}/schedule?sportId=1&date=${date}&hydrate=team,probablePitcher,status`;
  const response = await fetchFn(url);

  if (!response.ok) {
    throw new Error(`fetchTodaysGames: HTTP ${response.status} for date ${date}`);
  }

  const data = await response.json() as RawScheduleResponse;
  const games: GameScheduleEntry[] = [];

  for (const dateEntry of data.dates ?? []) {
    for (const game of dateEntry.games ?? []) {
      games.push({
        gamePk:          game.gamePk,
        gameDate:        game.gameDate,
        gameStatus:      game.status?.detailedState ?? game.status?.abstractGameState,
        homeTeamId:      game.teams.home.team.id,
        homeTeamName:    game.teams.home.team.name,
        awayTeamId:      game.teams.away.team.id,
        awayTeamName:    game.teams.away.team.name,
        homePitcherId:   game.teams.home.probablePitcher?.id,
        homePitcherName: game.teams.home.probablePitcher?.fullName,
        awayPitcherId:   game.teams.away.probablePitcher?.id,
        awayPitcherName: game.teams.away.probablePitcher?.fullName,
      });
    }
  }

  return games;
}

/**
 * Fetches AL + NL standings for the given season.
 * Returns a map keyed by teamId.
 */
export async function fetchTeamStandings(
  season:  number,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<Map<number, TeamStandingsEntry>> {
  const url = `${MLB_STATS_BASE}/standings?leagueId=103,104&season=${season}&standingsTypes=regularSeason`;
  const response = await fetchFn(url);

  if (!response.ok) {
    throw new Error(`fetchTeamStandings: HTTP ${response.status} for season ${season}`);
  }

  const data = await response.json() as RawStandingsResponse;
  const result = new Map<number, TeamStandingsEntry>();

  for (const record of data.records ?? []) {
    for (const entry of record.teamRecords ?? []) {
      // Extract last-10 record from splitRecords when available
      const last10 = entry.records?.splitRecords?.find(s => s.type === 'lastTen');

      result.set(entry.team.id, {
        teamId:      entry.team.id,
        teamName:    entry.team.name,
        wins:        entry.wins,
        losses:      entry.losses,
        gamesPlayed: entry.gamesPlayed,
        winPct:      parseFloat(entry.winningPercentage) || 0,
        last10Wins:  last10 !== undefined ? last10.wins : undefined,
      });
    }
  }

  return result;
}

/**
 * Fetches season-to-date hitting and pitching stats for a single team.
 * Two sequential requests (hitting + pitching group).
 */
export async function fetchTeamStats(
  teamId:  number,
  season:  number,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<TeamSeasonStats> {
  // Hitting stats (for OPS)
  const hitUrl = `${MLB_STATS_BASE}/teams/${teamId}/stats?stats=season&group=hitting&season=${season}`;
  const pitUrl = `${MLB_STATS_BASE}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`;

  const [hitResp, pitResp] = await Promise.all([
    fetchFn(hitUrl),
    fetchFn(pitUrl),
  ]);

  let ops: number | undefined;
  let teamEra: number | undefined;

  if (hitResp.ok) {
    const hitData = await hitResp.json() as RawTeamStatsResponse;
    const split   = hitData.stats?.[0]?.splits?.[0]?.stat;
    const rawOps  = split?.['ops'];
    if (typeof rawOps === 'string') ops = parseFloat(rawOps) || undefined;
    else if (typeof rawOps === 'number') ops = rawOps;
  }

  if (pitResp.ok) {
    const pitData = await pitResp.json() as RawTeamStatsResponse;
    const split   = pitData.stats?.[0]?.splits?.[0]?.stat;
    const rawEra  = split?.['era'];
    if (typeof rawEra === 'string') teamEra = parseFloat(rawEra) || undefined;
    else if (typeof rawEra === 'number') teamEra = rawEra;
  }

  return { teamId, ops, teamEra };
}

/**
 * Fetches season ERA and starts count for a specific pitcher.
 */
export async function fetchPitcherStats(
  pitcherId: number,
  season:    number,
  fetchFn:   FetchFn = fetch as FetchFn,
): Promise<PitcherSeasonStats> {
  const url = `${MLB_STATS_BASE}/people/${pitcherId}?hydrate=stats(group=pitching,type=season,season=${season})`;
  const response = await fetchFn(url);

  if (!response.ok) {
    return { pitcherId, era: undefined, starts: 0 };
  }

  const data   = await response.json() as RawPitcherResponse;
  const splits = data.people?.[0]?.stats?.[0]?.splits ?? [];
  const stat   = splits[0]?.stat;

  if (!stat) return { pitcherId, era: undefined, starts: 0 };

  const era    = parseFloat(stat.era)    || undefined;
  const starts = stat.gamesStarted       ?? 0;

  return { pitcherId, era, starts };
}

// ─────────────────────────────────────────────────────────────────────────────
// sampleSize merge logic
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the effective sampleSize for a team-game entry.
 *
 * Rule: use the lower of (teamGamesPlayed, pitcherSeasonStarts).
 * Rationale: the binding constraint is the weaker data source.
 * A veteran team with a rookie SP starter has an effective pitcher sample.
 *
 * Returns undefined when neither source has data.
 */
export function computeSampleSize(
  teamGamesPlayed:     number | undefined,
  pitcherSeasonStarts: number | undefined,
): number | undefined {
  if (teamGamesPlayed !== undefined && pitcherSeasonStarts !== undefined) {
    return Math.min(teamGamesPlayed, pitcherSeasonStarts);
  }
  if (teamGamesPlayed !== undefined) return teamGamesPlayed;
  if (pitcherSeasonStarts !== undefined) return pitcherSeasonStarts;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// assembleTeamGameStats — main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assembles TeamGameStats[] for all MLB games on a given date.
 *
 * Makes 1 + N×4 requests (schedule + per-team stats + per-pitcher stats).
 * All requests are rate-limited by sequential team-level fetches; pitcher
 * stats for both teams in a game are fetched in parallel.
 *
 * Returns:
 *   teamGameStats  — one entry per team per game (2 per game), ready for
 *                    mlbStatsModel.adapter.ts
 *   warnings       — MISSING_SAMPLE_SIZE when sampleSize cannot be computed
 *   errors         — per-game/team fetch failures that didn't crash the batch
 *
 * @param date     ISO date string e.g. '2025-06-10'
 * @param season   Season year e.g. 2025
 * @param fetchFn  Injectable fetch — use default for production, fake for tests
 */
export async function assembleTeamGameStats(
  date:    string,
  season:  number,
  fetchFn: FetchFn = fetch as FetchFn,
): Promise<AssembleResult> {
  const teamGameStats: TeamGameStats[]   = [];
  const warnings:      IngestionWarning[] = [];
  const errors:        IngestionError[]   = [];

  // ── Step 1: fetch schedule (probable pitchers embedded) ───────────────────
  let games: GameScheduleEntry[] = [];
  try {
    games = await fetchTodaysGames(date, fetchFn);
  } catch (e: unknown) {
    errors.push({
      stage:   'fetchTodaysGames',
      message: e instanceof Error ? e.message : String(e),
    });
    return { teamGameStats, warnings, errors };
  }

  if (games.length === 0) {
    warnings.push({
      code:    'MISSING_SAMPLE_SIZE',   // reuse code — no games means nothing to sample
      gameId:  'ALL',
      team:    'ALL',
      message: `No games found for date ${date} — schedule may not be published yet.`,
    });
    return { teamGameStats, warnings, errors };
  }

  // ── Step 2: fetch standings once for all teams ────────────────────────────
  let standingsMap = new Map<number, TeamStandingsEntry>();
  try {
    standingsMap = await fetchTeamStandings(season, fetchFn);
  } catch (e: unknown) {
    errors.push({
      stage:   'fetchTeamStandings',
      message: e instanceof Error ? e.message : String(e),
    });
    // Non-fatal — continue with empty standings, warnings added per team below
  }

  // ── Step 3: per-game assembly ─────────────────────────────────────────────
  for (const game of games) {
    const gameId = String(game.gamePk);

    // Collect unique team IDs and pitcher IDs for this game
    const teamIds    = [game.homeTeamId, game.awayTeamId];
    const pitcherIds = [game.homePitcherId, game.awayPitcherId].filter(
      (id): id is number => id !== undefined,
    );

    // Fetch team stats in parallel
    const [homeStats, awayStats] = await Promise.all(
      teamIds.map(id =>
        fetchTeamStats(id, season, fetchFn).catch((e: unknown) => {
          errors.push({
            stage:   'fetchTeamStats',
            gameId,
            message: e instanceof Error ? e.message : String(e),
          });
          return null;
        }),
      ),
    );

    // Fetch pitcher stats in parallel (only for pitchers who are known)
    const pitcherStatsMap = new Map<number, PitcherSeasonStats>();
    await Promise.all(
      pitcherIds.map(id =>
        fetchPitcherStats(id, season, fetchFn)
          .then(s => pitcherStatsMap.set(id, s))
          .catch((e: unknown) => {
            errors.push({
              stage:   'fetchPitcherStats',
              gameId,
              message: e instanceof Error ? e.message : String(e),
            });
          }),
      ),
    );

    // ── Build one TeamGameStats per team ─────────────────────────────────────
    const teams = [
      {
        isHome:     true,
        teamId:     game.homeTeamId,
        teamName:   game.homeTeamName,
        oppTeamId:  game.awayTeamId,
        oppName:    game.awayTeamName,
        pitcherId:  game.homePitcherId,
        oppPitId:   game.awayPitcherId,
        stats:      homeStats,
        oppStats:   awayStats,
      },
      {
        isHome:     false,
        teamId:     game.awayTeamId,
        teamName:   game.awayTeamName,
        oppTeamId:  game.homeTeamId,
        oppName:    game.homeTeamName,
        pitcherId:  game.awayPitcherId,
        oppPitId:   game.homePitcherId,
        stats:      awayStats,
        oppStats:   homeStats,
      },
    ];

    for (const t of teams) {
      const standing    = standingsMap.get(t.teamId);
      const oppStanding = standingsMap.get(t.oppTeamId);
      const pitcherStat = t.pitcherId !== undefined
        ? pitcherStatsMap.get(t.pitcherId)
        : undefined;

      // Warn when standings are missing
      if (!standing) {
        warnings.push({
          code:    'MISSING_STANDINGS',
          gameId,
          team:    t.teamName,
          message: `No standings data for team ${t.teamName} (id=${t.teamId}) — winPct and form unavailable.`,
        });
      }

      // Warn when team stats are missing
      if (!t.stats) {
        warnings.push({
          code:    'MISSING_TEAM_STATS',
          gameId,
          team:    t.teamName,
          message: `Failed to fetch season stats for ${t.teamName} — OPS and ERA unavailable.`,
        });
      }

      // Warn when pitcher ERA is missing but pitcher is listed
      if (t.pitcherId !== undefined && pitcherStat?.era === undefined) {
        warnings.push({
          code:    'MISSING_PITCHER_ERA',
          gameId,
          team:    t.teamName,
          message: `Probable pitcher listed for ${t.teamName} but ERA unavailable (pitcherId=${t.pitcherId}).`,
        });
      }

      // Compute sampleSize
      const pitcherStarts = pitcherStat?.starts;
      const sampleSize    = computeSampleSize(standing?.gamesPlayed, pitcherStarts);

      // Warn when sampleSize is undefined
      if (sampleSize === undefined) {
        warnings.push({
          code:    'MISSING_SAMPLE_SIZE',
          gameId,
          team:    t.teamName,
          message: `sampleSize could not be determined for ${t.teamName} in game ${gameId} — standings and pitcher data both unavailable.`,
        });
      }

      // Recent form: last10Wins from standings (or undefined)
      const recentFormWins    = standing?.last10Wins;
      const oppRecentFormWins = oppStanding?.last10Wins;

      teamGameStats.push({
        gameId,
        team:               t.teamName,
        opponent:           t.oppName,
        betType:            'moneyline',
        marketType:         'moneyline',
        isHome:             t.isHome,
        gameStatus:         game.gameStatus,
        gameDateTime:       game.gameDate,

        teamWinPct:         standing?.winPct,
        opponentWinPct:     oppStanding?.winPct,

        // SP ERA from pitcher stats (prefers per-pitcher over team ERA)
        spEra:              pitcherStat?.era ?? t.stats?.teamEra,
        opponentSpEra:      (() => {
          const oppPitcherStat = t.oppPitId !== undefined
            ? pitcherStatsMap.get(t.oppPitId)
            : undefined;
          return oppPitcherStat?.era ?? t.oppStats?.teamEra;
        })(),

        // Bullpen ERA: team ERA as proxy (best free approximation)
        bullpenEra:         t.stats?.teamEra,
        opponentBullpenEra: t.oppStats?.teamEra,

        teamOps:            t.stats?.ops,
        opponentOps:        t.oppStats?.ops,

        recentFormWins,
        opponentFormWins:   oppRecentFormWins,

        // Injury and weather: not ingested here — caller must supply if needed
        injuryAdjustment:   undefined,
        weatherAdjustment:  undefined,

        sampleSize,
      });
    }
  }

  return { teamGameStats, warnings, errors };
}
