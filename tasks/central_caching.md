The Reality of serve-web Architecture
According to the VS Code maintainers, the web version of VS Code is designed to treat the browser as the user. Because of this, serve-web explicitly ignores the server-side --user-data-dir for all UI-related settings.

Instead of writing your color themes, keybindings, and authentication states to the container's filesystem, the web UI forces all of those "User Settings" into your browser's local IndexedDB.

Because your containers are running on different ports (e.g., 33026, 32960), your browser's Same-Origin Policy treats every single port as a completely isolated environment. Container A literally cannot access the browser database where Container B saved its GitHub login token.

The Ultimate Fix: The "Single Origin" Reverse Proxy
If you want to seamlessly share your login states, themes, and UI customizations across all devcontainers without signing in over and over, you need to trick the browser into thinking all these containers are the exact same website.

You can achieve this by routing all your containers through a single port using a basic reverse proxy (like Caddy, Nginx, or a simple Node script) and utilizing VS Code's --server-base-path flag.

Here is how you would implement it:

1. Update the serve-web command in your containers:
   Append the --server-base-path flag to match the container's project name.

Bash

# Inside polaris-eds container

code serve-web --port 33026 --server-base-path /polaris-eds

# Inside polaris-fdd container

code serve-web --port 32960 --server-base-path /polaris-fdd 2. Set up a Reverse Proxy:
Run a lightweight proxy on your host machine on a single port (e.g., localhost:8080). Configure it to route traffic based on the URL path:

http://localhost:8080/polaris-eds/\* ➔ routes to localhost:33026

http://localhost:8080/polaris-fdd/\* ➔ routes to localhost:32960

3. Access via your Dashboard:
   Update your dashboard links to point to the proxy port (8080) instead of the direct container ports.

Why this works magic:
Because your browser is only ever communicating with http://localhost:8080, it saves all VS Code data to a single, unified IndexedDB instance. You log into GitHub Settings Sync exactly once on localhost:8080. From then on, no matter which container you open through your dashboard, the web UI will pull your unified themes, keybindings, and login tokens instantly, while the extensions remain safely isolated inside their respective containers.
