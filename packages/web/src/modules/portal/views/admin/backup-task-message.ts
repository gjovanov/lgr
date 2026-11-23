/**
 * The line under "Create backup" while a backup is being made, in the reader's language (#772).
 *
 * It used to be the task's last log line as the server wrote it: a Bulgarian screen read
 * "Verifying" and then "Done". The server now names each stage with a code beside its line
 * (`GET /backup/task/:taskId` answers it as `stage`), and the catalogue names each code
 * (`backup.stage.<code>`).
 *
 * The log line is still what is shown where the catalogue has nothing to say:
 *  - no code: a server older than the codes;
 *  - a code with no name here: a stage the server gained before its translation;
 *  - a failed task: its stage only says where it stopped, and its last line is the server's
 *    own account of why.
 */

/** What the task route answers about a backup being made: the part this line reads. */
export interface BackupTaskState {
  status?: string
  /** What the run is doing now, as a code: `exporting`, `packing`, `verifying`, `done`. */
  stage?: string
  /** The task's log lines, oldest first, in the server's English. */
  logs?: string[]
}

export function backupTaskMessage(
  task: BackupTaskState | null | undefined,
  t: (key: string) => string,
  te: (key: string) => boolean,
): string {
  const line = (task?.logs || []).slice(-1)[0] || ''
  const stage = task?.stage
  if (!stage || task?.status === 'failed') return line
  const key = `backup.stage.${stage}`
  return te(key) ? t(key) : line
}
