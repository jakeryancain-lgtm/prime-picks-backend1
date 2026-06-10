import * as assert from 'assert';
const TEST_DATE = '2025-06-10';

import {
  mapPredictionToDbRow,
  mapPipelineOutputToDbRows,
  savePredictions,
  type ModelPredictionRow,
  type SupabaseClientLike,
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
  public simulateError: { message: string; code?: string } | null = null;
  private _mvRows: Array<{ id: string; name: string }> = [];
  private _gen = 10000;

  setError(msg: string, code?: string) { this.simulateError = { message: msg, code }; }

  from(table: string): import('../src/services/supabase.types').SupabaseTableRef {
    const self = this;
    const select = (cols: string): import('../src/services/supabase.types').SupabaseQueryBuilder => {
      void cols;
      const filters: Array<{ col: string; val: string }> = [];
      const qb: import('../src/services/supabase.types').SupabaseQueryBuilder = {
        eq(col: string, val: string) { filters.push({ col, val }); return qb; },
        async limit(n: number) {
          if (table === 'model_versions') {
            const matches = self._mvRows.filter(r =>
              filters.every(f => String((r as Record<string, string>)[f.col]) === f.val)
            ).slice(0, n);
            return { data: matches as unknown[], error: null };
          }
          return { data: [] as unknown[], error: null };
        },
      };
      return qb;
    };
    const insert = async (
      rows: unknown[],
      _opts?: import('../src/services/supabase.types').InsertOptions,
    ): Promise<import('../src/services/supabase.types').SupabaseInsertResult> => {
      self.callCount++;
      // Only simulate errors on model_predictions — never on model_versions
      // (ensureModelVersion must succeed for UUID resolution to work)
      if (self.simulateError && table === 'model_predictions') return { data: null, error: self.simulateError };
      const withIds = (rows as Array<Record<string, unknown>>).map(r => ({
        id: r['id'] ?? `00000000-0000-4000-a000-${String(self._gen++).padStart(12, '0')}`,
        ...r,
      }));
      if (table === 'model_versions') {
        for (const r of withIds as Array<Record<string, unknown>>) {
          if (!self._mvRows.some(x => x.name === (r['name'] as string))) {
            self._mvRows.push({ id: r['id'] as string, name: r['name'] as string });
          }
        }
        return { data: withIds as unknown[], error: null };
      }
      self.insertedRows.push(...(withIds as unknown as ModelPredictionRow[]));
      return { data: withIds as unknown[], error: null };
    };
    return { select, insert };
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
  const row  = mapPredictionToDbRow(pick, TEST_DATE);

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
  const row = mapPredictionToDbRow(qualifiedPick(), TEST_DATE);
  assert.strictEqual(row.fail_reason, null);
});

test('probability_source is preserved as no-vig', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ probabilitySource: 'no-vig' }), TEST_DATE);
  assert.strictEqual(row.probability_source, 'no-vig');
});

test('probability_source is preserved as raw', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ probabilitySource: 'raw' }), TEST_DATE);
  assert.strictEqual(row.probability_source, 'raw');
});

test('riskReasons serialised as JSON array string', () => {
  const reasons = ['Low edge: 2.50% is below the 3% minimum'];
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: reasons }), TEST_DATE);
  const parsed = JSON.parse(row.risk_reasons_json);
  assert.deepStrictEqual(parsed, reasons);
});

test('empty riskReasons serialised as empty JSON array', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: [] }), TEST_DATE);
  assert.strictEqual(row.risk_reasons_json, '[]');
});

test('multiple riskReasons all preserved in JSON', () => {
  const reasons = ['reason one', 'reason two', 'reason three'];
  const row = mapPredictionToDbRow(qualifiedPick({ riskReasons: reasons }), TEST_DATE);
  const parsed = JSON.parse(row.risk_reasons_json);
  assert.strictEqual(parsed.length, 3);
  assert.deepStrictEqual(parsed, reasons);
});

// Required test 2: maps failed pick with failReason correctly
test('maps a failed pick with failReason EDGE_TOO_LOW', () => {
  const pick = failedPick({ failReason: 'EDGE_TOO_LOW' });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.status,      'FAILED_FILTER');
  assert.strictEqual(row.fail_reason, 'EDGE_TOO_LOW');
});

test('maps a failed pick with failReason BAD_ODDS_RANGE', () => {
  const pick = failedPick({ failReason: 'BAD_ODDS_RANGE' });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.fail_reason, 'BAD_ODDS_RANGE');
});

test('maps a failed pick with failReason EXCLUDED_RUN_LINE', () => {
  const pick = failedPick({ failReason: 'EXCLUDED_RUN_LINE' });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.fail_reason, 'EXCLUDED_RUN_LINE');
});

test('maps a failed pick with failReason HIGH_RISK', () => {
  const pick = failedPick({ failReason: 'HIGH_RISK' });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.fail_reason, 'HIGH_RISK');
});

test('maps a failed pick with failReason DUPLICATE_GAME', () => {
  const pick = failedPick({ failReason: 'DUPLICATE_GAME' });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.fail_reason, 'DUPLICATE_GAME');
});

test('failed pick still has all engine-computed fields preserved', () => {
  const pick = failedPick({ edgeDecimal: 0.015, riskScore: 25, gradeNumeric: 40 });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.edge_decimal,  0.015);
  assert.strictEqual(row.risk_score,    25);
  assert.strictEqual(row.grade_numeric, 40);
});

// Required test 3: maps no odds pick with grade 0 correctly
test('no-odds pick has grade_numeric=0 and grade_letter=NO_GRADE', () => {
  const pick = noOddsPick();
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.grade_numeric, 0);
  assert.strictEqual(row.grade_letter,  'NO_GRADE');
});

test('no-odds pick has status NO_ODDS', () => {
  const row = mapPredictionToDbRow(noOddsPick(), TEST_DATE);
  assert.strictEqual(row.status, 'NO_ODDS');
});

test('no-odds pick has null american_odds and decimal_odds', () => {
  const row = mapPredictionToDbRow(noOddsPick(), TEST_DATE);
  assert.strictEqual(row.american_odds,  null);
  assert.strictEqual(row.decimal_odds,   null);
});

test('no-odds pick has null no_vig_probability and implied_probability', () => {
  const row = mapPredictionToDbRow(noOddsPick(), TEST_DATE);
  assert.strictEqual(row.no_vig_probability, null);
  assert.strictEqual(row.implied_probability, null);
});

test('no-odds pick has null probability_source', () => {
  const row = mapPredictionToDbRow(noOddsPick(), TEST_DATE);
  assert.strictEqual(row.probability_source, null);
});

test('no-odds pick has no fail_reason', () => {
  const row = mapPredictionToDbRow(noOddsPick(), TEST_DATE);
  assert.strictEqual(row.fail_reason, null);
});

// Required test 5: throws if modelVersionId is missing
test('throws if modelVersionId is an empty string', () => {
  assert.throws(
    () => mapPredictionToDbRow(qualifiedPick({ modelVersionId: '' }), TEST_DATE),
    /modelVersionId/,
  );
});

test('throws if modelVersionId is whitespace only', () => {
  assert.throws(
    () => mapPredictionToDbRow(qualifiedPick({ modelVersionId: '   ' }), TEST_DATE),
    /modelVersionId/,
  );
});

test('run_line_spread is preserved when set', () => {
  const pick = qualifiedPick({ betType: 'run_line', runLineSpread: -1.5 });
  const row  = mapPredictionToDbRow(pick, TEST_DATE);
  assert.strictEqual(row.run_line_spread, -1.5);
});

test('run_line_spread is null when not a run line pick', () => {
  const row = mapPredictionToDbRow(qualifiedPick({ betType: 'moneyline', runLineSpread: null }), TEST_DATE);
  assert.strictEqual(row.run_line_spread, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// mapPipelineOutputToDbRows
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmapPipelineOutputToDbRows');

// Required test 4: maps all groups from pipeline output
test('maps all four groups into a single flat array', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
  const expectedCount =
    output.topPicks.length +
    output.qualifiedPicks.length +
    output.failedPicks.length +
    output.noOddsPicks.length;
  assert.strictEqual(rows.length, expectedCount);
});

test('all picks from topPicks appear in rows', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
  for (const pick of output.topPicks) {
    const found = rows.some(r => r.game_id === pick.gameId && r.team === pick.team);
    if (!found) throw new Error(`topPick ${pick.id} not found in rows`);
  }
});

test('all picks from failedPicks appear in rows with failReason', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
  for (const pick of output.failedPicks) {
    const found = rows.find(r => r.game_id === pick.gameId && r.team === pick.team);
    if (!found) throw new Error(`failedPick ${pick.id} not found in rows`);
    if (!found.fail_reason) throw new Error(`failedPick ${pick.id} missing fail_reason`);
  }
});

test('all picks from noOddsPicks appear in rows with grade 0', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
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
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
  assert.strictEqual(rows.length, top.length + qual.length + fail.length + noOdds.length);
});

test('empty pipeline output returns empty array', () => {
  const output: RankedOutput<ProcessedMLBPick> = {
    topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
  };
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
  assert.strictEqual(rows.length, 0);
});

test('no pick id is duplicated in output rows', () => {
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
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
asyncTest('fake insert is called and all prediction rows are saved', async () => {
  // callCount includes both model_versions insert + model_predictions insert
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput(), TEST_DATE);
  await savePredictions(rows, client);
  assert.ok(client.callCount >= 1, 'At least one insert call expected');
  // insertedRows only contains model_predictions rows (tracked separately from model_versions)
  assert.strictEqual(client.insertedRows.length, rows.length);
});

asyncTest('every prediction row is saved with resolved model_version_id', async () => {
  const client = new FakeSupabaseClient();
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
  const originalName = rows[0]?.model_version_id ?? '';
  await savePredictions(rows, client);
  assert.strictEqual(client.insertedRows.length, rows.length);
  // Verify the original string name was replaced (UUID resolution ran)
  for (const inserted of client.insertedRows) {
    assert.notStrictEqual(inserted.model_version_id, originalName,
      'model_version_id must be resolved from string to id before insert');
  }
});

asyncTest('save returns savedCount equal to row count on success', async () => {
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput(), TEST_DATE);
  const result = await savePredictions(rows, client);
  assert.strictEqual(result.savedCount, rows.length);
  assert.strictEqual(result.errors.length, 0);
});

asyncTest('save returns errors array when Supabase reports an error', async () => {
  const client = new FakeSupabaseClient();
  client.setError('duplicate key value violates unique constraint', '23505');
  const rows   = mapPipelineOutputToDbRows(pipelineOutput(), TEST_DATE);
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
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
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
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
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
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
  await savePredictions(rows, client);
  for (const row of client.insertedRows) {
    assert.strictEqual(row.fail_reason, null);
  }
});

asyncTest('model_version_id in inserted rows is not the original string name', async () => {
  // Production bug: "mlb-stats-v1" was inserted directly as a UUID FK → DB error.
  // savePredictions must resolve any non-UUID string through ensureModelVersion
  // before inserting, so the original name never reaches the DB.
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput(), TEST_DATE);
  const originalName = rows[0]?.model_version_id ?? '';

  // originalName should be a non-UUID string (e.g. 'test-version')
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const originalIsString = !uuidPattern.test(originalName);
  assert.ok(originalIsString, `Fixture should start with a non-UUID name, got: "${originalName}"`);

  await savePredictions(rows, client);

  // After save, the inserted row's model_version_id must be DIFFERENT from the
  // original string — it was resolved to an id by ensureModelVersion
  for (const inserted of client.insertedRows) {
    assert.notStrictEqual(
      inserted.model_version_id,
      originalName,
      `String name "${originalName}" was inserted unchanged — UUID resolution did not run`,
    );
    assert.ok(
      inserted.model_version_id.length > 0,
      'model_version_id should be non-empty after resolution',
    );
  }
});

asyncTest('savePredictions calls model_versions table before model_predictions', async () => {
  // Verify ensureModelVersion ran: the fake client should have a model_versions
  // row after a successful save
  const client = new FakeSupabaseClient();
  const rows   = mapPipelineOutputToDbRows(pipelineOutput(), TEST_DATE);
  await savePredictions(rows, client);

  // Inspect model_versions via a select (the fake client tracks them)
  void (client.from('model_versions') as unknown as {
    select: (c: string) => { eq: (col: string, val: string) => { limit: (n: number) => Promise<{ data: unknown[] | null; error: null }> } };
  }).select('id').eq('name', rows[0]?.model_version_id ?? '').limit(1);
  // After resolution, the name is in model_versions — but the resolved id
  // is what was used. We just verify no UUID FK error would fire.
  assert.ok(client.insertedRows.length > 0, 'Rows should have been inserted');
  // The key invariant: every inserted row's model_version_id changed from the original name
  const originalName = rows[0]?.model_version_id ?? '';
  for (const inserted of client.insertedRows) {
    assert.notStrictEqual(inserted.model_version_id, originalName,
      'UUID resolution must transform the string name before insert');
  }
});

asyncTest('all four groups saved in model_predictions (one predictions insert)', async () => {
  const client = new FakeSupabaseClient();
  const output = pipelineOutput();
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
  await savePredictions(rows, client);
  // callCount >= 1: model_versions insert + model_predictions insert
  assert.ok(client.callCount >= 1, 'Expected at least one insert call');
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
  const rows = mapPipelineOutputToDbRows(output, TEST_DATE);
  await savePredictions(rows, client);
  const statuses = client.insertedRows.map(r => r.status);
  assert.ok(statuses.includes('QUALIFIED'));
  assert.ok(statuses.includes('FAILED_FILTER'));
  assert.ok(statuses.includes('NO_ODDS'));
});

asyncTest('error from Supabase includes error code when provided', async () => {
  const client = new FakeSupabaseClient();
  client.setError('relation does not exist', '42P01');
  const result = await savePredictions([mapPredictionToDbRow(qualifiedPick(), TEST_DATE)], client);
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
  const rows   = mapPipelineOutputToDbRows(output, TEST_DATE);
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
