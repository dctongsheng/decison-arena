import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import { paraglideVitePlugin } from '@inlang/paraglide-js';
import mdx from '@mdx-js/rollup';
import tailwindcss from '@tailwindcss/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

import { loadEnvFiles } from './src/lib/env';
import { arcadeWebSocketBridge } from './dev/arcade-websocket';
import { publicOriginProxy } from './dev/public-origin';
import { configuredPublicOrigin } from './src/lib/dev-public-origin';

// Populate process.env from .env.local / .env.{NODE_ENV} / .env for the
// dev server and build process (Vite only exposes VITE_* via import.meta.env;
// server code reads secrets from process.env). In production, env comes
// from the actual host/container environment.
loadEnvFiles();

// Cloudflare Workers build (pnpm cf:build / cf:deploy): stub out unused DB
// drivers — mysql2 crashes workerd at module evaluation (node:net,
// node:process requires); postgres.js runs fine under nodejs_compat but is
// dead weight when the backend is D1. Which driver the bundle keeps follows
// wrangler.jsonc `vars.DATABASE_PROVIDER` (the runtime truth on workerd) —
// d1 stubs both, postgresql keeps postgres.js for the Hyperdrive binding.
const isCloudflareBuild = (process.env.NITRO_PRESET || '').includes(
  'cloudflare'
);
const driverStub = new URL('./src/core/db/driver-stub.ts', import.meta.url)
  .pathname;

// Prefer wrangler.jsonc over the build-time env, which can be polluted by
// .env.local (e.g. DATABASE_PROVIDER=sqlite for local dev).
function workersDbProvider(): string {
  try {
    const raw = readFileSync(
      new URL('./wrangler.jsonc', import.meta.url),
      'utf8'
    );
    const m = raw.match(/"DATABASE_PROVIDER"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  } catch {
    // no wrangler.jsonc yet (fresh clone) — fall through
  }
  return process.env.DATABASE_PROVIDER || 'd1';
}

const workersDb = isCloudflareBuild ? workersDbProvider() : '';
const keepPostgres = workersDb === 'postgresql' || workersDb === 'postgres';

// A Tunnel may expose this dev server, but only the explicitly configured host.
// Never use allowedHosts: true: Host validation protects the local workspace.
const publicDevOrigin = configuredPublicOrigin(process.env.ARENA_PUBLIC_ORIGIN);
const publicDevHost = publicDevOrigin ? [new URL(publicDevOrigin).hostname] : [];

export default defineConfig({
  server: {
    port: 3000,
    strictPort: true,
    // Workspace packages and pnpm's shared dependency store live above apps/web.
    fs: {
      allow: [fileURLToPath(new URL('../../', import.meta.url))],
      deny: [
        // Keep Vite defaults and block all local credentials, data and replay artifacts.
        '.env', '.env.*', '*.{crt,pem}', '**/.git/**',
        '**/.dev.vars*', '**/data/**', '**/artifacts/**', '**/.wrangler/**',
        '**/.output/**', '**/.nitro/**',
        '**/*.{db,sqlite,sqlite3}', '**/*.{db,sqlite,sqlite3}-*', '**/*.log',
      ],
    },
    // Cloud sandboxes (e2b) proxy the dev server through a
    // per-sandbox subdomain; without this Vite's host check blocks the
    // preview with "Blocked request. This host is not allowed."
    allowedHosts: ['.e2b.app', ...publicDevHost],
  },
  resolve: {
    tsconfigPaths: true,
    alias: isCloudflareBuild
      ? {
          mysql2: driverStub,
          ...(keepPostgres ? {} : { postgres: driverStub }),
        }
      : {},
  },
  plugins: [
    publicOriginProxy(),
    arcadeWebSocketBridge(),
    // MDX must run before the react plugin so JSX in compiled MDX gets transformed.
    { enforce: 'pre', ...mdx({ providerImportSource: '@mdx-js/react' }) },
    tailwindcss(),
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/paraglide',
      outputStructure: 'message-modules',
      cookieName: 'PARAGLIDE_LOCALE',
      strategy: ['url', 'cookie', 'baseLocale'],
      urlPatterns: [
        // API endpoints are never locale-prefixed.
        {
          pattern: '/api/:path(.*)?',
          localized: [
            ['en', '/api/:path(.*)?'],
            ['zh', '/api/:path(.*)?'],
          ],
        },
        // Bare locale homes match without a trailing-slash redirect.
        {
          pattern: '/',
          localized: [
            ['zh', '/zh'],
            ['en', '/'],
          ],
        },
        // "as-needed" prefix: zh under /zh, en (default) unprefixed.
        {
          pattern: '/:path(.*)?',
          localized: [
            ['zh', '/zh/:path(.*)?'],
            ['en', '/:path(.*)?'],
          ],
        },
      ],
    }),
    tanstackStart({
      srcDirectory: 'src',
    }),
    viteReact(),
    nitro(process.env.NITRO_PRESET === 'node_middleware' ? { serveStatic: true } : {}),
  ],
});
