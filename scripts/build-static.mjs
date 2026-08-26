import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRODUCTION_API_ORIGIN = 'https://harumphers-api.adamsfeuer.workers.dev';
const STATIC_ENTRIES = [
  'index.html',
  'directory.html',
  'events.html',
  'manifest.json',
  'sw.js',
  'apple-touch-icon.png',
  'assets',
  'icons'
];

function validatedOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The API origin must be a valid HTTPS origin.');
  }
  if (url.protocol !== 'https:' || url.origin !== url.href.replace(/\/$/, '')) {
    throw new Error('The API origin must be a valid HTTPS origin.');
  }
  return url.origin;
}

export async function buildStatic({ apiOrigin, outputDirectory }) {
  const origin = validatedOrigin(apiOrigin);
  const output = path.resolve(outputDirectory);
  if (output === APP_ROOT || APP_ROOT.startsWith(`${output}${path.sep}`)) {
    throw new Error('The output directory must not contain the source project.');
  }

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const entry of STATIC_ENTRIES) {
    await cp(path.join(APP_ROOT, entry), path.join(output, entry), { recursive: true });
  }

  for (const page of ['index.html', 'directory.html', 'events.html']) {
    const destination = path.join(output, page);
    const source = await readFile(destination, 'utf8');
    if (!source.includes(`data-api-origin="${PRODUCTION_API_ORIGIN}"`)) {
      throw new Error(`${page} does not contain the expected production API origin.`);
    }
    await writeFile(destination, source.replaceAll(PRODUCTION_API_ORIGIN, origin));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argumentsByName = Object.fromEntries(process.argv.slice(2).map(value => {
    const separator = value.indexOf('=');
    return separator > 2 ? [value.slice(2, separator), value.slice(separator + 1)] : [value, ''];
  }));
  try {
    await buildStatic({
      apiOrigin: argumentsByName['api-origin'],
      outputDirectory: argumentsByName['out-dir']
    });
    process.stdout.write(`Built Harumphers static site in ${path.resolve(argumentsByName['out-dir'])}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
