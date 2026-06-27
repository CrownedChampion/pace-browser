# Pace Browser — Windows Build Script
# Developed by That1Dev
# Run in PowerShell: .\BUILD.ps1
# Dev mode:         .\BUILD.ps1 -DevMode
# Skip npm install: .\BUILD.ps1 -SkipInstall

param([switch]$DevMode,[switch]$SkipInstall)
$ErrorActionPreference="Stop"

function W($m){Write-Host "  $m" -ForegroundColor Cyan}
function OK($m){Write-Host "  OK  $m" -ForegroundColor Green}
function ERR($m){Write-Host "  !! $m" -ForegroundColor Red}

Clear-Host
Write-Host ""
Write-Host "  ██████╗  █████╗  ██████╗███████╗" -ForegroundColor Cyan
Write-Host "  ██╔══██╗██╔══██╗██╔════╝██╔════╝" -ForegroundColor Cyan
Write-Host "  ██████╔╝███████║██║     █████╗  " -ForegroundColor Cyan
Write-Host "  ██╔═══╝ ██╔══██║██║     ██╔══╝  " -ForegroundColor Cyan
Write-Host "  ██║     ██║  ██║╚██████╗███████╗" -ForegroundColor Cyan
Write-Host "  ╚═╝     ╚═╝  ╚═╝ ╚═════╝╚══════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Pace Browser Build System  ·  Developed by That1Dev" -ForegroundColor White
Write-Host "  ═══════════════════════════════════════════════════" -ForegroundColor DarkGray
Write-Host ""

$ScriptDir=Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Node check
try{$nv=node --version 2>&1;OK "Node.js $nv"}
catch{ERR "Node.js not found — install from https://nodejs.org";exit 1}

# NOTE: Use Node 16.20.2 for best compatibility with this project's dependencies.
# Switch with nvm: nvm install 16.20.2 && nvm use 16.20.2

if(-not $SkipInstall){
  W "Installing dependencies (Electron ~120MB, please wait)..."
  npm install 2>&1|ForEach-Object{Write-Host "   $_" -ForegroundColor DarkGray}
  if($LASTEXITCODE -ne 0){ERR "npm install failed";exit 1}
  OK "Dependencies installed"
}

# Generate icon if missing
if(-not(Test-Path "src\assets\icons\icon.ico")){
  W "Generating placeholder icon..."
  New-Item -ItemType Directory -Force -Path "src\assets\icons"|Out-Null
  Add-Type -AssemblyName System.Drawing
  $bmp=New-Object System.Drawing.Bitmap(64,64)
  $g=[System.Drawing.Graphics]::FromImage($bmp)
  $bg=[System.Drawing.Drawing2D.LinearGradientBrush]::new([System.Drawing.Point]::new(0,0),[System.Drawing.Point]::new(64,64),[System.Drawing.Color]::FromArgb(255,91,142,240),[System.Drawing.Color]::FromArgb(255,167,139,250))
  $g.FillRectangle($bg,0,0,64,64)
  $font=New-Object System.Drawing.Font("Arial",32,[System.Drawing.FontStyle]::Bold)
  $wb=New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $g.DrawString("P",$font,$wb,10,8)
  $g.Dispose();$bmp.Save("src\assets\icons\icon.ico",[System.Drawing.Imaging.ImageFormat]::Icon);$bmp.Dispose()
  OK "Icon generated (replace with a proper 256x256 .ico for production)"
}

if($DevMode){
  W "Starting Pace Browser in dev mode..."
  npx electron .
}else{
  W "Building Windows installer..."
  npx electron-builder --win nsis --x64 2>&1|ForEach-Object{
    if($_-match"error|Error"){Write-Host "  $_" -ForegroundColor Red}
    elseif($_-match"packag|complet|success"){Write-Host "  $_" -ForegroundColor Green}
    else{Write-Host "  $_" -ForegroundColor DarkGray}
  }
  if($LASTEXITCODE -ne 0){ERR "Build failed";exit 1}
  $exe=Get-ChildItem -Path "dist" -Filter "*.exe" -Recurse -EA SilentlyContinue|Select-Object -First 1
  if($exe){
    Write-Host ""
    Write-Host "  ╔═══════════════════════════════════════════╗" -ForegroundColor Green
    Write-Host "  ║  Pace Browser installer ready!            ║" -ForegroundColor Green
    Write-Host "  ║                                           ║" -ForegroundColor Green
    Write-Host "  ║  $($exe.Name.PadRight(40))║" -ForegroundColor Cyan
    Write-Host "  ║  Size: $(("{0:N1} MB"-f($exe.Length/1MB)).PadRight(37))║" -ForegroundColor White
    Write-Host "  ╚═══════════════════════════════════════════╝" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Location: $($exe.FullName)" -ForegroundColor White
    Write-Host ""
    $o=Read-Host "  Open dist folder? (Y/N)"
    if($o-eq"Y"-or$o-eq"y"){Start-Process explorer.exe -ArgumentList $exe.DirectoryName}
  }
}
