import { useEffect, useState } from 'react';
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { tDynamic } from '@/core/i18n/dynamic';
import { apiDelete, apiGet, apiPatch, type PageResult } from '@/lib/api-client';
import { formatDateTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { m } from '@/paraglide/messages.js';
import { DataTable, type Column } from '@/components/data-table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

type IdeaStatus = 'pending' | 'planned' | 'in_progress' | 'done' | 'declined';

const STATUSES: IdeaStatus[] = [
  'pending',
  'planned',
  'in_progress',
  'done',
  'declined',
];

type Tab = 'all' | IdeaStatus;
const TABS: Tab[] = ['all', ...STATUSES];

const STATUS_BADGE: Record<
  IdeaStatus,
  'default' | 'secondary' | 'outline' | 'destructive'
> = {
  pending: 'outline',
  planned: 'secondary',
  in_progress: 'default',
  done: 'secondary',
  declined: 'destructive',
};

const PAGE_SIZE = 20;
const NOTE_MAX = 1000;

interface IdeaRow {
  id: string;
  content: string;
  status: IdeaStatus;
  isPublic: boolean;
  voteCount: number;
  adminNote: string | null;
  createdAt: string;
  updatedAt: string;
  userName: string | null;
  userEmail: string | null;
  userAvatar: string | null;
}

function AdminIdeasPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [tab, setTab] = useState<Tab>('all');
  const [visibility, setVisibility] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Edit dialog
  const [editing, setEditing] = useState<IdeaRow | null>(null);
  const [status, setStatus] = useState<IdeaStatus>('pending');
  const [isPublic, setIsPublic] = useState(true);
  const [adminNote, setAdminNote] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, tab, visibility]);

  const listQuery = useQuery({
    queryKey: ['admin-ideas', page, tab, visibility, debouncedSearch],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: String(PAGE_SIZE),
      });
      if (tab !== 'all') params.set('status', tab);
      if (visibility !== 'all') params.set('visibility', visibility);
      if (debouncedSearch) params.set('keyword', debouncedSearch);
      return apiGet<PageResult<IdeaRow>>(`/api/admin/ideas?${params}`);
    },
    placeholderData: keepPreviousData,
  });

  const refreshList = () =>
    queryClient.invalidateQueries({ queryKey: ['admin-ideas'] });

  const saveMutation = useMutation({
    mutationFn: (vars: {
      id: string;
      status: IdeaStatus;
      isPublic: boolean;
      adminNote: string;
    }) =>
      apiPatch(`/api/admin/ideas/${vars.id}`, {
        status: vars.status,
        isPublic: vars.isPublic,
        adminNote: vars.adminNote,
      }),
    onSuccess: () => {
      toast.success(m['admin.ideas.save_success']());
      setEditing(null);
      refreshList();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiDelete(`/api/admin/ideas/${id}`),
    onSuccess: () => {
      toast.success(m['admin.ideas.delete_success']());
      setEditing(null);
      refreshList();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function openEdit(row: IdeaRow) {
    setEditing(row);
    setStatus(row.status);
    setIsPublic(row.isPublic);
    setAdminNote(row.adminNote ?? '');
  }

  // Base UI's SelectValue shows the raw value, so triggers need explicit labels.
  const VISIBILITY_LABEL: Record<string, string> = {
    all: m['admin.ideas.visibility_all'](),
    public: m['admin.ideas.public'](),
    private: m['admin.ideas.private'](),
  };

  const columns: Column<IdeaRow>[] = [
    {
      header: m['admin.ideas.created_col'](),
      className: 'w-[160px]',
      cell: (r) => (
        <span className="text-muted-foreground">
          {formatDateTime(r.createdAt)}
        </span>
      ),
    },
    {
      header: m['admin.ideas.content_col'](),
      cell: (r) => (
        <button
          className="block max-w-[360px] truncate text-left font-medium hover:underline"
          onClick={() => openEdit(r)}
        >
          {r.content}
        </button>
      ),
    },
    {
      header: m['admin.ideas.user_col'](),
      cell: (r) => (
        <div className="flex items-center gap-2">
          <Avatar className="size-7">
            <AvatarImage src={r.userAvatar || undefined} />
            <AvatarFallback className="text-xs">
              {(r.userName || 'U').charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="flex flex-col">
            <span>{r.userName || '—'}</span>
            <span className="text-muted-foreground text-xs">{r.userEmail}</span>
          </div>
        </div>
      ),
    },
    {
      header: m['admin.ideas.votes_col'](),
      className: 'w-[80px]',
      cell: (r) => <span className="tabular-nums">{r.voteCount}</span>,
    },
    {
      header: m['admin.ideas.status_col'](),
      className: 'w-[120px]',
      cell: (r) => (
        <Badge variant={STATUS_BADGE[r.status] ?? 'outline'}>
          {tDynamic(`admin.ideas.status_${r.status}`)}
        </Badge>
      ),
    },
    {
      header: m['admin.ideas.visibility_col'](),
      className: 'w-[100px]',
      cell: (r) => (
        <Badge variant={r.isPublic ? 'secondary' : 'outline'}>
          {r.isPublic ? m['admin.ideas.public']() : m['admin.ideas.private']()}
        </Badge>
      ),
    },
    {
      header: m['admin.ideas.actions_col'](),
      className: 'w-[80px]',
      cell: (r) => (
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => openEdit(r)}
        >
          <Pencil className="size-4" />
        </Button>
      ),
    },
  ];

  const busy = saveMutation.isPending || deleteMutation.isPending;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{m['admin.ideas.title']()}</h1>
        <p className="text-muted-foreground">
          {m['admin.ideas.description']()}
        </p>
      </div>

      <div className="border-border flex gap-1 overflow-x-auto overflow-y-hidden border-b">
        {TABS.map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors',
              tab === tb
                ? 'border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground border-transparent'
            )}
          >
            {tDynamic(`admin.ideas.tab_${tb}`)}
          </button>
        ))}
      </div>

      <Card>
        <CardContent>
          <DataTable
            columns={columns}
            data={listQuery.data?.items ?? []}
            total={listQuery.data?.total ?? 0}
            page={page}
            pageSize={PAGE_SIZE}
            onPageChange={setPage}
            rowKey={(r) => r.id}
            emptyText={m['admin.ideas.empty']()}
            search={search}
            onSearchChange={setSearch}
            onRefresh={() => listQuery.refetch()}
            loading={listQuery.isFetching}
            toolbar={
              <Select
                value={visibility}
                onValueChange={(v) => setVisibility(v || 'all')}
              >
                <SelectTrigger className="h-8 w-[120px]">
                  {/* Base UI renders the raw value unless given a formatter. */}
                  <SelectValue>
                    {(v) => VISIBILITY_LABEL[v as string] ?? String(v)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">
                    {m['admin.ideas.visibility_all']()}
                  </SelectItem>
                  <SelectItem value="public">
                    {m['admin.ideas.public']()}
                  </SelectItem>
                  <SelectItem value="private">
                    {m['admin.ideas.private']()}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </CardContent>
      </Card>

      <Dialog
        open={!!editing}
        onOpenChange={(open) => {
          if (!open && !busy) setEditing(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{m['admin.ideas.edit_title']()}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <p className="bg-muted rounded-md p-3 text-sm break-words whitespace-pre-wrap">
              {editing?.content}
            </p>

            <div className="space-y-1.5">
              <Label>{m['admin.ideas.status_label']()}</Label>
              <Select
                value={status}
                onValueChange={(v) => v && setStatus(v as IdeaStatus)}
              >
                <SelectTrigger>
                  <SelectValue>
                    {(v) => tDynamic(`admin.ideas.status_${v}`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {tDynamic(`admin.ideas.status_${s}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="idea-visibility">
                {m['admin.ideas.visibility_label']()}
              </Label>
              <Switch
                id="idea-visibility"
                checked={isPublic}
                onCheckedChange={setIsPublic}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{m['admin.ideas.admin_note_label']()}</Label>
              <Textarea
                value={adminNote}
                onChange={(e) => setAdminNote(e.target.value)}
                placeholder={m['admin.ideas.admin_note_placeholder']()}
                maxLength={NOTE_MAX}
                rows={3}
                className="resize-none"
              />
            </div>
          </div>

          <DialogFooter className="sm:justify-between">
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => {
                if (!editing) return;
                if (!confirm(m['admin.ideas.delete_confirm']())) return;
                deleteMutation.mutate(editing.id);
              }}
            >
              <Trash2 className="size-4" />
              {m['admin.ideas.delete']()}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setEditing(null)}
              >
                {m['admin.ideas.cancel']()}
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  if (!editing) return;
                  saveMutation.mutate({
                    id: editing.id,
                    status,
                    isPublic,
                    adminNote,
                  });
                }}
              >
                {saveMutation.isPending
                  ? m['admin.ideas.saving']()
                  : m['admin.ideas.save']()}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export const Route = createFileRoute('/admin/ideas')({
  component: AdminIdeasPage,
});
