//! Environments for spawned git. A task that runs git strips every `GIT_*` variable
//! first: inside a hook, git exports `GIT_DIR`, `GIT_INDEX_FILE`, and friends, and a git
//! command started with them would act on the hook's repository instead of the one the
//! task names (a temporary repository in a test, say).

use crate::context::Env;

/// `env` without any `GIT_*` variable.
pub(crate) fn git_env(env: &Env) -> Env {
    env.iter()
        .filter(|(name, _)| !name.starts_with("GIT_"))
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

/// The staged guard's one exception: it keeps `GIT_INDEX_FILE`, because
/// `git commit -- <path>` commits from a temporary index that only this variable names,
/// and the guard must judge the index that is actually being committed.
pub(crate) fn staged_guard_env(env: &Env) -> Env {
    let mut isolated = git_env(env);
    if let Some(index) = env.get("GIT_INDEX_FILE") {
        isolated.insert("GIT_INDEX_FILE".to_owned(), index.clone());
    }
    isolated
}

#[cfg(test)]
mod tests {
    use super::{git_env, staged_guard_env};
    use crate::context::Env;

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
            .collect()
    }

    #[test]
    fn strips_every_git_variable() {
        let given = env(&[
            ("GIT_DIR", "/x"),
            ("GIT_INDEX_FILE", "/i"),
            ("PATH", "/bin"),
        ]);
        assert_eq!(git_env(&given), env(&[("PATH", "/bin")]));
    }

    #[test]
    fn keeps_only_the_index_for_the_staged_guard() {
        let given = env(&[
            ("GIT_DIR", "/x"),
            ("GIT_INDEX_FILE", "/i"),
            ("PATH", "/bin"),
        ]);
        assert_eq!(
            staged_guard_env(&given),
            env(&[("GIT_INDEX_FILE", "/i"), ("PATH", "/bin")])
        );
        assert_eq!(staged_guard_env(&env(&[("GIT_DIR", "/x")])), Env::new());
    }
}
