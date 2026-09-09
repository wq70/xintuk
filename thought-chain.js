(() => {
  const name = "thought-chain.js";
  const registry = globalThis.__tukSourceBundles;
  const parts = registry?.[name];
  if (!parts) throw new Error(`Missing source payload for ${name}`);
  const script = document.createElement("script");
  script.textContent = parts.join("");
  document.head.appendChild(script);
  script.remove();
  delete registry[name];
  if (Object.keys(registry).length === 0) delete globalThis.__tukSourceBundles;
})();
