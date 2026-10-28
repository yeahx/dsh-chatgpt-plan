// Requires Playwright and a browser. OAuth is mocked; no real credentials or external requests.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startManagement } from '../management.mjs';
import { ChatGPTAuth, PLAN_SCOPE } from '../oauth.mjs';
import { Store } from '../storage.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const cases = [
  { name: 'add-account', button: 'Continue with ChatGPT', existing: false, newProfile: true, enablePlan: false },
  { name: 'sign-in-again', button: '重新登录', existing: true, newProfile: false, enablePlan: false },
  { name: 'authorize-plan', button: '授权套餐使用', existing: true, newProfile: false, enablePlan: true },
];
const results = [];
try {
  for (const spec of cases) {
    const begins = [], callbacks = [];
    let manager;
    const profile = { id: 'test-profile', email: 'test@example.invalid', clientId: 'synthetic-client', connected: true, planEnabled: false, models: [] };
    const auth = {
      initialize: async () => {},
      status: async () => ({ profiles: spec.existing ? [profile] : [], activeProfileId: spec.existing ? profile.id : null, pending: false }),
      // Keep even redirect destinations on loopback: route interception does
      // not necessarily intercept every hop after a continued request.
      begin: async options => { begins.push(options); return manager.origin + '/?mock-authorization'; },
      callback: async url => { callbacks.push(url.pathname); },
      cancel() {}, requestController: new AbortController(),
    };
    manager = await startManagement(auth, { port: 0 });
    const mockAuthorization = manager.origin + '/?mock-authorization';
    const context = await browser.newContext();
    try {
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(manager.origin + '/')) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      const loaded = page.waitForResponse(r => r.url() === manager.origin + '/api/status');
      const landing = await page.goto(manager.origin);
      assert.equal(landing.headers()['referrer-policy'], 'same-origin');
      await loaded;
      const [post] = await Promise.all([
        page.waitForResponse(r => r.url() === manager.origin + '/oauth/start'),
        page.getByRole('button', { name: spec.button, exact: true }).click(),
      ]);
      assert.equal(post.status(), 303);
      assert.equal(post.headers().location, mockAuthorization);
      assert.equal((await post.request().allHeaders()).origin, manager.origin);
      assert.equal(post.headers()['referrer-policy'], 'no-referrer');
      await page.waitForURL(mockAuthorization);
      assert.equal(await page.title(), 'DeepSeek Harness · ChatGPT 套餐');
      assert.deepEqual(begins, [{ redirectUri: manager.origin + '/auth/callback', profileId: spec.existing ? profile.id : undefined, newProfile: spec.newProfile, enablePlan: spec.enablePlan }]);
      const redirectedHome = page.waitForRequest(r => r.isNavigationRequest() && r.url() === manager.origin + '/');
      const callbackResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/auth/callback');
      await page.goto(manager.origin + '/auth/callback?state=synthetic&code=test-only');
      assert.equal((await callbackResponse).headers()['referrer-policy'], 'no-referrer');
      assert.equal((await (await redirectedHome).allHeaders()).referer, undefined);
      assert.deepEqual(callbacks, ['/auth/callback']);
      assert.equal(page.url(), manager.origin + '/');
      results.push({ case: spec.name, loginStatus: post.status(), callbackReferrerSuppressed: true });
    } finally {
      await context.close();
      manager.close();
    }
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-inference-browser-test-'));
  let manager, context;
  try {
    const store = new Store(directory);
    const defaults = { serviceTier: 'auto', cyberAccessProgram: 'auto' };
    const firstOptions = { serviceTier: 'fast', cyberAccessProgram: 'daybreak_blue' };
    const secondOptions = { serviceTier: 'default', cyberAccessProgram: 'daybreak_red' };
    await store.transact(data => {
      data.activeProfileId = 'first';
      data.profiles = ['first', 'second'].map(id => ({
        id, clientId: 'synthetic-' + id, email: id + '@example.invalid', label: id === 'first' ? '测试账号 A' : '测试账号 B',
        access_token: 'synthetic-access-' + id, expiresAt: Date.now() + 3600000, scopes: [PLAN_SCOPE],
        models: [{ slug: 'synthetic-model', visibility: 'list' }],
      }));
    });
    let rejectSave = false, externalRequests = 0;
    const start = async () => {
      const auth = new ChatGPTAuth({ store: new Store(directory), fetcher: () => {
        externalRequests++;
        throw new Error('Unexpected external request in browser fixture');
      } });
      auth.notice = '此前的登录状态提示。';
      const save = auth.configureInference.bind(auth);
      auth.configureInference = async (id, options) => {
        if (rejectSave) throw new Error('模拟保存失败，请重试。');
        await save(id, options);
      };
      return startManagement(auth, { port: 0 });
    };
    manager = await start();
    context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(manager.origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage();
    const card = id => page.locator('article[data-profile-id="' + id + '"]');
    const speed = id => card(id).getByRole('combobox', { name: '速度', exact: true });
    const daybreak = id => card(id).getByRole('combobox', { name: 'Daybreak', exact: true });
    const open = async () => {
      const loaded = page.waitForResponse(r => r.url() === manager.origin + '/api/status');
      await page.goto(manager.origin);
      await loaded;
      await speed('first').waitFor();
    };
    const values = async id => ({ serviceTier: await speed(id).inputValue(), cyberAccessProgram: await daybreak(id).inputValue() });
    const save = async (id, options) => {
      await speed(id).selectOption(options.serviceTier);
      await daybreak(id).selectOption(options.cyberAccessProgram);
      const refreshed = page.waitForResponse(r => r.url() === manager.origin + '/api/status');
      const [response] = await Promise.all([
        page.waitForResponse(r => r.url() === manager.origin + '/api/inference'),
        card(id).getByRole('button', { name: '保存推理设置', exact: true }).click(),
      ]);
      assert.equal(response.status(), 200);
      assert.deepEqual(response.request().postDataJSON(), { id, options });
      await refreshed;
      await page.getByText('推理设置已保存，仅用于该账号后续请求；服务端支持尚未验证。', { exact: true }).waitFor();
    };
    await open();
    assert.deepEqual(await values('first'), defaults);
    assert.deepEqual(await values('second'), defaults);
    await save('first', firstOptions);
    assert.deepEqual((await store.load()).profiles.find(p => p.id === 'first').inferenceOptions, firstOptions);
    assert.deepEqual(await values('second'), defaults);
    await save('second', secondOptions);
    assert.deepEqual((await store.load()).profiles.find(p => p.id === 'first').inferenceOptions, firstOptions);
    assert.deepEqual((await store.load()).profiles.find(p => p.id === 'second').inferenceOptions, secondOptions);

    // A new auth instance and management server must load the saved settings.
    manager.close();
    manager = await start();
    await open();
    assert.deepEqual(await values('first'), firstOptions);
    assert.deepEqual(await values('second'), secondOptions);
    if (process.env.MANAGEMENT_TEST_SCREENSHOT) await page.screenshot({ path: process.env.MANAGEMENT_TEST_SCREENSHOT, fullPage: true });

    rejectSave = true;
    await speed('first').selectOption('default');
    await daybreak('first').selectOption('standard');
    const [failed] = await Promise.all([
      page.waitForResponse(r => r.url() === manager.origin + '/api/inference'),
      card('first').getByRole('button', { name: '保存推理设置', exact: true }).click(),
    ]);
    assert.equal(failed.status(), 400);
    await page.getByText('模拟保存失败，请重试。', { exact: true }).waitFor();
    assert.deepEqual((await store.load()).profiles.find(p => p.id === 'first').inferenceOptions, firstOptions);
    rejectSave = false;
    await open();
    assert.deepEqual(await values('first'), firstOptions);
    await save('first', defaults);
    assert.deepEqual((await store.load()).profiles.find(p => p.id === 'first').inferenceOptions, defaults);
    assert.deepEqual(await values('second'), secondOptions);
    assert.equal(externalRequests, 0);
    results.push({ case: 'inference-settings', saved: true, restartPersistence: true, accountIsolation: true, failureShown: true, resetDefaults: true, externalRequests });
  } finally {
    await context?.close();
    manager?.close();
    await rm(directory, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ success: true, realBrowser: true, oauth: 'mocked', cases: results }, null, 2));
} finally {
  await browser.close();
}
