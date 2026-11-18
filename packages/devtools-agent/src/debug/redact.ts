/**
 * Redaction for debug packs. Same rules as scripts/export-debug-data.js: the configured model
 * key, credential-like JSON keys (and their values wherever they reappear), bearer tokens, URL
 * userinfo and credential-like query parameters.
 */

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string) {
  return /^(apikey|authorization|proxyauthorization|cookie|setcookie|password|passwd|clientsecret|accesstoken|refreshtoken|idtoken|token|secret)$/i.test(
    key.replace(/[-_\s]/g, ''),
  );
}

function parseJSONObject(value: string): object | undefined {
  if (!/^\s*[[{]/.test(value)) return;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return;
  }
}

function collectSecrets(value: unknown, secrets: Set<string>) {
  if (Array.isArray(value)) for (const item of value) collectSecrets(item, secrets);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key) && typeof item === 'string' && item.length >= 4) secrets.add(item);
      collectSecrets(item, secrets);
    }
  else if (typeof value === 'string') {
    const parsed = parseJSONObject(value);
    if (parsed) collectSecrets(parsed, secrets);
  }
}

function redactURLs(text: string) {
  return text.replace(/https?:\/\/[^\s"'<>`]+/g, (candidate) => {
    try {
      const url = new URL(candidate);
      let changed = false;
      if (url.username || url.password) {
        url.username = REDACTED;
        url.password = '';
        changed = true;
      }
      for (const key of [...url.searchParams.keys()])
        if (isSensitiveKey(key)) {
          url.searchParams.set(key, REDACTED);
          changed = true;
        }
      return changed ? url.href : candidate;
    } catch {
      return candidate;
    }
  });
}

export interface Redactor {
  /** Redacts a JSON-compatible value. */
  value<T>(value: T): T;
  /** Redacts free text such as source files and markdown. */
  text(text: string): string;
}

/**
 * Builds a redactor from known secrets plus any credential-like fields found in `sources`, so a
 * key that appears structurally once is also removed from REPL code or logs elsewhere.
 */
export function createRedactor(knownSecrets: string[], sources: unknown[]): Redactor {
  const secrets = new Set(knownSecrets.filter((secret) => secret.length >= 4));
  for (const source of sources) collectSecrets(source, secrets);
  const values = [...secrets].sort((a, b) => b.length - a.length);

  const text = (input: string) => {
    let output = input;
    for (const secret of values) output = output.split(secret).join(REDACTED);
    output = output.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/gi, `Bearer ${REDACTED}`);
    return redactURLs(output);
  };

  const value = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object')
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [
          key,
          isSensitiveKey(key) && item != null && item !== '' ? REDACTED : value(item),
        ]),
      );
    if (typeof input !== 'string') return input;
    // Tool outputs may carry serialized JSON; redact structurally, then re-serialize.
    const parsed = parseJSONObject(input);
    if (parsed) return JSON.stringify(value(parsed));
    return text(input);
  };

  return { value: value as Redactor['value'], text };
}
