import * as assert from 'assert';
import {
  mapSettlementToDbRow,
  saveSettlementResults,
  deduplicateSettlements,
  type PickResultRow,
  type SupabaseClientLike,
} from '../src/services/settlement.service';
import type { SettlementResult } from '../src/engines/settlement.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Test harness
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const asyncTests: Promise<void>[] = [];

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
  public insertedRows: PickResultRow[] = [];
  public callCount = 0;
  private simulateError: { message: string; code?: string } | null = null;

  setError(msg: string, code?: string) {
    this.simulateError = { message: msg, code };
  }

  from(_table: string) {
    return {
      insert: async (rows: unknown[]) => {
        this.callCount++;
        this.insertedRows.push(...(rows as PickResultRow[]));
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
function uid() { return `pred-${++seq}`; }

const FIXED_TS = '2025-06-01T12:00:00.000Z';

function makeSettlement(overrides: Partial<SettlementResult> = {}): SettlementResult {
  return {
    predictionId:              uid(),
    result:                    'WIN',
    stake:                     1,
    profitLoss:                0.9091,
    roi:                       0.9091,
    closingOdds:               -110,
    closingImpliedProbability: 0.5238,
    clvDecimal:                0.0200,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// mapSettlementToDbRow
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmapSettlementToDbRow');

// Required test 1: maps one settlement correctly
test('maps all fields to the correct DB columns', () => {
  const s   = makeSettlement({ predictionId: 'pred-abc' });
  const row = mapSettlementToDbRow(s, FIXED_TS);

  assert.strictEqual(row.prediction_id,               s.predictionId);
  assert.strictEqual(row.result,                      s.result);
  assert.strictEqual(row.closing_odds,                s.closingOdds);
  assert.strictEqual(row.closing_implied_probability, s.closingImpliedProbability);
  assert.strictEqual(row.clv_decimal,                 s.clvDecimal);
  assert.strictEqual(row.stake,                       s.stake);
  assert.strictEqual(row.profit_loss,                 s.profitLoss);
  assert.strictEqual(row.roi,                         s.roi);
  assert.strictEqual(row.settled_at,                  FIXED_TS);
});

test('WIN result is mapped correctly', () => {
  const row = mapSettlementToDbRow(makeSettlement({ result: 'WIN' }), FIXED_TS);
  assert.strictEqual(row.result, 'WIN');
});

test('LOSS result is mapped correctly', () => {
  const row = mapSettlementToDbRow(makeSettlement({ result: 'LOSS', profitLoss: -1, roi: -1 }), FIXED_TS);
  assert.strictEqual(row.result,      'LOSS');
  assert.strictEqual(row.profit_loss, -1);
  assert.strictEqual(row.roi,         -1);
});

test('PUSH result is mapped correctly', () => {
  const row = mapSettlementToDbRow(makeSettlement({ result: 'PUSH', profitLoss: 0, roi: 0 }), FIXED_TS);
  assert.strictEqual(row.result,      'PUSH');
  assert.strictEqual(row.profit_loss, 0);
});

test('settled_at defaults to current ISO timestamp when not provided', () => {
  const before = new Date();
  const row    = mapSettlementToDbRow(makeSettlement());
  const after  = new Date();
  const ts     = new Date(row.settled_at);
  assert.ok(ts >= before && ts <= after, `settled_at ${row.settled_at} not within expected range`);
});

test('settled_at uses provided override when given', () => {
  const row = mapSettlementToDbRow(makeSettlement(), FIXED_TS);
  assert.strictEqual(row.settled_at, FIXED_TS);
});

// Required test 4: preserves positive CLV
test('positive CLV is preserved in clv_decimal', () => {
  const row = mapSettlementToDbRow(makeSettlement({ clvDecimal: 0.045 }), FIXED_TS);
  assert.ok(row.clv_decimal! > 0, `Expected positive clv_decimal, got ${row.clv_decimal}`);
  assert.strictEqual(row.clv_decimal, 0.045);
});

// Required test 5: preserves negative CLV
test('negative CLV is preserved in clv_decimal', () => {
  const row = mapSettlementToDbRow(makeSettlement({ clvDecimal: -0.032 }), FIXED_TS);
  assert.ok(row.clv_decimal! < 0, `Expected negative clv_decimal, got ${row.clv_decimal}`);
  assert.strictEqual(row.clv_decimal, -0.032);
});

test('zero CLV is preserved in clv_decimal', () => {
  const row = mapSettlementToDbRow(makeSettlement({ clvDecimal: 0 }), FIXED_TS);
  assert.strictEqual(row.clv_decimal, 0);
});

// Required test 6: preserves profit/loss
test('positive profit_loss is preserved', () => {
  const row = mapSettlementToDbRow(makeSettlement({ profitLoss: 1.5 }), FIXED_TS);
  assert.strictEqual(row.profit_loss, 1.5);
});

test('negative profit_loss (LOSS) is preserved', () => {
  const row = mapSettlementToDbRow(makeSettlement({ profitLoss: -1 }), FIXED_TS);
  assert.strictEqual(row.profit_loss, -1);
});

test('fractional profit_loss is preserved without rounding', () => {
  const row = mapSettlementToDbRow(makeSettlement({ profitLoss: 0.9091 }), FIXED_TS);
  assert.strictEqual(row.profit_loss, 0.9091);
});

// Required test 8: throws if predictionId is missing
test('throws if predictionId is empty string', () => {
  assert.throws(
    () => mapSettlementToDbRow(makeSettlement({ predictionId: '' }), FIXED_TS),
    /predictionId/,
  );
});

test('throws if predictionId is whitespace only', () => {
  assert.throws(
    () => mapSettlementToDbRow(makeSettlement({ predictionId: '  ' }), FIXED_TS),
    /predictionId/,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// deduplicateSettlements
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ndeduplicateSettlements');

test('unique ids pass through unchanged', () => {
  const settlements = [makeSettlement(), makeSettlement(), makeSettlement()];
  const { unique, duplicates } = deduplicateSettlements(settlements);
  assert.strictEqual(unique.length,     3);
  assert.strictEqual(duplicates.length, 0);
});

// Required test 3: rejects duplicate prediction ids
test('duplicate predictionId is removed from unique and added to duplicates', () => {
  const id = uid();
  const settlements = [
    makeSettlement({ predictionId: id }),
    makeSettlement({ predictionId: id }),
  ];
  const { unique, duplicates } = deduplicateSettlements(settlements);
  assert.strictEqual(unique.length,     1);
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(duplicates[0],     id);
});

test('first occurrence is kept when duplicate is present', () => {
  const id = uid();
  const first  = makeSettlement({ predictionId: id, result: 'WIN'  });
  const second = makeSettlement({ predictionId: id, result: 'LOSS' });
  const { unique } = deduplicateSettlements([first, second]);
  assert.strictEqual(unique[0]!.result, 'WIN');
});

test('triple duplicate: two in duplicates, one in unique', () => {
  const id = uid();
  const { unique, duplicates } = deduplicateSettlements([
    makeSettlement({ predictionId: id }),
    makeSettlement({ predictionId: id }),
    makeSettlement({ predictionId: id }),
  ]);
  assert.strictEqual(unique.length,     1);
  assert.strictEqual(duplicates.length, 2);
});

test('empty array returns empty unique and duplicates', () => {
  const { unique, duplicates } = deduplicateSettlements([]);
  assert.strictEqual(unique.length,     0);
  assert.strictEqual(duplicates.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// saveSettlementResults — async
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsaveSettlementResults (async)');

// Required test 2: saves multiple settlements in one insert
asyncTest('saves multiple settlements in one batched insert call', async () => {
  const client = new FakeSupabaseClient();
  const settlements = [makeSettlement(), makeSettlement(), makeSettlement()];
  const result = await saveSettlementResults(settlements, client, FIXED_TS);
  assert.strictEqual(result.insertedCount, 3);
  assert.strictEqual(client.callCount, 1);
  assert.strictEqual(client.insertedRows.length, 3);
  assert.strictEqual(result.errors.length, 0);
});

// Required test 7: fake Supabase insert called once
asyncTest('fake Supabase insert is called exactly once regardless of row count', async () => {
  const client = new FakeSupabaseClient();
  const settlements = [makeSettlement(), makeSettlement(), makeSettlement(), makeSettlement()];
  await saveSettlementResults(settlements, client, FIXED_TS);
  assert.strictEqual(client.callCount, 1);
});

asyncTest('single settlement insert works correctly', async () => {
  const client     = new FakeSupabaseClient();
  const settlement = makeSettlement({ predictionId: 'single-pred', result: 'WIN' });
  const result     = await saveSettlementResults([settlement], client, FIXED_TS);
  assert.strictEqual(result.insertedCount, 1);
  assert.strictEqual(client.insertedRows[0]!.prediction_id, 'single-pred');
  assert.strictEqual(client.insertedRows[0]!.result, 'WIN');
});

// Required test 3 (async): rejects duplicate prediction ids before insert
asyncTest('duplicate predictionIds are removed before insert', async () => {
  const id     = uid();
  const client = new FakeSupabaseClient();
  const result = await saveSettlementResults(
    [makeSettlement({ predictionId: id }), makeSettlement({ predictionId: id })],
    client,
    FIXED_TS,
  );
  assert.strictEqual(result.insertedCount,       1);
  assert.strictEqual(result.duplicatesSkipped.length, 1);
  assert.strictEqual(result.duplicatesSkipped[0],     id);
  assert.strictEqual(client.insertedRows.length, 1);
});

asyncTest('only unique rows reach the fake client when duplicates are present', async () => {
  const id     = uid();
  const client = new FakeSupabaseClient();
  await saveSettlementResults(
    [
      makeSettlement({ predictionId: id }),
      makeSettlement({ predictionId: id }),
      makeSettlement(),
    ],
    client,
    FIXED_TS,
  );
  // 2 unique ids → 2 rows sent
  assert.strictEqual(client.insertedRows.length, 2);
});

// Required test 9: returns error if fake Supabase fails
asyncTest('returns error object when Supabase insert fails', async () => {
  const client = new FakeSupabaseClient();
  client.setError('duplicate key value violates unique constraint', '23505');
  const result = await saveSettlementResults([makeSettlement()], client, FIXED_TS);
  assert.strictEqual(result.insertedCount,  0);
  assert.strictEqual(result.errors.length,  1);
  assert.ok(result.errors[0]!.message.includes('duplicate key'));
});

asyncTest('error code is preserved from Supabase error response', async () => {
  const client = new FakeSupabaseClient();
  client.setError('relation "pick_results" does not exist', '42P01');
  const result = await saveSettlementResults([makeSettlement()], client, FIXED_TS);
  assert.strictEqual(result.errors[0]!.code, '42P01');
});

asyncTest('Supabase error does not crash — returns errors array', async () => {
  const client = new FakeSupabaseClient();
  client.setError('connection timeout');
  let threw = false;
  try {
    await saveSettlementResults([makeSettlement()], client, FIXED_TS);
  } catch {
    threw = true;
  }
  assert.strictEqual(threw, false, 'saveSettlementResults should not throw on DB error');
});

asyncTest('empty input returns 0 inserted without calling insert', async () => {
  const client = new FakeSupabaseClient();
  const result = await saveSettlementResults([], client, FIXED_TS);
  assert.strictEqual(result.insertedCount, 0);
  assert.strictEqual(client.callCount,     0);
  assert.strictEqual(result.errors.length, 0);
});

asyncTest('duplicate pair: first inserted once, second skipped — one insert call', async () => {
  // deduplicateSettlements keeps the FIRST occurrence and marks the second as duplicate.
  // The first occurrence is still valid and gets inserted — insert is called once with 1 row.
  // callCount=0 only happens when ALL items are in duplicates (empty unique array),
  // which can only occur if the batch is truly empty after dedup — impossible since
  // we always keep first occurrences. Test the correct invariant:
  const id     = uid();
  const client = new FakeSupabaseClient();
  const result = await saveSettlementResults(
    [makeSettlement({ predictionId: id }), makeSettlement({ predictionId: id })],
    client,
    FIXED_TS,
  );
  // First occurrence inserted, second skipped
  assert.strictEqual(result.insertedCount,            1);
  assert.strictEqual(result.duplicatesSkipped.length, 1);
  assert.strictEqual(result.duplicatesSkipped[0],     id);
  // Exactly one insert call with exactly one row
  assert.strictEqual(client.callCount,    1);
  assert.strictEqual(client.insertedRows.length, 1);
});

// Positive and negative CLV preserved through the full save path
asyncTest('positive CLV is preserved end-to-end through save', async () => {
  const client = new FakeSupabaseClient();
  await saveSettlementResults(
    [makeSettlement({ clvDecimal: 0.072 })],
    client,
    FIXED_TS,
  );
  assert.strictEqual(client.insertedRows[0]!.clv_decimal, 0.072);
});

asyncTest('negative CLV is preserved end-to-end through save', async () => {
  const client = new FakeSupabaseClient();
  await saveSettlementResults(
    [makeSettlement({ clvDecimal: -0.041 })],
    client,
    FIXED_TS,
  );
  assert.strictEqual(client.insertedRows[0]!.clv_decimal, -0.041);
});

asyncTest('profit_loss is preserved for WIN, LOSS, and PUSH', async () => {
  const client = new FakeSupabaseClient();
  await saveSettlementResults(
    [
      makeSettlement({ result: 'WIN',  profitLoss:  1.5   }),
      makeSettlement({ result: 'LOSS', profitLoss: -1.0   }),
      makeSettlement({ result: 'PUSH', profitLoss:  0.0   }),
    ],
    client,
    FIXED_TS,
  );
  const pls = client.insertedRows.map(r => r.profit_loss);
  assert.ok(pls.includes(1.5),  'WIN profit_loss not found');
  assert.ok(pls.includes(-1.0), 'LOSS profit_loss not found');
  assert.ok(pls.includes(0.0),  'PUSH profit_loss not found');
});

asyncTest('settled_at timestamp is consistent across all rows in a batch', async () => {
  const client = new FakeSupabaseClient();
  await saveSettlementResults(
    [makeSettlement(), makeSettlement(), makeSettlement()],
    client,
    FIXED_TS,
  );
  const timestamps = client.insertedRows.map(r => r.settled_at);
  const unique     = new Set(timestamps);
  assert.strictEqual(unique.size, 1, 'All rows should share the same settled_at');
  assert.strictEqual(timestamps[0], FIXED_TS);
});

asyncTest('save result contains insertedCount, duplicatesSkipped, errors', () => {
  const r = saveSettlementResults([], new FakeSupabaseClient(), FIXED_TS);
  r.then(result => {
    assert.ok('insertedCount'      in result);
    assert.ok('duplicatesSkipped'  in result);
    assert.ok('errors'             in result);
  });
  return r.then(() => {});
});

asyncTest('throws if any unique settlement has blank predictionId (mapping error)', async () => {
  const badSettlement = makeSettlement({ predictionId: '' });
  let threw = false;
  try {
    await saveSettlementResults([badSettlement], new FakeSupabaseClient(), FIXED_TS);
  } catch (e: unknown) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    assert.ok(msg.includes('predictionId'), `Expected predictionId error, got: ${msg}`);
  }
  assert.ok(threw, 'Expected saveSettlementResults to throw on blank predictionId');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`settlement.service — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
