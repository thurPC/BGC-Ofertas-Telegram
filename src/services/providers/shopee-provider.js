import { GenericMetadataProvider } from './generic-provider.js';

const SHOPEE_HOSTS = ['shopee.com.br', 'shopee.com', 'shope.ee', 's.shopee.com.br'];

export class ShopeeProvider extends GenericMetadataProvider {
  constructor() {
    super({ id: 'shopee', name: 'Shopee', hosts: SHOPEE_HOSTS });
  }

  // A Shopee usa muito /m/ (mobile) para cupons e campanhas. A classificação
  // de tipo de página já distingue /m/cupom-de-desconto de /product/{id}/{id}.
  headersFor() {
    return { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' };
  }
}
