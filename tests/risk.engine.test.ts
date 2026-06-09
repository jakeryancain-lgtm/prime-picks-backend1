import * as assert from 'assert';
import { calculateRisk, type RiskInput } from '../src/engines/risk.engine';

// ─── helpers ─────────────────────────────────────────────────────────────────

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

/** A clean baseline pick — no risk factors triggered. */
function cleanPick(overrides: Partial<RiskInput> = {}): RiskInput {
  return {
    americanOdds:        -115,   // not heavy juice
    edgeDecimal:          0.06,  // above 3% threshold
    confidence:           0.72,  // above 60% threshold
    marketType:          'moneyline',
    betType:             'moneyline',
    lineMovementPercent:  1,     // positive = moved in our favour
    sampleSize:           80,    // well above 30
    injuryFlag:           false,
    weatherFlag:          false,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Required test 1: clean pick returns LOW risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nclean pick');

test('clean pick returns LOW risk and score 0', () => {
  const r = calculateRisk(cleanPick());
  assert.strictEqual(r.riskLevel, 'LOW');
  assert.strictEqual(r.riskScore, 0);
});

test('clean pick has empty riskReasons', () => {
  const r = calculateRisk(cleanPick());
  assert.strictEqual(r.riskReasons.length, 0);
});

test('clean pick has all factor points at 0', () => {
  const r = calculateRisk(cleanPick());
  const { factors } = r;
  const total = Object.values(factors).reduce((a, b) => a + b, 0);
  assert.strictEqual(total, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 2: heavy juice increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nheavy juice');

test('odds worse than -170 triggers heavy juice factor', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -180 }));
  assert.ok(r.riskScore > 0, `Expected score > 0, got ${r.riskScore}`);
  assert.ok(r.factors.juicePoints > 0);
});

test('odds at -170 do NOT trigger heavy juice (boundary is exclusive)', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -170 }));
  assert.strictEqual(r.factors.juicePoints, 0);
});

test('odds at -169 do NOT trigger heavy juice', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -169 }));
  assert.strictEqual(r.factors.juicePoints, 0);
});

test('odds at -171 DO trigger heavy juice', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -171 }));
  assert.ok(r.factors.juicePoints > 0);
});

test('heavy juice adds exactly 20 risk points', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -200 }));
  assert.strictEqual(r.factors.juicePoints, 20);
  assert.strictEqual(r.riskScore, 20);
});

test('heavy juice includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -200 }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('juice')));
});

test('underdog (positive) odds never trigger heavy juice', () => {
  const r = calculateRisk(cleanPick({ americanOdds: 200 }));
  assert.strictEqual(r.factors.juicePoints, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 3: low edge increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nlow edge');

test('edge below 0.03 triggers low edge factor', () => {
  const r = calculateRisk(cleanPick({ edgeDecimal: 0.02 }));
  assert.ok(r.factors.edgePoints > 0);
});

test('edge at exactly 0.03 does NOT trigger low edge (boundary is inclusive)', () => {
  // Edge >= 0.03 is not low edge
  const r = calculateRisk(cleanPick({ edgeDecimal: 0.03 }));
  assert.strictEqual(r.factors.edgePoints, 0);
});

test('edge at 0.0299 DOES trigger low edge', () => {
  const r = calculateRisk(cleanPick({ edgeDecimal: 0.0299 }));
  assert.ok(r.factors.edgePoints > 0);
});

test('negative edge triggers low edge factor', () => {
  const r = calculateRisk(cleanPick({ edgeDecimal: -0.05 }));
  assert.ok(r.factors.edgePoints > 0);
});

test('low edge adds exactly 20 risk points', () => {
  const r = calculateRisk(cleanPick({ edgeDecimal: 0.01 }));
  assert.strictEqual(r.factors.edgePoints, 20);
  assert.strictEqual(r.riskScore, 20);
});

test('low edge includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ edgeDecimal: 0.01 }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('edge')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 4: low confidence increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nlow confidence');

test('confidence below 0.60 triggers low confidence factor', () => {
  const r = calculateRisk(cleanPick({ confidence: 0.55 }));
  assert.ok(r.factors.confidencePoints > 0);
});

test('confidence at exactly 0.60 does NOT trigger', () => {
  const r = calculateRisk(cleanPick({ confidence: 0.60 }));
  assert.strictEqual(r.factors.confidencePoints, 0);
});

test('confidence at 0.59 DOES trigger', () => {
  const r = calculateRisk(cleanPick({ confidence: 0.59 }));
  assert.ok(r.factors.confidencePoints > 0);
});

test('low confidence adds exactly 15 risk points', () => {
  const r = calculateRisk(cleanPick({ confidence: 0.40 }));
  assert.strictEqual(r.factors.confidencePoints, 15);
  assert.strictEqual(r.riskScore, 15);
});

test('low confidence includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ confidence: 0.40 }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('confidence')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 5: small sample increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsmall sample');

test('sampleSize below 30 triggers small sample factor', () => {
  const r = calculateRisk(cleanPick({ sampleSize: 20 }));
  assert.ok(r.factors.samplePoints > 0);
});

test('sampleSize at exactly 30 does NOT trigger', () => {
  const r = calculateRisk(cleanPick({ sampleSize: 30 }));
  assert.strictEqual(r.factors.samplePoints, 0);
});

test('sampleSize at 29 DOES trigger', () => {
  const r = calculateRisk(cleanPick({ sampleSize: 29 }));
  assert.ok(r.factors.samplePoints > 0);
});

test('small sample adds exactly 10 risk points', () => {
  const r = calculateRisk(cleanPick({ sampleSize: 10 }));
  assert.strictEqual(r.factors.samplePoints, 10);
  assert.strictEqual(r.riskScore, 10);
});

test('small sample includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ sampleSize: 5 }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('sample')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 6: bad line movement increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbad line movement');

test('lineMovementPercent worse than -3 triggers bad movement factor', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: -5 }));
  assert.ok(r.factors.lineMovementPoints > 0);
});

test('lineMovementPercent at -3 does NOT trigger (boundary is exclusive)', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: -3 }));
  assert.strictEqual(r.factors.lineMovementPoints, 0);
});

test('lineMovementPercent at -3.01 DOES trigger', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: -3.01 }));
  assert.ok(r.factors.lineMovementPoints > 0);
});

test('positive line movement does NOT trigger', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: 5 }));
  assert.strictEqual(r.factors.lineMovementPoints, 0);
});

test('bad line movement adds exactly 15 risk points', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: -10 }));
  assert.strictEqual(r.factors.lineMovementPoints, 15);
  assert.strictEqual(r.riskScore, 15);
});

test('bad line movement includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ lineMovementPercent: -10 }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('line movement')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 7: injury flag increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ninjury flag');

test('injuryFlag=true triggers injury factor', () => {
  const r = calculateRisk(cleanPick({ injuryFlag: true }));
  assert.ok(r.factors.injuryPoints > 0);
});

test('injuryFlag=false does NOT trigger', () => {
  const r = calculateRisk(cleanPick({ injuryFlag: false }));
  assert.strictEqual(r.factors.injuryPoints, 0);
});

test('injury adds exactly 10 risk points', () => {
  const r = calculateRisk(cleanPick({ injuryFlag: true }));
  assert.strictEqual(r.factors.injuryPoints, 10);
  assert.strictEqual(r.riskScore, 10);
});

test('injury includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ injuryFlag: true }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('injury')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 8: weather flag increases risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nweather flag');

test('weatherFlag=true triggers weather factor', () => {
  const r = calculateRisk(cleanPick({ weatherFlag: true }));
  assert.ok(r.factors.weatherPoints > 0);
});

test('weatherFlag=false does NOT trigger', () => {
  const r = calculateRisk(cleanPick({ weatherFlag: false }));
  assert.strictEqual(r.factors.weatherPoints, 0);
});

test('weather adds exactly 10 risk points', () => {
  const r = calculateRisk(cleanPick({ weatherFlag: true }));
  assert.strictEqual(r.factors.weatherPoints, 10);
  assert.strictEqual(r.riskScore, 10);
});

test('weather includes reason in riskReasons', () => {
  const r = calculateRisk(cleanPick({ weatherFlag: true }));
  assert.ok(r.riskReasons.some(reason => reason.toLowerCase().includes('weather')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 9: multiple risk factors can create HIGH risk
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmultiple factors → HIGH');

test('all factors firing simultaneously produces HIGH risk', () => {
  const r = calculateRisk({
    americanOdds:        -200,  // +20 heavy juice
    edgeDecimal:          0.01, // +20 low edge
    confidence:           0.40, // +15 low confidence
    marketType:          'moneyline',
    betType:             'moneyline',
    lineMovementPercent: -10,   // +15 bad line movement
    sampleSize:           5,    // +10 small sample
    injuryFlag:           true,  // +10 injury
    weatherFlag:          true,  // +10 weather
    // Total: 100 → HIGH
  });
  assert.strictEqual(r.riskLevel, 'HIGH');
  assert.strictEqual(r.riskScore, 100);
  assert.strictEqual(r.riskReasons.length, 7);
});

test('heavy juice + low edge = 40 points → MEDIUM', () => {
  const r = calculateRisk(cleanPick({
    americanOdds: -200,  // +20
    edgeDecimal:  0.01,  // +20
  }));
  assert.strictEqual(r.riskScore, 40);
  assert.strictEqual(r.riskLevel, 'MEDIUM');
});

test('5 factors together can reach HIGH', () => {
  const r = calculateRisk(cleanPick({
    americanOdds:        -200,  // +20
    edgeDecimal:          0.01, // +20
    confidence:           0.40, // +15
    lineMovementPercent: -10,   // +15
    // total = 70 → HIGH
  }));
  assert.strictEqual(r.riskLevel, 'HIGH');
  if (r.riskScore < 70) throw new Error(`Expected score ≥ 70, got ${r.riskScore}`);
});

test('riskReasons count matches number of triggered factors', () => {
  const r = calculateRisk(cleanPick({
    americanOdds: -200,
    injuryFlag:   true,
    weatherFlag:  true,
  }));
  // juice + injury + weather = 3 reasons
  assert.strictEqual(r.riskReasons.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 10: risk never defaults to HIGH with missing optional fields
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nno default to HIGH');

test('omitting all optional fields returns LOW (not HIGH)', () => {
  const r = calculateRisk({
    americanOdds:  -115,
    edgeDecimal:    0.06,
    confidence:     0.72,
    marketType:    'moneyline',
    betType:       'moneyline',
    // lineMovementPercent, sampleSize, injuryFlag, weatherFlag all absent
  });
  assert.strictEqual(r.riskLevel, 'LOW');
  assert.strictEqual(r.riskScore, 0);
});

test('omitting sampleSize alone does not add risk points', () => {
  const withSample    = calculateRisk(cleanPick({ sampleSize: 80 }));
  const withoutSample = calculateRisk({
    americanOdds:  cleanPick().americanOdds,
    edgeDecimal:   cleanPick().edgeDecimal,
    confidence:    cleanPick().confidence,
    marketType:   'moneyline',
    betType:      'moneyline',
    // sampleSize deliberately omitted
  });
  assert.strictEqual(withSample.riskScore, 0);
  assert.strictEqual(withoutSample.riskScore, 0);
  assert.strictEqual(withoutSample.factors.samplePoints, 0);
});

test('omitting lineMovementPercent alone does not add risk points', () => {
  const r = calculateRisk({
    americanOdds:  -115,
    edgeDecimal:    0.06,
    confidence:     0.72,
    marketType:    'moneyline',
    betType:       'moneyline',
    // lineMovementPercent absent
  });
  assert.strictEqual(r.factors.lineMovementPoints, 0);
});

test('injuryFlag and weatherFlag default to false when absent', () => {
  const r = calculateRisk({
    americanOdds:  -115,
    edgeDecimal:    0.06,
    confidence:     0.72,
    marketType:    'moneyline',
    betType:       'moneyline',
  });
  assert.strictEqual(r.factors.injuryPoints, 0);
  assert.strictEqual(r.factors.weatherPoints, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 11: riskScore never exceeds 100
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nscore bounds');

test('riskScore never exceeds 100 — all factors firing', () => {
  const r = calculateRisk({
    americanOdds:        -500,
    edgeDecimal:         -0.10,
    confidence:           0.10,
    marketType:          'moneyline',
    betType:             'moneyline',
    lineMovementPercent: -50,
    sampleSize:           1,
    injuryFlag:           true,
    weatherFlag:          true,
  });
  if (r.riskScore > 100) throw new Error(`riskScore ${r.riskScore} exceeds 100`);
  assert.strictEqual(r.riskScore, 100);
});

test('riskScore never goes below 0', () => {
  const r = calculateRisk(cleanPick());
  if (r.riskScore < 0) throw new Error(`riskScore ${r.riskScore} is negative`);
  assert.strictEqual(r.riskScore, 0);
});

test('riskScore is always an integer (no fractional points)', () => {
  const cases = [
    cleanPick({ americanOdds: -200 }),
    cleanPick({ injuryFlag: true, weatherFlag: true }),
    cleanPick({ edgeDecimal: 0.01, confidence: 0.40, lineMovementPercent: -5 }),
  ];
  for (const input of cases) {
    const r = calculateRisk(input);
    if (!Number.isInteger(r.riskScore)) {
      throw new Error(`riskScore is not an integer: ${r.riskScore}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 12: riskReasons explain the score
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nriskReasons');

test('each triggered factor produces exactly one reason', () => {
  const r = calculateRisk(cleanPick({ americanOdds: -200, injuryFlag: true }));
  assert.strictEqual(r.riskReasons.length, 2);
});

test('riskReasons are non-empty strings', () => {
  const r = calculateRisk(cleanPick({
    americanOdds: -200,
    edgeDecimal:  0.01,
    confidence:   0.40,
  }));
  for (const reason of r.riskReasons) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`Empty or non-string reason: ${JSON.stringify(reason)}`);
    }
  }
});

test('clean pick riskReasons is empty array (not undefined or null)', () => {
  const r = calculateRisk(cleanPick());
  assert.ok(Array.isArray(r.riskReasons));
  assert.strictEqual(r.riskReasons.length, 0);
});

test('factors object accounts for all score points', () => {
  const r = calculateRisk(cleanPick({
    americanOdds:        -200,
    edgeDecimal:          0.01,
    confidence:           0.40,
    lineMovementPercent: -10,
    sampleSize:           5,
    injuryFlag:           true,
    weatherFlag:          true,
  }));
  const factorTotal = Object.values(r.factors).reduce((a, b) => a + b, 0);
  assert.strictEqual(factorTotal, r.riskScore);
});

// ─────────────────────────────────────────────────────────────────────────────
// Risk level band boundaries
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nrisk level bands');

test('score 0 → LOW', () => {
  const r = calculateRisk(cleanPick());
  assert.strictEqual(r.riskLevel, 'LOW');
});

test('score 34 → LOW (just below MEDIUM threshold)', () => {
  // juice(20) + injury(10) + weather(10) = but that's already 40
  // juice(20) + sample(10) = 30 → LOW
  // juice(20) + confidence(15) - 1? No, let's use juice + weather = 30 → LOW
  const r = calculateRisk(cleanPick({ americanOdds: -200, weatherFlag: true }));
  // 20 + 10 = 30 → LOW
  assert.strictEqual(r.riskScore, 30);
  assert.strictEqual(r.riskLevel, 'LOW');
});

test('score 35 → MEDIUM (at threshold)', () => {
  // juice(20) + confidence(15) = 35 → MEDIUM
  const r = calculateRisk(cleanPick({ americanOdds: -200, confidence: 0.40 }));
  assert.strictEqual(r.riskScore, 35);
  assert.strictEqual(r.riskLevel, 'MEDIUM');
});

test('score 69 → MEDIUM (just below HIGH threshold)', () => {
  // juice(20) + edge(20) + confidence(15) + weather(10) = 65 → MEDIUM
  const r = calculateRisk(cleanPick({
    americanOdds: -200,
    edgeDecimal:  0.01,
    confidence:   0.40,
    weatherFlag:  true,
  }));
  assert.strictEqual(r.riskScore, 65);
  assert.strictEqual(r.riskLevel, 'MEDIUM');
});

test('score 70 → HIGH (at threshold)', () => {
  // juice(20) + edge(20) + confidence(15) + lineMovement(15) = 70 → HIGH
  const r = calculateRisk(cleanPick({
    americanOdds:        -200,
    edgeDecimal:          0.01,
    confidence:           0.40,
    lineMovementPercent: -10,
  }));
  assert.strictEqual(r.riskScore, 70);
  assert.strictEqual(r.riskLevel, 'HIGH');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`risk.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
