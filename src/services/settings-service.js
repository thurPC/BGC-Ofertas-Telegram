import crypto from 'node:crypto';
import { normalizeText } from './exclusion-filter.js';
import { escapeHtml } from './validation-service.js';

export const DEFAULT_OPERATING_HOURS = {
  mode: 'always',
  startHour: 8,
  endHour: 22
};

export function createCategoryId() {
  return crypto.randomBytes(4).toString('hex');
}

export function normalizeCategoryName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function categoryKey(value) {
  return normalizeText(normalizeCategoryName(value));
}

export function parseHourInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, error: 'Informe a hora no formato 24h, de 0 a 23. Ex.: 8 ou 22.' };
  const match = raw.match(/^(\d{1,2})(?:h|:00)?$/i);
  if (!match) {
    return { ok: false, error: 'Use somente a hora, sem minutos. Ex.: 8, 08, 8h ou 22.' };
  }
  const hour = Number.parseInt(match[1], 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return { ok: false, error: 'A hora precisa estar entre 0 e 23.' };
  }
  return { ok: true, hour };
}

export function hoursFromRange(startHour, endHour) {
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour)) return [];
  if (startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) return [];
  const hours = [];
  if (startHour <= endHour) {
    for (let hour = startHour; hour <= endHour; hour += 1) hours.push(hour);
  } else {
    for (let hour = startHour; hour <= 23; hour += 1) hours.push(hour);
    for (let hour = 0; hour <= endHour; hour += 1) hours.push(hour);
  }
  return hours;
}

export function formatHour(hour) {
  if (!Number.isInteger(hour)) return '--';
  return `${String(hour).padStart(2, '0')}h`;
}

export function describeOperatingHours(hours) {
  if (!hours || hours.mode === 'always') {
    return 'O bot opera 24 horas (0h às 23h).';
  }
  return `O bot opera das ${formatHour(hours.startHour)} às ${formatHour(hours.endHour)} (formato 24h, sem minutos).`;
}

export function normalizeOperatingHours(value, fallbackHours = []) {
  if (value && typeof value === 'object') {
    const mode = value.mode === 'range' ? 'range' : 'always';
    const startHour = Number.isInteger(value.startHour) ? value.startHour : 8;
    const endHour = Number.isInteger(value.endHour) ? value.endHour : 22;
    return {
      mode,
      startHour: Math.min(23, Math.max(0, startHour)),
      endHour: Math.min(23, Math.max(0, endHour))
    };
  }
  if (Array.isArray(fallbackHours) && fallbackHours.length) {
    return {
      mode: 'range',
      startHour: fallbackHours[0],
      endHour: fallbackHours[fallbackHours.length - 1]
    };
  }
  return { ...DEFAULT_OPERATING_HOURS };
}

export function normalizeCategories(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const result = [];
  for (const item of list) {
    const name = normalizeCategoryName(item?.name ?? item);
    const key = categoryKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: String(item?.id || createCategoryId()),
      name,
      enabled: item?.enabled !== false
    });
  }
  return result;
}

export function resolveAllowedHours(operatingHours, fallbackHours = []) {
  const hours = normalizeOperatingHours(operatingHours, fallbackHours);
  if (hours.mode !== 'range') return [];
  return hoursFromRange(hours.startHour, hours.endHour);
}

export class SettingsService {
  constructor(storage, config = {}) {
    this.storage = storage;
    this.config = config;
  }

  envCategories() {
    return Array.isArray(this.config.excludedCategories) ? this.config.excludedCategories : [];
  }

  envHours() {
    return Array.isArray(this.config.allowedHours) ? this.config.allowedHours : [];
  }

  async get() {
    const db = this.storage ? await this.storage.read() : { settings: {} };
    return {
      categories: normalizeCategories(db.settings?.categories),
      operatingHours: normalizeOperatingHours(db.settings?.operatingHours, this.envHours())
    };
  }

  async #save(patch, { actorId, action } = {}) {
    const current = await this.get();
    const next = {
      categories: patch.categories ?? current.categories,
      operatingHours: patch.operatingHours ?? current.operatingHours
    };
    if (!this.storage) return next;
    await this.storage.update((db) => {
      db.settings = {
        ...db.settings,
        categories: next.categories,
        operatingHours: next.operatingHours
      };
      db.history.push({
        at: new Date().toISOString(),
        action: action || 'settings-update',
        actorId: actorId ?? null
      });
      return db;
    });
    return next;
  }

  async listCategories() {
    const settings = await this.get();
    return settings.categories;
  }

  async addCategory(name, { actorId, enabled = true } = {}) {
    const trimmed = normalizeCategoryName(name);
    if (!trimmed) return { ok: false, error: 'Informe o nome da categoria.' };
    const key = categoryKey(trimmed);
    const current = await this.listCategories();
    if (current.some((item) => categoryKey(item.name) === key)) {
      return { ok: false, error: 'Essa categoria já está na lista.' };
    }
    const category = { id: createCategoryId(), name: trimmed, enabled: enabled !== false };
    const categories = [...current, category];
    await this.#save({ categories }, { actorId, action: 'category-add' });
    return { ok: true, category, categories };
  }

  async setCategoryEnabled(id, enabled, { actorId } = {}) {
    const current = await this.listCategories();
    const category = current.find((item) => item.id === id);
    if (!category) return { ok: false, error: 'Categoria não encontrada.' };
    const categories = current.map((item) => (item.id === id ? { ...item, enabled: Boolean(enabled) } : item));
    await this.#save({ categories }, { actorId, action: enabled ? 'category-on' : 'category-off' });
    const next = categories.find((item) => item.id === id);
    return { ok: true, category: next, categories };
  }

  async removeCategory(id, { actorId } = {}) {
    const current = await this.listCategories();
    const category = current.find((item) => item.id === id);
    if (!category) return { ok: false, error: 'Categoria não encontrada.' };
    const categories = current.filter((item) => item.id !== id);
    await this.#save({ categories }, { actorId, action: 'category-remove' });
    return { ok: true, category, categories };
  }

  async setOperatingHours(patch, { actorId } = {}) {
    const current = await this.get();
    const next = normalizeOperatingHours({ ...current.operatingHours, ...patch });
    const settings = await this.#save({ operatingHours: next }, { actorId, action: 'hours-update' });
    return { ok: true, operatingHours: settings.operatingHours };
  }

  async setAlwaysOn({ actorId } = {}) {
    return this.setOperatingHours({ mode: 'always' }, { actorId });
  }

  async exclusionOptions() {
    const settings = await this.get();
    const extra = settings.categories.filter((item) => item.enabled).map((item) => item.name);
    return {
      extraCategories: [...this.envCategories(), ...extra],
      extraKeywords: this.config.excludedKeywords || []
    };
  }

  async allowedHours() {
    const settings = await this.get();
    return resolveAllowedHours(settings.operatingHours, this.envHours());
  }

  async runtimeConfig() {
    const settings = await this.get();
    const exclusion = await this.exclusionOptions();
    return {
      ...this.config,
      excludedCategories: exclusion.extraCategories,
      excludedKeywords: exclusion.extraKeywords,
      allowedHours: resolveAllowedHours(settings.operatingHours, this.envHours()),
      operatingHours: settings.operatingHours,
      categories: settings.categories
    };
  }
}

export function formatCategoryList(categories) {
  if (!categories.length) {
    return 'Nenhuma categoria extra cadastrada. Use Adicionar para incluir um item.';
  }
  return categories
    .map((item) => {
      const icon = item.enabled ? '✅' : '⏸️';
      const state = item.enabled ? 'ativa' : 'inativa';
      return `${icon} <b>${escapeHtml(item.name)}</b> — ${state}`;
    })
    .join('\n');
}
