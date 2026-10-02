//! On-demand text generation, independent of any provider, HTTP client, or credentials.

use std::sync::Arc;

use serde::Serialize;

/// How much reasoning a model should use. Choose a level the selected model supports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ReasoningEffort {
    /// Disable reasoning for models that support doing so.
    None,
    /// Favor a short reasoning pass.
    Low,
    /// Use the model's moderate reasoning level.
    Medium,
    /// Give the model more room to reason.
    High,
    /// Use the extra-high level on models that support it.
    Xhigh,
    /// Use the model's maximum supported reasoning effort.
    Max,
}

/// Source-controlled model choices passed in by the composition root, never read from
/// the environment by core. The output limit includes the model's reasoning tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationSettings {
    /// The provider's exact model identifier.
    pub model: String,
    /// The chosen model's reasoning level.
    pub reasoning_effort: ReasoningEffort,
    /// The maximum number of generated tokens, including reasoning; must be nonzero.
    pub max_output_tokens: u32,
}

/// One explicit model call. Contains user data; never put it in diagnostics or logs.
#[derive(Clone, PartialEq, Eq)]
pub struct GenerationRequest {
    /// The text the caller asks the model to process, preserved verbatim.
    pub prompt: String,
    /// The model and generation budget for this call.
    pub settings: GenerationSettings,
}

impl std::fmt::Debug for GenerationRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GenerationRequest")
            .field("prompt", &"[redacted]")
            .field("settings", &self.settings)
            .finish()
    }
}

/// The answer both a CLI command and a TUI screen can show. Do not log its text.
#[derive(Clone, PartialEq, Eq, Serialize)]
pub struct GenerationView {
    /// Only the final answer; internal reasoning is not exposed by the adapter.
    pub text: String,
}

impl std::fmt::Debug for GenerationView {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GenerationView")
            .field("text", &"[redacted]")
            .finish()
    }
}

/// A failed generation, carrying no credential, prompt, response, or provider message.
/// The binary maps these codes to wording; serialization also exposes only the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error, Serialize)]
#[serde(tag = "code", rename_all = "camelCase")]
pub enum GenerationError {
    /// The prompt contains no text; no model call was made.
    #[error("generation_failed: empty_prompt")]
    EmptyPrompt,
    /// Model settings or credential-file syntax cannot be used.
    #[error("generation_failed: invalid_configuration")]
    InvalidConfiguration,
    /// No credential was configured for this call.
    #[error("generation_failed: missing_credentials")]
    MissingCredentials,
    /// The credential cannot be used or was rejected by the provider.
    #[error("generation_failed: invalid_credentials")]
    InvalidCredentials,
    /// The provider account has insufficient credits.
    #[error("generation_failed: insufficient_credits")]
    InsufficientCredits,
    /// The provider's rate limit was reached.
    #[error("generation_failed: rate_limited")]
    RateLimited,
    /// The call did not complete within its deadline.
    #[error("generation_failed: timeout")]
    Timeout,
    /// The transport or provider is unavailable.
    #[error("generation_failed: unavailable")]
    Unavailable,
    /// The provider rejected the request or filtered the answer.
    #[error("generation_failed: rejected")]
    Rejected,
    /// The output budget was exhausted; a partial answer is not returned as success.
    #[error("generation_failed: truncated")]
    Truncated,
    /// The response was malformed, empty, or unsupported.
    #[error("generation_failed: invalid_response")]
    InvalidResponse,
}

/// The synchronous model port. Adapters translate provider results into core values.
/// A call is explicit, has no conversation state, and is never automatically retried.
pub trait TextGenerator: Send + Sync {
    /// Generate one final text answer for a request validated by [`GenerationService`].
    ///
    /// # Errors
    /// A [`GenerationError`] preserving the actionable failure kind, without user data.
    fn generate(&self, request: &GenerationRequest) -> Result<GenerationView, GenerationError>;
}

/// Validates a prompt, calls the injected generator once, and returns a view for either
/// front end. Construction performs no I/O. A front end should schedule a slow call off
/// its TUI event loop; core starts no background work of its own.
pub struct GenerationService {
    generator: Arc<dyn TextGenerator>,
    settings: GenerationSettings,
}

impl GenerationService {
    /// Prepare a service without contacting a model or looking up credentials.
    #[must_use]
    pub fn new(generator: Arc<dyn TextGenerator>, settings: GenerationSettings) -> Self {
        Self {
            generator,
            settings,
        }
    }

    /// Generate on demand, preserving the prompt and final answer verbatim.
    ///
    /// # Errors
    /// [`GenerationError::EmptyPrompt`] or [`GenerationError::InvalidConfiguration`]
    /// before a call; the port's error on failure; [`GenerationError::InvalidResponse`]
    /// for an answer containing no text.
    pub fn generate(&self, prompt: &str) -> Result<GenerationView, GenerationError> {
        if prompt.trim().is_empty() {
            return Err(GenerationError::EmptyPrompt);
        }
        if self.settings.model.is_empty()
            || self.settings.model.chars().any(char::is_whitespace)
            || self.settings.max_output_tokens == 0
        {
            return Err(GenerationError::InvalidConfiguration);
        }
        let view = self.generator.generate(&GenerationRequest {
            prompt: prompt.to_owned(),
            settings: self.settings.clone(),
        })?;
        if view.text.trim().is_empty() {
            return Err(GenerationError::InvalidResponse);
        }
        Ok(view)
    }
}
