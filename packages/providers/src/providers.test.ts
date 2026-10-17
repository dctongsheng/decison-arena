import {describe,it,expect,vi,afterEach} from 'vitest';
import {encryptSecret,decryptSecret,validateEndpoint,normalizeResponse,isPublicAddress,decide,ENDPOINTS,MAX_REASONING_CHARACTERS} from './index';
import type {ModelProfile} from '@decision-arena/core';
import {BAMBOONODE_INSUFFICIENT_QUOTA} from '@decision-arena/core';
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
 it('checks realtime ownership after asynchronous DNS and before sending any credential to the provider',async()=>{
  vi.stubGlobal('WebSocketPair',class {});
  let active=true;
  const transport=vi.fn<typeof fetch>(async url=>{
   expect(String(url)).toMatch(/^https:\/\/cloudflare-dns.com\/dns-query\?/);
   // Simulate a run ending while custom-provider DNS preflight is outstanding.
   active=false;
   return Response.json({Status:0,Answer:[{type:1,data:'8.8.8.8'}]});
  });
  vi.stubGlobal('fetch',transport);
  const guard=vi.fn(()=>{if(!active)throw new Error('fixture canceled before send');});
  await expect(decide({id:'p',ownerId:'u',name:'test',credentialId:'k',provider:'custom-systemone',endpoint:'https://service.example.org/v1/systemone',model:'',thinkMode:'always'},'fixture-key',req,undefined,guard)).rejects.toThrow('fixture canceled before send');
  expect(guard).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(2);
  for(const [,init] of transport.mock.calls)expect(new Headers(init?.headers).has('Authorization')).toBe(false);
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

describe('BambooNode fixed gateway providers',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 const profile=(provider:ModelProfile['provider'],model:string):ModelProfile=>({id:'bamboo-profile',ownerId:'u',name:'BambooNode',credentialId:'bamboo-key',provider,endpoint:ENDPOINTS[provider as keyof typeof ENDPOINTS],model});
 it.each([
  ['bamboonode-systemone','startlux-decision-27b-autothink'],
  ['bamboonode-decisions','typesafe/jev-1.13'],
  ['bamboonode-decisions','typesafe/jev-1.14'],
 ] as const)('sends %s/%s only to its fixed gateway and maps the raw gateway answer',async(provider,model)=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({model,answers:{primary_move:{type:'choice',choice:'m1',confidence:0.8,probabilities:{m0:0.2,m1:0.8}}},usage:{input_tokens:21,output_tokens:3}}));
  vi.stubGlobal('fetch',transport);
  const result=await decide({...profile(provider,model),thinkMode:'always',thinkBudget:1024},'fixture-bamboo-key',req);
  expect(transport).toHaveBeenCalledTimes(1);
  const [url,init]=transport.mock.calls[0];expect(url).toBe(ENDPOINTS[provider]);expect(init?.redirect).toBe('manual');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-bamboo-key');
  const body=JSON.parse(init!.body as string);
  expect(body.model).toBe(model);expect(body.state).toEqual(req.state);
  expect(body.questions.primary_move).toEqual({type:'choice',instructions:req.instructions,criteria:{m0:'A',m1:'B'}});
  expect(result.actionId).toBe('b');expect(result.metrics).toMatchObject({actualModel:model,confidence:0.8,probabilities:{a:0.2,b:0.8},usage:{input_tokens:21,output_tokens:3}});
  if(provider==='bamboonode-decisions')for(const field of ['think_mode','think_budget','return_thought','return_details'])expect(body).not.toHaveProperty(field);
 });
 it.each(['always','auto','never'] as const)('preserves SystemOne thinking policy %s',async thinkMode=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  await decide({...profile('bamboonode-systemone','startlux-decision-27b-autothink'),thinkMode,thinkBudget:512},'fixture-bamboo-key',req);
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toMatchObject({think_mode:thinkMode,think_budget:512,return_details:true,return_thought:thinkMode!=='never'});
 });
 it.each([
  ['bamboonode-systemone','typesafe/jev-1.13'],['bamboonode-decisions','startlux-decision-27b-autothink'],
  ['bamboonode-decisions','typesafe/jev-1.14-20261014'],['bamboonode-systemone',''],
 ] as const)('rejects unregistered model %s/%s before any network request',async(provider,model)=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(profile(provider,model),'fixture-bamboo-key',req)).rejects.toThrow('Unsupported BambooNode model');
  expect(transport).not.toHaveBeenCalled();
 });
 it.each(['https://attacker.example.org/v1/decisions','https://api.bamboonode.cn/v1/decisions','http://api.bamboonode.dev/v1/decisions','https://api.bamboonode.dev/v1/decisions?key=fixture','https://api.bamboonode.dev/jev/v1/decisions'])('rejects endpoint replacement %s without DNS or credential egress',async endpoint=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide({...profile('bamboonode-systemone','startlux-decision-27b-autothink'),endpoint},'fixture-bamboo-key',req)).rejects.toThrow('endpoint');
  expect(transport).not.toHaveBeenCalled();
 });
 it.each([302,307,401,403,429,500])('does not follow redirects, expose response text or retry HTTP %s',async status=>{
  const transport=vi.fn<typeof fetch>(async()=>new Response('private upstream detail',{status,headers:{location:'https://attacker.example.org/'}}));vi.stubGlobal('fetch',transport);
  await expect(decide(profile('bamboonode-decisions','typesafe/jev-1.13'),'fixture-bamboo-key',req)).rejects.toThrow(`Model provider returned HTTP ${status}`);
  expect(transport).toHaveBeenCalledTimes(1);expect(transport.mock.calls[0][1]?.redirect).toBe('manual');
 });
 it.each([
  {code:'permission_denied',message:'Insufficient user quota, remaining quota: ＄0.000000 private fixture'},
  {code:'permission_denied',message:'用户额度不足, 剩余额度: ＄0.000000 private fixture'},
  {code:'insufficient_quota',message:'private fixture'},
 ])('classifies an explicit BambooNode quota rejection without exposing its body: %j',async error=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({error},{status:403}));vi.stubGlobal('fetch',transport);
  await expect(decide(profile('bamboonode-decisions','typesafe/jev-1.14'),'fixture-bamboo-key',req)).rejects.toThrow(new Error(BAMBOONODE_INSUFFICIENT_QUOTA));
  expect(transport).toHaveBeenCalledTimes(1);
 });
 it('also classifies insufficient quota for BambooNode StartLux',async()=>{
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async()=>Response.json({error:{code:'insufficient_quota'}},{status:402})));
  await expect(decide(profile('bamboonode-systemone','startlux-decision-27b-autothink'),'fixture-bamboo-key',req)).rejects.toThrow(new Error(BAMBOONODE_INSUFFICIENT_QUOTA));
 });
 it.each([
  {error:{code:'permission_denied',message:'This model is not allowed. private fixture'}},
  {error:{code:'permission_denied',message:'Invalid credential private fixture'}},
  {message:'Insufficient user quota, remaining quota: private fixture'},
  {error:'Insufficient user quota'},
  {error:null},
 ])('does not misclassify another 403 error or copy its body: %j',async body=>{
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async()=>Response.json(body,{status:403})));
  await expect(decide(profile('bamboonode-decisions','typesafe/jev-1.13'),'fixture-bamboo-key',req)).rejects.toThrow(new Error('Model provider returned HTTP 403'));
 });
 it('bounds untrusted error bodies and cancels an oversized stream',async()=>{
  const cancel=vi.fn();
  vi.stubGlobal('fetch',vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify({error:{code:'insufficient_quota',message:'private fixture'.repeat(2000)}})));},cancel}),{status:403})));
  await expect(decide(profile('bamboonode-decisions','typesafe/jev-1.13'),'fixture-bamboo-key',req)).rejects.toThrow(new Error('Model provider returned HTTP 403'));
  expect(cancel).toHaveBeenCalledTimes(1);
 });
 it('does not interpret a quota message from a different provider or status',async()=>{
  for(const [provider,model,status] of [['openrouter','typesafe/jev-1.13',403],['bamboonode-decisions','typesafe/jev-1.13',401]] as const) {
   const transport=vi.fn<typeof fetch>(async()=>Response.json({error:{code:'insufficient_quota'}},{status}));vi.stubGlobal('fetch',transport);
   await expect(decide(profile(provider,model),'fixture-key',req)).rejects.toThrow(new Error(`Model provider returned HTTP ${status}`));
   expect(transport).toHaveBeenCalledTimes(1);
  }
 });
 it.each(['openrouter','systemone','custom-openrouter','custom-systemone'] as const)('does not send a managed app key through %s even if a stored profile is changed',async provider=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  const own={...profile(provider,'fixture-model'),endpoint:provider.startsWith('custom-')?'https://attacker.example.org/decisions':ENDPOINTS[provider as 'openrouter'|'systemone']};
  for(const key of ['sk-bag_fixture-only','bag_fixture-only'])await expect(decide(own,key,req)).rejects.toThrow('fixed BambooNode provider');
  expect(transport).not.toHaveBeenCalled();
 });
});
