/**
 * Pure generators for the OS scheduler job definitions behind
 * `codemie analytics sync install`.
 *
 * Every export here is a pure string/value builder — no I/O, no process spawning. The thin
 * register/unregister/query wiring that writes these to disk and talks to the OS scheduler
 * lives in `./index.ts`.
 */

import { realpath } from 'fs/promises';

/** launchd job label, shared with the standalone collector so install replaces its job. */
export const LAUNCHD_LABEL = 'com.epam.codemie.analytics-sync';
/** systemd user unit base name (service + timer share it), collector-compatible. */
export const SYSTEMD_UNIT_NAME = 'codemie-analytics-sync';
/** Windows Task Scheduler task name, collector-compatible. */
export const WINDOWS_TASK_NAME = 'CodeMie Analytics Sync';

/** The job command: absolute node binary, absolute CLI entry script, and its argv. */
export interface JobCommand {
  node: string;
  entry: string;
  args: string[];
}

/**
 * Resolve the job command run by the scheduled job: `process.execPath` plus the realpath of
 * the running CLI entry script (`process.argv[1]`), so a shim/symlink entry (e.g. an npm bin
 * wrapper) resolves to the real script — no `.cmd` shim on Windows.
 */
export async function resolveJobCommand(): Promise<JobCommand> {
  const entry = await realpath(process.argv[1] ?? '');
  return {
    node: process.execPath,
    entry,
    args: ['analytics', 'sync', 'run', '--scheduled']
  };
}

interface ParsedAt {
  hour: number;
  minute: number;
}

function parseAt(at: string): ParsedAt {
  const [hourText, minuteText] = at.split(':');
  return { hour: Number(hourText), minute: Number(minuteText) };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function plistString(value: string): string {
  return `<string>${xmlEscape(value)}</string>`;
}

function programArguments(cmd: JobCommand): string[] {
  return [cmd.node, cmd.entry, ...cmd.args];
}

/**
 * macOS launchd plist: `StartCalendarInterval` from `at` (`HH:MM`), `RunAtLoad=false` (the
 * job only ever runs on its daily schedule, never at login/registration), stdout/stderr
 * pointed at `logPath` (the sync log, so the job's own output lands next to the run log
 * instead of /dev/null).
 */
export function launchdPlist(cmd: JobCommand, at: string, logPath: string): string {
  const { hour, minute } = parseAt(at);
  const args = programArguments(cmd)
    .map((value) => `        ${plistString(value)}`)
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${hour}</integer>
        <key>Minute</key>
        <integer>${minute}</integer>
    </dict>
    <key>RunAtLoad</key>
    <false/>
    <key>StandardOutPath</key>
    ${plistString(logPath)}
    <key>StandardErrorPath</key>
    ${plistString(logPath)}
</dict>
</plist>
`;
}

/**
 * Linux systemd user service + timer. `Type=oneshot` (the job exits once it has sent/failed,
 * it is not long-running); `OnCalendar=*-*-* HH:MM:00` from `at`; `Persistent=true` (a missed
 * run — machine asleep/off — fires once at next boot); `RandomizedDelaySec=300` (spreads load
 * across machines that share the same `at`).
 */
export function systemdUnits(cmd: JobCommand, at: string): { service: string; timer: string } {
  const execStart = programArguments(cmd)
    .map((value) => `"${value.replace(/"/g, '\\"')}"`)
    .join(' ');

  const service = `[Unit]
Description=CodeMie analytics sync (daily)

[Service]
Type=oneshot
ExecStart=${execStart}
`;

  const timer = `[Unit]
Description=CodeMie analytics sync daily timer

[Timer]
OnCalendar=*-*-* ${at}:00
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`;

  return { service, timer };
}

/**
 * Windows Task Scheduler XML for `schtasks /Create /XML`. `StartWhenAvailable` (fires once
 * the machine is next available if it missed `at`); `IgnoreNew` (no overlapping runs);
 * `InteractiveToken`/`LeastPrivilege` (runs as the logged-in user, no elevation);
 * `ExecutionTimeLimit=PT30M` caps a stuck run. `<Command>` is the node binary path (no
 * `.cmd` shim); `<Arguments>` carries the entry script and CLI args.
 *
 * The returned string is plain UTF-16 XML text; encoding it as UTF-16LE with a BOM into the
 * temp file `schtasks` reads is the caller's job (`./index.ts`), not this generator's.
 */
export function taskSchedulerXml(cmd: JobCommand, at: string): string {
  const { hour, minute } = parseAt(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const startBoundary = `${new Date().toISOString().slice(0, 10)}T${pad(hour)}:${pad(minute)}:00`;
  const args = [cmd.entry, ...cmd.args].map(xmlEscape).join(' ');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>CodeMie analytics sync (daily)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(cmd.node)}</Command>
      <Arguments>${args}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}
