import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/features/api/request-parameters.js", import.meta.url), "utf8");
const documentStub = {
  readyState: "complete",
  getElementById: () => null,
};
const windowStub = { state: { apiConfig: {} } };
const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  console,
  JSON,
  Number,
  Object,
  String,
  Set,
});
vm.runInContext(source, context, { filename: "request-parameters.js" });

const api = windowStub.ApiGenerationParams;
assert.ok(api, "ApiGenerationParams should be exposed");

const migrated = api.normalizeApiConfig({ temperature: 0 });
assert.equal(migrated.generationParams.temperature.value, 0, "legacy zero temperature must be preserved");
assert.equal(migrated.generationParams.temperature.enabled, true);

const disabled = api.normalizeApiConfig({
  generationParams: { temperature: { enabled: false, value: 1.4 } },
});
assert.equal("temperature" in api.openAI({}, {}, disabled), false, "disabled OpenAI temperature must be omitted");
assert.equal("temperature" in api.gemini({}, {}, disabled), false, "disabled Gemini temperature must be omitted");

const configured = api.normalizeApiConfig({
  generationParams: {
    temperature: { enabled: true, value: 0 },
    topP: { enabled: true, value: 0.75 },
    maxOutputTokens: { enabled: true, value: 3000, openAIField: "max_tokens" },
    frequencyPenalty: { enabled: true, value: 0.2 },
    presencePenalty: { enabled: true, value: -0.1 },
    topK: { enabled: true, value: 32 },
    seed: { enabled: true, value: 7 },
    stopSequences: { enabled: true, value: ["END", "END", "STOP"] },
    custom: { enabled: true, value: { min_p: 0.1, model: "blocked" } },
  },
});
const openAI = api.openAI({}, { maxOutputTokens: 2048 }, configured);
assert.deepEqual(JSON.parse(JSON.stringify(openAI)), {
  min_p: 0.1,
  temperature: 0,
  top_p: 0.75,
  frequency_penalty: 0.2,
  presence_penalty: -0.1,
  seed: 7,
  stop: ["END", "STOP"],
  max_tokens: 2048,
});
const gemini = api.gemini({}, { maxOutputTokens: 2048 }, configured);
assert.deepEqual(JSON.parse(JSON.stringify(gemini)), {
  min_p: 0.1,
  temperature: 0,
  topP: 0.75,
  maxOutputTokens: 2048,
  frequencyPenalty: 0.2,
  presencePenalty: -0.1,
  topK: 32,
  seed: 7,
  stopSequences: ["END", "STOP"],
});

assert.equal(api.resolveProtocol({ apiProtocol: "gemini", proxyUrl: "https://proxy.example" }), "gemini");
assert.equal(api.resolveProtocol({ apiProtocol: "auto", proxyUrl: "https://api.example" }), "openai");
assert.equal(api.resolveProtocol({ apiProtocol: "auto", proxyUrl: "https://generativelanguage.googleapis.com/v1beta/models" }), "gemini");

console.log("API generation parameter checks passed.");
