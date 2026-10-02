use std::sync::{Mutex, PoisonError};

use myapp_core::{
    GenerationError, GenerationRequest, GenerationSettings, GenerationView, ReasoningEffort,
    TextGenerator,
};

/// A model that answers from a scripted value and records every explicit call.
pub struct StubTextGenerator {
    reply: Result<GenerationView, GenerationError>,
    requests: Mutex<Vec<GenerationRequest>>,
}

impl StubTextGenerator {
    /// Supply either a final answer or an actionable failure without any network access.
    #[must_use]
    pub fn new(reply: Result<GenerationView, GenerationError>) -> Self {
        Self {
            reply,
            requests: Mutex::new(Vec::new()),
        }
    }

    /// A model that returns the same answer for every call.
    #[must_use]
    pub fn replying(text: &str) -> Self {
        Self::new(Ok(GenerationView {
            text: text.to_owned(),
        }))
    }

    /// A model that fails every call with the given kind.
    #[must_use]
    pub fn failing(error: GenerationError) -> Self {
        Self::new(Err(error))
    }

    /// The requests received so far, in call order, for a test's independent assertions.
    #[must_use]
    pub fn requests(&self) -> Vec<GenerationRequest> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl TextGenerator for StubTextGenerator {
    fn generate(&self, request: &GenerationRequest) -> Result<GenerationView, GenerationError> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(request.clone());
        self.reply.clone()
    }
}

/// Verify final-answer and typed-error translation against a scripted generator. `make`
/// builds a new fake or adapter backed by a local HTTP fixture for each supplied reply.
///
/// # Panics
/// When a generator loses answer text, consumes its answer, or changes the failure kind.
pub fn text_generator_contract(
    mut make: impl FnMut(Result<GenerationView, GenerationError>) -> Box<dyn TextGenerator>,
) {
    let request = GenerationRequest {
        prompt: "Return the scripted answer.".to_owned(),
        settings: GenerationSettings {
            model: "example/model".to_owned(),
            reasoning_effort: ReasoningEffort::Max,
            max_output_tokens: 32_768,
        },
    };
    let answer = GenerationView {
        text: "  A complete answer.\nSecond line.  ".to_owned(),
    };
    let generator = make(Ok(answer.clone()));
    assert_eq!(generator.generate(&request), Ok(answer.clone()));
    assert_eq!(generator.generate(&request), Ok(answer));
    for error in [
        GenerationError::InvalidCredentials,
        GenerationError::InsufficientCredits,
        GenerationError::RateLimited,
        GenerationError::Unavailable,
        GenerationError::Rejected,
        GenerationError::Truncated,
        GenerationError::InvalidResponse,
    ] {
        assert_eq!(make(Err(error)).generate(&request), Err(error));
    }
}
