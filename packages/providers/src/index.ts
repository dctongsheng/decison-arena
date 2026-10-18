import type { BambooNodeProviderId, DecisionRequest, DecisionResponse, ModelProfile, ProviderId, ProviderAdapter } from '@decision-arena/core';
import { BAMBOONODE_INSUFFICIENT_QUOTA } from '@decision-arena/core';

export const ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/alpha/decisions', systemone: 'https://startlux-decision.com/v1/systemone',
  'bamboonode-systemone': 'https://api.bamboonode.dev/v1/decisions',
  'bamboonode-decisions': 'https://api.bamboonode.dev/jev/v1/decisions',
} as const;
export const BAMBOONODE_MODELS: Readonly<Record<BambooNodeProviderId, readonly string[]>> = {
  'bamboonode-systemone': ['startlux-decision-27b-autothink'],
  'bamboonode-decisions': ['typesafe/jev-1.13', 'typesafe/jev-1.14'],
};
export function isBambooNodeProvider(provider: string): provider is BambooNodeProviderId {
  return provider === 'bamboonode-systemone' || provider === 'bamboonode-decisions';
}
/** Explicit request-model capabilities, not aliases inferred from response metadata. */
export function supportsDecisionImages(profile: Pick<ModelProfile, 'provider' | 'model'>): boolean {
  if (profile.provider === 'systemone' || profile.provider === 'custom-systemone' || profile.provider === 'bamboonode-systemone') return true;
  return (profile.provider === 'openrouter' || profile.provider === 'custom-openrouter' || profile.provider === 'bamboonode-decisions') &&
    (profile.model === 'typesafe/jev-1.13' || profile.model === 'typesafe/jev-1.14');
}
const encoder = new TextEncoder();
export const MAX_REASONING_CHARACTERS = 16_384;
function b64(bytes: Uint8Array): string { return btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')); }
function unb64(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function vaultKey(masterKey: string): Promise<CryptoKey> {
  if (!masterKey || masterKey.length < 32) throw new Error('ARENA_ENCRYPTION_KEY must contain at least 32 characters');
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(masterKey));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(secret: string, masterKey: string, ownerId: string): Promise<string> {
  if (!secret || secret.length > 4096 || !ownerId) throw new Error('Invalid credential');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(ownerId)}, await vaultKey(masterKey), encoder.encode(secret));
  return `v1.${b64(iv)}.${b64(new Uint8Array(ciphertext))}`;
}
export async function decryptSecret(ciphertext: string, masterKey: string, ownerId: string): Promise<string> {
  const [version,iv,data,...rest] = ciphertext.split('.');
  if(version !== 'v1' || !iv || !data || rest.length) throw new Error('Invalid encrypted credential');
  try { return new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(iv),additionalData:encoder.encode(ownerId)},await vaultKey(masterKey),unb64(data))); }
  catch { throw new Error('Credential cannot be decrypted'); }
}
export function maskSecret(secret: string): string { return `••••${secret.slice(-4)}`; }

export function isPublicAddress(address: string): boolean {
  if(address.includes(':')) {
    const v = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(v) && !/^(2001:|2002:|3fff:)/.test(v);
  }
  const a = address.split('.').map(Number);
  if(a.length !== 4 || a.some(n=>!Number.isInteger(n)||n<0||n>255)) return false;
  const [x,y,z] = a;
  return !(x===0||x===10||x===127||x>=224||(x===100&&y>=64&&y<=127)||(x===169&&y===254)||(x===172&&y>=16&&y<=31)||(x===192&&(y===168||y===0||y===2))||(x===198&&(y===18||y===19||(y===51&&z===100)))||(x===203&&y===0&&z===113));
}
/** Trusted runtime policy only. Never populate this from a model/request payload. */
export interface ProviderRuntimeOptions { localEndpoints?: readonly string[] }
/** Local development accepts only literal, canonical loopback URLs. This avoids
 * URL aliases/normalization silently widening an operator's exact allowlist. */
export function isCanonicalLocalEndpoint(endpoint: string): boolean {
  if(endpoint.length>2048 || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[\x21-\x7e]*$/.test(endpoint) || /[%\\?#]/.test(endpoint)) return false;
  try {
    const url=new URL(endpoint);
    return url.href===endpoint && url.hostname==='127.0.0.1' && url.protocol==='http:' && !!url.port &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export async function validateEndpoint(endpoint: string, provider?: ProviderId, options: ProviderRuntimeOptions & {resolve?: boolean; fetcher?: typeof fetch; signal?: AbortSignal} = {}): Promise<string> {
  let url: URL; try { url = new URL(endpoint); } catch { throw new Error('Invalid endpoint URL'); }
  if(provider === 'openrouter' || provider === 'systemone' || (provider && isBambooNodeProvider(provider))) {
    if(url.href !== ENDPOINTS[provider]) throw new Error('Built-in provider endpoint cannot be changed; choose a custom provider');
    return url.href;
  }
  if((provider==='custom-systemone'||provider==='custom-openrouter') &&
    options.localEndpoints?.includes(endpoint) && isCanonicalLocalEndpoint(endpoint)) return endpoint;
  const host = url.hostname.toLowerCase();
  if(endpoint.length>2048 || url.protocol!=='https:' || url.username || url.password || url.hash || url.search || (url.port && url.port!=='443') || !host.includes('.') || /[^a-z0-9.-]/.test(host) || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host)) throw new Error('Use a public HTTPS hostname on port 443, without credentials, query or redirects');
  if(options.resolve !== false) {
    const fetcher=options.fetcher??fetch;
    const answers=await Promise.all(['A','AAAA'].map(async type=> {
      // Fail over only between fixed public resolvers on transport failures.
      // A successful private/reserved answer is never retried or accepted.
      let data: {Answer?:{type:number;data:string}[];Status?:number}|undefined;
      for(const resolver of ['https://cloudflare-dns.com/dns-query','https://dns.google/resolve','https://dns.alidns.com/resolve']) {
        try {
          const response=await fetcher(`${resolver}?name=${encodeURIComponent(host)}&type=${type}`,{headers:{Accept:'application/dns-json'},redirect:'manual',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(5000)]):AbortSignal.timeout(5000)});
          if(!response.ok){await response.body?.cancel();continue;}
          data=await response.json() as typeof data;
          if(data && Array.isArray(data.Answer ?? [])) break;
          data=undefined;
        } catch { data=undefined; }
      }
      if(!data || (data.Status && data.Status!==0)) throw new Error('Endpoint DNS validation failed');
      return (data.Answer??[]).filter(a=>a.type===1||a.type===28).map(a=>a.data);
    }));
    const addresses=answers.flat();
    if(!addresses.length || addresses.some(a=>!isPublicAddress(a))) throw new Error('Endpoint must resolve only to public addresses');
  }
  return url.href;
}
function numeric(value: unknown): value is number { return typeof value==='number' && Number.isFinite(value); }
function returnedReasoning(thoughts: unknown[]): DecisionResponse['reasoning'] {
  for(const thought of thoughts) {
    const value=typeof thought==='string'?thought:thought && typeof thought==='object' && 'text' in thought?thought.text:undefined;
    if(typeof value!=='string' || !value.trim()) continue;
    const text=value.trim();
    // Keep stored events bounded without splitting a UTF-16 surrogate pair.
    let end=Math.min(text.length,MAX_REASONING_CHARACTERS);
    if(end<text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
    return {text:text.slice(0,end),truncated:end<text.length || (typeof thought==='object' && thought!==null && 'truncated' in thought && thought.truncated===true)};
  }
  return undefined;
}
export function normalizeResponse(raw: unknown, request: DecisionRequest, elapsedMs: number): DecisionResponse {
  if(!raw || typeof raw!=='object') throw new Error('Provider returned invalid JSON');
  const body=raw as Record<string,any>;
  const answer=body.answers?.primary_move;
  // Candidate keys are deliberately short and independent of the game notation.
  const keys=request.actions.map((_,i)=>`m${i}`);
  const selected=keys.indexOf(answer?.choice);
  if(selected<0) throw new Error('Provider selected an invalid action; no move executed');
  const metrics: DecisionResponse['metrics']={elapsedMs};
  if(answer.confidence !== undefined) {
    if(!numeric(answer.confidence)||answer.confidence<0||answer.confidence>1) throw new Error('Invalid confidence');
    metrics.confidence=answer.confidence;
  }
  if(answer.probabilities !== undefined) {
    const probs=answer.probabilities;
    if(!probs||typeof probs!=='object'||Array.isArray(probs)||Object.keys(probs).length!==keys.length||keys.some(k=>!numeric(probs[k])||probs[k]<0||probs[k]>1)||Math.abs(keys.reduce((s,k)=>s+probs[k],0)-1)>0.02) throw new Error('Invalid candidate probabilities');
    metrics.probabilities=Object.fromEntries(keys.map((k,i)=>[request.actions[i].id,probs[k]]));
  }
  if(typeof body.model==='string') metrics.actualModel=body.model.slice(0,200);
  if(body.usage && typeof body.usage==='object') {
    const usage=Object.fromEntries(Object.entries(body.usage).filter(([k,v])=>/^[a-z_]+$/.test(k)&&numeric(v)&&v>=0));
    if(Object.keys(usage).length) metrics.usage=usage as Record<string,number>;
  }
  const thoughts=[answer?.details?.thought,body.thought,body.details?.thought];
  const thought=thoughts.find(value=>typeof value?.used==='boolean');
  if(typeof thought?.used==='boolean') metrics.thoughtUsed=thought.used;
  else if(typeof body.thought_used==='boolean') metrics.thoughtUsed=body.thought_used;
  const reasoning=returnedReasoning(thoughts);
  return {actionId:request.actions[selected].id, metrics,...(reasoning?{reasoning}:{})};
}
async function limitedJson(response: Response, maximumBytes = 2_000_000): Promise<unknown> {
  if(Number(response.headers.get('content-length'))>maximumBytes) { await response.body?.cancel(); throw new Error('Provider response too large'); }
  const reader=response.body?.getReader(); if(!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[]=[]; let size=0;
  while(true) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength; if(size>maximumBytes){await reader.cancel();throw new Error('Provider response too large');} chunks.push(value); }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('Provider returned invalid JSON');}
}
async function providerFailure(response: Response, provider: ProviderId): Promise<Error> {
  // Only classify the fixed BambooNode gateway's explicit quota rejection. A 403
  // can also mean denied permissions; neither status nor permission_denied alone
  // proves a balance problem. Never return upstream messages, balances or URLs.
  if(isBambooNodeProvider(provider) && [402,403].includes(response.status)) {
    try {
      const body = await limitedJson(response, 16_384);
      const error = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
      if(error && typeof error === 'object' && !Array.isArray(error)) {
        const { code, message } = error as { code?: unknown; message?: unknown };
        if(code === 'insufficient_quota' || (typeof message === 'string' && /^(?:Insufficient user quota\b|用户额度不足)(?:\s*[,，:：]|\s*$)/i.test(message.trim())))
          return new Error(BAMBOONODE_INSUFFICIENT_QUOTA);
      }
    } catch { /* Invalid/oversized error bodies retain the safe generic failure. */ }
  } else await response.body?.cancel();
  return new Error(`Model provider returned HTTP ${response.status}`);
}
export const MAX_DECISION_IMAGE_BYTES = 2 * 1024 * 1024;
function inlineDecisionImages(images: DecisionRequest['images'], jev = false): string[] | undefined {
  if (images === undefined) return undefined;
  if (!Array.isArray(images) || images.length !== 1) throw new Error('A visual decision requires one inline PNG observation');
  const image = images[0], prefix = 'data:image/png;base64,';
  if (typeof image !== 'string' || !image.startsWith(prefix) || image.length > prefix.length + Math.ceil(MAX_DECISION_IMAGE_BYTES / 3) * 4) throw new Error('Invalid or oversized decision image');
  const encoded = image.slice(prefix.length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Invalid decision image encoding');
  const raw = atob(encoded);
  if (raw.length < 33 || raw.length > MAX_DECISION_IMAGE_BYTES || raw.slice(0,8) !== '\x89PNG\r\n\x1a\n' || raw.slice(12,16) !== 'IHDR') throw new Error('Invalid PNG decision image');
  const size = (offset: number) => raw.charCodeAt(offset) * 16777216 + raw.charCodeAt(offset+1) * 65536 + raw.charCodeAt(offset+2) * 256 + raw.charCodeAt(offset+3);
  const width = size(16), height = size(20);
  if (jev) {
    // OpenRouter Decisions forwards the complete image to Jev. Reject invalid
    // sizes rather than resizing or silently reverting to a text-only request.
    if (width < 256 || height < 256 || width > 1568 || height > 1568 || width * height < 78_400 || width * height > 2_458_624) throw new Error('Invalid Jev decision image dimensions');
  } else if (width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 2_000_000) throw new Error('Invalid decision image dimensions');
  return [...images];
}
export async function decide(profile: ModelProfile, key: string, request: DecisionRequest, signal?: AbortSignal, beforeSend?: () => void, options: ProviderRuntimeOptions = {}): Promise<DecisionResponse> {
  if(!request.actions.length || request.actions.length>1000) throw new Error('Invalid candidate count');
  if(request.images !== undefined && !supportsDecisionImages(profile)) throw new Error('This model does not support visual decisions');
  const systemone=profile.provider.endsWith('systemone');
  const images=inlineDecisionImages(request.images,!systemone);
  if(!key || /[\r\n]/.test(key)) throw new Error('Invalid API key');
  if(/^(?:sk-)?bag_/.test(key.trim()) && !isBambooNodeProvider(profile.provider)) throw new Error('BambooNode application credentials require a fixed BambooNode provider');
  if(isBambooNodeProvider(profile.provider) && !BAMBOONODE_MODELS[profile.provider].includes(profile.model)) throw new Error('Unsupported BambooNode model');
  if(profile.provider.startsWith('custom-') && !('WebSocketPair' in globalThis)) throw new Error('Custom providers must run through the Cloudflare match service');
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
  const endpoint=await validateEndpoint(profile.endpoint,profile.provider,{signal:requestSignal,localEndpoints:options.localEndpoints});
  const criteria=Object.fromEntries(request.actions.map((a,i)=>[`m${i}`,a.label]));
  const payload:Record<string,unknown>={state:request.state, questions:{primary_move:{type:'choice',instructions:request.instructions,criteria}}};
  if(images) {
    if(systemone) payload.images=images;
    else {
      // Decisions media are top-level state parts. A top-level images property
      // is rejected by OpenRouter; keep the complete structured state as text.
      let text: string | undefined;
      try { text=JSON.stringify(request.state); } catch { throw new Error('Invalid structured state for visual decision'); }
      if(text === undefined) throw new Error('Invalid structured state for visual decision');
      payload.state=[text,...images.map(url=>({type:'image_url',image_url:{url}}))];
    }
  }
  if(profile.model) payload.model=profile.model;
  if(systemone) {
    // Game turns require a listed legal action, even when the service allows abstention by default.
    payload.allow_none=false;
    payload.think_mode=profile.thinkMode??'always'; payload.think_budget=profile.thinkBudget??4096; payload.return_details=true;
    payload.return_thought=payload.think_mode!=='never';
  }
  // DNS/credential preflight can outlive a realtime piece, run or control generation.
  // Revalidate synchronously at the final send boundary; never retry the paid request here.
  beforeSend?.();
  const started=Date.now();
  let response:Response;
  try { response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(payload),redirect:'manual',signal:requestSignal}); }
  catch { throw new Error('Model connection failed or timed out; retry explicitly to avoid duplicate charges'); }
  if(!response.ok) throw await providerFailure(response, profile.provider);
  return normalizeResponse(await limitedJson(response),request,Date.now()-started);
}
export const decisionProvider: ProviderAdapter={decide};
