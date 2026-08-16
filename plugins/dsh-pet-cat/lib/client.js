window.__ModuleLoader__.load({
  id: "dsh-pet-cat",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var React = require("react");
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    /* ── pixel art (generated from dev/art.mjs) ─────────────────────────── */
    var PALETTE = {"O":"#E8912D","D":"#C8751F","W":"#FFF3E0","B":"#2A2A2A","P":"#F28BAE"};
    var W = 16, H = 16;
    var PX = 6;
    var FRAMES = [{"id":"idle","grid":["................","...O........O...","..OOO......OOO..",".OOOOO....OOOOO.","..OOOOOOOOOOOO..",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOWBOOOOWBOOO.",".OOOBBOOOOBBOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOPPOOOOOO.",".OOOOWWWWWWOOOO.",".OOOWWWWWWWWOOOO.","..OOOOOOOOOOOO..","................"],"duration":2000},{"id":"blink","grid":["................","...O........O...","..OOO......OOO..",".OOOOO....OOOOO.","..OOOOOOOOOOOO..",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOPPOOOOOO.",".OOOOWWWWWWOOOO.",".OOOWWWWWWWWOOOO.","..OOOOOOOOOOOO..","................"],"duration":160},{"id":"idle","grid":["................","...O........O...","..OOO......OOO..",".OOOOO....OOOOO.","..OOOOOOOOOOOO..",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOWBOOOOWBOOO.",".OOOBBOOOOBBOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOPPOOOOOO.",".OOOOWWWWWWOOOO.",".OOOWWWWWWWWOOOO.","..OOOOOOOOOOOO..","................"],"duration":1800},{"id":"happy","grid":["................","...O........O...","..OOO......OOO..",".OOOOO....OOOOO.","..OOOOOOOOOOOO..",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOBOOOOBOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOPPOOOOOO.",".OOOOBBBBBBOOOO.",".OOOWWWWWWWWOOOO.","..OOOOOOOOOOOO..","................"],"duration":240},{"id":"idle","grid":["................","...O........O...","..OOO......OOO..",".OOOOO....OOOOO.","..OOOOOOOOOOOO..",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOWBOOOOWBOOO.",".OOOBBOOOOBBOOO.",".OOOOOOOOOOOOOO.",".OOOOOOOOOOOOOO.",".OOOOOOPPOOOOOO.",".OOOOWWWWWWOOOO.",".OOOWWWWWWWWOOOO.","..OOOOOOOOOOOO..","................"],"duration":1600}];

    /* ── one-time: inject styles ────────────────────────────────────────── */
    var TAG = "dsh-pet-cat/style";
    if (typeof document !== "undefined" && !document.getElementById(TAG)) {
      var style = document.createElement("style");
      style.id = TAG;
      style.textContent = [
        ".dshcat-pet{position:absolute;right:22px;bottom:16px;z-index:30;",
        "pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;",
        "touch-action:manipulation}",
        // 蹦蹦跳跳：外层轻轻浮沉，内层周期性跳一下，落地时压扁
        ".dshcat-bob{animation:dshcat-bob 3.4s ease-in-out infinite}",
        ".dshcat-hop{animation:dshcat-hop 2.6s cubic-bezier(.34,1.4,.64,1) infinite}",
        ".dshcat-sprite{display:block;image-rendering:pixelated;image-rendering:crisp-edges;",
        "filter:drop-shadow(0 4px 6px rgba(20,10,0,.16))}",
        ".dshcat-sprite svg{display:block;overflow:visible}",
        ".dshcat-jump{animation:dshcat-jump .6s cubic-bezier(.34,1.56,.64,1) both}",
        ".dshcat-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;",
        "transform:translateX(-50%);background:#fff;color:#c8751f;border:2px solid #e8912d;",
        "border-radius:11px;padding:6px 11px;font:600 12px/1.4 ui-rounded,'SF Pro Rounded',system-ui,sans-serif;",
        "white-space:normal;max-width:min(60vw,320px);text-align:center;",
        "box-shadow:0 6px 18px rgba(20,10,0,.16);animation:dshcat-pop .18s ease-out;z-index:2}",
        ".dshcat-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);",
        "border:6px solid transparent;border-top-color:#e8912d}",
        "@keyframes dshcat-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}",
        "@keyframes dshcat-hop{",
        "0%,55%,100%{transform:translateY(0) scale(1,1)}",
        "64%{transform:translateY(-20px) scale(1.06,.94)}",
        "73%{transform:translateY(0) scale(.94,1.08)}",
        "81%{transform:translateY(0) scale(1,1)}}",
        "@keyframes dshcat-jump{0%{transform:translateY(0) scale(1,1)}",
        "35%{transform:translateY(-30px) scale(1.05,.95)}",
        "70%{transform:translateY(0) scale(.92,1.1)}",
        "100%{transform:translateY(0) scale(1,1)}}",
        "@keyframes dshcat-pop{from{transform:translateX(-50%) translateY(4px) scale(.9);opacity:0}",
        "to{transform:translateX(-50%) translateY(0) scale(1);opacity:1}}"
      ].join("\n");
      document.head.appendChild(style);
    }

    /* ── Clamicro 联动（点一下 = 打开手机看板，no-cors 探活）────────── */
    var DEFAULT_ORIGIN = "http://127.0.0.1:8765";
    function clamicroOrigin(config) {
      var o = (config && config.clamicroOrigin) ||
        (typeof window !== "undefined" && window.__CLAMICRO_ORIGIN__) ||
        DEFAULT_ORIGIN;
      return String(o).replace(/\/+$/, "");
    }
    function probeClamicro(origin) {
      return fetch(origin + "/healthz", { mode: "no-cors", cache: "no-store" })
        .then(function () { return true; })
        .catch(function () { return false; });
    }
    var PHRASES = [
      "喵～",
      "Hi~ 我是一只小橘猫 🐱",
      "你在忙什么呀？",
      "戳我一下，我会蹦高高～",
      "摸鱼中……喵"
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
    function CatPet(props) {
      var config = (props && props.config) || {};
      var origin = clamicroOrigin(config);
      var linked = config.clamicro !== false;
      var _frame = useState(0);
      var frameIdx = _frame[0], setFrameIdx = _frame[1];
      var _jump = useState(false);
      var jump = _jump[0], setJump = _jump[1];
      var _bubble = useState(null);
      var bubble = _bubble[0], setBubble = _bubble[1];
      var bubbleTimer = useRef(null);
      var jumpTimer = useRef(null);

      /* 帧循环：眨眼 + 偶尔的开心脸 */
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

      function poke() {
        setJump(true);
        clearTimeout(jumpTimer.current);
        jumpTimer.current = setTimeout(function () { setJump(false); }, 620);

        if (!linked) {
          say(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
          return;
        }
        say("看看手机那边…");
        probeClamicro(origin).then(function (alive) {
          if (alive) {
            say("带你去手机看板 🐱");
            window.open(origin + "/ui", "_blank", "noopener");
          } else {
            say("Clamicro 没在跑。在终端执行 npx clamicro qr 就能配对手机～", 6000);
          }
        });
      }

      var sprite = React.createElement("div", {
        className: jump ? "dshcat-sprite dshcat-jump" : "dshcat-sprite",
        dangerouslySetInnerHTML: { __html: svgFor(FRAMES[frameIdx].grid) }
      });

      return React.createElement("div", {
        className: "dshcat-pet",
        role: "button",
        tabIndex: 0,
        "aria-label": linked ? "打开 Clamicro 手机看板" : "DeepSeek Pet",
        title: linked ? "点一下 → Clamicro 手机看板 / 配对二维码" : "DeepSeek Pet",
        onClick: poke,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); poke(); } }
      },
        bubble ? React.createElement("div", { className: "dshcat-bubble" }, bubble) : null,
        React.createElement("div", { className: "dshcat-bob" },
          React.createElement("div", { className: "dshcat-hop" }, sprite)
        )
      );
    }

    /* ── plugin body ────────────────────────────────────────────────────── */
    function apply(ctx, config) {
      var cfg = config || {};
      function Pet() {
        return React.createElement(CatPet, { config: cfg });
      }
      ctx.effect(function () {
        return ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-pet-cat",
            order: 1
          }, Pet);
        });
      }, "dsh-pet-cat: register overlay pet");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
