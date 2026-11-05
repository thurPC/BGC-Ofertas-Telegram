import { DEFAULT_CATEGORIES } from './offer-scorer.js';
import { escapeHtml } from './validation-service.js';

export const CATEGORY_IDS = DEFAULT_CATEGORIES.map((item) => item.id);

export function defaultCategorySettings() {
  return {
    enabled: [...CATEGORY_IDS],
    extras: [],
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

function extraKeywordOf(value) {
  if (typeof value === 'string') return String(value).trim();
  if (value && typeof value === 'object') return String(value.keyword ?? value.text ?? '').trim();
  return '';
}

function extraEnabledOf(value) {
  if (value && typeof value === 'object') return value.enabled !== false;
  return true;
}

export function normalizeExtras(values) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const keyword = extraKeywordOf(value);
    if (keyword.length < 2) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ keyword, enabled: extraEnabledOf(value) });
  }
  return result.slice(0, 40);
}

export function mergeCategorySettings(input = {}, fallback = defaultCategorySettings()) {
  const base = defaultCategorySettings();
  const source = input && typeof input === 'object' ? input : {};
  const enabledRaw = Array.isArray(source.enabled) ? source.enabled : fallback.enabled;
  const enabled = uniqueTexts(enabledRaw)
    .map((item) => String(item).trim().toLowerCase())
    .filter((id) => CATEGORY_IDS.includes(id));
  const extras = normalizeExtras(source.extras ?? source.extraKeywords ?? fallback.extras ?? fallback.extraKeywords);
  return {
    enabled: enabled.length ? enabled : [...base.enabled],
    extras,
    extraKeywords: extras.filter((item) => item.enabled).map((item) => item.keyword),
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
  const lines = ['<b>Categorias da automacao</b>', ''];
  lines.push('<b>Categorias padrao</b>');
  for (const item of DEFAULT_CATEGORIES) {
    const on = resolved.enabled.includes(item.id);
    lines.push(`${on ? 'ON' : 'OFF'} <b>${escapeHtml(item.label)}</b> <code>${escapeHtml(item.id)}</code>`);
  }
  lines.push('');
  lines.push(`Excluir livros: <b>${resolved.excludeBooks ? 'sim' : 'nao'}</b>`);
  lines.push('');
  if (resolved.extras.length) {
    lines.push('<b>Itens extras</b>');
    lines.push(
      ...resolved.extras.map((item) => `${item.enabled ? 'ON' : 'OFF'} ${escapeHtml(item.keyword)}`)
    );
  } else {
    lines.push('<b>Itens extras:</b> nenhum');
  }
  lines.push('');
  lines.push('Use os botoes para adicionar, ativar, desativar ou remover.');
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
      extras: [],
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
    if (CATEGORY_IDS.includes(key)) {
      return current.enabled.includes(key)
        ? this.deactivate(key, { actorId })
        : this.activate(key, { actorId });
    }
    const extra = current.extras.find((item) => item.keyword.toLowerCase() === key);
    if (extra) {
      return extra.enabled ? this.deactivate(key, { actorId }) : this.activate(key, { actorId });
    }
    return { ok: false, error: 'Categoria desconhecida.' };
  }

  async activate(id, { actorId } = {}) {
    const current = await this.get();
    const key = String(id ?? '').trim().toLowerCase();
    if (CATEGORY_IDS.includes(key)) {
      if (current.enabled.includes(key)) return { ok: true, settings: current };
      const settings = await this.save(
        { ...current, enabled: [...current.enabled, key] },
        { actorId, action: 'category-activate' }
      );
      return { ok: true, settings };
    }
    const extras = current.extras.map((item) =>
      item.keyword.toLowerCase() === key ? { ...item, enabled: true } : item
    );
    if (!extras.some((item) => item.keyword.toLowerCase() === key)) {
      return { ok: false, error: 'Item extra nao encontrado.' };
    }
    const settings = await this.save({ ...current, extras }, { actorId, action: 'category-activate' });
    return { ok: true, settings };
  }

  async deactivate(id, { actorId } = {}) {
    const current = await this.get();
    const key = String(id ?? '').trim().toLowerCase();
    if (CATEGORY_IDS.includes(key)) {
      const enabled = current.enabled.filter((item) => item !== key);
      if (!enabled.length && !current.extras.some((item) => item.enabled)) {
        return { ok: false, error: 'Mantenha ao menos uma categoria ativa.' };
      }
      const settings = await this.save({ ...current, enabled }, { actorId, action: 'category-deactivate' });
      return { ok: true, settings };
    }
    const extras = current.extras.map((item) =>
      item.keyword.toLowerCase() === key ? { ...item, enabled: false } : item
    );
    if (!extras.some((item) => item.keyword.toLowerCase() === key)) {
      return { ok: false, error: 'Item extra nao encontrado.' };
    }
    if (!current.enabled.length && extras.every((item) => !item.enabled)) {
      return { ok: false, error: 'Mantenha ao menos uma categoria ativa.' };
    }
    const settings = await this.save({ ...current, extras }, { actorId, action: 'category-deactivate' });
    return { ok: true, settings };
  }

  async addKeyword(keyword, { actorId } = {}) {
    const text = String(keyword ?? '').trim();
    if (text.length < 2) return { ok: false, error: 'Informe uma palavra-chave com pelo menos 2 caracteres.' };
    if (text.length > 60) return { ok: false, error: 'Palavra-chave longa demais.' };
    const current = await this.get();
    const key = text.toLowerCase();
    const known = DEFAULT_CATEGORIES.find((item) => item.id === key || item.label.toLowerCase() === key);
    if (known) return this.activate(known.id, { actorId });
    const existing = current.extras.find((item) => item.keyword.toLowerCase() === key);
    const extras = existing
      ? current.extras.map((item) => (item.keyword.toLowerCase() === key ? { keyword: item.keyword, enabled: true } : item))
      : [...current.extras, { keyword: text, enabled: true }];
    const settings = await this.save({ ...current, extras }, { actorId, action: 'category-keyword-add' });
    return { ok: true, settings };
  }

  async removeKeyword(keyword, { actorId } = {}) {
    const current = await this.get();
    const key = String(keyword ?? '').trim().toLowerCase();
    if (CATEGORY_IDS.includes(key)) {
      return { ok: false, error: 'Categorias padrao nao podem ser removidas. Desative-a se nao quiser usa-la.' };
    }
    const extras = current.extras.filter((item) => item.keyword.toLowerCase() !== key);
    const settings = await this.save({ ...current, extras }, { actorId, action: 'category-keyword-remove' });
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
