import { haystackOf, includesPhrase, normalizeText } from './text.js';

export const PRODUCT_FAMILIES = {
  COMPUTERS: 'computers',
  APPLIANCES: 'appliances',
  ELECTRONICS: 'electronics',
  UNKNOWN: 'unknown',
  INELIGIBLE: 'ineligible'
};

export const TAXONOMY = [
  {
    id: 'notebooks',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Notebooks',
    terms: ['notebook', 'laptop', 'ultrabook', 'macbook', 'chromebook'],
    storeCategories: ['notebooks', 'laptops', 'computadores portateis']
  },
  {
    id: 'desktops',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Desktops',
    terms: ['desktop', 'pc gamer', 'computador gamer', 'all in one', 'mini pc'],
    storeCategories: ['desktops', 'computadores']
  },
  {
    id: 'processors',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Processadores',
    terms: ['processador', 'processor', 'ryzen', 'core i3', 'core i5', 'core i7', 'core i9', 'cpu '],
    storeCategories: ['processadores', 'cpus']
  },
  {
    id: 'gpus',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Placas de vídeo',
    terms: ['placa de video', 'placa de vídeo', 'geforce', 'radeon', 'rtx', 'gtx', 'rx 6', 'rx 7', 'arc a'],
    storeCategories: ['placas de video', 'gpus']
  },
  {
    id: 'motherboards',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Placas-mãe',
    terms: ['placa mae', 'placa-mae', 'motherboard', 'chipset b650', 'chipset z790'],
    storeCategories: ['placas mae', 'motherboards']
  },
  {
    id: 'ram',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Memórias RAM',
    terms: ['memoria ram', 'memória ram', 'ddr4', 'ddr5', 'kit ram'],
    storeCategories: ['memorias', 'ram']
  },
  {
    id: 'ssds',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'SSDs',
    terms: ['ssd', 'nvme', 'm.2', 'solid state'],
    storeCategories: ['ssds', 'armazenamento ssd']
  },
  {
    id: 'hdds',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'HDs',
    terms: ['hd interno', 'hard disk', 'hdd', 'disco rigido'],
    storeCategories: ['hds', 'discos rigidos']
  },
  {
    id: 'psus',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Fontes',
    terms: ['fonte 80 plus', 'fonte atx', 'psu', 'fonte de alimentacao'],
    storeCategories: ['fontes', 'psus']
  },
  {
    id: 'cases',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Gabinetes',
    terms: ['gabinete', 'pc case'],
    storeCategories: ['gabinetes']
  },
  {
    id: 'coolers',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Coolers',
    terms: ['cooler', 'air cooler', 'ventilador cpu'],
    storeCategories: ['coolers']
  },
  {
    id: 'water-coolers',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Water coolers',
    terms: ['water cooler', 'liquid cooler', 'aio 240', 'aio 360'],
    storeCategories: ['water coolers']
  },
  {
    id: 'monitors',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Monitores',
    terms: ['monitor', 'display 144hz', 'monitor gamer'],
    storeCategories: ['monitores']
  },
  {
    id: 'keyboards',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Teclados',
    terms: ['teclado', 'keyboard', 'teclado mecanico'],
    storeCategories: ['teclados']
  },
  {
    id: 'mice',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Mouses',
    terms: ['mouse', 'mouse gamer'],
    storeCategories: ['mouses', 'mouse']
  },
  {
    id: 'headsets',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Headsets',
    terms: ['headset', 'fone gamer', 'headphone gamer'],
    storeCategories: ['headsets']
  },
  {
    id: 'webcams',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Webcams',
    terms: ['webcam', 'camera para pc'],
    storeCategories: ['webcams']
  },
  {
    id: 'microphones',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Microfones',
    terms: ['microfone', 'microphone', 'condensador'],
    storeCategories: ['microfones']
  },
  {
    id: 'routers',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Roteadores',
    terms: ['roteador', 'router', 'mesh wifi', 'wifi 6'],
    storeCategories: ['roteadores']
  },
  {
    id: 'nics',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Placas de rede',
    terms: ['placa de rede', 'adaptador wifi pci', 'nic '],
    storeCategories: ['placas de rede']
  },
  {
    id: 'ups',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Nobreaks',
    terms: ['nobreak', 'no-break', 'ups '],
    storeCategories: ['nobreaks']
  },
  {
    id: 'peripherals',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Periféricos',
    terms: ['periferico', 'perifericos', 'mousepad', 'hub usb'],
    storeCategories: ['perifericos']
  },
  {
    id: 'gamer-accessories',
    family: PRODUCT_FAMILIES.COMPUTERS,
    label: 'Acessórios gamer',
    terms: ['acessorio gamer', 'cadeira gamer', 'controle xbox', 'controle playstation'],
    storeCategories: ['acessorios gamer', 'games']
  },
  {
    id: 'refrigerators',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Geladeiras',
    terms: ['geladeira', 'refrigerador', 'frost free'],
    storeCategories: ['geladeiras', 'refrigeradores']
  },
  {
    id: 'freezers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Freezers',
    terms: ['freezer', 'congelador'],
    storeCategories: ['freezers']
  },
  {
    id: 'washers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Máquinas de lavar',
    terms: ['maquina de lavar', 'lavadora', 'lava e seca'],
    storeCategories: ['maquinas de lavar']
  },
  {
    id: 'dryers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Secadoras',
    terms: ['secadora'],
    storeCategories: ['secadoras']
  },
  {
    id: 'dishwashers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Lava-louças',
    terms: ['lava loucas', 'lava-loucas', 'dishwasher'],
    storeCategories: ['lava loucas']
  },
  {
    id: 'microwaves',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Micro-ondas',
    terms: ['microondas', 'micro-ondas', 'micro ondas'],
    storeCategories: ['microondas']
  },
  {
    id: 'ovens',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Fornos elétricos',
    terms: ['forno eletrico', 'forno elétrico'],
    storeCategories: ['fornos eletricos']
  },
  {
    id: 'stoves',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Fogões',
    terms: ['fogao', 'fogão'],
    storeCategories: ['fogoes']
  },
  {
    id: 'cooktops',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Cooktops',
    terms: ['cooktop', 'cook top'],
    storeCategories: ['cooktops']
  },
  {
    id: 'air-fryers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Air fryers',
    terms: ['air fryer', 'fritadeira eletrica', 'fritadeira sem oleo'],
    storeCategories: ['air fryers', 'fritadeiras']
  },
  {
    id: 'vacuums',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Aspiradores',
    terms: ['aspirador', 'robo aspirador'],
    storeCategories: ['aspiradores']
  },
  {
    id: 'coffee-makers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Cafeteiras',
    terms: ['cafeteira', 'espresso', 'nespresso'],
    storeCategories: ['cafeteiras']
  },
  {
    id: 'blenders',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Liquidificadores',
    terms: ['liquidificador'],
    storeCategories: ['liquidificadores']
  },
  {
    id: 'mixers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Batedeiras',
    terms: ['batedeira'],
    storeCategories: ['batedeiras']
  },
  {
    id: 'purifiers',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Purificadores',
    terms: ['purificador', 'filtro de agua'],
    storeCategories: ['purificadores']
  },
  {
    id: 'air-conditioners',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Ar-condicionado',
    terms: ['ar condicionado', 'ar-condicionado', 'split inverter'],
    storeCategories: ['ar condicionado']
  },
  {
    id: 'fans',
    family: PRODUCT_FAMILIES.APPLIANCES,
    label: 'Ventiladores',
    terms: ['ventilador', 'circulador de ar'],
    storeCategories: ['ventiladores']
  },
  {
    id: 'tvs',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'TVs',
    terms: ['smart tv', 'televisao', 'televisão', 'tv 50', 'tv 55', 'oled', 'qled'],
    storeCategories: ['tvs', 'televisores']
  },
  {
    id: 'projectors',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'Projetores',
    terms: ['projetor', 'projector'],
    storeCategories: ['projetores']
  },
  {
    id: 'soundbars',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'Soundbars',
    terms: ['soundbar', 'sound bar'],
    storeCategories: ['soundbars']
  },
  {
    id: 'audio-systems',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'Sistemas de áudio',
    terms: ['caixa de som', 'home theater', 'sound system'],
    storeCategories: ['audio', 'caixas de som']
  },
  {
    id: 'smart-home',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'Automação residencial',
    terms: ['alexa', 'google nest', 'smart home', 'interruptor inteligente'],
    storeCategories: ['automacao', 'casa inteligente']
  },
  {
    id: 'electronic-accessories',
    family: PRODUCT_FAMILIES.ELECTRONICS,
    label: 'Acessórios eletrônicos',
    terms: ['carregador', 'power bank', 'cabo usb-c'],
    storeCategories: ['acessorios eletronicos']
  }
];

const INELIGIBLE_TERMS = [
  'livro',
  'ebook',
  'e-book',
  'audiolivro',
  'revista',
  'apostila',
  'enciclopedia',
  'dicionario',
  'manga',
  'quadrinho',
  'hq '
];

const BOARD_GAME_TERMS = ['jogo de tabuleiro', 'board game', 'cartas colecionaveis', 'card game'];

const LEGACY_CATEGORY_MAP = {
  tecnologia: ['notebooks', 'desktops'],
  informatica: ['mice', 'keyboards', 'ssds', 'monitors', 'peripherals'],
  games: ['gpus', 'headsets', 'gamer-accessories'],
  eletronicos: ['tvs', 'audio-systems', 'electronic-accessories'],
  casa: ['air-fryers', 'vacuums', 'coffee-makers', 'blenders']
};

export function taxonomyById(id) {
  return TAXONOMY.find((item) => item.id === id) || null;
}

export function familyOf(id) {
  return taxonomyById(id)?.family || PRODUCT_FAMILIES.UNKNOWN;
}

export function legacyIdsForTaxonomy(taxonomyId) {
  const matches = [];
  for (const [legacy, ids] of Object.entries(LEGACY_CATEGORY_MAP)) {
    if (ids.includes(taxonomyId)) matches.push(legacy);
  }
  if (!matches.length) {
    const family = familyOf(taxonomyId);
    if (family === PRODUCT_FAMILIES.COMPUTERS) return ['informatica', 'tecnologia', 'games'];
    if (family === PRODUCT_FAMILIES.APPLIANCES) return ['casa'];
    if (family === PRODUCT_FAMILIES.ELECTRONICS) return ['eletronicos'];
  }
  return matches;
}

export function offerHaystack(offer) {
  return haystackOf([
    offer?.name,
    offer?.title,
    offer?.brand,
    offer?.model,
    offer?.category,
    offer?.storeCategory,
    offer?.description,
    Array.isArray(offer?.specs) ? offer.specs.join(' ') : offer?.specs
  ]);
}

export function isIneligiblePublication(offer) {
  const haystack = offerHaystack(offer);
  return INELIGIBLE_TERMS.some((term) => includesPhrase(haystack, term) || haystack.includes(normalizeText(term)));
}

export function isBoardGame(offer) {
  const haystack = offerHaystack(offer);
  return BOARD_GAME_TERMS.some((term) => haystack.includes(normalizeText(term)));
}

export { LEGACY_CATEGORY_MAP };
