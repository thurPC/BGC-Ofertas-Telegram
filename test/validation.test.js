import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateDiscount,
  escapeHtml,
  formatBRL,
  parseBrazilianPrice,
  validateHttpUrl,
  validateOfferInput,
  validateRequiredText
} from '../src/services/validation-service.js';

test('converte preços brasileiros com vírgula e ponto de milhar', () => {
  assert.equal(parseBrazilianPrice('199,90').value, 199.9);
  assert.equal(parseBrazilianPrice('R$ 1.299,00').value, 1299);
  assert.equal(parseBrazilianPrice('10.50').value, 10.5);
  assert.equal(parseBrazilianPrice(20).value, 20);
});

test('rejeita preços negativos e inválidos', () => {
  assert.equal(parseBrazilianPrice('-10').ok, false);
  assert.equal(parseBrazilianPrice('abc').ok, false);
  assert.equal(parseBrazilianPrice('').ok, false);
});

test('calcula desconto somente com preço anterior maior', () => {
  assert.equal(calculateDiscount(200, 100), 50);
  assert.equal(calculateDiscount(100, 100), null);
  assert.equal(calculateDiscount(null, 100), null);
  assert.equal(calculateDiscount(80, 100), null);
});

test('omite desconto quando não há preço anterior', () => {
  const result = validateOfferInput({
    name: 'Headset Gamer',
    price: '199,90',
    url: 'https://loja.example/produto',
    store: 'Loja X'
  });
  assert.equal(result.ok, true);
  assert.equal(result.offer.previousPrice, null);
  assert.equal(calculateDiscount(result.offer.previousPrice, result.offer.price), null);
});

test('escapa HTML perigoso', () => {
  assert.equal(escapeHtml('<b>x</b>&"'), '&lt;b&gt;x&lt;/b&gt;&amp;&quot;');
});

test('valida URLs http/https e rejeita esquemas inválidos', () => {
  assert.equal(validateHttpUrl('https://exemplo.com/p').ok, true);
  assert.equal(validateHttpUrl('ftp://exemplo.com').ok, false);
  assert.equal(validateHttpUrl('pular', { required: false }).skipped, true);
  assert.equal(validateHttpUrl('', { required: true }).ok, false);
});

test('exige campos obrigatórios da oferta', () => {
  const result = validateOfferInput({ name: '', price: '', url: '', store: '' });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 3);
});

test('formata BRL com duas casas', () => {
  assert.equal(formatBRL(10), '10,00');
  assert.equal(formatBRL(1299.5), '1.299,50');
});

test('validateRequiredText recusa vazio e excesso', () => {
  assert.equal(validateRequiredText('  ', 'Nome').ok, false);
  assert.equal(validateRequiredText('ab'.repeat(200), 'Nome', { max: 10 }).ok, false);
  assert.equal(validateRequiredText('Headset', 'Nome').value, 'Headset');
});
