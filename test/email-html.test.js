import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEmail } from '../src/email-html.js';

test('email HTML: link becomes a button, reasons and items are laid out, text is escaped', () => {
  const html = renderEmail({
    kind: 'approval_requested',
    subject: 'Approve $19.98 for Domaru?',
    body: ['Needs your OK because:', '- over <limit>', '', '2 x Paper Towels  $19.98', 'Approve or decline:', 'https://domaru.app/owner/approvals/a?t=x', '', '--', 'Domaru · support@domaru.app'].join('\n'),
  });
  assert.match(html, />Review and approve</);
  assert.match(html, /href="https:\/\/domaru\.app\/owner\/approvals\/a\?t=x"/);
  assert.match(html, /over &lt;limit&gt;/);
  assert.match(html, /Paper Towels <span[^>]*>× 2<\/span>/);
  assert.match(html, /support@domaru\.app/);
  assert.doesNotMatch(html, /<script/);
});
