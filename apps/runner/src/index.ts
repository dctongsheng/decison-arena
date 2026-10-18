import { DurableObject } from 'cloudflare:workers';
import { armyWatchView, getGame } from '@decision-arena/games';
import { decide, decryptSecret, isBambooNodeProvider, validateEndpoint } from '@decision-arena/providers';
import { assertBambooNodeAccess, assertBambooNodeKey } from './bamboonode';
import { localProviderOptions } from './local-provider-policy';
import { publicSeats } from '@decision-arena/core';
import { ArcadeSessionObject } from './arcade';
export { ArcadeSessionObject } from './arcade';
import type { CreateMatchInput, GameState, GameView, MatchCommand, MatchEvent, MatchSnapshot, MatchStatus, ReplayManifest, Seat, Viewer, DecisionResponse, GameResult, ModelProfile, DecisionRequest, ProviderId } from '@decision-arena/core';

export interface Env {
  MATCHES: DurableObjectNamespace<MatchObject>;
  USER_QUOTAS: DurableObjectNamespace<UserQuota>;
  ARCADES: DurableObjectNamespace<ArcadeSessionObject>;
  DB: D1Database;
  REPLAYS: R2Bucket;
  ARENA_ENCRYPTION_KEY: string;
  ARENA_INTERNAL_SECRET?: string;
  LOCAL_DEV?: string;
  ARENA_LOCAL_PROVIDER_ENDPOINTS?: string;
}
interface RecordState {
  id:string; ownerId:string; input:CreateMatchInput; seed:string; state:GameState; rulesVersion:string;
  status:MatchStatus; version:number; revision:number; eventSeq:number; frameSeq:number;
  createdAt:number; updatedAt:number; finishedAt?:number; activeMs:number;
  auto:boolean; queuedStep:boolean; error?:string; needsSync:boolean; syncFailures:number;
  result?:GameResult; inflight?:{id:string;revision:number;seat:Seat;startedAt:number};
}
const json=(data:unknown,status=200)=>Response.json(data,{status});
const safeError=(error:unknown)=>error instanceof Error?error.message:'Operation failed';
const MAX_PLIES=300, MAX_ACTIVE_MS=3600000, MAX_MATCH_EVENTS=1000;

export class UserQuota extends DurableObject<Env> {
  async acquire(matchId:string):Promise<boolean>{
    const active=await this.ctx.storage.get<{id:string;expires:number}>('active');
    if(active&&active.expires>Date.now()&&active.id!==matchId)return false;
    await this.ctx.storage.put('active',{id:matchId,expires:Date.now()+180000});return true;
  }
  async release(matchId:string):Promise<void>{
    const active=await this.ctx.storage.get<{id:string}>('active');
    if(active?.id===matchId)await this.ctx.storage.delete('active');
  }
}

export class MatchObject extends DurableObject<Env> {
  private rec?:RecordState;
  constructor(ctx:DurableObjectState, env:Env){
    super(ctx,env);
    ctx.blockConcurrencyWhile(async()=>{
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS frames (seq INTEGER PRIMARY KEY, value TEXT NOT NULL)');
      ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, version INTEGER NOT NULL)');
      const row=ctx.storage.sql.exec<{value:string}>('SELECT value FROM meta WHERE id=1').toArray()[0];
      if(row)this.rec=JSON.parse(row.value);
    });
  }
  private isFinished(){ return this.rec?.status === 'finished'; }
  private isArmyDuel(){ return this.rec?.input.gameId === 'army' && this.rec.input.seats.every(seat=>seat.kind==='ai'); }
  private result(){ return this.rec?.result ?? this.rec?.state.result; }
  private require(ownerId:string):RecordState {
    if(!this.rec || this.rec.ownerId!==ownerId)throw new Error('Match not found');
    return this.rec;
  }
  private persist(bumpVersion=true){
    const r=this.rec!;if(bumpVersion){r.updatedAt=Date.now();r.version++;}
    this.ctx.storage.sql.exec('INSERT INTO meta(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',JSON.stringify(r));
  }
  private event(type:MatchEvent['type'], data:Partial<MatchEvent>={}){
    const r=this.rec!;const e:MatchEvent={...data,seq:++r.eventSeq,type,at:Date.now()};
    this.ctx.storage.sql.exec('INSERT INTO events(seq,value) VALUES(?,?)',e.seq,JSON.stringify(e));
  }
  private frame(){
    const r=this.rec!;const view=getGame(r.input.gameId).view(r.state,'full');
    if(this.isFinished()){view.phase='finished';view.result=this.result();view.legalActions=[];}
    this.ctx.storage.sql.exec('INSERT INTO frames(seq,value) VALUES(?,?)',r.frameSeq++,JSON.stringify(view));
  }
  private transaction(fn:()=>void){this.ctx.storage.transactionSync(()=>{fn();this.rec!.needsSync=true;this.persist();});}
  private selectedViewer(request:Request,r:RecordState):Viewer {
    const seat=new URL(request.url).searchParams.get('seat');
    // require(ownerId) runs before this: omniscient watching is private, and
    // never grants a human opponent access to an AI's unrevealed pieces.
    if(this.isArmyDuel() && (seat==='full'||seat==='0'||seat==='1'))return seat==='full'?'full':Number(seat) as Seat;
    if(this.isFinished())return 'full';
    if(seat==='full')throw new Error('Full view is only available for AI versus AI Army matches');
    if(seat==='0'||seat==='1') {
      const n=Number(seat) as Seat;
      if(r.input.seats[n].kind!=='human')throw new Error('AI seat information is private');
      return n;
    }
    return 'spectator';
  }
  private snapshot(viewer:Viewer,since=0):MatchSnapshot {
    const r=this.rec!;
    const events=this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM events WHERE seq>? ORDER BY seq LIMIT ?',since,MAX_MATCH_EVENTS+4).toArray().map(row=>JSON.parse(row.value) as MatchEvent);
    const watch=this.isArmyDuel();
    if(r.input.gameId==='army'&&(watch?viewer!=='full':!this.isFinished()))for(const e of events){if(viewer!==e.seat){
      // Thoughts can name unrevealed pieces just like candidate probabilities.
      // Filter the parsed projection only; the private persisted event stays intact.
      delete e.reasoning;
      if(e.metrics){const{elapsedMs,actualModel,usage,thoughtUsed}=e.metrics;e.metrics={elapsedMs,actualModel,usage,thoughtUsed};}
    }}
    return {id:r.id,gameId:r.input.gameId,status:r.status,version:r.version,view:{...(watch?armyWatchView(r.state,viewer):getGame(r.input.gameId).view(r.state,viewer)),...(this.isFinished()?{phase:'finished' as const,result:this.result(),legalActions:[]}: {})},seats:publicSeats(r.input.seats),events,error:r.error,limits:{maxPlies:MAX_PLIES,maxActiveMs:MAX_ACTIVE_MS,activeMs:r.activeMs}};
  }
  private broadcast(){
    for(const socket of this.ctx.getWebSockets())try {
      const attachment=socket.deserializeAttachment() as {viewer:Viewer};
      const viewer=this.isFinished()&&!(this.isArmyDuel()&&typeof attachment.viewer==='number')?'full':attachment.viewer;
      socket.send(JSON.stringify({type:'snapshot',snapshot:this.snapshot(viewer)}));
    }catch{socket.close(1011,'Connection expired');}
  }
  private quota(){return this.env.USER_QUOTAS.getByName(this.rec!.ownerId);}
  private async schedule(){
    const r=this.rec!;
    const canMove=!this.isFinished()&&r.state.phase==='playing'&&!r.inflight&&(r.auto||r.queuedStep)&&r.input.seats[r.state.turn].kind==='ai';
    if(canMove||r.needsSync){
      const delay=canMove?100:Math.min(60000,1000*2**Math.min(r.syncFailures,6));
      await this.ctx.storage.setAlarm(Date.now()+delay);
    }else if(!r.inflight)await this.ctx.storage.deleteAlarm();
  }
  private replay():ReplayManifest{
    const r=this.rec!;
    if(!this.isFinished()||!this.result())throw new Error('Replay is available after the match ends');
    const frames=this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM frames ORDER BY seq').toArray().map(x=>JSON.parse(x.value) as GameView);
    const events=this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM events ORDER BY seq').toArray().map(x=>JSON.parse(x.value) as MatchEvent);
    return {version:1,matchId:r.id,gameId:r.input.gameId,rulesVersion:r.rulesVersion,promptVersion:'decision-arena-v1',seed:r.seed,config:r.input.config,seats:publicSeats(r.input.seats),result:this.result()!,createdAt:r.createdAt,finishedAt:r.finishedAt!,frames,events};
  }
  private async sync(){
    const r=this.rec!;if(!r.needsSync)return;
    // DO state is authoritative. External projections can be retried independently.
    const version=r.version;
    try{
      const summary={version,id:r.id,gameId:r.input.gameId,status:r.status,ply:r.state.ply,config:r.input.config,seats:publicSeats(r.input.seats),result:this.result(),createdAt:r.createdAt,updatedAt:r.updatedAt};
      await this.env.DB.prepare('INSERT INTO arena_matches(id,owner_id,game_id,status,summary_json,created_at,updated_at,result_json) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,summary_json=excluded.summary_json,updated_at=excluded.updated_at,result_json=excluded.result_json WHERE COALESCE(json_extract(arena_matches.summary_json, \'$.version\'), -1) < ?').bind(r.id,r.ownerId,r.input.gameId,r.status,JSON.stringify(summary),r.createdAt,r.updatedAt,this.result()?JSON.stringify(this.result()):null,version).run();
      if(this.isFinished())await this.env.REPLAYS.put(`replays/${r.id}.json`,JSON.stringify(this.replay()),{httpMetadata:{contentType:'application/json'}});
      if(this.rec?.version===version){r.needsSync=false;r.syncFailures=0;this.persist(false);}
    }catch{r.syncFailures++;this.persist(false);}
  }
  private async create(ownerId:string,id:string,input:CreateMatchInput){
    if(this.rec)throw new Error('Match already exists');
    if(!input||!['gomoku','xiangqi','army'].includes(input.gameId)||!Array.isArray(input.seats)||input.seats.length!==2)throw new Error('Invalid match configuration');
    for(const seat of input.seats){
      if(!seat||!['human','ai'].includes(seat.kind))throw new Error('Invalid seat configuration');
      if(seat.kind==='ai'){
        if(!seat.profile||seat.profile.ownerId!==ownerId)throw new Error('Model does not belong to account');
        const credential=await this.env.DB.prepare('SELECT id FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(seat.profile.credentialId,ownerId).first();
        if(!credential)throw new Error('Credential not found');
        await assertBambooNodeAccess(this.env.DB,ownerId,seat.profile);
      }
    }
    // Recheck after asynchronous validation: simultaneous creates must not overwrite.
    if(this.rec)throw new Error('Match already exists');
    const game=getGame(input.gameId),seed=input.gameId==='army'?crypto.randomUUID():(input.seed??crypto.randomUUID());
    let state=game.create(input.config??{},seed);
    if(state.phase==='setup')for(const seat of [0,1] as const)if(input.seats[seat].kind==='ai')state=game.apply(state,seat,'ready');
    this.rec={id,ownerId,input,seed,state,rulesVersion:game.rulesVersion,status:'ready',version:0,revision:0,eventSeq:0,frameSeq:0,createdAt:Date.now(),updatedAt:Date.now(),activeMs:0,auto:false,queuedStep:false,needsSync:true,syncFailures:0};
    this.transaction(()=>{this.event('created');this.frame();});
    await this.schedule();await this.sync();
  }
  private applyAction(seat:Seat,actionId:string,metrics?:DecisionResponse['metrics'],reasoning?:DecisionResponse['reasoning']){
    const r=this.rec!,game=getGame(r.input.gameId);
    const action=game.legalActions(r.state,seat).find(a=>a.id===actionId);
    if(!action)throw new Error('Illegal action; no move executed');
    const next=game.apply(r.state,seat,actionId);
    this.transaction(()=>{
      r.state=next;r.revision++;r.error=undefined;
      this.event('action',{seat,action,metrics,...(reasoning?{reasoning:{text:reasoning.text,truncated:reasoning.truncated}}:{})});this.frame();
      if(next.phase==='finished') {r.status='finished';r.finishedAt=Date.now();r.auto=false;r.queuedStep=false;this.event('status',{message:'finished'});}
    });
  }
  private async command(ownerId:string,command:MatchCommand){
    const r=this.require(ownerId);
    if(!command || typeof command.operationId!=='string'||command.operationId.length<8||command.operationId.length>100)throw new Error('An operation ID is required');
    if(this.ctx.storage.sql.exec('SELECT id FROM operations WHERE id=?',command.operationId).toArray().length)return;
    if(this.isFinished())throw new Error('Match is finished');
    if(command.type!=='end'&&r.eventSeq>=MAX_MATCH_EVENTS)throw new Error('Match event limit reached; end this match or create a new one');
    if(command.type!=='end'&&r.rulesVersion!==getGame(r.input.gameId).rulesVersion)throw new Error('This match uses an older rules version; end it or deploy its original adapter');
    if(command.type==='action'){
      if(r.state.ply>=MAX_PLIES||r.activeMs>=MAX_ACTIVE_MS)throw new Error('Match limit reached; end this match or create a new one');
      const seat=command.seat??r.state.turn;
      if(seat!==0&&seat!==1)throw new Error('Invalid seat');
      if(r.input.seats[seat].kind!=='human')throw new Error('This seat is controlled by AI');
      if(command.version!==r.version)throw new Error('Board changed; refresh and try again');
      if(r.inflight)throw new Error('A decision is in progress');
      this.ctx.storage.transactionSync(()=>{this.applyAction(seat,command.actionId??'');this.ctx.storage.sql.exec('INSERT INTO operations(id,version) VALUES(?,?)',command.operationId,r.version);});
    }else{
      if(!['start','resume','step','pause','end'].includes(command.type))throw new Error('Unknown command');
      if(['start','resume','step'].includes(command.type)){
        if(r.inflight)throw new Error('A decision is in progress');
        if(r.state.phase!=='playing')throw new Error('Both sides must finish deployment first');
        if(r.state.ply>=MAX_PLIES||r.activeMs>=MAX_ACTIVE_MS)throw new Error('Match limit reached; end this match or create a new one');
      }
      this.transaction(()=>{
        if(command.type==='pause'){r.auto=false;r.queuedStep=false;r.status='paused';}
        else if(command.type==='end'){
          r.auto=false;r.queuedStep=false;r.inflight=undefined;r.status='finished';r.finishedAt=Date.now();r.result={winner:null,reason:'ended_by_user'};this.frame();
        }else {r.auto=command.type!=='step';r.queuedStep=command.type==='step';r.status='running';r.error=undefined;}
        this.event('status',{message:r.status});
        this.ctx.storage.sql.exec('INSERT INTO operations(id,version) VALUES(?,?)',command.operationId,r.version+1);
      });
    }
    if(!r.inflight && (!r.auto||this.isFinished()))await this.quota().release(r.id);
    await this.schedule();this.broadcast();await this.sync();
  }
  async alarm(){
    const r=this.rec;if(!r)return;
    if(!this.isFinished()&&r.rulesVersion!==getGame(r.input.gameId).rulesVersion){this.transaction(()=>{r.auto=false;r.queuedStep=false;r.status='error';r.error='Rules version changed; this match cannot continue';});await this.quota().release(r.id);await this.sync();return;}
    if(r.inflight){
      // An interrupted alarm may have already reached the paid provider. Never retry it silently.
      this.transaction(()=>{r.activeMs+=Math.min(120000,Date.now()-r.inflight!.startedAt);r.inflight=undefined;r.auto=false;r.queuedStep=false;r.status='error';r.error='The previous model call was interrupted. Its billing status is unknown; retry explicitly.';this.event('error',{message:r.error});});
      await this.quota().release(r.id);await this.sync();await this.schedule();this.broadcast();return;
    }
    if(this.isFinished()||r.state.phase!=='playing'||(!r.auto&&!r.queuedStep)||r.input.seats[r.state.turn].kind!=='ai'){
      await this.sync();await this.schedule();return;
    }
    if(r.state.ply>=MAX_PLIES||r.activeMs>=MAX_ACTIVE_MS||r.eventSeq>=MAX_MATCH_EVENTS){
      this.transaction(()=>{r.auto=false;r.queuedStep=false;r.status='paused';r.error='Match limit reached';this.event('status',{message:r.error});});await this.quota().release(r.id);await this.sync();await this.schedule();this.broadcast();return;
    }
    if(!await this.quota().acquire(r.id)){
      this.transaction(()=>{r.auto=false;r.queuedStep=false;r.status='paused';r.error='Another AI match is running in this account';this.event('status',{message:r.error});});await this.sync();await this.schedule();this.broadcast();return;
    }
    // Requests can interleave while acquiring the quota.
    if(this.isFinished()||(!r.auto&&!r.queuedStep)){await this.quota().release(r.id);return;}
    const game=getGame(r.input.gameId),seat=r.state.turn,profile=r.input.seats[seat].profile!;
    const operationId=crypto.randomUUID(),revision=r.revision;
    this.transaction(()=>{r.inflight={id:operationId,revision,seat,startedAt:Date.now()};r.status='running';r.queuedStep=false;});this.broadcast();
    try{
      const credential=await this.env.DB.prepare('SELECT ciphertext FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(profile.credentialId,r.ownerId).first<{ciphertext:string}>();
      if(!credential)throw new Error('Credential was removed; choose an available model for a new match');
      const key=await decryptSecret(credential.ciphertext,this.env.ARENA_ENCRYPTION_KEY,r.ownerId);
      await assertBambooNodeAccess(this.env.DB,r.ownerId,profile);
      if(this.rec?.inflight?.id!==operationId||r.revision!==revision||this.isFinished())return;
      const actions=game.legalActions(r.state,seat);
      const history=this.ctx.storage.sql.exec<{value:string}>('SELECT value FROM events ORDER BY seq DESC LIMIT 40').toArray().reverse().map(row=>JSON.parse(row.value) as MatchEvent).filter(e=>e.type==='action').slice(-20).map(e=>({seat:e.seat,action:e.action}));
      const decision=await decide(profile,key,{state:{game:r.input.gameId,rules:game.rules,position:game.observe(r.state,seat),recentMoves:history},instructions:'Choose exactly one legal action to improve your chance of winning. The position and recent moves are the full available information.',actions},undefined,undefined,localProviderOptions(this.env));
      if(this.rec?.inflight?.id!==operationId||r.revision!==revision||this.isFinished())return;
      // Key deletion while inference is in flight also prevents committing its result.
      const stillExists=await this.env.DB.prepare('SELECT ciphertext FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(profile.credentialId,r.ownerId).first<{ciphertext:string}>();
      if(!stillExists)throw new Error('Credential was removed during the decision');
      await assertBambooNodeKey(profile,stillExists.ciphertext,key,this.env.ARENA_ENCRYPTION_KEY,r.ownerId);
      await assertBambooNodeAccess(this.env.DB,r.ownerId,profile);
      if(this.rec?.inflight?.id!==operationId||r.revision!==revision||this.isFinished())return;
      this.ctx.storage.transactionSync(()=>{
        r.activeMs+=Date.now()-r.inflight!.startedAt;r.inflight=undefined;
        this.applyAction(seat,decision.actionId,decision.metrics,decision.reasoning);
        if(!this.isFinished()){r.status=r.auto?'running':'paused';this.persist();}
      });
    }catch(error){
      if(this.rec?.inflight?.id===operationId&&!this.isFinished())this.transaction(()=>{r.activeMs+=Date.now()-r.inflight!.startedAt;r.inflight=undefined;r.auto=false;r.queuedStep=false;r.status='error';r.error=safeError(error);this.event('error',{message:r.error});});
    }finally{
      if(!r.auto||this.isFinished()||(r.status as MatchStatus)==='error'||r.input.seats[r.state.turn].kind==='human')await this.quota().release(r.id);
      await this.schedule();this.broadcast();await this.sync();await this.schedule();
    }
  }
  async fetch(request:Request):Promise<Response>{
    try{
      const ownerId=request.headers.get('X-Arena-Owner');if(!ownerId)return json({error:'Unauthorized'},401);
      const url=new URL(request.url),parts=url.pathname.split('/').filter(Boolean),id=parts[1];
      if(request.method==='POST'&&parts.length===2){await this.create(ownerId,id,await request.json() as CreateMatchInput);return json(this.snapshot(this.selectedViewer(request,this.rec!)),201);}
      const r=this.require(ownerId);
      if(parts[2]==='socket'){
        if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket required'},426);
        const viewer=this.selectedViewer(request,r),pair=new WebSocketPair();
        pair[1].serializeAttachment({viewer});this.ctx.acceptWebSocket(pair[1]);
        pair[1].send(JSON.stringify({type:'snapshot',snapshot:this.snapshot(viewer)}));
        return new Response(null,{status:101,webSocket:pair[0]});
      }
      if(parts[2]==='replay'&&request.method==='GET')return json(this.replay());
      if(parts[2]==='commands'&&request.method==='POST'){
        // Validate the requested response view before scheduling any paid work.
        this.selectedViewer(request,r);
        await this.command(ownerId,await request.json() as MatchCommand);
      }
      else if(request.method!=='GET')return json({error:'Method not allowed'},405);
      return json(this.snapshot(this.selectedViewer(request,r),Math.max(0,Number(url.searchParams.get('since'))||0)));
    }catch(error){const message=safeError(error);return json({error:message},message==='Match not found'?404:400);}
  }
  webSocketMessage(socket:WebSocket,message:string|ArrayBuffer){if(message==='ping')socket.send('pong');}
  webSocketClose(socket:WebSocket,code:number,reason:string){
    // Abnormal/empty close codes are reserved and cannot be sent on the wire.
    try { socket.close([1005,1006,1015].includes(code)?1000:code,reason); } catch { /* Peer has already disconnected. */ }
  }
}

export default {
  async fetch(request:Request,env:Env):Promise<Response>{
    if(env.LOCAL_DEV==='true'&&(!env.ARENA_INTERNAL_SECRET||request.headers.get('X-Arena-Internal')!==env.ARENA_INTERNAL_SECRET))return json({error:'Internal authentication required'},401);
    const owner=request.headers.get('X-Arena-Owner');if(!owner)return json({error:'Unauthorized'},401);
    const url=new URL(request.url),parts=url.pathname.split('/').filter(Boolean);
    if(parts[0]==='validate-endpoint'&&request.method==='POST'){
      try{
        const body=await request.json() as {endpoint:string;provider:ProviderId};
        if(typeof body.endpoint!=='string'||(!['openrouter','systemone','custom-openrouter','custom-systemone'].includes(body.provider)&&!isBambooNodeProvider(body.provider)))throw new Error('Invalid provider configuration');
        return json({endpoint:await validateEndpoint(body.endpoint,body.provider,localProviderOptions(env))});
      }catch(error){return json({error:safeError(error)},400);}
    }
    if(parts[0]==='provider-test'&&request.method==='POST'){
      try {
        const body=await request.json() as {profile:ModelProfile;key:string;request:DecisionRequest};
        if(!body.profile||body.profile.ownerId!==owner)throw new Error('Invalid model owner');
        // A unique lease prevents a late test from releasing another match's quota.
        const quota=env.USER_QUOTAS.getByName(owner),leaseId=`probe:${crypto.randomUUID()}`;
        if(!await quota.acquire(leaseId))return json({error:'Another model request is running in this account'},429);
        try{
          // Credential exists only in this internal request; it is never persisted here.
          const validateConnection = async () => {
            await assertBambooNodeAccess(env.DB,owner,body.profile);
            if(isBambooNodeProvider(body.profile.provider)) {
              const current=await env.DB.prepare('SELECT ciphertext FROM arena_credentials WHERE id=? AND owner_id=? AND deleted_at IS NULL').bind(body.profile.credentialId,owner).first<{ciphertext:string}>();
              if(!current)throw new Error('BambooNode credential was removed; reconnect before testing');
              await assertBambooNodeKey(body.profile,current.ciphertext,body.key,env.ARENA_ENCRYPTION_KEY,owner);
            }
          };
          await validateConnection();
          const decision=await decide(body.profile,body.key,body.request,undefined,undefined,localProviderOptions(env));
          await validateConnection();
          return json(decision);
        }finally{await quota.release(leaseId);}
      }catch(error){return json({error:safeError(error)},400);}
    }
    if(parts[0]==='arcade-sessions'){
      let id=parts[1];
      if(request.method==='POST'&&parts.length===1){id=`arcade-${crypto.randomUUID()}`;url.pathname=`/arcade-sessions/${id}`;}
      if(!id||!/^arcade-[a-zA-Z0-9-]{8,100}$/.test(id))return json({error:'Invalid arcade session ID'},400);
      return env.ARCADES.getByName(id).fetch(new Request(url,request));
    }
    if(parts[0]!=='matches')return json({error:'Not found'},404);
    let id=parts[1];
    if(request.method==='POST'&&parts.length===1){id=crypto.randomUUID();url.pathname=`/matches/${id}`;}
    if(!id||!/^[a-zA-Z0-9-]{8,100}$/.test(id))return json({error:'Invalid match ID'},400);
    return env.MATCHES.getByName(id).fetch(new Request(url,request));
  },
} satisfies ExportedHandler<Env>;
