import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../storage.mjs';
import { ChatGPTAuth, PLAN_SCOPE } from '../oauth.mjs';
import { createAdapter, PROVIDER } from '../adapter.mjs';
import { Network } from '../network.mjs';
import { PiAiAdapter, responses, llm, networkAgents } from './runtime.mjs';
const directory = await mkdtemp(join(tmpdir(), 'dsh-native-wire-test-'));
const store = new Store(directory), captured = [], requests = [];
const originalFetch = globalThis.fetch;
// Action-specific fields must stay optional. Responses normalizes omitted
// `strict` to strict mode, which otherwise forces resume calls to fill them.
const goalParameters = {
  type: 'object',
  properties: {
    goal_id: { type: 'string' },
    revision: { type: 'number' },
    action: { type: 'string', enum: ['edit', 'pause', 'resume', 'complete', 'blocked'] },
    objective: { type: 'string', description: 'Valid only with action edit.' },
    max_goal_rounds: { type: 'number', description: 'Valid only with action edit.' },
    blocked_reason: { type: 'string', description: 'Required only with action blocked.' },
  },
  required: ['goal_id', 'revision', 'action'],
};
let network, rejectNext401 = true, onUnauthorized, rejectionStatus;
try {
  await store.transact(data => { data.activeProfileId = 'test'; data.profiles = [{ id: 'test', clientId: 'oaiapp_test', access_token: 'fake-for-offline-test', refresh_token: 'fake-refresh', expiresAt: Date.now()+3600000, scopes: [PLAN_SCOPE], models: [{ slug: 'gpt-test', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] }] }]; });
  globalThis.fetch = async (url, options) => {
    const request = new Request(url, options);
    assert.equal(request.url, 'https://api.openai.com/v1/responses');
    const body = await request.text(), params = JSON.parse(body); captured.push(params);
    requests.push({ body, authorization: request.headers.get('authorization') });
    assert.equal(params.store, false); assert.equal(params.stream, true); assert.equal(params.temperature, undefined); assert.equal(params.max_output_tokens, undefined);
    assert.equal(params.tools[0].type, 'namespace'); assert.equal(params.tools[0].tools[0].name, 'echo_probe');
    assert.ok(params.input.every(item => item.role !== 'system'));
    if (rejectNext401) {
      rejectNext401 = false;
      await onUnauthorized?.();
      return new Response('unauthorized', { status: 401 });
    }
    if (rejectionStatus) return Response.json({ error: { message: 'Selected inference option is not available', type: 'invalid_request_error' } }, { status: rejectionStatus });
    const output = [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'WIRE_OK', annotations: [] }] }];
    const events = [
      { type: 'response.created', response: { id: 'resp_test', model: 'gpt-test', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...output[0], status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', item_id: 'msg_test', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: 'WIRE_OK' },
      { type: 'response.output_item.done', output_index: 0, item: output[0] },
      { type: 'response.completed', response: { id: 'resp_test', model: 'gpt-test', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
    ];
    return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  network = new Network({ directory, env: {}, agents: async () => networkAgents });
  await network.initialize();
  const auth = new ChatGPTAuth({ store, fetcher: network.fetch });
  let refreshes = 0;
  auth.tokenRequest = async params => { assert.equal(params.grant_type, 'refresh_token'); refreshes++; return { access_token: `rotated-fake-${refreshes}`, refresh_token: `rotated-refresh-${refreshes}`, token_type: 'Bearer', expires_in: 3600, scope: PLAN_SCOPE }; };
  const adapter = createAdapter({ PiAiAdapter, responses, resolveRetryPolicy: llm.resolveRetryPolicy }, auth);
  const messages = [llm.createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })];
  const args = { provider: PROVIDER, model: 'gpt-test', messages, tools: [
    { name: 'echo_probe', description: 'Echo', parameters: { type: 'object', properties: {} } },
    { name: 'update_goal', description: 'Update the current goal.', parameters: goalParameters },
  ], temperature: 0.1, maxTokens: 50, reasoningEffort: 'low' };
  async function check(rejected = false) {
    let text = '', finish, failure;
    try { for await (const chunk of adapter.stream(args)) { if (chunk.type === 'text-delta') text += chunk.text; if (chunk.type === 'finish') finish = chunk; } }
    catch (error) { failure = error; }
    if (rejected) { assert.ok(failure || finish, 'A rejected request must surface an error'); assert.notEqual(finish?.reason.kind, 'stop'); assert.equal(text, ''); }
    else { if (failure) throw failure; assert.equal(finish?.reason.kind, 'stop', JSON.stringify(finish?.reason)); assert.equal(text, 'WIRE_OK'); }
  }
  function inference(params, serviceTier, cyber) {
    if (serviceTier === undefined) assert.equal(Object.hasOwn(params, 'service_tier'), false);
    else assert.equal(params.service_tier, serviceTier);
    if (cyber === undefined) assert.equal(Object.hasOwn(params, 'access_programs'), false);
    else assert.deepEqual(params.access_programs, { cyber });
  }
  await check(); auth.changed(); await check();
  assert.equal(captured.length, 3); assert.equal(refreshes, 1);
  for (const params of captured) inference(params);

  // A preference saved while a 401 is being handled applies to the next
  // request. The current request must replay its original body unchanged.
  await auth.configureInference('test', { serviceTier: 'fast', cyberAccessProgram: 'daybreak_blue' });
  const replayStart = captured.length;
  rejectNext401 = true;
  onUnauthorized = () => auth.configureInference('test', { serviceTier: 'default', cyberAccessProgram: 'standard' });
  await check(); onUnauthorized = undefined;
  assert.equal(captured.length, replayStart + 2); assert.equal(refreshes, 2);
  inference(captured[replayStart], 'fast', 'daybreak_blue');
  assert.equal(requests[replayStart].body, requests[replayStart + 1].body);
  assert.notEqual(requests[replayStart].authorization, requests[replayStart + 1].authorization);
  await check(); inference(captured.at(-1), 'default', 'standard');
  await auth.configureInference('test', { serviceTier: 'fast', cyberAccessProgram: 'daybreak_red' });
  await check(); inference(captured.at(-1), 'fast', 'daybreak_red');

  // An option rejected by the upstream must never trigger an automatic
  // retry with weaker or omitted options, nor a credential refresh.
  for (const status of [400, 403]) {
    rejectionStatus = status;
    const before = captured.length;
    await check(true);
    assert.equal(captured.length, before + 1, `HTTP ${status} must not be resent`);
    inference(captured.at(-1), 'fast', 'daybreak_red');
    assert.equal(refreshes, 2);
  }
  rejectionStatus = undefined;
  await store.transact(data => { data.profiles.push({ id: 'second', clientId: 'oaiapp_second', access_token: 'fake-b', refresh_token: 'fake-refresh-b', expiresAt: Date.now()+3600000, scopes: [PLAN_SCOPE], models: [{ slug: 'gpt-test-b', visibility: 'list', context_window: 272000, supported_reasoning_levels: [{ effort: 'low' }] }] }); });
  await auth.select('second'); args.model = 'gpt-test-b'; await check();
  assert.equal(captured.at(-1).model, 'gpt-test-b'); inference(captured.at(-1));
  assert.equal(requests.at(-1).authorization, 'Bearer fake-b');
  await auth.configureInference('second', { serviceTier: 'default', cyberAccessProgram: 'daybreak_blue' });
  await check(); inference(captured.at(-1), 'default', 'daybreak_blue');
  await auth.select('test'); args.model = 'gpt-test'; await check();
  inference(captured.at(-1), 'fast', 'daybreak_red');
  await auth.configureInference('test', {});
  await check(); inference(captured.at(-1));
  for (const params of captured) {
    for (const tool of params.tools[0].tools) assert.equal(tool.strict, false, `${tool.name} must explicitly preserve optional parameters`);
    assert.deepEqual(params.tools[0].tools.find(tool => tool.name === 'update_goal').parameters, goalParameters);
  }
  console.log(JSON.stringify({ success: true, nativeDSHAdapter: true, publicEndpoint: true, namespacedTools: true, optionalToolParameters: true, explicitNonStrictTools: true, forbiddenFieldsRemoved: true, streaming: true, accountGenerationRenewal: true, multiAccountModelSwitch: true, forced401Refresh: true, fastAndDaybreakOnWire: true, accountInferenceIsolation: true, inferenceOptionsPreservedOn401: true, noFallbackOn400Or403: true, isolatedNetwork: true, mockedNetwork: true }));
} finally { globalThis.fetch = originalFetch; await network?.close(); await rm(directory, { recursive: true, force: true }); }
