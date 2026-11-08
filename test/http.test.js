import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyFetchError,
  describeNetworkError,
  isRetryableHttpStatus,
  defaultJsonHeaders
} from '../src/http.js';

test('classifica TypeError fetch failed com causa de timeout', () => {
  const aborted = new TypeError('fetch failed');
  aborted.cause = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.equal(classifyFetchError(aborted), 'timeout');

  const timedOut = new TypeError('fetch failed');
  timedOut.cause = Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
  assert.equal(classifyFetchError(timedOut), 'timeout');
});

test('classifica TypeError fetch failed de rede e descreve a causa', () => {
  const error = new TypeError('fetch failed');
  error.cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
  assert.equal(classifyFetchError(error), 'network');
  assert.match(describeNetworkError(error), /fetch failed/);
  assert.match(describeNetworkError(error), /ECONNREFUSED/);
});

test('headers JSON incluem User-Agent e status retryable cobre 429/5xx', () => {
  const headers = defaultJsonHeaders({ Accept: 'application/json' });
  assert.match(headers['User-Agent'], /BGC-Ofertas/);
  assert.equal(headers.Accept, 'application/json');
  assert.equal(isRetryableHttpStatus(503), true);
  assert.equal(isRetryableHttpStatus(429), true);
  assert.equal(isRetryableHttpStatus(404), false);
});
