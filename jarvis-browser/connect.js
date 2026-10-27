// Эту страницу открывает сам Джарвис (Playwright MCP --extension) и передаёт в
// адресе свой WebSocket. Соединение держит background.js, страница его закроет.
const query = new URLSearchParams(location.search);
if (query.get('protocolVersion') !== '2')
  document.getElementById('status').textContent =
    'Джарвис говорит на другой версии протокола (' + query.get('protocolVersion') +
    '), а расширение знает только 2. Обнови расширение.';
else
  chrome.runtime.sendMessage({ type: 'connect', url: query.get('mcpRelayUrl') });
