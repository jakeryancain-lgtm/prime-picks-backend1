import * as assert from 'assert';
import {
  settlePrediction,
  settleMany,
  calculateProfitLoss,
  type SettlementInput,
} from '../src/engines/settlement.engine';

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
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `pred-${++seq}`; }

function baseInput(overrides: Partial<SettlementInput> = {}): SettlementInput {
  return {
    predictionId:              uid(),
    americanOdds:              -110,
    closingOdds:               -115,
    stake:                     1,
    outcome:                   'WIN',
    originalImpliedProbability: 0.524,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateProfitLoss — isolated formula tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateProfitLoss');

// Required test 1: +150 win profit is 1.5 units on 1 unit stake
test('+150 WIN on 1 unit stake = 1.5 units profit', () => {
  assertApprox(calculateProfitLoss('WIN', 150, 1), 1.5, '+150 WIN profit');
});

test('+150 WIN on 2 unit stake = 3.0 units profit', () => {
  assertApprox(calculateProfitLoss('WIN', 150, 2), 3.0, '+150 WIN 2u');
});

test('+200 WIN on 1 unit stake = 2.0 units profit', () => {
  assertApprox(calculateProfitLoss('WIN', 200, 1), 2.0, '+200 WIN profit');
});

test('+100 WIN on 1 unit stake = 1.0 units profit (even money)', () => {
  assertApprox(calculateProfitLoss('WIN', 100, 1), 1.0, '+100 WIN profit');
});

// Required test 2: -150 win profit is 0.6667 units on 1 unit stake
test('-150 WIN on 1 unit stake ≈ 0.6667 units profit', () => {
  assertApprox(calculateProfitLoss('WIN', -150, 1), 0.6667, '-150 WIN profit');
});

test('-110 WIN on 1 unit stake ≈ 0.9091 units profit', () => {
  // 100 / 110 ≈ 0.9091
  assertApprox(calculateProfitLoss('WIN', -110, 1), 0.9091, '-110 WIN profit');
});

test('-200 WIN on 1 unit stake = 0.5 units profit', () => {
  assertApprox(calculateProfitLoss('WIN', -200, 1), 0.5, '-200 WIN profit');
});

// Required test 3: LOSS is -1 unit
test('LOSS on 1 unit stake = -1.0 units', () => {
  assertApprox(calculateProfitLoss('LOSS', -110, 1), -1.0, 'LOSS profit');
});

test('LOSS on 2.5 unit stake = -2.5 units', () => {
  assertApprox(calculateProfitLoss('LOSS', 150, 2.5), -2.5, 'LOSS 2.5u');
});

test('LOSS profit is always -stake regardless of odds', () => {
  const odds = [100, 150, 200, -100, -110, -150, -200];
  for (const o of odds) {
    const pl = calculateProfitLoss('LOSS', o, 1);
    if (!approx(pl, -1)) throw new Error(`LOSS at ${o}: expected -1, got ${pl}`);
  }
});

// Required test 4: PUSH is 0
test('PUSH on 1 unit stake = 0.0 profit', () => {
  assertApprox(calculateProfitLoss('PUSH', -110, 1), 0, 'PUSH profit');
});

test('PUSH profit is 0 regardless of stake or odds', () => {
  assert.strictEqual(calculateProfitLoss('PUSH', 150, 5), 0);
  assert.strictEqual(calculateProfitLoss('PUSH', -200, 10), 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// settlePrediction — full result shape
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsettlePrediction');

// Required test 5: ROI calculates correctly
test('ROI = profitLoss / stake (WIN at +150)', () => {
  const r = settlePrediction(baseInput({ americanOdds: 150, outcome: 'WIN', stake: 1 }));
  // profitLoss = 1.5, stake = 1 → ROI = 1.5
  assertApprox(r.roi, 1.5, 'ROI +150 WIN');
});

test('ROI = profitLoss / stake (WIN at -110)', () => {
  const r = settlePrediction(baseInput({ americanOdds: -110, outcome: 'WIN', stake: 1 }));
  // profitLoss ≈ 0.9091, stake = 1 → ROI ≈ 0.9091
  assertApprox(r.roi, 0.9091, 'ROI -110 WIN');
});

test('ROI for LOSS = -1.0 (on 1 unit stake)', () => {
  const r = settlePrediction(baseInput({ outcome: 'LOSS', stake: 1 }));
  assertApprox(r.roi, -1.0, 'ROI LOSS');
});

test('ROI for PUSH = 0', () => {
  const r = settlePrediction(baseInput({ outcome: 'PUSH' }));
  assertApprox(r.roi, 0, 'ROI PUSH');
});

test('ROI scales correctly with stake > 1', () => {
  const r = settlePrediction(baseInput({ americanOdds: 150, outcome: 'WIN', stake: 2 }));
  // profitLoss = 3.0, stake = 2 → ROI = 1.5 (same ratio as 1-unit)
  assertApprox(r.roi, 1.5, 'ROI stake scaling');
});

// Required test 6: closing implied probability calculates correctly
test('closingImpliedProbability is correct for -110 closing line', () => {
  const r = settlePrediction(baseInput({ closingOdds: -110 }));
  // 110 / (110 + 100) = 110/210 ≈ 0.5238
  assertApprox(r.closingImpliedProbability, 0.5238, 'closing prob -110');
});

test('closingImpliedProbability is correct for +150 closing line', () => {
  const r = settlePrediction(baseInput({ closingOdds: 150 }));
  // 100 / (150 + 100) = 100/250 = 0.4
  assertApprox(r.closingImpliedProbability, 0.4, 'closing prob +150');
});

test('closingImpliedProbability is correct for -200 closing line', () => {
  const r = settlePrediction(baseInput({ closingOdds: -200 }));
  // 200 / (200 + 100) = 200/300 ≈ 0.6667
  assertApprox(r.closingImpliedProbability, 0.6667, 'closing prob -200');
});

test('closingImpliedProbability is always between 0 and 1 exclusive', () => {
  const closingLines = [100, 110, 150, -100, -110, -150, -200, -300];
  for (const cl of closingLines) {
    const r = settlePrediction(baseInput({ closingOdds: cl }));
    if (r.closingImpliedProbability <= 0 || r.closingImpliedProbability >= 1) {
      throw new Error(`closingOdds ${cl}: prob ${r.closingImpliedProbability} out of (0,1)`);
    }
  }
});

// Required test 7: positive CLV detected
test('positive CLV: original prob > closing prob = we beat the line', () => {
  // We had implied 0.55 at entry; closing line implies only 0.52 → we got value
  const r = settlePrediction(baseInput({
    originalImpliedProbability: 0.55,
    closingOdds:               -110,  // closing implied ≈ 0.5238
  }));
  if (r.clvDecimal <= 0) {
    throw new Error(`Expected positive CLV, got ${r.clvDecimal}`);
  }
  assertApprox(r.clvDecimal, 0.55 - r.closingImpliedProbability, 'positive CLV value');
});

test('positive CLV is present when entry was better than close', () => {
  // Entry: raw implied from -110 ≈ 0.5238. Closing: -115 implies ≈ 0.5350
  // CLV = 0.5238 - 0.5350 = -0.0112 (negative, market moved against us)
  // Flip: entry 0.55, close -105 (≈ 0.5122) → CLV = 0.0378 positive
  const r = settlePrediction(baseInput({
    originalImpliedProbability: 0.55,
    closingOdds:               -105,  // ≈ 0.5122
  }));
  assert.ok(r.clvDecimal > 0, `Expected positive CLV, got ${r.clvDecimal}`);
});

// Required test 8: negative CLV detected
test('negative CLV: original prob < closing prob = line moved against us', () => {
  // We had entry implied 0.50; closing line -130 implies ≈ 0.5652 → market says we overpaid
  const r = settlePrediction(baseInput({
    originalImpliedProbability: 0.50,
    closingOdds:               -130,  // closing implied ≈ 0.5652
  }));
  if (r.clvDecimal >= 0) {
    throw new Error(`Expected negative CLV, got ${r.clvDecimal}`);
  }
});

test('zero CLV: original prob equals closing implied prob exactly', () => {
  // -110 raw implied = 110/210 ≈ 0.52381
  const closingOdds   = -110;
  const origProb      = 110 / 210;
  const r = settlePrediction(baseInput({
    originalImpliedProbability: origProb,
    closingOdds,
  }));
  assertApprox(r.clvDecimal, 0, 'zero CLV', 0.0001);
});

test('CLV formula: originalImpliedProbability - closingImpliedProbability', () => {
  const r = settlePrediction(baseInput({
    originalImpliedProbability: 0.54,
    closingOdds:               -115,
  }));
  const expected = 0.54 - r.closingImpliedProbability;
  assertApprox(r.clvDecimal, expected, 'CLV formula check', 0.00001);
});

// Result shape
test('settlePrediction returns all required fields', () => {
  const r = settlePrediction(baseInput());
  const fields = [
    'predictionId', 'result', 'stake', 'profitLoss',
    'roi', 'closingOdds', 'closingImpliedProbability', 'clvDecimal',
  ];
  for (const f of fields) {
    if (!(f in r)) throw new Error(`Missing field: ${f}`);
  }
});

test('predictionId is echoed back in result', () => {
  const input = baseInput({ predictionId: 'specific-pred-id' });
  const r     = settlePrediction(input);
  assert.strictEqual(r.predictionId, 'specific-pred-id');
});

test('result outcome is echoed back in result.result', () => {
  assert.strictEqual(settlePrediction(baseInput({ outcome: 'WIN'  })).result, 'WIN');
  assert.strictEqual(settlePrediction(baseInput({ outcome: 'LOSS' })).result, 'LOSS');
  assert.strictEqual(settlePrediction(baseInput({ outcome: 'PUSH' })).result, 'PUSH');
});

test('stake is echoed back in result', () => {
  const r = settlePrediction(baseInput({ stake: 2.5 }));
  assert.strictEqual(r.stake, 2.5);
});

// Required test 12: settlement does not modify pre-game grade fields
test('settlement result contains no pre-game grade fields', () => {
  const r = settlePrediction(baseInput());
  const preGameFields = ['gradeNumeric', 'gradeLetter', 'edgeDecimal', 'riskLevel', 'riskScore'];
  for (const f of preGameFields) {
    if (f in r) throw new Error(`Settlement result must not contain pre-game field: ${f}`);
  }
});

test('settlement result contains no pre-game probability fields', () => {
  const r = settlePrediction(baseInput());
  const engineFields = ['modelProbability', 'noVigProbability', 'edgeTier', 'confidence'];
  for (const f of engineFields) {
    if (f in r) throw new Error(`Settlement result must not contain engine field: ${f}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nvalidation');

// Required test 9: invalid stake throws
test('stake = 0 throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ stake: 0 })),
    /stake/,
  );
});

test('stake = -1 throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ stake: -1 })),
    /stake/,
  );
});

test('stake = NaN throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ stake: NaN })),
    /stake/,
  );
});

test('stake = Infinity throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ stake: Infinity })),
    /stake/,
  );
});

// Required test 10: invalid odds throw
test('invalid americanOdds (0) throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ americanOdds: 0 })),
    /americanOdds/,
  );
});

test('invalid americanOdds (+50) throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ americanOdds: 50 })),
    /americanOdds/,
  );
});

test('invalid closingOdds (0) throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ closingOdds: 0 })),
    /closingOdds/,
  );
});

test('invalid closingOdds (-75) throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ closingOdds: -75 })),
    /closingOdds/,
  );
});

test('originalImpliedProbability = 0 throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ originalImpliedProbability: 0 })),
    /originalImpliedProbability/,
  );
});

test('originalImpliedProbability = 1 throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ originalImpliedProbability: 1 })),
    /originalImpliedProbability/,
  );
});

test('blank predictionId throws', () => {
  assert.throws(
    () => settlePrediction(baseInput({ predictionId: '' })),
    /predictionId/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// settleMany — batch + duplicate guard
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsettleMany');

// Required test 11: duplicate prediction ids are rejected
test('duplicate predictionId in batch: second occurrence is skipped', () => {
  const id    = uid();
  const input = baseInput({ predictionId: id });
  const batch = [input, { ...input }]; // same id twice
  const r     = settleMany(batch);
  assert.strictEqual(r.settled.length,    1);
  assert.strictEqual(r.duplicates.length, 1);
  assert.strictEqual(r.duplicates[0],     id);
});

test('duplicate id: first occurrence is settled, not the second', () => {
  const id = uid();
  const first  = baseInput({ predictionId: id, outcome: 'WIN',  americanOdds: 150 });
  const second = baseInput({ predictionId: id, outcome: 'LOSS', americanOdds: 150 });
  const r      = settleMany([first, second]);
  assert.strictEqual(r.settled.length, 1);
  assert.strictEqual(r.settled[0]!.result, 'WIN');
});

test('triple duplicate: two in duplicates, one settled', () => {
  const id = uid();
  const r  = settleMany([
    baseInput({ predictionId: id }),
    baseInput({ predictionId: id }),
    baseInput({ predictionId: id }),
  ]);
  assert.strictEqual(r.settled.length,    1);
  assert.strictEqual(r.duplicates.length, 2);
});

test('unique ids in batch: all settled, none in duplicates', () => {
  const inputs = [baseInput(), baseInput(), baseInput()];
  const r      = settleMany(inputs);
  assert.strictEqual(r.settled.length,    3);
  assert.strictEqual(r.duplicates.length, 0);
  assert.strictEqual(r.errors.length,     0);
});

test('invalid input in batch goes to errors, not settled', () => {
  const good = baseInput();
  const bad  = baseInput({ stake: 0 });
  const r    = settleMany([good, bad]);
  assert.strictEqual(r.settled.length, 1);
  assert.strictEqual(r.errors.length,  1);
  assert.ok(r.errors[0]!.message.includes('stake'));
});

test('settleMany returns all three buckets: settled, duplicates, errors', () => {
  const r = settleMany([baseInput()]);
  assert.ok('settled'    in r);
  assert.ok('duplicates' in r);
  assert.ok('errors'     in r);
});

test('empty batch returns empty settled, duplicates, errors arrays', () => {
  const r = settleMany([]);
  assert.strictEqual(r.settled.length,    0);
  assert.strictEqual(r.duplicates.length, 0);
  assert.strictEqual(r.errors.length,     0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge cases and real-world scenarios
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nreal-world scenarios');

test('+300 underdog win: 3 units profit on 1 unit stake', () => {
  const r = settlePrediction(baseInput({
    americanOdds: 300, outcome: 'WIN', stake: 1,
    originalImpliedProbability: 0.45,
  }));
  assertApprox(r.profitLoss, 3.0, '+300 win profit');
  assertApprox(r.roi, 3.0, '+300 win ROI');
});

test('-400 heavy favourite win: 0.25 units profit on 1 unit stake', () => {
  const r = settlePrediction(baseInput({
    americanOdds: -400, outcome: 'WIN', stake: 1,
    closingOdds: -400,
    originalImpliedProbability: 0.78,
  }));
  // 100 / 400 = 0.25
  assertApprox(r.profitLoss, 0.25, '-400 win profit');
});

test('fractional stake: 0.5 unit WIN at +150 = 0.75 profit', () => {
  const r = settlePrediction(baseInput({
    americanOdds: 150, outcome: 'WIN', stake: 0.5,
    originalImpliedProbability: 0.45,
  }));
  assertApprox(r.profitLoss, 0.75, 'fractional stake');
});

test('profitLoss + stake equals total return on WIN', () => {
  // Total return = stake + profit (what you get back from sportsbook)
  const r = settlePrediction(baseInput({ americanOdds: 150, outcome: 'WIN', stake: 1 }));
  assertApprox(r.profitLoss + r.stake, 2.5, 'total return +150');
});

test('PUSH total return equals original stake (no gain, no loss)', () => {
  const r = settlePrediction(baseInput({ outcome: 'PUSH', stake: 2 }));
  assertApprox(r.profitLoss + r.stake, 2, 'PUSH total return');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`settlement.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
