import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADMIN_BOT_COMMANDS,
  PUBLIC_BOT_COMMANDS,
  adminCommandScopes,
  registerBotMenuCommands
} from '../src/commands/bot-commands.js';

test('menu público não lista comandos administrativos', () => {
  const names = PUBLIC_BOT_COMMANDS.map((item) => item.command);
  assert.deepEqual(names, ['start', 'ajuda', 'sobre']);
});

test('menu administrativo inclui categorias e horario', () => {
  const names = ADMIN_BOT_COMMANDS.map((item) => item.command);
  assert.ok(names.includes('admin'));
  assert.ok(names.includes('categorias'));
  assert.ok(names.includes('horario'));
  assert.ok(names.includes('modelo'));
  assert.equal(
    names.every((name) => /^[a-z0-9_]+$/.test(name) && name.length <= 32),
    true
  );
  assert.equal(
    ADMIN_BOT_COMMANDS.every((item) => item.description.length >= 3 && item.description.length <= 256),
    true
  );
});

test('escopos administrativos usam chat_id de cada admin', () => {
  const scopes = adminCommandScopes([111n, 222n]);
  assert.deepEqual(scopes, [
    { type: 'chat', chat_id: '111' },
    { type: 'chat', chat_id: '222' }
  ]);
});

test('registerBotMenuCommands envia menu público e um menu por admin', async () => {
  const calls = [];
  const bot = {
    async setMyCommands(commands, options) {
      calls.push({ commands, options });
      return true;
    }
  };
  await registerBotMenuCommands(bot, { adminIds: [10n, 20n] }, { warn() {} });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].commands, PUBLIC_BOT_COMMANDS);
  assert.equal(calls[0].options, undefined);
  assert.deepEqual(calls[1].commands, ADMIN_BOT_COMMANDS);
  assert.deepEqual(calls[1].options.scope, { type: 'chat', chat_id: '10' });
  assert.deepEqual(calls[2].options.scope, { type: 'chat', chat_id: '20' });
});

test('falha ao registrar um menu não interrompe os demais', async () => {
  const calls = [];
  const bot = {
    async setMyCommands(commands, options) {
      calls.push({ commands, options });
      if (!options) throw new Error('falha pública');
      return true;
    }
  };
  await registerBotMenuCommands(bot, { adminIds: [99n] }, { warn() {} });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].options.scope, { type: 'chat', chat_id: '99' });
});
