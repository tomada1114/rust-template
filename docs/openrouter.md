# OpenRouter

Model calls are optional. The default build includes the provider-neutral core port,
but neither the OpenRouter HTTP dependencies nor the `llm` command. Enable the
`openrouter` Cargo feature when an app needs them:

```bash
cargo run --locked -p myapp --features openrouter -- llm ask "Explain Rust ownership in one sentence."
```

Only `llm ask` contacts a model. Counter commands, the counter TUI, `--help`,
`--version`, and constructing a generator need no key and make no model call.

HTTPS uses the operating system's trusted certificates: Security.framework on macOS
and OpenSSL on Linux. Building this feature on Linux also needs OpenSSL development
headers and `pkg-config` (`libssl-dev` and `pkg-config` on Debian or Ubuntu), plus a
system CA certificate bundle at runtime. Default builds need none of these additions.

## Credentials

Set `OPENROUTER_KEY` in the process environment, or put it in `.env.local` in the
directory from which you run the command:

```dotenv
OPENROUTER_KEY=<your OpenRouter API key>
```

The environment takes precedence, including an explicitly empty value, which is an
error. When the variable is unset, only that directory's `.env.local` is read; parent
directories are not searched. Quoted values and `export` syntax are supported. The
parser does not set process environment variables. Git ignores `.env.local`, and
credentials are never included in diagnostic output. An installed binary uses its
working directory too, so run it from the directory containing the file or export the
key in your shell.

## Model choices in source

`crates/myapp/src/llm.rs` contains the model identifier, reasoning effort, and token
budget: `openai/gpt-6-luna`, `ReasoningEffort::Max`, and `32_768` generated tokens.
Change those constants to choose another supported model. Model settings are not read
from environment variables.

Luna's supported efforts include `max`, as verified in the public
[model catalog](https://openrouter.ai/api/v1/models) on 2026-10-02. The request requires
providers to support its parameters and excludes internal reasoning from the answer.
The token budget includes reasoning tokens, so a response that exhausts it is reported
as truncated instead of returning partial text as success. See OpenRouter's
[reasoning documentation](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Reusing the adapter

`TextGenerator` is a synchronous `Send + Sync` port in `myapp-core`.
`OpenRouterClient` in `myapp-platform` implements it, behind the `openrouter` feature.
`GenerationService` validates the prompt and settings, invokes the port once, rejects
an empty answer, and returns a `GenerationView` for either front end. For example,
composition code can construct a service without looking up credentials or contacting
the network:

```rust
use std::sync::Arc;
use myapp_core::{GenerationService, GenerationSettings, ReasoningEffort};
use myapp_platform::{OpenRouterClient, OpenRouterTuning};

let generator = OpenRouterClient::from_environment(OpenRouterTuning::default())?;
let service = GenerationService::new(Arc::new(generator), GenerationSettings {
    model: "openai/gpt-6-luna".to_owned(),
    reasoning_effort: ReasoningEffort::Max,
    max_output_tokens: 32_768,
});
let answer = service.generate("Explain Rust ownership in one sentence.")?;
```

The binary's `llm::compose` function shares its source-selected settings with future
TUI actions. Schedule a blocking model call on a front-end worker and send its result
back to the screen as an action; keep the terminal event loop responsive and use
`wording::generation_error` for its error line. Core does not start threads or depend
on an async runtime. The sample counter TUI remains a counter.

`OpenRouterClient::new` accepts a key supplied directly by composition code instead.
Tests inject `StubTextGenerator` from the dev-only `myapp-test-support`; its
`text_generator_contract` also runs against the adapter using a local HTTP fixture.

## Bounds and failures

`OpenRouterTuning` defaults to a 180-second deadline covering connection through body
reading and a 2 MiB response limit. The adapter uses direct HTTPS, does not inherit
proxy settings, follows no redirects, and makes a single request without automatic
retries. It supports one user prompt and one final text answer, without streaming,
conversation history, or tools.

Missing or invalid credentials, insufficient credits, rate limits, timeouts,
unavailable providers, rejected requests, truncation, and malformed answers have typed
`GenerationError` codes. The CLI prints the final answer on stdout and diagnostics on
stderr; success exits 0, runtime failure 1, and a usage error 2. Prompts, answers,
provider error bodies, and credentials are excluded from logs and errors. Tests and
routine repository checks use synthetic credentials and local servers, with no paid
API calls.
