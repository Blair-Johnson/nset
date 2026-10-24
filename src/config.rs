use crate::{
    auth::Token,
    errors::{ApiError, Result},
};
use clap::{Args, Parser};
use std::{net::SocketAddr, path::PathBuf};

pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// Default nonwaiting admission for active native API write requests.
/// Bounds concurrent body extraction/handlers, not total process RSS or DB work:
/// already queued writes can outlive a cancelled HTTP request. Keep the existing
/// body/decode limits and DB queues; never cancel or retry accepted writes here.
pub const MAX_ACTIVE_WRITES: usize = 8;
/// Resource limits, validated before opening a database or creating directories.
/// Write concurrency is HTTP admission, not parallel SQLite writers.
#[derive(Args, Clone, Debug, PartialEq, Eq)]
pub struct ConcurrencyOptions {
    /// Tokio async worker threads (not SQLite actors or blocking image workers).
    #[arg(long, env = "NSET_HTTP_WORKERS", default_value_t = default_http_workers(), value_parser = parse_count::<256>)]
    pub http_workers: usize,
    /// Read-only SQLite actors; the query database always has one writer.
    #[arg(long, env = "NSET_READ_WORKERS", default_value_t = 2, value_parser = parse_count::<64>)]
    pub read_workers: usize,
    /// Pending jobs per SQLite actor, excluding its currently executing job.
    #[arg(long, env = "NSET_DB_QUEUE_CAPACITY", default_value_t = 64, value_parser = parse_count::<4096>)]
    pub db_queue_capacity: usize,
    /// Concurrent admitted HTTP write requests, not SQLite writer threads.
    #[arg(long, env = "NSET_WRITE_CONCURRENCY", default_value_t = MAX_ACTIVE_WRITES, value_parser = parse_count::<1024>)]
    pub write_concurrency: usize,
    /// Concurrent image decode/write handlers.
    #[arg(long, env = "NSET_IMAGE_CONCURRENCY", default_value_t = 2, value_parser = parse_count::<64>)]
    pub image_concurrency: usize,
}

fn default_http_workers() -> usize {
    std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(1)
        .clamp(1, 32)
}

fn parse_count<const MAX: usize>(raw: &str) -> std::result::Result<usize, String> {
    // Parse as the field's actual type: never truncate a larger CLI integer.
    let value = raw
        .parse::<usize>()
        .map_err(|_| format!("expected an integer in 1..={MAX}"))?;
    check_count(value, MAX, "out of range")
        .map_err(|_| format!("expected an integer in 1..={MAX}"))?;
    Ok(value)
}

fn check_count(value: usize, max: usize, message: &'static str) -> Result<()> {
    if !(1..=max).contains(&value) {
        return Err(ApiError::bad(message));
    }
    Ok(())
}

pub(crate) fn validate_database_options(read_workers: usize, queue_capacity: usize) -> Result<()> {
    check_count(read_workers, 64, "read_workers must be in 1..=64")?;
    check_count(
        queue_capacity,
        4096,
        "db_queue_capacity must be in 1..=4096",
    )
}

impl Default for ConcurrencyOptions {
    fn default() -> Self {
        Self {
            http_workers: default_http_workers(),
            read_workers: 2,
            db_queue_capacity: 64,
            write_concurrency: MAX_ACTIVE_WRITES,
            image_concurrency: 2,
        }
    }
}

impl ConcurrencyOptions {
    pub fn validate(&self) -> Result<()> {
        check_count(self.http_workers, 256, "http_workers must be in 1..=256")?;
        validate_database_options(self.read_workers, self.db_queue_capacity)?;
        check_count(
            self.write_concurrency,
            1024,
            "write_concurrency must be in 1..=1024",
        )?;
        check_count(
            self.image_concurrency,
            64,
            "image_concurrency must be in 1..=64",
        )
    }
}

#[derive(Parser)]
#[command(name = "nset", version, about = "Local experiment tracker")]
pub struct Config {
    #[command(flatten)]
    pub concurrency: ConcurrencyOptions,
    #[arg(long, default_value = "data")]
    pub data_dir: PathBuf,
    #[arg(long, default_value = "127.0.0.1:8080")]
    pub listen: SocketAddr,
    #[arg(
        long,
        env = "NSET_TOKEN",
        hide_env_values = true,
        conflicts_with = "token_file"
    )]
    pub token: Option<String>,
    #[arg(long, conflicts_with = "token")]
    pub token_file: Option<PathBuf>,
}
impl Config {
    pub fn load_token(&self) -> Result<Token> {
        let value = match (&self.token, &self.token_file) {
            (Some(value), None) => value.clone(),
            (None, Some(path)) => std::fs::read_to_string(path)
                .map_err(|_| ApiError::bad("cannot read token file"))?
                .trim_end_matches(['\r', '\n'])
                .to_owned(),
            _ => return Err(ApiError::bad("supply --token, NSET_TOKEN, or --token-file")),
        };
        Token::new(&value)
    }
}
