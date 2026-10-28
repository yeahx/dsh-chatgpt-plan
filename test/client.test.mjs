import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script, createContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const endpoint = '/api/chatgpt-plan-config';
const firstConfig = { origin: 'http://127.0.0.1:18762', csrf: 'first-synthetic-csrf' };
const secondConfig = { origin: 'http://127.0.0.1:28762', csrf: 'second-synthetic-csrf' };
const status = { profiles: [], activeProfileId: null, profile: 'test-profile' };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// Execute the published client entry, capturing its actual settings component.
// This models only the hooks it uses; all requests and polling are controlled by
// the test, with no browser, real account, or network connection required.
function mountPanel({ globalConfig, respond }) {
  const hooks = [], timers = new Map(), requests = [];
  let Panel, tree, cursor = 0, mounted = true, lateStateUpdates = 0, timerId = 0;
  let effects = [];
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) };
    },
    useState(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[index].value, update => {
        if (!mounted) { lateStateUpdates++; return; }
        const next = typeof update === 'function' ? update(hooks[index].value) : update;
        if (Object.is(next, hooks[index].value)) return;
        hooks[index].value = next;
        render();
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!hooks[index]) hooks[index] = { ref: { current: initial } };
      return hooks[index].ref;
    },
    useEffect(effect, dependencies) {
      const index = cursor++;
      const previous = hooks[index];
      if (previous && dependencies && previous.dependencies && dependencies.length === previous.dependencies.length
          && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return;
      hooks[index] = { dependencies, cleanup: previous?.cleanup };
      effects.push(() => {
        hooks[index].cleanup?.();
        hooks[index].cleanup = effect();
      });
    },
  };
  function render() {
    cursor = 0;
    tree = Panel();
    const pending = effects;
    effects = [];
    for (const effect of pending) effect();
  }
  const sandbox = {
    URL, AbortController,
    __DSH_CHATGPT_PLAN__: globalConfig,
    fetch: async (input, init = {}) => {
      const call = { url: String(input), init };
      requests.push(call);
      return respond(call);
    },
    setInterval(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { timers.delete(id); },
    __ModuleLoader__: {
      load({ id, factory }) {
        assert.equal(id, 'dsh-chatgpt-plan');
        const plugin = factory(name => {
          assert.equal(name, 'react');
          return React;
        });
        plugin.apply({ slots: {
          inject(name, callback) { assert.equal(name, 'settings.section'); callback(); },
          register(spec, component) { assert.equal(spec.id, 'chatgpt-plan'); Panel = component; },
        } });
      },
    },
  };
  sandbox.window = sandbox;
  new Script(source, { filename: 'client.js' }).runInContext(createContext(sandbox));
  assert.equal(typeof Panel, 'function');
  render();
  return {
    requests,
    get tree() { return tree; },
    get lateStateUpdates() { return lateStateUpdates; },
    get timerCount() { return timers.size; },
    async flush() { await new Promise(resolve => setImmediate(resolve)); },
    async poll() {
      assert.equal(timers.size, 1, 'the mounted panel should have one polling timer');
      const timer = [...timers.values()][0];
      assert.equal(timer.delay, 5000);
      await timer.callback();
      await this.flush();
    },
    unmount() {
      mounted = false;
      for (const hook of hooks) hook?.cleanup?.();
    },
  };
}

function elements(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap(child => elements(child, predicate))];
}
function text(node) {
  if (node == null || node === false) return '';
  if (typeof node !== 'object') return String(node);
  return node.children.map(text).join('');
}
function loginLinks(panel) {
  return elements(panel.tree, node => node.type === 'a' && text(node).includes('Continue with ChatGPT'));
}
function assertNoEmptyLinks(panel) {
  for (const link of elements(panel.tree, node => node.type === 'a')) {
    assert.equal(typeof link.props.href, 'string', `link has no href: ${text(link)}`);
    assert.ok(link.props.href.length > 0, `link has an empty href: ${text(link)}`);
  }
}
function assertStatusRequest(call, config) {
  assert.equal(call.url, config.origin + '/api/status');
  assert.equal(call.init.headers['X-DSH-CSRF'], config.csrf);
}

test('settings discovers a usable login URL without a startup-injected global', async t => {
  const panel = mountPanel({ respond: call => {
    if (call.url === endpoint) return Response.json(firstConfig);
    assertStatusRequest(call, firstConfig);
    return Response.json(status);
  } });
  t.after(() => panel.unmount());
  assert.equal(loginLinks(panel).length, 0);
  assertNoEmptyLinks(panel);
  await panel.flush();
  assert.deepEqual(panel.requests.map(call => call.url), [endpoint, firstConfig.origin + '/api/status']);
  assert.equal(loginLinks(panel).length, 1);
  assert.equal(loginLinks(panel)[0].props.href, firstConfig.origin);
  assert.match(text(panel.tree), /test-profile/);
  assertNoEmptyLinks(panel);
});

test('settings falls back to the startup global when an older host has no config endpoint', async t => {
  const panel = mountPanel({ globalConfig: firstConfig, respond: call => {
    if (call.url === endpoint) return new Response(null, { status: 404 });
    assertStatusRequest(call, firstConfig);
    return Response.json(status);
  } });
  t.after(() => panel.unmount());
  await panel.flush();
  assert.deepEqual(panel.requests.map(call => call.url), [endpoint, firstConfig.origin + '/api/status']);
  assertStatusRequest(panel.requests[1], firstConfig);
  assert.equal(loginLinks(panel)[0]?.props.href, firstConfig.origin);
  assertNoEmptyLinks(panel);
});

test('unready settings disables login and recovers on the next poll', async t => {
  let ready = false;
  const panel = mountPanel({ respond: call => {
    if (call.url === endpoint) return ready ? Response.json(firstConfig) : new Response(null, { status: 503 });
    assert.ok(ready, 'status must not be requested before management is ready');
    assertStatusRequest(call, firstConfig);
    return Response.json(status);
  } });
  t.after(() => panel.unmount());
  await panel.flush();
  assert.equal(loginLinks(panel).length, 0);
  const buttons = elements(panel.tree, node => node.type === 'button' && /Continue with ChatGPT|账号管理/.test(text(node)));
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.disabled, true);
  assert.match(text(panel.tree), /尚未就绪|未就绪|无法|暂不可用|重试|等待/);
  assertNoEmptyLinks(panel);
  assert.deepEqual(panel.requests.map(call => call.url), [endpoint]);
  ready = true;
  await panel.poll();
  assert.equal(loginLinks(panel)[0]?.props.href, firstConfig.origin);
  assert.match(text(panel.tree), /test-profile/);
  assertNoEmptyLinks(panel);
});

test('a status error keeps the discovered login URL usable and recovers on polling', async t => {
  let ready = false;
  const panel = mountPanel({ respond: call => {
    if (call.url === endpoint) return Response.json(firstConfig);
    assertStatusRequest(call, firstConfig);
    return ready ? Response.json(status) : new Response(null, { status: 503 });
  } });
  t.after(() => panel.unmount());
  await panel.flush();
  assert.equal(loginLinks(panel)[0]?.props.href, firstConfig.origin);
  assert.match(text(panel.tree), /无法读取登录状态/);
  assertNoEmptyLinks(panel);
  ready = true;
  await panel.poll();
  assert.match(text(panel.tree), /test-profile/);
  assert.doesNotMatch(text(panel.tree), /无法读取登录状态/);
});

test('polling refreshes the management port and CSRF instead of retaining stale startup values', async t => {
  let config = firstConfig;
  const panel = mountPanel({ globalConfig: firstConfig, respond: call => {
    if (call.url === endpoint) return Response.json(config);
    assertStatusRequest(call, config);
    return Response.json(status);
  } });
  t.after(() => panel.unmount());
  await panel.flush();
  config = secondConfig;
  await panel.poll();
  assert.deepEqual(panel.requests.map(call => call.url), [
    endpoint, firstConfig.origin + '/api/status', endpoint, secondConfig.origin + '/api/status',
  ]);
  assertStatusRequest(panel.requests.at(-1), secondConfig);
  assert.equal(loginLinks(panel)[0]?.props.href, secondConfig.origin);
  assertNoEmptyLinks(panel);
});

for (const pendingRequest of ['config', 'status']) {
  test(`unmount ignores a delayed ${pendingRequest} response and stops polling`, async () => {
    const pending = deferred();
    const panel = mountPanel({ respond: call => {
      if (call.url === endpoint) return pendingRequest === 'config' ? pending.promise : Response.json(firstConfig);
      assertStatusRequest(call, firstConfig);
      return pendingRequest === 'status' ? pending.promise : Response.json(status);
    } });
    await panel.flush();
    assert.equal(panel.requests.length, pendingRequest === 'config' ? 1 : 2);
    const treeBeforeUnmount = panel.tree;
    panel.unmount();
    assert.equal(panel.timerCount, 0);
    pending.resolve(Response.json(pendingRequest === 'config' ? firstConfig : status));
    await panel.flush();
    assert.equal(panel.lateStateUpdates, 0);
    assert.equal(panel.tree, treeBeforeUnmount);
  });
}
