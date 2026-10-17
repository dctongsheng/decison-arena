import type { ModelProfile } from '@decision-arena/core';
import { BAMBOONODE_MODELS, decryptSecret, isBambooNodeProvider } from '@decision-arena/providers';

/** A reconnect can reuse the row ID. Compare keys, not randomized ciphertext. */
export async function assertBambooNodeKey(profile: ModelProfile, ciphertext: string, sentKey: string, masterKey: string, ownerId: string): Promise<void> {
  if (isBambooNodeProvider(profile.provider) && await decryptSecret(ciphertext, masterKey, ownerId) !== sentKey)
    throw new Error('BambooNode authorization changed during the request; retry explicitly with the current connection');
}

/** Read the local connection each time; frozen matches must not retain revoked access. */
export async function assertBambooNodeAccess(db: D1Database, ownerId: string, profile: ModelProfile): Promise<void> {
  if (!isBambooNodeProvider(profile.provider)) return;
  const connection = await db.prepare('SELECT status,expires_at,models_json FROM arena_bamboo_connections WHERE owner_id=? AND credential_id=?')
    .bind(ownerId, profile.credentialId).first<{ status: string; expires_at: number; models_json: string }>();
  if (!connection || connection.status !== 'connected' || !Number.isFinite(connection.expires_at) || connection.expires_at <= Date.now()) {
    throw new Error('BambooNode authorization expired or was disconnected; reconnect before starting another game');
  }
  let models: unknown;
  try { models = JSON.parse(connection.models_json); } catch { models = null; }
  if (!Array.isArray(models) || !models.every(model => typeof model === 'string') || !models.includes(profile.model) || !BAMBOONODE_MODELS[profile.provider].includes(profile.model)) {
    throw new Error('BambooNode model is no longer available; synchronize models before starting another game');
  }
}
