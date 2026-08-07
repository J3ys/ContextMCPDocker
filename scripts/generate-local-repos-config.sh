#!/bin/sh
set -eu

# Generates a full ContextMCP config.yaml by appending a `sources:` section
# (built from the LOCAL_DOCS_REPOS env var) to a static base config.
#
# LOCAL_DOCS_REPOS format: comma-separated repo=language pairs, optionally with
# a repo-relative subpath after the language, e.g.
#   CDC=java,Hybris=java:hybris/bin/custom,dgl-gui=typescript
#
# Usage: generate-local-repos-config.sh <base-config-path> <output-config-path>

BASE_CONFIG="${1:?base config path required}"
OUT_CONFIG="${2:?output config path required}"

if [ -z "${LOCAL_DOCS_REPOS:-}" ]; then
  printf 'LOCAL_DOCS_REPOS is empty or unset; no sources were generated.\n' >&2
  printf 'Set LOCAL_DOCS_ROOT and LOCAL_DOCS_REPOS in .env to use local multi-repo indexing.\n' >&2
  exit 1
fi

cp "$BASE_CONFIG" "$OUT_CONFIG"
printf '\nsources:\n' >> "$OUT_CONFIG"

# Split LOCAL_DOCS_REPOS into positional params using IFS=',' exactly once,
# then restore IFS immediately so nothing inside the loop body is affected by
# comma-splitting (word splitting on `for x in $VAR` happens once, up front,
# not per-iteration, so IFS only needs to be ',' for this one line).
old_ifs="$IFS"
IFS=','
set -- $LOCAL_DOCS_REPOS
IFS="$old_ifs"

added=0
for entry in "$@"; do
  [ -z "$entry" ] && continue

  case "$entry" in
    *=*) ;;
    *)
      printf 'Skipping malformed LOCAL_DOCS_REPOS entry (expected repo=language or repo=language:sub/path): %s\n' "$entry" >&2
      continue
      ;;
  esac

  repo="${entry%%=*}"
  language_and_subpath="${entry#*=}"

  # Trim leading/trailing whitespace from repo and language, in case the
  # entry was hand-edited with stray spaces (e.g. " CDC = java ").
  repo="$(printf '%s' "$repo" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  language_and_subpath="$(printf '%s' "$language_and_subpath" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"

  case "$language_and_subpath" in
    *:*)
      language="${language_and_subpath%%:*}"
      repo_subpath="${language_and_subpath#*:}"
      ;;
    *)
      language="$language_and_subpath"
      repo_subpath=""
      ;;
  esac

  language="$(printf '%s' "$language" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
  repo_subpath="$(printf '%s' "$repo_subpath" | sed 's#^[[:space:]]*##; s#[[:space:]]*$##; s#^/*##; s#/*$##')"

  safe_name=$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | sed 's/^-*//; s/-*$//')

  if [ -z "$safe_name" ]; then
    printf 'Skipping LOCAL_DOCS_REPOS entry with no usable name: %s\n' "$entry" >&2
    continue
  fi

  case "$language" in
    java | typescript | javascript | python) ;;
    *)
      printf 'Skipping LOCAL_DOCS_REPOS entry for %s: invalid language "%s" (expected one of: java, typescript, javascript)\n' "$repo" "$language" >&2
      continue
      ;;
  esac

  if [ -n "$repo_subpath" ]; then
    local_path="/workspace/repos/${repo}/${repo_subpath}"
  else
    local_path="/workspace/repos/${repo}"
  fi

  cat >> "$OUT_CONFIG" << SOURCE_EOF
  - name: ${safe_name}
    displayName: "${repo}"
    type: local
    localPath: ${local_path}
    parser: code
    language: ${language}
    optional: true
    skipDirs: *commonSkip
SOURCE_EOF
  added=$((added + 1))
done

if [ "$added" -eq 0 ]; then
  printf 'No valid entries found in LOCAL_DOCS_REPOS: %s\n' "$LOCAL_DOCS_REPOS" >&2
  exit 1
fi
