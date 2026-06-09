import * as assert from 'assert';
import { rankPicks, type RankablePick } from '../src/engines/ranking.engine';

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

let idCounter = 0;
function nextId() { return `pick-${++idCounter}`; }

/** A fully qualified pick — passes every filter. */
function qualifiedPick(overrides: Partial<RankablePick> = {}): RankablePick {
  return {
    id:            nextId(),
    gameId:        `game-${nextId()}`,
    betType:       'moneyline',
    americanOdds:  -115,
    edgeDecimal:   0.07,
    confidence:    0.75,
    gradeNumeric:  82,
    riskLevel:     'LOW',
    ...overrides,
  };
}

/** Collect all pick ids across all groups and check for duplicates. */
function allIds(output: ReturnType<typeof rankPicks>): string[] {
  return [
    ...output.topPicks.map(p => p.id),
    ...output.qualifiedPicks.map(p => p.id),
    ...output.failedPicks.map(p => p.id),
    ...output.noOddsPicks.map(p => p.id),
  ];
}

function assertNoDuplicateIds(output: ReturnType<typeof rankPicks>) {
  const ids = allIds(output);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Pick id ${id} appears in more than one group`);
    seen.add(id);
  }
}

function assertInputsEqualsOutputs(
  input: RankablePick[],
  output: ReturnType<typeof rankPicks>,
) {
  const outputTotal =
    output.topPicks.length +
    output.qualifiedPicks.length +
    output.failedPicks.length +
    output.noOddsPicks.length;
  if (outputTotal !== input.length) {
    throw new Error(
      `Input had ${input.length} picks but output total is ${outputTotal}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Required test 1: returns all four groups
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nreturn shape');

test('returns all four groups as arrays', () => {
  const result = rankPicks([]);
  assert.ok(Array.isArray(result.topPicks),      'topPicks not array');
  assert.ok(Array.isArray(result.qualifiedPicks), 'qualifiedPicks not array');
  assert.ok(Array.isArray(result.failedPicks),    'failedPicks not array');
  assert.ok(Array.isArray(result.noOddsPicks),    'noOddsPicks not array');
});

test('empty input returns four empty arrays', () => {
  const result = rankPicks([]);
  assert.strictEqual(result.topPicks.length,      0);
  assert.strictEqual(result.qualifiedPicks.length, 0);
  assert.strictEqual(result.failedPicks.length,    0);
  assert.strictEqual(result.noOddsPicks.length,    0);
});

test('single qualified pick lands in topPicks', () => {
  const pick = qualifiedPick();
  const result = rankPicks([pick]);
  assert.strictEqual(result.topPicks.length, 1);
  assert.strictEqual(result.topPicks[0]!.id, pick.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 2: no live odds goes to noOddsPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnoOddsPicks routing');

test('americanOdds=null routes to noOddsPicks', () => {
  const pick = qualifiedPick({ americanOdds: null });
  const result = rankPicks([pick]);
  assert.strictEqual(result.noOddsPicks.length, 1);
  assert.strictEqual(result.noOddsPicks[0]!.id, pick.id);
  assert.strictEqual(result.topPicks.length, 0);
  assert.strictEqual(result.failedPicks.length, 0);
});

test('americanOdds=undefined routes to noOddsPicks', () => {
  const pick = qualifiedPick({ americanOdds: undefined });
  const result = rankPicks([pick]);
  assert.strictEqual(result.noOddsPicks.length, 1);
});

test('noOdds picks receive status NO_ODDS', () => {
  const pick = qualifiedPick({ americanOdds: null });
  const result = rankPicks([pick]);
  assert.strictEqual(result.noOddsPicks[0]!.status, 'NO_ODDS');
});

test('noOdds picks do not receive a failReason', () => {
  const pick = qualifiedPick({ americanOdds: null });
  const result = rankPicks([pick]);
  assert.strictEqual(result.noOddsPicks[0]!.failReason, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 3: low edge goes to failedPicks with EDGE_TOO_LOW
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nEDGE_TOO_LOW');

test('edge below minimum routes to failedPicks', () => {
  const pick = qualifiedPick({ edgeDecimal: 0.02 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 1);
  assert.strictEqual(result.topPicks.length, 0);
});

test('low edge pick receives failReason EDGE_TOO_LOW', () => {
  const pick = qualifiedPick({ edgeDecimal: 0.01 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'EDGE_TOO_LOW');
});

test('low edge pick receives status FAILED_FILTER', () => {
  const pick = qualifiedPick({ edgeDecimal: 0.01 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.status, 'FAILED_FILTER');
});

test('edge exactly at minimum (0.03) qualifies', () => {
  const pick = qualifiedPick({ edgeDecimal: 0.03 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.topPicks.length, 1);
  assert.strictEqual(result.failedPicks.length, 0);
});

test('negative edge fails with EDGE_TOO_LOW', () => {
  const pick = qualifiedPick({ edgeDecimal: -0.05 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'EDGE_TOO_LOW');
});

test('custom minimumEdge is respected', () => {
  const pick = qualifiedPick({ edgeDecimal: 0.04 });
  // With custom minimum of 0.05 this pick should fail
  const result = rankPicks([pick], { minimumEdge: 0.05 });
  assert.strictEqual(result.failedPicks[0]!.failReason, 'EDGE_TOO_LOW');
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 4: bad odds range goes to failedPicks with BAD_ODDS_RANGE
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nBAD_ODDS_RANGE');

test('odds worse than -170 routes to failedPicks', () => {
  const pick = qualifiedPick({ americanOdds: -180 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 1);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'BAD_ODDS_RANGE');
});

test('odds at exactly -170 do NOT fail BAD_ODDS_RANGE', () => {
  const pick = qualifiedPick({ americanOdds: -170 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
  assert.strictEqual(result.topPicks.length, 1);
});

test('odds at -169 do NOT fail BAD_ODDS_RANGE', () => {
  const pick = qualifiedPick({ americanOdds: -169 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
});

test('BAD_ODDS_RANGE pick receives status FAILED_FILTER', () => {
  const pick = qualifiedPick({ americanOdds: -250 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.status, 'FAILED_FILTER');
});

test('positive (underdog) odds are never BAD_ODDS_RANGE', () => {
  const pick = qualifiedPick({ americanOdds: 300 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
});

test('custom maxNegativeOdds is respected', () => {
  const pick = qualifiedPick({ americanOdds: -140 });
  const result = rankPicks([pick], { maxNegativeOdds: -130 });
  assert.strictEqual(result.failedPicks[0]!.failReason, 'BAD_ODDS_RANGE');
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 5 & 6: +1.5 and +2.5 run lines excluded
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nEXCLUDED_RUN_LINE');

test('+1.5 run line goes to failedPicks with EXCLUDED_RUN_LINE', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: 1.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 1);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'EXCLUDED_RUN_LINE');
});

test('+2.5 run line goes to failedPicks with EXCLUDED_RUN_LINE', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: 2.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 1);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'EXCLUDED_RUN_LINE');
});

test('-1.5 run line is NOT excluded', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: -1.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
  assert.strictEqual(result.topPicks.length, 1);
});

test('-2.5 run line is NOT excluded', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: -2.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
  assert.strictEqual(result.topPicks.length, 1);
});

test('non-run-line betType with runLineSpread set is not excluded', () => {
  // Only run_line betType triggers the exclusion check
  const pick = qualifiedPick({ betType: 'moneyline', runLineSpread: 1.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
});

test('+1.5 run line receives status FAILED_FILTER', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: 1.5 });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.status, 'FAILED_FILTER');
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 7: HIGH risk fails
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nHIGH_RISK');

test('HIGH risk pick goes to failedPicks', () => {
  const pick = qualifiedPick({ riskLevel: 'HIGH' });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 1);
  assert.strictEqual(result.failedPicks[0]!.failReason, 'HIGH_RISK');
});

test('HIGH risk pick receives status FAILED_FILTER', () => {
  const pick = qualifiedPick({ riskLevel: 'HIGH' });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks[0]!.status, 'FAILED_FILTER');
});

test('MEDIUM risk does NOT fail', () => {
  const pick = qualifiedPick({ riskLevel: 'MEDIUM' });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
  assert.strictEqual(result.topPicks.length, 1);
});

test('LOW risk does NOT fail', () => {
  const pick = qualifiedPick({ riskLevel: 'LOW' });
  const result = rankPicks([pick]);
  assert.strictEqual(result.failedPicks.length, 0);
  assert.strictEqual(result.topPicks.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 8: qualified picks sorted by grade, edge, confidence
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsorting');

test('topPicks sorted by gradeNumeric DESC', () => {
  const picks = [
    qualifiedPick({ gradeNumeric: 60, edgeDecimal: 0.07, confidence: 0.75 }),
    qualifiedPick({ gradeNumeric: 85, edgeDecimal: 0.05, confidence: 0.65 }),
    qualifiedPick({ gradeNumeric: 75, edgeDecimal: 0.06, confidence: 0.70 }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks[0]!.gradeNumeric, 85);
  assert.strictEqual(result.topPicks[1]!.gradeNumeric, 75);
  assert.strictEqual(result.topPicks[2]!.gradeNumeric, 60);
});

test('equal grade picks sorted by edgeDecimal DESC', () => {
  const grade = 80;
  const picks = [
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: 0.04, confidence: 0.75 }),
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: 0.09, confidence: 0.75 }),
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: 0.06, confidence: 0.75 }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks[0]!.edgeDecimal, 0.09);
  assert.strictEqual(result.topPicks[1]!.edgeDecimal, 0.06);
  assert.strictEqual(result.topPicks[2]!.edgeDecimal, 0.04);
});

test('equal grade and edge sorted by confidence DESC', () => {
  const grade = 80;
  const edge  = 0.07;
  const picks = [
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: edge, confidence: 0.60 }),
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: edge, confidence: 0.90 }),
    qualifiedPick({ gradeNumeric: grade, edgeDecimal: edge, confidence: 0.75 }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks[0]!.confidence, 0.90);
  assert.strictEqual(result.topPicks[1]!.confidence, 0.75);
  assert.strictEqual(result.topPicks[2]!.confidence, 0.60);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 9: Top 5 max is enforced
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntop picks cap');

test('topPicks never exceeds default max of 5', () => {
  const picks = Array.from({ length: 8 }, () => qualifiedPick());
  const result = rankPicks(picks);
  if (result.topPicks.length > 5) {
    throw new Error(`topPicks length ${result.topPicks.length} exceeds 5`);
  }
  assert.strictEqual(result.topPicks.length, 5);
});

test('overflow qualified picks go to qualifiedPicks, not lost', () => {
  const picks = Array.from({ length: 8 }, () => qualifiedPick());
  const result = rankPicks(picks);
  // 8 total - 5 top = 3 overflow
  assert.strictEqual(result.qualifiedPicks.length, 3);
});

test('custom maxTopPicks is respected', () => {
  const picks = Array.from({ length: 4 }, () => qualifiedPick());
  const result = rankPicks(picks, { maxTopPicks: 3 });
  assert.strictEqual(result.topPicks.length, 3);
  assert.strictEqual(result.qualifiedPicks.length, 1);
});

test('maxTopPicks=1 puts best pick in top, rest in qualifiedPicks', () => {
  const picks = [
    qualifiedPick({ gradeNumeric: 90 }),
    qualifiedPick({ gradeNumeric: 80 }),
    qualifiedPick({ gradeNumeric: 70 }),
  ];
  const result = rankPicks(picks, { maxTopPicks: 1 });
  assert.strictEqual(result.topPicks.length, 1);
  assert.strictEqual(result.topPicks[0]!.gradeNumeric, 90);
  assert.strictEqual(result.qualifiedPicks.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 10: one pick per game in Top 5
// ─────────────────────────────────────────────────────────────────────────────

console.log('\none pick per game');

test('two picks from same game: only best lands in topPicks', () => {
  const gameId = 'shared-game-1';
  const better = qualifiedPick({ gameId, gradeNumeric: 90 });
  const worse  = qualifiedPick({ gameId, gradeNumeric: 70 });
  const result = rankPicks([better, worse]);
  assert.strictEqual(result.topPicks.length, 1);
  assert.strictEqual(result.topPicks[0]!.id, better.id);
});

test('topPicks contains no duplicate gameIds', () => {
  const picks = [
    qualifiedPick({ gameId: 'game-A', gradeNumeric: 95 }),
    qualifiedPick({ gameId: 'game-A', gradeNumeric: 85 }),
    qualifiedPick({ gameId: 'game-B', gradeNumeric: 80 }),
    qualifiedPick({ gameId: 'game-B', gradeNumeric: 75 }),
    qualifiedPick({ gameId: 'game-C', gradeNumeric: 70 }),
  ];
  const result = rankPicks(picks);
  const gameIds = result.topPicks.map(p => p.gameId);
  const unique = new Set(gameIds);
  if (unique.size !== gameIds.length) {
    throw new Error(`Duplicate gameIds in topPicks: ${gameIds.join(', ')}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 11: duplicate-game pick tagged DUPLICATE_GAME, not deleted
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nDUPLICATE_GAME');

test('second pick from same game receives DUPLICATE_GAME failReason', () => {
  const gameId = 'dupe-game';
  const better = qualifiedPick({ gameId, gradeNumeric: 90 });
  const worse  = qualifiedPick({ gameId, gradeNumeric: 70 });
  const result = rankPicks([better, worse]);
  const dupe = result.failedPicks.find(p => p.failReason === 'DUPLICATE_GAME');
  assert.ok(dupe, 'No DUPLICATE_GAME pick found in failedPicks');
  assert.strictEqual(dupe!.id, worse.id);
});

test('DUPLICATE_GAME pick receives status FAILED_FILTER', () => {
  const gameId = 'dupe-game-2';
  const picks = [
    qualifiedPick({ gameId, gradeNumeric: 90 }),
    qualifiedPick({ gameId, gradeNumeric: 70 }),
  ];
  const result = rankPicks(picks);
  const dupe = result.failedPicks.find(p => p.failReason === 'DUPLICATE_GAME');
  assert.strictEqual(dupe!.status, 'FAILED_FILTER');
});

test('DUPLICATE_GAME pick is NOT silently removed', () => {
  const gameId = 'dupe-game-3';
  const picks = [
    qualifiedPick({ gameId, gradeNumeric: 90 }),
    qualifiedPick({ gameId, gradeNumeric: 70 }),
  ];
  const result = rankPicks(picks);
  // All input picks must appear in output
  assertInputsEqualsOutputs(picks, result);
});

test('third pick from same game also gets DUPLICATE_GAME', () => {
  const gameId = 'triple-game';
  const picks = [
    qualifiedPick({ gameId, gradeNumeric: 95 }),
    qualifiedPick({ gameId, gradeNumeric: 80 }),
    qualifiedPick({ gameId, gradeNumeric: 65 }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks.filter(p => p.gameId === gameId).length, 1);
  const dupes = result.failedPicks.filter(p => p.failReason === 'DUPLICATE_GAME');
  assert.strictEqual(dupes.length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 12: if only 2 qualify, topPicks length is 2
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npartial top picks');

test('if only 2 picks qualify, topPicks.length === 2, not 5', () => {
  const picks = [
    qualifiedPick({ gradeNumeric: 85 }),
    qualifiedPick({ gradeNumeric: 78 }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks.length, 2);
});

test('if only 1 pick qualifies, topPicks.length === 1', () => {
  const picks = [qualifiedPick()];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks.length, 1);
});

test('if 0 picks qualify, topPicks is empty', () => {
  const picks = [
    qualifiedPick({ edgeDecimal: 0.01 }),  // fails EDGE_TOO_LOW
    qualifiedPick({ riskLevel: 'HIGH' }),   // fails HIGH_RISK
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks.length, 0);
  assert.strictEqual(result.failedPicks.length, 2);
});

test('topPicks does not pad with null or undefined to reach maxTopPicks', () => {
  const picks = [qualifiedPick()];
  const result = rankPicks(picks);
  for (const p of result.topPicks) {
    if (p === null || p === undefined) {
      throw new Error('topPicks contains null/undefined entry');
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 13: failedPicks are still returned
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfailedPicks always returned');

test('failedPicks are returned even when topPicks is full', () => {
  // Fill top 5 with good picks, then add failing picks
  const goodPicks = Array.from({ length: 5 }, () => qualifiedPick({ gradeNumeric: 80 }));
  const badPicks = [
    qualifiedPick({ edgeDecimal: 0.01 }),
    qualifiedPick({ riskLevel: 'HIGH' }),
  ];
  const result = rankPicks([...goodPicks, ...badPicks]);
  assert.strictEqual(result.failedPicks.length, 2);
});

test('all failed picks have status FAILED_FILTER', () => {
  const picks = [
    qualifiedPick({ edgeDecimal: 0.01 }),
    qualifiedPick({ riskLevel: 'HIGH' }),
    qualifiedPick({ betType: 'run_line', runLineSpread: 1.5 }),
    qualifiedPick({ americanOdds: -250 }),
  ];
  const result = rankPicks(picks);
  for (const p of result.failedPicks) {
    assert.strictEqual(p.status, 'FAILED_FILTER');
  }
});

test('all failed picks have a failReason set', () => {
  const picks = [
    qualifiedPick({ edgeDecimal: 0.01 }),
    qualifiedPick({ riskLevel: 'HIGH' }),
  ];
  const result = rankPicks(picks);
  for (const p of result.failedPicks) {
    if (!p.failReason) throw new Error(`Failed pick ${p.id} has no failReason`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 14: noOddsPicks are still returned
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nnoOddsPicks always returned');

test('noOddsPicks are returned alongside topPicks', () => {
  const picks = [
    qualifiedPick({ gradeNumeric: 85 }),         // → topPicks
    qualifiedPick({ americanOdds: null }),         // → noOddsPicks
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.topPicks.length,    1);
  assert.strictEqual(result.noOddsPicks.length, 1);
});

test('multiple noOddsPicks all appear in noOddsPicks group', () => {
  const picks = [
    qualifiedPick({ americanOdds: null }),
    qualifiedPick({ americanOdds: null }),
    qualifiedPick({ americanOdds: undefined }),
  ];
  const result = rankPicks(picks);
  assert.strictEqual(result.noOddsPicks.length, 3);
});

// ─────────────────────────────────────────────────────────────────────────────
// Required test 15: no pick appears in more than one group
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmutual exclusivity');

test('no pick id appears in more than one group', () => {
  const picks = [
    qualifiedPick({ gradeNumeric: 90 }),
    qualifiedPick({ gradeNumeric: 85 }),
    qualifiedPick({ edgeDecimal: 0.01 }),
    qualifiedPick({ americanOdds: null }),
    qualifiedPick({ riskLevel: 'HIGH' }),
    qualifiedPick({ betType: 'run_line', runLineSpread: 1.5 }),
    qualifiedPick({ americanOdds: -250 }),
  ];
  const result = rankPicks(picks);
  assertNoDuplicateIds(result);
});

test('total output count equals total input count', () => {
  const picks = [
    qualifiedPick(),
    qualifiedPick(),
    qualifiedPick({ edgeDecimal: 0.01 }),
    qualifiedPick({ americanOdds: null }),
    qualifiedPick({ riskLevel: 'HIGH' }),
    qualifiedPick({ betType: 'run_line', runLineSpread: 2.5 }),
  ];
  const result = rankPicks(picks);
  assertInputsEqualsOutputs(picks, result);
});

test('mixed scenario: full accounting across all groups', () => {
  const gameId = 'shared-game-x';
  const picks = [
    qualifiedPick({ gameId, gradeNumeric: 95 }),    // → topPicks (best from game)
    qualifiedPick({ gameId, gradeNumeric: 80 }),    // → failedPicks (DUPLICATE_GAME)
    qualifiedPick({ edgeDecimal: 0.01 }),            // → failedPicks (EDGE_TOO_LOW)
    qualifiedPick({ americanOdds: null }),            // → noOddsPicks
    qualifiedPick({ riskLevel: 'HIGH' }),             // → failedPicks (HIGH_RISK)
    qualifiedPick({ gradeNumeric: 70 }),              // → topPicks
  ];
  const result = rankPicks(picks);
  assertNoDuplicateIds(result);
  assertInputsEqualsOutputs(picks, result);
  assert.strictEqual(result.topPicks.length,    2);
  assert.strictEqual(result.noOddsPicks.length, 1);
  if (result.failedPicks.length < 3) {
    throw new Error(`Expected at least 3 failedPicks, got ${result.failedPicks.length}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Status field integrity
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nstatus integrity');

test('all topPicks have status QUALIFIED', () => {
  const picks = [qualifiedPick(), qualifiedPick(), qualifiedPick()];
  const result = rankPicks(picks);
  for (const p of result.topPicks) {
    assert.strictEqual(p.status, 'QUALIFIED');
  }
});

test('all qualifiedPicks (overflow) have status QUALIFIED', () => {
  const picks = Array.from({ length: 8 }, () => qualifiedPick());
  const result = rankPicks(picks);
  for (const p of result.qualifiedPicks) {
    assert.strictEqual(p.status, 'QUALIFIED');
  }
});

test('topPicks picks have no failReason', () => {
  const picks = [qualifiedPick(), qualifiedPick()];
  const result = rankPicks(picks);
  for (const p of result.topPicks) {
    if (p.failReason !== undefined) {
      throw new Error(`topPick ${p.id} has failReason ${p.failReason}`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`ranking.engine — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
