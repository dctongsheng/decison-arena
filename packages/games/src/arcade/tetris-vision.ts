import { readTetrisObservation } from './tetris-harness';
import { tetrisCells, TETROMINOES, type Tetromino } from './tetris';

/** Original bitmap renderer. Public observation only; no DOM, fonts, network, seed or target overlay. */
export const TETRIS_VISION_VERSION = 'arena-tetris-public-observation-png-v1';
export const TETRIS_IMAGE_WIDTH = 384, TETRIS_IMAGE_HEIGHT = 576;
// Indexed PNG keeps a complete metadata-free frame below 256 KiB without a platform-specific compressor.
const PALETTE = [0x101724,0x62cbd3,0xe8c96b,0xb49be8,0x9dcc7b,0xda877e,0x78a7df,0xe6aa6d,0x1c293a,0x30304b,0xf3f5fa,0x455468,0xa3b2c9];
const GLYPHS: Record<string,string> = {
  '0':'0E11131519110E','1':'040C040404040E','2':'0E11010204081F','3':'1E01010601011E','4':'02060A121F0202',
  '5':'1F10101E01011E','6':'0E10101E11110E','7':'1F010204080808','8':'0E11110E11110E','9':'0E11110F01010E',
  A:'0E11111F111111',B:'1E11111E11111E',C:'0F10101010100F',D:'1E11111111111E',E:'1F10101E10101F',
  F:'1F10101E101010',G:'0F10101711110F',H:'1111111F111111',I:'0E04040404040E',J:'0702020212120C',
  K:'11121418141211',L:'1010101010101F',M:'111B1515111111',N:'11191513111111',O:'0E11111111110E',
  P:'1E11111E101010',Q:'0E11111115120D',R:'1E11111E141211',S:'0F10100E01011E',T:'1F040404040404',
  U:'1111111111110E',V:'11111111110A04',W:'11111115151B11',X:'11110A040A1111',Y:'11110A04040404',Z:'1F01020408101F',
  '-':'0000001F000000',':':'00040000040000','.':'00000000000404','/':'01020204080810','=':'00001F001F0000',
};
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => { let c = n; for (let k=0;k<8;k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0; });
function u32(n: number) { return Uint8Array.of(n >>> 24, n >>> 16, n >>> 8, n); }
function concat(parts: Uint8Array[]) { const out = new Uint8Array(parts.reduce((n,p) => n+p.length,0)); let i=0; for(const p of parts){out.set(p,i);i+=p.length;} return out; }
function chunk(type: string, data: Uint8Array) {
  const name = Uint8Array.from(type, c => c.charCodeAt(0)); let crc=0xffffffff;
  for(const part of [name,data]) for(const byte of part) crc=CRC_TABLE[(crc^byte)&255] ^ crc>>>8;
  return concat([u32(data.length),name,data,u32((crc^0xffffffff)>>>0)]);
}
function storedZlib(data: Uint8Array) {
  const parts: Uint8Array[] = [Uint8Array.of(0x78,0x01)]; let a=1,b=0;
  for(let i=0;i<data.length;i+=65535){ const block=data.subarray(i,i+65535),n=block.length;
    parts.push(Uint8Array.of(i+n===data.length?1:0,n&255,n>>>8,(~n)&255,((~n)>>>8)&255),block);
    for(const byte of block){a=(a+byte)%65521;b=(b+a)%65521;}
  }
  parts.push(u32(((b<<16)|a)>>>0));return concat(parts);
}
/** Same public display fields -> byte-identical indexed PNG in Workers and browsers. */
export function renderTetrisObservationPng(position: unknown): Uint8Array {
  const { observation: o } = readTetrisObservation(position), w=TETRIS_IMAGE_WIDTH,h=TETRIS_IMAGE_HEIGHT;
  const pixels=new Uint8Array(w*h);
  const rect=(x:number,y:number,rw:number,rh:number,color:number)=>{
    for(let py=Math.max(0,y);py<Math.min(h,y+rh);py++) pixels.fill(color,py*w+Math.max(0,x),py*w+Math.min(w,x+rw));
  };
  const text=(x:number,y:number,value:string,scale=1,color=10)=>{
    for(const char of value.toUpperCase()){
      const glyph=GLYPHS[char];
      if(glyph)for(let row=0;row<7;row++){const bits=parseInt(glyph.slice(row*2,row*2+2),16);for(let col=0;col<5;col++)if(bits&(1<<(4-col)))rect(x+col*scale,y+row*scale,scale,scale,color);}
      x+=6*scale;
    }
  };
  const block=(x:number,y:number,color:number,active=false,size=20)=>{
    rect(x+1,y+1,size-2,size-2,active?10:11);rect(x+(active?3:2),y+(active?3:2),size-(active?6:4),size-(active?6:4),color);
  };
  const preview=(type:Tetromino|null,x:number,y:number)=>{
    if(type===null){text(x,y+4,'EMPTY');return;}
    const cells=tetrisCells({type,rotation:0,x:0,y:0}),left=Math.min(...cells.map(p=>p.x)),top=Math.min(...cells.map(p=>p.y));
    for(const p of cells)block(x+(p.x-left)*12,y+(p.y-top)*12,TETROMINOES.indexOf(type)+1,false,12);
  };
  text(20,15,'TETRIS',3);text(20,43,'ACTUAL CELLS - WHITE BORDER IS ACTIVE',1,12);
  const bx=36,by=80,size=20;
  for(let x=0;x<10;x++)text(bx+x*size+7,65,String(x));
  for(const row of o.board.rows){const py=by+(row.y+2)*size;text(12,py+6,String(row.y),1,row.y<0?12:10);
    for(let x=0;x<10;x++){const px=bx+x*size;rect(px,py,size,size,11);rect(px+1,py+1,size-1,size-1,row.y<0?9:8);
      const symbol=row.cells[x];if(symbol!=='.')block(px,py,TETROMINOES.indexOf(symbol as Tetromino)+1);}
  }
  for(const p of o.active?.cells??[])block(bx+p.x*size,by+(p.y+2)*size,TETROMINOES.indexOf(o.active!.type)+1,true);
  rect(bx,by+40,200,1,12);
  text(252,82,'ACTIVE',2);text(252,104,o.active?`${o.active.type} ROT ${o.active.rotation}`:'NONE');
  text(252,128,'SPAWN -2 -1',1,12);text(252,142,'Y DOWN',1,12);text(252,163,'NEXT',2);
  o.next.forEach((type,i)=>{text(252,193+i*40,`${i+1} ${type}`);preview(type,286,188+i*40);});
  text(252,402,'HOLD',2);preview(o.hold,252,427);text(252,459,o.holdAvailable?'AVAILABLE':'USED');
  text(252,486,'POINTS');text(252,501,String(o.score.points));text(252,523,`LINES ${o.score.lines}`);
  text(36,545,o.status,2);text(252,551,`TICK ${o.tick}`,1,12);
  const scanlines=new Uint8Array((w+1)*h);for(let y=0;y<h;y++)scanlines.set(pixels.subarray(y*w,(y+1)*w),y*(w+1)+1);
  const palette=Uint8Array.from(PALETTE.flatMap(c=>[c>>>16,(c>>>8)&255,c&255]));
  return concat([Uint8Array.of(137,80,78,71,13,10,26,10),chunk('IHDR',concat([u32(w),u32(h),Uint8Array.of(8,3,0,0,0)])),
    chunk('PLTE',palette),chunk('IDAT',storedZlib(scanlines)),chunk('IEND',new Uint8Array())]);
}
