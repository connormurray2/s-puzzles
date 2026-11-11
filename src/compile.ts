import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from 'runar-compiler';
import type { RunarArtifact } from 'runar-ir-schema';

const here = dirname(fileURLToPath(import.meta.url));
export const CONTRACTS_DIR = join(here, '..', 'contracts');
export const ARTIFACTS_DIR = join(here, '..', 'artifacts');

export const CONTRACT_NAMES = ['SPuzzle', 'PedersenOpening', 'ChaumPedersen', 'OrProof'] as const;
export type ContractName = (typeof CONTRACT_NAMES)[number];

const cache = new Map<string, RunarArtifact>();

/** Compile contracts/<name>.runar.ts with the Runar compiler built from main. */
export function compileContract(name: ContractName): RunarArtifact {
  const hit = cache.get(name);
  if (hit) return hit;
  const file = join(CONTRACTS_DIR, `${name}.runar.ts`);
  const result = compile(readFileSync(file, 'utf8'), { fileName: file });
  const errors = result.diagnostics.filter((d) => d.severity === 'error');
  if (!result.success || !result.artifact) {
    throw new Error(
      `Compiling ${name} failed:\n` +
        errors.map((d) => `  ${d.message} (line ${d.loc?.line})`).join('\n'),
    );
  }
  cache.set(name, result.artifact);
  return result.artifact;
}
