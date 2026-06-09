import * as assert from 'assert';
import {
  calculateModelProbability,
  buildModelProbabilityMap,
  type TeamGameStats,
} from '../src/adapters/mlbStatsModel.adapter';
import { buildModelKey } from '../src/adapters/mlbModel.adapter';

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

const MODEL_VERSION = 'mlb-stats-v1';

/** Completely neutral matchup — all stats equal, neutral context. */
function neutral(overrides: Partial<TeamGameStats> = {}): TeamGameStats {
  return {
    gameId:            'game-001',
    team:              'NYY',
    opponent:          'BOS',
    betType:           'moneyline',
    marketType:        'moneyline',
    isHome:            false,
    teamWinPct:        0.500,
    opponentWinPct:    0.500,
    spEra:             4.20,
    opponentSpEra:     4.20,
    bullpenEra:        4.00,
    opponentBullpenEra: 4.00,
    teamOps:           0.720,
    opponentOps:       0.720,
    recentFormWins:    5,
    opponentFormWins:  5,
    ...overrides,
  };
}

/** A clearly stronger team — better across all factors. */
function strongTeam(): TeamGameStats {
  return neutral({
    gameId:            'game-strong',
    teamWinPct:        0.600,
    opponentWinPct:    0.400,
    spEra:             3.00,
    opponentSpEra:     5.00,
    bullpenEra:        3.20,
    opponentBullpenEra: 4.80,
    teamOps:           0.780,
    opponentOps:       0.660,
    recentFormWins:    8,
    opponentFormWins:  3,
    isHome:            true,
  });
}

/** A clearly weaker team — worse across all factors. */
function weakTeam(): TeamGameStats {
  return neutral({
    gameId:            'game-weak',
    teamWinPct:        0.400,
    opponentWinPct:    0.600,
    spEra:             5.00,
    opponentSpEra:     3.00,
    bullpenEra:        4.80,
    opponentBullpenEra: 3.20,
    teamOps:           0.660,
    opponentOps:       0.780,
    recentFormWins:    3,
    opponentFormWins:  8,
    isHome:            false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests 1–2: stronger and weaker team probability direction
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nprobability direction');

// Required test 1: stronger team gets probability above 50%
test('stronger team gets modelProbability above 0.50', () => {
  const r = calculateModelProbability(strongTeam(), MODEL_VERSION);
  if (r.modelProbability <= 0.50) {
    throw new Error(`Strong team expected > 0.50, got ${r.modelProbability}`);
  }
});

// Required test 2: weaker team gets probability below 50%
test('weaker team gets modelProbability below 0.50', () => {
  const r = calculateModelProbability(weakTeam(), MODEL_VERSION);
  if (r.modelProbability >= 0.50) {
    throw new Error(`Weak team expected < 0.50, got ${r.modelProbability}`);
  }
});

// Required test 3: equal teams stay near 50%
test('equal teams (all neutral stats) stay within ±2% of 50%', () => {
  const r = calculateModelProbability(neutral(), MODEL_VERSION);
  if (Math.abs(r.modelProbability - 0.50) > 0.02) {
    throw new Error(`Equal teams expected ~0.50, got ${r.modelProbability}`);
  }
});

test('stronger team probability is higher than weaker team probability', () => {
  const strong = calculateModelProbability(strongTeam(), MODEL_VERSION);
  const weak   = calculateModelProbability(weakTeam(),   MODEL_VERSION);
  if (strong.modelProbability <= weak.modelProbability) {
    throw new Error(
      `Strong ${strong.modelProbability} should exceed weak ${weak.modelProbability}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 4–8: individual factor effects
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nindividual factor effects');

// Required test 4: elite pitcher advantage increases probability
test('team with elite SP ERA (2.50 vs 5.00) has higher prob than equal SPs', () => {
  const base   = calculateModelProbability(neutral(), MODEL_VERSION);
  const elite  = calculateModelProbability(
    neutral({ spEra: 2.50, opponentSpEra: 5.00 }),
    MODEL_VERSION,
  );
  if (elite.modelProbability <= base.modelProbability) {
    throw new Error(
      `Elite SP (${elite.modelProbability}) should exceed base (${base.modelProbability})`,
    );
  }
});

test('pitcher advantage increases probability by a meaningful amount', () => {
  const base  = calculateModelProbability(neutral(), MODEL_VERSION);
  const elite = calculateModelProbability(
    neutral({ spEra: 2.50, opponentSpEra: 5.50 }),
    MODEL_VERSION,
  );
  const diff = elite.modelProbability - base.modelProbability;
  if (diff < 0.02) {
    throw new Error(`SP ERA gap of 3 should add ≥ 2%, added ${(diff * 100).toFixed(2)}%`);
  }
});

test('poor SP ERA (5.50 vs 3.00) decreases probability', () => {
  const base = calculateModelProbability(neutral(), MODEL_VERSION);
  const bad  = calculateModelProbability(
    neutral({ spEra: 5.50, opponentSpEra: 3.00 }),
    MODEL_VERSION,
  );
  if (bad.modelProbability >= base.modelProbability) {
    throw new Error(`Bad SP should decrease probability`);
  }
});

// Required test 5: bullpen advantage increases probability
test('bullpen advantage (3.00 vs 4.50) increases probability', () => {
  const base   = calculateModelProbability(neutral(), MODEL_VERSION);
  const better = calculateModelProbability(
    neutral({ bullpenEra: 3.00, opponentBullpenEra: 4.50 }),
    MODEL_VERSION,
  );
  if (better.modelProbability <= base.modelProbability) {
    throw new Error(`Better bullpen should increase probability`);
  }
});

// Required test 6: OPS advantage increases probability
test('OPS advantage (0.800 vs 0.680) increases probability', () => {
  const base   = calculateModelProbability(neutral(), MODEL_VERSION);
  const better = calculateModelProbability(
    neutral({ teamOps: 0.800, opponentOps: 0.680 }),
    MODEL_VERSION,
  );
  if (better.modelProbability <= base.modelProbability) {
    throw new Error(`Better OPS should increase probability`);
  }
});

test('OPS disadvantage (0.640 vs 0.800) decreases probability', () => {
  const base  = calculateModelProbability(neutral(), MODEL_VERSION);
  const worse = calculateModelProbability(
    neutral({ teamOps: 0.640, opponentOps: 0.800 }),
    MODEL_VERSION,
  );
  if (worse.modelProbability >= base.modelProbability) {
    throw new Error(`Worse OPS should decrease probability`);
  }
});

// Required test 7: recent form advantage increases probability
test('recent form advantage (8-2 vs 2-8) increases probability', () => {
  const base   = calculateModelProbability(neutral(), MODEL_VERSION);
  const hotTeam = calculateModelProbability(
    neutral({ recentFormWins: 8, opponentFormWins: 2 }),
    MODEL_VERSION,
  );
  if (hotTeam.modelProbability <= base.modelProbability) {
    throw new Error(`Hot team should have higher probability`);
  }
});

test('cold team (2-8 vs 8-2) has lower probability', () => {
  const base = calculateModelProbability(neutral(), MODEL_VERSION);
  const cold  = calculateModelProbability(
    neutral({ recentFormWins: 2, opponentFormWins: 8 }),
    MODEL_VERSION,
  );
  if (cold.modelProbability >= base.modelProbability) {
    throw new Error(`Cold team should have lower probability`);
  }
});

// Required test 8: home field slightly increases probability
test('home team has higher probability than road team (all else equal)', () => {
  const home = calculateModelProbability(neutral({ isHome: true  }), MODEL_VERSION);
  const away = calculateModelProbability(neutral({ isHome: false }), MODEL_VERSION);
  if (home.modelProbability <= away.modelProbability) {
    throw new Error(
      `Home (${home.modelProbability}) should exceed away (${away.modelProbability})`,
    );
  }
});

test('home field advantage is small (< 5 percentage points)', () => {
  const home = calculateModelProbability(neutral({ isHome: true  }), MODEL_VERSION);
  const away = calculateModelProbability(neutral({ isHome: false }), MODEL_VERSION);
  const diff = home.modelProbability - away.modelProbability;
  if (diff >= 0.05) {
    throw new Error(`Home advantage ${(diff * 100).toFixed(1)}% should be < 5%`);
  }
});

// Required test 9: injury penalty lowers probability
test('negative injury adjustment lowers probability', () => {
  const base    = calculateModelProbability(neutral(), MODEL_VERSION);
  const injured = calculateModelProbability(
    neutral({ injuryAdjustment: -0.05 }),
    MODEL_VERSION,
  );
  if (injured.modelProbability >= base.modelProbability) {
    throw new Error(`Injury penalty should lower probability`);
  }
});

test('positive injury adjustment (opponent injured) raises probability', () => {
  const base    = calculateModelProbability(neutral(), MODEL_VERSION);
  const benefit = calculateModelProbability(
    neutral({ injuryAdjustment: 0.02 }),
    MODEL_VERSION,
  );
  if (benefit.modelProbability <= base.modelProbability) {
    throw new Error(`Opponent injury should raise probability`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: missing data lowers confidence
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nconfidence and data presence');

// Required test 10: missing data lowers confidence
test('fewer data points produces lower confidence than full data', () => {
  const full    = calculateModelProbability(strongTeam(), MODEL_VERSION);
  const sparse  = calculateModelProbability(
    {
      gameId:     'game-sparse',
      team:       'NYY',
      opponent:   'BOS',
      betType:    'moneyline',
      marketType: 'moneyline',
      isHome:     true,
      // Only win% provided, nothing else
      teamWinPct:     0.550,
      opponentWinPct: 0.450,
    },
    MODEL_VERSION,
  );
  if (sparse.confidence >= full.confidence) {
    throw new Error(
      `Sparse data confidence (${sparse.confidence}) should be < full (${full.confidence})`,
    );
  }
});

test('completely missing all optional stats still produces valid confidence', () => {
  const minimal = calculateModelProbability(
    {
      gameId:     'game-min',
      team:       'NYY',
      opponent:   'BOS',
      betType:    'moneyline',
      marketType: 'moneyline',
      isHome:     false,
      // No stats at all
    },
    MODEL_VERSION,
  );
  assert.ok(minimal.confidence > 0, 'confidence should be > 0 even with no stats');
  assert.ok(minimal.confidence < 1, 'confidence should be < 1 with minimal data');
});

test('more matching data points increases dataPointsUsed', () => {
  const sparse = calculateModelProbability(
    { gameId: 'g', team: 'NYY', opponent: 'BOS', betType: 'moneyline', marketType: 'moneyline', isHome: false },
    MODEL_VERSION,
  );
  const full = calculateModelProbability(strongTeam(), MODEL_VERSION);
  assert.ok(full.dataPointsUsed > sparse.dataPointsUsed,
    `full ${full.dataPointsUsed} should exceed sparse ${sparse.dataPointsUsed}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 11–12: probability clamping
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nprobability clamping');

// Required test 11: probability clamps at max 75%
test('extreme advantage cannot push probability above 75%', () => {
  const extreme = calculateModelProbability(
    neutral({
      teamWinPct:        0.700,
      opponentWinPct:    0.300,
      spEra:             2.00,
      opponentSpEra:     6.00,
      bullpenEra:        2.50,
      opponentBullpenEra: 5.50,
      teamOps:           0.850,
      opponentOps:       0.600,
      recentFormWins:    10,
      opponentFormWins:  0,
      isHome:            true,
      injuryAdjustment:  0.02,
    }),
    MODEL_VERSION,
  );
  if (extreme.modelProbability > 0.75) {
    throw new Error(`Probability ${extreme.modelProbability} exceeds max 0.75`);
  }
  assert.ok(Math.abs(extreme.modelProbability - 0.75) < 0.001,
    `At cap: expected 0.75, got ${extreme.modelProbability}`);
});

// Required test 12: probability clamps at min 35%
test('extreme disadvantage cannot push probability below 35%', () => {
  const extreme = calculateModelProbability(
    neutral({
      teamWinPct:        0.300,
      opponentWinPct:    0.700,
      spEra:             6.00,
      opponentSpEra:     2.00,
      bullpenEra:        5.50,
      opponentBullpenEra: 2.50,
      teamOps:           0.600,
      opponentOps:       0.850,
      recentFormWins:    0,
      opponentFormWins:  10,
      isHome:            false,
      injuryAdjustment:  -0.06,
    }),
    MODEL_VERSION,
  );
  if (extreme.modelProbability < 0.35) {
    throw new Error(`Probability ${extreme.modelProbability} below min 0.35`);
  }
  assert.ok(Math.abs(extreme.modelProbability - 0.35) < 0.001,
    `At floor: expected 0.35, got ${extreme.modelProbability}`);
});

test('clamped result is reflected in factors.clampedTotal', () => {
  const extreme = calculateModelProbability(strongTeam(), MODEL_VERSION);
  assert.strictEqual(extreme.modelProbability, extreme.factors.clampedTotal);
});

test('rawTotal vs clampedTotal shows when clamping occurred', () => {
  const extreme = calculateModelProbability(
    neutral({
      teamWinPct: 0.700, opponentWinPct: 0.300,
      spEra: 2.00, opponentSpEra: 6.00,
      bullpenEra: 2.50, opponentBullpenEra: 5.50,
      teamOps: 0.850, opponentOps: 0.600,
      recentFormWins: 10, opponentFormWins: 0,
      isHome: true,
    }),
    MODEL_VERSION,
  );
  // rawTotal should exceed 0.75 before clamping
  if (extreme.factors.rawTotal <= 0.75) {
    throw new Error(`Expected rawTotal > 0.75 for extreme inputs, got ${extreme.factors.rawTotal}`);
  }
  assert.strictEqual(extreme.factors.clampedTotal, 0.75);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests 13–14: confidence bounds
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nconfidence bounds');

// Required test 13: confidence never exceeds 1
test('confidence never exceeds 1 across many combinations', () => {
  const cases: Partial<TeamGameStats>[] = [
    {},
    { teamWinPct: 0.700, opponentWinPct: 0.300 },
    { spEra: 2.00, opponentSpEra: 6.00, bullpenEra: 2.50, opponentBullpenEra: 5.50 },
    { teamOps: 0.850, opponentOps: 0.600, recentFormWins: 10, opponentFormWins: 0 },
    { isHome: true, injuryAdjustment: 0.02, weatherAdjustment: -0.02 },
  ];
  for (const c of cases) {
    const r = calculateModelProbability(neutral(c), MODEL_VERSION);
    if (r.confidence > 1) {
      throw new Error(`confidence ${r.confidence} > 1 for ${JSON.stringify(c)}`);
    }
  }
});

// Required test 14: confidence never goes below 0
test('confidence never goes below 0 — even with no data', () => {
  const minimal = calculateModelProbability(
    { gameId: 'g', team: 'T', opponent: 'O', betType: 'moneyline', marketType: 'moneyline', isHome: false },
    MODEL_VERSION,
  );
  if (minimal.confidence < 0) {
    throw new Error(`confidence ${minimal.confidence} < 0`);
  }
});

test('confidence stays in (0, 1) exclusive across all test inputs', () => {
  const inputs: TeamGameStats[] = [
    strongTeam(),
    weakTeam(),
    neutral(),
    neutral({ isHome: true }),
    neutral({ injuryAdjustment: -0.06, weatherAdjustment: -0.03 }),
    neutral({ teamWinPct: 0.700, opponentWinPct: 0.300, spEra: 2.00, opponentSpEra: 6.00 }),
  ];
  for (const input of inputs) {
    const r = calculateModelProbability(input, MODEL_VERSION);
    if (r.confidence <= 0 || r.confidence >= 1) {
      throw new Error(`confidence ${r.confidence} out of (0,1) for ${input.team}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 15: output is compatible with mlbModel.adapter.ts
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmlbModel.adapter compatibility');

// Required test 15: output is compatible with mlbModel.adapter.ts
test('buildModelProbabilityMap produces keys matching buildModelKey format', () => {
  const stats = strongTeam();
  const { map } = buildModelProbabilityMap([stats], MODEL_VERSION);
  const expectedKey = buildModelKey(
    stats.gameId, stats.team, stats.betType, stats.marketType,
  );
  assert.ok(expectedKey in map, `Expected key "${expectedKey}" not in map`);
});

test('map entries have modelProbability as a number (not null)', () => {
  const { map } = buildModelProbabilityMap([strongTeam(), weakTeam()], MODEL_VERSION);
  for (const [key, record] of Object.entries(map)) {
    if (record.modelProbability === null || typeof record.modelProbability !== 'number') {
      throw new Error(`Key ${key}: modelProbability is null or not a number`);
    }
  }
});

test('map entries have confidence as a number (not null)', () => {
  const { map } = buildModelProbabilityMap([strongTeam(), weakTeam()], MODEL_VERSION);
  for (const [key, record] of Object.entries(map)) {
    if (record.confidence === null || typeof record.confidence !== 'number') {
      throw new Error(`Key ${key}: confidence is null or not a number`);
    }
  }
});

test('map entries have modelVersionId set', () => {
  const { map } = buildModelProbabilityMap([strongTeam()], MODEL_VERSION);
  for (const [key, record] of Object.entries(map)) {
    if (!record.modelVersionId) {
      throw new Error(`Key ${key}: modelVersionId missing`);
    }
    assert.strictEqual(record.modelVersionId, MODEL_VERSION);
  }
});

test('buildModelProbabilityMap processes multiple stats entries', () => {
  const inputs = [strongTeam(), weakTeam(), neutral({ gameId: 'game-n', team: 'HOU' })];
  const { map, outputs, errors } = buildModelProbabilityMap(inputs, MODEL_VERSION);
  assert.strictEqual(outputs.length, 3);
  assert.strictEqual(errors.length,  0);
  assert.strictEqual(Object.keys(map).length, 3);
});

test('map values satisfy the ModelProbabilityRecord interface shape', () => {
  const { map } = buildModelProbabilityMap([neutral()], MODEL_VERSION);
  for (const record of Object.values(map)) {
    assert.ok('modelProbability' in record, 'missing modelProbability');
    assert.ok('confidence'       in record, 'missing confidence');
    assert.ok('modelVersionId'   in record, 'missing modelVersionId');
    assert.ok(typeof record.modelProbability === 'number');
    assert.ok(typeof record.confidence       === 'number');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Output shape completeness
// ─────────────────────────────────────────────────────────────────────────────

console.log('\noutput shape');

test('calculateModelProbability returns all required fields', () => {
  const r = calculateModelProbability(neutral(), MODEL_VERSION);
  const requiredFields = [
    'gameId', 'team', 'opponent', 'betType', 'marketType',
    'modelProbability', 'confidence', 'modelVersionId',
    'dataPointsUsed', 'factorsAgreeing', 'factors', 'explanation',
    // sampleSize is present in the interface (may be undefined when not provided)
  ];
  for (const f of requiredFields) {
    if (!(f in r)) throw new Error(`Missing field: ${f}`);
  }
  // sampleSize key exists on the return shape (even if value is undefined)
  assert.ok('sampleSize' in r, 'sampleSize key should exist on output');
});

test('sampleSize is undefined when not provided in TeamGameStats', () => {
  const r = calculateModelProbability(neutral(), MODEL_VERSION);
  assert.strictEqual(r.sampleSize, undefined);
});

test('sampleSize is passed through when provided in TeamGameStats', () => {
  const r = calculateModelProbability(neutral({ sampleSize: 18 }), MODEL_VERSION);
  assert.strictEqual(r.sampleSize, 18);
});

test('sampleSize is passed through by buildModelProbabilityMap into the map record', () => {
  const { map } = buildModelProbabilityMap(
    [neutral({ sampleSize: 22 })],
    MODEL_VERSION,
  );
  const record = Object.values(map)[0];
  assert.ok(record, 'Expected one map entry');
  assert.strictEqual(record!.sampleSize, 22);
});

test('sampleSize undefined in TeamGameStats produces undefined in map record', () => {
  const { map } = buildModelProbabilityMap([neutral()], MODEL_VERSION);
  const record = Object.values(map)[0];
  assert.ok(record, 'Expected one map entry');
  assert.strictEqual(record!.sampleSize, undefined);
});

test('factors breakdown contains all expected sub-fields', () => {
  const r = calculateModelProbability(neutral(), MODEL_VERSION);
  const factorFields = [
    'base', 'winPctAdj', 'pitcherAdj', 'bullpenAdj',
    'opsAdj', 'formAdj', 'homeAdj', 'injuryAdj', 'weatherAdj',
    'rawTotal', 'clampedTotal',
  ];
  for (const f of factorFields) {
    if (!(f in r.factors)) throw new Error(`Missing factors.${f}`);
  }
});

test('explanation string is non-empty and includes probability', () => {
  const r = calculateModelProbability(neutral(), MODEL_VERSION);
  assert.ok(typeof r.explanation === 'string');
  assert.ok(r.explanation.length > 10, 'explanation too short');
  assert.ok(r.explanation.includes('%'), 'explanation should contain percentage');
});

test('modelVersionId is echoed from input', () => {
  const r = calculateModelProbability(neutral(), 'my-custom-version');
  assert.strictEqual(r.modelVersionId, 'my-custom-version');
});

// ─────────────────────────────────────────────────────────────────────────────
// Determinism
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ndeterminism');

test('same input always produces same output', () => {
  const stats = strongTeam();
  const r1    = calculateModelProbability(stats, MODEL_VERSION);
  const r2    = calculateModelProbability(stats, MODEL_VERSION);
  assert.strictEqual(r1.modelProbability, r2.modelProbability);
  assert.strictEqual(r1.confidence,       r2.confidence);
});

test('factors sum to rawTotal', () => {
  const r = calculateModelProbability(strongTeam(), MODEL_VERSION);
  const { factors: f } = r;
  const computed = f.base + f.winPctAdj + f.pitcherAdj + f.bullpenAdj
    + f.opsAdj + f.formAdj + f.homeAdj + f.injuryAdj + f.weatherAdj;
  if (Math.abs(computed - f.rawTotal) > 0.0001) {
    throw new Error(`factors sum ${computed} !== rawTotal ${f.rawTotal}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`mlbStatsModel.adapter — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
