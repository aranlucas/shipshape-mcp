/**
 * Starts work from an event handler. Expected failures are already turned
 * into UI state by the task itself; anything else goes to the browser's
 * global error reporting instead of disappearing.
 */
export function startTask(task: Promise<unknown>): void {
  task.catch(reportError);
}
