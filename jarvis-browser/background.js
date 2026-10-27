// Мост между Джарвисом и этим браузером. Джарвис ходит через Playwright MCP в
// режиме --extension: тот открывает connect.html с адресом своего WebSocket,
// шлёт сюда вызовы chrome.tabs / chrome.debugger, а мы отдаём ему события.
// Протокол — Playwright extension protocol v2
// (playwright-core/src/tools/mcp/cdpRelayV2.ts, browserModel.ts).
//
// Джарвис видит только «свои» вкладки: ту, на которой ты был, когда он
// подключился; те, что он открыл сам; и те, что открылись из них. Любую другую
// можно отдать ему кнопкой расширения на панели.

let ws = null;
let keepalive = 0;
const shared = new Set();

function send(message) {
  if (ws?.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify(message));
}

function mine(tabId) {
  if (!shared.has(tabId))
    throw new Error('Эта вкладка Джарвису не отдана');
}

function share(tab) {
  shared.add(tab.id);
  send({ method: 'chrome.tabs.onCreated', params: [tab] });
}

// Только то, что зовёт browserModel.ts, и только по своим вкладкам.
const calls = {
  'chrome.tabs.create': async ([props]) => {
    const tab = await chrome.tabs.create(props);
    shared.add(tab.id);
    return tab;
  },
  'chrome.tabs.remove': ([tabId]) => (mine(tabId), chrome.tabs.remove(tabId)),
  'chrome.debugger.attach': ([target, version]) => (mine(target.tabId), chrome.debugger.attach(target, version)),
  'chrome.debugger.detach': ([target]) => (mine(target.tabId), chrome.debugger.detach(target)),
  'chrome.debugger.sendCommand': ([target, method, params]) => {
    mine(target.tabId);
    // browser_close не должен гасить твой браузер целиком: тут он не Джарвиса.
    if (method === 'Browser.close')
      throw new Error('Браузер закрывает его хозяин');
    return chrome.debugger.sendCommand(target, method, params);
  },
};

async function handle({ id, method, params }) {
  try {
    if (!calls[method])
      throw new Error('Не умею ' + method);
    send({ id, result: await calls[method](params) });
  } catch (error) {
    send({ id, error: error.message });
  }
}

function cleanup() {
  for (const tabId of shared)
    chrome.debugger.detach({ tabId }).catch(() => {});
  shared.clear();
  clearInterval(keepalive);
  ws = null;
  chrome.action.setBadgeText({ text: '' });
}

function debuggable(url) {
  return /^(https?|file):|^about:blank/.test(url || '');
}

async function connect(url, page) {
  // Только к Джарвису на этом компьютере: адрес приходит из адресной строки.
  const where = new URL(url);
  if (where.protocol !== 'ws:' || !['localhost', '127.0.0.1', '[::1]'].includes(where.hostname))
    return;
  ws?.close(1000, 'Новое подключение');
  cleanup();

  // Вкладка, на которой ты был до того, как Джарвис открыл connect.html.
  const [previous] = (await chrome.tabs.query({ windowId: page.windowId }))
      .filter(tab => tab.id !== page.id && debuggable(tab.url))
      .sort((a, b) => b.lastAccessed - a.lastAccessed);

  const socket = ws = new WebSocket(url);
  socket.onopen = () => {
    if (previous) {
      share(previous);
      chrome.tabs.update(previous.id, { active: true });
    }
    // В окне, задвинутом за другие, Chromium не рисует кадры, и клик Playwright
    // вечно ждёт, пока элемент «устоится».
    chrome.windows.update(page.windowId, { focused: true });
    chrome.tabs.remove(page.id).catch(() => {});
    send({ method: 'extension.initialized', params: [] });
    // Без обмена сообщениями MV3 усыпит service worker через 30 с и порвёт связь.
    keepalive = setInterval(() => send({ method: 'jarvis.keepalive', params: [] }), 20000);
    chrome.action.setBadgeText({ text: 'ON' });
  };
  socket.onmessage = event => handle(JSON.parse(event.data));
  socket.onclose = () => {
    if (ws === socket)
      cleanup();
  };
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'connect' && sender.tab)
    connect(message.url, sender.tab);
});

chrome.action.onClicked.addListener(tab => {
  if (ws && !shared.has(tab.id) && debuggable(tab.url))
    share(tab);
});

chrome.tabs.onCreated.addListener(tab => {
  if (ws && shared.has(tab.openerTabId))
    share(tab);
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (shared.delete(tabId))
    send({ method: 'chrome.tabs.onRemoved', params: [tabId] });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (shared.has(source.tabId))
    send({ method: 'chrome.debugger.onEvent', params: [source, method, params] });
});

// Сюда же попадает «Отмена» на жёлтой плашке отладки: вкладка уходит от Джарвиса.
chrome.debugger.onDetach.addListener((source, reason) => {
  if (shared.delete(source.tabId))
    send({ method: 'chrome.debugger.onDetach', params: [source, reason] });
});
