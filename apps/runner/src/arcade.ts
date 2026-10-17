import { DurableObject } from 'cloudflare:workers';
import { ARCADE_PROMPT_VERSION, arcadeDecisionInstructions, getArcadeGame, SNAKE_HARNESS_PROTOCOL, snakeHarnessVersion, snakeHarnessInstructions, snakeHarnessPosition, rememberSnakeObservation } from '@decision-arena/games';
import type { SnakePreviousObservation, SnakeVisibleObservation } from '@decision-arena/games';
import { decide, decryptSecret } from '@decision-arena/providers';
import { assertBambooNodeAccess, assertBambooNodeKey } from './bamboonode';
import { ARCADE_GAME_IDS, ARCADE_MAX_CALLS, ARCADE_MAX_TICKS, ARCADE_MIN_REQUEST_MS, ARCADE_TICK_RATE, publicProfile } from '@decision-arena/core';
import type { ArcadeAction, ArcadeClientMessage, ArcadeCommand, ArcadeEvent, ArcadeInput, ArcadeReplayV2, ArcadeResult, ArcadeRunSnapshot, ArcadeSession, ArcadeState, ArcadeStatus, CreateArcadeInput, DecisionResponse, PublicSeatConfig, SeatConfig, SnakeHarnessVersion } from '@decision-arena/core';
import type { Env } from './index';
import { canObserveAfterInput, canSendObservedDecision } from './arcade-scheduling';

const BATCH_MS = 50, BROADCAST_MS = 100, WATCHDOG_MS = 5000, STALL_MS = 250;
const LEASE_RENEW_MS = 30000, LEASE_SAFE_MS = 150000, MAX_EVENTS = 12000;
const LEGACY_PROMPT_VERSION = 'decision-arena-arcade-v1';
const BUTTONS = new Set(['up', 'down', 'left', 'right', 'rotate-cw', 'rotate-ccw', 'soft-drop', 'hard-drop', 'hold', 'jump']);
type Inflight = { requestId: string; generation: number; observedTick: number; startedAt: number; pieceId?: number; promptVersion?: string; snakeHarnessVersion?: SnakeHarnessVersion };
type Control = { session: string; clientSeq: number; lastSeen: number; released: boolean; acks: Record<string, number> };
interface Run {
  id: string; controller: SeatConfig; state: ArcadeState; calls: number; lastRequestedAt: number;
  inflight?: Inflight; control?: Control; lastDecision?: ArcadeRunSnapshot['lastDecision'];
  observeAfterTick?: number;
  // A small visible-state checkpoint, never RNG or raw provider payload. Needed only by C.
  snakePreviousObservation?: SnakePreviousObservation;
}
interface RecordState {
  schemaVersion: 2; id: string; ownerId: string; input: CreateArcadeInput; seed: string; rulesVersion: string;
  promptVersion?: string;
  status: ArcadeStatus; version: number; generation: number; tick: number; runs: Run[]; eventSeq: number;
  createdAt: number; updatedAt: number; finishedAt?: number; result?: ArcadeResult; error?: string;
  anchorWall: number; anchorTick: number; lastBatchWall: number; needsRetry: boolean;
  leaseId?: string; leaseRenewedAt: number; needsSync: boolean; lastSyncedAt: number; syncFailures: number;
}
type Attachment = { cursor: number; runId?: string; controllerSession?: string };
const json = (value: unknown, status = 200) => Response.json(value, { status });
// Real-time controls have a fixed execution policy; saved profiles remain reusable elsewhere.
const realtimeProfile = (profile: NonNullable<SeatConfig['profile']>) => ({ ...profile, thinkMode: 'never' as const });
const publicController = (controller: SeatConfig, effectivePolicy = false): PublicSeatConfig => ({ kind: controller.kind,
  ...(controller.profile ? { profile: publicProfile(effectivePolicy ? realtimeProfile(controller.profile) : controller.profile) } : {}) });
const message = (error: unknown) => error instanceof Error ? error.message : 'Arcade operation failed';

/** One session owns one or two independent simulations; model latency never gates the clock. */
export class ArcadeSessionObject extends DurableObject<Env> {
  private rec?: RecordState;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private syncing = false;
  private renewing = false;
  private lastBroadcast = 0;
  private calls = new Map<string, AbortController>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS arcade_meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS arcade_events (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS arcade_frames (tick INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS arcade_operations (id TEXT PRIMARY KEY, signature TEXT NOT NULL)');
      const row = ctx.storage.sql.exec<{ value: string }>('SELECT value FROM arcade_meta WHERE id=1').toArray()[0];
      if (!row) return;
      const stored = JSON.parse(row.value) as RecordState;
      if (stored.schemaVersion !== 2) throw new Error('Unsupported arcade storage version');
      this.rec = stored;
      // There is no reliable shutdown callback. A new instance cannot know whether a paid request completed.
      if (stored.status === 'running' || stored.runs.some(run => run.inflight || run.control)) {
        this.change(r => {
          const wasRunning = r.status === 'running';
          r.generation++;
          for (const run of r.runs) {
            this.releaseButtons(r, run, 'Runtime restarted; buttons released');
            delete run.control;
            if (run.inflight) {
              const pending = run.inflight;
              run.lastDecision = { observedTick: pending.observedTick, outcome: 'unknown' };
              if (run.snakePreviousObservation?.tick === pending.observedTick) run.snakePreviousObservation.outcome = 'unknown';
              this.event(r, 'decision', { runId: run.id, requestId: pending.requestId, observedTick: pending.observedTick, promptVersion: pending.promptVersion ?? LEGACY_PROMPT_VERSION, ...(pending.snakeHarnessVersion ? { snakeHarnessVersion: pending.snakeHarnessVersion } : {}), outcome: 'unknown', message: 'Runtime restarted; billing status is unknown. Retry explicitly.' });
              delete run.inflight;
              r.needsRetry = true;
            }
          }
          if (wasRunning) r.status = 'paused';
          if (r.status !== 'finished') r.error = r.needsRetry ? 'A previous model request was interrupted; retry explicitly. Its billing status is unknown.' : 'Runtime restarted. Resume explicitly from the last saved tick.';
          this.event(r, 'status', { message: r.status === 'finished' ? 'Late requests interrupted after completion' : r.error });
          this.frame(r);
        });
      }
      // Preserve the durable watchdog rather than overwriting an alarm currently waking this instance.
      if (await ctx.storage.getAlarm() === null && this.rec.needsSync) await ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    });
  }

  private require(owner: string) {
    if (!this.rec || this.rec.ownerId !== owner) throw new Error('Arcade session not found');
    return this.rec;
  }
  private change(mutator: (next: RecordState) => void, bump = true) {
    const next = structuredClone(this.rec!);
    this.ctx.storage.transactionSync(() => {
      mutator(next);
      if (bump) { next.version++; next.updatedAt = Date.now(); next.needsSync = true; }
      this.ctx.storage.sql.exec('INSERT INTO arcade_meta(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', JSON.stringify(next));
    });
    this.rec = next;
  }
  private event(r: RecordState, type: ArcadeEvent['type'], data: Partial<ArcadeEvent> = {}) {
    const event: ArcadeEvent = { ...data, seq: ++r.eventSeq, tick: r.tick, at: Date.now(), type };
    this.ctx.storage.sql.exec('INSERT INTO arcade_events(seq,value) VALUES(?,?)', event.seq, JSON.stringify(event));
  }
  private frame(r: RecordState) {
    const adapter = getArcadeGame(r.input.gameId);
    this.ctx.storage.sql.exec('INSERT INTO arcade_frames(tick,value) VALUES(?,?) ON CONFLICT(tick) DO NOTHING', r.tick, JSON.stringify({ tick: r.tick, views: r.runs.map(run => adapter.view(run.state)) }));
  }
  private releaseButtons(r: RecordState, run: Run, reason: string) {
    if (run.state.status !== 'playing') return;
    this.frame(r);
    run.state = getArcadeGame(r.input.gameId).release(run.state);
    if (run.controller.kind === 'ai') run.observeAfterTick = r.tick + 1;
    if (r.tick < ARCADE_MAX_TICKS) this.event(r, 'input', { runId: run.id, input: { buttons: [] }, release: true, appliedTick: r.tick + 1, message: reason });
  }
  private events(since?: number): ArcadeEvent[] {
    return since === undefined
      ? this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM (SELECT seq,value FROM arcade_events ORDER BY seq DESC LIMIT 100) ORDER BY seq').toArray().map(row => JSON.parse(row.value))
      : this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM arcade_events WHERE seq>? ORDER BY seq LIMIT 100', since).toArray().map(row => JSON.parse(row.value));
  }
  private snapshot(since?: number): ArcadeSession {
    const r = this.rec!, adapter = getArcadeGame(r.input.gameId);
    return {
      id: r.id, engineKind: 'arcade', schemaVersion: 2, gameId: r.input.gameId, mode: r.input.mode,
      config: r.input.config, seed: r.seed, rulesVersion: r.rulesVersion, status: r.status, version: r.version, tick: r.tick,
      runs: r.runs.map(run => ({ id: run.id, controller: publicController(run.controller, r.status !== 'finished'), view: adapter.view(run.state), calls: run.calls,
        ...(run.controller.kind === 'human' ? { predictionState: structuredClone(run.state) } : {}),
        ...(run.inflight ? { inflight: { requestId: run.inflight.requestId, observedTick: run.inflight.observedTick, startedAt: run.inflight.startedAt } } : {}),
        ...(run.lastDecision ? { lastDecision: run.lastDecision } : {}) })),
      events: this.events(since), needsRetry: r.needsRetry, ...(r.result ? { result: r.result } : {}), ...(r.error ? { error: r.error } : {}),
      limits: { maxTicks: ARCADE_MAX_TICKS, maxCallsPerRun: ARCADE_MAX_CALLS, minRequestIntervalMs: ARCADE_MIN_REQUEST_MS },
      createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
  }
  private broadcast(force = false) {
    if (!this.rec || (!force && Date.now() - this.lastBroadcast < BROADCAST_MS)) return;
    this.lastBroadcast = Date.now();
    for (const socket of this.ctx.getWebSockets()) {
      try {
        const attachment = socket.deserializeAttachment() as Attachment;
        const snapshot = this.snapshot(attachment.cursor);
        socket.send(JSON.stringify({ type: 'snapshot', snapshot }));
        if (snapshot.events.length) attachment.cursor = snapshot.events.at(-1)!.seq;
        socket.serializeAttachment(attachment);
      } catch { try { socket.close(1011, 'Connection expired'); } catch {} }
    }
  }
  private quota() { return this.env.USER_QUOTAS.getByName(this.rec!.ownerId); }
  private stopTimer() { if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined; }
  private ensureTimer() {
    if (this.timer !== undefined || this.pumping || this.rec?.status !== 'running') return;
    const delay = Math.max(1, BATCH_MS - (Date.now() - this.rec.lastBatchWall));
    this.timer = setTimeout(() => { this.timer = undefined; this.ctx.waitUntil(this.pump()); }, delay);
  }
  private async scheduleAlarm() {
    const r = this.rec;
    if (!r) return;
    if (r.status === 'running' || r.needsSync || r.leaseId || r.runs.some(run => run.inflight)) {
      const existing = await this.ctx.storage.getAlarm();
      const due = Date.now() + WATCHDOG_MS;
      if (existing === null || existing > due) await this.ctx.storage.setAlarm(due);
    } else await this.ctx.storage.deleteAlarm();
  }
  private rotateControllers(previous: Map<string, string>) {
    const r = this.rec!;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      const run = r.runs.find(entry => entry.id === attachment.runId);
      if (!run?.control || attachment.controllerSession !== previous.get(run.id)) continue;
      attachment.controllerSession = run.control.session;
      socket.serializeAttachment(attachment);
      try { socket.send(JSON.stringify({ type: 'controller', runId: run.id, controllerSession: run.control.session })); } catch {}
    }
  }
  private pause(reason: string, needsRetry = false) {
    if (!this.rec || this.rec.status === 'finished') return;
    this.stopTimer();
    const previous = new Map(this.rec.runs.filter(run => run.control).map(run => [run.id, run.control!.session]));
    this.change(r => {
      r.status = 'paused'; r.generation++; r.error = reason; r.needsRetry ||= needsRetry;
      for (const run of r.runs) {
        this.releaseButtons(r, run, 'Session paused; buttons released');
        if (run.control) { run.control.session = crypto.randomUUID(); run.control.clientSeq = -1; run.control.released = true; run.control.acks = {}; }
      }
      this.event(r, needsRetry ? 'error' : 'status', { message: reason }); this.frame(r);
    });
    this.rotateControllers(previous);
  }
  private finish(r: RecordState, aborted: boolean) {
    const adapter = getArcadeGame(r.input.gameId), scores = r.runs.map(run => run.state.score);
    const comparison = scores.length === 2 ? adapter.compare(scores[0], scores[1]) : 0;
    r.status = 'finished'; r.generation++; r.finishedAt = Date.now(); delete r.error;
    r.result = { winner: aborted || scores.length === 1 || comparison === 0 ? null : comparison > 0 ? 0 : 1,
      reason: aborted ? 'ended_by_user' : r.tick >= ARCADE_MAX_TICKS ? 'time_limit' : 'runs_finished', scores, aborted };
    for (const run of r.runs) { run.state = adapter.release(run.state); delete run.control; }
    this.event(r, 'ended', { message: r.result.reason }); this.frame(r);
  }
  /** Advance old controls to the receive time before accepting a new input. No I/O or model dispatch. */
  private advanceToNow(now = Date.now()) {
      const current = this.rec;
      if (!current || current.status !== 'running') return;
      if (now - current.lastBatchWall > STALL_MS || now < current.lastBatchWall) {
        this.pause('Simulation timing was interrupted. Resume explicitly; offline time was not simulated.');
      } else if (current.leaseId && now - current.leaseRenewedAt >= LEASE_SAFE_MS) {
        this.pause('The account execution lease expired. Resume explicitly.');
      } else if (current.runs.some(run => run.controller.kind === 'human' && run.state.status === 'playing' && (!run.control || now - run.control.lastSeen >= 2000))) {
        this.pause('The human controller disconnected. Reconnect and resume.');
      } else if (current.eventSeq >= MAX_EVENTS) {
        this.pause('The session event budget was reached. End this session or create another.');
      } else {
        const target = Math.min(ARCADE_MAX_TICKS, current.anchorTick + Math.floor((now - current.anchorWall) * ARCADE_TICK_RATE / 1000));
        const ticks = Math.max(0, target - current.tick);
        if (ticks) this.change(r => {
          const adapter = getArcadeGame(r.input.gameId), oldTick = r.tick;
          for (const run of r.runs) {
            if (run.control && now - run.control.lastSeen >= 1000 && !run.control.released) {
              this.releaseButtons(r, run, 'Controller heartbeat expired; buttons released'); run.control.released = true;
            }
            if (run.state.status === 'playing') run.state = adapter.step(run.state, ticks);
          }
          r.tick = target; r.lastBatchWall = now;
          if (r.tick >= ARCADE_MAX_TICKS || r.runs.every(run => run.state.status === 'finished')) this.finish(r, false);
          else if (Math.floor(oldTick / ARCADE_TICK_RATE) !== Math.floor(r.tick / ARCADE_TICK_RATE)) this.frame(r);
        });
      }
  }
  private async pump() {
    if (this.pumping || this.rec?.status !== 'running') return;
    this.pumping = true;
    try {
      this.advanceToNow();
      // Explicitly confirm durability before a render frame can leave this object.
      await this.ctx.storage.sync();
      this.broadcast(this.rec.status !== 'running');
      if (this.rec.status === 'running') {
        this.dispatchEligible();
        if (Date.now() - this.rec.leaseRenewedAt >= LEASE_RENEW_MS) this.ctx.waitUntil(this.renewLease());
      } else {
        this.stopTimer();
        this.ctx.waitUntil(this.releaseLeaseIfIdle());
      }
      if (Date.now() - this.rec.lastSyncedAt >= WATCHDOG_MS || this.rec.status !== 'running') this.ctx.waitUntil(this.sync());
    } catch {
      // Engine/storage failures never trigger random controls or a paid retry.
      if (this.rec?.status === 'running') this.pause('Simulation failed. The last saved state was preserved.');
      this.broadcast(true);
    } finally {
      this.pumping = false; this.ensureTimer();
      await this.scheduleAlarm();
    }
  }

  private dispatchEligible() {
    const r = this.rec!;
    if (r.status !== 'running' || r.needsRetry) return;
    for (const run of r.runs) {
      if (run.controller.kind !== 'ai' || run.state.status !== 'playing' || run.inflight || this.calls.has(run.id)) continue;
      if (!canObserveAfterInput(run)) continue;
      if (run.calls >= ARCADE_MAX_CALLS) { this.pause('The model call budget was reached. This is not a loss. End the session or create another.'); break; }
      if (Date.now() - run.lastRequestedAt < ARCADE_MIN_REQUEST_MS) continue;
      this.launch(run.id);
    }
  }
  private launch(runId: string) {
    const current = this.rec!, run = current.runs.find(entry => entry.id === runId)!;
    // Re-read the live record after every async yield. Receiving a response only queues
    // its controls; observations must wait for step() to consume at least one frame.
    if (current.status !== 'running' || current.needsRetry || run.inflight || this.calls.has(runId) || !canObserveAfterInput(run)) return;
    if (!current.leaseId || Date.now() - current.leaseRenewedAt >= LEASE_SAFE_MS) return;
    const adapter = getArcadeGame(current.input.gameId), actions = adapter.candidates(run.state);
    if (!actions.length) { this.pause('The game returned no model input candidates.', true); return; }
    const view = adapter.view(run.state), requestId = crypto.randomUUID(), controller = new AbortController();
    const harness = current.input.gameId === 'snake' ? snakeHarnessVersion(current.input.config.snakeHarnessVersion) : undefined;
    const pending: Inflight = { requestId, generation: current.generation, observedTick: current.tick, startedAt: Date.now(), promptVersion: harness ? SNAKE_HARNESS_PROTOCOL : ARCADE_PROMPT_VERSION, ...(harness ? { snakeHarnessVersion: harness } : {}), ...(view.pieceId === undefined ? {} : { pieceId: view.pieceId }) };
    const visible = adapter.observe(run.state), profile = run.controller.profile!;
    const position = harness ? snakeHarnessPosition(harness, visible, actions, run.snakePreviousObservation) : visible;
    const recentInputs = this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM arcade_events WHERE json_extract(value,'$.runId')=? AND json_extract(value,'$.type')='input' ORDER BY seq DESC LIMIT 20", runId).toArray().reverse().map(row => JSON.parse(row.value) as ArcadeEvent).map(event => ({ tick: event.appliedTick ?? event.tick, input: event.input }));
    this.change(r => { const lane = r.runs.find(entry => entry.id === runId)!; lane.inflight = pending; lane.calls++; lane.lastRequestedAt = pending.startedAt;
      if (harness === 'snake-harness-c-v1') lane.snakePreviousObservation = rememberSnakeObservation(visible as SnakeVisibleObservation);
    });
    this.calls.set(runId, controller);
    this.ctx.waitUntil(this.infer(runId, pending, actions, { game: current.input.gameId, rules: adapter.rules, position, observedTick: pending.observedTick,
      promptVersion: pending.promptVersion, runtime: { tickRate: ARCADE_TICK_RATE, minRequestIntervalMs: ARCADE_MIN_REQUEST_MS, lastResponseMs: run.lastDecision?.metrics?.elapsedMs ?? null }, recentInputs }, profile, controller));
  }
  private async infer(runId: string, pending: Inflight, actions: ArcadeAction[], state: unknown, profile: NonNullable<SeatConfig['profile']>, controller: AbortController) {
    let canceledBeforeSend = false;
    const beforeSend = () => {
      this.advanceToNow();
      const current = this.rec!, lane = current.runs.find(entry => entry.id === runId);
      const live = lane && { status: lane.state.status, requestId: lane.inflight?.requestId, pieceId: getArcadeGame(current.input.gameId).view(lane.state).pieceId };
      if (!canSendObservedDecision(current, live, pending)) {
        canceledBeforeSend = true;
        throw new Error('Control became stale before model dispatch; no request was sent.');
      }
    };
    try {
      await this.ctx.storage.sync();
      const owner = this.rec!.ownerId;
      const credential = await this.env.DB.prepare('SELECT ciphertext FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(profile.credentialId, owner).first<{ ciphertext: string }>();
      if (!credential) throw new Error('Credential was removed. Create another session with an available model.');
      const key = await decryptSecret(credential.ciphertext, this.env.ARENA_ENCRYPTION_KEY, owner);
      await assertBambooNodeAccess(this.env.DB, owner, profile);
      beforeSend();
      // Reapply even for ready/paused/retry sessions frozen before this policy existed.
      const instructions = pending.snakeHarnessVersion ? snakeHarnessInstructions(pending.snakeHarnessVersion) : arcadeDecisionInstructions(this.rec!.input.gameId);
      const decision = await decide(realtimeProfile(profile), key, { state, actions, instructions }, controller.signal, beforeSend);
      const stillExists = await this.env.DB.prepare('SELECT ciphertext FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(profile.credentialId, owner).first<{ ciphertext: string }>();
      if (!stillExists) throw new Error('Credential was removed during the decision.');
      await assertBambooNodeKey(profile, stillExists.ciphertext, key, this.env.ARENA_ENCRYPTION_KEY, owner);
      await assertBambooNodeAccess(this.env.DB, owner, profile);
      this.settleDecision(runId, pending, decision, actions);
    } catch (error) {
      this.advanceToNow();
      const r = this.rec, run = r?.runs.find(entry => entry.id === runId);
      if (r && run?.inflight?.requestId === pending.requestId) {
        const active = !canceledBeforeSend && r.status === 'running' && r.generation === pending.generation;
        this.change(next => {
          const lane = next.runs.find(entry => entry.id === runId)!;
          lane.lastDecision = { observedTick: pending.observedTick, outcome: active ? 'failed' : 'dropped' }; delete lane.inflight;
          if (lane.snakePreviousObservation?.tick === pending.observedTick) lane.snakePreviousObservation.outcome = active ? 'failed' : 'dropped';
          this.event(next, 'decision', { runId, requestId: pending.requestId, observedTick: pending.observedTick, promptVersion: pending.promptVersion ?? LEGACY_PROMPT_VERSION, ...(pending.snakeHarnessVersion ? { snakeHarnessVersion: pending.snakeHarnessVersion } : {}), outcome: active ? 'failed' : 'dropped', message: canceledBeforeSend ? 'Control became stale before model dispatch; no request was sent.' : active ? message(error) : 'Request settled after its control generation ended' });
        });
        if (active) this.pause(message(error), true);
      }
    } finally {
      if (this.calls.get(runId) === controller) this.calls.delete(runId);
      await this.ctx.storage.sync(); this.broadcast(true);
      await this.releaseLeaseIfIdle();
      await this.scheduleAlarm();
      if (this.rec && (this.rec.status !== 'running' || Date.now() - this.rec.lastSyncedAt >= WATCHDOG_MS)) await this.sync();
    }
  }
  private settleDecision(runId: string, pending: Inflight, decision: DecisionResponse, actions: ArcadeAction[]) {
    this.advanceToNow();
    const r = this.rec!, run = r.runs.find(entry => entry.id === runId)!;
    if (run.inflight?.requestId !== pending.requestId) return;
    const action = actions.find(entry => entry.id === decision.actionId);
    if (!action) throw new Error('The model selected an invalid input.');
    const adapter = getArcadeGame(r.input.gameId), view = adapter.view(run.state);
    const valid = r.status === 'running' && r.generation === pending.generation && run.state.status === 'playing' && (pending.pieceId === undefined || pending.pieceId === view.pieceId) && adapter.candidates(run.state).some(entry => entry.id === action.id);
    this.change(next => {
      const lane = next.runs.find(entry => entry.id === runId)!;
      delete lane.inflight;
      lane.lastDecision = { observedTick: pending.observedTick, ...(valid ? { appliedTick: next.tick + 1 } : {}), outcome: valid ? 'applied' : 'dropped', metrics: decision.metrics, ...(decision.reasoning ? { reasoning: decision.reasoning } : {}) };
      if (lane.snakePreviousObservation?.tick === pending.observedTick) Object.assign(lane.snakePreviousObservation, { actionId: action.id, outcome: valid ? 'applied' : 'dropped', ...(valid ? { appliedTick: next.tick + 1 } : {}) });
      if (valid) {
        this.frame(next);
        lane.state = adapter.input(lane.state, action.input);
        lane.observeAfterTick = next.tick + 1;
      }
      this.event(next, 'decision', { runId, requestId: pending.requestId, observedTick: pending.observedTick, promptVersion: pending.promptVersion ?? LEGACY_PROMPT_VERSION, ...(pending.snakeHarnessVersion ? { snakeHarnessVersion: pending.snakeHarnessVersion } : {}), ...(valid ? { appliedTick: next.tick + 1 } : {}), actionId: action.id, outcome: valid ? 'applied' : 'dropped', metrics: decision.metrics, ...(decision.reasoning ? { reasoning: decision.reasoning } : {}) });
      if (valid) this.event(next, 'input', { runId, requestId: pending.requestId, input: action.input, appliedTick: next.tick + 1 });
      if (valid) this.frame(next);
    });
  }
  private async renewLease() {
    const r = this.rec;
    if (!r?.leaseId || this.renewing || Date.now() - r.leaseRenewedAt < LEASE_RENEW_MS) return;
    const leaseId = r.leaseId; this.renewing = true;
    try {
      const ok = await this.quota().acquire(leaseId);
      if (this.rec?.leaseId !== leaseId) { if (ok) await this.quota().release(leaseId); return; }
      if (ok) this.change(next => { next.leaseRenewedAt = Date.now(); }, false);
      else this.pause('Another AI activity owns this account execution lease.');
    } catch { /* The persisted lease deadline stops physics before an unrenewed lease can expire. */ }
    finally { this.renewing = false; }
  }
  private async releaseLeaseIfIdle() {
    const r = this.rec;
    if (!r?.leaseId || r.status === 'running' || r.runs.some(run => run.inflight) || this.calls.size) return;
    const leaseId = r.leaseId;
    await this.quota().release(leaseId);
    if (this.rec?.leaseId === leaseId && this.rec.status !== 'running') this.change(next => { delete next.leaseId; }, false);
  }
  private replay(): ArcadeReplayV2 {
    const r = this.rec!;
    if (r.status !== 'finished' || !r.result) throw new Error('Replay is available after the session ends');
    if (r.runs.some(run => run.inflight)) throw new Error('Replay is available after the outstanding model requests settle');
    return { version: 2, engineKind: 'arcade', matchId: r.id, gameId: r.input.gameId, mode: r.input.mode, rulesVersion: r.rulesVersion, promptVersion: r.promptVersion ?? LEGACY_PROMPT_VERSION, seed: r.seed, config: r.input.config,
      controllers: r.runs.map(run => publicController(run.controller)), runIds: r.runs.map(run => run.id), result: r.result, createdAt: r.createdAt, finishedAt: r.finishedAt!, maxTicks: ARCADE_MAX_TICKS,
      frames: this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM arcade_frames ORDER BY tick').toArray().map(row => JSON.parse(row.value)),
      events: this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM arcade_events ORDER BY seq').toArray().map(row => JSON.parse(row.value)) };
  }
  private async sync() {
    const r = this.rec;
    if (!r?.needsSync || this.syncing) return;
    this.syncing = true;
    const version = r.version;
    const summary = { engineKind: 'arcade', schemaVersion: 2, version, id: r.id, gameId: r.input.gameId, mode: r.input.mode, status: r.status, tick: r.tick, config: r.input.config,
      controllers: r.runs.map(run => publicController(run.controller)), scores: r.runs.map(run => run.state.score), result: r.result, createdAt: r.createdAt, updatedAt: r.updatedAt };
    const replay = r.status === 'finished' && !r.runs.some(run => run.inflight) ? this.replay() : undefined;
    try {
      await this.env.DB.prepare('INSERT INTO arena_matches(id,owner_id,game_id,status,summary_json,created_at,updated_at,result_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary_json=excluded.summary_json,updated_at=excluded.updated_at,result_json=excluded.result_json WHERE COALESCE(json_extract(arena_matches.summary_json, \'$.version\'), -1) < ?').bind(r.id, r.ownerId, r.input.gameId, r.status, JSON.stringify(summary), r.createdAt, r.updatedAt, r.result ? JSON.stringify(r.result) : null, version).run();
      if (replay) await this.env.REPLAYS.put(`replays/${r.id}.json`, JSON.stringify(replay), { httpMetadata: { contentType: 'application/json' } });
      this.change(next => { next.lastSyncedAt = Date.now(); next.syncFailures = 0; if (next.version === version) next.needsSync = false; }, false);
    } catch { this.change(next => { next.lastSyncedAt = Date.now(); next.syncFailures++; }, false); }
    finally { this.syncing = false; }
  }

  private async create(ownerId: string, id: string, input: CreateArcadeInput) {
    if (this.rec) { this.require(ownerId); throw new Error('Arcade session already exists'); }
    if (!input || !ARCADE_GAME_IDS.includes(input.gameId) || !['practice', 'ai-solo', 'human-ai', 'ai-ai'].includes(input.mode) || !Array.isArray(input.controllers)) throw new Error('Invalid arcade configuration');
    const expected = input.mode === 'practice' || input.mode === 'ai-solo' ? 1 : 2;
    if (input.controllers.length !== expected || input.controllers.some(controller => !controller || !['human', 'ai'].includes(controller.kind))) throw new Error('Invalid arcade controllers');
    if (input.mode === 'human-ai' && input.controllers.filter(controller => controller.kind === 'human').length !== 1) throw new Error('Human versus AI requires exactly one human');
    if (input.mode === 'ai-ai' && input.controllers.some(controller => controller.kind !== 'ai')) throw new Error('AI versus AI requires two models');
    if (input.mode === 'practice' && input.controllers[0].kind !== 'human') throw new Error('Practice requires a human controller');
    if (input.mode === 'ai-solo' && input.controllers[0].kind !== 'ai') throw new Error('Solo AI requires exactly one model');
    if (input.seed !== undefined && (typeof input.seed !== 'string' || input.seed.length < 1 || input.seed.length > 128)) throw new Error('Invalid session seed');
    if (input.config?.level !== undefined && ![1, 2, 3].includes(input.config.level)) throw new Error('Invalid level');
    if (input.gameId !== 'snake' && input.config?.snakeHarnessVersion !== undefined) throw new Error('Snake harness is only available for snake');
    const harness = input.gameId === 'snake' ? snakeHarnessVersion(input.config?.snakeHarnessVersion) : undefined;
    for (const controller of input.controllers) if (controller.kind === 'ai') {
      const profile = controller.profile;
      if (!profile || profile.ownerId !== ownerId) throw new Error('Invalid model owner');
      if (!await this.env.DB.prepare('SELECT id FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(profile.credentialId, ownerId).first()) throw new Error('Credential not found');
      await assertBambooNodeAccess(this.env.DB, ownerId, profile);
    }
    if (this.rec) { this.require(ownerId); throw new Error('Arcade session already exists'); }
    const adapter = getArcadeGame(input.gameId), seed = input.seed ?? crypto.randomUUID(), now = Date.now();
    const safeInput: CreateArcadeInput = { gameId: input.gameId, mode: input.mode, config: { ...(input.config?.level ? { level: input.config.level } : {}), ...(harness ? { snakeHarnessVersion: harness } : {}) }, controllers: input.controllers.map(controller => controller.kind === 'ai' ? { kind: 'ai', profile: realtimeProfile(controller.profile!) } : { kind: 'human' }) };
    this.rec = { schemaVersion: 2, id, ownerId, input: safeInput, seed, rulesVersion: adapter.rulesVersion, promptVersion: harness ? SNAKE_HARNESS_PROTOCOL : ARCADE_PROMPT_VERSION, status: 'ready', version: 0, generation: 0, tick: 0,
      runs: safeInput.controllers.map((controller, index) => ({ id: `run-${index}`, controller, state: adapter.create(safeInput.config, seed), calls: 0, lastRequestedAt: 0 })),
      eventSeq: 0, createdAt: now, updatedAt: now, anchorWall: now, anchorTick: 0, lastBatchWall: now, needsRetry: false,
      leaseRenewedAt: 0, needsSync: true, lastSyncedAt: 0, syncFailures: 0 };
    this.change(r => { this.event(r, 'created'); this.frame(r); });
    await this.sync(); await this.scheduleAlarm();
  }
  private async command(ownerId: string, value: ArcadeCommand) {
    let r = this.require(ownerId);
    if (!value || !['start', 'pause', 'resume', 'retry', 'end'].includes(value.type) || typeof value.operationId !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value.operationId)) throw new Error('A valid operation ID and command are required');
    const signature = JSON.stringify({ type: value.type });
    const old = this.ctx.storage.sql.exec<{ signature: string }>('SELECT signature FROM arcade_operations WHERE id=?', value.operationId).toArray()[0];
    if (old) { if (old.signature !== signature) throw new Error('Operation ID was already used for a different command'); return; }
    if (value.type === 'pause' || value.type === 'end') { this.advanceToNow(); r = this.require(ownerId); }
    if (r.status === 'finished') throw new Error('Arcade session is finished');
    if (value.type !== 'end' && r.eventSeq >= MAX_EVENTS) throw new Error('The session event budget was reached');
    if (value.type !== 'end' && r.rulesVersion !== getArcadeGame(r.input.gameId).rulesVersion) throw new Error('Rules version changed; this session cannot continue');
    let acquired: string | undefined;
    if (['start', 'resume', 'retry'].includes(value.type)) {
      if (r.status === 'running') throw new Error('Arcade session is already running');
      if (r.needsRetry && value.type !== 'retry') throw new Error('Previous model request failed or was interrupted. Retry explicitly.');
      if (r.runs.some(run => run.inflight) || this.calls.size) throw new Error('Previous model requests are still settling');
      if (r.runs.some(run => run.controller.kind === 'ai' && run.calls >= ARCADE_MAX_CALLS)) throw new Error('The model call budget was reached');
      if (r.runs.some(run => run.controller.kind === 'human' && run.state.status === 'playing' && (!run.control || Date.now() - run.control.lastSeen >= 1000))) throw new Error('Connect and claim the human controller before starting');
      if (r.runs.some(run => run.controller.kind === 'ai')) {
        // Recovery may retain our old lease even though no request remains owned by this instance.
        await this.releaseLeaseIfIdle();
        acquired = `arcade:${r.id}:${crypto.randomUUID()}`;
        if (!await this.quota().acquire(acquired)) throw new Error('Another AI activity is running in this account');
        if (this.rec?.version !== r.version || this.rec.status === 'finished') { await this.quota().release(acquired); throw new Error('Session changed; retry the command'); }
      }
    }
    if (value.type === 'pause') this.pause('Paused by user');
    this.change(next => {
      if (value.type === 'end') this.finish(next, true);
      else if (['start', 'resume', 'retry'].includes(value.type)) {
        const now = Date.now(); next.status = 'running'; next.generation++; next.needsRetry = false; delete next.error;
        next.anchorWall = now; next.anchorTick = next.tick; next.lastBatchWall = now;
        if (acquired) { next.leaseId = acquired; next.leaseRenewedAt = now; }
        this.event(next, 'status', { message: value.type });
      }
      this.ctx.storage.sql.exec('INSERT INTO arcade_operations(id,signature) VALUES(?,?)', value.operationId, signature);
    });
    await this.ctx.storage.sync();
    this.broadcast(true); this.ensureTimer();
    if (this.rec!.status === 'finished') this.stopTimer();
    await this.releaseLeaseIfIdle(); await this.scheduleAlarm();
    this.ctx.waitUntil(this.sync());
  }

  private validateInput(input: ArcadeInput): ArcadeInput {
    if (!input || !Array.isArray(input.buttons) || input.buttons.length > 4 || input.buttons.some(button => !BUTTONS.has(button)) || new Set(input.buttons).size !== input.buttons.length) throw new Error('Invalid control buttons');
    if (input.durationMs !== undefined && ![100, 300, 1000].includes(input.durationMs)) throw new Error('Invalid input duration');
    return { buttons: [...input.buttons], ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }) };
  }
  webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    try {
      if (typeof data !== 'string' || data.length > 4096) throw new Error('Invalid control message');
      const value = JSON.parse(data) as ArcadeClientMessage;
      if (value.type === 'input' || value.type === 'claim') this.advanceToNow();
      const r = this.rec!;
      if (r.status === 'finished') throw new Error('Arcade session is finished');
      const attachment = socket.deserializeAttachment() as Attachment;
      if (value.type === 'claim') {
        const run = r.runs.find(entry => entry.id === value.runId);
        if (!run || run.controller.kind !== 'human' || run.state.status !== 'playing') throw new Error('This run is not controlled by an active human');
        if (run.control && attachment.runId === run.id && run.control.session === attachment.controllerSession) {
          socket.send(JSON.stringify({ type: 'controller', runId: run.id, controllerSession: run.control.session })); return;
        }
        if (run.control && Date.now() - run.control.lastSeen < 2000 && run.control.session !== attachment.controllerSession) throw new Error('Another connection is controlling this run');
        if (r.eventSeq >= MAX_EVENTS) throw new Error('The session event budget was reached');
        const session = crypto.randomUUID();
        this.change(next => { const lane = next.runs.find(entry => entry.id === run.id)!; lane.control = { session, lastSeen: Date.now(), clientSeq: -1, released: false, acks: {} }; this.releaseButtons(next, lane, 'Human controller claimed'); this.frame(next); });
        attachment.runId = run.id; attachment.controllerSession = session; socket.serializeAttachment(attachment);
        socket.send(JSON.stringify({ type: 'controller', runId: run.id, controllerSession: session })); return;
      }
      const run = r.runs.find(entry => entry.id === attachment.runId);
      if (!run?.control || run.control.session !== attachment.controllerSession || value.controllerSession !== run.control.session) throw new Error('Controller session expired; claim again');
      if (value.type === 'heartbeat') {
        this.change(next => { next.runs.find(entry => entry.id === run.id)!.control!.lastSeen = Date.now(); }, false); return;
      }
      if (value.type !== 'input' || value.runId !== run.id || !Number.isSafeInteger(value.clientSeq) || value.clientSeq < 0) throw new Error('Invalid input sequence');
      if (run.state.status !== 'playing') throw new Error('This run is finished');
      if (r.status !== 'running') throw new Error('Resume the session before sending input');
      if (value.clientSeq <= run.control.clientSeq) {
        const appliedTick = run.control.acks[String(value.clientSeq)];
        if (appliedTick === undefined) throw new Error('Input sequence expired');
        socket.send(JSON.stringify({ type: 'ack', runId: run.id, clientSeq: value.clientSeq, appliedTick })); return;
      }
      if (r.eventSeq >= MAX_EVENTS) throw new Error('The session event budget was reached');
      const input = this.validateInput(value.input);
      this.change(next => {
        const lane = next.runs.find(entry => entry.id === run.id)!;
        this.frame(next);
        lane.state = getArcadeGame(next.input.gameId).input(lane.state, input);
        lane.control!.clientSeq = value.clientSeq; lane.control!.lastSeen = Date.now(); lane.control!.released = false;
        lane.control!.acks[String(value.clientSeq)] = next.tick + 1;
        const sequenceKeys = Object.keys(lane.control!.acks).sort((a,b) => Number(a)-Number(b));
        for (const key of sequenceKeys.slice(0, Math.max(0, sequenceKeys.length - 64))) delete lane.control!.acks[key];
        this.event(next, 'input', { runId: run.id, input, appliedTick: next.tick + 1 }); this.frame(next);
      });
      socket.send(JSON.stringify({ type: 'ack', runId: run.id, clientSeq: value.clientSeq, appliedTick: this.rec!.tick + 1 }));
    } catch (error) { try { socket.send(JSON.stringify({ type: 'error', message: message(error) })); } catch {} }
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    this.advanceToNow();
    const attachment = socket.deserializeAttachment() as Attachment;
    const run = this.rec?.runs.find(entry => entry.id === attachment.runId);
    if (run && run.control && run.control.session === attachment.controllerSession) this.change(next => {
      const lane = next.runs.find(entry => entry.id === attachment.runId)!;
      lane.control!.lastSeen = Date.now() - 1000; lane.control!.released = true;
      this.releaseButtons(next, lane, 'Controller connection closed');
    });
    try { socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason); } catch {}
  }
  async alarm() {
    if (!this.rec) return;
    if (this.rec.status === 'running' && Date.now() - this.rec.lastBatchWall > STALL_MS) this.pause('The simulation watchdog detected an interruption. Resume explicitly.');
    if (this.rec.status === 'running') { this.ensureTimer(); await this.renewLease(); }
    else await this.releaseLeaseIfIdle();
    await this.sync(); await this.scheduleAlarm(); this.broadcast(true);
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const owner = request.headers.get('X-Arena-Owner'); if (!owner) return json({ error: 'Unauthorized' }, 401);
      const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
      if (request.method === 'POST' && parts.length === 2) { await this.create(owner, parts[1], await request.json() as CreateArcadeInput); return json(this.snapshot(), 201); }
      const r = this.require(owner);
      if (parts[2] === 'socket') {
        if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket required' }, 426);
        const pair = new WebSocketPair(), snapshot = this.snapshot();
        pair[1].serializeAttachment({ cursor: snapshot.events.at(-1)?.seq ?? r.eventSeq } satisfies Attachment); this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({ type: 'snapshot', snapshot })); return new Response(null, { status: 101, webSocket: pair[0] });
      }
      if (parts[2] === 'replay' && request.method === 'GET') return json(this.replay());
      if (parts[2] === 'commands' && request.method === 'POST') await this.command(owner, await request.json() as ArcadeCommand);
      else if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      const since = url.searchParams.has('since') ? Math.max(0, Number(url.searchParams.get('since')) || 0) : undefined;
      return json(this.snapshot(since));
    } catch (error) { const errorMessage = message(error); return json({ error: errorMessage }, errorMessage === 'Arcade session not found' ? 404 : 400); }
  }
}
