import { extractFromHtml, hostOf, isDomainLikeTitle, requiresAuthorizedPrice } from '../link-extractor.js';
import { classifyPage, PAGE_TYPES, isPlaceholderTitle } from './page-classifier.js';

/**
 * Interface base dos provedores. Cada provedor devolve um resultado padronizado:
 * plataforma, tipo de página, campos com nível de confiança e motivos de ausência.
 */
export class BaseProvider {
  constructor({ id, name, hosts = [] }) {
    this.id = id;
    this.name = name;
    this.hosts = hosts;
  }

  matches(host) {
    const value = String(host || '').toLowerCase().replace(/^www\./, '');
    return this.hosts.some((candidate) => value === candidate || value.endsWith(`.${candidate}`));
  }

  // Ganchos que provedores específicos sobrescrevem.
  canonicalUrlFor() {
    return null;
  }

  authorizedPrice(offer) {
    return offer?.price ?? null;
  }

  priceAllowed() {
    return true;
  }
}

/**
 * Provedor genérico: usa apenas metadados públicos (Open Graph, JSON-LD, HTML).
 * É a base reaproveitada pelos provedores de loja.
 */
export class GenericMetadataProvider extends BaseProvider {
  constructor(options = {}) {
    super({ id: 'generic', name: null, hosts: [], ...options });
  }

  platformFor(url, platform) {
    return platform;
  }

  /**
   * Interpreta o HTML já obtido e monta os campos com confiança e motivos.
   * `context` carrega platform, url original, finalUrl e options.
   */
  interpret({ html, finalUrl, url, platform, options = {} }) {
    const data = extractFromHtml(html, finalUrl, platform);
    const host = hostOf(finalUrl);
    const jsonLdTypes = collectJsonLdTypes(html);
    const titleOk = Boolean(data.name && !isDomainLikeTitle(data.name, { host }) && !isPlaceholderTitle(data.name));
    // Sinais de produto: título real somado a imagem, preço ou JSON-LD Product.
    const hasProductData =
      titleOk && Boolean(data.imageUrl || data.price != null || jsonLdTypes.some((t) => /product/i.test(String(t))));
    const classification = classifyPage({ url, finalUrl, platform, meta: collectMeta(html), jsonLdTypes, hasProductData });

    const priceGate = requiresAuthorizedPrice(platform?.id) && !options.authorizedPriceProvider;

    const fields = {
      title: field(titleOk ? data.name : null, titleOk ? 0.8 : 0.2, titleOk ? null : 'title-not-found'),
      price: priceGate
        ? field(null, 0, 'price-authorized-only')
        : field(data.price, data.price != null ? 0.8 : 0.2, data.price != null ? null : 'price-not-found'),
      previousPrice: priceGate ? field(null, 0, 'price-authorized-only') : field(data.previousPrice, 0.5, null),
      image: field(data.imageUrl, data.imageUrl ? 0.8 : 0.2, data.imageUrl ? null : 'image-not-found'),
      store: field(data.store || platform?.name || null, data.store ? 0.7 : 0.3, data.store ? null : 'store-not-found'),
      coupon: field(data.coupon, data.coupon ? 0.6 : 0.1, null),
      seller: field(null, 0, 'not-available')
    };

    return {
      platform: platform?.id || 'generic',
      platformName: platform?.name || null,
      pageType: classification.type,
      pageTypeConfidence: classification.confidence,
      currency: 'BRL',
      fields,
      canonicalProductUrl: data.canonicalUrl || null,
      resolvedProductUrl: finalUrl,
      asin: data.asin || null,
      raw: data
    };
  }
}

function collectMeta(html) {
  const out = {};
  const re = /<meta\b[^>]*>/gi;
  let match;
  while ((match = re.exec(html))) {
    const attrs = {};
    const attrRe = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let attr;
    while ((attr = attrRe.exec(match[0]))) attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content != null && out[key] == null) out[key] = attrs.content;
  }
  return out;
}

function collectJsonLdTypes(html) {
  const types = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html))) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const stack = [parsed];
      while (stack.length) {
        const node = stack.pop();
        if (Array.isArray(node)) {
          stack.push(...node);
        } else if (node && typeof node === 'object') {
          if (node['@type']) types.push(...[].concat(node['@type']));
          if (node['@graph']) stack.push(node['@graph']);
        }
      }
    } catch {
      // JSON-LD inválido é ignorado; nunca inventamos dados
    }
  }
  return types;
}

export function field(value, confidence, reason = null) {
  return { value: value ?? null, confidence: Number(confidence) || 0, reason: value == null ? reason : null };
}

export function emptyResult(platform, pageType = PAGE_TYPES.UNKNOWN) {
  return {
    platform: platform?.id || 'generic',
    platformName: platform?.name || null,
    pageType,
    pageTypeConfidence: 0,
    currency: 'BRL',
    fields: {
      title: field(null, 0, 'title-not-found'),
      price: field(null, 0, 'price-not-found'),
      previousPrice: field(null, 0, 'not-available'),
      image: field(null, 0, 'image-not-found'),
      store: field(null, 0, 'store-not-found'),
      coupon: field(null, 0, 'not-available'),
      seller: field(null, 0, 'not-available')
    },
    canonicalProductUrl: null,
    resolvedProductUrl: null,
    asin: null,
    raw: {}
  };
}
