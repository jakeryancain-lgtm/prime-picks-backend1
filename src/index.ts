// =============================================================================
// Prime Picks Backend — Public API
// =============================================================================
// Import from this file, not from individual engine/service files.
// Internal helpers, test fixtures, and test harness utilities are not exported.
// =============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// Types (shared interfaces and enums)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  // Odds
  AmericanOdds,
  DecimalOdds,
  FractionalOdds,
  OddsConversion,
  VigMethod,
  ImpliedProbabilityResult,

  // Edge
  EdgeResult,

  // Risk
  RiskLevel,
  RiskInput,
  RiskResult,

  // Pick grade
  PickGrade,
  PickGradeInput,
  PickGradeResult,

  // Filters / status
  FailReason,
  PickStatus,

  // Bet types
  BetType,
  RunLineSpread,

  // Core pick shape
  MLBPick,

  // Ranking output
  RankedOutput,

  // Engine config
  EngineConfig,
} from './types/mlb';

export { DEFAULT_ENGINE_CONFIG } from './types/mlb';

// ─────────────────────────────────────────────────────────────────────────────
// Odds engine
// ─────────────────────────────────────────────────────────────────────────────

export {
  isValidAmericanOdds,
  americanToDecimal,
  decimalToAmerican,
  americanToFractional,
  americanToRawImpliedProbability,
  convertOdds,
} from './engines/odds.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Probability engine
// ─────────────────────────────────────────────────────────────────────────────

export {
  calculateRawProbability,
  calculateOverround,
  calculateNoVigProbability,
  calculateSingleSideProbability,
  calculateTwoSidedProbability,
} from './engines/probability.engine';

export type { TwoSidedProbabilityResult } from './engines/probability.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Edge engine
// ─────────────────────────────────────────────────────────────────────────────

export {
  calculateEdge,
  calculateDualEdge,
  getEdgeTier,
  DEFAULT_MIN_EDGE,
} from './engines/edge.engine';

export type {
  EdgeTier,
  EdgeInput,
  EdgeCalculation,
  DualEdgeResult,
} from './engines/edge.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Risk engine
// ─────────────────────────────────────────────────────────────────────────────

export { calculateRisk } from './engines/risk.engine';

export type { MarketType, BetType as RiskBetType } from './engines/risk.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Pick grade engine (pre-game)
// ─────────────────────────────────────────────────────────────────────────────

export {
  gradePickPreGame,
  gradeLetterFromScore,
} from './engines/pickGrade.engine';

export type {
  GradeLetter,
  PickGradeInput as PickGradeEngineInput,
  PickGradeResult as PickGradeEngineResult,
} from './engines/pickGrade.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Ranking engine
// ─────────────────────────────────────────────────────────────────────────────

export { rankPicks } from './engines/ranking.engine';

export type {
  RankablePick,
  RankingConfig,
  RankedOutput as RankingOutput,
} from './engines/ranking.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Settlement engine (post-game)
// ─────────────────────────────────────────────────────────────────────────────

export {
  settlePrediction,
  settleMany,
  calculateProfitLoss,
} from './engines/settlement.engine';

export type {
  SettlementOutcome,
  SettlementInput,
  SettlementResult,
  BatchSettlementResult,
} from './engines/settlement.engine';

// ─────────────────────────────────────────────────────────────────────────────
// MLB pipeline (orchestrator)
// ─────────────────────────────────────────────────────────────────────────────

export { runMLBPipeline } from './mlbPipeline';

export type {
  RawMLBPick,
  ProcessedMLBPick,
  PipelineConfig,
  PipelineResult,
  PipelineError,
} from './mlbPipeline';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: results service (model_predictions)
// ─────────────────────────────────────────────────────────────────────────────

export {
  mapPredictionToDbRow,
  mapPipelineOutputToDbRows,
  savePredictions,
} from './services/results.service';

export type { ModelPredictionRow } from './services/results.service';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence: settlement service (pick_results)
// ─────────────────────────────────────────────────────────────────────────────

export {
  mapSettlementToDbRow,
  saveSettlementResults,
  deduplicateSettlements,
} from './services/settlement.service';

export type {
  PickResultRow,
  SaveSettlementResult,
  DuplicateCheckResult,
} from './services/settlement.service';

// ─────────────────────────────────────────────────────────────────────────────
// Shared Supabase interface (for custom client injection)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  SupabaseClientLike,
  SupabaseInsertResult,
} from './services/supabase.types';

// ─────────────────────────────────────────────────────────────────────────────
// Backtesting service
// ─────────────────────────────────────────────────────────────────────────────

export {
  runBacktest,
  summarizeBacktest,
} from './services/backtesting.service';

export type {
  KnownOutcome,
  OutcomeMap,
  BacktestInput,
  BacktestMetrics,
  TopPicksMetrics,
  BacktestResult,
  RoiGroup,
  RoiByKey,
} from './services/backtesting.service';
