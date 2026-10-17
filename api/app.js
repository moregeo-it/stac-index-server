require('dotenv').config();
const express = require('express');
const swaggerUi = require('swagger-ui-express');
const path = require('path');
const favicon = require('serve-favicon');

// Import middleware
const { requestIdMiddleware } = require('./middleware/requestId');
const { globalErrorHandler } = require('./middleware/errorHandler');
const { rateLimitMiddleware } = require('./middleware/rateLimit');
const { corsMiddleware } = require('./middleware/cors');
const { requestSizeLimitMiddleware, MAX_BODY_SIZE } = require('./middleware/requestSize');
const { httpLogger } = require('./utils/logger');
const { loadOpenApiSpec, specForBaseUrl, toYaml } = require('./utils/openapi');
const { getBaseUrl } = require('./utils/baseUrl');

// Import routes
const indexRouter = require('./routes/index');
const conformanceRouter = require('./routes/conformance');
const collectionsRouter = require('./routes/collections');
const queryablesRouter = require('./routes/queryables');
const healthRouter = require('./routes/health');

const app = express();

// Request ID middleware (must be first)
app.use(requestIdMiddleware);

// HTTP request/response logging (after request ID)
app.use(httpLogger);

// Favicon middleware
app.use(favicon(path.join(__dirname, 'favicon.ico')));

// Global rate limiting middleware
// Limits each IP to 1000 requests per 15 minutes
app.use(rateLimitMiddleware);

// Request size limiting middleware
// Protects against excessively large requests (URLs, headers, bodies)
app.use(requestSizeLimitMiddleware);

// Middleware
// Body size limits are enforced here (for future POST/PUT support)
app.use(express.json({ limit: MAX_BODY_SIZE }));
app.use(express.urlencoded({ extended: false, limit: MAX_BODY_SIZE }));

// CORS configuration - allow requests from frontend
app.use(corsMiddleware);

// OpenAPI spec + Swagger UI (if openapi.yaml exists) - MUST be before Content-Type middleware
// The spec's "servers" entry is the base URL of each request, so the docs point at
// the URL the client used (see utils/baseUrl.js).
try {
  const openApiDocument = loadOpenApiSpec();
  const requestSpec = req => specForBaseUrl(openApiDocument, getBaseUrl(req));

  // YAML and JSON serialization of the same spec. The media types must match the
  // actual payload — advertising "+json" for YAML makes clients run JSON.parse()
  // on YAML text and fail.
  app.get('/openapi.yaml', (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.oai.openapi;version=3.0');
    res.send(toYaml(requestSpec(req)));
  });

  app.get('/openapi.json', (req, res) => {
    res.setHeader('Content-Type', 'application/vnd.oai.openapi+json;version=3.0');
    res.json(requestSpec(req));
  });

  // req.swaggerDoc makes swagger-ui-express render the per-request spec
  app.use(
    '/api-docs',
    (req, res, next) => {
      req.swaggerDoc = requestSpec(req);
      next();
    },
    swaggerUi.serveFiles(),
    swaggerUi.setup()
  );
} catch (err) {
  console.log('OpenAPI documentation not found. Create docs/openapi.yaml to enable Swagger UI.');
}

// Content-Type header for JSON responses (set AFTER special endpoints)
app.use((req, res, next) => {
  res.setHeader('Content-Type', 'application/json');
  next();
});

// STAC API routes
app.use('/', indexRouter);
app.use('/conformance', conformanceRouter);
app.use('/collections', collectionsRouter);
app.use('/collection-queryables', queryablesRouter);
app.use('/health', healthRouter);

// 404 handler - must be after all routes
app.use((req, res, next) => {
  const error = new Error(`The requested resource '${req.originalUrl}' was not found on this server.`);
  error.status = 404;
  error.code = 'NotFound';
  next(error);
});

// Global error handler - must be last
app.use(globalErrorHandler);

module.exports = app;