/**
 * Pixel art data for the DeepSeek dolphin pet.
 * Grid chars map to the palette below; '.' is transparent.
 *
 * The body is generated from an OUTLINE spec (xLeft/xRight per row), which
 * guarantees a clean continuous silhouette; detail colors are layered on top.
 * Two tail variants give the swim animation (flukes wagging). Tweak the
 * numbers and re-run `node dev/preview.mjs` or the ASCII dump to iterate.
 */

export const palette = {
  H: "#9DB2FF", // highlight (fin / top back)
  M: "#4D6BFE", // main DeepSeek blue
  D: "#3349D0", // shade (bottom edge / fluke tips / smile)
  W: "#F2F6FF", // belly
  B: "#0E1533", // eye
  S: "#BFD9FF", // splash light
  s: "#7FA5F2", // splash dark
};

export const canvas = { width: 24, height: 16 };

/** Shared silhouette head/body (rows 0-8); tail rows (9-15) vary per frame. */
const HEAD = [
  [-1, -1], // y0
  [11, 12], // y1 fin tip
  [10, 13], // y2 fin
  [8, 14], // y3 head top + fin base
  [6, 16], // y4
  [4, 18], // y5 head widens
  [3, 19], // y6 widest (eye row)
  [2, 20], // y7
  [2, 20], // y8 body
];

/** Tail variant A: upper fluke long, lower short. */
const TAIL_A = [
  [1, 21], // y9 beak tip / upper prong
  [1, 22], // y10 upper prong reaches out
  [3, 17], // y11 deep fork notch
  [4, 20], // y12 lower prong
  [5, 19], // y13
  [6, 17], // y14
  [7, 15], // y15
];

/** Tail variant B: lower fluke long, upper short (wag frame). */
const TAIL_B = [
  [1, 20], // y9
  [1, 21], // y10
  [3, 19], // y11
  [4, 22], // y12 lower prong reaches out
  [5, 20], // y13
  [6, 17], // y14
  [7, 15], // y15
];

const OUTLINES = { A: [...HEAD, ...TAIL_A], B: [...HEAD, ...TAIL_B] };

/** Eye: 2x2 at (x,y), top-left pixel is a white glint. */
const EYE = { x: 6, y: 6 };
/** Smile: two dark pixels at the beak corner. */
const MOUTH = [
  { y: 10, x: 3 },
  { y: 10, x: 4 },
];
/** Belly patch (W): smooth white chin under the eye. */
const BELLY = [
  { y: 9, x0: 6, x1: 10 },
  { y: 10, x0: 6, x1: 10 },
  { y: 11, x0: 5, x1: 9 },
  { y: 12, x0: 6, x1: 9 },
];
/** Bottom shading (D): 1px underside + fluke tips. */
const SHADE_BOTTOM = [
  { y: 11, x0: 16, x1: 17 },
  { y: 12, x0: 18, x1: 20 },
  { y: 13, x0: 15, x1: 19 },
  { y: 14, x0: 13, x1: 17 },
  { y: 15, x0: 10, x1: 15 },
];
/** Highlight (H): the fin + top back rows. */
const HIGHLIGHT = [
  { y: 1, x0: 11, x1: 12 },
  { y: 2, x0: 10, x1: 13 },
  { y: 3, x0: 8, x1: 13 },
  { y: 4, x0: 6, x1: 15 },
  { y: 5, x0: 4, x1: 17 },
];
/** Tail splash (S/s): water around the flukes. */
const SPLASH_A = [
  { y: 8, x0: 22, x1: 23, ch: "S" },
  { y: 9, x0: 22, x1: 23, ch: "S" },
  { y: 10, x0: 23, x1: 23, ch: "s" },
  { y: 11, x0: 20, x1: 23, ch: "s" },
  { y: 12, x0: 21, x1: 23, ch: "s" },
  { y: 13, x0: 20, x1: 22, ch: "S" },
  { y: 14, x0: 18, x1: 20, ch: "s" },
  { y: 15, x0: 16, x1: 18, ch: "S" },
];
const SPLASH_B = [
  { y: 8, x0: 22, x1: 23, ch: "S" },
  { y: 9, x0: 22, x1: 23, ch: "S" },
  { y: 10, x0: 23, x1: 23, ch: "s" },
  { y: 11, x0: 20, x1: 23, ch: "s" },
  { y: 12, x0: 23, x1: 23, ch: "s" },
  { y: 13, x0: 21, x1: 23, ch: "s" },
  { y: 14, x0: 19, x1: 21, ch: "s" },
  { y: 15, x0: 16, x1: 18, ch: "S" },
];

const { width: W, height: H } = canvas;

function blankGrid() {
  return Array.from({ length: H }, () => ".".repeat(W));
}

function fillRows(grid, rows, ch) {
  for (const { y, x0, x1, x, ch: own } of rows) {
    if (y < 0 || y >= H) continue;
    const row = grid[y].split("");
    const from = Math.max(0, x0 ?? x ?? 0);
    const to = Math.min(W - 1, x1 ?? x ?? W - 1);
    for (let c = from; c <= to; c++) row[c] = ch ?? own;
    grid[y] = row.join("");
  }
}

/** Build a full body grid for a tail variant ('A' or 'B'). */
export function gridFor(variant) {
  const outline = OUTLINES[variant];
  const g = blankGrid();
  for (let y = 0; y < H; y++) {
    const [l, r] = outline[y];
    if (l === -1) continue;
    const row = g[y].split("");
    for (let x = l; x <= r; x++) row[x] = "M";
    g[y] = row.join("");
  }
  fillRows(g, HIGHLIGHT, "H");
  fillRows(g, BELLY, "W");
  fillRows(g, SHADE_BOTTOM, "D");
  // eye with glint
  const r1 = g[EYE.y].split("");
  r1[EYE.x] = "W";
  r1[EYE.x + 1] = "B";
  g[EYE.y] = r1.join("");
  const r2 = g[EYE.y + 1].split("");
  r2[EYE.x] = "B";
  r2[EYE.x + 1] = "B";
  g[EYE.y + 1] = r2.join("");
  // smile
  fillRows(g, MOUTH, "D");
  // splash
  fillRows(g, variant === "B" ? SPLASH_B : SPLASH_A);
  return g;
}

export function baseGrid() {
  return gridFor("A");
}

/** Blink: eye closed (glint + pupil → body color). */
export function blinkGrid() {
  const g = gridFor("A");
  for (const dy of [0, 1]) {
    const row = g[EYE.y + dy].split("");
    row[EYE.x] = "M";
    row[EYE.x + 1] = "M";
    g[EYE.y + dy] = row.join("");
  }
  return g;
}

/** The animated frame loop. */
export const frames = [
  { id: "swim-a", grid: gridFor("A"), duration: 300 },
  { id: "swim-b", grid: gridFor("B"), duration: 300 },
  { id: "swim-a", grid: gridFor("A"), duration: 300 },
  { id: "swim-b", grid: gridFor("B"), duration: 300 },
  { id: "idle", grid: gridFor("A"), duration: 1400 },
  { id: "blink", grid: blinkGrid(), duration: 170 },
  { id: "idle", grid: gridFor("A"), duration: 1200 },
];

export function dumpAscii(grid) {
  return grid.join("\n");
}
