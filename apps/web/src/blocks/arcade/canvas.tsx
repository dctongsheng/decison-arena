import { useEffect, useRef, type RefObject } from 'react';
import type {
  ArcadeGameId,
  ArcadeState,
  ArcadeView,
} from '@decision-arena/core';

import { ArcadeRenderState, type LocalArcadeInput } from './render-state';

const colors = [
  '#142b35',
  '#71d4d1',
  '#eacb62',
  '#b797ec',
  '#9ecf75',
  '#ea8c9d',
  '#7fa8ef',
  '#edac68',
];
const W = 640,
  H = 400;
function rect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string
) {
  ctx.fillStyle = fill;
  ctx.fillRect(
    Math.round(x),
    Math.round(y),
    Math.ceil(width),
    Math.ceil(height)
  );
}
function tile(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string
) {
  rect(ctx, x + 1, y + 1, size - 2, size - 2, color);
  rect(ctx, x + 3, y + 3, size - 6, 3, '#ffffff38');
  rect(ctx, x + 3, y + size - 5, size - 6, 2, '#00000025');
}
export function drawArcade(
  ctx: CanvasRenderingContext2D,
  view: ArcadeView,
  frameTime = 0
) {
  ctx.clearRect(0, 0, W, H);
  rect(ctx, 0, 0, W, H, '#102c32');
  if (view.gameId === 'snake') {
    const size = Math.min(350 / view.width, 350 / view.height),
      ox = (W - view.width * size) / 2,
      oy = (H - view.height * size) / 2;
    rect(
      ctx,
      ox - 7,
      oy - 7,
      view.width * size + 14,
      view.height * size + 14,
      '#28464a'
    );
    for (let y = 0; y < view.height; y++)
      for (let x = 0; x < view.width; x++)
        rect(
          ctx,
          ox + x * size,
          oy + y * size,
          size,
          size,
          (x + y) % 2 ? '#17383d' : '#193c41'
        );
    const snake = view.snake || [];
    snake
      .slice()
      .reverse()
      .forEach((point, index) => {
        const head = index === snake.length - 1;
        tile(
          ctx,
          ox + point.x * size,
          oy + point.y * size,
          size,
          head ? '#e4f8b5' : '#9fcf73'
        );
        if (head) {
          rect(
            ctx,
            ox + point.x * size + size * 0.22,
            oy + point.y * size + size * 0.25,
            3,
            3,
            '#213c34'
          );
          rect(
            ctx,
            ox + point.x * size + size * 0.62,
            oy + point.y * size + size * 0.25,
            3,
            3,
            '#213c34'
          );
        }
      });
    if (view.food) {
      const x = ox + view.food.x * size,
        y = oy + view.food.y * size;
      rect(ctx, x + 4, y + 5, size - 8, size - 8, '#efb178');
      rect(ctx, x + size / 2, y + 2, 3, 5, '#bed58a');
    }
  } else if (view.gameId === 'tetris') {
    const size = 17,
      ox = 205,
      oy = 30;
    rect(
      ctx,
      ox - 7,
      oy - 7,
      view.width * size + 14,
      view.height * size + 14,
      '#305259'
    );
    for (let y = 0; y < view.height; y++)
      for (let x = 0; x < view.width; x++) {
        const value = view.cells?.[y * view.width + x] || 0;
        if (value)
          tile(
            ctx,
            ox + x * size,
            oy + y * size,
            size,
            colors[value % colors.length]
          );
        else
          rect(
            ctx,
            ox + x * size + 1,
            oy + y * size + 1,
            size - 1,
            size - 1,
            '#15363e'
          );
      }
    const value =
      ['I', 'O', 'T', 'S', 'Z', 'J', 'L'].indexOf(view.active?.type || '') + 1;
    view.active?.cells
      .filter((point) => point.y >= 0)
      .forEach((point) =>
        tile(
          ctx,
          ox + point.x * size,
          oy + point.y * size,
          size,
          colors[value] || '#acd884'
        )
      );
    ctx.font = '10px monospace';
    ctx.fillStyle = '#91b4af';
    ctx.fillText('NEXT', 410, 43);
    ctx.fillText('HOLD', 115, 43);
    const shapes: Record<string, number[][]> = {
      I: [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
      ],
      O: [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ],
      T: [
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ],
      S: [
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
      ],
      Z: [
        [0, 0],
        [1, 0],
        [1, 1],
        [2, 1],
      ],
      J: [
        [0, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ],
      L: [
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
      ],
    };
    (view.next || [])
      .slice(0, 5)
      .forEach((piece, i) =>
        (shapes[piece] || []).forEach(([x, y]) =>
          tile(
            ctx,
            410 + x * 12,
            58 + i * 52 + y * 12,
            12,
            colors[['I', 'O', 'T', 'S', 'Z', 'J', 'L'].indexOf(piece) + 1]
          )
        )
      );
    if (view.hold)
      (shapes[view.hold] || []).forEach(([x, y]) =>
        tile(ctx, 110 + x * 12, 58 + y * 12, 12, '#89b9ab')
      );
  } else {
    const visibleWidth = 640,
      camera = Math.max(
        0,
        Math.min(view.width - visibleWidth, (view.player?.x || 0) - 200)
      ),
      sy = H / view.height;
    rect(ctx, 0, 0, W, H, '#122e38');
    for (let i = 0; i < 26; i++) {
      const x = (((i * 89 + 31 - camera * 0.18) % 670) + 670) % 670;
      rect(
        ctx,
        x,
        22 + ((i * 47) % 160),
        2,
        2,
        i % 3 ? '#8da8a745' : '#e6d68f'
      );
    }
    ctx.fillStyle = '#20434a';
    for (let i = 0; i < 9; i++) {
      const x = i * 120 - ((camera * 0.3) % 120);
      ctx.beginPath();
      ctx.moveTo(x - 50, H);
      ctx.lineTo(x + 65, 130 + (i % 3) * 35);
      ctx.lineTo(x + 160, H);
      ctx.fill();
    }
    const world = (
      x: number,
      y: number,
      width: number,
      height: number,
      fill: string
    ) => rect(ctx, x - camera, y * sy, width, height * sy, fill);
    for (const p of view.platforms || []) {
      world(p.x, p.y, p.width, p.height, '#52694d');
      world(p.x, p.y, p.width, 6, '#a4c87a');
      for (let x = p.x + 7; x < p.x + p.width; x += 26)
        world(x, p.y + 15, 5, 3, '#3f5546');
    }
    for (const p of view.hazards || []) {
      ctx.fillStyle = '#d5a7a5';
      for (let x = p.x; x < p.x + p.width; x += 12) {
        ctx.beginPath();
        ctx.moveTo(x - camera, (p.y + p.height) * sy);
        ctx.lineTo(x + 6 - camera, p.y * sy);
        ctx.lineTo(x + 12 - camera, (p.y + p.height) * sy);
        ctx.fill();
      }
    }
    for (const p of view.coins || []) {
      const bob = Math.sin(frameTime / 450 + p.x) * 2;
      world(p.x - 4, p.y - 6 + bob, 8, 12, '#efcf7a');
      world(p.x - 2, p.y - 4 + bob, 2, 8, '#fff4b9');
    }
    for (const p of view.enemies || []) {
      world(p.x, p.y, p.width, p.height, '#bd8f9d');
      world(p.x + 4, p.y + 6, 4, 4, '#342f3c');
      world(p.x + p.width - 8, p.y + 6, 4, 4, '#342f3c');
    }
    if (view.exit) {
      const p = view.exit;
      world(p.x, p.y, p.width, p.height, '#284d4e');
      world(p.x + 4, p.y + 4, p.width - 8, p.height - 4, '#92c2a0');
      world(p.x + 9, p.y + 10, p.width - 18, p.height - 10, '#335b54');
    }
    if (view.player) {
      const p = view.player;
      world(p.x, p.y, p.width, p.height, '#c3e88e');
      world(p.x + 3, p.y + 3, p.width - 6, 8, '#e4f6b4');
      world(p.x + p.width - 7, p.y + 8, 4, 4, '#244146');
      world(p.x + 2, p.y + p.height - 5, 6, 5, '#6d9c80');
      world(p.x + p.width - 8, p.y + p.height - 5, 6, 5, '#6d9c80');
    }
  }
}
export function ArcadeCanvas({
  view,
  label,
  predictionState,
  active = false,
  localInputs,
}: {
  view: ArcadeView;
  label: string;
  predictionState?: ArcadeState;
  active?: boolean;
  localInputs?: RefObject<LocalArcadeInput[]>;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    latest = useRef({
      view,
      predictionState,
      active,
      localInputs,
      receivedAt: performance.now(),
    });
  const changed =
    latest.current.view !== view ||
    latest.current.predictionState !== predictionState ||
    latest.current.active !== active;
  latest.current = {
    view,
    predictionState,
    active,
    localInputs,
    receivedAt: changed ? performance.now() : latest.current.receivedAt,
  };
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * ratio;
    canvas.height = H * ratio;
    ctx.scale(ratio, ratio);
    ctx.imageSmoothingEnabled = false;
    const initial = latest.current;
    const presentation = new ArcadeRenderState(
      initial.view,
      initial.predictionState,
      initial.active,
      initial.receivedAt
    );
    let handle = 0;
    const render = (time: number) => {
      const current = latest.current;
      presentation.receive(
        current.view,
        current.predictionState,
        current.active,
        current.receivedAt
      );
      for (const input of current.localInputs?.current || [])
        presentation.input(input);
      drawArcade(ctx, presentation.frame(time), current.active ? time : 0);
      handle = requestAnimationFrame(render);
    };
    handle = requestAnimationFrame(render);
    return () => cancelAnimationFrame(handle);
  }, []);
  return (
    <canvas
      ref={ref}
      width={W}
      height={H}
      className="arcade-canvas"
      role="img"
      aria-label={`${label}: ${view.score.points}`}
    />
  );
}
export function previewView(gameId: ArcadeGameId): ArcadeView {
  const base = {
    gameId,
    tick: 0,
    status: 'playing' as const,
    score: { points: 0, survivedTicks: 0 },
    currentButtons: [],
    width: 20,
    height: 20,
  };
  if (gameId === 'snake')
    return {
      ...base,
      snake: [
        { x: 13, y: 7 },
        { x: 12, y: 7 },
        { x: 11, y: 7 },
        { x: 10, y: 7 },
        { x: 10, y: 8 },
        { x: 10, y: 9 },
        { x: 10, y: 10 },
        { x: 9, y: 10 },
        { x: 8, y: 10 },
        { x: 7, y: 10 },
      ],
      food: { x: 14, y: 12 },
    };
  if (gameId === 'tetris') {
    const cells = Array(200).fill(0);
    for (let y = 16; y < 20; y++)
      for (let x = 0; x < 10; x++)
        if (x !== 5 && (y > 17 || x < 3 || x > 7))
          cells[y * 10 + x] = 1 + ((x + y) % 7);
    return {
      ...base,
      width: 10,
      height: 20,
      cells,
      active: {
        type: 'T',
        cells: [
          { x: 5, y: 6 },
          { x: 4, y: 7 },
          { x: 5, y: 7 },
          { x: 6, y: 7 },
        ],
      },
      next: ['S', 'I', 'L', 'O'],
      hold: 'J',
    };
  }
  return {
    ...base,
    width: 1536,
    height: 384,
    player: {
      x: 170,
      y: 268,
      width: 24,
      height: 30,
      vx: 0,
      vy: 0,
      onGround: true,
    },
    platforms: [
      { x: 0, y: 320, width: 280, height: 64 },
      { x: 330, y: 320, width: 300, height: 64 },
      { x: 170, y: 230, width: 100, height: 18 },
      { x: 360, y: 175, width: 96, height: 18 },
    ],
    hazards: [{ x: 280, y: 360, width: 50, height: 24 }],
    coins: [
      { x: 210, y: 200 },
      { x: 240, y: 200 },
      { x: 395, y: 140 },
      { x: 425, y: 140 },
    ],
    enemies: [{ x: 480, y: 294, width: 26, height: 26 }],
    exit: { x: 590, y: 260, width: 32, height: 60 },
  };
}
export function ArcadeArtwork({ gameId }: { gameId: ArcadeGameId }) {
  return <ArcadeCanvas view={previewView(gameId)} label={gameId} />;
}
