# Build this checkout and replace the compiled Windows omp installation.
[CmdletBinding()]
param(
    [string]$InstallDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$packageDir = Join-Path $repoRoot 'packages\coding-agent'
$nativeDir = Join-Path $repoRoot 'packages\natives\native'
$distDir = Join-Path $packageDir 'dist'
$buildExe = Join-Path $distDir 'omp.exe'
$stamp = [Guid]::NewGuid().ToString('N')
$nativeBackups = @()
$oldBuild = $null
$oldInstall = $null
$staged = $null
$lock = $null
$installed = $false
$success = $false
$exitCode = 1
$originalLocation = Get-Location

function Invoke-Checked {
    param([string]$Executable, [string[]]$Arguments)
    # Windows PowerShell 5.1 treats native stderr as errors even for successful tools.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Executable @Arguments
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previous
    }
    if ($code -ne 0) { throw "$Executable exited with code $code" }
}

function Get-Sha256 {
    param([string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        return [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
}

try {
    if ($env:OS -ne 'Windows_NT') { throw 'This launcher requires Windows.' }
    if ($env:CROSS_TARGET) { throw 'Unset CROSS_TARGET before building a local Windows installation.' }
    $bun = (Get-Command bun -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $null = Get-Command git -CommandType Application -ErrorAction Stop
    if (-not $InstallDir) {
        $bunHome = if ($env:BUN_INSTALL) { $env:BUN_INSTALL } else { Join-Path $env:USERPROFILE '.bun' }
        $InstallDir = Join-Path $bunHome 'bin'
    }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $destination = Join-Path $InstallDir 'omp.exe'
    if ($destination -eq $buildExe) { throw 'InstallDir must differ from the build output directory.' }
    $null = New-Item -ItemType Directory -Force -Path $distDir
    # Prevent two invocations in this checkout from racing over build artifacts.
    $lock = [IO.File]::Open((Join-Path $distDir '.replace-global.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    Set-Location -LiteralPath $repoRoot
    . (Join-Path $PSScriptRoot 'windows-rust.ps1')
    $cargo = Ensure-WindowsCargo
    # Resolves/downloads the checkout's rust-toolchain.toml before touching artifacts.
    Invoke-Checked $cargo @('--version')
    Write-Host "Building checkout: $repoRoot"
    Write-Host "Installing to: $destination"

    Write-Host '[1/5] Installing workspace dependencies'
    Invoke-Checked $bun @('install')

    Write-Host '[2/5] Rebuilding native bindings'
    # Loaded DLLs cannot be overwritten, but Windows normally permits renaming them.
    # Keep originals until the entire build/install succeeds; do not kill sessions.
    $nativeBackupDir = Join-Path $nativeDir ".build\before-source-build-$stamp"
    foreach ($file in @(Get-ChildItem -LiteralPath $nativeDir -Filter 'pi_natives.win32-*.node' -File -ErrorAction SilentlyContinue)) {
        $null = New-Item -ItemType Directory -Force -Path $nativeBackupDir
        $backup = Join-Path $nativeBackupDir $file.Name
        Move-Item -LiteralPath $file.FullName -Destination $backup
        $nativeBackups += @{ Original = $file.FullName; Backup = $backup }
    }
    Invoke-Checked $bun @('run', 'build:native')

    Write-Host '[3/5] Compiling OMP'
    if (Test-Path -LiteralPath $buildExe) {
        $oldBuild = Join-Path $distDir "omp.before-source-build-$stamp.exe"
        Move-Item -LiteralPath $buildExe -Destination $oldBuild
    }
    Set-Location -LiteralPath $packageDir
    Invoke-Checked $bun @('run', 'build')
    if (-not (Test-Path -LiteralPath $buildExe -PathType Leaf)) { throw "Build did not produce $buildExe" }

    Write-Host '[4/5] Verifying candidate and staging installation'
    Invoke-Checked $buildExe @('--smoke-test')
    $expectedHash = Get-Sha256 $buildExe
    $null = New-Item -ItemType Directory -Force -Path $InstallDir
    $staged = Join-Path $InstallDir "omp-staged-$stamp.exe"
    Copy-Item -LiteralPath $buildExe -Destination $staged
    if ((Get-Sha256 $staged) -ne $expectedHash) { throw 'Staged executable hash mismatch.' }

    Write-Host '[5/5] Replacing and verifying installed executable'
    if (Test-Path -LiteralPath $destination) {
        $oldInstall = Join-Path $InstallDir "omp.before-source-build-$stamp.exe"
        Move-Item -LiteralPath $destination -Destination $oldInstall
    }
    Move-Item -LiteralPath $staged -Destination $destination
    $staged = $null
    $installed = $true
    Invoke-Checked $destination @('--smoke-test')
    if ((Get-Sha256 $destination) -ne $expectedHash) { throw 'Installed executable hash mismatch.' }
    $success = $true
    $exitCode = 0
    Write-Host "Installed: $destination"
    Write-Host "SHA256: $expectedHash"
    if ($oldInstall) { Write-Host "Previous executable: $oldInstall" }
    $resolved = Get-Command omp -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $resolved -or $resolved.Source -ne $destination) {
        Write-Warning "PATH does not select this executable. Put $InstallDir before other OMP installations on PATH, or invoke $destination directly."
    }
    Write-Host 'Restart running OMP sessions to load the new build. Configurations and sessions were not changed.'
} catch {
    Write-Host "Build/install failed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if (-not $success) {
        # Restore known-good artifacts. Rename failed files rather than deleting mapped images.
        try {
            if ($installed -and (Test-Path -LiteralPath $destination)) {
                Move-Item -LiteralPath $destination -Destination (Join-Path $InstallDir "omp.failed-source-build-$stamp.exe")
            }
            if ($oldInstall -and (Test-Path -LiteralPath $oldInstall)) { Move-Item -LiteralPath $oldInstall -Destination $destination }
            if ($oldBuild -and (Test-Path -LiteralPath $oldBuild)) {
                if (Test-Path -LiteralPath $buildExe) { Move-Item -LiteralPath $buildExe -Destination (Join-Path $distDir "omp.failed-source-build-$stamp.exe") }
                Move-Item -LiteralPath $oldBuild -Destination $buildExe
            }
            foreach ($entry in $nativeBackups) {
                if (Test-Path -LiteralPath $entry.Original) { Move-Item -LiteralPath $entry.Original -Destination ($entry.Backup + '.failed') }
                Move-Item -LiteralPath $entry.Backup -Destination $entry.Original
            }
        } catch {
            Write-Host "Automatic rollback failed: $($_.Exception.Message). Backups retain suffix $stamp." -ForegroundColor Red
        }
    }
    if ($staged -and (Test-Path -LiteralPath $staged)) { Remove-Item -LiteralPath $staged -Force -ErrorAction SilentlyContinue }
    if ($lock) { $lock.Dispose() }
    Set-Location -LiteralPath $originalLocation
}
exit $exitCode
