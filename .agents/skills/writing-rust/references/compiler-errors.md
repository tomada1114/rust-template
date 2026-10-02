# Compiler errors and clippy findings, with the fix this codebase prefers

Each entry names the error, what it means in plain words, and the fix that fits this
repository. The error index page explains the language rule; this file only says which
of the possible fixes to pick here, and why.

## Borrowing and moving

**E0382, use of a moved value** (https://doc.rust-lang.org/error_codes/E0382.html).
A value was handed to something that took ownership (a function taking `T`, a `move`
closure, `into_…`), then used again.

- Small value (an id, a short `String`, a view struct): `.clone()` it before the first
  use. Cheap, and no lifetime to follow.
- A shared port or service: clone the `Arc` (`Arc::clone(&service)`), which copies a
  pointer, not the service.
- The function did not need ownership: change its parameter to `&T` or `&str`.

**E0499, two mutable borrows at once** (https://doc.rust-lang.org/error_codes/E0499.html),
and **E0502, a mutable borrow while an immutable one is alive**
(https://doc.rust-lang.org/error_codes/E0502.html). Something reads through one
reference while another part of the code changes the same value.

- End the first borrow before the second begins: copy what you need out of it into a
  local (`let value = counter.value();`), then mutate.
- Split the work into two statements instead of one expression that borrows twice.
- Prefer a method that takes `self` and returns a new value over one that mutates
  through `&mut self`; most of these conflicts then disappear
  (`designing-core-logic` › "State transitions and use cases").

**E0505, moved while still borrowed** (https://doc.rust-lang.org/error_codes/E0505.html).
A reference is still in use when the value it points at is moved away. Finish using the
reference first, or clone the part you need before the move.

**E0597, borrowed value does not live long enough**
(https://doc.rust-lang.org/error_codes/E0597.html). A reference outlives the value it
points at, typically a reference to a local stored in something that lives longer.

- Store the owned value instead of the reference (a `String` field, not `&str`).
- In a test, keep the owner alive in a binding for the whole test: a
  `tempfile::TempDir` deletes its directory when it is dropped, so
  `let dir = tempfile::tempdir().unwrap();` stays in scope while `dir.path()` is used.
  `crates/myapp-platform/tests/contracts.rs` pushes each `TempDir` into a `Vec` for the
  same reason.
- Never add a lifetime parameter to a struct to get past this; see `SKILL.md` ›
  "Ownership and borrowing".

## Types and traits

**E0277, a trait bound is not satisfied**
(https://doc.rust-lang.org/error_codes/E0277.html). A type is used where a trait it does
not implement is required. The common cases here:

- `… cannot be shared between threads safely` / `… cannot be sent between threads
  safely`: something inside is not `Sync` or `Send`. Replace `Rc` with `Arc` and
  `RefCell`/`Cell` with `Mutex`; a port implementation must be `Send + Sync`.
- `` `?` couldn't convert the error to `…` ``: add `impl From<Inner> for Outer` beside
  the outer error (the `designing-errors` skill says whether the inner error should be
  wrapped or mapped to a kind), or map it explicitly with `.map_err(…)`.
- `` `…` doesn't implement `Debug` `` or `` binary operation `==` cannot be applied ``
  in a test: derive `Debug` and `PartialEq` on the type.
- ``the trait bound `…: Serialize` is not satisfied`` when writing a value as JSON (a
  stored file, a `--json` output): derive `serde::Serialize` on the core type, with
  `#[serde(rename_all = "camelCase")]`.

**E0308, mismatched types** (https://doc.rust-lang.org/error_codes/E0308.html). The type
written and the type produced differ. Two cases worth recognising here:

- A function ends with `Ok(value);` — the trailing semicolon turns the result into
  `()`. Remove it.
- The message names the same type through two paths (for example
  `myapp_core::Counter` and `crate::Counter`), or an E0277 says a fake does not
  implement a core trait it plainly implements: an inline `#[cfg(test)]` module in core
  used a fake from `myapp-test-support`, which links a second copy of core. Move that
  test to `crates/myapp-core/tests/` (the `placing-tests` skill).

**E0004, non-exhaustive patterns** (https://doc.rust-lang.org/error_codes/E0004.html).
A `match` does not cover a variant, usually because one was added a moment ago. Add an
arm that decides what the new variant means at this place. Do not add `_ =>`: in core
clippy's `wildcard_enum_match_arm` rejects a `_` that stands for a variant the match
could name, on any enum, a foreign one included, and anywhere else it hides the next
variant the same way. The exception is a `#[non_exhaustive]` enum from another crate,
which rustc never lets a match cover without `_`: outside core end that match with
`_ =>`; in core name every variant before the `_`, or, for an enum with unstable
variants no match can name (`std::io::ErrorKind`, E0658), test the value with `==` or
`matches!` instead.

## clippy findings met most here

`just lint` runs `cargo xtask clippy-guard cargo clippy --workspace --all-targets
--locked -- -D warnings` with `all` and `pedantic` on, so every warning fails, and the
guard also fails on a `clippy.toml` entry clippy cannot resolve or read
(`ERR_CLIPPY_BAN_UNRESOLVED`, `ERR_CLIPPY_CONFIG_INVALID`). Each finding names its lint;
look it up in the lint list (https://rust-lang.github.io/rust-clippy/master/index.html).

| Lint | What it wants | The fix here |
|---|---|---|
| `unwrap_used`, `expect_used` | no panic on `None` or `Err` in non-test code | `?`, `ok_or`, `let … else`, or a fallback that is a correct answer. In a helper function under `tests/` that is not itself a `#[test]`, clippy does not count the code as test code (`allow-unwrap-in-tests` covers test functions and `#[cfg(test)]`, https://doc.rust-lang.org/clippy/lint_configuration.html#allow-unwrap-in-tests, checked 2026-09-29), so match and panic with context instead, as `output` in `crates/myapp/tests/cli.rs` does |
| `disallowed_methods`, `disallowed_macros`, `disallowed_types` | core does not read the clock, the environment, or the file system, print, sleep, or start a process (`crates/myapp-core/clippy.toml`) | take the value as an argument or through a port (`designing-core-logic`); never move the call into core behind an `#[allow]` |
| `wildcard_enum_match_arm` | no `_` in core that stands for a nameable variant, on any enum | name every variant; group with `A \| B =>`; a `#[non_exhaustive]` foreign enum names them all before its `_`, or is tested with `==` or `matches!` |
| `missing_errors_doc`, `missing_panics_doc` | a `# Errors` / `# Panics` section on a public function that can fail or panic | write the section: which variant, and when |
| `must_use_candidate` | `#[must_use]` on a pure public function whose result would be a bug to ignore | add `#[must_use]`, as core's constructors and getters have |
| `needless_pass_by_value` | a parameter taken by value but only read | take `&T` (or `&str`, `&[T]`) |
| `cast_possible_truncation`, `cast_sign_loss`, `cast_possible_wrap` | an `as` cast that can lose data | `i64::try_from(x)` with a deliberate fallback, as `SystemClock::now` does |
| `clone_on_copy` | `.clone()` on a `Copy` value | drop the `.clone()` |
| `redundant_closure_for_method_calls` | `.map(\|s\| s.trim())` where a method path works | `.map(str::trim)` |
| `doc_markdown` | an identifier in a `///` comment without backticks | wrap it in backticks |
| `missing_docs` (a rustc lint) | a `///` on every public item | say why it exists and what it promises |

If a finding still looks wrong after reading its page, leave the code as it is, say so
in the pull request, and let a human decide whether the lint's configuration changes
(`changing-gates`). An `#[allow]` or `#[expect]` added to pass the check is weakening a
gate.
