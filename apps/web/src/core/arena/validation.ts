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
