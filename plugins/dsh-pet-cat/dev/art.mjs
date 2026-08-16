/**
 * Pixel art data for the cat pet. 16×16.
 *
 * 只画**填充**，描边由 outline() 自动生成。上一版描边是手画的，结果第 13 行
 * 多写了一格（17 格），渲染器的 `x < W` 把它静默吃掉——吃掉的正好是行尾那个
 * 透明格，于是下巴凭空向右鼓出一格。手画描边就是会这样：错一格没有任何反馈。
 *
 * 所以这里的分工是：人只负责形状，机器负责把形状包起来。
 */

export const palette = {
  O: "#E8912D", // 主体橙
  D: "#C8751F", // 暗橙——脸颊两侧的暗面，给这颗头一点体积
  L: "#8A4A12", // 描边。深棕而不是纯黑：纯黑在这个尺寸上会把橙压死
  W: "#FFF3E0", // 奶油色：嘴套 + 眼高光
  B: "#2A2A2A", // 眼
  P: "#F28BAE", // 粉：鼻头 + 耳内
};

export const canvas = { width: 16, height: 16 };

/**
 * 站姿（idle）。
 *
 * 相对上一版的四处结构性改动：
 *   · 耳朵。从 1px 尖变成 4 行实心三角，顶点落在头的**外缘**（第 2 / 13 列）
 *     而不是内缩一格，两耳之间留一个 4 行深的 V 形缺口。猫的辨识度几乎全在
 *     耳朵的剪影上，上一版在实际尺寸（96px）下耳朵只剩两个小凸起，整体读作
 *     一个圆角方块。耳内填粉。
 *   · 五官整体上移、收紧。上一版第 4–11 行有 8 行纯橙脑门（占了半张画布），
 *     而眼鼻之间空着两行——那个间距是它读起来像仓鼠不像猫的主因。
 *   · 嘴套从 8 格宽缩到 6 格，并给出鼻子→嘴的连接。上一版那块奶油色板砖
 *     接近脸宽一半，看着像围嘴。
 *   · 描边 + 侧面暗色。上一版是**没有描边的纯色橙块**：背景一旦偏暖（DSH 自己
 *     的橙色系界面就是）整只猫就化进去，只剩眼睛鼻子浮着。D 用在脸颊两侧，
 *     让这颗头不再是一块平板。
 */
const IDLE = [
  "................",
  "..O..........O..",
  "..OO........OO..",
  "..OPO......OPO..",
  "..OPPO....OPPO..",
  ".OOOOOOOOOOOOOO.",
  ".DOOOOOOOOOOOOD.",
  ".DOOWBOOOOWBOOD.",
  ".DOOBBOOOOBBOOD.",
  ".DOOOOOOOOOOOOD.",
  ".DOOOOOPPOOOOOD.",
  ".DOOOWWDDWWOOOD.",
  ".DOOOWWWWWWOOOD.",
  "..DOOOOOOOOOOD..",
  "................",
  "................",
];

/** 眨眼：眼睛闭成一条实线。上一版是把眼睛整个删掉，读起来是「眼睛没了」而不是闭眼。 */
const BLINK = IDLE.map((row, y) => {
  if (y === 7) return ".DOOOOOOOOOOOOD.";
  if (y === 8) return ".DOOBBOOOOBBOOD.";
  return row;
});

/**
 * 开心（点击时）：眼睛眯成 ^ ^，嘴张开。
 *
 * 上一版这里用 `replace("BB","OB")` 再 `replace("BB","BO")` ——第一次命中左眼、
 * 第二次命中右眼，于是两只眼睛各自朝内缩一格，成了斗鸡眼。改成直接写死整行，
 * 按下标对称，不依赖「第几次匹配」这种会飘的东西。
 */
const HAPPY = IDLE.map((row, y) => {
  if (y === 7) return ".DOOBOOOOOOBOOD.";
  if (y === 8) return ".DOBOBOOOOBOBOD.";
  if (y === 12) return ".DOOOWWBBWWOOOD.";
  return row;
});

/**
 * 自动描边：任何**紧邻**填充像素的透明格，涂成描边色。
 *
 * 用 8 邻域而不是 4 邻域：4 邻域会在斜角上漏出缺口，放大后能看到形状「破」了一角。
 */
function outline(grid) {
  const { width: w, height: h } = canvas;
  const at = (x, y) => (y < 0 || y >= h || x < 0 || x >= w ? "." : grid[y][x]);
  const out = [];
  for (let y = 0; y < h; y++) {
    let row = "";
    for (let x = 0; x < w; x++) {
      if (at(x, y) !== ".") { row += at(x, y); continue; }
      let touching = false;
      for (let dy = -1; dy <= 1 && !touching; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx || dy) && at(x + dx, y + dy) !== ".") { touching = true; break; }
        }
      }
      row += touching ? "L" : ".";
    }
    out.push(row);
  }
  return out;
}

/**
 * 每一格都得对得上画布，而且颜色得在调色板里。
 *
 * 这条断言就是上一版那个 bug 的墓碑：17 格的行不会报错，只会被渲染器悄悄
 * 截断成一个不对称的下巴。画错一格必须当场炸，不能等到有人盯着看才发现。
 */
function check(id, grid) {
  if (grid.length !== canvas.height) {
    throw new Error(`帧 ${id}: ${grid.length} 行，应为 ${canvas.height}`);
  }
  grid.forEach((row, y) => {
    if (row.length !== canvas.width) {
      throw new Error(`帧 ${id} 第 ${y} 行: ${row.length} 格，应为 ${canvas.width} —— ${row}`);
    }
    for (const ch of row) {
      if (ch !== "." && !palette[ch]) throw new Error(`帧 ${id} 第 ${y} 行有未知色号 ${ch}`);
    }
  });
  return grid;
}

const build = (id, grid) => outline(check(id, grid));

const idle = build("idle", IDLE);
const blink = build("blink", BLINK);
const happy = build("happy", HAPPY);

export const frames = [
  { id: "idle", grid: idle, duration: 2000 },
  { id: "blink", grid: blink, duration: 160 },
  { id: "idle", grid: idle, duration: 1800 },
  { id: "happy", grid: happy, duration: 240 },
  { id: "idle", grid: idle, duration: 1600 },
];

export function dumpAscii(grid) {
  return grid.join("\n");
}
