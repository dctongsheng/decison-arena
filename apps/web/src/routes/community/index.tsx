import { createFileRoute } from '@tanstack/react-router';

import { CommunityPage } from '@/blocks/arena/records-community';

export const Route = createFileRoute('/community/')({
  component: CommunityPage,
});
