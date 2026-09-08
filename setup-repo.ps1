<#
    setup-repo.ps1

    Sets up the Habibi repository and pushes it to GitHub, with checks that
    stop the two mistakes that are painful to undo: committing node_modules,
    and committing secrets.

    Run from the folder that contains dispatch-service and driver-app:

        cd C:\Users\wahli\Habibi\Habibi_v2\habibi-delivery
        powershell -ExecutionPolicy Bypass -File .\setup-repo.ps1

    Safe to run more than once.
#>

param(
    [string]$Name  = "Wahlied",
    [string]$Email = "wahlied@quikr.co.za",
    [string]$Repo  = "https://github.com/Wallisco/habibi-delivery.git",
    [switch]$Push
)

$ErrorActionPreference = "Stop"
function Say($m, $c = "White") { Write-Host $m -ForegroundColor $c }
function Ok($m)   { Say "  [ok]   $m" "Green" }
function Warn($m) { Say "  [warn] $m" "Yellow" }
function Die($m)  { Say "  [stop] $m" "Red"; exit 1 }

Say ""
Say "Habibi repository setup" "Cyan"
Say "-----------------------" "Cyan"

# --- 1. we must be in the right folder -------------------------------------
if (-not (Test-Path "dispatch-service") -or -not (Test-Path "driver-app")) {
    Die "Run this from the folder containing dispatch-service and driver-app. You are in $(Get-Location)"
}
Ok "Found dispatch-service and driver-app"

# --- 2. git identity --------------------------------------------------------
git config --global user.name  $Name
git config --global user.email $Email
Ok "Git identity set to $Name <$Email>"

# --- 3. .gitignore ----------------------------------------------------------
# This has to exist BEFORE the first `git add`. Once node_modules is committed
# it stays in the history even after you delete it.
# PowerShell 5.1 mishandles here-string terminators when a file has Unix line
# endings, so this is built as an array instead. Less elegant, always parses.
$ignore = @(
    'node_modules/'
    'data/'
    '.expo/'
    'dist/'
    '*.log'
    '.env'
    '*.jks'
    '*.p8'
    '*.p12'
    '*.key'
    '*.mobileprovision'
    'play-service-account.json'
    '.DS_Store'
) -join "`r`n"

if (-not (Test-Path ".gitignore")) {
    $ignore | Set-Content -Path ".gitignore" -Encoding UTF8
    Ok "Created .gitignore"
} else {
    $existing = Get-Content ".gitignore" -Raw
    if ($existing -notmatch "node_modules") {
        $ignore | Set-Content -Path ".gitignore" -Encoding UTF8
        Warn ".gitignore was missing node_modules - replaced it"
    } else {
        Ok ".gitignore looks right"
    }
}

# --- 4. workflows must sit at the repository root ---------------------------
# GitHub only reads .github/workflows from the root. Inside a subfolder they
# are silently ignored, which looks exactly like CI not working.
if ((Test-Path "dispatch-service\.github\workflows") -and -not (Test-Path ".github\workflows")) {
    New-Item -ItemType Directory -Force -Path ".github\workflows" | Out-Null
    Move-Item "dispatch-service\.github\workflows\*" ".github\workflows\" -Force
    Remove-Item "dispatch-service\.github" -Recurse -Force
    Ok "Moved .github/workflows to the repository root"
} elseif (Test-Path ".github\workflows") {
    Ok "Workflows are at the root"
} else {
    Warn "No .github/workflows found - CI will not run"
}

# --- 5. init ----------------------------------------------------------------
if (-not (Test-Path ".git")) {
    git init | Out-Null
    Ok "Initialised the repository"
} else {
    Ok "Repository already initialised"
}
git branch -M main
git add -A

# --- 6. the checks that matter ---------------------------------------------
Say ""
Say "Checking what would be committed" "Cyan"

$staged = git diff --cached --name-only
$count  = ($staged | Measure-Object -Line).Lines
Say "  $count files staged"

$bad = $staged | Where-Object {
    $_ -match "node_modules/" -or $_ -match "/data/" -or $_ -match "\.env$" -or
    $_ -match "\.expo/" -or $_ -match "\.jks$" -or $_ -match "\.p8$" -or
    $_ -match "play-service-account\.json$"
}

if ($bad) {
    Say ""
    Say "  These must NOT go to GitHub:" "Red"
    $bad | Select-Object -First 15 | ForEach-Object { Say "    $_" "Red" }
    if ($bad.Count -gt 15) { Say "    ...and $($bad.Count - 15) more" "Red" }
    Say ""
    Die "Unstage them with 'git rm -r --cached <path>' and run this again. Do not push."
}
Ok "No dependencies, databases or secrets staged"

if ($count -gt 200) {
    Warn "$count files is more than expected (about 72). Check the list above."
} elseif ($count -lt 40) {
    Warn "Only $count files staged. Some may be missing - dotfiles are hidden in Explorer."
} else {
    Ok "File count looks right"
}

# --- 7. commit --------------------------------------------------------------
$hasCommits = $false
try { git rev-parse HEAD 2>$null | Out-Null; $hasCommits = $true } catch { }

if (-not $hasCommits) {
    git commit -m "Dispatch service, driver app and back office" | Out-Null
    Ok "Created the first commit"
} else {
    $pending = git diff --cached --name-only
    if ($pending) {
        git commit -m "Update" | Out-Null
        Ok "Committed changes"
    } else {
        Ok "Nothing new to commit"
    }
}

# --- 8. remote --------------------------------------------------------------
$remotes = git remote
if ($remotes -notcontains "origin") {
    git remote add origin $Repo
    Ok "Added origin: $Repo"
} else {
    git remote set-url origin $Repo
    Ok "Origin set to $Repo"
}

# --- 9. push ----------------------------------------------------------------
Say ""
if ($Push) {
    Say "Pushing to GitHub..." "Cyan"
    Say "  A browser may open to sign in. If the terminal asks for a password," "DarkGray"
    Say "  use a Personal Access Token instead - GitHub stopped accepting" "DarkGray"
    Say "  passwords in 2021." "DarkGray"
    git push -u origin main
    Say ""
    Ok "Pushed. Check the Actions tab: https://github.com/Wallisco/habibi-delivery/actions"
} else {
    Say "Everything is ready. Nothing has been pushed yet." "Cyan"
    Say ""
    Say "  Review what is about to go up:" "DarkGray"
    Say "    git status --short" "White"
    Say ""
    Say "  Then push:" "DarkGray"
    Say "    git push -u origin main" "White"
    Say ""
    Say "  Or re-run this script with -Push to do it now." "DarkGray"
}
Say ""
