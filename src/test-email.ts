/**
 * Test script — verifies your Gmail IMAP connection works.
 * Run with: npm run test-email
 */

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const email = process.env.GMAIL_EMAIL ?? '';
const password = process.env.GMAIL_APP_PASSWORD ?? '';

async function main() {
  console.log('\n  📧 Email Monitor Test\n');

  if (!email || !password) {
    console.error('  ✗ Missing GMAIL_EMAIL or GMAIL_APP_PASSWORD in .env');
    process.exit(1);
  }

  console.log(`  Email: ${email}`);
  console.log('  Connecting to imap.gmail.com...\n');

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: password },
    logger: false,
  });

  try {
    await client.connect();
    console.log('  ✓ Connected to Gmail IMAP');

    const lock = await client.getMailboxLock('INBOX');
    // mailbox is `MailboxObject | false` — false while no mailbox is open
    const mb = client.mailbox;
    const total = mb ? mb.exists : 0;
    console.log(`  ✓ Inbox opened — ${total} messages total`);

    // Fetch the 5 most recent emails
    const from = Math.max(1, total - 4);

    console.log(`\n  Last 5 emails:\n`);

    let count = 0;
    for await (const msg of client.fetch(`${from}:*`, { envelope: true, source: true })) {
      count++;
      if (!msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const fromAddr = parsed.from?.text ?? '(unknown)';
      const subject = parsed.subject ?? '(no subject)';
      const date = parsed.date?.toLocaleString() ?? '';

      console.log(`  ${count}. ${subject}`);
      console.log(`     From: ${fromAddr}`);
      console.log(`     Date: ${date}`);

      // Check if it looks like a foreUP email
      const text = [subject, parsed.text, parsed.html].filter(Boolean).join(' ');
      if (text.toLowerCase().includes('foreup') || text.toLowerCase().includes('booking code')) {
        const codeMatch = text.match(/\b(\d{4,8})\b/);
        console.log(`     ⭐ Looks like a foreUP email! Code: ${codeMatch?.[1] ?? 'not found'}`);
      }
      console.log('');
    }

    lock.release();
    await client.logout();

    console.log('  ✓ Test complete — email monitoring will work!\n');
  } catch (err: any) {
    console.error(`\n  ✗ Connection failed: ${err.message}`);
    if (err.message.includes('Invalid credentials')) {
      console.error('\n  Likely cause: wrong App Password.');
      console.error('  Generate one at: https://myaccount.google.com/apppasswords');
      console.error('  Make sure 2-Step Verification is enabled on your Google account.\n');
    }
    process.exit(1);
  }
}

main();
