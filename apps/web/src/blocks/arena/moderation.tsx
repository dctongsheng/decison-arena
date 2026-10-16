import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Flag, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';

import { useSession } from '@/core/auth/client';
import { Link } from '@/core/i18n/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

import {
  ArenaShell,
  AuthGate,
  EmptyState,
  ErrorNotice,
  formatDate,
  Loading,
  PageHeading,
  t,
} from './shared';

interface Report {
  id: string;
  publicationId: string;
  title: string;
  reason: string;
  status: string;
  reporterName: string;
  createdAt: number;
}
export function ModerationPage() {
  return (
    <ArenaShell>
      <AuthGate>
        <ModerationContent />
      </AuthGate>
    </ArenaShell>
  );
}
function ModerationContent() {
  const { data: session } = useSession();
  const client = useQueryClient();
  const [confirm, setConfirm] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['arena-reports', session?.user?.id],
    queryFn: () => apiGet<{ items: Report[] }>('/api/arena/community/reports'),
  });
  const mutation = useMutation({
    mutationFn: (report: Report) =>
      apiPost(`/api/arena/community/${report.publicationId}`, {
        action: 'moderate',
        reason: report.reason,
      }),
    onSuccess: () => {
      setConfirm(null);
      client.invalidateQueries({
        queryKey: ['arena-reports', session?.user?.id],
      });
      client.invalidateQueries({ queryKey: ['arena-community'] });
      toast.success(t('moderation.removed'));
    },
  });
  return (
    <>
      <PageHeading
        eyebrow="COMMUNITY MODERATION"
        title={t('moderation.title')}
        description={t('moderation.description')}
      />
      <ErrorNotice error={query.error || mutation.error} />
      {query.isPending ? (
        <Loading />
      ) : query.data?.items.length ? (
        <div className="arena-moderation-list">
          {query.data.items.map((report) => (
            <article className="arena-panel arena-report-card" key={report.id}>
              <div>
                <span className="arena-icon-box">
                  <Flag size={20} />
                </span>
                <div>
                  <span className="arena-caption">
                    {report.reporterName} · {formatDate(report.createdAt)}
                  </span>
                  <h2>{report.title}</h2>
                </div>
              </div>
              <p>{report.reason}</p>
              <footer>
                <span className="arena-tag">{report.status}</span>
                <Link
                  href={`/community/${report.publicationId}`}
                  className="arena-text-link"
                >
                  {t('moderation.review')}
                  <ArrowRight size={15} />
                </Link>
                {confirm === report.id ? (
                  <>
                    <Button
                      variant="destructive"
                      disabled={mutation.isPending}
                      onClick={() => mutation.mutate(report)}
                    >
                      {t('confirm')}
                    </Button>
                    <Button variant="ghost" onClick={() => setConfirm(null)}>
                      {t('cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => setConfirm(report.id)}
                  >
                    <ShieldCheck size={15} />
                    {t('community.moderate')}
                  </Button>
                )}
              </footer>
            </article>
          ))}
        </div>
      ) : (
        !query.error && (
          <EmptyState
            title={t('moderation.empty')}
            description={t('moderation.empty_description')}
          />
        )
      )}
    </>
  );
}
