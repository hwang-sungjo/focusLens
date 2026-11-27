const http = require('node:http');

// Probe each address a browser may use for localhost. Keep the original Host
// header so Vite's host checks and the AI bridge's origin checks still apply.
async function probe(origin, path, headers, matches) {
  const url = new URL(path, origin);
  const addresses = url.hostname === 'localhost'
    ? ['127.0.0.1', '::1']
    : [url.hostname.replace(/^\[|\]$/g, '')];
  if (url.protocol !== 'http:' || addresses.some(ip => !['127.0.0.1', '::1'].includes(ip))) {
    throw new Error('Local stack probes require an HTTP loopback origin.');
  }
  const states = await Promise.all(addresses.map(address => new Promise(resolve => {
    const req = http.get({
      hostname: address,
      port: url.port || 80,
      path: url.pathname,
      headers: { ...headers, Host: url.host },
      agent: false,
      signal: AbortSignal.timeout(2000),
    }, res => {
      let length = 0;
      const chunks = [];
      res.on('data', chunk => {
        length += chunk.length;
        if (length > 128 * 1024) {
          resolve('conflict');
          res.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      res.on('error', () => resolve('conflict'));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve(matches(res, body) ? 'compatible' : 'conflict');
      });
    });
    req.on('error', err => {
      // A refused connection (or a disabled loopback address family) is free.
      // A timeout, protocol error or connection reset can mean an occupied port.
      const unavailable = ['ECONNREFUSED', 'EAFNOSUPPORT', 'EADDRNOTAVAIL', 'ENETUNREACH'];
      resolve(unavailable.includes(err.code) ? 'available' : 'conflict');
    });
  })));
  if (states.includes('conflict')) return 'conflict';
  return states.includes('compatible') ? 'compatible' : 'available';
}

function jsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Each public probe returns "available", "compatible", or "conflict".
function probeFrontend(origin = 'http://localhost:5173') {
  return probe(origin, '/login', {}, (res, body) => res.statusCode === 200
    && /<title>FocusLens<\/title>/i.test(body)
    && body.includes('/@vite/client')
    && body.includes('/src/main.tsx'));
}

function probeBackend(origin = 'http://localhost:3000') {
  return probe(origin, '/health', {}, (res, body) => {
    const health = jsonBody(body);
    return res.statusCode === 200 && health?.success === true && health.data?.status === 'ok'
      && health.data.db === 'connected' && health.data.redis === 'connected';
  });
}

function probeAi(origin = 'http://127.0.0.1:4317', frontendOrigin = 'http://localhost:5173') {
  // With no token, the bridge replies before contacting the API or the camera.
  return probe(origin, '/status', { Origin: frontendOrigin }, (res, body) => {
    const status = jsonBody(body);
    return res.statusCode === 401 && res.headers['access-control-allow-origin'] === frontendOrigin
      && status?.success === false && status.error === 'authentication_required';
  });
}

module.exports = { probeFrontend, probeBackend, probeAi };
