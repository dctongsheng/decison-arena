import { z } from 'zod';

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/);
export const idSchema = identifier;
export const credentialInput = z.object({
  id: identifier.optional(),
  name: z.string().trim().min(1).max(80),
  apiKey: z.string().trim().min(1).max(4096),
});
export const profileInput = z.object({
  id: identifier.optional(),
  name: z.string().trim().min(1).max(80),
  provider: z.enum([
    'openrouter',
    'systemone',
    'custom-openrouter',
    'custom-systemone',
  ]),
  model: z.string().trim().max(160).default(''),
  endpoint: z.string().trim().max(2048).default(''),
  credentialId: identifier.optional(),
  apiKey: z.string().trim().min(1).max(4096).optional(),
  thinkMode: z.enum(['never', 'auto', 'always']).default('never'),
  thinkBudget: z.number().int().min(128).max(16384).default(1024),
});
export const createMatchInput = z
  .object({
    cloneId: identifier.optional(),
    gameId: z.enum(['gomoku', 'xiangqi', 'army']).optional(),
    config: z.record(z.string(), z.unknown()).default({}),
    seed: z.string().max(128).optional(),
    seats: z.tuple([
      z.object({
        kind: z.enum(['human', 'ai']),
        profileId: identifier.optional(),
        profile: z.object({ id: identifier }).optional(),
      }),
      z.object({
        kind: z.enum(['human', 'ai']),
        profileId: identifier.optional(),
        profile: z.object({ id: identifier }).optional(),
      }),
    ]),
  })
  .refine((input) => input.cloneId || input.gameId, {
    path: ['gameId'],
    message: 'Choose a game or a published replay to clone.',
  });
export const commandInput = z.object({
  type: z.enum(['action', 'start', 'step', 'pause', 'resume', 'end']),
  operationId: identifier,
  version: z.number().int().min(0).optional(),
  actionId: z.string().max(160).optional(),
  seat: z.union([z.literal(0), z.literal(1)]).optional(),
});
const arcadeController = z.object({
  kind: z.enum(['human', 'ai']),
  profileId: identifier.optional(),
});
export const createArcadeInput = z.object({
  cloneId: identifier.optional(),
  gameId: z.enum(['snake', 'tetris', 'platformer']),
  mode: z.enum(['practice', 'ai-solo', 'human-ai', 'ai-ai']),
  config: z.object({
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    snakeHarnessVersion: z.enum(['snake-harness-a-v1', 'snake-harness-b-v1', 'snake-harness-c-v1']).optional(),
    tetrisHarnessVersion: z.enum(['tetris-harness-baseline-v1', 'tetris-harness-v8-realtime-v1']).optional(),
  }).default({}),
  seed: z.string().trim().min(1).max(128).optional(),
  controllers: z.array(arcadeController).min(1).max(2),
}).superRefine((value, ctx) => {
  if (value.gameId !== 'snake' && value.config.snakeHarnessVersion !== undefined)
    ctx.addIssue({ code: 'custom', path: ['config', 'snakeHarnessVersion'], message: 'Snake harness versions are only available for snake.' });
  if (value.gameId !== 'tetris' && value.config.tetrisHarnessVersion !== undefined)
    ctx.addIssue({ code: 'custom', path: ['config', 'tetrisHarnessVersion'], message: 'Tetris harness versions are only available for tetris.' });
  const expected = value.mode === 'practice' ? ['human'] : value.mode === 'ai-solo' ? ['ai'] : value.mode === 'human-ai' ? ['human', 'ai'] : ['ai', 'ai'];
  if (value.controllers.length !== expected.length || value.controllers.some((c, i) => c.kind !== expected[i]))
    ctx.addIssue({ code: 'custom', path: ['controllers'], message: 'Controllers do not match the selected mode.' });
  if (value.controllers.some(c => c.kind === 'ai' && !c.profileId))
    ctx.addIssue({ code: 'custom', path: ['controllers'], message: 'Choose your own saved model for each AI controller.' });
});
export const arcadeCommandInput = z.object({
  type: z.enum(['start', 'pause', 'resume', 'retry', 'end']),
  operationId: identifier.min(8).max(100),
});
export const publicationInput = z.object({
  matchId: identifier,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
});
export const communityActionInput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('like'), liked: z.boolean().optional() }),
  z.object({
    action: z.literal('comment'),
    body: z.string().trim().min(1).max(2000),
  }),
  z.object({
    action: z.literal('report'),
    reason: z.string().trim().min(1).max(1000),
  }),
  z.object({ action: z.literal('unpublish') }),
  z.object({
    action: z.literal('moderate'),
    reason: z.string().trim().max(1000).optional(),
  }),
]);
