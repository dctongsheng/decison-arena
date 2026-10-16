export interface XiangqiPiece { type: string; color: 'r' | 'b' }
export interface XiangqiMove { color: 'r' | 'b'; from: string; to: string; flags: string; piece: string; captured?: string; iccs: string }
export class Xiangqi {
  constructor(fen?: string);
  moves(options?: { verbose?: boolean; square?: string }): XiangqiMove[] | string[];
  move(move: string | { from: string; to: string }): XiangqiMove | null;
  undo(): XiangqiMove | null;
  fen(): string;
  board(): (XiangqiPiece | null)[][];
  turn(): 'r' | 'b';
  in_check(): boolean;
  in_checkmate(): boolean;
  in_stalemate(): boolean;
  in_threefold_repetition(): boolean;
  insufficient_material(): boolean;
  game_over(): boolean;
  ascii(): string;
}
