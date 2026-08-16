/**
 * Build lib/client.js from dev/art.mjs (single source of truth for the art).
 * Usage: node dev/build.mjs
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { palette, canvas, frames } from "./art.mjs";

const PX = 5; // display px per pixel

const client = `window.__ModuleLoader__.load({
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
    var PALETTE = ${JSON.stringify(palette)};
    var W = ${canvas.width}, H = ${canvas.height};
    var PX = ${PX};
    var FRAMES = ${JSON.stringify(frames)};

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
      ].join("\\n");
      document.head.appendChild(style);
    }

    var PHRASES = [
      "咕噜咕噜～",
      "Hi~ 我是 DeepSeek 海豚 🐬",
      "你在忙什么呀？",
      "DeepSeek 为你保驾护航",
      "戳我一下，我会跳高高～",
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
    function DolphinPet() {
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

      function poke() {
        setJump(true);
        clearTimeout(jumpTimer.current);
        jumpTimer.current = setTimeout(function () { setJump(false); }, 660);
        setBubble(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
        clearTimeout(bubbleTimer.current);
        bubbleTimer.current = setTimeout(function () { setBubble(null); }, 2600);
      }

      var sprite = React.createElement("div", {
        className: jump ? "dshdolphin-sprite dshdolphin-jump" : "dshdolphin-sprite",
        dangerouslySetInnerHTML: { __html: svgFor(FRAMES[frameIdx].grid) }
      });

      return React.createElement("div", {
        className: "dshdolphin-pet",
        role: "button",
        tabIndex: 0,
        "aria-label": "DeepSeek Dolphin",
        title: "DeepSeek Dolphin",
        onClick: poke,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); poke(); } }
      },
        bubble ? React.createElement("div", { className: "dshdolphin-bubble" }, bubble) : null,
        React.createElement("div", { className: "dshdolphin-bob" }, sprite),
        React.createElement("div", { className: "dshdolphin-shadow" })
      );
    }

    /* ── plugin body ────────────────────────────────────────────────────── */
    function apply(ctx) {
      ctx.effect(function () {
        return ctx.slots.inject("shell.overlay", function () {
          return ctx.slots.register({
            name: "shell.overlay",
            id: "dsh-pet-dolphin",
            order: 1
          }, DolphinPet);
        });
      }, "dsh-pet-dolphin: register overlay pet");
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
`;

const out = fileURLToPath(new URL("../lib/client.js", import.meta.url));
writeFileSync(out, client);
console.log("wrote", out, `(${client.length} bytes, ${frames.length} frames)`);
