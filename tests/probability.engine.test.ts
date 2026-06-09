import * as assert from 'assert';
import {
  calculateRawProbability,
  calculateOverround,
  calculateNoVigProbability,
  calculateSingleSideProbability,
  calculateTwoSidedProbability,
} from '../src/engines/probability.engine';

// ─── helpers ─────────────────────────────────────────────────────────────────

function approx(a: number, b: number, tol = 0.0001): boolean {
  return Math.abs(a - b) <= tol;
}

function assertApprox(actual: number, expected: number, label: string, tol = 0.0001) {
  if (!approx(actual, expected, tol)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

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
// calculateRawProbability
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateRawProbability');

// Required test 1: -150 raw implied probability
test('-150 raw implied probability ≈ 0.6000', () => {
  // |−150| / (|−150| + 100) = 150 / 250 = 0.6000
  assertApprox(calculateRawProbability(-150), 0.6000, '-150 raw prob');
});

// Required test 2: +130 raw implied probability
test('+130 raw implied probability ≈ 0.4348', () => {
  // 100 / (130 + 100) = 100 / 230 ≈ 0.43478
  assertApprox(calculateRawProbability(130), 0.4348, '+130 raw prob');
});

test('-110 raw implied probability ≈ 0.5238', () => {
  assertApprox(calculateRawProbability(-110), 0.5238, '-110 raw prob');
});

test('+110 raw implied probability ≈ 0.4762', () => {
  // 100 / 210 ≈ 0.47619
  assertApprox(calculateRawProbability(110), 0.4762, '+110 raw prob');
});

test('-200 raw implied probability ≈ 0.6667', () => {
  assertApprox(calculateRawProbability(-200), 0.6667, '-200 raw prob');
});

test('+200 raw implied probability ≈ 0.3333', () => {
  assertApprox(calculateRawProbability(200), 0.3333, '+200 raw prob');
});

// Required test 5 (partial): invalid odds throw an error
test('invalid odds throw an error — 0', () => {
  assert.throws(() => calculateRawProbability(0), /Invalid American odds/);
});
test('invalid odds throw an error — +50', () => {
  assert.throws(() => calculateRawProbability(50), /Invalid American odds/);
});
test('invalid odds throw an error — -75', () => {
  assert.throws(() => calculateRawProbability(-75), /Invalid American odds/);
});
test('invalid odds throw an error — NaN', () => {
  assert.throws(() => calculateRawProbability(NaN), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateOverround
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateOverround');

test('-110 / -110 overround ≈ 1.0476 (standard US juice)', () => {
  // 0.52381 + 0.52381 = 1.04762
  assertApprox(calculateOverround(-110, -110), 1.0476, '-110/-110 overround');
});

test('-150 / +130 overround ≈ 1.0348', () => {
  // 0.6000 + 0.4348 = 1.0348
  assertApprox(calculateOverround(-150, 130), 1.0348, '-150/+130 overround');
});

test('even money -100 / +100 overround = 1.0 (zero vig market)', () => {
  // Both sides = 0.5 exactly, total = 1.0
  assertApprox(calculateOverround(-100, 100), 1.0, '-100/+100 overround', 0.001);
});

test('overround is always ≥ 1.0 for valid markets', () => {
  const markets: [number, number][] = [
    [-110, -110],
    [-150, 130],
    [-200, 170],
    [-120, 110],
    [100, -100],
  ];
  for (const [a, b] of markets) {
    const o = calculateOverround(a, b);
    if (o < 1.0) throw new Error(`${a}/${b} produced overround ${o} < 1.0`);
  }
});

test('overround reflects higher vig on juicier markets', () => {
  // -120/-120 has more vig than -110/-110
  const lowJuice = calculateOverround(-110, -110);
  const highJuice = calculateOverround(-120, -120);
  if (highJuice <= lowJuice) {
    throw new Error(`Expected -120/-120 (${highJuice}) > -110/-110 (${lowJuice})`);
  }
});

test('throws if side A odds are invalid', () => {
  assert.throws(() => calculateOverround(0, -110), /Invalid American odds/);
});

test('throws if side B odds are invalid', () => {
  assert.throws(() => calculateOverround(-110, 50), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateNoVigProbability
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateNoVigProbability');

// Required test 3: two-sided no-vig probabilities sum to 1
test('no-vig probabilities for both sides sum to 1.0 — -110/-110', () => {
  const both = calculateTwoSidedProbability(-110, -110);
  const sum = both.sideA.impliedProbability + both.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'sum of no-vig probs', 0.00001);
});

test('no-vig probabilities sum to 1.0 — -150/+130', () => {
  const both = calculateTwoSidedProbability(-150, 130);
  const sum = both.sideA.impliedProbability + both.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'sum -150/+130', 0.00001);
});

test('no-vig probabilities sum to 1.0 — -200/+170', () => {
  const both = calculateTwoSidedProbability(-200, 170);
  const sum = both.sideA.impliedProbability + both.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'sum -200/+170', 0.00001);
});

// Required test 4: no-vig favourite probability is lower than raw favourite probability
test('no-vig favourite probability is lower than raw favourite probability', () => {
  // Favourite = -150. Raw = 0.6000.
  // After vig removal the favourite's share must come down.
  const rawFav = calculateRawProbability(-150);
  const result = calculateNoVigProbability(-150, 130);
  if (result.impliedProbability >= rawFav) {
    throw new Error(
      `No-vig fav prob ${result.impliedProbability} should be < raw ${rawFav}`,
    );
  }
});

test('vig removal moves both sides toward each other in an asymmetric market', () => {
  // In a -150/+130 market the favourite carries more vig in absolute terms.
  // Normalization:
  //   raw(-150) = 0.6000,  raw(+130) = 0.4348,  overround = 1.0348
  //   noVig(-150) = 0.6000 / 1.0348 ≈ 0.5799  (lower than raw 0.6000) ✓
  //   noVig(+130) = 0.4348 / 1.0348 ≈ 0.4201  (lower than raw 0.4348)
  //
  // Both probabilities shift toward the favourite's direction after normalization
  // because the favourite's raw prob dominates the overround.
  // The invariant is: both raw probs decrease after vig removal in this market,
  // and their sum goes from 1.0348 → 1.0000.
  const both = calculateTwoSidedProbability(-150, 130);
  const rawFav = calculateRawProbability(-150);
  const rawDog = calculateRawProbability(130);

  // Favourite always decreases after normalization
  if (both.sideA.impliedProbability >= rawFav) {
    throw new Error(`Fav: no-vig ${both.sideA.impliedProbability} should be < raw ${rawFav}`);
  }
  // Both sides sum to 1 (the definitive invariant)
  const sum = both.sideA.impliedProbability + both.sideB.impliedProbability;
  if (Math.abs(sum - 1.0) > 0.00001) {
    throw new Error(`Sum should be 1.0, got ${sum}`);
  }
  // The underdog's no-vig prob is its correct fair-market share
  const expectedDog = rawDog / (rawFav + rawDog);
  if (Math.abs(both.sideB.impliedProbability - expectedDog) > 0.0001) {
    throw new Error(`Dog no-vig expected ${expectedDog}, got ${both.sideB.impliedProbability}`);
  }
});

test('-110/-110 no-vig both sides ≈ 0.5 (symmetric market)', () => {
  const both = calculateTwoSidedProbability(-110, -110);
  assertApprox(both.sideA.impliedProbability, 0.5, 'sideA -110/-110', 0.0001);
  assertApprox(both.sideB.impliedProbability, 0.5, 'sideB -110/-110', 0.0001);
});

test('vig field is correct for -110/-110', () => {
  const result = calculateNoVigProbability(-110, -110);
  // overround ≈ 1.0476, vig ≈ 0.0476
  assertApprox(result.vig, 0.0476, 'vig -110/-110', 0.001);
});

test('vig field is 0 for even money market -100/+100', () => {
  const result = calculateNoVigProbability(-100, 100);
  assertApprox(result.vig, 0, 'vig zero-juice market', 0.001);
});

test('method is "basic"', () => {
  const result = calculateNoVigProbability(-110, -110);
  assert.strictEqual(result.method, 'basic');
});

test('no-vig probability is between 0 and 1', () => {
  const markets: [number, number][] = [
    [-110, -110],
    [-150, 130],
    [-200, 170],
    [-300, 250],
    [110, -110],
  ];
  for (const [a, b] of markets) {
    const r = calculateNoVigProbability(a, b);
    if (r.impliedProbability <= 0 || r.impliedProbability >= 1) {
      throw new Error(`${a}/${b}: no-vig prob ${r.impliedProbability} not in (0,1)`);
    }
  }
});

// Required test 5 (continued): invalid odds throw in no-vig path
test('throws on invalid favourite odds', () => {
  assert.throws(() => calculateNoVigProbability(50, -110), /Invalid American odds/);
});
test('throws on invalid underdog odds', () => {
  assert.throws(() => calculateNoVigProbability(-110, 0), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateSingleSideProbability
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateSingleSideProbability');

// Required test 6: missing opposite side returns raw probability only
test('missing opposite side returns raw probability only — -150', () => {
  const result = calculateSingleSideProbability(-150);
  // Should equal raw prob, no vig removal applied
  assertApprox(result.impliedProbability, 0.6000, 'single-side -150');
});

test('missing opposite side returns raw probability only — +130', () => {
  const result = calculateSingleSideProbability(130);
  assertApprox(result.impliedProbability, 0.4348, 'single-side +130');
});

test('single-side vig is reported as 0 (unknown)', () => {
  const result = calculateSingleSideProbability(-110);
  assert.strictEqual(result.vig, 0);
});

test('single-side matches calculateRawProbability exactly', () => {
  const odds = [-110, -150, 130, 200, -200];
  for (const o of odds) {
    const single = calculateSingleSideProbability(o);
    const raw = calculateRawProbability(o);
    if (single.impliedProbability !== raw) {
      throw new Error(`${o}: single-side ${single.impliedProbability} !== raw ${raw}`);
    }
  }
});

test('single-side throws on invalid odds', () => {
  assert.throws(() => calculateSingleSideProbability(0), /Invalid American odds/);
  assert.throws(() => calculateSingleSideProbability(99), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateTwoSidedProbability — structure and invariants
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateTwoSidedProbability');

test('returns sideA, sideB, overround, vig fields', () => {
  const r = calculateTwoSidedProbability(-110, -110);
  assert.ok('sideA' in r, 'missing sideA');
  assert.ok('sideB' in r, 'missing sideB');
  assert.ok('overround' in r, 'missing overround');
  assert.ok('vig' in r, 'missing vig');
});

test('overround field equals sideA.vig + 1', () => {
  const r = calculateTwoSidedProbability(-150, 130);
  assertApprox(r.overround, r.vig + 1, 'overround === vig + 1', 0.00001);
});

test('both sides share the same vig value', () => {
  const r = calculateTwoSidedProbability(-150, 130);
  assert.strictEqual(r.sideA.vig, r.sideB.vig);
});

test('sideA and sideB method fields are both "basic"', () => {
  const r = calculateTwoSidedProbability(-150, 130);
  assert.strictEqual(r.sideA.method, 'basic');
  assert.strictEqual(r.sideB.method, 'basic');
});

test('run line market -110/+110 — both sides sum to 1', () => {
  const r = calculateTwoSidedProbability(-110, 110);
  const sum = r.sideA.impliedProbability + r.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'run line sum', 0.00001);
});

test('total market (over -115 / under -105) — both sides sum to 1', () => {
  const r = calculateTwoSidedProbability(-115, -105);
  const sum = r.sideA.impliedProbability + r.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'total market sum', 0.00001);
});

test('high-juice market (-300/+250) — sum still equals 1', () => {
  const r = calculateTwoSidedProbability(-300, 250);
  const sum = r.sideA.impliedProbability + r.sideB.impliedProbability;
  assertApprox(sum, 1.0, 'high-juice sum', 0.00001);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`probability.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
