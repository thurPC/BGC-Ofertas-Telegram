import { compactKey, haystackOf, normalizeText, parseNumber, unique } from './text.js';

const BRANDS = [
  'nvidia',
  'geforce',
  'amd',
  'intel',
  'asus',
  'msi',
  'gigabyte',
  'galax',
  'pny',
  'zotac',
  'sapphire',
  'xfx',
  'asrock',
  'corsair',
  'kingston',
  'crucial',
  'western digital',
  'seagate',
  'samsung',
  'lg',
  'sony',
  'dell',
  'lenovo',
  'acer',
  'hp',
  'apple',
  'logitech',
  'razer',
  'hyperx',
  'redragon',
  'cooler master',
  'nzxt',
  'thermaltake',
  'evga',
  'seasonic',
  'philips',
  'electrolux',
  'brastemp',
  'consul',
  'panasonic',
  'electrolux',
  'midea',
  'gree',
  'elgin',
  'electrolux',
  'mondial',
  'philco',
  'britania',
  'tramontina',
  'electrolux'
];

const VARIANT_PATTERNS = [
  { key: 'gpuSuffix', re: /\b(rtx|gtx|rx)\s*(\d{3,4})\s*(ti|super|xt|gre)?\b/i },
  { key: 'cpuSuffix', re: /\b((?:ryzen|core)\s*[3579]\s*\d{4}(?:x?3d|[xfk])?|i[3579]-?\d{4,5}[kf]?)\b/i },
  { key: 'capacityTb', re: /\b(\d+(?:[.,]\d+)?)\s*tb\b/i },
  { key: 'capacityGb', re: /\b(\d+(?:[.,]\d+)?)\s*gb\b/i },
  { key: 'capacityKg', re: /\b(\d+(?:[.,]\d+)?)\s*kg\b/i },
  { key: 'capacityL', re: /\b(\d+(?:[.,]\d+)?)\s*(?:l|litros?)\b/i },
  { key: 'btu', re: /\b(\d{1,2}[.\s]?\d{3})\s*(?:btus?|btu)\b/i },
  { key: 'voltage', re: /\b(127|220|bivolt)\s*v?\b/i },
  { key: 'memoryType', re: /\b(ddr[345])\b/i },
  { key: 'resolution', re: /\b(full hd|quad hd|qhd|uhd|4k|8k|1080p|1440p|2160p)\b/i },
  { key: 'screen', re: /\b(\d{2}(?:[.,]\d)?)\s*(?:pol|polegadas|")\b/i }
];

function digitsOnly(value) {
  const text = String(value ?? '').replace(/\D+/g, '');
  return text || null;
}

export function normalizeGtin(value) {
  const digits = digitsOnly(value);
  if (!digits) return null;
  if (![8, 12, 13, 14].includes(digits.length)) return null;
  return digits;
}

export function normalizeMpn(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (text.length < 3) return null;
  return text.replace(/\s+/g, '');
}

export function extractBrand(offer) {
  const explicit = String(offer?.brand ?? '').trim();
  if (explicit) return normalizeText(explicit);
  const haystack = haystackOf([offer?.name, offer?.title, offer?.store]);
  for (const brand of BRANDS) {
    if (haystack.includes(brand)) return brand;
  }
  return null;
}

export function extractModel(offer) {
  const explicit = String(offer?.model ?? '').trim();
  if (explicit) return normalizeText(explicit);
  const haystack = haystackOf([offer?.name, offer?.title]);
  const gpu = haystack.match(/\b(rtx|gtx)\s*(\d{3,4})\s*(ti|super)?\b/);
  if (gpu) return normalizeText(`${gpu[1]} ${gpu[2]} ${gpu[3] || ''}`.trim());
  const rx = haystack.match(/\brx\s*(\d{3,4})\s*(xt|gre)?\b/);
  if (rx) return normalizeText(`rx ${rx[1]} ${rx[2] || ''}`.trim());
  const ryzen = haystack.match(/\bryzen\s*([3579])\s*(\d{4}(?:x3d|x|g)?)\b/);
  if (ryzen) return normalizeText(`ryzen ${ryzen[1]} ${ryzen[2]}`);
  const intel = haystack.match(/\b(?:core\s*)?i([3579])[ -]?(\d{4,5}[kf]?)\b/);
  if (intel) return normalizeText(`i${intel[1]}-${intel[2]}`);
  return null;
}

function variantFromMatch(key, match) {
  if (!match) return null;
  if (key === 'gpuSuffix') {
    return {
      series: normalizeText(`${match[1]} ${match[2]}`),
      suffix: normalizeText(match[3] || ''),
      model: normalizeText(`${match[1]} ${match[2]} ${match[3] || ''}`.trim())
    };
  }
  if (key === 'cpuSuffix') {
    return { cpu: normalizeText(match[1]) };
  }
  if (key === 'capacityTb') return { capacityTb: parseNumber(match[1]) };
  if (key === 'capacityGb') return { capacityGb: parseNumber(match[1]) };
  if (key === 'capacityKg') return { capacityKg: parseNumber(match[1]) };
  if (key === 'capacityL') return { capacityL: parseNumber(match[1]) };
  if (key === 'btu') return { btu: Number.parseInt(String(match[1]).replace(/\D+/g, ''), 10) };
  if (key === 'voltage') return { voltage: normalizeText(match[1]) };
  if (key === 'memoryType') return { memoryType: normalizeText(match[1]) };
  if (key === 'resolution') return { resolution: normalizeText(match[1]) };
  if (key === 'screen') return { screenInches: parseNumber(match[1]) };
  return null;
}

export function extractVariant(offer) {
  const haystack = haystackOf([
    offer?.name,
    offer?.title,
    offer?.model,
    offer?.variant,
    offer?.specs,
    offer?.description
  ]);
  const variant = {};
  for (const item of VARIANT_PATTERNS) {
    const match = haystack.match(item.re);
    const parsed = variantFromMatch(item.key, match);
    if (parsed) Object.assign(variant, parsed);
  }
  if (offer?.voltage) variant.voltage = normalizeText(offer.voltage);
  if (offer?.capacity) variant.capacity = normalizeText(offer.capacity);
  if (offer?.condition) variant.condition = normalizeText(offer.condition);
  return variant;
}

export function identityKey(identity) {
  if (identity?.gtin) return `gtin:${identity.gtin}`;
  if (identity?.mpn) return `mpn:${compactKey(identity.mpn)}`;
  if (identity?.brand && identity?.model) {
    const variantBits = Object.entries(identity.variant || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${compactKey(value)}`)
      .join(',');
    return `bmv:${compactKey(identity.brand)}:${compactKey(identity.model)}:${variantBits}`;
  }
  return null;
}

export function identifyProduct(offer = {}) {
  const gtin = normalizeGtin(offer.gtin || offer.ean || offer.barcode);
  const mpn = normalizeMpn(offer.mpn || offer.manufacturerPartNumber);
  const brand = extractBrand(offer);
  const model = extractModel(offer);
  const variant = extractVariant(offer);
  const evidence = [];
  if (gtin) evidence.push('gtin');
  if (mpn) evidence.push('mpn');
  if (brand && model) evidence.push('brand-model');
  if (Object.keys(variant).length) evidence.push('variant');

  let method = 'uncertain';
  let confidence = 20;
  if (gtin) {
    method = 'gtin';
    confidence = 98;
  } else if (mpn) {
    method = 'mpn';
    confidence = 92;
  } else if (brand && model && Object.keys(variant).length) {
    method = 'brand-model-variant';
    confidence = 84;
  } else if (brand && model) {
    method = 'brand-model';
    confidence = 70;
  }

  const identity = {
    gtin,
    mpn,
    brand,
    model,
    variant,
    method,
    confidence,
    evidence,
    uncertain: confidence < 80,
    key: null
  };
  identity.key = identityKey(identity);
  if (!identity.key) {
    identity.uncertain = true;
    identity.confidence = Math.min(identity.confidence, 40);
    identity.method = identity.method === 'uncertain' ? 'uncertain' : identity.method;
  }
  return identity;
}

export function variantsCompatible(left, right) {
  const a = left?.variant || left || {};
  const b = right?.variant || right || {};
  const keys = unique([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] == null || b[key] == null) continue;
    if (compactKey(a[key]) !== compactKey(b[key])) return false;
  }
  if (a.model && b.model && compactKey(a.model) !== compactKey(b.model)) return false;
  if (a.cpu && b.cpu && compactKey(a.cpu) !== compactKey(b.cpu)) return false;
  return true;
}

export function sameProductIdentity(left, right) {
  if (!left || !right) return false;
  if (left.gtin && right.gtin) return left.gtin === right.gtin;
  if (left.mpn && right.mpn) return compactKey(left.mpn) === compactKey(right.mpn);
  if (left.key && right.key && left.key === right.key) return variantsCompatible(left, right);
  if (left.brand && right.brand && left.model && right.model) {
    return (
      compactKey(left.brand) === compactKey(right.brand) &&
      compactKey(left.model) === compactKey(right.model) &&
      variantsCompatible(left, right)
    );
  }
  return false;
}
