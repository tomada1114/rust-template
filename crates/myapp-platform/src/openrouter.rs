//! Optional `OpenRouter` transport. The credential is resolved only for an explicit call.

use std::io;
use std::path::Path;
use std::time::Duration;

use myapp_core::{GenerationError, GenerationRequest, GenerationView, TextGenerator};
use serde::Deserialize;
use serde_json::json;

const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";
const KEY_VARIABLE: &str = "OPENROUTER_KEY";
const LOCAL_ENV_FILE: &str = ".env.local";

/// Transport bounds, separate from the source-controlled model and token settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OpenRouterTuning {
    /// A deadline covering connection, generation, and response reading. Max-effort
    /// reasoning can take longer than an ordinary text completion.
    pub request_timeout: Duration,
    /// Reject a larger response rather than allocating without a bound.
    pub max_response_bytes: u64,
}

impl Default for OpenRouterTuning {
    fn default() -> Self {
        Self {
            request_timeout: Duration::from_secs(180),
            max_response_bytes: 2 * 1024 * 1024,
        }
    }
}

enum Credentials {
    Provided(String),
    Environment,
}

/// Blocking `OpenRouter` HTTPS adapter. Only [`TextGenerator::generate`] sends a request;
/// construction performs no credential-file lookup and no network access. Credentials,
/// prompts, provider error bodies, and answers are never included in diagnostics.
pub struct OpenRouterClient {
    agent: ureq::Agent,
    endpoint: String,
    credentials: Credentials,
    tuning: OpenRouterTuning,
}

impl std::fmt::Debug for OpenRouterClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenRouterClient")
            .field("credentials", &"[redacted]")
            .field("tuning", &self.tuning)
            .finish_non_exhaustive()
    }
}

impl OpenRouterClient {
    /// Use a key supplied by the composition root, without looking at the environment.
    ///
    /// # Errors
    /// [`GenerationError::InvalidCredentials`] for an empty or header-unsafe key;
    /// [`GenerationError::InvalidConfiguration`] for a zero transport bound.
    pub fn new(api_key: &str, tuning: OpenRouterTuning) -> Result<Self, GenerationError> {
        validate_key(api_key)?;
        Self::build(Credentials::Provided(api_key.to_owned()), ENDPOINT, tuning)
    }

    /// Resolve `OPENROUTER_KEY` when called, falling back only when it is unset to
    /// `.env.local` in the current working directory. Does not change the environment,
    /// search parent directories, or require a key until an explicit model call.
    ///
    /// # Errors
    /// [`GenerationError::InvalidConfiguration`] for a zero transport bound.
    pub fn from_environment(tuning: OpenRouterTuning) -> Result<Self, GenerationError> {
        Self::build(Credentials::Environment, ENDPOINT, tuning)
    }

    fn build(
        credentials: Credentials,
        endpoint: &str,
        tuning: OpenRouterTuning,
    ) -> Result<Self, GenerationError> {
        if tuning.request_timeout.is_zero() || tuning.max_response_bytes == 0 {
            return Err(GenerationError::InvalidConfiguration);
        }
        let config = ureq::Agent::config_builder()
            .tls_config(
                ureq::tls::TlsConfig::builder()
                    .provider(ureq::tls::TlsProvider::NativeTls)
                    .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                    .build(),
            )
            .timeout_global(Some(tuning.request_timeout))
            // Never replay a paid POST or forward its Authorization header to a redirect.
            .max_redirects(0)
            .proxy(None)
            .build();
        Ok(Self {
            agent: config.into(),
            endpoint: endpoint.to_owned(),
            credentials,
            tuning,
        })
    }

    fn key(&self) -> Result<String, GenerationError> {
        match &self.credentials {
            Credentials::Provided(key) => Ok(key.clone()),
            Credentials::Environment => {
                let key = match std::env::var(KEY_VARIABLE) {
                    Ok(key) => Some(key),
                    Err(std::env::VarError::NotPresent) => None,
                    Err(std::env::VarError::NotUnicode(_)) => {
                        return Err(GenerationError::InvalidCredentials);
                    }
                };
                key_from_sources(key, Path::new(LOCAL_ENV_FILE))
            }
        }
    }
}

impl TextGenerator for OpenRouterClient {
    fn generate(&self, request: &GenerationRequest) -> Result<GenerationView, GenerationError> {
        let key = self.key()?;
        let mut response = self
            .agent
            .post(&self.endpoint)
            .header("Authorization", format!("Bearer {key}"))
            .send_json(json!({
                "model": request.settings.model,
                "messages": [{ "role": "user", "content": request.prompt }],
                "reasoning": { "effort": request.settings.reasoning_effort, "exclude": true },
                "max_tokens": request.settings.max_output_tokens,
                "stream": false,
                "provider": { "require_parameters": true },
            }))
            .map_err(|error| transport_error(&error))?;
        if !response.status().is_success() {
            return Err(status_error(response.status().as_u16()));
        }
        let body = response
            .body_mut()
            .with_config()
            .limit(self.tuning.max_response_bytes)
            .read_to_vec()
            .map_err(|error| transport_error(&error))?;
        decode_response(&body)
    }
}

fn validate_key(key: &str) -> Result<(), GenerationError> {
    if key.is_empty() || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(GenerationError::InvalidCredentials);
    }
    Ok(())
}

fn key_from_sources(environment: Option<String>, path: &Path) -> Result<String, GenerationError> {
    if let Some(key) = environment {
        validate_key(&key)?;
        return Ok(key);
    }
    let values = dotenvy::from_path_iter(path).map_err(|error| match error {
        dotenvy::Error::Io(error) if error.kind() == io::ErrorKind::NotFound => {
            GenerationError::MissingCredentials
        }
        _ => GenerationError::InvalidConfiguration,
    })?;
    let mut key = None;
    for value in values {
        let (name, value) = value.map_err(|_| GenerationError::InvalidConfiguration)?;
        if name == KEY_VARIABLE && key.is_none() {
            key = Some(value);
        }
    }
    let key = key.ok_or(GenerationError::MissingCredentials)?;
    validate_key(&key)?;
    Ok(key)
}

fn status_error(status: u16) -> GenerationError {
    match status {
        401 => GenerationError::InvalidCredentials,
        402 => GenerationError::InsufficientCredits,
        408 | 504 => GenerationError::Timeout,
        429 => GenerationError::RateLimited,
        400..=499 => GenerationError::Rejected,
        _ => GenerationError::Unavailable,
    }
}

fn transport_error(error: &ureq::Error) -> GenerationError {
    match error {
        ureq::Error::StatusCode(status) => status_error(*status),
        ureq::Error::Timeout(_) => GenerationError::Timeout,
        ureq::Error::BodyExceedsLimit(_) => GenerationError::InvalidResponse,
        _ => GenerationError::Unavailable,
    }
}

#[derive(Deserialize)]
struct Completion {
    #[serde(default)]
    choices: Vec<Choice>,
    error: Option<ProviderError>,
}

#[derive(Deserialize)]
struct ProviderError {
    code: u16,
}

#[derive(Deserialize)]
struct Choice {
    finish_reason: String,
    message: Message,
}

#[derive(Deserialize)]
struct Message {
    content: Option<String>,
    refusal: Option<String>,
}

fn decode_response(body: &[u8]) -> Result<GenerationView, GenerationError> {
    let response: Completion =
        serde_json::from_slice(body).map_err(|_| GenerationError::InvalidResponse)?;
    if let Some(error) = response.error {
        return Err(status_error(error.code));
    }
    let choice = response
        .choices
        .into_iter()
        .next()
        .ok_or(GenerationError::InvalidResponse)?;
    match choice.finish_reason.as_str() {
        "length" => return Err(GenerationError::Truncated),
        "content_filter" => return Err(GenerationError::Rejected),
        "stop" => {}
        _ => return Err(GenerationError::InvalidResponse),
    }
    if choice.message.refusal.is_some() {
        return Err(GenerationError::Rejected);
    }
    let text = choice
        .message
        .content
        .ok_or(GenerationError::InvalidResponse)?;
    Ok(GenerationView { text })
}

#[cfg(test)]
mod tests;
