import { detectPlatform, extractAsin, hostOf } from '../link-extractor.js';
import { FETCH_STATUS, REASON_TEXT, httpGetWithRetry } from './http-client.js';
import { GenericMetadataProvider, emptyResult } from './generic-provider.js';
import { AmazonProvider } from './amazon-provider.js';
import { MercadoLivreProvider } from './mercadolivre-provider.js';
import { ShopeeProvider } from './shopee-provider.js';
import { PAGE_TYPES, PAGE_TYPE_LABELS } from './page-classifier.js';

const FIELD_KEYS = ['title', 'price', 'previousPrice', 'image', 'store', 'coupon', 'seller'];

/**
 * Serviço central: coordena provedores independentes, aplica fallback entre
 * eles e devolve um resultado padronizado. Um provedor bloqueado nunca impede
 * a consulta dos demais nem é interpretado como ausência de produto.
 */
export class ProductResolverService {
  constructor({ providers = [] } = {}) {
    this.providers = providers.length
      ? providers
      : [new AmazonProvider(), new MercadoLivreProvider(), new ShopeeProvider(), new GenericMetadataProvider()];
  }

  providerFor(platform, host) {
    const specific = this.providers.find((p) => p.id === platform?.id && p.id !== 'generic');
    const generic = this.providers.find((p) => p.id === 'generic');
    if (specific) return [specific, generic].filter(Boolean);
    const byHost = this.providers.filter((p) => p.id !== 'generic' && p.matches(host));
    return [...byHost, generic].filter(Boolean);
  }

  async resolve(rawUrl, options = {}) {
    const url = String(rawUrl ?? '').trim();
    const platform = detectPlatform(url);
    const host = hostOf(url);
    const attempts = [];

    const chain = this.providerFor(platform, host);
    const primary = chain[0];
    const fallbacks = chain.slice(1);

    const fetched = await httpGetWithRetry(url, options);
    attempts.push({ provider: primary?.id || 'generic', url, status: fetched.status, httpStatus: fetched.httpStatus ?? null });

    if (!fetched.ok) {
      return this.blockedResult({ url, platform, primary, fallbacks, fetched, attempts, options });
    }

    return this.interpretWithChain({ url, platform, provider: primary, html: fetched.html, finalUrl: fetched.finalUrl, attempts, options, fetched });
  }

  async blockedResult({ url, platform, primary, fallbacks, fetched, attempts, options }) {
    // Mesmo bloqueado, tentamos o destino canônico (ex.: /dp/ASIN da Amazon) e
    // outros provedores legítimos. Não inventamos dados nem usamos evasão.
    const canonical = this.canonicalCandidate(primary, { url, html: '', finalUrl: url });
    if (canonical && canonical !== url) {
      const retry = await httpGetWithRetry(canonical, options);
      attempts.push({ provider: primary?.id || 'generic', url: canonical, status: retry.status, httpStatus: retry.httpStatus ?? null });
      if (retry.ok) {
        return this.interpretWithChain({ url, platform, provider: primary, html: retry.html, finalUrl: retry.finalUrl, attempts, options, fetched: retry });
      }
    }

    for (const provider of fallbacks) {
      const alt = await httpGetWithRetry(url, { ...options, headers: { ...(options.headers || {}), ...(provider.headersFor?.() || {}) } });
      attempts.push({ provider: provider.id, url, status: alt.status, httpStatus: alt.httpStatus ?? null });
      if (alt.ok) {
        return this.interpretWithChain({ url, platform, provider, html: alt.html, finalUrl: alt.finalUrl, attempts, options, fetched: alt });
      }
    }

    const result = emptyResult(platform);
    result.offer = {
      name: null,
      price: null,
      previousPrice: null,
      imageUrl: null,
      store: primary?.name || platform?.name || null,
      coupon: null,
      seller: null,
      currency: 'BRL',
      asin: extractAsin(url),
      url,
      originalAffiliateUrl: url,
      resolvedProductUrl: fetched.finalUrl || null,
      canonicalProductUrl: null
    };
    result.resolvedProductUrl = fetched.finalUrl || null;
    result.confidence = {};
    result.fieldReasons = {};
    result.warnings = [];
    result.missing = ['name', 'price'];
    result.status = fetched.status;
    result.error = fetched.error || REASON_TEXT[fetched.status];
    result.ok = false;
    result.attempts = attempts;
    return result;
  }

  canonicalCandidate(provider, context) {
    if (typeof provider?.canonicalUrlFor !== 'function') return null;
    try {
      return provider.canonicalUrlFor(context);
    } catch {
      return null;
    }
  }

  async interpretWithChain({ url, platform, provider, html, finalUrl, attempts, options, fetched }) {
    let chosen = provider;
    let interpreted = this.interpret(chosen, { html, finalUrl, url, platform, options });

    // Se o provedor específico não achou o produto mas há um destino canônico,
    // seguimos para a página do produto antes de desistir.
    const weak = interpreted.fields.title.value == null && interpreted.pageType !== PAGE_TYPES.PRODUCT;
    if (weak && typeof chosen.canonicalUrlFor === 'function') {
      const canonical = this.canonicalCandidate(chosen, { html, finalUrl, url });
      if (canonical && canonical !== finalUrl) {
        const follow = await httpGetWithRetry(canonical, options);
        attempts.push({ provider: chosen.id, url: canonical, status: follow.status, httpStatus: follow.httpStatus ?? null });
        if (follow.ok) {
          const second = this.interpret(chosen, { html: follow.html, finalUrl: follow.finalUrl, url, platform, options });
          if (second.fields.title.value != null || second.pageType === PAGE_TYPES.PRODUCT) {
            interpreted = second;
          }
        }
      }
    }

    // Preenche a loja pelo domínio quando o provedor específico conhece o marketplace.
    if (typeof chosen.storeFor === 'function' && interpreted.fields.store.value == null) {
      const store = chosen.storeFor(interpreted.resolvedProductUrl || finalUrl);
      if (store) interpreted.fields.store = { value: store, confidence: 0.7, reason: null };
    }

    const result = this.finalize({ url, platform, interpreted, attempts, fetched });
    return result;
  }

  interpret(provider, context) {
    try {
      return provider.interpret(context);
    } catch {
      return emptyResult(context.platform);
    }
  }

  finalize({ url, platform, interpreted, attempts, fetched }) {
    const offer = {
      name: interpreted.fields.title.value,
      price: interpreted.fields.price.value,
      previousPrice: interpreted.fields.previousPrice.value,
      imageUrl: interpreted.fields.image.value,
      store: interpreted.fields.store.value,
      coupon: interpreted.fields.coupon.value,
      seller: interpreted.fields.seller.value,
      currency: interpreted.currency || 'BRL',
      asin: interpreted.asin || null,
      url,
      originalAffiliateUrl: url,
      resolvedProductUrl: interpreted.resolvedProductUrl || fetched?.finalUrl || null,
      canonicalProductUrl: interpreted.canonicalProductUrl || null
    };

    const fieldReasons = {};
    const confidence = {};
    for (const key of FIELD_KEYS) {
      const entry = interpreted.fields[key] || { value: null, confidence: 0, reason: null };
      confidence[key] = entry.confidence;
      if (entry.value == null && entry.reason) fieldReasons[key] = entry.reason;
    }

    const warnings = [];
    if (offer.imageUrl == null) warnings.push('image-missing');
    if (offer.coupon == null) warnings.push('coupon-missing');
    if (offer.price == null) warnings.push('price-missing');
    if (fieldReasons.price === 'price-authorized-only') warnings.push('price-authorized-only');

    const missing = [];
    if (!offer.name) missing.push('name');
    if (offer.price == null) missing.push('price');
    if (!offer.store) missing.push('store');

    const isProduct = interpreted.pageType === PAGE_TYPES.PRODUCT;
    const ok = isProduct && (offer.name != null || offer.price != null);

    return {
      ok,
      status: fetched?.status || FETCH_STATUS.OK,
      platform,
      pageType: interpreted.pageType,
      pageTypeConfidence: interpreted.pageTypeConfidence,
      pageTypeLabel: PAGE_TYPE_LABELS[interpreted.pageType],
      offer,
      confidence,
      fieldReasons,
      warnings,
      missing,
      attempts
    };
  }
}

export function createProductResolver(options = {}) {
  return new ProductResolverService(options);
}
