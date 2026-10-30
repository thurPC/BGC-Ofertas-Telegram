import { extractAsin, findCanonicalProductUrl } from '../link-extractor.js';
import { GenericMetadataProvider } from './generic-provider.js';

const AMAZON_HOSTS = ['amazon.com.br', 'amazon.com', 'amzn.to', 'amzn.com', 'amzn.com.br', 'a.co', 'link.amazon'];
const MARKETPLACE_BY_HOST = [
  ['amazon.com.br', 'Amazon Brasil'],
  ['amzn.com.br', 'Amazon Brasil'],
  ['amazon.com', 'Amazon'],
  ['amzn.to', 'Amazon'],
  ['amzn.com', 'Amazon'],
  ['a.co', 'Amazon'],
  ['link.amazon', 'Amazon']
];

export class AmazonProvider extends GenericMetadataProvider {
  constructor() {
    super({ id: 'amazon', name: 'Amazon', hosts: AMAZON_HOSTS });
  }

  matches(host) {
    return super.matches(host);
  }

  // Encurtadores da Amazon às vezes devolvem uma página intermediária
  // (/hz/mobile/mission). O destino canônico leva ao /dp/ASIN do produto.
  canonicalUrlFor({ html, finalUrl, url }) {
    const asin = extractAsin(url) || extractAsin(finalUrl);
    if (asin && !/\/dp\//i.test(finalUrl) && !/\/gp\/product\//i.test(finalUrl)) {
      return `https://www.amazon.com.br/dp/${asin}`;
    }
    return findCanonicalProductUrl(html, finalUrl);
  }

  storeFor(finalUrl) {
    const host = String(finalUrl || '').toLowerCase();
    for (const [candidate, store] of MARKETPLACE_BY_HOST) {
      if (host.includes(candidate)) return store;
    }
    return 'Amazon';
  }
}
