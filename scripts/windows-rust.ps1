# Return a usable Cargo executable without requiring a new terminal or user input.
function Ensure-WindowsCargo {
    $existing = Get-Command cargo -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($existing) { return $existing.Source }

    $cargoHome = if ($env:CARGO_HOME) { $env:CARGO_HOME } else { Join-Path $env:USERPROFILE '.cargo' }
    $cargoBin = Join-Path ([IO.Path]::GetFullPath($cargoHome)) 'bin'
    $cargo = Join-Path $cargoBin 'cargo.exe'
    if (Test-Path -LiteralPath $cargo -PathType Leaf) {
        $env:PATH = "$cargoBin;$env:PATH"
        return $cargo
    }

    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $target = switch ($architecture) {
        'AMD64' { 'x86_64-pc-windows-msvc' }
        'ARM64' { 'aarch64-pc-windows-msvc' }
        default { throw "Unsupported Windows Rust host architecture: $architecture" }
    }
    $url = "https://static.rust-lang.org/rustup/dist/$target/rustup-init.exe"
    $temp = Join-Path ([IO.Path]::GetTempPath()) ('omp-rustup-' + [Guid]::NewGuid().ToString('N'))
    $installer = Join-Path $temp 'rustup-init.exe'
    $null = New-Item -ItemType Directory -Path $temp
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        Write-Host 'Cargo not found. Installing Rust via official rustup without prompts...'
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $installer -TimeoutSec 300
        $checksum = (Invoke-WebRequest -UseBasicParsing -Uri ($url + '.sha256') -TimeoutSec 60).Content
        if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
        $expected = ([string]$checksum).Trim().Split()[0]
        if ($expected -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid rustup installer checksum response.' }
        if ((Get-Sha256 $installer) -ne $expected) { throw 'Rustup installer SHA256 mismatch; installation cancelled.' }
        # No default toolchain change: Cargo will install this checkout's pinned toolchain.
        # rustup also updates the user's PATH for future terminals.
        Invoke-Checked $installer @('-y', '--profile', 'minimal', '--default-toolchain', 'none') | Out-Host
        if (-not (Test-Path -LiteralPath $cargo -PathType Leaf)) { throw "Rustup completed without installing $cargo" }
        $env:PATH = "$cargoBin;$env:PATH"
        return $cargo
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
        Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
    }
}
