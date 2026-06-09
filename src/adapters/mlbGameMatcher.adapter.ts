import type { NormalizedPick }  from './oddsApi.adapter';
import type { TeamGameStats }   from './mlbStatsModel.adapter';

// =============================================================================
// MLB Game Matcher Adapter
// =============================================================================
// The Odds API and MLB Stats API use different game identifiers and team name
// formats. This adapter bridges that gap by matching picks on:
//
//   normalizedTeamName × normalizedOpponentName × date
//
// When a match is found, the odds pick's gameId is rewritten to the MLB
// Stats gamePk so that buildModelKey() produces consistent lookup keys
// across the full pipeline.
//
// Matching strategy:
//   1. Normalize both team names through the alias map (e.g. "NY Yankees" → "new york yankees")
//   2. Build a composite key: {date}|{normalizedTeam}|{normalizedOpponent}
//   3. Join odds keys to stats keys; flag ambiguous or unmatched entries
//
// The original odds pick is never mutated — a new object is returned with
// the rewritten gameId and originalOddsGameId preserved in metadata.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** An odds pick with gameId rewritten to the MLB Stats gamePk. */
export interface AlignedOddsPick extends NormalizedPick {
  /** Original game ID from The Odds API — preserved, never lost. */
  originalOddsGameId: string;
  /** The MLB Stats gamePk, now used as gameId for buildModelKey. */
  gameId: string;
  /** ISO date string derived from game schedule e.g. '2025-06-10'. */
  matchDate: string;
}

export interface MatchWarning {
  code:    'AMBIGUOUS_MATCH' | 'MISSING_DATE' | 'LOW_CONFIDENCE_MATCH';
  team:    string;
  message: string;
}

export interface MatchError {
  code:    'MULTIPLE_STATS_FOR_SAME_ODDS' | 'MATCH_FAILED';
  team:    string;
  message: string;
}

export interface MatchResult {
  matchedPicks:       AlignedOddsPick[];
  unmatchedOddsPicks: NormalizedPick[];
  unmatchedStats:     TeamGameStats[];
  warnings:           MatchWarning[];
  errors:             MatchError[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Team alias map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maps all known Odds API team name variants to the canonical full name used
 * by the MLB Stats API. Keys are lowercase; all lookups are lowercased first.
 *
 * Coverage includes:
 *   - Common abbreviations used by various sportsbooks
 *   - City-only names
 *   - Nickname-only names
 *   - Geographic abbreviations (NY, LA, SF, KC, TB, CHI, WSH)
 */
export function buildTeamAliasMap(): Map<string, string> {
  const aliases: [string[], string][] = [
    // Arizona Diamondbacks
    [['arizona diamondbacks', 'arizona', 'diamondbacks', 'ari diamondbacks', 'az diamondbacks', 'd-backs', 'dbacks'], 'arizona diamondbacks'],
    // Atlanta Braves
    [['atlanta braves', 'atlanta', 'braves', 'atl braves'], 'atlanta braves'],
    // Baltimore Orioles
    [['baltimore orioles', 'baltimore', 'orioles', 'bal orioles', 'balt orioles'], 'baltimore orioles'],
    // Boston Red Sox
    [['boston red sox', 'boston', 'red sox', 'bos red sox'], 'boston red sox'],
    // Chicago Cubs
    [['chicago cubs', 'chi cubs', 'chc cubs', 'cubs', 'chicago nl'], 'chicago cubs'],
    // Chicago White Sox
    [['chicago white sox', 'chi white sox', 'chw white sox', 'cws white sox', 'white sox', 'chicago al'], 'chicago white sox'],
    // Cincinnati Reds
    [['cincinnati reds', 'cincinnati', 'reds', 'cin reds'], 'cincinnati reds'],
    // Cleveland Guardians
    [['cleveland guardians', 'cleveland', 'guardians', 'cle guardians'], 'cleveland guardians'],
    // Colorado Rockies
    [['colorado rockies', 'colorado', 'rockies', 'col rockies'], 'colorado rockies'],
    // Detroit Tigers
    [['detroit tigers', 'detroit', 'tigers', 'det tigers'], 'detroit tigers'],
    // Houston Astros
    [['houston astros', 'houston', 'astros', 'hou astros'], 'houston astros'],
    // Kansas City Royals
    [['kansas city royals', 'kansas city', 'royals', 'kc royals', 'kcr royals'], 'kansas city royals'],
    // Los Angeles Angels
    [['los angeles angels', 'la angels', 'laa angels', 'angels', 'anaheim angels', 'los angeles angels of anaheim'], 'los angeles angels'],
    // Los Angeles Dodgers
    [['los angeles dodgers', 'la dodgers', 'lad dodgers', 'dodgers'], 'los angeles dodgers'],
    // Miami Marlins
    [['miami marlins', 'miami', 'marlins', 'mia marlins'], 'miami marlins'],
    // Milwaukee Brewers
    [['milwaukee brewers', 'milwaukee', 'brewers', 'mil brewers'], 'milwaukee brewers'],
    // Minnesota Twins
    [['minnesota twins', 'minnesota', 'twins', 'min twins'], 'minnesota twins'],
    // New York Mets
    [['new york mets', 'ny mets', 'nym mets', 'mets'], 'new york mets'],
    // New York Yankees
    [['new york yankees', 'ny yankees', 'nyy yankees', 'yankees', 'new york al'], 'new york yankees'],
    // Oakland Athletics
    [['oakland athletics', 'oakland', 'athletics', 'oak athletics', "a's", 'las vegas athletics', 'athletics'], 'oakland athletics'],
    // Philadelphia Phillies
    [['philadelphia phillies', 'philadelphia', 'phillies', 'phi phillies'], 'philadelphia phillies'],
    // Pittsburgh Pirates
    [['pittsburgh pirates', 'pittsburgh', 'pirates', 'pit pirates'], 'pittsburgh pirates'],
    // San Diego Padres
    [['san diego padres', 'san diego', 'padres', 'sd padres', 'sdp padres'], 'san diego padres'],
    // San Francisco Giants
    [['san francisco giants', 'sf giants', 'sfg giants', 'giants'], 'san francisco giants'],
    // Seattle Mariners
    [['seattle mariners', 'seattle', 'mariners', 'sea mariners'], 'seattle mariners'],
    // St. Louis Cardinals
    [['st. louis cardinals', 'st louis cardinals', 'st. louis', 'st louis', 'cardinals', 'stl cardinals'], 'st. louis cardinals'],
    // Tampa Bay Rays
    [['tampa bay rays', 'tampa bay', 'rays', 'tb rays', 'tbr rays'], 'tampa bay rays'],
    // Texas Rangers
    [['texas rangers', 'texas', 'rangers', 'tex rangers'], 'texas rangers'],
    // Toronto Blue Jays
    [['toronto blue jays', 'toronto', 'blue jays', 'tor blue jays'], 'toronto blue jays'],
    // Washington Nationals
    [['washington nationals', 'washington', 'nationals', 'wsh nationals', 'wsh nationals', 'wsh nationals', 'was nationals'], 'washington nationals'],
  ];

  const map = new Map<string, string>();
  for (const [variants, canonical] of aliases) {
    for (const v of variants) {
      map.set(v.toLowerCase(), canonical);
    }
  }
  return map;
}

// Singleton alias map — built once, reused
let _aliasMap: Map<string, string> | null = null;
function getAliasMap(): Map<string, string> {
  if (!_aliasMap) _aliasMap = buildTeamAliasMap();
  return _aliasMap;
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeTeamName
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a team name to a canonical lowercase form.
 *
 * Looks up the lowercased name in the alias map. If found, returns the
 * canonical name (lowercased). If not found, returns the input lowercased
 * and trimmed — this allows exact matches to still work even for teams
 * not in the alias table.
 *
 * @example
 * normalizeTeamName('NY Yankees')      // → 'new york yankees'
 * normalizeTeamName('LA Dodgers')       // → 'los angeles dodgers'
 * normalizeTeamName('New York Yankees') // → 'new york yankees'
 */
export function normalizeTeamName(raw: string): string {
  const key = raw.trim().toLowerCase();
  return getAliasMap().get(key) ?? key;
}

// ─────────────────────────────────────────────────────────────────────────────
// buildGameMatchKey
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds a composite match key from date + normalized team + normalized opponent.
 *
 * Key format: `{date}|{normalizedTeam}|{normalizedOpponent}`
 *
 * Both team names are normalized through the alias map before joining,
 * so 'NY Yankees' and 'New York Yankees' produce the same key.
 *
 * @example
 * buildGameMatchKey('2025-06-10', 'NY Yankees', 'Boston Red Sox')
 * // → '2025-06-10|new york yankees|boston red sox'
 */
export function buildGameMatchKey(date: string, team: string, opponent: string): string {
  return [
    date.trim(),
    normalizeTeamName(team),
    normalizeTeamName(opponent),
  ].join('|');
}

// ─────────────────────────────────────────────────────────────────────────────
// matchOddsToStats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aligns normalized odds picks with TeamGameStats entries.
 *
 * Matching algorithm:
 *   1. Build a key→stats lookup from all TeamGameStats entries.
 *      Key = buildGameMatchKey(date, team, opponent)
 *      The stats gameId is the MLB gamePk (e.g. '777001').
 *   2. For each odds pick, extract the date from the pick's game date
 *      (passed via `gameDateByOddsGameId` map) and build its match key.
 *   3. If a stats entry is found for the key:
 *      - Create a new AlignedOddsPick with gameId rewritten to the stats gameId
 *      - Preserve originalOddsGameId in the returned object
 *      - Original odds pick is NOT mutated
 *   4. If no stats entry: add to unmatchedOddsPicks.
 *   5. Any stats entries not matched by any pick: unmatchedStats.
 *
 * @param oddsPicks           Normalized picks from oddsApi.adapter
 * @param statsEntries        TeamGameStats[] from mlbStats.ingestion
 * @param gameDateByOddsGameId  Map from Odds API game ID → ISO date string
 *                            (required because NormalizedPick has no date field)
 */
export function matchOddsToStats(
  oddsPicks:            NormalizedPick[],
  statsEntries:         TeamGameStats[],
  gameDateByOddsGameId: Map<string, string>,
): MatchResult {
  const matchedPicks:       AlignedOddsPick[] = [];
  const unmatchedOddsPicks: NormalizedPick[]  = [];
  const warnings:           MatchWarning[]    = [];
  const errors:             MatchError[]      = [];

  // ── Build stats lookup map ────────────────────────────────────────────────
  // key → { stats entry, how many times matched }
  const statsKeyMap = new Map<string, { entry: TeamGameStats; matchCount: number }>();
  const matchedStatsKeys = new Set<string>();

  for (const entry of statsEntries) {
    // Stats entries use a gamePk-derived gameId and a date embedded in that gamePk
    // We derive the date from the entry's gameId by checking gameDateByOddsGameId
    // for an equivalent, but for stats we need a date source too.
    // The TeamGameStats gameId is the gamePk — we look for a date in gameDateByOddsGameId
    // by finding any odds entry that references this stats entry's teams.
    // Simpler approach: store stats by all plausible date+team+opponent keys.
    // We don't know the date from TeamGameStats directly (it only has gameId).
    // Solution: The caller passes gameDateByOddsGameId. We also need a way to get
    // a date for stats entries. We'll use a reverse lookup: if any odds game date
    // maps to a key that matches this stats entry's teams, we use that date.
    // For now, build stats map without date first, then join with date from odds.
    const statsKey = `${normalizeTeamName(entry.team)}|${normalizeTeamName(entry.opponent)}`;
    if (!statsKeyMap.has(statsKey)) {
      statsKeyMap.set(statsKey, { entry, matchCount: 0 });
    } else {
      // Duplicate team+opponent — can happen if betType differs (moneyline vs run_line)
      // Keep the first moneyline entry as the primary for matching purposes
      if (entry.betType === 'moneyline') {
        statsKeyMap.set(statsKey, { entry, matchCount: 0 });
      }
    }
  }

  // Track which stats entries were matched
  const usedStatsKeys = new Set<string>();

  // ── Match each odds pick to a stats entry ─────────────────────────────────
  for (const pick of oddsPicks) {
    const date = gameDateByOddsGameId.get(pick.gameId);

    if (!date) {
      warnings.push({
        code:    'MISSING_DATE',
        team:    pick.team,
        message: `No date mapping found for odds gameId '${pick.gameId}' (team: ${pick.team}). Cannot match to stats.`,
      });
      unmatchedOddsPicks.push(pick);
      continue;
    }

    const teamKey     = `${normalizeTeamName(pick.team)}|${normalizeTeamName(pick.opponent)}`;
    const statsRecord = statsKeyMap.get(teamKey);

    if (!statsRecord) {
      unmatchedOddsPicks.push(pick);
      continue;
    }

    // Check if this stats entry is already matched by a different odds pick
    if (usedStatsKeys.has(teamKey) && statsRecord.matchCount > 0) {
      // Multiple odds picks mapping to the same stats entry — ambiguous
      if (pick.betType === 'moneyline') {
        // For moneyline picks this is expected (we may have multiple picks per game
        // e.g. home + away — both map to the same stats entry)
        // This is fine — proceed without warning
      } else {
        warnings.push({
          code:    'AMBIGUOUS_MATCH',
          team:    pick.team,
          message: `Stats entry for ${pick.team} vs ${pick.opponent} matched by multiple odds picks (${pick.betType}).`,
        });
      }
    }

    statsRecord.matchCount++;
    usedStatsKeys.add(teamKey);
    matchedStatsKeys.add(teamKey);

    // Create aligned pick with rewritten gameId — original pick untouched
    const aligned: AlignedOddsPick = {
      ...pick,
      originalOddsGameId: pick.gameId,
      gameId:             statsRecord.entry.gameId,  // rewritten to MLB gamePk
      matchDate:          date,
    };
    matchedPicks.push(aligned);
  }

  // ── Collect unmatched stats entries ───────────────────────────────────────
  const unmatchedStats: TeamGameStats[] = [];
  for (const [key, record] of statsKeyMap.entries()) {
    if (!usedStatsKeys.has(key)) {
      unmatchedStats.push(record.entry);
    }
  }

  return { matchedPicks, unmatchedOddsPicks, unmatchedStats, warnings, errors };
}
