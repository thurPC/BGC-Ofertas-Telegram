const URL_PATTERN = /^https?:\/\/[^\s]+$/i;

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function parseBrazilianPrice(input) {
  if (input === null || input === undefined) {
    return { ok: false, error: 'Preço ausente.' };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      return { ok: false, error: 'Preço inválido.' };
    }
    return { ok: true, value: roundMoney(input) };
  }

  const raw = String(input).trim();
  if (!raw || /^[-–—]$/.test(raw) || /^(pular|skip|nao|não|n\/a|na)$/i.test(raw)) {
    return { ok: false, skipped: true, error: 'Preço omitido.' };
  }

  let normalized = raw.replace(/\s/g, '').replace(/r\$/gi, '');
  if (!normalized) return { ok: false, error: 'Preço inválido.' };
  if (normalized.includes('-')) return { ok: false, error: 'Preço negativo não é permitido.' };

  if (normalized.includes(',') && normalized.includes('.')) {
    if (normalized.lastIndexOf(',') > normalized.lastIndexOf('.')) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (normalized.includes(',')) {
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, '');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(normalized) && !/^\d+\.\d+$/.test(normalized)) {
    const parsedLoose = Number.parseFloat(normalized);
    if (!Number.isFinite(parsedLoose) || parsedLoose < 0) {
      return { ok: false, error: 'Informe um preço válido no formato brasileiro, por exemplo 199,90.' };
    }
    return { ok: true, value: roundMoney(parsedLoose) };
  }

  const value = Number.parseFloat(normalized);
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, error: 'Preço inválido.' };
  }
  return { ok: true, value: roundMoney(value) };
}

export function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export function formatBRL(value) {
  return roundMoney(value).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function calculateDiscount(previousPrice, currentPrice) {
  if (!isPositivePrice(previousPrice) || !isPositivePrice(currentPrice)) return null;
  if (previousPrice <= currentPrice) return null;
  const percent = ((previousPrice - currentPrice) / previousPrice) * 100;
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return roundMoney(percent);
}

export function isPositivePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isOptionalSkip(input) {
  const raw = String(input ?? '').trim();
  return raw === '' || /^(pular|skip|-|nao|não|n\/a|na)$/i.test(raw);
}

export function validateHttpUrl(input, { required = true, image = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    return required
      ? { ok: false, error: 'URL obrigatória.' }
      : { ok: true, value: null, skipped: true };
  }
  if (isOptionalSkip(raw) && !required) {
    return { ok: true, value: null, skipped: true };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: 'URL inválida. Use um endereço iniciado por http:// ou https://.' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !URL_PATTERN.test(raw)) {
    return { ok: false, error: 'Somente URLs http ou https são aceitas.' };
  }
  if (image && parsed.protocol === 'http:') {
    return { ok: true, value: raw, warning: 'Imagens HTTP podem falhar no Telegram.' };
  }
  return { ok: true, value: raw };
}

export function validateRequiredText(input, field, { max = 200 } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) return { ok: false, error: `${field} é obrigatório.` };
  if (raw.length > max) return { ok: false, error: `${field} ultrapassa ${max} caracteres.` };
  return { ok: true, value: raw };
}

export function validateOptionalText(input, { max = 300 } = {}) {
  const raw = String(input ?? '').trim();
  if (isOptionalSkip(raw)) return { ok: true, value: null, skipped: true };
  if (raw.length > max) return { ok: false, error: `Texto ultrapassa ${max} caracteres.` };
  return { ok: true, value: raw };
}

export function parseValidity(input) {
  const raw = String(input ?? '').trim();
  if (isOptionalSkip(raw)) return { ok: true, value: null, skipped: true };

  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?$/);
  if (br) {
    const [, dd, mm, yyyy, hh = '23', min = '59'] = br;
    const iso = `${yyyy}-${mm}-${dd}T${hh}:${min}:00`;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return { ok: false, error: 'Data de validade inválida.' };
    return { ok: true, value: date.toISOString() };
  }

  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, error: 'Use o formato DD/MM/AAAA ou deixe em branco para pular.' };
  }
  return { ok: true, value: date.toISOString() };
}

export function validateOfferInput(input, { partial = false } = {}) {
  const errors = [];
  const offer = {};

  const name = validateRequiredText(input.name, 'Nome do produto', { max: 180 });
  if (!name.ok) {
    if (!partial || input.name !== undefined) errors.push(name.error);
  } else offer.name = name.value;

  const price = parseBrazilianPrice(input.price);
  if (!price.ok) {
    if (!partial || input.price !== undefined) errors.push(price.error);
  } else offer.price = price.value;

  if (input.previousPrice !== undefined && !isOptionalSkip(input.previousPrice)) {
    const previous = parseBrazilianPrice(input.previousPrice);
    if (!previous.ok) errors.push(`Preço anterior: ${previous.error}`);
    else offer.previousPrice = previous.value;
  } else {
    offer.previousPrice = null;
  }

  if (input.pixPrice !== undefined && !isOptionalSkip(input.pixPrice)) {
    const pix = parseBrazilianPrice(input.pixPrice);
    if (!pix.ok) errors.push(`Preço PIX: ${pix.error}`);
    else offer.pixPrice = pix.value;
  } else {
    offer.pixPrice = null;
  }

  const coupon = validateOptionalText(input.coupon, { max: 80 });
  if (!coupon.ok) errors.push(coupon.error);
  else offer.coupon = coupon.value;

  const conditions = validateOptionalText(input.couponConditions ?? input.conditions, { max: 300 });
  if (!conditions.ok) errors.push(conditions.error);
  else offer.couponConditions = conditions.value;

  const image = validateHttpUrl(input.imageUrl, { required: false, image: true });
  if (!image.ok) errors.push(image.error);
  else offer.imageUrl = image.value;

  const url = validateHttpUrl(input.url, { required: !partial });
  if (!url.ok) {
    if (!partial || input.url !== undefined) errors.push(url.error);
  } else if (url.value) offer.url = url.value;

  const store = validateRequiredText(input.store, 'Loja', { max: 80 });
  if (!store.ok) {
    if (!partial || input.store !== undefined) errors.push(store.error);
  } else offer.store = store.value;

  if (input.validUntil !== undefined) {
    const validity = parseValidity(input.validUntil);
    if (!validity.ok) errors.push(validity.error);
    else offer.validUntil = validity.value;
  } else {
    offer.validUntil = null;
  }

  if (offer.previousPrice != null && offer.price != null && offer.previousPrice < offer.price) {
    errors.push('O preço anterior não pode ser menor que o preço atual.');
  }

  return { ok: errors.length === 0, errors, offer };
}

export function telegramMessageLimitOk(text) {
  return String(text ?? '').length <= 4096;
}

export function telegramCaptionLimitOk(text) {
  return String(text ?? '').length <= 1024;
}
