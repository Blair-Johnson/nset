#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. rx retains artifacts relative to its worktree.
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/target}"
export NSET_BINARY="$CARGO_TARGET_DIR/release/nset"
export NSET_IMAGE_BINARY="$NSET_BINARY"
pixi run npm --prefix web ci
pixi run web-build
pixi run web-test
pixi run cargo fmt --all -- --check
pixi run cargo test --locked
pixi run cargo clippy --locked --all-targets -- -D warnings
pixi run cargo build --release --locked
pixi run python -m unittest discover -s tests -p 'test_*.py'
pixi run browser-install
CI=1 pixi run npm --prefix web run test:browser
pixi run python scripts/browser_verify.py
pixi run python scripts/benchmark.py
pixi run python scripts/browser_perf.py
pixi run python web/tests/shell-embedded.py
