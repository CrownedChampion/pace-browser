# ============================================================
#  Pace Browser - One-Command Release Script
#  Usage:  .\release.ps1 1.2.9  "what changed in this release"
#
#  This does EVERYTHING:
#   1. Sets the version in package.json
#   2. Commits and pushes your code (updates the website too)
#   3. Creates the version tag and pushes it
#   4. GitHub Actions then builds the installer and publishes it
#      to your Releases page automatically (takes a few minutes).
#
#  You do NOT build the .exe yourself - the cloud does it.
# ============================================================

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [Parameter(Mandatory = $false, Position = 1)]
    [string]$Message = ""
)

$ErrorActionPreference = "Stop"

# --- Normalize version: strip a leading "v" if the user typed one ---
$Version = $Version.TrimStart("v", "V")
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Host "ERROR: Version must look like 1.2.9 (numbers only)." -ForegroundColor Red
    exit 1
}
$Tag = "v$Version"
if ([string]::IsNullOrWhiteSpace($Message)) { $Message = "Release $Tag" }

Write-Host ""
Write-Host "=== Releasing Pace Browser $Tag ===" -ForegroundColor Cyan
Write-Host ""

# --- Make sure we're in a git repo ---
if (-not (Test-Path ".git")) {
    Write-Host "ERROR: This folder is not a git repository." -ForegroundColor Red
    Write-Host "Run this script from your pace-browser folder (the one with the .git folder)." -ForegroundColor Yellow
    exit 1
}

# --- 1. Set the version in package.json ---
Write-Host "[1/5] Setting version to $Version in package.json..." -ForegroundColor Green
$pkgPath = "package.json"
$pkg = Get-Content $pkgPath -Raw
$pkg = $pkg -replace '"version":\s*"[0-9.]+"', "`"version`": `"$Version`""
Set-Content $pkgPath $pkg -NoNewline

# --- 2. Pull any remote changes first (avoids "fetch first" rejections) ---
Write-Host "[2/5] Syncing with GitHub..." -ForegroundColor Green
try {
    git pull origin main --no-edit 2>&1 | Out-Host
} catch {
    Write-Host "Pull reported an issue. If it's a merge conflict, resolve it and re-run." -ForegroundColor Yellow
}

# --- 3. Commit and push the code ---
Write-Host "[3/5] Committing and pushing code..." -ForegroundColor Green
git add .
# Only commit if there's something to commit
$changes = git status --porcelain
if ($changes) {
    git commit -m "$Version`: $Message"
} else {
    Write-Host "      (no file changes to commit - pushing tag only)" -ForegroundColor DarkGray
}
git push origin main

# --- 4. Replace the tag (delete old one if it exists, then create fresh) ---
Write-Host "[4/5] Creating release tag $Tag..." -ForegroundColor Green
git tag -d $Tag 2>$null | Out-Null
git push origin ":refs/tags/$Tag" 2>$null | Out-Null
git tag $Tag
git push origin $Tag

# --- 5. Done ---
Write-Host ""
Write-Host "[5/5] DONE!" -ForegroundColor Green
Write-Host ""
Write-Host "GitHub Actions is now building the installer." -ForegroundColor Cyan
Write-Host "Watch it here:  https://github.com/CrownedChampion/pace-browser/actions" -ForegroundColor White
Write-Host ""
Write-Host "When the build turns green (a few minutes), the installer" -ForegroundColor Cyan
Write-Host "appears here:   https://github.com/CrownedChampion/pace-browser/releases" -ForegroundColor White
Write-Host ""
Write-Host "IMPORTANT: Make sure the release is PUBLISHED, not a draft," -ForegroundColor Yellow
Write-Host "or auto-update won't see it." -ForegroundColor Yellow
Write-Host ""
