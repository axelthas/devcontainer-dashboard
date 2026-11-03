# node-pty requires glibc in both stages.
FROM node:22-bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM ubuntu:noble
ENV DEBIAN_FRONTEND=noninteractive
RUN if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
    && apt-get update && apt-get install -y --no-install-recommends \
       curl ca-certificates git openssh-client zsh python3 python3.12-venv \
       python3-pip-whl locales util-linux passwd sudo \
    && locale-gen en_US.UTF-8 && rm -rf /var/lib/apt/lists/*
ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8
RUN curl -sL https://raw.githubusercontent.com/devcontainers/features/refs/heads/main/src/docker-outside-of-docker/install.sh | bash
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
ENV NPM_CONFIG_PREFIX=/opt/dashboard-tools
ENV PATH="/opt/dashboard-tools/bin:${PATH}"
RUN npm install -g npm@latest opencode-ai @devcontainers/cli
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
COPY scripts/10-dev-bootstrap.sh /opt/dashboard/hooks/10-dev-bootstrap.sh
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh /opt/dashboard/hooks/10-dev-bootstrap.sh \
    && mkdir -p /data /dashboard-history
USER root
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "const r=require('node:http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz'},s=>{s.resume();process.exitCode=s.statusCode===200?0:1});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exitCode=1)"
ENTRYPOINT ["/app/docker-entrypoint.sh"]
