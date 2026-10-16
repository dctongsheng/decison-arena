import { BrainCircuit, ChevronDown, LockKeyhole } from 'lucide-react';

import type { ReasoningPresentation } from '@/lib/arena-reasoning';

export interface ReasoningLabels {
  title: string;
  returned: string;
  restricted: string;
  disabled: string;
  notUsed: string;
  missing: string;
  missingUsed: string;
  history: string;
  truncated: string;
}

/** Only plain provider text is rendered; hidden identities never enter the DOM. */
export function DecisionReasoning({
  presentation,
  labels,
  compact = false,
}: {
  presentation: ReasoningPresentation;
  labels: ReasoningLabels;
  compact?: boolean;
}) {
  const description =
    presentation.kind === 'returned'
      ? labels.returned
      : presentation.kind === 'restricted'
        ? labels.restricted
        : presentation.kind === 'disabled'
          ? labels.disabled
          : presentation.kind === 'not-used'
            ? labels.notUsed
            : presentation.kind === 'missing-used'
              ? labels.missingUsed
              : labels.missing;
  return (
    <details
      className={compact ? 'arena-reasoning compact' : 'arena-reasoning'}
    >
      <summary>
        {presentation.kind === 'restricted' ? (
          <LockKeyhole size={14} aria-hidden="true" />
        ) : (
          <BrainCircuit size={14} aria-hidden="true" />
        )}
        <span>
          {labels.title}
          <small>{description}</small>
        </span>
        <ChevronDown
          className="arena-reasoning-chevron"
          size={14}
          aria-hidden="true"
        />
      </summary>
      <div className="arena-reasoning-content">
        {presentation.kind === 'returned' ? (
          <>
            <pre className="arena-reasoning-text">{presentation.text}</pre>
            {presentation.truncated && (
              <p className="arena-reasoning-notice">{labels.truncated}</p>
            )}
          </>
        ) : (
          <>
            <p>{description}</p>
            {(presentation.kind === 'missing' ||
              presentation.kind === 'missing-used') && (
              <p className="arena-reasoning-notice">{labels.history}</p>
            )}
          </>
        )}
      </div>
    </details>
  );
}
