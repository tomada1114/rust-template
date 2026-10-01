//! The full-screen counter view as a value: what it shows, and what a key does to it.
//!
//! No terminal type appears here. The binary translates its terminal's key events into
//! [`ScreenKey`], turns one into a [`ScreenAction`] with [`ScreenAction::for_key`], hands
//! it to [`CounterScreen::update`], and draws the [`CounterScreen`] it gets back, so every
//! decision the screen makes is tested here without a terminal.

use super::{CounterError, CounterService, CounterView};

/// A key press, as the screen sees it. The binary builds one from its terminal library's
/// event, so this crate never names that library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenKey {
    /// A printable character, as typed (`'+'`, `'q'`).
    Char(char),
    /// The up arrow.
    Up,
    /// The down arrow.
    Down,
    /// The escape key.
    Esc,
    /// Control-C. Raw mode delivers it as a key rather than a signal, so the screen has to
    /// treat it as the user asking to leave.
    Interrupt,
}

/// What the user asked the screen to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenAction {
    /// Add one.
    Increment,
    /// Subtract one.
    Decrement,
    /// Return to the minimum.
    Reset,
    /// Leave the screen.
    Quit,
}

impl ScreenAction {
    /// Every action, in the order the help line lists them.
    pub const ALL: [Self; 4] = [Self::Increment, Self::Decrement, Self::Reset, Self::Quit];

    /// The keys bound to this action, the first being the one to mention first. The help
    /// line is built from this list, so it cannot drift from what the keys do.
    #[must_use]
    pub const fn keys(self) -> &'static [ScreenKey] {
        match self {
            Self::Increment => &[ScreenKey::Char('+'), ScreenKey::Up],
            Self::Decrement => &[ScreenKey::Char('-'), ScreenKey::Down],
            Self::Reset => &[ScreenKey::Char('r')],
            Self::Quit => &[ScreenKey::Char('q'), ScreenKey::Esc, ScreenKey::Interrupt],
        }
    }

    /// The action bound to `key`, or `None` for a key the screen ignores.
    #[must_use]
    pub fn for_key(key: ScreenKey) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|action| action.keys().contains(&key))
    }
}

/// The screen's state: the counter as last seen, the error from the last action (if it
/// failed), and whether the user asked to leave.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CounterScreen {
    view: Option<CounterView>,
    error: Option<CounterError>,
    finished: bool,
}

impl CounterScreen {
    /// The screen as it opens: the stored counter, or no value and the error when the
    /// store cannot be read (a reset can still replace what it holds).
    #[must_use]
    pub fn load(service: &CounterService) -> Self {
        let (view, error) = match service.view() {
            Ok(view) => (Some(view), None),
            Err(error) => (None, Some(error)),
        };
        Self {
            view,
            error,
            finished: false,
        }
    }

    /// The screen after `action`. A change that succeeds shows the new counter and clears
    /// the error; one that fails keeps the counter as it was and shows the error; `Quit`
    /// only finishes the screen.
    #[must_use]
    pub fn update(self, action: ScreenAction, service: &CounterService) -> Self {
        let result = match action {
            ScreenAction::Increment => service.increment(),
            ScreenAction::Decrement => service.decrement(),
            ScreenAction::Reset => service.reset(),
            ScreenAction::Quit => {
                return Self {
                    finished: true,
                    ..self
                };
            }
        };
        match result {
            Ok(view) => Self {
                view: Some(view),
                error: None,
                ..self
            },
            Err(error) => Self {
                error: Some(error),
                ..self
            },
        }
    }

    /// The counter as last seen; `None` when it could not be read yet.
    #[must_use]
    pub const fn view(&self) -> Option<&CounterView> {
        self.view.as_ref()
    }

    /// Why the last action failed, until the next one succeeds.
    #[must_use]
    pub const fn error(&self) -> Option<CounterError> {
        self.error
    }

    /// Whether the user asked to leave; the binary's loop ends when it is.
    #[must_use]
    pub const fn is_finished(&self) -> bool {
        self.finished
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_bound_key_maps_to_its_action() {
        let expected = [
            (ScreenKey::Char('+'), ScreenAction::Increment),
            (ScreenKey::Up, ScreenAction::Increment),
            (ScreenKey::Char('-'), ScreenAction::Decrement),
            (ScreenKey::Down, ScreenAction::Decrement),
            (ScreenKey::Char('r'), ScreenAction::Reset),
            (ScreenKey::Char('q'), ScreenAction::Quit),
            (ScreenKey::Esc, ScreenAction::Quit),
            (ScreenKey::Interrupt, ScreenAction::Quit),
        ];
        for (key, action) in expected {
            assert_eq!(ScreenAction::for_key(key), Some(action), "{key:?}");
        }
    }

    #[test]
    fn an_unbound_key_maps_to_nothing() {
        for key in ['x', 'Q', 'R', '=', ' '] {
            assert_eq!(ScreenAction::for_key(ScreenKey::Char(key)), None, "{key:?}");
        }
    }

    #[test]
    fn no_key_is_bound_to_two_actions() {
        let keys: Vec<ScreenKey> = ScreenAction::ALL
            .into_iter()
            .flat_map(|action| action.keys().iter().copied())
            .collect();
        for (index, key) in keys.iter().enumerate() {
            assert!(!keys[index + 1..].contains(key), "{key:?} is bound twice");
        }
    }

    #[test]
    fn every_action_has_a_key() {
        for action in ScreenAction::ALL {
            assert!(!action.keys().is_empty(), "{action:?}");
        }
    }
}
