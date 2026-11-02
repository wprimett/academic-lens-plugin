/**
 * Academic Lens - Zotero 7 Addon
 * Local AI Research Assistant powered by Qwen.
 *
 * Key implementation note (XUL namespace pitfall):
 *   Zotero's item pane is a XUL <vbox>. If you call vbox.innerHTML = "...",
 *   Gecko parses child elements into the XUL namespace where <div> / <button>
 *   have no HTML layout, so flex/height rules are silently ignored and you see
 *   only native widgets (e.g. <textarea>). The fix (same as Beaver's ui.ts:78):
 *     1. createXULElement("vbox") — outer shell lives in XUL layout
 *     2. createElement("div")    — HTML namespace div, append to vbox
 *     3. set innerHTML on the HTML div → all children parse as HTML
 */

/* eslint-disable no-undef */

if (typeof Zotero === "undefined") {
  Zotero = Components.classes["@zotero.org/Zotero;1"].getService(
    Components.interfaces.nsISupports
  ).wrappedJSObject;
}

Zotero.AcademicLens = {
  // Configuration
  DEFAULT_ENDPOINT: "http://127.0.0.1:8080/",
  DEFAULT_MODEL: "Llama-3.2-3B-Instruct-Q4_K_M",
  FALLBACK_MODEL: "Qwen3.5-4B-Q4_K_S",
  DEFAULT_MAX_TOKENS: 800,
  DEFAULT_MAX_CONTEXT_CHARS: 3200,

  endpoint: "http://127.0.0.1:8080/",
  modelName: "Llama-3.2-3B-Instruct-Q4_K_M",
  maxTokens: 800,
  abstractOnly: false,

  // State
  rootURI: null,
  windows: new Map(),      // win → { isOpen: boolean, isMaximized: boolean }
  selectedDocuments: [],   // [{ id, title, authors, year, abstract, url, display, hasPdf, isExtracting, fullText, txtPath }]
  chatHistory: [],         // [{ role, content }]
  abortController: null,
  isGenerating: false,
  stylesheetRegistered: false,
  connectionEnabled: true,
  _prefObservers: [],
  _settingsWindow: null,

  /* ============================================================
     Lifecycle
  ============================================================ */

  async onStartup({ id, version, rootURI }) {
    this.rootURI = rootURI;
    this.loadSettings();
    this.registerGlobalStylesheet();
    this.registerPreferencesPane(id, rootURI);
    this.registerTabObserver();
    this.registerPrefObservers();
    Zotero.debug("[AcademicLens] Addon started. Endpoint: " + this.endpoint);
  },

  async onShutdown() {
    this.unregisterPrefObservers();
    this.unregisterTabObserver();
    this.unregisterGlobalStylesheet();
    for (const [win] of this.windows) {
      this.cleanupWindow(win);
    }
    this.windows.clear();
    Zotero.debug("[AcademicLens] Addon shut down.");
  },

  registerGlobalStylesheet() {
    try {
      const ssService = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const styleURI = Services.io.newURI("chrome://academic-lens/content/style.css");
      if (!ssService.sheetRegistered(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET)) {
        ssService.loadAndRegisterSheet(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET);
        this.stylesheetRegistered = true;
        Zotero.debug("[AcademicLens] Registered global stylesheet via nsIStyleSheetService");
      }
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to register global stylesheet: " + err);
    }
  },

  unregisterGlobalStylesheet() {
    if (!this.stylesheetRegistered) return;
    try {
      const ssService = Components.classes["@mozilla.org/content/style-sheet-service;1"]
        .getService(Components.interfaces.nsIStyleSheetService);
      const styleURI = Services.io.newURI("chrome://academic-lens/content/style.css");
      if (ssService.sheetRegistered(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET)) {
        ssService.unregisterSheet(styleURI, Components.interfaces.nsIStyleSheetService.AUTHOR_SHEET);
      }
      this.stylesheetRegistered = false;
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to unregister stylesheet: " + err);
    }
  },

  async onMainWindowLoad(win) {
    if (!win || win.closed || !win.document) return;

    try {
      if (Zotero.initializationPromise) await Zotero.initializationPromise;
      if (Zotero.unlockPromise)         await Zotero.unlockPromise;
      if (Zotero.uiReadyPromise)        await Zotero.uiReadyPromise;
    } catch (e) {
      Zotero.debug("[AcademicLens] Promise wait warning: " + e);
    }

    if (win.document.readyState === "loading") {
      win.addEventListener("DOMContentLoaded", () => this.initWindowWithRetry(win), { once: true });
      win.addEventListener("load",             () => this.initWindowWithRetry(win), { once: true });
    } else {
      await this.initWindowWithRetry(win);
    }
  },

  async initWindowWithRetry(win, retries = 30) {
    if (!win || win.closed || !win.document) return;

    const toolbar     = win.document.getElementById("zotero-tabs-toolbar");
    const itemPane    = win.document.getElementById("zotero-item-pane");
    const contextPane = win.document.getElementById("zotero-context-pane");

    if ((!toolbar || (!itemPane && !contextPane)) && retries > 0) {
      win.setTimeout(() => this.initWindowWithRetry(win, retries - 1), 200);
      return;
    }

    this.initWindowUI(win);
  },

  initWindowUI(win) {
    if (this.windows.has(win)) return;
    this.windows.set(win, { isOpen: false, isMaximized: false });

    Zotero.debug("[AcademicLens] Initializing window UI...");

    const step = (name, fn) => {
      try { fn(); }
      catch (err) {
        Zotero.debug(`[AcademicLens] ${name} FAILED: ${err}\n${err && err.stack}`);
        Zotero.logError(err);
      }
    };

    step("addToolbarButton",    () => this.addToolbarButton(win));
    step("addToolsMenuItem",    () => this.addToolsMenuItem(win));
    step("addContextMenuItems", () => this.addContextMenuItems(win));
    step("setupSidebar",        () => this.setupSidebar(win));

    // Open automatically so user sees the panel right away
    step("toggleSidebar",       () => this.toggleSidebar(win, true));
    // Zotero may restore a persisted collapsed item pane after load; re-open once settled
    win.setTimeout(() => step("toggleSidebar(delayed)", () => this.toggleSidebar(win, true)), 1500);
  },

  async onMainWindowUnload(win) {
    this.cleanupWindow(win);
    this.windows.delete(win);
  },

  cleanupWindow(win) {
    if (!win || !win.document) return;
    try {
      this.applyMaximizeState(win, false);
      this.unobserveItemPane(win);
      win.document.getElementById("zotero-academic-lens-tb-toggle")?.remove();
      win.document.getElementById("menu-academic-lens")?.remove();
      win.document.getElementById("menu-academic-lens-prefs")?.remove();
      win.document.getElementById("context-academic-lens-add")?.remove();
      win.document.getElementById("academic-lens-pane-library")?.remove();
      win.document.getElementById("academic-lens-pane-reader")?.remove();

      // Restore native item-pane children
      const itemPane = win.document.getElementById("zotero-item-pane");
      if (itemPane) {
        for (const child of itemPane.children) {
          if (child.id !== "academic-lens-pane-library") {
            child.style.removeProperty("display");
          }
        }
      }

      const contextPane = win.document.getElementById("zotero-context-pane");
      if (contextPane) {
        for (const child of contextPane.children) {
          if (child.id !== "academic-lens-pane-reader") {
            child.style.removeProperty("display");
          }
        }
      }
    } catch (err) {
      Zotero.debug("[AcademicLens] Error during window cleanup: " + err);
    }
  },

  observeItemPane(win) {
    if (this._itemPaneObservers?.has(win)) return;
    if (!this._itemPaneObservers) this._itemPaneObservers = new Map();

    const domItemPane = win.document.getElementById("zotero-item-pane");
    if (!domItemPane) return;

    try {
      const observer = new win.MutationObserver(() => {
        const winState = this.windows.get(win);
        if (!winState || !winState.isOpen) return;

        const alPane = win.document.getElementById("academic-lens-pane-library");
        if (!alPane || alPane.style.display === "none") return;

        for (const child of domItemPane.children) {
          if (child !== alPane && child.style.display !== "none") {
            child.style.display = "none";
          }
        }

        if (domItemPane.collapsed) {
          domItemPane.collapsed = false;
          domItemPane.removeAttribute("collapsed");
        }
      });

      observer.observe(domItemPane, { childList: true, subtree: false });
      this._itemPaneObservers.set(win, observer);
    } catch (_) {}
  },

  unobserveItemPane(win) {
    const obs = this._itemPaneObservers?.get(win);
    if (obs) {
      obs.disconnect();
      this._itemPaneObservers.delete(win);
    }
  },

  /* ============================================================
     UI Injection
  ============================================================ */

  addToolbarButton(win) {
    const toolbar = win.document.getElementById("zotero-tabs-toolbar");
    if (!toolbar) return;
    if (win.document.getElementById("zotero-academic-lens-tb-toggle")) return;

    const btn = win.document.createXULElement("toolbarbutton");
    btn.setAttribute("id", "zotero-academic-lens-tb-toggle");
    btn.setAttribute("class", "zotero-tb-button");
    btn.setAttribute("tooltiptext", "Toggle Academic Lens");
    btn.setAttribute("aria-label", "Toggle Academic Lens");
    btn.setAttribute("aria-pressed", "false");
    btn.setAttribute("tabindex", "0");
    // XUL toolbarbutton list-style-image picks up the icon in most themes
    btn.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    btn.style.listStyleImage = "url('chrome://academic-lens/content/icons/icon.png')";

    // Explicit <image> child guarantees the icon renders even when CSS is absent
    const img = win.document.createXULElement("image");
    img.setAttribute("src", "chrome://academic-lens/content/icons/icon.png");
    img.setAttribute("width", "18");
    img.setAttribute("height", "18");
    btn.appendChild(img);

    btn.addEventListener("command", () => this.toggleSidebar(win));

    const syncBtn = toolbar.querySelector("#zotero-tb-sync");
    if (syncBtn) {
      toolbar.insertBefore(btn, syncBtn);
    } else {
      toolbar.appendChild(btn);
    }

    Zotero.debug("[AcademicLens] Toolbar button injected.");
  },

  addToolsMenuItem(win) {
    const toolsPopup = win.document.getElementById("menu_ToolsPopup");
    if (!toolsPopup || win.document.getElementById("menu-academic-lens")) return;

    const mi = win.document.createXULElement("menuitem");
    mi.setAttribute("id", "menu-academic-lens");
    mi.setAttribute("label", "Academic Lens");
    mi.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    mi.setAttribute("class", "menuitem-iconic");
    mi.addEventListener("command", () => this.toggleSidebar(win));
    toolsPopup.appendChild(mi);

    const miPrefs = win.document.createXULElement("menuitem");
    miPrefs.setAttribute("id", "menu-academic-lens-prefs");
    miPrefs.setAttribute("label", "Academic Lens Settings…");
    miPrefs.setAttribute("class", "menuitem-iconic");
    miPrefs.addEventListener("command", () => this.openSettingsWindow(win));
    toolsPopup.appendChild(miPrefs);
  },

  addContextMenuItems(win) {
    const itemMenu = win.document.getElementById("zotero-itemmenu");
    if (!itemMenu || win.document.getElementById("context-academic-lens-add")) return;

    const mi = win.document.createXULElement("menuitem");
    mi.setAttribute("id", "context-academic-lens-add");
    mi.setAttribute("label", "Ask Academic Lens About Selected Item(s)");
    mi.setAttribute("image", "chrome://academic-lens/content/icons/icon.png");
    mi.setAttribute("class", "menuitem-iconic");
    mi.addEventListener("command", async () => {
      const selected = win.ZoteroPane?.getSelectedItems();
      if (selected && selected.length > 0) {
        await this.addItems(selected, win);
        this.toggleSidebar(win, true);
      }
    });
    itemMenu.appendChild(mi);
  },

  /*
   * setupSidebar — the critical rendering fix
   *
   * Beaver pattern (ui.ts lines 68-84):
   *   const mountPoint = doc.createXULElement("vbox");   ← XUL shell
   *   const reactContainer = doc.createElement("div");   ← HTML namespace
   *   mountPoint.appendChild(reactContainer);
   *   // React then writes into reactContainer, which is in HTML namespace.
   *
   * We follow the same pattern: XUL <vbox> holds an HTML <div>, all the
   * sidebar HTML goes into that div so Gecko parses it in the HTML namespace
   * and applies normal flex box / block layout.
   */
  getMaximizeIcon(isMaximized = false) {
    // return isMaximized ? "⤡ Restore" : "⤢ Maximise";
    return isMaximized ? "⤡" : "⤢";
  },

  getSidebarHTML() {
    return `
      <div class="al-header" style="display:flex;align-items:center;justify-content:space-between;padding:10px 14px;background:#22222a;border-bottom:1px solid #33333f;flex-shrink:0;">
        <div class="al-title-area" style="display:flex;align-items:center;gap:8px;min-width:0;">
          <img class="al-logo" src="chrome://academic-lens/content/icons/icon.png" alt="Logo" />
          <h3 class="al-title" style="margin:0;white-space:nowrap;">Academic Lens</h3>
        </div>
        <div class="al-header-actions" style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          <span id="al-btn-maximize" class="al-header-btn" role="button" tabindex="0" title="Maximise Panel" aria-label="Maximise Panel" aria-pressed="false"
            style="display:inline-flex;align-items:center;justify-content:center;gap:4px;height:26px;min-height:26px;padding:0 10px;background:#282834;border:1px solid #6c5ce7;border-radius:6px;color:#e0e0f0;font-size:11.5px;font-weight:600;cursor:pointer;user-select:none;line-height:1;white-space:nowrap;flex-shrink:0;box-sizing:border-box;">${this.getMaximizeIcon(false)}</span>
          <span id="al-btn-close" class="al-header-btn" role="button" tabindex="0" title="Close Sidebar" aria-label="Close"
            style="display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;min-width:26px;min-height:26px;padding:0;background:#282834;border:1px solid #4a4a5e;border-radius:6px;color:#e0e0f0;font-size:14px;font-weight:bold;cursor:pointer;user-select:none;line-height:1;flex-shrink:0;box-sizing:border-box;">✕</span>
        </div>
      </div>

      <!-- ── Inline Model and Endpoint Configuration Bar ── -->
      <div class="al-config-bar" id="al-config-bar">
        <div class="al-config-header">
          <div class="al-config-title">
            <span class="al-status-dot checking" id="al-cfg-status-dot" title="Checking status…"></span>
            <span>Endpoint Status:</span>
            <span class="al-cfg-status-text checking" id="al-cfg-status-text">Checking…</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <button class="al-btn-toggle-conn disconnect" id="al-btn-toggle-conn" title="Toggle connection status">Disconnect</button>
            <button class="al-btn al-btn-secondary al-btn-xs" id="al-btn-cfg-test" title="Test endpoint &amp; model">Test</button>
          </div>
        </div>

        <div class="al-config-fields">
          <div class="al-config-row">
            <input type="text" class="al-config-input" id="al-input-model"
                   value="${this.escapeHtml(this.modelName)}"
                   placeholder="Model (e.g. Llama-3.2-3B-Instruct-Q4_K_M)"
                   title="Model name matching /v1/models" />
            <select class="al-config-select" id="al-select-model" style="display:none;" title="Select available model from endpoint">
              <option value="">Select model…</option>
            </select>
          </div>
          <div class="al-config-row">
            <input type="text" class="al-config-input" id="al-input-endpoint"
                   value="${this.escapeHtml(this.endpoint)}"
                   placeholder="Endpoint (e.g. http://127.0.0.1:8080/)"
                   title="OpenAI-compatible server URL" />
          </div>
        </div>

        <div class="al-config-status-row">
          <span class="al-conn-badge checking" id="al-cfg-conn-badge">Checking connection…</span>
          <button class="al-config-toggle" id="al-btn-fetch-models" title="Refresh list of models hosted on endpoint">↻ Fetch Models</button>
        </div>

        <div class="al-conn-warning" id="al-cfg-warning"></div>
      </div>

      <div class="al-context-section">
        <div class="al-context-header">
          <span class="al-context-title">Selected Sources (<span id="al-doc-count">0</span>)</span>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span class="al-btn-dev-toggle ${this.abstractOnly ? "active" : ""}" id="al-btn-abstract-only"
              role="button" tabindex="0"
              aria-pressed="${this.abstractOnly ? "true" : "false"}"
              style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:4px;font-size:10px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;border:1px solid ${this.abstractOnly ? "rgba(250,173,20,0.5)" : "rgba(82,214,138,0.4)"};background:${this.abstractOnly ? "rgba(250,173,20,0.16)" : "rgba(82,214,138,0.14)"};color:${this.abstractOnly ? "#ffc53d" : "#52d68a"};"
              title="Developer toggle: when active, queries only use item abstracts and ignore extracted PDF text">${this.abstractOnly ? "🧪 Abstract-Only: ON" : "📄 Mode: PDF + Abstract"}</span>
            <button class="al-btn al-btn-secondary al-btn-xs" id="al-btn-clear-sources" title="Clear all selected sources">✕ Clear</button>
            <button class="al-btn al-btn-secondary al-btn-sm" id="al-btn-add-selected">+ Add Selected</button>
          </div>
        </div>
        <div class="al-drop-zone" id="al-drop-zone">
          <span class="al-drop-icon">📄</span>
          Drag articles from library here (auto-detects PDF &amp; converts to .txt)
        </div>
        <div class="al-doc-list" id="al-doc-list"></div>
      </div>

      <div class="al-messages-area" id="al-messages-area">
        <div class="al-message assistant">
          <div class="al-msg-header">
            <span>Academic Lens</span>
          </div>
          <div class="al-msg-content">Welcome to <b>Academic Lens</b>. Drag or select papers from your library to query specific sources, or simply type a keyword or question below with no papers selected to automatically find and analyze <b>2–5 matching papers</b> from your library.</div>
        </div>
      </div>

      <!-- ── Persistent Quick Prompts Toolbar ────────────────────── -->
      <div class="al-quick-prompts" id="al-quick-prompts" style="display:flex;flex-direction:column;gap:6px;padding:8px 12px;background:#1e1e24;border-top:1px solid #33333e;flex-shrink:0;">
        <div class="al-quick-title" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8d77ca;user-select:none;">Quick Prompts:</div>
        <div class="al-quick-list" style="display:flex;flex-wrap:wrap;gap:6px;width:100%;">
          <span class="al-quick-btn" role="button" tabindex="0" data-prompt="Summarize the key findings of these papers." style="display:inline-flex;align-items:center;background:#282834;border:1px solid #4a4a5e;border-radius:12px;color:#e0e0f0;font-size:11px;padding:4px 10px;cursor:pointer;user-select:none;line-height:1.3;white-space:nowrap;">💡 Summarize findings</span>
          <span class="al-quick-btn" role="button" tabindex="0" data-prompt="Compare the methodologies used across these papers." style="display:inline-flex;align-items:center;background:#282834;border:1px solid #4a4a5e;border-radius:12px;color:#e0e0f0;font-size:11px;padding:4px 10px;cursor:pointer;user-select:none;line-height:1.3;white-space:nowrap;">🔬 Compare methods</span>
          <span class="al-quick-btn" role="button" tabindex="0" data-prompt="What are the main contributions of these papers?" style="display:inline-flex;align-items:center;background:#282834;border:1px solid #4a4a5e;border-radius:12px;color:#e0e0f0;font-size:11px;padding:4px 10px;cursor:pointer;user-select:none;line-height:1.3;white-space:nowrap;">❓ Key contributions</span>
        </div>
      </div>

      <div class="al-composer-area">
        <textarea class="al-textarea" id="al-input-query" placeholder="Ask about selected papers, or enter keywords / a question to search for 2–5 papers… (Enter to send)" rows="2"></textarea>
        <div class="al-composer-actions">
          <div class="al-action-group">
            <button class="al-btn al-btn-secondary" id="al-btn-clear-chat">Clear</button>
          </div>
          <div class="al-action-group">
            <button id="send-btn" title="Send question (Enter)">Send</button>
          </div>
        </div>
      </div>
    `;
  },

  createSidebarMount(win, location) {
    const paneId = location === "reader" ? "academic-lens-pane-reader" : "academic-lens-pane-library";

    // ── 1. XUL shell — integrates into Zotero's XUL layout ──────────────
    const mountVBox = win.document.createXULElement("vbox");
    mountVBox.setAttribute("id", paneId);
    mountVBox.setAttribute("flex", "1");
    mountVBox.setAttribute("class", "al-vbox-shell");
    mountVBox.style.cssText = [
      "display: none",
      "flex: 1 1 0%",
      "min-height: 0",
      "width: 100%",
      "min-width: 300px",
      "height: 100%",
    ].join("; ");

    // ── 2. HTML root — parse all children as HTML ───────────────────────
    const htmlRoot = win.document.createElement("div");
    htmlRoot.setAttribute("id", "al-html-root-" + location);
    htmlRoot.setAttribute("class", "al-html-root");
    htmlRoot.style.cssText = [
      "display: flex",
      "flex-direction: column",
      "height: 100%",
      "width: 100%",
      "min-height: 0",
      "overflow: hidden",
      "box-sizing: border-box;",
    ].join("; ");

    htmlRoot.innerHTML = this.getSidebarHTML();

    mountVBox.appendChild(htmlRoot);

    this.bindEvents(win, htmlRoot);
    this.bindDragDrop(win, mountVBox, htmlRoot);

    return mountVBox;
  },

  setupSidebar(win) {
    if (!win || win.closed || !win.document) return;

    // Clean up any existing instances first
    try {
      win.document.getElementById("academic-lens-pane-library")?.remove();
      win.document.getElementById("academic-lens-pane-reader")?.remove();
    } catch (_) {}

    const itemPane = win.document.getElementById("zotero-item-pane");
    if (itemPane) {
      const libMount = this.createSidebarMount(win, "library");
      itemPane.appendChild(libMount);
      Zotero.debug("[AcademicLens] Mounted library sidebar to #zotero-item-pane");
    }

    const contextPane = win.document.getElementById("zotero-context-pane");
    if (contextPane) {
      const rdrMount = this.createSidebarMount(win, "reader");
      contextPane.appendChild(rdrMount);
      Zotero.debug("[AcademicLens] Mounted reader sidebar to #zotero-context-pane");
    }

    this.renderDocumentChips(win);
  },

  /* ============================================================
     Event Binding
  ============================================================ */

  bindEvents(win, root) {
    // Header maximise & close
    const maxBtn = root.querySelector("#al-btn-maximize");
    const closeBtn = root.querySelector("#al-btn-close");

    maxBtn?.addEventListener("click", () => this.toggleMaximize(win));
    maxBtn?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleMaximize(win);
      }
    });

    closeBtn?.addEventListener("click", () => this.toggleSidebar(win, false));
    closeBtn?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleSidebar(win, false);
      }
    });

    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.isGenerating && this.windows.get(win)?.isMaximized) {
        e.preventDefault();
        e.stopPropagation();
        this.toggleMaximize(win, false);
      }
    });

    // Inline Model and Endpoint input sync
    const modelInput = root.querySelector("#al-input-model");
    const modelSelect = root.querySelector("#al-select-model");
    const epInput = root.querySelector("#al-input-endpoint");
    const toggleConnBtn = root.querySelector("#al-btn-toggle-conn");

    modelInput?.addEventListener("change", () => {
      const val = modelInput.value.trim();
      if (val) {
        this.modelName = val;
        this.saveSettings();
        if (this.connectionEnabled) {
          this.testEndpoint(root);
        }
      }
    });

    modelSelect?.addEventListener("change", () => {
      const selected = modelSelect.value;
      if (selected && modelInput) {
        modelInput.value = selected;
        this.modelName = selected;
        this.saveSettings();
        if (this.connectionEnabled) {
          this.testEndpoint(root);
        }
      }
    });

    let epDebounce = null;
    epInput?.addEventListener("input", () => {
      if (epDebounce) win.clearTimeout(epDebounce);
      epDebounce = win.setTimeout(() => {
        const val = epInput.value.trim();
        if (val) {
          this.endpoint = val;
          this.saveSettings();
          if (this.connectionEnabled) {
            this.testEndpoint(root);
          }
        }
      }, 600);
    });

    toggleConnBtn?.addEventListener("click", () => {
      this.connectionEnabled = !this.connectionEnabled;
      if (this.connectionEnabled) {
        toggleConnBtn.textContent = "Disconnect";
        toggleConnBtn.className = "al-btn-toggle-conn disconnect";
        this.testEndpoint(root);
      } else {
        toggleConnBtn.textContent = "Reconnect";
        toggleConnBtn.className = "al-btn-toggle-conn reconnect";
        this.setPausedState(root);
      }
    });

    root.querySelector("#al-btn-cfg-test")?.addEventListener("click", () => {
      this.connectionEnabled = true;
      if (toggleConnBtn) {
        toggleConnBtn.textContent = "Disconnect";
        toggleConnBtn.className = "al-btn-toggle-conn disconnect";
      }
      this.testEndpoint(root);
    });

    root.querySelector("#al-btn-fetch-models")?.addEventListener("click", () => this.fetchAndSelectModel(root));

    // Initial check on mount
    win.setTimeout(() => {
      if (this.connectionEnabled) {
        this.testEndpoint(root);
      } else {
        this.setPausedState(root);
      }
    }, 250);

    // Developer toggle: Abstract-Only vs PDF + Abstract
    const devToggleBtn = root.querySelector("#al-btn-abstract-only");
    devToggleBtn?.addEventListener("click", () => {
      this.toggleAbstractOnly(win);
    });
    devToggleBtn?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.toggleAbstractOnly(win);
      }
    });

    // Clear selected sources
    root.querySelector("#al-btn-clear-sources")?.addEventListener("click", () => {
      this.clearSelectedDocuments(win);
    });

    // Add selected library items
    root.querySelector("#al-btn-add-selected")?.addEventListener("click", async () => {
      try {
        const selected = win.ZoteroPane?.getSelectedItems();
        if (selected && selected.length > 0) {
          await this.addItems(selected, win);
        } else {
          this._alert(win, "No items selected in your library. Click a paper in the list first.");
        }
      } catch (err) {
        Zotero.debug("[AcademicLens] Error adding selected items: " + err);
      }
    });

    // Quick-prompt chips
    root.querySelectorAll(".al-quick-btn").forEach(btn => {
      const applyPrompt = () => {
        const prompt = btn.getAttribute("data-prompt");
        if (!prompt) return;
        const ta = root.querySelector("#al-input-query");
        if (ta) { ta.value = prompt; ta.focus(); }
      };
      btn.addEventListener("click", applyPrompt);
      btn.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyPrompt();
        }
      });
    });

    // Composer
    const textarea = root.querySelector("#al-input-query");
    const sendBtn  = root.querySelector("#send-btn") || root.querySelector("#al-btn-send");
    const clearBtn = root.querySelector("#al-btn-clear-chat");

    sendBtn?.addEventListener("click", () => {
      if (this.isGenerating) {
        this.abortGeneration(win);
      } else {
        this.handleSend(win);
      }
    });

    sendBtn?.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (this.isGenerating) {
          e.preventDefault();
          this.abortGeneration(win);
        }
      }
    });

    textarea?.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "c" || e.key === "C")) {
        if (this.isGenerating) {
          const hasSelection = (textarea.selectionStart !== textarea.selectionEnd);
          if (!hasSelection) {
            e.preventDefault();
            this.abortGeneration(win);
            return;
          }
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isGenerating) {
          this.handleSend(win);
        }
      }
    });

    clearBtn?.addEventListener("click", () => {
      const area = root.querySelector("#al-messages-area");
      if (area) area.innerHTML = "";
      this.chatHistory = [];
    });
  },

  /*
   * bindDragDrop — capturing drag listeners on the whole sidebar pane.
   *
   * Beaver's DragDropWrapper (react/components/input/DragDropWrapper.tsx)
   * attaches onDragEnter / onDragOver / onDragLeave / onDrop to the outer
   * wrapper div. In plain JS we do the same thing with useCapture=true so
   * the sidebar intercepts events before any child can swallow them.
   *
   * Critical: e.preventDefault() in dragover is what tells Gecko the drop
   * target accepts the drag (otherwise dropEffect stays "none" and no drop
   * event fires at all).
   */
  bindDragDrop(win, mountVBox, htmlRoot) {
    const dropZone = htmlRoot.querySelector("#al-drop-zone");
    let dragCount = 0;   // track enter/leave pairs to handle child-element crossings

    const isZoteroItemDrag = (dt) => dt.types.includes("zotero/item");

    const onDragEnter = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount++;
      if (dropZone) dropZone.classList.add("drag-active");
    };

    const onDragOver = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (dropZone && !dropZone.classList.contains("drag-active")) {
        dropZone.classList.add("drag-active");
      }
    };

    const onDragLeave = (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount--;
      if (dragCount <= 0) {
        dragCount = 0;
        if (dropZone) dropZone.classList.remove("drag-active");
      }
    };

    const onDrop = async (e) => {
      if (!isZoteroItemDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      dragCount = 0;
      if (dropZone) dropZone.classList.remove("drag-active");

      // Parse comma-separated item IDs from the drag data
      const rawIDs = e.dataTransfer.getData("zotero/item");
      if (rawIDs) {
        const ids = rawIDs.split(",")
          .map(s => parseInt(s.trim(), 10))
          .filter(n => !isNaN(n));
        if (ids.length > 0) {
          await this.addItemsByIds(ids, win);
          return;
        }
      }

      // Fallback: use whatever is currently selected in the library pane
      try {
        const selected = win.ZoteroPane?.getSelectedItems();
        if (selected && selected.length > 0) {
          await this.addItems(selected, win);
        }
      } catch (err) {
        Zotero.debug("[AcademicLens] Drop fallback error: " + err);
      }
    };

    // Attach with useCapture=true so we intercept before child elements
    mountVBox.addEventListener("dragenter", onDragEnter, true);
    mountVBox.addEventListener("dragover",  onDragOver,  true);
    mountVBox.addEventListener("dragleave", onDragLeave, true);
    mountVBox.addEventListener("drop",      onDrop,      true);
  },

  /* ============================================================
     Toggle Sidebar
  ============================================================ */

  toggleSidebar(win, forceState = null) {
    try {
      this._toggleSidebarImpl(win, forceState);
    } catch (err) {
      Zotero.debug("[AcademicLens] toggleSidebar FAILED: " + err + "\n" + (err && err.stack));
      Zotero.logError(err);
    }
  },

  _toggleSidebarImpl(win, forceState = null) {
    if (!win || win.closed || !win.document) return;
    const doc = win.document;

    const domItemPane    = doc.getElementById("zotero-item-pane");
    const domContextPane = doc.getElementById("zotero-context-pane");
    const tbBtn          = doc.getElementById("zotero-academic-lens-tb-toggle");

    // Lazily mount if the container exists but our pane is missing
    if (domItemPane && !doc.getElementById("academic-lens-pane-library")) {
      domItemPane.appendChild(this.createSidebarMount(win, "library"));
    }
    if (domContextPane && !doc.getElementById("academic-lens-pane-reader")) {
      domContextPane.appendChild(this.createSidebarMount(win, "reader"));
    }

    const alPaneLib = doc.getElementById("academic-lens-pane-library");
    const alPaneRdr = doc.getElementById("academic-lens-pane-reader");

    const isReaderTab = Boolean(
      (win.Zotero_Tabs && win.Zotero_Tabs.selectedType && win.Zotero_Tabs.selectedType !== "library") ||
      (!domItemPane && domContextPane)
    );

    const prevWinState = this.windows.get(win) || { isOpen: false, isMaximized: false };
    const wasOpen    = Boolean(prevWinState.isOpen);
    const shouldOpen = forceState !== null ? forceState : !wasOpen;

    Zotero.debug(`[AcademicLens] toggleSidebar: shouldOpen=${shouldOpen}, isReaderTab=${isReaderTab}, wasOpen=${wasOpen}`);

    // Helpers: show our pane inside a container (hiding native children), or restore the container
    const showIn = (container, pane) => {
      for (const child of container.children) {
        if (child !== pane) child.style.display = "none";
      }
      pane.style.display = "flex";
    };
    const hideIn = (container, pane) => {
      if (pane) pane.style.display = "none";
      if (!container) return;
      for (const child of container.children) {
        if (child !== pane) child.style.removeProperty("display");
      }
    };

    if (shouldOpen) {
      if (isReaderTab && domContextPane && alPaneRdr) {
        // Reader tab: only touch the context pane
        hideIn(domItemPane, alPaneLib);
        try {
          if (win.ZoteroContextPane?.collapsed) win.ZoteroContextPane.togglePane?.();
        } catch (_) {}
        showIn(domContextPane, alPaneRdr);
      } else if (domItemPane && alPaneLib) {
        // Library tab: only touch the item pane — never uncollapse the reader context pane here
        hideIn(domContextPane, alPaneRdr);
        try {
          if (win.ZoteroPane?.itemPane?.collapsed) win.ZoteroPane.itemPane.collapsed = false;
        } catch (_) {}
        showIn(domItemPane, alPaneLib);
      }

      tbBtn?.setAttribute("aria-pressed", "true");
      tbBtn?.setAttribute("selected", "true");
      this.windows.set(win, { isOpen: true, isMaximized: Boolean(prevWinState.isMaximized) });
      this.applyMaximizeState(win, Boolean(prevWinState.isMaximized));
      this.observeItemPane(win);
    } else {
      this.applyMaximizeState(win, false);
      hideIn(domItemPane, alPaneLib);
      hideIn(domContextPane, alPaneRdr);

      tbBtn?.setAttribute("aria-pressed", "false");
      tbBtn?.removeAttribute("selected");
      this.windows.set(win, { isOpen: false, isMaximized: false });
      this.unobserveItemPane(win);
    }
  },

  /* ============================================================
     Maximise / Restore Panel (Antigravity Code Viewer Style)
  ============================================================ */

  toggleMaximize(win, forceState = null) {
    if (!win || win.closed || !win.document) return;
    const winState = this.windows.get(win) || { isOpen: true, isMaximized: false };
    const nextMaximized = forceState !== null ? Boolean(forceState) : !winState.isMaximized;

    this.windows.set(win, { ...winState, isMaximized: nextMaximized });
    this.applyMaximizeState(win, nextMaximized);
    Zotero.debug(`[AcademicLens] Panel maximised: ${nextMaximized}`);
  },

  applyMaximizeState(win, isMaximized) {
    if (!win || win.closed || !win.document) return;
    const doc = win.document;

    const toolbar = doc.getElementById("zotero-tabs-toolbar") || doc.getElementById("navigator-toolbox");
    const topOffset = toolbar ? Math.max(0, Math.round(toolbar.getBoundingClientRect().bottom)) : 0;

    const panes = [
      doc.getElementById("academic-lens-pane-library"),
      doc.getElementById("academic-lens-pane-reader"),
    ].filter(Boolean);

    const containers = [
      doc.getElementById("zotero-item-pane"),
      doc.getElementById("zotero-context-pane"),
    ].filter(Boolean);

    // Always restore any container fallback styles first before re-evaluating
    containers.forEach(container => {
      container.classList.remove("al-container-maximized");
      if (container.dataset && container.dataset.alPrevStyle !== undefined) {
        const prev = container.dataset.alPrevStyle;
        if (prev) {
          container.setAttribute("style", prev);
        } else {
          container.removeAttribute("style");
        }
        delete container.dataset.alPrevStyle;
      }
    });

    panes.forEach(pane => {
      const htmlRoot = pane.querySelector(".al-html-root");
      const maxBtn   = pane.querySelector("#al-btn-maximize");

      if (isMaximized) {
        pane.classList.add("al-maximized");
        htmlRoot?.classList.add("al-maximized");

        pane.style.setProperty("position", "fixed", "important");
        pane.style.setProperty("top", `${topOffset}px`, "important");
        pane.style.setProperty("left", "0px", "important");
        pane.style.setProperty("right", "0px", "important");
        pane.style.setProperty("bottom", "0px", "important");
        pane.style.setProperty("width", "100vw", "important");
        pane.style.setProperty("max-width", "100vw", "important");
        pane.style.setProperty("height", `calc(100vh - ${topOffset}px)`, "important");
        pane.style.setProperty("z-index", "99999", "important");

        if (maxBtn) {
          maxBtn.textContent = this.getMaximizeIcon(true);
          maxBtn.setAttribute("title", "Restore Panel Size (Esc)");
          maxBtn.setAttribute("aria-label", "Restore Panel Size");
          maxBtn.setAttribute("aria-pressed", "true");
          maxBtn.classList.add("active");
          maxBtn.style.background = "rgba(141, 119, 202, 0.28)";
          maxBtn.style.borderColor = "#9b87d6";
          maxBtn.style.color = "#ffffff";
        }

        // If an ancestor has `contain` or `transform` that traps fixed positioning,
        // expand the immediate Zotero pane container as a fallback.
        const parentContainer = pane.parentElement;
        if (parentContainer && pane.style.display !== "none") {
          const rect = pane.getBoundingClientRect();
          if (win.innerWidth > 0 && rect.width < win.innerWidth * 0.85) {
            if (parentContainer.dataset && parentContainer.dataset.alPrevStyle === undefined) {
              parentContainer.dataset.alPrevStyle = parentContainer.getAttribute("style") || "";
            }
            parentContainer.classList.add("al-container-maximized");
            parentContainer.style.setProperty("position", "fixed", "important");
            parentContainer.style.setProperty("top", `${topOffset}px`, "important");
            parentContainer.style.setProperty("left", "0px", "important");
            parentContainer.style.setProperty("right", "0px", "important");
            parentContainer.style.setProperty("bottom", "0px", "important");
            parentContainer.style.setProperty("width", "100vw", "important");
            parentContainer.style.setProperty("max-width", "100vw", "important");
            parentContainer.style.setProperty("height", `calc(100vh - ${topOffset}px)`, "important");
            parentContainer.style.setProperty("z-index", "99998", "important");
          }
        }
      } else {
        pane.classList.remove("al-maximized");
        htmlRoot?.classList.remove("al-maximized");

        ["position", "top", "left", "right", "bottom", "max-width", "z-index"].forEach(prop => {
          pane.style.removeProperty(prop);
        });
        pane.style.width = "100%";
        pane.style.height = "100%";

        if (maxBtn) {
          maxBtn.textContent = this.getMaximizeIcon(false);
          maxBtn.setAttribute("title", "Maximise Panel");
          maxBtn.setAttribute("aria-label", "Maximise Panel");
          maxBtn.setAttribute("aria-pressed", "false");
          maxBtn.classList.remove("active");
          maxBtn.style.background = "#282834";
          maxBtn.style.borderColor = "#6c5ce7";
          maxBtn.style.color = "#e0e0f0";
        }
      }
    });
  },

  /* Re-apply sidebar visibility when the user switches between library and reader tabs */
  registerTabObserver() {
    if (this._tabObserverID) return;
    try {
      this._tabObserverID = Zotero.Notifier.registerObserver({
        notify: (event, type) => {
          if (type !== "tab" || event !== "select") return;
          for (const [win, state] of this.windows) {
            if (state?.isOpen) {
              win.setTimeout(() => this.toggleSidebar(win, true), 50);
            }
          }
        }
      }, ["tab"], "academic-lens");
    } catch (err) {
      Zotero.debug("[AcademicLens] Could not register tab observer: " + err);
    }
  },

  unregisterTabObserver() {
    if (!this._tabObserverID) return;
    try { Zotero.Notifier.unregisterObserver(this._tabObserverID); } catch (_) {}
    this._tabObserverID = null;
  },

  /* ============================================================
     Settings Window (pop-out, Beaver pattern)
  ============================================================ */

  openSettingsWindow(win) {
    if (this._settingsWindow && !this._settingsWindow.closed) {
      this._settingsWindow.focus();
      return;
    }

    const hostWin = win || (typeof Zotero !== "undefined" && Zotero.getMainWindow ? Zotero.getMainWindow() : window);
    const settingsURL = "chrome://academic-lens/content/settings.xhtml";
    const opened = hostWin.openDialog(
      settingsURL,
      "academic-lens-settings-window",
      "chrome,resizable,centerscreen,dialog=false,width=560,height=640",
      null
    );

    if (opened) {
      this._settingsWindow = opened;
      opened.addEventListener("unload", () => {
        this._settingsWindow = null;
        this.updateAllSidebars();
      }, { once: true });
    }

    Zotero.debug("[AcademicLens] Opened settings window.");
  },

  /* ============================================================
     Item Ingestion (Automatic PDF → .txt + Abstract & Metadata)
  ============================================================ */

  toggleAbstractOnly(win = null, forceState = null) {
    this.abstractOnly = forceState !== null ? Boolean(forceState) : !this.abstractOnly;
    try {
      Zotero.Prefs?.set?.("extensions.academic-lens.abstractOnly", Boolean(this.abstractOnly));
    } catch (_) {}
    Zotero.debug(`[AcademicLens] Developer Abstract-Only mode: ${this.abstractOnly}`);
    this.renderDocumentChips(win);
  },

  async addItemsByIds(ids, win) {
    if (!ids || ids.length === 0) return;
    try {
      const items = await Zotero.Items.getAsync(ids);
      await this.addItems(items, win);
    } catch (err) {
      Zotero.debug("[AcademicLens] Failed to load items: " + err);
    }
  },

  async buildDocEntryFromItem(rawItem, win) {
    if (!rawItem) return null;

    let item = rawItem;
    let directAttachment = null;

    // Support dragging/selecting either a regular parent item OR a child PDF/TXT attachment directly
    try {
      if (rawItem.isAttachment && rawItem.isAttachment()) {
        directAttachment = rawItem;
        if (rawItem.parentItemID) {
          const parent = await Zotero.Items.getAsync(rawItem.parentItemID);
          if (parent && parent.isRegularItem && parent.isRegularItem()) {
            item = parent;
          }
        }
      }
    } catch (_) {}

    const isReg = Boolean(item.isRegularItem && item.isRegularItem());
    const isAtt = Boolean(item.isAttachment && item.isAttachment());
    if (!isReg && !isAtt) return null;

    const title    = item.getField("title") || directAttachment?.getField?.("title") || "Untitled";
    const creators = (isReg && item.getCreators) ? (item.getCreators() || []) : [];
    const firstAuthor = creators.length > 0
      ? (creators[0].lastName || creators[0].name || "Unknown")
      : "Unknown";
    const authors  = creators.map(c => c.lastName || c.name).filter(Boolean).join(", ") || firstAuthor;
    const rawDate  = (isReg && (item.getField("date") || item.getField("year"))) || "";
    const yearMatch = String(rawDate).match(/\b(19\d{2}|20\d{2})\b/);
    const year     = yearMatch ? yearMatch[1] : (rawDate ? String(rawDate).substring(0, 4) : "n.d.");
    const abstract = isReg ? this.normalizeWs(item.getField("abstractNote") || "") : "";
    const doi      = isReg ? item.getField("DOI") : "";
    const url      = item.getField("url") || (doi ? `https://doi.org/${doi}` : "");
    const display  = isReg ? `${firstAuthor} (${year})` : title;

    const docEntry = {
      id: item.id,
      title,
      firstAuthor,
      authors,
      year,
      abstract,
      url,
      display,
      hasPdf: false,
      isExtracting: true,
      fullText: "",
      txtPath: null,
      _extractPromise: null,
    };

    const p = this.extractItemPdfToTxt(item, directAttachment, docEntry, win);
    docEntry._extractPromise = p;
    return docEntry;
  },

  async addItems(items, win) {
    const list = Array.isArray(items) ? items : [items];
    const extractionTasks = [];

    for (const rawItem of list) {
      if (!rawItem) continue;
      const docEntry = await this.buildDocEntryFromItem(rawItem, win);
      if (!docEntry) continue;
      if (this.selectedDocuments.some(d => d.id === docEntry.id)) continue; // no dups

      this.selectedDocuments.push(docEntry);
      if (docEntry._extractPromise) {
        extractionTasks.push(docEntry._extractPromise);
      }
    }

    this.renderDocumentChips(win);
    if (extractionTasks.length > 0) {
      await Promise.allSettled(extractionTasks);
      this.renderDocumentChips(win);
    }
  },

  /**
   * Searches the user's Zotero library for 2–5 papers matching the prompt's
   * keywords or research question when no PDFs/sources are manually selected.
   */
  async searchLibraryPapers(query, win, minResults = 2, maxResults = 5) {
    if (!query || !String(query).trim()) return [];

    const stopWords = new Set([
      "the", "and", "for", "that", "this", "with", "from", "what", "are", "how",
      "which", "where", "when", "who", "whom", "whose", "why", "does", "did", "can",
      "could", "would", "should", "will", "was", "were", "been", "being", "have",
      "has", "had", "into", "onto", "upon", "within", "without", "between", "among",
      "through", "during", "before", "after", "above", "below", "under", "over",
      "these", "those", "their", "they", "them", "there", "here", "some", "such",
      "only", "more", "most", "other", "than", "very", "just", "also", "about",
      "paper", "papers", "article", "articles", "study", "studies", "research",
      "find", "search", "show", "list", "give", "tell", "explain", "summarize",
      "compare", "contrast", "discuss", "describe", "identify", "relate", "related",
      "relating", "using", "used", "use", "based", "question", "questions", "key",
      "main", "findings", "finding", "contributions", "contribution"
    ]);

    const rawClean = String(query)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Extract meaningful search terms
    let allTokens = rawClean.split(" ").filter(w => w.length >= 2);
    let keywords = allTokens.filter(w => !stopWords.has(w) && (w.length >= 3 || /^(ai|ml|vr|ar|xr|3d|2d|ui|ux|llm|rag|nlp|hci|iot|gpu|cpu)$/.test(w)));
    if (keywords.length === 0) {
      keywords = allTokens.filter(w => w.length >= 2);
    }
    // Deduplicate keywords while preserving order
    keywords = Array.from(new Set(keywords));

    const stemWord = (w) => {
      if (!w || w.length < 5) return w;
      return w
        .replace(/(?:ing|tion|sion|ment|ness|able|ible|ive|ous|ies|es|ed|s)$/i, (m) => (m === "ies" ? "y" : ""))
        .trim() || w;
    };

    const keywordEntries = keywords.map(kw => ({
      kw,
      stem: stemWord(kw),
      wordRegex: new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")
    }));

    const normalizedPhrase = keywords.slice(0, 5).join(" ");

    let libraryID = 1;
    try {
      libraryID = win?.ZoteroPane?.getSelectedLibraryID?.() || Zotero.Libraries?.userLibraryID || 1;
    } catch (_) {}

    // 1. Query Zotero's built-in quicksearch-everything (which includes indexed PDF full-text)
    const fulltextHitsByItem = new Map(); // itemID -> Set<kw>
    const candidateItemMap   = new Map(); // itemID -> Zotero.Item

    const resolveRegularParent = async (rawItem) => {
      if (!rawItem) return null;
      try {
        if (rawItem.deleted) return null;
        if (rawItem.isRegularItem && rawItem.isRegularItem()) return rawItem;
        if (rawItem.isAttachment && rawItem.isAttachment() && rawItem.parentItemID) {
          const parent = await Zotero.Items.getAsync(rawItem.parentItemID);
          if (parent && !parent.deleted && parent.isRegularItem && parent.isRegularItem()) {
            return parent;
          }
        }
      } catch (_) {}
      return null;
    };

    try {
      if (typeof Zotero.Search === "function") {
        for (const { kw } of keywordEntries.slice(0, 8)) {
          try {
            const s = new Zotero.Search();
            s.libraryID = libraryID;
            s.addCondition("quicksearch-everything", "contains", kw);
            const hitIds = await s.search();
            if (hitIds && hitIds.length > 0) {
              const items = await Zotero.Items.getAsync(hitIds.slice(0, 150));
              for (const raw of (Array.isArray(items) ? items : [items])) {
                const reg = await resolveRegularParent(raw);
                if (reg) {
                  candidateItemMap.set(reg.id, reg);
                  if (!fulltextHitsByItem.has(reg.id)) {
                    fulltextHitsByItem.set(reg.id, new Set());
                  }
                  fulltextHitsByItem.get(reg.id).add(kw);
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (searchErr) {
      Zotero.debug("[AcademicLens] Zotero.Search warning: " + searchErr);
    }

    // 2. Also load regular items from the active library so stem/partial matches are scored
    try {
      const allLibraryItems = await Zotero.Items.getAll(libraryID, false, false);
      if (Array.isArray(allLibraryItems)) {
        for (const it of allLibraryItems) {
          if (it && !it.deleted && it.isRegularItem && it.isRegularItem()) {
            candidateItemMap.set(it.id, it);
          }
        }
      }
    } catch (allErr) {
      Zotero.debug("[AcademicLens] Zotero.Items.getAll warning: " + allErr);
    }

    const candidates = Array.from(candidateItemMap.values());
    if (candidates.length === 0) return [];

    // 3. Score each candidate paper against the query
    const scored = [];
    for (const item of candidates) {
      try {
        const title    = String(item.getField("title") || "");
        const abstract = String(item.getField("abstractNote") || "");
        const pub      = String(item.getField("publicationTitle") || item.getField("proceedingsTitle") || "");
        const date     = String(item.getField("date") || item.getField("year") || "");
        const creators = (item.getCreators ? (item.getCreators() || []) : [])
          .map(c => `${c.firstName || ""} ${c.lastName || ""} ${c.name || ""}`)
          .join(" ");
        const tags     = (item.getTags ? (item.getTags() || []) : [])
          .map(t => (typeof t === "string" ? t : (t.tag || "")))
          .join(" ");

        const titleLower    = title.toLowerCase();
        const abstractLower = abstract.toLowerCase();
        const tagsLower     = tags.toLowerCase();
        const creatorsLower = creators.toLowerCase();
        const pubLower      = pub.toLowerCase();
        const dateLower     = date.toLowerCase();
        const ftKwSet       = fulltextHitsByItem.get(item.id) || new Set();

        let score = 0;
        let matchedKeywordsCount = 0;

        // Multi-word phrase boost
        if (normalizedPhrase.length >= 4 && keywordEntries.length >= 2) {
          if (titleLower.includes(normalizedPhrase))    score += 18;
          if (tagsLower.includes(normalizedPhrase))     score += 14;
          if (abstractLower.includes(normalizedPhrase)) score += 10;
        }

        for (const { kw, stem, wordRegex } of keywordEntries) {
          let kwScore = 0;

          // Title match
          if (wordRegex.test(titleLower)) {
            kwScore += 9;
          } else if (titleLower.includes(kw)) {
            kwScore += 7;
          } else if (stem.length >= 4 && titleLower.includes(stem)) {
            kwScore += 5;
          }

          // Tags / keywords match
          if (tagsLower.includes(kw)) {
            kwScore += 7;
          } else if (stem.length >= 4 && tagsLower.includes(stem)) {
            kwScore += 4.5;
          }

          // Author / Year match
          if (creatorsLower.includes(kw) || dateLower.includes(kw)) {
            kwScore += 6;
          }

          // Abstract match
          if (abstractLower.includes(kw)) {
            let hits = 0;
            let pos = abstractLower.indexOf(kw);
            while (pos !== -1 && hits < 4) {
              hits++;
              pos = abstractLower.indexOf(kw, pos + kw.length);
            }
            kwScore += 4 + Math.min(3, hits - 1);
          } else if (stem.length >= 4 && abstractLower.includes(stem)) {
            kwScore += 2.5;
          }

          // Venue / publication match
          if (pubLower.includes(kw)) {
            kwScore += 2;
          }

          // Full-text index match from Zotero.Search
          if (ftKwSet.has(kw)) {
            kwScore += 5;
          }

          if (kwScore > 0) {
            matchedKeywordsCount++;
            score += kwScore;
          }
        }

        // Coverage bonus for matching multiple distinct query keywords
        if (matchedKeywordsCount > 1) {
          score += matchedKeywordsCount * 5;
        }

        if (score > 0) {
          // Slight tie-breaker for items with rich metadata/attachments
          if (abstract.trim().length > 40) score += 0.3;
          try {
            const attIds = item.getAttachments ? (item.getAttachments() || []) : [];
            if (attIds.length > 0) score += 0.2;
          } catch (_) {}
          scored.push({ item, score, matchedKeywordsCount });
        }
      } catch (_) {}
    }

    // 4. Fallback prefix match if fewer than `minResults` items matched
    if (scored.length < minResults && keywordEntries.length > 0) {
      const alreadyIds = new Set(scored.map(s => s.item.id));
      for (const item of candidates) {
        if (alreadyIds.has(item.id)) continue;
        try {
          const hay = [
            item.getField("title") || "",
            item.getField("abstractNote") || "",
            (item.getTags ? (item.getTags() || []) : []).map(t => t.tag || t).join(" ")
          ].join(" ").toLowerCase();

          let fallbackScore = 0;
          for (const { kw } of keywordEntries) {
            const prefix = kw.slice(0, Math.min(4, kw.length));
            if (prefix.length >= 3 && hay.includes(prefix)) {
              fallbackScore += 1.5;
            }
          }
          if (fallbackScore > 0) {
            scored.push({ item, score: fallbackScore, matchedKeywordsCount: 1 });
          }
        } catch (_) {}
      }
    }

    if (scored.length === 0) return [];

    scored.sort((a, b) => b.score - a.score);

    // 5. Select between minResults (2) and maxResults (5) papers
    const topScore = scored[0].score;
    const chosenItems = [];
    for (let i = 0; i < scored.length && chosenItems.length < maxResults; i++) {
      const entry = scored[i];
      if (chosenItems.length < minResults || entry.score >= topScore * 0.28) {
        chosenItems.push(entry.item);
      }
    }

    Zotero.debug(`[AcademicLens] Auto-search for "${query}" matched ${chosenItems.length} papers (out of ${scored.length} candidates).`);

    // 6. Build docEntries and await PDF -> .txt extraction
    const docEntries = [];
    const extractionPromises = [];
    for (const item of chosenItems) {
      const docEntry = await this.buildDocEntryFromItem(item, win);
      if (docEntry) {
        docEntries.push(docEntry);
        if (docEntry._extractPromise && !this.abstractOnly) {
          extractionPromises.push(docEntry._extractPromise);
        }
      }
    }

    if (extractionPromises.length > 0) {
      await Promise.allSettled(extractionPromises);
    }

    return docEntries;
  },

  async extractItemPdfToTxt(item, directAttachment, docEntry, win) {
    try {
      const candidateAttachments = [];
      if (directAttachment) {
        candidateAttachments.push(directAttachment);
      }

      if (item.isRegularItem && item.isRegularItem()) {
        try {
          if (typeof item.getBestAttachment === "function") {
            const best = await item.getBestAttachment();
            if (best && !candidateAttachments.some(a => a.id === best.id)) {
              candidateAttachments.push(best);
            }
          }
        } catch (_) {}

        try {
          const attIds = (typeof item.getAttachments === "function") ? (item.getAttachments() || []) : [];
          if (attIds.length > 0) {
            const atts = await Zotero.Items.getAsync(attIds);
            for (const a of (Array.isArray(atts) ? atts : [atts])) {
              if (a && !candidateAttachments.some(existing => existing.id === a.id)) {
                candidateAttachments.push(a);
              }
            }
          }
        } catch (_) {}
      }

      const isPdfAtt = (att) => Boolean(
        att && (
          (typeof att.isPDFAttachment === "function" && att.isPDFAttachment()) ||
          att.attachmentContentType === "application/pdf" ||
          String(att.attachmentFilename || "").toLowerCase().endsWith(".pdf")
        )
      );

      const isTxtAtt = (att) => Boolean(
        att && (
          att.attachmentContentType === "text/plain" ||
          String(att.attachmentFilename || "").toLowerCase().endsWith(".txt")
        )
      );

      const pdfAtt = candidateAttachments.find(isPdfAtt);
      const txtAtt = candidateAttachments.find(isTxtAtt);

      let extractedText = "";
      let savedTxtPath = null;

      if (pdfAtt) {
        docEntry.hasPdf = true;
        const pdfPath = (typeof pdfAtt.getFilePathAsync === "function")
          ? await pdfAtt.getFilePathAsync()
          : (typeof pdfAtt.getFilePath === "function" ? pdfAtt.getFilePath() : null);

        const targetTxtPath = pdfPath ? pdfPath.replace(/\.pdf$/i, ".txt") : null;

        // 1. If a converted .txt file already exists alongside the PDF, read it first
        if (targetTxtPath) {
          try {
            if (typeof IOUtils !== "undefined" && IOUtils.exists && await IOUtils.exists(targetTxtPath)) {
              extractedText = await IOUtils.readUTF8(targetTxtPath);
              if (extractedText && extractedText.trim()) {
                savedTxtPath = targetTxtPath;
              }
            } else if (Zotero.File?.pathToFile) {
              const nsTxtFile = Zotero.File.pathToFile(targetTxtPath);
              if (nsTxtFile && nsTxtFile.exists()) {
                extractedText = await Zotero.File.getContentsAsync(nsTxtFile.path);
                if (extractedText && extractedText.trim()) {
                  savedTxtPath = targetTxtPath;
                }
              }
            }
          } catch (_) {}
        }

        // 2. Option A: Zotero's built-in .zotero-ft-cache + Zotero.Fulltext.indexItems
        if (!extractedText || !extractedText.trim()) {
          try {
            let cacheFile = Zotero.Fulltext?.getItemCacheFile?.(pdfAtt);
            if (!cacheFile || !cacheFile.exists()) {
              try {
                await Zotero.Fulltext?.indexItems?.([pdfAtt.id], { complete: true });
              } catch (_) {
                try { await Zotero.Fulltext?.indexItems?.([pdfAtt.id]); } catch (_2) {}
              }
              cacheFile = Zotero.Fulltext?.getItemCacheFile?.(pdfAtt);
            }
            if (cacheFile && cacheFile.exists()) {
              extractedText = await Zotero.File.getContentsAsync(cacheFile.path);
            }
          } catch (ftErr) {
            Zotero.debug("[AcademicLens] Fulltext cache extraction warning: " + ftErr);
          }
        }

        // 3. Fallback: Zotero.PDFWorker.getFullText or Zotero.Fulltext.getItemContent
        if (!extractedText || !extractedText.trim()) {
          try {
            const workerRes = await Zotero.PDFWorker?.getFullText?.(pdfAtt.id);
            if (workerRes && typeof workerRes.text === "string" && workerRes.text.trim()) {
              extractedText = workerRes.text;
            }
          } catch (_) {}
        }

        if (!extractedText || !extractedText.trim()) {
          try {
            const itemContent = await Zotero.Fulltext?.getItemContent?.(pdfAtt.id);
            if (itemContent && typeof itemContent.content === "string") {
              extractedText = itemContent.content;
            } else if (typeof itemContent === "string") {
              extractedText = itemContent;
            }
          } catch (_) {}
        }

        // 4. Write converted .txt file alongside the PDF in Zotero storage
        if (extractedText && extractedText.trim() && targetTxtPath && !savedTxtPath) {
          try {
            if (typeof IOUtils !== "undefined" && IOUtils.writeUTF8) {
              await IOUtils.writeUTF8(targetTxtPath, extractedText);
              savedTxtPath = targetTxtPath;
            } else if (Zotero.File?.putContentsAsync && Zotero.File?.pathToFile) {
              await Zotero.File.putContentsAsync(Zotero.File.pathToFile(targetTxtPath), extractedText);
              savedTxtPath = targetTxtPath;
            }
            Zotero.debug(`[AcademicLens] Converted PDF to TXT: ${targetTxtPath} (${extractedText.length} chars)`);
          } catch (writeErr) {
            Zotero.debug("[AcademicLens] Could not write .txt file alongside PDF: " + writeErr);
          }
        }
      } else if (txtAtt) {
        // Direct .txt attachment support
        try {
          const txtPath = (typeof txtAtt.getFilePathAsync === "function")
            ? await txtAtt.getFilePathAsync()
            : null;
          if (txtPath) {
            extractedText = await Zotero.File.getContentsAsync(txtPath);
            savedTxtPath = txtPath;
            docEntry.hasPdf = true;
          }
        } catch (_) {}
      }

      if (extractedText && extractedText.trim()) {
        docEntry.fullText = this.normalizePdfText(extractedText);
        docEntry.txtPath  = savedTxtPath;
      }
    } catch (err) {
      Zotero.debug("[AcademicLens] PDF extraction error: " + err);
    } finally {
      docEntry.isExtracting = false;
      this.renderDocumentChips(win);
    }
  },

  normalizePdfText(text) {
    if (!text) return "";
    return text
      .replace(/\r\n/g, "\n")
      .replace(/[ \t\u3000]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  },

  removeDocument(id, win) {
    this.selectedDocuments = this.selectedDocuments.filter(d => d.id !== id);
    this.renderDocumentChips(win);
  },

  clearSelectedDocuments(win) {
    this.selectedDocuments = [];
    this.renderDocumentChips(win);
  },

  renderDocumentChips(win = null) {
    const winsToUpdate = [];
    if (win && !win.closed && win.document) {
      winsToUpdate.push(win);
    }
    if (this.windows) {
      for (const [w] of this.windows) {
        if (w && !w.closed && w.document && !winsToUpdate.includes(w)) {
          winsToUpdate.push(w);
        }
      }
    }
    if (winsToUpdate.length === 0) {
      try {
        const mw = (typeof Zotero !== "undefined" && Zotero.getMainWindow) ? Zotero.getMainWindow() : null;
        if (mw && !mw.closed && mw.document) winsToUpdate.push(mw);
      } catch (_) {}
    }

    winsToUpdate.forEach(w => {
      const panes = w.document.querySelectorAll("#academic-lens-pane-library, #academic-lens-pane-reader");
      if (!panes || panes.length === 0) return;

      panes.forEach(pane => {
        const listContainer = pane.querySelector("#al-doc-list");
        const countSpan     = pane.querySelector("#al-doc-count");
        const devToggleBtn  = pane.querySelector("#al-btn-abstract-only");

        if (countSpan) countSpan.textContent = String(this.selectedDocuments.length);
        if (devToggleBtn) {
          devToggleBtn.classList.toggle("active", Boolean(this.abstractOnly));
          devToggleBtn.setAttribute("aria-pressed", this.abstractOnly ? "true" : "false");
          devToggleBtn.textContent = this.abstractOnly ? "🧪 Abstract-Only: ON" : "📄 Mode: PDF + Abstract";
          devToggleBtn.style.borderColor = this.abstractOnly ? "rgba(250,173,20,0.5)" : "rgba(82,214,138,0.4)";
          devToggleBtn.style.background = this.abstractOnly ? "rgba(250,173,20,0.16)" : "rgba(82,214,138,0.14)";
          devToggleBtn.style.color = this.abstractOnly ? "#ffc53d" : "#52d68a";
        }

        if (!listContainer) return;

        listContainer.innerHTML = "";

        this.selectedDocuments.forEach((doc, idx) => {
          const docOwner = pane.ownerDocument || w.document;
          const chip = docOwner.createElement("div");
          chip.className = "al-doc-chip";

          let badgeHtml = "";
          if (doc.isExtracting) {
            badgeHtml = `<span class="al-doc-source-badge extracting" title="Extracting text from attached PDF…">⏳ PDF→TXT…</span>`;
          } else if (doc.fullText && doc.fullText.length > 0) {
            const charK = Math.max(1, Math.round(doc.fullText.length / 1000));
            if (this.abstractOnly) {
              badgeHtml = `<span class="al-doc-source-badge abstract-dev" title="Abstract-Only developer mode active (PDF .txt extracted: ${charK}k chars, ignored in query)">🧪 Abstract Only (PDF ${charK}k)</span>`;
            } else {
              const pathHint = doc.txtPath ? `Saved: ${doc.txtPath}` : "Extracted from attached PDF";
              badgeHtml = `<span class="al-doc-source-badge pdf-ready" title="${this.escapeHtml(pathHint)}">📄 PDF .txt (${charK}k chars)</span>`;
            }
          } else {
            badgeHtml = `<span class="al-doc-source-badge no-pdf" title="No PDF attachment detected; using abstract only">📝 Abstract Only</span>`;
          }

          chip.innerHTML = `
            <div class="al-doc-info">
              <div class="al-doc-header-row">
                <span class="al-doc-header">[[${idx + 1}]] ${this.escapeHtml(doc.display)}</span>
                ${badgeHtml}
              </div>
              <div class="al-doc-title" title="${this.escapeHtml(doc.title)}">${this.escapeHtml(doc.title)}</div>
            </div>
            <span class="al-doc-remove" role="button" tabindex="0" title="Remove source" aria-label="Remove source" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;min-width:20px;min-height:20px;border-radius:50%;background:#e05252;border:1px solid #ff7875;color:#ffffff;font-size:12px;font-weight:bold;cursor:pointer;flex-shrink:0;user-select:none;margin-left:8px;line-height:1;text-align:center;">✕</span>
          `;
          const rmBtn = chip.querySelector(".al-doc-remove");
          rmBtn?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.removeDocument(doc.id, w);
          });
          rmBtn?.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              this.removeDocument(doc.id, w);
            }
          });
          listContainer.appendChild(chip);
        });
      });
    });
  },

  /* ============================================================
     Text Cleaning (ported from app.py)
  ============================================================ */

  normalizeWs(text) {
    if (!text) return "";
    return text.replace(/[ \t\u3000]+/g, " ").trim();
  },

  stripBracketCitations(text) {
    if (!text) return "";
    return text.replace(/\[\d+(?:,\s*\d+)*\]/g, "");
  },

  cleanMojibake(text) {
    if (!text) return "";
    return text
      .replace(/â\x80\x94/g, " - ")
      .replace(/â\x80\x99/g, "'")
      .replace(/â\x80\x9c/g, '"')
      .replace(/â\x80\x9d/g, '"');
  },

  formatBulletPoints(text) {
    if (!text) return "";
    return text.replace(/^- /gm, "• ");
  },

  cleanResponseTags(text) {
    if (!text) return "";
    return text
      .replace(/\|MESSAGE_ID\|[^|]*\|END_ID\|/g, "")
      .replace(/\|BIB_KEYWORDS\|[^|]*\|END_BIB\|/g, "")
      .replace(/\|SOURCES\|[^|]*\|END_SOURCES\|/g, "")
      .replace(/\|CONFIDENCE\|\d+\|/g, "")
      .trim();
  },

  /* ============================================================
     Prompt Generation & Chat
  ============================================================ */

  /**
   * Splits extracted PDF .txt into passages and selects the most relevant
   * excerpts for the user's query within `maxChars` so the prompt fits
   * within llama-server's 2048-token context window (`--ctx-size 2048`).
   */
  selectRelevantPdfExcerpts(fullText, query, maxChars = 2200) {
    if (!fullText || maxChars <= 0) return "";
    const cleaned = this.stripBracketCitations(fullText).trim();
    if (cleaned.length <= maxChars) return cleaned;

    // Split into ~500-char chunks along paragraph/sentence boundaries
    const chunkSize = 500;
    const chunks = [];
    let pos = 0;
    while (pos < cleaned.length) {
      let end = Math.min(pos + chunkSize, cleaned.length);
      if (end < cleaned.length) {
        const nextBreak = cleaned.lastIndexOf("\n", end);
        const nextDot   = cleaned.lastIndexOf(". ", end);
        if (nextBreak > pos + 200) end = nextBreak + 1;
        else if (nextDot > pos + 200) end = nextDot + 2;
      }
      const text = cleaned.slice(pos, end).trim();
      if (text.length > 40) {
        chunks.push({ idx: chunks.length, text });
      }
      pos = Math.max(pos + 1, end);
    }

    if (chunks.length === 0) return cleaned.slice(0, maxChars);

    // Extract query keywords (ignore stop words)
    const stopWords = new Set([
      "the", "and", "for", "that", "this", "with", "from", "what", "are", "how",
      "these", "papers", "paper", "study", "studies", "about", "used", "across",
      "into", "their", "they", "have", "has", "was", "were", "will", "can"
    ]);
    const queryTerms = String(query || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 3 && !stopWords.has(w));

    const academicBoostTerms = [
      "result", "results", "finding", "findings", "method", "methodology",
      "conclusion", "conclusions", "contribution", "propose", "demonstrate",
      "experiment", "evaluation", "discussion", "summary", "we show"
    ];

    // Score each chunk
    const scored = chunks.map(c => {
      const lower = c.text.toLowerCase();
      // Skip likely bibliography / reference list chunks near the end
      const isRefList = /\b(references|bibliography|acknowledg(e)?ments)\b/i.test(lower) &&
        (c.text.match(/\b(19|20)\d{2}\b/g) || []).length >= 4;
      if (isRefList) return { ...c, score: -10 };

      let score = 0;
      for (const term of queryTerms) {
        let idx = lower.indexOf(term);
        let hits = 0;
        while (idx !== -1 && hits < 5) {
          hits++;
          idx = lower.indexOf(term, idx + term.length);
        }
        if (hits > 0) score += 4 + Math.min(hits, 3);
      }
      for (const boost of academicBoostTerms) {
        if (lower.includes(boost)) score += 1.5;
      }
      // Slight preference for early/mid body sections over boilerplate header/footer
      if (c.idx >= 1 && c.idx <= Math.ceil(chunks.length * 0.75)) {
        score += 1;
      }
      return { ...c, score };
    });

    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

    const selected = [];
    let usedChars = 0;
    for (const item of scored) {
      if (usedChars + item.text.length + 10 > maxChars) {
        if (selected.length === 0) {
          selected.push({ idx: item.idx, text: item.text.slice(0, maxChars) });
        }
        break;
      }
      selected.push(item);
      usedChars += item.text.length + 6;
    }

    // Re-order selected chunks in natural document order
    selected.sort((a, b) => a.idx - b.idx);
    return selected.map(s => s.text).join("\n...\n");
  },

  buildContext(docs = null, query = "", totalCharBudget = null) {
    const list = (docs && docs.length > 0) ? docs : this.selectedDocuments;
    const budget = totalCharBudget || this.DEFAULT_MAX_CONTEXT_CHARS || 3200;
    const perDocBudget = Math.max(400, Math.floor(budget / Math.max(1, list.length)));

    return list.map((doc, idx) => {
      let cleanAbstract = this.stripBracketCitations(doc.abstract || "No abstract available.");
      const useFullText = !this.abstractOnly && doc.fullText && doc.fullText.trim().length > 0;

      if (useFullText && cleanAbstract.length > Math.floor(perDocBudget * 0.45)) {
        cleanAbstract = cleanAbstract.slice(0, Math.floor(perDocBudget * 0.45)) + "…";
      } else if (!useFullText && cleanAbstract.length > perDocBudget) {
        cleanAbstract = cleanAbstract.slice(0, perDocBudget) + "…";
      }

      let bodySection = `Abstract: ${cleanAbstract}`;
      if (useFullText) {
        const pdfCharBudget = Math.max(250, perDocBudget - cleanAbstract.length - 120);
        const excerpts = this.selectRelevantPdfExcerpts(doc.fullText, query, pdfCharBudget);
        if (excerpts) {
          bodySection += `\nPDF Text Excerpts:\n${excerpts}`;
        }
      }

      return (
        `--- START SOURCE [[${idx + 1}]] ---\n` +
        `Title: ${doc.title}\n` +
        `Authors: ${doc.authors} (${doc.year})\n` +
        `${bodySection}\n` +
        `--- END SOURCE [[${idx + 1}]] ---`
      );
    }).join("\n\n");
  },

  renderMatchedPapersCard(msgEl, matchedDocs, win = null) {
    if (!msgEl || !matchedDocs || matchedDocs.length === 0) return;
    const doc = msgEl.ownerDocument || win?.document;
    if (!doc) return;

    msgEl.querySelector(".al-matched-papers-card")?.remove();

    const card = doc.createElement("div");
    card.className = "al-matched-papers-card";
    card.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-bottom:10px;padding:8px 10px;background:#252532;border:1px solid rgba(141,119,202,0.35);border-radius:6px;";

    const hdr = doc.createElement("div");
    hdr.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;";

    const titleEl = doc.createElement("span");
    titleEl.style.cssText = "font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#b5a3ea;";
    titleEl.textContent = `🔍 Matched Library Papers (${matchedDocs.length})`;
    hdr.appendChild(titleEl);

    const addAllBtn = doc.createElement("span");
    addAllBtn.setAttribute("role", "button");
    addAllBtn.setAttribute("tabindex", "0");
    addAllBtn.style.cssText = "display:inline-flex;align-items:center;padding:2px 7px;background:#2f2c44;border:1px solid #6c5ce7;border-radius:4px;color:#e0e0f0;font-size:10px;font-weight:600;cursor:pointer;user-select:none;";
    addAllBtn.textContent = "+ Pin All to Sources";
    addAllBtn.title = "Add all matched papers to Selected Sources for follow-up questions";
    addAllBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      for (const d of matchedDocs) {
        if (!this.selectedDocuments.some(existing => existing.id === d.id)) {
          this.selectedDocuments.push({ ...d });
        }
      }
      this.renderDocumentChips(win);
      addAllBtn.textContent = "✓ Pinned";
    });
    hdr.appendChild(addAllBtn);
    card.appendChild(hdr);

    const listEl = doc.createElement("div");
    listEl.style.cssText = "display:flex;flex-direction:column;gap:5px;";

    matchedDocs.forEach((d, idx) => {
      const row = doc.createElement("div");
      row.className = "al-matched-paper-row";
      row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 8px;background:#1c1c26;border:1px solid #353548;border-left:3px solid #8d77ca;border-radius:4px;cursor:pointer;";
      row.title = `Click to select "${d.title}" in Zotero`;

      const info = doc.createElement("div");
      info.style.cssText = "display:flex;flex-direction:column;min-width:0;flex:1;gap:2px;";

      const topLine = doc.createElement("div");
      topLine.style.cssText = "display:flex;align-items:center;gap:6px;flex-wrap:wrap;";

      const citeSpan = doc.createElement("span");
      citeSpan.style.cssText = "font-size:11px;font-weight:700;color:#ab9ad6;";
      citeSpan.textContent = `[[${idx + 1}]] ${d.display}`;
      topLine.appendChild(citeSpan);

      const badge = doc.createElement("span");
      const hasPdfTxt = Boolean(d.fullText && d.fullText.trim().length > 0);
      badge.className = "al-doc-source-badge " + (hasPdfTxt ? (this.abstractOnly ? "abstract-dev" : "pdf-ready") : "no-pdf");
      badge.textContent = hasPdfTxt
        ? (this.abstractOnly ? "🧪 Abstract Only" : "📄 PDF .txt")
        : "📝 Abstract";
      topLine.appendChild(badge);
      info.appendChild(topLine);

      const paperTitle = doc.createElement("div");
      paperTitle.style.cssText = "font-size:11px;color:#d0d0e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;";
      paperTitle.textContent = d.title;
      info.appendChild(paperTitle);

      row.appendChild(info);

      const addOneBtn = doc.createElement("span");
      addOneBtn.setAttribute("role", "button");
      addOneBtn.setAttribute("tabindex", "0");
      addOneBtn.style.cssText = "display:inline-flex;align-items:center;padding:2px 6px;background:#282834;border:1px solid #4a4a5e;border-radius:4px;color:#ccc;font-size:10px;font-weight:600;cursor:pointer;user-select:none;flex-shrink:0;";
      addOneBtn.textContent = "+ Pin";
      addOneBtn.title = "Add this paper to Selected Sources";
      addOneBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!this.selectedDocuments.some(existing => existing.id === d.id)) {
          this.selectedDocuments.push({ ...d });
          this.renderDocumentChips(win);
        }
        addOneBtn.textContent = "✓";
      });
      row.appendChild(addOneBtn);

      row.addEventListener("click", () => {
        try {
          if (win && win.ZoteroPane && d.id) {
            win.ZoteroPane.selectItem(d.id);
          }
        } catch (_) {}
      });

      listEl.appendChild(row);
    });

    card.appendChild(listEl);

    const contentEl = msgEl.querySelector(".al-msg-content");
    if (contentEl) {
      msgEl.insertBefore(card, contentEl);
    } else {
      msgEl.appendChild(card);
    }
  },

  async handleSend(win) {
    const panes = win.document.querySelectorAll("#academic-lens-pane-library, #academic-lens-pane-reader");
    let pane = Array.from(panes).find(p => p.style.display !== "none");
    if (!pane) pane = win.document.getElementById("academic-lens-pane-library") || win.document.getElementById("academic-lens-pane-reader");
    if (!pane || this.isGenerating) return;

    const textarea = pane.querySelector("#al-input-query");
    const query    = textarea ? textarea.value.trim() : "";
    if (!query) return;

    textarea.value = "";

    const isAutoSearch = (this.selectedDocuments.length === 0);

    this.appendMessage(pane, "user", query, win);

    const assistantMsgEl = this.appendMessage(pane, "assistant", "", win);
    const contentEl      = assistantMsgEl?.querySelector(".al-msg-content");
    contentEl?.classList.add("al-streaming-cursor");

    const bookEl = win.document.createElement("div");
    bookEl.className = "book";
    bookEl.innerHTML = '<div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div><div class="book__pg"></div>';
    assistantMsgEl?.appendChild(bookEl);

    this.isGenerating = true;
    const sendBtn = pane.querySelector("#send-btn") || pane.querySelector("#al-btn-send");
    if (sendBtn) {
      sendBtn.textContent = "Cancel";
      sendBtn.classList.add("cancel");
      sendBtn.title = "Cancel response generation";
    }

    const AbortCtrl = (win && win.AbortController) || (typeof AbortController !== 'undefined' ? AbortController : (typeof window !== 'undefined' ? window.AbortController : null));
    if (AbortCtrl) {
      this.abortController = new AbortCtrl();
    } else {
      this.abortController = { signal: null, abort: () => {} };
    }

    let queryDocs = [];

    try {
      if (isAutoSearch) {
        if (contentEl) {
          contentEl.textContent = "🔍 Searching your Zotero library for 2–5 relevant papers…";
        }
        queryDocs = await this.searchLibraryPapers(query, win, 2, 5);
        if (!queryDocs || queryDocs.length === 0) {
          assistantMsgEl?.querySelector(".book")?.remove();
          contentEl?.classList.remove("al-streaming-cursor");
          if (contentEl) {
            contentEl.textContent = `No matching papers were found in your Zotero library for "${query}". Try different keywords or drag papers into Selected Sources.`;
          }
          return;
        }
        this.renderMatchedPapersCard(assistantMsgEl, queryDocs, win);
        if (contentEl) {
          contentEl.textContent = "";
        }
      } else {
        // Wait for any in-flight PDF → .txt extractions before snapshotting
        const pendingExtractions = this.selectedDocuments
          .map(d => d._extractPromise)
          .filter(Boolean);
        if (pendingExtractions.length > 0 && !this.abstractOnly) {
          await Promise.allSettled(pendingExtractions);
        }

        // Snapshot sources for this question
        queryDocs = [...this.selectedDocuments];

        // Clear sources for each new question
        this.selectedDocuments = [];
        this.renderDocumentChips(win);
      }

      const hasPdfText = !this.abstractOnly && queryDocs.some(d => d.fullText && d.fullText.trim().length > 0);
      const buildMessagesWithBudget = (charBudget, historyTurns, forceAbstractOnly = false) => {
        const prevAbsOnly = this.abstractOnly;
        if (forceAbstractOnly) this.abstractOnly = true;
        const ctxStr = this.buildContext(queryDocs, query, charBudget);
        this.abstractOnly = prevAbsOnly;

        const sysPrompt = (
          "You are a research assistant. Use ONLY the provided context to answer in concise bullet points.\n" +
          "At the end of EVERY bullet point, cite the source using double brackets, e.g., [[1]].\n" +
          "Be extremely brief to ensure rapid delivery.\n\n" +
          `<context>\n${ctxStr}\n</context>`
        );

        const recentHistory = historyTurns > 0
          ? this.chatHistory.slice(-historyTurns).map(h => ({
              role: h.role,
              content: String(h.content || "").slice(0, 500)
            }))
          : [];

        return [
          { role: "system", content: sysPrompt },
          ...recentHistory,
          { role: "user", content: query }
        ];
      };

      let fullText = "";

      const url = this.endpoint.replace(/\/+$/, "") + "/v1/chat/completions";
      const fetchFunc = (win && win.fetch) || (typeof fetch !== 'undefined' ? fetch : (typeof window !== 'undefined' ? window.fetch : null));

      const attemptRequest = async (messagesPayload, maxTok) => {
        return fetchFunc(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer ollama"
          },
          body: JSON.stringify({
            model:      this.modelName,
            messages:   messagesPayload,
            stream:     true,
            max_tokens: maxTok
          }),
          signal: this.abortController.signal
        });
      };

      const initialMaxTokens = hasPdfText ? Math.min(this.maxTokens, 512) : this.maxTokens;
      const initialHistory   = hasPdfText ? 2 : 4;
      let resp = await attemptRequest(
        buildMessagesWithBudget(this.DEFAULT_MAX_CONTEXT_CHARS, initialHistory, false),
        initialMaxTokens
      );

      // If llama-server returns HTTP 400 (e.g. exceed_context_size_error on 2048-token ctx),
      // automatically retry with a tighter context budget so the user's question succeeds.
      if (resp.status === 400) {
        Zotero.debug("[AcademicLens] HTTP 400 on initial request; retrying with compact context budget (1500 chars)...");
        resp = await attemptRequest(
          buildMessagesWithBudget(1500, 0, false),
          400
        );
      }

      if (resp.status === 400 && hasPdfText) {
        Zotero.debug("[AcademicLens] HTTP 400 persisted; falling back to abstract-only context...");
        resp = await attemptRequest(
          buildMessagesWithBudget(1500, 0, true),
          400
        );
      }

      if (!resp.ok) {
        let errDetail = resp.statusText;
        try {
          const errJson = await resp.json();
          if (errJson?.error?.message) errDetail = errJson.error.message;
        } catch (_) {}
        throw new Error(`HTTP ${resp.status}: ${errDetail}`);
      }

      const reader  = resp.body.getReader();
      const TDecoder = (win && win.TextDecoder) || (typeof TextDecoder !== 'undefined' ? TextDecoder : (typeof window !== 'undefined' ? window.TextDecoder : null));
      const decoder = TDecoder ? new TDecoder("utf-8") : { decode: (v) => String.fromCharCode.apply(null, new Uint8Array(v)) };
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (data === "[DONE]") break;
          try {
            const parsed = JSON.parse(data);
            const delta  = parsed.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullText += this.cleanMojibake(delta);
              this.updateAssistantText(contentEl, fullText);
            }
          } catch (_) { /* incomplete chunk */ }
        }
      }

      assistantMsgEl?.querySelector(".book")?.remove();
      contentEl?.classList.remove("al-streaming-cursor");
      this.finalizeAssistantMessage(assistantMsgEl, fullText, win.document, queryDocs, win);

      this.chatHistory.push({ role: "user",      content: query });
      this.chatHistory.push({ role: "assistant", content: fullText });

    } catch (err) {
      assistantMsgEl?.querySelector(".book")?.remove();
      contentEl?.classList.remove("al-streaming-cursor");
      if (err.name === "AbortError") {
        if (contentEl) contentEl.textContent += " (cancelled)";
      } else {
        if (contentEl) contentEl.textContent = `⚠ Error connecting to ${this.endpoint}: ${err.message}`;
      }
    } finally {
      assistantMsgEl?.querySelector(".book")?.remove();
      this.isGenerating = false;
      this.abortController = null;
      if (sendBtn) {
        sendBtn.textContent = "Send";
        sendBtn.classList.remove("cancel");
        sendBtn.title = "Send question (Enter)";
      }
    }
  },

  abortGeneration(win) {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch (_) {}
    }
    const panes = win?.document?.querySelectorAll?.("#academic-lens-pane-library, #academic-lens-pane-reader");
    panes?.forEach(pane => {
      pane.querySelectorAll(".book").forEach(b => b.remove());
      const cursor = pane.querySelector(".al-streaming-cursor");
      if (cursor) cursor.classList.remove("al-streaming-cursor");
      const sendBtn = pane.querySelector("#send-btn") || pane.querySelector("#al-btn-send");
      if (sendBtn) {
        sendBtn.textContent = "Send";
        sendBtn.classList.remove("cancel");
        sendBtn.title = "Send question (Enter)";
      }
    });
  },

  updateAssistantText(contentEl, rawText) {
    if (!contentEl) return;
    const parentMsg = contentEl.closest?.(".al-message") || contentEl.parentElement;
    const book = parentMsg?.querySelector(".book");
    if (book && rawText && rawText.trim().length > 0) {
      book.remove();
    }
    let text = this.cleanResponseTags(rawText);
    text = this.formatBulletPoints(text);
    contentEl.textContent = text;
  },

  finalizeAssistantMessage(msgEl, fullResponse, doc, sourceDocs = [], win = null) {
    if (!msgEl) return;
    const contentEl = msgEl.querySelector(".al-msg-content");
    if (!contentEl) return;

    let cleaned      = this.cleanResponseTags(fullResponse);
    cleaned          = this.formatBulletPoints(cleaned);

    const docsToUse = (sourceDocs && sourceDocs.length > 0) ? sourceDocs : this.selectedDocuments;

    // Replace [[n]] with inline citation spans
    const docMap = {};
    docsToUse.forEach((d, i) => { docMap[i + 1] = d.display; });

    let html = this.escapeHtml(cleaned);
    html = html.replace(/\[\[(\d+)\]\]/g, (_, n) => {
      const label = docMap[n] || `Source ${n}`;
      return `<span class="al-citation-tag" title="Source ${n}">(${label})</span>`;
    });

    contentEl.innerHTML = html;

    const docToUse = doc || msgEl?.ownerDocument;

    // Sources list below assistant message (matching app.py)
    if (docsToUse.length > 0 && docToUse) {
      const srcList = docToUse.createElement("div");
      srcList.className = "al-sources-list";
      const title = docToUse.createElement("div");
      title.className = "al-sources-title";
      title.textContent = "SOURCES:";
      srcList.appendChild(title);

      const tagsWrapper = docToUse.createElement("div");
      tagsWrapper.className = "al-sources-tags";

      docsToUse.forEach((d, i) => {
        const tag = docToUse.createElement("span");
        tag.className = "al-source-tag academic";
        tag.title = `${d.title} (${d.authors})`;
        tag.textContent = `[[${i + 1}]] ${d.display}`;
        tag.addEventListener("click", () => {
          try {
            if (win && win.ZoteroPane && d.id) {
              win.ZoteroPane.selectItem(d.id);
            }
          } catch (_) {}
        });
        tagsWrapper.appendChild(tag);
      });
      srcList.appendChild(tagsWrapper);
      msgEl.appendChild(srcList);
    }
  },

  appendMessage(pane, sender, text, win = null) {
    const area = pane.querySelector("#al-messages-area");
    if (!area) return null;

    const d   = pane.ownerDocument || win?.document;
    const msg = d.createElement("div");
    msg.className = `al-message ${sender}`;

    const hdr = d.createElement("div");
    hdr.className   = "al-msg-header";

    const titleSpan = d.createElement("span");
    titleSpan.textContent = sender === "user" ? "You" : "Academic Lens";
    hdr.appendChild(titleSpan);

    if (sender === "assistant") {
      const copyBtn = d.createElement("button");
      copyBtn.className = "al-btn-copy-msg";
      copyBtn.textContent = "Copy";
      copyBtn.title = "Copy response to clipboard";
      copyBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const content = msg.querySelector(".al-msg-content")?.textContent || "";
        this.copyToClipboard(win || pane.ownerDocument?.defaultView, content);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      });
      hdr.appendChild(copyBtn);
    }

    const cnt = d.createElement("div");
    cnt.className   = "al-msg-content";
    cnt.textContent = text;

    msg.appendChild(hdr);
    msg.appendChild(cnt);
    area.appendChild(msg);
    area.scrollTop = area.scrollHeight;
    return msg;
  },

  copyToClipboard(win, text) {
    if (!text) return false;
    try {
      if (win?.navigator?.clipboard?.writeText) {
        win.navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const clipHelper = Components.classes["@mozilla.org/widget/clipboardhelper;1"]
        ?.getService(Components.interfaces.nsIClipboardHelper);
      if (clipHelper) {
        clipHelper.copyString(text);
        return true;
      }
    } catch (_) {}
    try {
      const doc = win?.document || (typeof document !== 'undefined' ? document : null);
      if (doc) {
        const ta = doc.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        doc.body.appendChild(ta);
        ta.select();
        doc.execCommand("copy");
        ta.remove();
        return true;
      }
    } catch (_) {}
    return false;
  },

  escapeHtml(str) {
    if (!str) return "";
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  },

  /* ============================================================
     Endpoint Testing & Settings Persistence
  ============================================================ */

  setPausedState(root) {
    const dot = root.querySelector("#al-cfg-status-dot");
    const statusText = root.querySelector("#al-cfg-status-text");
    const badge = root.querySelector("#al-cfg-conn-badge");
    const warning = root.querySelector("#al-cfg-warning");

    if (dot) {
      dot.className = "al-status-dot paused";
      dot.title = "Connection paused";
    }
    if (statusText) {
      statusText.className = "al-cfg-status-text paused";
      statusText.textContent = "Paused";
    }
    if (badge) {
      badge.className = "al-conn-badge paused";
      badge.textContent = "Disconnected (paused)";
    }
    if (warning) warning.classList.remove("visible");
  },

  async testEndpoint(root) {
    if (!this.connectionEnabled) {
      this.setPausedState(root);
      return;
    }

    const dot = root.querySelector("#al-cfg-status-dot");
    const statusText = root.querySelector("#al-cfg-status-text");
    const badge = root.querySelector("#al-cfg-conn-badge");
    const warning = root.querySelector("#al-cfg-warning");
    const testBtn = root.querySelector("#al-btn-cfg-test");
    const epInput = root.querySelector("#al-input-endpoint");
    const modelInput = root.querySelector("#al-input-model");
    const modelSelect = root.querySelector("#al-select-model");

    const rawEp = epInput && typeof epInput.value === "string" && epInput.value.trim() ? epInput.value.trim() : (this.endpoint || "");
    const testUrl = (rawEp || this.DEFAULT_ENDPOINT).replace(/\/+$/, "");
    const targetModel = (modelInput && typeof modelInput.value === "string" && modelInput.value.trim() ? modelInput.value.trim() : (this.modelName || ""));

    if (dot) {
      dot.className = "al-status-dot checking";
      dot.title = "Checking endpoint…";
    }
    if (statusText) {
      statusText.className = "al-cfg-status-text checking";
      statusText.textContent = "Checking…";
    }
    if (badge) {
      badge.className = "al-conn-badge checking";
      badge.textContent = "Checking endpoint…";
    }
    if (testBtn) testBtn.textContent = "…";

    try {
      if (!testUrl || !/^https?:\/\/.+/.test(testUrl)) {
        throw new Error("Invalid endpoint URL (must start with http:// or https://)");
      }

      const fetchFn = (typeof fetch !== "undefined" ? fetch : (root.ownerDocument?.defaultView?.fetch || win?.fetch || Zotero.getMainWindow()?.fetch));
      const r = await fetchFn(`${testUrl}/v1/models`, {
        method: "GET",
        headers: { "Authorization": "Bearer ollama" },
      });

      if (!r.ok) {
        throw new Error(`Endpoint returned HTTP ${r.status}`);
      }

      const json = await r.json();
      const availableModels = ((json && json.data) || []).map(m => m.id).filter(Boolean);

      // Populate dropdown if models exist
      if (modelSelect) {
        const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
        if (availableModels.length > 0 && doc) {
          modelSelect.innerHTML = '<option value="">Select available model…</option>';
          availableModels.forEach(m => {
            const opt = doc.createElement("option");
            opt.value = m;
            opt.textContent = m;
            if (m === targetModel) opt.selected = true;
            modelSelect.appendChild(opt);
          });
          modelSelect.style.display = "inline-block";
        } else {
          modelSelect.style.display = "none";
        }
      }

      // Check if the specific model configured is actually hosted
      const hasExactModel = targetModel && availableModels.includes(targetModel);
      // Case-insensitive / prefix matching fallback (e.g. "llama3.2:3b" vs "llama3.2")
      const hasFuzzyModel = targetModel && availableModels.some(m => m.toLowerCase().includes(targetModel.toLowerCase()) || targetModel.toLowerCase().includes(m.toLowerCase()));

      if (hasExactModel || hasFuzzyModel) {
        if (dot) {
          dot.className = "al-status-dot connected";
          dot.title = `Online (${targetModel})`;
        }
        if (statusText) {
          statusText.className = "al-cfg-status-text connected";
          statusText.textContent = "Online";
        }
        if (badge) {
          badge.className = "al-conn-badge connected";
          badge.textContent = `✓ Ready (${targetModel})`;
        }
        if (warning) warning.classList.remove("visible");
      } else if (availableModels.length > 0) {
        // Endpoint is alive, but requested model is NOT hosted
        if (dot) {
          dot.className = "al-status-dot model-missing";
          dot.title = `Model "${targetModel}" not found`;
        }
        if (statusText) {
          statusText.className = "al-cfg-status-text model-missing";
          statusText.textContent = "Model Missing";
        }
        if (badge) {
          badge.className = "al-conn-badge model-missing";
          badge.textContent = `⚠ Model "${targetModel}" not found`;
        }
        if (warning) {
          warning.innerHTML = `Endpoint is online, but model <b>${this.escapeHtml(targetModel)}</b> is not hosted.<br/>` +
            `Available: <b>${this.escapeHtml(availableModels.join(", "))}</b>. Select from dropdown or run <code>ollama run ${this.escapeHtml(targetModel)}</code>.`;
          warning.classList.add("visible");
        }
      } else {
        // Endpoint online but no models loaded
        if (dot) {
          dot.className = "al-status-dot model-missing";
          dot.title = "Endpoint online, no models";
        }
        if (statusText) {
          statusText.className = "al-cfg-status-text model-missing";
          statusText.textContent = "No Models";
        }
        if (badge) {
          badge.className = "al-conn-badge model-missing";
          badge.textContent = "⚠ Endpoint online, no models";
        }
        if (warning) {
          warning.textContent = `Endpoint is reachable, but returned 0 models. Check that your LLM server has models pulled and loaded.`;
          warning.classList.add("visible");
        }
      }
    } catch (e) {
      if (dot) {
        dot.className = "al-status-dot disconnected";
        dot.title = `Offline: ${e.message}`;
      }
      if (statusText) {
        statusText.className = "al-cfg-status-text disconnected";
        statusText.textContent = "Offline";
      }
      if (badge) {
        badge.className = "al-conn-badge disconnected";
        badge.textContent = "✗ Endpoint not reachable";
      }
      if (warning) {
        warning.textContent = `⚠ Cannot connect to ${testUrl}: ${e.message}`;
        warning.classList.add("visible");
      }
    } finally {
      if (testBtn) testBtn.textContent = "Test";
    }
  },

  async fetchAndSelectModel(root) {
    const epInput = root.querySelector("#al-input-endpoint");
    const fetchBtn = root.querySelector("#al-btn-fetch-models");
    const rawEp = epInput && typeof epInput.value === "string" ? epInput.value.trim() : (this.endpoint || "");
    const testUrl = (rawEp || this.DEFAULT_ENDPOINT).replace(/\/+$/, "");

    if (!testUrl) return;
    if (fetchBtn) fetchBtn.textContent = "Fetching…";

    try {
      await this.testEndpoint(root);
      if (fetchBtn) fetchBtn.textContent = "✓ Updated";
    } catch (_) {
      if (fetchBtn) fetchBtn.textContent = "Failed";
    } finally {
      const timerWin = (root.ownerDocument?.defaultView || win || (typeof window !== "undefined" ? window : null));
      if (timerWin) timerWin.setTimeout(() => {
        if (fetchBtn) fetchBtn.textContent = "↻ Fetch Models";
      }, 2500);
    }
  },

  updateAllSidebars(skipRoot = null) {
    this.loadSettings();

    const windowsToUpdate = [];
    if (this.windows) {
      for (const [win] of this.windows) {
        if (win && !win.closed && win.document) {
          windowsToUpdate.push(win);
        }
      }
    }
    try {
      const mainWin = (typeof Zotero !== "undefined" && Zotero.getMainWindow) ? Zotero.getMainWindow() : null;
      if (mainWin && !windowsToUpdate.includes(mainWin) && !mainWin.closed && mainWin.document) {
        windowsToUpdate.push(mainWin);
      }
    } catch (_) {}

    for (const win of windowsToUpdate) {
      try {
        const roots = win.document.querySelectorAll(".al-html-root");
        roots.forEach(root => {
          if (root === skipRoot) return;

          // Sync input fields
          const epInput = root.querySelector("#al-input-endpoint");
          const modelInput = root.querySelector("#al-input-model");
          if (epInput && epInput !== win.document.activeElement) {
            epInput.value = this.endpoint;
          }
          if (modelInput && modelInput !== win.document.activeElement) {
            modelInput.value = this.modelName;
          }

          // Test endpoint and update status
          if (this.connectionEnabled) {
            this.testEndpoint(root);
          } else {
            this.setPausedState(root);
          }
        });
      } catch (err) {
        Zotero.debug("[AcademicLens] Error updating sidebar: " + err);
      }
    }
  },

  registerPrefObservers() {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && typeof Zotero.Prefs.registerObserver === "function") {
        const prefsToWatch = [
          "extensions.academic-lens.endpoint",
          "extensions.academic-lens.model",
          "extensions.academic-lens.maxTokens"
        ];
        prefsToWatch.forEach(pref => {
          const sym = Zotero.Prefs.registerObserver(pref, () => {
            Zotero.debug("[AcademicLens] Observed preference change: " + pref);
            this.updateAllSidebars();
          }, true);
          if (sym) {
            this._prefObservers.push(sym);
          }
        });
      }
    } catch (e) {
      Zotero.debug("[AcademicLens] Failed to register pref observers: " + e);
    }
  },

  unregisterPrefObservers() {
    try {
      if (typeof Zotero !== "undefined" && Zotero.Prefs && typeof Zotero.Prefs.unregisterObserver === "function") {
        this._prefObservers.forEach(sym => {
          try {
            Zotero.Prefs.unregisterObserver(sym);
          } catch (_) {}
        });
      }
    } catch (_) {}
    this._prefObservers = [];
  },

  loadSettings() {
    try {
      const ep    = Zotero.Prefs.get("extensions.academic-lens.endpoint");
      const model = Zotero.Prefs.get("extensions.academic-lens.model");
      const tok   = Zotero.Prefs.get("extensions.academic-lens.maxTokens");
      const absOnly = Zotero.Prefs.get("extensions.academic-lens.abstractOnly");
      if (ep)    this.endpoint   = ep;
      else if (!this.endpoint) this.endpoint = this.DEFAULT_ENDPOINT;
      if (model) this.modelName  = model;
      else if (!this.modelName) this.modelName = this.DEFAULT_MODEL;
      if (tok)   this.maxTokens  = parseInt(tok, 10) || this.DEFAULT_MAX_TOKENS;
      else if (!this.maxTokens) this.maxTokens = this.DEFAULT_MAX_TOKENS;
      if (typeof absOnly === "boolean") this.abstractOnly = absOnly;
    } catch (_) {}
  },

  saveSettings() {
    try {
      Zotero.Prefs.set("extensions.academic-lens.endpoint",     this.endpoint);
      Zotero.Prefs.set("extensions.academic-lens.model",        this.modelName);
      Zotero.Prefs.set("extensions.academic-lens.maxTokens",    String(this.maxTokens));
      Zotero.Prefs.set("extensions.academic-lens.abstractOnly", Boolean(this.abstractOnly));
      Zotero.debug("[AcademicLens] Settings saved: " + this.endpoint + " / " + this.modelName);
    } catch (_) {}
  },

  registerPreferencesPane(addonId, rootURI) {
    try {
      Zotero.PreferencePanes.register({
        pluginID: addonId,
        src:      rootURI + "content/preferences.xhtml",
        scripts:  [rootURI + "content/preferences.js"],
        id:       "academic-lens-prefpane",
        label:    "Academic Lens",
        image:    "chrome://academic-lens/content/icons/icon.png",
      });
      Zotero.debug("[AcademicLens] Preferences pane registered.");
    } catch (err) {
      Zotero.debug("[AcademicLens] Could not register prefs pane: " + err);
    }
  },

  /* Helper: cross-platform alert */
  _alert(win, msg) {
    try {
      win.alert(msg);
    } catch (_) {
      Zotero.debug("[AcademicLens] Alert: " + msg);
    }
  }
};

/* ================================================================
   AcademicLensPrefs — controller invoked by preferences.xhtml
   Handles the Zotero Preferences window pane.
================================================================ */

Zotero.AcademicLensPrefs = {

  _win: null,
  _saveTimer: null,

  init(win) {
    this._win = win;
    this._populate();
    this._bindEvents();
    Zotero.debug("[AcademicLensPrefs] Prefs pane initialised.");
  },

  // ── Populate fields from live settings ──────────────────────────

  _populate() {
    const al = Zotero.AcademicLens;
    this._set("al-prefs-endpoint",     al.endpoint  || al.DEFAULT_ENDPOINT);
    this._set("al-prefs-model",        al.modelName || al.DEFAULT_MODEL);

    const tok = al.maxTokens || al.DEFAULT_MAX_TOKENS;
    this._set("al-prefs-max-tokens",     String(tok));
    this._set("al-prefs-max-tokens-num", String(tok));
    this._syncTokenDisplay(tok);

    // Validate endpoint field visually on open
    this._validateEndpoint(this._val("al-prefs-endpoint"));
  },

  // ── Event wiring ─────────────────────────────────────────────────

  _bindEvents() {
    // Endpoint live validation
    this._on("al-prefs-endpoint", "input", () => {
      this._validateEndpoint(this._val("al-prefs-endpoint"));
    });

    // Model name live non-empty check
    this._on("al-prefs-model", "input", () => {
      const val = this._val("al-prefs-model").trim();
      const el  = this._el("al-prefs-model");
      if (el) {
        el.classList.toggle("invalid", val.length === 0);
        el.classList.toggle("valid",   val.length > 0);
      }
      const st = this._el("al-prefs-model-status");
      if (st) {
        if (val.length === 0) {
          this._status(st, "error", "Model name cannot be empty.");
        } else {
          st.textContent = "";
          st.className   = "al-prefs-status";
        }
      }
    });

    // Slider ↔ number input sync for max tokens
    this._on("al-prefs-max-tokens", "input", () => {
      const v = parseInt(this._val("al-prefs-max-tokens"), 10);
      if (!isNaN(v)) {
        this._set("al-prefs-max-tokens-num", String(v));
        this._syncTokenDisplay(v);
      }
    });
    this._on("al-prefs-max-tokens-num", "input", () => {
      const raw = parseInt(this._val("al-prefs-max-tokens-num"), 10);
      const v   = Math.min(8000, Math.max(100, raw || 100));
      this._set("al-prefs-max-tokens", String(v));
      this._syncTokenDisplay(v);
      const st = this._el("al-prefs-tokens-status");
      if (st) {
        if (isNaN(raw) || raw < 100) {
          this._status(st, "warn", "Minimum is 100 tokens.");
        } else if (raw > 8000) {
          this._status(st, "warn", "Maximum is 8000 tokens.");
        } else {
          st.textContent = ""; st.className = "al-prefs-status";
        }
      }
    });

    // Buttons
    this._on("al-prefs-test-btn",     "click", () => this._testEndpoint());
    this._on("al-prefs-fetch-models", "click", () => this._fetchModels());
    this._on("al-prefs-save",         "click", () => this._save());
    this._on("al-prefs-reset",        "click", () => this._reset());
  },

  _syncTokenDisplay(v) {
    const disp = this._el("al-prefs-tokens-display");
    if (disp) disp.textContent = String(v);
  },

  // ── Endpoint validation ──────────────────────────────────────────

  _validateEndpoint(val) {
    const trimmed = (val || "").trim();
    const ok      = /^https?:\/\/.+/.test(trimmed);
    const el      = this._el("al-prefs-endpoint");
    const st      = this._el("al-prefs-endpoint-status");
    if (el) {
      el.classList.toggle("valid",   ok);
      el.classList.toggle("invalid", trimmed.length > 0 && !ok);
    }
    if (st && trimmed.length > 0 && !ok) {
      this._status(st, "warn", "URL must start with http:// or https://");
    } else if (st && ok) {
      if (st.className.includes("warn") || st.className.includes("error")) {
        st.textContent = ""; st.className = "al-prefs-status";
      }
    }
    return ok || trimmed.length === 0;
  },

  // ── Test endpoint connectivity ────────────────────────────────────

  async _testEndpoint() {
    const ep      = this._val("al-prefs-endpoint").replace(/\/+$/, "");
    const statusEl = this._el("al-prefs-endpoint-status");
    const testBtn  = this._el("al-prefs-test-btn");

    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      this._status(statusEl, "error", "Please enter a valid URL first.");
      return;
    }

    if (testBtn) { testBtn.textContent = "…"; testBtn.disabled = true; }
    this._status(statusEl, "info", "Connecting…");

    try {
      const fetchFn = (typeof fetch !== "undefined" ? fetch : (root.ownerDocument?.defaultView?.fetch || win?.fetch || Zotero.getMainWindow()?.fetch));
      const r = await fetchFn(ep + "/v1/models", { method: "GET" });
      if (r.ok) {
        const json  = await r.json();
        const count = (json && json.data) ? json.data.length : 0;
        this._status(statusEl, "success",
          `✓ Connected — ${count} model${count !== 1 ? "s" : ""} available`);
      } else {
        throw new Error("HTTP " + r.status);
      }
    } catch (e) {
      this._status(statusEl, "error", "✗ Unreachable: " + e.message);
    } finally {
      if (testBtn) { testBtn.textContent = "Test"; testBtn.disabled = false; }
    }
  },

  // ── Fetch model list from endpoint ────────────────────────────────

  async _fetchModels() {
    const ep     = this._val("al-prefs-endpoint").replace(/\/+$/, "");
    const listEl = this._el("al-prefs-model-list");
    const fetchBtn = this._el("al-prefs-fetch-models");

    if (!ep || !/^https?:\/\/.+/.test(ep)) {
      if (listEl) {
        listEl.innerHTML = "";
        const err = this._win.document.createElement("div");
        err.className = "al-prefs-status error";
        err.textContent = "Please enter and save a valid endpoint URL first.";
        listEl.appendChild(err);
      }
      return;
    }

    if (fetchBtn) { fetchBtn.textContent = "…"; fetchBtn.disabled = true; }
    if (listEl) {
      listEl.innerHTML = "";
      const loading = this._win.document.createElement("div");
      loading.className   = "al-prefs-status info";
      loading.textContent = "Fetching models…";
      listEl.appendChild(loading);
    }

    try {
      const r    = await fetch(ep + "/v1/models", { method: "GET" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const json   = await r.json();
      const models = ((json && json.data) || []).map(m => m.id).filter(Boolean);

      listEl.innerHTML = "";
      if (models.length === 0) {
        const empty = this._win.document.createElement("div");
        empty.className   = "al-prefs-status warn";
        empty.textContent = "⚠ No models returned by the endpoint.";
        listEl.appendChild(empty);
        return;
      }

      const currentModel = this._val("al-prefs-model");
      models.forEach(id => {
        const item = this._win.document.createElement("div");
        item.className = "al-prefs-model-item" + (id === currentModel ? " selected" : "");
        item.innerHTML = `<span class="al-prefs-model-dot"></span><span>${id}</span>`;
        item.addEventListener("click", () => {
          listEl.querySelectorAll(".al-prefs-model-item").forEach(i => {
            i.classList.remove("selected");
          });
          item.classList.add("selected");
          this._set("al-prefs-model", id);
          // Also clear model status
          const mst = this._el("al-prefs-model-status");
          if (mst) { mst.textContent = ""; mst.className = "al-prefs-status"; }
          const mel = this._el("al-prefs-model");
          if (mel) { mel.classList.remove("invalid"); mel.classList.add("valid"); }
        });
        listEl.appendChild(item);
      });
    } catch (e) {
      listEl.innerHTML = "";
      const err = this._win.document.createElement("div");
      err.className   = "al-prefs-status error";
      err.textContent = "✗ Could not fetch models: " + e.message;
      listEl.appendChild(err);
    } finally {
      if (fetchBtn) { fetchBtn.textContent = "↻ Fetch from endpoint"; fetchBtn.disabled = false; }
    }
  },

  // ── Save settings ────────────────────────────────────────────────

  _save() {
    const al         = Zotero.AcademicLens;
    const saveStatus = this._el("al-prefs-save-status");

    const newEp    = this._val("al-prefs-endpoint").trim();
    const newModel = this._val("al-prefs-model").trim();
    const rawTok   = parseInt(this._val("al-prefs-max-tokens-num") || this._val("al-prefs-max-tokens"), 10);
    const newTok   = Math.min(8000, Math.max(100, isNaN(rawTok) ? 800 : rawTok));

    // Validate
    if (!newEp || !/^https?:\/\/.+/.test(newEp)) {
      this._status(saveStatus, "error", "⚠ Endpoint URL is invalid (must start with http:// or https://).");
      return;
    }
    if (!newModel) {
      this._status(saveStatus, "error", "⚠ Model name cannot be empty.");
      return;
    }

    al.endpoint  = newEp;
    al.modelName = newModel;
    al.maxTokens = newTok;
    al.saveSettings();

    // Sync back to any open sidebar inputs
    for (const [win] of al.windows) {
      try {
        const epEl  = win.document.getElementById("al-input-endpoint");
        const mdEl  = win.document.getElementById("al-input-model");
        if (epEl) epEl.value = newEp;
        if (mdEl) mdEl.value = newModel;
      } catch (_) {}
    }

    // Show success, auto-clear after 3 s
    this._status(saveStatus, "success", "✓ Settings saved!");
    if (this._saveTimer) this._win.clearTimeout(this._saveTimer);
    this._saveTimer = this._win.setTimeout(() => {
      const el = this._el("al-prefs-save-status");
      if (el) { el.textContent = ""; el.className = "al-prefs-status"; }
      this._saveTimer = null;
    }, 3000);
  },

  // ── Reset to defaults ────────────────────────────────────────────

  _reset() {
    const al = Zotero.AcademicLens;
    this._set("al-prefs-endpoint",     al.DEFAULT_ENDPOINT);
    this._set("al-prefs-model",        al.DEFAULT_MODEL);
    this._set("al-prefs-max-tokens",   String(al.DEFAULT_MAX_TOKENS));
    this._set("al-prefs-max-tokens-num", String(al.DEFAULT_MAX_TOKENS));
    this._syncTokenDisplay(al.DEFAULT_MAX_TOKENS);

    // Clear validation states
    ["al-prefs-endpoint","al-prefs-model"].forEach(id => {
      const el = this._el(id);
      if (el) { el.classList.remove("valid","invalid"); }
    });
    ["al-prefs-endpoint-status","al-prefs-model-status","al-prefs-tokens-status"].forEach(id => {
      const el = this._el(id);
      if (el) { el.textContent = ""; el.className = "al-prefs-status"; }
    });

    const saveStatus = this._el("al-prefs-save-status");
    this._status(saveStatus, "info", "Fields reset to defaults — click Save to apply.");
  },

  // ── Helpers ──────────────────────────────────────────────────────

  _el(id)     { return this._win && this._win.document.getElementById(id); },
  _val(id)    { const el = this._el(id); return el ? el.value : ""; },
  _set(id, v) { const el = this._el(id); if (el) el.value = v; },
  _on(id, ev, fn) { const el = this._el(id); if (el) el.addEventListener(ev, fn); },

  _status(el, cls, msg) {
    if (!el) return;
    el.className   = "al-prefs-status " + cls;
    el.textContent = msg;
  },
};

