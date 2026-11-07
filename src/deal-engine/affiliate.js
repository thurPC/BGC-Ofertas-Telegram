import { isAffiliateTrackingUrl } from '../services/offer-scorer.js';
import { validateHttpUrl } from '../services/validation-service.js';

export function validateAffiliateLink(offer = {}, options = {}) {
  const url = offer.url || offer.affiliateUrl;
  const http = validateHttpUrl(url, { required: true });
  if (!http.ok) {
    return { ok: false, reason: 'invalid-url', error: http.error, tracking: false };
  }
  const tracking = isAffiliateTrackingUrl(url, offer.store);
  const required = options.requireAffiliateLink === true || String(offer.source || '').includes('shopee');
  if (required && !tracking) {
    return {
      ok: false,
      reason: 'missing-affiliate',
      error: 'Link de afiliado ausente ou inválido.',
      tracking: false
    };
  }
  return {
    ok: true,
    url,
    tracking,
    preserved: true,
    originalUrl: offer.originalUrl || offer.productLink || null
  };
}

export function commissionExcludedFromDealScore() {
  return true;
}
