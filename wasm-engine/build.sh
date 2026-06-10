#!/usr/bin/env bash
# Build the Rust AI engine to WASM and embed it into the Angular sources.
set -euo pipefail
cd "$(dirname "$0")"

source "$HOME/.cargo/env" 2>/dev/null || true

# Threaded build: atomics + bulk-memory + a *shared*, imported memory so several
# Web Workers can instantiate the same module over one linear memory and share
# the transposition table. Needs nightly + build-std (the precompiled std isn't
# built with atomics). --export=__stack_pointer lets each worker relocate its
# shadow stack to a private region (see THREAD_STACK in lib.rs).
echo "Building WASM (release, threaded)…"
export RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
  -C link-arg=--shared-memory -C link-arg=--import-memory \
  -C link-arg=--max-memory=67108864 -C link-arg=--export=__stack_pointer"
cargo +nightly build --release --target wasm32-unknown-unknown \
  -Z build-std=std,panic_abort

echo "Embedding into src/app/services/gess-wasm.generated.ts…"
node embed.mjs

echo "Done."
