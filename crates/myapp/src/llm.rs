//! The optional model command's composition and output; model choices live in source.

use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::Arc;

use myapp_core::{GenerationError, GenerationService, GenerationSettings, ReasoningEffort};
use myapp_platform::{OpenRouterClient, OpenRouterTuning};

use crate::wording;

const MODEL: &str = "openai/gpt-6-luna";
const REASONING_EFFORT: ReasoningEffort = ReasoningEffort::Max;
const MAX_OUTPUT_TOKENS: u32 = 32_768;

fn settings() -> GenerationSettings {
    GenerationSettings {
        model: MODEL.to_owned(),
        reasoning_effort: REASONING_EFFORT,
        max_output_tokens: MAX_OUTPUT_TOKENS,
    }
}

/// Share the source-selected generator between explicit CLI and future TUI actions.
pub(crate) fn compose() -> Result<GenerationService, GenerationError> {
    Ok(GenerationService::new(
        Arc::new(OpenRouterClient::from_environment(
            OpenRouterTuning::default(),
        )?),
        settings(),
    ))
}

/// Compose the optional generator only for this explicit command and print its answer.
pub(crate) fn run(prompt: &str) -> ExitCode {
    let result = compose()
        .map_err(RunError::Generation)
        .and_then(|service| write_answer(&service, prompt, &mut io::stdout().lock()));
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            let message = match error {
                RunError::Generation(error) => wording::generation_error(error),
                RunError::Stdout => wording::STDOUT_UNAVAILABLE,
            };
            eprintln!("error: {message}");
            ExitCode::FAILURE
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum RunError {
    Generation(GenerationError),
    Stdout,
}

fn write_answer(
    service: &GenerationService,
    prompt: &str,
    output: &mut impl Write,
) -> Result<(), RunError> {
    let view = service.generate(prompt).map_err(RunError::Generation)?;
    writeln!(output, "{}", view.text).map_err(|_| RunError::Stdout)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use myapp_test_support::StubTextGenerator;

    use super::*;

    fn service(generator: StubTextGenerator) -> GenerationService {
        GenerationService::new(Arc::new(generator), settings())
    }

    #[test]
    fn a_complete_answer_is_printed_to_stdout_without_other_content() {
        let service = service(StubTextGenerator::replying("First line.\nSecond line."));
        let mut output = Vec::new();
        assert_eq!(write_answer(&service, "question", &mut output), Ok(()));
        assert_eq!(output, b"First line.\nSecond line.\n");
    }

    #[test]
    fn a_generation_failure_prints_no_answer() {
        let service = service(StubTextGenerator::failing(GenerationError::Truncated));
        let mut output = Vec::new();
        assert_eq!(
            write_answer(&service, "question", &mut output),
            Err(RunError::Generation(GenerationError::Truncated))
        );
        assert_eq!(output, Vec::<u8>::new());
    }

    struct ClosedOutput;

    impl Write for ClosedOutput {
        fn write(&mut self, _bytes: &[u8]) -> io::Result<usize> {
            Err(io::Error::from(io::ErrorKind::BrokenPipe))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_closed_stdout_is_a_runtime_failure_without_a_panic() {
        let service = service(StubTextGenerator::replying("answer"));
        assert_eq!(
            write_answer(&service, "question", &mut ClosedOutput),
            Err(RunError::Stdout)
        );
    }

    #[test]
    fn the_shipped_model_uses_luna_with_max_effort() {
        let chosen = settings();
        assert_eq!(chosen.model, "openai/gpt-6-luna");
        assert_eq!(chosen.reasoning_effort, ReasoningEffort::Max);
        assert_eq!(chosen.max_output_tokens, 32_768);
    }
}
