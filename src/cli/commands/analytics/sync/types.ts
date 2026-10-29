/**
 * Shared types for `codemie analytics sync`.
 */

export type SyncTargetType = 'webhook';

export interface SyncReport {
  fileName: string;
  bytes: Buffer;
}

export interface SyncTarget {
  readonly id: string;
  readonly type: SyncTargetType;
  deliver(report: SyncReport): Promise<void>;
}

export type IncludeExternalPolicy = 'windows' | 'always' | 'never';

export interface SyncConfig {
  targets: {
    webhook?: { url: string };
  };
  includeExternal: IncludeExternalPolicy;
  lookbackDays: number;
}

export type SyncStatus = 'ok' | 'skip' | 'fail';

export interface SyncResult {
  status: SyncStatus;
  category: string;
  detail: string;
}
