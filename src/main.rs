use clap::Parser;
use nset::{AppState, api, config::Config};
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nset=info".into()),
        )
        .init();
    let config = Config::parse();
    if let Err(error) = run(config) {
        eprintln!("nset: {}", error.1);
        std::process::exit(1);
    }
}
fn run(config: Config) -> nset::errors::Result<()> {
    config.concurrency.validate()?;
    config.ingest.options()?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(config.concurrency.http_workers)
        .enable_all()
        .build()?;
    runtime.block_on(serve(config))
}

async fn serve(config: Config) -> nset::errors::Result<()> {
    let token = config.load_token()?;
    let state = AppState::open_with_ingest_options(
        &config.data_dir, token, &config.concurrency, config.ingest.options()?,
    )?;
    tracing::info!(
        http_workers = config.concurrency.http_workers,
        read_workers = config.concurrency.read_workers,
        db_queue_capacity = config.concurrency.db_queue_capacity,
        write_concurrency = config.concurrency.write_concurrency,
        image_concurrency = config.concurrency.image_concurrency,
        sqlite_writers = 1,
        "resolved concurrency"
    );
    let listener = tokio::net::TcpListener::bind(config.listen).await?;
    // Register SIGTERM before reporting readiness; non-Unix platforms use Ctrl-C.
    #[cfg(unix)]
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tracing::info!(listen = %listener.local_addr()?, "server listening");
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
    Ok(())
}
