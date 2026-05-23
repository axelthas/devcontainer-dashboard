# **Feature Specification: Local Workspaces, Terminal & Bootstrap**

## **1\. Feature Overview**

This specification details the addition of three major features to the existing Devcontainer Dashboard SvelteKit application:

1. **Local Workspaces Discovery:** A file-system scanner that displays "Root" and "Task" workspaces, including nested Git repositories and their .devcontainer configuration status.
2. **Multi-Tab Persistent Terminal:** An integrated, interactive terminal UI capable of managing multiple concurrent terminal sessions (both generic shells and dedicated task runners).
3. **Bootstrap Script Execution:** A modal interface utilizing user-defined presets to launch a generic bootstrapping script (dev-bootstrap) directly into a dedicated terminal tab.

## **2\. Updated Data Models**

The backend must provide the following new data structures via the SvelteKit API:

// Represents a Git Repository inside a Task Workspace  
interface RepositoryData {  
 name: string;  
 path: string; // Absolute path on host  
 hasDevcontainer: boolean; // True if \`.devcontainer\` folder exists  
 isRunning: boolean; // True if a container matching this path/project is active  
}

// Represents a Task Workspace (a directory containing multiple repos)  
interface LocalWorkspaceData {  
 id: string; // Unique identifier (e.g., base64 of path)  
 name: string; // Folder name (e.g., TASK-4042)  
 path: string; // Absolute path on host  
 repos: RepositoryData\[\];  
}

// Represents a Bootstrap Preset  
interface BootstrapPreset {  
 id: string;  
 name: string;  
 command: string; // The full execution string  
}

## **3\. Backend API Additions (SvelteKit Routes)**

The Node.js backend must handle local file system operations and terminal process management.

### **GET /api/workspaces**

- **Action:** Scans the "Root Workspace" directory, configured via the `WORKSPACE_ROOT` environment variable (default: `/bootstrap_workspaces`). This directory is bind-mounted from the host machine.
- **Processing Rules:**
  1. Read `WORKSPACE_ROOT` to find immediate child subdirectories — these are **Task Workspaces** (e.g., `TASK-4042`).
  2. For each Task subdirectory, find immediate child subdirectories that contain a `.git` folder — these are **Git Repositories**. Subdirectories without `.git` are skipped.
  3. Check if a `.devcontainer` folder exists within each repository directory (`hasDevcontainer`).
  4. For `isRunning`: compare `repo.path` against the `devcontainer.local_folder` Docker label of all running containers. A repo is considered running if any running container's label value matches.
  5. Task Workspaces with zero qualifying repositories are excluded from the response.

### **GET /api/presets**

- **Action:** Returns the saved Bootstrap presets.
- **Storage:** Stored in a JSON file at a path configured via the `PRESETS_FILE` environment variable (default: `/data/presets.json`). The `docker-compose.yml` must mount a named volume or host directory to `/data` for persistence across container restarts. If the file does not exist on startup, the backend initialises it with an empty array (no crash on first run).

### **POST /api/presets**

- **Action:** Saves or updates a Bootstrap preset to persistent storage.

### **WebSocket Integration: Terminal Sessions (/api/terminal)**

Due to the interactive, streaming nature of terminals, standard HTTP routes are insufficient. The backend must implement WebSockets via a **custom server entry point** — SvelteKit's `build/index.js` manages its own HTTP server and cannot be directly extended.

- **Custom Server Entry (`src/server.ts`):** Must be created to:
  1. Create a Node `http.Server` instance.
  2. Attach the SvelteKit `handler` (from `build/handler.js`) to handle all HTTP requests.
  3. Attach a `ws.Server` to handle WebSocket upgrades on the same port.
  4. The Dockerfile `CMD` must change from `node build/index.js` to `node build/server.js`.
- **Connection:** Frontend establishes a WebSocket connection for a specific terminal session (UUID).
- **Spawn (node-pty):** The backend uses `node-pty` to spawn a pseudo-terminal process (`/bin/bash` or `sh`). **Note:** `node-pty` is a native addon requiring `python3`, `make`, and `g++` at compile time. The Dockerfile build stage must include these tools.
- **Data Stream:**
  - Backend → Frontend: stdout/stderr from the pty process.
  - Frontend → Backend: stdin keystrokes from the user.
- **Execution:** Upon WebSocket connection, an optional `command` parameter triggers automatic script execution (e.g., `dev-bootstrap` or `devcontainer up`). **Prerequisite:** the `devcontainer` CLI must be installed and in PATH for "Build & Start" actions.
- **Session Lifetime:** pty sessions are tied to the WebSocket connection. Navigating away from the page terminates all active processes.

## **4\. Frontend Specification Additions (Svelte 5\)**

### **4.1 Local Workspaces UI (Section 2\)**

- **Structure:** Expandable accordion list. Task Workspaces are headers; expanding reveals child Git Repositories. The section heading displays the configured `WORKSPACE_ROOT` path (e.g., `Local Workspaces (/bootstrap_workspaces)`).
- **Repo Actions:**
  - If hasDevcontainer is true AND \!isRunning: Show "Build & Start" button.
  - If hasDevcontainer is true AND isRunning: Show "Active Above" status.
  - If hasDevcontainer is false: Show "No configuration" status.
- **Action Handler:** Clicking "Build & Start" requests a new Terminal session from the backend, passing the command devcontainer up \--workspace-folder \<repo.path\>, and automatically opens the Terminal UI to that new tab.

### **4.2 Multi-Tab Terminal UI**

- **Layout:** A **bottom-anchored collapsible drawer** within `+page.svelte`. A toggle button in the header shows/hides the drawer. Any action that spawns a terminal (Bootstrap modal, "Build & Start") automatically opens the drawer.
- **Root Terminal:** On first open, a **Root Terminal** tab is automatically created. It spawns a generic shell (`/bin/bash`) with the working directory set to `WORKSPACE_ROOT`. This tab is **permanent and cannot be closed**.
- **State Management:** Maintain an array of active terminal sessions (`{ id, name, socket }`). The Root Terminal is always index 0.
- **Tab Bar:** Horizontal scrollable area. Clicking a tab switches the active view. A `+` button opens a new generic shell session. All tabs except Root Terminal include an `×` button to terminate the session.
- **Terminal View:** Uses **xterm.js** with `xterm-addon-fit` for full ANSI rendering and correct sizing. Must auto-scroll to bottom on new output. The xterm.js `Terminal` instance must be initialised inside a Svelte `$effect` after its DOM container is mounted.
- **Session Lifetime:** pty sessions terminate when the WebSocket closes (tab closed or page navigation).

### **4.3 Bootstrap Modal**

- **Trigger:** A **"Run Bootstrap" button** is placed in the top header of `+page.svelte`, alongside the existing theme toggle. Clicking it opens the modal.
- **Fields:** Dropdown for Presets, Text Input for Full Command.
- **Behavior:**
  - Selecting a preset populates the Command input.
  - Editing the Command input switches the dropdown to "Custom".
  - Clicking "Save as Preset" triggers a save prompt and calls `POST /api/presets`.
- **Action Handler:** Clicking "Run in Terminal" requests a new Terminal session, passing the Command input value, and automatically opens the Terminal drawer to that new tab.

## **5\. Implementation Plan (For Svelte 5 Integration)**

**Phase 0: Infrastructure & Configuration**

1. Update `.devcontainer/devcontainer.json`: add `source=${localEnv:HOME}/git.workspaces,target=/bootstrap_workspaces,type=bind` to `mounts`; add `WORKSPACE_ROOT=/bootstrap_workspaces` to `containerEnv`.
2. Update `docker-compose.yml`: add a bind mount of the host workspaces directory to `/bootstrap_workspaces`; add a named volume for `/data` (preset storage); add env vars `WORKSPACE_ROOT=/bootstrap_workspaces` and `PRESETS_FILE=/data/presets.json`.
3. Create `src/server.ts` — the custom Node entry point that creates `http.Server`, attaches the SvelteKit `handler`, and registers `ws.Server` for WebSocket upgrades.
4. Update `Dockerfile`: add `python3 make g++` to the build stage (required by `node-pty`); change `CMD` to `node build/server.js`.

**Phase 1: Backend File System & Presets API**

1. Implement GET /api/workspaces using Node's fs/promises to read directories and check for .devcontainer folders.
2. Implement a simple JSON file-backed storage mechanism for Presets.
3. Create GET and POST routes for /api/presets.

**Phase 2: Frontend State & UI Components (Svelte 5\)**

1. Create the LocalWorkspaces.svelte component (Section 2 UI) and integrate data fetching using Svelte 5 Runes (e.g., $state, $effect).
2. Update the BootstrapModal.svelte component to fetch presets and handle the simplified Command string logic.

**Phase 3: WebSocket & Pseudo-Terminal Backend (node-pty)**

1. Install `node-pty` and `ws` as production dependencies; add `@types/ws` as a dev dependency.
2. Create `src/lib/server/terminal.ts` to manage WebSocket connections: on connection, spawn a `node-pty` instance, route `pty.onData` to the WebSocket and WebSocket messages to `pty.write`. Support an optional `command` parameter for script execution.
3. Register the WebSocket upgrade handler from `terminal.ts` in `src/server.ts` (created in Phase 0).

**Phase 4: Frontend Terminal Emulator (xterm.js)**

1. Integrate xterm.js and xterm-addon-fit into the frontend for robust ANSI escape code rendering and standard terminal behavior.
2. Create a TerminalTab.svelte component that wraps the xterm.js instance and manages the WebSocket connection for a specific session ID.
3. Create the TerminalManager.svelte component (the drawer) that holds the tab state, tab bar UI, and dynamically renders the active TerminalTab.svelte.

**Phase 5: Wiring Actions**

1. Connect the "Run in Terminal" modal button to trigger the creation of a new tab in TerminalManager, passing the bootstrap command.
2. Connect the "Build & Start" workspace button to trigger a new tab, passing the devcontainer up command.
