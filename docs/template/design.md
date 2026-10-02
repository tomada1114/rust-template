# rust-template: design

<!-- template-only: cargo xtask bootstrap removes docs/template/ from a generated app. -->

Status: **finalized with the owner on 2026-10-02.** This records the current template
design. The maintained architecture and operating rules live in
[architecture.md](../architecture.md), the README's Design Philosophy, and
`AGENTS.md`. The companion [skills-plan.md](skills-plan.md) describes the skill set;
[implementation-notes.md](implementation-notes.md) records implementation observations.

## 1. What this template is

A public template for the owner's Rust command-line tools on macOS and Linux. It
provides one binary, `myapp`, with clap subcommands and a ratatui `tui` subcommand over
the same core. The counter sample illustrates storage, time, errors, and both front
ends; an app replaces it with its own domain.

The template supplies command-line and terminal interfaces. It imposes no general
prohibition on future graphical front ends; an app's dependency and architecture
changes still follow its review and ADR policies.

Current scope excludes Windows, a release pipeline, prebuilt or signed artifacts,
package-manager publishing, an updater, and a second wording language. Those become
app-level decisions when needed. Optional model calls are available behind the
`openrouter` feature; the default build needs neither provider credentials nor its
HTTP dependencies.

## 2. Decisions

### D1. Repository layout and crate names

Use a virtual Cargo workspace: `myapp-core` for domain logic and ports,
`myapp-platform` for adapters, `myapp-test-support` for fakes and contracts,
`myapp` for the binary, and `xtask` with `xtask-guard` for repository automation.
The split makes the dependency direction reviewable and lets core be tested without
the operating system. App crates carry the renameable prefix; none is named `core`.

### D2. Synchronous ports and adapters

A port is a synchronous `Send + Sync` trait over core-owned types. Platform
implements it; the binary constructs the real adapter; tests inject a fake. Core
never meets an async runtime. One contract suite per port runs against both the fake
and the real adapter so their behavior cannot drift independently.

### D3. Enforcing the OS boundary

Core's manifest names no OS binding or platform crate. The dependency-closure check
rejects normal and build paths to the OS bindings and `myapp-platform` listed in
`AGENTS.md`; the two lists must agree. The direct-edge rule in `deny.toml` lets only
the binary depend on `myapp-platform`. Test-support is dev-only.

Core's clippy configuration keeps direct I/O, clocks, environment reads, processes,
and unscoped threads behind ports or arguments. The existing OS boundary remains
independent of the choice of front end.

### D4. Shared views and wording

Every value a front end shows comes from a core view type. Subcommands and TUI frames
read the same model. Core returns data and typed errors; the binary's `wording.rs`
owns user-facing sentences and exhaustively maps error variants.

### D5. One binary with subcommands

One installation yields all entry points. The binary parses arguments, wires
adapters, calls core, and translates results. Data goes to stdout, diagnostics to
stderr; success exits 0, runtime errors 1, and usage errors 2. A machine-readable
output form is added when an app needs it.

### D6. The deletable counter example

The sample exercises `CounterStore`, `Clock`, persistence, bounds, typed failures,
and shared `CounterView` values. Core owns the state transitions; both front ends
call the same service. `starting-an-app` and the getting-started guide describe
replacing the sample without changing the harness.

### D7. Logging

Platform and the binary use `tracing`; core logs nothing. Only the binary installs
the subscriber. Logs use the platform's state/log directory, rotate daily, and retain
the last 14 files. While the TUI runs, logging goes only to the file. Model prompts,
answers, credentials, and provider error bodies are excluded from logs and errors.

### D8. Terminal UI

ratatui draws core views with the crossterm backend. Core owns the screen state and
key table; the binary owns rendering and the terminal loop. The terminal is restored
on exit, error, and panic. The terminal's own colors provide the base style; every
action has a named key, and meaning never depends on color alone. An app-specific
theme requires an ADR.

### D9. Tool pinning

`rust-toolchain.toml` holds the Rust pin. `mise.toml` holds the remaining tool
pins, preferring prebuilt binaries. Renovate updates those two configurations;
Dependabot updates crates and GitHub Actions. Their release-age policies agree.
Tool-specific values belong in their configuration rather than this record.

### D10. Task runner

`just` supplies the human-readable entry points. Recipes are thin calls into cargo,
repository tasks, or pinned tools. `just check` runs the full unattended local gate;
`AGENTS.md`'s Quick Reference and `CONTRIBUTING.md` list the commands and their
equivalents. Human-started recipes stay outside the routine gate.

### D11. Git hooks

lefthook runs check-only jobs against staged files: rustfmt, typos, the skills mirror,
and the staged guard. Clippy and tests belong to the full gate and CI. The hook's
repository tasks build into `target/xtask` so they do not wait on a workspace build's
lock. `just verify-hooks` checks installation; agents preserve the normal hooks.

### D12. Repository automation

Shared automation lives in Rust under `xtask/`; the staged guard's rules are in
`xtask/guard/`. Tasks take a faked context, parse structured inputs, isolate child
Git environments, and return named errors with Expected, Actual, and Next lines.
Tests use fakes and temporary directories. A skill may bundle Python or shell
scripts with its own tests.

### D13. Quality gates

Formatting, lints, coverage floors, supply-chain policy, and tool pins are defined
in their owning configurations and recipes. `AGENTS.md` points to them and explains
the sign-off required to change a protection. A failing check is repaired without
suppressing it, lowering a floor, excluding source, or bypassing a hook.

### D14. Harness self-checks

`cargo xtask check-harness` verifies the harness's claims about itself: recipes,
workflows, required contexts, dependency boundaries, labels, skills, documentation,
and the Product skeleton. Each check takes a fixture root and has explicit error
evidence. Values that a check enforces stay in their configuration.

### D15. Testing strategy

Core tests run with fakes inside its coverage floor. Contract suites also exercise
real adapters on macOS and Linux. CLI integration tests run the built binary against
temporary data directories and assert output streams and exit codes. TUI tests draw
into `TestBackend` and feed keys as values. Optional model calls use local HTTP
fixtures and synthetic credentials; routine checks make no paid API calls.

### D16. CI

The workflow and ruleset own the current job names and required checks. Linux runs
workspace linting, core coverage, platform tests, repository checks, xtask coverage,
and supply-chain checks. macOS checks the native adapters and binary. A template-only
job verifies bootstrap on a scratch copy; workflow security and the repository's
security workflows supply the remaining checks. Every required context must run on
every pull request.

### D17. Supply chain and repository security

Actions are SHA-pinned with version comments and least-privilege permissions.
Dependency Review, cargo-deny, OSV-Scanner, CodeQL, Scorecard, zizmor, and the
history secret scan cover their respective inputs. Crate policies apply to the built
macOS and Linux targets. A vulnerability in shipped code is fixed by updating;
exceptions need the reason, expiry, and sign-off the repository policy specifies.
`Cargo.lock` is committed.

### D18. Installation and distribution

A tool is installed from its checkout with
`cargo install --locked --path crates/myapp`. There is no release pipeline.
The changelog and workspace version remain, and release tags are human-authorized
actions. Distribution is revisited in an app's ADR when another audience needs it.

### D19. Bootstrap

`cargo xtask bootstrap` rewrites explicit placeholder sites, renames app crates,
updates the lockfile, removes template-only blocks and `docs/template/`, and resets
the changelog and app version. It prints next steps for Product, the roadmap, setup,
labels, rulesets, and repository security settings. The verification task checks a
temporary copy for leftovers and dangling references.

### D20. Agent harness

`AGENTS.md` is the shared project guide; `CLAUDE.md` imports it. Skills are
authored under `.agents/skills/` and mirrored byte-for-byte to `.claude/skills/`.
Claude-specific rules and agent definitions remain under `.claude/`.
Personal permissions and convenience hooks belong to each owner's uncommitted
configuration; repository gates and instructions govern the shared work.

### D21. Documentation and app decisions

The README provides the tour and rationale, `CONTRIBUTING.md` the working commands,
and `docs/architecture.md` the contracts and layers. App decisions are proposed as
ADRs under `docs/architecture/`, where only the human accepts them. The template's
design and skill notes are removed during bootstrap so an app starts with its own
Product statement and roadmap.

### D22. Never taking over the developer's machine or terminal

No routine check shows a window, takes focus, moves the pointer, raises a system
prompt, or takes over a terminal. An agent never runs `myapp tui`; its rendering and
state are tested without a real terminal. A human runs the real loop when a change
needs that evidence, and starts `just test-local`, `just logs-follow`, and
`just install-cli` deliberately.

## 3. Remaining operational limits

The real terminal loop is verified by a human; keeping it thin limits the gap.
Tests requiring a logged-in session, an OS privacy grant, or the Keychain are ignored
with a stated reason and run only through the human's local test recipe.

The template supplies its security settings and rulesets as a setup procedure;
creating a repository from it still requires its administrator to enable them.
An app fills Product and the roadmap after bootstrap. These operational steps do
not leave an open template design decision.
