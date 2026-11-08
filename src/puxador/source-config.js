export function parsePuxadorSourceChatIds(value = '') {
  return String(value ?? '')
    .split(/[;,\\s]+/)
    .map((item) => item.trim())
    .filter((item) => /^-?\\d+$/.test(item));
}

export function isAllowedPuxadorSource(chatId, allowedIds = []) {
  const id = String(chatId ?? '');
  return /^-?\\d+$/.test(id) && allowedIds.map(String).includes(id);
}
