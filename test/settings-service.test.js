import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStorage } from '../src/storage/json-storage.js';
import {
  SettingsService,
  describeOperatingHours,
  formatHour,
  hoursFromRange,
  parseHourInput,
  resolveAllowedHours
} from '../src/services/settings-service.js';
import { analyzeExclusion } from '../src/services/exclusion-filter.js';
import { isWithinAllowedHours } from '../src/sources/source-interface.js';
import { SchedulerService } from '../src/services/scheduler-service.js';

async function tempSettings(config = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-settings-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  return { service: new SettingsService(storage, config), storage, dir };
}

test('painel de categoria adiciona, ativa, desativa e remove item', async () => {
  const { service } = await tempSettings();
  const added = await service.addCategory('Papelaria', { actorId: 1 });
  assert.equal(added.ok, true);
  assert.equal(added.category.enabled, true);
  assert.equal(added.categories.length, 1);

  const duplicate = await service.addCategory('papelaria');
  assert.equal(duplicate.ok, false);

  const off = await service.setCategoryEnabled(added.category.id, false, { actorId: 1 });
  assert.equal(off.ok, true);
  assert.equal(off.category.enabled, false);

  let options = await service.exclusionOptions();
  assert.equal(options.extraCategories.includes('Papelaria'), false);

  const on = await service.setCategoryEnabled(added.category.id, true, { actorId: 1 });
  assert.equal(on.category.enabled, true);
  options = await service.exclusionOptions();
  assert.deepEqual(options.extraCategories, ['Papelaria']);

  const removed = await service.removeCategory(added.category.id, { actorId: 1 });
  assert.equal(removed.ok, true);
  assert.equal((await service.listCategories()).length, 0);
});

test('categoria ativa entra no filtro e inativa não bloqueia', async () => {
  const { service } = await tempSettings();
  const added = await service.addCategory('Cordas');
  const product = { name: 'Guitarra', category: 'Cordas' };

  let options = await service.exclusionOptions();
  assert.equal(analyzeExclusion(product, options).excluded, true);

  await service.setCategoryEnabled(added.category.id, false);
  options = await service.exclusionOptions();
  assert.equal(analyzeExclusion(product, options).excluded, false);
});

test('parseHourInput aceita hora 24h sem minutos e recusa minutos', () => {
  assert.deepEqual(parseHourInput('8'), { ok: true, hour: 8 });
  assert.deepEqual(parseHourInput('08'), { ok: true, hour: 8 });
  assert.deepEqual(parseHourInput('8h'), { ok: true, hour: 8 });
  assert.deepEqual(parseHourInput('22'), { ok: true, hour: 22 });
  assert.deepEqual(parseHourInput('0'), { ok: true, hour: 0 });
  assert.deepEqual(parseHourInput('23'), { ok: true, hour: 23 });
  assert.equal(parseHourInput('8:30').ok, false);
  assert.equal(parseHourInput('24').ok, false);
  assert.equal(parseHourInput('8.5').ok, false);
  assert.equal(parseHourInput('').ok, false);
});

test('intervalo 24h sem minutos cobre horas cheias e virada do dia', () => {
  assert.deepEqual(hoursFromRange(8, 22), [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
  assert.deepEqual(hoursFromRange(22, 6), [22, 23, 0, 1, 2, 3, 4, 5, 6]);
  assert.equal(formatHour(8), '08h');
  assert.match(describeOperatingHours({ mode: 'always' }), /24 horas/);
  assert.match(describeOperatingHours({ mode: 'range', startHour: 8, endHour: 22 }), /08h às 22h/);
});

test('modo 24h libera qualquer hora e o intervalo restringe', async () => {
  const { service } = await tempSettings();
  await service.setAlwaysOn();
  assert.deepEqual(await service.allowedHours(), []);
  assert.equal(isWithinAllowedHours(new Date('2026-01-01T03:00:00'), []), true);

  await service.setOperatingHours({ mode: 'range', startHour: 8, endHour: 22 });
  const hours = await service.allowedHours();
  assert.equal(isWithinAllowedHours(new Date(2026, 0, 1, 8, 0, 0), hours), true);
  assert.equal(isWithinAllowedHours(new Date(2026, 0, 1, 22, 0, 0), hours), true);
  assert.equal(isWithinAllowedHours(new Date(2026, 0, 1, 7, 0, 0), hours), false);
  assert.equal(isWithinAllowedHours(new Date(2026, 0, 1, 23, 0, 0), hours), false);
});

test('resolveAllowedHours no modo always devolve lista vazia', () => {
  assert.deepEqual(resolveAllowedHours({ mode: 'always', startHour: 8, endHour: 22 }), []);
  assert.deepEqual(resolveAllowedHours({ mode: 'range', startHour: 9, endHour: 11 }), [9, 10, 11]);
});

test('agendador não publica fora do horário configurado', async () => {
  const { service } = await tempSettings();
  await service.setOperatingHours({ mode: 'range', startHour: 8, endHour: 10 });
  const original = Date.prototype.getHours;
  Date.prototype.getHours = () => 3;
  try {
    const scheduler = new SchedulerService({
      config: { autoPublish: true, checkIntervalMinutes: 60, maxOffersPerRun: 5, allowedHours: [] },
      sources: [{ isConfigured: () => true, fetch: async () => ({ ok: true, offers: [] }) }],
      offerService: { list: async () => [] },
      publishingService: {},
      settingsService: service
    });
    const result = await scheduler.run();
    assert.equal(result.ok, true);
    assert.match(result.note, /horário/i);
  } finally {
    Date.prototype.getHours = original;
  }
});
