//! `myapp tui`: the terminal around the counter screen. Core decides what a key does
//! (`myapp_core::CounterScreen`); this module only enters and leaves the terminal, reads
//! its events, translates each into a `ScreenKey`, and draws (`view`).
//!
//! No test runs this loop: it needs a real terminal, which no check may take over. The
//! human's check is running `myapp tui` in one.

mod view;

use std::io;
use std::panic;

use myapp_core::{CounterScreen, CounterService, ScreenAction, ScreenKey};
use ratatui::DefaultTerminal;
use ratatui::Terminal;
use ratatui::backend::CrosstermBackend;
use ratatui::crossterm::cursor::Show;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::crossterm::execute;
use ratatui::crossterm::terminal::{
    EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode,
};

/// Run the screen until the user quits. The terminal is restored on every way out: here
/// after a normal exit or an error, and by the panic hook on a panic (which, with the
/// release profile's `panic = "abort"`, never unwinds back here).
///
/// # Errors
/// The terminal could not be entered, read, drawn to, or restored.
pub fn run(service: &CounterService) -> io::Result<()> {
    install_panic_hook();
    let result = enter().and_then(|mut terminal| event_loop(&mut terminal, service));
    let restored = leave();
    result.and(restored)
}

fn enter() -> io::Result<DefaultTerminal> {
    enable_raw_mode()?;
    execute!(io::stdout(), EnterAlternateScreen)?;
    Terminal::new(CrosstermBackend::new(io::stdout()))
}

/// Leave raw mode and the alternate screen, and show the cursor (a draw hides it). Each
/// step runs even when the one before failed, and it is harmless when nothing was entered.
fn leave() -> io::Result<()> {
    let raw_mode = disable_raw_mode();
    let screen = execute!(io::stdout(), LeaveAlternateScreen, Show);
    raw_mode.and(screen)
}

/// Restore the terminal before the panic message prints, so it lands on a usable screen.
fn install_panic_hook() {
    let previous = panic::take_hook();
    panic::set_hook(Box::new(move |info| {
        // Already panicking: a failed restore has nowhere better to be reported, and the
        // message the previous hook prints matters more.
        let _ = leave();
        previous(info);
    }));
}

fn event_loop(terminal: &mut DefaultTerminal, service: &CounterService) -> io::Result<()> {
    let mut screen = CounterScreen::load(service);
    tracing::info!(failed = screen.error().is_some(), "tui opened");
    while !screen.is_finished() {
        terminal.draw(|frame| view::draw(frame, &screen))?;
        // A resize or any other event just redraws on the next pass.
        if let Event::Key(key) = event::read()?
            && let Some(action) = screen_key(key).and_then(ScreenAction::for_key)
        {
            screen = screen.update(action, service);
            log_action(action, &screen);
        }
    }
    Ok(())
}

/// The terminal's key event as the screen sees it; `None` for a release or repeat event,
/// a control chord other than Control-C, and keys the screen has no name for.
fn screen_key(event: KeyEvent) -> Option<ScreenKey> {
    if event.kind != KeyEventKind::Press {
        return None;
    }
    if event.modifiers.contains(KeyModifiers::CONTROL) {
        return (event.code == KeyCode::Char('c')).then_some(ScreenKey::Interrupt);
    }
    if let KeyCode::Char(character) = event.code {
        return Some(ScreenKey::Char(character));
    }
    [
        (KeyCode::Up, ScreenKey::Up),
        (KeyCode::Down, ScreenKey::Down),
        (KeyCode::Esc, ScreenKey::Esc),
    ]
    .into_iter()
    .find_map(|(code, key)| (event.code == code).then_some(key))
}

fn log_action(action: ScreenAction, screen: &CounterScreen) {
    match action {
        ScreenAction::Quit => tracing::info!("tui closed"),
        ScreenAction::Increment | ScreenAction::Decrement | ScreenAction::Reset => {
            if let Some(error) = screen.error() {
                tracing::warn!(?action, %error, "tui action failed");
            } else {
                let value = screen.view().map(|view| view.value);
                tracing::info!(?action, value, "tui action succeeded");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(code: KeyCode, modifiers: KeyModifiers) -> KeyEvent {
        KeyEvent::new_with_kind(code, modifiers, KeyEventKind::Press)
    }

    #[test]
    fn a_typed_character_is_that_character_shifted_or_not() {
        assert_eq!(
            screen_key(press(KeyCode::Char('q'), KeyModifiers::NONE)),
            Some(ScreenKey::Char('q'))
        );
        assert_eq!(
            screen_key(press(KeyCode::Char('+'), KeyModifiers::SHIFT)),
            Some(ScreenKey::Char('+'))
        );
    }

    #[test]
    fn the_arrows_and_escape_have_their_own_keys() {
        for (code, key) in [
            (KeyCode::Up, ScreenKey::Up),
            (KeyCode::Down, ScreenKey::Down),
            (KeyCode::Esc, ScreenKey::Esc),
        ] {
            assert_eq!(screen_key(press(code, KeyModifiers::NONE)), Some(key));
        }
    }

    #[test]
    fn control_c_is_an_interrupt_and_other_control_chords_are_ignored() {
        assert_eq!(
            screen_key(press(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(ScreenKey::Interrupt)
        );
        assert_eq!(
            screen_key(press(KeyCode::Char('r'), KeyModifiers::CONTROL)),
            None
        );
    }

    #[test]
    fn keys_the_screen_has_no_name_for_are_ignored() {
        for code in [KeyCode::Enter, KeyCode::Left, KeyCode::F(1), KeyCode::Tab] {
            assert_eq!(
                screen_key(press(code, KeyModifiers::NONE)),
                None,
                "{code:?}"
            );
        }
    }

    #[test]
    fn only_a_press_counts_not_a_release_or_a_repeat() {
        for kind in [KeyEventKind::Release, KeyEventKind::Repeat] {
            let event = KeyEvent::new_with_kind(KeyCode::Char('+'), KeyModifiers::NONE, kind);
            assert_eq!(screen_key(event), None, "{kind:?}");
        }
    }
}
