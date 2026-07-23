// Prints every 微信客服 account under the enterprise, with its open_kfid.
// The console doesn't show open_kfid, but you need it to set ALLOWED_KF_IDS
// (so the bot only answers your TEST account, not the live 官方客服).
//
//   npm run list-kf
//
// Needs CORP_ID + KF_SECRET in .env. Read-only: it only lists, sends nothing.

import { WecomClient } from '../src/wecom.js';

const { CORP_ID, KF_SECRET } = process.env;
if (!CORP_ID || !KF_SECRET) {
  console.error('Missing CORP_ID or KF_SECRET — set them in .env first.');
  process.exit(1);
}

const wecom = new WecomClient(CORP_ID, KF_SECRET);
const accounts = await wecom.listKfAccounts();

if (accounts.length === 0) {
  console.log('No 微信客服 accounts found. Create one in the admin console first.');
} else {
  console.log(`Found ${accounts.length} kf account(s):\n`);
  for (const a of accounts) {
    console.log(`  ${a.name}`);
    console.log(`    open_kfid: ${a.open_kfid}\n`);
  }
  console.log("Set ALLOWED_KF_IDS in .env to your TEST account's open_kfid.");
}
