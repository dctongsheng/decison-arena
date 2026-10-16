import type { ArcadeReplayV2, ReplayManifest } from '@decision-arena/core';
import { z } from 'zod';

// Publication is an explicit allow-list. Provider payloads, credentials,
// endpoints and thoughts (including typed event.reasoning) never become part
// of a community artifact. Apply this both when publishing and when reading
// old artifacts, regardless of whether the viewer is the author.
const seat = z.union([z.literal(0), z.literal(1)]);
const result = z.object({
  winner: seat.nullable(),
  reason: z.string().max(500),
});
const action = z.object({
  id: z.string(),
  label: z.string(),
  from: z.number().optional(),
  to: z.number().optional(),
});
const piece = z.object({
  id: z.string(),
  seat,
  kind: z.string(),
  label: z.string(),
  hidden: z.boolean().optional(),
});
const gameId = z.enum(['gomoku', 'xiangqi', 'army']);
const view = z.object({
  gameId,
  rows: z.number(),
  cols: z.number(),
  cells: z.array(piece.nullable()),
  turn: seat,
  phase: z.enum(['setup', 'playing', 'finished']),
  ply: z.number(),
  legalActions: z.array(action),
  result: result.optional(),
  ready: z.tuple([z.boolean(), z.boolean()]).optional(),
});
const metrics = z.object({
  elapsedMs: z.number(),
  actualModel: z.string().optional(),
  confidence: z.number().optional(),
  probabilities: z.record(z.string(), z.number()).optional(),
  usage: z.record(z.string(), z.number()).optional(),
  thoughtUsed: z.boolean().optional(),
});
const publicSeat = z.object({
  kind: z.enum(['human', 'ai']),
  profile: z
    .object({
      name: z.string(),
      provider: z.enum([
        'openrouter',
        'systemone',
        'custom-openrouter',
        'custom-systemone',
      ]),
      model: z.string(),
      thinkMode: z.enum(['never', 'auto', 'always']).optional(),
      thinkBudget: z.number().optional(),
    })
    .optional(),
});
const replaySchema = z.object({
  version: z.literal(1),
  matchId: z.string(),
  gameId,
  rulesVersion: z.string(),
  promptVersion: z.string(),
  seed: z.string(),
  config: z.object({
    size: z.number().optional(),
    boardSize: z.number().optional(),
    maxPlies: z.number().optional(),
  }),
  seats: z.tuple([publicSeat, publicSeat]),
  result,
  createdAt: z.number(),
  finishedAt: z.number(),
  frames: z.array(view),
  events: z.array(
    z.object({
      seq: z.number(),
      type: z.enum(['created', 'action', 'status', 'error']),
      at: z.number(),
      seat: seat.optional(),
      action: action.optional(),
      metrics: metrics.optional(),
      view: view.optional(),
    }).strip()
  ),
});

const finite = z.number().finite();
const tick = z.number().int().min(0).max(7200);
const point = z.object({ x: finite, y: finite });
const rect = point.extend({ width: finite.nonnegative(), height: finite.nonnegative() });
const buttons = z.array(z.enum(['up', 'down', 'left', 'right', 'rotate-cw', 'rotate-ccw', 'soft-drop', 'hard-drop', 'hold', 'jump'])).max(10);
const input = z.object({ buttons, durationMs: z.union([z.literal(100), z.literal(300), z.literal(1000)]).optional() });
const arcadeScore = z.object({
  points: finite, survivedTicks: tick, food: finite.optional(), lines: finite.optional(),
  coins: finite.optional(), progress: finite.optional(), completed: z.boolean().optional(),
});
const arcadeGameId = z.enum(['snake', 'tetris', 'platformer']);
const arcadeView = z.object({
  gameId: arcadeGameId, tick, status: z.enum(['playing', 'finished']), score: arcadeScore,
  width: finite, height: finite, currentButtons: buttons, reason: z.string().max(500).optional(),
  cells: z.array(z.number().int().min(0).max(7)).max(400).optional(),
  snake: z.array(point).max(400).optional(), food: point.nullable().optional(),
  active: z.object({ type: z.string().max(8), cells: z.array(point).max(4) }).optional(),
  next: z.array(z.string().max(8)).max(5).optional(), hold: z.string().max(8).nullable().optional(), pieceId: z.number().int().optional(),
  player: rect.extend({ vx: finite, vy: finite, onGround: z.boolean() }).optional(),
  platforms: z.array(rect).max(1000).optional(), hazards: z.array(rect).max(1000).optional(),
  coins: z.array(point).max(1000).optional(), enemies: z.array(rect).max(100).optional(), exit: rect.optional(),
  level: z.number().int().min(1).max(1000).optional(),
});
const arcadeReplaySchema = z.object({
  version: z.literal(2), engineKind: z.literal('arcade'), matchId: z.string(), gameId: arcadeGameId,
  mode: z.enum(['practice', 'ai-solo', 'human-ai', 'ai-ai']), rulesVersion: z.string(), promptVersion: z.string(), seed: z.string(),
  config: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }),
  controllers: z.array(publicSeat).min(1).max(2),
  runIds: z.array(z.string()).min(1).max(2),
  result: result.extend({ scores: z.array(arcadeScore).min(1).max(2), aborted: z.boolean() }),
  createdAt: finite, finishedAt: finite, maxTicks: z.literal(7200),
  frames: z.array(z.object({ tick, views: z.array(arcadeView).min(1).max(2) })).min(1).max(20000),
  events: z.array(z.object({
    seq: z.number().int().nonnegative(), type: z.enum(['created', 'input', 'decision', 'status', 'ended', 'error']),
    tick, at: finite, runId: z.string().optional(), input: input.optional(), release: z.literal(true).optional(), actionId: z.string().max(160).optional(),
    observedTick: tick.optional(), appliedTick: tick.optional(), requestId: z.string().optional(),
    promptVersion: z.string().regex(/^decision-arena-arcade-v[1-9][0-9]*$/).max(64).optional(),
    outcome: z.enum(['applied', 'dropped', 'failed', 'unknown']).optional(), metrics: metrics.optional(),
  })).max(20000),
}).superRefine((value, ctx) => {
  const tracks = value.mode === 'practice' || value.mode === 'ai-solo' ? 1 : 2;
  if (value.controllers.length !== tracks || value.runIds.length !== tracks || new Set(value.runIds).size !== tracks || value.result.scores.length !== tracks ||
      (value.mode === 'ai-solo' && (value.controllers[0]?.kind !== 'ai' || value.result.winner !== null)) ||
      value.frames.some(frame => frame.views.length !== tracks || frame.views.some(view => view.gameId !== value.gameId)))
    ctx.addIssue({ code: 'custom', message: 'Replay tracks do not match the activity.' });
});

export type PublicReplay = ReplayManifest | ArcadeReplayV2;
export function publicReplay(value: unknown): PublicReplay {
  return value && typeof value === 'object' && 'version' in value && value.version === 2
    ? arcadeReplaySchema.parse(value)
    : replaySchema.parse(value);
}
