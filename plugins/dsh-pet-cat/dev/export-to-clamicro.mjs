/**
 * 把 idle 帧导出给 clamicro：dev/art.mjs → ../../src/cat-art.mjs
 *
 * 为什么要导出而不是直接 import：`plugins/` **不在 clamicro 的 npm 包里**
 * （package.json 的 files 没有它，插件是给 DSH 装的，单独发布）。装了
 * clamicro 的人机器上没有 plugins/，运行时 import 会直接崩。
 *
 * 但也不能手抄一份——那就有了两个真相，改一边忘另一边，最后终端里的猫
 * 和网页上的猫长得不一样，而且没有任何东西会告诉你。所以：art.mjs 仍是
 * 唯一来源，这里生成，test/cat-art.test.mjs 盯着两边不许漂。
 *
 * 用法：node plugins/dsh-pet-cat/dev/export-to-clamicro.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { palette, frames, canvas } from "./art.mjs";

/** 只导 idle：终端里是一张静止的图，眨眼和开心都无处可放。 */
const idle = frames.find((f) => f.id === "idle");
if (!idle) throw new Error("art.mjs 里没有 idle 帧");

export function render() {
  return `/**
 * 像素猫的 idle 帧 —— **自动生成，别手改**。
 *
 * 来源：plugins/dsh-pet-cat/dev/art.mjs
 * 重新生成：node plugins/dsh-pet-cat/dev/export-to-clamicro.mjs
 *
 * 为什么这里要有一份拷贝：plugins/ 不随 clamicro 的 npm 包发布（它是给 DSH
 * 装的插件，单独发），所以运行时 import 不到。test/cat-art.test.mjs 会比对
 * 这份和 art.mjs，漂了就红。
 */

export const palette = ${JSON.stringify(palette, null, 2).replace(/\n/g, "\n")};

export const canvas = ${JSON.stringify(canvas)};

export const grid = [
${idle.grid.map((row) => `  ${JSON.stringify(row)},`).join("\n")}
];
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = fileURLToPath(new URL("../../../src/cat-art.mjs", import.meta.url));
  writeFileSync(out, render());
  console.log(`wrote ${out}`);
}
