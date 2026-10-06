import { readFileSync } from 'node:fs';

// package.json sits one level above both src/ and dist/.
export const version: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
