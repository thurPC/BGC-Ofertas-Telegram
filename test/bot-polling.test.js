import assert from 'node:assert/strict';
import test from 'node:test';
import { startBotPolling } from '../src/bot.js';
import { isDuplicatePollingError } from '../src/polling-error.js';

test('reconhece 409 mesmo quando o code é ETELEGRAM', () => {
  assert.equal(
    isDuplicatePollingError({
      code: 'ETELEGRAM',
      message: 'ETELEGRAM: 409 Conflict: terminated by other getUpdates request; make sure that only one bot instance is running',
      response: { statusCode: 409, body: { error_code: 409 } }
    }),
    true
  );
  assert.equal(isDuplicatePollingError({ code: 409 }), true);
  assert.equal(isDuplicatePollingError({ message: 'network timeout' }), false);
  assert.equal(isDuplicatePollingError(null), false);
});

function fakeBot({ polling = false } = {}) {
  let pollingActive = polling;
  const calls = [];
  return {
    calls,
    isPolling() {
      return pollingActive;
    },
    async deleteWebHook() {
      calls.push('deleteWebHook');
    },
    async startPolling() {
      pollingActive = true;
      calls.push('startPolling');
    },
    async stopPolling() {
      pollingActive = false;
      calls.push('stopPolling');
    }
  };
}

test('startBotPolling inicia exatamente uma vez mesmo chamado em duplicidade', async () => {
  const bot = fakeBot();
  const first = await startBotPolling(bot);
  const second = await startBotPolling(bot);
  const third = await startBotPolling(bot);
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(third, false);
  assert.deepEqual(bot.calls, ['deleteWebHook', 'startPolling']);
});

test('startBotPolling não inicia uma segunda conexão quando o bot já está em polling', async () => {
  const bot = fakeBot({ polling: true });
  const started = await startBotPolling(bot);
  assert.equal(started, false);
  assert.deepEqual(bot.calls, []);
});
