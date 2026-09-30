/**
 * Environments for spawned git. A script that runs git strips every GIT_*
 * variable first: inside a hook, git exports GIT_DIR, GIT_INDEX_FILE, and friends, and
 * a git command started with them would act on the hook's repository instead of the
 * one the script names (a temporary clone in a test, say).
 */
type Env = Readonly<Record<string, string | undefined>>;

/** `env` without any GIT_* variable. */
export function gitEnv(env: Env): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith("GIT_")));
}

/**
 * The staged guard's one exception: it keeps GIT_INDEX_FILE, because
 * `git commit -- <path>` commits from a temporary index that only this variable names,
 * and the guard must judge the index that is actually being committed.
 */
export function stagedGuardEnv(env: Env): Record<string, string | undefined> {
  const isolated = gitEnv(env);
  const index = env["GIT_INDEX_FILE"];
  return index === undefined ? isolated : { ...isolated, GIT_INDEX_FILE: index };
}
