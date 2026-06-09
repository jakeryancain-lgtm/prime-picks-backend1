import * as assert from 'assert';
import {
  readSupabaseConfig,
  createSupabaseClient,
  getSupabaseClient,
  resetSupabaseClient,
} from '../src/config/supabase';
import type { SupabaseClientLike } from '../src/services/supabase.types';

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
// Env var helpers — save/restore around each test
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

function setEnv(url: string | undefined, key: string | undefined) {
  if (url === undefined) {
    delete process.env['SUPABASE_URL'];
  } else {
    process.env['SUPABASE_URL'] = url;
  }
  if (key === undefined) {
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
  } else {
    process.env['SUPABASE_SERVICE_ROLE_KEY'] = key;
  }
}

function restoreEnv() {
  // Remove any keys we may have set
  delete process.env['SUPABASE_URL'];
  delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
  // Restore original values if they existed
  if (ORIGINAL_ENV['SUPABASE_URL'])              process.env['SUPABASE_URL']              = ORIGINAL_ENV['SUPABASE_URL'];
  if (ORIGINAL_ENV['SUPABASE_SERVICE_ROLE_KEY']) process.env['SUPABASE_SERVICE_ROLE_KEY'] = ORIGINAL_ENV['SUPABASE_SERVICE_ROLE_KEY'];
  // Always reset the singleton so tests don't bleed into each other
  resetSupabaseClient();
}

const VALID_URL = 'https://test-project.supabase.co';
const VALID_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-service-role-key';

// ─────────────────────────────────────────────────────────────────────────────
// readSupabaseConfig — env var validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nreadSupabaseConfig');

test('returns config object when both env vars are set', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const config = readSupabaseConfig();
    assert.strictEqual(config.url,            VALID_URL);
    assert.strictEqual(config.serviceRoleKey, VALID_KEY);
  } finally {
    restoreEnv();
  }
});

test('trims whitespace from env var values', () => {
  setEnv(`  ${VALID_URL}  `, `  ${VALID_KEY}  `);
  try {
    const config = readSupabaseConfig();
    assert.strictEqual(config.url,            VALID_URL);
    assert.strictEqual(config.serviceRoleKey, VALID_KEY);
  } finally {
    restoreEnv();
  }
});

// Required: missing SUPABASE_URL throws
test('throws when SUPABASE_URL is not set', () => {
  setEnv(undefined, VALID_KEY);
  try {
    assert.throws(
      () => readSupabaseConfig(),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        return msg.includes('SUPABASE_URL');
      },
    );
  } finally {
    restoreEnv();
  }
});

test('throws when SUPABASE_URL is empty string', () => {
  setEnv('', VALID_KEY);
  try {
    assert.throws(
      () => readSupabaseConfig(),
      /SUPABASE_URL/,
    );
  } finally {
    restoreEnv();
  }
});

test('throws when SUPABASE_URL is whitespace only', () => {
  setEnv('   ', VALID_KEY);
  try {
    assert.throws(
      () => readSupabaseConfig(),
      /SUPABASE_URL/,
    );
  } finally {
    restoreEnv();
  }
});

// Required: missing SUPABASE_SERVICE_ROLE_KEY throws
test('throws when SUPABASE_SERVICE_ROLE_KEY is not set', () => {
  setEnv(VALID_URL, undefined);
  try {
    assert.throws(
      () => readSupabaseConfig(),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : '';
        return msg.includes('SUPABASE_SERVICE_ROLE_KEY');
      },
    );
  } finally {
    restoreEnv();
  }
});

test('throws when SUPABASE_SERVICE_ROLE_KEY is empty string', () => {
  setEnv(VALID_URL, '');
  try {
    assert.throws(
      () => readSupabaseConfig(),
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  } finally {
    restoreEnv();
  }
});

test('throws when SUPABASE_SERVICE_ROLE_KEY is whitespace only', () => {
  setEnv(VALID_URL, '   ');
  try {
    assert.throws(
      () => readSupabaseConfig(),
      /SUPABASE_SERVICE_ROLE_KEY/,
    );
  } finally {
    restoreEnv();
  }
});

test('URL-specific error message is descriptive', () => {
  setEnv(undefined, VALID_KEY);
  try {
    let message = '';
    try { readSupabaseConfig(); } catch (e) { message = e instanceof Error ? e.message : ''; }
    assert.ok(message.includes('SUPABASE_URL'), 'Error should name the missing variable');
    assert.ok(message.length > 20, 'Error message should be descriptive');
  } finally {
    restoreEnv();
  }
});

test('key-specific error message is descriptive', () => {
  setEnv(VALID_URL, undefined);
  try {
    let message = '';
    try { readSupabaseConfig(); } catch (e) { message = e instanceof Error ? e.message : ''; }
    assert.ok(message.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Error should name the missing variable');
    assert.ok(message.length > 20, 'Error message should be descriptive');
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// createSupabaseClient
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ncreateSupabaseClient');

// Required: createSupabaseClient returns a client-like object
test('returns an object with a from() method when given valid config', () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  assert.strictEqual(typeof client.from, 'function');
});

test('from() returns an object with an insert() method', () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const tableRef = client.from('model_predictions');
  assert.strictEqual(typeof tableRef.insert, 'function');
});

test('insert() returns a Promise', () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const result = client.from('model_predictions').insert([]);
  assert.ok(result instanceof Promise, 'insert() should return a Promise');
  // Consume the promise to avoid unhandled rejection in network-blocked env
  result.catch(() => {});
});

test('satisfies SupabaseClientLike interface at the type level', () => {
  // TypeScript compile check: assign to the interface type
  const client: SupabaseClientLike = createSupabaseClient({
    url:            VALID_URL,
    serviceRoleKey: VALID_KEY,
  });
  assert.ok(client, 'Should assign without type error');
});

test('each call to createSupabaseClient returns a new instance', () => {
  const c1 = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const c2 = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  assert.notStrictEqual(c1, c2, 'createSupabaseClient should return new instances');
});

test('throws when called without config and env vars are missing', () => {
  setEnv(undefined, undefined);
  try {
    assert.throws(
      () => createSupabaseClient(),
      /SUPABASE_URL/,
    );
  } finally {
    restoreEnv();
  }
});

test('uses env vars when called without explicit config', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const client = createSupabaseClient();
    assert.strictEqual(typeof client.from, 'function');
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// getSupabaseClient — singleton
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ngetSupabaseClient (singleton)');

// Required: singleton returns the same instance
test('returns the same instance on repeated calls', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const c1 = getSupabaseClient();
    const c2 = getSupabaseClient();
    const c3 = getSupabaseClient();
    assert.strictEqual(c1, c2, 'First and second call should return same instance');
    assert.strictEqual(c2, c3, 'Second and third call should return same instance');
  } finally {
    restoreEnv();
  }
});

test('singleton satisfies SupabaseClientLike interface', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const client: SupabaseClientLike = getSupabaseClient();
    assert.strictEqual(typeof client.from, 'function');
  } finally {
    restoreEnv();
  }
});

test('throws when env vars are not set', () => {
  setEnv(undefined, undefined);
  try {
    assert.throws(
      () => getSupabaseClient(),
      /SUPABASE_URL/,
    );
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// resetSupabaseClient — test helper
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nresetSupabaseClient');

test('reset clears the singleton — next call creates a new instance', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const before = getSupabaseClient();
    resetSupabaseClient();
    const after = getSupabaseClient();
    assert.notStrictEqual(before, after, 'After reset, a new instance should be created');
  } finally {
    restoreEnv();
  }
});

test('reset allows fresh env vars to take effect', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    const first = getSupabaseClient();
    resetSupabaseClient();
    // Change the URL — new singleton should use the new URL
    const NEW_URL = 'https://other-project.supabase.co';
    setEnv(NEW_URL, VALID_KEY);
    const second = getSupabaseClient();
    assert.notStrictEqual(first, second, 'New instance should be different after reset');
  } finally {
    restoreEnv();
  }
});

test('multiple resets do not throw', () => {
  setEnv(VALID_URL, VALID_KEY);
  try {
    resetSupabaseClient();
    resetSupabaseClient();
    resetSupabaseClient();
    // Should still work after multiple resets
    const client = getSupabaseClient();
    assert.ok(client);
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// insert with empty rows — network-safe path
// ─────────────────────────────────────────────────────────────────────────────

console.log('\ninsert behaviour (no network)');

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

asyncTest('insert with empty rows resolves without making a network call', async () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const result = await client.from('model_predictions').insert([]);
  assert.deepStrictEqual(result.data, []);
  assert.strictEqual(result.error, null);
});

asyncTest('insert with empty rows returns { data: [], error: null }', async () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const { data, error } = await client.from('pick_results').insert([]);
  assert.ok(Array.isArray(data), 'data should be an array');
  assert.strictEqual(error, null);
});

asyncTest('from() can be called on any table name', async () => {
  const client = createSupabaseClient({ url: VALID_URL, serviceRoleKey: VALID_KEY });
  const tables = ['model_predictions', 'pick_results', 'backtests', 'model_versions'];
  for (const table of tables) {
    const ref = client.from(table);
    assert.strictEqual(typeof ref.insert, 'function', `insert missing for table ${table}`);
    // Verify empty insert works on each
    const result = await ref.insert([]);
    assert.strictEqual(result.error, null, `error on empty insert for ${table}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`supabase.config — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
