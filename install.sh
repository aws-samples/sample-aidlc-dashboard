#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# aidlc-dashboard installer — macOS / Linux.
#
#   AIDLC_ARCHIVE=dist/aidlc-dashboard-<version>-<os>-<arch>.zip sh install.sh
#
# installs an archive you built yourself with `bun run package` (README, "Build an
# executable"). It downloads nothing: AIDLC_ARCHIVE is required. A release download path
# was here until 2026-11-19 and was removed in the security review, because it installed
# an executable fetched over the network with no checksum check.
#
# WHAT IT INSTALLS. One executable for this machine's platform, built with
# `bun build --compile` — the Bun runtime is inside it, so nothing else is installed.
# (Until 1.12 the release was a source zip plus bun, which this script detected,
# offered to install and checked against a version floor. All of that is gone.)
#
# WHY A SEPARATE SCRIPT AND NOT "unzip it". Two things have to happen in order and one
# of them is destructive if you get it wrong:
#
#   1. `data/usage.db` is the operator's collected credit history and it lives
#      INSIDE the install dir, beside the executable. A naive re-install (rm -rf +
#      unzip) destroys it. This script installs beside the old copy and carries
#      `data/` across — including from a pre-1.13 source install, whose `data/` is
#      in the same place.
#   2. On macOS a file downloaded by a browser is quarantined, and Gatekeeper refuses
#      an ad-hoc-signed executable that carries the flag. An archive built with
#      `bun run package` carries none; the flag is cleared anyway, for an archive the
#      user handed in that came through a browser.
#
# POSIX sh on purpose — it may be run by any `sh`, so no arrays, no [[, no `local`.
#
# Knobs (env vars):
#   AIDLC_ARCHIVE=/path/to.zip     the archive to install (required)
#   AIDLC_DIR=~/.aidlc-dashboard   where to install
#   AIDLC_NO_BIN=1                 do not create the ~/.local/bin launcher

set -eu

DIR="${AIDLC_DIR:-$HOME/.aidlc-dashboard}"
BIN_DIR="${AIDLC_BIN_DIR:-$HOME/.local/bin}"
BIN="$BIN_DIR/aidlc-dashboard"
EXE_NAME="aidlc-dashboard"

say() { printf '%s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---- prerequisites ----------------------------------------------------------
# unzip only — `tar` cannot read a zip portably.
command -v unzip >/dev/null 2>&1 || die "unzip is required."
[ -n "${AIDLC_ARCHIVE:-}" ] || die "AIDLC_ARCHIVE is required — build an archive with \`bun run package\` and pass it:
  AIDLC_ARCHIVE=dist/aidlc-dashboard-<version>-<os>-<arch>.zip sh install.sh"

# ---- which platform ---------------------------------------------------------
# The release names: darwin|linux × arm64|x64 (windows uses install.ps1).
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "Unsupported OS: $(uname -s) — use this script on macOS and Linux, install.ps1 on Windows." ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  x86_64 | amd64) ARCH=x64 ;;
  *) die "Unsupported CPU: $(uname -m) — only arm64 and x86_64 are built." ;;
esac
# A shell running under Rosetta on Apple Silicon reports x86_64. The native build is
# the right one there: it runs without translation.
if [ "$OS" = darwin ] && [ "$ARCH" = x64 ] &&
  [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  ARCH=arm64
fi
PLATFORM="$OS-$ARCH"

# ---- which archive ----------------------------------------------------------
[ -f "$AIDLC_ARCHIVE" ] || die "AIDLC_ARCHIVE file not found: $AIDLC_ARCHIVE"
ASSET=$(basename "$AIDLC_ARCHIVE")
# The version is read off the archive's own name, so the summary below is true.
VER=$(printf '%s\n' "$ASSET" | sed -n 's/^aidlc-dashboard-\(.*\)-[a-z]*-[a-z0-9]*\.zip$/\1/p')
[ -n "$VER" ] || VER="?"
say "▸ Local archive ($ASSET)"

# ---- unpack -----------------------------------------------------------------
TMP=$(mktemp -d) || die "Cannot create a temporary directory."
# Clean up on any exit, including the failure paths below.
trap 'rm -rf "$TMP"' EXIT INT TERM

cp "$AIDLC_ARCHIVE" "$TMP/$ASSET" || die "Cannot copy the archive: $AIDLC_ARCHIVE"
[ -s "$TMP/$ASSET" ] || die "The archive is empty: $ASSET"

unzip -q "$TMP/$ASSET" -d "$TMP/x" || die "Cannot unzip $ASSET."
# The archive carries one top-level dir holding the executable. Verify the shape rather
# than trusting it: a wrong layout should fail here, not halfway through the move below.
SRC="$TMP/x/aidlc-dashboard"
[ -f "$SRC/$EXE_NAME" ] || die "Unexpected archive layout (no $EXE_NAME — an archive for another platform, or from before 1.13)."
chmod +x "$SRC/$EXE_NAME"
# See 2. above. Harmless when the flag is absent; xattr exists only on macOS.
if [ "$OS" = darwin ]; then xattr -d com.apple.quarantine "$SRC/$EXE_NAME" 2>/dev/null || true; fi
# Prove it runs on THIS machine before it replaces anything: a wrong-platform or
# damaged binary must fail here, with the old install still in place.
"$SRC/$EXE_NAME" --help >/dev/null 2>&1 ||
  die "The executable does not run on this machine ($PLATFORM) — the existing install is untouched."

# ---- install ----------------------------------------------------------------
# Swap, not overwrite: the new tree is assembled complete, then put in place. A
# failure above leaves the existing install untouched.
#
# `data/` is the collected credit history (SQLite). It is written INTO the install
# dir at runtime, so it has to survive an upgrade — this is the one thing a
# re-install must not throw away. So it NEVER passes through $TMP: it moved there
# first once, and when the next `mv` failed the EXIT trap deleted $TMP and the history
# with it (reproduced: a read-only parent dir, `mv "$DIR" "$OLD"` refused, usage.db
# gone). The old tree is set aside whole, the new one put in place, and only then
# does `data/` cross from old to new — every failure leaves it on disk, and says where.
mkdir -p "$(dirname "$DIR")"
if [ -e "$DIR" ]; then
  OLD="$DIR.old.$$"
  mv "$DIR" "$OLD" || die "Cannot move the existing install aside: $DIR — nothing was changed."
  if ! mv "$SRC" "$DIR"; then
    mv "$OLD" "$DIR" || die "Could not put the new install in place nor restore the old one — the existing install is still at $OLD."
    die "Cannot put the new install in place: $DIR — the existing install was restored."
  fi
  if [ -d "$OLD/data" ]; then
    say "▸ Kept data/ (the collected credit history)"
    mv "$OLD/data" "$DIR/data" ||
      die "Could not move data/ — the collected history is still at $OLD/data. Move it to $DIR/data yourself."
  fi
  # A pre-1.13 install was a source tree run by bun; nothing of it is needed now.
  [ -d "$OLD/src" ] && say "▸ Replaced the earlier source install (run by bun) with the executable — bun is no longer needed."
  rm -rf "$OLD"
  say "▸ Updated: $DIR"
else
  mv "$SRC" "$DIR"
  say "▸ Installed: $DIR"
fi

# ---- launcher ---------------------------------------------------------------
# A WRAPPER, not a symlink, so the executable is always run by its real path —
# `data/` is found beside the executable it actually is (src/runtime.ts), never
# beside a link in ~/.local/bin.
#
# `RUN` is what the closing hint tells the user to type, and it is decided HERE
# rather than at the end: printing "add this to PATH" and then telling them to type
# the bare name is two instructions that contradict each other.
RUN="$DIR/$EXE_NAME"
if [ "${AIDLC_NO_BIN:-}" != "1" ]; then
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    cat > "$BIN" <<EOF
#!/bin/sh
exec "$DIR/$EXE_NAME" "\$@"
EOF
    chmod +x "$BIN"
    say "▸ Launcher: $BIN"
    case ":$PATH:" in
      *":$BIN_DIR:"*) RUN="aidlc-dashboard" ;;
      *) say "  ⚠ $BIN_DIR is not on PATH. Add it in your shell profile to run it by name." ;;
    esac
  else
    say "▸ Cannot create $BIN_DIR, so no launcher was made."
  fi
fi

# ---- done -------------------------------------------------------------------
say ""
say "Installed — v$VER ($PLATFORM)"
say ""
say "  $RUN"
say "  $RUN ~/path/to/workspace"
say ""
say "  The browser opens on its own (--no-open turns that off)."
say "  Read-only — this dashboard never writes to the workspace."
