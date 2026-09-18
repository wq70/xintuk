(function () {
  "use strict";

  const NEVER_SHOW_KEY = "ephone:update-notice:never-show";

  function byId(id) { return document.getElementById(id); }

  function closeNotice(neverShowAgain) {
    const modal = byId("update-notice-modal");
    if (!modal) return;
    modal.classList.remove("visible");
    modal.setAttribute("aria-hidden", "true");
    if (neverShowAgain) {
      localStorage.setItem(NEVER_SHOW_KEY, "true");
    }
  }

  function openNotice() {
    const modal = byId("update-notice-modal");
    if (!modal) return;
    modal.classList.add("visible");
    modal.setAttribute("aria-hidden", "false");
  }

  function init() {
    byId("update-notice-close")?.addEventListener("click", () => closeNotice(false));
    byId("update-notice-never")?.addEventListener("click", () => closeNotice(true));
    byId("update-notice-confirm")?.addEventListener("click", () => closeNotice(false));

    if (localStorage.getItem(NEVER_SHOW_KEY) !== "true") {
      openNotice();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
