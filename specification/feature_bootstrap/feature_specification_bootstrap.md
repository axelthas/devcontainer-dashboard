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
  path: string;           // Absolute path on host  
  hasDevcontainer: boolean; // True if \`.devcontainer\` folder exists  
  isRunning: boolean;     // True if a container matching this path/project is active  
}

// Represents a Task Workspace (a directory containing multiple repos)  
interface LocalWorkspaceData {  
  id: string;             // Unique identifier (e.g., base64 of path)  
  name: string;           // Folder name (e.g., TASK-4042)  
  path: string;           // Absolute path on host  
  repos: RepositoryData\[\];  
}

// Represents a Bootstrap Preset  
interface BootstrapPreset {  
  id: string;  
  name: string;  
  command: string;        // The full execution string  
}

## **3\. Backend API Additions (SvelteKit Routes)**

The Node.js backend must handle local file system operations and terminal process management.

### **GET /api/workspaces**

* **Action:** Scans the designated "Root Workspace" directory (e.g., /workspaces mapped to the host).  
* **Processing Rules:**  
  1. Read the Root directory to find Task subdirectories.  
  2. For each Task subdirectory, find immediate child subdirectories (Git Repositories).  
  3. Check if a .devcontainer folder exists within each repository directory.  
  4. Cross-reference running Docker containers to determine if a specific repository's devcontainer is currently active (setting isRunning).

### **GET /api/presets**

* **Action:** Returns the saved Bootstrap presets.  
* **Storage:** Can be stored in a local JSON file (e.g., presets.json in the app's persistent volume) or a lightweight local database (SQLite/LowDB).

### **POST /api/presets**

* **Action:** Saves or updates a Bootstrap preset to persistent storage.

### **WebSocket Integration: Terminal Sessions (/api/terminal)**

Due to the interactive, streaming nature of terminals, standard HTTP routes are insufficient. The backend must implement WebSockets (e.g., using ws or socket.io within the SvelteKit Node server) to handle bidirectional communication.

* **Connection:** Frontend establishes a WebSocket connection for a specific terminal session (UUID).  
* **Spawn (node-pty):** The backend uses a library like node-pty to spawn a pseudo-terminal process (e.g., /bin/bash or sh) on the host system.  
* **Data Stream:**  
  * Backend \-\> Frontend: Standard output (stdout/stderr) from the process.  
  * Frontend \-\> Backend: Standard input (stdin) from the user's keystrokes.  
* **Execution:** The backend must be able to accept a specific command string upon session initialization to automatically run scripts (like dev-bootstrap or devcontainer up).

## **4\. Frontend Specification Additions (Svelte 5\)**

### **4.1 Local Workspaces UI (Section 2\)**

* **Structure:** Expandable accordion list. Task Workspaces are headers; expanding reveals child Git Repositories.  
* **Repo Actions:**  
  * If hasDevcontainer is true AND \!isRunning: Show "Build & Start" button.  
  * If hasDevcontainer is true AND isRunning: Show "Active Above" status.  
  * If hasDevcontainer is false: Show "No configuration" status.  
* **Action Handler:** Clicking "Build & Start" requests a new Terminal session from the backend, passing the command devcontainer up \--workspace-folder \<repo.path\>, and automatically opens the Terminal UI to that new tab.

### **4.2 Multi-Tab Terminal UI**

* **State Management:** Maintain an array of active terminal sessions (ID, Name, Logs/Buffer).  
* **Tab Bar:** Horizontal scrollable area. Clicking a tab switches the active view. Includes a \+ button to request a new generic shell session from the backend. Includes an x on non-root tabs to terminate the session/WebSocket.  
* **Terminal View:** A dedicated area for the active session's output. Must auto-scroll to the bottom on new output.  
* **Input:** An input field (or full terminal emulator integration like xterm.js) tied to the active session's WebSocket input stream.

### **4.3 Bootstrap Modal**

* **Fields:** Dropdown for Presets, Text Input for Full Command.  
* **Behavior:**  
  * Selecting a preset populates the Command input.  
  * Editing the Command input switches the dropdown to "Custom".  
  * Clicking "Save as Preset" triggers a save prompt and calls POST /api/presets.  
* **Action Handler:** Clicking "Run in Terminal" requests a new Terminal session from the backend, passing the value of the Command input, and automatically opens the Terminal UI to that new tab.

## **5\. Implementation Plan (For Svelte 5 Integration)**

**Phase 1: Backend File System & Presets API**

1. Implement GET /api/workspaces using Node's fs/promises to read directories and check for .devcontainer folders.  
2. Implement a simple JSON file-backed storage mechanism for Presets.  
3. Create GET and POST routes for /api/presets.

**Phase 2: Frontend State & UI Components (Svelte 5\)**

1. Create the LocalWorkspaces.svelte component (Section 2 UI) and integrate data fetching using Svelte 5 Runes (e.g., $state, $effect).  
2. Update the BootstrapModal.svelte component to fetch presets and handle the simplified Command string logic.

**Phase 3: WebSocket & Pseudo-Terminal Backend (node-pty)**

1. Add node-pty to the project dependencies (Note: Requires native compilation on the host/container).  
2. Configure a WebSocket server alongside the SvelteKit Node adapter.  
3. Implement connection handling: Upon connection, spawn a node-pty instance. Route pty.onData to the WebSocket, and route WebSocket messages to pty.write.

**Phase 4: Frontend Terminal Emulator (xterm.js)**

1. Integrate xterm.js and xterm-addon-fit into the frontend for robust ANSI escape code rendering and standard terminal behavior.  
2. Create a TerminalTab.svelte component that wraps the xterm.js instance and manages the WebSocket connection for a specific session ID.  
3. Create the TerminalManager.svelte component (the drawer) that holds the tab state, tab bar UI, and dynamically renders the active TerminalTab.svelte.

**Phase 5: Wiring Actions**

1. Connect the "Run in Terminal" modal button to trigger the creation of a new tab in TerminalManager, passing the bootstrap command.  
2. Connect the "Build & Start" workspace button to trigger a new tab, passing the devcontainer up command.