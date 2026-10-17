const path = require('path');
const YAML = require('yamljs');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.yaml');

/**
 * Loads docs/openapi.yaml once at startup.
 *
 * @returns {object} Parsed spec
 * @throws {Error} When docs/openapi.yaml is missing or not parseable
 */
function loadOpenApiSpec() {
  return YAML.load(OPENAPI_PATH);
}

/**
 * Returns a copy of the spec whose "servers" list starts with the base URL the
 * request came in through (see utils/baseUrl.js), so the Swagger UI ("Try it out")
 * and the served spec point at the URL the client actually used.
 *
 * @param {object} document - Spec from loadOpenApiSpec()
 * @param {string} baseUrl - Base URL of the current request
 * @returns {object} Spec with replaced servers list
 */
function specForBaseUrl(document, baseUrl) {
  return { ...document, servers: resolveServers(document.servers, baseUrl) };
}

/**
 * Serializes a spec with a generous inline depth so the output stays block-style YAML.
 *
 * @param {object} document - Spec to serialize
 * @returns {string} YAML text
 */
function toYaml(document) {
  return YAML.stringify(document, 20, 2);
}

/**
 * Builds the servers list: the request's base URL becomes the first entry, the
 * file's remaining entries follow. If the file already documents that URL (e.g.
 * the local development server), its description is kept — only the order changes.
 *
 * @param {Array<{url: string, description?: string}>|undefined} fileServers - servers from the YAML file
 * @param {string} baseUrl - Base URL of the current request
 * @returns {Array<{url: string, description: string}>} Replacement list
 */
function resolveServers(fileServers, baseUrl) {
  const current = String(baseUrl || '').replace(/\/+$/, '');

  const servers = (Array.isArray(fileServers) ? fileServers : []).filter(
    server => server && server.url
  );
  if (!current) return servers;

  const isCurrent = server => server.url.replace(/\/+$/, '') === current;
  const documented = servers.find(isCurrent);

  return [
    documented || { url: current, description: 'Current server' },
    ...servers.filter(server => !isCurrent(server)),
  ];
}

module.exports = { loadOpenApiSpec, specForBaseUrl, toYaml, OPENAPI_PATH };
