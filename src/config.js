import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

function trim(value) {
  return String(value ?? '').trim();
}

function parseBoolean(value, fallback = false) {
  const raw = trim(value).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'sim'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'nao', 'não'].includes(raw)) return false;
  return fallback;
}

function parseInteger(value, fallback) {
  const raw = trim(value);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(value) {
  const raw = trim(value).replace(',', '.');
  if (!raw) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseIdList(value) {
  return trim(value)
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      if (!/^-?\d+$/.test(item)) return null;
      try {
        return BigInt(item);
      } catch {
        return null;
      }
    })
    .filter((item) => item !== null);
}

function parseCsv(value) {
  return trim(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseHours(value) {
  const items = parseCsv(value);
  const hours = [];
  for (const item of items) {
    const range = item.match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start >= 0 && start <= 23 && end >= 0 && end <= 23) {
        if (start <= end) {
          for (let h = start; h <= end; h += 1) hours.push(h);
        } else {
          for (let h = start; h <= 23; h += 1) hours.push(h);
          for (let h = 0; h <= end; h += 1) hours.push(h);
        }
      }
      continue;
    }
    const hour = Number.parseInt(item, 10);
    if (Number.isInteger(hour) && hour >= 0 && hour <= 23) hours.push(hour);
  }
  return [...new Set(hours)].sort((a, b) => a - b);
}

export function loadConfig(env = process.env) {
  const missing = [];
  const token = trim(env.TELEGRAM_BOT_TOKEN);
  const channelId = trim(env.TELEGRAM_CHANNEL_ID);
  const adminIds = parseIdList(env.ADMIN_IDS);

  if (!token) missing.push('TELEGRAM_BOT_TOKEN');
  if (!channelId) missing.push('TELEGRAM_CHANNEL_ID');
  if (adminIds.length === 0) missing.push('ADMIN_IDS');

  const interval = parseInteger(env.OFFER_CHECK_INTERVAL_MINUTES, 60);
  const maxPerRun = parseInteger(env.MAX_OFFERS_PER_RUN, 5);
  const dataDir = path.resolve(PROJECT_ROOT, trim(env.DATA_DIR) || 'data');

  return {
    projectRoot: PROJECT_ROOT,
    nodeEnv: trim(env.NODE_ENV) || 'production',
    token,
    channelId,
    adminIds,
    autoPublish: parseBoolean(env.OFFER_AUTO_PUBLISH, false),
    checkIntervalMinutes: interval > 0 ? interval : 60,
    maxOffersPerRun: maxPerRun > 0 ? maxPerRun : 5,
    dataDir,
    logLevel: trim(env.LOG_LEVEL) || 'info',
    feedUrl: trim(env.OFFER_FEED_URL),
    channelLink: trim(env.BGC_CHANNEL_LINK),
    maxPrice: parseNumber(env.OFFER_MAX_PRICE),
    minDiscountPercent: parseNumber(env.OFFER_MIN_DISCOUNT_PERCENT),
    allowedStores: parseCsv(env.OFFER_ALLOWED_STORES).map((item) => item.toLowerCase()),
    allowedHours: parseHours(env.OFFER_ALLOWED_HOURS),
    missing
  };
}

export function assertRuntimeConfig(config) {
  if (config.missing.length === 0) return;
  const list = config.missing.join(', ');
  throw new Error(
    `Configuração incompleta. Variáveis ausentes ou inválidas: ${list}. ` +
      'Copie .env.example para .env e preencha os valores. Nenhum segredo foi exibido.'
  );
}

export function isAdmin(config, userId) {
  if (userId === undefined || userId === null || userId === '') return false;
  let id;
  try {
    id = BigInt(String(userId));
  } catch {
    return false;
  }
  return config.adminIds.some((adminId) => adminId === id);
}

export { PROJECT_ROOT };
