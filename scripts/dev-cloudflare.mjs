import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run the production Worker build locally. This never deploys or uses remote bindings.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.ARENA_CF_PORT || 5093);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid ARENA_CF_PORT');
const origin = `http://127.0.0.1:${port}`;
const envFile = resolve(root, 'apps/web/.env.development');
if (!existsSync(envFile)) throw new Error('Run pnpm setup:local first.');
const secrets = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').flatMap(line => {
  const index = line.indexOf('=');
  if (index < 1 || line.trim().startsWith('#')) return [];
  return [[line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]];
}));
for (const name of ['AUTH_SECRET', 'CONFIG_ENCRYPTION_KEY', 'ARENA_ENCRYPTION_KEY']) {
  if (!secrets[name] || secrets[name].length < 32) throw new Error(`Missing ${name}; run pnpm setup:local.`);
}
// Explicitly isolated fixture login for the no-model smoke suite only.
if (process.argv.includes('--local-auth')) secrets.AUTH_MODE = 'local';
const local = resolve(root, '.wrangler/cloudflare-dev');
const state = resolve(local, 'state');
const environment = { ...process.env, VITE_APP_URL: origin, WRANGLER_LOG_PATH: resolve(local, 'logs'), WRANGLER_SEND_METRICS: 'false' };
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: root, env: environment, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!process.argv.includes('--skip-build')) run(['--filter', '@decision-arena/web', 'cf:build']);
const builtFile = resolve(root, 'apps/web/.output/server/wrangler.json');
if (!existsSync(builtFile)) throw new Error('Cloudflare build missing. Run without --skip-build.');
const web = JSON.parse(readFileSync(builtFile, 'utf8'));
const runner = JSON.parse(readFileSync(resolve(root, 'apps/runner/wrangler.jsonc'), 'utf8'));
const webDir = resolve(local, 'web'), runnerDir = resolve(local, 'runner');
mkdirSync(webDir, { recursive: true });
mkdirSync(runnerDir, { recursive: true });
mkdirSync(resolve(local, 'logs'), { recursive: true });
web.name = 'decision-arena-local-web';
web.main = resolve(dirname(builtFile), web.main);
web.assets.directory = resolve(dirname(builtFile), web.assets.directory);
web.vars = { ...web.vars, DATABASE_PROVIDER: 'd1', VITE_APP_URL: origin, AUTH_URL: origin, AUTH_TRUSTED_ORIGINS: origin };
web.services = [{ binding: 'MATCH_SERVICE', service: 'decision-arena-local-runner' }];
runner.name = 'decision-arena-local-runner';
runner.main = resolve(root, 'apps/runner', runner.main);
runner.vars = { ...runner.vars, LOCAL_DEV: 'false' };
for (const config of [web, runner]) {
  config.$schema = resolve(root, 'node_modules/wrangler/config-schema.json');
  for (const database of config.d1_databases || []) database.migrations_dir = resolve(root, 'apps/web/drizzle');
  for (const binding of [...(config.d1_databases || []), ...(config.r2_buckets || [])]) binding.remote = false;
}
const write = (path, content) => writeFileSync(path, content, { mode: 0o600 });
const webConfig = resolve(webDir, 'wrangler.json'), runnerConfig = resolve(runnerDir, 'wrangler.json');
write(webConfig, JSON.stringify(web, null, 2));
write(runnerConfig, JSON.stringify(runner, null, 2));
const webEnvironmentKeys = [
  'AUTH_SECRET', 'CONFIG_ENCRYPTION_KEY', 'ARENA_ENCRYPTION_KEY',
  'AUTH_MODE', 'BAMBOONODE_ISSUER', 'BAMBOONODE_CLIENT_ID',
  'BAMBOONODE_CLIENT_SECRET', 'BAMBOONODE_AUTHORIZATION_URL',
  'BAMBOONODE_TOKEN_URL', 'BAMBOONODE_USERINFO_URL', 'BAMBOONODE_SCOPES',
  'BAMBOONODE_TOKEN_AUTH_METHOD', 'BAMBOONODE_ACCOUNT_URL',
];
write(resolve(webDir, '.dev.vars'), webEnvironmentKeys
  .filter(name => secrets[name] !== undefined)
  .map(name => `${name}=${JSON.stringify(secrets[name])}`).join('\n') + '\n');
write(resolve(runnerDir, '.dev.vars'), `ARENA_ENCRYPTION_KEY=${JSON.stringify(secrets.ARENA_ENCRYPTION_KEY)}\n`);
run(['exec', 'wrangler', 'd1', 'migrations', 'apply', 'decision-arena-db', '--local', '--config', runnerConfig, '--persist-to', state]);
console.log(`Cloudflare local preview: ${origin}/zh (isolated local D1/R2; no deployment)`);
const child = spawn('pnpm', ['exec', 'wrangler', 'dev', '-c', webConfig, '-c', runnerConfig, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', '0', '--persist-to', state], { cwd: root, env: environment, stdio: 'inherit' });
let stopping = false;
function stop() { if (stopping) return; stopping = true; child.kill('SIGTERM'); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', code => process.exit(code ?? 0));
