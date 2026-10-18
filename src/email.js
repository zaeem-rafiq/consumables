// Email to households and to the support inbox. The store queues every
// message in its `emails` table, then a mailer delivers the queue.
//
// - OutboxMailer: delivers nothing; messages stay readable on the admin page
//   and in tests. Default.
// - ResendMailer: sends through Resend's REST API (RESEND_API_KEY).

export class OutboxMailer {
  name = 'outbox';

  async send() {
    return { status: 'logged', ref: null };
  }
}

export class ResendMailer {
  name = 'resend';

  constructor({ apiKey, fetch = globalThis.fetch, apiBase = 'https://api.resend.com' }) {
    if (!apiKey) throw new Error('ResendMailer needs an API key.');
    this.apiKey = apiKey;
    this.fetch = fetch;
    this.apiBase = apiBase;
  }

  async send({ id, from, to, replyTo, subject, text, html }) {
    const res = await this.fetch(`${this.apiBase}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', 'idempotency-key': id },
      body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text, ...(html ? { html } : {}) }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return { status: 'failed', ref: null, error: json.message ?? `Resend error ${res.status}` };
    return { status: 'sent', ref: json.id ?? null };
  }
}
