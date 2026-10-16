import { createFileRoute } from '@tanstack/react-router';

import { ModerationPage } from '@/blocks/arena/moderation';

export const Route = createFileRoute('/moderation')({
  component: ModerationPage,
});
