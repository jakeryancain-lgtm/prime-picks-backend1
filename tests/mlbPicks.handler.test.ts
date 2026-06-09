import * as assert from 'assert';
import {
  getMLBPicksHandler,
  type MLBPicksHandlerInput,
} from '../src/api/mlbPicks.handler';
import type { NormalizedPick }    from '../src/adapters/oddsApi.adapter';
import type { TeamGameStats }     from '../src/adapters/mlbStatsModel.adapter';
import type { SupabaseClientLike } from '../src/services/supabase.types';

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

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase client
// ─────────────────────────────────────────────────────────────────────────────

class FakeSupabaseClient implements SupabaseClientLike {
  public insertCallCount = 0;

  from(_table: string) {
    return {
      insert: async (rows: unknown[]) => {
        this.insertCallCount++;
        return { data: rows, error: null };
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — real-shaped data matching the end-to-end flow
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'mlb-handler-v1';
const TEST_DATE     = '2025-06-10';

const ODDS_PICKS: NormalizedPick[] = [
  {
    gameId:               'mlb-2025-06-10-nyy-bos',
    team:                 'New York Yankees',
    opponent:             'Boston Red Sox',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -120,
    oppositeAmericanOdds: 100,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
  {
    gameId:               'mlb-2025-06-10-nyy-bos',
    team:                 'Boston Red Sox',
    opponent:             'New York Yankees',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         100,
    oppositeAmericanOdds: -120,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
  {
    gameId:               'mlb-2025-06-10-hou-oak',
    team:                 'Houston Astros',
    opponent:             'Oakland Athletics',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -140,
    oppositeAmericanOdds: 120,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
];

const STRUCTURED_STATS: TeamGameStats[] = [
  {
    gameId:              'mlb-2025-06-10-nyy-bos',
    team:                'New York Yankees',
    opponent:            'Boston Red Sox',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              true,
    teamWinPct:          0.580,
    opponentWinPct:      0.430,
    spEra:               3.10,
    opponentSpEra:       4.90,
    bullpenEra:          3.40,
    opponentBullpenEra:  4.60,
    teamOps:             0.765,
    opponentOps:         0.695,
    recentFormWins:      7,
    opponentFormWins:    3,
  },
  {
    gameId:              'mlb-2025-06-10-nyy-bos',
    team:                'Boston Red Sox',
    opponent:            'New York Yankees',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              false,
    teamWinPct:          0.430,
    opponentWinPct:      0.580,
    spEra:               4.90,
    opponentSpEra:       3.10,
    bullpenEra:          4.60,
    opponentBullpenEra:  3.40,
    teamOps:             0.695,
    opponentOps:         0.765,
    recentFormWins:      3,
    opponentFormWins:    7,
  },
  {
    gameId:              'mlb-2025-06-10-hou-oak',
    team:                'Houston Astros',
    opponent:            'Oakland Athletics',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              true,
    teamWinPct:          0.555,
    opponentWinPct:      0.380,
    spEra:               3.50,
    opponentSpEra:       5.20,
    bullpenEra:          3.80,
    opponentBullpenEra:  5.00,
    teamOps:             0.755,
    opponentOps:         0.670,
    recentFormWins:      6,
    opponentFormWins:    3,
  },
];

function baseInput(overrides: Partial<MLBPicksHandlerInput> = {}): MLBPicksHandlerInput {
  return {
    date:                TEST_DATE,
    modelVersionId:      MODEL_VERSION,
    normalizedOddsPicks: ODDS_PICKS,
    structuredStats:     STRUCTURED_STATS,
    save:                false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: returns JSON-safe response
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nJSON-safe response');

asyncTest('response object has all required top-level fields', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  const required = [
    'date', 'modelVersionId', 'topPicks', 'qualifiedPicks',
    'failedPicks', 'noOddsPicks', 'summary', 'warnings', 'errors',
    'savedRows', 'timestamp',
  ];
  for (const f of required) {
    assert.ok(f in resp, `Missing field: ${f}`);
  }
});

// Test 10: JSON.stringify compatibility (test early — it's fundamental)
asyncTest('response can be serialized with JSON.stringify without error', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  let threw = false;
  try {
    const json = JSON.stringify(resp);
    assert.ok(json.length > 10, 'JSON string too short');
  } catch {
    threw = true;
  }
  assert.ok(!threw, 'JSON.stringify should not throw on response');
});

// Test 9: no undefined values
asyncTest('response has no undefined values at any level', async () => {
  const resp   = await getMLBPicksHandler(baseInput());
  const json   = JSON.stringify(resp);
  const parsed = JSON.parse(json) as Record<string, unknown>;

  function checkNoUndefined(obj: unknown, path = ''): void {
    if (obj === undefined) throw new Error(`undefined found at: ${path}`);
    if (obj === null || typeof obj !== 'object') return;
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (val === undefined) throw new Error(`undefined at: ${path}.${key}`);
      checkNoUndefined(val, `${path}.${key}`);
    }
  }

  checkNoUndefined(parsed);
});

asyncTest('arrays are arrays (not null/undefined)', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  assert.ok(Array.isArray(resp.topPicks),       'topPicks must be array');
  assert.ok(Array.isArray(resp.qualifiedPicks),  'qualifiedPicks must be array');
  assert.ok(Array.isArray(resp.failedPicks),     'failedPicks must be array');
  assert.ok(Array.isArray(resp.noOddsPicks),     'noOddsPicks must be array');
  assert.ok(Array.isArray(resp.warnings),        'warnings must be array');
  assert.ok(Array.isArray(resp.errors),          'errors must be array');
});

asyncTest('date and modelVersionId are echoed back correctly', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  assert.strictEqual(resp.date,           TEST_DATE);
  assert.strictEqual(resp.modelVersionId, MODEL_VERSION);
});

asyncTest('timestamp is a valid ISO-8601 string', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  assert.ok(typeof resp.timestamp === 'string');
  const ts = new Date(resp.timestamp);
  assert.ok(!isNaN(ts.getTime()), 'timestamp should be a valid date');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: returns topPicks from full daily model cycle
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntopPicks content');

asyncTest('topPicks has required fields on each pick', async () => {
  const resp     = await getMLBPicksHandler(baseInput());
  const required = [
    'id', 'gameId', 'team', 'opponent', 'betType', 'marketType',
    'americanOdds', 'modelProbability', 'impliedProbability',
    'edgeDecimal', 'edgePercent', 'edgeTier', 'riskLevel', 'riskScore',
    'gradeLetter', 'gradeNumeric', 'status', 'failReason', 'confidence',
  ];
  for (const pick of resp.topPicks) {
    for (const f of required) {
      assert.ok(f in pick, `topPick missing field: ${f}`);
    }
  }
});

asyncTest('topPicks have status QUALIFIED', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  for (const pick of resp.topPicks) {
    assert.strictEqual(pick.status, 'QUALIFIED');
  }
});

asyncTest('topPicks failReason is null (not undefined)', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  for (const pick of resp.topPicks) {
    assert.strictEqual(pick.failReason, null);
  }
});

asyncTest('topPicks have no duplicate gameIds', async () => {
  const resp    = await getMLBPicksHandler(baseInput());
  const gameIds = resp.topPicks.map(p => p.gameId);
  const unique  = new Set(gameIds);
  assert.strictEqual(unique.size, gameIds.length, 'Duplicate gameId in topPicks');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: failed picks include failReason
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfailed picks');

asyncTest('failed picks have status FAILED_FILTER', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  for (const pick of resp.failedPicks) {
    assert.strictEqual(pick.status, 'FAILED_FILTER');
  }
});

asyncTest('failed picks have non-null failReason', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  for (const pick of resp.failedPicks) {
    assert.ok(pick.failReason !== null, `Failed pick ${pick.id} missing failReason`);
    assert.ok(typeof pick.failReason === 'string');
    assert.ok(pick.failReason.length > 0);
  }
});

asyncTest('+1.5 run line appears in failedPicks with EXCLUDED_RUN_LINE', async () => {
  const runLinePick: NormalizedPick = {
    gameId:               'mlb-2025-06-10-lad-sf',
    team:                 'Los Angeles Dodgers',
    opponent:             'San Francisco Giants',
    betType:              'run_line',
    marketType:           'run_line',
    americanOdds:         -105,
    oppositeAmericanOdds: -115,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        1.5,
  };

  const runLineStats: TeamGameStats = {
    gameId:     'mlb-2025-06-10-lad-sf',
    team:       'Los Angeles Dodgers',
    opponent:   'San Francisco Giants',
    betType:    'run_line',
    marketType: 'run_line',
    isHome:     true,
    teamWinPct: 0.580,
    opponentWinPct: 0.420,
  };

  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [...ODDS_PICKS, runLinePick],
    structuredStats:     [...STRUCTURED_STATS, runLineStats],
  }));

  const excluded = resp.failedPicks.find(p =>
    p.betType === 'run_line' && p.failReason === 'EXCLUDED_RUN_LINE',
  );
  assert.ok(excluded, 'Expected EXCLUDED_RUN_LINE pick in failedPicks');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: noOddsPicks include NO_GRADE
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnoOddsPicks');

asyncTest('noOddsPicks have gradeLetter NO_GRADE', async () => {
  const noOddsPick: NormalizedPick = {
    gameId:               'mlb-2025-06-10-det-min',
    team:                 'Detroit Tigers',
    opponent:             'Minnesota Twins',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         null,
    oppositeAmericanOdds: undefined,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  };

  const noOddsStats: TeamGameStats = {
    gameId:     'mlb-2025-06-10-det-min',
    team:       'Detroit Tigers',
    opponent:   'Minnesota Twins',
    betType:    'moneyline',
    marketType: 'moneyline',
    isHome:     true,
    teamWinPct: 0.440,
    opponentWinPct: 0.480,
  };

  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [...ODDS_PICKS, noOddsPick],
    structuredStats:     [...STRUCTURED_STATS, noOddsStats],
  }));

  const noOddsResult = resp.noOddsPicks.find(p => p.gameId === 'mlb-2025-06-10-det-min');
  assert.ok(noOddsResult, 'Expected no-odds pick in noOddsPicks');
  assert.strictEqual(noOddsResult!.gradeLetter, 'NO_GRADE');
});

asyncTest('noOddsPicks have gradeNumeric 0', async () => {
  const noOddsPick: NormalizedPick = {
    gameId: 'no-odds-game', team: 'Team A', opponent: 'Team B',
    betType: 'moneyline', marketType: 'moneyline',
    americanOdds: null, oppositeAmericanOdds: undefined,
    modelProbability: null, confidence: null, runLineSpread: undefined,
  };

  const noOddsStats: TeamGameStats = {
    gameId: 'no-odds-game', team: 'Team A', opponent: 'Team B',
    betType: 'moneyline', marketType: 'moneyline',
    isHome: false, teamWinPct: 0.500, opponentWinPct: 0.500,
  };

  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [...ODDS_PICKS, noOddsPick],
    structuredStats:     [...STRUCTURED_STATS, noOddsStats],
  }));

  const noOddsResult = resp.noOddsPicks.find(p => p.gameId === 'no-odds-game');
  assert.ok(noOddsResult, 'Expected no-odds pick');
  assert.strictEqual(noOddsResult!.gradeNumeric, 0);
});

asyncTest('noOddsPicks have status NO_ODDS', async () => {
  const noOddsPick: NormalizedPick = {
    gameId: 'no-odds-game-2', team: 'Team C', opponent: 'Team D',
    betType: 'moneyline', marketType: 'moneyline',
    americanOdds: null, oppositeAmericanOdds: undefined,
    modelProbability: null, confidence: null, runLineSpread: undefined,
  };

  const noOddsStats: TeamGameStats = {
    gameId: 'no-odds-game-2', team: 'Team C', opponent: 'Team D',
    betType: 'moneyline', marketType: 'moneyline',
    isHome: true, teamWinPct: 0.500, opponentWinPct: 0.500,
  };

  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [...ODDS_PICKS, noOddsPick],
    structuredStats:     [...STRUCTURED_STATS, noOddsStats],
  }));

  const found = resp.noOddsPicks.find(p => p.gameId === 'no-odds-game-2');
  assert.ok(found, 'Expected no-odds pick in noOddsPicks group');
  assert.strictEqual(found!.status, 'NO_ODDS');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: save=false does not call Supabase
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsave flag');

asyncTest('save=false does not call Supabase insert', async () => {
  const client = new FakeSupabaseClient();
  await getMLBPicksHandler(baseInput({ save: false, supabaseClient: client }));
  assert.strictEqual(client.insertCallCount, 0,
    'insert should not be called when save=false');
});

asyncTest('save=false returns savedRows=0', async () => {
  const resp = await getMLBPicksHandler(baseInput({ save: false }));
  assert.strictEqual(resp.savedRows, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: save=true calls Supabase
// ─────────────────────────────────────────────────────────────────────────────

asyncTest('save=true with supabaseClient calls insert', async () => {
  const client = new FakeSupabaseClient();
  await getMLBPicksHandler(baseInput({ save: true, supabaseClient: client }));
  assert.ok(client.insertCallCount > 0, 'insert should be called when save=true');
});

asyncTest('save=true returns savedRows > 0', async () => {
  const client = new FakeSupabaseClient();
  const resp   = await getMLBPicksHandler(baseInput({ save: true, supabaseClient: client }));
  assert.ok(resp.savedRows > 0, `savedRows should be > 0, got ${resp.savedRows}`);
});

asyncTest('save=true saves all picks from all groups', async () => {
  const client = new FakeSupabaseClient();
  const resp   = await getMLBPicksHandler(baseInput({ save: true, supabaseClient: client }));
  const totalPicks =
    resp.topPicks.length + resp.qualifiedPicks.length +
    resp.failedPicks.length + resp.noOddsPicks.length;
  assert.strictEqual(resp.savedRows, totalPicks);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: missing modelVersionId throws or returns clear error
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nvalidation');

asyncTest('missing modelVersionId returns error in response.errors', async () => {
  const resp = await getMLBPicksHandler(baseInput({ modelVersionId: '' }));
  assert.ok(resp.errors.length > 0, 'Expected at least one error');
  assert.ok(
    resp.errors.some(e => e.toLowerCase().includes('modelVersionId'.toLowerCase())),
    'Error should mention modelVersionId',
  );
});

asyncTest('missing modelVersionId returns empty arrays', async () => {
  const resp = await getMLBPicksHandler(baseInput({ modelVersionId: '' }));
  assert.strictEqual(resp.topPicks.length,      0);
  assert.strictEqual(resp.qualifiedPicks.length, 0);
  assert.strictEqual(resp.failedPicks.length,   0);
  assert.strictEqual(resp.noOddsPicks.length,   0);
});

asyncTest('missing modelVersionId does not throw (returns response)', async () => {
  let threw = false;
  try {
    await getMLBPicksHandler(baseInput({ modelVersionId: '' }));
  } catch {
    threw = true;
  }
  assert.ok(!threw, 'Handler should never throw, even on invalid input');
});

asyncTest('save=true without supabaseClient returns error', async () => {
  const resp = await getMLBPicksHandler(baseInput({ save: true, supabaseClient: undefined }));
  assert.ok(resp.errors.length > 0, 'Expected error about missing supabaseClient');
  assert.ok(
    resp.errors.some(e => e.toLowerCase().includes('supabase')),
    'Error should mention supabaseClient',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: empty slate returns empty arrays, not crash
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nempty slate');

asyncTest('empty odds picks and stats returns empty arrays without crash', async () => {
  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [],
    structuredStats:     [],
  }));
  assert.strictEqual(resp.topPicks.length,      0);
  assert.strictEqual(resp.qualifiedPicks.length, 0);
  assert.strictEqual(resp.failedPicks.length,   0);
  assert.strictEqual(resp.noOddsPicks.length,   0);
  assert.strictEqual(resp.errors.length,        0);
});

asyncTest('empty slate adds a warning about empty input', async () => {
  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [],
    structuredStats:     [],
  }));
  assert.ok(resp.warnings.length > 0, 'Expected warning for empty input');
});

asyncTest('empty slate is still JSON-serializable', async () => {
  const resp = await getMLBPicksHandler(baseInput({
    normalizedOddsPicks: [],
    structuredStats:     [],
  }));
  assert.doesNotThrow(() => JSON.stringify(resp));
});

asyncTest('odds picks with no stats returns missingModelPicks warning', async () => {
  const resp = await getMLBPicksHandler(baseInput({
    structuredStats: [],
  }));
  assert.ok(
    resp.warnings.some(w => w.toLowerCase().includes('missing')),
    `Expected missing model picks warning, got: ${resp.warnings.join(', ')}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary field correctness
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsummary');

asyncTest('summary fields are all numbers', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  const numFields: (keyof typeof resp.summary)[] = [
    'totalOddsPicks', 'totalModelRecords', 'totalPipelineInputs',
    'topPicks', 'qualifiedPicks', 'failedPicks', 'noOddsPicks', 'savedRows',
  ];
  for (const f of numFields) {
    assert.ok(typeof resp.summary[f] === 'number',
      `summary.${f} should be a number, got ${typeof resp.summary[f]}`);
  }
});

asyncTest('summary.topPicks matches topPicks array length', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  assert.strictEqual(resp.summary.topPicks, resp.topPicks.length);
});

asyncTest('summary group sum equals totalPipelineInputs', async () => {
  const resp = await getMLBPicksHandler(baseInput());
  const sum  = resp.summary.topPicks + resp.summary.qualifiedPicks
    + resp.summary.failedPicks + resp.summary.noOddsPicks;
  assert.strictEqual(sum, resp.summary.totalPipelineInputs);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`mlbPicks.handler — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
