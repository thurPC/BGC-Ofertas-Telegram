import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractionSummary,
  missingFieldsMessage,
  missingFieldsPrompt,
  nonProductMessage,
  blockedMessage,
  WARNING_TEXT
} from '../src/services/offer-automation.js';
import { PAGE_TYPES } from '../src/services/providers/page-classifier.js';
import {
  createExtractionSession,
  missingRequiredFields,
  applyWizardInput,
  imageReviewNote
} from '../src/handlers/wizard.js';
import { chooseSendMode } from '../src/formatters/offer-message.js';
import { pickLargestPhoto, extractLinkFromText } from '../src/handlers/message-handler.js';

// ---------------------------------------------------------------------------
// Cadastro inteligente: pede somente os campos ausentes.
// ---------------------------------------------------------------------------

test('sessão de extração coleta somente os campos obrigatórios ausentes', () => {
  const session = createExtractionSession(1, { name: 'Produto', store: 'Shopee', url: 'https://x/y' });
  assert.deepEqual(session.collect, ['price'], 'título e loja já existem, só falta o preço');
  assert.equal(session.step, 'price');
});

test('sessão de extração não repete campos já extraídos', () => {
  const session = createExtractionSession(1, { name: 'Produto', price: 10, store: 'Amazon Brasil', imageUrl: 'https://x/i.jpg' });
  assert.deepEqual(session.collect, []);
  assert.equal(session.step, 'preview');
});

test('campos ausentes são informados individualmente', () => {
  assert.deepEqual(missingRequiredFields({ name: 'X', price: 1, store: 'S' }), []);
  assert.deepEqual(missingRequiredFields({ name: 'X' }), ['price', 'store']);
  assert.match(missingFieldsPrompt(['price']), /preço atual/i);
  assert.match(missingFieldsMessage(['price']), /preço/);
});

test('preenchimento do campo ausente conclui para a prévia', () => {
  const session = createExtractionSession(1, { name: 'Produto', store: 'Shopee' });
  const result = applyWizardInput(session, '199,90');
  assert.equal(result.ok, true);
  assert.equal(result.done, true);
  assert.equal(session.data.price, 199.9);
});

// ---------------------------------------------------------------------------
// Cupons e campanhas separados de produtos.
// ---------------------------------------------------------------------------

test('mensagem de cupom explica que não é produto individual', () => {
  const text = nonProductMessage({ pageType: PAGE_TYPES.COUPON, platform: { name: 'Shopee' } });
  assert.match(text, /página de cupons/i);
  assert.match(text, /Shopee/);
  assert.match(text, /link direto do produto/i);
});

test('mensagem de campanha é distinta da de cupom', () => {
  const text = nonProductMessage({ pageType: PAGE_TYPES.CAMPAIGN, platform: { name: 'Amazon' } });
  assert.match(text, /campanha promocional/i);
  assert.doesNotMatch(text, /cupons/i);
});

test('mensagem de bloqueio informa o motivo sem inventar dados', () => {
  const text = blockedMessage({ platform: { name: 'Mercado Livre' }, status: 'SOURCE_BLOCKED', error: 'A loja bloqueou o acesso automático (HTTP 403).' });
  assert.match(text, /Mercado Livre/);
  assert.match(text, /403/);
  assert.match(text, /Nenhum dado foi inventado/i);
});

// ---------------------------------------------------------------------------
// Imagem manual.
// ---------------------------------------------------------------------------

test('pickLargestPhoto escolhe o maior arquivo disponível', () => {
  const photo = pickLargestPhoto([
    { file_id: 'small', file_size: 100 },
    { file_id: 'big', file_size: 5000 },
    { file_id: 'mid', file_size: 900 }
  ]);
  assert.equal(photo.file_id, 'big');
});

test('pickLargestPhoto trata ausência de fotos', () => {
  assert.equal(pickLargestPhoto(undefined), null);
  assert.equal(pickLargestPhoto([]), null);
});

test('imagem via file_id dispensa revisão', () => {
  assert.equal(imageReviewNote({ imageFileId: 'abc' }), null);
  assert.equal(imageReviewNote({ imageUrl: 'https://x/i.jpg' }), null);
  assert.match(imageReviewNote({}), /Sem imagem confirmada/);
});

test('publicação usa a foto por file_id quando não há URL', () => {
  const mode = chooseSendMode({ name: 'X', price: 1, imageFileId: 'FILE123' }, '<b>oi</b>');
  assert.equal(mode.method, 'sendPhoto');
  assert.equal(mode.photo, 'FILE123');
});

test('publicação sem imagem cai para texto', () => {
  const mode = chooseSendMode({ name: 'X', price: 1 }, '<b>oi</b>');
  assert.equal(mode.method, 'sendMessage');
});

// ---------------------------------------------------------------------------
// Resumo e avisos.
// ---------------------------------------------------------------------------

test('resumo mostra tipo de página quando não é produto', () => {
  const text = extractionSummary({
    offer: { name: 'Cupons' },
    platform: { name: 'Shopee' },
    pageType: PAGE_TYPES.COUPON,
    warnings: []
  });
  assert.match(text, /Tipo de página/);
  assert.match(text, /página de cupons/);
});

test('resumo preserva menção ao link de afiliado', () => {
  const text = extractionSummary({ offer: { name: 'X', store: 'Amazon Brasil' }, platform: { name: 'Amazon' } });
  assert.match(text, /Link de afiliado preservado integralmente/);
});

test('aviso de preço autorizado é exibido quando aplicável', () => {
  assert.match(WARNING_TEXT['price-authorized-only'], /fonte autorizada/i);
});

// ---------------------------------------------------------------------------
// Extração de link do texto.
// ---------------------------------------------------------------------------

test('extractLinkFromText aceita apenas URLs isoladas', () => {
  assert.equal(extractLinkFromText('https://meli.la/x'), 'https://meli.la/x');
  assert.equal(extractLinkFromText('veja https://meli.la/x agora'), null);
  assert.equal(extractLinkFromText('199,90'), null);
});
