import { access, readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const layout = JSON.parse(await readFile(path.join(root, "source-layout.json"), "utf8"));
const contract = JSON.parse(await readFile(path.join(root, "protected-runtime-contract.json"), "utf8"));
const mappings = layout.generatedFiles;
const failures = [];
const sourceFiles = [...new Set(Object.values(mappings).flat())];
const readCombined = async (files) => (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("");
const checkClassicScript = (source, label) => {
  const result = spawnSync(process.execPath, ["--check", "-"], { input: source, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) failures.push(`${label}: classic-script syntax check failed\n${result.stderr}`);
};

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(full));
    else files.push(full);
  }
  return files;
}

function payloadValue(source) {
  const match = source.match(/\.push\(([\s\S]*)\);\s*$/);
  if (!match) throw new Error("Invalid runtime payload");
  return JSON.parse(match[1]);
}

for (const file of sourceFiles) {
  const size = (await stat(path.join(root, file))).size;
  const limit = file.endsWith(".html") || file.endsWith(".css") ? 40 * 1024 : 60 * 1024;
  if (size > limit) failures.push(`${file}: ${(size / 1024).toFixed(1)} KB exceeds ${(limit / 1024).toFixed(0)} KB`);
}

for (const [output, inputs] of Object.entries(mappings)) {
  if (output.endsWith(".js")) checkClassicScript(await readCombined(inputs), `source bundle ${output}`);
}

const templateHtml = await readCombined(mappings["index.html"]);
const mainScript = await readCombined(mappings["main-app.js"]);
const runtimeHtml = await readFile(path.join(root, "index.html"), "utf8");
const hashList = (values) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const elementIds = [...templateHtml.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const screenIds = [...templateHtml.matchAll(/<[^>]+id="([^"]+)"[^>]+class="[^"]*\bscreen\b[^"]*"|<[^>]+class="[^"]*\bscreen\b[^"]*"[^>]+id="([^"]+)"/g)]
  .map((match) => match[1] || match[2]);
const originalScriptReferences = [...templateHtml.matchAll(/<script\s+src="([^"]+)"/g)].map((match) => match[1]);
const runtimeScriptReferences = [...runtimeHtml.matchAll(/<script\s+src="([^"]+)"/g)]
  .map((match) => match[1])
  .filter((reference) => !reference.startsWith("runtime/"));
const inlineHandlerCount = [...templateHtml.matchAll(/\bon(?:click|change|input|submit|load|error|keydown|keyup)=/g)].length;
const schema = mainScript.match(/db\.version\(63\)\.stores\(\{[\s\S]*?\n\s*\}\);/)?.[0];

if (elementIds.length !== contract.elementIdCount || hashList(elementIds) !== contract.elementIdOrderHash) failures.push("protected DOM id contract changed");
if (screenIds.length !== contract.screenCount || hashList(screenIds) !== contract.screenIdOrderHash) failures.push("protected screen contract changed");
if (inlineHandlerCount !== contract.inlineHandlerCount) failures.push("protected inline interaction contract changed");
if (JSON.stringify(originalScriptReferences) !== JSON.stringify(contract.scriptReferences)) failures.push("protected script source order changed");
if (JSON.stringify(runtimeScriptReferences) !== JSON.stringify(contract.scriptReferences)) failures.push("runtime script runner order changed");
if (!schema || createHash("sha256").update(schema).digest("hex") !== contract.databaseSchemaHash) failures.push("protected Dexie schema contract changed");

const bodySource = templateHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1];
const viewDirectory = path.join(root, "runtime", "views");
const viewFiles = (await readdir(viewDirectory)).sort().map((file) => path.join(viewDirectory, file));
const runtimeBody = (await Promise.all(viewFiles.map(async (file) => payloadValue(await readFile(file, "utf8"))))).join("");
if (runtimeBody !== bodySource) failures.push("runtime view payloads do not reconstruct the protected body exactly");

for (const [bundleName, inputs] of Object.entries(mappings).filter(([name]) => name.endsWith(".js"))) {
  const directory = path.join(root, "runtime", "scripts", bundleName.replace(/\.js$/, ""));
  const files = (await readdir(directory)).sort().map((file) => path.join(directory, file));
  const runtimeSource = (await Promise.all(files.map(async (file) => payloadValue(await readFile(file, "utf8"))))).join("");
  if (runtimeSource !== await readCombined(inputs)) failures.push(`${bundleName}: runtime payload does not reconstruct source exactly`);
}

for (const file of ["index.html", "style.css", ...Object.keys(mappings).filter((name) => name.endsWith(".js")), "runtime/inject-html.js"]) {
  const size = (await stat(path.join(root, file))).size;
  if (size > 20 * 1024) failures.push(`${file}: runtime entry ${(size / 1024).toFixed(1)} KB exceeds 20 KB`);
}
for (const file of await collectFiles(path.join(root, "runtime"))) {
  if ((await stat(file)).size > 60 * 1024) failures.push(`${path.relative(root, file)} exceeds 60 KB`);
  if (file.endsWith(".js")) checkClassicScript(await readFile(file, "utf8"), path.relative(root, file));
}

for (const reference of [...runtimeHtml.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])) {
  if (/^(?:https?:|data:|#|blob:|javascript:)/.test(reference)) continue;
  try { await access(path.join(root, reference.split(/[?#]/, 1)[0])); }
  catch { failures.push(`index.html: missing local resource ${reference}`); }
}

if (failures.length) {
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exit(1);
}
console.log(`architecture check passed for ${sourceFiles.length} source files and the small-file runtime`);
