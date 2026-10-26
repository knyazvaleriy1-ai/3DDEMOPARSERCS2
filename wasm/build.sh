#!/usr/bin/env bash
# Build the in-browser demo parser: demoparser2's Rust parser compiled to
# WebAssembly, written to cs2demo/web/vendor/demoparser/.
#
# Needs: rustup target add wasm32-unknown-unknown
#        wasm-bindgen CLI of the same version as the crate (0.2.100)
set -euo pipefail
cd "$(dirname "$0")"

DEMOPARSER_REPO=https://github.com/LaihoE/demoparser
DEMOPARSER_REV=v0.42.1          # same parser as the Python package
WASM_BINDGEN=${WASM_BINDGEN:-wasm-bindgen}
OUT=../cs2demo/web/vendor/demoparser

if [ ! -d vendor/demoparser ]; then
  git clone --depth 1 --branch "$DEMOPARSER_REV" "$DEMOPARSER_REPO" vendor/demoparser
  # std::time::Instant panics on wasm32-unknown-unknown; the parser only uses
  # it for optional profiling output, so swap in a wasm-safe clock.
  grep -rl 'std::time::Instant' vendor/demoparser/src/parser/src | xargs sed -i 's/std::time::Instant/crate::wasm_clock::Instant/g'
  # The WALK button prop is mapped to "IN_WALK", which is not in BUTTONMAP,
  # so it never comes out; the on-screen keyboard needs it for Shift.
  sed -i 's/"WALK" => "IN_WALK",/"WALK" => "WALK",/' vendor/demoparser/src/parser/src/maps.rs
  # csgoproto's build script regenerates protobuf.rs from the latest
  # GameTracking-CS2 checkout (needs protoc, not reproducible); the release
  # already ships the generated file.
  rm vendor/demoparser/src/csgoproto/build.rs
  cat >> vendor/demoparser/src/parser/src/lib.rs <<'RS'

pub mod wasm_clock {
    /// Stand-in for std::time::Instant (unsupported on wasm32): always zero.
    #[derive(Clone, Copy)]
    pub struct Instant;
    impl Instant {
        pub fn now() -> Self { Instant }
        pub fn elapsed(&self) -> std::time::Duration { std::time::Duration::ZERO }
    }
}
RS
fi

cargo build --release --target wasm32-unknown-unknown
mkdir -p "$OUT"
"$WASM_BINDGEN" --target web --no-typescript --out-dir "$OUT" \
  target/wasm32-unknown-unknown/release/cs2wasm.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 --enable-bulk-memory --enable-nontrapping-float-to-int "$OUT/cs2wasm_bg.wasm" -o "$OUT/cs2wasm_bg.wasm"
fi
ls -la "$OUT"
