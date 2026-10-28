import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { normalizeInferenceOptions } from '../inference-options.mjs';
import { createAdapter, planPayload, PROVIDER } from '../adapter.mjs';
import { ChatGPTAuth, PLAN_SCOPE, RESOURCE } from '../oauth.mjs';
import { Store } from '../storage.mjs';
import { startManagement } from '../management.mjs';

const DEFAULTS = { serviceTier: 'auto', cyberAccessProgram: 'auto' };
const FAST_BLUE = { serviceTier: 'fast', cyberAccessProgram: 'daybreak_blue' };
const NOW = 1800000000000;

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-inference-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new Store(directory);
  await store.transact(data => {
    data.activeProfileId = 'one';
    data.profiles = ['one', 'two'].map(id => ({
      id, clientId: `oaiapp_${id}`, label: `Account ${id}`, email: `${id}@example.invalid`,
      access_token: `fake-access-${id}`, refresh_token: `fake-refresh-${id}`, id_token: `fake-identity-${id}`,
      expiresAt: NOW + 3600000, scopes: [PLAN_SCOPE],
      models: [{ slug: `model-${id}`, visibility: 'list' }],
    }));
  });
  const auth = new ChatGPTAuth({ store, now: () => NOW, fetcher: () => { throw new Error('Unexpected external request'); } });
  t.after(() => { auth.cancel(); auth.requestController.abort(); });
  return { store, auth };
}

test('inference options preserve omitted defaults and validate explicit selections', () => {
  assert.deepEqual(normalizeInferenceOptions(), DEFAULTS);
  assert.deepEqual(normalizeInferenceOptions({}), DEFAULTS);
  assert.deepEqual(normalizeInferenceOptions({ serviceTier: 'fast' }), { ...DEFAULTS, serviceTier: 'fast' });
  assert.deepEqual(normalizeInferenceOptions({ cyberAccessProgram: 'standard' }), { ...DEFAULTS, cyberAccessProgram: 'standard' });
  const input = Object.freeze({ ...FAST_BLUE });
  const output = normalizeInferenceOptions(input);
  assert.deepEqual(output, FAST_BLUE);
  assert.notEqual(output, input);
  for (const invalid of [null, [], 'fast', 1, true, { unknown: 'auto' }, { serviceTier: 'priority' },
    { serviceTier: null }, { serviceTier: undefined }, { cyberAccessProgram: 'daybreak' },
    { cyberAccessProgram: ['daybreak_blue'] }, { access_programs: { cyber: 'daybreak_red' } }]) {
    assert.throws(() => normalizeInferenceOptions(invalid), Error, JSON.stringify(invalid));
    assert.throws(() => planPayload({ input: [] }, invalid), Error, JSON.stringify(invalid));
  }
});

test('all inference selections map to exact wire fields while retaining the plan payload contract', () => {
  const input = {
    input: [{ role: 'system', content: 'instructions' }, { role: 'user', content: 'hello' }],
    store: true, stream: false, service_tier: 'injected', access_programs: { cyber: 'injected', other: 'injected' },
    temperature: 1, previous_response_id: 'previous', max_output_tokens: 123,
    tools: [{ type: 'function', name: 'echo', strict: false, parameters: { type: 'object', properties: {} } }],
  };
  const original = structuredClone(input);
  for (const serviceTier of ['auto', 'default', 'fast']) {
    for (const cyberAccessProgram of ['auto', 'standard', 'daybreak_blue', 'daybreak_red']) {
      const payload = planPayload(input, { serviceTier, cyberAccessProgram });
      assert.equal(Object.hasOwn(payload, 'service_tier'), serviceTier !== 'auto');
      assert.equal(payload.service_tier, serviceTier === 'auto' ? undefined : serviceTier);
      assert.equal(Object.hasOwn(payload, 'access_programs'), cyberAccessProgram !== 'auto');
      assert.deepEqual(payload.access_programs, cyberAccessProgram === 'auto' ? undefined : { cyber: cyberAccessProgram });
      assert.equal(payload.store, false); assert.equal(payload.stream, true);
      assert.equal(payload.input[0].role, 'developer');
      for (const key of ['temperature', 'previous_response_id', 'max_output_tokens']) assert.equal(Object.hasOwn(payload, key), false);
      assert.equal(payload.tools[0].type, 'namespace');
      assert.equal(payload.tools[0].tools[0].strict, false);
    }
  }
  assert.deepEqual(input, original, 'request transformation must not mutate the caller payload');
  const legacy = planPayload(input);
  assert.equal(Object.hasOwn(legacy, 'service_tier'), false);
  assert.equal(Object.hasOwn(legacy, 'access_programs'), false);
});

test('account preferences persist without changing credentials, other accounts, or an active stream signal', async t => {
  const { store, auth } = await fixture(t);
  const before = await store.load(), signal = auth.requestController.signal;
  let changes = 0; auth.onChange = () => { changes++; };
  assert.deepEqual((await auth.status()).profiles.map(p => p.inferenceOptions), [DEFAULTS, DEFAULTS]);
  const options = { ...FAST_BLUE };
  await auth.configureInference('one', options);
  options.serviceTier = 'default';
  const saved = await store.load();
  assert.deepEqual(saved, { ...before, profiles: [{ ...before.profiles[0], inferenceOptions: FAST_BLUE }, before.profiles[1]] });
  assert.equal(changes, 1);
  assert.equal(signal.aborted, false);
  assert.equal(auth.requestController.signal, signal);
  const reloaded = new ChatGPTAuth({ store: new Store(store.directory), now: () => NOW });
  const status = await reloaded.status();
  assert.deepEqual(status.profiles[0].inferenceOptions, FAST_BLUE);
  assert.deepEqual(status.profiles[1].inferenceOptions, DEFAULTS);
  assert.equal(JSON.stringify(status).includes('fake-'), false, 'status must not expose test credentials');
  await auth.configureInference('two', { cyberAccessProgram: 'daybreak_red' });
  await auth.select('two');
  assert.equal((await auth.access()).profileId, 'two');
  assert.deepEqual((await auth.status()).profiles.map(p => p.inferenceOptions), [FAST_BLUE, { ...DEFAULTS, cyberAccessProgram: 'daybreak_red' }]);
  await auth.configureInference('one', {});
  assert.deepEqual((await auth.status()).profiles.map(p => p.inferenceOptions), [DEFAULTS, { ...DEFAULTS, cyberAccessProgram: 'daybreak_red' }]);
});

test('invalid inference updates leave account bytes and change notifications untouched', async t => {
  const { store, auth } = await fixture(t);
  let changes = 0; auth.onChange = () => { changes++; };
  const before = await readFile(store.path, 'utf8');
  for (const options of [null, [], 'fast', { serviceTier: 'priority' }, { cyberAccessProgram: 'red' }, { surprise: true }]) {
    await assert.rejects(auth.configureInference('one', options));
  }
  await assert.rejects(auth.configureInference('missing', FAST_BLUE));
  assert.equal(await readFile(store.path, 'utf8'), before);
  assert.equal(changes, 0);
});

test('adapter refreshes account preferences for new requests and preserves existing request options', async t => {
  const { store, auth } = await fixture(t);
  const passthrough = (_model, _context, options) => options;
  const adapter = createAdapter({
    PiAiAdapter: class { constructor(config) { this.config = config; } },
    responses: { stream: passthrough, streamSimple: passthrough }, resolveRetryPolicy: () => ({}),
  }, auth);
  const provider = () => adapter.config.profiles().get(PROVIDER).piProvider;
  const original = provider().stream({}, {}, {});
  assert.equal(original.onPayload({ input: [] }).service_tier, undefined);
  await auth.configureInference('one', FAST_BLUE);
  const fast = provider().streamSimple({}, {}, {});
  assert.equal(fast.onPayload({ input: [] }).service_tier, 'fast');
  assert.deepEqual(fast.onPayload({ input: [] }).access_programs, { cyber: 'daybreak_blue' });
  assert.equal(original.onPayload({ input: [] }).service_tier, undefined);
  assert.equal(original.signal.aborted, false);
  // A second process can change the file without calling this auth instance's onChange.
  await new Store(store.directory).transact(data => { data.profiles[0].inferenceOptions = { serviceTier: 'default', cyberAccessProgram: 'standard' }; });
  const changed = provider().stream({}, {}, {});
  assert.equal(changed.onPayload({ input: [] }).service_tier, 'default');
  assert.deepEqual(changed.onPayload({ input: [] }).access_programs, { cyber: 'standard' });
  assert.equal(fast.onPayload({ input: [] }).service_tier, 'fast');
  assert.equal(fast.signal.aborted, false);
  await auth.select('two');
  const second = provider();
  assert.equal(second.getModels()[0].id, 'model-two');
  assert.equal(second.stream({}, {}, {}).onPayload({ input: [] }).service_tier, undefined);
  assert.equal(second.stream({}, {}, {}).onPayload({ input: [] }).access_programs, undefined);
});

test('401 replay keeps the original inference body even when preferences change during the request', async t => {
  const { store, auth } = await fixture(t), calls = [];
  await auth.configureInference('one', FAST_BLUE);
  let refreshes = 0;
  auth.tokenRequest = async () => {
    refreshes++;
    return { access_token: 'fake-rotated', refresh_token: 'fake-rotated-refresh', token_type: 'Bearer', expires_in: 3600, scope: PLAN_SCOPE };
  };
  auth.fetcher = async input => {
    assert.ok(input instanceof Request);
    calls.push({ body: await input.text(), authorization: input.headers.get('authorization') });
    if (calls.length === 1) {
      await auth.configureInference('one', { serviceTier: 'default', cyberAccessProgram: 'standard' });
      return new Response('unauthorized', { status: 401 });
    }
    return new Response('stream');
  };
  const body = JSON.stringify(planPayload({ input: [] }, FAST_BLUE));
  const response = await auth.fetchInference('one', `${RESOURCE}/responses`, { method: 'POST', body });
  assert.equal(response.status, 200); await response.text();
  assert.equal(refreshes, 1); assert.equal(calls.length, 2);
  assert.equal(calls[0].body, body); assert.equal(calls[1].body, body);
  assert.equal(calls[0].authorization, 'Bearer fake-access-one');
  assert.equal(calls[1].authorization, 'Bearer fake-rotated');
  assert.deepEqual((await store.load()).profiles[0].inferenceOptions, { serviceTier: 'default', cyberAccessProgram: 'standard' });
});

for (const status of [400, 403]) {
  test(`inference HTTP ${status} is returned once without silently retrying downgraded preferences`, async t => {
    const { store, auth } = await fixture(t), calls = [];
    await auth.configureInference('one', FAST_BLUE);
    auth.tokenRequest = () => { throw new Error('An entitlement or request rejection must not refresh authorization'); };
    auth.fetcher = async input => { calls.push(await input.text()); return new Response('selection rejected', { status }); };
    const body = JSON.stringify(planPayload({ input: [] }, FAST_BLUE));
    const response = await auth.fetchInference('one', `${RESOURCE}/responses`, { method: 'POST', body });
    assert.equal(response.status, status); assert.equal(await response.text(), 'selection rejected');
    assert.deepEqual(calls, [body]);
    assert.deepEqual((await store.load()).profiles[0].inferenceOptions, FAST_BLUE);
  });
}

test('inference management endpoint validates options, isolates accounts, and accepts an explicit reset', async t => {
  const { store, auth } = await fixture(t), manager = await startManagement(auth, { port: 0 });
  t.after(() => manager.close());
  const post = data => fetch(manager.origin + '/api/inference', {
    method: 'POST', headers: { Origin: manager.origin, 'Content-Type': 'application/json', 'X-DSH-CSRF': manager.csrf }, body: JSON.stringify(data),
  });
  const accepted = await post({ id: 'one', options: FAST_BLUE });
  assert.equal(accepted.status, 200);
  assert.deepEqual((await accepted.json()).profiles.map(p => p.inferenceOptions), [FAST_BLUE, DEFAULTS]);
  const before = await readFile(store.path, 'utf8');
  for (const invalid of [{ id: 'one' }, { id: 'one', options: null }, { id: 'one', options: [] },
    { id: 'one', options: { serviceTier: 'priority' } }, { id: 'one', options: { cyberAccessProgram: 'daybreak' } },
    { id: 'one', options: { unrecognized: 'auto' } }, { id: 'missing', options: {} }, { options: {} }]) {
    const response = await post(invalid);
    assert.equal(response.status, 400, JSON.stringify(invalid)); await response.text();
    assert.equal(await readFile(store.path, 'utf8'), before);
  }
  const reset = await post({ id: 'one', options: {} });
  assert.equal(reset.status, 200);
  assert.deepEqual((await reset.json()).profiles.map(p => p.inferenceOptions), [DEFAULTS, DEFAULTS]);
});

test('inference management mutations require the existing Host, Origin, and CSRF protections', async t => {
  const { store, auth } = await fixture(t), manager = await startManagement(auth, { port: 0 });
  t.after(() => manager.close());
  const before = await readFile(store.path, 'utf8'), body = JSON.stringify({ id: 'one', options: FAST_BLUE });
  const headers = { Origin: manager.origin, 'Content-Type': 'application/json', 'X-DSH-CSRF': manager.csrf };
  for (const denied of [
    { ...headers, Origin: 'https://untrusted.invalid' }, { ...headers, Origin: 'null' },
    { 'Content-Type': 'application/json', 'X-DSH-CSRF': manager.csrf },
    { ...headers, 'X-DSH-CSRF': 'incorrect' }, { Origin: manager.origin, 'Content-Type': 'application/json' },
  ]) {
    const response = await fetch(manager.origin + '/api/inference', { method: 'POST', headers: denied, body });
    assert.equal(response.status, 403); await response.text();
  }
  const maliciousHost = await new Promise((resolve, reject) => {
    const req = request(manager.origin + '/api/inference', { method: 'POST', headers: { ...headers, Host: 'untrusted.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(body);
  });
  assert.equal(maliciousHost, 403);
  const wrongMethod = await fetch(manager.origin + '/api/inference', { headers });
  assert.equal(wrongMethod.status, 404); await wrongMethod.text();
  assert.equal(await readFile(store.path, 'utf8'), before);
  const desktop = await fetch(manager.origin + '/api/inference', { method: 'POST', headers: { ...headers, Origin: 'dsh-app://app' }, body });
  assert.equal(desktop.status, 200); await desktop.text();
});
