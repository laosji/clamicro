/**
 * Pixel art data for the DeepSeek whale pet.
 * Grid chars map to the palette below; '.' is transparent.
 *
 * The shape follows the official DeepSeek mark (see dsh-web-frontend/dist/favicon.svg):
 * a WHALE with a big rounded head facing left, a body that tapers into a tail that
 * FLIPS UP at the top-right, one eye, and splash droplets above the tail. Solid
 * DeepSeek blue (no white belly — the mark is a flat silhouette).
 *
 * The body is generated from an OUTLINE spec (xLeft/xRight per row); detail colors
 * are layered on top. Tweak the numbers and re-run `node dev/preview.mjs` or the
 * ASCII dump to iterate.
 */

export const palette = {
  H: "#9DB2FF", // highlight (top of the back)
  M: "#4D6BFE", // main DeepSeek blue
  D: "#3349D0", // shade (underside / tail)
  W: "#E8F0FE", // belly hint (kept subtle — the mark is flat, not two-tone)
  B: "#0E1533", // eye
  S: "#BFD9FF", // splash light
  s: "#7FA5F2", // splash dark
};

export const canvas = { width: 24, height: 16 };

/**
 * Silhouette: per row, the leftmost and rightmost body column (inclusive).
 * Left-facing whale — big rounded head, body tapering up-right into an up-flipped
 * tail. -1 = empty row.
 */
const OUTLINE = [
  [-1, -1], // y0
  [16, 19], // y1 tail curl tip
  [15, 20], // y2 tail curl
  [14, 21], // y3 tail flukes
  [13, 20], // y4 tail base / back
  [12, 19], // y5 back (tapering)
  [10, 19], // y6 back
  [8, 19], // y7 body
  [6, 18], // y8 body (eye row)
  [4, 18], // y9 head (eye row)
  [2, 17], // y10 head
  [1, 16], // y11 head (rounded front)
  [2, 14], // y12 chin
  [3, 12], // y13 lower head
  [4, 10], // y14 bottom
  [-1, -1], // y15
];

/** Eye: 2x2 at (x,y), top-left pixel is a white glint. */
const EYE = { x: 6, y: 8 };
/** Belly hint (W): subtle, along the underside of the head only. */
const BELLY = [
  { y: 11, x0: 3, x1: 10 },
  { y: 12, x0: 4, x1: 9 },
  { y: 13, x0: 5, x1: 8 },
  { y: 14, x0: 5, x1: 7 },
];
/** Shade (D): tail underside + bottom edge. */
const SHADE = [
  { y: 3, x0: 17, x1: 20 },
  { y: 4, x0: 16, x1: 19 },
  { y: 11, x0: 12, x1: 14 },
  { y: 12, x0: 10, x1: 12 },
  { y: 13, x0: 9, x1: 11 },
  { y: 14, x0: 7, x1: 9 },
];
/** Highlight (H): along the top of the back. */
const HIGHLIGHT = [
  { y: 2, x0: 15, x1: 19 },
  { y: 3, x0: 14, x1: 20 },
  { y: 4, x0: 13, x1: 19 },
  { y: 5, x0: 12, x1: 18 },
  { y: 6, x0: 10, x1: 18 },
  { y: 7, x0: 8, x1: 18 },
  { y: 8, x0: 6, x1: 17 },
  { y: 9, x0: 4, x1: 17 },
  { y: 10, x0: 2, x1: 16 },
];
/** Splash droplets above the tail (S/s). */
const SPLASH_A = [
  { y: 0, x0: 20, x1: 20, ch: 's' },
  { y: 0, x0: 22, x1: 22, ch: 'S' },
  { y: 1, x0: 20, x1: 22, ch: 'S' },
  { y: 2, x0: 21, x1: 22, ch: 's' },
];
const SPLASH_B = [
  { y: 0, x0: 19, x1: 19, ch: 's' },
  { y: 0, x0: 21, x1: 21, ch: 'S' },
  { y: 0, x0: 23, x1: 23, ch: 'S' },
  { y: 1, x0: 20, x1: 21, ch: 'S' },
  { y: 2, x0: 22, x1: 22, ch: 's' },
];

const { width: W, height: H } = canvas;

function blankGrid() {
  return Array.from({ length: H }, () => '.'.repeat(W));
}

function fillRows(grid, rows, ch) {
  for (const { y, x0, x1, x, ch: own } of rows) {
    if (y < 0 || y >= H) continue;
    const row = grid[y].split('');
    const from = Math.max(0, x0 ?? x ?? 0);
    const to = Math.min(W - 1, x1 ?? x ?? W - 1);
    for (let c = from; c <= to; c++) row[c] = ch ?? own;
    grid[y] = row.join('');
  }
}

function paintEye(grid) {
  const r1 = grid[EYE.y].split('');
  r1[EYE.x] = 'W';
  r1[EYE.x + 1] = 'B';
  grid[EYE.y] = r1.join('');
  const r2 = grid[EYE.y + 1].split('');
  r2[EYE.x] = 'B';
  r2[EYE.x + 1] = 'B';
  grid[EYE.y + 1] = r2.join('');
}

/** Build a full whale grid with the given splash pattern. */
export function gridFor(splash) {
  const g = blankGrid();
  for (let y = 0; y < H; y++) {
    const [l, r] = OUTLINE[y];
    if (l === -1) continue;
    const row = g[y].split('');
    for (let x = l; x <= r; x++) row[x] = 'M';
    g[y] = row.join('');
  }
  fillRows(g, HIGHLIGHT, 'H');
  fillRows(g, BELLY, 'W');
  fillRows(g, SHADE, 'D');
  paintEye(g);
  fillRows(g, splash);
  return g;
}

export function baseGrid() {
  return gridFor(SPLASH_A);
}

/** Blink: eye closed (glint + pupil → body color). */
export function blinkGrid() {
  const g = gridFor(SPLASH_A);
  for (const dy of [0, 1]) {
    const row = g[EYE.y + dy].split('');
    row[EYE.x] = 'M';
    row[EYE.x + 1] = 'M';
    g[EYE.y + dy] = row.join('');
  }
  return g;
}

/** Tail-up / tail-down wag variants (swap the two splash patterns + tail shading). */
export function swimA() {
  return gridFor(SPLASH_A);
}

export function swimB() {
  return gridFor(SPLASH_B);
}

/** The animated frame loop. */
export const frames = [
  { id: 'swim-a', grid: swimA(), duration: 300 },
  { id: 'swim-b', grid: swimB(), duration: 300 },
  { id: 'swim-a', grid: swimA(), duration: 300 },
  { id: 'swim-b', grid: swimB(), duration: 300 },
  { id: 'idle', grid: baseGrid(), duration: 1600 },
  { id: 'blink', grid: blinkGrid(), duration: 160 },
  { id: 'idle', grid: baseGrid(), duration: 1400 },
];

export function dumpAscii(grid) {
  return grid.join('\n');
}
