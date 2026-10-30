import assert from 'node:assert/strict';
import test from 'node:test';
import { ProductResolverService } from '../src/services/providers/product-resolver.js';
import { AmazonProvider } from '../src/services/providers/amazon-provider.js';
import { MercadoLivreProvider } from '../src/services/providers/mercadolivre-provider.js';
import { ShopeeProvider } from '../src/services/providers/shopee-provider.js';
import { GenericMetadataProvider } from '../src/services/providers/generic-provider.js';
import { PAGE_TYPES, classifyPage } from '../src/services/providers/page-classifier.js';
import { FETCH_STATUS, classifyHttpStatus, httpGet } from '../src/services/providers/http-client.js';

// ---------------------------------------------------------------------------
// Helpers: respostas HTTP controladas, sem tocar em páginas reais.
// ---------------------------------------------------------------------------

function res({ status = 200, body = '', location = null, headers = {} } = {}) {
  const all = { ...headers, ...(location ? { location } : {}) };
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => all[String(name).toLowerCase()] ?? null },
    async text() {
      return body;
    }
  };
}

function makeFetcher(routes) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const route = routes[url];
    if (!route) return res({ status: 404, body: '<html>not found</html>' });
    if (typeof route === 'function') return route(url);
    return res(route);
  };
  return { fetchImpl, seen, lookup: async () => [{ address: '93.184.216.34' }] };
}

function resolverWith(routes) {
  const { fetchImpl, seen, lookup } = makeFetcher(routes);
  const resolver = new ProductResolverService();
  return { resolver, options: { fetchImpl, lookup, attempts: 1 }, seen };
}

const PRODUCT_HTML = (extra = '') => `<html><head>
  <meta property="og:title" content="Produto Real"/>
  <meta property="og:image" content="https://cdn.loja.com/produto.jpg"/>
  <meta property="og:type" content="product"/>
  ${extra}
</head><body>R$ 99,90</body></html>`;

// ---------------------------------------------------------------------------
// Erros HTTP
// ---------------------------------------------------------------------------

test('classifica os códigos HTTP em estados específicos', () => {
  assert.equal(classifyHttpStatus(200), FETCH_STATUS.OK);
  assert.equal(classifyHttpStatus(403), FETCH_STATUS.SOURCE_BLOCKED);
  assert.equal(classifyHttpStatus(404), FETCH_STATUS.NOT_FOUND);
  assert.equal(classifyHttpStatus(429), FETCH_STATUS.RATE_LIMITED);
  assert.equal(classifyHttpStatus(500), FETCH_STATUS.SOURCE_ERROR);
  assert.equal(classifyHttpStatus(502), FETCH_STATUS.SOURCE_ERROR);
  assert.equal(classifyHttpStatus(503), FETCH_STATUS.SOURCE_ERROR);
});

test('Amazon 503: registra indisponibilidade e não inventa dados', async () => {
  const { resolver, options } = resolverWith({
    'https://link.amazon/B08QSXUPQ0': { status: 503, body: '<html>Robot Check</html>' }
  });
  const result = await resolver.resolve('https://link.amazon/B08QSXUPQ0', options);
  assert.equal(result.ok, false);
  assert.equal(result.status, FETCH_STATUS.SOURCE_ERROR);
  assert.equal(result.offer.name, null);
  assert.equal(result.offer.price, null);
  assert.equal(result.offer.imageUrl, null);
  assert.ok(result.attempts.length >= 1);
});

test('Mercado Livre 403: estado SOURCE_BLOCKED sem substituir título pelo domínio', async () => {
  const { resolver, options } = resolverWith({
    'https://meli.la/2EC6TA2': { status: 403, body: '<html>forbidden</html>' }
  });
  const result = await resolver.resolve('https://meli.la/2EC6TA2', options);
  assert.equal(result.ok, false);
  assert.equal(result.status, FETCH_STATUS.SOURCE_BLOCKED);
  assert.equal(result.offer.name, null);
});

test('404 é NOT_FOUND, não bloqueio', async () => {
  const { resolver, options } = resolverWith({ 'https://www.amazon.com.br/dp/B08QSXUPQ0': { status: 404 } });
  const result = await resolver.resolve('https://www.amazon.com.br/dp/B08QSXUPQ0', options);
  assert.equal(result.status, FETCH_STATUS.NOT_FOUND);
});

test('redirecionamento para destino inseguro é recusado', async () => {
  const { resolver, options } = resolverWith({
    'https://meli.la/x': { status: 302, location: 'http://169.254.169.254/latest/meta-data' }
  });
  const result = await resolver.resolve('https://meli.la/x', options);
  assert.equal(result.ok, false);
  assert.equal(result.status, FETCH_STATUS.UNSAFE_URL);
});

test('protocolo diferente de http/https é recusado', async () => {
  const { resolver, options } = resolverWith({ 'https://meli.la/y': { status: 302, location: 'ftp://evil.example/x' } });
  const result = await resolver.resolve('https://meli.la/y', options);
  assert.equal(result.status, FETCH_STATUS.UNSAFE_URL);
});

test('httpGet envia cabeçalhos de navegador (Accept-Language pt-BR)', async () => {
  const seenHeaders = [];
  const fetchImpl = async (url, opts) => {
    seenHeaders.push(opts.headers);
    return res({ status: 200, body: PRODUCT_HTML() });
  };
  await httpGet('https://www.mercadolivre.com.br/p/MLB1', { fetchImpl, lookup: async () => [{ address: '93.184.216.34' }] });
  assert.match(seenHeaders[0]['Accept-Language'], /pt-BR/);
  assert.match(seenHeaders[0]['User-Agent'], /Mozilla/);
});

// ---------------------------------------------------------------------------
// Amazon
// ---------------------------------------------------------------------------

test('Amazon: link curto segue até /dp/ASIN e identifica o produto', async () => {
  const short = 'https://link.amazon/B08QSXUPQ0';
  const product = 'https://www.amazon.com.br/dp/B08QSXUPQ0';
  const { resolver, options } = resolverWith({
    [short]: { status: 302, location: product },
    [product]: { status: 200, body: PRODUCT_HTML('<meta property="og:site_name" content="Amazon.com.br"/>') }
  });
  const result = await resolver.resolve(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.pageType, PAGE_TYPES.PRODUCT);
  assert.equal(result.offer.name, 'Produto Real');
  assert.equal(result.offer.store, 'Amazon Brasil');
  assert.equal(result.offer.asin, 'B08QSXUPQ0');
  assert.equal(result.offer.url, short, 'link de afiliado original preservado');
});

test('Amazon: página intermediária /hz/mobile/mission é resolvida para /dp/ASIN', async () => {
  const short = 'https://link.amazon/B08QSXUPQ0';
  const mission = 'https://www.amazon.com.br/hz/mobile/mission?_encoding=UTF8&p=abc';
  const product = 'https://www.amazon.com.br/dp/B08QSXUPQ0';
  const { resolver, options } = resolverWith({
    [short]: { status: 302, location: mission },
    [mission]: { status: 200, body: '<html><head><title>Amazon.com.br</title></head><body>mission</body></html>' },
    [product]: { status: 200, body: PRODUCT_HTML('<meta property="og:site_name" content="Amazon.com.br"/>') }
  });
  const result = await resolver.resolve(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.offer.asin, 'B08QSXUPQ0');
  assert.equal(result.offer.name, 'Produto Real');
  assert.ok(result.attempts.some((a) => a.url === product), 'deve ter consultado a página do produto');
});

test('Amazon: preço não é exibido sem fonte autorizada', async () => {
  const url = 'https://www.amazon.com.br/dp/B08QSXUPQ0';
  const { resolver, options } = resolverWith({
    [url]: { status: 200, body: PRODUCT_HTML('<meta property="product:price:amount" content="199.90"/>') }
  });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.price, null);
  assert.ok(result.warnings.includes('price-authorized-only'));
  assert.equal(result.fieldReasons.price, 'price-authorized-only');
});

test('Amazon: preço é aceito quando há provedor autorizado', async () => {
  const url = 'https://www.amazon.com.br/dp/B08QSXUPQ0';
  const { resolver, options } = resolverWith({
    [url]: { status: 200, body: PRODUCT_HTML('<meta property="product:price:amount" content="199.90"/>') }
  });
  const result = await resolver.resolve(url, { ...options, authorizedPriceProvider: true });
  assert.equal(result.offer.price, 199.9);
  assert.ok(!result.warnings.includes('price-authorized-only'));
});

// ---------------------------------------------------------------------------
// Mercado Livre
// ---------------------------------------------------------------------------

test('Mercado Livre: /social/ com dados de produto é classificado como PRODUCT', async () => {
  const short = 'https://meli.la/2EC6TA2';
  const social = 'https://www.mercadolivre.com.br/social/ao20251027154024?ref=abc';
  const mlHtml = `<html><head>
    <meta property="og:title" content="Tênis Flyer Runner Mesh Bdp Puma - R$ 189,99"/>
    <meta property="og:image" content="https://http2.mlstatic.com/D_NQ_NP_730513-MLB.webp"/>
    <meta property="og:type" content="website"/>
    <meta property="og:site_name" content="Mercado Livre"/>
  </head><body></body></html>`;
  const { resolver, options } = resolverWith({
    [short]: { status: 302, location: social },
    [social]: { status: 200, body: mlHtml }
  });
  const result = await resolver.resolve(short, options);
  assert.equal(result.ok, true);
  assert.equal(result.pageType, PAGE_TYPES.PRODUCT);
  assert.equal(result.offer.name, 'Tênis Flyer Runner Mesh Bdp Puma');
  assert.equal(result.offer.price, 189.99);
  assert.equal(result.offer.store, 'Mercado Livre');
  assert.equal(result.offer.url, short);
});

test('Mercado Livre: falha do provedor específico não derruba o fluxo', async () => {
  const url = 'https://www.mercadolivre.com.br/p/MLB123';
  const { resolver, options } = resolverWith({
    [url]: { status: 200, body: PRODUCT_HTML() }
  });
  const result = await resolver.resolve(url, options);
  assert.equal(result.ok, true);
  assert.equal(result.offer.name, 'Produto Real');
});

// ---------------------------------------------------------------------------
// Shopee
// ---------------------------------------------------------------------------

test('Shopee: página de cupons é reconhecida e NÃO vira produto', async () => {
  const short = 'https://s.shopee.com.br/1143MqtGS3';
  const coupons = 'https://shopee.com.br/m/cupom-de-desconto?mmp_pid=an_1&utm_source=affiliates';
  const couponHtml = `<html><head>
    <meta property="og:title" content="Cupons de desconto"/>
    <meta property="og:type" content="website"/>
    <meta property="og:site_name" content="Shopee"/>
  </head><body>Cupons</body></html>`;
  const { resolver, options } = resolverWith({
    [short]: { status: 302, location: coupons },
    [coupons]: { status: 200, body: couponHtml }
  });
  const result = await resolver.resolve(short, options);
  assert.equal(result.pageType, PAGE_TYPES.COUPON);
  assert.equal(result.ok, false, 'página de cupons não é produto');
});

test('Shopee: página de produto é reconhecida como PRODUCT', async () => {
  const url = 'https://shopee.com.br/product/123/456';
  const html = `<html><head>
    <meta property="og:title" content="Fone Bluetooth"/>
    <meta property="og:image" content="https://cf.shopee.com.br/fone.jpg"/>
    <meta property="product:price:amount" content="89.90"/>
    <meta property="og:site_name" content="Shopee"/>
  </head><body></body></html>`;
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: html } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.ok, true);
  assert.equal(result.pageType, PAGE_TYPES.PRODUCT);
  assert.equal(result.offer.name, 'Fone Bluetooth');
  assert.equal(result.offer.price, 89.9);
  assert.equal(result.offer.store, 'Shopee');
});

// ---------------------------------------------------------------------------
// Classificação de tipo de página
// ---------------------------------------------------------------------------

test('classifyPage distingue campanha, loja e categoria', () => {
  assert.equal(classifyPage({ url: 'https://x.com/m/campanha', platform: { id: 'shopee' } }).type, PAGE_TYPES.CAMPAIGN);
  assert.equal(classifyPage({ url: 'https://x.com/loja/bgc', platform: { id: 'generic' } }).type, PAGE_TYPES.STORE);
  assert.equal(classifyPage({ url: 'https://x.com/categorias/eletronicos', platform: { id: 'generic' } }).type, PAGE_TYPES.CATEGORY);
  assert.equal(classifyPage({ url: 'https://x.com/m/cupom-de-desconto', platform: { id: 'shopee' } }).type, PAGE_TYPES.COUPON);
  assert.equal(classifyPage({ url: 'https://www.amazon.com.br/dp/B08QSXUPQ0', platform: { id: 'amazon' } }).type, PAGE_TYPES.PRODUCT);
  assert.equal(classifyPage({ url: 'https://x.com/qualquer', platform: { id: 'generic' } }).type, PAGE_TYPES.UNKNOWN);
});

test('classifyPage trata JSON-LD Product como PRODUCT mesmo em URL ambígua', () => {
  const result = classifyPage({
    url: 'https://loja.com/m/campanha',
    platform: { id: 'generic' },
    jsonLdTypes: ['Product'],
    hasProductData: true
  });
  assert.equal(result.type, PAGE_TYPES.PRODUCT);
});

// ---------------------------------------------------------------------------
// Metadados
// ---------------------------------------------------------------------------

test('produto com JSON-LD é extraído corretamente', async () => {
  const url = 'https://loja-qualquer.com/p/1';
  const html = `<html><head>
    <script type="application/ld+json">{"@type":"Product","name":"Monitor Gamer 27","image":"https://ml.com/mon.jpg","offers":{"@type":"Offer","price":"1299.00"}}</script>
  </head><body></body></html>`;
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: html } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.name, 'Monitor Gamer 27');
  assert.equal(result.offer.price, 1299);
  assert.equal(result.pageType, PAGE_TYPES.PRODUCT);
});

test('produto sem preço: campo ausente é registrado com motivo', async () => {
  const url = 'https://shopee.com.br/product/1/2';
  const html = '<meta property="og:title" content="Sem Preço"/><meta property="og:image" content="https://x/i.jpg"/>';
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: html } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.price, null);
  assert.ok(result.missing.includes('price'));
  assert.equal(result.fieldReasons.price, 'price-not-found');
});

test('produto sem imagem: campo ausente é registrado com motivo', async () => {
  const url = 'https://shopee.com.br/product/1/2';
  const html = '<meta property="og:title" content="Sem Foto"/><meta property="product:price:amount" content="10.00"/>';
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: html } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.imageUrl, null);
  assert.ok(result.warnings.includes('image-missing'));
});

test('título igual ao domínio é descartado', async () => {
  const url = 'https://www.amazon.com.br/dp/B08QSXUPQ0';
  const html = '<html><head><title>Amazon.com.br</title><meta property="og:title" content="Amazon.com.br"/></head><body></body></html>';
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: html } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.name, null);
});

test('página sem metadados retorna UNKNOWN e nenhum dado inventado', async () => {
  const url = 'https://loja-qualquer.com/p/sem-meta';
  const { resolver, options } = resolverWith({ [url]: { status: 200, body: '<html><body>vazio</body></html>' } });
  const result = await resolver.resolve(url, options);
  assert.equal(result.offer.name, null);
  assert.equal(result.offer.price, null);
  assert.equal(result.offer.imageUrl, null);
});

// ---------------------------------------------------------------------------
// Redirecionamentos múltiplos e link de afiliado
// ---------------------------------------------------------------------------

test('redirecionamentos múltiplos são seguidos e o link original é preservado', async () => {
  const original = 'https://s.shopee.com.br/abc123';
  const hop1 = 'https://shopee.com.br/redir/1';
  const product = 'https://shopee.com.br/product/9/9';
  const html = '<meta property="og:title" content="Produto"/><meta property="og:image" content="https://x/i.jpg"/><meta property="og:type" content="product"/>';
  const { resolver, options, seen } = resolverWith({
    [original]: { status: 301, location: hop1 },
    [hop1]: { status: 302, location: product },
    [product]: { status: 200, body: html }
  });
  const result = await resolver.resolve(original, options);
  assert.equal(result.offer.url, original);
  assert.equal(result.offer.originalAffiliateUrl, original);
  assert.equal(result.offer.resolvedProductUrl, product);
  assert.equal(seen[0], original);
});

test('link de afiliado com parâmetros é preservado integralmente', async () => {
  const affiliate = 'https://www.amazon.com.br/dp/B08QSXUPQ0?tag=bgc-20&linkCode=xyz&ref_=abc';
  const { resolver, options } = resolverWith({
    [affiliate]: { status: 200, body: PRODUCT_HTML('<meta property="og:site_name" content="Amazon.com.br"/>') }
  });
  const result = await resolver.resolve(affiliate, options);
  assert.equal(result.offer.url, affiliate);
  assert.equal(result.offer.originalAffiliateUrl, affiliate);
  assert.match(result.offer.url, /tag=bgc-20/);
  assert.match(result.offer.url, /linkCode=xyz/);
});

// ---------------------------------------------------------------------------
// Estrutura de provedores
// ---------------------------------------------------------------------------

test('resolver usa o provedor da plataforma e mantém fallback genérico', () => {
  const resolver = new ProductResolverService();
  const chain = resolver.providerFor({ id: 'amazon', name: 'Amazon' }, 'link.amazon');
  assert.equal(chain[0].id, 'amazon');
  assert.equal(chain.at(-1).id, 'generic');
});

test('provedores expõem hosts e nomes esperados', () => {
  assert.equal(new AmazonProvider().name, 'Amazon');
  assert.equal(new MercadoLivreProvider().name, 'Mercado Livre');
  assert.equal(new ShopeeProvider().name, 'Shopee');
  assert.equal(new GenericMetadataProvider().id, 'generic');
  assert.ok(new MercadoLivreProvider().matches('meli.la'));
  assert.ok(new ShopeeProvider().matches('s.shopee.com.br'));
  assert.ok(new AmazonProvider().matches('link.amazon'));
});
