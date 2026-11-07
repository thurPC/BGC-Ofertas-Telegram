export const DEFAULT_DEAL_ENGINE = {
  enabled: true,
  controlSelection: false,
  gateOnPublish: false,
  minDealScore: 75,
  minConfidence: 90,
  cooldownHours: 24,
  variantCooldownHours: 12,
  maxPerBrandPerCycle: 2,
  maxPerFamilyShare: 0.7,
  historyRetentionDays: 365,
  snapshotLimit: 400,
  significantDropPercent: 8,
  significantScoreGain: 10,
  sourceReliability: {
    'shopee-open-api': 85,
    'json-feed': 70,
    manual: 90
  }
};

export const DEAL_SCORE_WEIGHTS = {
  historicalDiscount: 35,
  nearHistoricalMin: 20,
  storeComparison: 15,
  sellerTrust: 10,
  popularity: 10,
  netSavings: 5,
  freshness: 5
};

export const QUEUE_STATUS = {
  DISCOVERED: 'discovered',
  IDENTIFIED: 'identified',
  CLASSIFIED: 'classified',
  EVALUATED: 'evaluated',
  REJECTED: 'rejected',
  QUEUED: 'queued',
  REVALIDATING: 'revalidating',
  PUBLISHED: 'published',
  EXPIRED: 'expired',
  FAILED: 'failed',
  QUARANTINE: 'quarantine'
};

export function mergeDealEngineConfig(input = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const weights = { ...DEAL_SCORE_WEIGHTS, ...(source.weights || {}) };
  const sourceReliability = {
    ...DEFAULT_DEAL_ENGINE.sourceReliability,
    ...(source.sourceReliability || {})
  };
  return {
    ...DEFAULT_DEAL_ENGINE,
    ...source,
    weights,
    sourceReliability,
    enabled: source.enabled !== false,
    controlSelection: source.controlSelection === true,
    gateOnPublish: source.gateOnPublish === true,
    minDealScore: Number.isFinite(Number(source.minDealScore))
      ? Number(source.minDealScore)
      : DEFAULT_DEAL_ENGINE.minDealScore,
    minConfidence: Number.isFinite(Number(source.minConfidence))
      ? Number(source.minConfidence)
      : DEFAULT_DEAL_ENGINE.minConfidence
  };
}
