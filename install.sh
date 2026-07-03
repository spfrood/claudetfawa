#!/usr/bin/env bash
# claudetfawa bootstrap installer.
# Installs Node.js >= 20 and node-pty's build toolchain if missing (the only
# steps that need sudo), then clones the app and installs its dependencies.
# Idempotent: safe to re-run; re-running updates an existing install.
set -euo pipefail

REPO_URL="https://github.com/spfrood/claudetfawa"
INSTALL_DIR="${CLAUDETFAWA_DIR:-$HOME/claudetfawa}"
NODE_MAJOR_MIN=20

say() { printf '\n\033[1m[claudetfawa]\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31m[claudetfawa]\033[0m %s\n' "$*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "This installer needs root or sudo to install packages. Install Node.js >= ${NODE_MAJOR_MIN}, git, python3, make, and g++ manually, then re-run."
  fi
fi

PKG=""
if command -v apt-get >/dev/null 2>&1; then PKG="apt"
elif command -v dnf >/dev/null 2>&1; then PKG="dnf"
elif command -v yum >/dev/null 2>&1; then PKG="yum"
fi

apt_install() { $SUDO apt-get install -y "$@"; }
rpm_install() { $SUDO "$PKG" install -y "$@"; }

ensure_basics() {
  local missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v git >/dev/null 2>&1 || missing+=(git)
  if [ "${#missing[@]}" -gt 0 ]; then
    say "Installing: ${missing[*]}"
    case "$PKG" in
      apt) $SUDO apt-get update -y && apt_install "${missing[@]}" ca-certificates ;;
      dnf|yum) rpm_install "${missing[@]}" ca-certificates ;;
      *) die "Unsupported distro: please install ${missing[*]} manually, then re-run." ;;
    esac
  fi
}

node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local major
  major="$(node -v | sed 's/^v//; s/\..*//')"
  [ "$major" -ge "$NODE_MAJOR_MIN" ]
}

ensure_node() {
  if node_ok; then
    say "Node.js $(node -v) found."
    return
  fi
  say "Installing Node.js ${NODE_MAJOR_MIN}+ (via NodeSource)…"
  case "$PKG" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO bash -
      apt_install nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | $SUDO bash -
      rpm_install nodejs
      ;;
    *)
      die "Unsupported distro: please install Node.js >= ${NODE_MAJOR_MIN} manually, then re-run."
      ;;
  esac
  node_ok || die "Node.js install did not produce a usable node >= ${NODE_MAJOR_MIN}."
}

ensure_build_tools() {
  if command -v make >/dev/null 2>&1 && command -v g++ >/dev/null 2>&1 && command -v python3 >/dev/null 2>&1; then
    say "Build toolchain found (needed to compile node-pty)."
    return
  fi
  say "Installing build toolchain for node-pty (python3, make, g++)…"
  case "$PKG" in
    apt) $SUDO apt-get update -y && apt_install build-essential python3 ;;
    dnf|yum) rpm_install gcc-c++ make python3 ;;
    *) die "Unsupported distro: please install python3, make, and g++ manually, then re-run." ;;
  esac
}

fetch_app() {
  if [ -d "$INSTALL_DIR/.git" ]; then
    say "Updating existing install in $INSTALL_DIR…"
    git -C "$INSTALL_DIR" pull --ff-only
  else
    say "Cloning to $INSTALL_DIR…"
    git clone "$REPO_URL" "$INSTALL_DIR"
  fi
  say "Installing npm dependencies (compiles node-pty — takes a minute)…"
  (cd "$INSTALL_DIR" && npm install --omit=dev --no-fund --no-audit)
}

ensure_basics
ensure_node
ensure_build_tools
fetch_app

command -v claude >/dev/null 2>&1 || say "NOTE: no 'claude' on PATH — install Claude Code before running the portal."

say "Done. To authenticate Claude Code from your browser:"
cat <<EOF

    node $INSTALL_DIR/server.js

  It will ask you to choose a one-time password, then print the URL to open
  and a certificate fingerprint to verify.

  Firewall note: your phone must be able to reach TCP port 61897 on this
  server. On most cloud VPSes that means temporarily allowing it in the
  provider's security group / firewall — and closing it again when done.
EOF
