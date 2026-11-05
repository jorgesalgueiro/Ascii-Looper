# Run a command with the MSVC environment for this machine.
#
#   .\scripts\dev.ps1 cargo test
#   .\scripts\dev.ps1 cargo run --bin sine-out -- --list-hosts
#
# The Visual Studio install on this machine is portable and ships no Windows
# SDK, so vcvars64.bat is combined with the system Windows Kits 10 SDK.
# Override with ASCII_LOOPER_VCVARS if the toolchain moves.

param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Command
)

$ErrorActionPreference = 'Stop'

function Find-VcVars {
    if ($env:ASCII_LOOPER_VCVARS -and (Test-Path $env:ASCII_LOOPER_VCVARS)) {
        return $env:ASCII_LOOPER_VCVARS
    }
    $candidates = @(
        'D:\Jorge\Documents\Codex\Aion-Looper\.toolchain\vs2022\VC\Auxiliary\Build\vcvars64.bat'
    )
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vswhere) {
        $installs = & $vswhere -all -products * -property installationPath 2>$null
        foreach ($install in $installs) {
            $candidates += (Join-Path $install 'VC\Auxiliary\Build\vcvars64.bat')
        }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    throw 'vcvars64.bat not found. Set ASCII_LOOPER_VCVARS.'
}

$vcvars = Find-VcVars
# `set` after vcvars gives the complete environment (INCLUDE/LIB/PATH/...).
foreach ($line in (& cmd /c "`"$vcvars`" >nul 2>&1 && set")) {
    if ($line -match '^([^=]+)=(.*)$') {
        Set-Item -Path ("Env:" + $matches[1]) -Value $matches[2]
    }
}

$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path $cargoBin) {
    $env:PATH = $cargoBin + ';' + $env:PATH
}

if (-not $env:RUSTUP_TOOLCHAIN) {
    $env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
}

# ASIO is opt-in via `--features asio`. These are local, git-ignored paths:
# the Steinberg SDK and the libclang that bindgen needs.
if (-not $env:CPAL_ASIO_DIR -and (Test-Path 'D:\asio-sdk-gpl\common\asio.h')) {
    $env:CPAL_ASIO_DIR = 'D:\asio-sdk-gpl'
}
if (-not $env:LIBCLANG_PATH -and (Test-Path 'D:\llvm-libclang\runtimes\win-x64\native\libclang.dll')) {
    $env:LIBCLANG_PATH = 'D:\llvm-libclang\runtimes\win-x64\native'
}

& $Command[0] @($Command[1..($Command.Length - 1)])
exit $LASTEXITCODE
