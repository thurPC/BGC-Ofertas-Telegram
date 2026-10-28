import assert from 'node:assert/strict';
import test from 'node:test';
import { isAdmin, loadConfig } from '../src/config.js';

test('autoriza somente IDs administrativos configurados', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'token-teste',
    TELEGRAM_CHANNEL_ID: '-100123',
    ADMIN_IDS: '111, 222'
  });
  assert.equal(isAdmin(config, 111), true);
  assert.equal(isAdmin(config, '222'), true);
  assert.equal(isAdmin(config, 333), false);
  assert.equal(isAdmin(config, null), false);
  assert.equal(isAdmin(config, 'abc'), false);
});

test('loadConfig aponta variáveis ausentes sem revelar valores', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_CHANNEL_ID: '',
    ADMIN_IDS: 'nao-numerico'
  });
  assert.deepEqual(config.missing, ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'ADMIN_IDS']);
  assert.equal(config.autoPublish, false);
});

test('publicação automática permanece desativada por padrão', () => {
  const config = loadConfig({
    TELEGRAM_BOT_TOKEN: 'x',
    TELEGRAM_CHANNEL_ID: '-100',
    ADMIN_IDS: '1'
  });
  assert.equal(config.autoPublish, false);
  assert.equal(config.checkIntervalMinutes, 60);
  assert.equal(config.maxOffersPerRun, 5);
});
