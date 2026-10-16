import { createFileRoute } from '@tanstack/react-router';

import { ArcadeRoomPage } from '@/blocks/arcade/session-room';

export const Route = createFileRoute('/arcade/$id')({ component: Page });
function Page() {
  const { id } = Route.useParams();
  return <ArcadeRoomPage id={id} />;
}
