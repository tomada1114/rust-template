//! Model generation is an explicit call through a port; no environment or network here.

use std::sync::Arc;

use myapp_core::{
    GenerationError, GenerationRequest, GenerationService, GenerationSettings, GenerationView,
    ReasoningEffort,
};
use myapp_test_support::{StubTextGenerator, text_generator_contract};

fn settings() -> GenerationSettings {
    GenerationSettings {
        model: "example/model".to_owned(),
        reasoning_effort: ReasoningEffort::Max,
        max_output_tokens: 32_768,
    }
}

#[test]
fn constructing_a_service_does_not_call_the_model() {
    let generator = Arc::new(StubTextGenerator::replying("answer"));
    let _service = GenerationService::new(generator.clone(), settings());
    assert_eq!(generator.requests(), Vec::new());
}

#[test]
fn generate_forwards_the_prompt_and_source_settings_and_returns_the_answer() {
    let generator = Arc::new(StubTextGenerator::replying("  Answer\nwith two lines.  "));
    let service = GenerationService::new(generator.clone(), settings());
    assert_eq!(
        service.generate("  Explain Rust.  "),
        Ok(GenerationView {
            text: "  Answer\nwith two lines.  ".to_owned(),
        })
    );
    assert_eq!(
        generator.requests(),
        vec![GenerationRequest {
            prompt: "  Explain Rust.  ".to_owned(),
            settings: settings(),
        }]
    );
}

#[test]
fn a_blank_prompt_fails_before_the_model_is_called() {
    let generator = Arc::new(StubTextGenerator::replying("answer"));
    let service = GenerationService::new(generator.clone(), settings());
    for prompt in ["", " \t\n", "\u{3000}"] {
        assert_eq!(service.generate(prompt), Err(GenerationError::EmptyPrompt));
    }
    assert_eq!(generator.requests(), Vec::new());
}

#[test]
fn invalid_model_settings_fail_without_a_model_call() {
    for invalid in [
        GenerationSettings {
            model: String::new(),
            ..settings()
        },
        GenerationSettings {
            model: "  ".to_owned(),
            ..settings()
        },
        GenerationSettings {
            max_output_tokens: 0,
            ..settings()
        },
    ] {
        let generator = Arc::new(StubTextGenerator::replying("answer"));
        let service = GenerationService::new(generator.clone(), invalid);
        assert_eq!(
            service.generate("question"),
            Err(GenerationError::InvalidConfiguration)
        );
        assert_eq!(generator.requests(), Vec::new());
    }
}

#[test]
fn debugging_generation_values_does_not_expose_user_text() {
    let request = GenerationRequest {
        prompt: "private-prompt".to_owned(),
        settings: settings(),
    };
    let view = GenerationView {
        text: "private-answer".to_owned(),
    };
    assert!(!format!("{request:?}").contains("private-prompt"));
    assert!(!format!("{view:?}").contains("private-answer"));
    assert_eq!(
        serde_json::to_value(view).unwrap(),
        serde_json::json!({ "text": "private-answer" })
    );
}

#[test]
fn an_empty_answer_is_an_invalid_response() {
    for answer in ["", " \n\t"] {
        let service =
            GenerationService::new(Arc::new(StubTextGenerator::replying(answer)), settings());
        assert_eq!(
            service.generate("question"),
            Err(GenerationError::InvalidResponse)
        );
    }
}

#[test]
fn every_port_failure_is_preserved_without_a_retry() {
    for error in [
        GenerationError::InvalidConfiguration,
        GenerationError::MissingCredentials,
        GenerationError::InvalidCredentials,
        GenerationError::InsufficientCredits,
        GenerationError::RateLimited,
        GenerationError::Timeout,
        GenerationError::Unavailable,
        GenerationError::Rejected,
        GenerationError::Truncated,
        GenerationError::InvalidResponse,
    ] {
        let generator = Arc::new(StubTextGenerator::failing(error));
        let service = GenerationService::new(generator.clone(), settings());
        assert_eq!(service.generate("question"), Err(error));
        assert_eq!(generator.requests().len(), 1);
    }
}

#[test]
fn the_fake_obeys_the_text_generator_contract() {
    text_generator_contract(|reply| Box::new(StubTextGenerator::new(reply)));
}

#[test]
fn reasoning_efforts_serialize_to_the_documented_wire_values() {
    for (effort, expected) in [
        (ReasoningEffort::None, "\"none\""),
        (ReasoningEffort::Low, "\"low\""),
        (ReasoningEffort::Medium, "\"medium\""),
        (ReasoningEffort::High, "\"high\""),
        (ReasoningEffort::Xhigh, "\"xhigh\""),
        (ReasoningEffort::Max, "\"max\""),
    ] {
        assert_eq!(serde_json::to_string(&effort).unwrap(), expected);
    }
}

#[test]
fn errors_serialize_as_codes_without_request_or_provider_data() {
    for (error, expected) in [
        (GenerationError::EmptyPrompt, "emptyPrompt"),
        (
            GenerationError::InvalidConfiguration,
            "invalidConfiguration",
        ),
        (GenerationError::MissingCredentials, "missingCredentials"),
        (GenerationError::InvalidCredentials, "invalidCredentials"),
        (GenerationError::InsufficientCredits, "insufficientCredits"),
        (GenerationError::RateLimited, "rateLimited"),
        (GenerationError::Timeout, "timeout"),
        (GenerationError::Unavailable, "unavailable"),
        (GenerationError::Rejected, "rejected"),
        (GenerationError::Truncated, "truncated"),
        (GenerationError::InvalidResponse, "invalidResponse"),
    ] {
        assert_eq!(
            serde_json::to_value(error).unwrap(),
            serde_json::json!({ "code": expected })
        );
    }
}
