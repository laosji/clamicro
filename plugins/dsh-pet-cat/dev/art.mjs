/**
 * Pixel art data for the cat-face pet.
 * Grid chars map to the palette below; '.' is transparent.
 * A chunky orange-tabby cat face — round head, two pointy ears, wide-set eyes
 * with a glint, pink nose, white muzzle. 16x16.
 */

export const palette = {
  O: "#E8912D", // main orange fur
  D: "#C8751F", // dark orange (mouth line)
  W: "#FFF3E0", // cream muzzle + eye glint
  B: "#2A2A2A", // eyes
  P: "#F28BAE", // pink nose
};

export const canvas = { width: 16, height: 16 };

/** 正常猫脸：尖耳 + 圆头 + 宽眼（带高光）+ 粉鼻 + 白嘴 */
const FACE = [
  "................",
  "...O........O...",
  "..OOO......OOO..",
  ".OOOOO....OOOOO.",
  "..OOOOOOOOOOOO..",
  ".OOOOOOOOOOOOOO.",
  ".OOOOOOOOOOOOOO.",
  ".OOOWBOOOOWBOOO.",
  ".OOOBBOOOOBBOOO.",
  ".OOOOOOOOOOOOOO.",
  ".OOOOOOOOOOOOOO.",
  ".OOOOOOPPOOOOOO.",
  ".OOOOWWWWWWOOOO.",
  ".OOOWWWWWWWWOOOO.",
  "..OOOOOOOOOOOO..",
  "................",
];

/** 眨眼：眼睛闭成一条线（眼黑换成毛色） */
function blink() {
  return FACE.map((row, y) => {
    if (y !== 7 && y !== 8) return row;
    let r = row;
    r = r.replace("WB", "OO");
    r = r.replace("WB", "OO");
    r = r.replace("BB", "OO");
    r = r.replace("BB", "OO");
    return r;
  });
}

/** 开心（点击时）：眼睛眯成 ^ ^，嘴咧开 */
function happy() {
  const g = FACE.map((r) => r);
  // 眯眼：上排眼睛去掉，下排留一点黑当眯缝
  g[7] = g[7].replace("WB", "OO").replace("WB", "OO");
  g[8] = g[8].replace("BB", "OB").replace("BB", "BO");
  // 咧嘴：鼻子下面一条宽嘴
  g[12] = ".OOOOBBBBBBOOOO.";
  return g;
}

export const frames = [
  { id: "idle", grid: FACE, duration: 2000 },
  { id: "blink", grid: blink(), duration: 160 },
  { id: "idle", grid: FACE, duration: 1800 },
  { id: "happy", grid: happy(), duration: 240 },
  { id: "idle", grid: FACE, duration: 1600 },
];

export function dumpAscii(grid) {
  return grid.join("\n");
}
