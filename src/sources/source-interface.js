export class OfferSource {
  constructor(name) {
    this.name = name;
  }

  isConfigured() {
    return false;
  }

  async fetchOffers() {
    return [];
  }

  describe() {
    return {
      name: this.name,
      configured: this.isConfigured(),
      note: 'Nenhuma fonte automática configurada.'
    };
  }
}

function preserveText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

export function normalizeFetchedOffer(raw, sourceName) {
  return {
    name: preserveText(raw?.name),
    price: raw?.price ?? null,
    previousPrice: raw?.previousPrice ?? null,
    pixPrice: raw?.pixPrice ?? null,
    coupon: preserveText(raw?.coupon),
    couponConditions: preserveText(raw?.couponConditions ?? raw?.conditions),
    imageUrl: preserveText(raw?.imageUrl ?? raw?.image),
    url: preserveText(raw?.url ?? raw?.link),
    store: preserveText(raw?.store ?? raw?.shop) || sourceName,
    validUntil: raw?.validUntil ?? null,
    externalId: preserveText(raw?.id ?? raw?.externalId),
    source: sourceName,
    fetchedAt: raw?.fetchedAt ?? new Date().toISOString()
  };
}

export function applyOfferFilters(offers, config) {
  return offers.filter((offer) => {
    if (!offer?.url) return false;
    if (config.maxPrice != null && offer.price != null && offer.price > config.maxPrice) return false;
    if (
      config.minDiscountPercent != null &&
      (offer.discountPercent == null || offer.discountPercent < config.minDiscountPercent)
    ) {
      return false;
    }
    if (config.allowedStores?.length) {
      const store = String(offer.store ?? '').toLowerCase();
      if (!config.allowedStores.includes(store)) return false;
    }
    return true;
  });
}

export function isWithinAllowedHours(date, allowedHours) {
  if (!allowedHours?.length) return true;
  return allowedHours.includes(date.getHours());
}
