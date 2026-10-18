import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { TetrisGoalTarget } from '@decision-arena/core';
import { arcadeDecisionInstructions } from '../src/arcade/decision';
import { tetris, tetrisCells, TETROMINOES, type TetrisState, type FallingPiece } from '../src/arcade/tetris';
import { applyTetrisGoalChoice, tetrisGoalCandidates, tetrisGoalScope, tetrisHarnessInstructions, tetrisHarnessPosition,
  tetrisHarnessVersion, tetrisLandingProjections, TETRIS_BASELINE_INSTRUCTIONS, TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS,
  TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS, TETRIS_V8_SOURCE_STRATEGY_NOTES, TETRIS_V8_ACTION_INSTRUCTIONS,
  TETRIS_V8_GOAL_INSTRUCTIONS, TETRIS_V8_ARENA_ADDENDUM, type TetrisGoalMemory } from '../src/arcade/tetris-harness';
import { renderTetrisObservationPng, TETRIS_IMAGE_WIDTH, TETRIS_IMAGE_HEIGHT } from '../src/arcade/tetris-vision';
const baseline='tetris-harness-baseline-v1',v8='tetris-harness-v8-realtime-v1';
const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const create=()=>tetris.create({},'tetris-v8-independent-fixture') as TetrisState;
const observe=(s:TetrisState)=>tetris.observe(s) as any;
const ids=['keep','clear',...Array.from({length:40},(_,i)=>`target:${Math.floor(i/4)}:${i%4}`)];
const metrics=(board:number[])=>{
  const heights:number[]=[],holes:number[]=[];
  for(let x=0;x<10;x++){
    const top=board.findIndex((value,index)=>index%10===x && value!==0);
    const topRow=top<0?22:Math.floor(top/10);heights.push(22-topRow);
    holes.push(board.filter((value,index)=>index%10===x && Math.floor(index/10)>topRow && value===0).length);
  }
  return {holes:holes.reduce((n,x)=>n+x,0),height:Math.max(...heights),total:heights.reduce((n,x)=>n+x,0),
    bump:heights.slice(1).reduce((n,x,i)=>n+Math.abs(x-heights[i]),0)};
};
function decodePng(png:Uint8Array){
  expect([...png.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
  const bytes=Buffer.from(png),types:string[]=[],data:Buffer[]=[];let offset=8;
  while(offset<bytes.length){const size=bytes.readUInt32BE(offset),type=bytes.toString('ascii',offset+4,offset+8);types.push(type);
    if(type==='IHDR'){expect(bytes.readUInt32BE(offset+8)).toBe(TETRIS_IMAGE_WIDTH);expect(bytes.readUInt32BE(offset+12)).toBe(TETRIS_IMAGE_HEIGHT);expect([...bytes.subarray(offset+16,offset+21)]).toEqual([8,3,0,0,0]);}
    if(type==='IDAT')data.push(bytes.subarray(offset+8,offset+8+size));offset+=12+size;}
  expect(types).toEqual(['IHDR','PLTE','IDAT','IEND']);
  const raw=inflateSync(Buffer.concat(data));expect(raw.length).toBe((TETRIS_IMAGE_WIDTH+1)*TETRIS_IMAGE_HEIGHT);
  for(let y=0;y<TETRIS_IMAGE_HEIGHT;y++)expect(raw[y*(TETRIS_IMAGE_WIDTH+1)]).toBe(0);
  return (x:number,y:number)=>raw[y*(TETRIS_IMAGE_WIDTH+1)+1+x];
}
describe('frozen Tetris harness protocol',()=>{
  it('preserves the baseline text and observation exactly, with an explicit realtime V8 addendum',()=>{
    const position=observe(create());
    expect(TETRIS_BASELINE_INSTRUCTIONS).toBe(arcadeDecisionInstructions('tetris'));
    expect(tetrisHarnessVersion(undefined)).toBe(baseline);
    expect(tetrisHarnessInstructions(baseline,'action')).toBe(TETRIS_BASELINE_INSTRUCTIONS);
    expect(tetrisHarnessPosition(baseline,position)).toBe(position);
    expect(TETRIS_V8_ACTION_INSTRUCTIONS).toBe(TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS+'\n策略参考：\n'+TETRIS_V8_SOURCE_STRATEGY_NOTES+'\n'+TETRIS_V8_ARENA_ADDENDUM);
    expect(TETRIS_V8_GOAL_INSTRUCTIONS).toBe(TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS+'\n'+TETRIS_V8_ARENA_ADDENDUM);
    expect(TETRIS_V8_ARENA_ADDENDUM).toContain('冲突时优先');expect(TETRIS_V8_ARENA_ADDENDUM).toContain('物理持续');
    for(const value of ['v8','tetris-harness-v8',null,1,'constructor'])expect(()=>tetrisHarnessVersion(value)).toThrow();
  });
  it('pins all three exact frozen research text hashes without importing the reference project',()=>{
    expect(hash(TETRIS_V8_SOURCE_ACTION_INSTRUCTIONS)).toBe('38b7d6e45e00a5c5b12a40783673a7b4263a31c3bd978d42111797049c8ef1da');
    expect(hash(TETRIS_V8_SOURCE_GOAL_INSTRUCTIONS)).toBe('4a3d30b81be0fd58983549888699e6c377ab8d950a6818ff2bfc7e324dae23b8');
    expect(hash(TETRIS_V8_SOURCE_STRATEGY_NOTES)).toBe('82d91f9dc478adf2051a2ec69d1930d861441525bb00a7fa636e9df91c86f25d');
  });
  it('returns every target in coordinate order, including impossible goals, with no executable input',()=>{
    for(const type of TETROMINOES){const s=create();s.active={type,rotation:0,x:3,y:-2};
      const choices=tetrisGoalCandidates(observe(s));expect(choices.map(c=>c.id)).toEqual(ids);
      expect(choices.every(c=>!Object.hasOwn(c,'input'))).toBe(true);
      const invalid=tetrisLandingProjections(observe(s)).candidates.filter(c=>!c.pose_valid);
      expect(invalid.length).toBeGreaterThan(0);
      for(const c of invalid){expect(c).toMatchObject({native_reachability:'not_proven',landing_cells:null,lines_cleared:null,points_delta:null,holes_after:null,top_out:null});expect(choices.find(x=>x.id===c.id)!.label).toContain('后果未知');}
    }
  });
  it('keeps/clears/selects model goal IDs strictly and never emits an input or chooses a substitute',()=>{
    const current:TetrisGoalTarget={leftmostColumn:3,rotation:2};
    expect(applyTetrisGoalChoice(current,'keep')).toEqual(current);expect(applyTetrisGoalChoice(current,'keep')).not.toBe(current);
    expect(applyTetrisGoalChoice(null,'keep')).toBeNull();expect(applyTetrisGoalChoice(current,'clear')).toBeNull();
    expect(applyTetrisGoalChoice(current,'target:9:3')).toEqual({leftmostColumn:9,rotation:3});
    for(const id of ['left:100','target:10:0','target:2:4','target:02:0','target:2:0\n','target:1:0:hard-drop'])expect(()=>applyTetrisGoalChoice(current,id)).toThrow();
  });
});
describe('conditional projections share native geometry, not reachability search',()=>{
  it.each(['empty','uneven','holes'])('%s board: all seven tetrominoes match native hard drop, line clear, scoring and top-out',pattern=>{
    for(const type of TETROMINOES){const s=create();s.active={type,rotation:0,x:3,y:-2};s.score.lines=19;s.score.points=700;
      if(pattern!=='empty')for(let x=0;x<10;x++)for(let y=19-(x*3%6);y<20;y++)if(pattern!=='holes'||(x+y)%4!==0)s.board[(y+2)*10+x]=x%7+1;
      const before=JSON.stringify(s),projections=tetrisLandingProjections(observe(s));
      expect(JSON.stringify(s)).toBe(before);expect(projections.candidates.map(p=>p.id)).toEqual(ids.slice(2));
      for(const p of projections.candidates){if(!p.pose_valid)continue;
        const assumed=structuredClone(s);assumed.active={type,rotation:p.rotation,x:p.landing_origin!.x,y:s.active.y} as FallingPiece;
        tetris.restore(assumed);
        const live=tetris.step(tetris.input(assumed,{buttons:['hard-drop'],durationMs:100}),1) as TetrisState;
        const facts=metrics(live.board);
        expect(live.score.lines!-s.score.lines!).toBe(p.lines_cleared);expect(live.score.points-s.score.points).toBe(p.points_delta);
        expect(live.board.slice(0,20).some(Boolean)).toBe(p.top_out);expect(facts).toEqual({holes:p.holes_after,height:p.max_height,total:p.total_height,bump:p.bumpiness});
        expect(p.holes_delta).toBe(p.holes_after!-metrics(s.board).holes);expect(p.native_reachability).toBe('not_proven');
      }
    }
  });
  it('uses pre-clear level and actual four-cell landing for a four-row I clear',()=>{
    const s=create();s.active={type:'I',rotation:0,x:3,y:-2};s.score.lines=9;
    for(let y=16;y<20;y++)for(let x=0;x<10;x++)if(x!==4)s.board[(y+2)*10+x]=1;
    const p=tetrisLandingProjections(observe(s)).candidates.find(p=>p.id==='target:4:1')!;
    expect(p).toMatchObject({pose_valid:true,landing_origin:{x:2,y:16},landing_cells:[{x:4,y:16},{x:4,y:17},{x:4,y:18},{x:4,y:19}],lines_cleared:4,points_delta:800,holes_after:0,max_height:0,total_height:0,bumpiness:0,top_out:false});
  });
  it('does not filter lethal goals, search around barriers, or treat geometric validity as reachable',()=>{
    const s=create();s.active={type:'O',rotation:0,x:3,y:-2};
    // A locked column reaches the visible ceiling. An assumed O above it is valid but locks in spawn rows.
    for(let y=0;y<20;y++)s.board[(y+2)*10]=1;
    const observation=observe(s),all=tetrisLandingProjections(observation).candidates;
    expect(all.find(p=>p.id==='target:0:0')).toMatchObject({pose_valid:true,top_out:true,native_reachability:'not_proven'});
    expect(tetrisGoalCandidates(observation).map(p=>p.id)).toEqual(ids);
    // At the present low y, a blocked assumed pose is null even if it could have been reached earlier.
    const low=create();low.active={type:'T',rotation:0,x:3,y:10};low.board[(10+2)*10]=1;
    expect(tetrisLandingProjections(observe(low)).candidates.find(p=>p.id==='target:0:1')).toMatchObject({pose_valid:false,invalid_reason:'start_pose_collision',points_delta:null});
  });
  it('does not inspect random state or previews beyond five, and does not alter native candidates or state',()=>{
    const s=create(),o=observe(s),before=JSON.stringify(s),actions=tetris.candidates(s);
    const expected=tetrisHarnessPosition(v8,o);Object.defineProperty(o,'rng',{get(){throw new Error('private rng accessed');}});
    o.next.push('PRIVATE-FUTURE-PIECE');o.secret='not-an-observation';
    expect(tetrisHarnessPosition(v8,o)).toEqual(expected);expect(tetris.candidates(s)).toEqual(actions);expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(expected)).not.toMatch(/PRIVATE|rng|secret/);
  });
  it('fails closed on absent rows, mismatched cells and non-Tetris input',()=>{
    const o=observe(create());
    for(const value of [{...o,gameId:'snake'},{...o,board:{rows:o.board.rows.slice(1)}},{...o,active:{...o.active,cells:[{x:1,y:1}]}},{...o,score:{lines:-1,points:0,survivedTicks:0}}]){
      expect(()=>tetrisLandingProjections(value)).toThrow('Invalid public Tetris observation');expect(()=>renderTetrisObservationPng(value)).toThrow();
    }
  });
});
describe('goal scope and realtime control evidence',()=>{
  it('retains scope through movement but changes it for hold or a changed locked board',()=>{
    const s=create(),scope=tetrisGoalScope(observe(s));
    const moved=tetris.step(tetris.input(s,{buttons:['right'],durationMs:100}),2) as TetrisState;
    expect(tetrisGoalScope(observe(moved))).toEqual(scope);
    const held=tetris.step(tetris.input(s,{buttons:['hold'],durationMs:100}),1) as TetrisState;
    expect(tetrisGoalScope(observe(held)).pieceId).not.toBe(scope.pieceId);
    const changed=structuredClone(s);changed.board[219]=1;expect(tetrisGoalScope(observe(changed)).boardKey).not.toBe(scope.boardKey);
  });
  it('reports only confirmed real transitions and conditions crossing on unchanged target and rotation',()=>{
    const o=observe(create()),target:TetrisGoalTarget={leftmostColumn:4,rotation:0};
    const memory:TetrisGoalMemory={target,ageActions:1,recentActions:[{actionId:'right:100',observedTick:10,appliedTick:80,beforeLeftmostColumn:3,beforeRotation:0,outcome:'applied',targetAtAction:target}]};
    let c=tetrisHarnessPosition(v8,o,memory) as any;expect(c.tetris_control_facts.last_transition).toBeNull();
    Object.assign(memory.recentActions[0],{afterObservedTick:95,afterLeftmostColumn:5,afterRotation:0});
    c=tetrisHarnessPosition(v8,o,memory) as any;expect(c.tetris_control_facts.last_transition).toMatchObject({physical_ticks:85,actual_column_delta:2,strictly_crossed_target_column:true});
    memory.target={leftmostColumn:6,rotation:0};expect((tetrisHarnessPosition(v8,o,memory) as any).tetris_control_facts.last_transition.crossing_comparison_applicable).toBe(false);
    memory.target=target;memory.recentActions[0].afterRotation=1;expect((tetrisHarnessPosition(v8,o,memory) as any).tetris_control_facts.last_transition.crossing_comparison_applicable).toBe(false);
  });
});
describe('deterministic public PNG without DOM or private information',()=>{
  it('emits a bounded valid PNG containing actual active cells and exposes spawn rows',()=>{
    const s=create();s.active={type:'T',rotation:0,x:3,y:-2};const png=renderTetrisObservationPng(observe(s));
    expect(png.byteLength).toBeLessThan(256*1024);const pixel=decodePng(png);
    // The white border surrounds the actual top-center T cell in spawn row -2.
    expect(pixel(36+4*20+1,80+1)).toBe(10);expect(pixel(36+4*20+5,80+5)).toBe(3);
    expect(pixel(36+1,80+1)).toBe(9);expect(pixel(36+1,80+2*20+2)).toBe(8);
    expect(renderTetrisObservationPng(observe(s))).toEqual(png);
  });
  it('does not change bytes for secrets, target/projection advice, private RNG or additional queue',()=>{
    const o=observe(create()),png=renderTetrisObservationPng(o);
    const enriched={...o,next:[...o.next,'PRIVATE'],rng:999,owner:'private',target:{leftmostColumn:0},tetris_landing_projections:{best:'private'},prompt:'private'};
    expect(renderTetrisObservationPng(enriched)).toEqual(png);
    const changed=structuredClone(o);changed.hold=changed.hold==='I'?'T':'I';expect(hash(renderTetrisObservationPng(changed))).not.toBe(hash(png));
  });
});
