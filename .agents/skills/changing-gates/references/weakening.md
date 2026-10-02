# What weakening a gate means here, in Rust and in a skill's scripts

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
| `.unwrap()` / `.expect()` outside tests, with an `allow` for `unwrap_used` | A panic where an error belongs. In a subcommand a panic is a crash with no wording and no exit code of ours; in the TUI, with `panic = "abort"` in the release profile, it also skips the code that restores the terminal. | Return a `Result` and propagate with `?` into the module's error enum (`designing-errors`). |
| `unsafe`, or lifting `unsafe_code = "forbid"` | `forbid` is the strictest lint level: nothing below it can `allow` it back. `unsafe` switches off the borrow checker's guarantees for a block, and is never the fix for a borrow error. | Restructure the borrow: end the first borrow before the next, or clone the small value (`writing-rust`). Real FFI in `myapp-platform` goes through an ADR (`integrating-system-apis`). |
| `#[ignore]` on a failing test | nextest skips it and reports it as ignored, so the suite goes green with the failure still there. | Fix the code, or the test if its oracle is wrong. `#[ignore = "local machine: …"]` is reserved for a test that needs a GUI session, a TCC grant, the Keychain, or a real terminal. |
| Deleting or loosening an assertion | The test passes because it no longer checks the behaviour. | Fix the code; an assertion changes only when the specified behaviour did. |
| Lowering `--fail-under-lines` / `--fail-under-functions` in the `test-core` or `test-xtask` recipe | The core floor is 80/80, the one number that says decisions are tested; xtask's floors say the same of the automation every gate runs on. | Add tests; move an untestable decision out of an adapter or the binary into core. |
| Removing a ban from `crates/myapp-core/clippy.toml` | Lets core print, read the clock, touch the file system, or spawn a process directly, bypassing its ports. | Reach the outside world through a port (`designing-core-logic`). |
| An entry in `deny.toml`'s `ignore`, `exceptions`, or `skip`, or in `osv-scanner.toml` | Stops `cargo deny` or OSV-Scanner reporting an advisory or a licence. | Update the crate. Only an advisory with no fixed release may be ignored, with a reason, a 90-day expiry, and a tracking issue. |
| Changing `deny.toml`'s `[graph] targets` or its `unmaintained` scope | Changes what counts as shipped, and so which advisories count. | A change to what ships is an ADR (a new target platform, or dropping one). |

## A skill's bundled scripts

| Construct | What it does | Do instead |
|---|---|---|
| `skip` on a failing test (`unittest.skip`, `self.skipTest`) in a skill's `scripts/tests/` | `just test-scripts` reports it as skipped and goes green with the failure still there. | Fix the script, or the test if its oracle is wrong. |
| `# shellcheck disable=…` to get `just test-scripts` green | Silences that finding for the next command. | Fix the script. A directive that stays carries its reason on the same line, as the one in `shipping-issues`' `worktree_setup.sh` does. |
| Removing a suite from the `test-scripts` recipe | That skill's scripts stop being tested at all, with nothing reporting it. | Fix the suite. |

## Everywhere

| Construct | Why it is weakening |
|---|---|
| Adding a path to an ignore list (`typos.toml`, `deny.toml`, `osv-scanner.toml`) | That path leaves the gate for good, and nothing reports it again. The one deliberate entry in `typos.toml` beyond build output and the lockfile is the generated `.claude/skills/` mirror, and a harness check keeps it there and keeps `.agents/skills/` out. |
| `continue-on-error` on a CI job or step | The job reports success whatever the step did. A step that must not run without a secret is skipped by an `if:` on a step-level condition instead. |
| `git commit --no-verify` | Skips every pre-commit job, the staged secret guard included, which no CI job reruns. A personal permission file may deny its usual spellings on one host; the rule binds every author. |
| Widening a workflow's `permissions:` | A compromised step can do more with the token. |
| Removing a required context from `.github/rulesets/main.json` | A pull request can merge without that check. |
| An entry in a harness check's `EXCEPTIONS`, removing a check from `CHECKS`, or narrowing what one reads | The claim stops being checked for that case, or at all, while `just check-harness` stays green. An exception is a human's decision with its reason in the entry. |
| Re-spelling a denied command (`git -C . …`, `bash -c '…'`, a bundled short flag) | Routes around a human's or a config's refusal. Stop and ask. |

## When the gate itself looks wrong

Say so in the pull request or an issue, with the finding and why the rule does not fit,
and let a human decide. A gate that is wrong for the whole codebase is changed in its
config, in a pull request of its own, never suppressed at the one site that tripped it.
The reverse also holds: when a human agrees that one site, and only that one, needs the
exception, prefer an attribute on that item with its reason
(`#[expect(…, reason = "…")]`) to relaxing the lint in `[workspace.lints]`, which
widens the gate for every future file.
