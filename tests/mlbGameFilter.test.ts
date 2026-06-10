import * as assert from 'assert';
import {
  isBlockedGameStatus,
  isAllowedGameStatus,
  isGameStarted,
  filterPregameOnly,
  buildLiveGameWarning,
  ALLOWED_GAME_STATUSES,
  type FilterablePick,
} from '../src/adapters/mlbGameFilter';

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

// An hour from now — game hasn't started
const FUTURE_GAME_TIME = new Date(Date.now() + 3_600_000).toISOString();
// An hour ago — game has started  
const PAST_GAME_TIME   = new Date(Date.now() - 3_600_000).toISOString();

function makePick(
  gameId    = 'game-001',
  team      = 'NYY',
  status?: string,
  dt?: string,
): FilterablePick {
  return { gameId, team, gameStatus: status, gameDateTime: dt };
}

// ─────────────────────────────────────────────────────────────────────────────
// isBlockedGameStatus
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nisBlockedGameStatus');

test('returns false for undefined (unknown = assume pregame)', () => {
  assert.strictEqual(isBlockedGameStatus(undefined), false);
});

test('returns false for "Scheduled"', () => {
  assert.strictEqual(isBlockedGameStatus('Scheduled'), false);
});

test('returns false for "Pre-Game"', () => {
  assert.strictEqual(isBlockedGameStatus('Pre-Game'), false);
});

test('returns false for "Preview"', () => {
  assert.strictEqual(isBlockedGameStatus('Preview'), false);
});

test('returns false for "Warmup"', () => {
  assert.strictEqual(isBlockedGameStatus('Warmup'), false);
});

// Live states must be blocked
test('returns true for "Live"', () => {
  assert.strictEqual(isBlockedGameStatus('Live'), true);
});

test('returns true for "In Progress"', () => {
  assert.strictEqual(isBlockedGameStatus('In Progress'), true);
});

test('returns true for "Manager Challenge"', () => {
  assert.strictEqual(isBlockedGameStatus('Manager Challenge'), true);
});

// Final states must be blocked
test('returns true for "Final"', () => {
  assert.strictEqual(isBlockedGameStatus('Final'), true);
});

test('returns true for "Game Over"', () => {
  assert.strictEqual(isBlockedGameStatus('Game Over'), true);
});

test('returns true for "Completed Early"', () => {
  assert.strictEqual(isBlockedGameStatus('Completed Early'), true);
});

// Delayed / Suspended
test('returns true for "Postponed"', () => {
  assert.strictEqual(isBlockedGameStatus('Postponed'), true);
});

test('returns true for "Suspended"', () => {
  assert.strictEqual(isBlockedGameStatus('Suspended'), true);
});

test('returns true for "Delayed"', () => {
  assert.strictEqual(isBlockedGameStatus('Delayed'), true);
});

test('returns true for "Rain Delay"', () => {
  assert.strictEqual(isBlockedGameStatus('Rain Delay'), true);
});

test('returns true for "Cancelled"', () => {
  assert.strictEqual(isBlockedGameStatus('Cancelled'), true);
});

// Variants via substring
test('returns true for "Final: Rain" (variant)', () => {
  assert.strictEqual(isBlockedGameStatus('Final: Rain'), true);
});

test('returns true for "Delayed - Rain"', () => {
  assert.strictEqual(isBlockedGameStatus('Delayed - Rain'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// isAllowedGameStatus
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nisAllowedGameStatus');

test('allows undefined (unknown status = allow)', () => {
  assert.strictEqual(isAllowedGameStatus(undefined), true);
});

for (const s of ALLOWED_GAME_STATUSES) {
  test(`allows "${s}"`, () => {
    assert.strictEqual(isAllowedGameStatus(s), true);
  });
}

for (const s of ['Live', 'In Progress', 'Final', 'Postponed', 'Cancelled', 'Suspended']) {
  test(`rejects "${s}"`, () => {
    assert.strictEqual(isAllowedGameStatus(s), false);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// isGameStarted
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nisGameStarted');

test('returns false for undefined gameDateTime', () => {
  assert.strictEqual(isGameStarted(undefined), false);
});

test('returns false when game is in the future', () => {
  assert.strictEqual(isGameStarted(FUTURE_GAME_TIME), false);
});

test('returns true when game time has passed', () => {
  assert.strictEqual(isGameStarted(PAST_GAME_TIME), true);
});

test('returns true exactly at game start time', () => {
  const now = Date.now();
  assert.strictEqual(isGameStarted(new Date(now).toISOString(), now), true);
});

test('returns false for invalid date string', () => {
  assert.strictEqual(isGameStarted('not-a-date'), false);
});

test('injectable nowMs parameter works correctly', () => {
  const gameTime = new Date('2025-06-10T18:05:00Z').getTime();
  // 5 minutes before: not started
  assert.strictEqual(isGameStarted('2025-06-10T18:05:00Z', gameTime - 300_000), false);
  // 5 minutes after: started
  assert.strictEqual(isGameStarted('2025-06-10T18:05:00Z', gameTime + 300_000), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// filterPregameOnly — core requirement: live games never reach ranking
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nfilterPregameOnly');

// Requirement 9: prove live games never reach ranking
test('live game pick is excluded from allowed', () => {
  const pick = makePick('g1', 'NYY', 'In Progress', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length,  0);
  assert.strictEqual(result.excluded.length, 1);
});

test('final game pick is excluded', () => {
  const pick = makePick('g1', 'NYY', 'Final', PAST_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.excluded.length, 1);
});

test('postponed game pick is excluded', () => {
  const pick = makePick('g1', 'NYY', 'Postponed');
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.excluded.length, 1);
});

test('scheduled future game is allowed', () => {
  const pick = makePick('g1', 'NYY', 'Scheduled', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length,  1);
  assert.strictEqual(result.excluded.length, 0);
});

test('pre-game future game is allowed', () => {
  const pick = makePick('g1', 'NYY', 'Pre-Game', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length, 1);
});

test('preview game is allowed', () => {
  const pick = makePick('g1', 'NYY', 'Preview', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length, 1);
});

test('warmup game is allowed', () => {
  const pick = makePick('g1', 'NYY', 'Warmup', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length, 1);
});

// Time-based exclusion regardless of status
test('scheduled game excluded when start time has passed', () => {
  const pick = makePick('g1', 'NYY', 'Scheduled', PAST_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.excluded.length, 1,
    'Should be excluded because game time has passed even though status is Scheduled');
});

test('unknown status with future time is allowed', () => {
  const pick = makePick('g1', 'NYY', undefined, FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length, 1);
});

test('unknown status with past time is excluded', () => {
  const pick = makePick('g1', 'NYY', undefined, PAST_GAME_TIME);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.excluded.length, 1,
    'Game has started — exclude regardless of status');
});

test('completely unknown (no status, no time) is allowed', () => {
  const pick = makePick('g1', 'NYY', undefined, undefined);
  const result = filterPregameOnly([pick]);
  assert.strictEqual(result.allowed.length, 1,
    'No data = assume pregame, do not block');
});

test('excludedCount matches excluded array length', () => {
  const picks = [
    makePick('g1', 'NYY', 'In Progress'),
    makePick('g2', 'BOS', 'Scheduled', FUTURE_GAME_TIME),
    makePick('g3', 'LAD', 'Final'),
    makePick('g4', 'HOU', 'Pre-Game', FUTURE_GAME_TIME),
  ];
  const result = filterPregameOnly(picks);
  assert.strictEqual(result.excludedCount, result.excluded.length);
  assert.strictEqual(result.allowed.length,  2);
  assert.strictEqual(result.excluded.length, 2);
});

test('reasons map is populated for excluded picks', () => {
  const pick = makePick('g1', 'NYY', 'In Progress', FUTURE_GAME_TIME);
  const result = filterPregameOnly([pick]);
  const key = 'g1|NYY';
  assert.ok(key in result.reasons, 'Reason should be keyed by gameId|team');
  assert.ok(result.reasons[key]!.length > 0, 'Reason should be non-empty');
  assert.ok(result.reasons[key]!.toLowerCase().includes('progress') ||
            result.reasons[key]!.toLowerCase().includes('pregame'),
            `Reason should describe why: ${result.reasons[key]}`);
});

test('injectable nowMs: future game excluded when clock passed it', () => {
  const gameTime = '2025-06-10T18:05:00Z';
  const afterGame = new Date('2025-06-10T20:00:00Z').getTime();
  const pick = makePick('g1', 'NYY', 'Scheduled', gameTime);
  const result = filterPregameOnly([pick], afterGame);
  assert.strictEqual(result.excluded.length, 1);
});

test('injectable nowMs: same game allowed when clock is before start', () => {
  const gameTime = '2025-06-10T18:05:00Z';
  const beforeGame = new Date('2025-06-10T16:00:00Z').getTime();
  const pick = makePick('g1', 'NYY', 'Scheduled', gameTime);
  const result = filterPregameOnly([pick], beforeGame);
  assert.strictEqual(result.allowed.length, 1);
});

test('empty picks array returns empty result', () => {
  const result = filterPregameOnly([]);
  assert.strictEqual(result.allowed.length,  0);
  assert.strictEqual(result.excluded.length, 0);
  assert.strictEqual(result.excludedCount,   0);
});

// ─────────────────────────────────────────────────────────────────────────────
// buildLiveGameWarning
// ─────────────────────────────────────────────────────────────────────────────

console.log('\nbuildLiveGameWarning');

test('returns null when excludedCount = 0', () => {
  assert.strictEqual(buildLiveGameWarning(0), null);
});

test('returns singular warning for 1 excluded', () => {
  const w = buildLiveGameWarning(1);
  assert.ok(w !== null);
  assert.ok(w!.includes('1'), 'Should include count');
  assert.ok(!w!.endsWith('games'), 'Should use singular for 1');
});

test('returns plural warning for N > 1 excluded', () => {
  const w = buildLiveGameWarning(5);
  assert.ok(w !== null);
  assert.ok(w!.includes('5'));
  assert.ok(w!.includes('games'), 'Should use plural for 5');
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`mlbGameFilter — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
