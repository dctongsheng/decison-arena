import type { CSSProperties } from 'react';
import type { GameId, GameView } from '@decision-arena/core';

export function Board({
  view,
  selected,
  destinations = [],
  lastTo,
  disabled = false,
  obscured = false,
  onCell,
  labels,
}: {
  view: GameView;
  selected?: number | null;
  destinations?: number[];
  lastTo?: number;
  disabled?: boolean;
  obscured?: boolean;
  onCell?: (index: number) => void;
  labels: {
    board: string;
    empty: string;
    hidden: string;
    river: string;
    camp: string;
  };
}) {
  // A visual overlay alone still exposes ranks to screen readers and DOM queries.
  // Do not create piece nodes at all until the next player explicitly reveals.
  if (obscured)
    return (
      <div
        className={`arena-board-placeholder ${view.gameId}`}
        style={{ aspectRatio: `${view.cols}/${view.rows}` }}
        aria-hidden="true"
      />
    );
  const gridStyle = {
    '--cols': view.cols,
    '--rows': view.rows,
  } as CSSProperties;
  const rank = (row: number) => (view.gameId === 'xiangqi' ? 9 - row : row + 1);
  return (
    <div className={`arena-board-wrap ${view.gameId}`}>
      <div className="arena-board-files" style={gridStyle}>
        {Array.from({ length: view.cols }, (_, i) => (
          <span key={i}>{String.fromCharCode(65 + i)}</span>
        ))}
      </div>
      <div
        className={`arena-board ${view.gameId}`}
        style={gridStyle}
        role="group"
        aria-label={labels.board}
      >
        <BoardLines view={view} />
        {view.gameId === 'xiangqi' && (
          <div className="arena-river" aria-hidden="true">
            {labels.river}
          </div>
        )}
        {view.cells.map((piece, index) => {
          const row = Math.floor(index / view.cols),
            col = index % view.cols;
          const camp =
            view.gameId === 'army' &&
            [
              [2, 1],
              [2, 3],
              [3, 2],
              [4, 1],
              [4, 3],
              [7, 1],
              [7, 3],
              [8, 2],
              [9, 1],
              [9, 3],
            ].some(([r, c]) => r === row && c === col);
          const destination = destinations.includes(index);
          return (
            <button
              key={index}
              type="button"
              disabled={disabled || !onCell}
              onClick={() => onCell?.(index)}
              className={`arena-cell ${selected === index ? 'selected' : ''} ${destination ? 'destination' : ''} ${lastTo === index ? 'last' : ''} ${camp ? 'camp' : ''} ${piece ? 'occupied' : ''}`}
              aria-label={`${String.fromCharCode(65 + col)}${rank(row)} ${piece ? (piece.hidden ? labels.hidden : piece.label) : labels.empty}${camp ? ` ${labels.camp}` : ''}`}
              aria-pressed={selected === index}
            >
              <span className="arena-cross" aria-hidden="true" />
              {col === 0 && (
                <span className="arena-row-label" aria-hidden="true">
                  {rank(row)}
                </span>
              )}
              {camp && !piece && (
                <span className="arena-camp-mark" aria-hidden="true" />
              )}
              {piece && (
                <span
                  className={`arena-piece seat-${piece.seat} ${piece.hidden ? 'hidden-piece' : ''}`}
                >
                  <span>
                    {view.gameId === 'gomoku'
                      ? ''
                      : piece.hidden
                        ? '?'
                        : piece.label}
                  </span>
                </span>
              )}
              {destination && !piece && <span className="arena-move-dot" />}
              {lastTo === index && piece && (
                <span className="arena-last-mark" />
              )}
            </button>
          );
        })}
      </div>
      <div className="arena-board-foot">
        <span>
          {view.cols} × {view.rows}
        </span>
        <span>
          {view.gameId === 'gomoku'
            ? 'FREESTYLE'
            : view.gameId === 'xiangqi'
              ? 'XIANGQI'
              : 'HIDDEN STRATEGY'}
        </span>
      </div>
    </div>
  );
}

export function GameArtwork({
  gameId,
  large = false,
}: {
  gameId: GameId;
  large?: boolean;
}) {
  const labels =
    gameId === 'xiangqi'
      ? ['車', '馬', '炮', '帥', '兵']
      : gameId === 'army'
        ? ['司令', '工兵', '?', '軍旗', '?']
        : ['', '', '', '', ''];
  return (
    <div
      className={`arena-game-art ${gameId} ${large ? 'large' : ''}`}
      aria-hidden="true"
    >
      <div className="arena-art-grid" />
      {labels.map((label, i) => (
        <span
          key={i}
          className={`arena-art-piece piece-${i} ${i % 2 ? 'light' : 'dark'}`}
        >
          {label}
        </span>
      ))}
      <span className="arena-art-coordinate">H08</span>
    </div>
  );
}

function BoardLines({ view }: { view: GameView }) {
  const { cols, rows, gameId } = view;
  const x = (col: number) => col * 100 + 50,
    y = (row: number) => row * 100 + 50;
  const rail = new Set(
    Array.from({ length: 60 }, (_, i) => i).filter((i) => {
      const row = Math.floor(i / 5),
        col = i % 5;
      return (
        row > 0 &&
        row < 11 &&
        (col === 0 || col === 4 || [1, 5, 6, 10].includes(row))
      );
    })
  );
  const camps = [11, 13, 17, 21, 23, 36, 38, 42, 46, 48];
  return (
    <svg
      className="arena-board-lines"
      viewBox={`0 0 ${cols * 100} ${rows * 100}`}
      aria-hidden="true"
    >
      {Array.from({ length: rows }, (_, row) => (
        <line
          key={`h${row}`}
          x1={x(0)}
          x2={x(cols - 1)}
          y1={y(row)}
          y2={y(row)}
        />
      ))}
      {Array.from({ length: cols }, (_, col) =>
        gameId === 'xiangqi' && col !== 0 && col !== cols - 1 ? (
          <g key={`v${col}`}>
            <line x1={x(col)} x2={x(col)} y1={y(0)} y2={y(4)} />
            <line x1={x(col)} x2={x(col)} y1={y(5)} y2={y(9)} />
          </g>
        ) : (
          <line
            key={`v${col}`}
            x1={x(col)}
            x2={x(col)}
            y1={y(0)}
            y2={y(rows - 1)}
          />
        )
      )}
      {gameId === 'xiangqi' && (
        <g>
          {[0, 7].map((row) => (
            <g key={row}>
              <line x1={x(3)} x2={x(5)} y1={y(row)} y2={y(row + 2)} />
              <line x1={x(5)} x2={x(3)} y1={y(row)} y2={y(row + 2)} />
            </g>
          ))}
        </g>
      )}
      {gameId === 'gomoku' &&
        (cols === 15 ? [3, 7, 11] : [2, 4, 6]).flatMap((row) =>
          (cols === 15 ? [3, 7, 11] : [2, 4, 6]).map((col) => (
            <circle
              className="star"
              key={`${row}-${col}`}
              cx={x(col)}
              cy={y(row)}
              r="6"
            />
          ))
        )}
      {gameId === 'army' && (
        <g>
          {camps.flatMap((index) =>
            [-1, 1].flatMap((dr) =>
              [-1, 1].map((dc) => (
                <line
                  key={`${index}-${dr}-${dc}`}
                  x1={x(index % 5)}
                  y1={y(Math.floor(index / 5))}
                  x2={x((index % 5) + dc)}
                  y2={y(Math.floor(index / 5) + dr)}
                />
              ))
            )
          )}
          {[...rail].flatMap((index) =>
            [1, 5].map((step) => {
              const to = index + step;
              if (
                !rail.has(to) ||
                (step === 1 && Math.floor(index / 5) !== Math.floor(to / 5)) ||
                (Math.floor(index / 5) === 5 &&
                  step === 5 &&
                  ![0, 2, 4].includes(index % 5))
              )
                return null;
              return (
                <line
                  key={`${index}-${to}`}
                  className="rail"
                  x1={x(index % 5)}
                  y1={y(Math.floor(index / 5))}
                  x2={x(to % 5)}
                  y2={y(Math.floor(to / 5))}
                />
              );
            })
          )}
          {[1, 3, 56, 58].map((index) => (
            <rect
              key={index}
              className="headquarters"
              x={x(index % 5) - 38}
              y={y(Math.floor(index / 5)) - 30}
              width="76"
              height="60"
              rx="8"
            />
          ))}
        </g>
      )}
    </svg>
  );
}
