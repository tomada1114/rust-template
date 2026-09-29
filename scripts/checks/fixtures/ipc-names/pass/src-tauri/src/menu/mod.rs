//! ipc-names fixture: an emit in a submodule counts too.

pub fn on_reset<R: Runtime>(app: &AppHandle<R>, view: &View) {
    let _ = app.emit(crate::commands::COUNTER_CHANGED, view);
}
