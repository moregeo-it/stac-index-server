/**
 * Resolves the public base URL the API was reached at, so every "href" in a
 * response points back at the URL the client actually used — e.g.
 * http://localhost:3000 locally, https://stacindex.org/api in production.
 *
 * Resolution order:
 * 1. Scheme, host and path prefix are taken from the request, honouring the
 *    proxy headers X-Forwarded-Proto, X-Forwarded-Host and X-Forwarded-Prefix.
 * 2. If the request came in via the host of the configured `API_BASE_URL`
 *    (see api/.env.example), that URL is used as-is. This keeps the configured
 *    scheme and path prefix (e.g. "/api") for proxies that strip the prefix
 *    without sending X-Forwarded-Prefix.
 * 3. Without any Host header, `API_BASE_URL` (or http://localhost) is used.
 *
 * @param {import('express').Request} req - Incoming request
 * @returns {string} Base URL without trailing slash, e.g. "https://stacindex.org/api"
 */
function getBaseUrl(req) {
  const configured = trimTrailingSlashes((process.env.API_BASE_URL || '').trim());

  const host = firstHeaderValue(req.get('x-forwarded-host')) || firstHeaderValue(req.get('host'));
  if (!host) {
    return configured || 'http://localhost';
  }

  const protocol = (firstHeaderValue(req.get('x-forwarded-proto')) || req.protocol || 'http').toLowerCase();
  const prefix = normalizePrefix(firstHeaderValue(req.get('x-forwarded-prefix')));

  const configuredUrl = parseUrl(configured);
  if (configuredUrl && !prefix && sameHost(configuredUrl, host, protocol)) {
    return configured;
  }

  return trimTrailingSlashes(`${protocol}://${host}${prefix}`);
}

/**
 * Compares the configured URL's host with the request host. Ports are
 * normalized, so "example.org" and "example.org:443" match over https.
 *
 * @param {URL} configuredUrl - Parsed API_BASE_URL
 * @param {string} requestHost - Host (with optional port) from the request
 * @param {string} requestProtocol - Scheme of the request, e.g. "https"
 * @returns {boolean} True when both refer to the same host and port
 */
function sameHost(configuredUrl, requestHost, requestProtocol) {
  const requestUrl = parseUrl(`${requestProtocol}://${requestHost}`);
  if (!requestUrl) return false;

  const port = url => url.port || (url.protocol === 'https:' ? '443' : '80');
  return configuredUrl.hostname === requestUrl.hostname && port(configuredUrl) === port(requestUrl);
}

/**
 * @param {string} value - URL string
 * @returns {URL|undefined} Parsed URL, or undefined when empty or invalid
 */
function parseUrl(value) {
  if (!value) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * Turns an X-Forwarded-Prefix value into "/prefix" (leading, no trailing slash).
 *
 * @param {string|undefined} value - Raw prefix
 * @returns {string} Normalized prefix, or "" when none
 */
function normalizePrefix(value) {
  const trimmed = trimTrailingSlashes(value || '').replace(/^\/+/, '');
  return trimmed ? `/${trimmed}` : '';
}

function trimTrailingSlashes(value) {
  return value.replace(/\/+$/, '');
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
