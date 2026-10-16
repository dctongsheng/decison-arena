import { ChevronUp, Lock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

export interface IdeaItemProps {
  content: string;
  authorLabel: string;
  authorAvatar?: string | null;
  statusLabel: string;
  statusVariant: 'default' | 'secondary' | 'outline' | 'destructive';
  timeLabel: string;
  voteCount: number;
  hasVoted: boolean;
  voteLabel: string;
  onVote: () => void;
  voteDisabled?: boolean;
  adminNote?: string | null;
  adminNoteLabel?: string;
  /** Rendered only when the idea is hidden from the public board. */
  privateLabel?: string | null;
}

/**
 * One row of the ideas board.
 *
 * All user-authored text (`content`, `adminNote`) is rendered as a plain JSX
 * text child — never as markup. Do not route it through a markdown renderer
 * or `dangerouslySetInnerHTML`.
 */
export function IdeaItem({
  content,
  authorLabel,
  authorAvatar,
  statusLabel,
  statusVariant,
  timeLabel,
  voteCount,
  hasVoted,
  voteLabel,
  onVote,
  voteDisabled,
  adminNote,
  adminNoteLabel,
  privateLabel,
}: IdeaItemProps) {
  return (
    <div className="flex gap-4 py-4">
      <button
        type="button"
        onClick={onVote}
        disabled={voteDisabled}
        aria-pressed={hasVoted}
        aria-label={voteLabel}
        title={voteLabel}
        className={cn(
          'flex h-fit min-w-12 shrink-0 flex-col items-center gap-0.5 rounded-lg border px-2 py-1.5 transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-60',
          hasVoted
            ? 'border-primary bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
        )}
      >
        <ChevronUp className={cn('size-4', hasVoted && 'stroke-[2.5]')} />
        <span className="text-sm leading-none font-semibold tabular-nums">
          {voteCount}
        </span>
      </button>

      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {content}
        </p>

        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Badge variant={statusVariant}>{statusLabel}</Badge>
          {privateLabel ? (
            <Badge variant="outline" className="gap-1">
              <Lock className="size-3" />
              {privateLabel}
            </Badge>
          ) : null}
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5">
            <Avatar className="size-4">
              <AvatarImage src={authorAvatar || undefined} />
              <AvatarFallback className="text-[9px]">
                {authorLabel.replace(/^@/, '').charAt(0).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            {authorLabel}
          </span>
          <span aria-hidden>·</span>
          <span>{timeLabel}</span>
        </div>

        {adminNote ? (
          <div className="bg-muted text-muted-foreground rounded-md p-2 text-xs">
            {adminNoteLabel ? (
              <span className="text-foreground font-semibold">
                {adminNoteLabel}
                {': '}
              </span>
            ) : null}
            <span className="break-words whitespace-pre-wrap">{adminNote}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
