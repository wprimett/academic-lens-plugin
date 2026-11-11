# Academic Lens - Zotero 7 Add-on

 A lightweight, local-first Zotero 7 add-on that enables evidence-grounded chat over selected research documents over a self-hosted model.

---

## 1. Documentation & Terminology Guide


## 2. Features

- **Private & Configurable:** Communicates directly with your OpenAI-compatible endpoint (`http://127.0.0.1:18181/v1/chat/completions`), keeping your library data private.
- **Drag-and-Drop Ingestion:** Drag articles directly from your Zotero library table into the Academic Lens sidebar.
- **One-Click Add:** Quickly add all currently highlighted items with the **+ Add Selected** button.
- **Real-Time Streaming:** Streams responses token-by-token directly from local Qwen.
- **Text Cleaning & Citation Formatting:** Ported directly from `app.py`:
  - Strips bracketed in-text references from source abstracts to prevent collisions.
  - Automatically replaces `[[1]]`, `[[2]]` with clean `(Author, Year)` citation badges.
  - Formats bullet points with clean `•` bullets.
  - Extracts and renders `|CONFIDENCE|score|` badges (High / Medium / Low).
  - Handles UTF-8 mojibake cleanups.
- **Zero Heavy Dependencies:** No external npm packages, Supabase, or cloud dependencies required.

---

## 3. Minimum System Requirements (Local LLM: `llama3.2:3b`)

To run `llama3.2:3b` (`Llama-3.2-3B-Instruct-Q4_K_M`, ~2.0 GB 4-bit quantized) locally alongside Zotero 7:

| Component | Minimum Requirement (CPU / Integrated) |
| :--- | :--- |
| **System RAM** | **8 GB RAM** (~3 GB free for model weights + KV cache) |
| **GPU / VRAM** | Not required (runs on CPU) |
| **CPU** | 4-core modern x86_64 (AVX2 support) or ARM64 |
| **Disk Space** | **3 GB free** (~2.0 GB for `llama3.2:3b` weights + runtime) |
| **Software** | Zotero 7.0+ |

---

## 4. Installation in Zotero 7

### Method A: Install the pre-built `.xpi` (Easiest)
1. Open **Zotero 7**.
2. Go to **Tools** → **Plugins** (or **Add-ons**).
3. Click the **Gear icon (⚙)** in the top right corner and select **"Install Add-on From File..."**.
4. Select `academic-lens.xpi` (located in this directory or the root directory).
5. Click **Install**, then restart Zotero if prompted.

### Method B: Developer Mode (Live Editing)
1. Open your Zotero profile folder:
   - Linux: `~/.zotero/zotero/<profile-dir>/extensions/`
   - macOS: `~/Library/Application Support/Zotero/Profiles/<profile-dir>/extensions/`
   - Windows: `%APPDATA%\Zotero\Zotero\Profiles\<profile-dir>\extensions\`
2. In the `extensions/` directory, create a text file named:
   ```
   academic-lens@ut.ee
   ```
3. Inside that file, write the absolute path to this folder:
   ```
   /var/www/RAG-Qwen3VL-Test/academic-lens-zotero
   ```
4. Restart Zotero.

---

## 5. Usage

### AcademicLens Endpoint

Academic Lens is intended to work with locally hosted models which can run on consumer-level hardware (i.e. the computer you are already using may already be enough). An endpoint is required for the application to send requests to the model. These requests include prompts, files and embeddings.

The `AcademicLensEndpoint` executable is recommended as a click-and-play background application to serve the model locally. This needs to run separately alongside to use Zotero + AcademicLens plugin and should be closed when not in use.

1. **Ensure your endpoint is running:**
   ```bash
   # Default endpoint: http://77.42.92.200:18181/
   # Default model: Llama-3.2-3B-Instruct-Q4_K_M
   ```
2. **Open Academic Lens:**
   - Click the **Academic Lens** toggle button in the Zotero tabs toolbar (next to the Sync button).
   - The sidebar opens on the right side of the library pane.
3. **Add papers to context:**
   - **Option 1:** Drag any item from your Zotero library and drop it into the drop zone.
   - **Option 2:** Select one or more items in the library table and click **+ Add Selected**.
4. **Chat:**
   - Type your question in the composer box (e.g., *"Summarize the core methodologies of these papers"*).
   - Press **Enter** or click **Send**.
   - Watch the answer stream with citations `(Author, Year)` and a confidence assessment badge.
5. **Settings:**
   - Click the **Gear (⚙)** icon in the header to change the endpoint URL or model name, or click **Test Endpoint** to check connectivity.

---

## 6. Rebuilding the Add-on

To pack the add-on into a new `.xpi` after making code changes:
```bash
node build.mjs
```
This produces `academic-lens.xpi` using pure built-in Node.js.
