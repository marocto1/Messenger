param([ValidateSet('web','desktop','build:desktop','build:android','release:android','open:android','prepare:android')][string]$Mode = 'web')
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 22 or newer, then reopen this console.' }
node scripts/run.mjs $Mode
exit $LASTEXITCODE
