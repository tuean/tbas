/**
 * Regenerate extension/demo.json from src/demo.js.
 * Run: npm run demo:sync
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { demoBundle } from '../src/demo.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'extension', 'demo.json');
const bundle = demoBundle();
writeFileSync(file, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
console.log(`wrote ${file}`);
for (const snapshot of bundle.snapshots) {
  console.log(`  ${snapshot.id}  ${snapshot.name}  ${snapshot.stats.tabs} 标签`);
}
