# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

# aidlc-dashboard installer -- Windows (PowerShell).
#
#     $env:AIDLC_ARCHIVE = "dist\aidlc-dashboard-<version>-windows-x64.zip"
#     Get-Content -Raw .\install.ps1 | iex
#
# installs an archive you built yourself with `bun run package` (README, "Build an
# executable"). It downloads nothing: AIDLC_ARCHIVE is required. A release download path
# was here until 2026-11-19 and was removed in the security review, because it installed
# an executable fetched over the network with no checksum check.
#
# `... | iex` runs the script from MEMORY, so the execution policy that blocks an
# unsigned .ps1 on disk does not apply -- which is why it is run this way rather than
# as `.\install.ps1`.
#
# What it installs: ONE executable, `aidlc-dashboard.exe`, built with
# `bun build --compile` -- the Bun runtime is inside it, so nothing else is installed.
# (Until 1.12 the release was a source zip plus bun, which this script detected,
# offered to install and checked against a version floor. All of that is gone.)
#
# The same things install.sh has to get right, for the same reasons:
#
#   1. `data\usage.db` is the operator's collected credit history and it lives
#      INSIDE the install dir, beside the executable. A naive re-install destroys it,
#      so the new tree is assembled beside the old one and `data\` is carried across
#      -- from a pre-1.13 source install too, whose `data\` is in the same place.
#   2. The executable is run once (`--help`) before it replaces anything, so a damaged
#      or wrong-platform archive fails with the old install still in place.
#
# Windows on ARM runs the x64 build under the system's x64 emulation; there is no
# separate ARM64 build.
#
# Knobs (environment variables):
#   AIDLC_ARCHIVE   the archive to install (required)
#   AIDLC_DIR       install location (default %LOCALAPPDATA%\Programs\aidlc-dashboard)
#   AIDLC_NO_PATH=1 do not add the install folder to the user Path
#
# WHERE IT GOES (2026-11-17, the owner's call). The Windows convention for a per-user
# program: %LOCALAPPDATA%\Programs\<name> -- where Kiro's and VS Code's user installs sit --
# with that folder itself on the user Path, so `aidlc-dashboard` resolves to the
# executable and no launcher shim is needed. Until then it was %USERPROFILE%\.aidlc-dashboard
# plus a .cmd shim in %USERPROFILE%\.local\bin, a Unix layout. An install found there is
# moved over: its data\ carried across, the old dir and shim removed, and the .local\bin
# Path entry removed only when that folder is left empty -- other tools (Claude Code, uv)
# put their own programs there. AIDLC_BIN_DIR / AIDLC_NO_BIN are install.sh's (macOS/Linux).

$ErrorActionPreference = 'Stop'

# Path literals use FORWARD slashes on purpose: .NET accepts them on Windows too,
# and it is what makes this script runnable under pwsh on macOS/Linux -- which is how
# it was verified, since the author had no Windows machine.
$dir = if ($env:AIDLC_DIR) {
  $env:AIDLC_DIR
} elseif ($env:LOCALAPPDATA) {
  Join-Path $env:LOCALAPPDATA 'Programs/aidlc-dashboard'
} else {
  Join-Path $HOME 'AppData/Local/Programs/aidlc-dashboard'
}
$exeName = 'aidlc-dashboard.exe'
$platform = 'windows-x64'

# The layout before 2026-11-17 (see the header), moved over when it is found -- but not
# when AIDLC_DIR names a place: an explicit location is the user's, and so is the old one.
$legacyDir = Join-Path $HOME '.aidlc-dashboard'
$legacyBin = Join-Path $HOME '.local/bin'
$legacyShim = Join-Path $legacyBin 'aidlc-dashboard.cmd'
function Get-FullDir([string]$p) { [IO.Path]::GetFullPath($p).TrimEnd('\', '/') }
$migrate = (-not $env:AIDLC_DIR) -and
  (Test-Path -LiteralPath (Join-Path $legacyDir $exeName)) -and
  ((Get-FullDir $legacyDir) -ine (Get-FullDir $dir))

# Non-ASCII characters (the message marks, dashes and arrows) are written as \uXXXX escapes
# and decoded by T at run time, so this
# file stays pure ASCII. It has to: `irm | iex` under Windows PowerShell 5.1 decodes a
# response with no charset (GitHub serves release assets as application/octet-stream)
# as ISO-8859-1, and reads a BOM-less file from disk in the ANSI code page -- either
# way UTF-8 text beyond ASCII arrived as mojibake. Parentheses inside a $(T '...') are escaped as
# well (\u0028 \u0029): PowerShell counts them even inside quotes when it looks for the
# end of $( ) in a double-quoted string, so an unbalanced one swallowed what followed.
# src/test/ps1-ascii.test.ts pins both. To read a message, run
# [regex]::Unescape('<the escaped text>') in any PowerShell.
function T([string]$s) { [regex]::Unescape($s) }
function Say([string]$m) { Write-Host $m }
# `throw`, not `exit`: under `... | iex` the script runs in the caller's session, so
# `exit` closed the user's PowerShell window before they could read why it failed. The
# exception is TAGGED so the top level (the `catch` at the end of this file) prints it as
# one red line: a bare `throw` showed Windows PowerShell 5.1's whole error record under the
# message (position, CategoryInfo, FullyQualifiedErrorId -- seen on a real Windows Server
# 2025 box, 2026-11-17). `finally` blocks on the way out still run.
function Die([string]$m) { $e = [Exception]::new("$(T '\u2717 ')$m"); $e.Data['aidlc.die'] = $true; throw $e }

# Everything below runs inside one try, closed at the end of the file without re-indenting.
try {

# ---- which archive ----------------------------------------------------------
if (-not $env:AIDLC_ARCHIVE) {
  Die @"
$(T 'AIDLC_ARCHIVE is required \u2014 build an archive with `bun run package` and pass it:')
    `$env:AIDLC_ARCHIVE = "dist\aidlc-dashboard-<version>-windows-x64.zip"
    Get-Content -Raw .\install.ps1 | iex
"@
}
if (-not (Test-Path -LiteralPath $env:AIDLC_ARCHIVE)) {
  Die "$(T 'AIDLC_ARCHIVE file not found: ')$env:AIDLC_ARCHIVE"
}
$asset = Split-Path -Leaf $env:AIDLC_ARCHIVE
$ver = if ($asset -match '^aidlc-dashboard-(.+)-windows-[a-z0-9]+\.zip$') { $Matches[1] } else { '?' }
Say "$(T '\u25b8 Local archive \u0028')$asset$(T '\u0029')"

# ---- unpack -----------------------------------------------------------------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
  $zip = Join-Path $tmp $asset
  try {
    Copy-Item -LiteralPath $env:AIDLC_ARCHIVE -Destination $zip
  } catch {
    Die "$(T 'Cannot copy the archive: ')$env:AIDLC_ARCHIVE$(T ' \u0028')$_)"
  }
  if (-not (Test-Path $zip) -or (Get-Item $zip).Length -eq 0) {
    Die "$(T 'The archive is empty: ')$asset"
  }

  $x = Join-Path $tmp 'x'
  try {
    Expand-Archive -LiteralPath $zip -DestinationPath $x -Force
  } catch {
    Die "$(T 'Cannot unzip \u0028')$asset): $_"
  }

  # The archive carries one top-level dir holding the executable. Verify the shape
  # rather than trusting it: a wrong layout should fail here, not halfway through the
  # swap below.
  $src = Join-Path $x 'aidlc-dashboard'
  $exe = Join-Path $src $exeName
  if (-not (Test-Path $exe)) {
    Die (T 'Unexpected archive layout \u0028no aidlc-dashboard.exe \u2014 an archive for another platform, or from before 1.13\u0029.')
  }
  # See 3. above. Only on Windows: under pwsh on macOS (how this script is tested) the
  # .exe cannot run, and that is not the download's fault.
  # Judged by the exit code alone: Windows PowerShell 5.1 turns a native command's stderr
  # line into a terminating NativeCommandError under $ErrorActionPreference = 'Stop' once
  # stderr is redirected, so any stderr output stopped the install on a working executable
  # (seen on a real Windows Server 2025 box, 2026-11-17, when the usage text went to stderr).
  if ($env:OS -eq 'Windows_NT') {
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & $exe --help *> $null
      $smoke = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $prevEap
    }
    if ($smoke -ne 0) {
      Die (T 'The executable does not run on this machine \u2014 the existing install is untouched.')
    }
  }

  # A running copy holds its executable open, and Windows will not move or delete the
  # folder under it, so a re-install while the dashboard ran stopped half way (seen on a
  # real Windows Server 2025 box, 2026-11-17). Ask for it to be closed BEFORE anything
  # moves -- the copy at the target and the one at the old location alike.
  $held = @()
  $watch = @((Join-Path $dir $exeName), (Join-Path $legacyDir $exeName)) | ForEach-Object { [IO.Path]::GetFullPath($_) }
  foreach ($p in @(Get-Process -Name 'aidlc-dashboard' -ErrorAction SilentlyContinue)) {
    $pp = $null
    try { $pp = $p.Path } catch { }
    if ($pp -and ($watch -contains [IO.Path]::GetFullPath($pp))) { $held += "PID $($p.Id) $pp" }
  }
  if ($held.Count -gt 0) {
    Die "$(T 'Close the running aidlc-dashboard first \u2014 nothing was changed: ')$($held -join ', ')"
  }

  # ---- install --------------------------------------------------------------
  # Swap, not overwrite: the new tree is complete before it is put in place, so a
  # failure above leaves the existing install untouched.
  #
  # `data\` never passes through $tmp -- the same defect install.sh had, reproduced
  # there: it moved into the new tree first, the next move failed, and `finally`
  # deleted $tmp with the credit history in it. Old tree aside, new tree in place,
  # THEN `data\` crosses; every failure leaves it on disk and says where.
  $parent = Split-Path -Parent $dir
  if ($parent -and -not (Test-Path $parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  if (Test-Path $dir) {
    $old = "$dir.old.$PID"
    try {
      Move-Item -LiteralPath $dir -Destination $old
    } catch {
      Die "$(T 'Cannot move the existing install aside: ')$dir$(T ' \u2014 nothing was changed. \u0028')$_)"
    }
    try {
      Move-Item -LiteralPath $src -Destination $dir
    } catch {
      try {
        Move-Item -LiteralPath $old -Destination $dir
      } catch {
        Die "$(T 'Could not put the new install in place nor restore the old one \u2014 the existing install is still at ')$old$(T '. \u0028')$_)"
      }
      Die "$(T 'Cannot put the new install in place: ')$dir$(T ' \u2014 the existing install was restored. \u0028')$_)"
    }
    $data = Join-Path $old 'data'
    if (Test-Path $data) {
      Say (T '\u25b8 Kept data\\ \u0028the collected credit history\u0029')
      try {
        Move-Item -LiteralPath $data -Destination (Join-Path $dir 'data')
      } catch {
        Die "$(T 'Could not move data\\ \u2014 the collected history is still at ')$data$(T '. Move it to ')$(Join-Path $dir 'data')$(T ' yourself. \u0028')$_)"
      }
    }
    # A pre-1.13 install was a source tree run by bun; nothing of it is needed now.
    if (Test-Path (Join-Path $old 'src')) {
      Say (T '\u25b8 Replaced the earlier source install \u0028run by bun\u0029 with the executable \u2014 bun is no longer needed.')
    }
    Remove-Item -LiteralPath $old -Recurse -Force
    Say "$(T '\u25b8 Updated: ')$dir"
  } else {
    Move-Item -LiteralPath $src -Destination $dir
    Say "$(T '\u25b8 Installed: ')$dir"
  }

  # The old layout, moved over (see the header). Same rule as data\ above: it crosses
  # only after the new tree is in place, and a failure leaves it where it was and says so.
  if ($migrate) {
    Say "$(T '\u25b8 Moved from the older location: ')$legacyDir$(T ' \u2192 ')$dir"
    $legacyData = Join-Path $legacyDir 'data'
    $newData = Join-Path $dir 'data'
    if ((Test-Path -LiteralPath $legacyData) -and (Test-Path -LiteralPath $newData)) {
      # Two histories: keep both rather than pick one; the old one stays put, named.
      Say "$(T '  \u26a0 data\\ exists in both places, so the older one was left as it is: ')$legacyData"
    } else {
      if (Test-Path -LiteralPath $legacyData) {
        Say (T '\u25b8 Kept data\\ \u0028the collected credit history\u0029')
        try {
          Move-Item -LiteralPath $legacyData -Destination $newData
        } catch {
          Die "$(T 'Could not move data\\ \u2014 the collected history is still at ')$legacyData$(T '. Move it to ')$newData$(T ' yourself. \u0028')$_)"
        }
      }
      try {
        Remove-Item -LiteralPath $legacyDir -Recurse -Force
        Say "$(T '\u25b8 Removed the older install: ')$legacyDir"
      } catch {
        Say "$(T '  \u26a0 Could not remove the older install \u2014 remove it yourself: ')$legacyDir$(T ' \u0028')$_)"
      }
    }
    if (Test-Path -LiteralPath $legacyShim) {
      try {
        Remove-Item -LiteralPath $legacyShim -Force
        Say "$(T '\u25b8 Removed the older launcher: ')$legacyShim"
      } catch {
        Say "$(T '  \u26a0 Could not remove the older launcher \u2014 remove it yourself: ')$legacyShim$(T ' \u0028')$_)"
      }
    }
  }
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- user PATH (Windows) -----------------------------------------------------
# The install folder is useless by name until it is on PATH, and on Windows a new
# folder never is: `aidlc-dashboard` failed with CommandNotFound on a fresh machine
# (2026-10-16). So it is added to the USER Path (HKCU, no elevation) -- announced first,
# skipped with AIDLC_NO_PATH=1 -- the way bun's and scoop's installers do it.
#
# Through the registry, not [Environment]::SetEnvironmentVariable: that one reads the
# value EXPANDED, so writing it back would bake `%USERPROFILE%`-style entries into
# literals. The raw value is read with DoNotExpandEnvironmentNames and written back
# with the kind it had.

# $raw with $entry appended, or $null when an entry already names the same folder
# (compared expanded, case-insensitive, trailing slash ignored).
function Join-PathEntry([string]$raw, [string]$entry) {
  $norm = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\', '/') }
  $want = & $norm $entry
  $parts = @($raw -split ';' | Where-Object { $_ -and $_.Trim() })
  foreach ($p in $parts) { if ((& $norm $p) -ieq $want) { return $null } }
  return (@($parts) + $entry) -join ';'
}

# Tell running programs the environment changed, so a terminal opened from Explorer
# sees the new Path without signing out. Best effort: a failure costs only that.
function Publish-Env {
  try {
    if (-not ('AidlcDashboard.NativeMethods' -as [type])) {
      Add-Type -Namespace AidlcDashboard -Name NativeMethods -MemberDefinition '[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);'
    }
    $result = [UIntPtr]::Zero
    [void][AidlcDashboard.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
  }
}

# The machine Path, raw. Read-only (no elevation needed to read HKLM); '' when absent.
function Get-MachinePathRaw {
  try {
    $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Control\Session Manager\Environment')
    if (-not $key) { return '' }
    try { return [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } finally { $key.Close() }
  } catch {
    # Unreadable is treated as "not there": the user Path is then made to hold it,
    # which at worst duplicates a machine entry -- harmless, unlike a missing one.
    return ''
  }
}

# Add $entry to the user Path (if absent) and to this session. Returns $true when it
# wrote the registry, $false when the user Path already had it.
function Add-UserPath([string]$entry) {
  $wrote = $false
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { throw 'HKCU\Environment could not be opened for writing' }
  try {
    $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $new = Join-PathEntry $raw $entry
    if ($null -ne $new) {
      $key.SetValue('Path', $new, $kind)
      $wrote = $true
      Publish-Env
    }
  } finally {
    $key.Close()
  }
  # `... | iex` runs in the caller's session, so this reaches the user's own window.
  if ($null -ne (Join-PathEntry $env:Path $entry)) { $env:Path = "$env:Path;$entry" }
  return $wrote
}

# Remove every user Path entry naming $entry's folder (same comparison as Join-PathEntry),
# from the registry and from this session. Returns $true when it wrote the registry.
function Remove-UserPath([string]$entry) {
  $norm = { param($p) [Environment]::ExpandEnvironmentVariables($p).Trim().TrimEnd('\', '/') }
  $want = & $norm $entry
  $keep = { param($raw) @($raw -split ';' | Where-Object { $_ -and $_.Trim() -and ((& $norm $_) -ine $want) }) }
  $wrote = $false
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  if (-not $key) { throw 'HKCU\Environment could not be opened for writing' }
  try {
    if ($key.GetValueNames() -contains 'Path') {
      $raw = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $kind = $key.GetValueKind('Path')
      $left = & $keep $raw
      if ($left.Count -ne @($raw -split ';' | Where-Object { $_ -and $_.Trim() }).Count) {
        $key.SetValue('Path', ($left -join ';'), $kind)
        $wrote = $true
        Publish-Env
      }
    }
  } finally {
    $key.Close()
  }
  $env:Path = (& $keep $env:Path) -join ';'
  return $wrote
}

# ---- on PATH ----------------------------------------------------------------
# The install folder itself goes on PATH, no shim: `aidlc-dashboard` is the executable,
# which finds data\ beside its real location (src/runtime.ts).
#
# `$run` is what the closing hint tells the user to type, decided HERE: printing
# "add this to PATH" and then telling them to type the bare name is two
# instructions that contradict each other.
$exePath = Join-Path $dir $exeName
$run = $exePath
$onPath = ($env:PATH -split ';' | Where-Object { $_ -and ($_.TrimEnd('\', '/') -ieq $dir.TrimEnd('\', '/')) })
# On Windows the question is whether NEW terminals will find it, so it is answered from
# the registry, not from this session: a session can carry the folder from a one-off
# `$env:Path +=` or a stale inherited environment while the user Path lacks it -- then
# the command worked here and nowhere else (seen 2026-10-16). The machine Path counts as
# present; otherwise the user Path is made to hold it.
$winPath = $env:OS -eq 'Windows_NT' -and $env:AIDLC_NO_PATH -ne '1'
if ($winPath -and $null -eq (Join-PathEntry (Get-MachinePathRaw) $dir)) {
  if (-not $onPath) { $env:Path = "$env:Path;$dir" }
  $run = 'aidlc-dashboard'
} elseif ($winPath) {
  Say "$(T '\u25b8 User PATH: ')$dir$(T ' \u0028AIDLC_NO_PATH=1 skips this\u0029')"
  try {
    $wrote = Add-UserPath $dir
    $run = 'aidlc-dashboard'
    if ($wrote) {
      Say (T '  Added. New terminals run aidlc-dashboard too, and this window already has it.')
    } else {
      Say (T '  Already on the user PATH \u2014 applied to this window too.')
    }
  } catch {
    Say "$(T '  \u26a0 Could not add it to PATH \u2014 add it yourself: ')$dir$(T ' \u0028')$_$(T '\u0029')"
  }
} elseif ($onPath) {
  $run = 'aidlc-dashboard'
} else {
  Say "$(T '  \u26a0 ')$dir$(T ' is not on PATH \u2014 run the full path below, or add it to PATH to run it by name.')"
}

# The old layout's .local\bin Path entry goes only when that folder is left empty: other
# tools put their own programs there, and their entry is theirs (see the header).
if ($migrate) {
  $binLeft = (Test-Path -LiteralPath $legacyBin) -and @(Get-ChildItem -LiteralPath $legacyBin -Force).Count -gt 0
  if ($binLeft) {
    Say "$(T '  \u21b3 Other programs are there, so it was left as it is \u0028PATH entry included\u0029: ')$legacyBin"
  } else {
    if (Test-Path -LiteralPath $legacyBin) {
      try { Remove-Item -LiteralPath $legacyBin -Force } catch { }
    }
    if ($env:OS -eq 'Windows_NT') {
      try {
        if (Remove-UserPath $legacyBin) { Say "$(T '\u25b8 Removed from the user PATH, as it was empty: ')$legacyBin" }
      } catch {
        Say "$(T '  \u26a0 Could not remove it from the user PATH \u2014 remove it yourself: ')$legacyBin$(T ' \u0028')$_$(T '\u0029')"
      }
    }
  }
}

# ---- done -------------------------------------------------------------------
Say ''
Say "$(T 'Installed \u2014 v')$ver ($platform)"
Say ''
Say "  $run"
Say "  $run C:\path\to\workspace"
if ($run -ne $exePath) { Say "$(T '  Full path: ')$exePath" }
Say ''
Say (T '  The browser opens on its own \u0028--no-open turns that off\u0029.')
Say (T '  Read-only \u2014 this dashboard never writes to the workspace.')
$global:LASTEXITCODE = 0
} catch {
  # A Die: one red line and the window stays open. $LASTEXITCODE is the status a caller in
  # the same session can read (`... | iex; if ($LASTEXITCODE) { ... }`); a `powershell
  # -Command` wrapper must pass it on itself (`; exit $LASTEXITCODE`), because under `iex` an
  # error that is handled leaves the pipeline successful. Anything else is not ours to
  # soften and propagates as before.
  if ($_.Exception.Data['aidlc.die']) {
    Write-Host $_.Exception.Message -ForegroundColor Red
    $global:LASTEXITCODE = 1
  } else {
    throw
  }
}
