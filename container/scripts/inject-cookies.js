#!/usr/bin/env node

/**
 * Cookie Injection Script for agent-browser
 *
 * Converts Cookie-Editor JSON exports to Playwright storageState format,
 * which agent-browser can load with `agent-browser state load <file>`.
 *
 * Usage:
 *   node inject-cookies.js <cookie-file> [output-file]
 *
 * Example:
 *   node inject-cookies.js /workspace/group/dunnes-cookies.json
 *   node inject-cookies.js /workspace/group/dunnes-cookies.json /tmp/state.json
 *
 * If output-file is omitted, writes to <cookie-file-dir>/.state-<basename>.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SAME_SITE_MAP = {
  'no_restriction': 'None',
  'lax': 'Lax',
  'strict': 'Strict',
  'unspecified': 'Lax',
};

function validateCookies(cookies) {
  if (!Array.isArray(cookies)) {
    throw new Error('Cookie file must contain a JSON array of cookies');
  }
  for (const cookie of cookies) {
    if (!cookie.name || !cookie.value || !cookie.domain) {
      throw new Error(`Invalid cookie: missing name, value, or domain in ${JSON.stringify(cookie)}`);
    }
  }
}

function toStorageState(cookies) {
  return {
    cookies: cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      expires: c.expirationDate || -1,
      httpOnly: c.httpOnly === true,
      secure: c.secure === true,
      sameSite: SAME_SITE_MAP[(c.sameSite || 'lax').toLowerCase()] || 'Lax',
    })),
    origins: [],
  };
}

// CLI
const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __filename) {
  const [,, cookieFile, outputFile] = process.argv;

  if (!cookieFile) {
    console.error('Usage: node inject-cookies.js <cookie-file> [output-file]');
    process.exit(1);
  }

  if (!fs.existsSync(cookieFile)) {
    console.error(`Cookie file not found: ${cookieFile}`);
    process.exit(1);
  }

  const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf8'));
  validateCookies(cookies);

  const state = toStorageState(cookies);
  const outPath = outputFile || path.join(
    path.dirname(cookieFile),
    `.state-${path.basename(cookieFile)}`,
  );

  fs.writeFileSync(outPath, JSON.stringify(state, null, 2));
  console.log(`Converted ${cookies.length} cookies → ${outPath}`);
  console.log(`\nLoad in agent-browser:\n  agent-browser state load ${outPath}`);
}
