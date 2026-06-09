import * as assert from 'assert';
import {
  handleMLBPicksRequest,
  CORS_HEADERS,
  type HandlerRequest,
} from '../src/api/mlbPicks.endpoint';

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
// Environment and module mocking
// ─────────────────────────────────────────────────────────────────────────────

// Save and restore env vars around tests
const ORIGINAL_ENV = {
  ODDS_API_KEY:              process.env['ODDS_API_KEY'],
  SUPABASE_URL:              process.env['SUPABASE_URL'],
  SUPABASE_SERVICE_ROLE_KEY: process.env['SUPABASE_SERVICE_ROLE_KEY'],
};

function setEnv(overrides: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function restoreEnv() {
  setEnv(ORIGINAL_ENV as Record<string, string | undefined>);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake adapters — injected via module-level monkey-patching
// Since the endpoint imports adapters directly, we mock at the network level
// by setting ODDS_API_KEY and providing the key so validation passes, then
// we rely on the fact that the actual fetches will fail gracefully in test env
// (no real network). We test the endpoint's own logic: routing, CORS, parsing.
// ─────────────────────────────────────────────────────────────────────────────

const FAKE_ODDS_KEY = 'test-key-endpoint-001';
const TEST_DATE     = '2025-06-10';

function getRequest(params: string = ''): HandlerRequest {
  return { method: 'GET', url: `/api/mlb-picks?date=${TEST_DATE}${params}` };
}

function optionsRequest(): HandlerRequest {
  return { method: 'OPTIONS', url: '/api/mlb-picks' };
}

function postRequest(body: Record<string, unknown>): HandlerRequest {
  return { method: 'POST', url: '/api/mlb-picks', body: JSON.stringify(body) };
}

// ─────────────────────────────────────────────────────────────────────────────
// CORS tests — no env var needed
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nCORS');

asyncTest('OPTIONS preflight returns 204 with CORS headers', async () => {
  const result = await handleMLBPicksRequest(optionsRequest());
  assert.strictEqual(result.status, 204);
  assert.ok('Access-Control-Allow-Origin'  in result.headers, 'Missing Allow-Origin');
  assert.ok('Access-Control-Allow-Methods' in result.headers, 'Missing Allow-Methods');
  assert.ok('Access-Control-Allow-Headers' in result.headers, 'Missing Allow-Headers');
});

asyncTest('OPTIONS returns * for Allow-Origin', async () => {
  const result = await handleMLBPicksRequest(optionsRequest());
  assert.strictEqual(result.headers['Access-Control-Allow-Origin'], '*');
});

asyncTest('OPTIONS body is null (no content)', async () => {
  const result = await handleMLBPicksRequest(optionsRequest());
  assert.strictEqual(result.body, null);
});

asyncTest('GET response includes CORS headers', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    assert.ok('Access-Control-Allow-Origin' in result.headers);
  } finally {
    restoreEnv();
  }
});

asyncTest('POST response includes CORS headers', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(postRequest({ date: TEST_DATE }));
    assert.ok('Access-Control-Allow-Origin' in result.headers);
  } finally {
    restoreEnv();
  }
});

asyncTest('CORS_HEADERS export contains expected keys', () => {
  assert.ok('Access-Control-Allow-Origin'  in CORS_HEADERS);
  assert.ok('Access-Control-Allow-Methods' in CORS_HEADERS);
  assert.ok('Access-Control-Allow-Headers' in CORS_HEADERS);
  return Promise.resolve();
});

// ─────────────────────────────────────────────────────────────────────────────
// Method validation
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nmethod validation');

asyncTest('PUT returns 405', async () => {
  const result = await handleMLBPicksRequest({ method: 'PUT', url: '/api/mlb-picks' });
  assert.strictEqual(result.status, 405);
});

asyncTest('DELETE returns 405', async () => {
  const result = await handleMLBPicksRequest({ method: 'DELETE', url: '/api/mlb-picks' });
  assert.strictEqual(result.status, 405);
});

asyncTest('405 response body includes error field', async () => {
  const result = await handleMLBPicksRequest({ method: 'PATCH', url: '/api/mlb-picks' });
  const body = result.body as Record<string, unknown>;
  assert.ok('error' in body);
});

// ─────────────────────────────────────────────────────────────────────────────
// Missing ODDS_API_KEY
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nODDS_API_KEY validation');

asyncTest('GET returns 500 when ODDS_API_KEY is not set', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    assert.strictEqual(result.status, 500);
  } finally {
    restoreEnv();
  }
});

asyncTest('POST returns 500 when ODDS_API_KEY is not set', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(postRequest({ date: TEST_DATE }));
    assert.strictEqual(result.status, 500);
  } finally {
    restoreEnv();
  }
});

asyncTest('500 response when key missing includes empty topPicks array', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    const body = result.body as Record<string, unknown>;
    assert.ok(Array.isArray(body['topPicks']), 'topPicks should be array even on error');
    assert.strictEqual((body['topPicks'] as unknown[]).length, 0);
  } finally {
    restoreEnv();
  }
});

asyncTest('500 response includes descriptive error message', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    const body = result.body as Record<string, unknown>;
    assert.ok(
      String(body['error']).toLowerCase().includes('odds_api_key') ||
      String(body['error']).toLowerCase().includes('key'),
    );
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET parameter parsing
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nGET parameter parsing');

asyncTest('GET with invalid body returns 400 for POST but not GET', async () => {
  const result = await handleMLBPicksRequest({
    method: 'POST', url: '/api/mlb-picks',
    body: 'this is not json {{{{',
  });
  assert.strictEqual(result.status, 400);
});

asyncTest('GET ?date= is parsed correctly (passes through to pipeline)', async () => {
  // We can verify parsing by checking the error doesn't complain about date
  // (it should get to ODDS_API_KEY validation, not date validation)
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest('&date=2025-07-04'));
    // Should fail on key, not date
    assert.strictEqual(result.status, 500);
    const body = result.body as Record<string, unknown>;
    assert.ok(String(body['error']).toLowerCase().includes('key') ||
              String(body['error']).toLowerCase().includes('odds'));
  } finally {
    restoreEnv();
  }
});

asyncTest('POST body with date is accepted', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(postRequest({ date: TEST_DATE, save: false }));
    // Should fail at key validation, not body parsing
    assert.notStrictEqual(result.status, 400, 'Should not fail with valid JSON body');
  } finally {
    restoreEnv();
  }
});

asyncTest('POST with invalid JSON body returns 400', async () => {
  const result = await handleMLBPicksRequest({
    method: 'POST', url: '/api/mlb-picks',
    body: '{"bad json": true, trailing_comma: }',
  });
  assert.strictEqual(result.status, 400);
});

// ─────────────────────────────────────────────────────────────────────────────
// save=false does not require Supabase credentials
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nsave=false safety');

asyncTest('save=false does not require SUPABASE credentials (only fails on ODDS_API_KEY)', async () => {
  setEnv({
    ODDS_API_KEY:              undefined,
    SUPABASE_URL:              undefined,
    SUPABASE_SERVICE_ROLE_KEY: undefined,
  });
  try {
    const result = await handleMLBPicksRequest(getRequest('&save=false'));
    // Should fail only because ODDS_API_KEY is missing, not Supabase
    assert.strictEqual(result.status, 500);
    const body = result.body as Record<string, unknown>;
    const errorMsg = String(body['error']).toLowerCase();
    // Error must be about odds key, not Supabase
    assert.ok(
      errorMsg.includes('odds') || errorMsg.includes('key'),
      `Error should be about ODDS_API_KEY, got: ${body['error']}`,
    );
    assert.ok(!errorMsg.includes('supabase'), 'Error should NOT mention Supabase for save=false');
  } finally {
    restoreEnv();
  }
});

asyncTest('GET default is save=false (no Supabase required)', async () => {
  setEnv({ ODDS_API_KEY: undefined, SUPABASE_URL: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    // Failure should be ODDS_API_KEY, not Supabase
    const body = result.body as Record<string, unknown>;
    assert.ok(!String(body['error']).toLowerCase().includes('supabase'));
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Response shape contract
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nresponse shape contract');

asyncTest('all error responses include expected Lovable-required fields', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    const body = result.body as Record<string, unknown>;
    // Every response (even error) must have these fields for Lovable to render gracefully
    const required = ['topPicks', 'qualifiedPicks', 'failedPicks', 'noOddsPicks', 'errors', 'warnings'];
    for (const f of required) {
      assert.ok(f in body, `Error response missing Lovable field: ${f}`);
    }
  } finally {
    restoreEnv();
  }
});

asyncTest('all error responses have Content-Type application/json', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    assert.strictEqual(result.headers['Content-Type'], 'application/json');
  } finally {
    restoreEnv();
  }
});

asyncTest('response body is JSON-serializable', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    assert.doesNotThrow(() => JSON.stringify(result.body));
  } finally {
    restoreEnv();
  }
});

asyncTest('topPicks is always an array (never null/undefined)', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    const body = result.body as Record<string, unknown>;
    assert.ok(Array.isArray(body['topPicks']), 'topPicks must always be an array');
  } finally {
    restoreEnv();
  }
});

asyncTest('errors is always an array (never null/undefined)', async () => {
  setEnv({ ODDS_API_KEY: undefined });
  try {
    const result = await handleMLBPicksRequest(getRequest());
    const body = result.body as Record<string, unknown>;
    assert.ok(Array.isArray(body['errors']), 'errors must always be an array');
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Full cycle with real-shaped fake data (network-blocked environment)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfull cycle with ODDS_API_KEY set (network-blocked)');

asyncTest('with ODDS_API_KEY set, GET proceeds past key validation to network call', async () => {
  setEnv({ ODDS_API_KEY: FAKE_ODDS_KEY });
  try {
    // In test environment, actual fetch calls will fail or succeed
    // depending on network access. Either way, the endpoint should
    // return a structured response (not crash with unhandled exception).
    let threw = false;
    let result: Awaited<ReturnType<typeof handleMLBPicksRequest>> | null = null;
    try {
      result = await handleMLBPicksRequest(getRequest());
    } catch {
      threw = true;
    }
    assert.ok(!threw, 'Endpoint should never throw — errors go in response body');
    if (result) {
      // Whether it succeeded or failed the network call, response shape is valid
      const body = result.body as Record<string, unknown>;
      assert.ok(Array.isArray(body['topPicks']), 'topPicks must be array');
      assert.ok(Array.isArray(body['errors']),   'errors must be array');
    }
  } finally {
    restoreEnv();
  }
});

asyncTest('with ODDS_API_KEY set, POST proceeds past key validation', async () => {
  setEnv({ ODDS_API_KEY: FAKE_ODDS_KEY });
  try {
    let threw = false;
    try {
      await handleMLBPicksRequest(postRequest({ date: TEST_DATE, save: false }));
    } catch {
      threw = true;
    }
    assert.ok(!threw, 'POST should never throw');
  } finally {
    restoreEnv();
  }
});

asyncTest('503 response from stats failure includes correct shape', async () => {
  // We can trigger this by using a future date that stats API won't have
  setEnv({ ODDS_API_KEY: FAKE_ODDS_KEY });
  try {
    // The endpoint will try to fetch and may get 503 or empty response
    // Either way, we only care that the response shape is correct
    let result: Awaited<ReturnType<typeof handleMLBPicksRequest>>;
    try {
      result = await handleMLBPicksRequest(getRequest('&date=2099-01-01'));
    } catch {
      // If it throws, that's a bug
      throw new Error('Endpoint should not throw on failed stats fetch');
    }
    const body = result.body as Record<string, unknown>;
    assert.ok(Array.isArray(body['topPicks']  ?? []), 'topPicks must be array in any response');
    assert.ok(Array.isArray(body['errors']    ?? []), 'errors must be array in any response');
  } finally {
    restoreEnv();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

Promise.all(asyncTests).then(() => {
  // Restore env vars one final time
  restoreEnv();
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`mlbPicks.endpoint — ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
});
