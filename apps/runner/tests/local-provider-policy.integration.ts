import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel, Response as FixtureResponse } from 'miniflare';
import type { ArcadeSession, MatchSnapshot, ModelProfile } from '@decision-arena/core';
import { encryptSecret } from '@decision-arena/providers';
import { localProviderOptions } from '../src/local-provider-policy';

const endpoint='http://127.0.0.1:18080/v1/systemone';
const configured=JSON.stringify([endpoint]);
const owner='fixture-local-provider-owner', internal='fixture-local-provider-internal';
const master='fixture-local-provider-master-key-2026-not-production';

describe('local provider server-binding policy',()=>{
  it.each([undefined,'false','TRUE','1'])('ignores even a configured endpoint outside exact LOCAL_DEV=true: %s',LOCAL_DEV=>{
    expect(localProviderOptions({LOCAL_DEV,ARENA_LOCAL_PROVIDER_ENDPOINTS:configured})).toEqual({});
  });
  it('defaults to closed and parses only canonical explicit entries',()=>{
    expect(localProviderOptions({LOCAL_DEV:'true'})).toEqual({});
    expect(localProviderOptions({LOCAL_DEV:'true',ARENA_LOCAL_PROVIDER_ENDPOINTS:configured})).toEqual({localEndpoints:[endpoint]});
  });
  it.each(['not-json','{}','null','[1]',JSON.stringify(['http://localhost:18080/v1/systemone']),JSON.stringify(['http://2130706433:18080/v1/systemone']),JSON.stringify(['https://example.org/decisions']),JSON.stringify([endpoint+'?secret=fixture-private']),JSON.stringify(Array(33).fill(endpoint))])('fails closed without echoing invalid runtime configuration',ARENA_LOCAL_PROVIDER_ENDPOINTS=>{
    expect(()=>localProviderOptions({LOCAL_DEV:'true',ARENA_LOCAL_PROVIDER_ENDPOINTS})).toThrow(new Error('Invalid ARENA_LOCAL_PROVIDER_ENDPOINTS configuration'));
  });
});

describe.each([
  {name:'explicit local development policy',allowed:true,local:'true',configured:true},
  {name:'default development policy',allowed:false,local:'true',configured:false},
  {name:'production with an accidentally retained allowlist',allowed:false,local:'false',configured:true},
])('$name (workerd, fixture-only outbound transport)',({allowed,local,configured:hasConfiguration})=>{
  let mf:Miniflare;
  let own:ModelProfile;
  let calls:{url:string;body:any}[]=[];
  let responseStatus=200;
  const request=(path:string,body?:unknown)=>mf.dispatchFetch(`https://fixture.test${path}`,{
    method:body===undefined?'GET':'POST',
    headers:{'X-Arena-Owner':owner,'X-Arena-Internal':internal,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
  });
  const command=(path:string,type:string)=>request(`${path}/commands`,{type,operationId:crypto.randomUUID()});
  const until=async(check:()=>Promise<boolean>)=>{
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){if(await check())return;await new Promise(resolve=>setTimeout(resolve,40));}
    throw new Error('Fixture runner did not settle');
  };
  beforeAll(async()=>{
    mf=new Miniflare({
      name:'fixture-local-provider-policy',modules:true,scriptPath:resolve('apps/runner/dist/index.js'),
      compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat','global_fetch_strictly_public'],
      host:'127.0.0.1',port:0,cf:false,log:new Log(LogLevel.ERROR),
      bindings:{ARENA_ENCRYPTION_KEY:master,ARENA_INTERNAL_SECRET:internal,LOCAL_DEV:local,...(hasConfiguration?{ARENA_LOCAL_PROVIDER_ENDPOINTS:configured}:{})},
      durableObjects:{MATCHES:{className:'MatchObject',useSQLite:true},USER_QUOTAS:{className:'UserQuota',useSQLite:true},ARCADES:{className:'ArcadeSessionObject',useSQLite:true}},
      d1Databases:['DB'],r2Buckets:['REPLAYS'],
      // Even a failed assertion can never reach a real model or DNS resolver.
      outboundService:async request=>{
        if(request.url!==endpoint)throw new Error('Unexpected fixture outbound URL');
        const body=await request.json() as any;calls.push({url:request.url,body});
        if(responseStatus!==200)return new FixtureResponse('fixture-private-body',{status:responseStatus,headers:{location:'http://127.0.0.1:5092/'}});
        return new FixtureResponse(JSON.stringify({model:'fixture-local-model',answers:{primary_move:{choice:Object.keys(body.questions.primary_move.criteria)[0]}}}),{headers:{'Content-Type':'application/json'}});
      },
    });
    await mf.ready;
    const db=await mf.getD1Database('DB');
    const statements=readFileSync(resolve('apps/web/drizzle/0000_powerful_solo.sql'),'utf8').split('--> statement-breakpoint').map(sql=>sql.trim());
    for(const name of ['user','arena_credentials','arena_matches'])await db.prepare(statements.find(sql=>sql.startsWith(`CREATE TABLE \`${name}\``))!).run();
    await db.prepare('INSERT INTO user(id,name,email) VALUES(?,?,?)').bind(owner,owner,'fixture-local@example.test').run();
    const credentialId=crypto.randomUUID(),ciphertext=await encryptSecret('fixture-local-model-key',master,owner);
    await db.prepare('INSERT INTO arena_credentials(id,owner_id,name,ciphertext,masked,created_at) VALUES(?,?,?,?,?,?)').bind(credentialId,owner,'fixture',ciphertext,'fixture-mask',Date.now()).run();
    own={id:crypto.randomUUID(),ownerId:owner,credentialId,provider:'custom-systemone',model:'fixture-model',name:'Local fixture',endpoint,thinkMode:'always'};
  });
  beforeEach(()=>{calls=[];responseStatus=200;});
  afterAll(async()=>{await mf?.dispose();});

  it('uses binding policy for endpoint validation, ignoring a payload allowlist',async()=>{
    const result=await request('/validate-endpoint',{endpoint,provider:'custom-systemone',localEndpoints:[endpoint]});
    expect(result.status).toBe(allowed?200:400);expect(calls).toHaveLength(0);
    if(allowed)expect(await result.json()).toEqual({endpoint});
    for(const other of [endpoint.replace(':18080',':18081'),endpoint+'/other']){
      expect((await request('/validate-endpoint',{endpoint:other,provider:'custom-systemone',localEndpoints:[other]})).status).toBe(400);
    }
  });
  it('uses binding policy for connection tests without trusting profile/request policy fields',async()=>{
    const result=await request('/provider-test',{profile:{...own,localEndpoints:[endpoint]},key:'fixture-local-model-key',localEndpoints:[endpoint],request:{state:{},instructions:'Fixture choice',actions:[{id:'fixture-choice',label:'Fixture'}]}});
    expect(result.status).toBe(allowed?200:400);expect(calls).toHaveLength(allowed?1:0);
    if(allowed)expect(await result.json()).toMatchObject({actionId:'fixture-choice',metrics:{actualModel:'fixture-local-model'}});
  });
  it('cannot override built-in providers or the authenticated owner',async()=>{
    for(const profile of [{...own,provider:'systemone'},{...own,ownerId:'fixture-other-owner'}]){
      expect((await request('/provider-test',{profile,key:'fixture-key',request:{state:{},instructions:'fixture',actions:[{id:'a',label:'A'}]}})).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
  it('applies the runtime policy again to a saved chess profile at inference',async()=>{
    const created=await request('/matches',{gameId:'gomoku',config:{size:9},seats:[{kind:'ai',profile:own},{kind:'human'}]});
    expect(created.status).toBe(201);
    const match=await created.json() as MatchSnapshot,path=`/matches/${match.id}`;
    try{
      expect((await command(path,'step')).status).toBe(200);
      await until(async()=>{const current=await(await request(path)).json() as MatchSnapshot;return allowed?current.events.some(e=>e.type==='action'):current.status==='error';});
      expect(calls).toHaveLength(allowed?1:0);
    }finally{await command(path,'end');}
  });
  it('applies the runtime policy again to a saved arcade profile and keeps no-thinking',async()=>{
    const created=await request('/arcade-sessions',{gameId:'snake',mode:'ai-solo',config:{},controllers:[{kind:'ai',profile:own}]});
    expect(created.status).toBe(201);
    const session=await created.json() as ArcadeSession,path=`/arcade-sessions/${session.id}`;
    try{
      expect((await command(path,'start')).status).toBe(200);
      await until(async()=>{const current=await(await request(path)).json() as ArcadeSession;return allowed?current.events.some(e=>e.type==='decision'&&e.outcome==='applied'):current.status==='paused';});
      expect(calls.length).toBe(allowed?1:0);
      if(allowed)expect(calls[0].body).toMatchObject({think_mode:'never',return_thought:false});
    }finally{await command(path,'end');}
  });
  if(allowed)it('never follows a local endpoint redirect',async()=>{
    responseStatus=307;
    const result=await request('/provider-test',{profile:own,key:'fixture-key',request:{state:{},instructions:'fixture',actions:[{id:'a',label:'A'}]}});
    expect(result.status).toBe(400);expect(await result.json()).toEqual({error:'Model provider returned HTTP 307'});expect(calls).toHaveLength(1);
  });
});
