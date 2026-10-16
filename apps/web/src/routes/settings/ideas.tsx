import { createFileRoute } from '@tanstack/react-router';

import { m } from '@/paraglide/messages.js';
import { IdeasBoard } from '@/blocks/ideas-board';

function IdeasPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{m['settings.ideas.title']()}</h1>
        <p className="text-muted-foreground">
          {m['settings.ideas.description']()}
        </p>
      </div>
      <IdeasBoard scope="feed" />
    </div>
  );
}

export const Route = createFileRoute('/settings/ideas')({
  component: IdeasPage,
});
