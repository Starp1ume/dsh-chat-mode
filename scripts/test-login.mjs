// 登录行为回归：执行真实 client.js 的事件处理，只使用内存里的假凭据。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const PREF = 'dsh-chat-mode:prefs:v1';
const LOGIN = 'dsh-chat-mode:login:v1';
const FIRST = 'fixture-a';
const SECOND = 'fixture-b';
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const marker = "return { inject: ['slots'], apply };";
assert.equal(source.split(marker).length, 2);
// 只在测试 VM 中暴露入口；生产文件的模块接口保持不变。
const instrumented = source.replace(marker,
  'return { prefs, state, ensureWebview, autoSaveLogin, saveLogin, clearSavedLogin, ChatSettingsPage };');
const flush = () => new Promise(resolve => setImmediate(resolve));

async function setup({ prefs, storage = new Map(), pageToken = '' } = {}) {
  if (prefs !== undefined) storage.set(PREF, JSON.stringify(prefs));
  let loginWrites = 0;
  const handlers = new Map();
  const view = {
    url: 'about:blank', pageToken, reads: 0, reloads: 0, pending: null, rejectReads: false,
    setAttribute(name, value) { if (name === 'src') this.url = value; },
    addEventListener(name, callback) { handlers.set(name, callback); },
    getURL() { return this.url; },
    loadURL(url) { this.url = url; return Promise.resolve(); },
    reload() { this.reloads += 1; },
    executeJavaScript(script) {
      if (script.includes('getItem("userToken")')) {
        this.reads += 1;
        if (this.rejectReads) return Promise.reject(new Error('fixture-read-error'));
        if (this.pending) return this.pending;
      }
      return Promise.resolve(vm.runInNewContext(script, {
        location: { pathname: new URL(this.url).pathname },
        localStorage: {
          getItem: key => { assert.equal(key, 'userToken'); return this.pageToken; },
          setItem: (key, value) => { assert.equal(key, 'userToken'); this.pageToken = value; },
        },
      }));
    },
  };
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: value => [value, () => {}],
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
  let api;
  vm.runInNewContext(instrumented, {
    window: { __ModuleLoader__: { load: definition => { api = definition.factory(() => React); } } },
    document: { createElement: tag => { assert.equal(tag, 'webview'); return view; } },
    dshDesktop: { protocolVersion: 1, browser: {
      acquire: async () => ({ lease: 'fixture-lease', partition: 'fixture-partition' }),
    } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); if (key === LOGIN) loginWrites += 1; },
      removeItem: key => storage.delete(key),
    },
    URL, console, setTimeout: () => 1, clearTimeout: () => {},
  });
  api.ensureWebview({ appendChild(child) { child.parentNode = this; } });
  await flush();
  handlers.get('dom-ready')();
  await flush();
  return {
    api, view, storage,
    get writes() { return loginWrites; },
    saved: () => storage.has(LOGIN) ? JSON.parse(storage.get(LOGIN)) : null,
    async navigate(url = 'https://chat.deepseek.com/', { spa = false, mainFrame = true } = {}) {
      view.url = url;
      if (spa) handlers.get('did-navigate-in-page')({ url, isMainFrame: mainFrame });
      else {
        handlers.get('did-navigate')({ url });
        handlers.get('did-stop-loading')();
      }
      await flush();
    },
    async stopLoading() { handlers.get('did-stop-loading')(); await flush(); },
    async toggleRemember(checked) {
      const stack = [api.ChatSettingsPage()];
      while (stack.length) {
        const node = stack.pop();
        if (node?.type === 'label' && node.children.includes('自动记住登录（只保存 userToken 一项）')) {
          node.children.find(child => child?.type === 'input').props.onChange({ target: { checked } });
          await flush();
          return;
        }
        if (node?.children) stack.push(...node.children.flat());
      }
      assert.fail('Missing remember-login checkbox');
    },
  };
}

test('新安装和缺少该字段的旧设置默认开启，明确关闭的设置保留', async () => {
  assert.equal((await setup()).api.prefs.rememberLogin, true);
  assert.equal((await setup({ prefs: { rememberLast: true } })).api.prefs.rememberLogin, true);
  assert.equal((await setup({ prefs: { rememberLogin: false } })).api.prefs.rememberLogin, false);
});

test('首次在 SPA 中登录后自动保存，登录页本身不保存残留令牌', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate('https://chat.deepseek.com/sign_in');
  assert.equal(s.view.reads, 0);
  await s.navigate('https://chat.deepseek.com/', { spa: true });
  assert.equal(s.saved().token, FIRST);
  assert.equal(s.api.state.login.status, 'saved');
  assert.equal(s.view.reloads, 0);
});

test('普通页面加载也会保存，后续完整导航不会重注入或重载', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  assert.equal(s.saved().token, FIRST);
  await s.navigate('https://chat.deepseek.com/a/session');
  assert.equal(s.view.reloads, 0);
});

test('相同令牌不重复写入，站内导航时保存更新后的令牌', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  await s.navigate('https://chat.deepseek.com/a/one', { spa: true });
  assert.equal(s.writes, 1);
  s.view.pageToken = SECOND;
  await s.navigate('https://chat.deepseek.com/a/two', { spa: true });
  assert.equal(s.writes, 2);
  assert.equal(s.saved().token, SECOND);
});

test('关闭时不读取，已登录页面开启开关后立即自动保存', async () => {
  const s = await setup({ prefs: { rememberLogin: false }, pageToken: FIRST });
  await s.navigate();
  assert.equal(s.view.reads, 0);
  await s.toggleRemember(true);
  assert.equal(s.saved().token, FIRST);
});

test('关闭并清除后不再自动存回，重新开启可保存', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  s.api.clearSavedLogin();
  assert.equal(s.saved(), null);
  assert.equal(JSON.parse(s.storage.get(PREF)).rememberLogin, false);
  await s.navigate('https://chat.deepseek.com/a/session', { spa: true });
  assert.equal(s.saved(), null);
  await s.toggleRemember(true);
  assert.equal(s.saved().token, FIRST);
});

test('读取尚未完成时关闭开关，自动和手动保存都不会把副本存回', async () => {
  for (const manual of [false, true]) {
    const s = await setup();
    let complete;
    s.view.pending = new Promise(resolve => { complete = resolve; });
    if (manual) s.api.saveLogin();
    else await s.navigate();
    await flush();
    s.api.clearSavedLogin();
    complete(FIRST);
    await flush();
    assert.equal(s.saved(), null);
  }
});

test('网页内主动退出清除副本，之后手动重新登录仍会自动保存', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  await s.navigate('https://chat.deepseek.com/sign_in', { spa: true });
  assert.equal(s.saved(), null);
  s.view.pageToken = SECOND;
  await s.navigate('https://chat.deepseek.com/', { spa: true });
  assert.equal(s.saved().token, SECOND);
  assert.equal(s.view.reloads, 0);
});

test('读取期间返回登录页，不重新保存刚刚退出的令牌', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  let complete;
  s.view.pending = new Promise(resolve => { complete = resolve; });
  await s.navigate('https://chat.deepseek.com/a/session', { spa: true });
  await s.navigate('https://chat.deepseek.com/sign_in', { spa: true });
  complete(FIRST);
  await flush();
  assert.equal(s.saved(), null);
});

test('外部站点和非官方配置地址不读取令牌', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate('https://example.com/');
  assert.equal(s.view.reads, 0);
  const custom = await setup({ prefs: { webUrl: 'https://example.com/', webUrlConfirmedHost: 'example.com' }, pageToken: FIRST });
  await custom.navigate();
  assert.equal(custom.view.reads, 0);
});

test('子框架的站内导航不触发自动保存', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate('https://chat.deepseek.com/', { spa: true, mainFrame: false });
  assert.equal(s.view.reads, 0);
});

test('自动保存的副本在新进程中恢复一次，恢复期间不提前保存', async () => {
  const first = await setup({ pageToken: FIRST });
  await first.navigate();
  const next = await setup({ storage: new Map(first.storage) });
  await next.navigate();
  assert.equal(next.view.pageToken, FIRST);
  assert.equal(next.view.reloads, 1);
  assert.equal(next.writes, 0);
  await next.stopLoading();
  assert.equal(next.api.state.login.status, 'restored');
  assert.equal(next.view.reloads, 1);
  assert.equal(next.writes, 0);
});

test('读取失败或空值不覆盖已有副本，事件日志不记录令牌', async () => {
  const s = await setup({ pageToken: FIRST });
  await s.navigate();
  s.view.rejectReads = true;
  await s.navigate('https://chat.deepseek.com/a/session', { spa: true });
  assert.equal(s.saved().token, FIRST);
  s.view.rejectReads = false;
  s.view.pageToken = '';
  await s.navigate('https://chat.deepseek.com/a/session2', { spa: true });
  assert.equal(s.saved().token, FIRST);
  assert.equal(JSON.stringify(s.api.state.events).includes(FIRST), false);
});
