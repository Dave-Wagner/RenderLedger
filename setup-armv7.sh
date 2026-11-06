#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

if ! command -v rustup >/dev/null; then
  printf '%s\n' 'Run this script in Ubuntu WSL with Rustup available.' >&2
  exit 1
fi

target=armv7-unknown-linux-gnueabihf
rustup target add "$target"

if ! command -v arm-linux-gnueabihf-gcc >/dev/null || ! command -v qemu-arm >/dev/null; then
  sudo apt-get update
  sudo apt-get install -y gcc-arm-linux-gnueabihf qemu-user
fi

export CARGO_TARGET_ARMV7_UNKNOWN_LINUX_GNUEABIHF_LINKER=arm-linux-gnueabihf-gcc
export CC_armv7_unknown_linux_gnueabihf=arm-linux-gnueabihf-gcc
cargo build --locked --release --target "$target" --target-dir target/wsl-cross
binary="target/wsl-cross/$target/release/renderledger"
qemu-arm -L /usr/arm-linux-gnueabihf "$binary" --help
printf '\nARMv7 executable: %s\n' "$binary"
