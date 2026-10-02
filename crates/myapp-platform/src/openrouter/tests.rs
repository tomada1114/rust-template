use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::mpsc;

use myapp_core::{GenerationSettings, ReasoningEffort};
use myapp_test_support::text_generator_contract;
use serde_json::{Value, json};

use super::*;

const FIXTURE_KEY: &str = "fixture-key";

fn request() -> GenerationRequest {
    GenerationRequest {
        prompt: "Explain Rust.\n日本語でも。".to_owned(),
        settings: GenerationSettings {
            model: "openai/gpt-6-luna".to_owned(),
            reasoning_effort: ReasoningEffort::Max,
            max_output_tokens: 32_768,
        },
    }
}

fn answer(text: &str) -> String {
    json!({ "choices": [{ "finish_reason": "stop", "message": { "content": text } }] }).to_string()
}

fn read_request(stream: &TcpStream) -> (String, Value) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut reader = BufReader::new(stream);
    let mut headers = String::new();
    let mut length = 0;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
            break;
        }
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            length = value.trim().parse::<usize>().unwrap();
        }
        headers.push_str(&line);
    }
    let mut body = vec![0; length];
    reader.read_exact(&mut body).unwrap();
    (
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

fn with_response<R>(
    status: u16,
    body: &str,
    tuning: OpenRouterTuning,
    run: impl FnOnce(OpenRouterClient) -> R,
) -> (R, String, Value) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let client = OpenRouterClient::build(
        Credentials::Provided(FIXTURE_KEY.to_owned()),
        &format!("http://{address}/api/v1/chat/completions"),
        tuning,
    )
    .unwrap();
    std::thread::scope(|scope| {
        let server = scope.spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let captured = read_request(&stream);
            let response = format!(
                "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            // The client may reject a response or time out and close the connection.
            let _ = stream.write_all(response.as_bytes());
            captured
        });
        let result = run(client);
        // Wake a server whose client failed before connecting, so a test failure cannot
        // leave the scoped worker waiting on accept. No credentials use this socket.
        let _ = TcpStream::connect(address);
        let (headers, body) = server.join().unwrap();
        (result, headers, body)
    })
}

fn generate(status: u16, body: &str) -> Result<GenerationView, GenerationError> {
    with_response(status, body, OpenRouterTuning::default(), |client| {
        client.generate(&request())
    })
    .0
}

#[test]
fn sends_the_selected_model_max_effort_and_authentication_and_returns_only_final_text() {
    let (result, headers, body) = with_response(
        200,
        r#"{"choices":[{"finish_reason":"stop","message":{"content":"  Final answer.  ","reasoning":"private reasoning"}}]}"#,
        OpenRouterTuning::default(),
        |client| client.generate(&request()),
    );
    assert_eq!(
        result,
        Ok(GenerationView {
            text: "  Final answer.  ".to_owned()
        })
    );
    assert!(headers.starts_with("POST /api/v1/chat/completions HTTP/1.1\r\n"));
    assert!(
        headers
            .to_ascii_lowercase()
            .contains("authorization: bearer fixture-key\r\n")
    );
    assert_eq!(
        body,
        json!({
            "model": "openai/gpt-6-luna",
            "messages": [{ "role": "user", "content": "Explain Rust.\n日本語でも。" }],
            "reasoning": { "effort": "max", "exclude": true },
            "max_tokens": 32_768,
            "stream": false,
            "provider": { "require_parameters": true },
        })
    );
}

#[test]
fn maps_http_failures_without_retaining_the_provider_body() {
    for (status, expected) in [
        (400, GenerationError::Rejected),
        (401, GenerationError::InvalidCredentials),
        (402, GenerationError::InsufficientCredits),
        (403, GenerationError::Rejected),
        (408, GenerationError::Timeout),
        (429, GenerationError::RateLimited),
        (500, GenerationError::Unavailable),
        (503, GenerationError::Unavailable),
    ] {
        assert_eq!(generate(status, "private provider message"), Err(expected));
    }
}

#[test]
fn a_provider_error_inside_http_success_is_still_an_error() {
    assert_eq!(
        generate(200, r#"{"error":{"code":429,"message":"private content"}}"#),
        Err(GenerationError::RateLimited)
    );
}

#[test]
fn truncated_and_filtered_answers_are_never_reported_as_success() {
    for (reason, expected) in [
        ("length", GenerationError::Truncated),
        ("content_filter", GenerationError::Rejected),
        ("tool_calls", GenerationError::InvalidResponse),
    ] {
        let body = json!({ "choices": [{ "finish_reason": reason, "message": { "content": "partial answer" } }] });
        assert_eq!(generate(200, &body.to_string()), Err(expected));
    }
}

#[test]
fn malformed_or_missing_text_is_an_invalid_response() {
    for body in [
        "not JSON",
        "{}",
        r#"{"choices":[]}"#,
        r#"{"choices":[{"finish_reason":"stop","message":{"content":null}}]}"#,
        r#"{"choices":[{"finish_reason":"stop","message":{"content":[],"refusal":null}}]}"#,
    ] {
        assert_eq!(generate(200, body), Err(GenerationError::InvalidResponse));
    }
}

#[test]
fn a_refusal_is_a_rejection_even_when_the_finish_reason_is_stop() {
    assert_eq!(
        generate(
            200,
            r#"{"choices":[{"finish_reason":"stop","message":{"content":null,"refusal":"private refusal"}}]}"#
        ),
        Err(GenerationError::Rejected)
    );
}

#[test]
fn response_size_is_bounded() {
    let result = with_response(
        200,
        &answer(&"x".repeat(128)),
        OpenRouterTuning {
            max_response_bytes: 64,
            ..OpenRouterTuning::default()
        },
        |client| client.generate(&request()),
    )
    .0;
    assert_eq!(result, Err(GenerationError::InvalidResponse));
}

#[test]
fn a_stalled_provider_reaches_the_deadline_without_a_retry() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let client = OpenRouterClient::build(
        Credentials::Provided(FIXTURE_KEY.to_owned()),
        &format!("http://{address}/api/v1/chat/completions"),
        OpenRouterTuning {
            request_timeout: Duration::from_millis(30),
            ..OpenRouterTuning::default()
        },
    )
    .unwrap();
    let (release, wait) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            read_request(&stream);
            // Hold the connection until the client's deadline fires; no sleeps.
            wait.recv().unwrap();
        });
        assert_eq!(client.generate(&request()), Err(GenerationError::Timeout));
        release.send(()).unwrap();
    });
}

#[test]
fn the_deadline_also_covers_a_stalled_response_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let client = OpenRouterClient::build(
        Credentials::Provided(FIXTURE_KEY.to_owned()),
        &format!("http://{address}/api/v1/chat/completions"),
        OpenRouterTuning {
            request_timeout: Duration::from_millis(30),
            ..OpenRouterTuning::default()
        },
    )
    .unwrap();
    let (release, wait) = mpsc::channel();
    std::thread::scope(|scope| {
        scope.spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            read_request(&stream);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{")
                .unwrap();
            wait.recv().unwrap();
        });
        let result = client.generate(&request());
        release.send(()).unwrap();
        assert_eq!(result, Err(GenerationError::Timeout));
    });
}

#[test]
fn credential_file_supports_quotes_and_export_without_mutating_the_environment() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.sample");
    std::fs::write(
        &path,
        "# local configuration\nexport OPENROUTER_KEY='fixture-key'\n",
    )
    .unwrap();
    assert_eq!(key_from_sources(None, &path), Ok("fixture-key".to_owned()));
    assert_eq!(
        key_from_sources(Some("environment-key".to_owned()), &path),
        Ok("environment-key".to_owned())
    );
}

#[test]
fn a_missing_file_or_key_is_missing_credentials() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.sample");
    assert_eq!(
        key_from_sources(None, &path),
        Err(GenerationError::MissingCredentials)
    );
    std::fs::write(&path, "OTHER_SETTING=value\n").unwrap();
    assert_eq!(
        key_from_sources(None, &path),
        Err(GenerationError::MissingCredentials)
    );
}

#[test]
fn malformed_or_unreadable_credential_files_report_only_a_code() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(".env.sample");
    std::fs::write(&path, "OPENROUTER_KEY='unterminated private content\n").unwrap();
    assert_eq!(
        key_from_sources(None, &path),
        Err(GenerationError::InvalidConfiguration)
    );
    assert_eq!(
        key_from_sources(None, dir.path()),
        Err(GenerationError::InvalidConfiguration)
    );
    // A supplied environment key is authoritative, even if the file is malformed.
    assert_eq!(
        key_from_sources(Some("environment-key".to_owned()), &path),
        Ok("environment-key".to_owned())
    );
}

#[test]
fn empty_or_header_unsafe_credentials_are_rejected() {
    for key in ["", "  ", "key\nInjected: header", "key\r", "キー"] {
        assert!(matches!(
            OpenRouterClient::new(key, OpenRouterTuning::default()),
            Err(GenerationError::InvalidCredentials)
        ));
    }
}

#[test]
fn debug_does_not_expose_credentials() {
    let client = OpenRouterClient::new(FIXTURE_KEY, OpenRouterTuning::default()).unwrap();
    assert!(!format!("{client:?}").contains(FIXTURE_KEY));
}

#[test]
fn a_redirect_is_not_accepted_as_a_completed_generation() {
    assert_eq!(
        generate(302, &answer("redirect body")),
        Err(GenerationError::Unavailable)
    );
}

#[test]
fn zero_transport_bounds_are_invalid_before_credentials_are_loaded() {
    for tuning in [
        OpenRouterTuning {
            request_timeout: Duration::ZERO,
            ..OpenRouterTuning::default()
        },
        OpenRouterTuning {
            max_response_bytes: 0,
            ..OpenRouterTuning::default()
        },
    ] {
        assert!(matches!(
            OpenRouterClient::from_environment(tuning),
            Err(GenerationError::InvalidConfiguration)
        ));
    }
}

struct FixtureGenerator {
    status: u16,
    body: String,
}

impl TextGenerator for FixtureGenerator {
    fn generate(&self, request: &GenerationRequest) -> Result<GenerationView, GenerationError> {
        with_response(
            self.status,
            &self.body,
            OpenRouterTuning::default(),
            |client| client.generate(request),
        )
        .0
    }
}

#[test]
fn the_real_http_adapter_obeys_the_same_contract_as_the_fake() {
    text_generator_contract(|reply| {
        let (status, body) = match reply {
            Ok(view) => (200, answer(&view.text)),
            Err(GenerationError::InvalidCredentials) => (401, String::new()),
            Err(GenerationError::InsufficientCredits) => (402, String::new()),
            Err(GenerationError::RateLimited) => (429, String::new()),
            Err(GenerationError::Unavailable) => (503, String::new()),
            Err(GenerationError::Rejected) => (403, String::new()),
            Err(GenerationError::Truncated) => (
                200,
                r#"{"choices":[{"finish_reason":"length","message":{"content":null}}]}"#.to_owned(),
            ),
            Err(GenerationError::InvalidResponse) => (200, "malformed".to_owned()),
            Err(
                GenerationError::EmptyPrompt
                | GenerationError::InvalidConfiguration
                | GenerationError::MissingCredentials
                | GenerationError::Timeout,
            ) => panic!("this contract exercises provider responses"),
        };
        Box::new(FixtureGenerator { status, body })
    });
}
