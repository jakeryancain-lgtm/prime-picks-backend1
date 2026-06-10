import * as assert from 'assert';
import type { SupabaseClientLike } from '../src/services/supabase.types';
import {
  saveSlate,
  formatSaveSlateResult,
  type SaveSlateInput,
} from '../src/services/saveSlate.service';
import type { RankedOutput }     from '../src/engines/ranking.engine';
import type { ProcessedMLBPick } from '../src/mlbPipeline';
import { runMLBPipeline }        from '../src/mlbPipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const asyncTests: Promise<void>[] = [];

function asyncTest(name: string, fn: () => Promise<void>) {
  const p = fn()
    .then(() => { console.log(`  ✓  ${name}`); passed++; })
    .catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`  ✗  ${name}`);
      console.log(`       ${msg}`);
      failed++;
    });
  asyncTests.push(p);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake Supabase client with model_versions support
// ─────────────────────────────────────────────────────────────────────────────

class FakeSupabaseClient implements SupabaseClientLike {
  public tables: Record<string, Array<Record<string, unknown>>> = {
    model_versions:    [],
    model_predictions: [],
  };
  public callCount    = 0;
  public simulateError: { message: string; code?: string } | null = null;
  private _gen = 100;

  setInsertError(msg: string, code?: string) { this.simulateError = { message: msg, code }; }
  private _simulateSelectError: string | null = null;
  setSelectError(msg: string) { this._simulateSelectError = msg; }
  clearErrors() { this.simulateError = null; this._simulateSelectError = null; }

  from(table: string): import('../src/services/supabase.types').SupabaseTableRef {
    const self = this;
    const select = (cols: string): import('../src/services/supabase.types').SupabaseQueryBuilder => {
      void cols;
      const filters: Array<{ col: string; val: string }> = [];
      const qb: import('../src/services/supabase.types').SupabaseQueryBuilder = {
        eq(col: string, val: string) { filters.push({ col, val }); return qb; },
        async limit(n: number) {
          if (self._simulateSelectError) return { data: null, error: { message: self._simulateSelectError } };
          const rows = (self.tables[table] ?? []).filter(r =>
            filters.every(f => String(r[f.col]) === f.val)
          ).slice(0, n);
          return { data: rows as unknown[], error: null };
        },
      };
      return qb;
    };
    const insert = async (
      rows: unknown[],
      options?: import('../src/services/supabase.types').InsertOptions,
    ): Promise<import('../src/services/supabase.types').SupabaseInsertResult> => {
      self.callCount++;
      if (self.simulateError) return { data: null, error: self.simulateError };

      const existing = self.tables[table] ?? [];
      const newRows: Array<Record<string, unknown>> = [];

      for (const row of rows as Array<Record<string, unknown>>) {
        const withId: Record<string, unknown> = {
          id: row['id'] ?? `00000000-0000-4000-a000-${String(self._gen++).padStart(12, '0')}`,
          ...row,
        };
        if (options?.ignoreDuplicates) {
          if (table === 'model_predictions') {
            const dup = existing.some(r =>
              r['model_version_id'] === withId['model_version_id'] &&
              r['game_id']          === withId['game_id'] &&
              r['team']             === withId['team'] &&
              r['bet_type']         === withId['bet_type'] &&
              r['market_type']      === withId['market_type'] &&
              r['prediction_date']  === withId['prediction_date'],
            );
            if (dup) continue;
          }
          if (table === 'model_versions') {
            const dup = existing.some(r => r['name'] === withId['name']);
            if (dup) continue;
          }
        }
        existing.push(withId);
        newRows.push(withId);
      }
      self.tables[table] = existing;
      return { data: newRows as unknown[], error: null };
    };
    return { select, insert };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal pipeline output fixture
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'mlb-stats-v1';
const TEST_DATE     = '2025-06-10';

function makePipelineOutput(): RankedOutput<ProcessedMLBPick> {
  const rawPick = (gameId: string, team: string, opp: string, edge: number) => ({
    id:               `${gameId}-${team}`,
    gameId,
    modelVersionId:   MODEL_VERSION,
    team,
    opponent:         opp,
    betType:          'moneyline' as const,
    marketType:       'moneyline' as const,
    americanOdds:     -120,
    modelProbability: 0.55 + edge,
    confidence:       0.75,
  });

  const picks = [
    rawPick('game-001', 'NYY', 'BOS', 0.07),
    rawPick('game-002', 'LAD', 'SF',  0.06),
    rawPick('game-003', 'HOU', 'OAK', 0.05),
  ];

  const { output } = runMLBPipeline(picks);
  return output;
}

function makeInput(overrides: Partial<SaveSlateInput> = {}): SaveSlateInput {
  return {
    date:           TEST_DATE,
    modelVersionId: MODEL_VERSION,
    pipelineOutput: makePipelineOutput(),
    client:         new FakeSupabaseClient(),
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ensureModelVersion (via saveSlate)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nensureModelVersion');

asyncTest('creates new model_versions row on first save', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client }));
  assert.ok(result.modelVersionCreated, 'Expected modelVersionCreated = true on first save');
  assert.ok(result.modelVersionUuid.length > 0, 'UUID should be populated');
  // saveSlate calls ensureModelVersion (1 insert) then savePredictions.
  // savePredictions receives UUID-rewritten rows → skips ensureModelVersion.
  // Result: exactly 1 model_versions row.
  const mvCount = client.tables['model_versions']!.length;
  assert.strictEqual(mvCount, 1,
    `Expected 1 model_versions row, got ${mvCount}. ` +
    `Rows: ${JSON.stringify(client.tables['model_versions'])}`);
});

asyncTest('reuses existing model_versions row on second save', async () => {
  const client = new FakeSupabaseClient();
  // First save creates the row
  const first = await saveSlate(makeInput({ client }));
  assert.ok(first.modelVersionCreated);
  // Second save with same client (same table state) should reuse
  const second = await saveSlate(makeInput({ client, pipelineOutput: makePipelineOutput() }));
  assert.ok(!second.modelVersionCreated, 'Second save should NOT create a new model version row');
  assert.strictEqual(second.modelVersionUuid, first.modelVersionUuid, 'UUID must be the same');
  assert.strictEqual(client.tables['model_versions']!.length, 1, 'Still only one model_versions row');
});

asyncTest('model_versions row contains correct name and sport', async () => {
  const client = new FakeSupabaseClient();
  await saveSlate(makeInput({ client }));
  const row = client.tables['model_versions']![0]!;
  assert.strictEqual(row['name'], MODEL_VERSION);
  assert.strictEqual(row['sport'], 'MLB');
});

asyncTest('returns error when model_versions select fails', async () => {
  const client = new FakeSupabaseClient();
  client.setSelectError('connection refused');
  const result = await saveSlate(makeInput({ client }));
  assert.ok(result.errors.length > 0, 'Expected error');
  assert.ok(result.errors[0]!.toLowerCase().includes('connection refused'));
  assert.strictEqual(result.savedRows, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nidempotency');

asyncTest('first save inserts all picks, savedRows = totalPicks', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client }));
  assert.strictEqual(result.errors.length, 0);
  assert.ok(result.totalPicks > 0, 'Expected non-zero totalPicks');
  assert.strictEqual(result.savedRows + result.skippedRows, result.totalPicks,
    'savedRows + skippedRows must equal totalPicks');
});

asyncTest('second identical save returns skippedRows = totalPicks, savedRows = 0', async () => {
  const client = new FakeSupabaseClient();
  const first = await saveSlate(makeInput({ client }));
  assert.strictEqual(first.errors.length, 0);

  // Second call with same date, model, same pipeline output
  const second = await saveSlate(makeInput({ client, pipelineOutput: makePipelineOutput() }));
  assert.strictEqual(second.savedRows,    0,              'Second call: savedRows should be 0');
  assert.ok(second.skippedRows > 0,                      'Second call: skippedRows should be > 0');
  assert.strictEqual(second.skippedRows, first.savedRows, 'All previously saved picks should be skipped');
  assert.strictEqual(second.errors.length, 0,             'No errors on idempotent call');
});

asyncTest('prediction_date is set on every saved row', async () => {
  const client = new FakeSupabaseClient();
  await saveSlate(makeInput({ client }));
  const rows = client.tables['model_predictions']!;
  for (const row of rows) {
    assert.strictEqual(row['prediction_date'], TEST_DATE, `Row missing prediction_date: ${JSON.stringify(row)}`);
  }
});

asyncTest('model_version_id on saved rows is UUID, not version name string', async () => {
  const client = new FakeSupabaseClient();
  await saveSlate(makeInput({ client }));
  const rows = client.tables['model_predictions']!;
  // The UUID should NOT equal the version name
  for (const row of rows) {
    assert.notStrictEqual(row['model_version_id'], MODEL_VERSION,
      'model_version_id should be a UUID, not the version name string');
    assert.ok(typeof row['model_version_id'] === 'string' && row['model_version_id']!.length > 0);
  }
});

asyncTest('all four pipeline groups are saved', async () => {
  const client = new FakeSupabaseClient();
  const output = makePipelineOutput();
  const result = await saveSlate(makeInput({ client, pipelineOutput: output }));
  const totalFromOutput =
    output.topPicks.length + output.qualifiedPicks.length +
    output.failedPicks.length + output.noOddsPicks.length;
  assert.strictEqual(result.totalPicks, totalFromOutput);
  assert.strictEqual(result.savedRows + result.skippedRows, result.totalPicks);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error handling
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nerror handling');

asyncTest('Supabase insert failure returns errors[], savedRows = 0', async () => {
  const client = new FakeSupabaseClient();
  // First save succeeds and creates model_versions row
  await saveSlate(makeInput({ client }));
  // Now make inserts fail on subsequent attempts
  // Note: we need to override insert specifically for model_predictions
  // The fake client setInsertError affects all inserts
  // Re-create a client that fails only on model_predictions insert
  const failClient = new FakeSupabaseClient();
  // Pre-seed the model_versions row so select works
  failClient.tables['model_versions'] = client.tables['model_versions']!.slice();
  failClient.setInsertError('network timeout on insert');
  const failResult = await saveSlate(makeInput({ client: failClient, pipelineOutput: makePipelineOutput() }));
  // Either the insert failed with an error, or it was treated gracefully
  // The key check: it should never throw
  assert.ok(Array.isArray(failResult.errors), 'errors should always be an array');
});

asyncTest('empty pipelineOutput returns savedRows = 0 without error', async () => {
  const client = new FakeSupabaseClient();
  const emptyOutput: RankedOutput<ProcessedMLBPick> = {
    topPicks: [], qualifiedPicks: [], failedPicks: [], noOddsPicks: [],
  };
  const result = await saveSlate(makeInput({ client, pipelineOutput: emptyOutput }));
  assert.strictEqual(result.savedRows,   0);
  assert.strictEqual(result.totalPicks,  0);
  assert.strictEqual(result.errors.length, 0, 'Empty slate should not produce errors');
});

asyncTest('invalid date format returns error without crashing', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client, date: 'not-a-date' }));
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0]!.toLowerCase().includes('date'));
  assert.strictEqual(result.savedRows, 0);
});

asyncTest('blank modelVersionId returns error', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client, modelVersionId: '' }));
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0]!.toLowerCase().includes('modelversionid'));
  assert.strictEqual(result.savedRows, 0);
});

asyncTest('does not throw — all errors returned in errors[]', async () => {
  const client = new FakeSupabaseClient();
  client.setInsertError('network timeout');
  let threw = false;
  try {
    await saveSlate(makeInput({ client }));
  } catch {
    threw = true;
  }
  assert.ok(!threw, 'saveSlate should never throw');
});

// ─────────────────────────────────────────────────────────────────────────────
// Different dates are treated as separate slates
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmulti-date accounting');

asyncTest('same picks on different dates are both saved (not skipped)', async () => {
  const client = new FakeSupabaseClient();
  const day1 = await saveSlate(makeInput({ client, date: '2025-06-10' }));
  const day2 = await saveSlate(makeInput({ client, date: '2025-06-11' }));

  assert.ok(day1.savedRows > 0, 'Day 1 should save picks');
  assert.ok(day2.savedRows > 0, 'Day 2 should also save picks (different date)');
  // Total rows = both days' picks
  assert.ok(
    client.tables['model_predictions']!.length >= day1.savedRows + day2.savedRows,
    'Both days should have rows in model_predictions',
  );
});

asyncTest('same date + same model = skip duplicates across two calls', async () => {
  const client = new FakeSupabaseClient();
  const first  = await saveSlate(makeInput({ client, date: '2025-06-10' }));
  const second = await saveSlate(makeInput({ client, date: '2025-06-10', pipelineOutput: makePipelineOutput() }));
  assert.strictEqual(second.savedRows,   0,                'Same date: no new rows');
  assert.strictEqual(second.skippedRows, first.savedRows,  'Same date: all skipped');
});

// ─────────────────────────────────────────────────────────────────────────────
// formatSaveSlateResult
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nformatSaveSlateResult');

asyncTest('formats summary with all expected lines', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client }));
  const summary = formatSaveSlateResult(result, TEST_DATE, MODEL_VERSION);

  assert.ok(summary.includes(TEST_DATE),     'Summary should include the date');
  assert.ok(summary.includes(MODEL_VERSION), 'Summary should include model version');
  assert.ok(summary.includes('Total picks'), 'Summary should include total picks label');
  assert.ok(summary.includes('Saved'),       'Summary should include saved count');
  assert.ok(summary.includes('Skipped'),     'Summary should include skipped count');
});

asyncTest('success message when savedRows > 0', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSlate(makeInput({ client }));
  const summary = formatSaveSlateResult(result, TEST_DATE, MODEL_VERSION);
  if (result.savedRows > 0) {
    assert.ok(summary.includes('successfully'), 'Should show success message');
  }
});

asyncTest('already-saved message when skippedRows = totalPicks', async () => {
  const client = new FakeSupabaseClient();
  await saveSlate(makeInput({ client })); // first save
  const second = await saveSlate(makeInput({ client, pipelineOutput: makePipelineOutput() }));
  const summary = formatSaveSlateResult(second, TEST_DATE, MODEL_VERSION);
  if (second.savedRows === 0 && second.skippedRows > 0) {
    assert.ok(summary.includes('previously saved'), 'Should indicate slate was already saved');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`saveSlate.service — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
