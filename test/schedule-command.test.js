import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStorage } from '../src/storage/json-storage.js';
import { SchedulerService } from '../src/services/scheduler-service.js';
import {
  ScheduleService,
  defaultScheduleSettings,
  formatScheduleRange,
  hoursFromSchedule,
  mergeScheduleSettings,
  parseScheduleInput
} from '../src/services/schedule-service.js';
import { registerScheduleCallbacks, registerScheduleCommand, schedulePanel } from '../src/commands/schedule.js';
import { loadConfig } from '../src/config.js';
import { isWithinAllowedHours } from '../src/sources/source-interface.js';

async function tempService(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bgc-sch-'));
  const storage = new JsonStorage(path.join(dir, 'offers.json'));
  await storage.init();
  const service = new ScheduleService(storage, env);
  return { dir, storage, service };
}

function fakeBot() {
  const sent = [];
  const handlers = { text: [], message: [], callback: [] };
  const bot = {
    on(event, handler) {
      if (event === 'callback_query') handlers.callback.push(handler);
      else handlers.message.push(handler);
    },
    onText(pattern, handler) {
      handlers.text.push({ pattern, handler });
    },
    async sendMessage(chatId, text, extra) {
      sent.push({ kind: 'text', chatId, text, extra });
      return { message_id: sent.length };
    },
    async answerCallbackQuery() {}
  };
  return { bot, sent, handlers };
}

test('parseia horario 24h sem minutos e rejeita minutos', () => {
  assert.deepEqual(parseScheduleInput('24h').settings, defaultScheduleSettings());
  assert.deepEqual(parseScheduleInput('08-22').settings, { mode: 'range', startHour: 8, endHour: 22 });
  assert.deepEqual(parseScheduleInput('9 18').settings, { mode: 'range', startHour: 9, endHour: 18 });
  assert.equal(parseScheduleInput('08:30-22:00').ok, false);
  assert.match(parseScheduleInput('08:30-22:00').error, /24h, sem minutos/i);
});

test('hoursFromSchedule gera horas cheias e 24h libera todas', () => {
  assert.deepEqual(hoursFromSchedule({ mode: 'always' }), []);
  assert.deepEqual(hoursFromSchedule({ mode: 'range', startHour: 8, endHour: 10 }), [8, 9, 10]);
  assert.equal(isWithinAllowedHours(new Date('2026-11-05T12:00:00Z'), []), true);
  assert.equal(isWithinAllowedHours(new Date('2026-11-05T12:00:00-03:00'), [8, 9, 10]), false);
});

test('persiste janela 08-22 e restaura 24h', async () => {
  const { service, storage } = await tempService();
  const updated = await service.setFromInput('08-22', { actorId: 1 });
  assert.equal(updated.ok, true);
  assert.equal(formatScheduleRange(updated.settings), '08h-22h');
  const db = await storage.read();
  assert.equal(db.settings.schedule.startHour, 8);
  assert.equal(db.settings.schedule.endHour, 22);
  const restored = await service.reset({ actorId: 1 });
  assert.deepEqual(restored, defaultScheduleSettings());
});

test('/horario e restrito a admin e aplica no agendador', async () => {
  const { service } = await tempService();
  const { bot, sent, handlers } = fakeBot();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '7'
  });
  const applied = [];
  const scheduler = {
    applyScheduleSettings(settings) {
      applied.push(mergeScheduleSettings(settings));
    }
  };
  registerScheduleCommand(bot, { config, scheduleService: service, scheduler });
  const route = handlers.text.find((item) => item.pattern.test('/horario'));
  await route.handler({ chat: { id: 1 }, from: { id: 99 }, text: '/horario' });
  assert.match(sent[0].text, /restrito/i);
  sent.length = 0;
  await route.handler({ chat: { id: 1 }, from: { id: 7 }, text: '/horario 08-22' });
  assert.match(sent[0].text, /08h-22h/);
  assert.equal(applied[0].startHour, 8);
  assert.equal(applied[0].endHour, 22);
});

test('callback 24h restaura operacao continua', async () => {
  const { service } = await tempService();
  await service.setFromInput('09-18');
  const { bot, sent, handlers } = fakeBot();
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '7'
  });
  registerScheduleCallbacks(bot, {
    config,
    scheduleService: service,
    scheduler: { applyScheduleSettings() {} }
  });
  await handlers.callback[0]({
    id: '1',
    data: 'horario:set:24h',
    from: { id: 7 },
    message: { chat: { id: 11 } }
  });
  const current = await service.get();
  assert.equal(current.mode, 'always');
  assert.match(sent.at(-1).text, /24h/);
});

test('agendador aplica janela 24h e bloqueia fora do horario', () => {
  const scheduler = new SchedulerService({
    config: { allowedHours: [] },
    sources: [],
    offerService: {},
    publishingService: {}
  });
  scheduler.applyScheduleSettings({ mode: 'range', startHour: 8, endHour: 10 });
  assert.deepEqual(scheduler.config.allowedHours, [8, 9, 10]);
  const noon = new Date(2026, 10, 5, 12, 0, 0);
  const morning = new Date(2026, 10, 5, 9, 0, 0);
  assert.equal(isWithinAllowedHours(noon, scheduler.config.allowedHours), false);
  assert.equal(isWithinAllowedHours(morning, scheduler.config.allowedHours), true);
  scheduler.applyScheduleSettings({ mode: 'always' });
  assert.deepEqual(scheduler.config.allowedHours, []);
  assert.equal(isWithinAllowedHours(noon, scheduler.config.allowedHours), true);
  assert.ok(schedulePanel({ mode: 'range', startHour: 8, endHour: 22 }).html.includes('08h-22h'));
});
