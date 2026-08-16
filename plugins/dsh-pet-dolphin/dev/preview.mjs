/**
 * Render the pixel-art frames to a PNG contact sheet for visual review.
 * Usage: node dev/preview.mjs [out.png]
 * Requires sharp from the DSH checkout node_modules.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { palette, frames, canvas } from "./art.mjs";

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require("/Users/duanchao/.npm/_npx/1e7f6d9597241db0/node_modules/sharp");
} catch {
  console.error("sharp not found — run with the DSH checkout present");
  process.exit(1);
}

const SCALE = 8;
const GAP = 4 * SCALE;
const { width: W, height: H } = canvas;

function frameSvg(grid) {
  const rects = [];
  for (let y = 0; y < H; y++) {
    const row = grid[y] ?? "";
    for (let x = 0; x < W; x++) {
      const ch = row[x];
      if (!ch || ch === "." || !palette[ch]) continue;
      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="${palette[ch]}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

async function main() {
  const out = process.argv[2] ?? new URL("./preview.png", import.meta.url).pathname;
  const cols = Math.ceil(Math.sqrt(frames.length));
  const cellW = W * SCALE + GAP;
  const cellH = H * SCALE + GAP;
  const sheetW = cols * cellW + GAP;
  const sheetH = Math.ceil(frames.length / cols) * cellH + GAP;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sheetW}" height="${sheetH}">
  <rect width="100%" height="100%" fill="#1e2749"/>
  ${frames
    .map((f, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = GAP + col * cellW;
      const y = GAP + row * cellH;
      return `<g transform="translate(${x},${y})">${frameSvg(f.grid)}</g>`;
    })
    .join("")}
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(out);
  console.log(`wrote ${out} (${frames.length} frames)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
