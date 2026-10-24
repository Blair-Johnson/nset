pub mod api;
pub mod assets;
pub mod auth;
pub mod config;
pub mod db;
pub mod errors;
pub mod models;
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;
#[derive(Clone)]
pub struct AppState {
    pub db: db::Database,
    pub token: auth::Token,
    pub image_slots: Arc<Semaphore>,
    pub write_slots: Arc<Semaphore>,
}
impl AppState {
    pub fn open(path: &Path, token: auth::Token) -> errors::Result<Self> {
        Self::open_with_options(path, token, &config::ConcurrencyOptions::default())
    }

    pub fn open_with_options(
        path: &Path,
        token: auth::Token,
        options: &config::ConcurrencyOptions,
    ) -> errors::Result<Self> {
        // Validate every option before Database::open_with_options can touch disk.
        options.validate()?;
        Ok(Self {
            db: db::Database::open_with_options(
                path,
                options.read_workers,
                options.db_queue_capacity,
            )?,
            token,
            image_slots: Arc::new(Semaphore::new(options.image_concurrency)),
            write_slots: Arc::new(Semaphore::new(options.write_concurrency)),
        })
    }
}
