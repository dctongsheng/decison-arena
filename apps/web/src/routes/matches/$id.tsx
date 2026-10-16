import { createFileRoute } from '@tanstack/react-router';

import { MatchRoomPage } from '@/blocks/arena/match-room';

export const Route = createFileRoute('/matches/$id')({ component: Page });
function Page() {
  const { id } = Route.useParams();
  return <MatchRoomPage id={id} />;
}
