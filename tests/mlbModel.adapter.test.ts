import * as assert from 'assert';
import {
  attachModelProbabilities,
  validateModelProbabilityRecord,
  buildModelKey,
  type ModelProbabilityMap,
  type ModelProbabilityRecord,
} from '../src/adapters/mlbModel.adapter';
import type { NormalizedPick as OddsNormalizedPick } from '../src/adapters/oddsApi.adapter';

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
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL_VERSION = 'model-v1';

/** A normalized moneyline pick as it would arrive from oddsApi.adapter. */
function normalizedMoneyline(overrides: Partial<OddsNormalizedPick> = {}): OddsNormalizedPick {
  return {
    gameId:               'game-001',
    team:                 'New York Yankees',
    opponent:             'Boston Red Sox',
    betType:              'moneyline',
    marketType:           'moneyline',
    americanOdds:         -130,
    oppositeAmericanOdds: 110,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
    ...overrides,
  };
}

/** A normalized run line pick. */
function normalizedRunLine(overrides: Partial<OddsNormalizedPick> = {}): OddsNormalizedPick {
  return {
    gameId:               'game-002',
    team:                 'Los Angeles Dodgers',
    opponent:             'San Francisco Giants',
    betType:              'run_line',
    marketType:           'run_line',
    americanOdds:         -110,
    oppositeAmericanOdds: -110,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        -1.5,
    ...overrides,
  };
}

/** A normalized total pick. */
function normalizedTotal(overrides: Partial<OddsNormalizedPick> = {}): OddsNormalizedPick {
  return {
    gameId:               'game-003',
    team:                 'Houston Astros',
    opponent:             'Oakland Athletics',
    betType:              'total_over',
    marketType:           'total',
    americanOdds:         -115,
    oppositeAmericanOdds: -105,
    modelProbability:     null,
    confidence:           null,
    runLineSpread:        undefined,
    ...overrides,
  };
}

/** A model probability record with valid values. */
function validRecord(overrides: Partial<ModelProbabilityRecord> = {}): ModelProbabilityRecord {
  return {
    modelProbability: 0.62,
    confidence:       0.75,
    modelVersionId:   'model-v1',
    ...overrides,
  };
}

/** Builds a ModelProbabilityMap for a single normalized pick. */
function mapForPick(pick: OddsNormalizedPick, record: ModelProbabilityRecord): ModelProbabilityMap {
  const key = buildModelKey(pick.gameId, pick.team, pick.betType, pick.marketType);
  return { [key]: record };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildModelKey
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildModelKey');

// Required test 6: buildModelKey is stable
test('produces the same key for the same inputs', () => {
  const k1 = buildModelKey('game-001', 'New York Yankees', 'moneyline', 'moneyline');
  const k2 = buildModelKey('game-001', 'New York Yankees', 'moneyline', 'moneyline');
  assert.strictEqual(k1, k2);
});

test('key is case-insensitive (all lowercased)', () => {
  const k1 = buildModelKey('GAME-001', 'New York Yankees', 'Moneyline', 'Moneyline');
  const k2 = buildModelKey('game-001', 'new york yankees', 'moneyline', 'moneyline');
  assert.strictEqual(k1, k2);
});

test('trims whitespace from all parts', () => {
  const k1 = buildModelKey('  game-001  ', '  New York Yankees  ', ' moneyline ', ' moneyline ');
  const k2 = buildModelKey('game-001', 'New York Yankees', 'moneyline', 'moneyline');
  assert.strictEqual(k1, k2);
});

test('different gameId produces different key', () => {
  const k1 = buildModelKey('game-001', 'NYY', 'moneyline', 'moneyline');
  const k2 = buildModelKey('game-002', 'NYY', 'moneyline', 'moneyline');
  assert.notStrictEqual(k1, k2);
});

test('different team produces different key', () => {
  const k1 = buildModelKey('game-001', 'NYY', 'moneyline', 'moneyline');
  const k2 = buildModelKey('game-001', 'BOS', 'moneyline', 'moneyline');
  assert.notStrictEqual(k1, k2);
});

test('different betType produces different key', () => {
  const k1 = buildModelKey('game-001', 'NYY', 'moneyline', 'moneyline');
  const k2 = buildModelKey('game-001', 'NYY', 'run_line',  'run_line');
  assert.notStrictEqual(k1, k2);
});

test('key format uses pipe separator', () => {
  const key = buildModelKey('game-001', 'NYY', 'moneyline', 'moneyline');
  const parts = key.split('|');
  assert.strictEqual(parts.length, 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// validateModelProbabilityRecord
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nvalidateModelProbabilityRecord');

test('returns valid=true for good record', () => {
  const result = validateModelProbabilityRecord(validRecord());
  assert.strictEqual(result.valid, true);
  assert.strictEqual(result.message, undefined);
});

// Required test 4: invalid modelProbability returns error
test('returns valid=false when modelProbability = 0', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: 0 }));
  assert.strictEqual(result.valid, false);
  assert.ok(result.message!.includes('modelProbability'));
});

test('returns valid=false when modelProbability = 1', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: 1 }));
  assert.strictEqual(result.valid, false);
  assert.ok(result.message!.includes('modelProbability'));
});

test('returns valid=false when modelProbability > 1', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: 1.5 }));
  assert.strictEqual(result.valid, false);
});

test('returns valid=false when modelProbability < 0', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: -0.1 }));
  assert.strictEqual(result.valid, false);
});

test('returns valid=false when modelProbability is NaN', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: NaN }));
  assert.strictEqual(result.valid, false);
});

test('returns valid=false when modelProbability is Infinity', () => {
  const result = validateModelProbabilityRecord(validRecord({ modelProbability: Infinity }));
  assert.strictEqual(result.valid, false);
});

// Required test 5: invalid confidence returns error
test('returns valid=false when confidence = 0', () => {
  const result = validateModelProbabilityRecord(validRecord({ confidence: 0 }));
  assert.strictEqual(result.valid, false);
  assert.ok(result.message!.includes('confidence'));
});

test('returns valid=false when confidence = 1', () => {
  const result = validateModelProbabilityRecord(validRecord({ confidence: 1 }));
  assert.strictEqual(result.valid, false);
  assert.ok(result.message!.includes('confidence'));
});

test('returns valid=false when confidence is NaN', () => {
  const result = validateModelProbabilityRecord(validRecord({ confidence: NaN }));
  assert.strictEqual(result.valid, false);
});

test('does not throw — always returns a result object', () => {
  const badValues = [0, 1, -1, 1.5, NaN, Infinity, -Infinity];
  for (const v of badValues) {
    let threw = false;
    try { validateModelProbabilityRecord({ modelProbability: v, confidence: 0.5 }); }
    catch { threw = true; }
    if (threw) throw new Error(`validateModelProbabilityRecord threw for modelProbability=${v}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// attachModelProbabilities
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nattachModelProbabilities');

// Required test 1: attaches modelProbability correctly
test('attaches modelProbability from the matched record', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ modelProbability: 0.64 });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length, 1);
  assert.strictEqual(result.readyPicks[0]!.modelProbability, 0.64);
});

// Required test 2: attaches confidence correctly
test('attaches confidence from the matched record', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ confidence: 0.82 });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.confidence, 0.82);
});

test('attaches modelVersionId from the record when present', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ modelVersionId: 'my-model-v3' });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.modelVersionId, 'my-model-v3');
});

test('uses defaultModelVersionId when record has no modelVersionId', () => {
  const pick   = normalizedMoneyline();
  const record: ModelProbabilityRecord = { modelProbability: 0.60, confidence: 0.70 };
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, 'default-v1');
  assert.strictEqual(result.readyPicks[0]!.modelVersionId, 'default-v1');
});

// Required test 3: missing model record goes to missingModelPicks
test('pick with no matching model record goes to missingModelPicks', () => {
  const pick   = normalizedMoneyline();
  const result = attachModelProbabilities([pick], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length,        0);
  assert.strictEqual(result.missingModelPicks.length, 1);
  assert.strictEqual(result.missingModelPicks[0]!.gameId, pick.gameId);
});

test('missingModelPicks still has modelProbability = null (unmodified)', () => {
  const pick   = normalizedMoneyline();
  const result = attachModelProbabilities([pick], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.missingModelPicks[0]!.modelProbability, null);
});

test('missingModelPicks still has confidence = null (unmodified)', () => {
  const pick   = normalizedMoneyline();
  const result = attachModelProbabilities([pick], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.missingModelPicks[0]!.confidence, null);
});

// Required test 4 (via attachModelProbabilities): invalid modelProbability → error
test('invalid modelProbability goes to errors, not readyPicks', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ modelProbability: 0 }); // invalid
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length, 0);
  assert.strictEqual(result.errors.length,     1);
  assert.ok(result.errors[0]!.message.includes('modelProbability'));
});

// Required test 5 (via attachModelProbabilities): invalid confidence → error
test('invalid confidence goes to errors, not readyPicks', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ confidence: 1.5 }); // invalid
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length, 0);
  assert.strictEqual(result.errors.length,     1);
  assert.ok(result.errors[0]!.message.includes('confidence'));
});

test('error includes the pickKey for identification', () => {
  const pick   = normalizedMoneyline();
  const record = validRecord({ modelProbability: NaN });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.ok(result.errors[0]!.pickKey.length > 0, 'pickKey should be non-empty');
});

// Required test 7: odds fields are preserved
test('americanOdds is unchanged after attaching model probability', () => {
  const pick   = normalizedMoneyline({ americanOdds: -130 });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.americanOdds, -130);
});

test('betType is unchanged after attaching model probability', () => {
  const pick   = normalizedRunLine();
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.betType, 'run_line');
});

test('marketType is unchanged after attaching model probability', () => {
  const pick   = normalizedRunLine();
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.marketType, 'run_line');
});

test('gameId is unchanged after attaching model probability', () => {
  const pick   = normalizedMoneyline({ gameId: 'game-abc-123' });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.gameId, 'game-abc-123');
});

test('team and opponent are unchanged', () => {
  const pick   = normalizedMoneyline({ team: 'NYY', opponent: 'BOS' });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.team,     'NYY');
  assert.strictEqual(result.readyPicks[0]!.opponent,  'BOS');
});

// Required test 8: oppositeAmericanOdds is preserved
test('oppositeAmericanOdds is preserved on readyPicks', () => {
  const pick   = normalizedMoneyline({ oppositeAmericanOdds: 110 });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.oppositeAmericanOdds, 110);
});

test('oppositeAmericanOdds is preserved on missingModelPicks', () => {
  const pick   = normalizedMoneyline({ oppositeAmericanOdds: 105 });
  const result = attachModelProbabilities([pick], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.missingModelPicks[0]!.oppositeAmericanOdds, 105);
});

// Required test 9: runLineSpread is preserved
test('runLineSpread is preserved on readyPicks', () => {
  const pick   = normalizedRunLine({ runLineSpread: -1.5 });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.runLineSpread, -1.5);
});

test('runLineSpread +1.5 is preserved on readyPicks', () => {
  const pick   = normalizedRunLine({ runLineSpread: 1.5 });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.runLineSpread, 1.5);
});

test('runLineSpread undefined is preserved (not set to a value)', () => {
  const pick   = normalizedMoneyline({ runLineSpread: undefined });
  const map    = mapForPick(pick, validRecord());
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.runLineSpread, undefined);
});

test('runLineSpread is preserved on missingModelPicks', () => {
  const pick   = normalizedRunLine({ runLineSpread: -2.5 });
  const result = attachModelProbabilities([pick], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.missingModelPicks[0]!.runLineSpread, -2.5);
});

// Required test 10: does not invent probability from odds
test('readyPick modelProbability is exactly what the record provides, never derived from odds', () => {
  const pick   = normalizedMoneyline({ americanOdds: -130, oppositeAmericanOdds: 110 });
  const record = validRecord({ modelProbability: 0.71 });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  // -130 implied prob ≈ 0.565. If the adapter were using odds as model prob
  // the result would be near 0.565, not 0.71.
  assert.strictEqual(result.readyPicks[0]!.modelProbability, 0.71);
  // Verify it's not derived from the odds
  const oddsImplied = 130 / (130 + 100); // ≈ 0.565
  assert.notStrictEqual(result.readyPicks[0]!.modelProbability, oddsImplied);
});

test('confidence is exactly what the record provides, never derived from odds', () => {
  const pick   = normalizedMoneyline({ americanOdds: -200 });
  const record = validRecord({ confidence: 0.88 });
  const map    = mapForPick(pick, record);
  const result = attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks[0]!.confidence, 0.88);
});

// Required test 11: multiple picks can be processed
test('processes a batch of mixed picks correctly', () => {
  const ml    = normalizedMoneyline();
  const rl    = normalizedRunLine();
  const total = normalizedTotal();
  const noRecord = normalizedMoneyline({ gameId: 'game-no-record', team: 'ATL' });

  const map: ModelProbabilityMap = {
    [buildModelKey(ml.gameId,    ml.team,    ml.betType,    ml.marketType)]:    validRecord({ modelProbability: 0.64 }),
    [buildModelKey(rl.gameId,    rl.team,    rl.betType,    rl.marketType)]:    validRecord({ modelProbability: 0.55 }),
    [buildModelKey(total.gameId, total.team, total.betType, total.marketType)]: validRecord({ modelProbability: 0.52 }),
  };

  const result = attachModelProbabilities([ml, rl, total, noRecord], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length,        3);
  assert.strictEqual(result.missingModelPicks.length, 1);
  assert.strictEqual(result.errors.length,            0);
});

test('batch processes 10 picks without issue', () => {
  const picks: OddsNormalizedPick[] = Array.from({ length: 10 }, (_, i) =>
    normalizedMoneyline({ gameId: `game-${i}`, team: `team-${i}` }),
  );
  const map: ModelProbabilityMap = {};
  for (const p of picks) {
    map[buildModelKey(p.gameId, p.team, p.betType, p.marketType)] = validRecord();
  }
  const result = attachModelProbabilities(picks, map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length,        10);
  assert.strictEqual(result.missingModelPicks.length,  0);
  assert.strictEqual(result.errors.length,             0);
});

// Required test 12: errors do not crash the full batch
test('one invalid record in a batch does not block other valid picks', () => {
  const good1  = normalizedMoneyline({ gameId: 'g1', team: 'NYY' });
  const bad    = normalizedMoneyline({ gameId: 'g2', team: 'BOS' });
  const good2  = normalizedMoneyline({ gameId: 'g3', team: 'HOU' });

  const map: ModelProbabilityMap = {
    [buildModelKey(good1.gameId, good1.team, good1.betType, good1.marketType)]: validRecord({ modelProbability: 0.65 }),
    [buildModelKey(bad.gameId,   bad.team,   bad.betType,   bad.marketType)]:   { modelProbability: 0, confidence: 0.75 }, // invalid
    [buildModelKey(good2.gameId, good2.team, good2.betType, good2.marketType)]: validRecord({ modelProbability: 0.60 }),
  };

  const result = attachModelProbabilities([good1, bad, good2], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length, 2, 'Two valid picks should succeed');
  assert.strictEqual(result.errors.length,     1, 'One error for the invalid pick');
  assert.strictEqual(result.missingModelPicks.length, 0);
});

test('empty picks array returns empty result without errors', () => {
  const result = attachModelProbabilities([], {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length,        0);
  assert.strictEqual(result.missingModelPicks.length, 0);
  assert.strictEqual(result.errors.length,            0);
});

test('empty map with non-empty picks puts all in missingModelPicks', () => {
  const picks = [normalizedMoneyline(), normalizedRunLine(), normalizedTotal()];
  const result = attachModelProbabilities(picks, {}, DEFAULT_MODEL_VERSION);
  assert.strictEqual(result.readyPicks.length,        0);
  assert.strictEqual(result.missingModelPicks.length, 3);
  assert.strictEqual(result.errors.length,            0);
});

// ─────────────────────────────────────────────────────────────────────────────
// NormalizedPick is not mutated by the adapter
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nimmutability');

test('original normalized pick is not mutated', () => {
  const pick   = normalizedMoneyline({ modelProbability: null, confidence: null });
  const map    = mapForPick(pick, validRecord({ modelProbability: 0.70 }));
  attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  // The original pick should still have null values
  assert.strictEqual(pick.modelProbability, null, 'modelProbability should remain null on original');
  assert.strictEqual(pick.confidence,       null, 'confidence should remain null on original');
});

test('original odds fields are not mutated', () => {
  const pick    = normalizedMoneyline({ americanOdds: -130, oppositeAmericanOdds: 110 });
  const origOdds = pick.americanOdds;
  const origOpp  = pick.oppositeAmericanOdds;
  const map     = mapForPick(pick, validRecord());
  attachModelProbabilities([pick], map, DEFAULT_MODEL_VERSION);
  assert.strictEqual(pick.americanOdds,         origOdds, 'americanOdds mutated');
  assert.strictEqual(pick.oppositeAmericanOdds, origOpp,  'oppositeAmericanOdds mutated');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`mlbModel.adapter — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
