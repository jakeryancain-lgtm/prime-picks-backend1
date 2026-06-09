import * as assert from 'assert';
import {
  mapPredictionToDbRow,
  mapPipelineOutputToDbRows,
  savePredictions,
  type ModelPredictionRow,
  type SupabaseClientLike,
  type SupabaseInsertResult,
} from '../src/services/results.service';
import type { ProcessedMLBPick } from '../src/mlbPipeline';
import type { RankedOutput } from '../src/engines/ranking.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      result
        .then(() => { console.log(`  ✓  ${name}`); passed++; })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          console.log(`  ✗  ${name}`);
          console.log(`       ${msg}`);
          failed++;
        });
    } else {
      console.log(`  ✓  ${name}`);
      passed++;
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗  ${name}`);
    console.log(`       ${msg}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase client
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records every insert call so tests can inspect what was sent to the DB.
 * Returns a configurable result to test both success and error paths.
 */
class FakeSupabaseClient implements SupabaseClientLike {
  public insertedRows: ModelPredictionRow[] = [];
  public callCount = 0;
  private simulateError: { message: string; code?: string } | null = null;

  setError(msg: string, code?: string) {
    this.simulateError = { message: msg, code };
  }

  from(_table: string) {
    return {
      insert: async (rows: unknown[]): Promise<SupabaseInsertResult> => {
        this.callCount++;
        this.insertedRows.push(...(rows as ModelPredictionRow[]));
        if (this.simulateError) {
          return { data: null, error: this.simulateError };
        }
        return { data: rows, error: null };
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let seq = 0;
function uid() { return `pick-${++seq}`; }

/** A fully processed qualified pick as it would come out of mlbPipeline. */
function qualifiedPick(overrides: Partial<ProcessedMLBPick> = {}): ProcessedMLBPick {
  return {
    id:                    uid(),
    modelVersionId:        'model-v1',
    gameId:                'game-001',
    team:                  'NYY',
    opponent:              'BOS',
    betType:               'moneyline',
    marketType:            'moneyline',
    runLineSpread:         null,
    americanOdds:          -115,
    decimalOdds:           1.8696,
    modelProbability:      0.64,
    confidence:            0.78,
    rawImpliedProbability: 0.5350,
    noVigProbability:      0.5144,
    impliedProbabilityUsed: 0.5144,
    probabilitySource:     'no-vig',
    edgeDecimal:           0.1256,
    edgePercent:           12.56,
    hasPositiveEdge:       true,
    edgeTier:              'ELITE',
    riskScore:             0,
    riskLevel:             'LOW',
    riskReasons:           [],
    gradeNumeric:          91.5,
    gradeLetter:           'A+',
    status:                'QUALIFIED',
    failReason:            undefined,
    ...overrides,
  } as ProcessedMLBPick;
}

/** A pick that failed the edge filter. */
function failedPick(overrides: Partial<ProcessedMLBPick> = {}): ProcessedMLBPick {
  return qualifiedPick({
    id:          uid(),
    gameId:      'game-002',
    team:        'CHC',
    edgeDecimal: 0.015,
    edgePercent: 1.5,
    edgeTier:    'LOW',
    gradeNumeric: 40,
    gradeLetter:  'F',
    status:      'FAILED_FILTER',
    failReason:  'EDGE_TOO_LOW',
    ...overrides,
  });
}

/** A pick with no live odds. */
function noOddsPick(overrides: Partial<ProcessedMLBPick> = {}): ProcessedMLBPick {
  return qualifiedPick({
    id:                    uid(),
    gameId:                'game-003',
    team:                  'MIL',
    americanOdds:          null,
    decimalOdds:           null,
    rawImpliedProbability: null,
    noVigProbability:      null,
    impliedProbabilityUsed: null,
    probabilitySource:     null,
    edgeDecimal:           0,
    edgePercent:           0,
    edgeTier:              'NEGATIVE',
    riskScore:             0,
    riskLevel:             'LOW',
    riskReasons:           [],
    gradeNumeric:          0,
    gradeLetter:           'NO_GRADE',
    status:                'NO_ODDS',
    failReason:            undefined,
    ...overrides,
  });
}

/** Minimal RankedOutput with picks spread across all four groups. */
function pipelineOutput(overrides: Partial<RankedOutput<ProcessedMLBPick>> = {}): RankedOutput<ProcessedMLBPick> {
  return {
    topPicks:      [qualifiedPick({ id: uid(), gameId: 'game-top-1', gradeNumeric: 92 })],
    qualifiedPicks: [qualifiedPick({ id: uid(), gameId: 'game-qual-1', gradeNumeric: 78 })],
    failedPicks:   [failedPick()],
    noOddsPicks:   [noOddsPick()],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mapPredictionToDbRow
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmapPredictionToDbRow');

// Required test 1: maps one qualified pick correctly
test('maps a qualified pick to the correct DB columns', () => {
  const pick = qualifiedPick();
  const row  = mapPredictionToDbRow(pick);

  assert.strictEqual(row.model_version_id,   pick.modelVersionId);
  assert.strictEqual(row.game_id,            pick.gameId);
  assert.strictEqual(row.sport,              'MLB');
  assert.strictEqual(row.league,             'MLB');
  assert.strictEqual(row.team,               pick.team);
  assert.strictEqual(row.opponent,           pick.opponent);
  assert.strictEqual(row.bet_type,           pick.betType);
  assert.strictEqual(row.market_type,        pick.marketType);
  assert.strictEqual(row.run_line_spread,    null);
  assert.strictEqual(row.american_odds,      pick.americanOdds);
  assert.strictEqual(row.decimal_odds,       pick.decimalOdds);
  assert.strictEqual(row.model_probability,  pick.modelProbability);
  assert.strictEqual(row.implied_probability, pick.rawImpliedProbability);
  assert.strictEqual(row.no_vig_probability, pick.noVigProbability);
  assert.strictEqual(row.probability_source, pick.probabilitySource);
  assert.strictEqual(row.edge_decimal,       pick.edgeDecimal);
  assert.strictEqual(row.edge_percent,       pick.edgePercent);
  assert.strictEqual(row.edge_tier,          pick.edgeTier);
  assert.strictEqual(row.confidence,         pick.confidence);
  assert.strictEqual(row.risk_score,         pick.riskScore);
  assert.strictEqual(row.risk_level,         pick.riskLevel);
  assert.strictEqual(row.grade_numeric,      pick.gradeNumeric);
  assert.strictEqual(row.grade_letter,       pick.gradeLetter);
  assert.strictEqual(row.status,             'QUALIFIED');
  assert.strictEqual(row.fail_reason,        null);
});

test('qualified pick has no fail_reason', () => {
  const row = mapPredictionToDbRow(qualifiedPick());
  assert.strictEqual(row.fail_reason, null);
});

test('probability_source is preserved as no-vig', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ probabilitySource: 'no-vig' }));
  assert.strictEqual(row.probability_source, 'no-vig');
});

test('probability_source is preserved as raw', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ probabilitySource: 'raw' }));
  assert.strictEqual(row.probability_source, 'raw');
});

test('riskReasons serialised as JSON array string', () => {
  const reasons = ['Low edge: 2.50% is below the 3% minimum'];
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: reasons }));
  const parsed = JSON.parse(row.risk_reasons_json);
  assert.deepStrictEqual(parsed, reasons);
});

test('empty riskReasons serialised as empty JSON array', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: [] }));
  assert.strictEqual(row.risk_reasons_json, '[]');
});

test('multiple riskReasons all preserved in JSON', () => {
  const reasons = ['reason one', 'reason two', 'reason three'];
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: reasons }));
  const parsed = JSON.parse(row.risk_reasons_json);
  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual(parsed, reasons);
});

// Required test 2: maps failed pick with failReason correctly
test('maps a failed pick with failReason EDGE_TOO_LOW', () => {
  const pick = failedPick({ failReason: 'EDGE_TOO_LOW' });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.status,      'FAILED_FILTER');
  assert.strictEqual(row.fail_reason, 'EDGE_TOO_LOW');
});

test('maps a failed pick with failReason BAD_ODDS_RANGE', () => {
  const pick = failedPick({ failReason: 'BAD_ODDS_RANGE' });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.fail_reason, 'BAD_ODDS_RANGE');
});

test('maps a failed pick with failReason EXCLUDED_RUN_LINE', () => {
  const pick = failedPick({ failReason: 'EXCLUDED_RUN_LINE' });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.fail_reason, 'EXCLUDED_RUN_LINE');
});

test('maps a failed pick with failReason HIGH_RISK', () => {
  const pick = failedPick({ failReason: 'HIGH_RISK' });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.fail_reason, 'HIGH_RISK');
});

test('maps a failed pick with failReason DUPLICATE_GAME', () => {
  const pick = failedPick({ failReason: 'DUPLICATE_GAME' });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.fail_reason, 'DUPLICATE_GAME');
});

test('failed pick still has all engine-computed fields preserved', () => {
  const pick = failedPick({ edgeDecimal: 0.015, riskScore: 25, gradeNumeric: 40 });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.edge_decimal,  0.015);
  assert.strictEqual(row.risk_score,    25);
  assert.strictEqual(row.grade_numeric, 40);
});

// Required test 3: maps no odds pick with grade 0 correctly
test('no-odds pick has grade_numeric=0 and grade_letter=NO_GRADE', () => {
  const pick = noOddsPick();
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.grade_numeric, 0);
  assert.strictEqual(row.grade_letter,  'NO_GRADE');
});

test('no-odds pick has status NO_ODDS', () => {
  const row = mapPredictionToDbRow(noOddsPick());
  assert.strictEqual(row.status, 'NO_ODDS');
});

test('no-odds pick has null american_odds and decimal_odds', () => {
  const row = mapPredictionToDbRow(noOddsPick());
  assert.strictEqual(row.american_odds,  null);
  assert.strictEqual(row.decimal_odds,   null);
});

test('no-odds pick has null no_vig_probability and implied_probability', () => {
  const row = mapPredictionToDbRow(noOddsPick());
  assert.strictEqual(row.no_vig_probability, null);
  assert.strictEqual(row.implied_probability, null);
});

test('no-odds pick has null probability_source', () => {
  const row = mapPredictionToDbRow(noOddsPick());
  assert.strictEqual(row.probability_source, null);
});

test('no-odds pick has no fail_reason', () => {
  const row = mapPredictionToDbRow(noOddsPick());
  assert.strictEqual(row.fail_reason, null);
});

// Required test 5: throws if modelVersionId is missing
test('throws if modelVersionId is an empty string', () => {
  assert.throws(
    () => mapPredictionToDbRow(qualifiedPick({ modelVersionId: '' })),
    /modelVersionId/,
  );
});

test('throws if modelVersionId is whitespace only', () => {
  assert.throws(
    () => mapPredictionToDbRow(qualifiedPick({ modelVersionId: '   ' })),
    /modelVersionId/,
  );
});

test('run_line_spread is preserved when set', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: -1.5 });
  const row  = mapPredictionToDbRow(pick);
  assert.strictEqual(row.run_line_spread, -1.5);
});

test('run_line_spread is null when not a run line pick', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ betType: 'moneyline', runLineSpread: null }));
  assert.strictEqual(row.run_line_spread, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// mapPipelineOutputToDbRows
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmapPipelineOutputToDbRows');

// Required test 4: maps all groups from pipeline output
test('maps all four groups into a single flat array', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  const expectedCount =
    output.topPicks.length +
    output.qualifiedPicks.length +
    output.failedPicks.length +
    output.noOddsPicks.length;
  assert.strictEqual(rows.length, expectedCount);
});

test('all picks from topPicks appear in rows', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  for (const pick of output.topPicks) {
    const found = rows.some(r => r.game_id === pick.gameId && r.team === pick.team);
    if (!found) throw new Error(`topPick ${pick.id} not found in rows`);
  }
});

test('all picks from failedPicks appear in rows with failReason', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  for (const pick of output.failedPicks) {
    const found = rows.find(r => r.game_id === pick.gameId && r.team === pick.team);
    if (!found) throw new Error(`failedPick ${pick.id} not found in rows`);
    if (!found.fail_reason) throw new Error(`failedPick ${pick.id} missing fail_reason`);
  }
});

test('all picks from noOddsPicks appear in rows with grade 0', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  for (const pick of output.noOddsPicks) {
    const found = rows.find(r => r.game_id === pick.gameId && r.team === pick.team);
    if (!found) throw new Error(`noOddsPick ${pick.id} not found in rows`);
    if (found.grade_numeric !== 0) {
      throw new Error(`noOddsPick should have grade 0, got ${found.grade_numeric}`);
    }
  }
});

// Required test 7: no pick is skipped
test('row count matches total picks across all groups', () => {
  const top   = [qualifiedPick({ id: uid() }), qualifiedPick({ id: uid() })];
  const qual  = [qualifiedPick({ id: uid() })];
  const fail  = [failedPick(), failedPick({ failReason: 'HIGH_RISK' })];
  const noOdds = [noOddsPick(), noOddsPick()];
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks: top, qualifiedPicks: qual, failedPicks: fail, noOddsPicks: noOdds,
  };
  const rows = mapPipelineOutputToDbRows(output);
  assert.strictEqual(rows.length, top.length + qual.length + fail.length + noOdds.length);
});

test('empty pipeline output returns empty array', () => {
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
  };
  const rows = mapPipelineOutputToDbRows(output);
  assert.strictEqual(rows.length, 0);
});

test('no pick id is duplicated in output rows', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  const ids    = rows.map(r => `${r.game_id}:${r.team}`);
  const unique = new Set(ids);
  assert.strictEqual(unique.size, ids.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// savePredictions — async tests using FakeSupabaseClient
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsavePredictions (async)');

// Run async tests and wait for all to settle
const asyncTests: Promise<void>[] = [];

function asyncTest(name: string, fn: () => Promise<void>) {
  const p = fn().then(() => {
    console.log(`  ✓  ${name}`);
    passed++;
  }).catch((e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  ✗  ${name}`);
    console.log(`       ${msg}`);
    failed++;
  });
  asyncTests.push(p);
}

// Required test 6: fake Supabase insert is called with every row
asyncTest('fake insert is called once with all rows', async () => {
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput());
  await savePredictions(rows, client);
  assert.strictEqual(client.callCount, 1);
  assert.strictEqual(client.insertedRows.length, rows.length);
});

asyncTest('every row sent to fake client matches the mapped output', async () => {
  const client = new FakeSupabaseClient();
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  assert.strictEqual(client.insertedRows.length, rows.length);
  for (let i = 0; i < rows.length; i++) {
    assert.deepStrictEqual(client.insertedRows[i], rows[i]);
  }
});

asyncTest('save returns savedCount equal to row count on success', async () => {
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput());
  const result = await savePredictions(rows, client);
  assert.strictEqual(result.savedCount, rows.length);
  assert.strictEqual(result.errors.length, 0);
});

asyncTest('save returns errors array when Supabase reports an error', async () => {
  const client = new FakeSupabaseClient();
  client.setError('duplicate key value violates unique constraint', '23505');
  const rows   = mapPipelineOutputToDbRows(pipelineOutput());
  const result = await savePredictions(rows, client);
  assert.strictEqual(result.savedCount, 0);
  assert.strictEqual(result.errors.length, 1);
  assert.ok(result.errors[0]!.message.includes('duplicate key'));
});

asyncTest('save with empty rows returns 0 saved and does not call insert', async () => {
  const client = new FakeSupabaseClient();
  const result = await savePredictions([], client);
  assert.strictEqual(result.savedCount, 0);
  assert.strictEqual(result.errors.length, 0);
  assert.strictEqual(client.callCount, 0);
});

asyncTest('failed picks in saved rows preserve fail_reason', async () => {
  const client = new FakeSupabaseClient();
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks:      [],
    qualifiedPicks: [],
    failedPicks:   [
      failedPick({ failReason: 'EDGE_TOO_LOW'    }),
      failedPick({ failReason: 'HIGH_RISK'       }),
      failedPick({ failReason: 'DUPLICATE_GAME'  }),
    ],
    noOddsPicks:   [],
  };
  const rows = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  const reasons = client.insertedRows.map(r => r.fail_reason);
  assert.ok(reasons.includes('EDGE_TOO_LOW'));
  assert.ok(reasons.includes('HIGH_RISK'));
  assert.ok(reasons.includes('DUPLICATE_GAME'));
});

asyncTest('no-odds picks in saved rows have grade_numeric=0 and grade_letter=NO_GRADE', async () => {
  const client = new FakeSupabaseClient();
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks: [], qualifiedPicks: [], failedPicks: [],
    noOddsPicks: [noOddsPick(), noOddsPick()],
  };
  const rows = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  for (const row of client.insertedRows) {
    assert.strictEqual(row.grade_numeric, 0);
    assert.strictEqual(row.grade_letter, 'NO_GRADE');
  }
});

asyncTest('qualified picks in saved rows have no fail_reason', async () => {
  const client = new FakeSupabaseClient();
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks:      [qualifiedPick()],
    qualifiedPicks: [qualifiedPick()],
    failedPicks:   [],
    noOddsPicks:   [],
  };
  const rows = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  for (const row of client.insertedRows) {
    assert.strictEqual(row.fail_reason, null);
  }
});

asyncTest('all four groups saved together in one insert call', async () => {
  const client = new FakeSupabaseClient();
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  // All groups in one call
  assert.strictEqual(client.callCount, 1);
  // Count of rows from each group
  const totalExpected =
    output.topPicks.length +
    output.qualifiedPicks.length +
    output.failedPicks.length +
    output.noOddsPicks.length;
  assert.strictEqual(client.insertedRows.length, totalExpected);
});

asyncTest('status field is correctly saved for each group', async () => {
  const client = new FakeSupabaseClient();
  const topPick   = qualifiedPick({ id: uid(), gameId: 'g-top',  status: 'QUALIFIED' });
  const qualPick  = qualifiedPick({ id: uid(), gameId: 'g-qual', status: 'QUALIFIED' });
  const failPick  = failedPick  ({ failReason: 'EDGE_TOO_LOW'                        });
  const noOPick   = noOddsPick  ({                                                    });
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks: [topPick], qualifiedPicks: [qualPick],
    failedPicks: [failPick], noOddsPicks: [noOPick],
  };
  const rows = mapPipelineOutputToDbRows(output);
  await savePredictions(rows, client);
  const statuses = client.insertedRows.map(r => r.status);
  assert.ok(statuses.includes('QUALIFIED'));
  assert.ok(statuses.includes('FAILED_FILTER'));
  assert.ok(statuses.includes('NO_ODDS'));
});

asyncTest('error from Supabase includes error code when provided', async () => {
  const client = new FakeSupabaseClient();
  client.setError('relation does not exist', '42P01');
  const result = await savePredictions([mapPredictionToDbRow(qualifiedPick())], client);
  assert.strictEqual(result.errors[0]!.code, '42P01');
});

// ─────────────────────────────────────────────────────────────────────────────
// Full pipeline → save integration smoke test
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nend-to-end smoke test');

asyncTest('full pipeline output → map → save is internally consistent', async () => {
  const { runMLBPipeline } = await import('../src/mlbPipeline');
  const { STRONG_MONEYLINE_FIXTURE, NO_ODDS_FIXTURE, FAILED_EDGE_FIXTURE } =
    await import('./fixtures/samplePicks');

  const { output } = runMLBPipeline([
    STRONG_MONEYLINE_FIXTURE,
    NO_ODDS_FIXTURE,
    FAILED_EDGE_FIXTURE,
  ]);

  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(output);
  const result = await savePredictions(rows, client);

  // All 3 input picks must appear in DB rows
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(result.savedCount, 3);
  assert.strictEqual(result.errors.length, 0);

  // No-odds pick must have grade 0
  const noOddsRow = client.insertedRows.find(r => r.american_odds === null);
  if (!noOddsRow) throw new Error('No-odds row not found');
  assert.strictEqual(noOddsRow.grade_numeric, 0);
  assert.strictEqual(noOddsRow.grade_letter, 'NO_GRADE');

  // Failed edge pick must have fail_reason
  const failedRow = client.insertedRows.find(r => r.status === 'FAILED_FILTER');
  if (!failedRow) throw new Error('Failed row not found');
  assert.strictEqual(failedRow.fail_reason, 'EDGE_TOO_LOW');
});

// ─────────────────────────────────────────────────────────────────────────────
// Wait for async tests then print summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`results.service — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
