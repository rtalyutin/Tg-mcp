// Driver messages and stacks can contain credentials or a complete connection URL.
// Only protocol codes and fixed classifications may reach the startup log.
const transportCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION',
  'ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR',
]);
const messageCodes = new Map([
  ['Connection terminated due to connection timeout', 'DB_CONNECTION_TIMEOUT'],
  ['The server does not support SSL connections', 'DB_SSL_UNSUPPORTED'],
  ['SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string', 'DB_PASSWORD_MISSING'],
]);

// Inspect data properties without evaluating getters or serializing an error.
function dataProperty(value: object, key: string): unknown {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; }
  catch { return undefined; }
}

export function safeStartupCode(error: unknown): string {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  let fallback = 'STARTUP_UNKNOWN';
  // Bound traversal, including cyclic causes and Node's aggregated socket errors.
  while (pending.length && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    const code = dataProperty(current, 'code');
    if (typeof code === 'string' && (/^[A-Z0-9]{5}$/.test(code) || transportCodes.has(code))) {
      return ` code=${code}`;
    }
    const message = dataProperty(current, 'message');
    if (typeof message === 'string') fallback = messageCodes.get(message) ?? fallback;
    pending.push(dataProperty(current, 'cause'));
    const errors = dataProperty(current, 'errors');
    try {
      if (Array.isArray(errors)) {
        const length = dataProperty(errors, 'length');
        if (typeof length === 'number') {
          for (let i = 0; i < Math.min(length, 8 - seen.size); i++) pending.push(dataProperty(errors, String(i)));
        }
      }
    } catch { /* A malformed error must not break the startup failure handler. */ }
  }
  return ` code=${fallback}`;
}
