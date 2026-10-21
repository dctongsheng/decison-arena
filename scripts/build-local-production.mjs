import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { localProductionEnv, productionDir, root } from './local-production-config.mjs';

process.umask(0o077);
const env = localProductionEnv();
const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${revision}`;
const release = resolve(productionDir, 'releases', id);
execFileSync('pnpm', ['--filter', '@decision-arena/web', 'build'], {
  cwd: root, env: { ...env, NITRO_PRESET: 'node_middleware' }, stdio: 'inherit',
});
execFileSync('pnpm', ['--filter', '@decision-arena/runner', 'build'], { cwd: root, env, stdio: 'inherit' });
const output = resolve(root, 'apps/web/.output');
const metadata = JSON.parse(readFileSync(resolve(output, 'nitro.json'), 'utf8'));
if (!['node-middleware', 'node_middleware'].includes(metadata.preset)) throw new Error('Expected a Node middleware production build');
mkdirSync(release, { recursive: true });
cpSync(output, resolve(release, 'web'), { recursive: true });
cpSync(resolve(root, 'apps/runner/dist'), resolve(release, 'runner'), { recursive: true });
writeFileSync(resolve(release, 'release.json'), JSON.stringify({ id, revision, builtAt: new Date().toISOString(), publicOrigin: env.ARENA_PUBLIC_ORIGIN }, null, 2));
// Publish the pointer only after both compiled artifacts exist. Existing processes
// keep their previous absolute release path until explicitly restarted.
writeFileSync(resolve(productionDir, 'current.tmp'), id + '\n');
renameSync(resolve(productionDir, 'current.tmp'), resolve(productionDir, 'current'));
console.log(`Local production release ready: ${id}`);
