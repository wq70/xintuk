import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = await readFile(path.join(root, "src/features/prompt-center/app.js"), "utf8");
const catalog = await readFile(path.join(root, "src/features/prompt-center/catalog.js"), "utf8");
const view = await readFile(path.join(root, "src/views/prompt-center.html"), "utf8");
const shell = await readFile(path.join(root, "src/views/document-shell.html"), "utf8");
const home = await readFile(path.join(root, "src/views/home.html"), "utf8");
const schema = await readFile(path.join(root, "src/legacy/main-app/004-base64.js.part"), "utf8");
const backup = await readFile(path.join(root, "src/legacy/main-app/006-blob.js.part"), "utf8");
const streamBackup = await readFile(path.join(root, "src/legacy/main-app/041-has-compressed.js.part"), "utf8");
const icon = await readFile(path.join(root, "icons/prompt-center.svg"), "utf8");

for (const id of ["prompt-center-screen", "pc-master-switch", "pc-main-content", "pc-import-input", "pc-sheet-backdrop", "pc-reset-prompts-btn", "pc-picker-backdrop", "pc-picker-options"]) {
  assert.match(view, new RegExp(`id=["']${id}["']`), `missing prompt-center UI id ${id}`);
}
assert.match(home, /id="prompt-center-home-entry"/, "home entry is missing");
assert.match(shell, /src="prompt-center\.js" defer/, "prompt-center runtime script is missing");
for (const table of ["promptSettings", "promptItems", "promptPresets", "promptBindings", "promptDiagnostics"]) {
  assert.match(schema, new RegExp(`${table}:`), `database schema is missing ${table}`);
  assert.match(backup, new RegExp(`db\.${table}\.toArray\(\)`), `full backup is missing ${table}`);
  assert.match(streamBackup, new RegExp(`["']${table}["']`), `stream backup is missing ${table}`);
}
assert.match(source, /isThoughtChainContent/, "thought-chain exclusion is missing");
assert.match(source, /async function resetPromptItems/, "prompt item reset is missing");
assert.match(source, /function openFeaturePicker/, "scrollable feature picker is missing");
assert.match(source, /当前聊天角色名称/, "variable descriptions are missing");
assert.match(icon, /<rect[^>]+fill="#fff"/, "prompt center icon must use a white SVG background");
assert.match(catalog, /第一部分：角色核心设定/, "built-in original chat prompt catalog is missing");
assert.ok((catalog.match(/entry\(/g) || []).length >= 20, "prompt center must be populated before the first model request");
assert.match(source, /if \(!settings\.enabled \|\| settings\.featureToggles\[featureId\] === false\)/, "disabled mode guard is missing");
assert.match(source, /if \(!prepared\.changed\) return nativeFetch\(input, init\)/, "unchanged requests must keep their original body");

function table(records = []) {
  return {
    records: structuredClone(records),
    async get(id) { return structuredClone(this.records.find((item) => item.id === id)); },
    async toArray() { return structuredClone(this.records); },
    async put(value) { const index = this.records.findIndex((item) => item.id === value.id); if (index >= 0) this.records[index] = structuredClone(value); else this.records.push(structuredClone(value)); return value.id; },
    async bulkPut(values) { for (const value of values) await this.put(value); },
    async add(value) { this.records.push(structuredClone(value)); return this.records.length; },
    async count() { return this.records.length; },
    orderBy() { return { limit: () => ({ primaryKeys: async () => [] }) }; },
    async bulkDelete(ids) { this.records = this.records.filter((item) => !ids.includes(item.id)); },
    async clear() { this.records = []; },
  };
}

const db = {
  isOpen: () => true,
  promptSettings: table([{ id: "main", enabled: true, diagnosticsEnabled: false, featureToggles: {} }]),
  promptItems: table([{ id: "test-custom", name: "通用补充", featureId: "all", kind: "custom", role: "system", placement: "after", enabled: true, useCustom: true, customContent: "附加规则 {{character.name}}" }]),
  promptPresets: table(),
  promptDiagnostics: table(),
};
const document = {
  readyState: "loading",
  addEventListener() {},
  getElementById() { return null; },
  createElement() { return { textContent: "", get innerHTML() { return this.textContent; } }; },
};
const nativeFetch = async (input, init) => ({ input, init });
const context = vm.createContext({
  window: { fetch: nativeFetch, db, state: { activeChatId: "c1", chats: { c1: { name: "小兔", settings: {} } }, qzoneSettings: {}, apiConfig: {} } },
  document,
  console,
  Blob: class {},
  FileReader: class {},
  URL: { createObjectURL() { return "blob:test"; }, revokeObjectURL() {} },
  setTimeout,
  clearTimeout,
  Date,
  JSON,
  Math,
});
vm.runInContext(catalog, context, { filename: "prompt-center/catalog.js" });
vm.runInContext(source, context, { filename: "prompt-center/app.js" });
await new Promise((resolve) => setTimeout(resolve, 0));

const app = context.window.PromptCenterApp;
assert.equal(app.getSettings().enabled, true, "stored master switch was not loaded");
assert.ok(app.getItems().length >= 20, "built-in prompt items were not available immediately after loading");
const prepared = app.prepareMessages([{ role: "system", content: "每次回复必须包含 chatResponse JSON对象" }, { role: "user", content: "你好" }]);
assert.equal(prepared.featureId, "chat-single");
assert.equal(prepared.messages.at(-1).content, "附加规则 小兔", "custom prompt was not expanded and appended");
assert.ok(app.getItems().some((item) => item.id === "pc-captured:chat-single:system:0:0"), "actual default prompt was not registered as an item");

const thoughtOnly = app.prepareMessages([{ role: "system", content: "[incipere]\n<thinking>思维链首部协议</thinking>" }, { role: "user", content: "普通消息" }]);
assert.ok(!app.getItems().some((item) => item.defaultContent.includes("思维链首部协议")), "thought-chain content must not be managed by prompt center");
assert.equal(thoughtOnly.messages.filter((message) => message.content.includes("附加规则")).length, 1, "custom prompt should remain independent from thought-chain content");

const originalBody = JSON.stringify({ model: "test", messages: [{ role: "system", content: "每次回复必须包含 chatResponse JSON对象" }] });
const response = await context.window.fetch("https://example.test/v1/chat/completions", { method: "POST", body: originalBody });
const sent = JSON.parse(response.init.body);
assert.ok(sent.messages.some((message) => message.content === "附加规则 小兔"), "fetch boundary did not apply prompt center output");

console.log("prompt center check passed");
