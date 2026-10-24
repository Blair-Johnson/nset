use clap::Parser;
use fs2::FileExt;
use nset::{
    AppState, api,
    config::{Command, ConcurrencyOptions, Config, IngestConfig, ServeConfig},
    errors::{ApiError, Result},
};
use std::{fs::OpenOptions, path::Path};

fn main() {
    let Config {
        command: Command::Serve(config),
    } = Config::parse();
    tracing_subscriber::fmt()
        .with_env_filter(format!("nset={}", config.log_level.filter()))
        .init();
    if let Err(error) = run(config) {
        eprintln!("nset: {}", error.1);
        std::process::exit(1);
    }
}

fn lock_root(path: &Path) -> Result<std::fs::File> {
    if path.exists() && !path.is_dir() {
        return Err(ApiError::bad("--db-path must be a directory, not a file"));
    }
    std::fs::create_dir_all(path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.join("nset.lock"))?;
    file.try_lock_exclusive()
        .map_err(|_| ApiError::bad("storage directory is already owned by another server"))?;
    Ok(file)
}

fn run(config: ServeConfig) -> Result<()> {
    // Validate secrets and all tuning before creating storage or starting workers.
    let token = config.load_token()?;
    let concurrency = ConcurrencyOptions::from_env(config.workers)?;
    let ingest = IngestConfig::from_env()?.options()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(concurrency.http_workers)
        .enable_all()
        .build()?;
    let mut ownership = None;
    let result = runtime.block_on(async {
        // Bind before touching disk; an unavailable address cannot create a new root.
        let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
        ownership = Some(lock_root(&config.db_path)?);
        let state =
            AppState::open_with_ingest_options(&config.db_path, token, &concurrency, ingest)?;
        tracing::info!(
            http_workers = concurrency.http_workers,
            read_workers = concurrency.read_workers,
            db_queue_capacity = concurrency.db_queue_capacity,
            write_concurrency = concurrency.write_concurrency,
            image_concurrency = concurrency.image_concurrency,
            sqlite_writers = 1,
            "resolved concurrency"
        );
        #[cfg(unix)]
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tracing::info!(listen = %listener.local_addr()?, "server listening");
        let pending_writes = state.write_slots.clone();
        axum::serve(listener, api::router(state))
            .with_graceful_shutdown(async move {
                let ctrl_c = async {
                    if let Err(error) = tokio::signal::ctrl_c().await {
                        tracing::error!(%error, "failed to listen for Ctrl-C");
                    }
                };
                #[cfg(unix)]
                tokio::select! {
                    _ = ctrl_c => {},
                    _ = terminate.recv() => {},
                }
                #[cfg(not(unix))]
                ctrl_c.await;
            })
            .await?;
        // HTTP waiters may have disconnected while accepted compatibility work
        // still owns a permit. Keep the runtime and root ownership alive until
        // those operations release their locks and finish their actor writes.
        let _drained = pending_writes
            .acquire_many_owned(concurrency.write_concurrency as u32)
            .await
            .map_err(|_| ApiError::bad("write admission closed during shutdown"))?;
        Ok(())
    });
    // Runtime cancellation drops any remaining task-held database handles; their
    // actor destructors drain and join before the root lock can be released.
    drop(runtime);
    drop(ownership);
    result
}
