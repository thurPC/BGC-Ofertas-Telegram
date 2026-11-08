import dns from 'node:dns';

export const DEFAULT_USER_AGENT =
  'BGC-Ofertas/1.0 (Telegram bot; +https://github.com/thurPC/BGC-Ofertas-Telegram)';

export function preferIpv4() {
  try {
    if (typeof dns.setDefaultResultOrder === 'function') {
      dns.setDefaultResultOrder('ipv4first');
    }
  } catch {
  }
}

preferIpv4();

export function describeNetworkError(error) {
  if (!error) return 'erro de rede desconhecido';
  const parts = [];
  const message = String(error.message || '').trim();
  if (message) parts.push(message);
  let cause = error.cause;
  while (cause && parts.length < 6) {
    const code = cause.code || cause.errno;
    const causeMessage = String(cause.message || '').trim();
    if (code && !parts.includes(String(code))) parts.push(String(code));
    if (causeMessage && !parts.includes(causeMessage)) parts.push(causeMessage);
    cause = cause.cause;
  }
  return parts.join(' — ') || 'erro de rede desconhecido';
}

function collectErrorSignals(error) {
  const names = [];
  const messages = [];
  const codes = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current.name) names.push(String(current.name));
    if (current.message) messages.push(String(current.message));
    if (current.code) codes.push(String(current.code));
    if (current.errno) codes.push(String(current.errno));
    current = current.cause;
  }
  return { names, messages: messages.join(' '), codes: codes.join(' ') };
}

export function classifyFetchError(error) {
  const { names, messages, codes } = collectErrorSignals(error);
  if (
    names.some((name) => name === 'AbortError' || name === 'TimeoutError') ||
    /aborted|timeout/i.test(messages) ||
    /TIMEOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/i.test(codes)
  ) {
    return 'timeout';
  }
  if (error instanceof SyntaxError || /json/i.test(messages)) {
    return 'invalid-json';
  }
  return 'network';
}

export function defaultJsonHeaders(extra = {}) {
  return {
    Accept: 'application/json,text/plain;q=0.9,*/*;q=0.8',
    'User-Agent': DEFAULT_USER_AGENT,
    ...extra
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableHttpStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}
