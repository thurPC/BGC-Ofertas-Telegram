import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { ShopeeAffiliateClient } from '../src/services/shopee-affiliate-client.js';

test('assina a requisição com SHA-256 no formato Shopee', () => {
  const client = new ShopeeAffiliateClient({ appId: '123', secret: 'segredo' });
  const body = '{"query":"{ shopOfferV2 }"}';
  const timestamp = 1700000000;
  const expected = createHash('sha256')
    .update('123' + String(timestamp) + body + 'segredo', 'utf8')
    .digest('hex');
  assert.equal(
    client.authorization(body, timestamp),
    `SHA256 Credential=123, Timestamp=1700000000, Signature=${expected}`
  );
});

test('gera link curto e envia assinatura e payload GraphQL', async () => {
  let request;
  const client = new ShopeeAffiliateClient({
    appId: '123',
    secret: 'segredo',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: { generateShortLink: { shortLink: 'https://s.shopee.com.br/abc' } } });
        }
      };
    }
  });
  const result = await client.generateShortLink('https://shopee.com.br/produto-i.111.222');
  assert.deepEqual(result, { ok: true, shortLink: 'https://s.shopee.com.br/abc' });
  assert.equal(request.url, 'https://open-api.affiliate.shopee.com.br/graphql');
  assert.match(request.options.headers.Authorization, /^SHA256 Credential=123, Timestamp=\d+, Signature=[a-f0-9]{64}$/);
  assert.match(request.options.body, /generateShortLink/);
  assert.match(request.options.body, /originUrl/);
});

test('não chama API sem credenciais ou com URL de outro domínio', async () => {
  const missing = new ShopeeAffiliateClient();
  assert.equal((await missing.generateShortLink('https://shopee.com.br/x')).reason, 'not-configured');
  const client = new ShopeeAffiliateClient({ appId: '1', secret: 'x', fetchImpl: async () => { throw new Error('não deveria chamar'); } });
  assert.equal((await client.generateShortLink('https://example.com/produto')).reason, 'invalid-url');
});

test('usa fallback explícito quando a API retorna erro GraphQL', async () => {
  const client = new ShopeeAffiliateClient({
    appId: '123',
    secret: 'segredo',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() { return JSON.stringify({ errors: [{ message: 'Invalid credential', extensions: { code: 10020 } }] }); }
    })
  });
  const result = await client.generateShortLink('https://shopee.com.br/produto-i.111.222');
  assert.equal(result.ok, false);
  assert.equal(result.code, 10020);
});
