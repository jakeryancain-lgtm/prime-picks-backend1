/**
 * Prime Picks — Daily MLB Dry Run
 *
 * Runs the full daily pick cycle without saving anything to Supabase.
 * Use this to preview today's picks, verify the pipeline is healthy,
 * and debug ingestion warnings before committing to persistence.
 *
 * Usage:
 *   ts-node src/scripts/runTodayDryRun.ts
 *   ts-node src/scripts/runTodayDryRun.ts --date 2025-06-15
 *   ts-node src/scripts/runTodayDryRun.ts --modelVersionId my-model-v2
 */

import { assembleTeamGameStats, type AssembleResult } from '../adapters/mlbStats.ingestion';
import { fetchMLBOdds, type FetchFn as OddsFetchFn, type NormalizedPick } from '../adapters/oddsApi.adapter';
import { buildModelProbabilityMap } from '../adapters/mlbStatsModel.adapter';
import { attachModelProbabilities } from '../adapters/mlbModel.adapter';
import { matchOddsToStats }         from '../adapters/mlbGameMatcher.adapter';
import { runMLBPipeline }           from '../mlbPipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

export interface DryRunConfig {
  date:           string;    // ISO date e.g. '2025-06-10'
  season:         number;    // MLB season year
  modelVersionId: string;
  /** Injectable fetch for stats API — defaults to global fetch */
  statsFetchFn?:  Parameters<typeof assembleTeamGameStats>[2];
  /** Injectable fetch for odds API — defaults to global fetch */
  oddsFetchFn?:   OddsFetchFn;
}

export function buildDryRunConfig(args: string[] = process.argv.slice(2)): DryRunConfig {
  const today   = new Date().toISOString().slice(0, 10);
  const season  = new Date().getFullYear();

  let date           = today;
  let modelVersionId = 'mlb-stats-v1';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date'           && args[i + 1]) date           = args[i + 1]!;
    if (args[i] === '--modelVersionId' && args[i + 1]) modelVersionId = args[i + 1]!;
  }

  return { date, season, modelVersionId };
}

// ─────────────────────────────────────────────────────────────────────────────
// Result shape (returned by runDryRun for testability)
// ─────────────────────────────────────────────────────────────────────────────

export interface DryRunResult {
  date:              string;
  modelVersionId:    string;
  totalGames:        number;
  totalOddsPicks:    number;
  matchedOddsPicks:  number;
  unmatchedOddsPicks: number;
  readyPicks:        number;
  missingModelPicks: number;

  ingestionWarnings: string[];
  ingestionErrors:   string[];
  matcherWarnings:   string[];
  matcherErrors:     string[];
  oddsErrors:        string[];
  modelErrors:       string[];
  pipelineErrors:    string[];

  topPicks: Array<{
    team:        string;
    opponent:    string;
    betType:     string;
    americanOdds: number | null;
    edgePercent: number;
    gradeLetter: string;
    riskLevel:   string;
  }>;

  failedPicksByReason: Record<string, number>;
  noOddsPicks:         number;
  qualifiedPicks:      number;
  totalPipelinePicks:  number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core dry-run function (testable — accepts injectable fetchers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs the full daily MLB pick cycle without saving to Supabase.
 * Returns a structured result for testing; also emits console output
 * when `silent` is false (default).
 */
export async function runDryRun(
  config: DryRunConfig,
  silent = false,
): Promise<DryRunResult> {
  const log = (msg: string) => { if (!silent) console.log(msg); };

  log(`\n${'═'.repeat(60)}`);
  log(`  Prime Picks — Daily MLB Dry Run`);
  log(`  Date: ${config.date}   Model: ${config.modelVersionId}`);
  log(`  Mode: preview (save=false)`);
  log(`${'═'.repeat(60)}\n`);

  const ingestionWarnings: string[] = [];
  const ingestionErrors:   string[] = [];
  const matcherWarnings:   string[] = [];
  const matcherErrors:     string[] = [];
  const oddsErrors:        string[] = [];
  const modelErrors:       string[] = [];
  const pipelineErrors:    string[] = [];

  // ── Step 1: Fetch MLB stats ───────────────────────────────────────────────
  log('Step 1/7 — Fetching MLB stats from statsapi.mlb.com...');
  let statsResult: AssembleResult = { teamGameStats: [], warnings: [], errors: [] };

  try {
    statsResult = await assembleTeamGameStats(
      config.date,
      config.season,
      config.statsFetchFn,
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    pipelineErrors.push(`Stats ingestion failed: ${msg}`);
    log(`  ✗ Stats fetch error: ${msg}`);
  }

  const totalGames = statsResult.teamGameStats.length / 2;  // 2 entries per game
  ingestionWarnings.push(...statsResult.warnings.map(w => `[${w.code}] ${w.team}: ${w.message}`));
  ingestionErrors.push(...statsResult.errors.map(e => `[${e.stage}] ${e.message}`));

  log(`  Games today:          ${Math.floor(totalGames)}`);
  log(`  TeamGameStats built:  ${statsResult.teamGameStats.length}`);
  if (statsResult.warnings.length > 0) {
    log(`  ⚠ Ingestion warnings: ${statsResult.warnings.length}`);
  }
  if (statsResult.errors.length > 0) {
    log(`  ✗ Ingestion errors:   ${statsResult.errors.length}`);
  }

  // ── Step 2: Fetch live odds ───────────────────────────────────────────────
  log('\nStep 2/7 — Fetching live MLB odds from The Odds API...');
  let rawOddsPicks: NormalizedPick[] = [];

  try {
    const oddsResult = await fetchMLBOdds({
      markets:  ['h2h'],
      fetchFn:  config.oddsFetchFn,
    });
    rawOddsPicks = oddsResult.picks;
    oddsErrors.push(...oddsResult.errors);

    log(`  Odds picks received:  ${oddsResult.picks.length}`);
    if (oddsResult.errors.length > 0) {
      log(`  ✗ Odds errors:        ${oddsResult.errors.length}`);
      for (const e of oddsResult.errors) log(`    ${e}`);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    pipelineErrors.push(`Odds fetch failed: ${msg}`);
    log(`  ✗ Odds fetch error: ${msg}`);
  }

  const totalOddsPicks = rawOddsPicks.length;

  // ── Step 3: Align odds picks to MLB Stats game IDs via team name matching ──
  log('\nStep 3/7 — Matching odds picks to MLB Stats game IDs...');

  // Build date map: odds gameId → ISO date
  // The Odds API embeds commence_time in the game object; we don't have it on
  // NormalizedPick directly, so we use today's date as a uniform fallback.
  // In production this would come from the raw Odds API response.
  const gameDateByOddsGameId = new Map<string, string>(
    rawOddsPicks.map(p => [p.gameId, config.date]),
  );

  const matchResult = matchOddsToStats(
    rawOddsPicks,
    statsResult.teamGameStats,
    gameDateByOddsGameId,
  );

  matcherWarnings.push(...matchResult.warnings.map(w => `[${w.code}] ${w.team}: ${w.message}`));
  matcherErrors.push(...matchResult.errors.map(e => `[${e.code}] ${e.team}: ${e.message}`));

  // Use matched picks (gameId rewritten to MLB gamePk) as the input to the model
  const alignedPicks = matchResult.matchedPicks;

  log(`  Matched:              ${matchResult.matchedPicks.length}`);
  log(`  Unmatched odds picks: ${matchResult.unmatchedOddsPicks.length}`);
  log(`  Unmatched stats:      ${matchResult.unmatchedStats.length}`);
  if (matchResult.warnings.length > 0) {
    log(`  ⚠ Matcher warnings:   ${matchResult.warnings.length}`);
  }
  if (matchResult.errors.length > 0) {
    log(`  ✗ Matcher errors:     ${matchResult.errors.length}`);
  }

  // ── Step 4: Build model probability map ──────────────────────────────────
  log('\nStep 4/7 — Building model probability records from stats...');
  const { map: modelProbabilityMap, errors: mapErrors } = buildModelProbabilityMap(
    statsResult.teamGameStats,
    config.modelVersionId,
  );
  modelErrors.push(...mapErrors.map(e => `[${e.gameId}/${e.team}] ${e.message}`));

  log(`  Model records built:  ${Object.keys(modelProbabilityMap).length}`);
  if (mapErrors.length > 0) {
    log(`  ✗ Model build errors: ${mapErrors.length}`);
  }

  // ── Step 5: Attach model probabilities to aligned picks ──────────────────
  log('\nStep 5/7 — Attaching model probabilities to aligned picks...');
  const {
    readyPicks,
    missingModelPicks,
    errors: attachErrors,
  } = attachModelProbabilities(
    alignedPicks,
    modelProbabilityMap,
    config.modelVersionId,
  );
  modelErrors.push(...attachErrors.map(e => `[${e.pickKey}] ${e.message}`));

  log(`  Ready picks:          ${readyPicks.length}`);
  log(`  Missing model picks:  ${missingModelPicks.length}`);
  if (attachErrors.length > 0) {
    log(`  ✗ Attach errors:      ${attachErrors.length}`);
  }

  // ── Step 6: Run pipeline ──────────────────────────────────────────────────
  log('\nStep 6/7 — Running MLB pipeline (edge → risk → grade → rank)...');

  const rawPicks = readyPicks.map((p, i) => ({
    ...p,
    id:               `${config.modelVersionId}:${p.gameId}:${p.team}:${p.betType}:${i}`,
    modelVersionId:   p.modelVersionId ?? config.modelVersionId,
    modelProbability: p.modelProbability as number,
    confidence:       p.confidence as number,
  }));

  const { output: pipelineOutput } = runMLBPipeline(rawPicks);

  const failedPicksByReason: Record<string, number> = {};
  for (const p of pipelineOutput.failedPicks) {
    const reason = p.failReason ?? 'UNKNOWN';
    failedPicksByReason[reason] = (failedPicksByReason[reason] ?? 0) + 1;
  }

  const totalPipelinePicks =
    pipelineOutput.topPicks.length +
    pipelineOutput.qualifiedPicks.length +
    pipelineOutput.failedPicks.length +
    pipelineOutput.noOddsPicks.length;

  log(`  Top picks:            ${pipelineOutput.topPicks.length}`);
  log(`  Qualified picks:      ${pipelineOutput.qualifiedPicks.length}`);
  log(`  Failed picks:         ${pipelineOutput.failedPicks.length}`);
  log(`  No-odds picks:        ${pipelineOutput.noOddsPicks.length}`);

  // ── Step 7: Print summary ─────────────────────────────────────────────────
  log(`\nStep 7/7 — Summary\n`);

  log(`${'─'.repeat(60)}`);
  log(`  TOP PICKS (${pipelineOutput.topPicks.length})`);
  log(`${'─'.repeat(60)}`);

  if (pipelineOutput.topPicks.length === 0) {
    log(`  (no qualifying picks today)`);
  } else {
    for (const p of pipelineOutput.topPicks) {
      const odds = p.americanOdds !== null && p.americanOdds !== undefined
        ? (p.americanOdds > 0 ? `+${p.americanOdds}` : String(p.americanOdds))
        : 'N/A';
      log(`  ${p.gradeLetter.padEnd(3)} ${p.team.padEnd(25)} vs ${p.opponent.padEnd(25)}`);
      log(`      Odds: ${odds.padEnd(8)} Edge: ${p.edgePercent.toFixed(2).padStart(6)}%  Risk: ${p.riskLevel}`);
    }
  }

  if (pipelineOutput.qualifiedPicks.length > 0) {
    log(`\n${'─'.repeat(60)}`);
    log(`  QUALIFIED PICKS (overflow — ${pipelineOutput.qualifiedPicks.length})`);
    log(`${'─'.repeat(60)}`);
    for (const p of pipelineOutput.qualifiedPicks) {
      const odds = p.americanOdds !== null && p.americanOdds !== undefined
        ? (p.americanOdds > 0 ? `+${p.americanOdds}` : String(p.americanOdds))
        : 'N/A';
      log(`  ${p.gradeLetter.padEnd(3)} ${p.team.padEnd(25)} vs ${p.opponent.padEnd(25)} (${odds})`);
    }
  }

  if (Object.keys(failedPicksByReason).length > 0) {
    log(`\n${'─'.repeat(60)}`);
    log(`  FAILED PICKS BY REASON`);
    log(`${'─'.repeat(60)}`);
    for (const [reason, count] of Object.entries(failedPicksByReason).sort()) {
      log(`  ${reason.padEnd(25)} ${count}`);
    }
  }

  if (pipelineOutput.noOddsPicks.length > 0) {
    log(`\n${'─'.repeat(60)}`);
    log(`  NO-ODDS PICKS (${pipelineOutput.noOddsPicks.length})`);
    log(`${'─'.repeat(60)}`);
    for (const p of pipelineOutput.noOddsPicks) {
      log(`  ${p.team.padEnd(25)} vs ${p.opponent.padEnd(25)}  [NO_GRADE]`);
    }
  }

  // Warnings — ingestion + matcher
  const allWarnings = [...ingestionWarnings, ...matcherWarnings];
  if (allWarnings.length > 0) {
    log(`\n${'─'.repeat(60)}`);
    log(`  WARNINGS (${allWarnings.length})`);
    log(`${'─'.repeat(60)}`);
    for (const w of allWarnings) log(`  ⚠ ${w}`);
  }

  // All errors
  const allErrors = [...ingestionErrors, ...matcherErrors, ...oddsErrors, ...modelErrors, ...pipelineErrors];
  if (allErrors.length > 0) {
    log(`\n${'─'.repeat(60)}`);
    log(`  ERRORS (${allErrors.length})`);
    log(`${'─'.repeat(60)}`);
    for (const e of allErrors) log(`  ✗ ${e}`);
  }

  log(`\n${'═'.repeat(60)}`);
  log(`  Dry run complete. Nothing was saved to Supabase.`);
  log(`  To persist picks: set save=true and provide a Supabase client.`);
  log(`${'═'.repeat(60)}\n`);

  return {
    date:               config.date,
    modelVersionId:     config.modelVersionId,
    totalGames:         Math.floor(totalGames),
    totalOddsPicks,
    matchedOddsPicks:   matchResult.matchedPicks.length,
    unmatchedOddsPicks: matchResult.unmatchedOddsPicks.length,
    readyPicks:         readyPicks.length,
    missingModelPicks:  missingModelPicks.length,
    ingestionWarnings,
    ingestionErrors,
    matcherWarnings,
    matcherErrors,
    oddsErrors,
    modelErrors,
    pipelineErrors,
    topPicks: pipelineOutput.topPicks.map(p => ({
      team:         p.team,
      opponent:     p.opponent,
      betType:      p.betType,
      americanOdds: p.americanOdds ?? null,
      edgePercent:  p.edgePercent,
      gradeLetter:  p.gradeLetter,
      riskLevel:    p.riskLevel,
    })),
    failedPicksByReason,
    noOddsPicks:        pipelineOutput.noOddsPicks.length,
    qualifiedPicks:     pipelineOutput.qualifiedPicks.length,
    totalPipelinePicks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point — only runs when executed directly, not when imported
// ─────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  const config = buildDryRunConfig();

  // Validate ODDS_API_KEY is present before hitting the real API
  if (!process.env['ODDS_API_KEY']) {
    console.error('\n✗ ODDS_API_KEY is not set. Add it to your .env file.\n');
    process.exit(1);
  }

  runDryRun(config)
    .then(result => {
      if (result.pipelineErrors.length > 0 || result.oddsErrors.length > 0) {
        process.exit(1);
      }
    })
    .catch((e: unknown) => {
      console.error('\n✗ Dry run crashed:', e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
}
