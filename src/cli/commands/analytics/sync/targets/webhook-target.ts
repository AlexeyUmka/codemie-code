/**
 * Webhook delivery target for `codemie analytics sync`.
 *
 * POSTs the analytics export as a single JSON attachment to a configured
 * HTTPS webhook URL. Any 2xx response resolves; a non-2xx response or a
 * `fetchImpl` rejection becomes a `SyncDeliveryError` with a redacted
 * message (the signed URL query parameter must never leak into it).
 */

import { ExportTooLargeError, SyncDeliveryError } from '../../../../../utils/errors.js';
import { errorMessage } from '../redact.js';
import type { SyncReport, SyncTarget, SyncTargetType } from '../types.js';

export const MAX_EXPORT_BYTES = 70_000_000;

const defaultFetch: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

export class WebhookTarget implements SyncTarget {
  readonly id = 'webhook';
  readonly type: SyncTargetType = 'webhook';

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = defaultFetch
  ) {}

  async deliver(report: SyncReport): Promise<void> {
    if (report.bytes.length > MAX_EXPORT_BYTES) {
      throw new ExportTooLargeError(report.bytes.length, MAX_EXPORT_BYTES);
    }

    const body = JSON.stringify({
      type: 'message',
      attachments: [
        {
          contentType: 'application/json',
          name: report.fileName,
          contentBytes: report.bytes.toString('base64'),
        },
      ],
    });

    let response: { ok: boolean; status: number };
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
    } catch (err) {
      throw new SyncDeliveryError(errorMessage(err));
    }

    if (!response.ok) {
      throw new SyncDeliveryError(`Webhook delivery failed with status ${response.status}`, response.status);
    }
  }
}
