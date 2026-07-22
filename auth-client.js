(async function () {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    const data = await response.json();
    if (!data.enabled || !data.authenticated) return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Logout";
    button.setAttribute("aria-label", "Logout");
    button.style.cssText = [
      "position:fixed",
      "left:24px",
      "bottom:24px",
      "width:202px",
      "z-index:10000",
      "border:1px solid rgba(255,255,255,.38)",
      "border-radius:999px",
      "padding:10px 14px",
      "background:rgba(65,20,14,.78)",
      "color:#fff8f1",
      "font:700 12px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "box-shadow:0 14px 34px rgba(51,37,27,.22)",
      "cursor:pointer",
      "backdrop-filter:blur(12px)"
    ].join(";");
    button.addEventListener("click", async () => {
      const existing = document.getElementById("logoutConfirmOverlay");
      if (existing) existing.remove();
      const overlay = document.createElement("div");
      overlay.id = "logoutConfirmOverlay";
      overlay.style.cssText = [
        "position:fixed",
        "inset:0",
        "z-index:10001",
        "display:grid",
        "place-items:center",
        "padding:24px",
        "background:rgba(51,37,27,.34)",
        "backdrop-filter:blur(5px)"
      ].join(";");
      overlay.innerHTML = `
        <div role="dialog" aria-modal="true" aria-label="Confirm logout" style="
          width:min(360px, 100%);
          border:1px solid rgba(255,255,255,.48);
          border-radius:28px;
          padding:24px;
          background:linear-gradient(145deg, rgba(255,248,241,.94), rgba(242,222,206,.86));
          box-shadow:0 28px 80px rgba(51,37,27,.26);
          color:#2a1713;
          text-align:center;
          font-family:Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        ">
          <div style="font-size:18px;font-weight:900;color:#41140E;margin-bottom:8px;">Confirm Logout?</div>
          <div style="font-size:13px;line-height:1.6;color:#78665e;margin-bottom:20px;">确定要登出 Dashboard 吗？</div>
          <div style="display:flex;gap:10px;justify-content:center;">
            <button type="button" data-logout-cancel style="
              border:1px solid rgba(65,20,14,.16);
              border-radius:999px;
              padding:10px 16px;
              background:rgba(255,255,255,.58);
              color:#41140E;
              font:800 12px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              cursor:pointer;
            ">Cancel</button>
            <button type="button" data-logout-confirm style="
              border:0;
              border-radius:999px;
              padding:10px 18px;
              background:#41140E;
              color:#fff8f1;
              font:900 12px Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
              cursor:pointer;
              box-shadow:0 12px 28px rgba(65,20,14,.22);
            ">Logout</button>
          </div>
        </div>
      `;
      overlay.addEventListener("click", event => {
        if (event.target === overlay || event.target.closest("[data-logout-cancel]")) overlay.remove();
      });
      overlay.querySelector("[data-logout-confirm]").addEventListener("click", async () => {
        await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        location.href = "/login";
      });
      document.body.appendChild(overlay);
    });
    document.body.appendChild(button);
  } catch (error) {
    console.warn("Auth status check failed", error);
  }
})();
