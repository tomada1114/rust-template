---
paths:
  - "crates/*/tests/**"
  - "crates/myapp-test-support/**"
---

Only what no skill states: which skill owns which question about a test, and the rule
below. The skills hold everything else, and nothing here restates them.

| Question | Load |
|---|---|
| Where the test goes, which recipe runs it, which coverage floor measures it | `placing-tests` |
| What it asserts: the oracle, fakes and the contract suite, clocks, the built binary, `TestBackend` | `writing-tests` |
| The order of work: the failing test first | `tdd` |

- A red test is fixed in the code. An `#[ignore]`, a `skip`, or a loosened assertion to
  get it out of the way is weakening a gate (`AGENTS.md` › "Security and human
  approval"), and no test opens a window, takes focus, raises a prompt, or takes over a
  terminal (`AGENTS.md` › "Never taking over the machine")
