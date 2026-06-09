import * as assert from 'assert';
import {
  calculateEdge,
  calculateDualEdge,
  getEdgeTier,
  DEFAULT_MIN_EDGE,
} from '../src/engines/edge.engine';

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
// getEdgeTier
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ngetEdgeTier');

test('edge < 0 → NEGATIVE', () => {
  assert.strictEqual(getEdgeTier(-0.01), 'NEGATIVE');
  assert.strictEqual(getEdgeTier(-0.5), 'NEGATIVE');
});
test('edge = 0.00 → LOW', () => {
  assert.strictEqual(getEdgeTier(0), 'LOW');
});
test('edge = 0.01 → LOW', () => {
  assert.strictEqual(getEdgeTier(0.01), 'LOW');
});
test('edge = 0.0199 → LOW', () => {
  assert.strictEqual(getEdgeTier(0.0199), 'LOW');
});
test('edge = 0.02 → MEDIUM', () => {
  assert.strictEqual(getEdgeTier(0.02), 'MEDIUM');
});
test('edge = 0.035 → MEDIUM', () => {
  assert.strictEqual(getEdgeTier(0.035), 'MEDIUM');
});
test('edge = 0.0399 → MEDIUM', () => {
  assert.strictEqual(getEdgeTier(0.0399), 'MEDIUM');
});
test('edge = 0.04 → HIGH', () => {
  assert.strictEqual(getEdgeTier(0.04), 'HIGH');
});
test('edge = 0.055 → HIGH', () => {
  assert.strictEqual(getEdgeTier(0.055), 'HIGH');
});
test('edge = 0.0699 → HIGH', () => {
  assert.strictEqual(getEdgeTier(0.0699), 'HIGH');
});

// Required test 7: ELITE tier
test('edge = 0.07 → ELITE', () => {
  assert.strictEqual(getEdgeTier(0.07), 'ELITE');
});
test('edge = 0.12 → ELITE', () => {
  assert.strictEqual(getEdgeTier(0.12), 'ELITE');
});
test('edge = 0.50 → ELITE', () => {
  assert.strictEqual(getEdgeTier(0.50), 'ELITE');
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateEdge — core formula
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateEdge — core formula');

// Required test 1: model 0.60 vs implied 0.55 = 0.05 edge
test('model 0.60 vs implied 0.55 = 0.05 edge', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.55 });
  assertApprox(r.edge, 0.05, 'edge');
  assertApprox(r.edgeDecimal, 0.05, 'edgeDecimal');
  assertApprox(r.edgePercent, 5.0, 'edgePercent');
});

test('edge decimal and edgeDecimal are always identical', () => {
  const r = calculateEdge({ modelProbability: 0.62, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.edge, r.edgeDecimal);
});

test('edgePercent = edge * 100', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.55 });
  assertApprox(r.edgePercent, r.edge * 100, 'edgePercent scaling');
});

// Required test 2: negative edge is detected
test('negative edge is detected — model 0.45 vs implied 0.52', () => {
  const r = calculateEdge({ modelProbability: 0.45, noVigImpliedProbability: 0.52 });
  assertApprox(r.edge, -0.07, 'negative edge');
  assert.strictEqual(r.hasPositiveEdge, false);
  assert.strictEqual(r.edgeTier, 'NEGATIVE');
});

test('zero edge has hasPositiveEdge = false', () => {
  const r = calculateEdge({ modelProbability: 0.55, noVigImpliedProbability: 0.55 });
  assertApprox(r.edge, 0, 'zero edge');
  assert.strictEqual(r.hasPositiveEdge, false);
});

test('positive edge has hasPositiveEdge = true', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.50 });
  assert.strictEqual(r.hasPositiveEdge, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// meetsMinimumEdge
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmeetsMinimumEdge');

// Required test 3: meetsMinimumEdge works at 3%
test('edge = 0.03 meets 3% minimum (exactly at boundary)', () => {
  // 0.58 - 0.55 = 0.02999...9 in IEEE 754 — genuinely below 0.03.
  // Use 0.553 - 0.523 = 0.030000...027 which is unambiguously >= 0.03.
  const r = calculateEdge({ modelProbability: 0.553, noVigImpliedProbability: 0.523 });
  assertApprox(r.edge, 0.03, 'edge at boundary');
  assert.strictEqual(r.meetsThreshold, true);
});

test('edge = 0.0299 does NOT meet 3% minimum', () => {
  const r = calculateEdge({ modelProbability: 0.5799, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.meetsThreshold, false);
});

// Required test 8: LOW tier does not meet 3% minimum
test('edge tier LOW (0.015) does not meet 3% minimum', () => {
  const r = calculateEdge({ modelProbability: 0.565, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.edgeTier, 'LOW');
  assert.strictEqual(r.meetsThreshold, false);
});

test('edge tier MEDIUM can be above OR below the 3% minimum', () => {
  // MEDIUM tier = 0.02 to 0.0399. The 3% threshold sits inside MEDIUM.
  // An edge of 0.025 is MEDIUM but does NOT meet the 3% minimum.
  // An edge of 0.035 is MEDIUM and DOES meet the 3% minimum.
  const belowThreshold = calculateEdge({ modelProbability: 0.575, noVigImpliedProbability: 0.55 });
  assert.strictEqual(belowThreshold.edgeTier, 'MEDIUM');
  assert.strictEqual(belowThreshold.meetsThreshold, false);

  const aboveThreshold = calculateEdge({ modelProbability: 0.553, noVigImpliedProbability: 0.518 });
  assert.strictEqual(aboveThreshold.edgeTier, 'MEDIUM');
  assert.strictEqual(aboveThreshold.meetsThreshold, true);
});

test('default threshold is 0.03', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.threshold, DEFAULT_MIN_EDGE);
  assert.strictEqual(r.threshold, 0.03);
});

test('custom threshold is respected', () => {
  // Edge = 0.05, custom threshold = 0.06 → should NOT meet
  const r = calculateEdge({
    modelProbability: 0.60,
    noVigImpliedProbability: 0.55,
    minEdgeThreshold: 0.06,
  });
  assert.strictEqual(r.threshold, 0.06);
  assert.strictEqual(r.meetsThreshold, false);
});

test('custom threshold 0.02 → edge 0.05 meets it', () => {
  const r = calculateEdge({
    modelProbability: 0.60,
    noVigImpliedProbability: 0.55,
    minEdgeThreshold: 0.02,
  });
  assert.strictEqual(r.meetsThreshold, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Probability source selection
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nprobability source selection');

// Required test 4: no-vig probability is preferred when provided
test('no-vig probability is preferred over raw when both provided', () => {
  const r = calculateEdge({
    modelProbability: 0.60,
    rawImpliedProbability: 0.54,   // raw (higher, vig-inflated)
    noVigImpliedProbability: 0.51, // no-vig (lower, correct)
  });
  // Should use no-vig → edge = 0.60 - 0.51 = 0.09
  assertApprox(r.edge, 0.09, 'edge using no-vig');
  assert.strictEqual(r.probabilitySource, 'no-vig');
  assert.strictEqual(r.impliedProbabilityUsed, 0.51);
});

test('raw probability is used as fallback when no-vig is absent', () => {
  const r = calculateEdge({
    modelProbability: 0.60,
    rawImpliedProbability: 0.54,
  });
  assertApprox(r.edge, 0.06, 'edge using raw');
  assert.strictEqual(r.probabilitySource, 'raw');
  assert.strictEqual(r.impliedProbabilityUsed, 0.54);
});

test('using raw vs no-vig gives different edge values for same market', () => {
  const withRaw = calculateEdge({ modelProbability: 0.60, rawImpliedProbability: 0.54 });
  const withNoVig = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.51 });
  if (withRaw.edge === withNoVig.edge) {
    throw new Error('Expected different edges for different implied probs');
  }
});

test('no-vig source: probabilitySource field is "no-vig"', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.51 });
  assert.strictEqual(r.probabilitySource, 'no-vig');
});

test('raw source: probabilitySource field is "raw"', () => {
  const r = calculateEdge({ modelProbability: 0.60, rawImpliedProbability: 0.54 });
  assert.strictEqual(r.probabilitySource, 'raw');
});

// ─────────────────────────────────────────────────────────────────────────────
// Validation — invalid inputs
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nvalidation');

// Required test 5: invalid model probability throws error
test('modelProbability = 0 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0, noVigImpliedProbability: 0.50 }),
    /Invalid modelProbability/,
  );
});
test('modelProbability = 1 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 1, noVigImpliedProbability: 0.50 }),
    /Invalid modelProbability/,
  );
});
test('modelProbability > 1 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 1.2, noVigImpliedProbability: 0.50 }),
    /Invalid modelProbability/,
  );
});
test('modelProbability < 0 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: -0.1, noVigImpliedProbability: 0.50 }),
    /Invalid modelProbability/,
  );
});
test('modelProbability = NaN throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: NaN, noVigImpliedProbability: 0.50 }),
    /Invalid modelProbability/,
  );
});

// Required test 6: invalid implied probability throws error
test('noVigImpliedProbability = 0 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0 }),
    /Invalid noVigImpliedProbability/,
  );
});
test('noVigImpliedProbability = 1 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 1 }),
    /Invalid noVigImpliedProbability/,
  );
});
test('rawImpliedProbability = 0 throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0.60, rawImpliedProbability: 0 }),
    /Invalid rawImpliedProbability/,
  );
});
test('rawImpliedProbability = NaN throws error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0.60, rawImpliedProbability: NaN }),
    /Invalid rawImpliedProbability/,
  );
});
test('neither probability provided throws descriptive error', () => {
  assert.throws(
    () => calculateEdge({ modelProbability: 0.60 }),
    /requires at least one of/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge tier boundary precision
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nedge tier boundaries');

test('exact boundary 0.02 is MEDIUM not LOW', () => {
  assert.strictEqual(getEdgeTier(0.02), 'MEDIUM');
});
test('exact boundary 0.04 is HIGH not MEDIUM', () => {
  assert.strictEqual(getEdgeTier(0.04), 'HIGH');
});
test('exact boundary 0.07 is ELITE not HIGH', () => {
  assert.strictEqual(getEdgeTier(0.07), 'ELITE');
});
test('0.0699 is HIGH (just below ELITE boundary)', () => {
  assert.strictEqual(getEdgeTier(0.0699), 'HIGH');
});
test('0.0700 is ELITE (at boundary)', () => {
  assert.strictEqual(getEdgeTier(0.0700), 'ELITE');
});

// ─────────────────────────────────────────────────────────────────────────────
// calculateDualEdge
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncalculateDualEdge');

test('returns noVig, raw, and vigImpact fields', () => {
  const r = calculateDualEdge(0.60, 0.54, 0.51);
  assert.ok('noVig' in r, 'missing noVig');
  assert.ok('raw' in r, 'missing raw');
  assert.ok('vigImpact' in r, 'missing vigImpact');
});

test('noVig edge is higher than raw edge when no-vig prob is lower', () => {
  // Lower implied probability → higher edge
  const r = calculateDualEdge(0.60, 0.54, 0.51);
  if (r.noVig.edge <= r.raw.edge) {
    throw new Error(`noVig edge ${r.noVig.edge} should be > raw edge ${r.raw.edge}`);
  }
});

test('vigImpact = noVig.edge - raw.edge', () => {
  const r = calculateDualEdge(0.60, 0.54, 0.51);
  const expected = r.noVig.edge - r.raw.edge;
  if (Math.abs(r.vigImpact - expected) > 0.00001) {
    throw new Error(`vigImpact ${r.vigImpact} !== ${expected}`);
  }
});

test('noVig source is "no-vig", raw source is "raw"', () => {
  const r = calculateDualEdge(0.60, 0.54, 0.51);
  assert.strictEqual(r.noVig.probabilitySource, 'no-vig');
  assert.strictEqual(r.raw.probabilitySource, 'raw');
});

// ─────────────────────────────────────────────────────────────────────────────
// Return shape completeness
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nreturn shape');

test('result contains all required fields', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.55 });
  const required = [
    'edge', 'edgeDecimal', 'edgePercent',
    'hasPositiveEdge', 'meetsThreshold', 'threshold',
    'edgeTier', 'probabilitySource', 'impliedProbabilityUsed',
    'modelProbability', 'impliedProbability',
  ];
  for (const field of required) {
    if (!(field in r)) throw new Error(`Missing field: ${field}`);
  }
});

test('impliedProbability and impliedProbabilityUsed are the same value', () => {
  const r = calculateEdge({ modelProbability: 0.60, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.impliedProbability, r.impliedProbabilityUsed);
});

test('modelProbability is echoed back correctly', () => {
  const r = calculateEdge({ modelProbability: 0.62, noVigImpliedProbability: 0.55 });
  assert.strictEqual(r.modelProbability, 0.62);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`edge.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
