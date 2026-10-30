import { GenericMetadataProvider } from './generic-provider.js';

const ML_HOSTS = [
  'mercadolivre.com.br',
  'mercadolibre.com.br',
  'mercadolibre.com',
  'mercadoliv.re',
  'meli.la',
  'mercadolibre.cl',
  'mercadolivre.com'
];

export class MercadoLivreProvider extends GenericMetadataProvider {
  constructor() {
    super({ id: 'mercadolivre', name: 'Mercado Livre', hosts: ML_HOSTS });
  }

  // O Mercado Livre exige que a requisição declare o idioma esperado;
  // sem isso responde 403. O http-client já envia pt-BR por padrão.
  headersFor() {
    return { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' };
  }

  // O título do Mercado Livre costuma vir como "Produto - R$ 189,99".
  // Separamos o nome do produto do preço embutido.
  interpret(context) {
    const result = super.interpret(context);
    const title = result.fields.title?.value;
    if (title) {
      const match = String(title).match(/^(.*?)\s*-\s*R\$\s*([\d.]+,\d{2})\s*$/);
      if (match) {
        result.fields.title = { value: match[1].trim(), confidence: result.fields.title.confidence, reason: null };
        if (result.fields.price.value == null) {
          const parsed = Number(match[2].replace(/\./g, '').replace(',', '.'));
          if (Number.isFinite(parsed)) {
            result.fields.price = { value: parsed, confidence: 0.65, reason: null };
          }
        }
      }
    }
    return result;
  }
}
