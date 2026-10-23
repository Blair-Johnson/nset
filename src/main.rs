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
    tracing::info!(listen = %listener.local_addr()?, "server listening");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
