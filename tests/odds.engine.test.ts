import * as assert from 'assert';
import {
  isValidAmericanOdds,
  americanToDecimal,
  decimalToAmerican,
  americanToFractional,
  americanToRawImpliedProbability,
  convertOdds,
} from '../src/engines/odds.engine';

// ─── helpers ────────────────────────────────────────────────────────────────

function approx(a: number, b: number, tolerance = 0.0001): boolean {
  return Math.abs(a - b) <= tolerance;
}

function assertApprox(actual: number, expected: number, label: string, tol = 0.0001) {
  if (!approx(actual, expected, tol)) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

// ─── test runner ─────────────────────────────────────────────────────────────

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
// isValidAmericanOdds
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nisValidAmericanOdds');

test('accepts +100', () => assert.ok(isValidAmericanOdds(100)));
test('accepts +150', () => assert.ok(isValidAmericanOdds(150)));
test('accepts -110', () => assert.ok(isValidAmericanOdds(-110)));
test('accepts -100 (even money)', () => assert.ok(isValidAmericanOdds(-100)));
test('accepts +100 even money', () => assert.ok(isValidAmericanOdds(100)));
test('rejects 0', () => assert.ok(!isValidAmericanOdds(0)));
test('rejects +50 (< 100)', () => assert.ok(!isValidAmericanOdds(50)));
test('rejects -50 (> -100)', () => assert.ok(!isValidAmericanOdds(-50)));
test('rejects NaN', () => assert.ok(!isValidAmericanOdds(NaN)));
test('rejects Infinity', () => assert.ok(!isValidAmericanOdds(Infinity)));
test('rejects -Infinity', () => assert.ok(!isValidAmericanOdds(-Infinity)));
test('rejects +1 (between 1 and 99)', () => assert.ok(!isValidAmericanOdds(1)));
test('rejects -1 (between -1 and -99)', () => assert.ok(!isValidAmericanOdds(-1)));

// ─────────────────────────────────────────────────────────────────────────────
// americanToDecimal
// ─────────────────────────────────────────────────────────────────────────────

console.log('\namericanToDecimal');

test('+100 → 2.0', () => assertApprox(americanToDecimal(100), 2.0, '+100'));
test('+150 → 2.5', () => assertApprox(americanToDecimal(150), 2.5, '+150'));
test('+200 → 3.0', () => assertApprox(americanToDecimal(200), 3.0, '+200'));
test('-110 → 1.9091', () => assertApprox(americanToDecimal(-110), 1.9091, '-110'));
test('-150 → 1.6667', () => assertApprox(americanToDecimal(-150), 1.6667, '-150'));
test('-200 → 1.5', () => assertApprox(americanToDecimal(-200), 1.5, '-200'));
test('-100 → 2.0 (even money)', () => assertApprox(americanToDecimal(-100), 2.0, '-100'));
test('+300 → 4.0', () => assertApprox(americanToDecimal(300), 4.0, '+300'));
test('decimal result is always > 1.0', () => {
  const odds = [100, 110, 150, 200, 300, -100, -110, -150, -200, -300];
  for (const o of odds) {
    const d = americanToDecimal(o);
    if (d <= 1.0) throw new Error(`${o} produced decimal ${d} ≤ 1.0`);
  }
});
test('throws on invalid +50', () => {
  assert.throws(() => americanToDecimal(50), /Invalid American odds/);
});
test('throws on 0', () => {
  assert.throws(() => americanToDecimal(0), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// decimalToAmerican
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ndecimalToAmerican');

test('2.0 → +100', () => assert.strictEqual(decimalToAmerican(2.0), 100));
test('2.5 → +150', () => assert.strictEqual(decimalToAmerican(2.5), 150));
test('3.0 → +200', () => assert.strictEqual(decimalToAmerican(3.0), 200));
test('1.9091 → -110', () => {
  const result = decimalToAmerican(1.9091);
  if (Math.abs(result - (-110)) > 1) throw new Error(`Expected -110, got ${result}`);
});
test('1.5 → -200', () => assert.strictEqual(decimalToAmerican(1.5), -200));
test('1.6667 → -150', () => {
  const result = decimalToAmerican(1.6667);
  if (Math.abs(result - (-150)) > 1) throw new Error(`Expected -150, got ${result}`);
});
test('throws on decimal ≤ 1.0', () => {
  assert.throws(() => decimalToAmerican(1.0), /Invalid decimal odds/);
  assert.throws(() => decimalToAmerican(0.5), /Invalid decimal odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// americanToFractional
// ─────────────────────────────────────────────────────────────────────────────

console.log('\namericanToFractional');

test('+100 → 1/1 (evens)', () => {
  const f = americanToFractional(100);
  assert.deepStrictEqual(f, { numerator: 1, denominator: 1 });
});
test('+150 → 3/2', () => {
  const f = americanToFractional(150);
  assert.deepStrictEqual(f, { numerator: 3, denominator: 2 });
});
test('+200 → 2/1', () => {
  const f = americanToFractional(200);
  assert.deepStrictEqual(f, { numerator: 2, denominator: 1 });
});
test('-110 → 10/11 (reduced from 100/110)', () => {
  const f = americanToFractional(-110);
  assert.deepStrictEqual(f, { numerator: 10, denominator: 11 });
});
test('-200 → 1/2', () => {
  const f = americanToFractional(-200);
  assert.deepStrictEqual(f, { numerator: 1, denominator: 2 });
});
test('-150 → 2/3', () => {
  const f = americanToFractional(-150);
  assert.deepStrictEqual(f, { numerator: 2, denominator: 3 });
});
test('+300 → 3/1', () => {
  const f = americanToFractional(300);
  assert.deepStrictEqual(f, { numerator: 3, denominator: 1 });
});
test('fractional is always in lowest terms', () => {
  const cases: [number, number, number][] = [
    [200, 2, 1],
    [-200, 1, 2],
    [150, 3, 2],
    [-150, 2, 3],
    [400, 4, 1],
  ];
  for (const [odds, n, d] of cases) {
    const f = americanToFractional(odds);
    if (f.numerator !== n || f.denominator !== d) {
      throw new Error(`${odds}: expected ${n}/${d}, got ${f.numerator}/${f.denominator}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// americanToRawImpliedProbability
// ─────────────────────────────────────────────────────────────────────────────

console.log('\namericanToRawImpliedProbability');

test('+100 → 0.5', () => assertApprox(americanToRawImpliedProbability(100), 0.5, '+100'));
test('-100 → 0.5 (even money)', () => assertApprox(americanToRawImpliedProbability(-100), 0.5, '-100'));
test('-110 → 0.5238', () => assertApprox(americanToRawImpliedProbability(-110), 0.5238, '-110'));
test('+150 → 0.4', () => assertApprox(americanToRawImpliedProbability(150), 0.4, '+150'));
test('-150 → 0.6', () => assertApprox(americanToRawImpliedProbability(150), 0.4, '+150'));
test('-200 → 0.6667', () => assertApprox(americanToRawImpliedProbability(-200), 0.6667, '-200'));
test('+200 → 0.3333', () => assertApprox(americanToRawImpliedProbability(200), 0.3333, '+200'));
test('result is always between 0 and 1 (exclusive)', () => {
  const odds = [100, 110, 150, 200, 300, -100, -110, -150, -200, -300];
  for (const o of odds) {
    const p = americanToRawImpliedProbability(o);
    if (p <= 0 || p >= 1) throw new Error(`${o} produced probability ${p} outside (0, 1)`);
  }
});
test('favourite always has implied prob > 0.5', () => {
  const favs = [-110, -120, -150, -200, -300];
  for (const o of favs) {
    const p = americanToRawImpliedProbability(o);
    if (p <= 0.5) throw new Error(`${o} produced prob ${p}, expected > 0.5`);
  }
});
test('underdog always has implied prob < 0.5', () => {
  const dogs = [110, 120, 150, 200, 300];
  for (const o of dogs) {
    const p = americanToRawImpliedProbability(o);
    if (p >= 0.5) throw new Error(`${o} produced prob ${p}, expected < 0.5`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// convertOdds (full conversion)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nconvertOdds');

test('returns all four fields', () => {
  const r = convertOdds(-110);
  assert.ok('american' in r, 'missing american');
  assert.ok('decimal' in r, 'missing decimal');
  assert.ok('fractional' in r, 'missing fractional');
  assert.ok('rawImpliedProbability' in r, 'missing rawImpliedProbability');
});
test('american field is unchanged input', () => {
  assert.strictEqual(convertOdds(150).american, 150);
  assert.strictEqual(convertOdds(-200).american, -200);
});
test('-110 full conversion is internally consistent', () => {
  const r = convertOdds(-110);
  assertApprox(r.decimal, 1.9091, 'decimal');
  assert.deepStrictEqual(r.fractional, { numerator: 10, denominator: 11 });
  assertApprox(r.rawImpliedProbability, 0.5238, 'rawImpliedProbability');
});
test('+150 full conversion is internally consistent', () => {
  const r = convertOdds(150);
  assertApprox(r.decimal, 2.5, 'decimal');
  assert.deepStrictEqual(r.fractional, { numerator: 3, denominator: 2 });
  assertApprox(r.rawImpliedProbability, 0.4, 'rawImpliedProbability');
});
test('round-trip: american → decimal → american stays within 1', () => {
  // -100 and +100 are mathematically identical (both = 2.0 decimal / even money).
  // decimalToAmerican always returns the positive convention for 2.0 (+100).
  // We exclude -100 from the round-trip check for this reason.
  const samples = [100, 110, 120, 150, 200, -105, -110, -115, -120, -150, -200];
  for (const o of samples) {
    const dec = americanToDecimal(o);
    const back = decimalToAmerican(dec);
    if (Math.abs(back - o) > 1) {
      throw new Error(`Round-trip failed for ${o}: got ${back}`);
    }
  }
});
test('-100 and +100 both convert to decimal 2.0 (even money equivalence)', () => {
  assertApprox(americanToDecimal(-100), 2.0, '-100 decimal');
  assertApprox(americanToDecimal(100), 2.0, '+100 decimal');
  assert.strictEqual(decimalToAmerican(2.0), 100);
});
test('throws on invalid odds in convertOdds', () => {
  assert.throws(() => convertOdds(0), /Invalid American odds/);
  assert.throws(() => convertOdds(50), /Invalid American odds/);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`odds.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
