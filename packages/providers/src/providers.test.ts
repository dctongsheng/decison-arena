import {describe,it,expect,vi,afterEach} from 'vitest';
import {encryptSecret,decryptSecret,validateEndpoint,normalizeResponse,isPublicAddress,decide,ENDPOINTS,MAX_REASONING_CHARACTERS} from './index';
import type {ModelProfile} from '@decision-arena/core';
const req={state:{},instructions:'choose',actions:[{id:'a',label:'A'},{id:'b',label:'B'}]};
describe('credential isolation',()=>{
 it('fails closed without a master key',async()=>{await expect(encryptSecret('test-key','','a')).rejects.toThrow();});
 it('authenticates owner and detects tampering',async()=>{const key='x'.repeat(32); const encrypted=await encryptSecret('fixture-secret',key,'a');expect(encrypted).not.toContain('fixture-secret');expect(await decryptSecret(encrypted,key,'a')).toBe('fixture-secret');await expect(decryptSecret(encrypted,key,'b')).rejects.toThrow();await expect(decryptSecret(encrypted,'y'.repeat(32),'a')).rejects.toThrow();});
});
describe('decision validation',()=>{
 it('maps only supplied actions, retaining optional metrics',()=>{expect(normalizeResponse({answers:{primary_move:{choice:'m1'}}},req,2).actionId).toBe('b');});
 it('rejects nonexistent choices and invalid probabilities',()=>{expect(()=>normalizeResponse({answers:{primary_move:{choice:'a'}}},req,1)).toThrow();expect(()=>normalizeResponse({answers:{primary_move:{choice:'m0',probabilities:{m0:1,m1:1}}}},req,1)).toThrow();});
 it('retains only returned thought text in a separate private field',()=>{const result=normalizeResponse({answers:{primary_move:{choice:'m0',details:{thought:{used:true,text:'Compare A and B.\nChoose A.',tokens:12,debug:'PRIVATE'}}}},api_key:'SECRET'},req,1);expect(result.reasoning).toEqual({text:'Compare A and B.\nChoose A.',truncated:false});expect(JSON.stringify(result.metrics)).not.toContain('Compare');expect(JSON.stringify(result)).not.toMatch(/PRIVATE|SECRET/);expect(result.metrics.thoughtUsed).toBe(true);});
 it('accepts explicit top-level compatibility thought text',()=>{expect(normalizeResponse({answers:{primary_move:{choice:'m0'}},thought:{used:true,text:'Returned text'}},req,1).reasoning?.text).toBe('Returned text');expect(normalizeResponse({answers:{primary_move:{choice:'m0'}},details:{thought:'Returned text'}},req,1).reasoning?.text).toBe('Returned text');});
 it.each([undefined,{used:true,tokens:50},{used:false,text:''},{used:true,text:'  \n '},{used:true,text:{explanation:'not text'}}])('does not fabricate thought text from metadata: %j',thought=>{const result=normalizeResponse({answers:{primary_move:{choice:'m0',details:{thought}}}},req,1);expect(result).not.toHaveProperty('reasoning');});
 it('bounds thought text and marks truncation without broken unicode',()=>{const prefix='a'.repeat(MAX_REASONING_CHARACTERS-1);const result=normalizeResponse({answers:{primary_move:{choice:'m0',details:{thought:{text:prefix+'😀more'}}}}},req,1);expect(result.reasoning).toEqual({text:prefix,truncated:true});});
});
describe('thinking request controls',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it.each(['always','auto','never',undefined] as const)('requests actual System One text only when thinking may run: %s',async thinkMode=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const profile:ModelProfile={id:'p',ownerId:'u',name:'test',credentialId:'k',provider:'systemone',endpoint:ENDPOINTS.systemone,model:'',thinkMode};
  await decide(profile,'fixture-key',req);
  const payload=JSON.parse(transport.mock.calls[0][1]!.body as string);
  expect(payload.return_details).toBe(true);expect(payload.return_thought).toBe(thinkMode!=='never');expect(payload.think_mode).toBe(thinkMode??'always');
 });
 it('does not send System One controls to OpenRouter Decisions',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  await decide({id:'p',ownerId:'u',name:'test',credentialId:'k',provider:'openrouter',endpoint:ENDPOINTS.openrouter,model:'typesafe/jev-1.13'},'fixture-key',req);
  const payload=JSON.parse(transport.mock.calls[0][1]!.body as string);expect(payload).not.toHaveProperty('return_thought');expect(payload).not.toHaveProperty('think_mode');
 });
});
describe('endpoint policy',()=>{
 it.each(['http://example.org/v1','https://127.0.0.1/v1','https://[::1]/','https://user:pass@foo.com/','https://foo.local/','https://foo.com:8090/v1','https://foo.com/?token=a'])('rejects %s',async url=>{await expect(validateEndpoint(url,undefined,{resolve:false})).rejects.toThrow();});
 it('checks all DNS answers',async()=>{const fetcher=async()=>Response.json({Answer:[{type:1,data:'127.0.0.1'}]});await expect(validateEndpoint('https://service.example.org/v1',undefined,{fetcher:fetcher as typeof fetch})).rejects.toThrow();});
 it('does not permit a custom endpoint under a built-in provider',async()=>{await expect(validateEndpoint('https://evil.org','openrouter')).rejects.toThrow();});
 it('rejects private and reserved address spaces',()=>{for(const ip of ['10.1.1.1','127.1.2.3','169.254.169.254','172.16.0.1','192.168.1.1','100.64.0.1','198.18.0.1','::1','fc00::1','2001:db8::1'])expect(isPublicAddress(ip)).toBe(false);expect(isPublicAddress('8.8.8.8')).toBe(true);});
});

describe('DNS resolver availability',()=>{
 it('uses only a fixed fallback after transport failure',async()=>{
  const urls:string[]=[];const fetcher=async(url:string)=>{urls.push(url);if(url.startsWith('https://cloudflare-dns.com/'))throw new Error('unavailable');return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});};
  expect(await validateEndpoint('https://service.example.org/v1',undefined,{fetcher:fetcher as typeof fetch})).toBe('https://service.example.org/v1');expect(urls).toHaveLength(4);expect(urls.filter(u=>u.startsWith('https://dns.google/'))).toHaveLength(2);
 });
 it('does not fall back to override a private DNS result',async()=>{
  const urls:string[]=[];const fetcher=async(url:string)=>{urls.push(url);return Response.json({Status:0,Answer:[{type:1,data:'127.0.0.1'}]});};
  await expect(validateEndpoint('https://service.example.org/v1',undefined,{fetcher:fetcher as typeof fetch})).rejects.toThrow('public');expect(urls).toHaveLength(2);expect(urls.every(u=>u.startsWith('https://cloudflare-dns.com/'))).toBe(true);
 });
});
