import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("src/features/thought-chain/app.js", "utf8");
const href = "https://example.test/app/index.html";
const storageKey = "ephone:tuk-phone:https://example.test/app/:thought-chain-settings-v1";

function loadApp(settings) {
  const store = new Map(settings ? [[storageKey, JSON.stringify(settings)]] : []);
  const document = {
    readyState: "loading",
    addEventListener() {},
    getElementById() { return null; },
    createElement() {
      return {
        textContent: "",
        get innerHTML() { return this.textContent; },
      };
    },
  };
  const window = { location: { href }, state: { apiConfig: {} } };
  const context = {
    window,
    document,
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    URL,
    Blob,
    console,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Math,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return window.ThoughtChainApp;
}

const originalMessages = [{ role: "user", content: "hello" }];

let app = loadApp(null);
let result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
});
assert.equal(result.active, false);
assert.equal(result.systemPrompt, "base");
assert.deepEqual(JSON.parse(JSON.stringify(result.messages)), originalMessages);
assert.deepEqual(JSON.parse(JSON.stringify(result.openAIOptions)), {});

app = loadApp({ enabled: true, mode: "native_off", provider: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
});
assert.equal(result.messages.length, 1);
assert.equal(result.openAIOptions.thinking.type, "disabled");
assert.equal(result.openAIOptions.reasoning_effort, undefined);

app = loadApp({ enabled: true, mode: "card", provider: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  model: "gemini-3.5-flash",
});
assert.match(result.systemPrompt, /思维链/);
assert.equal(result.messages.at(-1).role, "assistant");
assert.equal(result.geminiThinkingConfig.thinkingLevel, "minimal");
const processed = app.processResponse({
  text: '<thinking>检查设定</thinking>\n[finire]\n{"ok":true}',
  provider: "gemini",
  model: "gemini-3.5-flash",
});
assert.equal(processed.text, '{"ok":true}');
assert.equal(processed.reasoning, "检查设定");

app = loadApp({ enabled: true, mode: "card", provider: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://proxy.test",
  model: "claude-sonnet-4-6",
});
assert.equal(result.prefillStrategy, "system");
assert.equal(result.messages.at(-1).role, "user");
assert.match(result.systemPrompt, /响应起始协议/);

app = loadApp({ enabled: true, mode: "card", provider: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://api.deepseek.com/beta",
  model: "deepseek-v4-pro",
});
assert.equal(result.prefillStrategy, "assistant");
assert.equal(result.messages.at(-1).prefix, true);

app = loadApp({ enabled: true, mode: "native_off", provider: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://generativelanguage.googleapis.com/v1beta/models",
  model: "gemini-3.8-flash",
});
assert.equal(result.geminiThinkingConfig.thinkingLevel, "low");

app = loadApp({ enabled: true, mode: "hybrid", provider: "deepseek", nativeEffort: "auto" });
result = app.prepareRequest({
  systemPrompt: "base",
  messages: originalMessages,
  proxyUrl: "https://proxy.test",
  model: "deepseek-v4-pro",
});
assert.deepEqual(JSON.parse(JSON.stringify(result.openAIOptions)), {});
assert.ok(result.messages.length > originalMessages.length);

console.log("thought-chain behavior checks passed");
