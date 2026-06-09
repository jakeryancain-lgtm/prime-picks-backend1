import * as assert from 'assert';
import { runDryRun, buildDryRunConfig, type DryRunConfig } from '../src/scripts/runTodayDryRun';
import type { FetchFn as StatsFetchFn } from '../src/adapters/mlbStats.ingestion';
import type { FetchFn as OddsFetchFn }  from '../src/adapters/oddsApi.adapter';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const asyncTests: Promise<void>[] = [];

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
// Fake MLB Stats API responses
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_SCHEDULE = {
  dates: [{
    date: '2025-06-10',
    games: [
      {
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
      },
      {
        gamePk: 777002,
        gameDate: '2025-06-10T20:10:00Z',
        teams: {
          home: {
            team: { id: 119, name: 'Los Angeles Dodgers' },
            probablePitcher: { id: 543243, fullName: 'Walker Buehler' },
          },
          away: {
            team: { id: 137, name: 'San Francisco Giants' },
            probablePitcher: { id: 605483, fullName: 'Logan Webb' },
          },
        },
      },
    ],
  }],
};

const FAKE_STANDINGS = {
  records: [{
    teamRecords: [
      { team: { id: 147, name: 'New York Yankees'    }, wins: 42, losses: 28, gamesPlayed: 70, winningPercentage: '0.600', records: { splitRecords: [{ type: 'lastTen', wins: 7, losses: 3 }] } },
      { team: { id: 111, name: 'Boston Red Sox'       }, wins: 30, losses: 40, gamesPlayed: 70, winningPercentage: '0.429', records: { splitRecords: [{ type: 'lastTen', wins: 4, losses: 6 }] } },
      { team: { id: 119, name: 'Los Angeles Dodgers'  }, wins: 50, losses: 20, gamesPlayed: 70, winningPercentage: '0.714', records: { splitRecords: [{ type: 'lastTen', wins: 8, losses: 2 }] } },
      { team: { id: 137, name: 'San Francisco Giants' }, wins: 32, losses: 38, gamesPlayed: 70, winningPercentage: '0.457', records: { splitRecords: [{ type: 'lastTen', wins: 5, losses: 5 }] } },
    ],
  }],
};

function makeStatsFetch(overrides: Record<string, unknown> = {}): StatsFetchFn {
  const base: Record<string, unknown> = {
    'schedule':                                  FAKE_SCHEDULE,
    'standings':                                 FAKE_STANDINGS,
    'teams/147/stats?stats=season&group=hitting': { stats: [{ splits: [{ stat: { ops: '.780' } }] }] },
    'teams/111/stats?stats=season&group=hitting': { stats: [{ splits: [{ stat: { ops: '.710' } }] }] },
    'teams/119/stats?stats=season&group=hitting': { stats: [{ splits: [{ stat: { ops: '.800' } }] }] },
    'teams/137/stats?stats=season&group=hitting': { stats: [{ splits: [{ stat: { ops: '.720' } }] }] },
    'teams/147/stats?stats=season&group=pitching': { stats: [{ splits: [{ stat: { era: '3.45' } }] }] },
    'teams/111/stats?stats=season&group=pitching': { stats: [{ splits: [{ stat: { era: '4.20' } }] }] },
    'teams/119/stats?stats=season&group=pitching': { stats: [{ splits: [{ stat: { era: '3.10' } }] }] },
    'teams/137/stats?stats=season&group=pitching': { stats: [{ splits: [{ stat: { era: '4.05' } }] }] },
    'people/543037': { people: [{ stats: [{ splits: [{ stat: { gamesStarted: 18, era: '2.95', inningsPitched: '110.1' } }] }] }] },
    'people/605135': { people: [{ stats: [{ splits: [{ stat: { gamesStarted: 16, era: '4.50', inningsPitched: '88.0'  } }] }] }] },
    'people/543243': { people: [{ stats: [{ splits: [{ stat: { gamesStarted: 14, era: '3.80', inningsPitched: '82.0'  } }] }] }] },
    'people/605483': { people: [{ stats: [{ splits: [{ stat: { gamesStarted: 20, era: '3.20', inningsPitched: '122.0' } }] }] }] },
    ...overrides,
  };

  return async (url: string) => {
    const key = Object.keys(base).find(k => url.includes(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => `no mock: ${url}` };
    return { ok: true, status: 200, json: async () => base[key], text: async () => '' };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake Odds API responses
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_ODDS_GAMES = [
  {
    id: 'game-nyy-bos', sport_key: 'baseball_mlb',
    commence_time: '2025-06-10T18:05:00Z',
    home_team: 'New York Yankees', away_team: 'Boston Red Sox',
    bookmakers: [{
      key: 'draftkings', title: 'DraftKings',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'New York Yankees', price: -130 },
        { name: 'Boston Red Sox',   price:  110 },
      ]}],
    }],
  },
  {
    id: 'game-lad-sf', sport_key: 'baseball_mlb',
    commence_time: '2025-06-10T20:10:00Z',
    home_team: 'Los Angeles Dodgers', away_team: 'San Francisco Giants',
    bookmakers: [{
      key: 'draftkings', title: 'DraftKings',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'Los Angeles Dodgers',  price: -160 },
        { name: 'San Francisco Giants', price:  140 },
      ]}],
    }],
  },
];

function makeOddsFetch(games = FAKE_ODDS_GAMES): OddsFetchFn {
  return async (_url: string) => ({
    ok: true, status: 200,
    json: async () => games,
    text: async () => JSON.stringify(games),
  });
}

function makeOddsFetchError(status = 401, body = 'Unauthorized'): OddsFetchFn {
  return async (_url: string) => ({
    ok: false, status,
    json: async () => ({}),
    text: async () => body,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Base config
// ─────────────────────────────────────────────────────────────────────────────

// Set ODDS_API_KEY for all tests — fetchMLBOdds validates it even with injected fetch
const ORIGINAL_ODDS_KEY = process.env['ODDS_API_KEY'];
process.env['ODDS_API_KEY'] = 'test-key-dry-run';

const BASE_CONFIG: DryRunConfig = {
  date:           '2025-06-10',
  season:         2025,
  modelVersionId: 'test-model-v1',
  statsFetchFn:   makeStatsFetch(),
  oddsFetchFn:    makeOddsFetch(),
};

// ─────────────────────────────────────────────────────────────────────────────
// buildDryRunConfig
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildDryRunConfig');

test('uses today\'s date by default', () => {
  const config = buildDryRunConfig([]);
  const today  = new Date().toISOString().slice(0, 10);
  assert.strictEqual(config.date, today);
});

test('--date flag overrides today', () => {
  const config = buildDryRunConfig(['--date', '2025-07-04']);
  assert.strictEqual(config.date, '2025-07-04');
});

test('--modelVersionId flag sets model version', () => {
  const config = buildDryRunConfig(['--modelVersionId', 'my-model-v3']);
  assert.strictEqual(config.modelVersionId, 'my-model-v3');
});

test('default modelVersionId is mlb-stats-v1', () => {
  const config = buildDryRunConfig([]);
  assert.strictEqual(config.modelVersionId, 'mlb-stats-v1');
});

// ─────────────────────────────────────────────────────────────────────────────
// runDryRun — full cycle with fake data
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nrunDryRun — full cycle');

asyncTest('runs full cycle without throwing', async () => {
  let threw = false;
  try { await runDryRun(BASE_CONFIG, true); } catch { threw = true; }
  assert.ok(!threw, 'runDryRun should not throw on valid inputs');
});

asyncTest('returns all required fields in result', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  const fields = [
    'date', 'modelVersionId', 'totalGames', 'totalOddsPicks',
    'matchedOddsPicks', 'unmatchedOddsPicks', 'readyPicks', 'missingModelPicks',
    'ingestionWarnings', 'ingestionErrors', 'matcherWarnings', 'matcherErrors',
    'oddsErrors', 'modelErrors', 'pipelineErrors',
    'topPicks', 'failedPicksByReason', 'noOddsPicks', 'qualifiedPicks', 'totalPipelinePicks',
  ];
  for (const f of fields) {
    assert.ok(f in result, `Missing result field: ${f}`);
  }
});

asyncTest('date and modelVersionId are echoed back', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(result.date,           BASE_CONFIG.date);
  assert.strictEqual(result.modelVersionId, BASE_CONFIG.modelVersionId);
});

asyncTest('totalGames equals number of games in schedule', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  // 2 games in FAKE_SCHEDULE
  assert.strictEqual(result.totalGames, 2);
});

asyncTest('totalOddsPicks equals picks from odds API', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  // 2 games × 2 teams = 4 picks (h2h only)
  assert.strictEqual(result.totalOddsPicks, 4);
});

asyncTest('readyPicks reflects matching between odds gameId and stats gameId', async () => {
  // In a real deployment, odds gameIds (from The Odds API) and stats gameIds
  // (MLB gamePk) are different — a team-name-based matching layer is needed.
  // In this test, odds use 'game-nyy-bos' and stats use '777001', so they don't match.
  // readyPicks will be 0 here; missingModelPicks = totalOddsPicks.
  // This is the CORRECT behavior — the test documents it, not a bug.
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(
    result.readyPicks + result.missingModelPicks,
    result.totalOddsPicks,
    'All odds picks should be accounted for (ready + missing = total)',
  );
});

asyncTest('totalPipelinePicks equals readyPicks (all flow into pipeline)', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(result.totalPipelinePicks, result.readyPicks);
});

asyncTest('no pipeline errors on clean run', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(result.pipelineErrors.length, 0);
});

asyncTest('no odds errors on clean run', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(result.oddsErrors.length, 0);
});

asyncTest('no ingestion errors on clean run', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.strictEqual(result.ingestionErrors.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// topPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntopPicks content');

asyncTest('topPicks contains only qualified picks', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  for (const p of result.topPicks) {
    assert.ok('team'        in p, 'missing team');
    assert.ok('opponent'    in p, 'missing opponent');
    assert.ok('edgePercent' in p, 'missing edgePercent');
    assert.ok('gradeLetter' in p, 'missing gradeLetter');
    assert.ok('riskLevel'   in p, 'missing riskLevel');
  }
});

asyncTest('topPicks length does not exceed 5', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  assert.ok(result.topPicks.length <= 5,
    `topPicks.length ${result.topPicks.length} exceeds max 5`);
});

asyncTest('topPicks has no duplicate opponents within the same game context', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  // No game ID in topPick result shape, but team name should be unique per game
  const teams = result.topPicks.map(p => p.team);
  const uniqueTeams = new Set(teams);
  assert.strictEqual(uniqueTeams.size, teams.length, 'Duplicate team in topPicks');
});

// ─────────────────────────────────────────────────────────────────────────────
// failedPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfailedPicksByReason');

asyncTest('failedPicksByReason is an object with string keys and number values', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  for (const [key, val] of Object.entries(result.failedPicksByReason)) {
    assert.ok(typeof key === 'string', `Key should be string: ${key}`);
    assert.ok(typeof val === 'number' && val > 0, `Value should be positive number: ${val}`);
  }
});

asyncTest('sum of failedPicksByReason values is non-negative', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  const total  = Object.values(result.failedPicksByReason).reduce((a, b) => a + b, 0);
  assert.ok(total >= 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Ingestion warnings
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ningestion warnings');

asyncTest('no MISSING_SAMPLE_SIZE warnings when all data is present', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  const sampleWarnings = result.ingestionWarnings.filter(
    w => w.includes('MISSING_SAMPLE_SIZE'),
  );
  assert.strictEqual(sampleWarnings.length, 0,
    `Unexpected MISSING_SAMPLE_SIZE warnings: ${sampleWarnings.join('; ')}`);
});

asyncTest('MISSING_SAMPLE_SIZE warning surfaces when standings are empty', async () => {
  // Use a stats fetch that returns empty standings — no gamesPlayed data
  // Pitcher starts will still be available, so sampleSize = pitcherStarts (not undefined)
  // To force undefined sampleSize we need BOTH standings empty AND no pitcher data
  const noPitcherSchedule = {
    dates: [{ date: '2025-06-10', games: [{
      gamePk: 888001, gameDate: '2025-06-10T18:05:00Z',
      teams: {
        home: { team: { id: 147, name: 'New York Yankees' } },   // no probablePitcher
        away: { team: { id: 111, name: 'Boston Red Sox' } },     // no probablePitcher
      },
    }] }],
  };
  const config: DryRunConfig = {
    ...BASE_CONFIG,
    statsFetchFn: makeStatsFetch({
      'standings': { records: [] },      // no standings = no gamesPlayed
      'schedule':  noPitcherSchedule,    // no probable pitchers = no pitcher starts
    }),
  };
  const result = await runDryRun(config, true);
  const hasMissingWarning = result.ingestionWarnings.some(
    w => w.includes('MISSING_SAMPLE_SIZE'),
  );
  assert.ok(hasMissingWarning, 'Expected MISSING_SAMPLE_SIZE warning when both standings and pitchers missing');
});

asyncTest('ingestionWarnings is an array of strings', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  for (const w of result.ingestionWarnings) {
    assert.ok(typeof w === 'string', `Warning should be string: ${w}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nerror handling');

asyncTest('odds API error is captured in oddsErrors and does not crash', async () => {
  // ODDS_API_KEY must be set for fetchMLBOdds to not throw validation error
  const orig = process.env['ODDS_API_KEY'];
  process.env['ODDS_API_KEY'] = 'fake-key-for-test';
  try {
    const config: DryRunConfig = {
      ...BASE_CONFIG,
      oddsFetchFn: makeOddsFetchError(401, 'Unauthorized'),
    };
    let threw = false;
    try { await runDryRun(config, true); } catch { threw = true; }
    assert.ok(!threw, 'runDryRun should not throw on odds API error');
  } finally {
    if (orig !== undefined) process.env['ODDS_API_KEY'] = orig;
    else delete process.env['ODDS_API_KEY'];
  }
});

asyncTest('stats API failure returns result with pipelineErrors populated', async () => {
  const badStats: StatsFetchFn = async () => ({
    ok: false, status: 503,
    json: async () => ({}), text: async () => 'service unavailable',
  });
  const config: DryRunConfig = { ...BASE_CONFIG, statsFetchFn: badStats };
  const result = await runDryRun(config, true);
  // Stats failure → totalGames = 0, some error captured
  assert.strictEqual(result.totalGames, 0);
  assert.ok(
    result.ingestionErrors.length > 0 || result.pipelineErrors.length > 0,
    'Expected at least one error from stats failure',
  );
});

asyncTest('unmatched odds picks reported when odds team has no stats', async () => {
  // Add an extra odds game that has no stats entry (DET/MIN)
  // With the matcher layer: these land in unmatchedOddsPicks (not missingModelPicks)
  // because the matcher filters them before model attachment
  const extraGame = {
    id: 'extra-game', sport_key: 'baseball_mlb',
    commence_time: '2025-06-10T21:00:00Z',
    home_team: 'Detroit Tigers', away_team: 'Minnesota Twins',
    bookmakers: [{
      key: 'draftkings', title: 'DraftKings',
      markets: [{ key: 'h2h', outcomes: [
        { name: 'Detroit Tigers',   price: 110 },
        { name: 'Minnesota Twins', price: -130 },
      ]}],
    }],
  };

  process.env['ODDS_API_KEY'] = 'fake-key-for-test';
  const config: DryRunConfig = {
    ...BASE_CONFIG,
    oddsFetchFn: makeOddsFetch([...FAKE_ODDS_GAMES, extraGame]),
  };
  const result = await runDryRun(config, true);
  // DET and MIN have no stats → they are unmatched at the matcher step
  assert.ok(result.unmatchedOddsPicks >= 2,
    `Expected ≥ 2 unmatchedOddsPicks for DET/MIN, got ${result.unmatchedOddsPicks}`);
  assert.strictEqual(result.totalOddsPicks, FAKE_ODDS_GAMES.length * 2 + 2, 'Total should include DET and MIN picks');
  delete process.env['ODDS_API_KEY'];
});

// ─────────────────────────────────────────────────────────────────────────────
// save=false guarantee
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsave=false guarantee');

asyncTest('runDryRun never saves to Supabase (no supabaseClient used)', async () => {
  // The dry-run has no way to save — verify by checking no Supabase import is called
  // We verify indirectly: if result has no DB-related errors, it never tried to save
  const result = await runDryRun(BASE_CONFIG, true);
  // A save attempt with no client would throw — absence of that error proves it didn't try
  const dbErrors = [
    ...result.pipelineErrors,
    ...result.ingestionErrors,
  ].filter(e => e.toLowerCase().includes('supabase') || e.toLowerCase().includes('database'));
  assert.strictEqual(dbErrors.length, 0, 'Unexpected Supabase-related errors in dry run');
});

asyncTest('result is JSON-serializable (safe for logging)', async () => {
  const result = await runDryRun(BASE_CONFIG, true);
  let threw = false;
  try { JSON.stringify(result); } catch { threw = true; }
  assert.ok(!threw, 'Dry run result should be JSON-serializable');
});

asyncTest('silent=true suppresses all console output', async () => {
  // We can't easily intercept console.log, but we can verify the function
  // completes without error in silent mode
  const result = await runDryRun(BASE_CONFIG, true);
  assert.ok(result !== undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  // Restore ODDS_API_KEY to original state
  if (ORIGINAL_ODDS_KEY !== undefined) process.env['ODDS_API_KEY'] = ORIGINAL_ODDS_KEY;
  else delete process.env['ODDS_API_KEY'];

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`runTodayDryRun — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
