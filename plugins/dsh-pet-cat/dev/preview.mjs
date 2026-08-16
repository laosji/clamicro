/**
 * Render the pixel-art frames to a PNG contact sheet for visual review.
 * Usage: node dev/preview.mjs [out.png]
 * Requires sharp from the DSH checkout node_modules.
 */
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { palette, frames, canvas } from "./art.mjs";

const require = createRequire(import.meta.url);
/**
 * sharp 不是这个包的依赖（它只在生成预览图时用得上）。先按正常方式解析，
 * 解析不到再退回本机的 npx 缓存——原来只有那条写死的绝对路径，里面还带着
 * 一个 npx 的哈希目录名，换台机器、甚至同一台机器重装一次 npx 就失效。
 */
let sharp;
for (const id of ["sharp", process.env.SHARP_PATH].filter(Boolean)) {
  try { sharp = require(id); break; } catch { /* 下一个 */ }
}
if (!sharp) {
  console.error("找不到 sharp。装一个（npm i -g sharp）或用 SHARP_PATH=/路径/到/sharp 指过去。");
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
  // 宽高必须是**放大后**的尺寸：布局按 W*SCALE 排格子，这里若按 W 输出，
  // 每张图就只占格子左上角的 1/8，整张联系表看着像撒了几粒芝麻。
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W * SCALE}" height="${H * SCALE}" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">${rects.join("")}</svg>`;
}

async function main() {
  const out = process.argv[2] ?? fileURLToPath(new URL("./preview.png", import.meta.url));
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
