const request = require('supertest');

// Mock DB module BEFORE importing the app
jest.mock('../db/db_APIconnection', () => ({
  ping: jest.fn(),
  query: jest.fn(),
  pool: { connect: jest.fn() },
}));

const { getBaseUrl } = require('../utils/baseUrl');

/**
 * Minimal stand-in for an Express request.
 */
function fakeReq(headers = {}, protocol = 'http') {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { protocol, get: name => lower[name.toLowerCase()] };
}

describe('getBaseUrl', () => {
  const original = process.env.API_BASE_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = original;
  });

  test('uses the request host when it differs from API_BASE_URL', () => {
    process.env.API_BASE_URL = 'https://stacindex.org/api';
    expect(getBaseUrl(fakeReq({ host: 'localhost:3000' }))).toBe('http://localhost:3000');
  });

  test('uses API_BASE_URL (incl. prefix) when the request comes in via its host', () => {
    process.env.API_BASE_URL = 'https://stacindex.org/api';
    const req = fakeReq({ host: 'stacindex.org', 'x-forwarded-proto': 'https' });
    expect(getBaseUrl(req)).toBe('https://stacindex.org/api');
  });

  test('normalizes default ports when matching API_BASE_URL', () => {
    process.env.API_BASE_URL = 'https://stacindex.org/api';
    const req = fakeReq({ 'x-forwarded-host': 'stacindex.org:443', 'x-forwarded-proto': 'https' });
    expect(getBaseUrl(req)).toBe('https://stacindex.org/api');
  });

  test('honours X-Forwarded-Host, -Proto and -Prefix', () => {
    process.env.API_BASE_URL = 'http://localhost:3000';
    const req = fakeReq({
      host: 'api:3000',
      'x-forwarded-host': 'staging.example.org, proxy.internal',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '/stac/',
    });
    expect(getBaseUrl(req)).toBe('https://staging.example.org/stac');
  });

  test('X-Forwarded-Prefix wins over the configured prefix', () => {
    process.env.API_BASE_URL = 'https://stacindex.org/api';
    const req = fakeReq({ host: 'stacindex.org', 'x-forwarded-proto': 'https', 'x-forwarded-prefix': '/v2' });
    expect(getBaseUrl(req)).toBe('https://stacindex.org/v2');
  });

  test('works without API_BASE_URL', () => {
    delete process.env.API_BASE_URL;
    expect(getBaseUrl(fakeReq({ host: 'example.org:8080' }))).toBe('http://example.org:8080');
  });

  test('falls back to API_BASE_URL without a Host header', () => {
    process.env.API_BASE_URL = 'https://stacindex.org/api/';
    expect(getBaseUrl(fakeReq())).toBe('https://stacindex.org/api');
  });
});

describe('response links follow the requested URL', () => {
  const app = require('../app');

  test('landing page links use the request host', async () => {
    const res = await request(app).get('/').set('Host', 'example.org:8080');
    expect(res.status).toBe(200);
    const self = res.body.links.find(l => l.rel === 'self');
    expect(self.href).toBe('http://example.org:8080');
    expect(res.body.links.every(l => l.href.startsWith('http://example.org:8080'))).toBe(true);
  });

  test('OpenAPI servers list starts with the request URL', async () => {
    const res = await request(app)
      .get('/openapi.json')
      .set('X-Forwarded-Host', 'stac.example.org')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-Prefix', '/api');
    expect(res.status).toBe(200);
    expect(res.body.servers[0].url).toBe('https://stac.example.org/api');
  });
});
