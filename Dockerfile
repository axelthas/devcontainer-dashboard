# Build stage
# Use bookworm-slim to match the runtime stage — node-pty has native bindings that must
# be compiled against the same libc (glibc) as the image that will run them.
FROM node:22-bookworm-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm run build:server

# Run stage
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

# ── System setup (root) ────────────────────────────────────────────────────────

# Create the ddash user with sudo access
RUN groupadd --gid 1000 ddash \
    && useradd --uid 1000 --gid 1000 --shell /bin/zsh -m ddash \
    && apt-get update \
    && apt-get install -y --no-install-recommends sudo \
    && echo 'ddash ALL=(root) NOPASSWD:ALL' > /etc/sudoers.d/ddash \
    && chmod 0440 /etc/sudoers.d/ddash \
    && rm -rf /var/lib/apt/lists/*

# Configure locale
RUN apt-get update && apt-get install -y --no-install-recommends locales \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Install system packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    git \
    openssh-client \
    zsh \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI (required for gh copilot extension and useful for AI sessions)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
        | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
        > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Prepare directories owned by ddash
RUN mkdir -p /app /opt/dashboard/hooks /home/ddash/.zsh_data \
    && chown ddash:ddash /app /home/ddash/.zsh_data

# ── User setup (ddash) ────────────────────────────────────────────────────────

USER ddash

# Configure npm global modules directory in the user's home
RUN mkdir -p /home/ddash/.npm-global \
    && npm config set prefix '/home/ddash/.npm-global'

# Install global npm tools: AI tools + devcontainer CLI
RUN /home/ddash/.npm-global/bin/npm install -g npm@latest \
    && /home/ddash/.npm-global/bin/npm install -g opencode-ai @devcontainers/cli

# Install GitHub Copilot CLI extension.
# Fails gracefully so a transient network issue doesn't break the build.
RUN GH_NO_UPDATE_NOTIFIER=1 gh extension install github/gh-copilot \
    || echo "[WARN] gh copilot extension install failed — run 'gh extension install github/gh-copilot' manually"

# Install Oh My Zsh (--unattended skips the chsh prompt and auto-zsh launch)
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)" "" --unattended

# Install Spaceship prompt theme
RUN git clone https://github.com/spaceship-prompt/spaceship-prompt.git \
        /home/ddash/.oh-my-zsh/custom/themes/spaceship-prompt --depth=1 \
    && ln -s /home/ddash/.oh-my-zsh/custom/themes/spaceship-prompt/spaceship.zsh-theme \
        /home/ddash/.oh-my-zsh/custom/themes/spaceship.zsh-theme

# Install zsh plugins
RUN git clone https://github.com/zsh-users/zsh-autosuggestions \
        /home/ddash/.oh-my-zsh/custom/plugins/zsh-autosuggestions --depth=1 \
    && git clone https://github.com/zsh-users/zsh-syntax-highlighting \
        /home/ddash/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting --depth=1

# Configure .zshrc: theme, plugins, PATH, persistent history
RUN sed -i 's/^ZSH_THEME=.*/ZSH_THEME="spaceship"/' /home/ddash/.zshrc \
    && sed -i 's/^plugins=.*/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' /home/ddash/.zshrc \
    && printf '\n# npm global binaries\nexport PATH=/home/ddash/.npm-global/bin:$PATH\n' >> /home/ddash/.zshrc \
    && printf '\n# Persistent history (mount a volume at /home/ddash/.zsh_data to retain across restarts)\n' >> /home/ddash/.zshrc \
    && printf 'HISTFILE=/home/ddash/.zsh_data/.zsh_history\nHISTSIZE=10000\nSAVEHIST=10000\n' >> /home/ddash/.zshrc \
    && printf 'setopt APPEND_HISTORY\nsetopt INC_APPEND_HISTORY\nsetopt SHARE_HISTORY\n' >> /home/ddash/.zshrc \
    && printf '\nexport PATH=/home/ddash/.npm-global/bin:$PATH\n' >> /home/ddash/.bashrc

# Tell the dashboard terminal which shell to spawn (read by terminal.ts)
ENV SHELL=/bin/zsh

# ── Application artifacts (root for COPY, back to ddash for CMD) ───────────────

USER root

# Bundle the dev-bootstrap setup hook. Activate it by mounting into /docker-entrypoint.d/:
#   volumes:
#     - /opt/dashboard/hooks/10-dev-bootstrap.sh:/docker-entrypoint.d/10-dev-bootstrap.sh:ro
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

CMD ["sh", "docker-entrypoint.sh"]
