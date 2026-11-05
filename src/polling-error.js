export function isDuplicatePollingError(error) {
  const status = error?.response?.statusCode ?? error?.response?.body?.error_code;
  if (Number(status) === 409) return true;
  if (Number(error?.code) === 409) return true;
  return /409|terminated by other getUpdates/i.test(String(error?.message || ''));
}
