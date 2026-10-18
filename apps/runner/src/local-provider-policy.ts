import { isCanonicalLocalEndpoint, type ProviderRuntimeOptions } from '@decision-arena/providers';

/** Server bindings only: no request/profile fields may widen endpoint access.
 * Even a stored development profile is denied once LOCAL_DEV is disabled. */
export function localProviderOptions(env: {
  LOCAL_DEV?: string;
  ARENA_LOCAL_PROVIDER_ENDPOINTS?: string;
}): ProviderRuntimeOptions {
  if(env.LOCAL_DEV!=='true' || !env.ARENA_LOCAL_PROVIDER_ENDPOINTS) return {};
  const invalid=()=>new Error('Invalid ARENA_LOCAL_PROVIDER_ENDPOINTS configuration');
  if(env.ARENA_LOCAL_PROVIDER_ENDPOINTS.length>65_536) throw invalid();
  let endpoints: unknown;
  try { endpoints=JSON.parse(env.ARENA_LOCAL_PROVIDER_ENDPOINTS); } catch { throw invalid(); }
  if(!Array.isArray(endpoints) || endpoints.length>32 ||
    endpoints.some(endpoint=>typeof endpoint!=='string'||!isCanonicalLocalEndpoint(endpoint))) throw invalid();
  return {localEndpoints:Object.freeze([...new Set(endpoints as string[])])};
}
