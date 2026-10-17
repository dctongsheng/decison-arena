#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, authenticatedApi, createProgress, ExperimentError, localOrigin, makePlan, planHash, report, runBatch, safeModels, validatePlan, validateProgress, verifySnapshot, collectSnapshot, sourceManifest, verifySources } from './snake-harness-experiment-lib.mjs';

const HELP = `Snake harness experiment (existing owner, no new accounts or model keys)

Read-only model inventory (no inference):
  node scripts/snake-harness-experiment.mjs inspect --out artifacts/snake-experiment/models.json

Freeze explicit development/acceptance seeds, model metadata and interleaved schedule:
  node scripts/snake-harness-experiment.mjs plan --metadata artifacts/snake-experiment/models.json \\
    --profile-ids PROFILE_ID_1,PROFILE_ID_2 --development-seeds dev-seed-1 \\
    --acceptance-seeds acceptance-seed-1,acceptance-seed-2 --repeat-seeds acceptance-seed-1 --global-max-requests 1800 \\
    --out artifacts/snake-experiment/plan.json

Live pilot (first development seed, all profiles × A/B/C; explicit opt-in):
  node scripts/snake-harness-experiment.mjs run --plan artifacts/snake-experiment/plan.json --pilot --confirm-live
Live partition (same ledger; completed entries are skipped):
  node scripts/snake-harness-experiment.mjs run --plan artifacts/snake-experiment/plan.json --partition acceptance --confirm-live
Use --seed-file docs/experiments/snake-harness-v1/seeds.json to preserve preregistered
seed lists/repeat indices. Formal plan: --development-seeds none excludes the pilot.
--partition repeat runs only the explicit repeated seeds (separate from acceptance).

Read-only reconciliation after an interruption (NEVER unhalts or retries):
  node scripts/snake-harness-experiment.mjs reconcile --plan artifacts/snake-experiment/plan.json
Offline report:
  node scripts/snake-harness-experiment.mjs report --plan artifacts/snake-experiment/plan.json
Remove a stale local lock only after its process is gone (does not clear unknown/halted entries):
  node scripts/snake-harness-experiment.mjs unlock --plan artifacts/snake-experiment/plan.json --confirm-no-driver

inspect/plan accept --origin http://127.0.0.1:5091. Authenticated commands accept
--auth-file artifacts/local-fixture.json (existing private file containing cookie).
Progress and report are saved beside the plan as *.progress.json / *.report.json,
with restrictive permissions. Do not copy/delete the ledger to retry uncertain runs.
A 300-request reservation is required before EACH start, released only after natural
completion and in-flight settlement. A paused/error/unknown run halts the whole batch.
No automatic start/resume/retry, no raw replay, thought, request, Cookie or key logging.`;
const valueOptions = new Set(['out', 'metadata', 'profile-ids', 'development-seeds', 'acceptance-seeds', 'global-max-requests', 'repeat-seeds', 'seed-file', 'plan', 'partition', 'origin', 'auth-file']);
const boolOptions = new Set(['pilot', 'confirm-live', 'confirm-no-driver']);
function args(argv) {
  const [command, ...rest] = argv; const options = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || Object.hasOwn(options, key)) throw new ExperimentError('INVALID_ARGUMENTS');
    if (boolOptions.has(key)) options[key] = true;
    else if (valueOptions.has(key) && rest[i + 1] && !rest[i + 1].startsWith('--')) options[key] = rest[++i];
    else throw new ExperimentError('INVALID_ARGUMENTS');
  }
  return { command, options };
}
const required = (options, key) => { if (!options[key]) throw new ExperimentError(`MISSING_${key.toUpperCase().replaceAll('-', '_')}`); return options[key]; };
async function readJson(file, code) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { throw new ExperimentError(code); } }
const emit = value => console.log(JSON.stringify(value));
const sibling = (file, suffix) => file.replace(/\.json$/, '') + suffix;
async function lock(filename) {
  try { await atomicJson(filename, { pid: process.pid }, { exclusive: true }); } catch { throw new ExperimentError('DRIVER_LOCK_EXISTS'); }
  return () => fs.unlink(filename);
}
export async function main(argv = process.argv.slice(2)) {
  const { command, options } = args(argv);
  if (!command || ['help', '--help'].includes(command)) { console.log(HELP); return; }
  const origin = localOrigin(options.origin || 'http://127.0.0.1:5091');
  const authFile = options['auth-file'] || 'artifacts/local-fixture.json';
  if (command === 'inspect') {
    const api = await authenticatedApi(origin, authFile);
    const models = safeModels((await api('/models')).items);
    const out = required(options, 'out');
    await atomicJson(out, { schemaVersion: 1, origin, checkedAt: new Date().toISOString(), models });
    emit({ type: 'model-metadata', origin, models }); return;
  }
  if (command === 'plan') {
    const metadata = await readJson(required(options, 'metadata'), 'METADATA_UNAVAILABLE');
    if (metadata.origin !== origin) throw new ExperimentError('METADATA_ORIGIN_MISMATCH');
    const seeds = options['seed-file'] ? await readJson(options['seed-file'], 'SEEDS_UNAVAILABLE') : {};
    const split = value => value ? value.split(',') : [];
    const developmentSeeds = options['development-seeds'] === 'none' ? [] : options['development-seeds'] ? split(options['development-seeds']) : seeds.development ?? [];
    const acceptanceSeeds = options['acceptance-seeds'] ? split(options['acceptance-seeds']) : seeds.acceptance ?? [];
    const repeatSeeds = options['repeat-seeds'] ? split(options['repeat-seeds']) : seeds.repeatSeedIndices?.map(i => acceptanceSeeds[i]) ?? [];
    const plan = makePlan({ origin, models: metadata.models, profileIds: required(options, 'profile-ids').split(','),
      developmentSeeds, acceptanceSeeds, repeatSeeds, sourceManifest: await sourceManifest(), globalMaxRequests: Number(required(options, 'global-max-requests')) });
    await atomicJson(required(options, 'out'), plan, { exclusive: true });
    emit({ type: 'plan-created', experimentId: plan.experimentId, planHash: planHash(plan), entries: plan.schedule.length, pilotEntries: plan.pilotEntryIds.length, globalMaxRequests: plan.limits.globalMaxRequests }); return;
  }
  const planFile = path.resolve(required(options, 'plan'));
  const plan = validatePlan(await readJson(planFile, 'PLAN_UNAVAILABLE'));
  if (options.origin && options.origin !== plan.origin) throw new ExperimentError('PLAN_ORIGIN_MISMATCH');
  const progressFile = sibling(planFile, '.progress.json'), lockFile = sibling(planFile, '.lock.json'), reportFile = sibling(planFile, '.report.json');
  if (command === 'unlock') {
    if (!options['confirm-no-driver']) throw new ExperimentError('CONFIRM_NO_DRIVER_REQUIRED');
    const info = await readJson(lockFile, 'LOCK_UNAVAILABLE');
    if (!Number.isInteger(info.pid) || info.pid < 1) throw new ExperimentError('INVALID_LOCK');
    try { process.kill(info.pid, 0); throw new ExperimentError('DRIVER_PROCESS_STILL_EXISTS'); }
    catch (error) { if (error.code !== 'ESRCH') throw new ExperimentError('DRIVER_PROCESS_STILL_EXISTS'); }
    await fs.unlink(lockFile); emit({ type: 'stale-lock-removed', experimentId: plan.experimentId }); return;
  }
  if (!['run', 'report', 'reconcile'].includes(command)) throw new ExperimentError('INVALID_COMMAND');
  if (command === 'run' && (!options['confirm-live'] || (!options.pilot && !['development', 'acceptance', 'repeat'].includes(options.partition)) || (options.pilot && options.partition))) throw new ExperimentError('CONFIRM_LIVE_AND_SELECTION_REQUIRED');
  // report is offline and doesn't need an authenticated session. The lock is shared
  // by all ledger readers/writers so report never observes an in-progress write.
  const release = await lock(lockFile);
  try {
    let progress;
    try { progress = JSON.parse(await fs.readFile(progressFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT' || command !== 'run') throw new ExperimentError('PROGRESS_UNAVAILABLE'); progress = createProgress(plan); await atomicJson(progressFile, progress, { exclusive: true }); }
    validateProgress(plan, progress);
    const save = () => atomicJson(progressFile, progress);
    if (command === 'run') {
      const abort = new AbortController(); const stop = () => abort.abort();
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      try {
        const { tsImport } = await import('tsx/esm/api');
        const { getArcadeGame } = await tsImport('../packages/games/src/arcade/index.ts', import.meta.url);
        const { summarizeSnakeReplay } = await import('./lib/snake-experiment-report.mjs');
        await runBatch({ plan, progress, api: await authenticatedApi(plan.origin, authFile), save, pilot: Boolean(options.pilot), partition: options.partition, signal: abort.signal, verifySource: () => verifySources(plan), summarizeReplay: replay => summarizeSnakeReplay(replay, { adapter: getArcadeGame('snake') }), emit });
      }
      finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
    } else if (command === 'reconcile') {
      const api = await authenticatedApi(plan.origin, authFile);
      for (const entry of plan.schedule) {
        const row = progress.entries[entry.id];
        if (!row.sessionId || ['pending', 'complete'].includes(row.phase)) continue;
        // Reads existing IDs only. No mutation or resumption, even when a live session
        // naturally finished while the driver was absent. Operator review is required.
        let snapshot;
        do {
          snapshot = await api(`/arcade-sessions/${row.sessionId}?since=${row.cursor}`);
          verifySnapshot(plan, entry, snapshot); collectSnapshot(row, snapshot); await save();
        } while ((snapshot.events?.length ?? 0) >= 100);
      }
      emit({ type: 'reconciled-read-only', halted: progress.halted, automaticResume: false });
    }
    const result = report(plan, progress);
    const { reportPairwise } = await import('./lib/snake-experiment-report.mjs');
    result.statistics = plan.profiles.map(profile => ({ profileId: profile.profileId, ...reportPairwise(result.entries.filter(entry => entry.profileId === profile.profileId && entry.eligibleForScore && entry.partition !== 'development').map(entry => ({ seed: entry.seed, harnessVersion: entry.snakeHarnessVersion, food: entry.score.food, survivedTicks: entry.score.survivedTicks, cohort: entry.cohort, repetition: entry.repetition }))) }));
    await atomicJson(reportFile, result); emit(result);
  } finally { await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(JSON.stringify({ type: 'experiment-failed', code: error instanceof ExperimentError ? error.code : 'LOCAL_IO_OR_DRIVER_ERROR', secretsAndRawErrorsOmitted: true })); process.exitCode = 1; });
}
