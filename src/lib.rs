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
        Ok(Self {
            db: db::Database::open(path)?,
            token,
            image_slots: Arc::new(Semaphore::new(2)),
            write_slots: Arc::new(Semaphore::new(config::MAX_ACTIVE_WRITES)),
        })
    }
}
