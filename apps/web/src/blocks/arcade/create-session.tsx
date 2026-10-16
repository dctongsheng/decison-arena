import { useEffect, useRef, useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ARCADE_GAME_IDS,
  type ArcadeGameId,
  type ArcadeMode,
  type ArcadeReplayV2,
  type ArcadeSession,
} from '@decision-arena/core';
import {
  ArrowRight,
  Bot,
  Check,
  Gamepad2,
  MonitorPlay,
  ShieldCheck,
  Swords,
  Timer,
  Zap,
} from 'lucide-react';
import { z } from 'zod';

import { useSession } from '@/core/auth/client';
import { Link, useRouter } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import {
  ArenaShell,
  AuthGate,
  ErrorNotice,
  Loading,
  PageHeading,
  SubmitButton,
  t,
  useModels,
} from '@/blocks/arena/shared';

import { ArcadeArtwork } from './canvas';
import {
  arcadeControllerKinds,
  arcadeCreateControllers,
  arcadeModelsReady,
  emptyArcadeSelection,
  readArcadePreferences,
  rememberArcadeSelection,
  selectArcadeMode,
  writeArcadePreferences,
  type ArcadeCreatePreferences,
  type ArcadeSelection,
} from './create-preferences';
import { a } from './messages';

import './arcade.css';

export function CreateArcadePage({
  game,
  clone,
}: {
  game?: string;
  clone?: string;
}) {
  return (
    <ArenaShell>
      <AuthGate>
        <CreateContent
          key={`${game || ''}:${clone || ''}`}
          game={game}
          clone={clone}
        />
      </AuthGate>
    </ArenaShell>
  );
}
function CreateContent({ game, clone }: { game?: string; clone?: string }) {
  const router = useRouter(),
    models = useModels();
  const { data: identity } = useSession();
  const userId = identity?.user.id || '';
  const [preferencesReady, setPreferencesReady] = useState(false);
  const restoredUser = useRef('');
  const preferences = useRef<ArcadeCreatePreferences>({
    version: 1,
    mode: 'practice',
    selections: {},
  });
  const source = useQuery({
    queryKey: ['arena-arcade-clone', clone],
    queryFn: () =>
      apiGet<{ replay: ArcadeReplayV2 }>(
        `/api/arena/community/${encodeURIComponent(clone!)}?version=2`
      ),
    enabled: !!clone,
  });
  const create = useMutation({
    mutationFn: (body: unknown) =>
      apiPost<ArcadeSession>('/api/arena/arcade-sessions', body),
    onSuccess: (data) => router.push(`/arcade/${data.id}`),
  });
  const form = useForm({
    defaultValues: {
      gameId: (ARCADE_GAME_IDS.includes(game as ArcadeGameId)
        ? game
        : 'snake') as ArcadeGameId,
      mode: 'practice' as ArcadeMode,
      ...emptyArcadeSelection(),
      seed: '',
      level: '1',
    },
    validators: {
      onSubmit: z.object({
        gameId: z.enum(['snake', 'tetris', 'platformer']),
        mode: z.enum(['practice', 'ai-solo', 'human-ai', 'ai-ai']),
        profile0: z.string(),
        profile1: z.string(),
        seed: z.string().max(128),
        level: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const controllers = arcadeCreateControllers(
        value.mode,
        value,
        (models.data?.items || []).map((profile) => profile.id)
      );
      if (!controllers) throw new Error(a('required_model'));
      await create.mutateAsync({
        gameId: value.gameId,
        mode: value.mode,
        controllers,
        config:
          value.gameId === 'platformer' ? { level: Number(value.level) } : {},
        ...(value.seed ? { seed: value.seed } : {}),
        ...(clone ? { cloneId: clone } : {}),
      });
    },
  });
  function applySelection(selection: ArcadeSelection) {
    form.setFieldValue('profile0', selection.profile0);
    form.setFieldValue('profile1', selection.profile1);
  }
  function persist() {
    if (clone || !preferencesReady || !models.isSuccess) return;
    const ids = models.data.items.map((model) => model.id);
    preferences.current = rememberArcadeSelection(
      preferences.current,
      form.state.values.mode,
      form.state.values,
      ids
    );
    try {
      writeArcadePreferences(
        window.localStorage,
        userId,
        preferences.current,
        ids
      );
    } catch {
      /* Storage may be disabled. */
    }
  }
  function changeMode(mode: ArcadeMode) {
    const ids = (models.data?.items || []).map((model) => model.id);
    preferences.current = selectArcadeMode(
      preferences.current,
      form.state.values.mode,
      form.state.values,
      mode,
      ids
    );
    form.setFieldValue('mode', mode);
    applySelection(
      preferences.current.selections[mode] || emptyArcadeSelection()
    );
    persist();
  }
  useEffect(() => {
    if (clone || !userId || !models.isSuccess) return;
    const ids = models.data.items.map((model) => model.id);
    if (restoredUser.current !== userId) {
      try {
        preferences.current = readArcadePreferences(
          window.localStorage,
          userId,
          ids
        );
      } catch {
        /* Storage may be disabled. */
      }
      form.setFieldValue('mode', preferences.current.mode);
      restoredUser.current = userId;
    } else {
      preferences.current = rememberArcadeSelection(
        preferences.current,
        form.state.values.mode,
        form.state.values,
        ids
      );
    }
    applySelection(
      preferences.current.selections[preferences.current.mode] ||
        emptyArcadeSelection()
    );
    // Remove deleted/foreign IDs even when the user does not change a form field.
    try {
      writeArcadePreferences(
        window.localStorage,
        userId,
        preferences.current,
        ids
      );
    } catch {
      /* Storage may be disabled. */
    }
    setPreferencesReady(true);
  }, [userId, models.data, models.isSuccess, clone]);
  useEffect(() => {
    const replay = source.data?.replay;
    if (replay?.version === 2) {
      form.setFieldValue('gameId', replay.gameId);
      form.setFieldValue('mode', replay.mode);
      form.setFieldValue('seed', replay.seed);
      form.setFieldValue('level', String(replay.config.level || 1));
    }
  }, [source.data]);
  if (clone && source.isPending) return <Loading />;
  if (!clone && !models.error && !preferencesReady) return <Loading />;
  return (
    <>
      <PageHeading
        eyebrow={a('eyebrow')}
        title={a('new_title')}
        description={a('new_description')}
      />
      <ErrorNotice error={models.error || source.error || create.error} />
      <p className="arcade-notice">{a('thinking_disabled')}</p>
      {clone && (
        <div className="arena-clone-banner">
          <ShieldCheck size={24} />
          <p>{a('clone_note')}</p>
        </div>
      )}
      <form
        className="arcade-create"
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit();
        }}
      >
        <div>
          <section className="arena-panel arcade-form-section">
            <h2>{a('choose_game')}</h2>
            <form.Field name="gameId">
              {(field) => (
                <div className="arcade-game-options">
                  {ARCADE_GAME_IDS.map((id) => (
                    <button
                      type="button"
                      key={id}
                      className={
                        field.state.value === id
                          ? 'arcade-game-option selected'
                          : 'arcade-game-option'
                      }
                      aria-pressed={field.state.value === id}
                      disabled={!!clone}
                      onClick={() => field.handleChange(id)}
                    >
                      <ArcadeArtwork gameId={id} />
                      <span>
                        {a(`game.${id}`)}
                        {field.state.value === id && <Check size={16} />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </form.Field>
          </section>
          <section className="arena-panel arcade-form-section">
            <h2>{a('choose_mode')}</h2>
            <form.Field name="mode">
              {(field) => (
                <div className="arcade-mode-options">
                  {(
                    [
                      { id: 'practice', label: 'solo', Icon: Gamepad2 },
                      { id: 'ai-solo', label: 'ai-solo', Icon: MonitorPlay },
                      { id: 'human-ai', label: 'human-ai', Icon: Swords },
                      { id: 'ai-ai', label: 'ai-ai', Icon: Bot },
                    ] as const
                  ).map(({ id, label, Icon }) => (
                    <button
                      key={id}
                      type="button"
                      disabled={!!clone}
                      className={
                        field.state.value === id
                          ? 'arcade-mode selected'
                          : 'arcade-mode'
                      }
                      aria-pressed={field.state.value === id}
                      onClick={() => changeMode(id)}
                    >
                      <Icon size={24} />
                      <strong>{a(`mode.${label}`)}</strong>
                      <p>{a(`mode.${label}.help`)}</p>
                    </button>
                  ))}
                </div>
              )}
            </form.Field>
          </section>
          <form.Subscribe selector={(state) => state.values}>
            {(values) => (
              <section className="arena-panel arcade-form-section">
                <h2>{a('choose_controllers')}</h2>
                <div className="arcade-controller-options">
                  {arcadeControllerKinds(values.mode).map((kind, index) => {
                    const ai = kind === 'ai';
                    const original =
                      source.data?.replay.controllers[index]?.profile;
                    const available = (models.data?.items || []).filter(
                      (model) =>
                        !clone ||
                        !original ||
                        model.provider === original.provider
                    );
                    return (
                      <div className="arcade-controller-config" key={index}>
                        <div className="arcade-controller-label">
                          <span className="arena-icon-box">
                            {ai ? <Bot size={22} /> : <Gamepad2 size={22} />}
                          </span>
                          <div>
                            <small>
                              {a(
                                arcadeControllerKinds(values.mode).length === 1
                                  ? 'single_lane'
                                  : index === 0
                                    ? 'left'
                                    : 'right'
                              )}
                            </small>
                            <strong>{a(ai ? 'ai' : 'you')}</strong>
                          </div>
                        </div>
                        {ai ? (
                          <>
                            {clone && original && (
                              <p>
                                {a('original_model')} · {original.name} ·{' '}
                                {original.model || t('models.service_default')}
                              </p>
                            )}
                            <form.Field
                              name={index === 0 ? 'profile0' : 'profile1'}
                            >
                              {(field) => (
                                <label className="arena-field">
                                  <span>{a('pick_model')}</span>
                                  <select
                                    required
                                    value={field.state.value}
                                    onChange={(event) => {
                                      field.handleChange(event.target.value);
                                      persist();
                                    }}
                                  >
                                    <option value="">{a('pick_model')}</option>
                                    {available.map((model) => (
                                      <option value={model.id} key={model.id}>
                                        {model.name} ·{' '}
                                        {model.model ||
                                          t('models.service_default')}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              )}
                            </form.Field>
                            {!models.isPending && !available.length && (
                              <p className="arcade-notice">
                                {a('models_empty')}{' '}
                                <Link href="/models">{a('models_add')}</Link>
                              </p>
                            )}
                          </>
                        ) : (
                          <p>{a(`controls.${values.gameId}`)}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </form.Subscribe>
          {!clone && (
            <p className="arcade-preference-note">{a('preferences_note')}</p>
          )}
        </div>
        <aside className="arena-panel arcade-create-aside">
          <span className="arcade-eyebrow">
            <Zap size={14} />
            {a('continuous')}
          </span>
          <h2>
            120 <small>sec</small>
          </h2>
          <p>{a('rules_note')}</p>
          <form.Subscribe selector={(state) => state.values.gameId}>
            {(gameId) => (
              <section className="arcade-rule-summary">
                <strong>{a('rules_title')}</strong>
                <p>{a(`rules_summary.${gameId}`)}</p>
                <small>{a(`comparison.${gameId}`)}</small>
              </section>
            )}
          </form.Subscribe>
          <div className="arcade-mode-facts">
            <span>
              <Timer size={16} />
              {a('standard')}
            </span>
            <span>
              <ShieldCheck size={16} />
              {a('saved_note')}
            </span>
          </div>
          <form.Field name="seed">
            {(field) => (
              <label className="arena-field">
                <span>{a('seed')}</span>
                <input
                  value={field.state.value}
                  maxLength={128}
                  disabled={!!clone}
                  placeholder="AUTO"
                  onChange={(event) => field.handleChange(event.target.value)}
                />
                <small>{a('seed_help')}</small>
              </label>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.gameId}>
            {(id) =>
              id === 'platformer' && (
                <form.Field name="level">
                  {(field) => (
                    <label className="arena-field">
                      <span>{a('level')}</span>
                      <select
                        value={field.state.value}
                        disabled={!!clone}
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                      >
                        {[1, 2, 3].map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </form.Field>
              )
            }
          </form.Subscribe>
          <form.Subscribe
            selector={(state) => [state.isSubmitting, state.values] as const}
          >
            {([pending, values]) => (
              <SubmitButton
                type="submit"
                pending={pending}
                disabled={
                  !!(
                    source.error ||
                    models.error ||
                    models.isPending ||
                    !arcadeModelsReady(
                      values.mode,
                      values,
                      (models.data?.items || []).map((model) => model.id)
                    )
                  )
                }
              >
                {a('create')}
                <ArrowRight size={17} />
              </SubmitButton>
            )}
          </form.Subscribe>
        </aside>
      </form>
    </>
  );
}
