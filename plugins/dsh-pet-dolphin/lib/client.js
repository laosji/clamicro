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
    var PALETTE = {"H":"#9DB2FF","M":"#4D6BFE","D":"#3349D0","W":"#E8F0FE","B":"#0E1533","S":"#BFD9FF","s":"#7FA5F2"};
    var W = 24, H = 16;
    var PX = 5;
    var FRAMES = [{"id":"swim-a","grid":["....................s.S.","................MMMMSSS.","...............HHHHHMss.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":300},{"id":"swim-b","grid":["...................s.S.S","................MMMMSS..","...............HHHHHM.s.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":300},{"id":"swim-a","grid":["....................s.S.","................MMMMSSS.","...............HHHHHMss.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":300},{"id":"swim-b","grid":["...................s.S.S","................MMMMSS..","...............HHHHHM.s.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":300},{"id":"idle","grid":["....................s.S.","................MMMMSSS.","...............HHHHHMss.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":1600},{"id":"blink","grid":["....................s.S.","................MMMMSSS.","...............HHHHHMss.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......MMHHHHHHHHHHM.....","....HHMMHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":160},{"id":"idle","grid":["....................s.S.","................MMMMSSS.","...............HHHHHMss.","..............HHHDDDDM..",".............HHHDDDDM...","............HHHHHHHM....","..........HHHHHHHHHM....","........HHHHHHHHHHHM....","......WBHHHHHHHHHHM.....","....HHBBHHHHHHHHHHM.....","..HHHHHHHHHHHHHHHM......",".MMWWWWWWWWMDDDMM.......","..MMWWWWWWDDDMM.........","...MMWWWWDDDM...........","....MWWDDDM.............","........................"],"duration":1400}];

    /* ── one-time: inject styles ────────────────────────────────────────── */
    var TAG = "dsh-pet-dolphin/style";
    if (typeof document !== "undefined" && !document.getElementById(TAG)) {
      var style = document.createElement("style");
      style.id = TAG;
      style.textContent = [
        ".dshdolphin-pet{position:absolute;bottom:18px;left:0;z-index:30;",
        "pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;",
        "touch-action:manipulation;will-change:left}",
        ".dshdolphin-bob{animation:dshdolphin-bob 3.2s ease-in-out infinite}",
        ".dshdolphin-flip{display:block}",
        ".dshdolphin-sprite{display:block;image-rendering:pixelated;image-rendering:crisp-edges;",
        "transition:transform .45s ease}",
        ".dshdolphin-sprite svg{display:block;overflow:visible}",
        ".dshdolphin-jump{animation:dshdolphin-jump .65s cubic-bezier(.34,1.56,.64,1) both}",
        ".dshdolphin-shadow{position:absolute;left:12%;right:18%;bottom:-5px;height:9px;",
        "border-radius:50%;background:rgba(10,16,60,.18);filter:blur(2px)}",
        ".dshdolphin-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;",
        "transform:translateX(-50%);background:#fff;color:#3349d0;border:2px solid #4d6bfe;",
        "border-radius:11px;padding:6px 11px;font:600 12px/1.4 ui-rounded,'SF Pro Rounded',system-ui,sans-serif;",
        "white-space:normal;max-width:min(60vw,320px);text-align:center;",
        "box-shadow:0 6px 18px rgba(15,25,90,.18);animation:dshdolphin-pop .18s ease-out;z-index:2}",
        ".dshdolphin-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);",
        "border:6px solid transparent;border-top-color:#4d6bfe}",
        ".dshdolphin-bub{position:absolute;bottom:66%;border-radius:50%;pointer-events:none;",
        "background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.9),rgba(191,217,255,.35));",
        "box-shadow:inset 0 0 0 1px rgba(127,165,242,.4);",
        "animation:dshdolphin-rise ease-in forwards}",
        "@keyframes dshdolphin-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-5px)}}",
        "@keyframes dshdolphin-jump{0%{transform:translateY(0) scale(1)}",
        "35%{transform:translateY(-22px) scale(1.05)}",
        "70%{transform:translateY(0) scale(.97)}",
        "100%{transform:translateY(0) scale(1)}}",
        "@keyframes dshdolphin-pop{from{transform:translateX(-50%) translateY(4px) scale(.9);opacity:0}",
        "to{transform:translateX(-50%) translateY(0) scale(1);opacity:1}}",
        "@keyframes dshdolphin-rise{from{transform:translateY(0) translateX(0) scale(.7);opacity:.85}",
        "60%{opacity:.5}to{transform:translateY(-52px) translateX(6px) scale(1.1);opacity:0}}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /* ── Clamicro 联动 ──────────────────────────────────────────────────
     *
     * 点一下 = 打开 Clamicro 的手机看板。为什么这条路不需要任何新权限：
     *
     *   · 打开页面是**普通导航**，不是 XHR —— 不涉及跨源，
     *     clamicro 那边一个字节都不用改。
     *   · 配对二维码本来就在 clamicro 自己的页面上（同源）。所以
     *     「点鲸鱼 → 出二维码」只是把入口前移一步，没有绕过 /api/pair
     *     的 X-CCM 防护 —— 那道防护拦的是「你访问的任意网站都能让这台
     *     Mac 弹二维码」，不该为便利拆掉。
     *
     * 活性探测用 no-cors：响应是 opaque、**读不到任何内容**，只有
     * 「连得上/连不上」这一个 bit，够决定是开窗还是给提示。
     */
    var DEFAULT_ORIGIN = "http://127.0.0.1:8765";

    function clamicroOrigin(config) {
      var o = (config && config.clamicroOrigin) ||
        (typeof window !== "undefined" && window.__CLAMICRO_ORIGIN__) ||
        DEFAULT_ORIGIN;
      return String(o).replace(/\/+$/, "");
    }

    function probeClamicro(origin) {
      // cache:no-store —— 别让缓存把「已经挂了」显示成「还活着」
      return fetch(origin + "/healthz", { mode: "no-cors", cache: "no-store" })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    var PHRASES = [
      "咕噜咕噜～",
      "Hi~ 我是 DeepSeek 鲸鱼 🐋",
      "你在忙什么呀？",
      "DeepSeek 为你保驾护航",
      "戳我一下，我会跳高高～",
      "深潜中……吐个泡泡"
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

    var PET_W = W * PX;

    /* ── the pet component ─────────────────────────────────────────────── */
    function DolphinPet(props) {
      var config = (props && props.config) || {};
      var origin = clamicroOrigin(config);
      // 关掉联动就退回原来的纯玩具行为
      var linked = config.clamicro !== false;
      var _frame = useState(0);
      var frameIdx = _frame[0], setFrameIdx = _frame[1];
      var _dir = useState(-1);          // -1 = 朝左，1 = 朝右（镜像）
      var dir = _dir[0], setDir = _dir[1];
      var _jump = useState(false);
      var jump = _jump[0], setJump = _jump[1];
      var _bubble = useState(null);
      var bubble = _bubble[0], setBubble = _bubble[1];
      var bubbleTimer = useRef(null);
      var jumpTimer = useRef(null);
      var petRef = useRef(null);
      var dirRef = useRef(-1);

      /* tail-wag / blink frame loop */
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

      /* 游来游去：在整条 overlay 底部左右漂移，撞边就掉头 + 镜像 */
      useEffect(function () {
        var raf, last = null;
        var x = 0, heading = 1;         // heading: +1 右，-1 左
        var SPEED = 34;                 // px per second（从容的巡游速度）
        function step(now) {
          var el = petRef.current;
          if (!el) { raf = requestAnimationFrame(step); return; }
          if (last === null) last = now;
          var dt = Math.min(0.05, (now - last) / 1000); // 切后台回来别跳一大步
          last = now;
          var parent = el.parentElement;
          var maxX = parent ? Math.max(0, parent.clientWidth - el.offsetWidth) : 0;
          x += heading * SPEED * dt;
          if (x <= 0) { x = 0; heading = 1; if (dirRef.current !== 1) { dirRef.current = 1; setDir(1); } }
          else if (x >= maxX) { x = maxX; heading = -1; if (dirRef.current !== -1) { dirRef.current = -1; setDir(-1); } }
          el.style.left = x.toFixed(1) + "px";
          raf = requestAnimationFrame(step);
        }
        raf = requestAnimationFrame(step);
        return function () { cancelAnimationFrame(raf); };
      }, []);

      /* 水花：呼吸孔吐泡泡 */
      useEffect(function () {
        var t = setInterval(function () {
          var el = petRef.current;
          if (!el || !el.isConnected) return;
          var b = document.createElement("span");
          b.className = "dshdolphin-bub";
          // 呼吸孔在头顶靠前侧；镜像时翻到另一侧
          var side = dirRef.current === 1 ? PET_W - 34 : 20;
          b.style.left = (side + Math.random() * 14) + "px";
          var sz = 4 + Math.random() * 5;
          b.style.width = b.style.height = sz + "px";
          b.style.animationDuration = (1.5 + Math.random() * 1.5) + "s";
          el.appendChild(b);
          setTimeout(function () { b.remove(); }, 3200);
        }, 1300);
        return function () { clearInterval(t); };
      }, []);

      function say(text, ms) {
        setBubble(text);
        clearTimeout(bubbleTimer.current);
        bubbleTimer.current = setTimeout(function () { setBubble(null); }, ms || 2600);
      }

      /**
       * 点击 = 去 Clamicro 手机看板（没配对的话那一页就是二维码入口）。
       *
       * 先探活再开窗，不直接 window.open：clamicro 没在跑时直接开会甩给
       * 用户一个浏览器错误页——既没说清是什么问题，也没说怎么办。
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
            say("带你去手机看板 🐳");
            // noopener：新窗口不该拿到对本页的引用
            window.open(origin + "/ui", "_blank", "noopener");
          } else {
            // 说清「怎么办」，而不只是「不行」
            say("Clamicro 没在跑。在终端执行 npx clamicro qr 就能配对手机～", 6000);
          }
        });
      }

      var sprite = React.createElement("div", {
        className: jump ? "dshdolphin-sprite dshdolphin-jump" : "dshdolphin-sprite",
        dangerouslySetInnerHTML: { __html: svgFor(FRAMES[frameIdx].grid) }
      });

      return React.createElement("div", {
        ref: petRef,
        className: "dshdolphin-pet",
        role: "button",
        tabIndex: 0,
        // 图标按钮对读屏软件是无名的；这里还要说清**点了会怎样**
        "aria-label": linked ? "打开 Clamicro 手机看板" : "DeepSeek Whale",
        title: linked ? "点一下 → Clamicro 手机看板 / 配对二维码" : "DeepSeek Whale",
        onClick: poke,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); poke(); } }
      },
        bubble ? React.createElement("div", { className: "dshdolphin-bubble" }, bubble) : null,
        React.createElement("div", { className: "dshdolphin-bob" },
          React.createElement("div", {
            className: "dshdolphin-flip",
            style: { transform: dir === 1 ? "scaleX(-1)" : "scaleX(1)" }
          }, sprite)
        ),
        React.createElement("div", { className: "dshdolphin-shadow" })
      );
    }

    /* ── plugin body ────────────────────────────────────────────────────── */
    /**
     * @param config 全部可选：
     *   clamicro       false = 关掉 Clamicro 联动，退回纯玩具
     *   clamicroOrigin Clamicro 地址，默认 http://127.0.0.1:8765
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
