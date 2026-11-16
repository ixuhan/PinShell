$env:CARGO_HOME = 'F:\.toolchain\cargo'
$env:RUSTUP_HOME = 'F:\.toolchain\rustup'
$env:PATH = 'F:\.toolchain\cargo\bin;' + $env:PATH
Set-Location 'f:\PinShell'
npm run app:dev
