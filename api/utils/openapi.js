const path = require('path');
const YAML = require('yamljs');

const OPENAPI_PATH = path.join(__dirname, '..', 'docs', 'openapi.yaml');

/**
 * Loads docs/openapi.yaml and replaces its "servers" list with the deployment's
 * public base URL, so the Swagger UI ("Try it out") and the served spec point at
 * the host the API is actually reachable at instead of a hardcoded one.
 *
 * The URL comes from API_BASE_URL (see api/.env.example) — the same variable the
 * runtime links use, see utils/baseUrl.js. Without it, the servers list from the
 * YAML file is kept unchanged.
 *
 * @returns {{ document: object, yaml: string }} Parsed spec and its YAML serialization
 * @throws {Error} When docs/openapi.yaml is missing or not parseable
 */
function loadOpenApiSpec() {
  const document = YAML.load(OPENAPI_PATH);

  const servers = resolveServers(document.servers);
  if (servers) {
    document.servers = servers;
  }

  // Serialize with a generous inline depth so the output stays block-style YAML
  return { document, yaml: YAML.stringify(document, 20, 2) };
}

/**
 * Builds the servers list from API_BASE_URL: the configured URL becomes the first
 * entry, the file's remaining entries follow. If the file already documents that
 * URL (e.g. the local development server), its description is kept — only the
 * order changes.
 *
 * @param {Array<{url: string, description?: string}>|undefined} fileServers - servers from the YAML file
 * @returns {Array<{url: string, description: string}>|undefined} Replacement list, or undefined to keep the file's list
 */
function resolveServers(fileServers) {
  const configured = (process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!configured) return undefined;

  const servers = (Array.isArray(fileServers) ? fileServers : []).filter(
    server => server && server.url
  );

  const isConfigured = server => server.url.replace(/\/+$/, '') === configured;
  const documented = servers.find(isConfigured);

  return [
    documented || { url: configured, description: 'Deployment server' },
    ...servers.filter(server => !isConfigured(server)),
  ];
}

module.exports = { loadOpenApiSpec, OPENAPI_PATH };
