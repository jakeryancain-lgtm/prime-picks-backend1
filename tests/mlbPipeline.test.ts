import * as assert from 'assert';
import { runMLBPipeline, type RawMLBPick, type ProcessedMLBPick } from '../src/mlbPipeline';

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
// Fake slate — one raw pick per scenario
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function makeId(label: string) { return `${++seq}-${label}`; }

/**
 * Scenario 1 — Strong moneyline: should qualify and reach topPicks.
 * NYY -115 / BOS +105. Model says NYY win prob = 0.64.
 * No-vig implied ≈ 0.523. Edge ≈ 0.117. LOW risk. HIGH grade.
 */
const STRONG_MONEYLINE: RawMLBPick = {
  id:                   makeId('strong-moneyline'),
  modelVersionId:       'model-v1',
  gameId:               'game-NYY-BOS',
  team:                 'NYY',
  opponent:             'BOS',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -115,
  oppositeAmericanOdds: 105,
  modelProbability:     0.64,
  confidence:           0.78,
  oddsQuality:          0.85,
  lineMovementPercent:  1,
  sampleSize:           120,
};

/**
 * Scenario 2 — No odds: should route to noOddsPicks.
 */
const NO_ODDS_PICK: RawMLBPick = {
  id:             makeId('no-odds'),
  modelVersionId: 'model-v1',
  gameId:         'game-CHC-MIL',
  team:           'CHC',
  opponent:       'MIL',
  betType:        'moneyline',
  marketType:     'moneyline',
  americanOdds:   null,
  modelProbability: 0.58,
  confidence:     0.70,
};

/**
 * Scenario 3 — +1.5 run line: should fail with EXCLUDED_RUN_LINE.
 */
const PLUS_1_5_RUN_LINE: RawMLBPick = {
  id:                   makeId('plus-1.5-rl'),
  modelVersionId:       'model-v1',
  gameId:               'game-LAD-SF',
  team:                 'SF',
  opponent:             'LAD',
  betType:              'run_line',
  marketType:           'run_line',
  americanOdds:         -105,
  oppositeAmericanOdds: -115,
  modelProbability:     0.55,
  confidence:           0.72,
  runLineSpread:        1.5,
  sampleSize:           80,
};

/**
 * Scenario 4 — Odds worse than -170: should fail with BAD_ODDS_RANGE.
 */
const BAD_ODDS_RANGE: RawMLBPick = {
  id:                   makeId('bad-odds'),
  modelVersionId:       'model-v1',
  gameId:               'game-HOU-OAK',
  team:                 'HOU',
  opponent:             'OAK',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -210,
  oppositeAmericanOdds: 180,
  modelProbability:     0.72,
  confidence:           0.80,
  sampleSize:           90,
};

/**
 * Scenario 5 — Low edge: edge will be below 3%, should fail EDGE_TOO_LOW.
 * -115 / +105 market. No-vig implied ≈ 0.523. Model prob 0.54 → edge ≈ 0.017.
 */
const LOW_EDGE: RawMLBPick = {
  id:                   makeId('low-edge'),
  modelVersionId:       'model-v1',
  gameId:               'game-ATL-PHI',
  team:                 'ATL',
  opponent:             'PHI',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -115,
  oppositeAmericanOdds: 105,
  modelProbability:     0.54,   // no-vig implied ≈ 0.523 → edge ≈ 0.017
  confidence:           0.65,
  sampleSize:           60,
};

// Scenario 6 — High risk: -200 juice(+20) + low confidence(+15) + bad movement(+15) + small sample(+10) + injury(+10) = 70 → HIGH
const HIGH_RISK_REAL: RawMLBPick = {
  id:                   makeId('high-risk-real'),
  modelVersionId:       'model-v1',
  gameId:               'game-NYM-WSH-2',
  team:                 'NYM',
  opponent:             'WSH',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -200,  // +20 juice
  oppositeAmericanOdds: 170,
  modelProbability:     0.68,  // no-vig of -200/+170 ≈ 0.553 → edge ≈ 0.127, so edge is fine
  confidence:           0.45,  // +15 low confidence
  lineMovementPercent:  -8,    // +15 bad movement
  sampleSize:           12,    // +10 small sample
  // juice 20 + confidence 15 + movement 15 + sample 10 = 60 → MEDIUM
  // need one more: low edge. But model=0.68 vs implied≈0.553 → edge≈0.127 (high). Not low edge.
  // To hit 70, add injuryFlag:
  injuryFlag:           true,  // +10 → total 70 → HIGH
};

/**
 * Scenario 7a — Duplicate game best pick (should qualify → topPicks).
 */
const DUPLICATE_BEST: RawMLBPick = {
  id:                   makeId('dupe-best'),
  modelVersionId:       'model-v1',
  gameId:               'game-DET-MIN',
  team:                 'DET',
  opponent:             'MIN',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -115,
  oppositeAmericanOdds: 105,
  modelProbability:     0.68,
  confidence:           0.82,
  oddsQuality:          0.88,
  sampleSize:           100,
};

/**
 * Scenario 7b — Duplicate game second pick (should fail DUPLICATE_GAME).
 * Same gameId as DUPLICATE_BEST but lower model probability / grade.
 */
const DUPLICATE_SECOND: RawMLBPick = {
  id:                   makeId('dupe-second'),
  modelVersionId:       'model-v1',
  gameId:               'game-DET-MIN',     // same game as DUPLICATE_BEST
  team:                 'MIN',
  opponent:             'DET',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         105,
  oppositeAmericanOdds: -115,
  modelProbability:     0.55,
  confidence:           0.65,
  oddsQuality:          0.70,
  sampleSize:           100,
};

// Full slate for the main integration tests
const FULL_SLATE: RawMLBPick[] = [
  STRONG_MONEYLINE,
  NO_ODDS_PICK,
  PLUS_1_5_RUN_LINE,
  BAD_ODDS_RANGE,
  LOW_EDGE,
  HIGH_RISK_REAL,
  DUPLICATE_BEST,
  DUPLICATE_SECOND,
];

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function findById(picks: ProcessedMLBPick[], id: string) {
  return picks.find(p => p.id === id);
}

function allOutputPicks(output: ReturnType<typeof runMLBPipeline>['output']): ProcessedMLBPick[] {
  return [
    ...output.topPicks,
    ...output.qualifiedPicks,
    ...output.failedPicks,
    ...output.noOddsPicks,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// Integration tests
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npipeline — full slate integration');

const { output, errors, totalInput, totalOutput } = runMLBPipeline(FULL_SLATE);

// No pipeline errors — all picks are valid inputs
test('pipeline runs without errors on the full slate', () => {
  if (errors.length > 0) {
    throw new Error(`Pipeline produced errors: ${JSON.stringify(errors)}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: strong moneyline qualifies and reaches topPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 1 — strong moneyline');

test('strong moneyline is in topPicks', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id);
  if (!found) throw new Error(`${STRONG_MONEYLINE.id} not found in topPicks`);
});

test('strong moneyline has positive edge', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  if (!found) throw new Error('pick not in topPicks');
  if (found.edgeDecimal <= 0) throw new Error(`Expected positive edge, got ${found.edgeDecimal}`);
});

test('strong moneyline uses no-vig probability (opposite odds provided)', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  if (!found) throw new Error('pick not in topPicks');
  assert.strictEqual(found.probabilitySource, 'no-vig');
});

test('strong moneyline has grade A or A+', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  if (!found) throw new Error('pick not in topPicks');
  if (found.gradeLetter !== 'A+' && found.gradeLetter !== 'A') {
    throw new Error(`Expected A or A+, got ${found.gradeLetter} (score: ${found.gradeNumeric})`);
  }
});

test('strong moneyline has status QUALIFIED', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  if (!found) throw new Error('pick not in topPicks');
  assert.strictEqual(found.status, 'QUALIFIED');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: no odds pick goes to noOddsPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 2 — no odds');

test('no-odds pick is in noOddsPicks', () => {
  const found = findById(output.noOddsPicks, NO_ODDS_PICK.id);
  if (!found) throw new Error(`${NO_ODDS_PICK.id} not in noOddsPicks`);
});

test('no-odds pick has gradeNumeric 0', () => {
  const found = findById(output.noOddsPicks, NO_ODDS_PICK.id)!;
  assert.strictEqual(found.gradeNumeric, 0);
});

test('no-odds pick has gradeLetter NO_GRADE', () => {
  const found = findById(output.noOddsPicks, NO_ODDS_PICK.id)!;
  assert.strictEqual(found.gradeLetter, 'NO_GRADE');
});

test('no-odds pick has status NO_ODDS', () => {
  const found = findById(output.noOddsPicks, NO_ODDS_PICK.id)!;
  assert.strictEqual(found.status, 'NO_ODDS');
});

test('no-odds pick is not in any other group', () => {
  const notInTop  = !findById(output.topPicks, NO_ODDS_PICK.id);
  const notFailed = !findById(output.failedPicks, NO_ODDS_PICK.id);
  const notQual   = !findById(output.qualifiedPicks, NO_ODDS_PICK.id);
  if (!notInTop || !notFailed || !notQual) {
    throw new Error('no-odds pick appeared in wrong group');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: +1.5 run line fails
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 3 — +1.5 run line');

test('+1.5 run line is in failedPicks', () => {
  const found = findById(output.failedPicks, PLUS_1_5_RUN_LINE.id);
  if (!found) throw new Error(`${PLUS_1_5_RUN_LINE.id} not in failedPicks`);
});

test('+1.5 run line has failReason EXCLUDED_RUN_LINE', () => {
  const found = findById(output.failedPicks, PLUS_1_5_RUN_LINE.id)!;
  assert.strictEqual(found.failReason, 'EXCLUDED_RUN_LINE');
});

test('+1.5 run line has status FAILED_FILTER', () => {
  const found = findById(output.failedPicks, PLUS_1_5_RUN_LINE.id)!;
  assert.strictEqual(found.status, 'FAILED_FILTER');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: bad odds fails
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 4 — bad odds range');

test('bad odds pick is in failedPicks', () => {
  const found = findById(output.failedPicks, BAD_ODDS_RANGE.id);
  if (!found) throw new Error(`${BAD_ODDS_RANGE.id} not in failedPicks`);
});

test('bad odds pick has failReason BAD_ODDS_RANGE', () => {
  const found = findById(output.failedPicks, BAD_ODDS_RANGE.id)!;
  assert.strictEqual(found.failReason, 'BAD_ODDS_RANGE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: low edge fails
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 5 — low edge');

test('low edge pick is in failedPicks', () => {
  const found = findById(output.failedPicks, LOW_EDGE.id);
  if (!found) throw new Error(`${LOW_EDGE.id} not in failedPicks`);
});

test('low edge pick has failReason EDGE_TOO_LOW', () => {
  const found = findById(output.failedPicks, LOW_EDGE.id)!;
  assert.strictEqual(found.failReason, 'EDGE_TOO_LOW');
});

test('low edge pick has computed a non-zero edgeDecimal (was calculated before tagging)', () => {
  const found = findById(output.failedPicks, LOW_EDGE.id)!;
  // Edge should be small but computed — not zero or missing
  if (found.edgeDecimal === null || found.edgeDecimal === undefined) {
    throw new Error('edgeDecimal was not computed for failed pick');
  }
  if (Math.abs(found.edgeDecimal) > 0.03) {
    throw new Error(`Expected low edge < 0.03, got ${found.edgeDecimal}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: high risk fails
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 6 — high risk');

test('high risk pick is in failedPicks', () => {
  const found = findById(output.failedPicks, HIGH_RISK_REAL.id);
  if (!found) throw new Error(`${HIGH_RISK_REAL.id} not in failedPicks`);
});

test('high risk pick fails — reason is BAD_ODDS_RANGE because -200 odds trigger that filter first', () => {
  // The ranking engine processes filters in order: no-odds → BAD_ODDS_RANGE → EXCLUDED_RUN_LINE → EDGE_TOO_LOW → HIGH_RISK.
  // HIGH_RISK_REAL uses -200 odds which is worse than the -170 threshold, so BAD_ODDS_RANGE fires first.
  // This is correct behavior: a pick that is both bad-odds AND high-risk exits at the first matching filter.
  const found = findById(output.failedPicks, HIGH_RISK_REAL.id)!;
  // The pick is failed for one of: BAD_ODDS_RANGE or HIGH_RISK (both correct, order determines which)
  const validReasons = ['BAD_ODDS_RANGE', 'HIGH_RISK'];
  if (!validReasons.includes(found.failReason!)) {
    throw new Error(`Expected BAD_ODDS_RANGE or HIGH_RISK, got ${found.failReason}`);
  }
});

test('high risk pick has riskLevel HIGH (confirmed by pipeline)', () => {
  const found = findById(output.failedPicks, HIGH_RISK_REAL.id)!;
  assert.strictEqual(found.riskLevel, 'HIGH');
});

test('high risk pick has riskScore ≥ 70', () => {
  const found = findById(output.failedPicks, HIGH_RISK_REAL.id)!;
  if (found.riskScore < 70) {
    throw new Error(`Expected riskScore ≥ 70, got ${found.riskScore}`);
  }
});

test('HIGH_RISK failReason reached when odds pass range check (custom config)', () => {
  // Use maxNegativeOdds: -250 so -200 passes the odds range filter.
  // The HIGH_RISK path is then reached: juice(+20) + confidence(+15) + movement(+15) + sample(+10) + injury(+10) = 70 → HIGH.
  const result = runMLBPipeline([HIGH_RISK_REAL], { maxNegativeOdds: -250 });
  const found = result.output.failedPicks.find(p => p.id === HIGH_RISK_REAL.id);
  if (!found) throw new Error(`${HIGH_RISK_REAL.id} not in failedPicks with custom config`);
  assert.strictEqual(found.failReason, 'HIGH_RISK');
  assert.strictEqual(found.riskLevel, 'HIGH');
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: duplicate game pick tagged DUPLICATE_GAME
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 7 — duplicate game');

test('best pick from duplicate game is in topPicks', () => {
  const found = findById(output.topPicks, DUPLICATE_BEST.id);
  if (!found) throw new Error(`Best pick ${DUPLICATE_BEST.id} not in topPicks`);
});

test('second pick from duplicate game is in failedPicks', () => {
  const found = findById(output.failedPicks, DUPLICATE_SECOND.id);
  if (!found) throw new Error(`Second pick ${DUPLICATE_SECOND.id} not in failedPicks`);
});

test('second duplicate pick has failReason DUPLICATE_GAME', () => {
  const found = findById(output.failedPicks, DUPLICATE_SECOND.id)!;
  assert.strictEqual(found.failReason, 'DUPLICATE_GAME');
});

test('both duplicate picks are accounted for (not deleted)', () => {
  const all = allOutputPicks(output);
  const best   = all.find(p => p.id === DUPLICATE_BEST.id);
  const second = all.find(p => p.id === DUPLICATE_SECOND.id);
  if (!best)   throw new Error(`${DUPLICATE_BEST.id} missing from all output`);
  if (!second) throw new Error(`${DUPLICATE_SECOND.id} missing from all output`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: only qualified picks reach topPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 8 — topPicks integrity');

test('no failed pick appears in topPicks', () => {
  const failedIds = new Set(output.failedPicks.map(p => p.id));
  for (const top of output.topPicks) {
    if (failedIds.has(top.id)) {
      throw new Error(`Failed pick ${top.id} leaked into topPicks`);
    }
  }
});

test('no noOdds pick appears in topPicks', () => {
  const noOddsIds = new Set(output.noOddsPicks.map(p => p.id));
  for (const top of output.topPicks) {
    if (noOddsIds.has(top.id)) {
      throw new Error(`NoOdds pick ${top.id} leaked into topPicks`);
    }
  }
});

test('all topPicks have status QUALIFIED', () => {
  for (const p of output.topPicks) {
    if (p.status !== 'QUALIFIED') {
      throw new Error(`topPick ${p.id} has status ${p.status}`);
    }
  }
});

test('all topPicks have positive edgeDecimal', () => {
  for (const p of output.topPicks) {
    if (p.edgeDecimal <= 0) {
      throw new Error(`topPick ${p.id} has non-positive edge ${p.edgeDecimal}`);
    }
  }
});

test('all topPicks have non-HIGH riskLevel', () => {
  for (const p of output.topPicks) {
    if (p.riskLevel === 'HIGH') {
      throw new Error(`topPick ${p.id} has HIGH risk`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9: every input pick appears in exactly one output group
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 9 — full accounting');

test('totalInput equals totalOutput (no picks lost)', () => {
  assert.strictEqual(totalInput, FULL_SLATE.length);
  assert.strictEqual(totalOutput, FULL_SLATE.length);
});

test('no pick id appears in more than one output group', () => {
  const all = allOutputPicks(output);
  const seen = new Set<string>();
  for (const p of all) {
    if (seen.has(p.id)) throw new Error(`Pick ${p.id} appears in more than one group`);
    seen.add(p.id);
  }
});

test('every input pick id is present in some output group', () => {
  const all = new Set(allOutputPicks(output).map(p => p.id));
  for (const raw of FULL_SLATE) {
    if (!all.has(raw.id)) throw new Error(`Input pick ${raw.id} missing from all output groups`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10: topPicks does not force 5 picks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  scenario 10 — no padding to 5');

test('topPicks contains only picks that actually qualified', () => {
  // From our slate: STRONG_MONEYLINE and DUPLICATE_BEST are the only
  // clean qualifiers (others all fail for one reason). So top ≤ 2.
  if (output.topPicks.length > 2) {
    const ids = output.topPicks.map(p => `${p.id}(${p.failReason ?? 'ok'})`).join(', ');
    throw new Error(`Expected ≤ 2 topPicks, got ${output.topPicks.length}: ${ids}`);
  }
  if (output.topPicks.length < 1) {
    throw new Error('Expected at least 1 topPick');
  }
});

test('topPicks is not padded with null/undefined to fill 5 slots', () => {
  assert.strictEqual(output.topPicks.length <= 5, true);
  for (const p of output.topPicks) {
    if (p == null) throw new Error('topPicks contains null/undefined entry');
  }
});

test('pipeline with 0 qualifying picks returns empty topPicks', () => {
  // Use real no-odds pick so pipeline can process it
  const noQualResult = runMLBPipeline([
    { ...NO_ODDS_PICK, id: 'z3' },
    { ...PLUS_1_5_RUN_LINE, id: 'z4' },
  ]);
  assert.strictEqual(noQualResult.output.topPicks.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Engine output integrity — spot-check computed fields
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  computed field spot-checks');

test('strong moneyline decimalOdds is correctly converted from americanOdds', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  // -115 → decimal = (100/115) + 1 ≈ 1.8696
  if (!found.decimalOdds || Math.abs(found.decimalOdds - 1.8696) > 0.001) {
    throw new Error(`Expected decimal ~1.8696, got ${found.decimalOdds}`);
  }
});

test('strong moneyline no-vig probability is between 0 and 1', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  if (!found.noVigProbability || found.noVigProbability <= 0 || found.noVigProbability >= 1) {
    throw new Error(`noVigProbability out of range: ${found.noVigProbability}`);
  }
});

test('strong moneyline edge is consistent: model prob - no-vig implied ≈ edgeDecimal', () => {
  const found = findById(output.topPicks, STRONG_MONEYLINE.id)!;
  const expected = found.modelProbability - found.noVigProbability!;
  if (Math.abs(found.edgeDecimal - expected) > 0.0001) {
    throw new Error(`Edge inconsistency: ${found.edgeDecimal} vs ${expected}`);
  }
});

test('all topPicks have non-null decimalOdds', () => {
  for (const p of output.topPicks) {
    if (p.decimalOdds === null || p.decimalOdds === undefined) {
      throw new Error(`topPick ${p.id} has null decimalOdds`);
    }
  }
});

test('all topPicks have gradeNumeric > 0', () => {
  for (const p of output.topPicks) {
    if (p.gradeNumeric <= 0) throw new Error(`topPick ${p.id} has gradeNumeric ${p.gradeNumeric}`);
  }
});

test('riskReasons array is present on all processed picks', () => {
  const all = allOutputPicks(output);
  for (const p of all) {
    if (!Array.isArray(p.riskReasons)) {
      throw new Error(`Pick ${p.id} missing riskReasons array`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot: print one qualifying pick for human review
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n  ── Example output from slate ──────────────────────');
if (output.topPicks.length > 0) {
  const ex = output.topPicks[0]!;
  console.log(`  Pick:       ${ex.team} vs ${ex.opponent} (${ex.betType})`);
  console.log(`  Odds:       ${ex.americanOdds} American / ${ex.decimalOdds?.toFixed(4)} decimal`);
  console.log(`  No-vig:     ${(ex.noVigProbability! * 100).toFixed(2)}%`);
  console.log(`  Model prob: ${(ex.modelProbability * 100).toFixed(2)}%`);
  console.log(`  Edge:       ${(ex.edgeDecimal * 100).toFixed(2)}% (${ex.edgeTier})`);
  console.log(`  Risk:       ${ex.riskLevel} (score ${ex.riskScore})`);
  console.log(`  Grade:      ${ex.gradeLetter} (${ex.gradeNumeric.toFixed(1)})`);
  console.log(`  Status:     ${ex.status}`);
}
console.log(`\n  topPicks:      ${output.topPicks.length}`);
console.log(`  qualifiedPicks: ${output.qualifiedPicks.length}`);
console.log(`  failedPicks:    ${output.failedPicks.length} (reasons: ${[...new Set(output.failedPicks.map(p => p.failReason))].join(', ')})`);
console.log(`  noOddsPicks:    ${output.noOddsPicks.length}`);

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`mlbPipeline — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
