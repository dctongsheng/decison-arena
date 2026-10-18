import {describe,it,expect,vi,afterEach} from 'vitest';
import {encryptSecret,decryptSecret,validateEndpoint,normalizeResponse,isPublicAddress,isCanonicalLocalEndpoint,decide,supportsDecisionImages,ENDPOINTS,MAX_REASONING_CHARACTERS,MAX_DECISION_IMAGE_BYTES} from './index';
import type {ModelProfile} from '@decision-arena/core';
import {BAMBOONODE_INSUFFICIENT_QUOTA} from '@decision-arena/core';
import { tetris } from '../../games/src/arcade/tetris';
import { renderTetrisObservationPng } from '../../games/src/arcade/tetris-vision';
const req={state:{},instructions:'choose',actions:[{id:'a',label:'A'},{id:'b',label:'B'}]};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6mZkAAAAASUVORK5CYII=';
const jevProviders=['openrouter','custom-openrouter','bamboonode-decisions'] as const;
function visualProfile(provider:ModelProfile['provider']='openrouter',model='typesafe/jev-1.14'):ModelProfile {
 const endpoint=provider==='custom-openrouter'?'http://127.0.0.1:18080/v1/decisions':ENDPOINTS[provider as keyof typeof ENDPOINTS];
 return {id:'v',ownerId:'o',credentialId:'k',name:'fixture',provider,endpoint,model,thinkMode:'never'};
}
function tetrisObservationImage() {
 const position=tetris.observe(tetris.create({},'fixture-visual-observation')),bytes=renderTetrisObservationPng(position);
 let binary='';for(let offset=0;offset<bytes.length;offset+=8192)binary+=String.fromCharCode(...bytes.subarray(offset,offset+8192));
 return {position,bytes,image:'data:image/png;base64,'+btoa(binary)};
}
// Header-only fixtures isolate dimension validation; complete PNG transport is
// independently tested using the real Tetris renderer below.
function imageDimensions(width:number,height:number) {
 const bytes=Uint8Array.from(atob(png.split(',')[1]),c=>c.charCodeAt(0));
 const view=new DataView(bytes.buffer);view.setUint32(16,width);view.setUint32(20,height);
 return 'data:image/png;base64,'+btoa(String.fromCharCode(...bytes));
}
describe('bounded inline visual observations',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it.each(['systemone','custom-systemone','bamboonode-systemone'] as const)('sends exactly the supplied PNG with structured state to %s',async provider=>{
  vi.stubGlobal('WebSocketPair',class {});
  const endpoint=provider==='custom-systemone'?'http://127.0.0.1:18080/v1/systemone':ENDPOINTS[provider];
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m1'}}}));vi.stubGlobal('fetch',transport);
  const result=await decide({id:'v',ownerId:'o',credentialId:'k',name:'fixture',provider,endpoint,model:provider==='bamboonode-systemone'?'startlux-decision-27b-autothink':'',thinkMode:'never'},'fixture-key',{...req,images:[png]},undefined,undefined,{localEndpoints:[endpoint]});
  expect(transport).toHaveBeenCalledOnce();
  const body=JSON.parse(transport.mock.calls[0][1]!.body as string);
  expect(body.images).toEqual([png]);expect(body.state).toEqual(req.state);expect(body.allow_none).toBe(false);expect(body.think_mode).toBe('never');expect(result.actionId).toBe('b');
 });
 it('accepts the complete generated Tetris PNG without shrinking or dropping its structured observation',async()=>{
  const {position,bytes,image}=tetrisObservationImage();
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  await decide({id:'v',ownerId:'o',credentialId:'k',name:'fixture',provider:'systemone',endpoint:ENDPOINTS.systemone,model:'',thinkMode:'never'},'fixture-key',{...req,state:{position},images:[image]});
  const body=JSON.parse(transport.mock.calls[0][1]!.body as string);expect(body.images[0]).toBe(image);expect(body.state.position).toEqual(position);expect(bytes.length).toBeGreaterThan(200_000);
 });
 it.each([[],[png,png],['https://example.test/observation.png'],['data:image/svg+xml;base64,PHN2Zy8+'],['data:image/png;base64,invalid'],[png+'\n']].map(images=>({images})))('rejects malformed images before network calls: case %#',async({images})=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide({id:'v',ownerId:'o',credentialId:'k',name:'fixture',provider:'systemone',endpoint:ENDPOINTS.systemone,model:''},'fixture-key',{...req,images})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
 });
 it('rejects oversized image content and dimensions without provider requests',async()=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  const profile:ModelProfile={id:'v',ownerId:'o',credentialId:'k',name:'fixture',provider:'systemone',endpoint:ENDPOINTS.systemone,model:''};
  const bytes=new Uint8Array(40);bytes.set([137,80,78,71,13,10,26,10],0);bytes.set([73,72,68,82],12);new DataView(bytes.buffer).setUint32(16,5000);new DataView(bytes.buffer).setUint32(20,5000);
  for(const image of ['data:image/png;base64,'+'A'.repeat(Math.ceil(MAX_DECISION_IMAGE_BYTES/3)*4+4),'data:image/png;base64,'+btoa(String.fromCharCode(...bytes))])await expect(decide(profile,'fixture-key',{...req,images:[image]})).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
 });
 it.each(jevProviders.flatMap(provider=>['typesafe/jev-1.13','typesafe/jev-1.14'].map(model=>({provider,model}))))('sends complete visual state parts to $provider / $model without unsupported controls',async({provider,model})=>{
  vi.stubGlobal('WebSocketPair',class {});
  const {position,bytes,image}=tetrisObservationImage(),profile=visualProfile(provider,model);
  const request={...req,state:{position,decisionStage:'target',recentInputs:[{tick:1,input:{buttons:['left'],durationMs:100}}]},images:[image]};
  const original=structuredClone(request);
  const transport=vi.fn<typeof fetch>(async()=>Response.json({model:model+'-fixture-pinned-response',answers:{primary_move:{choice:'m1'}}}));vi.stubGlobal('fetch',transport);
  const result=await decide(profile,'fixture-key',request,undefined,undefined,{localEndpoints:[profile.endpoint]});
  expect(transport).toHaveBeenCalledOnce();
  const [url,init]=transport.mock.calls[0],body=JSON.parse(init!.body as string);
  expect(url).toBe(profile.endpoint);expect(init!.redirect).toBe('manual');
  expect(body).toEqual({model,state:[JSON.stringify(request.state),{type:'image_url',image_url:{url:image}}],questions:{primary_move:{type:'choice',instructions:req.instructions,criteria:{m0:'A',m1:'B'}}}});
  expect(JSON.parse(body.state[0])).toEqual(request.state);expect(body.state[1].image_url.url).toBe(image);
  expect(Buffer.from(body.state[1].image_url.url.split(',')[1],'base64')).toEqual(Buffer.from(bytes));
  expect(bytes.length).toBeGreaterThan(200_000);expect(request).toEqual(original);
  expect(body).not.toHaveProperty('images');expect(body).not.toHaveProperty('think_mode');expect(body).not.toHaveProperty('think_budget');expect(body).not.toHaveProperty('return_thought');
  expect(result.actionId).toBe('b');expect(result.metrics.actualModel).toBe(model+'-fixture-pinned-response');expect(result.metrics).not.toHaveProperty('thoughtUsed');
 });
 it.each(jevProviders.flatMap(provider=>['','typesafe/jev-latest','typesafe/jev-1.13-20260917','typesafe/jev-1.14-20261014','other/unknown'].map(model=>({provider,model}))))('fails explicitly for unsupported visual model $provider / $model instead of dropping the image',async({provider,model})=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  expect(supportsDecisionImages({provider,model})).toBe(false);
  await expect(decide(visualProfile(provider,model),'fixture-key',{...req,images:[png]})).rejects.toThrow('does not support visual decisions');expect(transport).not.toHaveBeenCalled();
 });
 it('declares only the supported provider/model combinations',()=>{
  for(const provider of ['systemone','custom-systemone','bamboonode-systemone'] as const)
   expect(supportsDecisionImages({provider,model:''})).toBe(true);
  for(const provider of jevProviders)for(const model of ['typesafe/jev-1.13','typesafe/jev-1.14'])
   expect(supportsDecisionImages({provider,model})).toBe(true);
 });
 it.each(jevProviders)('does not change nonvisual request structure for %s',async provider=>{
  vi.stubGlobal('WebSocketPair',class {});
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const profile=visualProfile(provider);
  for(const state of [{board:['.X.','O..'],nested:{turn:3}},['original','array'],'plain state',null,0]) {
   await decide(profile,'fixture-key',{...req,state},undefined,undefined,{localEndpoints:[profile.endpoint]});
   expect(JSON.parse(transport.mock.calls.at(-1)![1]!.body as string)).toEqual({state,model:profile.model,questions:{primary_move:{type:'choice',instructions:req.instructions,criteria:{m0:'A',m1:'B'}}}});
  }
 });
 it.each([[255,400],[400,255],[256,306],[306,256],[1569,256],[256,1569],[1569,1569]])('rejects Jev image dimensions %i x %i before transport',async(width,height)=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(visualProfile(),'fixture-key',{...req,images:[imageDimensions(width,height)]})).rejects.toThrow('Invalid Jev decision image dimensions');expect(transport).not.toHaveBeenCalled();
 });
 it.each([[280,280],[256,307],[307,256],[1568,1568]])('accepts inclusive Jev dimension limits %i x %i without resizing',async(width,height)=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const image=imageDimensions(width,height);
  await decide(visualProfile(),'fixture-key',{...req,images:[image]});
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string).state[1].image_url.url).toBe(image);
 });
 it.each([[],[png,png],['https://example.test/observation.png'],['data:image/svg+xml;base64,PHN2Zy8+'],['data:image/png;base64,invalid'],[png+'\n'],['data:image/png;base64,'+'A'.repeat(Math.ceil(MAX_DECISION_IMAGE_BYTES/3)*4+4)]].map(images=>({images})))('keeps PNG encoding/count/byte limits on Jev: case %#',async({images})=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(visualProfile(),'fixture-key',{...req,images})).rejects.toThrow();expect(transport).not.toHaveBeenCalled();
 });
 it('preserves every serializable original state value in the visual JSON text part',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const image=imageDimensions(280,280);
  for(const state of [{text:'中文状态',nested:{value:0}},['original','array'],'plain state',null,0]) {
   await decide(visualProfile(),'fixture-key',{...req,state,images:[image]});
   const body=JSON.parse(transport.mock.calls.at(-1)![1]!.body as string);
   expect(body.state[0]).toBe(JSON.stringify(state));expect(JSON.parse(body.state[0])).toEqual(state);
  }
 });
 it.each([undefined,1n])('rejects non-JSON visual state rather than discarding it: %s',async state=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(visualProfile(),'fixture-key',{...req,state,images:[imageDimensions(280,280)]})).rejects.toThrow('Invalid structured state');expect(transport).not.toHaveBeenCalled();
 });
 it('does not replace or retry an invalid visual model choice',async()=>{
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:null,probabilities:{m0:0.99,m1:0.01}}}}));vi.stubGlobal('fetch',transport);
  await expect(decide(visualProfile(),'fixture-key',{...req,images:[imageDimensions(280,280)]})).rejects.toThrow('invalid action');expect(transport).toHaveBeenCalledOnce();
 });
});
describe('explicit local development endpoint policy',()=>{
 const endpoint='http://127.0.0.1:18080/v1/systemone';
 const options={localEndpoints:[endpoint]};
 const profile:ModelProfile={id:'fixture-profile',ownerId:'fixture-owner',credentialId:'fixture-credential',name:'Fixture local',provider:'custom-systemone',endpoint,model:'fixture-model',thinkMode:'never'};
 afterEach(()=>vi.unstubAllGlobals());
 it('keeps private endpoints denied by default, including DNS-skipping checks',async()=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(validateEndpoint(endpoint,'custom-systemone')).rejects.toThrow('public HTTPS');
  await expect(validateEndpoint(endpoint,'custom-systemone',{resolve:false})).rejects.toThrow('public HTTPS');
  expect(transport).not.toHaveBeenCalled();
 });
 it.each(['custom-systemone','custom-openrouter'] as const)('accepts only the exact canonical endpoint for %s without DNS',async provider=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  expect(isCanonicalLocalEndpoint(endpoint)).toBe(true);
  await expect(validateEndpoint(endpoint,provider,options)).resolves.toBe(endpoint);
  expect(transport).not.toHaveBeenCalled();
 });
 it.each([
  'http://127.0.0.1:18081/v1/systemone',
  'http://127.0.0.1:18080/v1/decisions',
  'http://127.0.0.1:18080/v1/systemone/',
  'http://localhost:18080/v1/systemone',
  'http://127.0.0.2:18080/v1/systemone',
  'http://[::1]:18080/v1/systemone',
  'http://2130706433:18080/v1/systemone',
  'http://127.1:18080/v1/systemone',
  'http://0x7f000001:18080/v1/systemone',
  'http://127.000.000.001:18080/v1/systemone',
  'http://127.0.0.1:018080/v1/systemone',
  'http://127.0.0.1:18080/v1/../v1/systemone',
  'http://127.0.0.1:18080/v1/%73ystemone',
  'http://127.0.0.1:18080/v1/systemone?',
  'http://127.0.0.1:18080/v1/systemone#',
  'http://user:pass@127.0.0.1:18080/v1/systemone',
  'http://127.0.0.1:18080\\v1\\systemone',
  'http://127.0.0.1:18080/v1/systemone\n',
  'https://127.0.0.1:18080/v1/systemone',
 ])('does not normalize or broaden the configured target: %s',async value=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(validateEndpoint(value,'custom-systemone',options)).rejects.toThrow();
  expect(transport).not.toHaveBeenCalled();
 });
 it.each([
  'http://localhost:18080/v1/systemone',
  'http://2130706433:18080/v1/systemone',
  'http://127.0.0.1:18080/v1/../v1/systemone',
  'http://127.0.0.1:18080/v1/systemone?key=fixture',
  'http://user:pass@127.0.0.1:18080/v1/systemone',
 ])('rejects an unsafe entry even if the policy itself contains it: %s',async value=>{
  expect(isCanonicalLocalEndpoint(value)).toBe(false);
  await expect(validateEndpoint(value,'custom-systemone',{localEndpoints:[value]})).rejects.toThrow();
 });
 it.each(['openrouter','systemone','bamboonode-systemone','bamboonode-decisions',undefined] as const)('does not allow built-in or missing provider override: %s',async provider=>{
  await expect(validateEndpoint(endpoint,provider,options)).rejects.toThrow();
 });
 it('retains the workerd-only requirement, even with an explicit local endpoint',async()=>{
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(profile,'fixture-key',req,undefined,undefined,options)).rejects.toThrow('Cloudflare match service');
  expect(transport).not.toHaveBeenCalled();
 });
 it('keeps the beforeSend fence and passes explicit policy only as the sixth argument',async()=>{
  vi.stubGlobal('WebSocketPair',class {});
  const transport=vi.fn<typeof fetch>(async()=>Response.json({model:'fixture-model',answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const beforeSend=vi.fn(()=>{expect(transport).not.toHaveBeenCalled();});
  const result=await decide(profile,'fixture-key',req,undefined,beforeSend,options);
  expect(beforeSend).toHaveBeenCalledOnce();expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0][0]).toBe(endpoint);
  expect(transport.mock.calls[0][1]?.redirect).toBe('manual');
  expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toMatchObject({allow_none:false,think_mode:'never',return_thought:false});
  expect(result.actionId).toBe('a');
 });
 it('never sends after the current-action fence rejects',async()=>{
  vi.stubGlobal('WebSocketPair',class {});
  const transport=vi.fn<typeof fetch>();vi.stubGlobal('fetch',transport);
  await expect(decide(profile,'fixture-key',req,undefined,()=>{throw new Error('fixture-stale-action');},options)).rejects.toThrow('fixture-stale-action');
  expect(transport).not.toHaveBeenCalled();
 });
 it.each([301,302,303,307,308])('rejects HTTP %s without following any redirect or disclosing its body',async status=>{
  vi.stubGlobal('WebSocketPair',class {});
  const transport=vi.fn<typeof fetch>(async()=>new Response('fixture-private-upstream-body',{status,headers:{location:'http://127.0.0.1:5092/'}}));vi.stubGlobal('fetch',transport);
  await expect(decide(profile,'fixture-key',req,undefined,undefined,options)).rejects.toThrow(new Error(`Model provider returned HTTP ${status}`));
  expect(transport).toHaveBeenCalledOnce();expect(transport.mock.calls[0][1]?.redirect).toBe('manual');
 });
});
describe('credential isolation',()=>{
 it('fails closed without a master key',async()=>{await expect(encryptSecret('test-key','','a')).rejects.toThrow();});
 it('authenticates owner and detects tampering',async()=>{const key='x'.repeat(32); const encrypted=await encryptSecret('fixture-secret',key,'a');expect(encrypted).not.toContain('fixture-secret');expect(await decryptSecret(encrypted,key,'a')).toBe('fixture-secret');await expect(decryptSecret(encrypted,key,'b')).rejects.toThrow();await expect(decryptSecret(encrypted,'y'.repeat(32),'a')).rejects.toThrow();});
});
describe('decision validation',()=>{
 it('maps only supplied actions, retaining optional metrics',()=>{expect(normalizeResponse({answers:{primary_move:{choice:'m1'}}},req,2).actionId).toBe('b');});
 it('rejects nonexistent choices and invalid probabilities',()=>{expect(()=>normalizeResponse({answers:{primary_move:{choice:'a'}}},req,1)).toThrow();expect(()=>normalizeResponse({answers:{primary_move:{choice:'m0',probabilities:{m0:1,m1:1}}}},req,1)).toThrow();});
 it.each([null,undefined,'None of the above','m2'])('rejects abstention or an invalid choice without substituting the highest-probability action: %s',choice=>{
  expect(()=>normalizeResponse({answers:{primary_move:{choice,probabilities:{m0:0.9,m1:0.1},none_probability:0.7}}},req,1)).toThrow('Provider selected an invalid action; no move executed');
 });
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
  expect(payload.allow_none).toBe(false);expect(payload.return_details).toBe(true);expect(payload.return_thought).toBe(thinkMode!=='never');expect(payload.think_mode).toBe(thinkMode??'always');
 });
 it.each(['openrouter','custom-openrouter'] as const)('does not send System One controls to %s Decisions',async provider=>{
  vi.stubGlobal('WebSocketPair',class {});
  const transport=vi.fn<typeof fetch>(async()=>Response.json({answers:{primary_move:{choice:'m0'}}}));vi.stubGlobal('fetch',transport);
  const endpoint=provider==='openrouter'?ENDPOINTS.openrouter:'http://127.0.0.1:18080/v1/decisions';
  await decide({id:'p',ownerId:'u',name:'test',credentialId:'k',provider,endpoint,model:'typesafe/jev-1.13'},'fixture-key',req,undefined,undefined,{localEndpoints:[endpoint]});
  const payload=JSON.parse(transport.mock.calls[0][1]!.body as string);expect(payload).not.toHaveProperty('return_thought');expect(payload).not.toHaveProperty('think_mode');expect(payload).not.toHaveProperty('allow_none');
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
  if(provider==='bamboonode-decisions')for(const field of ['think_mode','think_budget','return_thought','return_details','allow_none'])expect(body).not.toHaveProperty(field);
  else expect(body.allow_none).toBe(false);
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
