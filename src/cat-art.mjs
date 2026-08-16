/**
 * 像素猫的 idle 帧 —— **自动生成，别手改**。
 *
 * 来源：plugins/dsh-pet-cat/dev/art.mjs
 * 重新生成：node plugins/dsh-pet-cat/dev/export-to-clamicro.mjs
 *
 * 为什么这里要有一份拷贝：plugins/ 不随 clamicro 的 npm 包发布（它是给 DSH
 * 装的插件，单独发），所以运行时 import 不到。test/cat-art.test.mjs 会比对
 * 这份和 art.mjs，漂了就红。
 */

export const palette = {
  "O": "#E8912D",
  "D": "#C8751F",
  "L": "#8A4A12",
  "W": "#FFF3E0",
  "B": "#2A2A2A",
  "P": "#F28BAE"
};

export const canvas = {"width":16,"height":16};

export const grid = [
  ".LLL........LLL.",
  ".LOLL......LLOL.",
  ".LOOLL....LLOOL.",
  ".LOPOLL..LLOPOL.",
  "LLOPPOLLLLOPPOLL",
  "LOOOOOOOOOOOOOOL",
  "LDOOOOOOOOOOOODL",
  "LDOOWBOOOOWBOODL",
  "LDOOBBOOOOBBOODL",
  "LDOOOOOOOOOOOODL",
  "LDOOOOOPPOOOOODL",
  "LDOOOWWDDWWOOODL",
  "LDOOOWWWWWWOOODL",
  "LLDOOOOOOOOOODLL",
  ".LLLLLLLLLLLLLL.",
  "................",
];
