window.__ModuleLoader__.load({
  id: "dsh-pet-dolphin",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    /* ── pixel art (generated from dev/art.mjs) ─────────────────────────── */
    var PALETTE = {"H":"#9DB2FF","M":"#4D6BFE","D":"#3349D0","W":"#F2F6FF","B":"#0E1533","S":"#BFD9FF","s":"#7FA5F2"};
    var W = 24, H = 16;
    var PX = 5;
    var FRAMES = [{"id":"swim-a","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMMMSS",".MMDDMWWWWWMMMMMMMMMMMMs","...MMWWWWWMMMMMMDD..ssss","....MMWWWWMMMMMMMMDDDsss",".....MMMMMMMMMMDDDDDSSS.","......MMMMMMMDDDDDsss...",".......MMMDDDDDDSSS....."],"duration":300},{"id":"swim-b","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMM.SS",".MMDDMWWWWWMMMMMMMMMMM.s","...MMWWWWWMMMMMMDDMMssss","....MMWWWWMMMMMMMMDDDMMs",".....MMMMMMMMMMDDDDDMsss","......MMMMMMMDDDDD.sss..",".......MMMDDDDDDSSS....."],"duration":300},{"id":"swim-a","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMMMSS",".MMDDMWWWWWMMMMMMMMMMMMs","...MMWWWWWMMMMMMDD..ssss","....MMWWWWMMMMMMMMDDDsss",".....MMMMMMMMMMDDDDDSSS.","......MMMMMMMDDDDDsss...",".......MMMDDDDDDSSS....."],"duration":300},{"id":"swim-b","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMM.SS",".MMDDMWWWWWMMMMMMMMMMM.s","...MMWWWWWMMMMMMDDMMssss","....MMWWWWMMMMMMMMDDDMMs",".....MMMMMMMMMMDDDDDMsss","......MMMMMMMDDDDD.sss..",".......MMMDDDDDDSSS....."],"duration":300},{"id":"idle","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMMMSS",".MMDDMWWWWWMMMMMMMMMMMMs","...MMWWWWWMMMMMMDD..ssss","....MMWWWWMMMMMMMMDDDsss",".....MMMMMMMMMMDDDDDSSS.","......MMMMMMMDDDDDsss...",".......MMMDDDDDDSSS....."],"duration":1400},{"id":"blink","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMMMMMMMMMMMMMMM....","..MMMMMMMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMMMSS",".MMDDMWWWWWMMMMMMMMMMMMs","...MMWWWWWMMMMMMDD..ssss","....MMWWWWMMMMMMMMDDDsss",".....MMMMMMMMMMDDDDDSSS.","......MMMMMMMDDDDDsss...",".......MMMDDDDDDSSS....."],"duration":170},{"id":"idle","grid":["........................","...........HH...........","..........HHHH..........","........HHHHHHM.........","......HHHHHHHHHHM.......","....HHHHHHHHHHHHHHM.....","...MMMWBMMMMMMMMMMMM....","..MMMMBBMMMMMMMMMMMMM...","..MMMMMMMMMMMMMMMMMMM.SS",".MMMMMWWWWWMMMMMMMMMMMSS",".MMDDMWWWWWMMMMMMMMMMMMs","...MMWWWWWMMMMMMDD..ssss","....MMWWWWMMMMMMMMDDDsss",".....MMMMMMMMMMDDDDDSSS.","......MMMMMMMDDDDDsss...",".......MMMDDDDDDSSS....."],"duration":1200}];

    /* ── one-time: inject styles ────────────────────────────────────────── */
    var TAG = "dsh-pet-dolphin/style";
    if (typeof document !== "undefined" && !document.getElementById(TAG)) {
      var style = document.createElement("style");
      style.id = TAG;
      style.textContent = [
        ".dshdolphin-pet{position:absolute;right:22px;bottom:18px;z-index:30;",
        "pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;",
        "touch-action:manipulation}",
        ".dshdolphin-bob{animation:dshdolphin-bob 3.2s ease-in-out infinite}",
        ".dshdolphin-sprite{display:block;image-rendering:pixelated;image-rendering:crisp-edges}",
        ".dshdolphin-sprite svg{display:block;overflow:visible}",
        ".dshdolphin-jump{animation:dshdolphin-jump .65s cubic-bezier(.34,1.56,.64,1) both}",
        ".dshdolphin-shadow{position:absolute;left:12%;right:18%;bottom:-5px;height:9px;",
        "border-radius:50%;background:rgba(10,16,60,.20);filter:blur(2px)}",
        ".dshdolphin-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;",
        "transform:translateX(-50%);background:#fff;color:#3349d0;border:2px solid #4d6bfe;",
        "border-radius:11px;padding:6px 11px;font:600 12px/1.4 ui-rounded,'SF Pro Rounded',system-ui,sans-serif;",
        "white-space:normal;max-width:min(60vw,320px);text-align:center;",
        "box-shadow:0 6px 18px rgba(15,25,90,.18);animation:dshdolphin-pop .18s ease-out}",
        ".dshdolphin-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);",
        "border:6px solid transparent;border-top-color:#4d6bfe}",
        "@keyframes dshdolphin-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
        "@keyframes dshdolphin-jump{0%{transform:translateY(0) scale(1)}",
        "35%{transform:translateY(-20px) scale(1.05)}",
        "70%{transform:translateY(0) scale(.97)}",
        "100%{transform:translateY(0) scale(1)}}",
        "@keyframes dshdolphin-pop{from{transform:translateX(-50%) translateY(4px) scale(.9);opacity:0}",
        "to{transform:translateX(-50%) translateY(0) scale(1);opacity:1}}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /* ── Clamicro 联动 ──────────────────────────────────────────────────
     *
     * 点一下海豚 = 打开 Clamicro 的手机看板。为什么这条路走得通、而且
     * 不需要任何新权限：
     *
     *   · 打开页面是一次**普通导航**，不是 XHR —— 不涉及跨源，
     *     clamicro 那边一个字节都不用改。
     *   · 配对二维码本来就在 clamicro 自己的页面上（同源，一直能用）。
     *     所以「点海豚 → 出二维码」只是把入口前移了一步，
     *     没有绕过 /api/pair 的 X-CCM 防护 —— 那道防护存在的理由是
     *     「否则你访问的任意网站都能让这台 Mac 弹二维码」，不该为便利拆掉。
     *
     * 活性探测用 no-cors：**读不到任何内容**（响应是 opaque），
     * 但连接被拒时 fetch 会 reject。刚好够回答「在不在跑」这一个 bit，
     * 而这一个 bit 本机页面本来就能通过别的方式知道，不构成新的信息泄露。
     */
    var DEFAULT_ORIGIN = "http://127.0.0.1:8765";

    function clamicroOrigin(config) {
      var o = (config && config.clamicroOrigin) ||
        (typeof window !== "undefined" && window.__CLAMICRO_ORIGIN__) ||
        DEFAULT_ORIGIN;
      return String(o).replace(/\/+$/, "");
    }

    function probeClamicro(origin) {
      // cache:no-store：别让浏览器缓存把「已经挂了」显示成「还活着」
      return fetch(origin + "/healthz", { mode: "no-cors", cache: "no-store" })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    var PHRASES = [
      "咕噜咕噜～",
      "Hi~ 我是 DeepSeek 海豚 🐬",
      "你在忙什么呀？",
      "DeepSeek 为你保驾护航",
      "摸鱼中……吐个泡泡"
    ];

    /* ── frame → svg string (precomputed, cached) ──────────────────────── */
    var SVG_CACHE = {};
    function svgFor(grid) {
      if (SVG_CACHE[grid]) return SVG_CACHE[grid];
      var rects = [];
      for (var y = 0; y < H; y++) {
        var row = grid[y] || "";
        for (var x = 0; x < W; x++) {
          var ch = row[x];
          if (!ch || ch === "." || !PALETTE[ch]) continue;
          rects.push('<rect x="' + x + '" y="' + y + '" width="1" height="1" fill="' + PALETTE[ch] + '"/>');
        }
      }
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" width="' + (W * PX) + '" height="' + (H * PX) + '" shape-rendering="crispEdges">' + rects.join("") + "</svg>";
      SVG_CACHE[grid] = svg;
      return svg;
    }

    /* ── the pet component ─────────────────────────────────────────────── */
    function DolphinPet(props) {
      var config = (props && props.config) || {};
      var origin = clamicroOrigin(config);
      // 关掉联动就退回原来的纯玩具行为
      var linked = config.clamicro !== false;
      var _frame = useState(0);
      var frameIdx = _frame[0], setFrameIdx = _frame[1];
      var _jump = useState(false);
      var jump = _jump[0], setJump = _jump[1];
      var _bubble = useState(null);
      var bubble = _bubble[0], setBubble = _bubble[1];
      var bubbleTimer = useRef(null);
      var jumpTimer = useRef(null);

      useEffect(function () {
        var alive = true;
        var idx = 0;
        var timer;
        function tick() {
          if (!alive) return;
          setFrameIdx(idx);
          timer = setTimeout(tick, FRAMES[idx].duration);
          idx = (idx + 1) % FRAMES.length;
        }
        tick();
        return function () { alive = false; clearTimeout(timer); };
      }, []);

      useEffect(function () {
        return function () {
          clearTimeout(jumpTimer.current);
          clearTimeout(bubbleTimer.current);
        };
      }, []);

      function say(text, ms) {
        setBubble(text);
        clearTimeout(bubbleTimer.current);
        bubbleTimer.current = setTimeout(function () { setBubble(null); }, ms || 2600);
      }

      /**
       * 点击 = 去 Clamicro 手机看板（没配对的话那一页上就是二维码入口）。
       *
       * 先探活再开窗，不是直接 window.open：clamicro 没在跑的时候，
       * 直接开会甩给用户一个浏览器错误页——那既没说清是什么问题，
       * 也没说怎么办。探一下就能给出可执行的下一步。
       */
      function poke() {
        setJump(true);
        clearTimeout(jumpTimer.current);
        jumpTimer.current = setTimeout(function () { setJump(false); }, 660);

        if (!linked) {
          say(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
          return;
        }

        say("看看手机那边…");
        probeClamicro(origin).then(function (alive) {
          if (alive) {
            say("带你去手机看板 🐬");
            // noopener：新窗口不该拿到对本页的引用
            window.open(origin + "/ui", "_blank", "noopener");
          } else {
            // 说清「怎么办」而不只是「不行」。命令是可以照抄的那一条
            say("Clamicro 没在跑。在终端执行 npx clamicro qr 就能配对手机～", 6000);
          }
        });
      }

      var sprite = React.createElement("div", {
        className: jump ? "dshdolphin-sprite dshdolphin-jump" : "dshdolphin-sprite",
        dangerouslySetInnerHTML: { __html: svgFor(FRAMES[frameIdx].grid) }
      });

      return React.createElement("div", {
        className: "dshdolphin-pet",
        role: "button",
        tabIndex: 0,
        // 图标按钮对读屏软件是无名的，而且这里 aria-label 还要说清**点了会怎样**
        "aria-label": linked ? "打开 Clamicro 手机看板" : "DeepSeek Dolphin",
        title: linked ? "点一下 → Clamicro 手机看板 / 配对二维码" : "DeepSeek Dolphin",
        onClick: poke,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); poke(); } }
      },
        bubble ? React.createElement("div", { className: "dshdolphin-bubble" }, bubble) : null,
        React.createElement("div", { className: "dshdolphin-bob" }, sprite),
        React.createElement("div", { className: "dshdolphin-shadow" })
      );
    }

    /* ── plugin body ────────────────────────────────────────────────────── */
    /**
     * @param config 插件配置，全部可选：
     *   clamicro       false = 关掉 Clamicro 联动，退回纯玩具（点了只跳一下）
     *   clamicroOrigin Clamicro 地址，默认 http://127.0.0.1:8765
     *
     * 配置在这里就地绑进组件，而不是让组件自己去读全局：
     * 组件只该拿到「它需要什么」，去哪儿拿是插件层的事。
     */
    function apply(ctx, config) {
      var cfg = config || {};
      function Pet() {
        return React.createElement(DolphinPet, { config: cfg });
      }
      ctx.effect(function () {
        return ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-pet-dolphin",
            order: 1
          }, Pet);
        });
      }, "dsh-pet-dolphin: register overlay pet");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
