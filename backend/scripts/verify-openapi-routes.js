#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const mounts = [
  ['/api/auth', require('../src/routes/auth')],
  ['/api/sessions', require('../src/routes/sessions')],
  ['/api/reports', require('../src/routes/reports')],
  ['/api/users', require('../src/routes/users')],
  ['/api/connections', require('../src/routes/connections')],
  ['/api/session-shares', require('../src/routes/sessionShares')],
  ['/api/rankings', require('../src/routes/rankings')],
  ['/api/groups', require('../src/routes/groups')],
];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];

const normalizeExpressPath = (base, routePath) => {
  const joined = `${base}/${routePath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
  return joined.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
};

const expressOperations = new Set();
for (const [base, router] of mounts) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routePaths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const routePath of routePaths) {
      for (const method of Object.keys(layer.route.methods).filter((name) => layer.route.methods[name])) {
        expressOperations.add(`${method.toLowerCase()} ${normalizeExpressPath(base, routePath)}`);
      }
    }
  }
}

const documentPath = path.resolve(__dirname, '../../docs/swagger.yaml');
const document = YAML.parse(fs.readFileSync(documentPath, 'utf8'));
if (!String(document.openapi).startsWith('3.')) throw new Error('OpenAPI 3.x 문서가 아닙니다.');

const openApiOperations = new Set();
const operationIds = new Set();
for (const [apiPath, pathItem] of Object.entries(document.paths || {})) {
  for (const method of HTTP_METHODS) {
    const operation = pathItem[method];
    if (!operation) continue;
    const key = `${method} ${apiPath}`;
    openApiOperations.add(key);
    if (!operation.operationId) throw new Error(`${key}: operationId가 없습니다.`);
    if (operationIds.has(operation.operationId)) {
      throw new Error(`${key}: 중복 operationId ${operation.operationId}`);
    }
    operationIds.add(operation.operationId);
    if (!operation.responses || Object.keys(operation.responses).length === 0) {
      throw new Error(`${key}: responses가 없습니다.`);
    }
  }
}

const missingInOpenApi = [...expressOperations].filter((item) => !openApiOperations.has(item)).sort();
const missingInExpress = [...openApiOperations].filter((item) => !expressOperations.has(item)).sort();
if (missingInOpenApi.length || missingInExpress.length) {
  console.error(JSON.stringify({ missingInOpenApi, missingInExpress }, null, 2));
  process.exit(1);
}

console.log(`OpenAPI lint and route comparison passed: ${openApiOperations.size} operations`);
