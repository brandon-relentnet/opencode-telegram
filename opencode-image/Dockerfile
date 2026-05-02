# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim

# CLI tools opencode benefits from + LSP runtimes for the languages
# typescript-language-server runs on Node (already present)
# pyright runs on Node (installed via npm)
# gopls and rust-analyzer are language-specific; install only if needed
ARG INSTALL_GO_LSP=false
ARG INSTALL_RUST_LSP=false

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      openssh-client \
      ripgrep \
      fd-find \
      jq \
      build-essential \
      python3 \
      python3-pip \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# opencode CLI + Node-based LSPs
RUN npm install -g \
      opencode-ai \
      typescript \
      typescript-language-server \
      pyright

# Optional: Go LSP
RUN if [ "$INSTALL_GO_LSP" = "true" ]; then \
      apt-get update \
        && apt-get install -y --no-install-recommends golang-go \
        && rm -rf /var/lib/apt/lists/* \
        && go install golang.org/x/tools/gopls@latest \
        && cp /root/go/bin/gopls /usr/local/bin/gopls; \
    fi

# Optional: Rust LSP (large; ~250MB)
RUN if [ "$INSTALL_RUST_LSP" = "true" ]; then \
      apt-get update \
        && apt-get install -y --no-install-recommends rust-analyzer cargo rustc \
        && rm -rf /var/lib/apt/lists/*; \
    fi

# Persist auth and session history at /root/.local/share/opencode (volume)
# Persist config at /root/.config/opencode (volume)
RUN mkdir -p /root/.local/share/opencode /root/.config/opencode /workspace
COPY opencode-config.json /root/.config/opencode/config.json

WORKDIR /workspace

EXPOSE 4096
CMD ["opencode", "serve", "--hostname", "0.0.0.0", "--port", "4096"]
