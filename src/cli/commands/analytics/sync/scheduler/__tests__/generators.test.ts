import { describe, expect, it } from 'vitest';

import { launchdPlist, systemdUnits, taskSchedulerXml, type JobCommand } from '../generators.js';

const CMD: JobCommand = {
  node: '/usr/local/bin/node',
  entry: '/Users/dev & "quote"/codemie/bin/codemie.js',
  args: ['analytics', 'sync', 'run', '--scheduled']
};

describe('launchdPlist', () => {
  const plist = launchdPlist(CMD, '07:05', '/Users/dev/.codemie/logs/analytics-sync.log');

  it('contains the launchd label', () => {
    expect(plist).toContain('<string>com.epam.codemie.analytics-sync</string>');
  });

  it('parses "07:05" into integer Hour/Minute for StartCalendarInterval', () => {
    expect(plist).toContain('<key>Hour</key>\n        <integer>7</integer>');
    expect(plist).toContain('<key>Minute</key>\n        <integer>5</integer>');
  });

  it('sets RunAtLoad to false', () => {
    expect(plist).toContain('<key>RunAtLoad</key>\n    <false/>');
  });

  it('XML-escapes paths containing special characters', () => {
    expect(plist).toContain('&amp;');
    expect(plist).toContain('&quot;quote&quot;');
    expect(plist).not.toContain('& "quote"');
  });
});

describe('systemdUnits', () => {
  const { service, timer } = systemdUnits(CMD, '07:05');

  it('service runs as a oneshot executing the job command', () => {
    expect(service).toContain('Type=oneshot');
    expect(service).toContain(CMD.node);
    expect(service).toContain(CMD.entry.replace(/"/g, '\\"'));
  });

  it('timer has OnCalendar=*-*-* 07:05:00 and Persistent=true', () => {
    expect(timer).toContain('OnCalendar=*-*-* 07:05:00');
    expect(timer).toContain('Persistent=true');
  });

  it('timer sets a RandomizedDelaySec', () => {
    expect(timer).toContain('RandomizedDelaySec=300');
  });
});

describe('taskSchedulerXml', () => {
  const xml = taskSchedulerXml(CMD, '07:05');

  it('sets StartWhenAvailable to true', () => {
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });

  it('uses the node binary path as <Command>, with no .cmd shim', () => {
    expect(xml).toContain(`<Command>${CMD.node}</Command>`);
    expect(xml).not.toContain('.cmd');
  });

  it('sets IgnoreNew and LeastPrivilege', () => {
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });

  it('caps execution time at PT30M', () => {
    expect(xml).toContain('<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>');
  });
});
