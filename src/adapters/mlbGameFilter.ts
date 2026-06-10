// =============================================================================
// MLB Game Filter — Pregame-Only Guard
// =============================================================================
// Excludes any game that is not strictly in a pregame state before picks are
// ranked, saved, or displayed. Uses two independent checks:
//
//   1. MLB official status string from the Stats API
//   2. Wall-clock time vs. scheduled game start time
//
// A pick is excluded if EITHER check fails. This prevents any live or
// finished game from ever reaching the pipeline, Supabase, or the UI.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// MLB Status classification
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Official MLB `abstractGameState` and `detailedState` strings returned by
 * the Stats API schedule endpoint (hydrate=status).
 *
 * ALLOWED states — only these may proceed to ranking and saving:
 *   "Scheduled", "Pre-Game", "Preview", "Warmup"
 *
 * BLOCKED states — picks from these games are excluded:
 *   Live / In Progress:   "Live", "In Progress", "Manager Challenge"
 *   Final:               "Final", "Game Over", "Completed Early"
 *   Delayed:             "Delayed", "Delayed Start", "Rain Delay",
 *                        "Suspended", "Delayed - Rain", "Delayed - Other"
 *   Cancelled/Other:     "Postponed", "Cancelled", "Forfeit"
 */
export const ALLOWED_GAME_STATUSES = new Set([
  'Scheduled',
  'Pre-Game',
  'Preview',
  'Warmup',
]);

export const BLOCKED_GAME_STATUSES = new Set([
  // Live
  'Live',
  'In Progress',
  'Manager Challenge',
  'Instant Replay - Challenge',
  // Final
  'Final',
  'Game Over',
  'Completed Early',
  // Delayed / Suspended
  'Delayed',
  'Delayed Start',
  'Rain Delay',
  'Suspended',
  'Delayed - Rain',
  'Delayed - Other',
  // Cancelled / Postponed
  'Postponed',
  'Cancelled',
  'Forfeit',
]);

/** Returns true when a status string represents a live or post-game state. */
export function isBlockedGameStatus(status: string | undefined): boolean {
  if (!status) return false;   // unknown = assume pregame, let time check handle it
  // Exact match first
  if (BLOCKED_GAME_STATUSES.has(status)) return true;
  // Substring fallback for variants (e.g. "Final: Rain")
  const lower = status.toLowerCase();
  return (
    lower.startsWith('final') ||
    lower.includes('in progress') ||
    lower.includes('live') ||
    lower.includes('postponed') ||
    lower.includes('cancelled') ||
    lower.includes('suspended') ||
    lower.includes('delayed')
  );
}

/** Returns true when a status string is explicitly allowed for pregame picks. */
export function isAllowedGameStatus(status: string | undefined): boolean {
  if (!status) return true;   // unknown = allow (time check is the backstop)
  return ALLOWED_GAME_STATUSES.has(status) || !isBlockedGameStatus(status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Time-based guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true when the wall clock has reached or passed the game start time.
 * Uses a configurable grace period (default 0 ms) so the filter fires exactly
 * at game time rather than a few minutes early.
 *
 * @param gameDateTime  ISO-8601 UTC string from the MLB Stats API
 * @param nowMs         Current time in ms (injectable for tests, defaults to Date.now())
 */
export function isGameStarted(
  gameDateTime: string | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!gameDateTime) return false;  // no start time = assume pregame
  const startMs = new Date(gameDateTime).getTime();
  if (isNaN(startMs)) return false;
  return nowMs >= startMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pick interface (minimal — only what the filter needs)
// ─────────────────────────────────────────────────────────────────────────────

export interface FilterablePick {
  gameId:        string;
  team:          string;
  gameStatus?:   string;
  gameDateTime?: string;
}

export interface FilterResult<T extends FilterablePick> {
  /** Picks that passed both status and time checks. */
  allowed:  T[];
  /** Picks that were excluded because the game is live, final, or started. */
  excluded: T[];
  /** Human-readable reasons keyed by gameId|team. */
  reasons:  Record<string, string>;
  /** Total excluded count. */
  excludedCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// filterPregameOnly — main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Separates picks into allowed (pregame only) and excluded (live/post-game).
 *
 * A pick is excluded when ANY of the following is true:
 *   - gameStatus is a blocked status string (live, final, postponed, etc.)
 *   - Current time >= gameDateTime (game has started)
 *
 * A pick is allowed when BOTH:
 *   - gameStatus is undefined OR is an allowed status
 *   - Current time < gameDateTime (or gameDateTime is unknown)
 *
 * @param picks   Any array of objects with gameId, team, gameStatus?, gameDateTime?
 * @param nowMs   Current time in ms — injectable for tests
 */
export function filterPregameOnly<T extends FilterablePick>(
  picks: T[],
  nowMs: number = Date.now(),
): FilterResult<T> {
  const allowed:  T[]                     = [];
  const excluded: T[]                     = [];
  const reasons:  Record<string, string>  = {};

  for (const pick of picks) {
    const key             = `${pick.gameId}|${pick.team}`;
    const statusBlocked   = isBlockedGameStatus(pick.gameStatus);
    const timeElapsed     = isGameStarted(pick.gameDateTime, nowMs);

    if (statusBlocked) {
      excluded.push(pick);
      reasons[key] = `Game status "${pick.gameStatus}" is not a pregame state`;
    } else if (timeElapsed) {
      excluded.push(pick);
      const dt = pick.gameDateTime ? new Date(pick.gameDateTime).toISOString() : 'unknown';
      reasons[key] = `Game start time ${dt} has passed`;
    } else {
      allowed.push(pick);
    }
  }

  return { allowed, excluded, reasons, excludedCount: excluded.length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Warning message builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Formats the exclusion count as a human-readable warning string suitable for
 * inclusion in API response.warnings[].
 */
export function buildLiveGameWarning(excludedCount: number): string | null {
  if (excludedCount === 0) return null;
  return `${excludedCount} live or non-pregame game${excludedCount === 1 ? '' : 's'} excluded before ranking.`;
}
