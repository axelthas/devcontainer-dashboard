# Build stage
# Use bookworm-slim to match the runtime stage: node-pty needs glibc.
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM ubuntu:noble
ENV DEBIAN_FRONTEND=noninteractive

RUN if id -u ubuntu >/dev/null 2>&1 && [ "$(id -u ubuntu)" = "1000" ]; then \
        userdel -r ubuntu; \
    fi \
    && groupadd --gid 1000 ddash \
    && useradd --uid 1000 --gid 1000 --shell /bin/zsh -m ddash \
    && apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && echo 'ddash ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/ddash \
    && chmod 0440 /etc/sudoers.d/ddash \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends locales \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    openssh-client \
    zsh \
    python3 \
    python3.12-venv \
    python3-pip-whl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -sL https://raw.githubusercontent.com/devcontainers/features/refs/heads/main/src/docker-outside-of-docker/install.sh | bash

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app /opt/dashboard/hooks /home/ddash/.zsh_data \
    && chown ddash:ddash /app /home/ddash/.zsh_data

USER ddash

RUN mkdir -p /home/ddash/.npm-global \
    && npm config set prefix '/home/ddash/.npm-global'
RUN npm install -g npm@latest opencode-ai @devcontainers/cli
RUN GH_NO_UPDATE_NOTIFIER=1 gh extension install github/gh-copilot 2>/dev/null \
    || true
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended
RUN git clone https://github.com/spaceship-prompt/spaceship-prompt.git \
        /home/ddash/.oh-my-zsh/custom/themes/spaceship-prompt --depth=1 \
    && ln -s /home/ddash/.oh-my-zsh/custom/themes/spaceship-prompt/spaceship.zsh-theme \
        /home/ddash/.oh-my-zsh/custom/themes/spaceship.zsh-theme
RUN git clone https://github.com/zsh-users/zsh-autosuggestions \
        /home/ddash/.oh-my-zsh/custom/plugins/zsh-autosuggestions --depth=1 \
    && git clone https://github.com/zsh-users/zsh-syntax-highlighting \
        /home/ddash/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting --depth=1
RUN sed -i 's/^ZSH_THEME=.*/ZSH_THEME="spaceship"/' /home/ddash/.zshrc \
    && sed -i 's/^plugins=.*/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' /home/ddash/.zshrc \
    && printf '\n# npm global binaries\nexport PATH=/home/ddash/.npm-global/bin:$PATH\n' >> /home/ddash/.zshrc \
    && printf '\n# Persistent history (mount a volume at /home/ddash/.zsh_data to retain across restarts)\n' >> /home/ddash/.zshrc \
    && printf 'HISTFILE=/home/ddash/.zsh_data/.zsh_history\nHISTSIZE=10000\nSAVEHIST=10000\n' >> /home/ddash/.zshrc \
    && printf 'setopt APPEND_HISTORY\nsetopt INC_APPEND_HISTORY\nsetopt SHARE_HISTORY\n' >> /home/ddash/.zshrc \
    && printf '\nexport PATH=/home/ddash/.npm-global/bin:$PATH\n' >> /home/ddash/.bashrc

ENV SHELL=/bin/zsh
ENV PATH="/home/ddash/.npm-global/bin:/home/ddash/.local/bin:${PATH}"

USER root
COPY --chown=root:root scripts/10-dev-bootstrap.sh /opt/dashboard/hooks/10-dev-bootstrap.sh
RUN chmod +x /opt/dashboard/hooks/10-dev-bootstrap.sh
COPY --from=builder --chown=ddash:ddash /app/build /app/build
COPY --from=builder --chown=ddash:ddash /app/node_modules /app/node_modules
COPY --from=builder --chown=ddash:ddash /app/package.json /app/package.json
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh
WORKDIR /app
USER ddash
EXPOSE 3000

# Probe the actual custom server. No password, Docker metadata, or shell tools needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD node -e "const r=require('node:http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz'},s=>{s.resume();process.exitCode=s.statusCode===200?0:1});r.setTimeout(3000,()=>r.destroy());r.on('error',()=>process.exitCode=1)"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
