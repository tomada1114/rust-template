# App shapes: a window, or a menu-bar agent

The detail behind `starting-an-app`'s "Choose the app shape". Decide before the first
feature, and record the choice as an ADR.

| | Windowed (the starting shape) | Menu-bar agent |
|---|---|---|
| Dock icon, app switcher, ⌘Tab | yes | no |
| App menu, ⌘Q | yes | no: the tray icon is the whole surface |
| Activation policy on a normal launch | `Regular` | `Accessory` |
| At launch | startup shows the main window | the tray icon appears; a window only when the tray opens one |
| Quitting | ⌘Q, the app menu | a Quit item the app provides in the tray menu |
| `tauri` crate feature | none extra | `tray-icon` |
| The launch smoke | unchanged: `Prohibited`, no window, exits 0 | unchanged, and it must add no tray icon either |

Everything else is shared: the crates and their dependency direction, ports and
adapters, IPC, the coverage floor, signing, entitlements, and every gate.

## Windowed: read the shipped files

The template is the windowed reference, so it is not copied here. Read
`src-tauri/src/startup.rs` (`startup_plan`, a pure function deciding the activation
policy, whether to show the window, and whether to exit, tested without a window) and
`run()` in `src-tauri/src/lib.rs`, which applies the plan before any window shows. The
main window is declared with `"visible": false` in `tauri.conf.json`, so nothing flashes
on screen before the plan decides.

## Menu-bar agent

`ActivationPolicy::Accessory` corresponds to AppKit's accessory policy: the app "doesn't
appear in the Dock and doesn't have a menu bar", but may be activated programmatically
or by clicking one of its windows
(https://developer.apple.com/documentation/appkit/nsapplication/activationpolicy-swift.enum/accessory,
checked 2026-09-29). Tauri 2.11 exposes it through `App::set_activation_policy`
(observed in the `tauri` 2.11.6 crate source with
`rg Accessory ~/.cargo/registry/src/*/tauri-2.11.6/src`, 2026-09-29).

The changes, in order:

1. **The startup plan.** Add an `Accessory` variant to `StartupActivation` in
   `src-tauri/src/startup.rs`, with its arm in the `From` conversion to
   `tauri::ActivationPolicy`, and make the normal-launch branch of `startup_plan`
   return it and leave the window hidden. Leave the smoke branch alone: it is what keeps
   a smoke run from taking focus. Update the unit test that pins the normal-launch plan
   to the new expectation. Adding the variant makes every `match` on the enum a compile
   error until it names the new case, which is the point: each place that decides by
   activation policy has to decide again.
2. **The tray icon.** Enable the `tray-icon` feature of `tauri` in
   `src-tauri/Cargo.toml` (`tauri = { workspace = true, features = ["tray-icon"] }`)
   and build the icon with `TrayIconBuilder` during setup
   (https://v2.tauri.app/learn/system-tray/, checked 2026-09-29). A feature that brings
   in new crates is reviewed as a dependency change (`managing-dependencies`). Build the
   icon only when the plan says so: add a field to `StartupPlan` that the smoke branch
   sets to `false`, so a smoke run puts nothing in the menu bar, and its test pins that
   (`AGENTS.md` › "Never taking over the developer's Mac").
3. **Quitting.** An agent has no app menu and no ⌘Q, so without a Quit item in the tray
   menu the only way out of a running copy is `pkill -x myapp`. Add the item with the
   tray.
4. **The window.** Keep it declared hidden and show it from the tray. Decide whether
   closing it hides it or quits the app, and say which in the ADR.
5. **Logging.** An agent that starts and shows nothing looks the same as one that
   crashed, so the `startup complete` log line and `just logs` matter more, not less.

## What can be checked, and by whom

- `just test-platform` and `just logs` stay an agent's evidence; they need no change
  beyond step 2's guard.
- The plan itself is unit-tested in `src-tauri` (`just test-platform`).
- No gate sees the tray icon or its menu. The check is a human running the app and
  `just logs`, with what they saw in the pull request (`running-the-app`).
