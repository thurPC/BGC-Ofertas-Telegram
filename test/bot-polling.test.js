import assert from 'node:assert/strict';
import test from 'node:test';
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
