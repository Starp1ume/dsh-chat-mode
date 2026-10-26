// ============================================================================
// 正式版：聊天 / 工作双模式插件（Chat / Work）
//
// 聊天模式：在常驻 overlay 层里用租约 webview 内嵌 DeepSeek 官方网页版
//   （默认 https://chat.deepseek.com/，可在设置页改地址）。聊天模式下本插件
//   **没有任何 API 调用**、不触发 Agent 循环、不做后台请求；页面浏览由官方网页
//   自己完成。工作模式就是 DSH 原生 Agent 界面，只有它调用 API、消耗 token。
//
// 本文件实现：
//   - 标题栏「聊天 / 工作」分段切换（工作模式警示色 + title 提示）
//   - 聊天层常驻保活：只切 display，不卸载 DOM、不重载页面
//   - 聊天模式下遮住 DSH 标题栏左上角「收起侧栏」按钮（被聊天层盖住、点了没效果）
//   - 设置页：默认启动模式、网页版地址（https 校验）、记住上次模式、登录恢复开关、
//     「带入工作」模板
//   - 「带入工作模式」一键：读网页当前选中的文字（只读 getSelection().toString()）→
//     切到工作模式 → 模板 + 选中文字用 setDraft 只填入、不发送；
//     没有选中文字 / 脚本失败时回退到原来的粘贴对话框
//   - 登录恢复（可选，默认关）：只处理 localStorage.userToken 一项，明文存插件
//     localStorage；恢复失败自动清除；详细方案见 research/formal-plan.md §7
//
// 明确不做：
//   - 不读 document.cookie / IndexedDB / 页面 DOM（只执行下面两类固定脚本：
//     登录恢复只读写 userToken；「带入工作」只读 window.getSelection().toString()）
//   - 不分析、不保存用户输入内容；读到的选中文字只放内存、用完即清，不写任何存储
//   - 除上述固定脚本外不调用 executeJavaScript；不保存、不上报任何数据；
//     token / 选中文字不发送到任何地方；无后台轮询或定时请求
// ============================================================================

window.__ModuleLoader__.load({
  id: '@local/dsh-chat-mode',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // ------------------------------------------------------------------
    // 常量（全部公开可审计；网页地址由设置在运行期给出）
    // ------------------------------------------------------------------
    const PREF_KEY = 'dsh-chat-mode:prefs:v1'; // 设置（默认模式/网页地址/记住开关等）
    const LEASE_WORKSPACE = 'dsh-chat-mode'; // 租约的 workspace 键（普通字符串）
    const DEFAULT_WEB_URL = 'https://chat.deepseek.com/'; // 设置页的默认网页地址
    const DEFAULT_MODE = 'chat'; // 默认启动模式：聊天（避免无意消耗 token）

    // 标题栏切换控件的左偏移「兜底值」（px，从窗口左边缘算起）。
    // 正常运行时不再依赖它：控件会实时测量 preload 注入的原生菜单宿主
    // [data-windows-menu] 的右边界，再留出 TITLEBAR_MENU_GAP 的间距。
    // 参考（兜底依据）：菜单栏从 48px 开始，[应用]≈48px + 2px 间隙 + [编辑]≈48px ≈ 146px。
    // 只在量不到菜单宿主时（非 Windows 标题栏 / preload 未注入）才用这个值。
    const TITLEBAR_LEFT_OFFSET = 154;

    // 原生 Windows 菜单宿主选择器（由 preload 的 installWindowsMenu() 注入）。
    // 它的 :host 是 fixed 定位，left 跟随 --dsh-windows-menu-start（展开 48px、收起 84px）。
    const WINDOWS_MENU_SELECTOR = '[data-windows-menu]';

    // 插件控件与原生菜单右边界之间保留的间距（px）。
    const TITLEBAR_MENU_GAP = 8;

    // 聊天模式下把原生菜单左移到这个位置（px），让菜单回到隐藏按钮原来的左边缘，
    // 消除标题栏左侧空白。只覆盖 DSH 的 CSS 变量 --dsh-windows-menu-start，
    // 且只在受控期间生效（html[data-chat-mode-hide-toggle="1"]）；撤销属性后自动恢复
    // DSH 原值（展开 48px、收起 84px）。依赖 DSH 的变量名，改版失效时只是空白回来。
    const CHAT_MODE_MENU_START = 12;

    // 标题栏高度兜底（px）。html 上的 --dsh-windows-titlebar-height 由 preload 设为 40px。
    const TITLEBAR_HEIGHT_FALLBACK = 40;

    // 聊天层顶部下移量（px）：让聊天层不盖住标题栏，并使两个模式的 logo 对齐。
    // 初始值 34 来自用户按截图估算（聊天页 logo y≈30，工作模式 logo y≈64，差 34px）；
    // 不依赖 --dsh-frame-top-clearance，微调时只改这一个常量。
    const CHAT_LAYER_TOP = 34;

    // ------------------------------------------------------------------
    // 聊天模式下隐藏 DSH 标题栏左上角按钮（受控样式，只作用于下列按钮）
    // 展开状态：侧栏开关，aria-label 为「收起侧边栏 / Collapse sidebar」；
    // 收起状态：同一个开关变为「打开侧边栏 / Open sidebar」，标题栏还多一个「新建会话 / New session」图标。
    // 这些按钮没有稳定的 data-* 属性，class 是构建时自动生成的，因此只能按 aria-label 精确匹配；
    // 收起态的新会话图标用 [data-sidebar-collapsed="true"] 限定，避免误隐藏展开态侧栏里的同名按钮。
    // ------------------------------------------------------------------
    // 常量开关：false 时完全不注入样式/属性，按钮保持原样。
    const HIDE_DSH_SIDEBAR_BUTTON = true;
    // 挂在 <html> 上的属性名；聊天层可见时设为 "1"，撤销时移除。
    const DSH_SIDEBAR_HIDE_ATTR = 'data-chat-mode-hide-toggle';
    // 注入 <head> 的受控样式：只隐藏这些按钮（仍占位，不影响标题栏布局），并把标题栏原生菜单左移，
    // 消除隐藏按钮左侧的空白。两条规则挂在同一个 <style> 里，随受控属性一起撤销。
    // 菜单左移只覆盖 --dsh-windows-menu-start（DSH 用它给 preload 菜单宿主设 left），
    // 切换条仍按「菜单右边界 + 8px」动态测量，所以两者会一起移动、不会重叠。
    const DSH_SIDEBAR_HIDE_CSS =
      [
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="收起侧边栏"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="Collapse sidebar"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="打开侧边栏"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] button[aria-label="Open sidebar"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] [data-sidebar-collapsed="true"] button[aria-label="新建会话"]',
        'html[' + DSH_SIDEBAR_HIDE_ATTR + '="1"] [data-sidebar-collapsed="true"] button[aria-label="New session"]',
      ].join(', ') +
      ' { visibility: hidden !important; pointer-events: none !important; }' +
      '\nhtml[' + DSH_SIDEBAR_HIDE_ATTR + '="1"][data-windows-titlebar] { --dsh-windows-menu-start: ' +
      CHAT_MODE_MENU_START + 'px !important; }';

    // ------------------------------------------------------------------
    // 「带入工作」一键带入（读取网页中选中的文字）
    // ------------------------------------------------------------------
    const BRING_SELECTION_MAX_CHARS = 20000; // 选中文字上限（超出截断并在界面提示）
    const DEFAULT_BRING_TEMPLATE = '以下是我在网页聊天里得出的要点，请整理并记住：\n\n';

    // ------------------------------------------------------------------
    // 登录恢复（正式功能，可选，仅限 userToken 一项）
    // ------------------------------------------------------------------
    // 保存位置：插件自己的 localStorage 键（dsh-app://app/ 源）。明文 JSON：
    //   { v: 1, token: "<不透明字符串>", savedAt: <毫秒时间戳> }
    const LOGIN_KEY = 'dsh-chat-mode:login:v1';
    // 只允许在官方聊天站点 origin 下读写 localStorage.userToken。
    const CHAT_ORIGIN = 'https://chat.deepseek.com';

    // 所有 executeJavaScript 的脚本都是写死的字符串常量；token 值只作为「数据」传入
    // （JSON.stringify 后写进模板的数据位），不拼接成可执行代码。
    // 只读 userToken：
    const SCRIPT_READ_USER_TOKEN =
      '(() => { try { const value = localStorage.getItem("userToken"); ' +
      'return typeof value === "string" ? value : ""; } catch (error) { return ""; } })()';
    // 写回 userToken：前缀 + JSON.stringify(token) + 后缀；脚本结构固定、token 只是数据。
    const SCRIPT_WRITE_USER_TOKEN_PREFIX = '(() => { try { const token = ';
    const SCRIPT_WRITE_USER_TOKEN_SUFFIX =
      '; if (typeof token !== "string" || token.length === 0) return false; ' +
      'localStorage.setItem("userToken", token); return true; } catch (error) { return false; } })()';
    // 只读 location.pathname（判断恢复后是否仍在登录页）：
    const SCRIPT_READ_PATHNAME =
      '(() => { try { return location.pathname || ""; } catch (error) { return ""; } })()';
    // 只读用户当前选中的文字（window.getSelection().toString()）：不读 DOM 其他内容、
    // 不读输入框/聊天记录；只在用户点击「带入工作」且页面 origin 完全等于官方站点时执行。
    const SCRIPT_READ_SELECTION =
      '(() => { try { const selection = window.getSelection(); ' +
      'return String(selection ? selection.toString() : ""); } catch (error) { return ""; } })()';

    // 只用已确认存在的主题变量（getComputedStyle 检查结果显示在诊断面板），并带同色系兜底，
    // 避免深字配深底：bg-base 与 label-primary 是成对的中性色，border 用于区分边界。
    const BORDER_COLOR = 'var(--dsw-alias-border, rgba(128,128,128,.45))';
    const LABEL_COLOR = 'var(--dsw-alias-label-primary, #111)';

    // ------------------------------------------------------------------
    // 设置（localStorage 持久化；读不出/损坏时逐字段回落默认值）
    // ------------------------------------------------------------------
    const prefs = {
      defaultMode: DEFAULT_MODE, // 'chat' | 'work'：不记住上次模式时的启动模式
      webUrl: DEFAULT_WEB_URL, // 网页版地址（https + 无凭据校验后保存）
      webUrlConfirmedHost: null, // 非 deepseek.com 域名：用户二次确认过的 hostname（否则不放行）
      rememberLast: false, // 是否记住上次使用的模式
      rememberLogin: false, // 是否记住登录（默认关；只处理 userToken）
      lastMode: 'chat', // 内部值：上次模式（rememberLast 开启时使用）
      diagOpen: false, // 诊断面板是否展开（仅本地界面偏好）
      bringTemplate: DEFAULT_BRING_TEMPLATE, // 「带入工作」一键带入时加在选中文字前的模板
    };

    function normalizeWebUrl(value) {
      if (typeof value !== 'string') return null;
      const text = value.trim();
      if (!text) return null;
      try {
        const url = new URL(text);
        if (url.protocol !== 'https:' || !url.hostname) return null;
        // 拒绝带用户名/密码的地址（https://user:pass@host/ 形式）
        if (url.username || url.password) return null;
        return url.toString();
      } catch {
        return null;
      }
    }

    // 默认只放行 deepseek.com 及其子域名；其他域名需要用户在设置页二次确认
    function isDeepseekHost(hostname) {
      return (
        typeof hostname === 'string' &&
        (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'))
      );
    }

    // loadURL 之前的运行时二次校验（存储值可能被其他脚本改过）：
    // 必须是 https、无凭据；非 deepseek 域名必须在设置页被用户二次确认过。
    // 任一条件不满足就回退默认地址，绝不加载未确认的地址。
    function effectiveChatUrl() {
      const normalized = normalizeWebUrl(prefs.webUrl);
      if (!normalized) return DEFAULT_WEB_URL;
      try {
        const host = new URL(normalized).hostname;
        if (isDeepseekHost(host)) return normalized;
        if (prefs.webUrlConfirmedHost === host) return normalized;
      } catch {
        return DEFAULT_WEB_URL;
      }
      return DEFAULT_WEB_URL;
    }

    function loadPrefs() {
      let raw = null;
      try {
        raw = globalThis.localStorage?.getItem(PREF_KEY);
      } catch {
        raw = null;
      }
      if (!raw) return;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return;
      }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.defaultMode === 'chat' || parsed.defaultMode === 'work') {
        prefs.defaultMode = parsed.defaultMode;
      }
      const webUrl = normalizeWebUrl(parsed.webUrl);
      if (webUrl) prefs.webUrl = webUrl;
      const confirmedHost = parsed.webUrlConfirmedHost;
      prefs.webUrlConfirmedHost =
        typeof confirmedHost === 'string' && /^[a-z0-9.-]{1,253}$/.test(confirmedHost)
          ? confirmedHost
          : null;
      prefs.rememberLast = parsed.rememberLast === true;
      prefs.rememberLogin = parsed.rememberLogin === true;
      prefs.lastMode = parsed.lastMode === 'work' ? 'work' : 'chat';
      prefs.diagOpen = parsed.diagOpen === true;
      if (typeof parsed.bringTemplate === 'string') {
        // 模板只做长度上限保护（不解释内容）；空字符串是合法值（= 不加前缀）
        prefs.bringTemplate = parsed.bringTemplate.slice(0, 4000);
      }
    }

    function savePrefs(patch) {
      if (patch && typeof patch === 'object') Object.assign(prefs, patch);
      try {
        globalThis.localStorage?.setItem(PREF_KEY, JSON.stringify(prefs));
      } catch {
        // 偏好保存失败不影响功能
      }
    }

    // 启动模式：不记住上次模式 → 默认启动模式；记住 → 上次模式（兜底 chat）
    function resolveStartMode() {
      if (prefs.rememberLast) return prefs.lastMode === 'work' ? 'work' : 'chat';
      return prefs.defaultMode === 'work' ? 'work' : 'chat';
    }

    loadPrefs();

    // ------------------------------------------------------------------
    // 模块级状态（插件卸载即销毁；持久化只发生在 prefs / LOGIN_KEY）
    // ------------------------------------------------------------------
    let version = 0;
    const listeners = new Set();
    const state = {
      mode: resolveStartMode(), // 'chat' | 'work'
      bridge: 'unknown', // unknown | ok | missing
      phase: 'idle', // idle | acquiring | created | loading | ready | failed | no-bridge
      lease: '-',
      partition: '-',
      error: '',
      inspecting: false,
      diagOpen: prefs.diagOpen, // 诊断面板默认隐藏
      geometry: null,
      counters: { domReady: 0, start: 0, stop: 0, navigate: 0, navigateInPage: 0, fail: 0, gone: 0 },
      // 加载遮罩：消除登录恢复时的登录页闪烁；首个页面稳定/恢复结束后撤掉
      mask: true,
      // 「带入工作模式」对话框
      bring: {
        open: false,
        text: '',
        busy: false,
        error: '',
        notice: '',
        toast: '', // 一键带入的短暂提示（例如"已截断到 20000 字"），只显示固定文字
      },
      // 登录恢复状态（只用于显示状态与长度，绝不保存/显示 token 值本身）
      login: {
        saved: false, // 插件自己的 localStorage 里是否存在已保存副本
        savedLength: 0, // 已保存 token 的长度（仅用于显示"已保存（长度 N）"）
        savedAt: 0, // 保存时间（毫秒），仅用于显示日期
        status: 'idle', // idle | saved | cleared | restoring | restored | still-login | error
        error: '', // 只放通用描述，不放任何数据/异常原文
      },
      events: [],
    };

    let element = null; // <webview> 元素；插件卸载前一直保留
    let lease = null; // { lease, partition }
    let bridge = null; // window.dshDesktop.browser
    let loadIssued = false;
    let inspectTimer = null;
    let hostContainer = null;
    let maskTimer = null; // 加载遮罩兜底定时器（8 秒）
    let toastTimer = null; // 「带入工作」简短提示的自动清除定时器

    // ------------------------------------------------------------------
    // 登录恢复的存储（token 只在内存里；持久化只在 LOGIN_KEY，明文、单键）
    // ------------------------------------------------------------------
    let savedUserToken = null; // 从插件 localStorage 读出的 userToken（不透明字符串）
    let savedTokenAt = 0; // 保存时间（毫秒）
    let restoreAttempted = false; // 本次 webview 生命周期内是否已尝试恢复
    let restoreReloaded = false; // 是否已为恢复写回并触发过一次 reload
    let loggedOutThisRun = false; // 本次运行内检测到用户主动退出后，不再自动恢复
    // 退出检测的启用条件：本次运行内已确认登录（恢复成功，或用户本次点击「保存登录」成功）。
    // 启动时仅从存储载入副本不算确认登录，因此登录页先闪一下的那次导航不会误清副本。
    let loginConfirmedThisRun = false;

    function readLoginStore() {
      let raw = null;
      try {
        raw = globalThis.localStorage?.getItem(LOGIN_KEY);
      } catch {
        return null;
      }
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.token !== 'string' || parsed.token.length === 0) return null;
        return { token: parsed.token, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
      } catch {
        return null;
      }
    }

    function writeLoginStore(token) {
      try {
        const savedAt = Date.now();
        globalThis.localStorage?.setItem(
          LOGIN_KEY,
          JSON.stringify({ v: 1, token, savedAt }),
        );
        return savedAt;
      } catch {
        return 0;
      }
    }

    function clearLoginStore() {
      try {
        globalThis.localStorage?.removeItem(LOGIN_KEY);
      } catch {
        // 删除失败也继续清空内存状态
      }
    }

    function readStoredToken() {
      const entry = readLoginStore();
      return entry ? entry.token : null;
    }

    // 启动时只把"是否存在/长度/时间"同步到界面状态；值本身留在内存变量里。
    // 注意：这里不改变 state.login.status（启动后仍为初始值 idle），
    // 退出检测也不依赖 status，而是依赖 loginConfirmedThisRun（见下）。
    function refreshLoginState() {
      const entry = readLoginStore();
      savedUserToken = entry ? entry.token : null;
      savedTokenAt = entry ? entry.savedAt : 0;
      state.login.saved = savedUserToken !== null;
      state.login.savedLength = savedUserToken ? savedUserToken.length : 0;
      state.login.savedAt = savedTokenAt;
    }

    function isChatOrigin(url) {
      try {
        return new URL(url).origin === CHAT_ORIGIN;
      } catch {
        return false;
      }
    }

    function isSignInPathname(url) {
      try {
        return new URL(url).pathname.indexOf('/sign_in') === 0;
      } catch {
        return false;
      }
    }

    // 退出检测：只用导航事件自带的 URL（不执行页面脚本、不读页面存储）。
    // 仅当本次运行内已确认登录后才启用，避免恢复流程/首次加载的登录页被误判为"主动退出"。
    function handleSignInNavigation(url) {
      if (!loginConfirmedThisRun) return false;
      if (restoreReloaded) return false; // 恢复写回触发的 reload 过程不算主动退出
      if (!url || !isSignInPathname(url)) return false;
      loggedOutThisRun = true;
      loginConfirmedThisRun = false;
      dropSavedLogin('检测到已退出登录');
      return true;
    }

    // 当前有效的聊天地址：运行时再校验一次（https/无凭据/deepseek 或已确认域名），否则回落默认地址
    function currentChatUrl() {
      return effectiveChatUrl();
    }

    // 登录恢复只对官方 chat.deepseek.com 生效（换自定义地址时不碰登录令牌）
    function isOfficialChatSite() {
      try {
        return new URL(currentChatUrl()).origin === CHAT_ORIGIN;
      } catch {
        return false;
      }
    }

    // 开关关闭时不保留副本（满足"开关关闭时清除已保存的副本"）
    if (!prefs.rememberLogin) clearLoginStore();
    refreshLoginState();

    // 清理第一段 spike 插件遗留的两个自有键（只删键、不读值、不碰其他键；
    // 其中 userToken 是明文登录副本，删除有安全收益）。
    try {
      globalThis.localStorage?.removeItem('dsh-webview-spike:mode:v1');
      globalThis.localStorage?.removeItem('dsh-webview-spike:userToken:v1');
    } catch {
      // 清理失败不影响功能
    }

    // ------------------------------------------------------------------
    // 小工具
    // ------------------------------------------------------------------
    // 只有「记住上次模式」开启时 lastMode 才参与启动决策；始终记录以便开关切换
    function saveMode(mode) {
      savePrefs({ lastMode: mode === 'work' ? 'work' : 'chat' });
    }

    function now() {
      try {
        return new Date().toLocaleTimeString('zh-CN', { hour12: false });
      } catch {
        return '--:--:--';
      }
    }

    function firstLine(error) {
      const text = error && typeof error.message === 'string' ? error.message : String(error);
      return text.split('\n')[0].slice(0, 180);
    }

    function notify() {
      version += 1;
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // 单个订阅者异常不影响其他订阅者
        }
      }
    }

    function subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }

    function useSpike() {
      return React.useSyncExternalStore(subscribe, () => version);
    }

    function record(name, detail) {
      const label = detail ? name + ' (' + detail + ')' : name;
      state.events = [{ at: now(), label }, ...state.events].slice(0, 8);
      notify();
    }

    function switchMode(mode) {
      if (mode !== 'chat' && mode !== 'work') return;
      if (state.mode === mode) return;
      state.mode = mode;
      saveMode(mode);
      record(mode === 'chat' ? '切换 → 聊天模式' : '切换 → 工作模式');
      notify();
    }

    function toggleDiag() {
      state.diagOpen = !state.diagOpen;
      savePrefs({ diagOpen: state.diagOpen });
      notify();
    }

    function resetCounters() {
      state.counters = { domReady: 0, start: 0, stop: 0, navigate: 0, navigateInPage: 0, fail: 0, gone: 0 };
      state.events = [];
      record('计数已重置');
    }

    // ------------------------------------------------------------------
    // 「带入工作模式」：只填入、不发送（发送由用户自己决定）
    // ------------------------------------------------------------------
    // composer 桥：注册在 conversation.composer.dock（session 作用域）的无 UI 组件
    // 会通过标准 prop 收到 inputActions（setDraft / insertText / submit 等），
    // 这里只把 actions 存到模块变量，供标题栏按钮调用；绝不调用 submit。
    let composerBridge = { sessionId: null, actions: null };

    function openBringDialog(notice) {
      state.bring.open = true;
      state.bring.busy = false;
      state.bring.error = '';
      state.bring.notice = typeof notice === 'string' ? notice : '';
      // 对话框默认空文本框；剪贴板只在用户点击「读取剪贴板」时读取一次
      state.bring.text = '';
      notify();
    }

    // 仅在用户点击「读取剪贴板」按钮时调用；读到的内容只放进可编辑文本框，不自动填入、不发送。
    function readClipboardIntoDialog() {
      let clipboard = null;
      try {
        clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      } catch {
        clipboard = null;
      }
      if (!clipboard || typeof clipboard.readText !== 'function') {
        state.bring.notice = '当前环境无法读取剪贴板，请手动粘贴到下方文本框';
        notify();
        return;
      }
      Promise.resolve(clipboard.readText())
        .then((text) => {
          if (typeof text === 'string' && text.length > 0) {
            state.bring.text = text.slice(0, 8000);
            state.bring.notice = '已读取剪贴板，请检查/编辑后再点「确认带入（不发送）」';
          } else {
            state.bring.notice = '剪贴板为空，请手动输入或粘贴';
          }
          notify();
        })
        .catch(() => {
          state.bring.notice = '无法读取剪贴板，请手动粘贴到下方文本框';
          notify();
        });
    }

    function closeBringDialog() {
      state.bring.open = false;
      state.bring.busy = false;
      state.bring.error = '';
      state.bring.notice = '';
      notify();
    }

    // 只调用 setDraft 填入草稿；不调用 submit / 不发送。
    function fillWorkDraft(text) {
      const actions = composerBridge.actions;
      if (!actions || typeof actions.setDraft !== 'function') return 'no-session';
      try {
        actions.setDraft(text);
        return 'ok';
      } catch {
        return 'failed';
      }
    }

    function submitBring() {
      if (state.bring.busy) return;
      const text = typeof state.bring.text === 'string' ? state.bring.text.trim() : '';
      if (!text) {
        state.bring.error = '内容为空：请先输入，或从聊天页里选中文字后复制再粘贴';
        notify();
        return;
      }
      state.bring.busy = true;
      state.bring.error = '';
      notify();
      // 先切到工作模式，让输入框可见（切换只是 display 变化，不会重载任何页面）
      if (state.mode !== 'work') switchMode('work');
      // 给 React 一次提交/挂载的时机，再尝试填入
      setTimeout(() => {
        const result = fillWorkDraft(text);
        state.bring.busy = false;
        if (result === 'ok') {
          record('已把内容填入工作模式输入框（未发送）');
          closeBringDialog();
          return;
        }
        state.bring.error =
          result === 'no-session'
            ? '工作模式还没有打开的会话：请先在「工作」里新建或打开一个会话，再重新点「带入工作」。'
            : '填入失败：输入框暂时不可用，请重试或手动粘贴到输入框。';
        notify();
      }, 120);
    }

    // 一键带入的短暂提示（只显示固定文字；6 秒后自动消失）
    function showBringToast(text) {
      if (toastTimer) clearTimeout(toastTimer);
      state.bring.toast = typeof text === 'string' ? text : '';
      notify();
      toastTimer = setTimeout(() => {
        toastTimer = null;
        state.bring.toast = '';
        notify();
      }, 6000);
    }

    // 一键带入：用户点击「带入工作」时调用。
    // 只在官方 origin（完全相等）的 webview 上、由用户点击触发执行固定脚本；
    // 读到的选中文字只放内存，填入后立即丢弃，不写存储、不打印内容。
    function startBringFromSelection() {
      if (state.bring.busy) return;
      const view = element;
      let currentUrl = '';
      try {
        currentUrl = view && typeof view.getURL === 'function' ? view.getURL() : '';
      } catch {
        currentUrl = '';
      }
      if (!view || typeof view.executeJavaScript !== 'function' || !isChatOrigin(currentUrl)) {
        openBringDialog(
          '当前没有可用的官方聊天页面（或 webview 尚未创建）：未读取选中文字，请手动粘贴到下方文本框。',
        );
        return;
      }
      state.bring.busy = true;
      notify();
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_SELECTION))
        .then((raw) => {
          state.bring.busy = false;
          const selection = typeof raw === 'string' ? raw : '';
          if (!selection.trim()) {
            openBringDialog(
              '没有读到选中的文字：请先在网页里选中文字再点「带入工作」；也可以手动粘贴到下方文本框。',
            );
            return;
          }
          let text = selection;
          let truncated = false;
          if (text.length > BRING_SELECTION_MAX_CHARS) {
            text = text.slice(0, BRING_SELECTION_MAX_CHARS);
            truncated = true;
          }
          const template =
            typeof prefs.bringTemplate === 'string' ? prefs.bringTemplate : DEFAULT_BRING_TEMPLATE;
          deliverBringText(template + text, text.length, truncated);
        })
        .catch(() => {
          state.bring.busy = false;
          openBringDialog('读取选中文字失败：请手动粘贴到下方文本框。');
        });
    }

    // 把「模板 + 选中文字」只填入工作模式输入框（不发送）；失败时回退到原对话框并给原提示。
    function deliverBringText(composed, chars, truncated) {
      state.bring.busy = true;
      if (state.mode !== 'work') switchMode('work');
      setTimeout(() => {
        const result = fillWorkDraft(composed);
        state.bring.busy = false;
        if (result === 'ok') {
          // 只记录固定文字与字数；正文立即丢弃（不写存储、不打印）
          record('已带入选中文字（' + chars + ' 字，未发送）');
          if (truncated) {
            showBringToast(
              '选中文字超过 ' +
                BRING_SELECTION_MAX_CHARS +
                ' 字，已截断到 ' +
                BRING_SELECTION_MAX_CHARS +
                ' 字',
            );
          }
          if (state.bring.open) closeBringDialog();
          notify();
          return;
        }
        openBringDialog('');
        state.bring.error =
          result === 'no-session'
            ? '工作模式还没有打开的会话：请先在「工作」里新建或打开一个会话，再重新点「带入工作」。'
            : '填入失败：输入框暂时不可用，请重试或手动粘贴到输入框。';
        state.bring.text = composed;
        notify();
      }, 120);
    }

    function ComposerBridge(props) {
      const actions = props && props.inputActions;
      const sessionId = props && props.sessionId;
      React.useEffect(() => {
        composerBridge = { sessionId: sessionId || null, actions: actions || null };
        return () => {
          if (composerBridge.actions === (actions || null)) {
            composerBridge = { sessionId: null, actions: null };
          }
        };
      }, [actions, sessionId]);
      return null;
    }

    function refreshGeometry() {
      const layer = hostContainer
        ? hostContainer.closest('[data-chat-layer]')
        : null;
      const rect = layer ? layer.getBoundingClientRect() : null;
      let clearance = '';
      try {
        clearance = getComputedStyle(document.documentElement)
          .getPropertyValue('--dsh-frame-top-clearance')
          .trim();
      } catch {
        clearance = '';
      }
      state.geometry = {
        layer: rect
          ? {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            }
          : null,
        viewport: { w: globalThis.innerWidth, h: globalThis.innerHeight },
        clearance: clearance || '(未定义)',
        chatVisible: state.mode === 'chat',
        chatWidth: element ? Math.round(element.getBoundingClientRect().width) : 0,
        chatHeight: element ? Math.round(element.getBoundingClientRect().height) : 0,
      };
      notify();
    }

    function startInspect() {
      if (state.mode !== 'chat') return;
      if (inspectTimer) clearTimeout(inspectTimer);
      state.inspecting = true;
      refreshGeometry();
      record('覆盖检查：聊天层半透明 3 秒');
      inspectTimer = setTimeout(() => {
        inspectTimer = null;
        state.inspecting = false;
        notify();
      }, 3000);
    }

    // ------------------------------------------------------------------
    // webview 生命周期：acquire → 创建元素 → 挂事件 → 首次 dom-ready 后 loadURL
    // ------------------------------------------------------------------
    function releaseWebview() {
      if (inspectTimer) {
        clearTimeout(inspectTimer);
        inspectTimer = null;
      }
      if (element) {
        try {
          if (element.parentNode) element.parentNode.removeChild(element);
        } catch {
          // 忽略清理异常
        }
        element = null;
      }
      if (bridge && lease) {
        try {
          Promise.resolve(bridge.release(lease.lease)).catch(() => {});
        } catch {
          // 忽略释放异常
        }
      }
      lease = null;
      bridge = null;
      loadIssued = false;
      // 新 webview 生命周期：允许再次尝试一次登录恢复（savedUserToken 保留在插件 localStorage）
      restoreAttempted = false;
      restoreReloaded = false;
      // 下一轮加载前先盖住，避免重建过程中露出登录页/空白页
      state.mask = true;
      if (maskTimer) {
        clearTimeout(maskTimer);
        maskTimer = null;
      }
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      state.bring.toast = '';
    }

    function retryWebview() {
      if (element) return;
      releaseWebview();
      state.phase = 'idle';
      state.bridge = 'unknown';
      state.error = '';
      state.lease = '-';
      state.partition = '-';
      notify();
      if (hostContainer) ensureWebview(hostContainer);
    }

    // ------------------------------------------------------------------
    // 登录恢复（正式功能，可选，仅限 userToken 一项；默认关闭）
    // ------------------------------------------------------------------
    // 说明：token 视为不透明字符串，不打印、不记录、不上报；只写进插件自己的
    // localStorage 键 LOGIN_KEY（明文，设置页有风险提示），只写回官方站点页面的
    // localStorage.userToken，不读 cookie / IndexedDB / 页面 DOM。
    // 脚本结构固定，token 只经 JSON.stringify 写进数据位（不是可执行代码拼接）。
    function writeTokenScript(token) {
      return (
        SCRIPT_WRITE_USER_TOKEN_PREFIX + JSON.stringify(token) + SCRIPT_WRITE_USER_TOKEN_SUFFIX
      );
    }

    function clearMask() {
      if (maskTimer) {
        clearTimeout(maskTimer);
        maskTimer = null;
      }
      if (state.mask) {
        state.mask = false;
        notify();
      }
    }

    // 清除已保存副本（token 无效/用户主动退出时调用），静默、不显示 token 值。
    function dropSavedLogin(reason) {
      clearLoginStore();
      savedUserToken = null;
      savedTokenAt = 0;
      state.login.saved = false;
      state.login.savedLength = 0;
      state.login.savedAt = 0;
      state.login.status = 'still-login';
      state.login.error = '';
      loginConfirmedThisRun = false;
      clearMask();
      record('已清除已保存的登录副本' + (reason ? '（' + reason + '）' : ''));
      notify();
    }

    // 仅在「webview 首次加载到聊天站点」后尝试一次恢复，不重试、不循环。
    function maybeRestoreLogin(view) {
      if (!view || restoreAttempted) return;
      if (!prefs.rememberLogin) return; // 开关关闭：不恢复
      if (loggedOutThisRun) return; // 本次运行已检测到主动退出：不再自动恢复
      if (!isOfficialChatSite()) return; // 自定义地址：不碰官方站点的登录令牌
      if (typeof view.executeJavaScript !== 'function') return;
      if (!savedUserToken) return;
      const currentUrl = typeof view.getURL === 'function' ? view.getURL() : '';
      if (!isChatOrigin(currentUrl)) return;
      restoreAttempted = true;
      state.login.status = 'restoring';
      state.mask = true; // 恢复期间保持遮罩，消除登录页闪烁
      record('登录恢复：检测到已保存 token，尝试写回');
      notify();
      Promise.resolve()
        .then(() => view.executeJavaScript(writeTokenScript(savedUserToken)))
        .then((ok) => {
          if (ok !== true) {
            dropSavedLogin('写回未生效');
            return;
          }
          restoreReloaded = true;
          record('登录恢复：写回完成，重新加载一次');
          try {
            view.reload();
          } catch {
            restoreReloaded = false;
            dropSavedLogin('重新加载失败');
          }
        })
        .catch(() => {
          // 静默：不显示错误细节、不影响其它功能
          dropSavedLogin('执行失败');
        });
    }

    // 保存时机之三：恢复成功后刷新已保存副本（站点可能轮换/刷新了 token）。
    function refreshSavedTokenAfterRestore(view) {
      if (!prefs.rememberLogin) return;
      if (typeof view.executeJavaScript !== 'function') return;
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_USER_TOKEN))
        .then((token) => {
          if (typeof token !== 'string' || token.length === 0) return;
          if (token === savedUserToken) return; // 未变化：不重复写
          const savedAt = writeLoginStore(token);
          if (savedAt <= 0) return;
          savedUserToken = token;
          savedTokenAt = savedAt;
          state.login.saved = true;
          state.login.savedLength = token.length;
          state.login.savedAt = savedAt;
          record('登录恢复：已更新保存副本（长度 ' + token.length + '）');
          notify();
        })
        .catch(() => {
          // 静默：更新副本失败不影响使用
        });
    }

    // 恢复写回并 reload 后，只读 location.pathname 判断是否仍在登录页。
    function checkLoginPageResult(view) {
      if (!view) return;
      if (!restoreReloaded) {
        // 恢复进行中（写回还没完成）：保持遮罩，不做判断
        if (state.login.status === 'restoring') return;
        // 非恢复流程的普通加载完成：撤掉遮罩
        clearMask();
        return;
      }
      restoreReloaded = false;
      if (typeof view.executeJavaScript !== 'function') {
        dropSavedLogin('页面不可用');
        return;
      }
      Promise.resolve()
        .then(() => view.executeJavaScript(SCRIPT_READ_PATHNAME))
        .then((pathname) => {
          const stillLogin = typeof pathname === 'string' && pathname.indexOf('/sign_in') === 0;
          if (stillLogin) {
            state.login.status = 'still-login';
            dropSavedLogin('恢复后仍在登录页');
            return;
          }
          state.login.status = 'restored';
          loginConfirmedThisRun = true; // 本次运行内确认已登录 → 之后才启用退出检测
          clearMask();
          record('登录恢复：已恢复');
          notify();
          // 恢复成功后刷新已保存副本（token 可能被站点轮换）
          refreshSavedTokenAfterRestore(view);
        })
        .catch(() => {
          dropSavedLogin('路径检查失败');
        });
    }

    // 「保存登录」：只在用户点击时执行；只读 localStorage.userToken 一项。
    function saveLogin() {
      if (!prefs.rememberLogin) {
        state.login.status = 'error';
        state.login.error = '请先在「设置 → 聊天模式」中开启「记住登录」';
        record('保存登录：开关未开启，已拒绝');
        notify();
        return;
      }
      if (!element || typeof element.executeJavaScript !== 'function') {
        state.login.status = 'error';
        state.login.error = 'webview 尚未创建或不可用';
        record('保存登录：webview 不可用');
        notify();
        return;
      }
      const currentUrl = typeof element.getURL === 'function' ? element.getURL() : '';
      if (!isChatOrigin(currentUrl)) {
        state.login.status = 'error';
        state.login.error = '当前不在 chat.deepseek.com，已拒绝保存';
        record('保存登录：origin 不符，已拒绝');
        notify();
        return;
      }
      record('保存登录：读取 userToken（只读一项）');
      Promise.resolve()
        .then(() => element.executeJavaScript(SCRIPT_READ_USER_TOKEN))
        .then((token) => {
          if (typeof token !== 'string' || token.length === 0) {
            state.login.status = 'error';
            state.login.error = '页面中没有可读取的 userToken（可能尚未登录）';
            record('保存登录：未找到 userToken');
            notify();
            return;
          }
          const savedAt = writeLoginStore(token);
          if (savedAt <= 0) {
            state.login.status = 'error';
            state.login.error = '本地保存失败';
            record('保存登录：本地保存失败');
            notify();
            return;
          }
          savedUserToken = token;
          savedTokenAt = savedAt;
          state.login.saved = true;
          state.login.savedLength = token.length;
          state.login.savedAt = savedAt;
          state.login.status = 'saved';
          state.login.error = '';
          loginConfirmedThisRun = true; // 用户本次点击保存成功 → 之后才启用退出检测
          record('登录信息已保存（长度 ' + token.length + '）');
          notify();
        })
        .catch(() => {
          state.login.status = 'error';
          state.login.error = '读取失败（详情不记录）';
          record('保存登录：读取失败（静默）');
          notify();
        });
    }

    // 「清除已保存登录」：删除插件自己的 localStorage 键，并清空内存中的 token。
    function clearSavedLogin() {
      clearLoginStore();
      savedUserToken = null;
      savedTokenAt = 0;
      restoreAttempted = false;
      restoreReloaded = false;
      state.login.saved = false;
      state.login.savedLength = 0;
      state.login.savedAt = 0;
      state.login.status = 'cleared';
      state.login.error = '';
      record('已清除保存的登录信息');
      notify();
    }

    function ensureWebview(container) {
      if (!container) return;
      hostContainer = container;
      if (element) {
        if (element.parentNode !== container) container.appendChild(element);
        return;
      }
      if (state.phase !== 'idle') return;

      const carrier = globalThis.dshDesktop;
      const browser =
        carrier && carrier.protocolVersion === 1 && carrier.browser
          ? carrier.browser
          : undefined;
      if (!browser) {
        state.bridge = 'missing';
        state.phase = 'no-bridge';
        state.error = '当前环境没有 dshDesktop.browser（非桌面主窗口），无法创建 webview。';
        notify();
        return;
      }

      state.bridge = 'ok';
      state.phase = 'acquiring';
      notify();

      Promise.resolve()
        .then(() => browser.acquire(LEASE_WORKSPACE))
        .then((reservation) => {
          if (
            !reservation ||
            typeof reservation.lease !== 'string' ||
            typeof reservation.partition !== 'string'
          ) {
            throw new Error('acquire 返回值无效');
          }
          lease = { lease: reservation.lease, partition: reservation.partition };
          state.lease = reservation.lease;
          state.partition = reservation.partition;
          state.phase = 'created';
          record('acquire 成功');

          const view = document.createElement('webview');
          // about:blank#<lease> 是主进程 will-attach-webview 放行的握手条件
          view.setAttribute('name', reservation.lease);
          view.setAttribute('partition', reservation.partition);
          view.setAttribute('src', 'about:blank#' + reservation.lease);
          view.setAttribute('data-sidebar-browser-frame', 'webview');
          view.className = 'dsh-chat-mode-frame';
          view.setAttribute(
            'style',
            'display:flex;width:100%;height:100%;border:0;' +
              'background:var(--dsw-alias-bg-base,#fff);',
          );

          // —— 只监听事件与计数；不读页面内容、不注入脚本（登录恢复除外） ——
          view.addEventListener('did-start-loading', () => {
            state.counters.start += 1;
            record('did-start-loading');
          });
          view.addEventListener('did-stop-loading', () => {
            state.counters.stop += 1;
            if (loadIssued && state.phase !== 'failed') state.phase = 'ready';
            record('did-stop-loading');
            // 恢复写回后 reload 完成时只读 pathname 判断结果；恢复进行中继续保持遮罩
            checkLoginPageResult(view);
          });
          view.addEventListener('did-navigate', (event) => {
            state.counters.navigate += 1;
            // webview 的 did-navigate 只代表主框架导航，不再区分子框架
            record('did-navigate（导航）');
            const target = event && typeof event.url === 'string' ? event.url : '';
            // 运行中检测到用户主动退出（进入 /sign_in）：清除已保存副本，本次运行不再自动恢复。
            // 仅当本次运行已确认登录后才生效（见 handleSignInNavigation），避免登录页先闪一下时误清副本。
            if (handleSignInNavigation(target)) return;
            // 首次导航到聊天站点后，若存在已保存 token 且开关开启则尝试恢复一次。
            // 注意：这里是登录恢复的触发点（spike 时期在另一处，后改为 did-navigate）；
            // 若恢复没有发生，这是第一个排查点（确认 did-navigate 是否到达、url 是否已是 chat 域）。
            maybeRestoreLogin(view);
          });
          // 页面内跳转（SPA 路由）不会触发 did-navigate；补一次同规则的退出检测。
          // 只用事件自带的 url / isMainFrame，不执行页面脚本、不读页面存储。
          view.addEventListener('did-navigate-in-page', (event) => {
            if (!event || event.isMainFrame !== true) return;
            state.counters.navigateInPage += 1;
            record('did-navigate-in-page（页面内导航）');
            handleSignInNavigation(typeof event.url === 'string' ? event.url : '');
          });
          view.addEventListener('did-fail-load', (event) => {
            const code = event && typeof event.errorCode === 'number' ? event.errorCode : 0;
            if (code === -3) return; // ERR_ABORTED：用户主动中断，不算失败
            state.counters.fail += 1;
            state.phase = 'failed';
            state.error = 'did-fail-load errorCode=' + code;
            record('did-fail-load', 'errorCode=' + code);
            clearMask();
          });
          view.addEventListener('dom-ready', () => {
            state.counters.domReady += 1;
            if (!loadIssued) {
              loadIssued = true;
              state.phase = 'loading';
              record('dom-ready → loadURL 开始');
              try {
                Promise.resolve(view.loadURL(currentChatUrl())).catch((error) => {
                  state.phase = 'failed';
                  state.error = firstLine(error);
                  record('loadURL 失败');
                  clearMask();
                });
              } catch (error) {
                state.phase = 'failed';
                state.error = firstLine(error);
                record('loadURL 抛错');
                clearMask();
              }
            } else {
              // webview 的 dom-ready 事件在每次新 document 就绪时触发；
              // 正常情况下首次加载完成后不应再出现第二次（出现即说明发生了重载）。
              record('dom-ready（第二次及以后）');
            }
          });
          view.addEventListener('render-process-gone', () => {
            state.counters.gone += 1;
            record('render-process-gone');
          });
          view.addEventListener('destroyed', () => {
            record('webview destroyed');
          });

          element = view;
          container.appendChild(view);
          record('webview 已挂载');
          // 遮罩兜底：8 秒还没撤掉就强制撤掉，避免一直挡住界面
          if (maskTimer) clearTimeout(maskTimer);
          maskTimer = setTimeout(() => {
            maskTimer = null;
            if (state.mask) {
              state.mask = false;
              record('遮罩兜底超时，已撤掉');
              notify();
            }
          }, 8000);
          notify();
        })
        .catch((error) => {
          state.phase = 'failed';
          state.bridge = state.bridge === 'unknown' ? 'missing' : state.bridge;
          state.error = firstLine(error);
          record('acquire / 创建失败');
        });
    }

    // ------------------------------------------------------------------
    // UI
    // ------------------------------------------------------------------
    function button(label, onClick, options) {
      const opts = options || {};
      const active = opts.active === true;
      const warn = opts.tone === 'warn';
      return h(
        'button',
        {
          type: 'button',
          title: opts.title || label,
          onClick,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            padding: '3px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            border: '1px solid ' + (active ? 'transparent' : BORDER_COLOR),
            background: active
              ? warn
                ? 'var(--dsw-alias-state-warning-strong, #d97706)'
                : 'var(--dsw-alias-brand-primary, #4d6bfe)'
              : 'transparent',
            color: active ? '#fff' : LABEL_COLOR,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    function checkbox(label, checked, onChange) {
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            cursor: 'pointer',
            userSelect: 'none',
          },
        },
        h('input', {
          type: 'checkbox',
          checked,
          onChange: (event) => onChange(event.target.checked),
        }),
        label,
      );
    }

    // -webkit-app-region 不是标准 CSSStyleDeclaration 属性，用 ref 直接 setProperty 最稳。
    function noDrag(node) {
      if (!node) return;
      try {
        node.style.setProperty('-webkit-app-region', 'no-drag');
      } catch {
        // 老环境忽略
      }
    }

    function segmentButton(label, active, warn, title, onClick) {
      return h(
        'button',
        {
          type: 'button',
          title,
          onClick,
          ref: noDrag,
          style: {
            font: 'inherit',
            fontSize: 12,
            lineHeight: '18px',
            height: 22,
            padding: '0 9px',
            borderRadius: 4,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
            border: '1px solid ' + (active && !warn ? BORDER_COLOR : 'transparent'),
            background: active
              ? warn
                ? 'var(--dsw-alias-state-warning-strong, #d97706)'
                : 'var(--dsw-alias-bg-base, #fff)'
              : 'transparent',
            color: active && warn ? '#fff' : LABEL_COLOR,
            fontWeight: active ? 600 : 400,
            opacity: active ? 1 : 0.66,
          },
        },
        label,
      );
    }

    // 标题栏控件的动态左偏移：测量原生菜单宿主 [data-windows-menu] 的右边界，
    // 让整组控件跟随菜单移动（收起侧栏时菜单从 48px 移到 84px，「新建聊天」按钮出现）。
    // 不轮询：只在窗口尺寸变化、菜单自身尺寸变化、侧栏折叠状态变化时重新测量。
    // 测不到菜单（Web 环境 / preload 未注入）时回退到 TITLEBAR_LEFT_OFFSET。
    function useTitlebarLeftOffset() {
      const [left, setLeft] = React.useState(TITLEBAR_LEFT_OFFSET);
      React.useEffect(() => {
        let disposed = false;
        const timers = [];
        let menuNode = null;
        let menuObserver = null;
        let layoutObserver = null;
        let attributeObserver = null;

        const measure = () => {
          if (disposed) return;
          let next = TITLEBAR_LEFT_OFFSET;
          try {
            const menu = document.querySelector(WINDOWS_MENU_SELECTOR);
            if (menu) {
              const rect = menu.getBoundingClientRect();
              // width 为 0 说明菜单还没布局完成（或已隐藏），保留兜底值，等下一次测量。
              if (rect.width > 0 && rect.right > 0) next = Math.round(rect.right) + TITLEBAR_MENU_GAP;
            }
          } catch {
            // 保持兜底值
          }
          setLeft((current) => (current === next ? current : next));
        };

        // 直接同步测量：窗口被遮挡时浏览器会节流 requestAnimationFrame，
        // 而侧栏折叠会立刻改变菜单右边界，必须当场跟随，否则会出现短暂重叠。
        const schedule = () => {
          if (disposed) return;
          measure();
        };

        // 菜单宿主可能因窗口重建而更换节点；尺寸变化（菜单文字/语言）时重新测量右边界。
        const watchMenu = () => {
          const menu = document.querySelector(WINDOWS_MENU_SELECTOR);
          if (menu === menuNode) return;
          if (menuObserver) menuObserver.disconnect();
          menuObserver = null;
          menuNode = menu;
          if (!menu || typeof ResizeObserver !== 'function') return;
          menuObserver = new ResizeObserver(schedule);
          try {
            menuObserver.observe(menu);
          } catch {
            menuObserver = null;
          }
        };

        // 首次挂载时菜单可能还没注入：做几次有界补偿测量（首屏布局稳定后即可量到）。
        const settleTimers = [0, 120, 500].map((delay) =>
          setTimeout(() => {
            watchMenu();
            schedule();
          }, delay),
        );
        timers.push(...settleTimers);

        // 窗口尺寸变化（含最大化/还原、显示缩放变化）。
        window.addEventListener('resize', schedule);

        // 侧栏折叠状态变化时，原生菜单左边界会变（CSS :has 改 --dsh-windows-menu-start），
        // 而菜单自身宽度可能完全不变（ResizeObserver 捕获不到纯位置平移），所以必须监听属性。
        // 同理，受控隐藏开关（data-chat-mode-hide-toggle）会把菜单左移 12px，
        // 这里也监听它，保证属性切换后立刻重新测量、不会沿用旧位置。
        if (typeof MutationObserver === 'function') {
          attributeObserver = new MutationObserver(() => {
            watchMenu();
            schedule();
          });
          try {
            attributeObserver.observe(document.documentElement, {
              attributes: true,
              subtree: true,
              attributeFilter: ['data-sidebar-collapsed', DSH_SIDEBAR_HIDE_ATTR, 'data-windows-titlebar'],
            });
          } catch {
            attributeObserver = null;
          }
        }

        // 标题栏区域尺寸变化（布局列宽变化等）。
        if (typeof ResizeObserver === 'function' && document.documentElement) {
          layoutObserver = new ResizeObserver(schedule);
          try {
            layoutObserver.observe(document.documentElement);
          } catch {
            layoutObserver = null;
          }
        }

        watchMenu();
        schedule();

        return () => {
          disposed = true;
          for (const timer of timers) clearTimeout(timer);
          window.removeEventListener('resize', schedule);
          if (menuObserver) menuObserver.disconnect();
          if (attributeObserver) attributeObserver.disconnect();
          if (layoutObserver) layoutObserver.disconnect();
        };
      }, []);
      return left;
    }

    // ------------------------------------------------------------------
    // 受控隐藏 DSH 标题栏按钮（用属性开关 + 一条样式规则，仍占位、布局不变）
    // ------------------------------------------------------------------
    // 为什么不用遮罩：该按钮 z-index:30，在 overlay 层（z-index:20）之上，遮罩盖不住也挡不到点击；
    // 这里改为在聊天层可见时隐藏它。
    // 选择器只认 aria-label（中英）与 data-sidebar-collapsed，不使用自动生成的 class，不修改其它元素。
    let sidebarHideStyle = null;

    function applySidebarToggleHiding() {
      try {
        if (!HIDE_DSH_SIDEBAR_BUTTON) return;
        if (typeof document === 'undefined' || !document.documentElement) return;
        // 只在聊天模式、聊天层可见（webview 桥可用）时隐藏
        if (state.mode !== 'chat' || state.bridge !== 'ok') return;
        // 规则本身只匹配上述按钮，没有匹配对象时无副作用，因此不需要先 querySelector 探测。
        if (!sidebarHideStyle) {
          const style = document.createElement('style');
          style.setAttribute('data-chat-mode-style', 'hide-dsh-sidebar-toggle');
          style.textContent = DSH_SIDEBAR_HIDE_CSS;
          (document.head || document.documentElement).appendChild(style);
          sidebarHideStyle = style;
        }
        document.documentElement.setAttribute(DSH_SIDEBAR_HIDE_ATTR, '1');
      } catch {
        // 任何异常都按"撤销"处理，不影响插件其它功能
        clearSidebarToggleHiding();
      }
    }

    // 统一清理函数：移除 <html> 上的属性 + 删除注入的 <style>；幂等，可在任何时机调用。
    function clearSidebarToggleHiding() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.removeAttribute(DSH_SIDEBAR_HIDE_ATTR);
        }
      } catch {
        // 忽略
      }
      try {
        if (sidebarHideStyle && sidebarHideStyle.parentNode) {
          sidebarHideStyle.parentNode.removeChild(sidebarHideStyle);
        }
      } catch {
        // 忽略
      }
      sidebarHideStyle = null;
    }

    // 无 UI 的同步组件：按「模式 / webview 桥 / 开关」启用或撤销受控隐藏。
    // 条件不满足（工作模式、聊天层不可见、开关关闭）时立即撤销；组件卸载时也撤销。
    // 插件被整体卸载时的兜底清理在 apply 的 ctx.effect 里。
    function SidebarToggleHider() {
      useSpike();
      const active = HIDE_DSH_SIDEBAR_BUTTON && state.mode === 'chat' && state.bridge === 'ok';
      React.useEffect(() => {
        if (active) applySidebarToggleHiding();
        else clearSidebarToggleHiding();
        return () => clearSidebarToggleHiding();
      }, [active]);
      return null;
    }

    // 标题栏控件：紧凑分段切换（聊天/工作）+ 很小的「诊断」开关。
    // 位置：动态跟随标题栏「编辑」菜单右侧（保留小间距），垂直居中；两种模式下都可见。
    function TitlebarControls() {
      useSpike();
      const menuLeft = useTitlebarLeftOffset();
      const chat = state.mode === 'chat';
      return h(
        'div',
        {
          ref: noDrag,
          style: {
            position: 'fixed',
            top: 'calc((var(--dsh-windows-titlebar-height, ' + TITLEBAR_HEIGHT_FALLBACK + 'px) - 26px) / 2)',
            left: menuLeft,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            zIndex: 45,
            pointerEvents: 'auto',
            fontFamily: 'inherit',
          },
        },
        h(
          'div',
          {
            ref: noDrag,
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 2,
              height: 26,
              boxSizing: 'border-box',
              padding: 2,
              borderRadius: 6,
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
            },
          },
          segmentButton('聊天', chat, false, '聊天模式', () => switchMode('chat')),
          segmentButton('工作', !chat, true, '工作模式会消耗 token', () => switchMode('work')),
        ),
        h(
          'button',
          {
            type: 'button',
            ref: noDrag,
            title: state.diagOpen ? '隐藏诊断面板' : '显示诊断面板',
            onClick: toggleDiag,
            style: {
              font: 'inherit',
              fontSize: 11,
              lineHeight: '16px',
              height: 22,
              padding: '0 7px',
              borderRadius: 4,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
              color: LABEL_COLOR,
              opacity: state.diagOpen ? 1 : 0.72,
            },
          },
          '诊断',
        ),
        // 「带入工作模式」：只在聊天模式显示（把剪贴板/选中文字经确认后填入工作输入框）
        chat
          ? h(
              'button',
              {
                type: 'button',
                ref: noDrag,
                title: '把网页里选中的文字（加模板）填入工作模式输入框（只填入，不自动发送）',
                onClick: startBringFromSelection,
                style: {
                  font: 'inherit',
                  fontSize: 11,
                  lineHeight: '16px',
                  height: 22,
                  padding: '0 7px',
                  borderRadius: 4,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  border: '1px solid ' + BORDER_COLOR,
                  background: 'transparent',
                  color: LABEL_COLOR,
                  opacity: 0.85,
                },
              },
              '带入工作',
            )
          : null,
      );
    }

    function DiagnosticsPanel() {
      useSpike();
      const panelRef = React.useRef(null);
      const [probeText, setProbeText] = React.useState('(面板打开后读取)');
      const probeNames = [
        '--dsw-alias-bg-base',
        '--dsw-alias-bg-raised',
        '--dsw-alias-label-primary',
        '--dsw-alias-border',
        '--dsw-alias-state-warning-strong',
      ];
      // 主题变量探测：读取**插件自己容器元素**的 getComputedStyle（只用于显示，不做样式判断）。
      React.useEffect(() => {
        if (!state.diagOpen || !panelRef.current) return;
        try {
          const computed = getComputedStyle(panelRef.current);
          setProbeText(
            probeNames
              .map((name) => name + '=' + (computed.getPropertyValue(name).trim() || '(空)'))
              .join('  '),
          );
        } catch {
          setProbeText('(读取失败)');
        }
      }, [state.diagOpen]);
      // 默认隐藏：只由标题栏「诊断」开关切换显示/隐藏
      if (!state.diagOpen) return null;
      const rows = [];

      rows.push('主题变量(面板容器 getComputedStyle): ' + probeText);

      rows.push('模式: ' + (state.mode === 'chat' ? '聊天（不调用 API）' : '工作（消耗 token）'));
      rows.push(
        '桥: ' +
          (state.bridge === 'ok'
            ? '可用 (protocolVersion=1)'
            : state.bridge === 'missing'
              ? '不可用（没有 dshDesktop.browser）'
              : '未检测'),
      );
      rows.push(
        '阶段: ' +
          state.phase +
          (state.error ? '  错误: ' + state.error : ''),
      );
      rows.push('lease: ' + state.lease + '   partition: ' + state.partition);
      rows.push('目标网址: ' + currentChatUrl() + '（只在首次 dom-ready 后 loadURL 一次）');
      rows.push(
        '设置: 默认=' +
          prefs.defaultMode +
          ' | 记住上次=' +
          (prefs.rememberLast ? '开' : '关') +
          ' | 记住登录=' +
          (prefs.rememberLogin ? '开' : '关') +
          ' | 上次=' +
          prefs.lastMode,
      );
      rows.push(
        '计数: dom-ready ' +
          state.counters.domReady +
          ' | start ' +
          state.counters.start +
          ' | stop ' +
          state.counters.stop +
          ' | 导航 ' +
          state.counters.navigate +
          ' | 失败 ' +
          state.counters.fail +
          ' | 崩溃 ' +
          state.counters.gone,
      );
      // 登录恢复状态：只显示"是否保存/长度/结果"，不显示 token 值本身
      {
        const statusLabels = {
          idle: state.login.saved ? '已保存（长度 ' + state.login.savedLength + '）' : '未保存',
          saved: '已保存（长度 ' + state.login.savedLength + '）',
          cleared: '已清除',
          restoring: '恢复中',
          restored: '已恢复',
          'still-login': '仍在登录页',
          error: '操作未完成' + (state.login.error ? '：' + state.login.error : ''),
        };
        rows.push('登录恢复: ' + (statusLabels[state.login.status] || state.login.status));
      }
      rows.push(
        '最近事件:\n' +
          (state.events.length
            ? state.events.map((item) => '  ' + item.at + '  ' + item.label).join('\n')
            : '  (无)'),
      );
      if (state.geometry) {
        const g = state.geometry;
        rows.push(
          '几何: layer=' +
            (g.layer
              ? g.layer.x + ',' + g.layer.y + ' ' + g.layer.w + 'x' + g.layer.h
              : 'n/a') +
            ' | viewport=' +
            g.viewport.w +
            'x' +
            g.viewport.h +
            ' | --dsh-frame-top-clearance=' +
            g.clearance +
            ' | chat=' +
            g.chatWidth +
            'x' +
            g.chatHeight,
        );
      }

      return h(
        'div',
        {
          ref: panelRef,
          style: {
            position: 'fixed',
            top: 'calc(var(--dsh-windows-titlebar-height, ' + TITLEBAR_HEIGHT_FALLBACK + 'px) + 8px)',
            right: 16,
            zIndex: 40,
            pointerEvents: 'auto',
            // 宽度自适应视口，避免窄窗口被横向裁切
            width: 'min(560px, calc(100vw - 32px))',
            boxSizing: 'border-box',
            maxHeight: '60vh',
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: '8px 10px',
            borderRadius: 10,
            // 颜色用深浅主题都读得清的备用色；变量存在时会覆盖（仅视觉，不参与逻辑）
            background: 'var(--dsw-alias-bg-base, #fff)',
            border: '1px solid ' + BORDER_COLOR,
            boxShadow: '0 8px 24px rgba(0,0,0,.18)',
            color: LABEL_COLOR,
            fontFamily: 'ui-monospace, Consolas, monospace',
            fontSize: 11,
            lineHeight: 1.55,
            userSelect: 'text',
          },
        },
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              rowGap: 6,
              marginBottom: 6,
            },
          },
          h('strong', { style: { fontSize: 12, marginRight: 4 } }, '诊断'),
          button('覆盖检查(3s)', startInspect),
          button('刷新几何', refreshGeometry),
          button('重置计数', resetCounters),
          state.phase === 'failed' ? button('重试创建', retryWebview) : null,
          button('重置为聊天', () => switchMode('chat')),
        ),
        // 登录恢复：单独一行，只在用户点击时执行；「保存」需当前 origin 为 chat.deepseek.com
        h(
          'div',
          {
            style: {
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 6,
              rowGap: 6,
              marginBottom: 6,
            },
          },
          h('span', { style: { opacity: 0.8 } }, '登录恢复：'),
          button('保存登录', saveLogin),
          state.login.saved ? button('清除已保存登录', clearSavedLogin) : null,
        ),
        h(
          'div',
          null,
          h(
            'pre',
            {
              style: {
                margin: 0,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'inherit',
              },
            },
            rows.join('\n'),
          ),
          h(
            'div',
            {
              style: {
                marginTop: 6,
                opacity: 0.85,
                borderTop: '1px dashed ' + BORDER_COLOR,
                paddingTop: 6,
              },
            },
            '保活判断：切到「工作」再切回「聊天」后，首次加载完成后计数应保持不变（通常是 2：about:blank 占位 + 目标页），start 计数不增加；' +
              '页面里已输入的文字应仍在（请目视确认，本插件不读取页面内容）。\n' +
              '覆盖判断：点「覆盖检查(3s)」，聊天层变半透明，若能看到侧栏/标题栏/输入框说明未覆盖；' +
              '看不到则说明被覆盖（这正是聊天模式想要的效果）。\n' +
              '网络声明：本插件代码无 fetch / XHR / WebSocket / sendBeacon / window.open；' +
              'executeJavaScript 只用于登录恢复（固定脚本，token 仅作数据传入）与「带入工作」' +
              '读取 window.getSelection().toString()（用户点击、官方 origin 完全相等时，固定脚本）。\n' +
              '存储声明：只写插件自己的 localStorage 两个键——dsh-chat-mode:prefs:v1（设置/模式偏好/' +
              '带入模板）与 dsh-chat-mode:login:v1（仅 userToken 一项，明文，默认关闭）；' +
              '不读取 document.cookie、其它 localStorage 项、IndexedDB 或页面内容；' +
              '读到的选中文字只放内存，用完即清，不写任何存储。\n' +
              '带入工作模式：只调用 inputActions.setDraft 填入（模板 + 选中文字），绝不自动发送；' +
              '不读取聊天记录或输入框已有内容；内容不保存、不上报。\n' +
              '登录恢复：「保存登录」只在用户点击、开关开启且当前 origin 为 https://chat.deepseek.com 时执行；' +
              '恢复只在首次加载后尝试一次，失败自动清除副本并静默回到正常登录页，不弹错；' +
              '用户主动退出后本次运行不再自动恢复。',
          ),
        ),
      );
    }

    // 「带入工作模式」确认对话框（悬浮在聊天层之上；只填入、不发送）
    function BringDialog() {
      useSpike();
      if (!state.bring.open) return null;
      return h(
        'div',
        {
          style: {
            position: 'absolute',
            top: 'var(--dsh-frame-overlay-top, 52px)',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 'min(640px, calc(100vw - 32px))',
            zIndex: 60,
            pointerEvents: 'auto',
            boxSizing: 'border-box',
            padding: '12px 14px',
            borderRadius: 10,
            background: 'var(--dsw-alias-bg-base, #fff)',
            border: '1px solid ' + BORDER_COLOR,
            boxShadow: '0 12px 32px rgba(0,0,0,.28)',
            color: LABEL_COLOR,
            fontSize: 13,
            lineHeight: 1.6,
          },
        },
        h(
          'div',
          { style: { fontWeight: 600, fontSize: 14, marginBottom: 4 } },
          '带入工作模式（只填入，不发送）',
        ),
        h(
          'div',
          { style: { fontSize: 12, opacity: 0.8, marginBottom: 8 } },
          '检查 / 编辑下面的内容，确认后填入工作模式的输入框。发送由你自己决定，插件不会自动发送。',
        ),
        h('textarea', {
          value: state.bring.text,
          rows: 7,
          spellCheck: false,
          onChange: (event) => {
            state.bring.text = event.target.value;
            notify();
          },
          style: {
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            minHeight: 120,
            font: 'inherit',
            fontSize: 12,
            lineHeight: 1.6,
            padding: '8px',
            borderRadius: 6,
            border: '1px solid ' + BORDER_COLOR,
            background: 'transparent',
            color: 'inherit',
          },
        }),
        h(
          'div',
          { style: { display: 'flex', gap: 8, marginTop: 8 } },
          button('读取剪贴板', readClipboardIntoDialog),
        ),
        state.bring.notice
          ? h('div', { style: { fontSize: 12, opacity: 0.78, marginTop: 6 } }, state.bring.notice)
          : null,
        state.bring.error
          ? h('div', { style: { fontSize: 12, color: '#c2410c', marginTop: 6 } }, state.bring.error)
          : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } },
          button('取消', closeBringDialog),
          button(state.bring.busy ? '正在填入…' : '确认带入（不发送）', submitBring, { active: true }),
        ),
      );
    }

    // 设置页（注册到 settings.section）：启动行为、网页地址、登录恢复。
    function ChatSettingsPage() {
      useSpike();
      const [urlDraft, setUrlDraft] = React.useState(prefs.webUrl);
      const [urlError, setUrlError] = React.useState('');
      const [urlNotice, setUrlNotice] = React.useState('');
      const [urlWarning, setUrlWarning] = React.useState('');
      const [urlConfirmHost, setUrlConfirmHost] = React.useState('');
      const [templateDraft, setTemplateDraft] = React.useState(prefs.bringTemplate);
      const [templateNotice, setTemplateNotice] = React.useState('');
      const sectionStyle = { marginBottom: 14 };
      const titleStyle = { fontWeight: 600, fontSize: 13, marginBottom: 6 };
      const hintStyle = { fontSize: 12, opacity: 0.78, marginTop: 4, lineHeight: 1.6 };
      const rowStyle = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 };

      function updatePrefs(patch) {
        savePrefs(patch);
        notify();
      }

      function applyUrlValue(value, host) {
        updatePrefs({ webUrl: value, webUrlConfirmedHost: host });
        setUrlDraft(value);
        setUrlError('');
        setUrlWarning('');
        setUrlConfirmHost('');
        setUrlNotice('已保存。已打开的聊天页继续使用当前地址；重建 WebView 后生效。');
      }

      function applyUrl() {
        const next = normalizeWebUrl(urlDraft);
        if (!next) {
          setUrlError('地址不合法（只接受不带用户名/密码的 https 地址）。已恢复默认地址。');
          setUrlWarning('');
          setUrlConfirmHost('');
          setUrlDraft(DEFAULT_WEB_URL);
          updatePrefs({ webUrl: DEFAULT_WEB_URL, webUrlConfirmedHost: null });
          return;
        }
        const host = new URL(next).hostname.toLowerCase();
        if (isDeepseekHost(host)) {
          applyUrlValue(next, host);
          return;
        }
        // 非 DeepSeek 官方域名：显示黄色警告，需要再点一次「确认使用该地址」才保存
        if (urlConfirmHost !== host) {
          setUrlError('');
          setUrlNotice('');
          setUrlWarning('该地址不是 DeepSeek 官方域名（' + host + '）。确认要使用它，请再点一次「确认使用该地址」。');
          setUrlConfirmHost(host);
          return;
        }
        applyUrlValue(next, host);
      }

      function confirmUrl() {
        const next = normalizeWebUrl(urlDraft);
        if (!next) {
          applyUrl();
          return;
        }
        const host = new URL(next).hostname.toLowerCase();
        if (!urlConfirmHost || host !== urlConfirmHost) {
          applyUrl();
          return;
        }
        applyUrlValue(next, host);
      }

      function resetUrl() {
        setUrlDraft(DEFAULT_WEB_URL);
        setUrlError('');
        setUrlWarning('');
        setUrlConfirmHost('');
        updatePrefs({ webUrl: DEFAULT_WEB_URL, webUrlConfirmedHost: null });
        setUrlNotice('已恢复默认地址。');
      }

      const loginLabel = (() => {
        const labels = {
          idle: state.login.saved ? '已保存（长度 ' + state.login.savedLength + '）' : '未保存',
          saved: '已保存（长度 ' + state.login.savedLength + '）',
          cleared: '已清除',
          restoring: '恢复中',
          restored: '已恢复',
          'still-login': '未恢复（仍在登录页）',
          error: state.login.error ? '操作未完成：' + state.login.error : '操作未完成',
        };
        return labels[state.login.status] || state.login.status;
      })();

      return h(
        'div',
        { style: { padding: '4px 0 8px', color: LABEL_COLOR, fontSize: 13, lineHeight: 1.65 } },
        h('div', { style: titleStyle }, '聊天模式'),
        h(
          'div',
          { style: { ...hintStyle, marginBottom: 10 } },
          '聊天模式内嵌 DeepSeek 官方网页版，不消耗 API token；工作模式是 DSH 原有 Agent 界面，会消耗 token。',
        ),
        h(
          'div',
          { style: sectionStyle },
          h('div', { style: titleStyle }, '启动行为'),
          h(
            'div',
            { style: rowStyle },
            h('span', null, '默认启动模式：'),
            segmentButton('聊天', prefs.defaultMode === 'chat', false, '默认启动进入聊天模式（不消耗 token）', () =>
              updatePrefs({ defaultMode: 'chat' }),
            ),
            segmentButton('工作', prefs.defaultMode === 'work', true, '默认启动进入工作模式（会消耗 token）', () =>
              updatePrefs({ defaultMode: 'work' }),
            ),
          ),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            checkbox('记住上次使用的模式', prefs.rememberLast, (checked) =>
              updatePrefs({ rememberLast: checked }),
            ),
          ),
          h(
            'div',
            { style: hintStyle },
            '未开启「记住上次」时，每次启动都进入默认模式；开启后进入上次退出时的模式。',
          ),
        ),
        h(
          'div',
          { style: sectionStyle },
          h('div', { style: titleStyle }, '网页版地址'),
          h(
            'div',
            { style: rowStyle },
            h('input', {
              type: 'text',
              value: urlDraft,
              spellCheck: false,
              onChange: (event) => {
                setUrlDraft(event.target.value);
                setUrlError('');
                setUrlWarning('');
                setUrlConfirmHost('');
              },
              style: {
                flex: '1 1 260px',
                minWidth: 180,
                font: 'inherit',
                fontSize: 13,
                padding: '6px 8px',
                borderRadius: 6,
                border: '1px solid ' + BORDER_COLOR,
                background: 'transparent',
                color: 'inherit',
              },
            }),
            button('保存', applyUrl, { active: true }),
            urlWarning ? button('确认使用该地址', confirmUrl, { active: true }) : null,
            button('恢复默认', resetUrl),
          ),
          urlError ? h('div', { style: { ...hintStyle, color: '#c2410c' } }, urlError) : null,
          urlWarning ? h('div', { style: { ...hintStyle, color: '#b45309' } }, urlWarning) : null,
          urlNotice ? h('div', { style: hintStyle }, urlNotice) : null,
          h(
            'div',
            { style: hintStyle },
            '只接受 https 地址；deepseek.com 及其子域直接保存，其他域名需二次确认；带用户名/密码的地址会被拒绝。默认 https://chat.deepseek.com/。',
          ),
        ),
        h(
          'div',
          { style: { ...sectionStyle, borderTop: '1px solid ' + BORDER_COLOR, paddingTop: 12 } },
          h('div', { style: titleStyle }, '带入工作'),
          h(
            'div',
            { style: { ...hintStyle, marginBottom: 6 } },
            '在聊天网页里选中文字后点标题栏「带入工作」：把下面模板 + 选中文字填入工作模式输入框（只填入、不自动发送）。没有选中文字时会打开原来的粘贴对话框。',
          ),
          h('textarea', {
            value: templateDraft,
            rows: 3,
            spellCheck: false,
            onChange: (event) => {
              setTemplateDraft(event.target.value);
              setTemplateNotice('');
            },
            style: {
              width: '100%',
              boxSizing: 'border-box',
              resize: 'vertical',
              minHeight: 64,
              font: 'inherit',
              fontSize: 12,
              lineHeight: 1.6,
              padding: '8px',
              borderRadius: 6,
              border: '1px solid ' + BORDER_COLOR,
              background: 'transparent',
              color: 'inherit',
            },
          }),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            button(
              '保存模板',
              () => {
                updatePrefs({ bringTemplate: String(templateDraft || '').slice(0, 4000) });
                setTemplateDraft(prefs.bringTemplate);
                setTemplateNotice('已保存，下次点「带入工作」生效。');
              },
              { active: true },
            ),
            button('恢复默认模板', () => {
              updatePrefs({ bringTemplate: DEFAULT_BRING_TEMPLATE });
              setTemplateDraft(DEFAULT_BRING_TEMPLATE);
              setTemplateNotice('已恢复默认模板。');
            }),
          ),
          templateNotice ? h('div', { style: hintStyle }, templateNotice) : null,
          h(
            'div',
            { style: hintStyle },
            '模板与本页其它设置存在同一个插件 localStorage 键中，不会上传。选中文字超过 ' +
              BRING_SELECTION_MAX_CHARS +
              ' 字会截断并提示；读到的选中文字只放内存，不写存储，填入后不自动发送。',
          ),
        ),
        h(
          'div',
          { style: { ...sectionStyle, borderTop: '1px solid ' + BORDER_COLOR, paddingTop: 12 } },
          h('div', { style: titleStyle }, '登录恢复（可选）'),
          h(
            'div',
            { style: rowStyle },
            checkbox('记住登录（只保存 userToken 一项）', prefs.rememberLogin, (checked) => {
              updatePrefs({ rememberLogin: checked });
              if (!checked) clearSavedLogin(); // 关闭即清除已保存副本
            }),
          ),
          h(
            'div',
            { style: { ...rowStyle, marginTop: 8 } },
            h('span', null, '状态：' + loginLabel),
            button('保存当前登录', saveLogin),
            state.login.saved ? button('清除已保存登录', clearSavedLogin) : null,
          ),
          h(
            'div',
            { style: { ...hintStyle, marginTop: 8 } },
            '说明：仅在开关开启且网页为官方 chat.deepseek.com 时生效；保存在本机插件 localStorage（明文，同源脚本理论上可读）。' +
              '恢复失败会自动清除副本；你在网页里主动退出后，本次运行不会再自动登录。token 有效期尚未验证。',
          ),
        ),
      );
    }

    function SpikeRoot() {
      useSpike();
      const containerRef = React.useRef(null);

      React.useEffect(() => {
        if (state.mode === 'chat' && containerRef.current) {
          ensureWebview(containerRef.current);
        }
      });

      const chatVisible = state.mode === 'chat';
      const showChat = chatVisible && state.bridge === 'ok';

      return h(
        'div',
        {
          style: {
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 30,
          },
        },
        // 聊天层：始终存在于 DOM 中，只切换 display，保证 webview 不被卸载/重载
        // 顶部从 CHAT_LAYER_TOP 开始，避免盖住标题栏（标题栏里的切换按钮仍在聊天层之上）
        h(
          'div',
          {
            'data-chat-layer': 'chat',
            style: {
              position: 'absolute',
              top: CHAT_LAYER_TOP,
              right: 0,
              bottom: 0,
              left: 0,
              display: showChat ? 'block' : 'none',
              background: 'var(--dsw-alias-bg-base, #fff)',
              opacity: state.inspecting ? 0.45 : 1,
              outline: state.inspecting ? '3px dashed rgba(255,64,64,.95)' : 'none',
              transition: 'opacity 120ms linear',
              pointerEvents: showChat ? 'auto' : 'none',
              zIndex: 1,
            },
          },
          h('div', {
            ref: containerRef,
            style: { position: 'absolute', inset: 0 },
          }),
          // 加载遮罩：首次加载 / 登录恢复期间盖住聊天区域，消除登录页闪烁（8 秒兜底自动撤掉）
          state.mask
            ? h(
                'div',
                {
                  style: {
                    position: 'absolute',
                    inset: 0,
                    zIndex: 2,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--dsw-alias-bg-base, #fff)',
                    color: LABEL_COLOR,
                    fontSize: 13,
                    pointerEvents: 'auto',
                  },
                },
                '正在加载聊天页面…',
              )
            : null,
        ),
        // 没有桌面桥时的提示（Web 环境），此时不覆盖应用
        chatVisible && state.bridge === 'missing'
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  top: 'var(--dsh-frame-overlay-top, 52px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 25,
                  pointerEvents: 'auto',
                  maxWidth: 560,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: 'var(--dsw-alias-bg-base, #fff)',
                  border: '1px solid ' + BORDER_COLOR,
                  color: LABEL_COLOR,
                  fontSize: 12,
                  lineHeight: 1.6,
                },
              },
              '未检测到桌面 webview 桥（dshDesktop.browser）：当前环境无法承载网页，' +
                '因此聊天模式不会覆盖应用。请确认在 DSH 桌面端主窗口运行。',
            )
          : null,
        // 聊天层可见时隐藏 DSH 标题栏「收起侧栏」按钮（受控样式，无 UI）
        h(SidebarToggleHider),
        h(TitlebarControls),
        h(DiagnosticsPanel),
        h(BringDialog),
        // 一键带入的短暂提示（固定文字，不显示选中文字正文）
        state.bring.toast
          ? h(
              'div',
              {
                style: {
                  position: 'fixed',
                  top: 'calc(var(--dsh-windows-titlebar-height, ' +
                    TITLEBAR_HEIGHT_FALLBACK +
                    'px) + 8px)',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  zIndex: 62,
                  pointerEvents: 'none',
                  padding: '6px 12px',
                  borderRadius: 8,
                  background: 'var(--dsw-alias-bg-base, #fff)',
                  border: '1px solid ' + BORDER_COLOR,
                  color: LABEL_COLOR,
                  fontSize: 12,
                  boxShadow: '0 8px 24px rgba(0,0,0,.18)',
                },
              },
              state.bring.toast,
            )
          : null,
      );
    }

    function apply(ctx) {
      try {
        // 插件卸载 / apply 失败时的统一清理：撤销受控隐藏（属性 + <style>）+ 释放 webview 租约。
        // ctx.effect 的返回值即清理函数，插件卸载时由 Cordis 调用。
        ctx.effect(
          () => () => {
            clearSidebarToggleHiding();
            releaseWebview();
          },
          'dsh-chat-mode:cleanup',
        );
        // 常驻 overlay：聊天层 + 标题栏切换控件 + 诊断面板 + 带入工作对话框
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'chat-mode', order: 60 },
            SpikeRoot,
          ),
        );
        // 设置页：默认启动模式、网页版地址、记住上次模式、登录恢复
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'chat-mode', order: 80, label: '聊天模式' },
            ChatSettingsPage,
          ),
        );
        // 无 UI 桥接组件：在 session 作用域拿到 inputActions，供「带入工作模式」调用 setDraft
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'chat-mode-input-bridge', order: 50 },
            ComposerBridge,
          ),
        );
      } catch (error) {
        // apply 出错：确保不留下受控隐藏的属性和样式
        clearSidebarToggleHiding();
        try {
          console.error('[chat-mode] apply 失败:', firstLine(error));
        } catch {
          // 忽略
        }
      }
    }

    return { inject: ['slots'], apply };
  },
});
