(function () {
  const enhanced = new WeakMap();

  function labelFor(select) {
    return select.options[select.selectedIndex]?.textContent?.trim() || select.value || "选择";
  }

  function closeAll(except) {
    document.querySelectorAll(".custom-select.is-open").forEach(box => {
      if (box !== except) box.classList.remove("is-open");
    });
  }

  function sync(select) {
    const widget = enhanced.get(select);
    if (!widget) return;
    widget.button.querySelector(".custom-select-value").textContent = labelFor(select);
    widget.options.querySelectorAll("[data-value]").forEach(option => {
      const active = option.dataset.value === select.value;
      option.classList.toggle("is-selected", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function enhance(select) {
    if (!(select instanceof HTMLSelectElement) || enhanced.has(select)) return;
    const wrapper = document.createElement("div");
    wrapper.className = "custom-select";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "custom-select-button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = `<span class="custom-select-value"></span><span class="custom-select-chevron">⌄</span>`;
    const list = document.createElement("div");
    list.className = "custom-select-options";
    list.setAttribute("role", "listbox");

    Array.from(select.options).forEach(option => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "custom-select-option";
      item.dataset.value = option.value;
      item.setAttribute("role", "option");
      item.textContent = option.textContent;
      item.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        wrapper.classList.remove("is-open");
        sync(select);
      });
      list.appendChild(item);
    });

    select.classList.add("native-select-hidden");
    select.insertAdjacentElement("afterend", wrapper);
    wrapper.append(button, list);
    enhanced.set(select, { wrapper, button, options: list });

    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const nextOpen = !wrapper.classList.contains("is-open");
      closeAll(wrapper);
      if (nextOpen) {
        document.querySelectorAll(".date-popover, .month-popover, .analysis-date-popover").forEach(panel => {
          panel.hidden = true;
        });
      }
      wrapper.classList.toggle("is-open", nextOpen);
      button.setAttribute("aria-expanded", nextOpen ? "true" : "false");
      sync(select);
    });

    button.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        wrapper.classList.remove("is-open");
        button.setAttribute("aria-expanded", "false");
      }
    });

    select.addEventListener("change", () => sync(select));
    sync(select);
  }

  function init(root = document) {
    root.querySelectorAll("select").forEach(enhance);
    window.customSelectRefresh();
  }

  window.customSelectRefresh = function customSelectRefresh(root = document) {
    root.querySelectorAll("select").forEach(enhance);
    document.querySelectorAll("select.native-select-hidden").forEach(sync);
  };

  document.addEventListener("click", event => {
    if (!event.target.closest(".custom-select")) closeAll();
  });

  document.addEventListener("DOMContentLoaded", () => init());
})();
