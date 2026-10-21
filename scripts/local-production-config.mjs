import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const productionDir = resolve(root, 'artifacts/local-production');

// The existing encrypted data must retain the same keys. Never regenerate them here.
export function localProductionEnv() {
  const envFile = resolve(root, process.env.ARENA_LOCAL_ENV_FILE || 'apps/web/.env.development');
  if (!existsSync(envFile)) throw new Error('Local Arena environment file is missing');
  const env = { ...process.env, ...parseEnv(readFileSync(envFile, 'utf8')) };
  const productionOverrides = resolve(root, 'apps/web/.env.production');
  if (!process.env.ARENA_LOCAL_ENV_FILE && existsSync(productionOverrides)) {
    Object.assign(env, parseEnv(readFileSync(productionOverrides, 'utf8')));
  }
  const runner = parseEnv(readFileSync(resolve(root, 'apps/runner/.dev.vars'), 'utf8'));
  for (const key of ['ARENA_ENCRYPTION_KEY', 'ARENA_INTERNAL_SECRET']) {
    if (!env[key] || env[key] !== runner[key]) throw new Error(`Web and runner ${key} must match`);
  }
  for (const key of ['AUTH_SECRET', 'CONFIG_ENCRYPTION_KEY']) {
    if (!env[key] || env[key].length < 24) throw new Error(`${key} must be configured`);
  }
  if (runner.LOCAL_DEV !== 'true') throw new Error('Local runner must explicitly enable LOCAL_DEV');
  if (env.DATABASE_PROVIDER !== 'sqlite' || !env.DATABASE_URL?.startsWith('file:/')) {
    throw new Error('Local production requires the existing absolute SQLite database path');
  }
  if (!existsSync(env.DATABASE_URL.slice(5))) throw new Error('Existing SQLite database is missing; refusing to create an empty database');
  const origin = new URL(env.ARENA_PUBLIC_ORIGIN || '');
  if (origin.protocol !== 'https:' || origin.origin !== env.ARENA_PUBLIC_ORIGIN) {
    throw new Error('ARENA_PUBLIC_ORIGIN must be an exact HTTPS origin');
  }
  return {
    ...env,
    NODE_ENV: 'production',
    ARENA_LOCAL_PRODUCTION: 'true',
    ARENA_RUNNER_URL: 'http://127.0.0.1:5092',
    PORT: '5091',
    HOST: '127.0.0.1',
    WRANGLER_SEND_METRICS: 'false',
    WRANGLER_LOG_PATH: resolve(productionDir, 'logs/wrangler'),
  };
}
