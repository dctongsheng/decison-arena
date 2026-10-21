/** Operator-only opt-in for the loopback Node production wrapper.
 * Workers may expose process through nodejs_compat, so process alone cannot
 * authorize the local transport. Worker bindings/runtime markers fail closed. */
export function isLocalProduction(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.env.NODE_ENV === 'production' &&
    process.env.ARENA_LOCAL_PRODUCTION === 'true' &&
    process.release?.name === 'node' &&
    typeof process.versions?.node === 'string' &&
    !('Cloudflare' in globalThis) &&
    !('WebSocketPair' in globalThis) &&
    !('__CF_ENV__' in globalThis) &&
    !('__env__' in globalThis) &&
    !(typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers')
  );
}
