import {defineConfig} from 'vitest/config';
import {fileURLToPath} from 'node:url';
export default defineConfig({resolve:{alias:{'@':fileURLToPath(new URL('./apps/web/src',import.meta.url))}},test:{include:['packages/**/*.test.ts','apps/web/tests/**/*.test.ts'],exclude:['**/node_modules/**'],testTimeout:15000,pool:'forks'}});
