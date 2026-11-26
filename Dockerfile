# Build the pinned OpenChamber frontend with a small, hash-checked draft-launch patch.
# Its server remains the official npm package. No minified assets are rewritten.
FROM oven/bun:1.4.4 AS openchamber-ui
USER root
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates tar \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /source
RUN curl -fsSL https://codeload.github.com/openchamber/openchamber/tar.gz/c075210f9a67d45701281c3cdd150e9db9f480af \
    | tar -xz --strip-components=1
COPY scripts/patch-openchamber.mjs /dashboard/scripts/patch-openchamber.mjs
COPY integrations/openchamber/dashboard-launch.ts /dashboard/integrations/openchamber/dashboard-launch.ts
RUN bun /dashboard/scripts/patch-openchamber.mjs /source \
    && bun install --frozen-lockfile --ignore-scripts \
    && bun run --cwd packages/sdk build \
    && bun run build:web

# Use the same Node distribution for native module builds and the runtime.
FROM node:24-bookworm-slim AS node-base
FROM node-base AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM ubuntu:noble
ENV DEBIAN_FRONTEND=noninteractive
RUN set -eu; \
    if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi; \
    printf '%s\n' 'Acquire::Retries "3";' 'APT::Update::Error-Mode "any";' \
      > /etc/apt/apt.conf.d/80-devharbour-retries; \
    for delay in 5 15 0; do \
      if apt-get update; then break; fi; \
      if [ "$delay" = 0 ]; then exit 1; fi; \
      sleep "$delay"; \
    done; \
    apt-get install -y --no-install-recommends \
       curl ca-certificates git openssh-client zsh python3 python3.12-venv \
       python3-pip-whl locales util-linux passwd sudo which tar make g++; \
    locale-gen en_US.UTF-8; \
    rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
# The feature installer sources a sibling helper. Keep both files at one reviewed
# revision and execute a file, not stdin, so BASH_SOURCE resolves that helper.
RUN set -eu; \
    feature_revision=b6877129e0a264b8e83a63e8b93de29077132e5b; \
    feature_dir="$(mktemp -d)"; \
    mkdir -p "$feature_dir/scripts"; \
    curl -fsSL "https://raw.githubusercontent.com/devcontainers/features/${feature_revision}/src/docker-outside-of-docker/install.sh" \
      -o "$feature_dir/install.sh"; \
    curl -fsSL "https://raw.githubusercontent.com/devcontainers/features/${feature_revision}/src/docker-outside-of-docker/scripts/version-resolution.sh" \
      -o "$feature_dir/scripts/version-resolution.sh"; \
    bash "$feature_dir/install.sh"; \
    rm -rf "$feature_dir"
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
COPY --from=node-base /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
    && node --version && npm --version
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_PREFIX=/opt/dashboard-tools
ENV PATH="/opt/dashboard-tools/bin:${PATH}"
ARG OPENCODE_VERSION=2.3.0
ARG OPENCHAMBER_VERSION=2.7.1
# Seed a user-writable persistent installation at runtime, as dev-bootstrap does.
RUN set -eu; \
    test "$OPENCHAMBER_VERSION" = 2.7.1; \
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);if(a<24||(a===24&&b<14))process.exit(1)'; \
    npm install -g npm@latest @devcontainers/cli "@openchamber/web@${OPENCHAMBER_VERSION}"; \
    curl -fsSL https://opencode.ai/v2/install -o /tmp/install-opencode; \
    HOME=/tmp/opencode-seed SHELL=/bin/bash bash /tmp/install-opencode --version "$OPENCODE_VERSION" --no-modify-path; \
    version="$(/tmp/opencode-seed/.opencode/bin/opencode --version)"; \
    printf 'Installed OpenCode: %s\n' "$version"; \
    version="${version##* }"; version="${version#v}"; \
    test "$version" = "$OPENCODE_VERSION"; \
    mkdir -p /opt/dashboard-ai; \
    cp /tmp/opencode-seed/.opencode/bin/opencode /opt/dashboard-ai/opencode; \
    rm -rf /tmp/opencode-seed /tmp/install-opencode
RUN git clone --depth=1 https://github.com/ohmyzsh/ohmyzsh.git /opt/dashboard-shell \
    && git clone --depth=1 https://github.com/spaceship-prompt/spaceship-prompt.git /opt/dashboard-shell/custom/themes/spaceship-prompt \
    && ln -s /opt/dashboard-shell/custom/themes/spaceship-prompt/spaceship.zsh-theme /opt/dashboard-shell/custom/themes/spaceship.zsh-theme \
    && git clone --depth=1 https://github.com/zsh-users/zsh-autosuggestions /opt/dashboard-shell/custom/plugins/zsh-autosuggestions \
    && git clone --depth=1 https://github.com/zsh-users/zsh-syntax-highlighting /opt/dashboard-shell/custom/plugins/zsh-syntax-highlighting \
    && printf '%s\n' \
      'export ZSH=/opt/dashboard-shell' \
      'ZSH_THEME="spaceship"' \
      'plugins=(git zsh-autosuggestions zsh-syntax-highlighting)' \
      'export ZSH_COMPDUMP="$HOME/.zcompdump"' \
      'source "$ZSH/oh-my-zsh.sh"' \
      'export HISTFILE=/dashboard-history/.zsh_history' \
      'HISTSIZE=10000' 'SAVEHIST=10000' \
      'setopt APPEND_HISTORY INC_APPEND_HISTORY SHARE_HISTORY' \
      > /opt/dashboard-shell/.zshrc \
    && printf '%s\n' 'export PATH="/opt/dashboard-tools/bin:$PATH"' > /opt/dashboard-shell/.bashrc
WORKDIR /app
COPY --from=builder /app/build /app/build
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY scripts/devcontainer-agent.mjs /app/scripts/devcontainer-agent.mjs
# Settings reuses Python validation and the same host-CLI lock, never a second writer.
COPY scripts/devharbour*.py scripts/devharbour.schema.json scripts/run-dashboard.sh /app/scripts/
COPY --from=openchamber-ui /source/packages/web/dist /opt/openchamber-dist
ENV OPENCHAMBER_DIST_DIR=/opt/openchamber-dist
COPY plugins/tern-dev-bootstrap.sh /opt/dashboard/plugins/tern-dev-bootstrap.sh
COPY scripts/ai-state.sh /opt/dashboard-ai/state.sh
COPY scripts/opencode.sh /opt/dashboard-tools/bin/opencode
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh /opt/dashboard/plugins/tern-dev-bootstrap.sh \
       /opt/dashboard-ai/state.sh /opt/dashboard-tools/bin/opencode \
    && mkdir -p /data /dashboard-history /dashboard-ai
ENV AI_ENABLED=0
USER root
EXPOSE 3000 3002
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "const r=require('node:http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz'},s=>{s.resume();process.exitCode=s.statusCode===200?0:1});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exitCode=1)"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
