/**
 * Resolves the public base URL the API is reachable at.
 *
 * The request headers alone are not reliable in production: behind a reverse
 * proxy or inside Docker, `Host` may be missing the public port or carry an
 * internal hostname. Therefore an explicitly configured `API_BASE_URL`
 * (see api/.env.example) always wins, and the request is only used as a
 * fallback for local/standalone runs.
 *
 * @param {import('express').Request} req - Incoming request
 * @returns {string} Base URL without trailing slash, e.g. "https://atlas.stacindex.org:3000"
 */
function getBaseUrl(req) {
  const configured = (process.env.API_BASE_URL || '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  // Fallback: derive from the request, honouring common proxy headers
  const forwardedProto = firstHeaderValue(req.get('x-forwarded-proto'));
  const forwardedHost = firstHeaderValue(req.get('x-forwarded-host'));

  const protocol = forwardedProto || req.protocol || 'http';
  const host = forwardedHost || req.get('host') || 'localhost';

  return `${protocol}://${host}`.replace(/\/+$/, '');
}

/**
 * Proxy headers may contain a comma-separated list; only the first hop matters.
 *
 * @param {string|undefined} value - Raw header value
 * @returns {string|undefined} First entry, trimmed, or undefined when empty
 */
function firstHeaderValue(value) {
  if (!value) return undefined;
  const first = String(value).split(',')[0].trim();
  return first || undefined;
}

module.exports = { getBaseUrl };
