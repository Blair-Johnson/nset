use crate::{
    auth::Token,
    errors::{ApiError, Result},
};
use clap::Parser;
use std::{net::SocketAddr, path::PathBuf};

pub const MAX_BODY: usize = 32 * 1024 * 1024;
#[derive(Parser)]
#[command(name = "nset", version, about = "Local experiment tracker")]
pub struct Config {
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
