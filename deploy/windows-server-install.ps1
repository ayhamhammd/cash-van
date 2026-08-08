# VanFlow server install - ERP + backend + dashboard. No mobile app.
#
# Two modes:
#   .\windows-server-install.ps1              # CHECK only - installs nothing
#   .\windows-server-install.ps1 -Install     # install whatever is missing
#
# Run as Administrator. Reboot when told to; WSL is not usable until you do.
#
# -- Read this before running on Windows SERVER -------------------------------
# Docker Desktop is supported on Windows 10/11 Pro/Enterprise, NOT on Windows
# Server. On Server the supported path for LINUX containers (which this image
# is) is Docker Engine inside a WSL2 distro, or a Linux VM. The script detects
# which OS it is on and tells you which path applies rather than installing
# something that cannot run the image.

param(
    [switch]$Install
)

$ErrorActionPreference = 'SilentlyContinue'
$script:Missing = @()

function Say($status, $name, $detail) {
    $c = switch ($status) { 'OK' {'Green'} 'MISSING' {'Red'} 'WARN' {'Yellow'} default {'Gray'} }
    Write-Host ("[{0,-7}] " -f $status) -ForegroundColor $c -NoNewline
    Write-Host ("{0,-26}" -f $name) -NoNewline
    Write-Host $detail -ForegroundColor DarkGray
}

# One line on purpose: a backtick line-continuation is the easiest thing in a
# PowerShell script to break with a stray trailing space.
$id = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Write-Host "`nRun this in an ADMINISTRATOR PowerShell.`n" -ForegroundColor Red; exit 1 }

Write-Host "`n=== VanFlow server - ERP + backend + dashboard ===`n" -ForegroundColor Cyan

# -- Which Windows is this? ---------------------------------------------------
$os       = Get-CimInstance Win32_OperatingSystem
$isServer = $os.ProductType -ne 1            # 1 = workstation
$build    = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber

Say 'INFO' 'Operating system' "$($os.Caption) (build $build)"
if ($isServer) {
    Say 'WARN' 'Docker Desktop' 'not supported on Windows Server - use Docker Engine inside WSL2, or a Linux VM'
}
if ($build -lt 19041) {
    Say 'MISSING' 'Windows build' "$build - WSL2 needs 19041+. Nothing below will work; upgrade first."
    exit 1
}

# -- 1. Virtualisation --------------------------------------------------------
# Checked first because it cannot be fixed by any installer - it is a firmware
# setting, and Docker installs successfully without it and then never starts.
if ($os.HypervisorPresent) {
    Say 'OK' 'Virtualisation' 'enabled'
} else {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    if ($cpu.VirtualizationFirmwareEnabled) {
        Say 'WARN' 'Virtualisation' 'on in firmware, hypervisor not started - WSL2 will enable it'
    } else {
        Say 'MISSING' 'Virtualisation' 'DISABLED in BIOS/UEFI - enable Intel VT-x / AMD-V, then re-run'
        Write-Host "`nStop here. No installer can fix this.`n" -ForegroundColor Red
        exit 1
    }
}

# -- 2. WSL2 ------------------------------------------------------------------
wsl.exe --status *> $null
if ($LASTEXITCODE -eq 0) {
    Say 'OK' 'WSL2' 'installed'
} else {
    Say 'MISSING' 'WSL2' 'not installed'
    $script:Missing += 'wsl'
}

# -- 3. Docker ----------------------------------------------------------------
if (Get-Command docker -ErrorAction SilentlyContinue) {
    Say 'OK' 'Docker' ((docker --version) 2>$null)
    $osType = (docker info --format '{{.OSType}}') 2>$null
    if ($LASTEXITCODE -ne 0) {
        Say 'WARN' 'Docker daemon' 'installed but not running - start it before deploying'
    } elseif ($osType -ne 'linux') {
        Say 'WARN' 'Container mode' "$osType - must be LINUX containers for this image"
    } else {
        Say 'OK' 'Container mode' 'Linux containers'
    }
} else {
    Say 'MISSING' 'Docker' 'not installed'
    $script:Missing += 'docker'
}

# -- 4. PostgreSQL ------------------------------------------------------------
# Not in the image. Two databases are needed: flowvan and erp_flowvan.
if (Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue) {
    Say 'OK' 'PostgreSQL' 'listening on 5432'
} elseif (Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue) {
    Say 'WARN' 'PostgreSQL' 'service present but stopped - start it'
} else {
    Say 'MISSING' 'PostgreSQL 16' 'not installed (or is on another server)'
    $script:Missing += 'postgres'
}

# -- 5. Ports -----------------------------------------------------------------
foreach ($p in 3000, 3001, 3100) {
    $u = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($u) {
        $n = (Get-Process -Id $u[0].OwningProcess).ProcessName
        Say 'WARN' "Port $p" "in use by '$n' - docker run will fail at bind"
    } else {
        Say 'OK' "Port $p" 'free'
    }
}

# -- Install ------------------------------------------------------------------
if (-not $Install) {
    Write-Host ""
    if ($script:Missing.Count -eq 0) {
        Write-Host "Everything required is present.`n" -ForegroundColor Green
    } else {
        Write-Host "Missing: $($script:Missing -join ', ')" -ForegroundColor Yellow
        Write-Host "Re-run with -Install to install them.`n" -ForegroundColor Yellow
    }
    exit 0
}

if ($script:Missing.Count -eq 0) { Write-Host "`nNothing to install.`n" -ForegroundColor Green; exit 0 }

# winget ships with Windows 10 1809+ and Server 2025. Older Server builds have
# no package manager, so the script points at the download instead of failing.
$winget = Get-Command winget -ErrorAction SilentlyContinue
Write-Host "`n--- Installing ---`n" -ForegroundColor Cyan

if ($script:Missing -contains 'wsl') {
    Write-Host "WSL2..." -ForegroundColor Cyan
    wsl.exe --install --no-distribution
    Write-Host "WSL2 installed - REBOOT before continuing.`n" -ForegroundColor Yellow
}

if ($script:Missing -contains 'docker') {
    if ($isServer) {
        Write-Host "Docker on Windows Server: install Docker Engine inside a WSL2 distro." -ForegroundColor Yellow
        Write-Host "  wsl --install -d Ubuntu-22.04" -ForegroundColor Gray
        Write-Host "  wsl -d Ubuntu-22.04 -- bash -c 'curl -fsSL https://get.docker.com | sh'" -ForegroundColor Gray
    } elseif ($winget) {
        Write-Host "Docker Desktop..." -ForegroundColor Cyan
        winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
    } else {
        Write-Host "No winget. Download: https://www.docker.com/products/docker-desktop" -ForegroundColor Yellow
    }
}

if ($script:Missing -contains 'postgres') {
    if ($winget) {
        Write-Host "PostgreSQL 16..." -ForegroundColor Cyan
        winget install --id PostgreSQL.PostgreSQL.16 -e --accept-source-agreements --accept-package-agreements
    } else {
        Write-Host "No winget. Download: https://www.postgresql.org/download/windows/" -ForegroundColor Yellow
    }
}

Write-Host @"

--- Next ---
1. Reboot if WSL2 was just installed.
2. Start Docker; confirm it is in LINUX container mode.
3. Create BOTH databases (two, not one):
     createdb -U postgres flowvan
     createdb -U postgres erp_flowvan
4. Run the migrations - they do NOT run on container start. See SETUP.md.
5. Start the container. See SETUP.md section 7.

"@ -ForegroundColor Cyan
