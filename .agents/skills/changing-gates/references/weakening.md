# What weakening a gate means here, in Rust and TypeScript

The detail behind `changing-gates`. `AGENTS.md` › "Security and human approval" is the
rule and its list; this page says, for each item, what it does, why no check catches it,
and what to do instead. Every item below is weakening **when used to make a failing
check pass**; the same construct written with a human's sign-off and a stated reason is
a reviewed decision, not a workaround.

Most of these are invisible to every gate by construction: a suppression is the thing
that tells the gate to stop looking. Review is the only layer that sees them, which is
why the pull request template asks about them and why an agent never adds one to get
green.

## Rust

| Construct | What it does | Do instead |
|---|---|---|
| `#[allow(clippy::…)]` or `#[allow(…)]` on a rustc lint | Silences that lint for the item (or, as `#![allow]`, the whole crate). `just lint` runs clippy with `-D warnings`, so every warning is an error; an `allow` turns the error off without fixing its cause. | Fix what the lint describes. The clippy lint list explains each lint and its usual fix (https://rust-lang.github.io/rust-clippy/master/index.html). A pedantic lint that is wrong for the whole codebase is a `[workspace.lints]` change, argued in its own pull request. |
| `#[expect(…)]` | Like `allow`, but warns if the lint stops firing. It documents a suppression better; it is still one. | The same as `allow`. |
| `.unwrap()` / `.expect()` outside tests, with an `allow` for `unwrap_used` | A panic where an error belongs. In a command, a panic is a crash the UI cannot map to a code. | Return a `Result` and propagate with `?` into the module's error enum (`designing-errors`). |
| `unsafe`, or lifting `unsafe_code = "forbid"` | `forbid` is the strictest lint level: nothing below it can `allow` it back. `unsafe` switches off the borrow checker's guarantees for a block, and is never the fix for a borrow error. | Restructure the borrow: end the first borrow before the next, or clone the small value (`writing-rust`). Real FFI in `myapp-platform` goes through an ADR (`integrating-system-apis`). |
| `#[ignore]` on a failing test | nextest skips it and reports it as ignored, so the suite goes green with the failure still there. | Fix the code, or the test if its oracle is wrong. `#[ignore = "local machine: …"]` is reserved for a test that needs a GUI session, a TCC grant, or the Keychain. |
| Deleting or loosening an assertion | The test passes because it no longer checks the behaviour. | Fix the code; an assertion changes only when the specified behaviour did. |
| Lowering `--fail-under-lines` / `--fail-under-functions` in the `test-core` recipe | The core floor is 80/80, the one number that says decisions are tested. | Add tests; move an untestable decision out of an adapter into core. |
| Removing a ban from `crates/myapp-core/clippy.toml` | Lets core print, read the clock, touch the file system, or spawn a process directly, bypassing its ports. | Reach the outside world through a port (`designing-core-logic`). |
| An entry in `deny.toml`'s `ignore`, `exceptions`, or `skip`, or in `osv-scanner.toml` | Stops `cargo deny` or OSV-Scanner reporting an advisory or a licence. | Update the crate. Only an advisory with no fixed release may be ignored, with a reason, a 90-day expiry, and a tracking issue. |
| Changing `deny.toml`'s `[graph] targets` or its `unmaintained` scope | Changes what counts as shipped, and so which advisories count. | A change to what ships is an ADR (a universal build adds a target). |

## TypeScript

| Construct | What it does | Do instead |
|---|---|---|
| `// eslint-disable…` in any form | Silences ESLint for a line, a block, or a file. `reportUnusedDisableDirectives: "error"` catches only a directive that suppresses nothing. | Fix the finding. |
| `@ts-ignore` | Silences the next line's type error, and any later one on that line. `ban-ts-comment` rejects it. | Narrow the value (`writing-typescript`). |
| `@ts-expect-error` | Allowed with a description, and fails once the error goes away; used to silence tsc it is still a suppression. | The same. |
| A non-null `!` | Tells tsc a value cannot be `null` or `undefined` without checking. | Check it, or change the type so it cannot be absent. |
| An `as` cast to silence tsc | Asserts a type the value was never checked to have. | Narrow with `typeof`, `in`, or a type guard; `satisfies` for a literal. |
| `.skip`, `.todo`, `.only` on a failing Vitest test | Removes it from the run (`allowOnly: false` fails `.only`). | Fix the code or the oracle. |
| Adding to coverage `exclude`, or lowering `thresholds` in `vitest.config.ts` | An untested file stops counting, or the bar drops. | Add tests. |
| Removing a strict option from a `tsconfig*.json`, or an ESLint rule or preset | Every file gets weaker checking, not only the one that failed. | Fix the file that failed. |

## Everywhere

| Construct | Why it is weakening |
|---|---|
| Adding a path to an ignore list (`typos.toml`, `.prettierignore`, ESLint's `globalIgnores`, `deny.toml`, `osv-scanner.toml`) | That path leaves the gate for good, and nothing reports it again. The one deliberate entry shared by the lists is the generated `.claude/skills/` mirror; a harness check keeps `.prettierignore`, `typos.toml`, and Vitest's lists agreeing on it (ESLint's `globalIgnores` is no longer compared). |
| `continue-on-error` on a CI job or step | The job reports success whatever the step did. A step that must not run without a secret is skipped by an `if:` on a step-level condition instead. |
| `git commit --no-verify` | Skips every pre-commit job, the staged secret guard included, which no CI job reruns. A personal permission file may deny its usual spellings on one host; the rule binds every author. |
| Widening a workflow's `permissions:` | A compromised step can do more with the token. |
| Removing a required context from `.github/rulesets/main.json` | A pull request can merge without that check. |
| Re-spelling a denied command (`git -C . …`, `bash -c '…'`, a bundled short flag) | Routes around a human's or a config's refusal. Stop and ask. |

## When the gate itself looks wrong

Say so in the pull request or an issue, with the finding and why the rule does not fit,
and let a human decide. A gate that is wrong for the whole codebase is changed in its
config, in a pull request of its own, never suppressed at the one site that tripped it.
The reverse also holds: when a human agrees that one site, and only that one, needs the
exception, prefer an attribute on that item with its reason
(`#[expect(…, reason = "…")]`) to relaxing the lint in `[workspace.lints]`, which
widens the gate for every future file.
