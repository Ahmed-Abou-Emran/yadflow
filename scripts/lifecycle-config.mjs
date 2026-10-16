#!/usr/bin/env node
/* global console, process */
// Writes the generated parts of skills/sdlc/config.yaml — the phase table, the route ids, the sentinels
// and `automation.back_steps` — from the shipped lifecycle default, cli/lifecycle/defaults/<n>.json
// (E134). Only the lines between each `# >>> generated: <name>` and `# <<< generated: <name>` marker are
// ever replaced. A test in cli/test-lifecycle.mjs fails when the file and the default disagree, and this
// script is how you make them agree again.
//
//   node scripts/lifecycle-config.mjs           rewrite the regions; print each one it changed
//   node scripts/lifecycle-config.mjs --check   change nothing; exit 1 when a region is stale or missing
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyConfigRegions } from '../cli/lifecycle.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'skills', 'sdlc', 'config.yaml');
const check = process.argv.includes('--check');
const r = applyConfigRegions(fs.readFileSync(FILE, 'utf8'));
for (const reason of r.refused) console.error(`refused: skills/sdlc/config.yaml — ${reason}. Add the markers, then run this script again.`);
for (const name of r.stale) console.log(`${check ? 'stale' : 'wrote'}: skills/sdlc/config.yaml region "${name}"`);
if (!check && !r.refused.length && r.stale.length) fs.writeFileSync(FILE, r.text);
if (r.refused.length || (check && r.stale.length)) process.exit(1);
