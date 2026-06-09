import * as assert from 'assert';
import {
  runBacktest,
  summarizeBacktest,
  type BacktestInput,
} from '../src/services/backtesting.service';
import type { RawMLBPick } from '../src/mlbPipeline';

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

function approx(a: number, b: number, tol = 0.0001): boolean {
  return Math.abs(a - b) <= tol;
}

function assertApprox(actual: number, expected: number, label: string, tol = 0.0001) {
  if (!approx(actual, expected, tol)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake raw picks
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `pick-bt-${++seq}`; }

/**
 * Strong moneyline that qualifies: edge >> 3%, LOW risk, grade A+.
 * -115/+105 market, model=0.68 → no-vig implied ≈ 0.523, edge ≈ 0.157.
 */
function strongPick(overrides: Partial<RawMLBPick> = {}): RawMLBPick {
  return {
    id:                   uid(),
    modelVersionId:       'model-v1',
    gameId:               `game-${uid()}`,
    team:                 'NYY',
    opponent:             'BOS',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -115,
    oppositeAmericanOdds: 105,
    modelProbability:     0.68,
    confidence:           0.80,
    oddsQuality:          0.85,
    sampleSize:           100,
    ...overrides,
  };
}

/**
 * Low-edge pick that fails EDGE_TOO_LOW.
 * -115/+105, model=0.535 → edge ≈ 0.012 < 0.03.
 */
function lowEdgePick(overrides: Partial<RawMLBPick> = {}): RawMLBPick {
  return {
    id:                   uid(),
    modelVersionId:       'model-v1',
    gameId:               `game-${uid()}`,
    team:                 'ATL',
    opponent:             'PHI',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -115,
    oppositeAmericanOdds: 105,
    modelProbability:     0.535,
    confidence:           0.65,
    ...overrides,
  };
}

/**
 * No-odds pick that goes to noOddsPicks.
 */
function noOddsPick(overrides: Partial<RawMLBPick> = {}): RawMLBPick {
  return {
    id:             uid(),
    modelVersionId: 'model-v1',
    gameId:         `game-${uid()}`,
    team:           'MIL',
    opponent:       'CHC',
    betType:        'moneyline',
    marketType:     'moneyline',
    americanOdds:   null,
    modelProbability: 0.60,
    confidence:     0.70,
    ...overrides,
  };
}

/**
 * +1.5 run line that fails EXCLUDED_RUN_LINE.
 */
function runLinePlusPick(overrides: Partial<RawMLBPick> = {}): RawMLBPick {
  return {
    id:                   uid(),
    modelVersionId:       'model-v1',
    gameId:               `game-${uid()}`,
    team:                 'LAD',
    opponent:             'SF',
    betType:              'run_line',
    marketType:           'run_line',
    americanOdds:         -105,
    oppositeAmericanOdds: -115,
    modelProbability:     0.58,
    confidence:           0.72,
    runLineSpread:        1.5,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a basic backtest input
// ─────────────────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<BacktestInput> = {}): BacktestInput {
  const p1 = strongPick();
  const p2 = strongPick({ team: 'HOU' });
  return {
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'LOSS' },
    stake:            1,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Required test 1: backtest runs full pipeline
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npipeline integration');

test('runBacktest returns a result with expected top-level keys', () => {
  const result = runBacktest(makeInput());
  assert.ok('modelVersionId'    in result);
  assert.ok('all'               in result);
  assert.ok('topPicks'          in result);
  assert.ok('settledDetails'    in result);
  assert.ok('allProcessedPicks' in result);
});

test('modelVersionId is echoed back in result', () => {
  const result = runBacktest(makeInput({ modelVersionId: 'test-v99' }));
  assert.strictEqual(result.modelVersionId, 'test-v99');
});

test('totalPredictions matches number of input picks', () => {
  const picks = [strongPick(), strongPick(), lowEdgePick(), noOddsPick()];
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         picks,
    outcomesByPickId: {},
  });
  assert.strictEqual(result.all.totalPredictions, picks.length);
});

test('allProcessedPicks length equals input picks length', () => {
  const picks = [strongPick(), strongPick(), noOddsPick()];
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         picks,
    outcomesByPickId: {},
  });
  assert.strictEqual(result.allProcessedPicks.length, picks.length);
});

test('totalQualified only counts QUALIFIED picks', () => {
  const p1 = strongPick();
  const p2 = lowEdgePick();
  const p3 = noOddsPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2, p3],
    outcomesByPickId: {},
  });
  // p1 qualifies, p2 fails EDGE_TOO_LOW, p3 is NO_ODDS
  assert.strictEqual(result.all.totalQualified, 1);
  assert.strictEqual(result.all.totalPredictions, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 2: calculates wins/losses/pushes
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nwins / losses / pushes');

test('counts wins, losses, and pushes correctly', () => {
  const win   = strongPick({ team: 'A', gameId: 'g-a' });
  const loss  = strongPick({ team: 'B', gameId: 'g-b' });
  const push  = strongPick({ team: 'C', gameId: 'g-c' });
  const result = runBacktest({
    modelVersionId: 'model-v1',
    rawPicks:       [win, loss, push],
    outcomesByPickId: {
      [win.id]:  'WIN',
      [loss.id]: 'LOSS',
      [push.id]: 'PUSH',
    },
    stake: 1,
  });
  assert.strictEqual(result.all.wins,   1);
  assert.strictEqual(result.all.losses, 1);
  assert.strictEqual(result.all.pushes, 1);
});

test('totalSettled equals number of picks with outcomes', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2' });
  const p3 = strongPick({ gameId: 'g3' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2, p3],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'LOSS' },
    // p3 has no outcome
  });
  assert.strictEqual(result.all.totalSettled, 2);
});

test('picks without outcomes are not settled', () => {
  const p1 = strongPick();
  const p2 = strongPick({ team: 'HOU', gameId: 'g-hou' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN' },
  });
  assert.strictEqual(result.all.totalSettled, 1);
  assert.strictEqual(result.all.wins,         1);
  assert.strictEqual(result.all.losses,       0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 3: calculates profit/loss
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nprofit/loss');

test('WIN at -115 on 1 unit stake adds ≈ 0.8696 to profit', () => {
  const p = strongPick({ americanOdds: -115, oppositeAmericanOdds: 105 });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
    stake:            1,
  });
  // -115 WIN: 100/115 ≈ 0.8696
  assertApprox(result.all.profitLoss, 0.8696, 'WIN -115 profit', 0.001);
});

test('LOSS on 1 unit stake results in -1 profitLoss', () => {
  const p = strongPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'LOSS' },
    stake:            1,
  });
  assertApprox(result.all.profitLoss, -1.0, 'LOSS profit');
});

test('PUSH contributes 0 to profit/loss', () => {
  const p = strongPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'PUSH' },
    stake:            1,
  });
  assertApprox(result.all.profitLoss, 0, 'PUSH profit');
});

test('profit/loss accumulates correctly across multiple picks', () => {
  const win  = strongPick({ americanOdds: -115, gameId: 'g-w' });
  const loss = strongPick({ americanOdds: -115, gameId: 'g-l', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [win, loss],
    outcomesByPickId: { [win.id]: 'WIN', [loss.id]: 'LOSS' },
    stake:            1,
  });
  // WIN: +0.8696, LOSS: -1.0 → net ≈ -0.1304
  assertApprox(result.all.profitLoss, 0.8696 - 1.0, 'net profit', 0.01);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 4: calculates ROI
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nROI');

test('ROI = profitLoss / (totalSettled * stake)', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
    stake:            1,
  });
  const expected = result.all.profitLoss / (result.all.totalSettled * 1);
  assertApprox(result.all.roi, expected, 'ROI formula');
});

test('ROI with 2 unit stake is scaled correctly', () => {
  const p = strongPick({ americanOdds: 150, oppositeAmericanOdds: -165 });
  const result1 = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
    stake:            1,
  });
  const p2 = strongPick({ id: p.id + '-2', americanOdds: 150, oppositeAmericanOdds: -165, gameId: p.gameId + '-2' });
  const result2 = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p2],
    outcomesByPickId: { [p2.id]: 'WIN' },
    stake:            2,
  });
  // ROI (%) should be identical regardless of stake size
  assertApprox(result1.all.roi, result2.all.roi, 'ROI stake-independent', 0.001);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 5: calculates win rate
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nwin rate');

test('win rate = wins / (wins + losses), pushes excluded', () => {
  const w1 = strongPick({ gameId: 'g1' });
  const w2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const l1 = strongPick({ gameId: 'g3', team: 'LAD' });
  const p1 = strongPick({ gameId: 'g4', team: 'MIA' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [w1, w2, l1, p1],
    outcomesByPickId: {
      [w1.id]: 'WIN', [w2.id]: 'WIN', [l1.id]: 'LOSS', [p1.id]: 'PUSH',
    },
  });
  // 2W / (2W + 1L) = 0.6667, push excluded
  assertApprox(result.all.winRate, 2 / 3, 'win rate');
  assert.strictEqual(result.all.wins,   2);
  assert.strictEqual(result.all.losses, 1);
  assert.strictEqual(result.all.pushes, 1);
});

test('win rate is 1.0 when all settled picks win', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
  });
  assertApprox(result.all.winRate, 1.0, 'all-win rate');
});

test('win rate is 0.0 when all settled picks lose', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1],
    outcomesByPickId: { [p1.id]: 'LOSS' },
  });
  assertApprox(result.all.winRate, 0.0, 'all-loss rate');
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 6: calculates avg CLV
// ─────────────────────────────────────────────────────────────────────────────

console.log('\navg CLV');

test('avgClv is average of all settled picks CLV values', () => {
  const p1 = strongPick({ gameId: 'g1', americanOdds: -115, oppositeAmericanOdds: 105 });
  const p2 = strongPick({ gameId: 'g2', americanOdds: -115, oppositeAmericanOdds: 105, team: 'HOU' });
  // Provide closing odds — when entry = closing, CLV ≈ 0
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'LOSS' },
    closingOddsByPickId: { [p1.id]: -110, [p2.id]: -120 },
  });
  const { settledDetails } = result;
  const expectedAvg = settledDetails.reduce((s, d) => s + d.clvDecimal, 0) / settledDetails.length;
  assertApprox(result.all.avgClv, expectedAvg, 'avgClv');
});

test('positive closing line shift produces positive CLV', () => {
  const p = strongPick({ americanOdds: -115, oppositeAmericanOdds: 105 });
  // Entry implied (no-vig) is roughly 0.523.
  // Closing -130 → raw implied ≈ 0.565 → CLV = 0.523 - 0.565 < 0 (moved against us)
  // Closing -105 → raw implied ≈ 0.512 → CLV = 0.523 - 0.512 > 0 (we beat close)
  const result = runBacktest({
    modelVersionId:       'model-v1',
    rawPicks:             [p],
    outcomesByPickId:     { [p.id]: 'WIN' },
    closingOddsByPickId:  { [p.id]: -105 },
  });
  assert.ok(result.all.avgClv > 0, `Expected positive CLV, got ${result.all.avgClv}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 7: groups ROI by edge tier
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroiByEdgeTier');

test('roiByEdgeTier groups settled picks by their edge tier', () => {
  const p = strongPick(); // strong pick → edge ≈ 15%, should be ELITE
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
  });
  const processed = result.allProcessedPicks.find(x => x.id === p.id)!;
  const tier = processed.edgeTier;
  assert.ok(tier in result.all.roiByEdgeTier, `tier ${tier} not found in roiByEdgeTier`);
  assert.strictEqual(result.all.roiByEdgeTier[tier]!.count, 1);
});

test('roiByEdgeTier count matches settled picks in each tier', () => {
  const p1 = strongPick({ gameId: 'g1' });        // ELITE edge
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' }); // ELITE edge
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
  });
  // Both should be in the same tier
  const tierCounts = Object.values(result.all.roiByEdgeTier).reduce((s, g) => s + g.count, 0);
  assert.strictEqual(tierCounts, result.all.totalSettled);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 8: groups ROI by bet type
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroiByBetType');

test('roiByBetType groups picks by betType', () => {
  const ml   = strongPick({ gameId: 'g1', betType: 'moneyline', marketType: 'moneyline' });
  const over = strongPick({ gameId: 'g2', team: 'HOU', betType: 'total_over', marketType: 'total' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [ml, over],
    outcomesByPickId: { [ml.id]: 'WIN', [over.id]: 'WIN' },
  });
  assert.ok('moneyline' in result.all.roiByBetType, 'moneyline key missing');
  assert.ok('total_over' in result.all.roiByBetType, 'total_over key missing');
});

test('roiByBetType count sums to totalSettled', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'LOSS' },
  });
  const total = Object.values(result.all.roiByBetType).reduce((s, g) => s + g.count, 0);
  assert.strictEqual(total, result.all.totalSettled);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 9: groups ROI by grade letter
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroiByGradeLetter');

test('roiByGradeLetter groups picks by grade letter', () => {
  const p = strongPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
  });
  const processed = result.allProcessedPicks.find(x => x.id === p.id)!;
  const grade = processed.gradeLetter;
  assert.ok(grade in result.all.roiByGradeLetter, `grade ${grade} not in roiByGradeLetter`);
  assert.strictEqual(result.all.roiByGradeLetter[grade]!.count, 1);
});

test('roiByGradeLetter count sums to totalSettled', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
  });
  const total = Object.values(result.all.roiByGradeLetter).reduce((s, g) => s + g.count, 0);
  assert.strictEqual(total, result.all.totalSettled);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 10: groups ROI by risk level
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nroiByRiskLevel');

test('roiByRiskLevel groups picks by riskLevel', () => {
  const p = strongPick(); // LOW risk
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
  });
  const processed = result.allProcessedPicks.find(x => x.id === p.id)!;
  const level = processed.riskLevel;
  assert.ok(level in result.all.roiByRiskLevel, `risk ${level} not in roiByRiskLevel`);
});

test('roiByRiskLevel count sums to totalSettled', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'LOSS' },
  });
  const total = Object.values(result.all.roiByRiskLevel).reduce((s, g) => s + g.count, 0);
  assert.strictEqual(total, result.all.totalSettled);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 11: no settled picks returns ROI 0
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nno settled picks');

test('ROI is 0 (not NaN) when no picks are settled', () => {
  const p = strongPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: {},
  });
  assert.strictEqual(result.all.totalSettled, 0);
  assert.strictEqual(result.all.roi,          0);
  assert.ok(!Number.isNaN(result.all.roi), 'ROI must not be NaN');
});

test('winRate is 0 (not NaN) when no picks are settled', () => {
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [strongPick()],
    outcomesByPickId: {},
  });
  assert.strictEqual(result.all.winRate, 0);
  assert.ok(!Number.isNaN(result.all.winRate), 'winRate must not be NaN');
});

test('avgClv is 0 (not NaN) when no picks are settled', () => {
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [strongPick()],
    outcomesByPickId: {},
  });
  assert.strictEqual(result.all.avgClv, 0);
  assert.ok(!Number.isNaN(result.all.avgClv), 'avgClv must not be NaN');
});

test('empty rawPicks returns all zeroes without crashing', () => {
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [],
    outcomesByPickId: {},
  });
  assert.strictEqual(result.all.totalPredictions, 0);
  assert.strictEqual(result.all.totalSettled,     0);
  assert.strictEqual(result.all.roi,              0);
  assert.ok(!Number.isNaN(result.all.roi));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 12: input picks are not mutated
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nimmutability');

test('input rawPicks array is not mutated', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const original = [p1, p2];
  const originalLength  = original.length;
  const originalIds     = original.map(p => p.id);
  const originalOdds    = original.map(p => p.americanOdds);

  runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         original,
    outcomesByPickId: { [p1.id]: 'WIN' },
  });

  assert.strictEqual(original.length, originalLength, 'array length changed');
  assert.deepStrictEqual(original.map(p => p.id), originalIds, 'ids changed');
  assert.deepStrictEqual(original.map(p => p.americanOdds), originalOdds, 'odds changed');
});

test('individual pick objects are not mutated by pipeline', () => {
  const p = strongPick();
  const originalModelProb = p.modelProbability;
  const originalOdds      = p.americanOdds;

  runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p],
    outcomesByPickId: { [p.id]: 'WIN' },
  });

  assert.strictEqual(p.modelProbability, originalModelProb, 'modelProbability mutated');
  assert.strictEqual(p.americanOdds,     originalOdds,      'americanOdds mutated');
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 13: topPicks metrics separate from all settled
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntopPicks separate metrics');

test('topPicks and all can have different settled counts', () => {
  // Use picks from different games so multiple make it into topPicks
  const p1 = strongPick({ gameId: 'game-001', gradeNumeric: 95 } as Partial<RawMLBPick>);
  const p2 = strongPick({ gameId: 'game-002', team: 'HOU' });
  // Add a pick that qualifies but won't be in top 5 (different game, lower grade)
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
  });
  // Both fields exist as separate objects
  assert.ok('all'      in result, 'missing all');
  assert.ok('topPicks' in result, 'missing topPicks');
  // totalTopPicks reported consistently
  assert.strictEqual(result.all.totalTopPicks, result.topPicks.totalTopPicks);
});

test('topPicks profitLoss is subset of all profitLoss', () => {
  const p1 = strongPick({ gameId: 'g1' });
  const p2 = strongPick({ gameId: 'g2', team: 'HOU' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [p1, p2],
    outcomesByPickId: { [p1.id]: 'WIN', [p2.id]: 'WIN' },
  });
  // Top picks profit should be ≤ all profit (subset or equal, never more)
  assert.ok(
    result.topPicks.profitLoss <= result.all.profitLoss + 0.001,
    `topPicks P/L ${result.topPicks.profitLoss} should be ≤ all P/L ${result.all.profitLoss}`,
  );
});

test('topPicks has its own separate win/loss/push counters', () => {
  const result = runBacktest(makeInput());
  assert.ok('wins'   in result.topPicks);
  assert.ok('losses' in result.topPicks);
  assert.ok('pushes' in result.topPicks);
  assert.ok('roi'    in result.topPicks);
  assert.ok('avgClv' in result.topPicks);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 14: failed picks stored but not in topPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfailed picks stored');

test('failed picks appear in allProcessedPicks', () => {
  const failPick = lowEdgePick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [failPick],
    outcomesByPickId: {},
  });
  const found = result.allProcessedPicks.find(p => p.id === failPick.id);
  assert.ok(found, 'failed pick not found in allProcessedPicks');
  assert.strictEqual(found!.status, 'FAILED_FILTER');
});

test('failed pick with outcome is settled but not in totalTopPicks', () => {
  const good  = strongPick({ gameId: 'g-good' });
  const fail  = lowEdgePick({ gameId: 'g-fail' });
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [good, fail],
    // Give both a WIN outcome — fail pick gets settled but should not be in topPicks
    outcomesByPickId: { [good.id]: 'WIN', [fail.id]: 'WIN' },
  });
  // topPicks.totalSettled should be just the good pick (1), not 2
  assert.ok(result.topPicks.totalSettled <= result.topPicks.totalTopPicks);
  // all.totalSettled includes the failed pick if it was settled
  assert.ok(result.all.totalSettled >= result.topPicks.totalSettled);
});

test('noOdds pick without odds cannot be settled', () => {
  const noOdds = noOddsPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [noOdds],
    // Try to give it an outcome — should be skipped because americanOdds is null
    outcomesByPickId: { [noOdds.id]: 'WIN' },
  });
  assert.strictEqual(result.all.totalSettled, 0);
});

test('+1.5 run line stored in allProcessedPicks as failed', () => {
  const rl = runLinePlusPick();
  const result = runBacktest({
    modelVersionId:   'model-v1',
    rawPicks:         [rl],
    outcomesByPickId: {},
  });
  const found = result.allProcessedPicks.find(p => p.id === rl.id);
  assert.ok(found, 'run line pick not in allProcessedPicks');
  assert.strictEqual(found!.failReason, 'EXCLUDED_RUN_LINE');
  assert.strictEqual(result.all.totalTopPicks, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// summarizeBacktest
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsummarizeBacktest');

test('summarizeBacktest returns a non-empty string', () => {
  const result  = runBacktest(makeInput());
  const summary = summarizeBacktest(result);
  assert.ok(typeof summary === 'string');
  assert.ok(summary.length > 0);
});

test('summarizeBacktest includes modelVersionId', () => {
  const result  = runBacktest(makeInput({ modelVersionId: 'my-model-42' }));
  const summary = summarizeBacktest(result);
  assert.ok(summary.includes('my-model-42'));
});

test('summarizeBacktest includes ROI and win rate information', () => {
  const result  = runBacktest(makeInput());
  const summary = summarizeBacktest(result);
  assert.ok(summary.includes('ROI'), 'ROI label missing');
  assert.ok(summary.includes('Win rate') || summary.includes('Win'), 'win rate missing');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`backtesting.service — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
