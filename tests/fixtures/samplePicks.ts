import type { RawMLBPick } from '../../src/mlbPipeline';

/** Strong moneyline with good edge — should qualify. */
export const STRONG_MONEYLINE_FIXTURE: RawMLBPick = {
  id:                   'fixture-strong-ml',
  modelVersionId:       'model-v1',
  gameId:               'fixture-game-001',
  team:                 'NYY',
  opponent:             'BOS',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -115,
  oppositeAmericanOdds: 105,
  modelProbability:     0.65,
  confidence:           0.78,
  oddsQuality:          0.85,
  sampleSize:           120,
};

/** No live odds — should route to noOddsPicks with grade 0. */
export const NO_ODDS_FIXTURE: RawMLBPick = {
  id:             'fixture-no-odds',
  modelVersionId: 'model-v1',
  gameId:         'fixture-game-002',
  team:           'CHC',
  opponent:       'MIL',
  betType:        'moneyline',
  marketType:     'moneyline',
  americanOdds:   null,
  modelProbability: 0.58,
  confidence:     0.70,
};

/**
 * Low edge — model prob barely above implied prob.
 * -115/+105 market: no-vig implied ≈ 0.523. Model 0.535 → edge ≈ 0.012 < 0.03.
 */
export const FAILED_EDGE_FIXTURE: RawMLBPick = {
  id:                   'fixture-low-edge',
  modelVersionId:       'model-v1',
  gameId:               'fixture-game-003',
  team:                 'ATL',
  opponent:             'PHI',
  betType:              'moneyline',
  marketType:           'moneyline',
  americanOdds:         -115,
  oppositeAmericanOdds: 105,
  modelProbability:     0.535,
  confidence:           0.65,
  sampleSize:           60,
};
