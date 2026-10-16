import type { ReactNode } from 'react';

import { ArenaShell, AuthGate } from './shared';

export function ArenaSettingsShell({ children }: { children: ReactNode }) {
  return (
    <ArenaShell>
      <AuthGate>
        <div className="arena-account-settings">{children}</div>
      </AuthGate>
    </ArenaShell>
  );
}
