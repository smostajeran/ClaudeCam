/*
 * USM Haller configurator palette.
 * Builds a Path P configuration (column widths / row heights / depth / per-cell
 * content) and sends it to Fusion, which calls the usm-engine /api/build and
 * renders the returned payload. Bridge: adsk.fusionSendData / fusionJavaScriptHandler.
 */
(function () {
  "use strict";

  function frame(inner) {
    return (
      '<svg viewBox="0 0 64 48">' +
      '<g fill="none" stroke="#8a8c8f" stroke-width="2" stroke-linejoin="round">' +
      '<path d="M8 16 L40 16 L56 8 L24 8 Z"/>' +
      '<path d="M8 16 L8 40 L40 40 L40 16"/>' +
      '<path d="M40 16 L56 8 L56 32 L40 40"/></g>' + (inner || "") +
      '<g fill="#4a4c4f"><circle cx="8" cy="16" r="2.4"/><circle cx="40" cy="16" r="2.4"/>' +
      '<circle cx="56" cy="8" r="2.4"/><circle cx="24" cy="8" r="2.4"/>' +
      '<circle cx="8" cy="40" r="2.4"/><circle cx="40" cy="40" r="2.4"/>' +
      '<circle cx="56" cy="32" r="2.4"/></g></svg>'
    );
  }
  var CELL_ICON = {
    open: frame(""),
    closed: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#cfd2d6"/>'),
    shelf: frame('<path d="M8 28 L40 28 L52 21 L20 21 Z" fill="#cfd2d6" opacity="0.95"/>'),
    pullout: frame('<path d="M8 30 L40 30 L52 23 L20 23 Z" fill="#dfe1e4"/><path d="M20 36 L40 36" stroke="#8a8c8f" stroke-width="2"/>'),
    door: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#c9cdd2"/><path d="M8 40 L40 40 L46 46 L14 46 Z" fill="#dfe1e4"/>'),
    glass: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#bcd6e6" opacity="0.5"/>'),
    panel: frame('<path d="M8 16 L40 16 L40 40 L8 40 Z" fill="#b9c4d6" opacity="0.9"/>'),
  };

  var state = {
    width: 750, height: 350, depth: 350, cols: 2, rows: 1,
    cell: "closed", color: "USM Matte Silver",
  };
  var catalogParts = [];
  var cfg = { colors: {}, widths: [], depths: [], cellTypes: [], engineUrl: "", version: "" };

  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function byId(id) { return document.getElementById(id); }
  function sendData(action, payload) { try { adsk.fusionSendData(action, JSON.stringify(payload || {})); } catch (e) {} }

  function renderChips(hostId, values, field) {
    var host = byId(hostId); host.innerHTML = "";
    values.forEach(function (v) {
      var c = el("div", "chip" + (state[field] === v ? " selected" : ""), String(v));
      c.onclick = function () { state[field] = v; renderChips(hostId, values, field); };
      host.appendChild(c);
    });
  }
  function renderCells() {
    var host = byId("cells"); host.innerHTML = "";
    cfg.cellTypes.forEach(function (t) {
      var icon = CELL_ICON[t.id] || CELL_ICON.closed;
      var tile = el("div", "tile" + (state.cell === t.id ? " selected" : ""), icon + '<div class="cap">' + t.name + "</div>");
      tile.onclick = function () { state.cell = t.id; renderCells(); };
      host.appendChild(tile);
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
  function renderCatalog() {
    var host = byId("catalog"); host.innerHTML = "";
    var q = (byId("catFilter").value || "").trim().toLowerCase();
    var groups = {};
    catalogParts.forEach(function (p) {
      if (q && (p.label + " " + p.part + " " + p.family).toLowerCase().indexOf(q) < 0) return;
      (groups[p.family] = groups[p.family] || []).push(p);
    });
    var fams = Object.keys(groups).sort();
    if (!fams.length) { host.appendChild(el("div", "muted", catalogParts.length ? "No matches." : "")); return; }
    fams.forEach(function (fam) {
      host.appendChild(el("div", "catgroup", fam + " (" + groups[fam].length + ")"));
      groups[fam].forEach(function (p) {
        var dims = (p.dims && p.dims.length) ? " · " + p.dims.join("×") + " mm" : "";
        var row = el("div", "catrow", "<span>" + p.label + "</span><span class='catid'>" + p.part + dims + "</span>");
        row.title = "Click to place in Fusion";
        row.onclick = function () {
          setStatus("Placing " + p.label + "…");
          sendData("place_part", { part: p.part, family: p.family, dims: p.dims, render: { color: state.color } });
        };
        host.appendChild(row);
      });
    });
  }

  function renderSteppers() { byId("cols").textContent = state.cols; byId("rows").textContent = state.rows; }
  function renderAll() {
    renderChips("widths", cfg.widths, "width");
    renderChips("heights", cfg.widths, "height");
    renderChips("depths", cfg.depths, "depth");
    renderCells(); renderColors(); renderSteppers();
  }

  function pathP() {
    var cols = [], rows = [], cells = [];
    for (var i = 0; i < state.cols; i++) cols.push(state.width);
    for (var j = 0; j < state.rows; j++) rows.push(state.height);
    for (var c = 0; c < state.cols; c++) for (var r = 0; r < state.rows; r++) cells.push({ col: c, row: r, type: state.cell });
    return { columnWidths: cols, rowHeights: rows, depth: state.depth, cells: cells };
  }

  function setStatus(text, level) {
    var b = byId("bom");
    b.textContent = text;
    b.className = "bom" + (level === "error" ? " err" : level === "ok" ? " ok" : "");
  }

  function init() {
    document.querySelectorAll("[data-step]").forEach(function (b) {
      b.onclick = function () {
        var f = b.getAttribute("data-step"), d = parseInt(b.getAttribute("data-d"), 10);
        state[f] = Math.max(1, Math.min(16, state[f] + d));
        renderSteppers();
      };
    });
    byId("gear").onclick = function () { byId("settings").classList.toggle("hidden"); };
    byId("saveSettings").onclick = function () {
      sendData("save_settings", {
        engine_url: byId("engineUrl").value,
        engine_user: byId("engineUser").value,
        engine_password: byId("enginePassword").value,
      });
    };
    byId("checkEngine").onclick = function () { setStatus("Checking engine…"); sendData("check_engine", {}); };
    byId("loadCatalog").onclick = function () { setStatus("Loading catalogue…"); sendData("load_catalog", {}); };
    byId("catFilter").oninput = renderCatalog;
    byId("build").onclick = function () {
      setStatus("Building via engine…");
      sendData("build", { path_p: pathP(), render: { color: state.color } });
    };
    byId("clear").onclick = function () { setStatus("Clearing…"); sendData("clear", {}); };
    sendData("ready", {});
  }

  window.fusionJavaScriptHandler = {
    handle: function (action, data) {
      try {
        var d = data ? JSON.parse(data) : {};
        if (action === "config") {
          cfg = d;
          if (d.colors && Object.keys(d.colors).length && !cfg.colors[state.color]) state.color = Object.keys(d.colors)[0];
          if (d.widths && d.widths.indexOf(state.width) < 0) state.width = d.widths[d.widths.length - 1];
          if (d.depths && d.depths.indexOf(state.depth) < 0) state.depth = d.depths[0];
          byId("engineUrl").value = d.engineUrl || "";
          byId("engineUser").value = d.engineUser || "";
          byId("ver").textContent = "v" + (d.version || "");
          renderAll();
        } else if (action === "result") {
          setStatus(d.text || "", d.level);
        } else if (action === "catalog") {
          catalogParts = d.parts || [];
          byId("catFilter").classList.toggle("hidden", catalogParts.length === 0);
          renderCatalog();
        }
      } catch (e) {}
      return "OK";
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
