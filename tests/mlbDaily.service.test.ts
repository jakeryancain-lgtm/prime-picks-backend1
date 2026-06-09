import * as assert from 'assert';
import {
  runDailyMLBCycle,
  type DailyCycleInput,
} from '../src/adapters/mlbDaily.service';
import {
  buildModelKey,
  type ModelProbabilityMap,
} from '../src/adapters/mlbModel.adapter';
import type { NormalizedPick }    from '../src/adapters/oddsApi.adapter';
import type { SupabaseClientLike } from '../src/services/supabase.types';
import type { ModelPredictionRow } from '../src/services/results.service';

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
// Fake Supabase client
// ─────────────────────────────────────────────────────────────────────────────

class FakeSupabaseClient implements SupabaseClientLike {
  public insertedRows: ModelPredictionRow[] = [];
  public callCount = 0;
  private simulateError: { message: string; code?: string } | null = null;

  setError(msg: string, code?: string) {
    this.simulateError = { message: msg, code };
  }

  from(_table: string) {
    return {
      insert: async (rows: unknown[]) => {
        this.callCount++;
        this.insertedRows.push(...(rows as ModelPredictionRow[]));
        if (this.simulateError) return { data: null, error: this.simulateError };
        return { data: rows, error: null };
      },
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'model-v1';

/** A normalized pick that qualifies: good edge, valid odds. */
function makePick(
  gameId:    string,
  team:      string,
  opponent:  string,
  overrides: Partial<NormalizedPick> = {},
): NormalizedPick {
  return {
    gameId,
    team,
    opponent,
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -115,
    oppositeAmericanOdds: 105,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
    ...overrides,
  };
}

/** A model map entry that produces a strong qualifying pick. */
function modelEntry(gameId: string, team: string, modelProbability = 0.65) {
  const key = buildModelKey(gameId, team, 'moneyline', 'moneyline');
  return { [key]: { modelProbability, confidence: 0.78, modelVersionId: MODEL_VERSION } };
}

/** Three strong qualifying picks across different games with model entries. */
function makeSlate() {
  const p1 = makePick('game-001', 'NYY', 'BOS');
  const p2 = makePick('game-002', 'HOU', 'OAK');
  const p3 = makePick('game-003', 'LAD', 'SF');

  const modelMap: ModelProbabilityMap = {
    ...modelEntry('game-001', 'NYY', 0.68),
    ...modelEntry('game-002', 'HOU', 0.66),
    ...modelEntry('game-003', 'LAD', 0.64),
  };

  return { picks: [p1, p2, p3], modelMap };
}

function makeInput(overrides: Partial<DailyCycleInput> = {}): DailyCycleInput {
  const { picks, modelMap } = makeSlate();
  return {
    normalizedPicks:    picks,
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: runs full daily cycle with fake odds and model records
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ndaily cycle — full run');

asyncTest('runs full daily cycle and returns a result object', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.ok('pipelineOutput'    in result, 'missing pipelineOutput');
  assert.ok('missingModelPicks' in result, 'missing missingModelPicks');
  assert.ok('modelErrors'       in result, 'missing modelErrors');
  assert.ok('summary'           in result, 'missing summary');
});

asyncTest('pipelineOutput has the four required groups', async () => {
  const result = await runDailyMLBCycle(makeInput());
  const { pipelineOutput } = result;
  assert.ok(Array.isArray(pipelineOutput.topPicks),      'topPicks not array');
  assert.ok(Array.isArray(pipelineOutput.qualifiedPicks), 'qualifiedPicks not array');
  assert.ok(Array.isArray(pipelineOutput.failedPicks),    'failedPicks not array');
  assert.ok(Array.isArray(pipelineOutput.noOddsPicks),    'noOddsPicks not array');
});

asyncTest('cycle completes without errors for a clean slate', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.strictEqual(result.modelErrors.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: returns topPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ntopPicks');

asyncTest('returns topPicks with qualifying picks', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.ok(result.pipelineOutput.topPicks.length > 0,
    `Expected at least one topPick, got ${result.pipelineOutput.topPicks.length}`);
});

asyncTest('all topPicks have status QUALIFIED', async () => {
  const result = await runDailyMLBCycle(makeInput());
  for (const p of result.pipelineOutput.topPicks) {
    assert.strictEqual(p.status, 'QUALIFIED');
  }
});

asyncTest('topPicks have no duplicate gameIds', async () => {
  const result = await runDailyMLBCycle(makeInput());
  const gameIds = result.pipelineOutput.topPicks.map(p => p.gameId);
  const unique  = new Set(gameIds);
  assert.strictEqual(unique.size, gameIds.length, 'Duplicate gameId in topPicks');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: returns missingModelPicks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmissingModelPicks');

asyncTest('picks without model records appear in missingModelPicks', async () => {
  const p1 = makePick('game-001', 'NYY', 'BOS');
  const p2 = makePick('game-002', 'HOU', 'OAK');  // no model record

  const modelMap: ModelProbabilityMap = {
    ...modelEntry('game-001', 'NYY', 0.68),
    // game-002 HOU intentionally omitted
  };

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p1, p2],
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
  });

  assert.strictEqual(result.missingModelPicks.length, 1, 'Expected 1 missingModelPick');
  assert.strictEqual(result.missingModelPicks[0]!.gameId, 'game-002');
});

asyncTest('missingModelPicks still have modelProbability = null', async () => {
  const p = makePick('game-X', 'TEAM', 'OPP');
  const result = await runDailyMLBCycle({
    normalizedPicks:    [p],
    modelProbabilities: {},
    modelVersionId:     MODEL_VERSION,
  });
  assert.strictEqual(result.missingModelPicks[0]!.modelProbability, null);
});

asyncTest('missingModelPicks are not silently dropped from the result', async () => {
  const missing = makePick('game-M', 'MISS', 'OPP');
  const result  = await runDailyMLBCycle({
    normalizedPicks:    [missing],
    modelProbabilities: {},
    modelVersionId:     MODEL_VERSION,
  });
  assert.strictEqual(result.missingModelPicks.length, 1, 'missingModelPicks should not be empty');
  assert.strictEqual(result.summary.missingModelPicks, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: returns modelErrors
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmodelErrors');

asyncTest('invalid model record goes to modelErrors', async () => {
  const p   = makePick('game-E', 'ERR', 'OPP');
  const key = buildModelKey('game-E', 'ERR', 'moneyline', 'moneyline');

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p],
    modelProbabilities: { [key]: { modelProbability: 0, confidence: 0.70 } }, // invalid prob
    modelVersionId:     MODEL_VERSION,
  });

  assert.strictEqual(result.modelErrors.length, 1);
  assert.ok(result.modelErrors[0]!.message.includes('modelProbability'));
});

asyncTest('modelErrors include the pickKey', async () => {
  const p   = makePick('game-E2', 'ERR2', 'OPP');
  const key = buildModelKey('game-E2', 'ERR2', 'moneyline', 'moneyline');

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p],
    modelProbabilities: { [key]: { modelProbability: 1.5, confidence: 0.70 } },
    modelVersionId:     MODEL_VERSION,
  });

  assert.ok(result.modelErrors[0]!.pickKey.length > 0, 'pickKey should be non-empty');
});

asyncTest('no model errors when all records are valid', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.strictEqual(result.modelErrors.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: saves predictions when Supabase client is provided
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npersistence');

asyncTest('saves all picks when Supabase client is provided', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBCycle(makeInput({ supabaseClient: client }));

  assert.ok(result.saveResult !== undefined, 'saveResult should be present when client provided');
  assert.strictEqual(result.saveResult!.errors.length, 0);
  assert.ok(client.callCount > 0, 'Expected at least one insert call');
  assert.ok(client.insertedRows.length > 0, 'Expected inserted rows');
});

asyncTest('saveResult.savedCount equals total pipeline output picks', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBCycle(makeInput({ supabaseClient: client }));

  const totalPicks =
    result.pipelineOutput.topPicks.length +
    result.pipelineOutput.qualifiedPicks.length +
    result.pipelineOutput.failedPicks.length +
    result.pipelineOutput.noOddsPicks.length;

  assert.strictEqual(result.saveResult!.savedCount, totalPicks);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: does not save when Supabase client is missing
// ─────────────────────────────────────────────────────────────────────────────

asyncTest('saveResult is undefined when no Supabase client provided', async () => {
  const result = await runDailyMLBCycle(makeInput()); // no supabaseClient
  assert.strictEqual(result.saveResult, undefined);
});

asyncTest('cycle still completes fully without a Supabase client', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.ok(result.pipelineOutput.topPicks.length >= 0, 'pipeline should still run');
  assert.strictEqual(result.summary.savedRows, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: summary counts are correct
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsummary counts');

asyncTest('summary.totalOddsPicks equals input normalizedPicks length', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.strictEqual(result.summary.totalOddsPicks, makeInput().normalizedPicks.length);
});

asyncTest('summary.readyPicks equals picks that got model records', async () => {
  const p1 = makePick('game-001', 'NYY', 'BOS');
  const p2 = makePick('game-002', 'HOU', 'OAK'); // no record
  const modelMap: ModelProbabilityMap = { ...modelEntry('game-001', 'NYY', 0.68) };

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p1, p2],
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
  });

  assert.strictEqual(result.summary.readyPicks,        1);
  assert.strictEqual(result.summary.missingModelPicks, 1);
});

asyncTest('summary picks counts sum correctly', async () => {
  const result = await runDailyMLBCycle(makeInput());
  const { summary, pipelineOutput } = result;

  assert.strictEqual(summary.topPicks,      pipelineOutput.topPicks.length);
  assert.strictEqual(summary.qualifiedPicks, pipelineOutput.qualifiedPicks.length);
  assert.strictEqual(summary.failedPicks,   pipelineOutput.failedPicks.length);
  assert.strictEqual(summary.noOddsPicks,   pipelineOutput.noOddsPicks.length);
});

asyncTest('summary.savedRows is 0 when no client provided', async () => {
  const result = await runDailyMLBCycle(makeInput());
  assert.strictEqual(result.summary.savedRows, 0);
});

asyncTest('summary.savedRows equals saveResult.savedCount when client provided', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBCycle(makeInput({ supabaseClient: client }));
  assert.strictEqual(result.summary.savedRows, result.saveResult!.savedCount);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: bad model record does not crash full cycle
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfault tolerance');

asyncTest('cycle with one bad record and two good ones still returns good picks', async () => {
  const good1 = makePick('game-G1', 'NYY', 'BOS');
  const bad   = makePick('game-B',  'ERR', 'OPP');
  const good2 = makePick('game-G2', 'HOU', 'OAK');

  const modelMap: ModelProbabilityMap = {
    ...modelEntry('game-G1', 'NYY', 0.66),
    [buildModelKey('game-B', 'ERR', 'moneyline', 'moneyline')]:
      { modelProbability: 0, confidence: 0.70 }, // invalid
    ...modelEntry('game-G2', 'HOU', 0.65),
  };

  const result = await runDailyMLBCycle({
    normalizedPicks:    [good1, bad, good2],
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
  });

  // Two good picks should reach the pipeline
  assert.strictEqual(result.summary.readyPicks, 2);
  // One error for the invalid pick
  assert.strictEqual(result.modelErrors.length, 1);
  // Cycle completed without throwing
  assert.ok(result.pipelineOutput !== undefined);
});

asyncTest('all-bad model records produces empty topPicks but no crash', async () => {
  const p   = makePick('game-B', 'BAD', 'OPP');
  const key = buildModelKey('game-B', 'BAD', 'moneyline', 'moneyline');

  let threw = false;
  try {
    await runDailyMLBCycle({
      normalizedPicks:    [p],
      modelProbabilities: { [key]: { modelProbability: NaN, confidence: 0.70 } },
      modelVersionId:     MODEL_VERSION,
    });
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, false, 'Cycle should not throw on bad model data');
});

asyncTest('empty picks produces empty result without error', async () => {
  const result = await runDailyMLBCycle({
    normalizedPicks:    [],
    modelProbabilities: {},
    modelVersionId:     MODEL_VERSION,
  });
  assert.strictEqual(result.summary.totalOddsPicks, 0);
  assert.strictEqual(result.summary.readyPicks,     0);
  assert.strictEqual(result.summary.topPicks,       0);
  assert.strictEqual(result.modelErrors.length,     0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: no forced Top 5
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nno forced Top 5');

asyncTest('topPicks length equals qualifying picks, not forced to 5', async () => {
  // Only 2 picks in the slate
  const p1 = makePick('game-001', 'NYY', 'BOS');
  const p2 = makePick('game-002', 'HOU', 'OAK');
  const modelMap: ModelProbabilityMap = {
    ...modelEntry('game-001', 'NYY', 0.68),
    ...modelEntry('game-002', 'HOU', 0.66),
  };

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p1, p2],
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
  });

  // At most 2 topPicks — never padded to 5
  assert.ok(result.pipelineOutput.topPicks.length <= 2,
    `topPicks ${result.pipelineOutput.topPicks.length} should be ≤ 2`);
});

asyncTest('topPicks is empty when no picks qualify', async () => {
  // Low-edge pick: model prob barely above implied (~0.523)
  const p   = makePick('game-LOW', 'LOW', 'OPP', { americanOdds: -115, oppositeAmericanOdds: 105 });
  const key = buildModelKey('game-LOW', 'LOW', 'moneyline', 'moneyline');

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p],
    modelProbabilities: { [key]: { modelProbability: 0.53, confidence: 0.65 } }, // edge ~0.007
    modelVersionId:     MODEL_VERSION,
  });

  assert.strictEqual(result.pipelineOutput.topPicks.length, 0,
    'No picks should qualify with very low edge');
});

asyncTest('maxTopPicks config is respected', async () => {
  // 5 qualifying picks, but limit to 2 via config
  const picks = Array.from({ length: 5 }, (_, i) =>
    makePick(`game-00${i}`, `team${i}`, `opp${i}`),
  );
  const modelMap: ModelProbabilityMap = {};
  for (const p of picks) {
    modelMap[buildModelKey(p.gameId, p.team, p.betType, p.marketType)] =
      { modelProbability: 0.65, confidence: 0.78 };
  }

  const result = await runDailyMLBCycle({
    normalizedPicks:    picks,
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
    pipelineConfig:     { maxTopPicks: 2 },
  });

  assert.ok(result.pipelineOutput.topPicks.length <= 2,
    `Expected ≤ 2 topPicks with maxTopPicks:2, got ${result.pipelineOutput.topPicks.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: every ready pick appears in exactly one pipeline output group
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npick accounting');

asyncTest('every ready pick appears in exactly one output group', async () => {
  const result = await runDailyMLBCycle(makeInput());
  const { pipelineOutput } = result;

  const allIds = [
    ...pipelineOutput.topPicks.map(p => p.id),
    ...pipelineOutput.qualifiedPicks.map(p => p.id),
    ...pipelineOutput.failedPicks.map(p => p.id),
    ...pipelineOutput.noOddsPicks.map(p => p.id),
  ];

  const unique = new Set(allIds);
  assert.strictEqual(unique.size, allIds.length, 'A pick id appears in more than one group');
});

asyncTest('total picks in all groups equals readyPicks count', async () => {
  const result = await runDailyMLBCycle(makeInput());
  const { pipelineOutput, summary } = result;

  const total =
    pipelineOutput.topPicks.length +
    pipelineOutput.qualifiedPicks.length +
    pipelineOutput.failedPicks.length +
    pipelineOutput.noOddsPicks.length;

  assert.strictEqual(total, summary.readyPicks,
    `Pipeline output total (${total}) !== readyPicks (${summary.readyPicks})`);
});

asyncTest('missingModelPicks are NOT in any pipeline group', async () => {
  const p1      = makePick('game-001', 'NYY', 'BOS');
  const missing = makePick('game-M',   'MIS', 'OPP');

  const modelMap: ModelProbabilityMap = { ...modelEntry('game-001', 'NYY', 0.66) };

  const result = await runDailyMLBCycle({
    normalizedPicks:    [p1, missing],
    modelProbabilities: modelMap,
    modelVersionId:     MODEL_VERSION,
  });

  const allPipelineIds = new Set([
    ...result.pipelineOutput.topPicks.map(p => p.gameId),
    ...result.pipelineOutput.qualifiedPicks.map(p => p.gameId),
    ...result.pipelineOutput.failedPicks.map(p => p.gameId),
    ...result.pipelineOutput.noOddsPicks.map(p => p.gameId),
  ]);

  for (const mp of result.missingModelPicks) {
    assert.ok(!allPipelineIds.has(mp.gameId),
      `Missing pick gameId ${mp.gameId} should not appear in pipeline output`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`mlbDaily.service — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
