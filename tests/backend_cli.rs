use clap::{CommandFactory, FromArgMatches};
use nset::config::{Command as CliCommand, Config, LogLevel, ServeConfig};
use std::{
    path::Path,
    process::{Command, Output},
};

fn parse(args: &[&str]) -> Result<ServeConfig, clap::Error> {
    // Keep parser tests independent of the developer's token environment.
    let matches = Config::command()
        .mut_subcommand("serve", |command| {
            command.mut_args(|arg| arg.env(None::<&str>))
        })
        .try_get_matches_from(args)?;
    let CliCommand::Serve(config) = Config::from_arg_matches(&matches)?.command;
    Ok(config)
}

fn binary(directory: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nset"));
    command.env_clear().current_dir(directory);
    command
}

fn output_text(output: &Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

#[test]
fn serve_defaults_and_explicit_host_port_path() {
    let config = parse(&["nset", "serve"]).unwrap();
    assert_eq!(config.host, "127.0.0.1");
    assert_eq!(config.port, 8080);
    assert_eq!(config.db_path, Path::new("./nset-data"));
    assert!(config.token.is_none());
    assert!(config.token_file.is_none());
    assert!(config.workers.is_none());
    assert!(matches!(config.log_level, LogLevel::Info));
    assert!(config.load_token().is_err());

    for host in ["127.0.0.1", "0.0.0.0", "localhost", "::1"] {
        for port in ["0", "1", "8080", "65535"] {
            let config = parse(&[
                "nset",
                "serve",
                "--host",
                host,
                "--port",
                port,
                "--db-path",
                "directory with spaces/data",
                "--token",
                "test-secret",
            ])
            .unwrap();
            assert_eq!(config.host, host);
            assert_eq!(config.port, port.parse::<u16>().unwrap());
            assert_eq!(config.db_path, Path::new("directory with spaces/data"));
            assert!(config.load_token().unwrap().matches("test-secret"));
        }
    }
    for port in ["-1", "65536", "18446744073709551616", "1.5", "no"] {
        assert!(parse(&["nset", "serve", &format!("--port={port}")]).is_err());
    }
}

#[test]
fn only_approved_serve_flags_are_accepted() {
    assert!(parse(&["nset"]).is_err());
    for args in [
        vec!["nset", "--token", "secret"],
        vec!["nset", "--host", "127.0.0.1"],
        vec!["nset", "--port", "8080"],
        vec!["nset", "--db-path", "data"],
        vec!["nset", "--listen", "127.0.0.1:8080"],
        vec!["nset", "--data-dir", "data"],
    ] {
        assert!(parse(&args).is_err(), "{args:?}");
    }
    for (flag, value) in [
        ("--listen", "127.0.0.1:8080"),
        ("--data-dir", "data"),
        ("--db_path", "data"),
        ("--http-workers", "1"),
        ("--read-workers", "1"),
        ("--db-queue-capacity", "1"),
        ("--write-concurrency", "1"),
        ("--image-concurrency", "1"),
        ("--ingest-queue-capacity", "1"),
        ("--ingest-max-pending-bytes", "1"),
        ("--ingest-max-pending-batches", "1"),
        ("--ingest-poll-interval-ms", "1"),
    ] {
        assert!(parse(&["nset", "serve", flag, value]).is_err(), "{flag}");
    }
    assert!(parse(&["nset", "serve", "--ingest-paused"]).is_err());
    assert!(parse(&["nset", "serve", "--ingest-paused=true"]).is_err());
}

#[test]
fn public_workers_and_log_level_validation() {
    for workers in ["1", "32", "256"] {
        let config = parse(&["nset", "serve", "--workers", workers]).unwrap();
        assert_eq!(config.workers, Some(workers.parse().unwrap()));
    }
    for workers in [
        "0",
        "257",
        "-1",
        "1.5",
        "no",
        "4294967297",
        "18446744073709551616",
    ] {
        assert!(parse(&["nset", "serve", &format!("--workers={workers}")]).is_err());
    }
    for level in ["error", "warn", "info", "debug"] {
        let config = parse(&["nset", "serve", "--log-level", level]).unwrap();
        assert_eq!(config.log_level.filter(), level);
    }
    for level in ["trace", "off", "warning", "INFO", ""] {
        assert!(parse(&["nset", "serve", "--log-level", level]).is_err());
    }
}

#[test]
fn root_help_version_and_serve_help_do_not_create_storage_or_reveal_token() {
    let directory = tempfile::tempdir().unwrap();
    let secret = "environment-secret-must-never-appear";
    for args in [vec!["--help"], vec!["--version"], vec!["serve", "--help"]] {
        let output = binary(directory.path())
            .env("NSET_TOKEN", secret)
            .args(&args)
            .output()
            .unwrap();
        let text = output_text(&output);
        assert!(output.status.success(), "{text}");
        assert!(!text.contains(secret));
        if args == ["--version"] {
            assert!(text.contains(env!("CARGO_PKG_VERSION")));
        } else {
            assert!(text.contains("serve"));
            for hidden in [
                "--listen",
                "--data-dir",
                "--db_path",
                "--http-workers",
                "--read-workers",
                "--ingest-queue-capacity",
            ] {
                assert!(!text.contains(hidden), "{hidden}: {text}");
            }
        }
        if args == ["serve", "--help"] {
            for visible in [
                "--host",
                "--port",
                "--db-path",
                "--token",
                "--token-file",
                "--workers",
                "--log-level",
            ] {
                assert!(text.contains(visible), "{visible}: {text}");
            }
        }
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
    let output = binary(directory.path()).output().unwrap();
    assert!(!output.status.success());
    assert!(output_text(&output).contains("serve"));
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}

#[test]
fn token_file_loads_and_conflicts_with_inline_or_environment_token() {
    let directory = tempfile::tempdir().unwrap();
    let token_file = directory.path().join("token file");
    let secret = "file-secret-must-never-appear";
    std::fs::write(&token_file, format!("{secret}\r\n")).unwrap();
    let config = parse(&[
        "nset",
        "serve",
        "--token-file",
        token_file.to_str().unwrap(),
    ])
    .unwrap();
    assert!(config.load_token().unwrap().matches(secret));
    let inline_secret = "inline-secret-must-never-appear";
    let environment_secret = "environment-secret-must-never-appear";
    for environment in [false, true] {
        let mut command = binary(directory.path());
        command.args(["serve", "--token-file"]).arg(&token_file);
        if environment {
            command.env("NSET_TOKEN", environment_secret);
        } else {
            command.args(["--token", inline_secret]);
        }
        let output = command.output().unwrap();
        let text = output_text(&output);
        assert!(!output.status.success());
        assert!(text.contains("--token-file"), "{text}");
        for secret in [secret, inline_secret, environment_secret] {
            assert!(!text.contains(secret), "{text}");
        }
        assert!(!directory.path().join("nset-data").exists());
    }
}

#[test]
fn database_path_must_be_a_directory_and_existing_file_is_untouched() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("not a directory");
    std::fs::write(&path, b"do not modify").unwrap();
    let output = binary(directory.path())
        .args([
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--workers",
            "1",
            "--token",
            "test-secret",
            "--db-path",
        ])
        .arg(&path)
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(output_text(&output).contains("directory"));
    assert_eq!(std::fs::read(&path).unwrap(), b"do not modify");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}

#[test]
fn invalid_configuration_fails_before_creating_any_files() {
    let directory = tempfile::tempdir().unwrap();
    for args in [
        vec![],
        vec!["--token-file", "missing-token-file"],
        vec!["--token", "test-secret", "--workers", "0"],
        vec!["--token", "test-secret", "--port", "65536"],
        vec!["--token", "test-secret", "--log-level", "trace"],
    ] {
        let output = binary(directory.path())
            .args(["serve", "--db-path", "missing/data"])
            .args(&args)
            .output()
            .unwrap();
        assert!(!output.status.success(), "{args:?}");
        assert!(!output_text(&output).contains("test-secret"));
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }
    for name in [
        "NSET_HTTP_WORKERS",
        "NSET_READ_WORKERS",
        "NSET_DB_QUEUE_CAPACITY",
        "NSET_WRITE_CONCURRENCY",
        "NSET_IMAGE_CONCURRENCY",
        "NSET_INGEST_QUEUE_CAPACITY",
        "NSET_INGEST_MAX_PENDING_BYTES",
        "NSET_INGEST_MAX_PENDING_BATCHES",
        "NSET_INGEST_POLL_INTERVAL_MS",
        "NSET_INGEST_PAUSED",
    ] {
        let output = binary(directory.path())
            .env(name, "invalid-value-must-not-leak")
            .args([
                "serve",
                "--db-path",
                "missing/data",
                "--token",
                "test-secret",
            ])
            .output()
            .unwrap();
        let text = output_text(&output);
        assert!(!output.status.success(), "{name}");
        assert!(!text.contains("test-secret"));
        assert!(!text.contains("invalid-value-must-not-leak"));
        assert_eq!(
            std::fs::read_dir(directory.path()).unwrap().count(),
            0,
            "{name}"
        );
    }
}

#[test]
fn unavailable_listener_does_not_create_storage_or_reveal_token() {
    let directory = tempfile::tempdir().unwrap();
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port().to_string();
    let secret = "environment-secret-must-never-appear";
    let output = binary(directory.path())
        .env("NSET_TOKEN", secret)
        .args([
            "serve",
            "--host",
            "127.0.0.1",
            "--port",
            &port,
            "--workers",
            "1",
            "--db-path",
            "missing/data",
        ])
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(!output_text(&output).contains(secret));
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
}
