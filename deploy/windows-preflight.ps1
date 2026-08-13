# VanFlow suite - Windows pre-flight check
#
# Run on the CLIENT's Windows desktop BEFORE installing, to find out what is
# missing. Reads only - installs nothing, changes nothing.
#
#   1. Right-click Start -> "Terminal (Admin)" or "Windows PowerShell (Admin)"
#   2. Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. .\windows-preflight.ps1
#
# Admin is not strictly required, but without it the virtualisation and service
# checks report "unknown" instead of an answer.

$ErrorActionPreference = 'SilentlyContinue'
$script:Fail = 0
$script:Warn = 0

function Say($status, $name, $detail) {
    $colour = switch ($status) { 'PASS' {'Green'} 'WARN' {'Yellow'} 'FAIL' {'Red'} default {'Gray'} }
    Write-Host ("[{0}] " -f $status) -ForegroundColor $colour -NoNewline
    Write-Host ("{0,-34}" -f $name) -NoNewline
    Write-Host $detail -ForegroundColor DarkGray
    if ($status -eq 'FAIL') { $script:Fail++ }
    if ($status -eq 'WARN') { $script:Warn++ }
}

Write-Host "`n=== VanFlow suite - Windows pre-flight ===`n" -ForegroundColor Cyan

# -- 1. Windows version -------------------------------------------------------
# Docker Desktop needs the WSL2 backend, which needs build 19041 (Windows 10
# 2004) or newer. Older builds cannot run this image at all.
$os    = Get-CimInstance Win32_OperatingSystem
$build = [int](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion').CurrentBuildNumber
if ($build -ge 19041) {
    Say 'PASS' 'Windows version' "$($os.Caption) (build $build)"
} else {
    Say 'FAIL' 'Windows version' "$($os.Caption) build $build - need 19041+ (Win10 2004) for WSL2"
}

# -- 2. 64-bit ----------------------------------------------------------------
if ([Environment]::Is64BitOperatingSystem) {
    Say 'PASS' 'Architecture' '64-bit'
} else {
    Say 'FAIL' 'Architecture' '32-bit - Docker Desktop requires 64-bit'
}

# -- 3. Virtualisation --------------------------------------------------------
# The single most common blocker on client machines: virtualisation disabled in
# BIOS/UEFI. Docker Desktop installs fine and then refuses to start.
$virt = $os.HypervisorPresent
if ($virt -eq $true) {
    Say 'PASS' 'Virtualisation' 'enabled (hypervisor present)'
} else {
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    if ($cpu.VirtualizationFirmwareEnabled -eq $true) {
        Say 'WARN' 'Virtualisation' 'enabled in firmware, hypervisor not running - enable WSL2/Hyper-V'
    } else {
        Say 'FAIL' 'Virtualisation' 'DISABLED - turn on Intel VT-x / AMD-V in BIOS/UEFI first'
    }
}

# -- 4. WSL2 ------------------------------------------------------------------
$wsl = (wsl.exe --status) 2>$null
if ($LASTEXITCODE -eq 0) {
    $ver = (wsl.exe --list --verbose) 2>$null | Out-String
    if ($ver -match '\s2\s*$' -or $ver -match '\s2\s') {
        Say 'PASS' 'WSL2' 'installed, a version-2 distro present'
    } else {
        Say 'WARN' 'WSL2' 'WSL present but no version-2 distro - run: wsl --set-default-version 2'
    }
} else {
    Say 'FAIL' 'WSL2' 'not installed - run: wsl --install   (then reboot)'
}

# -- 5. Docker ----------------------------------------------------------------
$docker = Get-Command docker -ErrorAction SilentlyContinue
if ($docker) {
    $dv = (docker --version) 2>$null
    Say 'PASS' 'Docker installed' $dv

    $info = (docker info --format '{{.OSType}}|{{.ServerVersion}}|{{.MemTotal}}') 2>$null
    if ($LASTEXITCODE -eq 0 -and $info) {
        $parts = $info -split '\|'
        Say 'PASS' 'Docker daemon' "running (server $($parts[1]))"

        # Windows-container mode cannot run a Linux image. Silent and confusing:
        # the pull fails with a manifest error that reads like a bad image.
        if ($parts[0] -eq 'linux') {
            Say 'PASS' 'Container mode' 'Linux containers'
        } else {
            Say 'FAIL' 'Container mode' "$($parts[0]) - right-click the Docker tray icon -> Switch to Linux containers"
        }

        $memGb = [math]::Round([double]$parts[2] / 1GB, 1)
        if ($memGb -ge 4) {
            Say 'PASS' 'Memory given to Docker' "$memGb GB"
        } else {
            Say 'WARN' 'Memory given to Docker' "$memGb GB - raise to 4GB+ (Settings -> Resources); three Node apps share it"
        }
    } else {
        Say 'FAIL' 'Docker daemon' 'not running - start Docker Desktop and wait for the whale to settle'
    }
} else {
    Say 'FAIL' 'Docker installed' 'not found - install Docker Desktop for Windows'
}

# -- 6. Disk ------------------------------------------------------------------
# The image plus the WSL virtual disk it unpacks into. WSL2's vhdx grows and
# does not shrink on its own, so headroom matters more than the image size.
$sys  = (Get-Item Env:SystemDrive).Value
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$sys'"
$freeGb = [math]::Round($disk.FreeSpace / 1GB, 1)
if ($freeGb -ge 20)    { Say 'PASS' 'Free disk space' "$freeGb GB on $sys" }
elseif ($freeGb -ge 10){ Say 'WARN' 'Free disk space' "$freeGb GB on $sys - tight; 20GB+ recommended" }
else                   { Say 'FAIL' 'Free disk space' "$freeGb GB on $sys - need 10GB minimum" }

# -- 7. RAM -------------------------------------------------------------------
$ramGb = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
if ($ramGb -ge 8)    { Say 'PASS' 'System RAM' "$ramGb GB" }
elseif ($ramGb -ge 4){ Say 'WARN' 'System RAM' "$ramGb GB - will run, but slowly with a database alongside" }
else                 { Say 'FAIL' 'System RAM' "$ramGb GB - 4GB minimum" }

# -- 8. Ports -----------------------------------------------------------------
# 3000 ERP, 3001 dashboard, 3100 backend. Anything already listening makes
# `docker run` fail at the port bind, after the image has downloaded.
foreach ($p in 3000, 3001, 3100) {
    $inUse = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($inUse) {
        $procName = (Get-Process -Id $inUse[0].OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Say 'FAIL' "Port $p" "in use by '$procName' (PID $($inUse[0].OwningProcess))"
    } else {
        Say 'PASS' "Port $p" 'free'
    }
}

# -- 9. PostgreSQL ------------------------------------------------------------
# THE IMAGE CONTAINS NO DATABASE. All three apps need PostgreSQL 16 reachable,
# with TWO databases: flowvan and erp_flowvan.
$pg = Get-Service -Name 'postgresql*' -ErrorAction SilentlyContinue
$pgPort = Get-NetTCPConnection -LocalPort 5432 -State Listen -ErrorAction SilentlyContinue
if ($pgPort) {
    Say 'PASS' 'PostgreSQL' 'something is listening on 5432'
} elseif ($pg) {
    Say 'WARN' 'PostgreSQL' "service '$($pg.Name)' is $($pg.Status) - start it, or point at a remote server"
} else {
    Say 'WARN' 'PostgreSQL' 'not found locally - install PostgreSQL 16, or use a remote server'
}
Say 'INFO' 'Databases required' 'flowvan  +  erp_flowvan  (two, not one)'

# -- 10. Internet -------------------------------------------------------------
if (Test-NetConnection -ComputerName 'registry-1.docker.io' -Port 443 -InformationLevel Quiet) {
    Say 'PASS' 'Reach Docker registry' 'registry-1.docker.io:443'
} else {
    Say 'WARN' 'Reach Docker registry' 'unreachable - you will need the image as a .tar file'
}

# -- Summary ------------------------------------------------------------------
Write-Host ""
if ($script:Fail -gt 0) {
    Write-Host "$($script:Fail) blocker(s), $($script:Warn) warning(s). Fix the FAIL lines before installing." -ForegroundColor Red
} elseif ($script:Warn -gt 0) {
    Write-Host "Ready, with $($script:Warn) warning(s) worth reading." -ForegroundColor Yellow
} else {
    Write-Host "All checks passed - ready to install." -ForegroundColor Green
}
Write-Host ""
