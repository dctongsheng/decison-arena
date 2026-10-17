import { useState } from 'react';
import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CheckCircle2,
  FlaskConical,
  KeyRound,
  LockKeyhole,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { apiDelete, apiPost } from '@/lib/api-client';
import { m } from '@/paraglide/messages.js';
import { TextField } from '@/components/form-field';
import { Button } from '@/components/ui/button';

import { canEditModel } from './bamboonode-access';
import { BambooModelConnection } from './bamboonode-connection';
import {
  ArenaShell,
  AuthGate,
  EmptyState,
  ErrorNotice,
  Loading,
  PageHeading,
  SubmitButton,
  t,
  useModels,
} from './shared';

const defaults = {
  name: '',
  provider: 'openrouter',
  model: 'typesafe/jev-1.13',
  endpoint: 'https://openrouter.ai/api/alpha/decisions',
  apiKey: '',
  thinkMode: 'always',
  thinkBudget: 4096,
};
export function ModelsPage() {
  return (
    <ArenaShell>
      <AuthGate>
        <BambooModelConnection />
        <ModelsContent />
      </AuthGate>
    </ArenaShell>
  );
}
function ModelsContent() {
  const query = useModels();
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | undefined>();
  const [tested, setTested] = useState<string | null>(null);
  const [testInfo, setTestInfo] = useState<{
    actualModel?: string;
    elapsedMs: number;
  } | null>(null);
  const form = useForm({
    defaultValues: defaults,
    validators: {
      onSubmit: z.object({
        name: z.string().min(1),
        provider: z.string(),
        model: z.string(),
        endpoint: z.url(),
        apiKey: z.string(),
        thinkMode: z.string(),
        thinkBudget: z.number().int().min(128).max(16384),
      }),
    },
    onSubmit: async ({ value }) => {
      if (tested !== JSON.stringify({ value, id: editId }))
        throw new Error(t('models.test_first'));
      await save.mutateAsync(value);
    },
  });
  const save = useMutation({
    mutationFn: (value: typeof defaults) =>
      apiPost('/api/arena/models', {
        ...value,
        id: editId,
        apiKey: value.apiKey || undefined,
        ...(!value.provider.includes('systemone')
          ? { thinkMode: 'never' }
          : {}),
      }),
    onSuccess: () => {
      form.reset();
      setOpen(false);
      setEditId(undefined);
      setTestInfo(null);
      setTested(null);
      client.invalidateQueries({ queryKey: ['arena-models'] });
      toast.success(t('models.saved'));
    },
  });
  const test = useMutation({
    mutationFn: ({ value, id }: { value: typeof defaults; id?: string }) =>
      apiPost<{ actualModel?: string; elapsedMs: number }>(
        '/api/arena/models/test',
        {
          ...value,
          id,
          apiKey: value.apiKey || undefined,
          ...(!value.provider.includes('systemone')
            ? { thinkMode: 'never' }
            : {}),
        }
      ),
    onSuccess: (result, input) => {
      setTested(JSON.stringify(input));
      setTestInfo(result);
    },
    onError: () => {
      setTested(null);
      setTestInfo(null);
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/arena/models?id=${encodeURIComponent(id)}`),
    onSuccess: () => {
      setDeleteId(null);
      client.invalidateQueries({ queryKey: ['arena-models'] });
      toast.success(t('models.deleted'));
    },
  });
  return (
    <>
      <PageHeading
        eyebrow="MODEL CONNECTIONS"
        title={t('models.title')}
        description={t('models.description')}
        action={
          <Button
            className="arena-button"
            onClick={() => {
              setOpen(true);
              setEditId(undefined);
              form.reset(defaults);
              setTested(null);
              setTestInfo(null);
              save.reset();
              test.reset();
            }}
          >
            <Plus size={17} />
            {t('models.add')}
          </Button>
        }
      />
      <div className="arena-security-banner">
        <ShieldCheck size={21} />
        <div>
          <strong>{t('models.vault_title')}</strong>
          <p>{t('models.vault_description')}</p>
        </div>
        <span>AES-GCM</span>
      </div>
      <ErrorNotice error={query.error || remove.error} />
      {open && (
        <section className="arena-panel arena-model-form">
          <div className="arena-panel-heading">
            <h2>{t(editId ? 'models.edit' : 'models.add')}</h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('close')}
              onClick={() => setOpen(false)}
            >
              <X size={19} />
            </Button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void form.handleSubmit();
            }}
          >
            <div className="arena-form-grid">
              <form.Field name="name">
                {(field) => (
                  <TextField
                    field={field}
                    label={t('models.name')}
                    placeholder={t('models.name_placeholder')}
                    required
                  />
                )}
              </form.Field>
              <form.Field name="provider">
                {(field) => (
                  <label className="arena-field">
                    <span>{t('models.provider')}</span>
                    <select
                      value={field.state.value}
                      onChange={(e) => {
                        const v = e.target.value;
                        field.handleChange(v);
                        form.setFieldValue(
                          'endpoint',
                          v === 'openrouter'
                            ? defaults.endpoint
                            : v === 'systemone'
                              ? 'https://startlux-decision.com/v1/systemone'
                              : ''
                        );
                        form.setFieldValue(
                          'model',
                          v.includes('openrouter') ? defaults.model : ''
                        );
                        setTested(null);
                        setTestInfo(null);
                      }}
                    >
                      <option value="openrouter">OpenRouter Decisions</option>
                      <option value="systemone">StartLux System One</option>
                      <option value="custom-openrouter">
                        {t('models.custom_openrouter')}
                      </option>
                      <option value="custom-systemone">
                        {t('models.custom_systemone')}
                      </option>
                    </select>
                  </label>
                )}
              </form.Field>
              <form.Field name="model">
                {(field) => (
                  <TextField
                    field={field}
                    label={t('models.model')}
                    placeholder="typesafe/jev-1.13"
                  />
                )}
              </form.Field>
              <form.Field name="endpoint">
                {(field) => (
                  <TextField
                    field={field}
                    label={t('models.endpoint')}
                    placeholder="https://…"
                    type="url"
                    required
                  />
                )}
              </form.Field>
              <div className="arena-form-wide">
                <form.Field name="apiKey">
                  {(field) => (
                    <TextField
                      field={field}
                      label={t('models.key')}
                      placeholder="sk-…"
                      type="password"
                      autoComplete="off"
                      required={!editId}
                    />
                  )}
                </form.Field>
                <p className="arena-field-help">
                  {t(editId ? 'models.key_keep' : 'models.key_help')}
                </p>
              </div>
              <form.Subscribe selector={(s) => s.values.provider}>
                {(provider) =>
                  provider.includes('systemone') && (
                    <>
                      <form.Field name="thinkMode">
                        {(field) => (
                          <label className="arena-field">
                            <span>{t('models.think_mode')}</span>
                            <select
                              value={field.state.value}
                              onChange={(e) =>
                                field.handleChange(e.target.value)
                              }
                            >
                              <option value="always">
                                {t('models.think_always')}
                              </option>
                              <option value="auto">
                                {t('models.think_auto')}
                              </option>
                              <option value="never">
                                {t('models.think_never')}
                              </option>
                            </select>
                          </label>
                        )}
                      </form.Field>
                      <form.Field name="thinkBudget">
                        {(field) => (
                          <label className="arena-field">
                            <span>{t('models.think_budget')}</span>
                            <input
                              type="number"
                              min={128}
                              max={16384}
                              value={field.state.value}
                              onChange={(e) =>
                                field.handleChange(Number(e.target.value))
                              }
                            />
                          </label>
                        )}
                      </form.Field>
                    </>
                  )
                }
              </form.Subscribe>
            </div>
            <ErrorNotice error={test.error || save.error} />
            {testInfo && (
              <div className="arena-test-result">
                <CheckCircle2 size={18} />
                {t('models.connected')} ·{' '}
                {testInfo.actualModel || t('not_returned')} ·{' '}
                {(testInfo.elapsedMs / 1000).toFixed(2)}s
              </div>
            )}
            <div className="arena-form-actions">
              <Button
                type="button"
                variant="outline"
                className="arena-button secondary"
                disabled={test.isPending || save.isPending}
                onClick={() =>
                  test.mutate({ value: { ...form.state.values }, id: editId })
                }
              >
                <FlaskConical size={17} />
                {test.isPending ? t('models.testing') : t('models.test')}
              </Button>
              <form.Subscribe selector={(s) => s.values}>
                {(values) => (
                  <SubmitButton
                    pending={save.isPending}
                    type="submit"
                    disabled={
                      tested !== JSON.stringify({ value: values, id: editId })
                    }
                  >
                    <LockKeyhole size={17} />
                    {t('models.save')}
                  </SubmitButton>
                )}
              </form.Subscribe>
            </div>
            <p className="arena-field-help">{t('models.test_note')}</p>
          </form>
        </section>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="arena-model-grid">
          {query.data.items.map((model) => (
            <article className="arena-panel arena-model-card" key={model.id}>
              <div className="arena-model-card-top">
                <span className="arena-icon-box">
                  <KeyRound size={22} />
                </span>
                <span className="arena-tag">
                  {model.source === 'bamboonode'
                    ? m['arena.bamboo.model_source']()
                    : model.provider}
                </span>
              </div>
              <h3>{model.name}</h3>
              <p className="arena-model-id">{model.model || 'System One'}</p>
              <dl>
                <div>
                  <dt>
                    {model.source === 'bamboonode'
                      ? m['arena.bamboo.billing']()
                      : t('models.credential')}
                  </dt>
                  <dd>
                    <LockKeyhole size={12} />
                    {model.source === 'bamboonode'
                      ? m['arena.bamboo.own_quota']()
                      : model.keyMask || '••••••••'}
                  </dd>
                </div>
                <div>
                  <dt>{t('models.think_mode')}</dt>
                  <dd>
                    {model.provider.includes('systemone')
                      ? t(`models.think_${model.thinkMode || 'always'}`)
                      : t('models.provider_managed')}
                  </dd>
                </div>
              </dl>
              {!canEditModel(model) && (
                <p className="arena-field-help">
                  {m['arena.bamboo.managed_profile']()}
                </p>
              )}
              <div className="arena-model-card-footer">
                {deleteId === model.id ? (
                  <>
                    <span>{t('models.delete_confirm')}</span>
                    <Button
                      variant="destructive"
                      size="sm"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(model.id)}
                    >
                      {t('confirm')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteId(null)}
                    >
                      {t('cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <span>
                      <span className="arena-dot" />
                      {model.available === false
                        ? m['arena.bamboo.model_unavailable']()
                        : t('models.ready')}
                    </span>
                    {canEditModel(model) && (
                      <div className="arena-model-card-tools">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('models.edit')}
                          onClick={() => {
                            setOpen(true);
                            setEditId(model.id);
                            form.reset({
                              ...defaults,
                              name: model.name,
                              provider: model.provider,
                              model: model.model,
                              endpoint: model.endpoint,
                              thinkMode: model.thinkMode || 'always',
                              thinkBudget: model.thinkBudget || 4096,
                            });
                            setTested(null);
                            setTestInfo(null);
                            save.reset();
                            test.reset();
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          <Pencil size={15} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t('models.delete')}
                          onClick={() => setDeleteId(model.id)}
                        >
                          <Trash2 size={16} />
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        !open && (
          <EmptyState
            title={t('models.empty')}
            description={t('models.empty_description')}
          />
        )
      )}
      <div className="arena-note">
        <LockKeyhole size={18} />
        <p>{t('models.endpoint_note')}</p>
      </div>
    </>
  );
}
