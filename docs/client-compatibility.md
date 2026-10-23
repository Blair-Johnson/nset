# Client compatibility: status and implementation contract

## Current support

As of source `cea8ccd`, nset serves its own authenticated `/api` routes only. No MLflow tracking, W&B SDK transport or TensorBoard event ingestion is implemented or SDK-tested. The native Python client is not a substitute for those protocols. This document is a design contract, not a compatibility announcement.

The intended experience is unchanged training logging code. MLflow and W&B users should configure an endpoint and credentials; TensorBoard users should retain standard writers and make their event files available through a shared log directory or a separately deployed collector. An external collector is infrastructure, not a custom training client, but it is an additional deployment requirement that must be disclosed.

## MLflow target

Implement the documented tracking API under `/api/2.0/mlflow`, beginning with experiment lookup/create, run create/get/update, parameter/tag logging, scalar metrics and batch logging. Artifact listing, upload and download require generic file storage and a compatible artifact URI, not an alias to image uploads. Test `set_experiment`, `start_run`, logging and completion with real official clients using only tracking URI and authentication settings. Test explicit `MlflowClient` calls as well as the fluent API.

The upstream service schema distinguishes immutable parameters from mutable tags. Native nset parameter patches overwrite values, so a sequence of native patch calls is not sufficient enforcement. Check/create must be atomic at the writer. Batch failure, metric ordering and duplicate semantics must follow the selected upstream specification rather than assume all native batch rules apply unchanged. Preserve or explicitly reject values outside native finite, nonnegative JS-safe numeric limits; never silently clamp steps or discard non-finite metrics.

Run start/end times, lifecycle deletion, status vocabulary, names/IDs, filtering, pagination and metric summaries need protocol-specific representations. Do not encode authoritative external identity solely in user-editable tags. Model registry, tracing, logged-model APIs and framework autologging are separate compatibility surfaces; none is implied by passing basic scalar tracking tests. Record exact SDK versions and the exercised features before documenting support.

## W&B target

The official SDK exposes `WANDB_BASE_URL` and API-key configuration, but a configurable URL does not imply an interchangeable REST tracking API. Upstream documentation/source includes a GraphQL control interface and file-stream transport. Investigate initialization and capability negotiation using the actual SDK, then implement run identity/resume, configuration, scalar history, summary, completion and file upload with durable acknowledgement semantics.

History, summary, system events and terminal output are distinct streams. The SDK file-stream implementation resumes from offsets; repeated uploads must not blindly append duplicate history after lost acknowledgements. External namespace/run identity and accepted stream offsets need durable mappings committed with accepted data. Media references, general files and artifact manifests must resolve to stored content; reporting successful uploads while dropping data is forbidden.

Define the first supported SDK feature subset only after a real `wandb.init`/`log`/`finish`/resume journey succeeds, including process/server restart and retry tests. Advanced artifacts, tables, sweeps, registries and public read APIs are independent requirements, not automatically covered by scalar logging. Unsupported protocol operations must produce meaningful errors rather than fabricated GraphQL fields.

## TensorBoard target

Standard TensorBoard writers emit event files, and TensorBoard discovers runs from log directories. The intended integration therefore reads standard `tfevents` files from an accessible log directory or collector, rather than promising an HTTP endpoint that existing writers do not use.

Ingest both scalar encodings used by standard event records, with images next. Associate files and runs explicitly, retain original event metadata where needed, and define any conversion from wall time to native milliseconds. Checkpoint file identity and committed record position, tolerate files being actively appended and partial final records, and handle restart/rotation without duplicating acknowledged records. Account for TensorBoard restart/purge semantics instead of assuming every record is a new permanent point. Histograms, text, audio, graphs and profiling need separate storage/UI support and must remain visibly unsupported until tested.

## Shared native constraints

Native metrics are append-only with database-assigned sequence identity; identical key/step/time/value observations are legal and retained. Run creation, metric writes and image writes are not idempotent. A request that loses its response may still commit. Replay handling belongs to a source-aware receipt or offset contract; deduplicating all equal observations would corrupt native semantics.

Current native timestamps are integer Unix milliseconds and values are finite f64; steps/timestamps are nonnegative JS-safe integers. Native runs have only running/finished/failed status and no explicit end time. Experiments have globally unique names, with no tenant namespace. The configured token grants access to the whole database, so multiple experiments are not tenant isolation.

Artifacts currently mean validated PNG/JPEG/WebP images only. Image validation and decoding limits live in the HTTP handler, not wholly in the database method. New adapters must share those protections rather than calling the lower-level image writer unchecked. Generic artifact paths need traversal protection, namespacing, bounded transfers and explicit retention/durability semantics.

Database schema version 1 does not contain external-ID mappings, replay receipts, generic artifacts or compatibility metadata. Add versioned migrations and upgrade/restart tests when these become necessary. Keep native API behavior unchanged and put source-specific translations at the edge; share bounded admission, validation and committed storage underneath.

## Conformance gate

Each claimed SDK/version must pass a real-client journey, native readback, restart/resume and error-path tests. Include concurrent runs across experiments, repeated/out-of-order steps, Unicode and boundary-sized names, timestamp conversion, parameter conflicts, malformed/oversized batches, authentication, retry ambiguity and artifact path safety. Black-box HTTP tests are required alongside in-process unit tests. Mocked requests alone cannot establish drop-in compatibility.

## Evidence and next decision

Local audit anchors are `src/api.rs`, `src/models.rs`, `src/db.rs`, `src/auth.rs`, `tests/backend_api.rs` and `tests/support.py`. The separate ingestion plan defines the rollout and performance gates. No SDK packages were installed and no upstream-client conformance tests were run during this initial audit.

Upstream references inspected on October 23, 2026 are the MLflow REST API reference and `mlflow/mlflow:mlflow/protos/service.proto`; the W&B environment configuration source, file-stream implementation and GraphQL API documentation; and the TensorBoard README. These references are mutable; pin client versions and source revisions for implementation tests.

Reference locations: `https://mlflow.org/docs/latest/api_reference/rest-api.html`, `https://github.com/mlflow/mlflow/blob/master/mlflow/protos/service.proto`, `https://github.com/wandb/wandb/blob/main/wandb/env.py`, `https://github.com/wandb/wandb/blob/main/core/internal/filestream/filestream.go`, `https://docs.wandb.ai/platform/app/features/custom-charts/walkthrough`, and `https://github.com/tensorflow/tensorboard/blob/master/README.md`.

TensorBoard scalar/restart details were additionally checked against `https://github.com/pytorch/pytorch/blob/main/torch/utils/tensorboard/writer.py`, `https://github.com/pytorch/pytorch/blob/main/torch/utils/tensorboard/summary.py` and `https://github.com/tensorflow/tensorboard/blob/master/tensorboard/backend/event_processing/plugin_event_accumulator.py`.
