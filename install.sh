#!/bin/sh
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# aidlc-dashboard installer — macOS / Linux. Run it from a clone:
#
#   sh install.sh
#
# builds the executable for this machine from the clone (`bun run package --only
# <platform>`) and installs it, with an `aidlc-dashboard` launcher on PATH. It downloads
# nothing: the clone is the source, and the build needs no `bun install` (there are no
# runtime dependencies). A
# release download path was here until 2026-11-19 and was removed in the security
# review, because it installed an executable fetched over the network with no checksum
# check. No prebuilt executable is published any more either: one carries Bun, which
# statically links LGPL code, so Bun stays a prerequisite the person installs.
#
#   AIDLC_ARCHIVE=dist/aidlc-dashboard-<version>-<os>-<arch>.zip sh install.sh
#
# installs an archive you built yourself instead, and needs no bun.
#
# BUN IS A PREREQUISITE, NEVER INSTALLED HERE. The build needs Bun at the floor in
# `package.json`'s `engines.bun`, and the executable it makes embeds THAT Bun as its
# runtime — so the floor is checked before the build, with the same comparator the
# server uses (`src/version.ts`), not a second copy of the number. Without bun, or
# below the floor, the script says so and stops.
#
# WHAT IT INSTALLS. One executable for this machine's platform, built with
# `bun build --compile` — the Bun runtime is inside it, so nothing else is installed.
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
#   AIDLC_ARCHIVE=/path/to.zip     install this archive instead of building one
#   AIDLC_DIR=~/.aidlc-dashboard   where to install
#   AIDLC_NO_BIN=1                 do not create the ~/.local/bin launcher
#   AIDLC_NO_PATH=1                leave the shell profile alone (no PATH line)

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

TMP=$(mktemp -d) || die "Cannot create a temporary directory."
# Clean up on any exit, including the failure paths below.
trap 'rm -rf "$TMP"' EXIT INT TERM

# ---- which archive: handed in, or built from this clone ---------------------
if [ -n "${AIDLC_ARCHIVE:-}" ]; then
  [ -f "$AIDLC_ARCHIVE" ] || die "AIDLC_ARCHIVE file not found: $AIDLC_ARCHIVE"
  ARCHIVE="$AIDLC_ARCHIVE"
  say "▸ Local archive ($(basename "$ARCHIVE"))"
else
  # The clone is the directory this script sits in, not the caller's cwd.
  ROOT=$(cd "$(dirname "$0")" && pwd) || die "Cannot find the directory this script is in."
  [ -f "$ROOT/package.json" ] && [ -f "$ROOT/scripts/package.ts" ] ||
    die "Run this from a clone of the repository (no package.json or scripts/package.ts beside it): $ROOT"
  command -v bun >/dev/null 2>&1 ||
    die "Bun is required to build the dashboard and was not found on PATH. Install Bun (see bun.sh), open a new terminal and run this again."
  command -v zip >/dev/null 2>&1 || die "zip is required to build the archive."
  # Exit 3 and the floor on stdout means "below the floor"; an unreadable version or
  # floor is not "too old", as the server reads it.
  FLOOR=$(cd "$ROOT" && bun -e 'import { BUN_FLOOR, belowFloor } from "./src/version.ts";
if (BUN_FLOOR && belowFloor(Bun.version, BUN_FLOOR)) { console.log(BUN_FLOOR); process.exit(3); }' 2>/dev/null) &&
    FLOOR_RC=0 || FLOOR_RC=$?
  if [ "$FLOOR_RC" = 3 ]; then
    die "Bun $(bun --version 2>/dev/null) is too old — $FLOOR or later is required. Upgrade Bun and run this again."
  elif [ "$FLOOR_RC" != 0 ]; then
    die "Cannot run Bun to check its version (bun -e failed in $ROOT)."
  fi
  say "▸ Building for $PLATFORM with Bun $(bun --version) (from $ROOT)"
  # `--local`: this build is installed here and published nowhere, so package.ts skips the
  # content audit that would match the installer's own account name (see its header). The
  # build log is shown only when the build fails.
  if ! (cd "$ROOT" && bun run scripts/package.ts "$TMP/dist" --only "$PLATFORM" --local) >"$TMP/build.log" 2>&1; then
    cat "$TMP/build.log" >&2
    die "The build failed — the existing install is untouched."
  fi
  ARCHIVE=$(ls "$TMP"/dist/aidlc-dashboard-*-"$PLATFORM".zip 2>/dev/null | head -n 1)
  [ -n "$ARCHIVE" ] || die "The build made no archive for $PLATFORM."
fi
ASSET=$(basename "$ARCHIVE")
# The version is read off the archive's own name, so the summary below is true.
VER=$(printf '%s\n' "$ASSET" | sed -n 's/^aidlc-dashboard-\(.*\)-[a-z]*-[a-z0-9]*\.zip$/\1/p')
[ -n "$VER" ] || VER="?"

# ---- unpack -----------------------------------------------------------------
cp "$ARCHIVE" "$TMP/$ASSET" || die "Cannot copy the archive: $ARCHIVE"
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
# The install is done when typing `aidlc-dashboard` runs it. macOS's default zsh does not
# have ~/.local/bin on PATH, so the launcher dir is added to the shell's startup file —
# said first, once, and skipped with AIDLC_NO_PATH=1. A child process cannot change the
# PATH of the shell that started it, so README's install block ends with the same
# `export` line for the terminal it was pasted into; new terminals read the file.
#
# `RUN` is what the closing hint tells the user to type, and it is decided HERE
# rather than at the end: printing "add this to PATH" and then telling them to type
# the bare name is two instructions that contradict each other.
RUN="$DIR/$EXE_NAME"
NEW_SHELL_HINT=""
# The startup file the login shell reads for an interactive terminal; empty when this
# script cannot write one that shell reads (fish has its own syntax and file).
profile_file() {
  case "$(basename "${SHELL:-sh}")" in
    zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash) if [ "$OS" = darwin ]; then printf '%s\n' "$HOME/.bash_profile"; else printf '%s\n' "$HOME/.bashrc"; fi ;;
    fish) ;;
    *) printf '%s\n' "$HOME/.profile" ;;
  esac
}
if [ "${AIDLC_NO_BIN:-}" != "1" ]; then
  if mkdir -p "$BIN_DIR" 2>/dev/null; then
    cat > "$BIN" <<EOF
#!/bin/sh
exec "$DIR/$EXE_NAME" "\$@"
EOF
    chmod +x "$BIN"
    say "▸ Launcher: $BIN"
    LINE="export PATH=\"$BIN_DIR:\$PATH\""
    PROFILE=$(profile_file)
    case ":$PATH:" in
      *":$BIN_DIR:"*) RUN="aidlc-dashboard" ;;
      *)
        if [ "${AIDLC_NO_PATH:-}" = "1" ]; then
          say "  ⚠ $BIN_DIR is not on PATH, and AIDLC_NO_PATH=1 leaves your shell profile alone."
        elif [ -z "$PROFILE" ]; then
          say "  ⚠ $BIN_DIR is not on PATH. For fish: fish_add_path $BIN_DIR"
        elif [ -f "$PROFILE" ] && grep -qxF "$LINE" "$PROFILE"; then
          RUN="aidlc-dashboard"
          NEW_SHELL_HINT="$LINE"
        elif printf '\n# aidlc-dashboard launcher (added by install.sh)\n%s\n' "$LINE" >>"$PROFILE"; then
          say "▸ Added $BIN_DIR to PATH in $PROFILE"
          RUN="aidlc-dashboard"
          NEW_SHELL_HINT="$LINE"
        else
          say "  ⚠ Could not write $PROFILE — add this line to your shell profile: $LINE"
        fi
        ;;
    esac
  else
    say "▸ Cannot create $BIN_DIR, so no launcher was made."
  fi
fi

# ---- done -------------------------------------------------------------------
say ""
say "Installed — v$VER ($PLATFORM)"
say ""
if [ -n "$NEW_SHELL_HINT" ]; then
  say "  New terminals find it by name. In this one, run first:"
  say "    $NEW_SHELL_HINT"
  say ""
fi
say "  $RUN"
say "  $RUN ~/path/to/workspace"
say ""
say "  The browser opens on its own (--no-open turns that off)."
say "  Read-only — this dashboard never writes to the workspace."
