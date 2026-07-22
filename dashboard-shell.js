(function () {
  const frame = document.getElementById("contentFrame");
  const channelList = document.getElementById("channelList");
  const overviewButton = document.getElementById("inboxOverview");
  const params = new URLSearchParams(window.location.search);

  const accounts = new Set(["fb108701968299986", "fb1177107122151553", "fb701760706347255"]);
  let activeTarget = "";
  let activeAccount = "";

  function currentDate() {
    return params.get("date") || new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kuala_Lumpur" });
  }

  function buildSrc(target, account) {
    const date = currentDate();
    if (target === "order-key-in") {
      return `/order-key-in?account=${encodeURIComponent(account || params.get("account") || "fb108701968299986")}&date=${encodeURIComponent(date)}&embedded=1`;
    }
    if (target === "broadcast-planning") {
      return `/broadcast-planning?account=${encodeURIComponent(account || params.get("account") || "fb108701968299986")}&date=${encodeURIComponent(date)}&embedded=1`;
    }
    if (target === "analysis-account") {
      return `/index?account=${encodeURIComponent(account)}&date=${encodeURIComponent(date)}&embedded=1`;
    }
    return `/index?date=${encodeURIComponent(date)}&embedded=1`;
  }

  function updateUrl(target, account) {
    const next = new URL(window.location.href);
    next.searchParams.set("view", target);
    if (account) next.searchParams.set("account", account);
    else if (target === "analysis-overview") next.searchParams.delete("account");
    next.searchParams.set("date", currentDate());
    params.set("view", target);
    if (account) params.set("account", account);
    else if (target === "analysis-overview") params.delete("account");
    params.set("date", currentDate());
    history.pushState({ target, account }, "", next);
  }

  function setDropdown(open) {
    channelList.hidden = !open;
    overviewButton.classList.toggle("open", open);
    overviewButton.setAttribute("aria-expanded", String(open));
  }

  function setActive(target, account, push = true, options = {}) {
    const openAnalysis = Boolean(options.openAnalysis);
    activeTarget = target;
    activeAccount = account || "";
    document.querySelectorAll(".side-item").forEach(item => item.classList.remove("active"));
    if (target === "analysis-overview") {
      overviewButton.classList.add("active");
      setDropdown(openAnalysis);
    } else if (target === "analysis-account") {
      setDropdown(true);
      document.querySelector(`[data-target="analysis-account"][data-account="${account}"]`)?.classList.add("active");
    } else {
      setDropdown(false);
      document.querySelector(`[data-target="${target}"]`)?.classList.add("active");
    }
    frame.src = buildSrc(target, account);
    if (push) updateUrl(target, account);
  }

  overviewButton.addEventListener("click", () => {
    const isOpen = !channelList.hidden;
    if (activeTarget === "analysis-overview" && isOpen) {
      setDropdown(false);
      return;
    }
    setActive("analysis-overview", "", true, { openAnalysis: !isOpen });
  });

  document.querySelectorAll("[data-target]").forEach(button => {
    if (button === overviewButton) return;
    button.addEventListener("click", () => {
      setActive(button.dataset.target, button.dataset.account || params.get("account") || "");
    });
  });

  window.addEventListener("popstate", () => {
    const next = new URLSearchParams(window.location.search);
    params.set("date", next.get("date") || currentDate());
    const target = next.get("view") || (accounts.has(next.get("account")) ? "analysis-account" : "analysis-overview");
    const account = next.get("account") || "";
    setActive(target, account, false);
  });

  window.addEventListener("message", event => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type !== "dashboard-date-change") return;
    const rawValue = String(event.data.value || "");
    const normalizedDate = /^\d{4}-\d{2}$/.test(rawValue) ? `${rawValue}-01` : rawValue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return;
    params.set("date", normalizedDate);
    const next = new URL(window.location.href);
    next.searchParams.set("date", normalizedDate);
    history.replaceState(history.state || {}, "", next);
  });

  const pathTarget = location.pathname.includes("order-key-in")
    ? "order-key-in"
    : location.pathname.includes("broadcast-planning")
      ? "broadcast-planning"
      : "";
  const initialTarget = params.get("view") || pathTarget || (accounts.has(params.get("account")) ? "analysis-account" : "analysis-overview");
  setActive(initialTarget, params.get("account") || "", false);
})();
