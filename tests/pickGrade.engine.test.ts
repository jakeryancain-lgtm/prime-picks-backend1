import * as assert from 'assert';
import {
  gradePickPreGame,
  gradeLetterFromScore,
  type PickGradeInput,
} from '../src/engines/pickGrade.engine';

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

/** A strong baseline pick — good edge, high confidence, good odds, LOW risk. */
function strongPick(overrides: Partial<PickGradeInput> = {}): PickGradeInput {
  return {
    edgeDecimal:  0.08,
    confidence:   0.80,
    oddsQuality:  0.85,
    riskLevel:    'LOW',
    hasLiveOdds:  true,
    americanOdds: -115,
    ...overrides,
  };
}

/** A weak pick — near-zero edge, low confidence, mediocre odds, MEDIUM risk. */
function weakPick(overrides: Partial<PickGradeInput> = {}): PickGradeInput {
  return {
    edgeDecimal:  0.01,
    confidence:   0.40,
    oddsQuality:  0.35,
    riskLevel:    'MEDIUM',
    hasLiveOdds:  true,
    americanOdds: +150,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// NO_GRADE path
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nNO_GRADE path');

// Required test 1: no live odds returns grade 0 and NO_GRADE
test('hasLiveOdds=false returns gradeNumeric=0 and NO_GRADE', () => {
  const r = gradePickPreGame(strongPick({ hasLiveOdds: false }));
  assert.strictEqual(r.gradeNumeric, 0);
  assert.strictEqual(r.gradeLetter, 'NO_GRADE');
});

// Required test 2: null americanOdds returns grade 0 and NO_GRADE
test('americanOdds=null returns gradeNumeric=0 and NO_GRADE', () => {
  const r = gradePickPreGame(strongPick({ americanOdds: null }));
  assert.strictEqual(r.gradeNumeric, 0);
  assert.strictEqual(r.gradeLetter, 'NO_GRADE');
});

test('both hasLiveOdds=false AND americanOdds=null returns NO_GRADE', () => {
  const r = gradePickPreGame(strongPick({ hasLiveOdds: false, americanOdds: null }));
  assert.strictEqual(r.gradeNumeric, 0);
  assert.strictEqual(r.gradeLetter, 'NO_GRADE');
});

test('NO_GRADE result has all component scores at 0', () => {
  const r = gradePickPreGame(strongPick({ hasLiveOdds: false }));
  assert.strictEqual(r.components.edgeScore, 0);
  assert.strictEqual(r.components.confidenceScore, 0);
  assert.strictEqual(r.components.oddsQualityScore, 0);
  assert.strictEqual(r.components.riskAdjustment, 0);
  assert.strictEqual(r.baseScore, 0);
});

test('NO_GRADE ignores other strong inputs — grade stays 0', () => {
  const r = gradePickPreGame({
    edgeDecimal:  0.12,
    confidence:   1.0,
    oddsQuality:  1.0,
    riskLevel:    'LOW',
    hasLiveOdds:  false,  // forces NO_GRADE regardless
    americanOdds: -110,
  });
  assert.strictEqual(r.gradeNumeric, 0);
  assert.strictEqual(r.gradeLetter, 'NO_GRADE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Strong pick grading
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nstrong pick grading');

// Required test 3: strong edge/confidence/odds quality/LOW risk gets A or A+
test('strong pick with LOW risk grades A or A+', () => {
  const r = gradePickPreGame(strongPick());
  if (r.gradeLetter !== 'A+' && r.gradeLetter !== 'A') {
    throw new Error(`Expected A or A+, got ${r.gradeLetter} (score: ${r.gradeNumeric})`);
  }
  if (r.gradeNumeric < 80) {
    throw new Error(`Expected score ≥ 80, got ${r.gradeNumeric}`);
  }
});

test('elite edge pick gets A+', () => {
  const r = gradePickPreGame(strongPick({
    edgeDecimal: 0.12,
    confidence:  0.90,
    oddsQuality: 0.90,
    riskLevel:   'LOW',
  }));
  assert.strictEqual(r.gradeLetter, 'A+');
  if (r.gradeNumeric < 90) {
    throw new Error(`Expected score ≥ 90, got ${r.gradeNumeric}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Risk comparison
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nrisk comparison');

// Required test 4: same pick with HIGH risk grades lower than LOW risk
test('HIGH risk grades lower than LOW risk (same pick)', () => {
  const low  = gradePickPreGame(strongPick({ riskLevel: 'LOW' }));
  const high = gradePickPreGame(strongPick({ riskLevel: 'HIGH' }));
  if (high.gradeNumeric >= low.gradeNumeric) {
    throw new Error(
      `HIGH risk score ${high.gradeNumeric} should be < LOW risk score ${low.gradeNumeric}`,
    );
  }
});

// Required test 8: MEDIUM risk is neutral between LOW and HIGH
test('MEDIUM risk score is between LOW and HIGH risk scores', () => {
  const low    = gradePickPreGame(strongPick({ riskLevel: 'LOW' }));
  const medium = gradePickPreGame(strongPick({ riskLevel: 'MEDIUM' }));
  const high   = gradePickPreGame(strongPick({ riskLevel: 'HIGH' }));
  if (medium.gradeNumeric >= low.gradeNumeric) {
    throw new Error(
      `MEDIUM (${medium.gradeNumeric}) should be < LOW (${low.gradeNumeric})`,
    );
  }
  if (medium.gradeNumeric <= high.gradeNumeric) {
    throw new Error(
      `MEDIUM (${medium.gradeNumeric}) should be > HIGH (${high.gradeNumeric})`,
    );
  }
});

test('HIGH risk penalty reduces grade by a meaningful amount', () => {
  const low  = gradePickPreGame(strongPick({ riskLevel: 'LOW' }));
  const high = gradePickPreGame(strongPick({ riskLevel: 'HIGH' }));
  const diff = low.gradeNumeric - high.gradeNumeric;
  if (diff < 5) {
    throw new Error(`Risk difference too small (${diff}). Expected at least 5 points.`);
  }
});

test('LOW risk riskAdjustment component is positive', () => {
  const r = gradePickPreGame(strongPick({ riskLevel: 'LOW' }));
  if (r.components.riskAdjustment <= 0) {
    throw new Error(`Expected positive riskAdjustment for LOW risk, got ${r.components.riskAdjustment}`);
  }
});

test('MEDIUM risk riskAdjustment component is 0', () => {
  const r = gradePickPreGame(strongPick({ riskLevel: 'MEDIUM' }));
  assert.strictEqual(r.components.riskAdjustment, 0);
});

test('HIGH risk riskAdjustment component is negative', () => {
  const r = gradePickPreGame(strongPick({ riskLevel: 'HIGH' }));
  if (r.components.riskAdjustment >= 0) {
    throw new Error(`Expected negative riskAdjustment for HIGH risk, got ${r.components.riskAdjustment}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Weak pick grading
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nweak pick grading');

// Required test 5: weak edge gets low grade
test('weak edge pick grades D or F', () => {
  const r = gradePickPreGame(weakPick());
  if (r.gradeLetter !== 'D' && r.gradeLetter !== 'F') {
    throw new Error(`Expected D or F, got ${r.gradeLetter} (score: ${r.gradeNumeric})`);
  }
});

test('negative edge picks score low', () => {
  const r = gradePickPreGame(strongPick({ edgeDecimal: -0.05 }));
  if (r.gradeNumeric >= 60) {
    throw new Error(`Negative edge should score < 60, got ${r.gradeNumeric}`);
  }
});

test('zero edge (with good confidence/quality) grades below MEDIUM-edge equivalent', () => {
  const noEdge   = gradePickPreGame(strongPick({ edgeDecimal: 0 }));
  const goodEdge = gradePickPreGame(strongPick({ edgeDecimal: 0.07 }));
  if (noEdge.gradeNumeric >= goodEdge.gradeNumeric) {
    throw new Error(
      `Zero-edge (${noEdge.gradeNumeric}) should grade below good-edge (${goodEdge.gradeNumeric})`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Bounds
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbounds');

// Required test 6: grade never exceeds 100
test('grade never exceeds 100 — perfect inputs', () => {
  const r = gradePickPreGame({
    edgeDecimal:  0.99,
    confidence:   1.0,
    oddsQuality:  1.0,
    riskLevel:    'LOW',
    hasLiveOdds:  true,
    americanOdds: -110,
  });
  if (r.gradeNumeric > 100) {
    throw new Error(`Grade exceeded 100: ${r.gradeNumeric}`);
  }
  assert.strictEqual(r.gradeNumeric, 100);
});

test('grade never exceeds 100 across many input combinations', () => {
  const edges   = [0, 0.03, 0.07, 0.12, 0.50, 0.99];
  const confs   = [0.1, 0.5, 0.9, 1.0];
  const quals   = [0.1, 0.5, 0.9, 1.0];
  const risks   = ['LOW', 'MEDIUM', 'HIGH'] as const;
  for (const e of edges) {
    for (const c of confs) {
      for (const q of quals) {
        for (const r of risks) {
          const result = gradePickPreGame({
            edgeDecimal: e, confidence: c, oddsQuality: q,
            riskLevel: r, hasLiveOdds: true, americanOdds: -110,
          });
          if (result.gradeNumeric > 100) {
            throw new Error(`Score ${result.gradeNumeric} > 100 for e=${e} c=${c} q=${q} r=${r}`);
          }
        }
      }
    }
  }
});

// Required test 7: grade never goes below 0
test('grade never goes below 0 — worst case inputs', () => {
  const r = gradePickPreGame({
    edgeDecimal:  -0.99,
    confidence:   0.01,
    oddsQuality:  0.01,
    riskLevel:    'HIGH',
    hasLiveOdds:  true,
    americanOdds: +500,
  });
  if (r.gradeNumeric < 0) {
    throw new Error(`Grade went below 0: ${r.gradeNumeric}`);
  }
});

test('grade never goes below 0 across many input combinations', () => {
  const edges = [-0.5, -0.1, -0.01, 0];
  const confs = [0.01, 0.1, 0.3];
  const risks = ['LOW', 'MEDIUM', 'HIGH'] as const;
  for (const e of edges) {
    for (const c of confs) {
      for (const r of risks) {
        const result = gradePickPreGame({
          edgeDecimal: e, confidence: c, oddsQuality: 0.1,
          riskLevel: r, hasLiveOdds: true, americanOdds: -110,
        });
        if (result.gradeNumeric < 0) {
          throw new Error(`Score ${result.gradeNumeric} < 0 for e=${e} c=${c} r=${r}`);
        }
      }
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Grade letter mapping
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ngrade letter mapping');

// Required test 9: gradeLetter mapping works for every range
test('score 100 → A+', () => assert.strictEqual(gradeLetterFromScore(100), 'A+'));
test('score 90  → A+', () => assert.strictEqual(gradeLetterFromScore(90),  'A+'));
test('score 89  → A',  () => assert.strictEqual(gradeLetterFromScore(89),  'A'));
test('score 80  → A',  () => assert.strictEqual(gradeLetterFromScore(80),  'A'));
test('score 79  → B',  () => assert.strictEqual(gradeLetterFromScore(79),  'B'));
test('score 70  → B',  () => assert.strictEqual(gradeLetterFromScore(70),  'B'));
test('score 69  → C',  () => assert.strictEqual(gradeLetterFromScore(69),  'C'));
test('score 60  → C',  () => assert.strictEqual(gradeLetterFromScore(60),  'C'));
test('score 59  → D',  () => assert.strictEqual(gradeLetterFromScore(59),  'D'));
test('score 50  → D',  () => assert.strictEqual(gradeLetterFromScore(50),  'D'));
test('score 49  → F',  () => assert.strictEqual(gradeLetterFromScore(49),  'F'));
test('score 0   → F',  () => assert.strictEqual(gradeLetterFromScore(0),   'F'));
test('score 1   → F',  () => assert.strictEqual(gradeLetterFromScore(1),   'F'));

test('gradeNumeric and gradeLetter are consistent in full result', () => {
  const cases = [
    strongPick({ edgeDecimal: 0.12, confidence: 0.95, oddsQuality: 0.95, riskLevel: 'LOW' }),
    strongPick({ riskLevel: 'HIGH' }),
    weakPick(),
    weakPick({ riskLevel: 'HIGH' }),
  ];
  for (const input of cases) {
    const r = gradePickPreGame(input);
    const expected = gradeLetterFromScore(r.gradeNumeric);
    if (r.gradeLetter !== expected) {
      throw new Error(
        `Score ${r.gradeNumeric} → letter ${r.gradeLetter} but expected ${expected}`,
      );
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Component transparency
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncomponent transparency');

test('components object is always returned', () => {
  const r = gradePickPreGame(strongPick());
  assert.ok('edgeScore'       in r.components, 'missing edgeScore');
  assert.ok('confidenceScore' in r.components, 'missing confidenceScore');
  assert.ok('oddsQualityScore' in r.components, 'missing oddsQualityScore');
  assert.ok('riskAdjustment'  in r.components, 'missing riskAdjustment');
});

test('higher edge input produces higher edgeScore component', () => {
  const low  = gradePickPreGame(strongPick({ edgeDecimal: 0.03 }));
  const high = gradePickPreGame(strongPick({ edgeDecimal: 0.09 }));
  if (high.components.edgeScore <= low.components.edgeScore) {
    throw new Error(
      `Higher edge should produce higher edgeScore: ${high.components.edgeScore} vs ${low.components.edgeScore}`,
    );
  }
});

test('higher confidence input produces higher confidenceScore component', () => {
  const low  = gradePickPreGame(strongPick({ confidence: 0.40 }));
  const high = gradePickPreGame(strongPick({ confidence: 0.90 }));
  if (high.components.confidenceScore <= low.components.confidenceScore) {
    throw new Error(
      `Higher confidence should produce higher confidenceScore: ${high.components.confidenceScore} vs ${low.components.confidenceScore}`,
    );
  }
});

test('higher oddsQuality produces higher oddsQualityScore component', () => {
  const low  = gradePickPreGame(strongPick({ oddsQuality: 0.30 }));
  const high = gradePickPreGame(strongPick({ oddsQuality: 0.90 }));
  if (high.components.oddsQualityScore <= low.components.oddsQualityScore) {
    throw new Error(
      `Higher oddsQuality should produce higher score: ${high.components.oddsQualityScore} vs ${low.components.oddsQualityScore}`,
    );
  }
});

test('baseScore is always between 0 and 100', () => {
  const inputs: PickGradeInput[] = [
    strongPick(),
    weakPick(),
    strongPick({ riskLevel: 'HIGH' }),
    strongPick({ edgeDecimal: 0 }),
  ];
  for (const input of inputs) {
    const r = gradePickPreGame(input);
    if (r.baseScore < 0 || r.baseScore > 100) {
      throw new Error(`baseScore out of range: ${r.baseScore}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Edge scoring linearity
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nedge scoring linearity');

test('higher edge produces strictly higher grade (all else equal)', () => {
  const edges = [0.01, 0.03, 0.05, 0.07, 0.10, 0.12];
  let prev = -1;
  for (const e of edges) {
    const r = gradePickPreGame(strongPick({ edgeDecimal: e, riskLevel: 'MEDIUM' }));
    if (r.gradeNumeric <= prev) {
      throw new Error(`Edge ${e} produced score ${r.gradeNumeric} ≤ previous ${prev}`);
    }
    prev = r.gradeNumeric;
  }
});

test('edge contribution accounts for 40% of base score', () => {
  // With confidence=0, oddsQuality=0, MEDIUM risk: only edge contributes
  // edgeDecimal=0.06 → edgeScore = (0.06/0.12)*100 = 50
  // baseScore = 50 * 0.40 = 20 (plus 0 + 0 + 25*0.10 = 2.5) = 22.5
  // gradeNumeric = 22.5 + 0 (MEDIUM adj) = 22.5
  const r = gradePickPreGame({
    edgeDecimal:  0.06,
    confidence:   0,
    oddsQuality:  0,
    riskLevel:    'MEDIUM',
    hasLiveOdds:  true,
    americanOdds: -110,
  });
  // Edge 0.06 / ceiling 0.12 = 50 edge score → 50 * 0.40 = 20 weighted
  // riskSubScore MEDIUM = 50 → 50 * 0.10 = 5
  // baseScore = 25, gradeNumeric = 25
  if (r.gradeNumeric < 20 || r.gradeNumeric > 30) {
    throw new Error(
      `Expected gradeNumeric ~25 for isolated edge contribution, got ${r.gradeNumeric}`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`pickGrade.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
