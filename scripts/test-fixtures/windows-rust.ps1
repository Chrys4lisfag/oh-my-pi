param($Helper, $Fixture, $Mode)
$ErrorActionPreference = 'Stop'
function Get-Sha256($Path) {
    $s = [IO.File]::OpenRead($Path)
    $h = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($h.ComputeHash($s)).Replace('-', '') } finally { $s.Dispose(); $h.Dispose() }
}
# Isolate downloads from the network, but run the actual bootstrap and installer process.
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Uri, $OutFile, $TimeoutSec)
    if ($Mode -eq 'existing') { throw 'Existing Cargo must not trigger a download' }
    if ($Uri -notlike 'https://static.rust-lang.org/rustup/dist/*/rustup-init.exe*') { throw 'Wrong installer origin' }
    if ($OutFile) { [IO.File]::Copy($Fixture, $OutFile); return }
    $hash = Get-Sha256 $Fixture
    if ($Mode -eq 'bad-checksum') { $hash = '0' * 64 }
    @{ Content = [Text.Encoding]::UTF8.GetBytes($hash) }
}
function Invoke-Checked($Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "installer exited with code $LASTEXITCODE" }
}
. $Helper
try {
    $cargo = Ensure-WindowsCargo
    & $cargo '--version'
    if ($LASTEXITCODE -ne 0) { throw 'Installed Cargo cannot execute' }
    if ((Get-Command cargo -CommandType Application).Source -ne $cargo) { throw 'Cargo missing from current PATH' }
    Write-Output 'cargo-ready'
} catch { Write-Output $_.Exception.Message; exit 1 }
