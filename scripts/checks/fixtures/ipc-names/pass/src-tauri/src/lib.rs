//! ipc-names fixture: the passing root. A comment naming generate_handler![ignored]
//! or app.emit("commented-out", 1) must not count.

mod commands;
mod menu;

/// Were raw strings read as plain ones, the lone quote and the `/*` would hide the rest.
const PATTERN: &str = r#"a lone " quote /* not a comment"#;

pub fn with_commands<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        commands::get_counter,
        commands::increment,
        log_from_ui, // a trailing comment
    ])
}

/* A block comment: app.emit("block-commented", 1) */
fn on_menu<R: Runtime>(app: &AppHandle<R>, view: &View) {
    let _ = app.emit_to("main", commands::COUNTER_CHANGED, (view, 'x', '\''));
}
