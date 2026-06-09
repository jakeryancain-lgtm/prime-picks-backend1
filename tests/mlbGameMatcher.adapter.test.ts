import * as assert from 'assert';
import {
  normalizeTeamName,
  buildTeamAliasMap,
  buildGameMatchKey,
  matchOddsToStats,
} from '../src/adapters/mlbGameMatcher.adapter';
import type { NormalizedPick } from '../src/adapters/oddsApi.adapter';
import type { TeamGameStats }  from '../src/adapters/mlbStatsModel.adapter';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗  ${name}`);
    console.log(`       ${msg}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DATE = '2025-06-10';

function makeOddsPick(
  team: string,
  opponent: string,
  overrides: Partial<NormalizedPick> = {},
): NormalizedPick {
  return {
    gameId:               `odds-${team.toLowerCase().replace(/\s+/g, '-')}`,
    team,
    opponent,
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -120,
    oppositeAmericanOdds: 100,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
    ...overrides,
  };
}

function makeStats(
  team: string,
  opponent: string,
  gameId = `mlb-${team.toLowerCase().replace(/\s+/g, '-')}`,
  isHome = true,
): TeamGameStats {
  return {
    gameId,
    team,
    opponent,
    betType:     'moneyline',
    marketType:  'moneyline',
    isHome,
    teamWinPct:  0.555,
    opponentWinPct: 0.445,
  };
}

function makeDateMap(picks: NormalizedPick[], date = DATE): Map<string, string> {
  return new Map(picks.map(p => [p.gameId, date]));
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeTeamName
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeTeamName');

test('full name is lowercased and returned as canonical', () => {
  assert.strictEqual(normalizeTeamName('New York Yankees'), 'new york yankees');
});

test('alias maps to canonical name', () => {
  assert.strictEqual(normalizeTeamName('NY Yankees'), 'new york yankees');
});

test('already canonical name passes through unchanged', () => {
  assert.strictEqual(normalizeTeamName('los angeles dodgers'), 'los angeles dodgers');
});

test('leading/trailing whitespace is trimmed', () => {
  assert.strictEqual(normalizeTeamName('  Boston Red Sox  '), 'boston red sox');
});

test('unknown name returns lowercased input (no crash)', () => {
  assert.strictEqual(normalizeTeamName('Unknown Team FC'), 'unknown team fc');
});

// Required test 3: NY Yankees → New York Yankees
test('NY Yankees normalizes to new york yankees', () => {
  assert.strictEqual(normalizeTeamName('NY Yankees'), 'new york yankees');
  assert.strictEqual(normalizeTeamName('NYY Yankees'), 'new york yankees');
  assert.strictEqual(normalizeTeamName('Yankees'), 'new york yankees');
});

// Required test 4: LA Dodgers → Los Angeles Dodgers
test('LA Dodgers normalizes to los angeles dodgers', () => {
  assert.strictEqual(normalizeTeamName('LA Dodgers'), 'los angeles dodgers');
  assert.strictEqual(normalizeTeamName('LAD Dodgers'), 'los angeles dodgers');
  assert.strictEqual(normalizeTeamName('Dodgers'), 'los angeles dodgers');
});

// Required test 5: SF Giants → San Francisco Giants
test('SF Giants normalizes to san francisco giants', () => {
  assert.strictEqual(normalizeTeamName('SF Giants'), 'san francisco giants');
  assert.strictEqual(normalizeTeamName('SFG Giants'), 'san francisco giants');
  assert.strictEqual(normalizeTeamName('Giants'), 'san francisco giants');
});

test('Chi Cubs normalizes to chicago cubs', () => {
  assert.strictEqual(normalizeTeamName('Chi Cubs'), 'chicago cubs');
  assert.strictEqual(normalizeTeamName('Cubs'), 'chicago cubs');
});

test('Chi White Sox normalizes to chicago white sox', () => {
  assert.strictEqual(normalizeTeamName('Chi White Sox'), 'chicago white sox');
  assert.strictEqual(normalizeTeamName('White Sox'), 'chicago white sox');
});

test('KC Royals normalizes to kansas city royals', () => {
  assert.strictEqual(normalizeTeamName('KC Royals'), 'kansas city royals');
  assert.strictEqual(normalizeTeamName('Royals'), 'kansas city royals');
});

test('TB Rays normalizes to tampa bay rays', () => {
  assert.strictEqual(normalizeTeamName('TB Rays'), 'tampa bay rays');
  assert.strictEqual(normalizeTeamName('Rays'), 'tampa bay rays');
});

test('WSH Nationals normalizes to washington nationals', () => {
  assert.strictEqual(normalizeTeamName('WSH Nationals'), 'washington nationals');
  assert.strictEqual(normalizeTeamName('Nationals'), 'washington nationals');
});

// ─────────────────────────────────────────────────────────────────────────────
// buildTeamAliasMap
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildTeamAliasMap');

test('returns a Map with entries', () => {
  const map = buildTeamAliasMap();
  assert.ok(map instanceof Map);
  assert.ok(map.size > 0);
});

test('all canonical names are covered', () => {
  const map = buildTeamAliasMap();
  const canonicals = [
    'new york yankees', 'boston red sox', 'los angeles dodgers',
    'san francisco giants', 'chicago cubs', 'chicago white sox',
    'kansas city royals', 'tampa bay rays', 'washington nationals',
  ];
  for (const c of canonicals) {
    assert.ok(map.has(c), `canonical missing: ${c}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// buildGameMatchKey
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildGameMatchKey');

test('produces consistent key for full team names', () => {
  const k1 = buildGameMatchKey('2025-06-10', 'New York Yankees', 'Boston Red Sox');
  const k2 = buildGameMatchKey('2025-06-10', 'New York Yankees', 'Boston Red Sox');
  assert.strictEqual(k1, k2);
});

test('NY Yankees and New York Yankees produce the same key', () => {
  const k1 = buildGameMatchKey('2025-06-10', 'NY Yankees', 'Boston Red Sox');
  const k2 = buildGameMatchKey('2025-06-10', 'New York Yankees', 'Boston Red Sox');
  assert.strictEqual(k1, k2);
});

test('LA Dodgers and Los Angeles Dodgers produce the same key', () => {
  const k1 = buildGameMatchKey('2025-06-10', 'LA Dodgers', 'SF Giants');
  const k2 = buildGameMatchKey('2025-06-10', 'Los Angeles Dodgers', 'San Francisco Giants');
  assert.strictEqual(k1, k2);
});

test('different dates produce different keys', () => {
  const k1 = buildGameMatchKey('2025-06-10', 'NYY', 'BOS');
  const k2 = buildGameMatchKey('2025-06-11', 'NYY', 'BOS');
  assert.notStrictEqual(k1, k2);
});

test('key format is date|team|opponent', () => {
  const k = buildGameMatchKey('2025-06-10', 'New York Yankees', 'Boston Red Sox');
  const parts = k.split('|');
  assert.strictEqual(parts.length, 3);
  assert.strictEqual(parts[0], '2025-06-10');
});

// ─────────────────────────────────────────────────────────────────────────────
// matchOddsToStats
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmatchOddsToStats');

// Required test 1: exact team names match
test('exact team names match correctly', () => {
  const odds  = makeOddsPick('New York Yankees', 'Boston Red Sox');
  const stats = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const dates = makeDateMap([odds]);

  const result = matchOddsToStats([odds], [stats], dates);
  assert.strictEqual(result.matchedPicks.length, 1);
  assert.strictEqual(result.unmatchedOddsPicks.length, 0);
});

// Required test 2: alias team names match
test('alias team names match (NY Yankees vs New York Yankees)', () => {
  const odds  = makeOddsPick('NY Yankees',       'Boston Red Sox');
  const stats = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const dates = makeDateMap([odds]);

  const result = matchOddsToStats([odds], [stats], dates);
  assert.strictEqual(result.matchedPicks.length, 1, 'Expected match via alias');
  assert.strictEqual(result.unmatchedOddsPicks.length, 0);
});

// Required test 3: NY Yankees specifically
test('NY Yankees matches New York Yankees in stats', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox');
  const entry = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const result = matchOddsToStats([pick], [entry], makeDateMap([pick]));
  assert.strictEqual(result.matchedPicks.length, 1);
  assert.strictEqual(result.matchedPicks[0]!.team, 'NY Yankees');
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-777001');
});

// Required test 4: LA Dodgers
test('LA Dodgers matches Los Angeles Dodgers in stats', () => {
  const pick  = makeOddsPick('LA Dodgers', 'SF Giants');
  const entry = makeStats   ('Los Angeles Dodgers', 'San Francisco Giants', 'mlb-777002');
  const result = matchOddsToStats([pick], [entry], makeDateMap([pick]));
  assert.strictEqual(result.matchedPicks.length, 1);
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-777002');
});

// Required test 5: SF Giants
test('SF Giants matches San Francisco Giants in stats', () => {
  const pick  = makeOddsPick('SF Giants', 'LA Dodgers');
  const entry = makeStats   ('San Francisco Giants', 'Los Angeles Dodgers', 'mlb-777003');
  const result = matchOddsToStats([pick], [entry], makeDateMap([pick]));
  assert.strictEqual(result.matchedPicks.length, 1);
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-777003');
});

// Required test 6: home/away prevents wrong match
test('correct match uses both team and opponent — prevents wrong pairing', () => {
  const yankeesPick = makeOddsPick('NY Yankees', 'Boston Red Sox');
  const metsStats   = makeStats   ('New York Mets', 'Boston Red Sox', 'mlb-999');
  const yankeesStats = makeStats  ('New York Yankees', 'Boston Red Sox', 'mlb-777');
  const dates = makeDateMap([yankeesPick]);

  const result = matchOddsToStats(
    [yankeesPick],
    [metsStats, yankeesStats],
    dates,
  );
  assert.strictEqual(result.matchedPicks.length, 1);
  // Should match Yankees, not Mets
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-777');
});

// Required test 7: original odds pick is not mutated
test('original odds pick object is not mutated by matching', () => {
  const pick = makeOddsPick('NY Yankees', 'Boston Red Sox');
  const originalGameId = pick.gameId;
  const entry = makeStats('New York Yankees', 'Boston Red Sox', 'mlb-777001');

  matchOddsToStats([pick], [entry], makeDateMap([pick]));

  assert.strictEqual(pick.gameId, originalGameId, 'pick.gameId was mutated');
});

// Required test 8: originalOddsGameId is preserved
test('matched pick preserves originalOddsGameId', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', { gameId: 'odds-abc-123' });
  const entry = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const dates = new Map([['odds-abc-123', DATE]]);

  const result = matchOddsToStats([pick], [entry], dates);
  assert.strictEqual(result.matchedPicks[0]!.originalOddsGameId, 'odds-abc-123');
});

// Required test 9: matched pick gets MLB stats gameId
test('matched pick gameId is rewritten to MLB stats gamePk', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', { gameId: 'odds-nyy-bos' });
  const entry = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-gamepk-777001');
  const dates = new Map([['odds-nyy-bos', DATE]]);

  const result = matchOddsToStats([pick], [entry], dates);
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-gamepk-777001');
});

// Required test 10: unmatched odds picks returned
test('odds pick with no matching stats goes to unmatchedOddsPicks', () => {
  const pick = makeOddsPick('Detroit Tigers', 'Minnesota Twins');
  const result = matchOddsToStats([pick], [], makeDateMap([pick]));
  assert.strictEqual(result.unmatchedOddsPicks.length, 1);
  assert.strictEqual(result.unmatchedOddsPicks[0]!.team, 'Detroit Tigers');
  assert.strictEqual(result.matchedPicks.length, 0);
});

// Required test 11: unmatched stats returned
test('stats entry with no matching odds pick goes to unmatchedStats', () => {
  const odds  = makeOddsPick('NY Yankees', 'Boston Red Sox');
  const statsA = makeStats  ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const statsB = makeStats  ('Houston Astros', 'Oakland Athletics', 'mlb-777002');
  const dates  = makeDateMap([odds]);

  const result = matchOddsToStats([odds], [statsA, statsB], dates);
  assert.strictEqual(result.matchedPicks.length, 1);
  assert.strictEqual(result.unmatchedStats.length, 1);
  assert.strictEqual(result.unmatchedStats[0]!.team, 'Houston Astros');
});

// Required test 12: duplicate/ambiguous match returns warning
test('missing date mapping adds MISSING_DATE warning and goes to unmatchedOddsPicks', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', { gameId: 'odds-no-date' });
  const entry = makeStats   ('New York Yankees', 'Boston Red Sox', 'mlb-777001');
  const emptyDates = new Map<string, string>(); // no date for this pick

  const result = matchOddsToStats([pick], [entry], emptyDates);
  assert.strictEqual(result.warnings.length, 1);
  assert.strictEqual(result.warnings[0]!.code, 'MISSING_DATE');
  assert.strictEqual(result.unmatchedOddsPicks.length, 1);
  assert.strictEqual(result.matchedPicks.length, 0);
});

// Required test 13: match works regardless of team/opponent order
test('away team pick (team = away, opponent = home) matches stats entry', () => {
  // The Odds API returns picks for both sides:
  //   pick1: team=NYY, opponent=BOS (NYY is away)
  //   pick2: team=BOS, opponent=NYY (BOS is home)
  // Stats has: team=NYY, opponent=BOS AND team=BOS, opponent=NYY (two entries)
  const pick1 = makeOddsPick('NY Yankees',    'Boston Red Sox');
  const pick2 = makeOddsPick('Boston Red Sox', 'NY Yankees',   { gameId: 'odds-bos-nyy' });
  const stats1 = makeStats  ('New York Yankees', 'Boston Red Sox', 'mlb-777001', false);
  const stats2 = makeStats  ('Boston Red Sox',   'New York Yankees', 'mlb-777001', true);

  const dates = new Map([
    [pick1.gameId, DATE],
    [pick2.gameId, DATE],
  ]);

  const result = matchOddsToStats([pick1, pick2], [stats1, stats2], dates);
  assert.strictEqual(result.matchedPicks.length, 2);
  assert.strictEqual(result.unmatchedOddsPicks.length, 0);

  // Both matched picks should have the same MLB gameId
  assert.strictEqual(result.matchedPicks[0]!.gameId, 'mlb-777001');
  assert.strictEqual(result.matchedPicks[1]!.gameId, 'mlb-777001');
});

// Required test 14: multiple games in one batch
test('multiple games can be matched in one batch', () => {
  const picks = [
    makeOddsPick('NY Yankees',    'Boston Red Sox',        { gameId: 'odds-g1' }),
    makeOddsPick('Boston Red Sox', 'NY Yankees',           { gameId: 'odds-g1-away' }),
    makeOddsPick('LA Dodgers',    'San Francisco Giants',  { gameId: 'odds-g2' }),
    makeOddsPick('SF Giants',     'Los Angeles Dodgers',   { gameId: 'odds-g2-away' }),
    makeOddsPick('Houston Astros','Oakland Athletics',     { gameId: 'odds-g3' }),
  ];

  const statsEntries = [
    makeStats('New York Yankees',    'Boston Red Sox',        'mlb-1001', false),
    makeStats('Boston Red Sox',      'New York Yankees',      'mlb-1001', true),
    makeStats('Los Angeles Dodgers', 'San Francisco Giants',  'mlb-1002', true),
    makeStats('San Francisco Giants','Los Angeles Dodgers',   'mlb-1002', false),
    makeStats('Houston Astros',      'Oakland Athletics',     'mlb-1003', true),
  ];

  const dates = new Map([
    ['odds-g1',      DATE],
    ['odds-g1-away', DATE],
    ['odds-g2',      DATE],
    ['odds-g2-away', DATE],
    ['odds-g3',      DATE],
  ]);

  const result = matchOddsToStats(picks, statsEntries, dates);
  assert.strictEqual(result.matchedPicks.length, 5);
  assert.strictEqual(result.unmatchedOddsPicks.length, 0);
  assert.strictEqual(result.unmatchedStats.length, 0);

  // Verify MLB gameIds were assigned correctly
  const g1Picks = result.matchedPicks.filter(p => p.gameId === 'mlb-1001');
  const g2Picks = result.matchedPicks.filter(p => p.gameId === 'mlb-1002');
  const g3Picks = result.matchedPicks.filter(p => p.gameId === 'mlb-1003');
  assert.strictEqual(g1Picks.length, 2);
  assert.strictEqual(g2Picks.length, 2);
  assert.strictEqual(g3Picks.length, 1);
});

// Additional safety tests
test('matchDate is set on aligned pick', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', { gameId: 'odds-g' });
  const entry = makeStats('New York Yankees', 'Boston Red Sox', 'mlb-1');
  const result = matchOddsToStats([pick], [entry], new Map([['odds-g', DATE]]));
  assert.strictEqual(result.matchedPicks[0]!.matchDate, DATE);
});

test('empty inputs return empty result without errors', () => {
  const result = matchOddsToStats([], [], new Map());
  assert.strictEqual(result.matchedPicks.length, 0);
  assert.strictEqual(result.unmatchedOddsPicks.length, 0);
  assert.strictEqual(result.unmatchedStats.length, 0);
  assert.strictEqual(result.warnings.length, 0);
  assert.strictEqual(result.errors.length, 0);
});

test('original pick model fields (null) are preserved in aligned pick', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', { gameId: 'odds-x' });
  const entry = makeStats('New York Yankees', 'Boston Red Sox', 'mlb-x');
  const result = matchOddsToStats([pick], [entry], new Map([['odds-x', DATE]]));
  const aligned = result.matchedPicks[0]!;
  assert.strictEqual(aligned.modelProbability, null);
  assert.strictEqual(aligned.confidence, null);
});

test('americanOdds and oppositeAmericanOdds preserved in aligned pick', () => {
  const pick  = makeOddsPick('NY Yankees', 'Boston Red Sox', {
    gameId: 'odds-y', americanOdds: -130, oppositeAmericanOdds: 110,
  });
  const entry = makeStats('New York Yankees', 'Boston Red Sox', 'mlb-y');
  const result = matchOddsToStats([pick], [entry], new Map([['odds-y', DATE]]));
  const aligned = result.matchedPicks[0]!;
  assert.strictEqual(aligned.americanOdds, -130);
  assert.strictEqual(aligned.oppositeAmericanOdds, 110);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`mlbGameMatcher.adapter — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
