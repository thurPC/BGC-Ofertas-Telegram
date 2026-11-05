import { DEFAULT_CATEGORIES } from './offer-scorer.js';
import { escapeHtml } from './validation-service.js';

export const CATEGORY_IDS = DEFAULT_CATEGORIES.map((item) => item.id);

export function defaultCategorySettings() {
  return {
    enabled: [...CATEGORY_IDS],
    extraKeywords: [],
    excludeBooks: true
  };
}

function uniqueTexts(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function mergeCategorySettings(input = {}, fallback = defaultCategorySettings()) {
  const base = defaultCategorySettings();
  const source = input && typeof input === 'object' ? input : {};
  const enabledRaw = Array.isArray(source.enabled) ? source.enabled : fallback.enabled;
  const enabled = uniqueTexts(enabledRaw)
    .map((item) => String(item).trim().toLowerCase())
    .filter((id) => CATEGORY_IDS.includes(id));
  return {
    enabled: enabled.length ? enabled : [...base.enabled],
    extraKeywords: uniqueTexts(source.extraKeywords ?? fallback.extraKeywords).slice(0, 40),
    excludeBooks: source.excludeBooks !== false
  };
}

export function categoryById(id) {
  return DEFAULT_CATEGORIES.find((item) => item.id === id) || null;
}

export function enabledCategories(settings) {
  const resolved = mergeCategorySettings(settings);
  return DEFAULT_CATEGORIES.filter((item) => resolved.enabled.includes(item.id));
}

export function searchKeywordsFromSettings(settings, envKeywords = []) {
  const resolved = mergeCategorySettings(settings);
  const fromCategories = enabledCategories(resolved).map((item) => item.keywords[0]);
  return uniqueTexts([...fromCategories, ...(envKeywords || []), ...resolved.extraKeywords]);
}

export function describeCategories(settings) {
  const resolved = mergeCategorySettings(settings);
  const lines = ['📂 <b>Categorias da automação</b>', ''];
  for (const item of DEFAULT_CATEGORIES) {
    const on = resolved.enabled.includes(item.id);
    lines.push(`${on ? '✅' : '🚫'} <b>${escapeHtml(item.label)}</b> <code>${escapeHtml(item.id)}</code>`);
  }
  lines.push('');
  lines.push(`📚 Excluir livros: <b>${resolved.excludeBooks ? 'sim' : 'não'}</b>`);
  lines.push('');
  if (resolved.extraKeywords.length) {
    lines.push('<b>Palavras extras</b>');
    lines.push(...resolved.extraKeywords.map((keyword) => `• ${escapeHtml(keyword)}`));
  } else {
    lines.push('<b>Palavras extras:</b> nenhuma');
  }
  return lines.join('\n');
}

export class CategoryService {
  constructor(storage, env = {}) {
    this.storage = storage;
    this.envKeywords = Array.isArray(env.shopeeKeywords) ? env.shopeeKeywords : [];
    this.envExcludeBooks = env.excludeBooks !== false;
  }

  defaults() {
    return mergeCategorySettings({
      enabled: [...CATEGORY_IDS],
      extraKeywords: [],
      excludeBooks: this.envExcludeBooks
    });
  }

  async get() {
    if (!this.storage) return this.defaults();
    const db = await this.storage.read();
    return mergeCategorySettings(db.settings?.categories, this.defaults());
  }

  async save(next, { actorId, action = 'category-update' } = {}) {
    const resolved = mergeCategorySettings(next, this.defaults());
    if (!this.storage) return resolved;
    await this.storage.update((db) => {
      db.settings = { ...db.settings, categories: resolved };
      db.history.push({
        at: new Date().toISOString(),
        action,
        actorId: actorId ?? null
      });
      return db;
    });
    return resolved;
  }

  async toggle(id, { actorId } = {}) {
    const current = await this.get();
    const key = String(id ?? '').trim().toLowerCase();
    if (!CATEGORY_IDS.includes(key)) return { ok: false, error: 'Categoria desconhecida.' };
    const enabled = current.enabled.includes(key)
      ? current.enabled.filter((item) => item !== key)
      : [...current.enabled, key];
    if (!enabled.length) {
      return { ok: false, error: 'Mantenha ao menos uma categoria ativa.' };
    }
    const settings = await this.save({ ...current, enabled }, { actorId, action: 'category-toggle' });
    return { ok: true, settings };
  }

  async addKeyword(keyword, { actorId } = {}) {
    const text = String(keyword ?? '').trim();
    if (text.length < 2) return { ok: false, error: 'Informe uma palavra-chave com pelo menos 2 caracteres.' };
    if (text.length > 60) return { ok: false, error: 'Palavra-chave longa demais.' };
    const current = await this.get();
    const settings = await this.save(
      { ...current, extraKeywords: [...current.extraKeywords, text] },
      { actorId, action: 'category-keyword-add' }
    );
    return { ok: true, settings };
  }

  async removeKeyword(keyword, { actorId } = {}) {
    const current = await this.get();
    const key = String(keyword ?? '').trim().toLowerCase();
    const extraKeywords = current.extraKeywords.filter((item) => item.toLowerCase() !== key);
    const settings = await this.save({ ...current, extraKeywords }, { actorId, action: 'category-keyword-remove' });
    return { ok: true, settings };
  }

  async setExcludeBooks(enabled, { actorId } = {}) {
    const current = await this.get();
    const settings = await this.save(
      { ...current, excludeBooks: Boolean(enabled) },
      { actorId, action: 'category-books' }
    );
    return { ok: true, settings };
  }

  async reset({ actorId } = {}) {
    return this.save(this.defaults(), { actorId, action: 'category-reset' });
  }
}
