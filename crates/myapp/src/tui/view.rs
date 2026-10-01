//! Drawing the counter screen. Every word comes from here or from `wording`, the help
//! line from core's key table, and no color carries meaning: the error line says
//! "Error:" and is bold, on the terminal's own colors.

use myapp_core::{CounterScreen, ScreenAction, ScreenKey};
use ratatui::Frame;
use ratatui::layout::{Constraint, Layout};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::Block;

use crate::wording;

const TITLE: &str = "Counter";
const VALUE_LABEL: &str = "Value: ";
/// Shown in place of the value while the counter file cannot be read.
const UNKNOWN_VALUE: &str = "unknown";
const ERROR_LABEL: &str = "Error: ";
const ERROR_STYLE: Style = Style::new().add_modifier(Modifier::BOLD);

/// Draw `screen` over the whole frame: the value, the last error, and the keys.
pub fn draw(frame: &mut Frame, screen: &CounterScreen) {
    let block = Block::bordered().title(TITLE);
    let inner = block.inner(frame.area());
    frame.render_widget(block, frame.area());
    let [value_area, error_area, _, help_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Fill(1),
        Constraint::Length(1),
    ])
    .areas(inner);

    let value = screen
        .view()
        .map_or_else(|| UNKNOWN_VALUE.to_owned(), |view| view.value.to_string());
    frame.render_widget(Line::raw(format!("{VALUE_LABEL}{value}")), value_area);
    if let Some(error) = screen.error() {
        let text = format!("{ERROR_LABEL}{}", wording::counter_error(error));
        frame.render_widget(Line::from(Span::styled(text, ERROR_STYLE)), error_area);
    }
    frame.render_widget(Line::raw(help()), help_area);
}

/// Every action with its keys, in core's order: `+/Up increment  -/Down decrement …`.
fn help() -> String {
    ScreenAction::ALL
        .into_iter()
        .map(|action| {
            let keys: Vec<String> = action.keys().iter().map(|key| key_name(*key)).collect();
            format!("{} {}", keys.join("/"), action_name(action))
        })
        .collect::<Vec<_>>()
        .join("  ")
}

fn key_name(key: ScreenKey) -> String {
    match key {
        ScreenKey::Char(character) => character.to_string(),
        ScreenKey::Up => "Up".to_owned(),
        ScreenKey::Down => "Down".to_owned(),
        ScreenKey::Esc => "Esc".to_owned(),
        ScreenKey::Interrupt => "Ctrl+C".to_owned(),
    }
}

const fn action_name(action: ScreenAction) -> &'static str {
    match action {
        ScreenAction::Increment => "increment",
        ScreenAction::Decrement => "decrement",
        ScreenAction::Reset => "reset",
        ScreenAction::Quit => "quit",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use myapp_core::{CounterService, StorageErrorKind, StoredCounter, Tuning};
    use myapp_test_support::{FailingCounterStore, FixedClock, InMemoryCounterStore};
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::buffer::Buffer;
    use ratatui::layout::Rect;

    use super::*;

    fn service_holding(value: i64) -> CounterService {
        let store = InMemoryCounterStore::holding(StoredCounter {
            value,
            last_changed_at: None,
        });
        CounterService::new(
            Arc::new(store),
            Arc::new(FixedClock::default()),
            Tuning::default(),
        )
    }

    fn drawn(screen: &CounterScreen, width: u16, height: u16) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
        terminal.draw(|frame| draw(frame, screen)).unwrap();
        terminal
    }

    /// The bold run of an error line written at row `y`.
    fn bold(expected: &mut Buffer, y: u16, text: &str) {
        let width = u16::try_from(text.chars().count()).unwrap();
        expected.set_style(Rect::new(1, y, width, 1), ERROR_STYLE);
    }

    #[test]
    fn the_counter_shows_its_value_and_every_key() {
        let screen = CounterScreen::load(&service_holding(3));
        drawn(&screen, 64, 6).backend().assert_buffer_lines([
            "┌Counter───────────────────────────────────────────────────────┐",
            "│Value: 3                                                      │",
            "│                                                              │",
            "│                                                              │",
            "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
            "└──────────────────────────────────────────────────────────────┘",
        ]);
    }

    #[test]
    fn a_change_at_the_bound_shows_the_error_in_bold_under_the_value() {
        let service = service_holding(99);
        let screen = CounterScreen::load(&service).update(ScreenAction::Increment, &service);
        let mut expected = Buffer::with_lines([
            "┌Counter───────────────────────────────────────────────────────┐",
            "│Value: 99                                                     │",
            "│Error: the counter is already at its maximum                  │",
            "│                                                              │",
            "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
            "└──────────────────────────────────────────────────────────────┘",
        ]);
        bold(
            &mut expected,
            2,
            "Error: the counter is already at its maximum",
        );
        drawn(&screen, 64, 6).backend().assert_buffer(&expected);
    }

    #[test]
    fn an_unreadable_counter_file_shows_no_value_and_why() {
        let service = CounterService::new(
            Arc::new(FailingCounterStore::load_fails(StorageErrorKind::Corrupt)),
            Arc::new(FixedClock::default()),
            Tuning::default(),
        );
        let screen = CounterScreen::load(&service);
        let mut expected = Buffer::with_lines([
            "┌Counter───────────────────────────────────────────────────────┐",
            "│Value: unknown                                                │",
            "│Error: the counter file holds data this version cannot read   │",
            "│                                                              │",
            "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
            "└──────────────────────────────────────────────────────────────┘",
        ]);
        bold(
            &mut expected,
            2,
            "Error: the counter file holds data this version cannot read",
        );
        drawn(&screen, 64, 6).backend().assert_buffer(&expected);
    }

    #[test]
    fn a_failed_save_shows_the_storage_error_and_keeps_the_value() {
        let service = CounterService::new(
            Arc::new(FailingCounterStore::save_fails(
                StorageErrorKind::Unavailable,
                Some(StoredCounter {
                    value: 7,
                    last_changed_at: None,
                }),
            )),
            Arc::new(FixedClock::default()),
            Tuning::default(),
        );
        let screen = CounterScreen::load(&service).update(ScreenAction::Reset, &service);
        let mut expected = Buffer::with_lines([
            "┌Counter───────────────────────────────────────────────────────┐",
            "│Value: 7                                                      │",
            "│Error: the counter file could not be read or written          │",
            "│                                                              │",
            "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
            "└──────────────────────────────────────────────────────────────┘",
        ]);
        bold(
            &mut expected,
            2,
            "Error: the counter file could not be read or written",
        );
        drawn(&screen, 64, 6).backend().assert_buffer(&expected);
    }

    #[test]
    fn the_next_successful_change_clears_the_error_line() {
        let service = service_holding(99);
        let screen = CounterScreen::load(&service)
            .update(ScreenAction::Increment, &service)
            .update(ScreenAction::Decrement, &service);
        drawn(&screen, 64, 6).backend().assert_buffer_lines([
            "┌Counter───────────────────────────────────────────────────────┐",
            "│Value: 98                                                     │",
            "│                                                              │",
            "│                                                              │",
            "│+/Up increment  -/Down decrement  r reset  q/Esc/Ctrl+C quit  │",
            "└──────────────────────────────────────────────────────────────┘",
        ]);
    }

    #[test]
    fn a_terminal_too_small_for_the_screen_clips_it_without_panicking() {
        let screen = CounterScreen::load(&service_holding(3));
        drawn(&screen, 12, 3).backend().assert_buffer_lines([
            "┌Counter───┐",
            "│Value: 3  │",
            "└──────────┘",
        ]);
    }
}
