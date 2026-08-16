/**
 * Build lib/client.js — the official DeepSeek whale pet.
 * The whale is the OFFICIAL mark (the exact SVG path from
 * dsh-web-frontend/dist/favicon.svg), not hand-drawn pixel art.
 * Usage: node dev/build.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const whale = JSON.parse(readFileSync(new URL("./whale-path.json", import.meta.url), "utf8"));
const WHALE_PATH = whale.d;
const SIZE = 64; // display size in px (viewBox is 50x50)

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

    /* ── the official DeepSeek whale mark ────────────────────────────────
     * 直接取自 dsh-web-frontend/dist/favicon.svg 的 path（不是手绘像素），
     * 所以形状和官方 logo 一模一样。眼睛在 path 里是一个「洞」，这里再补一个
     * 实心深色圆点，保证在任何背景上都看得见。
     */
    var WHALE_PATH = ${JSON.stringify(WHALE_PATH)};
    var SIZE = ${SIZE};

    var WHALE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" ' +
      'width="' + SIZE + '" height="' + SIZE + '" aria-hidden="true">' +
      '<path d="' + WHALE_PATH + '" fill="#4D6BFE" fill-rule="nonzero"/>' +
      '<circle cx="26.6" cy="24.6" r="0.85" fill="#0E1533"/>' +
      '</svg>';

    /* ── one-time: inject styles ────────────────────────────────────────── */
    var TAG = "dsh-pet-dolphin/style";
    if (typeof document !== "undefined" && !document.getElementById(TAG)) {
      var style = document.createElement("style");
      style.id = TAG;
      style.textContent = [
        ".dshdolphin-pet{position:absolute;bottom:18px;left:0;z-index:30;",
        "pointer-events:auto;cursor:pointer;user-select:none;-webkit-user-select:none;",
        "touch-action:manipulation;will-change:left}",
        ".dshdolphin-bob{animation:dshdolphin-bob 3.4s ease-in-out infinite}",
        ".dshdolphin-flip{display:block}",
        ".dshdolphin-sprite{display:block;transition:transform .45s ease;filter:",
        "drop-shadow(0 4px 6px rgba(10,16,60,.18))}",
        ".dshdolphin-sprite svg{display:block;overflow:visible}",
        ".dshdolphin-jump{animation:dshdolphin-jump .65s cubic-bezier(.34,1.56,.64,1) both}",
        ".dshdolphin-bubble{position:absolute;bottom:calc(100% + 12px);left:50%;",
        "transform:translateX(-50%);background:#fff;color:#3349d0;border:2px solid #4d6bfe;",
        "border-radius:11px;padding:6px 11px;font:600 12px/1.4 ui-rounded,'SF Pro Rounded',system-ui,sans-serif;",
        "white-space:normal;max-width:min(60vw,320px);text-align:center;",
        "box-shadow:0 6px 18px rgba(15,25,90,.18);animation:dshdolphin-pop .18s ease-out;z-index:2}",
        ".dshdolphin-bubble::after{content:'';position:absolute;top:100%;left:50%;transform:translateX(-50%);",
        "border:6px solid transparent;border-top-color:#4d6bfe}",
        ".dshdolphin-bub{position:absolute;bottom:72%;border-radius:50%;pointer-events:none;",
        "background:radial-gradient(circle at 35% 30%,rgba(255,255,255,.9),rgba(191,217,255,.35));",
        "box-shadow:inset 0 0 0 1px rgba(127,165,242,.4);",
        "animation:dshdolphin-rise ease-in forwards}",
        "@keyframes dshdolphin-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}",
        "@keyframes dshdolphin-jump{0%{transform:translateY(0) scale(1)}",
        "35%{transform:translateY(-22px) scale(1.05)}",
        "70%{transform:translateY(0) scale(.97)}",
        "100%{transform:translateY(0) scale(1)}}",
        "@keyframes dshdolphin-pop{from{transform:translateX(-50%) translateY(4px) scale(.9);opacity:0}",
        "to{transform:translateX(-50%) translateY(0) scale(1);opacity:1}}",
        "@keyframes dshdolphin-rise{from{transform:translateY(0) translateX(0) scale(.6);opacity:.85}",
        "60%{opacity:.5}to{transform:translateY(-56px) translateX(7px) scale(1.15);opacity:0}}"
      ].join("\\n");
      document.head.appendChild(style);
    }

    /* ── Clamicro 联动 ──────────────────────────────────────────────────
     * 点一下 = 打开 Clamicro 手机看板。普通导航 + no-cors 活性探测。
     */
    var DEFAULT_ORIGIN = "http://127.0.0.1:8765";

    function clamicroOrigin(config) {
      var o = (config && config.clamicroOrigin) ||
        (typeof window !== "undefined" && window.__CLAMICRO_ORIGIN__) ||
        DEFAULT_ORIGIN;
      return String(o).replace(/\\/+$/, "");
    }

    function probeClamicro(origin) {
      return fetch(origin + "/healthz", { mode: "no-cors", cache: "no-store" })
        .then(function () { return true; })
        .catch(function () { return false; });
    }

    var PHRASES = [
      "咕噜咕噜～",
      "Hi~ 我是 DeepSeek 鲸鱼 🐋",
      "你在忙什么呀？",
      "DeepSeek 为你保驾护航",
      "摸鱼中……吐个泡泡"
    ];

    /* ── the pet component ─────────────────────────────────────────────── */
    function DolphinPet(props) {
      var config = (props && props.config) || {};
      var origin = clamicroOrigin(config);
      var linked = config.clamicro !== false;
      var _jump = useState(false);
      var jump = _jump[0], setJump = _jump[1];
      var _bubble = useState(null);
      var bubble = _bubble[0], setBubble = _bubble[1];
      var _dir = useState(-1);
      var dir = _dir[0], setDir = _dir[1];
      var bubbleTimer = useRef(null);
      var jumpTimer = useRef(null);
      var petRef = useRef(null);
      var dirRef = useRef(-1);

      /* 游来游去：底部左右漂移，撞边掉头 + 镜像 */
      useEffect(function () {
        var raf, last = null;
        var x = 0, heading = 1;
        var SPEED = 30; // px/s
        function step(now) {
          var el = petRef.current;
          if (!el) { raf = requestAnimationFrame(step); return; }
          if (last === null) last = now;
          var dt = Math.min(0.05, (now - last) / 1000);
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

      /* 水花：喷气孔吐泡泡 */
      useEffect(function () {
        var t = setInterval(function () {
          var el = petRef.current;
          if (!el || !el.isConnected) return;
          var b = document.createElement("span");
          b.className = "dshdolphin-bub";
          var side = dirRef.current === 1 ? SIZE - 22 : 16;
          b.style.left = (side + Math.random() * 10) + "px";
          var sz = 3 + Math.random() * 4;
          b.style.width = b.style.height = sz + "px";
          b.style.animationDuration = (1.4 + Math.random() * 1.4) + "s";
          el.appendChild(b);
          setTimeout(function () { b.remove(); }, 3000);
        }, 1300);
        return function () { clearInterval(t); };
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
        jumpTimer.current = setTimeout(function () { setJump(false); }, 660);

        if (!linked) {
          say(PHRASES[Math.floor(Math.random() * PHRASES.length)]);
          return;
        }

        say("看看手机那边…");
        probeClamicro(origin).then(function (alive) {
          if (alive) {
            say("带你去手机看板 🐳");
            window.open(origin + "/ui", "_blank", "noopener");
          } else {
            say("Clamicro 没在跑。在终端执行 npx clamicro qr 就能配对手机～", 6000);
          }
        });
      }

      var sprite = React.createElement("div", {
        className: jump ? "dshdolphin-sprite dshdolphin-jump" : "dshdolphin-sprite",
        dangerouslySetInnerHTML: { __html: WHALE_SVG }
      });

      return React.createElement("div", {
        ref: petRef,
        className: "dshdolphin-pet",
        role: "button",
        tabIndex: 0,
        "aria-label": linked ? "打开 Clamicro 手机看板" : "DeepSeek Pet",
        title: linked ? "点一下 → Clamicro 手机看板 / 配对二维码" : "DeepSeek Pet",
        onClick: poke,
        onKeyDown: function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); poke(); } }
      },
        bubble ? React.createElement("div", { className: "dshdolphin-bubble" }, bubble) : null,
        React.createElement("div", { className: "dshdolphin-bob" },
          React.createElement("div", {
            className: "dshdolphin-flip",
            style: { transform: dir === 1 ? "scaleX(-1)" : "scaleX(1)" }
          }, sprite)
        )
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
`;

const out = fileURLToPath(new URL("../lib/client.js", import.meta.url));
writeFileSync(out, client);
console.log("wrote", out, `(${client.length} chars, whale path ${WHALE_PATH.length} chars)`);
