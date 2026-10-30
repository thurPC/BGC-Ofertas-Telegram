import dns from 'node:dns/promises';
import { isPrivateHostname, isPrivateIp } from '../link-extractor.js';

export const DEFAULT_TIMEOUT_MS = 12000;
export const MAX_HTML_CHARS = 1_000_000;
export const MAX_REDIRECTS = 5;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

// Cabeçalhos de navegador: necessários porque lojas como o Mercado Livre
// devolvem 403 quando a requisição não declara idioma/agente esperados.
const BROWSER_HEADERS = Object.freeze({
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1'
});

// Estados de resultado. Um erro de fonte nunca vira "produto inexistente".
export const FETCH_STATUS = Object.freeze({
  OK: 'OK',
  SOURCE_BLOCKED: 'SOURCE_BLOCKED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  SOURCE_ERROR: 'SOURCE_ERROR',
  TIMEOUT: 'TIMEOUT',
  UNSAFE_URL: 'UNSAFE_URL',
  BAD_REDIRECT: 'BAD_REDIRECT',
  EMPTY: 'EMPTY',
  NETWORK: 'NETWORK'
});

// Motivos legíveis para exibição ao administrador.
export const REASON_TEXT = Object.freeze({
  [FETCH_STATUS.SOURCE_BLOCKED]: 'A loja bloqueou o acesso automático (HTTP 403).',
  [FETCH_STATUS.NOT_FOUND]: 'A página ou o produto não foi encontrado (HTTP 404).',
  [FETCH_STATUS.RATE_LIMITED]: 'A loja limitou as requisições (HTTP 429). Tente novamente em instantes.',
  [FETCH_STATUS.SOURCE_ERROR]: 'A loja apresentou indisponibilidade temporária.',
  [FETCH_STATUS.TIMEOUT]: 'A consulta excedeu o tempo permitido.',
  [FETCH_STATUS.UNSAFE_URL]: 'O destino do link não é permitido por segurança.',
  [FETCH_STATUS.BAD_REDIRECT]: 'O redirecionamento do link é inválido.',
  [FETCH_STATUS.EMPTY]: 'A página retornou conteúdo vazio.',
  [FETCH_STATUS.NETWORK]: 'Falha de rede ao consultar a página.'
});

export function classifyHttpStatus(status) {
  const code = Number(status);
  if (code >= 200 && code < 300) return FETCH_STATUS.OK;
  if (code === 403 || code === 401 || code === 451) return FETCH_STATUS.SOURCE_BLOCKED;
  if (code === 404 || code === 410) return FETCH_STATUS.NOT_FOUND;
  if (code === 429) return FETCH_STATUS.RATE_LIMITED;
  if (code >= 500) return FETCH_STATUS.SOURCE_ERROR;
  return FETCH_STATUS.SOURCE_ERROR;
}

export function isRetryable(status) {
  return RETRYABLE_STATUS.has(Number(status));
}

export function headerValue(response, name) {
  const headers = response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function defaultLookup(host, options) {
  return dns.lookup(host, options);
}

export async function assertPublicHttpUrl(url, { lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { ok: false, error: 'URL inválida.', status: FETCH_STATUS.UNSAFE_URL };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, error: 'Somente URLs http ou https são aceitas.', status: FETCH_STATUS.UNSAFE_URL };
  }
  const host = parsed.hostname;
  if (isPrivateHostname(host)) {
    return { ok: false, error: 'Endereço interno não é permitido.', status: FETCH_STATUS.UNSAFE_URL };
  }
  const bare = host.replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(':')) {
    if (isPrivateIp(bare)) return { ok: false, error: 'Endereço interno não é permitido.', status: FETCH_STATUS.UNSAFE_URL };
    return { ok: true, value: parsed.toString() };
  }
  const resolver = typeof lookup === 'function' ? lookup : defaultLookup;
  let addresses;
  try {
    addresses = await resolver(host, { all: true });
  } catch {
    return { ok: false, error: 'Não foi possível resolver o endereço do link.', status: FETCH_STATUS.NETWORK };
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) return { ok: false, error: 'Endereço não resolvido.', status: FETCH_STATUS.NETWORK };
  if (list.some((entry) => isPrivateIp(entry?.address))) {
    return { ok: false, error: 'Endereço interno não é permitido.', status: FETCH_STATUS.UNSAFE_URL };
  }
  return { ok: true, value: parsed.toString() };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Busca uma URL seguindo redirecionamentos manualmente, validando cada destino,
// limitando tamanho/tempo e aplicando backoff apenas em erros temporários.
export async function httpGet(rawUrl, options = {}) {
  const fetcher = options.fetchImpl || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  if (typeof fetcher !== 'function') {
    return { ok: false, status: FETCH_STATUS.NETWORK, error: 'Cliente HTTP indisponível.' };
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : MAX_REDIRECTS;
  const maxChars = Number.isInteger(options.maxChars) ? options.maxChars : MAX_HTML_CHARS;
  const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };

  let current = String(rawUrl);
  let lastStatus = null;
  let lastReason = null;

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const safety = await assertPublicHttpUrl(current, { lookup: options.lookup });
    if (!safety.ok) {
      return { ok: false, status: safety.status, error: safety.error, finalUrl: current };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetcher(current, { redirect: 'manual', signal: controller.signal, headers });
    } catch (error) {
      clearTimeout(timer);
      const aborted = error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || ''));
      return {
        ok: false,
        status: aborted ? FETCH_STATUS.TIMEOUT : FETCH_STATUS.NETWORK,
        error: aborted ? REASON_TEXT[FETCH_STATUS.TIMEOUT] : REASON_TEXT[FETCH_STATUS.NETWORK],
        finalUrl: current
      };
    } finally {
      clearTimeout(timer);
    }

    const status = response?.status ?? 200;
    if (REDIRECT_STATUS.has(status)) {
      const location = headerValue(response, 'location');
      if (!location) {
        return { ok: false, status: FETCH_STATUS.BAD_REDIRECT, error: 'Redirecionamento sem destino.', finalUrl: current };
      }
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        return { ok: false, status: FETCH_STATUS.BAD_REDIRECT, error: 'Redirecionamento inválido.', finalUrl: current };
      }
      current = next;
      continue;
    }

    const state = classifyHttpStatus(status);
    if (state !== FETCH_STATUS.OK) {
      return {
        ok: false,
        status: state,
        httpStatus: status,
        error: REASON_TEXT[state],
        retryable: isRetryable(status),
        finalUrl: current
      };
    }

    let html;
    try {
      html = await response.text();
    } catch {
      return { ok: false, status: FETCH_STATUS.EMPTY, error: 'Não foi possível ler a página.', finalUrl: current };
    }
    const body = String(html ?? '').slice(0, maxChars);
    if (!body.trim()) {
      return { ok: false, status: FETCH_STATUS.EMPTY, error: REASON_TEXT[FETCH_STATUS.EMPTY], finalUrl: current };
    }
    return { ok: true, status: FETCH_STATUS.OK, html: body, finalUrl: current, httpStatus: status };
  }

  return { ok: false, status: FETCH_STATUS.BAD_REDIRECT, error: 'Muitos redirecionamentos.', finalUrl: current };
}

// Consulta com tentativas limitadas: só repete em erros temporários (429/5xx/timeout).
export async function httpGetWithRetry(url, options = {}) {
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 2;
  const baseDelay = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 400;
  const wait = options.sleepImpl || sleep;
  let result;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await httpGet(url, options);
    if (result.ok) return result;
    const retryable =
      result.retryable === true ||
      result.status === FETCH_STATUS.TIMEOUT ||
      result.status === FETCH_STATUS.NETWORK ||
      result.status === FETCH_STATUS.SOURCE_ERROR ||
      result.status === FETCH_STATUS.RATE_LIMITED;
    if (!retryable || attempt === attempts - 1) return result;
    await wait(baseDelay * 2 ** attempt);
  }
  return result;
}
