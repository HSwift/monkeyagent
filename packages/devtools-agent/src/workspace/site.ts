import { getDomain } from 'tldts';

/** Site scope is eTLD+1, independent of scheme, port, path, and subdomain. */
export function siteKey(value: string): string {
  const url = new URL(value || 'about:blank');
  if (url.hostname) {
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    try {
      const domain = globalThis.chrome?.publicSuffix?.getDomain?.(hostname);
      if (domain) return domain;
    } catch {
      // Keep the bundled PSL available when the native API cannot be used.
    }
    return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
  }
  // Hostless browser/file pages have no registrable domain.
  return url.origin !== 'null' ? url.origin : `${url.protocol}${url.pathname}`;
}

export function siteWorkspaceId(value: string): string {
  return `site:${siteKey(value)}`;
}
