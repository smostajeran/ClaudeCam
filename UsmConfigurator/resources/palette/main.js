/*
 * USM Haller configurator palette.
 * Sends actions to Fusion via adsk.fusionSendData and receives updates through
 * window.fusionJavaScriptHandler.handle(action, data).
 */
(function () {
  "use strict";

  // -- own SVG icons (not the proprietary USM artwork) -----------------------
  // A simple isometric helper so every tile shares a consistent look.
  function frame(inner) {
    return (
      '<svg viewBox="0 0 64 48">' +
      '<g fill="none" stroke="#8a8c8f" stroke-width="2" stroke-linejoin="round">' +
      '<path d="M8 16 L40 16 L56 8 L24 8 Z"/>' +        // top
      '<path d="M8 16 L8 40 L40 40 L40 16"/>' +          // front
      '<path d="M40 16 L56 8 L56 32 L40 40"/>' +         // side
      '</g>' + (inner || "") +
      '<g fill="#4a4c4f">' +                              // ball nodes
      '<circle cx="8" cy="16" r="2.4"/><circle cx="40" cy="16" r="2.4"/>' +
      '<circle cx="56" cy="8" r="2.4"/><circle cx="24" cy="8" r="2.4"/>' +
      '<circle cx="8" cy="40" r="2.4"/><circle cx="40" cy="40" r="2.4"/>' +
      '<circle cx="56" cy="32" r="2.4"/>' +
      '</g></svg>'
    );
  }
  var ICON = {
    open: frame(""),
    back: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#b9c4d6" opacity="0.9"/>'),
    shelf: frame('<path d="M8 28 L40 28 L52 21 L20 21 Z" fill="#cfd2d6" opacity="0.95"/>'),
    divider: frame('<path d="M24 12 L24 38 L36 31 L36 5 Z" fill="#cfd2d6" opacity="0.6"/>'),
    door: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#c9cdd2"/><path d="M8 40 L40 40 L46 46 L14 46 Z" fill="#dfe1e4"/>'),
  };

  function chrome() {
    return (
      '<svg viewBox="0 0 64 48"><g stroke="#6e7073" stroke-width="3" stroke-linecap="round" fill="none">' +
      '<path d="M32 24 L14 14"/><path d="M32 24 L50 14"/><path d="M32 24 L32 44"/></g>' +
      '<circle cx="32" cy="24" r="6" fill="#5a5c5f"/></svg>'
    );
  }

  // -- state -----------------------------------------------------------------
  var state = {
    base: null,                 // selected preset id (or null for custom)
    width: 750, depth: 350,
    cols: 2, rows: 1,
    back_panels: true, shelves: false, dividers: false, door: false,
    color: "USM Matte Silver",
  };
  var cfg = { colors: {}, presets: [], defaults: {}, version: "" };

  var BASES = [
    { id: null, cap: "Open", icon: ICON.open },
    { id: "usm-sideboard", cap: "Sideboard", icon: ICON.back },
    { id: "usm-bookshelf", cap: "Bookshelf", icon: ICON.shelf },
    { id: "usm-credenza", cap: "Credenza", icon: ICON.divider },
  ];
  var COMPONENTS = [
    { key: "back_panels", cap: "Back", icon: ICON.back },
    { key: "shelves", cap: "Shelf", icon: ICON.shelf },
    { key: "dividers", cap: "Divider", icon: ICON.divider },
    { key: "door", cap: "Drop door", icon: ICON.door },
  ];
  var WIDTHS = [250, 350, 500, 750, 1000];
  var DEPTHS = [350, 500];

  // -- helpers ---------------------------------------------------------------
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function sendData(action, payload) {
    try { adsk.fusionSendData(action, JSON.stringify(payload || {})); } catch (e) {}
  }
  function byId(id) { return document.getElementById(id); }

  // -- render ----------------------------------------------------------------
  function renderBase() {
    var host = byId("base"); host.innerHTML = "";
    BASES.forEach(function (b) {
      var t = el("div", "tile" + (state.base === b.id ? " selected" : ""), b.icon + '<div class="cap">' + b.cap + "</div>");
      t.onclick = function () { applyBase(b.id); };
      host.appendChild(t);
    });
    // chrome connector decoration tile to echo the reference (informational)
    var info = el("div", "tile", chrome() + '<div class="cap">Frame</div>');
    info.style.cursor = "default";
    host.appendChild(info);
  }
  function renderChips(hostId, values, field, suffix) {
    var host = byId(hostId); host.innerHTML = "";
    values.forEach(function (v) {
      var c = el("div", "chip" + (state[field] === v ? " selected" : ""), v + (suffix || ""));
      c.onclick = function () { state[field] = v; state.base = null; renderAll(); };
      host.appendChild(c);
    });
  }
  function renderComponents() {
    var host = byId("components"); host.innerHTML = "";
    COMPONENTS.forEach(function (c) {
      var t = el("div", "tile" + (state[c.key] ? " selected" : ""), c.icon + '<div class="cap">' + c.cap + "</div>");
      t.onclick = function () { state[c.key] = !state[c.key]; state.base = null; renderComponents(); estimate(); };
      host.appendChild(t);
    });
  }
  function renderColors() {
    var host = byId("colors"); host.innerHTML = "";
    Object.keys(cfg.colors).forEach(function (name) {
      var rgb = cfg.colors[name];
      var s = el("div", "swatch" + (state.color === name ? " selected" : ""));
      s.style.background = "rgb(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + ")";
      s.title = name;
      s.onclick = function () { state.color = name; renderColors(); };
      host.appendChild(s);
    });
  }
  function renderSteppers() {
    byId("cols").textContent = state.cols;
    byId("rows").textContent = state.rows;
  }
  function renderAll() {
    renderBase(); renderComponents(); renderColors(); renderSteppers();
    renderChips("widths", WIDTHS, "width", "");
    renderChips("depths", DEPTHS, "depth", "");
    estimate();
  }

  function applyBase(id) {
    state.base = id;
    if (id) {
      var p = cfg.presets.filter(function (e) { return e.id === id; })[0];
      if (p) {
        state.cols = (p.columns || [state.width]).length;
        state.rows = (p.rows || [350]).length;
        state.width = (p.columns && p.columns[0]) || state.width;
        state.depth = (p.depths && p.depths[0]) || state.depth;
        state.back_panels = !!p.back_panels;
        state.shelves = !!p.shelves;
        state.dividers = !!p.dividers;
        if (p.color) state.color = p.color;
      }
    }
    renderAll();
  }

  // Local mirror of the engine's counts so the BOM updates live before Build.
  function estimate() {
    var nx = state.cols + 1, ny = 2, nz = state.rows + 1;
    var balls = nx * ny * nz;
    var tubes = nz * ny * (nx - 1) + nz * (ny - 1) * nx + (nz - 1) * ny * nx;
    var w = state.cols * state.width, h = state.rows * 350, d = state.depth;
    byId("bom").textContent =
      w + " x " + d + " x " + h + " mm  ·  " + balls + " balls · " + tubes + " tubes";
  }

  function buildConfig() {
    return {
      columns: Array.apply(null, { length: state.cols }).map(function () { return state.width; }),
      rows: Array.apply(null, { length: state.rows }).map(function () { return 350; }),
      depths: [state.depth],
      options: {
        back_panels: state.back_panels,
        shelves: state.shelves,
        dividers: state.dividers,
        door: state.door,
        color: state.color,
      },
    };
  }

  // -- wire up ---------------------------------------------------------------
  function init() {
    document.querySelectorAll("[data-step]").forEach(function (b) {
      b.onclick = function () {
        var f = b.getAttribute("data-step"), d = parseInt(b.getAttribute("data-d"), 10);
        state[f] = Math.max(1, Math.min(16, state[f] + d));
        state.base = null;
        renderSteppers(); estimate();
      };
    });
    byId("build").onclick = function () { sendData("build", buildConfig()); };
    byId("clear").onclick = function () { sendData("clear", {}); };
    sendData("ready", {});
  }

  window.fusionJavaScriptHandler = {
    handle: function (action, data) {
      try {
        var d = data ? JSON.parse(data) : {};
        if (action === "config") {
          cfg = d;
          if (d.colors && Object.keys(d.colors).length) state.color = Object.keys(d.colors)[0];
          byId("ver").textContent = "v" + (d.version || "");
          renderAll();
        } else if (action === "result") {
          byId("bom").textContent = d.text || "";
        }
      } catch (e) {}
      return "OK";
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
