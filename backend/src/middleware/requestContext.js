const { randomUUID } = require('crypto');
const { logEvent, recordMetric } = require('../services/observability');

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID_PATH_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?=\/|$)/gi;

const getRequestPath = (req) => (req.originalUrl || req.path || '').split('?')[0];
const normalizeRoute = (path) => path.replace(UUID_PATH_SEGMENT, '/:id');

const requestContext = (req, res, next) => {
  const suppliedRequestId = req.get('x-request-id');
  const requestId = REQUEST_ID_PATTERN.test(suppliedRequestId || '')
    ? suppliedRequestId
    : randomUUID();
  const startedAt = process.hrtime.bigint();

  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const path = getRequestPath(req);
    const route = normalizeRoute(path);
    const fields = {
      request_id: requestId,
      user_id: req.user?.sub ?? null,
      method: req.method,
      path,
      status_code: res.statusCode,
      duration_ms: Math.round(durationMs * 100) / 100,
    };
    recordMetric('http_requests_total', { method: req.method, status: res.statusCode });
    if (res.statusCode === 401) recordMetric('auth_failures_total', { route });
    if (res.statusCode === 403) recordMetric('permission_denials_total', { route });
    if (res.statusCode >= 500) recordMetric('http_server_errors_total', { route });
    logEvent('http_request', fields, res.statusCode >= 500 ? 'error' : 'info');
  });

  next();
};

module.exports = { requestContext, normalizeRoute };
