import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { localProductionEnv, productionDir, root } from './local-production-config.mjs';

process.umask(0o077);
const env = localProductionEnv();
const id = process.env.ARENA_LOCAL_RELEASE || readFileSync(resolve(productionDir, 'current'), 'utf8').trim();
if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error('Invalid local production release');
const release = resolve(productionDir, 'releases', id);
const runnerEntry = resolve(release, 'runner/index.js');
const webEntry = resolve(release, 'web/server/index.mjs');
for (const path of [runnerEntry, webEntry]) if (!existsSync(path)) throw new Error('Build the local production release first');
mkdirSync(resolve(productionDir, 'logs'), { recursive: true });
for (const port of [5091, 5092, 5094]) {
  await new Promise((accept, reject) => {
    const server = createServer();
    server.on('error', () => reject(new Error(`Port ${port} is occupied; stop the other Arena server first`)));
    server.listen(port, '127.0.0.1', () => server.close(accept));
  });
}
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already stopped. */ }
  }
  const force = setTimeout(() => {
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    process.exit(code);
  }, 8000);
  Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve() : new Promise(done => child.once('exit', done))))
    .then(() => { clearTimeout(force); process.exit(code); });
}
function start(args, childEnv = env) {
  const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: 'inherit', detached: true });
  children.push(child);
  child.once('error', () => stop(1));
  child.once('exit', code => { if (!stopping) stop(code || 1); });
  return child;
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
start([
  resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'dev', runnerEntry,
  '--no-bundle', '--local', '--ip', '127.0.0.1', '--port', '5092', '--inspector-port', '0',
  '--persist-to', resolve(root, '.wrangler/state'),
  '--config', resolve(root, 'apps/runner/wrangler.jsonc'),
]);
let ready = false;
for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
  try {
    const response = await fetch('http://127.0.0.1:5092/', { signal: AbortSignal.timeout(1000) });
    if (response.status === 401 && (await response.json()).error === 'Internal authentication required') {
      ready = true; break;
    }
  } catch { /* Local runtime is starting. */ }
  await new Promise(done => setTimeout(done, 500));
}
if (!ready) { console.error('Local runner did not become ready'); stop(1); }
else {
  start(['--import', 'tsx', resolve(root, 'apps/web/scripts/serve-local-production.ts')], {
    ...env, ARENA_LOCAL_BUILD_ENTRY: webEntry,
  });
  console.log(`Serving compiled Arena release ${id}; public origin ${env.ARENA_PUBLIC_ORIGIN}`);
}
