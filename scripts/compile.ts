/**
 * Compile every contract with Runar and write:
 *   artifacts/<Name>.runar.json  full artifact (script hex, asm, ABI) - gitignored, large
 *   artifacts/summary.json       sizes and hashes - committed
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR, CONTRACT_NAMES, compileContract } from '../src/compile.js';

let runarCommit = 'unknown';
try {
  runarCommit = execSync('git -C vendor/runar rev-parse HEAD', { encoding: 'utf8' }).trim();
} catch { /* vendor/runar is not a git checkout */ }

mkdirSync(ARTIFACTS_DIR, { recursive: true });
const summary: Record<string, unknown> = {};
for (const name of CONTRACT_NAMES) {
  const artifact = compileContract(name) as any;
  writeFileSync(join(ARTIFACTS_DIR, `${name}.runar.json`), JSON.stringify(artifact));
  summary[name] = {
    compilerVersion: artifact.compilerVersion,
    runarCommit,
    templateScriptBytes: artifact.script.length / 2,
    templateScriptSha256: createHash('sha256').update(Buffer.from(artifact.script, 'hex')).digest('hex'),
    codeSeparatorIndex: artifact.codeSeparatorIndex,
    scriptCodeBytes: artifact.script.length / 2 - artifact.codeSeparatorIndex - 1,
    abi: artifact.abi,
  };
  console.log(`${name.padEnd(16)} ${String(artifact.script.length / 2).padStart(9)} bytes`);
}
writeFileSync(join(ARTIFACTS_DIR, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
