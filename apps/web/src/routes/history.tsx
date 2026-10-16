import { createFileRoute } from '@tanstack/react-router';

import { HistoryPage } from '@/blocks/arena/records-community';

export const Route = createFileRoute('/history')({ component: HistoryPage });
