import { useQuery } from '@tanstack/react-query';

import { apiGet } from '@/lib/api-client';

export type PublicConfig = Partial<
  Record<
    | 'app_name'
    | 'app_description'
    | 'app_logo'
    | 'email_auth_enabled'
    | 'google_auth_enabled'
    | 'google_one_tap_enabled'
    | 'google_client_id'
    | 'github_auth_enabled'
    | 'invite_code_required'
    | 'desktop_auth_schemes'
    | 'select_payment_enabled'
    | 'default_payment_provider'
    | 'stripe_enabled'
    | 'creem_enabled'
    | 'paypal_enabled'
    | 'alipay_enabled'
    | 'wechat_enabled'
    | 'google_analytics_id'
    | 'plausible_domain'
    | 'plausible_src'
    | 'password_reset_enabled'
    | 'email_verification_enabled'
    | 'bamboonode_account_url',
    string
  >
> & {
  auth_mode?: 'local' | 'bamboonode';
  bamboonode_auth_ready?: boolean;
  bamboonode_scope_upgrade_required?: boolean;
};

// Public runtime config (auth methods, social login ids, …) — shared by
// sign-in/sign-up/forgot-password/google-one-tap/pricing. Deduped and
// cached by react-query.
export function usePublicConfig() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: () =>
      apiGet<PublicConfig>('/api/config/public', { cache: 'no-store' }),
    staleTime: 0,
  });
}
