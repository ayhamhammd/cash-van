<#
  export-onprem.ps1 — dump the ERP + VanFlow Postgres databases from their Docker
  containers on the client (Windows) server into local custom-format .dump files.

  Run on the CLIENT SERVER (PowerShell), from any folder:
      .\export-onprem.ps1                       # writes to the current folder
      .\export-onprem.ps1 -OutDir C:\dumps      # writes to C:\dumps
      .\export-onprem.ps1 -SkipVan              # ERP only

  Then copy the two .dump files to your Mac and run import-local.sh there.
#>
param(
  [string]$OutDir       = ".",
  [string]$ErpContainer = "erp-postgres",
  [string]$ErpUser      = "postgres",
  [string]$ErpDb        = "erp_database",
  [string]$VanContainer = "cashvan-db",
  [string]$VanUser      = "cashvan",
  [string]$VanDb        = "cashvan",
  [switch]$SkipErp,
  [switch]$SkipVan
)

$ErrorActionPreference = "Stop"

function Test-Container([string]$name) {
  $names = docker ps --format "{{.Names}}"
  return ($names -split "`n") -contains $name
}

function Invoke-Dump([string]$container, [string]$user, [string]$db, [string]$outFile) {
  if (-not (Test-Container $container)) {
    Write-Host "  ! container '$container' not running — skipping $db. (check 'docker ps')" -ForegroundColor Yellow
    return
  }
  Write-Host "-> dumping '$db' from '$container' ..." -ForegroundColor Cyan
  docker exec $container pg_dump -U $user -Fc -f /tmp/dump.out $db
  docker cp "${container}:/tmp/dump.out" $outFile
  docker exec $container rm -f /tmp/dump.out
  $mb = [math]::Round((Get-Item $outFile).Length / 1MB, 2)
  Write-Host "   OK  $outFile  ($mb MB)" -ForegroundColor Green
}

# sanity: docker reachable
docker version | Out-Null

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$erpOut = Join-Path $OutDir "erp-$stamp.dump"
$vanOut = Join-Path $OutDir "cashvan-$stamp.dump"

if (-not $SkipErp) { Invoke-Dump $ErpContainer $ErpUser $ErpDb $erpOut }
if (-not $SkipVan) { Invoke-Dump $VanContainer $VanUser $VanDb $vanOut }

Write-Host ""
Write-Host "Done. Copy these to your Mac (~/dumps), then run import-local.sh:" -ForegroundColor Yellow
if (Test-Path $erpOut) { Write-Host "  $erpOut" }
if (Test-Path $vanOut) { Write-Host "  $vanOut" }
