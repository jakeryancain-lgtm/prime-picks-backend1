import * as assert from 'assert';
import {
  runDailyMLBModelCycle,
  type DailyModelCycleInput,
} from '../src/services/mlbDailyModel.service';
import type { NormalizedPick }    from '../src/adapters/oddsApi.adapter';
import type { TeamGameStats }     from '../src/adapters/mlbStatsModel.adapter';
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

  setError(msg: string, code?: string) { this.simulateError = { message: msg, code }; }

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
// Real-shaped fixtures (no live API calls)
// ─────────────────────────────────────────────────────────────────────────────

const MODEL_VERSION = 'mlb-stats-v1';

/**
 * Normalized odds picks as they would arrive from oddsApi.adapter.
 * Three games — moneylines only for simplicity.
 * Odds are reasonable (-115/+105 range) so picks can qualify through the pipeline.
 */
const REAL_SHAPED_ODDS_PICKS: NormalizedPick[] = [
  {
    gameId:               'mlb-2025-06-10-nyy-bos',
    team:                 'New York Yankees',
    opponent:             'Boston Red Sox',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -120,
    oppositeAmericanOdds: 100,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
  {
    gameId:               'mlb-2025-06-10-nyy-bos',
    team:                 'Boston Red Sox',
    opponent:             'New York Yankees',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         100,
    oppositeAmericanOdds: -120,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
  {
    gameId:               'mlb-2025-06-10-hou-oak',
    team:                 'Houston Astros',
    opponent:             'Oakland Athletics',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -140,
    oppositeAmericanOdds: 120,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
  {
    gameId:               'mlb-2025-06-10-hou-oak',
    team:                 'Oakland Athletics',
    opponent:             'Houston Astros',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         120,
    oppositeAmericanOdds: -140,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  },
];

/**
 * Structured MLB stats as they would come from a real data source.
 * NYY is clearly stronger than BOS; HOU is a moderate favourite over OAK.
 */
const REAL_SHAPED_STATS: TeamGameStats[] = [
  {
    gameId:              'mlb-2025-06-10-nyy-bos',
    team:                'New York Yankees',
    opponent:            'Boston Red Sox',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              true,
    teamWinPct:          0.580,
    opponentWinPct:      0.430,
    spEra:               3.10,
    opponentSpEra:       4.90,
    bullpenEra:          3.40,
    opponentBullpenEra:  4.60,
    teamOps:             0.765,
    opponentOps:         0.695,
    recentFormWins:      7,
    opponentFormWins:    3,
  },
  {
    gameId:              'mlb-2025-06-10-nyy-bos',
    team:                'Boston Red Sox',
    opponent:            'New York Yankees',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              false,
    teamWinPct:          0.430,
    opponentWinPct:      0.580,
    spEra:               4.90,
    opponentSpEra:       3.10,
    bullpenEra:          4.60,
    opponentBullpenEra:  3.40,
    teamOps:             0.695,
    opponentOps:         0.765,
    recentFormWins:      3,
    opponentFormWins:    7,
  },
  {
    gameId:              'mlb-2025-06-10-hou-oak',
    team:                'Houston Astros',
    opponent:            'Oakland Athletics',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              true,
    teamWinPct:          0.555,
    opponentWinPct:      0.380,
    spEra:               3.50,
    opponentSpEra:       5.20,
    bullpenEra:          3.80,
    opponentBullpenEra:  5.00,
    teamOps:             0.755,
    opponentOps:         0.670,
    recentFormWins:      6,
    opponentFormWins:    3,
  },
  {
    gameId:              'mlb-2025-06-10-hou-oak',
    team:                'Oakland Athletics',
    opponent:            'Houston Astros',
    betType:             'moneyline',
    marketType:          'moneyline',
    isHome:              false,
    teamWinPct:          0.380,
    opponentWinPct:      0.555,
    spEra:               5.20,
    opponentSpEra:       3.50,
    bullpenEra:          5.00,
    opponentBullpenEra:  3.80,
    teamOps:             0.670,
    opponentOps:         0.755,
    recentFormWins:      3,
    opponentFormWins:    6,
  },
];

function baseInput(overrides: Partial<DailyModelCycleInput> = {}): DailyModelCycleInput {
  return {
    modelVersionId:      MODEL_VERSION,
    normalizedOddsPicks: REAL_SHAPED_ODDS_PICKS,
    structuredStats:     REAL_SHAPED_STATS,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: full cycle creates model probabilities from stats
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmodel probability generation');

asyncTest('full cycle creates model probabilities from structured stats', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const mapKeys = Object.keys(result.modelProbabilityMap);
  assert.ok(mapKeys.length > 0, 'modelProbabilityMap should have entries');
  assert.strictEqual(mapKeys.length, REAL_SHAPED_STATS.length);
});

asyncTest('model probability map entries are valid numbers', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  for (const [key, record] of Object.entries(result.modelProbabilityMap)) {
    assert.ok(
      typeof record.modelProbability === 'number' &&
      record.modelProbability > 0 &&
      record.modelProbability < 1,
      `Key ${key}: invalid modelProbability ${record.modelProbability}`,
    );
  }
});

asyncTest('model build errors are empty for valid stats', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.strictEqual(result.modelBuildErrors.length, 0);
});

asyncTest('NYY probability is higher than BOS probability (stronger team)', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const nyyKey = Object.keys(result.modelProbabilityMap)
    .find(k => k.includes('new york yankees'));
  const bosKey = Object.keys(result.modelProbabilityMap)
    .find(k => k.includes('boston red sox'));
  assert.ok(nyyKey, 'NYY key not found in model map');
  assert.ok(bosKey, 'BOS key not found in model map');
  const nyyProb = result.modelProbabilityMap[nyyKey!]!.modelProbability;
  const bosProb = result.modelProbabilityMap[bosKey!]!.modelProbability;
  assert.ok(nyyProb > bosProb,
    `NYY (${nyyProb}) should have higher prob than BOS (${bosProb})`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: full cycle attaches probabilities to odds
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nprobability attachment');

asyncTest('all odds picks with matching stats get model probabilities attached', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  // 4 odds picks + 4 stats entries = all 4 should attach
  assert.strictEqual(result.missingModelPicks.length, 0,
    `Expected 0 missing model picks, got ${result.missingModelPicks.length}`);
  assert.strictEqual(result.modelAttachErrors.length, 0);
});

asyncTest('pipeline inputs equal odds picks minus missing model picks', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const expected = REAL_SHAPED_ODDS_PICKS.length - result.missingModelPicks.length;
  assert.strictEqual(result.summary.totalPipelineInputs, expected);
});

asyncTest('processed picks have non-null modelProbability (attached correctly)', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const all = [
    ...result.pipelineOutput.topPicks,
    ...result.pipelineOutput.qualifiedPicks,
    ...result.pipelineOutput.failedPicks,
    ...result.pipelineOutput.noOddsPicks,
  ];
  for (const pick of all) {
    if (pick.modelProbability === null || pick.modelProbability === undefined) {
      throw new Error(`Pick ${pick.id} has null modelProbability after pipeline`);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: full cycle runs pipeline
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npipeline execution');

asyncTest('pipeline runs and returns four groups', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.ok(Array.isArray(result.pipelineOutput.topPicks));
  assert.ok(Array.isArray(result.pipelineOutput.qualifiedPicks));
  assert.ok(Array.isArray(result.pipelineOutput.failedPicks));
  assert.ok(Array.isArray(result.pipelineOutput.noOddsPicks));
});

asyncTest('no pick id appears in more than one pipeline group', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const allIds = [
    ...result.pipelineOutput.topPicks.map(p => p.id),
    ...result.pipelineOutput.qualifiedPicks.map(p => p.id),
    ...result.pipelineOutput.failedPicks.map(p => p.id),
    ...result.pipelineOutput.noOddsPicks.map(p => p.id),
  ];
  const unique = new Set(allIds);
  assert.strictEqual(unique.size, allIds.length, 'Duplicate id across pipeline groups');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: strong stats create qualified/top pick when odds are reasonable
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nstrong stats → qualifying picks');

asyncTest('NYY with strong stats qualifies or reaches topPicks', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const allQualified = [
    ...result.pipelineOutput.topPicks,
    ...result.pipelineOutput.qualifiedPicks,
  ];
  const nyyPick = allQualified.find(p =>
    p.team.toLowerCase().includes('yankees') ||
    p.team.toLowerCase().includes('nyy'),
  );
  assert.ok(nyyPick, 'NYY with strong stats should be in topPicks or qualifiedPicks');
});

asyncTest('qualified picks have positive edge', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const qualified = [
    ...result.pipelineOutput.topPicks,
    ...result.pipelineOutput.qualifiedPicks,
  ];
  for (const p of qualified) {
    assert.ok(p.edgeDecimal > 0,
      `Qualified pick ${p.team} should have positive edge, got ${p.edgeDecimal}`);
  }
});

asyncTest('topPicks have no duplicate gameIds', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const gameIds = result.pipelineOutput.topPicks.map(p => p.gameId);
  const unique  = new Set(gameIds);
  assert.strictEqual(unique.size, gameIds.length, 'Duplicate gameId in topPicks');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: missing stats lowers confidence or prevents attachment cleanly
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmissing stats handling');

asyncTest('odds pick with no matching stats goes to missingModelPicks', async () => {
  // Add an extra odds pick with no corresponding stats entry
  const extraPick: NormalizedPick = {
    gameId:               'mlb-2025-06-10-det-min',
    team:                 'Detroit Tigers',
    opponent:             'Minnesota Twins',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         110,
    oppositeAmericanOdds: -130,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  };

  const result = await runDailyMLBModelCycle(baseInput({
    normalizedOddsPicks: [...REAL_SHAPED_ODDS_PICKS, extraPick],
    // structuredStats has no entry for DET/MIN
  }));

  assert.strictEqual(result.missingModelPicks.length, 1);
  assert.ok(
    result.missingModelPicks[0]!.team === 'Detroit Tigers' ||
    result.missingModelPicks[0]!.gameId === 'mlb-2025-06-10-det-min',
  );
});

asyncTest('stats with minimal data still produce a valid model record', async () => {
  const sparseStats: TeamGameStats = {
    gameId:     'mlb-2025-06-10-det-min',
    team:       'Detroit Tigers',
    opponent:   'Minnesota Twins',
    betType:    'moneyline',
    marketType: 'moneyline',
    isHome:     true,
    // Only win% provided — sparse data
    teamWinPct:     0.440,
    opponentWinPct: 0.480,
  };

  const sparseOdds: NormalizedPick = {
    gameId:               sparseStats.gameId,
    team:                 sparseStats.team,
    opponent:             sparseStats.opponent,
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         110,
    oppositeAmericanOdds: -130,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
  };

  const result = await runDailyMLBModelCycle({
    modelVersionId:      MODEL_VERSION,
    normalizedOddsPicks: [sparseOdds],
    structuredStats:     [sparseStats],
  });

  // Should attach (not be missing) despite sparse data
  assert.strictEqual(result.missingModelPicks.length, 0);
  assert.strictEqual(result.modelBuildErrors.length, 0);

  // Confidence should be lower than a fully-specified pick
  const mapEntry = Object.values(result.modelProbabilityMap)[0];
  assert.ok(mapEntry, 'Model map should have one entry');
  assert.ok(mapEntry!.confidence < 0.85,
    `Sparse data should have lower confidence, got ${mapEntry!.confidence}`);
});

asyncTest('missingModelPicks are still in the result, not silently dropped', async () => {
  const extraPick: NormalizedPick = {
    gameId: 'no-stats-game', team: 'Ghost Team', opponent: 'OPP',
    betType: 'moneyline', marketType: 'moneyline',
    americanOdds: 100, oppositeAmericanOdds: -120,
    modelProbability: null, confidence: null, runLineSpread: undefined,
  };

  const result = await runDailyMLBModelCycle(baseInput({
    normalizedOddsPicks: [...REAL_SHAPED_ODDS_PICKS, extraPick],
  }));

  assert.ok(result.missingModelPicks.length >= 1);
  assert.strictEqual(result.summary.totalOddsPicks, REAL_SHAPED_ODDS_PICKS.length + 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: optional Supabase client saves all predictions
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npersistence');

asyncTest('Supabase client is called when provided', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBModelCycle(baseInput({ supabaseClient: client }));

  assert.ok(result.saveResult !== undefined, 'saveResult should be present');
  assert.ok(client.callCount > 0, 'insert should have been called');
  assert.strictEqual(result.saveResult!.errors.length, 0);
});

asyncTest('saves all picks from all pipeline groups', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBModelCycle(baseInput({ supabaseClient: client }));

  const totalPipelinePicks = result.summary.totalPipelineInputs;
  assert.strictEqual(client.insertedRows.length, totalPipelinePicks,
    `Expected ${totalPipelinePicks} saved rows`);
});

asyncTest('saved rows have valid status fields', async () => {
  const client = new FakeSupabaseClient();
  await runDailyMLBModelCycle(baseInput({ supabaseClient: client }));

  const validStatuses = ['QUALIFIED', 'FAILED_FILTER', 'NO_ODDS'];
  for (const row of client.insertedRows) {
    assert.ok(validStatuses.includes(row.status),
      `Invalid status "${row.status}"`);
  }
});

asyncTest('saved rows all have model_version_id set', async () => {
  const client = new FakeSupabaseClient();
  await runDailyMLBModelCycle(baseInput({ supabaseClient: client }));

  for (const row of client.insertedRows) {
    assert.ok(row.model_version_id && row.model_version_id.length > 0,
      `Row missing model_version_id`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7: no Supabase client still runs dry
// ─────────────────────────────────────────────────────────────────────────────

asyncTest('cycle runs completely without Supabase client', async () => {
  const result = await runDailyMLBModelCycle(baseInput()); // no client
  assert.strictEqual(result.saveResult, undefined, 'saveResult should be undefined');
  assert.ok(result.pipelineOutput !== undefined, 'pipelineOutput should still be present');
});

asyncTest('summary.savedRows is 0 when no Supabase client', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.strictEqual(result.summary.savedRows, 0);
});

asyncTest('dry run still returns a complete summary', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const requiredFields: (keyof typeof result.summary)[] = [
    'totalOddsPicks', 'totalModelRecords', 'totalPipelineInputs',
    'topPicks', 'qualifiedPicks', 'failedPicks', 'noOddsPicks', 'savedRows',
  ];
  for (const f of requiredFields) {
    assert.ok(f in result.summary, `Missing summary.${f}`);
    assert.ok(typeof result.summary[f] === 'number', `summary.${f} should be a number`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8: summary counts are correct
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsummary correctness');

asyncTest('summary.totalOddsPicks equals input picks length', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.strictEqual(result.summary.totalOddsPicks, REAL_SHAPED_ODDS_PICKS.length);
});

asyncTest('summary.totalModelRecords equals structuredStats length', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.strictEqual(result.summary.totalModelRecords, REAL_SHAPED_STATS.length);
});

asyncTest('summary group counts sum to totalPipelineInputs', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const { summary } = result;
  const groupSum = summary.topPicks + summary.qualifiedPicks
    + summary.failedPicks + summary.noOddsPicks;
  assert.strictEqual(groupSum, summary.totalPipelineInputs,
    `Groups (${groupSum}) don't sum to totalPipelineInputs (${summary.totalPipelineInputs})`);
});

asyncTest('summary.topPicks matches pipelineOutput.topPicks.length', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  assert.strictEqual(result.summary.topPicks, result.pipelineOutput.topPicks.length);
});

asyncTest('summary.savedRows matches saveResult.savedCount', async () => {
  const client = new FakeSupabaseClient();
  const result = await runDailyMLBModelCycle(baseInput({ supabaseClient: client }));
  assert.strictEqual(result.summary.savedRows, result.saveResult!.savedCount);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9: no pick is silently skipped
// ─────────────────────────────────────────────────────────────────────────────

console.log('\npick accounting');

asyncTest('total picks accounted for = pipelineInputs + missingModelPicks + modelAttachErrors', async () => {
  const result = await runDailyMLBModelCycle(baseInput());
  const accounted =
    result.summary.totalPipelineInputs +
    result.missingModelPicks.length +
    result.modelAttachErrors.length;
  assert.strictEqual(accounted, result.summary.totalOddsPicks,
    `Accounted (${accounted}) !== totalOddsPicks (${result.summary.totalOddsPicks})`);
});

asyncTest('every input odds pick appears in some output bucket', async () => {
  const extraPick: NormalizedPick = {
    gameId: 'no-stats', team: 'Ghost', opponent: 'OPP',
    betType: 'moneyline', marketType: 'moneyline',
    americanOdds: 110, oppositeAmericanOdds: -130,
    modelProbability: null, confidence: null, runLineSpread: undefined,
  };

  const result = await runDailyMLBModelCycle(baseInput({
    normalizedOddsPicks: [...REAL_SHAPED_ODDS_PICKS, extraPick],
  }));

  // All pipeline picks + missing + errors = total input
  const total = REAL_SHAPED_ODDS_PICKS.length + 1;
  const accounted =
    result.summary.totalPipelineInputs +
    result.missingModelPicks.length +
    result.modelAttachErrors.length;

  assert.strictEqual(accounted, total,
    `Not all picks accounted for: ${accounted} vs ${total}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10: output can be consumed by results.service
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nresults.service compatibility');

asyncTest('pipelineOutput can be passed to mapPipelineOutputToDbRows without error', async () => {
  const { mapPipelineOutputToDbRows } = await import('../src/services/results.service');
  const result = await runDailyMLBModelCycle(baseInput());
  let threw = false;
  try {
    const rows = mapPipelineOutputToDbRows(result.pipelineOutput);
    assert.ok(Array.isArray(rows), 'Expected array from mapPipelineOutputToDbRows');
    assert.ok(rows.length > 0, 'Expected non-empty rows');
  } catch {
    threw = true;
  }
  assert.ok(!threw, 'mapPipelineOutputToDbRows should not throw on pipeline output');
});

asyncTest('DB rows have all required fields for Supabase schema', async () => {
  const { mapPipelineOutputToDbRows } = await import('../src/services/results.service');
  const result = await runDailyMLBModelCycle(baseInput());
  const rows   = mapPipelineOutputToDbRows(result.pipelineOutput);

  const requiredCols = [
    'model_version_id', 'game_id', 'sport', 'team', 'opponent',
    'bet_type', 'market_type', 'model_probability', 'edge_decimal',
    'risk_level', 'grade_numeric', 'grade_letter', 'status',
  ];

  for (const row of rows) {
    for (const col of requiredCols) {
      assert.ok(col in row, `Row missing column: ${col}`);
    }
  }
});

asyncTest('DB rows all have model_version_id matching input', async () => {
  const { mapPipelineOutputToDbRows } = await import('../src/services/results.service');
  const result = await runDailyMLBModelCycle(baseInput());
  const rows   = mapPipelineOutputToDbRows(result.pipelineOutput);

  for (const row of rows) {
    assert.strictEqual(row.model_version_id, MODEL_VERSION,
      `Row model_version_id should be ${MODEL_VERSION}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`mlbDailyModel.service — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
