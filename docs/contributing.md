# Development

The [README](../README.md#set-up-and-launch) covers setup and launch. Run these commands from the repository root. Pixi manages Rust, Node, and Python; a platform C/C++ build toolchain is needed for bundled SQLite. Use the committed Pixi, Cargo, and npm lockfiles.

`pixi run build` builds the UI and then the release executable, embedding `web/dist` in `target/release/nset` (`nset.exe` on Windows). Rebuild after source changes. Build for the target OS and architecture.

## Checks

```sh
pixi run check
pixi run format-check
pixi run api-test
```

`check` builds the UI and runs frontend unit tests and locked Cargo tests. `api-test` builds the debug server and runs Python tests with disposable server data. Official SDK tests require the compatibility environment:

```sh
pixi install -e compat --locked
pixi run -e compat compat-test
```

This enables the W&B SDK cases alongside MLflow checks. Inspect test output for skipped cases when running a smaller environment.

For browser fixtures:

```sh
pixi run browser-install
CI=1 pixi run npm --prefix web run test:browser
```

Playwright starts a local Vite server; `NSET_TEST_PORT` selects its port (default 4173). Failure screenshots and traces go to `web/test-results`. The broader `bash scripts/verify.sh` also builds a release binary, runs strict Clippy, installs Chromium, and exercises real-server browser journeys and performance probes. It is separate from the opt-in SDK check above.

## UI development

Start a server as in the README, then run:

```sh
pixi run npm --prefix web run dev
```

Vite forwards `/api` to `http://127.0.0.1:8080`; set `NSET_API` to use another backend. Enter the server token in the browser's connection dialog. For a seeded demo on a free port, run `pixi run preview --port 8081`. It builds and starts a loopback server using ignored `artifacts/preview-data`, with its token in `artifacts/preview.token`. Stop that foreground helper with Ctrl-C.

Bundled browser-library license notices are in [web/public/NOTICES.txt](../web/public/NOTICES.txt); preserve them when distributing the UI or executable.
