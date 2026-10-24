mod options {
    use clap::Parser;
    use nset::config::{Command as CliCommand, ConcurrencyOptions, Config};
    use std::process::Command;

    type Case = (&'static str, usize, fn(&mut ConcurrencyOptions, usize));
    const CASES: [Case; 5] = [
        ("NSET_HTTP_WORKERS", 256, |o, v| o.http_workers = v),
        ("NSET_READ_WORKERS", 64, |o, v| o.read_workers = v),
        ("NSET_DB_QUEUE_CAPACITY", 4096, |o, v| {
            o.db_queue_capacity = v
        }),
        ("NSET_WRITE_CONCURRENCY", 1024, |o, v| {
            o.write_concurrency = v
        }),
        ("NSET_IMAGE_CONCURRENCY", 64, |o, v| o.image_concurrency = v),
    ];

    #[test]
    fn defaults_match_programmatic_defaults() {
        let options = ConcurrencyOptions::default();
        assert_eq!(
            options.http_workers,
            std::thread::available_parallelism()
                .map(usize::from)
                .unwrap_or(1)
                .clamp(1, 32)
        );
        assert_eq!(
            (
                options.read_workers,
                options.db_queue_capacity,
                options.write_concurrency,
                options.image_concurrency
            ),
            (2, 64, 8, 2)
        );
        options.validate().unwrap();
        assert_probe(probe("defaults"));
    }

    #[test]
    fn programmatic_bounds_are_inclusive_and_usize_safe() {
        for (name, max, set) in CASES {
            for value in [1, max] {
                let mut options = ConcurrencyOptions::default();
                set(&mut options, value);
                options.validate().unwrap();
            }
            for value in [0, max + 1, usize::MAX] {
                let mut options = ConcurrencyOptions::default();
                set(&mut options, value);
                assert!(options.validate().is_err(), "{name}={value}");
            }
        }
    }

    fn probe(mode: &str) -> Command {
        // Child environments avoid process-global mutation in parallel tests.
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "options::environment_probe", "--nocapture"]);
        command.env("NSET_CONCURRENCY_TEST_PROBE", mode);
        command.env_remove("NSET_TOKEN");
        for (name, _, _) in CASES {
            command.env_remove(name);
        }
        command
    }

    fn assert_probe(mut command: Command) {
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn environment_options_and_workers_precedence() {
        let mut command = probe("valid");
        for (i, (name, _, _)) in CASES.iter().enumerate() {
            command.env(name, (i + 3).to_string());
        }
        assert_probe(command);
        for (name, max, _) in CASES {
            for value in [1, max] {
                let mut command = probe("boundary");
                command.env(name, value.to_string());
                command.env("NSET_CONCURRENCY_TEST_FIELD", name);
                command.env("NSET_CONCURRENCY_TEST_VALUE", value.to_string());
                assert_probe(command);
            }
            for value in [
                "0".to_owned(),
                (max + 1).to_string(),
                usize::MAX.to_string(),
                "18446744073709551616".to_owned(),
                "4294967297".to_owned(),
                "-1".to_owned(),
                "1.5".to_owned(),
                "no".to_owned(),
            ] {
                let mut command = probe("invalid");
                command.env(name, value);
                assert_probe(command);
            }
        }
    }

    #[test]
    fn environment_probe() {
        match std::env::var("NSET_CONCURRENCY_TEST_PROBE").as_deref() {
            Ok("defaults") => assert_eq!(
                ConcurrencyOptions::from_env(None).unwrap(),
                ConcurrencyOptions::default()
            ),
            Ok("boundary") => {
                let field = std::env::var("NSET_CONCURRENCY_TEST_FIELD").unwrap();
                let value = std::env::var("NSET_CONCURRENCY_TEST_VALUE")
                    .unwrap()
                    .parse()
                    .unwrap();
                let (_, _, set) = CASES.iter().find(|(name, _, _)| *name == field).unwrap();
                let mut expected = ConcurrencyOptions::default();
                set(&mut expected, value);
                assert_eq!(ConcurrencyOptions::from_env(None).unwrap(), expected);
            }
            Ok("valid") => {
                let CliCommand::Serve(config) =
                    Config::try_parse_from(["nset", "serve"]).unwrap().command;
                let expected = ConcurrencyOptions {
                    http_workers: 3,
                    read_workers: 4,
                    db_queue_capacity: 5,
                    write_concurrency: 6,
                    image_concurrency: 7,
                };
                assert_eq!(
                    ConcurrencyOptions::from_env(config.workers).unwrap(),
                    expected
                );
                let CliCommand::Serve(config) =
                    Config::try_parse_from(["nset", "serve", "--workers", "1"])
                        .unwrap()
                        .command;
                assert_eq!(
                    ConcurrencyOptions::from_env(config.workers).unwrap(),
                    ConcurrencyOptions {
                        http_workers: 1,
                        ..expected
                    }
                );
            }
            Ok("invalid") => assert!(ConcurrencyOptions::from_env(None).is_err()),
            _ => {}
        }
    }
}

mod backend {
    use axum::{
        body::Body,
        http::{Request, StatusCode},
    };
    use http_body_util::{BodyExt, Full};
    use nset::{AppState, api, auth::Token, config::ConcurrencyOptions, db::Database};
    use std::{
        future::{Future, pending},
        path::Path,
        task::{Context, Poll, Waker},
    };
    use tower::ServiceExt;

    fn token() -> Token {
        Token::new("test-secret").unwrap()
    }

    fn assert_untouched(path: &Path) {
        assert_eq!(
            std::fs::read(path.join("nset.sqlite3")).unwrap(),
            b"do not open or modify"
        );
        assert_eq!(std::fs::read_dir(path).unwrap().count(), 1);
    }

    #[test]
    fn invalid_programmatic_options_never_mutate_disk() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("missing");
        let existing = directory.path().join("existing");
        std::fs::create_dir(&existing).unwrap();
        std::fs::write(existing.join("nset.sqlite3"), b"do not open or modify").unwrap();
        type Setter = fn(&mut ConcurrencyOptions, usize);
        let cases: [(usize, Setter); 5] = [
            (256, |o, v| o.http_workers = v),
            (64, |o, v| o.read_workers = v),
            (4096, |o, v| o.db_queue_capacity = v),
            (1024, |o, v| o.write_concurrency = v),
            (64, |o, v| o.image_concurrency = v),
        ];
        for (max, set) in cases {
            for value in [0, max + 1, usize::MAX] {
                let mut options = ConcurrencyOptions::default();
                set(&mut options, value);
                for path in [&missing, &existing] {
                    assert!(AppState::open_with_options(path, token(), &options).is_err());
                }
                assert!(!missing.exists());
                assert_untouched(&existing);
            }
        }
        for (readers, capacity) in [
            (0, 64),
            (65, 64),
            (usize::MAX, 64),
            (2, 0),
            (2, 4097),
            (2, usize::MAX),
        ] {
            for path in [&missing, &existing] {
                assert!(Database::open_with_options(path, readers, capacity).is_err());
            }
            assert!(!missing.exists());
            assert_untouched(&existing);
        }
    }

    #[test]
    fn invalid_environment_options_never_create_data_directory() {
        for name in [
            "NSET_HTTP_WORKERS",
            "NSET_READ_WORKERS",
            "NSET_DB_QUEUE_CAPACITY",
            "NSET_WRITE_CONCURRENCY",
            "NSET_IMAGE_CONCURRENCY",
        ] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("missing");
            let output = std::process::Command::new(env!("CARGO_BIN_EXE_nset"))
                .env_clear()
                .env(name, "0")
                .args(["serve", "--db-path"])
                .arg(&path)
                .args(["--token", "test-secret"])
                .output()
                .unwrap();
            assert!(!output.status.success(), "{name}");
            assert!(!path.exists(), "{name}");
        }
    }

    #[test]
    fn default_wrappers_preserve_pools_and_slots() {
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::open(directory.path(), token()).unwrap();
        assert_eq!(state.db.queue_capacities(), (64, vec![64; 2]));
        assert_eq!(state.write_slots.available_permits(), 8);
        assert_eq!(state.image_slots.available_permits(), 2);
        let directory = tempfile::tempdir().unwrap();
        let db = Database::open(directory.path()).unwrap();
        assert_eq!(db.queue_capacities(), (64, vec![64; 2]));
    }

    #[tokio::test]
    async fn configured_read_pool_and_actor_capacities_are_used() {
        for (read_workers, db_queue_capacity) in [(1, 1), (3, 7), (4, 4096)] {
            let directory = tempfile::tempdir().unwrap();
            let options = ConcurrencyOptions {
                read_workers,
                db_queue_capacity,
                ..Default::default()
            };
            let state = AppState::open_with_options(directory.path(), token(), &options).unwrap();
            assert_eq!(
                state.db.queue_capacities(),
                (db_queue_capacity, vec![db_queue_capacity; read_workers])
            );
            // Traverse the whole round-robin pool more than once.
            for _ in 0..read_workers * 2 {
                state.db.catalog().await.unwrap();
            }
        }
    }

    fn request(uri: &str, body: Body, content_type: &str) -> Request<Body> {
        Request::builder()
            .method("POST")
            .uri(uri)
            .header("authorization", "Bearer test-secret")
            .header("content-type", content_type)
            .body(body)
            .unwrap()
    }

    #[tokio::test]
    async fn configured_request_slots_admit_reject_and_release() {
        let directory = tempfile::tempdir().unwrap();
        let options = ConcurrencyOptions {
            write_concurrency: 3,
            image_concurrency: 1,
            ..Default::default()
        };
        let state = AppState::open_with_options(directory.path(), token(), &options).unwrap();
        let app = api::router(state.clone());
        assert_eq!(state.write_slots.available_permits(), 3);
        assert_eq!(state.image_slots.available_permits(), 1);
        let mut pending_requests = Vec::new();
        for remaining in (0..3).rev() {
            let body = Full::new(axum::body::Bytes::from_static(b"{}"))
                .with_trailers(pending::<
                    Option<Result<axum::http::HeaderMap, std::convert::Infallible>>,
                >());
            let mut response = Box::pin(app.clone().oneshot(request(
                "/api/experiments",
                Body::new(body),
                "application/json",
            )));
            assert!(matches!(
                response
                    .as_mut()
                    .poll(&mut Context::from_waker(Waker::noop())),
                Poll::Pending
            ));
            assert_eq!(state.write_slots.available_permits(), remaining);
            pending_requests.push(response);
        }
        let response = app
            .clone()
            .oneshot(request(
                "/api/experiments",
                Body::from("{}"),
                "application/json",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        drop(pending_requests);
        assert_eq!(state.write_slots.available_permits(), 3);
        let (experiment, _) = state
            .db
            .create_experiment("image admission".into())
            .await
            .unwrap();
        let run = state
            .db
            .create_run(nset::models::NewRun {
                experiment_id: experiment.id,
                name: "image".into(),
                params: Default::default(),
                tags: Default::default(),
            })
            .await
            .unwrap();
        let image_uri = format!("/api/runs/{}/images?key=image&step=0", run.id);
        let held_image = state.image_slots.try_acquire().unwrap();
        let response = app
            .clone()
            .oneshot(request(
                &image_uri,
                Body::from("invalid image"),
                "image/png",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(state.write_slots.available_permits(), 3);
        drop(held_image);
        let response = app
            .oneshot(request(
                &image_uri,
                Body::from("invalid image"),
                "image/png",
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert_eq!(state.image_slots.available_permits(), 1);
        assert_eq!(state.write_slots.available_permits(), 3);
    }
}
