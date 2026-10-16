import { createFileRoute } from '@tanstack/react-router';

import { ModelsPage } from '@/blocks/arena/models';

export const Route = createFileRoute('/models')({ component: ModelsPage });
