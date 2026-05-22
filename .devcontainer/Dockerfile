FROM ubuntu:noble

ARG USERNAME=valas
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Remove or rename the default ubuntu user if it exists with UID 1000
RUN if id -u ubuntu >/dev/null 2>&1; then \
        if [ "$(id -u ubuntu)" = "1000" ]; then \
            userdel -r ubuntu; \
        fi; \
    fi \
    # Create our user and group
    && groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    # Add sudo support
    && apt-get update \
    && apt-get install -y sudo \
    && echo $USERNAME ALL=\(root\) NOPASSWD:ALL > /etc/sudoers.d/$USERNAME \
    && chmod 0440 /etc/sudoers.d/$USERNAME

# Avoid interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Set locale. This is important for many tools to work correctly, especially those that handle text processing
# like terminals, git, and npm. It ensures that the environment can handle UTF-8 characters properly.
RUN apt-get update && apt-get install -y locales \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    ca-certificates \
    gnupg \
    git \
    unzip \
    vim \
    zsh \
    build-essential \
    python3 \
    python3.12-venv \
    python3-pip-whl \
    && rm -rf /var/lib/apt/lists/*


# Install Node.js 22 (LTS) via NodeSource
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*


# Set working directory
WORKDIR /workspaces

USER ${USERNAME}

# Configure npm global modules directory for the valas user
RUN mkdir -p /home/${USERNAME}/.npm-global \
    && npm config set prefix "/home/${USERNAME}/.npm-global"

RUN npm install -g npm@latest opencode-ai @devcontainers/cli

# prisma vite vitest svelte @sveltejs/kit create-svelte 

# Install Oh My Zsh for the valas user
RUN sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"

# Install Spaceship theme
RUN git clone https://github.com/spaceship-prompt/spaceship-prompt.git \
        /home/${USERNAME}/.oh-my-zsh/custom/themes/spaceship-prompt --depth=1 \
    && ln -s /home/${USERNAME}/.oh-my-zsh/custom/themes/spaceship-prompt/spaceship.zsh-theme \
        /home/${USERNAME}/.oh-my-zsh/custom/themes/spaceship.zsh-theme

# Install zsh plugins
RUN git clone https://github.com/zsh-users/zsh-autosuggestions \
        /home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-autosuggestions --depth=1 \
    && git clone https://github.com/zsh-users/zsh-syntax-highlighting \
        /home/${USERNAME}/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting --depth=1

# Configure .zshrc: theme, plugins, and history persistence
RUN sed -i 's/^ZSH_THEME=.*/ZSH_THEME="spaceship"/' /home/${USERNAME}/.zshrc \
    && sed -i 's/^plugins=.*/plugins=(git zsh-autosuggestions zsh-syntax-highlighting)/' /home/${USERNAME}/.zshrc \
    && echo '' >> /home/${USERNAME}/.zshrc \
    && echo '# Persistent history settings' >> /home/${USERNAME}/.zshrc \
    && echo 'HISTFILE=/home/'"${USERNAME}"'/.zsh_data/.zsh_history' >> /home/${USERNAME}/.zshrc \
    && echo 'HISTSIZE=10000' >> /home/${USERNAME}/.zshrc \
    && echo 'SAVEHIST=10000' >> /home/${USERNAME}/.zshrc \
    && echo 'setopt APPEND_HISTORY' >> /home/${USERNAME}/.zshrc \
    && echo 'setopt INC_APPEND_HISTORY' >> /home/${USERNAME}/.zshrc \
    && echo 'setopt SHARE_HISTORY' >> /home/${USERNAME}/.zshrc

RUN echo 'export PATH=/home/${USERNAME}/.npm-global/bin:$PATH' >> /home/${USERNAME}/.bashrc \
    && echo 'export PATH=/home/${USERNAME}/.npm-global/bin:$PATH' >> /home/${USERNAME}/.zshrc