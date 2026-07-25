/**
 * Whether a local-jsx command's panel lets permission dialogs render on top of it.
 *
 * A one-line decision, extracted only so it can be tested. It sits on a wire that has no
 * other seam: `processSlashCommand` builds the `setToolJSX` payload inside a `.then()` in a
 * 700-line React module, and REPL reads it back through
 * `allowDialogsWithAnimation = !toolJSX || toolJSX.shouldContinueAnimation`, which gates
 * `tool-permission`, `prompt`, `elicitation` and the worker-sandbox prompt.
 *
 * What that gate cost: a local-jsx command sets `toolJSX` without the flag, so while its
 * panel is mounted the confirm queue is INVISIBLE. `/et` hands the session's real
 * `canUseTool` to write-capable execute sub-agents, so the first Edit/Write/Bash needing
 * approval enqueued a request the terminal could never draw — with a Feishu bridge the run
 * degraded to approve-from-phone without saying so, and with no bridge it waited forever.
 *
 * Opt-in rather than default: painting a permission dialog over a command that owns the
 * screen is only correct when that command is genuinely waiting on one. An ordinary dialog
 * command (`/model`, `/config`) has nothing of its own asking, and should keep the screen.
 */
export function allowsPermissionDialogs(command: { spawnsSubagents?: boolean }): boolean {
  return command.spawnsSubagents === true
}
