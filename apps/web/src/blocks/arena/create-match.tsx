import { useEffect } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQuery } from '@tanstack/react-query';
import type {
  GameId,
  MatchSnapshot,
  ReplayManifest,
} from '@decision-arena/core';
import {
  ArrowRight,
  Bot,
  Check,
  CircleHelp,
  KeyRound,
  Shield,
  Swords,
  UserRound,
  Users,
} from 'lucide-react';
import { z } from 'zod';

import { Link, useRouter } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';
import { GameArtwork } from '@/components/arena/board';

import { availableModels } from './bamboonode-access';
import { BambooModelConnection } from './bamboonode-connection';
import { BambooJevNotice } from './bamboonode-billing';
import {
  ArenaShell,
  AuthGate,
  CommunityPost,
  ErrorNotice,
  gameName,
  Loading,
  PageHeading,
  seatName,
  SubmitButton,
  t,
  useModels,
} from './shared';

export function CreateMatchPage({
  game,
  clone,
}: {
  game?: string;
  clone?: string;
}) {
  return (
    <ArenaShell>
      <AuthGate>
        <BambooModelConnection />
        <CreateMatchContent game={game} clone={clone} />
      </AuthGate>
    </ArenaShell>
  );
}
function CreateMatchContent({
  game,
  clone,
}: {
  game?: string;
  clone?: string;
}) {
  const models = useModels();
  const playableModels = availableModels(models.data?.items);
  const router = useRouter();
  const source = useQuery({
    queryKey: ['arena-clone', clone],
    queryFn: () =>
      apiGet<{ post: CommunityPost; replay: ReplayManifest }>(
        `/api/arena/community/${encodeURIComponent(clone!)}`
      ),
    enabled: !!clone,
  });
  const mutation = useMutation({
    mutationFn: (payload: unknown) =>
      apiPost<MatchSnapshot>('/api/arena/matches', payload),
    onSuccess: (snapshot) => router.push(`/matches/${snapshot.id}`),
  });
  const form = useForm({
    defaultValues: {
      gameId: (['gomoku', 'xiangqi', 'army'].includes(game || '')
        ? game
        : 'gomoku') as GameId,
      mode: 'human-human',
      humanSeat: '0',
      profile0: '',
      profile1: '',
      size: '15',
    },
    validators: {
      onSubmit: z.object({
        gameId: z.enum(['gomoku', 'xiangqi', 'army']),
        mode: z.string(),
        humanSeat: z.string(),
        profile0: z.string(),
        profile1: z.string(),
        size: z.string(),
      }),
    },
    onSubmit: async ({ value }) => {
      const seats = ([0, 1] as const).map((seat) => {
        const ai =
          value.mode === 'ai-ai' ||
          (value.mode === 'human-ai' && Number(value.humanSeat) !== seat);
        return ai
          ? {
              kind: 'ai',
              profileId: seat === 0 ? value.profile0 : value.profile1,
            }
          : { kind: 'human' };
      });
      await mutation.mutateAsync({
        cloneId: clone,
        gameId: value.gameId,
        config: value.gameId === 'gomoku' ? { size: Number(value.size) } : {},
        seats,
      });
    },
  });
  useEffect(() => {
    if (source.data) {
      form.setFieldValue('gameId', source.data.replay.gameId);
      const aiCount = source.data.replay.seats.filter(
        (seat) => seat.kind === 'ai'
      ).length;
      form.setFieldValue(
        'mode',
        aiCount === 2 ? 'ai-ai' : aiCount === 1 ? 'human-ai' : 'human-human'
      );
      form.setFieldValue(
        'humanSeat',
        String(
          source.data.replay.seats.findIndex((seat) => seat.kind === 'human')
        )
      );
      if (source.data.replay.gameId === 'gomoku')
        form.setFieldValue(
          'size',
          String(source.data.replay.config.size || 15)
        );
    }
  }, [source.data]);
  if (clone && source.isPending) return <Loading />;
  if (clone && source.error)
    return (
      <>
        <ErrorNotice error={source.error} />
        <Link href="/new" className="arena-text-link">
          {t('new.exit_clone')}
        </Link>
      </>
    );
  return (
    <>
      <PageHeading
        eyebrow="NEW EXPERIMENT"
        title={t('new.title')}
        description={t('new.description')}
      />
      {source.data && (
        <div className="arena-clone-banner">
          <Shield size={21} />
          <div>
            <strong>
              {t('new.clone')}: {source.data.post.title}
            </strong>
            <p>{t('new.clone_help')}</p>
            <Link className="arena-text-link" href="/new">
              {t('new.exit_clone')}
              <ArrowRight size={14} />
            </Link>
            <p className="arena-caption">
              {source.data.replay.seats
                .map((s) => s.profile?.name || t('human'))
                .join(' × ')}
            </p>
          </div>
        </div>
      )}
      <ErrorNotice error={source.error} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void form.handleSubmit();
        }}
        className="arena-create-layout"
      >
        <div className="arena-create-main">
          <section className="arena-panel arena-form-section">
            <h2>
              <span>01</span>
              {t('new.choose_game')}
            </h2>
            <form.Field name="gameId">
              {(field) => (
                <div className="arena-game-options">
                  {(['gomoku', 'xiangqi', 'army'] as GameId[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      className={`arena-game-option ${field.state.value === id ? 'selected' : ''}`}
                      disabled={!!clone}
                      onClick={() => field.handleChange(id)}
                      aria-pressed={field.state.value === id}
                    >
                      <GameArtwork gameId={id} />
                      <span>
                        {gameName(id)}
                        {field.state.value === id && <Check size={17} />}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values.gameId}>
              {(id) =>
                id === 'gomoku' && (
                  <form.Field name="size">
                    {(field) => (
                      <label className="arena-field arena-inline-field">
                        <span>{t('new.board_size')}</span>
                        <select
                          disabled={!!clone}
                          value={field.state.value}
                          onChange={(e) => field.handleChange(e.target.value)}
                        >
                          <option value="15">
                            15 × 15 · {t('new.standard')}
                          </option>
                          <option value="9">9 × 9 · {t('new.quick')}</option>
                        </select>
                      </label>
                    )}
                  </form.Field>
                )
              }
            </form.Subscribe>
          </section>
          <section className="arena-panel arena-form-section">
            <h2>
              <span>02</span>
              {t('new.choose_mode')}
            </h2>
            <form.Field name="mode">
              {(field) => (
                <div className="arena-mode-options">
                  {[
                    { id: 'human-human', Icon: Users },
                    { id: 'human-ai', Icon: Swords },
                    { id: 'ai-ai', Icon: Bot },
                  ].map(({ id, Icon }) => (
                    <button
                      type="button"
                      className={`arena-mode-option ${field.state.value === id ? 'selected' : ''}`}
                      key={id}
                      disabled={!!clone}
                      onClick={() => field.handleChange(id)}
                      aria-pressed={field.state.value === id}
                    >
                      <Icon size={25} />
                      <strong>{t(`mode.${id}`)}</strong>
                      <small>{t(`mode.${id}.description`)}</small>
                    </button>
                  ))}
                </div>
              )}
            </form.Field>
          </section>
          <section className="arena-panel arena-form-section">
            <h2>
              <span>03</span>
              {t('new.seats')}
            </h2>
            <form.Subscribe selector={(s) => s.values}>
              {(values) => (
                <>
                  <div className="arena-seat-configs">
                    {([0, 1] as const).map((seat) => {
                      const ai =
                        values.mode === 'ai-ai' ||
                        (values.mode === 'human-ai' &&
                          Number(values.humanSeat) !== seat);
                      const template = source.data?.replay.seats[seat].profile;
                      const choices = playableModels.filter(
                        (model) =>
                          !clone ||
                          !template ||
                          model.provider === template.provider
                      );
                      return (
                        <div
                          className={`arena-seat-config seat-${seat}`}
                          key={seat}
                        >
                          <div>
                            <span className="arena-seat-dot" />
                            {seatName(values.gameId, seat)}
                            {seat === 0 && <small>{t('new.first')}</small>}
                          </div>
                          <h3>
                            {ai ? (
                              <>
                                <Bot size={20} />
                                {t('ai')}
                              </>
                            ) : (
                              <>
                                <UserRound size={20} />
                                {t('human')}
                              </>
                            )}
                          </h3>
                          {ai && template && (
                            <div className="arena-clone-model">
                              <strong>{template.name}</strong>
                              <code>{template.model || 'System One'}</code>
                              <span>
                                {template.provider}
                                {template.provider.includes('systemone')
                                  ? ` · ${t(`models.think_${template.thinkMode || 'never'}`)} · ${template.thinkBudget || 4096} tokens`
                                  : ''}
                              </span>
                            </div>
                          )}
                          {ai ? (
                            <form.Field
                              name={seat === 0 ? 'profile0' : 'profile1'}
                            >
                              {(field) => (
                                <label className="arena-field">
                                  <span>
                                    {t(
                                      clone
                                        ? 'new.select_credential'
                                        : 'new.select_model'
                                    )}
                                  </span>
                                  <select
                                    value={field.state.value}
                                    onChange={(e) =>
                                      field.handleChange(e.target.value)
                                    }
                                    required
                                  >
                                    <option value="">
                                      {t('new.select_placeholder')}
                                    </option>
                                    {choices?.map((model) => (
                                      <option value={model.id} key={model.id}>
                                        {model.name} ·{' '}
                                        {model.model || 'System One'}
                                        {model.source === 'bamboonode'
                                          ? ` · ${m['arena.bamboo.model_source']()}`
                                          : ''}
                                      </option>
                                    ))}
                                  </select>
                                  {clone && !choices?.length && (
                                    <small className="arena-field-help">
                                      {t('new.no_compatible')}
                                    </small>
                                  )}
                                </label>
                              )}
                            </form.Field>
                          ) : (
                            <p>
                              {t(
                                values.mode === 'human-human'
                                  ? 'new.local_human'
                                  : 'new.you'
                              )}
                            </p>
                          )}
                          {ai && (
                            <BambooJevNotice
                              profile={choices.find((model) => model.id ===
                                (seat === 0 ? values.profile0 : values.profile1)
                              )}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                  {values.mode === 'human-ai' && (
                    <form.Field name="humanSeat">
                      {(field) => (
                        <label className="arena-field arena-inline-field">
                          <span>{t('new.your_side')}</span>
                          <select
                            disabled={!!clone}
                            value={field.state.value}
                            onChange={(e) => field.handleChange(e.target.value)}
                          >
                            <option value="0">
                              {seatName(values.gameId, 0)} · {t('new.first')}
                            </option>
                            <option value="1">
                              {seatName(values.gameId, 1)}
                            </option>
                          </select>
                        </label>
                      )}
                    </form.Field>
                  )}
                  {values.mode !== 'human-human' && (
                    <Link href="/models" className="arena-text-link">
                      <KeyRound size={15} />
                      {t('new.manage_models')}
                      <ArrowRight size={15} />
                    </Link>
                  )}
                </>
              )}
            </form.Subscribe>
            <ErrorNotice error={models.error} />
          </section>
        </div>
        <aside className="arena-create-summary arena-panel">
          <div className="arena-eyebrow">MATCH BRIEF</div>
          <h2>{t('new.summary')}</h2>
          <form.Subscribe selector={(s) => s.values}>
            {(values) => (
              <>
                <dl>
                  <div>
                    <dt>{t('new.game')}</dt>
                    <dd>{gameName(values.gameId)}</dd>
                  </div>
                  <div>
                    <dt>{t('new.mode')}</dt>
                    <dd>{t(`mode.${values.mode}`)}</dd>
                  </div>
                  <div>
                    <dt>{t('new.visibility')}</dt>
                    <dd>
                      <Shield size={13} />
                      {t('private')}
                    </dd>
                  </div>
                </dl>
                <div className="arena-summary-rules">
                  <CircleHelp size={18} />
                  <p>{t(`game.${values.gameId}.rules`)}</p>
                </div>
                <ErrorNotice error={mutation.error} />
                <SubmitButton
                  type="submit"
                  pending={mutation.isPending}
                  disabled={
                    (!!clone && !source.data) ||
                    (values.mode === 'ai-ai' &&
                      (!playableModels.some(
                        (model) => model.id === values.profile0
                      ) ||
                        !playableModels.some(
                          (model) => model.id === values.profile1
                        ))) ||
                    (values.mode === 'human-ai' &&
                      !playableModels.some(
                        (model) =>
                          model.id ===
                          (values.humanSeat === '0'
                            ? values.profile1
                            : values.profile0)
                      ))
                  }
                >
                  {t('new.create')}
                  <ArrowRight size={17} />
                </SubmitButton>
                <p className="arena-field-help">{t('new.limits')}</p>
              </>
            )}
          </form.Subscribe>
        </aside>
      </form>
    </>
  );
}
