import { mergeNormalizedFields, normalizeDiscoveredProduct } from './adapters.js';

export const SOURCE_ADAPTERS = {
  'json-feed': (raw) => normalizeDiscoveredProduct(raw, 'json-feed'),
  'shopee-open-api': (raw) => normalizeDiscoveredProduct(raw, 'shopee-open-api'),
  'mercadolivre-feed': (raw) => normalizeDiscoveredProduct(raw, 'mercadolivre-feed'),
  manual: (raw) => normalizeDiscoveredProduct(raw, 'manual')
};

export function unavailableAuthorizedSources() {
  return [
    {
      name: 'manufacturer-catalog',
      available: false,
      reason: 'Nenhum catálogo oficial de fabricante autenticado neste repositório.'
    },
    {
      name: 'mercadolivre-official-api',
      available: false,
      reason: 'API oficial do Mercado Livre não está configurada; itens entram só pelo feed autorizado.'
    }
  ];
}

export function adaptDiscoveredProduct(raw = {}, sourceName = 'unknown') {
  const store = String(raw.store || raw.source || '').toLowerCase();
  if (store.includes('mercado livre') || store.includes('mercadolivre')) {
    return SOURCE_ADAPTERS['mercadolivre-feed'](raw);
  }
  const adapter = SOURCE_ADAPTERS[sourceName] || SOURCE_ADAPTERS[raw.source];
  if (adapter) return adapter(raw);
  return mergeNormalizedFields(raw, sourceName);
}

export function adaptDiscoveredBatch(offers = [], sourceName = 'unknown') {
  return (offers || []).map((item) => adaptDiscoveredProduct(item, item?.source || sourceName));
}
