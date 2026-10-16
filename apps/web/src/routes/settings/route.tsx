import { createFileRoute, Outlet } from '@tanstack/react-router';

import { ArenaSettingsShell } from '@/blocks/arena/settings-shell';

export const Route = createFileRoute('/settings')({
  component: SettingsLayout,
});
function SettingsLayout() {
  return (
    <ArenaSettingsShell>
      <Outlet />
    </ArenaSettingsShell>
  );
}
