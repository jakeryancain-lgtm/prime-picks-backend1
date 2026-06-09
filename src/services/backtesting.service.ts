import { runMLBPipeline, type RawMLBPick, type ProcessedMLBPick } from '../mlbPipeline';
import { settlePrediction, type SettlementResult } from '../engines/settlement.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type KnownOutcome = 'WIN' | 'LOSS' | 'PUSH';

/** Map from pick id → known post-game result. */
export type OutcomeMap = Record<string, KnownOutcome>;

export interface BacktestInput {
  modelVersionId: string;
  rawPicks:       RawMLBPick[];
  /** Post-game outcomes keyed by pick id. Picks without an entry are unsettled. */
  outcomesByPickId: OutcomeMap;
  /**
   * Closing odds keyed by pick id.
   * Falls back to entry odds for CLV calculation when not provided.
   */
  closingOddsByPickId?: Record<string, number>;
  /** Stake per pick in units. Default: 1. */
  stake?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Grouped ROI helper type
// ─────────────────────────────────────────────────────────────────────────────

export interface RoiGroup {
  count:      number;
  profitLoss: number;
  roi:        number;
}

export type RoiByKey = Record<string, RoiGroup>;

// ─────────────────────────────────────────────────────────────────────────────
// Backtest results
// ─────────────────────────────────────────────────────────────────────────────

export interface BacktestMetrics {
  /** Total raw picks fed in. */
  totalPredictions:  number;
  /** Picks that passed all ranking filters (QUALIFIED). */
  totalQualified:    number;
  /** Picks that made the Top N. */
  totalTopPicks:     number;
  /** Picks with a known outcome (settled). */
  totalSettled:      number;

  // ── Settlement breakdown ──────────────────────────────────────────────────
  wins:    number;
  losses:  number;
  pushes:  number;

  /** wins / (wins + losses). 0 when no settled picks. */
  winRate: number;

  // ── Financial performance (all settled picks) ─────────────────────────────
  profitLoss: number;
  /** profitLoss / (totalSettled * stake). 0 when totalSettled === 0. */
  roi:        number;

  /** Average CLV across all settled picks. 0 when none. */
  avgClv:     number;

  // ── Grouped ROI breakdowns ────────────────────────────────────────────────
  roiByEdgeTier:   RoiByKey;
  roiByBetType:    RoiByKey;
  roiByGradeLetter: RoiByKey;
  roiByRiskLevel:  RoiByKey;
}

export interface TopPicksMetrics {
  totalTopPicks: number;
  totalSettled:  number;
  wins:          number;
  losses:        number;
  pushes:        number;
  winRate:       number;
  profitLoss:    number;
  roi:           number;
  avgClv:        number;
}

export interface BacktestResult {
  modelVersionId:   string;
  all:              BacktestMetrics;
  topPicks:         TopPicksMetrics;
  settledDetails:   SettlementResult[];
  /** Full pipeline output for inspection. */
  allProcessedPicks: ProcessedMLBPick[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function safeRoi(profitLoss: number, totalStake: number): number {
  if (totalStake === 0) return 0;
  return profitLoss / totalStake;
}

function buildRoiGroup(settlements: SettlementResult[], stake: number): RoiGroup {
  const profitLoss = settlements.reduce((sum, s) => sum + s.profitLoss, 0);
  return {
    count:      settlements.length,
    profitLoss,
    roi:        safeRoi(profitLoss, settlements.length * stake),
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const groups: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    if (!groups[k]) groups[k] = [];
    groups[k]!.push(item);
  }
  return groups;
}

// ─────────────────────────────────────────────────────────────────────────────
// Settlement helpers
// ─────────────────────────────────────────────────────────────────────────────

function settleProcessedPick(
  pick:             ProcessedMLBPick,
  outcome:          KnownOutcome,
  closingOdds:      number,
  stake:            number,
): SettlementResult {
  const impliedProb =
    pick.noVigProbability ??
    pick.rawImpliedProbability ??
    // fallback: compute from americanOdds if available, otherwise use 0.5
    0.5;

  return settlePrediction({
    predictionId:               pick.id,
    americanOdds:               pick.americanOdds!,
    closingOdds,
    stake,
    outcome,
    originalImpliedProbability: impliedProb > 0 && impliedProb < 1 ? impliedProb : 0.5,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics computation
// ─────────────────────────────────────────────────────────────────────────────

function computeMetrics(
  settlements:       SettlementResult[],
  processedByPickId: Map<string, ProcessedMLBPick>,
  stake:             number,
): Omit<BacktestMetrics, 'totalPredictions' | 'totalQualified' | 'totalTopPicks'> {
  const totalSettled = settlements.length;
  const wins   = settlements.filter(s => s.result === 'WIN').length;
  const losses = settlements.filter(s => s.result === 'LOSS').length;
  const pushes = settlements.filter(s => s.result === 'PUSH').length;

  const winRate   = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const profitLoss = settlements.reduce((sum, s) => sum + s.profitLoss, 0);
  const roi        = safeRoi(profitLoss, totalSettled * stake);
  const avgClv     = totalSettled > 0
    ? settlements.reduce((sum, s) => sum + s.clvDecimal, 0) / totalSettled
    : 0;

  // ── Grouped ROI — attach pick-level fields from the processed pick ────────
  const roiByEdgeTier:    RoiByKey = {};
  const roiByBetType:     RoiByKey = {};
  const roiByGradeLetter: RoiByKey = {};
  const roiByRiskLevel:   RoiByKey = {};

  // Group settlements by their pick's edge tier, bet type, grade, risk
  const byEdge    = groupBy(settlements, s => processedByPickId.get(s.predictionId)?.edgeTier    ?? 'UNKNOWN');
  const byBetType = groupBy(settlements, s => processedByPickId.get(s.predictionId)?.betType     ?? 'UNKNOWN');
  const byGrade   = groupBy(settlements, s => processedByPickId.get(s.predictionId)?.gradeLetter ?? 'UNKNOWN');
  const byRisk    = groupBy(settlements, s => processedByPickId.get(s.predictionId)?.riskLevel   ?? 'UNKNOWN');

  for (const [key, group] of Object.entries(byEdge))    roiByEdgeTier[key]    = buildRoiGroup(group, stake);
  for (const [key, group] of Object.entries(byBetType)) roiByBetType[key]     = buildRoiGroup(group, stake);
  for (const [key, group] of Object.entries(byGrade))   roiByGradeLetter[key] = buildRoiGroup(group, stake);
  for (const [key, group] of Object.entries(byRisk))    roiByRiskLevel[key]   = buildRoiGroup(group, stake);

  return {
    totalSettled,
    wins, losses, pushes,
    winRate, profitLoss, roi, avgClv,
    roiByEdgeTier, roiByBetType, roiByGradeLetter, roiByRiskLevel,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main: runBacktest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs a historical slate through the full MLB pipeline, then settles every
 * pick that has a known outcome.
 *
 * Rules enforced:
 * - Input picks are not mutated (pipeline receives a shallow copy).
 * - Only QUALIFIED picks (topPicks + qualifiedPicks) have odds, so only they
 *   can be settled. No-odds and failed picks are stored for audit but do not
 *   contribute to ROI unless they have an explicit outcome entry AND valid odds.
 * - topPicks metrics are computed separately from all settled metrics.
 * - ROI is 0 (not NaN) when no picks are settled.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const stake = input.stake ?? 1;

  // ── Step 1: run pipeline (never mutates input) ───────────────────────────
  const { output } = runMLBPipeline([...input.rawPicks]);

  // Build flat list + lookup map of all processed picks
  const allPicks: ProcessedMLBPick[] = [
    ...output.topPicks,
    ...output.qualifiedPicks,
    ...output.failedPicks,
    ...output.noOddsPicks,
  ];

  const processedById = new Map<string, ProcessedMLBPick>();
  for (const p of allPicks) processedById.set(p.id, p);

  const topPickIds = new Set(output.topPicks.map(p => p.id));

  // ── Step 2: settle picks that have outcomes and valid odds ────────────────
  const allSettled:     SettlementResult[] = [];
  const topSettled:     SettlementResult[] = [];

  for (const pick of allPicks) {
    const outcome = input.outcomesByPickId[pick.id];
    if (!outcome) continue;                    // no outcome = unsettled
    if (!pick.americanOdds) continue;          // can't settle without odds

    const closingOdds = input.closingOddsByPickId?.[pick.id] ?? pick.americanOdds;

    try {
      const result = settleProcessedPick(pick, outcome, closingOdds, stake);
      allSettled.push(result);
      if (topPickIds.has(pick.id)) topSettled.push(result);
    } catch {
      // Skip picks where settlement throws (e.g. invalid odds edge case)
    }
  }

  // ── Step 3: compute metrics ───────────────────────────────────────────────
  const totalQualified =
    output.topPicks.length + output.qualifiedPicks.length;

  const allMetrics = computeMetrics(allSettled, processedById, stake);
  const topMetrics = computeMetrics(topSettled, processedById, stake);

  const all: BacktestMetrics = {
    totalPredictions: allPicks.length,
    totalQualified,
    totalTopPicks:    output.topPicks.length,
    ...allMetrics,
  };

  const topPicks: TopPicksMetrics = {
    totalTopPicks: output.topPicks.length,
    totalSettled:  topMetrics.totalSettled,
    wins:          topMetrics.wins,
    losses:        topMetrics.losses,
    pushes:        topMetrics.pushes,
    winRate:       topMetrics.winRate,
    profitLoss:    topMetrics.profitLoss,
    roi:           topMetrics.roi,
    avgClv:        topMetrics.avgClv,
  };

  return {
    modelVersionId: input.modelVersionId,
    all,
    topPicks,
    settledDetails:    allSettled,
    allProcessedPicks: allPicks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// summarizeBacktest — human-readable summary string
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a concise multi-line summary of backtest results.
 * Useful for logging and CLI output.
 */
export function summarizeBacktest(result: BacktestResult): string {
  const { all, topPicks } = result;
  const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

  const lines = [
    `Backtest — model: ${result.modelVersionId}`,
    `  Predictions:  ${all.totalPredictions} total | ${all.totalQualified} qualified | ${all.totalTopPicks} top picks`,
    `  Settled:      ${all.totalSettled} (W:${all.wins} L:${all.losses} P:${all.pushes})`,
    `  Win rate:     ${pct(all.winRate)}`,
    `  Profit/loss:  ${all.profitLoss.toFixed(4)} units`,
    `  ROI:          ${pct(all.roi)}`,
    `  Avg CLV:      ${pct(all.avgClv)}`,
    ``,
    `  Top picks only:`,
    `    Settled:    ${topPicks.totalSettled} (W:${topPicks.wins} L:${topPicks.losses} P:${topPicks.pushes})`,
    `    Win rate:   ${pct(topPicks.winRate)}`,
    `    ROI:        ${pct(topPicks.roi)}`,
    `    Avg CLV:    ${pct(topPicks.avgClv)}`,
    ``,
    `  ROI by edge tier:`,
    ...Object.entries(all.roiByEdgeTier).map(
      ([k, v]) => `    ${k}: ${pct(v.roi)} (${v.count} picks, P/L ${v.profitLoss.toFixed(4)})`,
    ),
  ];

  return lines.join('\n');
}
