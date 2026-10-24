use crate::{
    auth::Token,
    errors::{ApiError, Result},
};
use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// Default nonwaiting admission for active native API write requests.
/// Bounds concurrent body extraction/handlers, not total process RSS or DB work:
/// already queued writes can outlive a cancelled HTTP request. Keep the existing
/// body/decode limits and DB queues; never cancel or retry accepted writes here.
pub const MAX_ACTIVE_WRITES: usize = 8;
/// Resource limits, validated before opening a database or creating directories.
/// Write concurrency is HTTP admission, not parallel SQLite writers.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConcurrencyOptions {
    /// Tokio async worker threads (not SQLite actors or blocking image workers).
    pub http_workers: usize,
    /// Read-only SQLite actors; the query database always has one writer.
    pub read_workers: usize,
    /// Pending jobs per SQLite actor, excluding its currently executing job.
    pub db_queue_capacity: usize,
    /// Concurrent admitted HTTP write requests, not SQLite writer threads.
    pub write_concurrency: usize,
    /// Concurrent image decode/write handlers.
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

#[derive(Clone, Debug)]
pub struct IngestConfig {
    /// Pending in-memory durable intake jobs, excluding the executing job.
    pub ingest_queue_capacity: usize,
    /// Maximum pending journal payload bytes; receipts and SQLite overhead are extra.
    pub ingest_max_pending_bytes: u64,
    pub ingest_max_pending_batches: usize,
    pub ingest_poll_interval_ms: u64,
    /// Accept durable batches without projecting them (maintenance/recovery only).
    pub ingest_paused: bool,
}
impl IngestConfig {
    pub fn options(&self) -> Result<crate::ingest::IngestOptions> {
        if self.ingest_max_pending_bytes == 0
            || self.ingest_max_pending_bytes > i64::MAX as u64
            || !(1..=60_000).contains(&self.ingest_poll_interval_ms)
        {
            return Err(ApiError::bad("invalid durable ingest limits"));
        }
        check_count(
            self.ingest_queue_capacity,
            4096,
            "invalid ingest queue capacity",
        )?;
        check_count(
            self.ingest_max_pending_batches,
            1_000_000,
            "invalid ingest batch capacity",
        )?;
        Ok(crate::ingest::IngestOptions {
            queue_capacity: self.ingest_queue_capacity,
            max_pending_bytes: self.ingest_max_pending_bytes,
            max_pending_batches: self.ingest_max_pending_batches,
            poll_interval_ms: self.ingest_poll_interval_ms,
            paused: self.ingest_paused,
        })
    }
}
fn env_value<T: std::str::FromStr>(name: &str, default: T) -> Result<T> {
    match std::env::var(name) {
        Ok(raw) => raw
            .parse()
            .map_err(|_| ApiError::bad("invalid internal tuning environment variable")),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(_) => Err(ApiError::bad(
            "invalid internal tuning environment variable",
        )),
    }
}

impl ConcurrencyOptions {
    pub fn from_env(workers: Option<usize>) -> Result<Self> {
        let defaults = Self::default();
        let options = Self {
            http_workers: match workers {
                Some(n) => n,
                None => env_value("NSET_HTTP_WORKERS", defaults.http_workers)?,
            },
            read_workers: env_value("NSET_READ_WORKERS", defaults.read_workers)?,
            db_queue_capacity: env_value("NSET_DB_QUEUE_CAPACITY", defaults.db_queue_capacity)?,
            write_concurrency: env_value("NSET_WRITE_CONCURRENCY", defaults.write_concurrency)?,
            image_concurrency: env_value("NSET_IMAGE_CONCURRENCY", defaults.image_concurrency)?,
        };
        options.validate()?;
        Ok(options)
    }
}
impl IngestConfig {
    pub fn from_env() -> Result<Self> {
        let config = Self {
            ingest_queue_capacity: env_value("NSET_INGEST_QUEUE_CAPACITY", 64)?,
            ingest_max_pending_bytes: env_value("NSET_INGEST_MAX_PENDING_BYTES", 268_435_456)?,
            ingest_max_pending_batches: env_value("NSET_INGEST_MAX_PENDING_BATCHES", 10_000)?,
            ingest_poll_interval_ms: env_value("NSET_INGEST_POLL_INTERVAL_MS", 100)?,
            ingest_paused: env_value("NSET_INGEST_PAUSED", false)?,
        };
        config.options()?;
        Ok(config)
    }
}

#[derive(Parser)]
#[command(
    name = "nset",
    version,
    about = "Metrics-first experiment tracker",
    arg_required_else_help = true
)]
pub struct Config {
    #[command(subcommand)]
    pub command: Command,
}
#[derive(Subcommand)]
pub enum Command {
    /// Serve the UI, native API, MLflow and W&B on one HTTP listener.
    Serve(ServeConfig),
}
#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}
impl LogLevel {
    pub fn filter(self) -> &'static str {
        match self {
            Self::Error => "error",
            Self::Warn => "warn",
            Self::Info => "info",
            Self::Debug => "debug",
        }
    }
}
#[derive(Args)]
pub struct ServeConfig {
    /// Bind hostname or IP address.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,
    #[arg(long, default_value_t = 8080)]
    pub port: u16,
    /// Directory holding query data, ingestion journal, compatibility state and native images.
    #[arg(long, default_value = "./nset-data")]
    pub db_path: PathBuf,
    /// Shared API secret (or set NSET_TOKEN).
    #[arg(
        long,
        env = "NSET_TOKEN",
        hide_env_values = true,
        conflicts_with = "token_file"
    )]
    pub token: Option<String>,
    /// Read the shared API secret from a file.
    #[arg(long, conflicts_with = "token")]
    pub token_file: Option<PathBuf>,
    /// Async HTTP workers; defaults to available parallelism, capped at 32.
    #[arg(long, value_parser = parse_count::<256>)]
    pub workers: Option<usize>,
    #[arg(long, value_enum, default_value = "info")]
    pub log_level: LogLevel,
}
impl ServeConfig {
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
