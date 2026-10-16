import { createFileRoute } from '@tanstack/react-router';

import { LobbyPage } from '@/blocks/arena/lobby';

export const Route = createFileRoute('/')({ component: LobbyPage });
