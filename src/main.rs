use clap::Parser;
use nset::{AppState, api, config::Config};
#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nset=info".into()),
        )
        .init();
    let config = Config::parse();
    if let Err(error) = serve(config).await {
        eprintln!("nset: {}", error.1);
        std::process::exit(1);
    }
}
async fn serve(config: Config) -> nset::errors::Result<()> {
    let token = config.load_token()?;
    let state = AppState::open(&config.data_dir, token)?;
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
