//! ipc-names fixture: the passing root's commands and events.

pub const COUNTER_CHANGED: &str = "counter-changed";
pub(crate) const SETTINGS_CHANGED: &'static str = "settings-changed";
const HELP_URL: &str = "https://example.com/help"; // a string holding `//` is not a comment

fn announce<'a, R: Runtime>(app: &'a AppHandle<R>, view: &View) {
    if let Err(error) = app.emit(COUNTER_CHANGED, view) {
        tracing::warn!(%error, "not delivered");
    }
    let _ = app.emit_filter(SETTINGS_CHANGED, settings(view, HELP_URL), |target| true);
}
