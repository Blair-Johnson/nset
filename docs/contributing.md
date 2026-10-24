# Building and contributing

The README contains a quick start. This guide covers source builds and development checks in more detail.

## Locked source build

Install Pixi and a platform C/C++ build toolchain (SQLite is compiled into the executable). From the repository root:

```sh
pixi install --locked
pixi run web-install
pixi run build
```

Pixi manages Rust, Node and the development Python environment. `web-install` uses `npm --prefix web ci`; the build task first builds the UI, then runs `cargo build --release --locked`. The Rust build embeds `web/dist`, so do not bypass the UI build with a direct Cargo invocation. Use the committed Pixi, Cargo and npm lockfiles.

The result is `target/release/nset` (`nset.exe` on Windows). Build separately for the target OS/architecture. The built executable contains the UI and serves native, MLflow and W&B routes itself: deploying it does not require Python, Node, a compatibility process or a second HTTP port. Platform declarations are not evidence that every platform has passed the current test gates.

Run the executable with the `serve` command documented in `README.md` (use `./target/release/nset` if it is not on PATH). No backward-compatibility or migration path from earlier test-data servers is provided.

## Producer dependencies

The dependency-free native Python client can be installed from this checkout with `pip install ./python`. Install official MLflow or W&B SDKs in the training environment when using those protocols. The optional TensorBoard collector needs Python and the `nset-client[tensorboard]` extra on the producer machine, not on the server. See `docs/client-compatibility.md`.

For source-based SDK checks, the optional locked environment is installed with:

```sh
pixi install -e compat --locked
```

## Development checks

```sh
pixi run check
pixi run format-check
NSET_BINARY="$PWD/target/release/nset" pixi run python -m unittest discover -s tests -p 'test_*.py'
```

`check` runs the frontend build/unit checks and locked Cargo tests. Python tests use the binary named by `NSET_BINARY`; rebuild it after server changes. The broader acceptance entry point is `bash scripts/verify.sh`, which also installs Chromium for browser checks. These are instructions, not a statement that the current source has passed them.

Record exact commands, source revision, dependency versions and results for standalone-server and real-SDK gates. Keep historical native/gateway results distinct from current same-process compatibility validation. Throughput, latency and parity claims require their own matching evidence; unit tests alone do not establish them.

## Example data

For an isolated source-development demo, `pixi run preview` builds and launches a loopback instance and seeds example runs. It prints the address and uses ignored `artifacts/preview-data` with its token in `artifacts/preview.token`. Stop the foreground command with Ctrl-C. This is a development helper, not the deployment entry point.

To seed an already-running server with a matching token file:

```sh
pixi run python examples/demo.py --token-file ./access-token
```

The examples contain irregular scalar observations and native PNG sequences; they do not exercise unsupported generic artifact uploads.
