import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const runtimeRoot = path.resolve(root, "runtime");
const layout = JSON.parse(await readFile(path.join(root, "source-layout.json"), "utf8"));
const mappings = layout.generatedFiles;
const htmlSources = mappings["index.html"];
const styleSources = mappings["style.css"];
const scriptMappings = Object.fromEntries(
  Object.entries(mappings).filter(([output]) => output.endsWith(".js")),
);

if (!runtimeRoot.startsWith(root + path.sep)) throw new Error("Unsafe runtime output path");
await rm(runtimeRoot, { recursive: true, force: true });
await mkdir(runtimeRoot, { recursive: true });

async function concatenate(files) {
  return (await Promise.all(files.map((file) => readFile(path.join(root, file), "utf8")))).join("");
}

async function writePayload(directory, index, expression) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${String(index + 1).padStart(3, "0")}.js`);
  await writeFile(file, `${expression}\n`, "utf8");
  return path.relative(root, file).replaceAll("\\", "/");
}

const scriptPayloads = {};
for (const [bundleName, sourceFiles] of Object.entries(scriptMappings)) {
  const bundleDirectory = path.join(runtimeRoot, "scripts", bundleName.replace(/\.js$/, ""));
  scriptPayloads[bundleName] = [];
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const source = await readFile(path.join(root, sourceFiles[index]), "utf8");
    const expression = `((globalThis.__tukSourceBundles ??= Object.create(null))[${JSON.stringify(bundleName)}] ??= []).push(${JSON.stringify(source)});`;
    scriptPayloads[bundleName].push(await writePayload(bundleDirectory, index, expression));
  }

  const runner = `(() => {\n  const name = ${JSON.stringify(bundleName)};\n  const registry = globalThis.__tukSourceBundles;\n  const parts = registry?.[name];\n  if (!parts) throw new Error(\`Missing source payload for \${name}\`);\n  const script = document.createElement("script");\n  script.textContent = parts.join("");\n  document.head.appendChild(script);\n  script.remove();\n  delete registry[name];\n  if (Object.keys(registry).length === 0) delete globalThis.__tukSourceBundles;\n})();\n`;
  await writeFile(path.join(root, bundleName), runner, "utf8");
}

const cssImports = styleSources.map((file) => `@import url("./${file}");`).join("\n");
await writeFile(path.join(root, "style.css"), `${cssImports}\n`, "utf8");

const templateHtml = await concatenate(htmlSources);
const bodyMatch = templateHtml.match(/<body([^>]*)>([\s\S]*?)<\/body>/i);
if (!bodyMatch) throw new Error("Unable to locate the protected body markup");
const bodyInner = bodyMatch[2];
const bodyStart = bodyMatch.index;
const openingBody = `<body${bodyMatch[1]}>`;
const bodyContentStart = bodyStart + openingBody.length;
const bodyContentEnd = bodyContentStart + bodyInner.length;

function splitByBytes(source, maximum = 36 * 1024) {
  const lines = source.match(/.*(?:\r\n|\n|$)/g).filter(Boolean);
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if (current && Buffer.byteLength(current + line) > maximum) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks;
}

const viewChunks = splitByBytes(bodyInner);
const viewPayloads = [];
for (let index = 0; index < viewChunks.length; index += 1) {
  const expression = `(globalThis.__tukViewParts ??= []).push(${JSON.stringify(viewChunks[index])});`;
  viewPayloads.push(await writePayload(path.join(runtimeRoot, "views"), index, expression));
}

const injectHtml = `(() => {\n  const runner = document.currentScript;\n  const markup = (globalThis.__tukViewParts ?? []).join("");\n  document.write(markup);\n  runner.remove();\n  delete globalThis.__tukViewParts;\n})();\n`;
await writeFile(path.join(runtimeRoot, "inject-html.js"), injectHtml, "utf8");

let headAndOpeningBody = templateHtml.slice(0, bodyContentStart);
for (const [bundleName, payloadFiles] of Object.entries(scriptPayloads)) {
  const escapedName = bundleName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const scriptPattern = new RegExp(`<script\\s+src="${escapedName}"([^>]*)><\\/script>`);
  const match = headAndOpeningBody.match(scriptPattern);
  if (!match) throw new Error(`Unable to locate runtime script reference ${bundleName}`);
  const defer = /\bdefer\b/.test(match[1]);
  const payloadTags = payloadFiles
    .map((file) => `    <script src="${file}"${defer ? " defer" : ""}></script>`)
    .join("\n");
  headAndOpeningBody = headAndOpeningBody.replace(match[0], `${payloadTags}\n${match[0]}`);
}

const viewTags = viewPayloads.map((file) => `    <script src="${file}"></script>`).join("\n");
headAndOpeningBody = headAndOpeningBody.replace("</head>", `${viewTags}\n  </head>`);
const tail = templateHtml.slice(bodyContentEnd);
const runtimeHtml = `${headAndOpeningBody}\n    <script src="runtime/inject-html.js"></script>${tail}`;
await writeFile(path.join(root, "index.html"), runtimeHtml, "utf8");

console.log(`built small runtime index with ${viewPayloads.length} view payloads`);
console.log(`built small stylesheet entry with ${styleSources.length} imports`);
console.log(`built ${Object.keys(scriptMappings).length} small script runners with ${Object.values(scriptPayloads).flat().length} payloads`);
