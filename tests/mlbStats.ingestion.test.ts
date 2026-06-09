import * as assert from 'assert';
import {
  computeSampleSize,
  fetchTodaysGames,
  fetchTeamStandings,
  fetchPitcherStats,
  assembleTeamGameStats,
  type FetchFn,
} from '../src/adapters/mlbStats.ingestion';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const asyncTests: Promise<void>[] = [];

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

function asyncTest(name: string, fn: () => Promise<void>) {
  const p = fn()
    .then(() => { console.log(`  ✓  ${name}`); passed++; })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗  ${name}`);
      console.log(`       ${msg}`);
      failed++;
    });
  asyncTests.push(p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake API response builders
// ─────────────────────────────────────────────────────────────────────────────

function makeFetch(responses: Record<string, unknown>): FetchFn {
  return async (url: string) => {
    // Match by substring so tests don't need exact query strings
    const key = Object.keys(responses).find(k => url.includes(k));
    if (!key) {
      return {
        ok: false, status: 404,
        json: async () => ({}),
        text: async () => `No mock for URL: ${url}`,
      };
    }
    return {
      ok: true, status: 200,
      json: async () => responses[key],
      text: async () => JSON.stringify(responses[key]),
    };
  };
}

/** Fake schedule API response — one NYY @ BOS game with probable pitchers. */
const FAKE_SCHEDULE = {
  dates: [{
    date: '2025-06-10',
    games: [{
      gamePk: 777001,
      gameDate: '2025-06-10T18:05:00Z',
      teams: {
        home: {
          team: { id: 147, name: 'New York Yankees' },
          probablePitcher: { id: 543037, fullName: 'Gerrit Cole' },
        },
        away: {
          team: { id: 111, name: 'Boston Red Sox' },
          probablePitcher: { id: 605135, fullName: 'Brayan Bello' },
        },
      },
    }],
  }],
};

/** Fake schedule with no probable pitchers. */
const FAKE_SCHEDULE_NO_PITCHERS = {
  dates: [{
    date: '2025-06-10',
    games: [{
      gamePk: 777002,
      gameDate: '2025-06-10T18:05:00Z',
      teams: {
        home: { team: { id: 147, name: 'New York Yankees' } },
        away: { team: { id: 111, name: 'Boston Red Sox' } },
      },
    }],
  }],
};

/** Fake standings — NYY and BOS entries. */
const FAKE_STANDINGS = {
  records: [{
    teamRecords: [
      {
        team: { id: 147, name: 'New York Yankees' },
        wins: 42, losses: 28, gamesPlayed: 70,
        winningPercentage: '0.600',
        records: { splitRecords: [{ type: 'lastTen', wins: 7, losses: 3 }] },
      },
      {
        team: { id: 111, name: 'Boston Red Sox' },
        wins: 30, losses: 40, gamesPlayed: 70,
        winningPercentage: '0.429',
        records: { splitRecords: [{ type: 'lastTen', wins: 4, losses: 6 }] },
      },
    ],
  }],
};

/** Fake team hitting stats (OPS). */
const FAKE_HIT_STATS_NYY = {
  stats: [{ splits: [{ stat: { ops: '.780', avg: '.265' } }] }],
};
const FAKE_HIT_STATS_BOS = {
  stats: [{ splits: [{ stat: { ops: '.710', avg: '.248' } }] }],
};

/** Fake team pitching stats (ERA). */
const FAKE_PIT_STATS_NYY = {
  stats: [{ splits: [{ stat: { era: '3.45', whip: '1.18' } }] }],
};
const FAKE_PIT_STATS_BOS = {
  stats: [{ splits: [{ stat: { era: '4.20', whip: '1.32' } }] }],
};

/** Fake pitcher stats — Gerrit Cole (18 starts). */
const FAKE_COLE_STATS = {
  people: [{ stats: [{ splits: [{ stat: { gamesStarted: 18, era: '2.95', inningsPitched: '110.1' } }] }] }],
};

/** Fake pitcher stats — Brayan Bello (16 starts). */
const FAKE_BELLO_STATS = {
  people: [{ stats: [{ splits: [{ stat: { gamesStarted: 16, era: '4.50', inningsPitched: '88.0' } }] }] }],
};

// ─────────────────────────────────────────────────────────────────────────────
// computeSampleSize — pure unit tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncomputeSampleSize');

test('uses teamGamesPlayed alone when pitcher starts is undefined', () => {
  assert.strictEqual(computeSampleSize(55, undefined), 55);
});

test('uses pitcherStarts alone when teamGamesPlayed is undefined', () => {
  assert.strictEqual(computeSampleSize(undefined, 12), 12);
});

test('uses min(teamGamesPlayed, pitcherStarts) when both available — pitcher smaller', () => {
  // pitcher has fewer starts than team games — pitcher is binding
  assert.strictEqual(computeSampleSize(65, 14), 14);
});

test('uses min(teamGamesPlayed, pitcherStarts) when both available — team smaller', () => {
  // early season: team has played fewer games (unusual but possible)
  assert.strictEqual(computeSampleSize(12, 35), 12);
});

test('uses equal value when both are equal', () => {
  assert.strictEqual(computeSampleSize(30, 30), 30);
});

test('returns undefined when both are undefined', () => {
  assert.strictEqual(computeSampleSize(undefined, undefined), undefined);
});

test('pitcher starts = 0 produces sampleSize = 0 (not undefined)', () => {
  assert.strictEqual(computeSampleSize(60, 0), 0);
});

test('teamGamesPlayed = 0 produces sampleSize = 0', () => {
  assert.strictEqual(computeSampleSize(0, undefined), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchTodaysGames
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfetchTodaysGames');

asyncTest('returns a game entry for each scheduled game', async () => {
  const fetch = makeFetch({ 'schedule': FAKE_SCHEDULE });
  const games = await fetchTodaysGames('2025-06-10', fetch);
  assert.strictEqual(games.length, 1);
});

asyncTest('game entry has correct home and away team fields', async () => {
  const fetch = makeFetch({ 'schedule': FAKE_SCHEDULE });
  const games = await fetchTodaysGames('2025-06-10', fetch);
  const g     = games[0]!;
  assert.strictEqual(g.homeTeamName, 'New York Yankees');
  assert.strictEqual(g.awayTeamName, 'Boston Red Sox');
  assert.strictEqual(g.homeTeamId,   147);
  assert.strictEqual(g.awayTeamId,   111);
});

asyncTest('probable pitcher ids are extracted when present', async () => {
  const fetch = makeFetch({ 'schedule': FAKE_SCHEDULE });
  const games = await fetchTodaysGames('2025-06-10', fetch);
  const g     = games[0]!;
  assert.strictEqual(g.homePitcherId, 543037);
  assert.strictEqual(g.awayPitcherId, 605135);
});

asyncTest('probable pitcher ids are undefined when not present', async () => {
  const fetch = makeFetch({ 'schedule': FAKE_SCHEDULE_NO_PITCHERS });
  const games = await fetchTodaysGames('2025-06-10', fetch);
  const g     = games[0]!;
  assert.strictEqual(g.homePitcherId, undefined);
  assert.strictEqual(g.awayPitcherId, undefined);
});

asyncTest('throws when HTTP error returned', async () => {
  const badFetch: FetchFn = async () => ({
    ok: false, status: 500,
    json: async () => ({}), text: async () => 'error',
  });
  let threw = false;
  try { await fetchTodaysGames('2025-06-10', badFetch); } catch { threw = true; }
  assert.ok(threw);
});

asyncTest('returns empty array when no dates in response', async () => {
  const fetch = makeFetch({ 'schedule': { dates: [] } });
  const games = await fetchTodaysGames('2025-06-10', fetch);
  assert.strictEqual(games.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchTeamStandings
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfetchTeamStandings');

asyncTest('returns map keyed by teamId', async () => {
  const fetch = makeFetch({ 'standings': FAKE_STANDINGS });
  const map   = await fetchTeamStandings(2025, fetch);
  assert.ok(map.has(147), 'NYY missing');
  assert.ok(map.has(111), 'BOS missing');
});

asyncTest('winPct is parsed as a float', async () => {
  const fetch = makeFetch({ 'standings': FAKE_STANDINGS });
  const map   = await fetchTeamStandings(2025, fetch);
  const nyy   = map.get(147)!;
  assert.ok(Math.abs(nyy.winPct - 0.600) < 0.001, `Expected 0.600, got ${nyy.winPct}`);
});

asyncTest('gamesPlayed is populated', async () => {
  const fetch = makeFetch({ 'standings': FAKE_STANDINGS });
  const map   = await fetchTeamStandings(2025, fetch);
  assert.strictEqual(map.get(147)!.gamesPlayed, 70);
});

asyncTest('last10Wins is extracted from splitRecords', async () => {
  const fetch = makeFetch({ 'standings': FAKE_STANDINGS });
  const map   = await fetchTeamStandings(2025, fetch);
  assert.strictEqual(map.get(147)!.last10Wins, 7);
  assert.strictEqual(map.get(111)!.last10Wins, 4);
});

asyncTest('throws when HTTP error returned', async () => {
  const badFetch: FetchFn = async () => ({
    ok: false, status: 500,
    json: async () => ({}), text: async () => 'error',
  });
  let threw = false;
  try { await fetchTeamStandings(2025, badFetch); } catch { threw = true; }
  assert.ok(threw);
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchPitcherStats
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfetchPitcherStats');

asyncTest('returns correct ERA and starts for a known pitcher', async () => {
  const fetch = makeFetch({ 'people/543037': FAKE_COLE_STATS });
  const stats = await fetchPitcherStats(543037, 2025, fetch);
  assert.ok(Math.abs((stats.era ?? 0) - 2.95) < 0.001, `ERA: ${stats.era}`);
  assert.strictEqual(stats.starts, 18);
});

asyncTest('returns undefined ERA when HTTP error (does not throw)', async () => {
  const badFetch: FetchFn = async () => ({
    ok: false, status: 404,
    json: async () => ({}), text: async () => 'not found',
  });
  const stats = await fetchPitcherStats(99999, 2025, badFetch);
  assert.strictEqual(stats.era, undefined);
  assert.strictEqual(stats.starts, 0);
});

asyncTest('returns starts = 0 when no splits available', async () => {
  const fetch = makeFetch({ 'people': { people: [{ stats: [] }] } });
  const stats = await fetchPitcherStats(123, 2025, fetch);
  assert.strictEqual(stats.starts, 0);
  assert.strictEqual(stats.era, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// assembleTeamGameStats — core integration
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nassembleTeamGameStats');

/** Build a full fake fetch covering all endpoints for the NYY/BOS game. */
function buildFullFetch(): FetchFn {
  return makeFetch({
    'schedule':       FAKE_SCHEDULE,
    'standings':      FAKE_STANDINGS,
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
    'people/543037': FAKE_COLE_STATS,
    'people/605135': FAKE_BELLO_STATS,
  });
}

asyncTest('returns two TeamGameStats entries for one game', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  assert.strictEqual(result.teamGameStats.length, 2);
});

asyncTest('returns teamGameStats, warnings, and errors fields', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  assert.ok(Array.isArray(result.teamGameStats));
  assert.ok(Array.isArray(result.warnings));
  assert.ok(Array.isArray(result.errors));
});

asyncTest('home team entry has isHome = true', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees');
  assert.ok(nyy, 'NYY not found');
  assert.strictEqual(nyy!.isHome, true);
});

asyncTest('away team entry has isHome = false', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const bos = result.teamGameStats.find(s => s.team === 'Boston Red Sox');
  assert.ok(bos, 'BOS not found');
  assert.strictEqual(bos!.isHome, false);
});

asyncTest('winPct populated from standings', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.ok(Math.abs((nyy.teamWinPct ?? 0) - 0.600) < 0.001);
});

asyncTest('recentFormWins populated from last10 standings', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.strictEqual(nyy.recentFormWins, 7);
});

asyncTest('OPS populated from hitting stats', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.ok(Math.abs((nyy.teamOps ?? 0) - 0.780) < 0.001, `OPS: ${nyy.teamOps}`);
});

asyncTest('spEra populated from pitcher stats (not team ERA)', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  // Cole's ERA is 2.95, team ERA is 3.45 — should use pitcher
  assert.ok(Math.abs((nyy.spEra ?? 0) - 2.95) < 0.001, `spEra: ${nyy.spEra}`);
});

// sampleSize — the core feature tests
asyncTest('sampleSize is min(gamesPlayed, pitcherStarts) when both available', async () => {
  // NYY: gamesPlayed=70, Cole starts=18 → min = 18
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.strictEqual(nyy.sampleSize, 18, `Expected 18 (pitcher starts), got ${nyy.sampleSize}`);
});

asyncTest('sampleSize uses teamGamesPlayed when no pitcher known', async () => {
  // Use schedule with no probable pitchers — sampleSize should fall back to gamesPlayed
  const fetch = makeFetch({
    'schedule':       FAKE_SCHEDULE_NO_PITCHERS,
    'standings':      FAKE_STANDINGS,
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, fetch);
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.strictEqual(nyy.sampleSize, 70, `Expected 70 (gamesPlayed), got ${nyy.sampleSize}`);
});

asyncTest('sampleSize is undefined when no standings and no pitcher data', async () => {
  const fetch = makeFetch({
    'schedule':  FAKE_SCHEDULE_NO_PITCHERS,
    'standings': { records: [] },              // empty standings
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, fetch);
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.strictEqual(nyy.sampleSize, undefined);
});

// MISSING_SAMPLE_SIZE warning
asyncTest('MISSING_SAMPLE_SIZE warning emitted when sampleSize is undefined', async () => {
  const fetch = makeFetch({
    'schedule':  FAKE_SCHEDULE_NO_PITCHERS,
    'standings': { records: [] },
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, fetch);
  const missingSampleWarnings = result.warnings.filter(
    w => w.code === 'MISSING_SAMPLE_SIZE',
  );
  assert.ok(missingSampleWarnings.length > 0,
    `Expected MISSING_SAMPLE_SIZE warning, got: ${result.warnings.map(w => w.code).join(', ')}`);
});

asyncTest('no MISSING_SAMPLE_SIZE warning when sampleSize is defined', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const missingSampleWarnings = result.warnings.filter(
    w => w.code === 'MISSING_SAMPLE_SIZE',
  );
  assert.strictEqual(missingSampleWarnings.length, 0,
    `Unexpected MISSING_SAMPLE_SIZE warnings: ${missingSampleWarnings.map(w => w.message).join('; ')}`);
});

asyncTest('MISSING_SAMPLE_SIZE warning includes gameId and team', async () => {
  const fetch = makeFetch({
    'schedule':  FAKE_SCHEDULE_NO_PITCHERS,
    'standings': { records: [] },
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, fetch);
  const w = result.warnings.find(w => w.code === 'MISSING_SAMPLE_SIZE' && w.team === 'New York Yankees');
  assert.ok(w, 'Expected MISSING_SAMPLE_SIZE for NYY');
  assert.ok(w!.gameId.length > 0, 'gameId should be populated');
  assert.ok(w!.message.length > 0, 'message should be populated');
});

asyncTest('small sampleSize (< 30) triggers small sample risk in calculateRisk', async () => {
  // Verify the end-to-end: sampleSize=14 should cause +10 risk points
  const { calculateRisk } = await import('../src/engines/risk.engine');
  const r = calculateRisk({
    americanOdds: -115,
    edgeDecimal:   0.06,
    confidence:    0.72,
    marketType:   'moneyline',
    betType:      'moneyline',
    sampleSize:    14,        // below 30 threshold
  });
  assert.ok(r.factors.samplePoints > 0,
    `Expected samplePoints > 0 for sampleSize=14, got ${r.factors.samplePoints}`);
  assert.ok(r.riskReasons.some(r => r.toLowerCase().includes('sample')),
    'Expected sample reason in riskReasons');
});

asyncTest('undefined sampleSize does NOT trigger small sample risk', async () => {
  const { calculateRisk } = await import('../src/engines/risk.engine');
  const r = calculateRisk({
    americanOdds: -115,
    edgeDecimal:   0.06,
    confidence:    0.72,
    marketType:   'moneyline',
    betType:      'moneyline',
    // sampleSize deliberately omitted
  });
  assert.strictEqual(r.factors.samplePoints, 0,
    `Expected samplePoints = 0 for undefined sampleSize, got ${r.factors.samplePoints}`);
});

asyncTest('no errors for a clean full fetch', async () => {
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  assert.strictEqual(result.errors.length, 0,
    `Unexpected errors: ${result.errors.map(e => e.message).join('; ')}`);
});

asyncTest('schedule fetch failure returns empty stats with error', async () => {
  const badFetch: FetchFn = async () => ({
    ok: false, status: 503,
    json: async () => ({}), text: async () => 'service unavailable',
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, badFetch);
  assert.strictEqual(result.teamGameStats.length, 0);
  assert.ok(result.errors.length > 0, 'Expected at least one error');
});

asyncTest('missing standings is non-fatal — teams still assembled without winPct', async () => {
  const fetch = makeFetch({
    'schedule':  FAKE_SCHEDULE,
    'standings': { records: [] },   // empty, no error — just no data
    'teams/147/stats?stats=season&group=hitting': FAKE_HIT_STATS_NYY,
    'teams/111/stats?stats=season&group=hitting': FAKE_HIT_STATS_BOS,
    'teams/147/stats?stats=season&group=pitching': FAKE_PIT_STATS_NYY,
    'teams/111/stats?stats=season&group=pitching': FAKE_PIT_STATS_BOS,
    'people/543037': FAKE_COLE_STATS,
    'people/605135': FAKE_BELLO_STATS,
  });
  const result = await assembleTeamGameStats('2025-06-10', 2025, fetch);
  // Should still produce entries — just with undefined winPct
  assert.strictEqual(result.teamGameStats.length, 2);
  const nyy = result.teamGameStats.find(s => s.team === 'New York Yankees')!;
  assert.strictEqual(nyy.teamWinPct, undefined);
});

asyncTest('output TeamGameStats entries are compatible with mlbStatsModel.adapter', async () => {
  const { buildModelProbabilityMap } = await import('../src/adapters/mlbStatsModel.adapter');
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  // Should produce a valid map with no errors
  const { map, errors } = buildModelProbabilityMap(result.teamGameStats, 'test-v1');
  assert.ok(Object.keys(map).length > 0, 'Expected at least one map entry');
  assert.strictEqual(errors.length, 0, `Model errors: ${errors.map(e => e.message).join('; ')}`);
});

asyncTest('sampleSize flows end-to-end into ModelProbabilityMap record', async () => {
  const { buildModelProbabilityMap } = await import('../src/adapters/mlbStatsModel.adapter');
  const result = await assembleTeamGameStats('2025-06-10', 2025, buildFullFetch());
  const { map } = buildModelProbabilityMap(result.teamGameStats, 'test-v1');
  // NYY entry should have sampleSize = 18 (min of gamesPlayed=70, starts=18)
  const nyyRecord = Object.entries(map).find(([k]) => k.includes('new york yankees'));
  assert.ok(nyyRecord, 'NYY record not found in map');
  assert.strictEqual(nyyRecord![1].sampleSize, 18);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`mlbStats.ingestion — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
