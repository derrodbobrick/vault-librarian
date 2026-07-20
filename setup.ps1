# ============================================================================
# Bobrick OT Knowledge Base - one-shot setup for a fresh Windows machine/VM
#
# Installs: Git, Node.js LTS, Python 3, Obsidian, Claude Code
# Clones:   Obsidian-knowledge-base (vault + OT Dashboard) and vault-librarian
# Wires:    npm install, openpyxl, VAULT_PATH, start scripts
#
# Run via setup.cmd (double-click) or:
#   powershell -ExecutionPolicy Bypass -File setup.ps1 [-BaseDir C:\somewhere] [-DryRun]
# Safe to re-run: existing installs are skipped, existing clones are pulled.
# ============================================================================
param(
    [string]$BaseDir = "$env:USERPROFILE\Bobrick",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$KB_REPO  = "https://github.com/derrodbobrick/Obsidian-knowledge-base.git"
$APP_REPO = "https://github.com/derrodbobrick/vault-librarian.git"
$KB_DIR   = Join-Path $BaseDir "Obsidian-knowledge-base"
$APP_DIR  = Join-Path $BaseDir "vault-librarian"

function Step($msg)  { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg)    { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg)  { Write-Host "    ! $msg" -ForegroundColor Yellow }
function Act($msg)   { if ($DryRun) { Write-Host "    [dry-run] $msg" -ForegroundColor DarkGray; return $true } return $false }

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

function Have($cmd) { return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

function Winget-Install($id, $label) {
    if (Act "winget install $id") { return }
    winget install --id $id --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { Warn "winget exited with $LASTEXITCODE for $label - it may already be installed." }
    Refresh-Path
}

Write-Host "Bobrick OT Knowledge Base setup" -ForegroundColor White
Write-Host "Target directory: $BaseDir"
if ($DryRun) { Warn "DRY RUN - nothing will be installed or written." }

if ($BaseDir -match "OneDrive") {
    Warn "BaseDir is inside OneDrive. Git is the sync mechanism between devices;"
    Warn "letting OneDrive sync a second git clone causes conflict noise."
    Warn "Recommended: re-run with -BaseDir outside OneDrive (e.g. C:\Bobrick)."
}

# --- 0. winget --------------------------------------------------------------
Step "Checking winget"
if (-not (Have "winget")) {
    throw "winget not found. Install 'App Installer' from the Microsoft Store, then re-run."
}
Ok "winget available"

# --- 1. Prerequisites -------------------------------------------------------
Step "Git"
if (Have "git") { Ok "already installed: $(git --version)" } else { Winget-Install "Git.Git" "Git" }

Step "Node.js LTS"
if (Have "node") { Ok "already installed: node $(node --version)" } else { Winget-Install "OpenJS.NodeJS.LTS" "Node.js" }

Step "Python 3"
if (Have "python") { Ok "already installed: $(python --version)" } else { Winget-Install "Python.Python.3.12" "Python" }

Step "Obsidian"
$obs = winget list --id Obsidian.Obsidian 2>$null | Select-String "Obsidian"
if ($obs) { Ok "already installed" } else { Winget-Install "Obsidian.Obsidian" "Obsidian" }

Step "openpyxl (spreadsheet extraction for librarian uploads)"
if (-not (Act "pip install openpyxl")) {
    python -m pip install --quiet openpyxl
    Ok "openpyxl ready"
}

Step "Claude Code (powers the librarian chat agent)"
if (Have "claude") { Ok "already installed: $(claude --version 2>$null)" }
elseif (-not (Act "npm install -g @anthropic-ai/claude-code")) {
    npm install -g @anthropic-ai/claude-code
    Refresh-Path
    Ok "installed"
}

# --- 2. Clone / update repos ------------------------------------------------
Step "Repositories"
if (-not (Act "create $BaseDir; clone/pull both repos")) {
    New-Item -ItemType Directory -Force $BaseDir | Out-Null
    foreach ($pair in @(@($KB_REPO, $KB_DIR), @($APP_REPO, $APP_DIR))) {
        $url = $pair[0]; $dir = $pair[1]
        if (Test-Path (Join-Path $dir ".git")) {
            Write-Host "    pulling $dir"
            git -C $dir pull --ff-only
        } else {
            Write-Host "    cloning $url"
            git clone $url $dir
        }
    }
    Ok "repos in place (first clone of a private repo prompts for GitHub sign-in)"
}

# --- 3. App dependencies + environment ---------------------------------------
Step "vault-librarian npm install"
if (-not (Act "npm install in $APP_DIR")) {
    Push-Location $APP_DIR
    npm install
    Pop-Location
    Ok "dependencies installed"
}

Step "VAULT_PATH environment variable"
if (-not (Act "setx VAULT_PATH $KB_DIR")) {
    setx VAULT_PATH $KB_DIR | Out-Null
    $env:VAULT_PATH = $KB_DIR
    Ok "VAULT_PATH = $KB_DIR"
}

# --- 4. Start scripts ---------------------------------------------------------
Step "Start scripts"
if (-not (Act "write start scripts in $BaseDir")) {
    Set-Content -Encoding ascii (Join-Path $BaseDir "Start Vault Librarian.cmd") @"
@echo off
set VAULT_PATH=$KB_DIR
cd /d "$APP_DIR"
start "" http://localhost:4747
node server.js
"@
    Set-Content -Encoding ascii (Join-Path $BaseDir "Start OT Dashboard.cmd") @"
@echo off
cd /d "$KB_DIR\OT Dashboard"
start "" http://localhost:4800
node server.js
"@
    Ok "created 'Start Vault Librarian.cmd' and 'Start OT Dashboard.cmd'"
}

# --- 5. Manual steps ----------------------------------------------------------
Step "Done. Three manual steps remain (one-time):"
Write-Host @"
    1. Run 'claude' once in a terminal and log in - the librarian's chat
       agent runs on your Claude account.
    2. Open Obsidian -> 'Open folder as vault' -> $KB_DIR
    3. First 'git push' will prompt a GitHub sign-in (credential manager).

    Start the apps any time with the two .cmd files in $BaseDir
    (Vault Librarian -> http://localhost:4747, OT Dashboard -> http://localhost:4800).
"@
