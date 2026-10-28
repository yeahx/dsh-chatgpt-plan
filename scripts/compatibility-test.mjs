// Run with DSH's Electron (ELECTRON_RUN_AS_NODE=1). No real accounts or OpenAI requests.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const require = createRequire(`${runtime}/package.json`);
// An optional package directory also lets this test check an unpacked npm tarball.
const packageRoot = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const packageUrl = pathToFileURL(join(packageRoot, '/')).href;
const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
const { evaluatePluginCompatibility, getDshRuntimeVersion } = await import(require.resolve('@deepseek-ai/dsh-app-boot'));
const { satisfies } = require('semver');
const runtimeVersion = getDshRuntimeVersion();
const dshPeers = ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm-pi-ai'];
const oldManifest = { ...manifest, version: '0.1.3', peerDependencies: {
  ...Object.fromEntries(dshPeers.map(name => [name, '0.2.0-rc.2'])),
  '@earendil-works/pi-ai': '0.87.1',
} };

// Reproduce the reported rejection with the host's real compatibility checker.
const rejected = evaluatePluginCompatibility(oldManifest, {}, '0.2.1-rc.3');
assert.deepEqual(rejected.requirements, Object.fromEntries(dshPeers.map(name => [name, '0.2.0-rc.2'])));
assert.equal(rejected.exempted, false);
// Later 0.2.1 releases are admitted by policy, not claimed as runtime-tested.
for (const version of ['0.2.0-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1', runtimeVersion]) {
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `DSH ${version} must be compatible`);
}
// The -0 upper bound excludes even 0.2.2 prereleases with includePrerelease enabled.
for (const version of ['0.2.0-rc.1', '0.2.1-rc.2', '0.2.2-alpha.1', '0.2.2-rc.1', '0.2.2', '0.3.0']) {
  assert.ok(evaluatePluginCompatibility(manifest, {}, version), `DSH ${version} is outside the supported range`);
}
for (const name of dshPeers) {
  for (const version of ['0.2.0-rc.2', '0.2.1-rc.3', '0.2.1-rc.4', '0.2.1']) {
    assert.ok(satisfies(version, manifest.peerDependencies[name]), `${name} must also satisfy npm's default prerelease rules`);
  }
}

// DSH's startup gate only checks DSH peers; verify pi-ai against the actual host too.
const hostPeers = {};
for (const [name, range] of Object.entries(manifest.peerDependencies)) {
  const installed = JSON.parse(await readFile(join(runtime, 'node_modules', name, 'package.json'), 'utf8')).version;
  assert.ok(satisfies(installed, range), `${name}@${installed} does not satisfy ${range}`);
  hostPeers[name] = installed;
}
const piRange = manifest.peerDependencies['@earendil-works/pi-ai'];
for (const version of ['0.87.1', '1.1.0', '1.1.1', '1.1.99']) assert.ok(satisfies(version, piRange));
for (const version of ['0.87.2', '1.0.2', '1.1.1-rc.1', '1.2.0-rc.1', '1.2.0', '2.0.0']) assert.ok(!satisfies(version, piRange));

// Resolve the plugin's imports to the bundled host packages without installing
// another copy of DSH. The registry is mocked; the entry point and adapter are real.
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(packageUrl) &&
        (specifier.startsWith('@deepseek-ai/') || specifier.startsWith('@earendil-works/') || specifier === 'undici')) {
      // Keep ESM conditions: pi-ai's API subpaths are import-only exports.
      return nextResolve(specifier, { ...context, parentURL: pathToFileURL(`${runtime}/package.json`).href });
    }
    return nextResolve(specifier, context);
  },
});
const profile = await mkdtemp(join(tmpdir(), 'dsh-compatibility-test-'));
const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Unexpected network access during plugin initialization'); };
const listeners = new Map();
let registered, configRoute, disposed = false;
try {
  const plugin = await import(pathToFileURL(join(packageRoot, manifest.main)).href);
  assert.equal(plugin.name, 'chatgpt-plan');
  assert.deepEqual(plugin.inject, ['llm']);
  const ctx = {
    // Never use a profile named desktop: that would attempt legacy account migration.
    baseUrl: pathToFileURL(profile).href,
    on(name, listener) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
    inject(names, apply) {
      assert.deepEqual(names, ['connection']);
      apply({ connection: { fetch: { register(route) { configRoute = route; } } } });
    },
    get() { return undefined; },
    llm: { registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['chatgpt-plan']);
      assert.equal(typeof adapter.stream, 'function');
      assert.equal(adapter.providerRetryPolicy('chatgpt-plan').maxRetries, 2);
      registered = adapter;
      return Object.assign(() => { disposed = true; }, { replace() {} });
    } },
  };
  await plugin.apply(ctx);
  assert.ok(registered);
  const injected = [];
  for (const listener of listeners.get('webserver/index-inject') || []) listener(injected);
  assert.equal(injected[0]?.name, '__DSH_CHATGPT_PLAN__');
  assert.equal(new URL(injected[0].value.origin).hostname, '127.0.0.1');
  assert.equal(configRoute.path, '/api/chatgpt-plan-config');
  assert.deepEqual(configRoute.methods, ['GET']);
  assert.equal(configRoute.requestBody, 'buffered');
  const response = await configRoute.fetch(new Request('http://localhost/api/chatgpt-plan-config'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), injected[0].value);
  const accounts = JSON.parse(await readFile(join(profile, 'data/dsh-chatgpt-plan/accounts.json'), 'utf8'));
  assert.deepEqual(accounts.profiles, []);
} finally {
  for (const listener of listeners.get('dispose') || []) await listener();
  globalThis.fetch = originalFetch;
  hook.deregister();
  await rm(profile, { recursive: true, force: true });
}
assert.equal(disposed, true);
console.log(JSON.stringify({ success: true, runtimeVersion, hostPeers, originalRejectionReproduced: true,
  versionBoundariesChecked: true, pluginInitialization: true, registry: 'mocked', profile: 'temporary', network: 'blocked' }, null, 2));
