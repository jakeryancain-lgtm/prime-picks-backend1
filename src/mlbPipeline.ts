import { convertOdds } from './engines/odds.engine';
import { calculateNoVigProbability, calculateSingleSideProbability } from './engines/probability.engine';
import { calculateEdge } from './engines/edge.engine';
import { calculateRisk, type MarketType, type BetType } from './engines/risk.engine';
import { gradePickPreGame } from './engines/pickGrade.engine';
import { rankPicks, type RankablePick, type RankedOutput } from './engines/ranking.engine';

// ─────────────────────────────────────────────────────────────────────────────
// Input shape (raw pick from data ingestion / model output)
// ─────────────────────────────────────────────────────────────────────────────

export interface RawMLBPick {
  id: string;
  modelVersionId: string;
  gameId: string;
  team: string;
  opponent: string;
  betType: BetType;
  marketType: MarketType;
  /** Live American odds for this side. Null = no live odds posted yet. */
  americanOdds: number | null;
  /** Live American odds for the opposite side. Used for vig removal. */
  oppositeAmericanOdds?: number | null;
  /** Model's win probability for this side (0–1). */
  modelProbability: number;
  /** Model confidence in this prediction (0–1). */
  confidence: number;
  /** Only set when betType is 'run_line'. */
  runLineSpread?: number | null;
  /** Optional risk signals. */
  lineMovementPercent?: number;
  sampleSize?: number;
  injuryFlag?: boolean;
  weatherFlag?: boolean;
  /** Odds quality score (0–1). Defaults to 0.75 when not provided. */
  oddsQuality?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processed pick — raw pick with all engine outputs attached
// ─────────────────────────────────────────────────────────────────────────────

export interface ProcessedMLBPick extends RankablePick {
  // Pass-through from raw
  id: string;
  modelVersionId: string;
  gameId: string;
  team: string;
  opponent: string;
  betType: string;
  marketType: MarketType;
  americanOdds: number | null;
  modelProbability: number;
  confidence: number;
  runLineSpread?: number | null;

  // Computed by pipeline
  decimalOdds:          number | null;
  rawImpliedProbability: number | null;
  noVigProbability:      number | null;
  impliedProbabilityUsed: number | null;
  probabilitySource:     'no-vig' | 'raw' | null;
  edgeDecimal:           number;
  edgePercent:           number;
  hasPositiveEdge:       boolean;
  edgeTier:              string;
  riskScore:             number;
  riskLevel:             'LOW' | 'MEDIUM' | 'HIGH';
  riskReasons:           string[];
  gradeNumeric:          number;
  gradeLetter:           string;

  // Set by ranking engine
  status?:     import('./types/mlb').PickStatus;
  failReason?: import('./types/mlb').FailReason;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline config
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  minimumEdge?:     number;
  maxNegativeOdds?: number;
  maxTopPicks?:     number;
  defaultOddsQuality?: number;
}

const PIPELINE_DEFAULTS: Required<PipelineConfig> = {
  minimumEdge:        0.03,
  maxNegativeOdds:   -170,
  maxTopPicks:         5,
  defaultOddsQuality: 0.75,
};

// ─────────────────────────────────────────────────────────────────────────────
// Error handling — individual pick failures should not crash the pipeline
// ─────────────────────────────────────────────────────────────────────────────

export interface PipelineError {
  pickId: string;
  stage: string;
  message: string;
}

export interface PipelineResult {
  output: RankedOutput<ProcessedMLBPick>;
  errors: PipelineError[];
  /** Total input picks processed. */
  totalInput: number;
  /** Total output picks across all groups (must equal totalInput minus errored picks). */
  totalOutput: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Single-pick processor
// ─────────────────────────────────────────────────────────────────────────────

function processOnePick(
  raw: RawMLBPick,
  config: Required<PipelineConfig>,
): ProcessedMLBPick {
  const oddsQuality = raw.oddsQuality ?? config.defaultOddsQuality;

  // ── No live odds path ────────────────────────────────────────────────────
  if (raw.americanOdds === null || raw.americanOdds === undefined) {
    return {
      ...raw,
      americanOdds:           null,
      runLineSpread:           raw.runLineSpread ?? null,
      decimalOdds:             null,
      rawImpliedProbability:   null,
      noVigProbability:        null,
      impliedProbabilityUsed:  null,
      probabilitySource:       null,
      edgeDecimal:             0,
      edgePercent:             0,
      hasPositiveEdge:         false,
      edgeTier:                'NEGATIVE',
      riskScore:               0,
      riskLevel:               'LOW',
      riskReasons:             [],
      gradeNumeric:            0,
      gradeLetter:             'NO_GRADE',
    };
  }

  // ── Odds conversion ───────────────────────────────────────────────────────
  const oddsConversion = convertOdds(raw.americanOdds);

  // ── Probability (prefer no-vig when opposite odds available) ──────────────
  let noVigProbability: number | null = null;
  let rawImpliedProbability: number;
  let impliedProbabilityUsed: number;
  let probabilitySource: 'no-vig' | 'raw';

  if (
    raw.oppositeAmericanOdds !== null &&
    raw.oppositeAmericanOdds !== undefined
  ) {
    const twoSided = calculateNoVigProbability(
      raw.americanOdds,
      raw.oppositeAmericanOdds,
    );
    noVigProbability       = twoSided.impliedProbability;
    rawImpliedProbability  = oddsConversion.rawImpliedProbability;
    impliedProbabilityUsed = noVigProbability;
    probabilitySource      = 'no-vig';
  } else {
    const single           = calculateSingleSideProbability(raw.americanOdds);
    rawImpliedProbability  = single.impliedProbability;
    impliedProbabilityUsed = rawImpliedProbability;
    probabilitySource      = 'raw';
  }

  // ── Edge ──────────────────────────────────────────────────────────────────
  const edgeResult = calculateEdge({
    modelProbability:      raw.modelProbability,
    noVigImpliedProbability: probabilitySource === 'no-vig' ? impliedProbabilityUsed : undefined,
    rawImpliedProbability:   probabilitySource === 'raw'    ? impliedProbabilityUsed : undefined,
    minEdgeThreshold:      config.minimumEdge,
  });

  // ── Risk ──────────────────────────────────────────────────────────────────
  const riskResult = calculateRisk({
    americanOdds:        raw.americanOdds,
    edgeDecimal:         edgeResult.edge,
    confidence:          raw.confidence,
    marketType:          raw.marketType,
    betType:             raw.betType,
    lineMovementPercent: raw.lineMovementPercent,
    sampleSize:          raw.sampleSize,
    injuryFlag:          raw.injuryFlag,
    weatherFlag:         raw.weatherFlag,
  });

  // ── Pre-game grade ────────────────────────────────────────────────────────
  const gradeResult = gradePickPreGame({
    edgeDecimal:  edgeResult.edge,
    confidence:   raw.confidence,
    oddsQuality,
    riskLevel:    riskResult.riskLevel,
    hasLiveOdds:  true,
    americanOdds: raw.americanOdds,
  });

  return {
    ...raw,
    americanOdds:            raw.americanOdds,
    runLineSpread:            raw.runLineSpread ?? null,
    decimalOdds:              oddsConversion.decimal,
    rawImpliedProbability,
    noVigProbability,
    impliedProbabilityUsed,
    probabilitySource,
    edgeDecimal:              edgeResult.edge,
    edgePercent:              edgeResult.edgePercent,
    hasPositiveEdge:          edgeResult.hasPositiveEdge,
    edgeTier:                 edgeResult.edgeTier,
    riskScore:                riskResult.riskScore,
    riskLevel:                riskResult.riskLevel,
    riskReasons:              riskResult.riskReasons,
    gradeNumeric:             gradeResult.gradeNumeric,
    gradeLetter:              gradeResult.gradeLetter,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Runs a slate of raw MLB picks through the full engine pipeline.
 *
 * Processing is fault-tolerant: if a single pick throws (e.g. invalid odds),
 * it is captured in `errors` and excluded from the ranked output rather than
 * crashing the whole slate.
 *
 * No Supabase, no CLV, no settlement — pure in-memory computation.
 */
export function runMLBPipeline(
  rawPicks: RawMLBPick[],
  config: PipelineConfig = {},
): PipelineResult {
  const cfg: Required<PipelineConfig> = { ...PIPELINE_DEFAULTS, ...config };
  const errors: PipelineError[] = [];
  const processed: ProcessedMLBPick[] = [];

  for (const raw of rawPicks) {
    try {
      processed.push(processOnePick(raw, cfg));
    } catch (e: unknown) {
      errors.push({
        pickId:  raw.id,
        stage:   'processing',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const output = rankPicks<ProcessedMLBPick>(processed, {
    minimumEdge:     cfg.minimumEdge,
    maxNegativeOdds: cfg.maxNegativeOdds,
    maxTopPicks:     cfg.maxTopPicks,
  });

  const totalOutput =
    output.topPicks.length +
    output.qualifiedPicks.length +
    output.failedPicks.length +
    output.noOddsPicks.length;

  return { output, errors, totalInput: rawPicks.length, totalOutput };
}
