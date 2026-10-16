import { createFileRoute } from '@tanstack/react-router';

import { CreateMatchPage } from '@/blocks/arena/create-match';

export const Route = createFileRoute('/new')({
  validateSearch: (search: Record<string, unknown>) => ({
    game: typeof search.game === 'string' ? search.game : undefined,
    clone: typeof search.clone === 'string' ? search.clone : undefined,
  }),
  component: Page,
});
function Page() {
  const { game, clone } = Route.useSearch();
  return <CreateMatchPage game={game} clone={clone} />;
}
