(() => {
  const runner = document.currentScript;
  const markup = (globalThis.__tukViewParts ?? []).join("");
  document.write(markup);
  runner.remove();
  delete globalThis.__tukViewParts;
})();
