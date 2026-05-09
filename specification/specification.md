# **Software Specification: Devcontainer Dashboard**

## **1\. Project Overview**

The **Devcontainer Dashboard** is a local web application designed to manage and monitor local Docker containers. It provides a visual interface to quickly access exposed services (like VSCode, NoVNC, databases, and web servers) and perform basic container lifecycle actions (start, stop, restart).

The UI explicitly separates "Devcontainers" (primary focus) from "Sandbox Services" (supporting local infrastructure) and uses the Nord color palette with Light/Dark mode support.

## **2\. Technology Stack**

* **Framework:** SvelteKit (Full-stack: handles both SSR/frontend and backend API routes)  
* **Language:** TypeScript  
* **Styling:** Tailwind CSS (with arbitrary value support for Nord hex codes)  
* **Icons:** lucide-svelte  
* **Docker Integration:** dockerode (Node.js Docker API client)  
* **Deployment:** Dockerized (Node.js Alpine image) with a mounted host docker socket.

## **3\. Data Models**

The frontend expects the following data structure from the SvelteKit API:

interface ServicePort {  
  containerPort: string;  
  hostPort: string;  
}

interface ContainerData {  
  id: string;             // Truncated or full container ID  
  name: string;           // Raw container name  
  projectName: string;    // Cleaned up name for display  
  state: 'running' | 'exited' | 'created' | string; // Docker container state  
  isDevcontainer: boolean; // True if name/image contains 'vsc-' or 'devcontainer'  
  ports: Record\<string, string\>; // Key: container port, Value: host port  
}

## **4\. Backend API Specification (SvelteKit Routes)**

The backend will be implemented using SvelteKit server routes (+server.ts). It must interact with /var/run/docker.sock via dockerode.

### **GET /api/containers**

* **Action:** Fetches all containers (both running and stopped) using docker.listContainers({ all: true }).  
* **Processing Rules:**  
  1. **Filter:** Exclude any containers that have *no* exposed host ports.  
  2. **Mapping:** Extract the NetworkSettings.Ports or equivalent from the container data to map container ports to host ports.  
  3. **Identification:** Determine isDevcontainer. Logic: Check if the container name or image name includes standard Devcontainer prefixes/suffixes (e.g., vsc-, \-features).  
  4. **Project Name:** Strip boilerplate text (like vsc-, \-uid, \-features) from the container name to create a cleaner projectName.

### **POST /api/containers/\[id\]/\[action\]**

* **Parameters:** id (container ID), action (start, stop, restart).  
* **Action:** Executes the corresponding command via dockerode (container.start(), etc.).  
* **Response:** Success boolean. The frontend will then refetch /api/containers to update state.

## **5\. Frontend Specification**

### **5.1 Layout & Structure**

* **Header:** Title, Quick Stats (Running/Stopped counts), Theme Toggle (Sun/Moon).  
* **Section 1: Devcontainers:** Displayed as a responsive Grid (grid-cols-1 md:grid-cols-2 xl:grid-cols-3). Uses large cards.  
* **Section 2: Sandbox Services:** Displayed as a condensed vertical list/table for density.  
* **Sorting:** Within each section, running containers must appear before exited containers.

### **5.2 Theming (Nord Palette)**

The application must use the following Nord hex codes via Tailwind arbitrary values (e.g., bg-\[\#2e3440\]).

* **Dark Mode Base:** Background \#2e3440, Surface \#3b4252 & \#434c5e, Text \#d8dee9 & \#eceff4.  
* **Light Mode Base:** Background \#eceff4, Surface \#e5e9f0 & white, Text \#2e3440 & \#4c566a.  
* **Accents (Both Modes):**  
  * Green (Running/Play): \#a3be8c  
  * Red (Stopped/Stop): \#bf616a  
  * Yellow/Orange (Restart): \#ebcb8b / \#d08770  
  * Blue/Frost (Icons/Brand): \#5e81ac, \#81a1c1, \#88c0d0, \#8fbcbb

### **5.3 Service Port Mapping Logic**

The frontend must map specific ports to UI labels, lucide-svelte icons, and specific Nord color combinations.

* 6904 \-\> "NoVNC" (Monitor Icon)  
* 4096 \-\> "OpenCode" (Code Icon)  
* 9001 \-\> "Supervisor" (Activity Icon)  
* 8000 \-\> "VSCode" (Terminal Icon)  
* 5432 / 3306 \-\> "Database" (Database Icon)  
* 6379 \-\> "Redis" (Database Icon)  
* 80 / 443 / 8080 \-\> "Web" (Globe Icon)

*Fallback:* Any unrecognized port should render generically as "Port \[Number\]" using a Server icon.

### **5.4 Interactions**

* **Service Buttons:** Clicking a mapped service button should open http://localhost:\<hostPort\> in a new tab. If the container is not running, the button must be disabled (visually dimmed, cursor-not-allowed).  
* **Action Buttons:** Start/Stop/Restart buttons should trigger the corresponding POST API route and set a loading state until the action completes and the container list refreshes.

## **6\. Deployment / Docker Configuration**

The application must be packaged as a Docker container so it can run alongside the devcontainers.

### **Dockerfile**

A standard Node.js multi-stage build.

1. **Build Stage:** npm install, npm run build (using @sveltejs/adapter-node).  
2. **Run Stage:** Copy the build output, expose port 3000, run node build/index.js.

### **docker-compose.yml**

version: '3.8'  
services:  
  dashboard:  
    build: .  
    ports:  
      \- "3000:3000"  
    volumes:  
      \- /var/run/docker.sock:/var/run/docker.sock \# CRITICAL for dockerode access  
    restart: unless-stopped

## **7\. Implementation Plan (For AI Generation)**

**Phase 1: Project Initialization**

1. Scaffold a new SvelteKit skeleton project (npm create svelte@latest).  
2. Install Tailwind CSS, lucide-svelte, and dockerode (plus @types/dockerode).  
3. Configure SvelteKit to use @sveltejs/adapter-node.

**Phase 2: Backend Development (+server.ts routes)**

1. Create a docker.ts utility file to initialize the dockerode client.  
2. Implement GET /api/containers with mapping, filtering (no-port exclusion), and isDevcontainer logic.  
3. Implement POST /api/containers/\[id\]/\[action\] for start/stop/restart commands.

**Phase 3: Frontend State & Theming**

1. Create a layout (+layout.svelte) that manages the global light/dark mode state (Nord themes).  
2. Fetch container data in \+page.server.ts or \+page.ts to ensure fast initial load, and set up an interval to poll for updates (e.g., every 5 seconds).

**Phase 4: Component Construction**

1. Build ServiceButton.svelte (handles port mapping logic, icons, and Nord coloring).  
2. Build ActionControls.svelte (handles API calls to start/stop/restart).  
3. Build DevcontainerCard.svelte (for Section 1).  
4. Build SandboxRow.svelte (for Section 2).

**Phase 5: Assembly & Refinement**

1. Assemble the components in \+page.svelte, applying the sorting logic and the dual-section layout.  
2. Ensure responsive design using Tailwind breakpoints.  
3. Test loading states and empty states.  
4. Provide the final Dockerfile and docker-compose.yml.