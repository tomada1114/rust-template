//! What startup does differently in smoke mode — visibility and lifetime only, never
//! behaviour (design D22). Pure functions, so they are tested without a window.

use std::ffi::OsStr;

/// Set to `1` to start in smoke mode. The bootstrap renames it with the app.
pub const SMOKE_ENV: &str = "MYAPP_SMOKE";

/// Whether the value of [`SMOKE_ENV`] asks for smoke mode: exactly `1`, so `0`, an empty
/// value, or an unset variable all start the app normally.
#[must_use]
pub fn smoke_requested(value: Option<&OsStr>) -> bool {
    value.is_some_and(|value| value == "1")
}

/// How the app presents itself to macOS. Mirrors `tauri::ActivationPolicy`, which only
/// exists on macOS, so the plan stays testable everywhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartupActivation {
    /// A normal app: a Dock icon, and it may take focus.
    Regular,
    /// No Dock icon, and it may never become the active app.
    Prohibited,
}

#[cfg(target_os = "macos")]
impl From<StartupActivation> for tauri::ActivationPolicy {
    fn from(activation: StartupActivation) -> Self {
        match activation {
            StartupActivation::Regular => Self::Regular,
            StartupActivation::Prohibited => Self::Prohibited,
        }
    }
}

/// The decisions startup makes before any window exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StartupPlan {
    /// Show the main window (created hidden by `tauri.conf.json`).
    pub show_window: bool,
    /// The activation policy, set on the built app before its event loop starts, so
    /// macOS applies it at launch — before any window exists or the app can activate.
    pub activation_policy: StartupActivation,
    /// Exit 0 once startup completes.
    pub exit_after_startup: bool,
}

/// The plan for a normal launch or a smoke run.
#[must_use]
pub const fn startup_plan(smoke: bool) -> StartupPlan {
    if smoke {
        StartupPlan {
            show_window: false,
            activation_policy: StartupActivation::Prohibited,
            exit_after_startup: true,
        }
    } else {
        StartupPlan {
            show_window: true,
            activation_policy: StartupActivation::Regular,
            exit_after_startup: false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_normal_launch_shows_the_window_and_keeps_running() {
        assert_eq!(
            startup_plan(false),
            StartupPlan {
                show_window: true,
                activation_policy: StartupActivation::Regular,
                exit_after_startup: false,
            }
        );
    }

    #[test]
    fn a_smoke_run_stays_invisible_and_exits() {
        assert_eq!(
            startup_plan(true),
            StartupPlan {
                show_window: false,
                activation_policy: StartupActivation::Prohibited,
                exit_after_startup: true,
            }
        );
    }

    #[test]
    fn only_the_value_1_requests_smoke_mode() {
        let cases: [(Option<&str>, bool); 6] = [
            (Some("1"), true),
            (Some("0"), false),
            (Some(""), false),
            (Some("true"), false),
            (Some(" 1"), false),
            (None, false),
        ];
        for (value, expected) in cases {
            assert_eq!(
                smoke_requested(value.map(OsStr::new)),
                expected,
                "{SMOKE_ENV}={value:?}"
            );
        }
    }

    #[test]
    fn the_smoke_env_var_is_named_after_the_app() {
        assert_eq!(SMOKE_ENV, "MYAPP_SMOKE");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn activation_maps_onto_tauris_policy() {
        assert!(matches!(
            tauri::ActivationPolicy::from(StartupActivation::Regular),
            tauri::ActivationPolicy::Regular
        ));
        assert!(matches!(
            tauri::ActivationPolicy::from(StartupActivation::Prohibited),
            tauri::ActivationPolicy::Prohibited
        ));
    }
}
