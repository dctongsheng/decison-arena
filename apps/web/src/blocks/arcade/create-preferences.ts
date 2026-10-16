import type { ArcadeMode } from '@decision-arena/core';

const modes = ['practice', 'ai-solo', 'human-ai', 'ai-ai'] as const;
export interface ArcadeSelection {
  profile0: string;
  profile1: string;
}
export interface ArcadeCreatePreferences {
  version: 1;
  mode: ArcadeMode;
  selections: Partial<Record<ArcadeMode, ArcadeSelection>>;
}
type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export const emptyArcadeSelection = (): ArcadeSelection => ({
  profile0: '',
  profile1: '',
});
const emptyPreferences = (): ArcadeCreatePreferences => ({
  version: 1,
  mode: 'practice',
  selections: {},
});
export const arcadePreferenceKey = (userId: string) =>
  `decision-arena:arcade-create:v1:${encodeURIComponent(userId)}`;

export function arcadeControllerKinds(mode: ArcadeMode): ('human' | 'ai')[] {
  switch (mode) {
    case 'practice':
      return ['human'];
    case 'ai-solo':
      return ['ai'];
    case 'human-ai':
      return ['human', 'ai'];
    case 'ai-ai':
      return ['ai', 'ai'];
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function cleanSelection(
  value: unknown,
  mode: ArcadeMode,
  profileIds: readonly string[]
): ArcadeSelection {
  const source = record(value),
    result = emptyArcadeSelection();
  arcadeControllerKinds(mode).forEach((kind, index) => {
    if (kind !== 'ai') return;
    const profileKey = index === 0 ? 'profile0' : 'profile1';
    const id = source[profileKey];
    if (typeof id !== 'string' || !profileIds.includes(id)) return;
    result[profileKey] = id;
  });
  return result;
}
export function sanitizeArcadePreferences(
  value: unknown,
  profileIds: readonly string[]
): ArcadeCreatePreferences {
  const source = record(value),
    result = emptyPreferences();
  if (source.version !== 1) return result;
  if (modes.includes(source.mode as ArcadeMode))
    result.mode = source.mode as ArcadeMode;
  const selections = record(source.selections);
  for (const mode of modes) {
    if (selections[mode])
      result.selections[mode] = cleanSelection(
        selections[mode],
        mode,
        profileIds
      );
  }
  return result;
}
export function rememberArcadeSelection(
  preferences: ArcadeCreatePreferences,
  mode: ArcadeMode,
  selection: ArcadeSelection,
  profileIds: readonly string[]
): ArcadeCreatePreferences {
  return sanitizeArcadePreferences(
    {
      version: 1,
      mode,
      selections: { ...preferences.selections, [mode]: selection },
    },
    profileIds
  );
}
export function selectArcadeMode(
  preferences: ArcadeCreatePreferences,
  currentMode: ArcadeMode,
  currentSelection: ArcadeSelection,
  nextMode: ArcadeMode,
  profileIds: readonly string[]
): ArcadeCreatePreferences {
  return {
    ...rememberArcadeSelection(
      preferences,
      currentMode,
      currentSelection,
      profileIds
    ),
    mode: nextMode,
  };
}
export function readArcadePreferences(
  storage: PreferenceStorage,
  userId: string,
  profileIds: readonly string[],
  clone = false
): ArcadeCreatePreferences {
  // Public clone settings never read or overwrite a user's creation preferences.
  if (clone || !userId) return emptyPreferences();
  try {
    return sanitizeArcadePreferences(
      JSON.parse(storage.getItem(arcadePreferenceKey(userId)) || 'null'),
      profileIds
    );
  } catch {
    return emptyPreferences();
  }
}
export function writeArcadePreferences(
  storage: PreferenceStorage,
  userId: string,
  preferences: ArcadeCreatePreferences,
  profileIds: readonly string[],
  clone = false
) {
  if (clone || !userId) return;
  try {
    // Rebuild the whitelist before serialization; never persist a profile object.
    storage.setItem(
      arcadePreferenceKey(userId),
      JSON.stringify(sanitizeArcadePreferences(preferences, profileIds))
    );
  } catch {
    /* A blocked/full browser store must not prevent creating a game. */
  }
}
export function arcadeModelsReady(
  mode: ArcadeMode,
  selection: ArcadeSelection,
  profileIds: readonly string[]
) {
  return arcadeControllerKinds(mode).every(
    (kind, index) =>
      kind === 'human' ||
      profileIds.includes(index === 0 ? selection.profile0 : selection.profile1)
  );
}

export function arcadeCreateControllers(
  mode: ArcadeMode,
  selection: ArcadeSelection,
  profileIds: readonly string[]
) {
  if (!arcadeModelsReady(mode, selection, profileIds)) return null;
  // Send only references. The server enforces the arcade no-thinking policy,
  // including clones and profiles whose general configuration enables thinking.
  return arcadeControllerKinds(mode).map((kind, index) =>
    kind === 'human'
      ? { kind }
      : {
          kind,
          profileId: index === 0 ? selection.profile0 : selection.profile1,
        }
  );
}
