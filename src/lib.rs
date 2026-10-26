#![cfg_attr(test, recursion_limit = "256")]
pub mod api;
pub mod assets;
pub mod auth;
pub mod compat;
pub mod compat_http;
pub mod config;
pub mod db;
pub mod errors;
pub mod ingest;
pub mod models;
pub mod rx;
mod view_config;
mod views;
use std::{path::Path, sync::Arc};
use tokio::sync::Semaphore;
#[derive(Clone)]
pub struct AppState {
    pub rx: Option<rx::Source>,
    pub db: db::Database,
    pub ingest: ingest::DurableIngest,
    pub token: auth::Token,
    pub compat: compat::Compat,
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
        Self::open_with_ingest_options(path, token, options, ingest::IngestOptions::default())
    }

    pub fn open_with_ingest_options(
        path: &Path,
        token: auth::Token,
        options: &config::ConcurrencyOptions,
        ingest_options: ingest::IngestOptions,
    ) -> errors::Result<Self> {
        // Validate all limits before either database can touch disk.
        options.validate()?;
        ingest_options.validate()?;
        let db =
            db::Database::open_with_options(path, options.read_workers, options.db_queue_capacity)?;
        let ingest = ingest::DurableIngest::open(path, db.clone(), ingest_options)?;
        let compat = compat::Compat::new(db.clone(), ingest.clone());
        Ok(Self {
            rx: None,
            compat,
            db,
            ingest,
            token,
            image_slots: Arc::new(Semaphore::new(options.image_concurrency)),
            write_slots: Arc::new(Semaphore::new(options.write_concurrency)),
        })
    }
}
