import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStorage, normalizeCategoryStore, createDefaultDb } from '../src/storage/json-storage.js';
import { CategoryService, mergeCategorySettings } from '../src/services/category-service.js';
import { SettingsService, normalizeCategories, categoriesFromStore, categoryStoreState } from '../src/services/settings-service.js';

async function tempStorage() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-storage-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return storage;
}

async function seedSettings(storage, categories, extraSettings = {}) {
  const db = createDefaultDb();
  db.settings = { ...db.settings, ...extraSettings, categories };
  await storage.write(db);
}

const OBJECT_STORE = {
  enabled: ['games', 'casa'],
  extras: [
    { id: 'cat-air-fryer', keyword: 'air fryer', name: 'air fryer', enabled: true },
    { id: 'cat-antiga', keyword: 'item antigo', name: 'item antigo', enabled: false }
  ],
  extraKeywords: ['air fryer'],
  excludeBooks: false
};

const LEGACY_ARRAY = [
  { id: 'cat-papelaria', name: 'Papelaria', enabled: true },
  { id: 'cat-antiga', name: 'Item antigo', enabled: false }
];

test('normalizeCategoryStore preserva objeto e array e cai em [] no inválido', () => {
  assert.deepEqual(normalizeCategoryStore(OBJECT_STORE), OBJECT_STORE);
  assert.deepEqual(normalizeCategoryStore(LEGACY_ARRAY), LEGACY_ARRAY);
  assert.deepEqual(normalizeCategoryStore(null), []);
  assert.deepEqual(normalizeCategoryStore('x'), []);
  assert.deepEqual(normalizeCategoryStore(undefined), []);
});

test('leitura preserva o objeto novo de categorias sem converter em array vazio', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const db = await storage.read();
  assert.equal(Array.isArray(db.settings.categories), false);
  assert.deepEqual(db.settings.categories, OBJECT_STORE);
});

test('leitura preserva o array antigo de categorias', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, LEGACY_ARRAY);
  const db = await storage.read();
  assert.equal(Array.isArray(db.settings.categories), true);
  assert.deepEqual(db.settings.categories, LEGACY_ARRAY);
});

test('gravação do objeto novo sobrevive ao ciclo escrever/ler', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const db = await storage.read();
  await storage.write(db);
  const reloaded = await storage.read();
  assert.deepEqual(reloaded.settings.categories, OBJECT_STORE);
});

test('CategoryService lê o objeto novo preservando enabled e extras desativados', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const service = new CategoryService(storage, { excludeBooks: true });
  const settings = await service.get();
  assert.deepEqual(settings.enabled, ['games', 'casa']);
  assert.equal(settings.excludeBooks, false);
  assert.equal(settings.extras.length, 2);
  assert.equal(settings.extras.find((item) => item.keyword === 'item antigo').enabled, false);
});

test('CategoryService migra o array antigo sem perder categorias principais nem extras', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, LEGACY_ARRAY);
  const service = new CategoryService(storage, { excludeBooks: true });
  const settings = await service.get();
  assert.deepEqual(settings.enabled, ['tecnologia', 'informatica', 'games', 'eletronicos', 'casa']);
  assert.equal(settings.excludeBooks, true);
  assert.deepEqual(settings.extraKeywords, ['Papelaria']);
  assert.equal(settings.extras.find((item) => item.keyword === 'Item antigo').enabled, false);
});

test('SettingsService lê o objeto novo e expõe os extras ativos no filtro', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const service = new SettingsService(storage, {});
  const list = await service.listCategories();
  assert.deepEqual(list.map((item) => item.name), ['air fryer', 'item antigo']);
  const options = await service.exclusionOptions();
  assert.deepEqual(options.extraCategories, ['air fryer']);
});

test('SettingsService migra o array antigo para a lista do painel', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, LEGACY_ARRAY);
  const service = new SettingsService(storage, {});
  const list = await service.listCategories();
  assert.deepEqual(list.map((item) => item.name), ['Papelaria', 'Item antigo']);
  assert.equal(list.find((item) => item.name === 'Item antigo').enabled, false);
});

test('salvar categoria preserva enabled, excludeBooks e não apaga operatingHours', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE, {
    operatingHours: { mode: 'range', startHour: 9, endHour: 18 }
  });
  const service = new SettingsService(storage, {});
  await service.addCategory('Papelaria');

  const db = await storage.read();
  const store = db.settings.categories;
  assert.deepEqual(store.enabled, ['games', 'casa']);
  assert.equal(store.excludeBooks, false);
  assert.deepEqual(db.settings.operatingHours, { mode: 'range', startHour: 9, endHour: 18 });
  assert.deepEqual(store.extras.map((item) => item.keyword), ['air fryer', 'item antigo', 'Papelaria']);
  assert.deepEqual(store.extraKeywords, ['air fryer', 'Papelaria']);
});

test('salvar horário preserva as categorias e seus estados', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const service = new SettingsService(storage, {});
  await service.setOperatingHours({ mode: 'range', startHour: 8, endHour: 22 });

  const db = await storage.read();
  assert.deepEqual(db.settings.categories.enabled, ['games', 'casa']);
  assert.equal(db.settings.categories.excludeBooks, false);
  assert.deepEqual(db.settings.categories.extraKeywords, ['air fryer']);
  assert.deepEqual(db.settings.operatingHours, { mode: 'range', startHour: 8, endHour: 22 });
});

test('ciclo completo: gravar objeto, ler no CategoryService, salvar e reler no SettingsService', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const categoryService = new CategoryService(storage, { excludeBooks: true });
  const before = await categoryService.get();
  const saved = await categoryService.save({ ...before, excludeBooks: true });
  assert.equal(saved.excludeBooks, true);

  const settingsService = new SettingsService(storage, {});
  const list = await settingsService.listCategories();
  assert.deepEqual(list.map((item) => item.name), ['air fryer', 'item antigo']);

  const db = await storage.read();
  assert.deepEqual(db.settings.categories.enabled, ['games', 'casa']);
  assert.equal(db.settings.categories.excludeBooks, true);
});

test('normalizeCategories e categoriesFromStore aceitam array antigo e objeto novo', () => {
  assert.deepEqual(categoriesFromStore(LEGACY_ARRAY), LEGACY_ARRAY);
  assert.deepEqual(categoriesFromStore(OBJECT_STORE), OBJECT_STORE.extras);
  assert.deepEqual(categoriesFromStore(null), []);

  const fromObject = normalizeCategories(OBJECT_STORE);
  assert.deepEqual(fromObject.map((item) => item.name), ['air fryer', 'item antigo']);
  assert.equal(fromObject[1].enabled, false);

  const fromArray = normalizeCategories(LEGACY_ARRAY);
  assert.deepEqual(fromArray.map((item) => item.name), ['Papelaria', 'Item antigo']);
  assert.equal(fromArray[1].enabled, false);
});

test('categoryStoreState unifica os dois formatos sem zerar as categorias principais', () => {
  const fromObject = categoryStoreState(OBJECT_STORE);
  assert.deepEqual(fromObject.enabled, ['games', 'casa']);
  assert.equal(fromObject.excludeBooks, false);

  const fromArray = categoryStoreState(LEGACY_ARRAY);
  assert.deepEqual(fromArray.enabled, ['tecnologia', 'informatica', 'games', 'eletronicos', 'casa']);
  assert.equal(fromArray.excludeBooks, true);

  const fromEmpty = mergeCategorySettings([]);
  assert.deepEqual(fromEmpty.enabled, ['tecnologia', 'informatica', 'games', 'eletronicos', 'casa']);
});

test('boot do scheduler recebe as categorias persistidas via categorySettings', async () => {
  const storage = await tempStorage();
  await seedSettings(storage, OBJECT_STORE);
  const settingsService = new SettingsService(storage, {});
  const applied = settingsService.categorySettings();

  const resolved = mergeCategorySettings(await applied);
  assert.deepEqual(resolved.enabled, ['games', 'casa']);
  assert.equal(resolved.excludeBooks, false);
  assert.deepEqual(resolved.extraKeywords, ['air fryer']);
});
