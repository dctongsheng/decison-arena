import { createFileRoute } from '@tanstack/react-router';

import { CreateArcadePage } from '@/blocks/arcade/create-session';

export const Route = createFileRoute('/arcade/new')({
  validateSearch: (search: Record<string, unknown>) => ({
    game: typeof search.game === 'string' ? search.game : undefined,
    clone: typeof search.clone === 'string' ? search.clone : undefined,
  }),
  component: Page,
});
function Page() {
  const { game, clone } = Route.useSearch();
  return <CreateArcadePage game={game} clone={clone} />;
}
