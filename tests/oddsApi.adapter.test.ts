import * as assert from 'assert';
import {
  readOddsApiConfig,
  buildOddsApiUrl,
  normalizeOddsApiResponse,
  fetchMLBOdds,
  type OddsApiGame,
  type FetchFn,
} from '../src/adapters/oddsApi.adapter';

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
// Env helpers
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_KEY = process.env['ODDS_API_KEY'];

function setKey(val: string | undefined) {
  if (val === undefined) delete process.env['ODDS_API_KEY'];
  else process.env['ODDS_API_KEY'] = val;
}

function restoreKey() {
  if (ORIGINAL_KEY !== undefined) process.env['ODDS_API_KEY'] = ORIGINAL_KEY;
  else delete process.env['ODDS_API_KEY'];
}

const FAKE_KEY  = 'test-api-key-abc123';

// ─────────────────────────────────────────────────────────────────────────────
// Fake Odds API response fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MONEYLINE_GAME: OddsApiGame = {
  id:            'game-ml-001',
  sport_key:     'baseball_mlb',
  commence_time: '2025-06-10T18:05:00Z',
  home_team:     'New York Yankees',
  away_team:     'Boston Red Sox',
  bookmakers: [{
    key:   'draftkings',
    title: 'DraftKings',
    markets: [{
      key: 'h2h',
      outcomes: [
        { name: 'New York Yankees', price: -130 },
        { name: 'Boston Red Sox',   price:  110 },
      ],
    }],
  }],
};

const RUN_LINE_GAME: OddsApiGame = {
  id:            'game-rl-001',
  sport_key:     'baseball_mlb',
  commence_time: '2025-06-10T20:10:00Z',
  home_team:     'Los Angeles Dodgers',
  away_team:     'San Francisco Giants',
  bookmakers: [{
    key:   'fanduel',
    title: 'FanDuel',
    markets: [{
      key: 'spreads',
      outcomes: [
        { name: 'Los Angeles Dodgers', price: -110, point: -1.5 },
        { name: 'San Francisco Giants', price: -110, point:  1.5 },
      ],
    }],
  }],
};

const TOTALS_GAME: OddsApiGame = {
  id:            'game-tot-001',
  sport_key:     'baseball_mlb',
  commence_time: '2025-06-10T22:05:00Z',
  home_team:     'Houston Astros',
  away_team:     'Oakland Athletics',
  bookmakers: [{
    key:   'betmgm',
    title: 'BetMGM',
    markets: [{
      key: 'totals',
      outcomes: [
        { name: 'Over',  price: -115, point: 8.5 },
        { name: 'Under', price: -105, point: 8.5 },
      ],
    }],
  }],
};

const ALL_MARKETS_GAME: OddsApiGame = {
  id:            'game-all-001',
  sport_key:     'baseball_mlb',
  commence_time: '2025-06-10T19:10:00Z',
  home_team:     'Chicago Cubs',
  away_team:     'Milwaukee Brewers',
  bookmakers: [{
    key:   'draftkings',
    title: 'DraftKings',
    markets: [
      {
        key: 'h2h',
        outcomes: [
          { name: 'Chicago Cubs',     price: -120 },
          { name: 'Milwaukee Brewers', price:  100 },
        ],
      },
      {
        key: 'spreads',
        outcomes: [
          { name: 'Chicago Cubs',     price: -105, point: -1.5 },
          { name: 'Milwaukee Brewers', price: -115, point:  1.5 },
        ],
      },
      {
        key: 'totals',
        outcomes: [
          { name: 'Over',  price: -110, point: 9.0 },
          { name: 'Under', price: -110, point: 9.0 },
        ],
      },
    ],
  }],
};

// ─────────────────────────────────────────────────────────────────────────────
// Fake fetch factory
// ─────────────────────────────────────────────────────────────────────────────

function fakeFetch(games: OddsApiGame[]): FetchFn {
  return async (_url: string) => ({
    ok:     true,
    status: 200,
    json:   async () => games,
    text:   async () => JSON.stringify(games),
  });
}

function failingFetch(status: number, body: string): FetchFn {
  return async (_url: string) => ({
    ok:     false,
    status,
    json:   async () => { throw new Error('not JSON'); },
    text:   async () => body,
  });
}

function networkErrorFetch(): FetchFn {
  return async (_url: string) => {
    throw new Error('ECONNREFUSED: connection refused');
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// readOddsApiConfig
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nreadOddsApiConfig');

// Required test 1: missing ODDS_API_KEY throws
test('throws when ODDS_API_KEY is not set', () => {
  setKey(undefined);
  try {
    assert.throws(
      () => readOddsApiConfig(),
      (err: unknown) => err instanceof Error && err.message.includes('ODDS_API_KEY'),
    );
  } finally {
    restoreKey();
  }
});

test('throws when ODDS_API_KEY is empty string', () => {
  setKey('');
  try {
    assert.throws(() => readOddsApiConfig(), /ODDS_API_KEY/);
  } finally {
    restoreKey();
  }
});

test('throws when ODDS_API_KEY is whitespace only', () => {
  setKey('   ');
  try {
    assert.throws(() => readOddsApiConfig(), /ODDS_API_KEY/);
  } finally {
    restoreKey();
  }
});

test('returns trimmed apiKey when env var is set', () => {
  setKey(`  ${FAKE_KEY}  `);
  try {
    const config = readOddsApiConfig();
    assert.strictEqual(config.apiKey, FAKE_KEY);
  } finally {
    restoreKey();
  }
});

test('error message is descriptive and names the env var', () => {
  setKey(undefined);
  try {
    let msg = '';
    try { readOddsApiConfig(); } catch (e) { msg = e instanceof Error ? e.message : ''; }
    assert.ok(msg.includes('ODDS_API_KEY'));
    assert.ok(msg.length > 20);
  } finally {
    restoreKey();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// buildOddsApiUrl
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildOddsApiUrl');

// Required test 2: URL includes api key, sport, regions, markets, odds format
test('URL includes api key', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(url.includes(FAKE_KEY), 'API key missing from URL');
});

test('URL includes sport baseball_mlb', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(url.includes('baseball_mlb'), 'sport missing from URL');
});

test('URL includes regions=us', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(url.includes('regions=us'), 'regions missing from URL');
});

test('URL includes markets parameter', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h', 'spreads', 'totals'] });
  assert.ok(url.includes('markets='), 'markets param missing');
  assert.ok(url.includes('h2h'),     'h2h missing from markets');
  assert.ok(url.includes('spreads'), 'spreads missing from markets');
  assert.ok(url.includes('totals'),  'totals missing from markets');
});

test('URL includes oddsFormat=american', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(url.includes('american'), 'oddsFormat=american missing from URL');
});

test('URL points to the-odds-api.com v4 endpoint', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(url.startsWith('https://api.the-odds-api.com/v4'), `Unexpected base URL: ${url}`);
});

test('optional commenceTimeFrom is included when provided', () => {
  const url = buildOddsApiUrl({
    apiKey:           FAKE_KEY,
    markets:          ['h2h'],
    commenceTimeFrom: '2025-06-10T00:00:00Z',
  });
  assert.ok(url.includes('commenceTimeFrom'), 'commenceTimeFrom missing');
});

test('optional commenceTimeTo is included when provided', () => {
  const url = buildOddsApiUrl({
    apiKey:         FAKE_KEY,
    markets:        ['h2h'],
    commenceTimeTo: '2025-06-10T23:59:59Z',
  });
  assert.ok(url.includes('commenceTimeTo'), 'commenceTimeTo missing');
});

test('URL without optional params does not include their keys', () => {
  const url = buildOddsApiUrl({ apiKey: FAKE_KEY, markets: ['h2h'] });
  assert.ok(!url.includes('commenceTimeFrom'), 'unexpected commenceTimeFrom');
  assert.ok(!url.includes('commenceTimeTo'),   'unexpected commenceTimeTo');
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeOddsApiResponse — moneyline
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeOddsApiResponse — moneyline');

// Required test 3: normalize moneyline odds correctly
test('moneyline game produces two picks (one per team)', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  assert.strictEqual(picks.length, 2);
});

test('moneyline home team pick has correct americanOdds', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  const home  = picks.find(p => p.team === 'New York Yankees');
  assert.ok(home, 'Home team pick not found');
  assert.strictEqual(home!.americanOdds, -130);
});

test('moneyline away team pick has correct americanOdds', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  const away  = picks.find(p => p.team === 'Boston Red Sox');
  assert.ok(away, 'Away team pick not found');
  assert.strictEqual(away!.americanOdds, 110);
});

test('moneyline picks have betType moneyline and marketType moneyline', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.betType,    'moneyline');
    assert.strictEqual(pick.marketType, 'moneyline');
  }
});

test('moneyline picks have gameId matching the game id', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.gameId, 'game-ml-001');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeOddsApiResponse — run line
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeOddsApiResponse — run line');

// Required test 4: normalize run line odds correctly
test('run line game produces two picks (one per team)', () => {
  const picks = normalizeOddsApiResponse([RUN_LINE_GAME]);
  assert.strictEqual(picks.length, 2);
});

test('run line picks have betType run_line and marketType run_line', () => {
  const picks = normalizeOddsApiResponse([RUN_LINE_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.betType,    'run_line');
    assert.strictEqual(pick.marketType, 'run_line');
  }
});

test('run line home pick has correct runLineSpread', () => {
  const picks = normalizeOddsApiResponse([RUN_LINE_GAME]);
  const home  = picks.find(p => p.team === 'Los Angeles Dodgers');
  assert.ok(home, 'Home run line pick not found');
  assert.strictEqual(home!.runLineSpread, -1.5);
});

test('run line away pick has correct runLineSpread', () => {
  const picks = normalizeOddsApiResponse([RUN_LINE_GAME]);
  const away  = picks.find(p => p.team === 'San Francisco Giants');
  assert.ok(away, 'Away run line pick not found');
  assert.strictEqual(away!.runLineSpread, 1.5);
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeOddsApiResponse — totals
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeOddsApiResponse — totals');

// Required test 5: normalize totals odds correctly
test('totals game produces two picks (over and under)', () => {
  const picks = normalizeOddsApiResponse([TOTALS_GAME]);
  assert.strictEqual(picks.length, 2);
});

test('over pick has betType total_over and correct odds', () => {
  const picks = normalizeOddsApiResponse([TOTALS_GAME]);
  const over  = picks.find(p => p.betType === 'total_over');
  assert.ok(over, 'Over pick not found');
  assert.strictEqual(over!.americanOdds, -115);
  assert.strictEqual(over!.marketType,   'total');
});

test('under pick has betType total_under and correct odds', () => {
  const picks = normalizeOddsApiResponse([TOTALS_GAME]);
  const under = picks.find(p => p.betType === 'total_under');
  assert.ok(under, 'Under pick not found');
  assert.strictEqual(under!.americanOdds, -105);
  assert.strictEqual(under!.marketType,   'total');
});

// ─────────────────────────────────────────────────────────────────────────────
// oppositeAmericanOdds
// ─────────────────────────────────────────────────────────────────────────────

console.log('\noppositeAmericanOdds');

// Required test 6: oppositeAmericanOdds attached when both sides exist
test('moneyline home pick has oppositeAmericanOdds = away price', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  const home  = picks.find(p => p.team === 'New York Yankees');
  assert.strictEqual(home!.oppositeAmericanOdds, 110);
});

test('moneyline away pick has oppositeAmericanOdds = home price', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME]);
  const away  = picks.find(p => p.team === 'Boston Red Sox');
  assert.strictEqual(away!.oppositeAmericanOdds, -130);
});

test('run line picks have oppositeAmericanOdds set', () => {
  const picks = normalizeOddsApiResponse([RUN_LINE_GAME]);
  for (const pick of picks) {
    assert.ok(pick.oppositeAmericanOdds !== undefined, `oppositeAmericanOdds missing for ${pick.team}`);
  }
});

test('over pick has oppositeAmericanOdds = under price', () => {
  const picks = normalizeOddsApiResponse([TOTALS_GAME]);
  const over  = picks.find(p => p.betType === 'total_over');
  assert.strictEqual(over!.oppositeAmericanOdds, -105);
});

test('under pick has oppositeAmericanOdds = over price', () => {
  const picks = normalizeOddsApiResponse([TOTALS_GAME]);
  const under = picks.find(p => p.betType === 'total_under');
  assert.strictEqual(under!.oppositeAmericanOdds, -115);
});

// ─────────────────────────────────────────────────────────────────────────────
// modelProbability and confidence are null
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmodelProbability and confidence');

// Required test 7: modelProbability is null
test('modelProbability is null on all normalized picks', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME, RUN_LINE_GAME, TOTALS_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.modelProbability, null, `${pick.team}/${pick.betType}: modelProbability should be null`);
  }
});

// Required test 8: confidence is null
test('confidence is null on all normalized picks', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME, RUN_LINE_GAME, TOTALS_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.confidence, null, `${pick.team}/${pick.betType}: confidence should be null`);
  }
});

test('modelProbability is null even for games with all three markets', () => {
  const picks = normalizeOddsApiResponse([ALL_MARKETS_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.modelProbability, null);
  }
});

test('confidence is null even for games with all three markets', () => {
  const picks = normalizeOddsApiResponse([ALL_MARKETS_GAME]);
  for (const pick of picks) {
    assert.strictEqual(pick.confidence, null);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeOddsApiResponse — edge cases
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnormalizeOddsApiResponse — edge cases');

test('empty games array returns empty picks', () => {
  const picks = normalizeOddsApiResponse([]);
  assert.strictEqual(picks.length, 0);
});

test('game with no bookmakers produces no picks', () => {
  const noBookmakers: OddsApiGame = {
    ...MONEYLINE_GAME, id: 'no-bm-game', bookmakers: [],
  };
  const picks = normalizeOddsApiResponse([noBookmakers]);
  assert.strictEqual(picks.length, 0);
});

test('game with all three markets produces 6 picks', () => {
  const picks = normalizeOddsApiResponse([ALL_MARKETS_GAME]);
  // h2h: 2 + spreads: 2 + totals: 2 = 6
  assert.strictEqual(picks.length, 6);
});

test('prefers draftkings over fanduel when both available', () => {
  const game: OddsApiGame = {
    ...MONEYLINE_GAME,
    id: 'multi-bm-game',
    bookmakers: [
      {
        key: 'fanduel', title: 'FanDuel',
        markets: [{ key: 'h2h', outcomes: [
          { name: 'New York Yankees', price: -125 },
          { name: 'Boston Red Sox',   price:  105 },
        ]}],
      },
      {
        key: 'draftkings', title: 'DraftKings',
        markets: [{ key: 'h2h', outcomes: [
          { name: 'New York Yankees', price: -130 },
          { name: 'Boston Red Sox',   price:  110 },
        ]}],
      },
    ],
  };
  const picks = normalizeOddsApiResponse([game]);
  const home  = picks.find(p => p.team === 'New York Yankees');
  // DraftKings is first in preferred list, should use -130
  assert.strictEqual(home!.americanOdds, -130, 'Should use DraftKings price');
});

test('multiple games produce picks from all games', () => {
  const picks = normalizeOddsApiResponse([MONEYLINE_GAME, RUN_LINE_GAME, TOTALS_GAME]);
  const gameIds = new Set(picks.map(p => p.gameId));
  assert.strictEqual(gameIds.size, 3, 'Should have picks from 3 different games');
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchMLBOdds — injected fake fetch
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfetchMLBOdds');

// Required test 9: fetchMLBOdds uses injected fake fetch
asyncTest('uses injected fake fetch and returns normalized picks', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      markets: ['h2h'],
      fetchFn: fakeFetch([MONEYLINE_GAME]),
    });
    assert.strictEqual(result.errors.length, 0);
    assert.ok(result.picks.length > 0, 'Expected picks from fake fetch');
  } finally {
    restoreKey();
  }
});

asyncTest('fake fetch result contains correct pick data', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      markets: ['h2h'],
      fetchFn: fakeFetch([MONEYLINE_GAME]),
    });
    const home = result.picks.find(p => p.team === 'New York Yankees');
    assert.ok(home, 'Home team pick not found');
    assert.strictEqual(home!.americanOdds, -130);
    assert.strictEqual(home!.modelProbability, null);
  } finally {
    restoreKey();
  }
});

asyncTest('injected fetch URL contains api key and sport', async () => {
  setKey(FAKE_KEY);
  const capturedUrls: string[] = [];
  const capturingFetch: FetchFn = async (url) => {
    capturedUrls.push(url);
    return { ok: true, status: 200, json: async () => [], text: async () => '[]' };
  };
  try {
    await fetchMLBOdds({ fetchFn: capturingFetch });
    assert.strictEqual(capturedUrls.length, 1);
    assert.ok(capturedUrls[0]!.includes(FAKE_KEY), 'URL missing api key');
    assert.ok(capturedUrls[0]!.includes('baseball_mlb'), 'URL missing sport');
  } finally {
    restoreKey();
  }
});

asyncTest('empty response returns empty picks with no errors', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      fetchFn: fakeFetch([]),
    });
    assert.strictEqual(result.picks.length,  0);
    assert.strictEqual(result.errors.length, 0);
  } finally {
    restoreKey();
  }
});

// Required test 10: failed fetch returns error cleanly
asyncTest('HTTP error response returns error string and no picks', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      fetchFn: failingFetch(401, 'Unauthorized'),
    });
    assert.strictEqual(result.picks.length,  0);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0]!.includes('401'), 'Error should include status code');
  } finally {
    restoreKey();
  }
});

asyncTest('network error returns error string and no picks', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      fetchFn: networkErrorFetch(),
    });
    assert.strictEqual(result.picks.length,  0);
    assert.strictEqual(result.errors.length, 1);
    assert.ok(result.errors[0]!.toLowerCase().includes('error'), `Unexpected error: ${result.errors[0]}`);
  } finally {
    restoreKey();
  }
});

asyncTest('429 rate limit error is captured cleanly', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      fetchFn: failingFetch(429, 'Too Many Requests'),
    });
    assert.strictEqual(result.picks.length,  0);
    assert.ok(result.errors[0]!.includes('429'));
  } finally {
    restoreKey();
  }
});

asyncTest('fetchMLBOdds throws (not silently) when ODDS_API_KEY is missing', async () => {
  setKey(undefined);
  let threw = false;
  try {
    await fetchMLBOdds({ fetchFn: fakeFetch([]) });
  } catch (e: unknown) {
    threw = true;
    const msg = e instanceof Error ? e.message : '';
    assert.ok(msg.includes('ODDS_API_KEY'), `Expected ODDS_API_KEY error, got: ${msg}`);
  } finally {
    restoreKey();
  }
  assert.ok(threw, 'Expected fetchMLBOdds to throw on missing API key');
});

asyncTest('multiple games fetched correctly through fake fetch', async () => {
  setKey(FAKE_KEY);
  try {
    const result = await fetchMLBOdds({
      markets: ['h2h', 'spreads', 'totals'],
      fetchFn: fakeFetch([MONEYLINE_GAME, RUN_LINE_GAME, TOTALS_GAME, ALL_MARKETS_GAME]),
    });
    assert.strictEqual(result.errors.length, 0);
    // MONEYLINE(2) + RUN_LINE(2) + TOTALS(2) + ALL_MARKETS(6) = 12
    assert.strictEqual(result.picks.length, 12);
  } finally {
    restoreKey();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`oddsApi.adapter — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
