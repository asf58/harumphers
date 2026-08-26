import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleRequest } from '../../worker/src/index.js';
import { createFixtureAirtable, FIXTURE_LOGIN } from './worker-data.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const API_ORIGIN_PATTERN = /data-api-origin="https:\/\/harumphers-api\.adamsfeuer\.workers\.dev"/g;
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png']
]);

function collectBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function fixtureEnv(origin) {
  return {
    ADMIN_LOGIN: FIXTURE_LOGIN.adminPassword,
    ALLOWED_ORIGINS: origin,
    GUEST_LOGIN: FIXTURE_LOGIN.guestPhrase,
    SESSION_SECRET: 'fixture-session-secret-for-local-model-only',
    DATA_MODE: 'fixtures'
  };
}

async function sendWorkerResponse(nodeResponse, workerResponse) {
  nodeResponse.statusCode = workerResponse.status;
  for (const [name, value] of workerResponse.headers) nodeResponse.setHeader(name, value);
  nodeResponse.end(Buffer.from(await workerResponse.arrayBuffer()));
}

function localPath(pathname) {
  let value = pathname;
  if (value === '/harumphers' || value === '/harumphers/') value = '/index.html';
  else if (value.startsWith('/harumphers/')) value = value.slice('/harumphers'.length);
  if (value === '/') value = '/index.html';

  const resolved = path.resolve(APP_ROOT, `.${value}`);
  return resolved === APP_ROOT || resolved.startsWith(`${APP_ROOT}${path.sep}`) ? resolved : null;
}

async function serveStatic(request, response, origin) {
  const url = new URL(request.url, origin);
  const file = localPath(url.pathname);
  if (!file) {
    response.writeHead(404).end();
    return;
  }

  let details;
  try {
    details = await stat(file);
  } catch {
    response.writeHead(404).end();
    return;
  }
  if (!details.isFile()) {
    response.writeHead(404).end();
    return;
  }

  const extension = path.extname(file).toLowerCase();
  response.setHeader('Content-Type', CONTENT_TYPES.get(extension) ?? 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-store');
  if (extension === '.html') {
    const html = await readFile(file, 'utf8');
    response.end(html.replace(API_ORIGIN_PATTERN, `data-api-origin="${origin}"`));
    return;
  }
  createReadStream(file).pipe(response);
}

export async function createFixtureServer({ host = '127.0.0.1', port = 4173 } = {}) {
  const fixtureAirtable = createFixtureAirtable();
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const body = request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await collectBody(request);
        const workerRequest = new Request(url, {
          method: request.method,
          headers: request.headers,
          body
        });
        const workerResponse = await handleRequest(workerRequest, fixtureEnv(origin), {}, {
          airtable: fixtureAirtable
        });
        await sendWorkerResponse(response, workerResponse);
        return;
      }
      await serveStatic(request, response, origin);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('The local Harumphers model could not complete the request.');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  origin = `http://${host}:${address.port}`;

  return {
    origin,
    close() {
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const portArgument = process.argv.find(value => value.startsWith('--port='));
  const port = portArgument ? Number(portArgument.split('=')[1]) : 4173;
  const model = await createFixtureServer({ port });
  process.stdout.write(`Harumphers fixture model: ${model.origin}\n`);
}
