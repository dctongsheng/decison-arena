import type { DecisionRequest, DecisionResponse, ModelProfile, ProviderId, ProviderAdapter } from '@decision-arena/core';

export const ENDPOINTS = { openrouter: 'https://openrouter.ai/api/alpha/decisions', systemone: 'https://startlux-decision.com/v1/systemone' } as const;
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
export async function validateEndpoint(endpoint: string, provider?: ProviderId, options: {resolve?: boolean; fetcher?: typeof fetch; signal?: AbortSignal} = {}): Promise<string> {
  let url: URL; try { url = new URL(endpoint); } catch { throw new Error('Invalid endpoint URL'); }
  if(provider === 'openrouter' || provider === 'systemone') {
    if(url.href !== ENDPOINTS[provider]) throw new Error('Built-in provider endpoint cannot be changed; choose a custom provider');
    return url.href;
  }
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
async function limitedJson(response: Response): Promise<unknown> {
  if(Number(response.headers.get('content-length'))>2_000_000) throw new Error('Provider response too large');
  const reader=response.body?.getReader(); if(!reader) throw new Error('Empty provider response');
  const chunks: Uint8Array[]=[]; let size=0;
  while(true) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength; if(size>2_000_000){await reader.cancel();throw new Error('Provider response too large');} chunks.push(value); }
  const bytes=new Uint8Array(size); let offset=0; for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes));}catch{throw new Error('Provider returned invalid JSON');}
}
export async function decide(profile: ModelProfile, key: string, request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> {
  if(!request.actions.length || request.actions.length>1000) throw new Error('Invalid candidate count');
  if(!key || /[\r\n]/.test(key)) throw new Error('Invalid API key');
  if(profile.provider.startsWith('custom-') && !('WebSocketPair' in globalThis)) throw new Error('Custom providers must run through the Cloudflare match service');
  const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(120000)]):AbortSignal.timeout(120000);
  const endpoint=await validateEndpoint(profile.endpoint,profile.provider,{signal:requestSignal});
  const criteria=Object.fromEntries(request.actions.map((a,i)=>[`m${i}`,a.label]));
  const payload:Record<string,unknown>={state:request.state, questions:{primary_move:{type:'choice',instructions:request.instructions,criteria}}};
  if(profile.model) payload.model=profile.model;
  if(profile.provider.endsWith('systemone')) {
    payload.think_mode=profile.thinkMode??'always'; payload.think_budget=profile.thinkBudget??4096; payload.return_details=true;
    payload.return_thought=payload.think_mode!=='never';
  }
  const started=Date.now();
  let response:Response;
  try { response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(payload),redirect:'manual',signal:requestSignal}); }
  catch { throw new Error('Model connection failed or timed out; retry explicitly to avoid duplicate charges'); }
  if(!response.ok) { await response.body?.cancel(); throw new Error(`Model provider returned HTTP ${response.status}`); }
  return normalizeResponse(await limitedJson(response),request,Date.now()-started);
}
export const decisionProvider: ProviderAdapter={decide};
