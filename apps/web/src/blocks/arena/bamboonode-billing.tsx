import { m } from '@/paraglide/messages.js';

import { BAMBOONODE_ACCOUNT_URL, isBambooJev } from './model-errors';

export function BambooAccountLink() {
  return (
    <a
      href={BAMBOONODE_ACCOUNT_URL}
      target="_blank"
      rel="noreferrer"
      className="arena-text-link"
    >
      {m['arena.bamboo.top_up']()}
    </a>
  );
}

export function BambooJevNotice({
  profile,
}: {
  profile?: { provider?: string };
}) {
  if (!isBambooJev(profile)) return null;
  return (
    <p className="arena-field-help arena-bamboo-billing">
      {m['arena.bamboo.jev_paid']()} <BambooAccountLink />
    </p>
  );
}
