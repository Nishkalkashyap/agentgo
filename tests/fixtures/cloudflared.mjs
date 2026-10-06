#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('cloudflared fixture'); process.exit(0); }
const path = join(dirname(args[args.indexOf('--config') + 1]), 'fake-tunnel-count');
let count = 0;
try { count = Number(readFileSync(path, 'utf8')); } catch {}
writeFileSync(path, String(++count));
console.error(`https://fake-${count}.trycloudflare.com`);
console.error('Registered tunnel connection');
if (count === 1) setTimeout(() => process.exit(1), 200);
else setInterval(() => {}, 1000);
