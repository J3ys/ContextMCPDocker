# syntax=docker/dockerfile:1.7

FROM node:20-bookworm-slim AS upstream

ARG CONTEXTMCP_REPO=https://github.com/dodopayments/context-mcp.git
ARG CONTEXTMCP_REF=v0.5.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates patch \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch "${CONTEXTMCP_REF}" "${CONTEXTMCP_REPO}" contextmcp
COPY patches/contextmcp/ /tmp/contextmcp-patches/

WORKDIR /src/contextmcp
RUN for patch_file in /tmp/contextmcp-patches/*.patch; do patch -p1 < "$patch_file"; done
RUN npm ci
RUN npm --prefix deployments/dodopayments/cloudflare-worker install

# Hand-pick only the grammar .wasm files this project actually uses (java,
# typescript, tsx, javascript, python) instead of a large multi-language bundle.
# Sourced directly from the grammar authors' own npm packages, which ship
# compatible prebuilt .wasm files at their package root (dylink.0 format,
# required by web-tree-sitter@0.26.11 — the tree-sitter-wasms bundle's
# .wasm files use the older, incompatible dylink format and fail to load).
# Note: contextmcp uses npm workspaces (packages/cli, packages/template), so
# npm hoists these packages to the repo-root node_modules rather than
# packages/template/node_modules; --ignore-scripts skips their native
# node-gyp postinstall builds, which are unnecessary since we only need the
# prebuilt .wasm files and this environment lacks Python for node-gyp.
RUN npm install --no-save --ignore-scripts --save-exact tree-sitter-java@0.23.5 tree-sitter-typescript@0.23.2 tree-sitter-javascript@0.25.0 tree-sitter-python@0.25.0 \
  && mkdir -p packages/template/grammars \
  && cp node_modules/tree-sitter-java/tree-sitter-java.wasm packages/template/grammars/ \
  && cp node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm packages/template/grammars/ \
  && cp node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm packages/template/grammars/ \
  && cp node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm packages/template/grammars/ \
  && cp node_modules/tree-sitter-python/tree-sitter-python.wasm packages/template/grammars/ \
  && rm -rf node_modules/tree-sitter-java node_modules/tree-sitter-typescript node_modules/tree-sitter-javascript node_modules/tree-sitter-python

RUN rm -rf .git

FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production \
  CONTEXTMCP_ROOT=/app \
  CONTEXTMCP_DEPLOYMENT_DIR=/app/deployments/dodopayments

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=upstream /src/contextmcp/ /app/
COPY config.example.yaml /app/deployments/dodopayments/config.example.yaml
COPY .env.example /app/.env.example
COPY README.md /app/README.md
COPY scripts/entrypoint.sh /app/scripts/entrypoint.sh
COPY scripts/reindex.sh /app/scripts/reindex.sh
COPY scripts/wait-for-http.sh /app/scripts/wait-for-http.sh
COPY config.local-repos-base.yaml /app/config.local-repos-base.yaml
COPY scripts/generate-local-repos-config.sh /app/scripts/generate-local-repos-config.sh

RUN chmod 0755 /app/scripts/entrypoint.sh /app/scripts/reindex.sh /app/scripts/wait-for-http.sh /app/scripts/generate-local-repos-config.sh

EXPOSE 8787

ENTRYPOINT ["/app/scripts/entrypoint.sh"]
CMD ["server"]
