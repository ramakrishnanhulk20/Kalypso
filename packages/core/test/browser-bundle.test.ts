// Does NOT cover: whether the bundle runs in a browser (bb.js also needs the circuits and the
// COOP and COEP headers), or modules named only at runtime, which no bundler can see. It
// bundles with the rolldown that vite already installs, for platform browser.
import { isBuiltin } from 'node:module';
import { join, relative } from 'node:path';
import { rolldown, type Plugin } from 'rolldown';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');
const PROBE = '\0browser-probe';

/**
 * Bundles `input` for the browser and returns every Node built-in its graph reaches, with or
 * without the node: prefix, as "specifier <- importer". A bare name that resolves to an
 * installed npm package (the Stellar SDK imports the npm buffer package on purpose) is a
 * browser polyfill, so it goes into `polyfills` instead.
 */
async function nodeBuiltinsReached(input: string, probeSource?: string) {
  const builtins = new Set<string>();
  const polyfills = new Set<string>();
  const detector: Plugin = {
    name: 'node-builtin-detector',
    async resolveId(source, importer, options) {
      if (probeSource !== undefined && source === PROBE) return PROBE;
      if (!isBuiltin(source)) return null;
      const resolved = source.startsWith('node:') ? null : await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved !== null && !resolved.external) {
        polyfills.add(source);
        return null;
      }
      builtins.add(`${source} <- ${importer === undefined ? '?' : relative(root, importer).replaceAll('\\', '/')}`);
      return { id: source, external: true };
    },
    load(id) {
      return id === PROBE ? (probeSource ?? null) : null;
    },
  };
  const bundle = await rolldown({ input, platform: 'browser', cwd: root, logLevel: 'silent', plugins: [detector] });
  try {
    await bundle.generate({ format: 'esm' });
  } finally {
    await bundle.close();
  }
  return { builtins: [...builtins].sort(), polyfills: [...polyfills].sort() };
}

describe('the "." entry in a browser bundle', () => {
  it('reaches no Node built-in, with or without the node: prefix', async () => {
    const { builtins, polyfills } = await nodeBuiltinsReached(join(root, 'src/index.ts'));
    expect(builtins).toEqual([]);
    expect(polyfills).toContain('buffer');
  }, 120_000);

  it('the same check flags the Node prover, which reads circuits with fs, path and url', async () => {
    const { builtins } = await nodeBuiltinsReached(join(root, 'src/prover/node.ts'));
    const names = builtins.map((hit) => hit.split(' <- ')[0]);
    expect(names).toEqual(expect.arrayContaining(['fs', 'path', 'url']));
    expect(builtins.every((hit) => hit.includes('stellar-confidential-token-sdk/dist/node.js'))).toBe(true);
  }, 120_000);

  it('flags node:crypto and bare crypto but lets the installed buffer package through', async () => {
    const { builtins, polyfills } = await nodeBuiltinsReached(PROBE, "import 'node:crypto';\nimport 'crypto';\nimport 'buffer';\n");
    expect(builtins.map((hit) => hit.split(' <- ')[0])).toEqual(['crypto', 'node:crypto']);
    expect(polyfills).toEqual(['buffer']);
  }, 60_000);
});
