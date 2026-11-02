/* eslint-disable no-undef, no-restricted-globals */
/**
 * Academic Lens — Settings Window Controller
 * Loaded as chrome://academic-lens/content/settings.js in settings.xhtml
 */

var { Zotero } = (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule)
  ? ChromeUtils.importESModule("chrome://zotero/content/zotero.mjs")
  : { Zotero: window.opener?.Zotero || window.Zotero };

(function () {
  "use strict";

  var _saveTimer = null;

  function al() {
    return Zotero?.AcademicLens || window.opener?.Zotero?.AcademicLens;
  }

  function el(id) {
    return document.getElementById(id);
  }

  function val(id) {
    var e = el(id);
    return e ? e.value : "";
  }

  function setVal(id, v) {
    var e = el(id);
    if (e) e.value = v;
  }

  function status(id, cls, msg) {
    var e = el(id);
    if (!e) return;
    e.className = "al-status" + (cls ? " " + cls : "");
    e.textContent = msg || "";
  }

  function syncTokenDisplay(v) {
    var d = el("s-tokens-display");
    if (d) d.textContent = String(v);
  }

  function validateEndpoint(v) {
    var trimmed = (v || "").trim();
    var ok = /^https?:\/\/.+/.test(trimmed);
    var inp = el("s-endpoint");
    if (inp) {
      inp.classList.toggle("valid", ok);
      inp.classList.toggle("invalid", trimmed.length > 0 && !ok);
    }
    var st = el("s-endpoint-status");
    if (st) {
      if (trimmed.length > 0 && !ok) {
        status("s-endpoint-status", "warn", "URL must start with http:// or https://");
      } else if (ok && (st.className.includes("warn") || st.className.includes("error"))) {
        status("s-endpoint-status", "", "");
      }
    }
    return ok || trimmed.length === 0;
  }

  function populate() {
    var a = al();
    if (!a) {
      status("s-save-status", "error", "Could not connect to Academic Lens service.");
      return;
    }
    setVal("s-endpoint", a.endpoint || a.DEFAULT_ENDPOINT || "http://77.42.92.200:18181/");
    setVal("s-model", a.modelName || a.DEFAULT_MODEL || "Llama-3.2-3B-Instruct-Q4_K_M");
    var tok = a.maxTokens || a.DEFAULT_MAX_TOKENS || 800;
    setVal("s-tokens-range", tok);
    setVal("s-tokens-num", tok);
    syncTokenDisplay(tok);
    validateEndpoint(val("s-endpoint"));
  }

  async function testEndpoint() {
    var ep = val("s-endpoint").trim().replace(/\/+$/, "");
    var btn = el("s-test-btn");
    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      status("s-endpoint-status", "error", "Please enter a valid URL first.");
      return;
    }
    status("s-endpoint-status", "info", "Connecting…");
    if (btn) { btn.textContent = "…"; btn.disabled = true; }

    try {
      var r = await fetch(ep + "/v1/models", { method: "GET" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var json = await r.json();
      var count = (json && json.data) ? json.data.length : 0;
      status("s-endpoint-status", "success",
        "✓ Connected — " + count + " model" + (count !== 1 ? "s" : "") + " available");
    } catch (e) {
      status("s-endpoint-status", "error", "✗ Unreachable: " + e.message);
    } finally {
      if (btn) { btn.textContent = "⚡ Test"; btn.disabled = false; }
    }
  }

  async function fetchModels() {
    var ep = val("s-endpoint").trim().replace(/\/+$/, "");
    var listEl = el("s-model-list");
    var btn = el("s-fetch-btn");

    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      if (listEl) {
        listEl.innerHTML = '<div class="al-status error">Please enter a valid endpoint URL first.</div>';
      }
      return;
    }

    if (btn) { btn.textContent = "…"; btn.disabled = true; }
    if (listEl) {
      listEl.innerHTML = '<div class="al-status info">Fetching models…</div>';
    }

    try {
      var r = await fetch(ep + "/v1/models", { method: "GET" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      var json = await r.json();
      var models = ((json && json.data) || []).map(function(m) { return m.id; }).filter(Boolean);

      listEl.innerHTML = "";
      if (models.length === 0) {
        listEl.innerHTML = '<div class="al-status warn">⚠ No models returned by the endpoint.</div>';
        return;
      }

      var current = val("s-model");
      models.forEach(function(id) {
        var item = document.createElement("div");
        item.className = "al-model-item" + (id === current ? " selected" : "");
        item.innerHTML =
          '<span class="al-model-dot"></span>' +
          '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + id + '</span>';
        item.addEventListener("click", function() {
          listEl.querySelectorAll(".al-model-item").forEach(function(i) {
            i.classList.remove("selected");
          });
          item.classList.add("selected");
          setVal("s-model", id);
          var minp = el("s-model");
          if (minp) { minp.classList.remove("invalid"); minp.classList.add("valid"); }
          status("s-model-status", "", "");
        });
        listEl.appendChild(item);
      });
    } catch (e) {
      listEl.innerHTML = '<div class="al-status error">✗ Could not fetch models: ' + e.message + '</div>';
    } finally {
      if (btn) { btn.textContent = "↻ Fetch from endpoint"; btn.disabled = false; }
    }
  }

  function save() {
    var a = al();
    if (!a) {
      status("s-save-status", "error", "Addon service not found.");
      return;
    }

    var newEp = val("s-endpoint").trim();
    var newModel = val("s-model").trim();
    var rawTok = parseInt(val("s-tokens-num") || val("s-tokens-range"), 10);
    var newTok = Math.min(8000, Math.max(100, isNaN(rawTok) ? 800 : rawTok));

    if (!newEp || !/^https?:\/\/.+/.test(newEp)) {
      status("s-save-status", "error", "⚠ Endpoint URL is invalid.");
      return;
    }
    if (!newModel) {
      status("s-save-status", "error", "⚠ Model name cannot be empty.");
      return;
    }

    a.endpoint = newEp;
    a.modelName = newModel;
    a.maxTokens = newTok;
    a.saveSettings();

    // Trigger dynamic sidebar update and endpoint status re-check
    try {
      if (typeof a.updateAllSidebars === "function") {
        a.updateAllSidebars();
      }
    } catch (_) {}

    status("s-save-status", "success", "✓ Settings saved!");
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(function() {
      status("s-save-status", "", "");
      _saveTimer = null;
    }, 3000);
  }

  function reset() {
    var a = al();
    if (!a) return;
    var defEp = a.DEFAULT_ENDPOINT || "http://77.42.92.200:18181/";
    var defModel = a.DEFAULT_MODEL || "Llama-3.2-3B-Instruct-Q4_K_M";
    var defTok = a.DEFAULT_MAX_TOKENS || 800;

    setVal("s-endpoint", defEp);
    setVal("s-model", defModel);
    setVal("s-tokens-range", defTok);
    setVal("s-tokens-num", defTok);
    syncTokenDisplay(defTok);

    ["s-endpoint", "s-model"].forEach(function(id) {
      var e = el(id);
      if (e) e.classList.remove("valid", "invalid");
    });
    ["s-endpoint-status", "s-model-status", "s-tokens-status"].forEach(function(id) {
      status(id, "", "");
    });

    a.endpoint = defEp;
    a.modelName = defModel;
    a.maxTokens = defTok;
    a.saveSettings();

    try {
      if (typeof a.updateAllSidebars === "function") {
        a.updateAllSidebars();
      }
    } catch (_) {}

    status("s-save-status", "info", "Reset to defaults and applied.");
  }

  window.addEventListener("load", function () {
    populate();

    el("s-endpoint")?.addEventListener("input", function () {
      validateEndpoint(this.value);
    });

    el("s-model")?.addEventListener("input", function () {
      var v = this.value.trim();
      this.classList.toggle("invalid", v.length === 0);
      this.classList.toggle("valid", v.length > 0);
      status("s-model-status", v.length === 0 ? "error" : "", v.length === 0 ? "Model name cannot be empty." : "");
    });

    el("s-tokens-range")?.addEventListener("input", function () {
      var v = parseInt(this.value, 10);
      if (!isNaN(v)) {
        setVal("s-tokens-num", v);
        syncTokenDisplay(v);
      }
    });

    el("s-tokens-num")?.addEventListener("input", function () {
      var raw = parseInt(this.value, 10);
      var v = Math.min(8000, Math.max(100, raw || 100));
      setVal("s-tokens-range", v);
      syncTokenDisplay(v);
      if (isNaN(raw) || raw < 100) {
        status("s-tokens-status", "warn", "Minimum is 100 tokens.");
      } else if (raw > 8000) {
        status("s-tokens-status", "warn", "Maximum is 8000 tokens.");
      } else {
        status("s-tokens-status", "", "");
      }
    });

    el("s-test-btn")?.addEventListener("click", testEndpoint);
    el("s-fetch-btn")?.addEventListener("click", fetchModels);
    el("s-save-btn")?.addEventListener("click", save);
    el("s-reset-btn")?.addEventListener("click", reset);

    window.addEventListener("keydown", function (e) {
      if (e.key === "Escape" || ((e.metaKey || e.ctrlKey) && e.key === "w")) {
        window.close();
      }
    });
  }, { once: true });
})();
