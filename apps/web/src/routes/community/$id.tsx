import { createFileRoute } from '@tanstack/react-router';

import { CommunityDetailPage } from '@/blocks/arena/records-community';

export const Route = createFileRoute('/community/$id')({ component: Page });
function Page() {
  const { id } = Route.useParams();
  return <CommunityDetailPage id={id} />;
}
