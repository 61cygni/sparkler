#!/usr/bin/env bash
set -euo pipefail

# Keep this script in sync with public/setup.sh, which is served by the hosted app.

SPARKLER_GITHUB_REPO="${SPARKLER_GITHUB_REPO:-61cygni/sparkler}"
SPARKLER_GITHUB_REF="${SPARKLER_GITHUB_REF:-main}"
INSTALL_ROOT_DIR="${SPARKLER_ROOT_DIR:-$PWD}"
CONFIG_HOME_DIR="${XDG_CONFIG_HOME:-${INSTALL_ROOT_DIR}/.config}"
SPARKLER_CONFIG_DIR="${CONFIG_HOME_DIR}/sparkler"
SPARKLER_CONFIG_FILE="${SPARKLER_CONFIG_DIR}/config.json"
SPARKLER_INSTALL_DIR="${SPARKLER_INSTALL_DIR:-${INSTALL_ROOT_DIR}/.sparkler}"
SPARKLER_BIN_DIR="${SPARKLER_BIN_DIR:-${INSTALL_ROOT_DIR}/bin}"
SPARKLER_NPM_CACHE_DIR="${SPARKLER_NPM_CACHE_DIR:-${INSTALL_ROOT_DIR}/.npm-cache}"

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

trim() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

detect_platform() {
  local os_raw arch_raw os arch
  os_raw="$(uname -s)"
  arch_raw="$(uname -m)"

  case "$os_raw" in
    Darwin) os="macOS" ;;
    Linux) os="Linux" ;;
    *) fail "Unsupported OS: ${os_raw}. Sparkler setup currently supports macOS and Linux." ;;
  esac

  case "$arch_raw" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) arch="$arch_raw" ;;
  esac

  say "Detected platform: ${os} (${arch})"
}

node_install_hint() {
  local os_raw
  os_raw="$(uname -s)"
  case "$os_raw" in
    Darwin)
      say "Install Node 18+ first. Good options:"
      say "  - https://nodejs.org/"
      say "  - brew install node"
      say "  - https://github.com/nvm-sh/nvm"
      ;;
    Linux)
      say "Install Node 18+ first. Good options:"
      say "  - https://nodejs.org/"
      say "  - https://github.com/nvm-sh/nvm"
      say "  - your distro package manager"
      ;;
    *)
      say "Install Node 18+ from https://nodejs.org/"
      ;;
  esac
}

ensure_prereqs() {
  if ! command_exists node; then
    node_install_hint
    fail "Node.js is required before Sparkler can be installed."
  fi
  if ! command_exists curl; then
    fail "curl is required before Sparkler can be installed."
  fi
  if ! command_exists tar; then
    fail "tar is required before Sparkler can be installed."
  fi
  if ! command_exists npm; then
    fail "npm is required before Sparkler can be installed."
  fi

  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "${major}" -lt 18 ]; then
    fail "Node.js 18+ is required. Found: $(node -v)"
  fi

  say "Node version: $(node -v)"
  say "npm version: $(npm -v)"
}

source_archive_url() {
  printf 'https://github.com/%s/archive/%s.tar.gz' \
    "$SPARKLER_GITHUB_REPO" "$SPARKLER_GITHUB_REF"
}

install_cli() {
  local url tmp_root archive_path unpack_root extracted_root cli_dir
  url="$(source_archive_url)"
  tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/sparkler-install-XXXXXX")"
  archive_path="${tmp_root}/sparkler-source.tar.gz"
  unpack_root="${tmp_root}/unpacked"

  say "Downloading Sparkler source from GitHub ..."
  say "Source: ${url}"
  curl -fsSL "$url" -o "$archive_path"

  mkdir -p "$unpack_root"
  tar -xzf "$archive_path" -C "$unpack_root"
  extracted_root="$(find "$unpack_root" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "${extracted_root}" ]; then
    rm -rf "$tmp_root"
    fail "Could not unpack the Sparkler source archive."
  fi

  cli_dir="${extracted_root}/packages/cli"
  if [ ! -f "${cli_dir}/package.json" ]; then
    rm -rf "$tmp_root"
    fail "Expected packages/cli/package.json in the downloaded Sparkler source."
  fi

  say "Installing CLI dependencies locally ..."
  npm install --prefix "$cli_dir" --cache "$SPARKLER_NPM_CACHE_DIR"

  mkdir -p "$(dirname "$SPARKLER_INSTALL_DIR")"
  rm -rf "$SPARKLER_INSTALL_DIR"
  mv "$cli_dir" "$SPARKLER_INSTALL_DIR"
  rm -rf "$tmp_root"

  write_launcher

  if ! "${SPARKLER_BIN_DIR}/sparkler" --help >/dev/null 2>&1; then
    fail "Sparkler installed, but 'sparkler --help' did not succeed."
  fi
}

write_launcher() {
  mkdir -p "$SPARKLER_BIN_DIR"
  cat >"${SPARKLER_BIN_DIR}/sparkler" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export XDG_CONFIG_HOME="\${XDG_CONFIG_HOME:-${CONFIG_HOME_DIR}}"
exec node "${SPARKLER_INSTALL_DIR}/bin/sparkler.mjs" "\$@"
EOF
  chmod +x "${SPARKLER_BIN_DIR}/sparkler"
}

prompt_value() {
  local label default reply
  label="$1"
  default="$2"
  if [ ! -r /dev/tty ]; then
    printf '%s' "$default"
    return
  fi

  if [ -n "$default" ]; then
    printf '%s [%s]: ' "$label" "$default" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  IFS= read -r reply </dev/tty
  reply="$(trim "$reply")"
  if [ -z "$reply" ]; then
    reply="$default"
  fi
  printf '%s' "$reply"
}

infer_convex_cloud_url() {
  local deployment_url trimmed
  deployment_url="$1"
  trimmed="${deployment_url%/}"
  if printf '%s' "$trimmed" | grep -q '\.convex\.site$'; then
    printf '%s' "${trimmed%.convex.site}.convex.cloud"
    return
  fi
  printf '%s' ""
}

write_config() {
  local deployment_url convex_url site_url
  deployment_url="$(trim "${SPARKLER_DEPLOYMENT_URL:-}")"
  site_url="$(trim "${SPARKLER_CONVEX_SITE_URL:-}")"
  convex_url="$(trim "${SPARKLER_CONVEX_URL:-}")"

  if [ -z "$deployment_url" ]; then
    deployment_url="$(prompt_value "Sparkler deployment URL" "")"
  fi

  if [ -z "$deployment_url" ]; then
    say "Skipping Sparkler config file generation."
    say "You can still run sparkler after setting SPARKLER_DEPLOYMENT_URL and SPARKLER_CONVEX_URL later."
    return
  fi

  if [ -z "$site_url" ]; then
    site_url="$deployment_url"
  fi
  if [ -z "$convex_url" ]; then
    convex_url="$(infer_convex_cloud_url "$site_url")"
  fi
  if [ -z "$convex_url" ]; then
    convex_url="$(prompt_value "Convex cloud URL" "")"
  fi

  mkdir -p "$SPARKLER_CONFIG_DIR"
  cat >"$SPARKLER_CONFIG_FILE" <<EOF
{
  "deploymentUrl": "${deployment_url%/}",
  "convexSiteUrl": "${site_url%/}",
  "convexUrl": "${convex_url%/}"
}
EOF

  say "Wrote ${SPARKLER_CONFIG_FILE}"
}

print_path_hint() {
  case ":$PATH:" in
    *":${SPARKLER_BIN_DIR}:"*) ;;
    *)
      say
      say "Add Sparkler to your PATH if you want to call it without a full path:"
      say "  export PATH=\"${SPARKLER_BIN_DIR}:\$PATH\""
      ;;
  esac
}

print_conversion_note() {
  if command_exists cargo; then
    say
    say "Rust detected: local Spark build-lod conversion is available once SPARKLER_SPARK_ROOT points at a Spark checkout."
    return
  fi

  say
  say "Optional conversion note:"
  say "  sparkler host myscan.rad works immediately."
  say "  For non-.rad uploads like .spz or .ply, install Rust and point SPARKLER_SPARK_ROOT at a Spark checkout with npm run build-lod."
}

main() {
  detect_platform
  ensure_prereqs
  install_cli
  write_config
  mkdir -p "$SPARKLER_CONFIG_DIR"

  say
  say "Sparkler is installed."
  say "Binary: ${SPARKLER_BIN_DIR}/sparkler"
  say "Install root: ${INSTALL_ROOT_DIR}"
  say
  say "Next steps:"
  say "  1. ./bin/sparkler login"
  say "  2. Wait for admin approval if your account shows as pending"
  say "  3. ./bin/sparkler host myscene.rad"
  say
  say "If you prefer the safer manual installer flow next time:"
  say "  curl -fsSL https://<deployment>.convex.site/setup.sh -o setup.sh"
  say "  bash setup.sh"

  print_path_hint
  print_conversion_note
}

main "$@"
