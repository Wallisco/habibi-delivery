<#
    install.ps1  -  Habibi local setup, start to finish.

    Run once from the folder holding dispatch-service and driver-app:

        cd C:\Users\wahli\Habibi\Habibi_v3
        powershell -ExecutionPolicy Bypass -File .\install.ps1

    Checks the files are all present, installs both projects, runs every test,
    writes the app config, and prepares the git repo. Nothing is pushed and
    nothing is deployed - those are separate, deliberate steps.

    Safe to run repeatedly.
#>

param(
    [string]$ApiUrl   = "https://habibi-api.quikr.co.za",
    [string]$Repo     = "https://github.com/Wallisco/habibi-delivery.git",
    [string]$Name     = "Wahlied",
    [string]$Email    = "wahlied@quikr.co.za",
    [string]$EasProjectId = "bb57e84f-872a-489a-952e-674a171b2bb0",
    [switch]$SkipTests
)

$ErrorActionPreference = "Stop"
function Say($m,$c="White"){ Write-Host $m -ForegroundColor $c }
function Step($n,$m){ Say ""; Say "[$n] $m" "Cyan"; Say ("-" * (($m.Length)+6)) "DarkGray" }
function Ok($m){ Say "  ok    $m" "Green" }
function Warn($m){ Say "  warn  $m" "Yellow" }
function Die($m){ Say "  STOP  $m" "Red"; exit 1 }

Say ""
Say "Habibi setup" "Cyan"
Say "============" "Cyan"
Say "  folder : $(Get-Location)"
Say "  api    : $ApiUrl"

# ---------------------------------------------------------------- 1. layout
Step 1 "Checking the files are all here"

if (-not (Test-Path "dispatch-service") -or -not (Test-Path "driver-app")) {
    Die "Run this from the folder containing dispatch-service and driver-app."
}

# Every file the system will not start without. Checking now beats a confusing
# runtime error twenty minutes later.
$required = @(
    "dispatch-service\package.json"
    "dispatch-service\src\server.js"
    "dispatch-service\src\dispatch.js"
    "dispatch-service\src\readyGate.js"
    "dispatch-service\src\rates.js"
    "dispatch-service\src\fees.js"
    "dispatch-service\src\batching.js"
    "dispatch-service\src\accounts.js"
    "dispatch-service\src\orders.js"
    "dispatch-service\src\keychat.js"
    "dispatch-service\src\routing.js"
    "dispatch-service\src\db.js"
    "dispatch-service\public\ops.html"
    "dispatch-service\public\track.html"
    "dispatch-service\public\vendor\leaflet.js"
    "dispatch-service\public\vendor\leaflet.css"
    "driver-app\package.json"
    "driver-app\app.json"
    "driver-app\App.js"
    "driver-app\src\state\store.js"
    "driver-app\src\lib\api.js"
    "driver-app\src\components\MapPanel.js"
    "driver-app\src\screens\ShiftScreen.js"
    "driver-app\src\screens\RunScreen.js"
)
$missing = $required | Where-Object { -not (Test-Path $_) }
if ($missing) {
    Say "  These are missing:" "Red"
    $missing | ForEach-Object { Say "    $_" "Red" }
    Die "Extract habibi-delivery.zip into this folder and run again."
}
Ok "$($required.Count) key files present"

# ------------------------------------------------------------ 2. toolchain
Step 2 "Checking Node"

try { $nodeV = (node -v).TrimStart('v') } catch { Die "Node is not installed. Get the LTS from nodejs.org." }
if ([int]($nodeV.Split('.')[0]) -lt 20) { Die "Node $nodeV is too old. Version 20 or newer is required." }
Ok "Node $nodeV"

try { git --version | Out-Null; Ok "Git present" } catch { Die "Git is not installed. Get it from git-scm.com." }

# ------------------------------------------------------------- 3. app config
Step 3 "Writing the app config"

$appJsonPath = "driver-app\app.json"
$app = Get-Content $appJsonPath -Raw | ConvertFrom-Json

$app.expo.extra.apiBaseUrl = $ApiUrl
$app.expo.extra.demoMode   = $false
if (-not $app.expo.extra.eas) {
    $app.expo.extra | Add-Member -NotePropertyName eas -NotePropertyValue ([pscustomobject]@{ projectId = $EasProjectId })
} else {
    $app.expo.extra.eas.projectId = $EasProjectId
}

# The bundle identifier is permanent after the first store submission, so it
# must not be left as the placeholder.
if ($app.expo.android.package -like "*REPLACE*") { $app.expo.android.package = "za.co.habibi.driver" }
if ($app.expo.ios.bundleIdentifier -like "*REPLACE*") { $app.expo.ios.bundleIdentifier = "za.co.habibi.driver" }

$app | ConvertTo-Json -Depth 20 | Set-Content $appJsonPath -Encoding UTF8
Ok "apiBaseUrl  $ApiUrl"
Ok "demoMode    false"
Ok "package     $($app.expo.android.package)"
Ok "eas project $EasProjectId"

# ------------------------------------------------------------- 4. dependencies
Step 4 "Installing dependencies (a few minutes)"

Push-Location dispatch-service
Say "  dispatch-service..." "DarkGray"
npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "dispatch-service install failed. Run 'npm install' there to see why." }
Pop-Location
Ok "dispatch-service"

Push-Location driver-app
Say "  driver-app... (larger, be patient)" "DarkGray"
npm install --silent 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) { Pop-Location; Die "driver-app install failed. Run 'npm install' there to see why." }
Pop-Location
Ok "driver-app"

# ------------------------------------------------------------------ 5. tests
if (-not $SkipTests) {
    Step 5 "Running the tests"

    Push-Location dispatch-service
    $out = npm test 2>&1 | Out-String
    Pop-Location
    if ($out -match "# fail (\d+)" -and [int]$Matches[1] -gt 0) {
        Say $out "Red"; Die "Service tests failed. Do not deploy this."
    }
    if ($out -match "# pass (\d+)") { Ok "$($Matches[1]) service tests passed" } else { Warn "Could not read the test count" }

    Push-Location driver-app
    $out = npm test 2>&1 | Out-String
    Pop-Location
    if ($out -match "(\d+) passed, (\d+) failed") {
        if ([int]$Matches[2] -gt 0) { Die "App tests failed." }
        Ok "$($Matches[1]) app tests passed"
    }

    # Every screen must survive the real Expo transform. This is the check that
    # catches a missing dependency before it reaches a phone.
    Push-Location driver-app
    $compile = node -e "
      const b=require('@babel/core'),fs=require('fs'),p=require('path');
      const walk=(d)=>fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>
        e.isDirectory()?walk(p.join(d,e.name)):e.name.endsWith('.js')?[p.join(d,e.name)]:[]);
      const files=['App.js','index.js',...walk('src')];let bad=0;
      for(const f of files){try{b.transformSync(fs.readFileSync(f,'utf8'),
        {filename:f,presets:['babel-preset-expo']})}catch(e){bad++;console.error('FAIL '+f)}}
      console.log(bad?('BAD '+bad):(files.length+' files compile'));" 2>&1 | Out-String
    Pop-Location
    if ($compile -match "BAD") { Say $compile "Red"; Die "Some app files do not compile." }
    Ok $compile.Trim()
} else {
    Step 5 "Skipping tests (-SkipTests)"
}

# -------------------------------------------------------------------- 6. git
Step 6 "Preparing the repository"

git config --global user.name  $Name
git config --global user.email $Email
git config --global core.editor notepad
Ok "identity $Name <$Email>"
Ok "editor set to notepad, so merges do not drop you into Vim"

if (-not (Test-Path ".gitignore")) {
    @(
        'node_modules/','data/','.expo/','dist/','*.log','.env','*.jks','*.p8'
        '*.p12','*.key','*.mobileprovision','play-service-account.json','.DS_Store'
    ) -join "`r`n" | Set-Content ".gitignore" -Encoding UTF8
    Ok "created .gitignore"
} else { Ok ".gitignore present" }

if (-not (Test-Path ".git")) { git init | Out-Null; Ok "initialised" } else { Ok "already a repository" }
git branch -M main
git add -A

$staged = git diff --cached --name-only
$count  = ($staged | Measure-Object -Line).Lines
$bad = $staged | Where-Object {
    $_ -match "node_modules/" -or $_ -match "/data/" -or $_ -match "\.env$" -or $_ -match "\.expo/"
}
if ($bad) {
    $bad | Select-Object -First 10 | ForEach-Object { Say "    $_" "Red" }
    Die "Dependencies or secrets are staged. Fix .gitignore, run 'git rm -r --cached .', try again."
}
Ok "$count files staged, nothing sensitive"

if ($(git remote) -notcontains "origin") { git remote add origin $Repo } else { git remote set-url origin $Repo }
Ok "origin $Repo"

# ------------------------------------------------------------------- done
Say ""
Say "Local setup complete." "Green"
Say ""
Say "  Next, in order:" "Cyan"
Say "    1. Start it locally and check it works:"
Say "         cd dispatch-service; npm start" "White"
Say "         then open http://localhost:3000/ops" "DarkGray"
Say ""
Say "    2. Push to GitHub:"
Say "         git add -A; git commit -m 'Initial'; git push -u origin main" "White"
Say ""
Say "    3. Deploy to the server:"
Say "         ssh root@169.255.59.165" "White"
Say "         cd /opt/dispatch && git pull && systemctl restart dispatch" "White"
Say ""
Say "    4. Build the app:"
Say "         cd driver-app; eas build --profile preview --platform android" "White"
Say ""
