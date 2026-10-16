import type { ReplayManifest } from '@decision-arena/core';
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

export function publicReplay(value: unknown): ReplayManifest {
  return replaySchema.parse(value);
}
