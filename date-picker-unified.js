(function () {
  const pickers = [
    { control: ".analysis-date-control", label: "#dateLabel", popover: "#datePopover", prev: "#prevDay", next: "#nextDay" },
    { control: ".order-date-control", label: "#orderDateLabel", popover: "#orderDatePopover", prev: "#orderPrevDay", next: "#orderNextDay" },
    { control: ".month-control", label: "#monthLabel", popover: "#monthPopover", prev: "#prevMonth", next: "#nextMonth" }
  ];

  function element(selector) {
    return selector ? document.querySelector(selector) : null;
  }

  function closePicker(picker) {
    const popover = element(picker.popover);
    const label = element(picker.label);
    if (!popover) return;
    popover.hidden = true;
    if (label) label.setAttribute("aria-expanded", "false");
  }

  function normalizedDateFromText(text = "") {
    const value = String(text || "").trim();
    const dayMatch = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (dayMatch) return `${dayMatch[3]}-${dayMatch[2]}-${dayMatch[1]}`;
    const monthMatch = value.match(/^(\d{2})\/(\d{4})$/);
    if (monthMatch) return `${monthMatch[2]}-${monthMatch[1]}`;
    return "";
  }

  function notifyDateChange() {
    const labels = ["#dateLabel", "#orderDateLabel", "#monthLabel"]
      .map(selector => element(selector))
      .filter(Boolean);
    const label = labels.find(item => normalizedDateFromText(item.textContent || item.value || ""));
    const value = label ? normalizedDateFromText(label.textContent || label.value || "") : "";
    if (!value || window.parent === window) return;
    window.parent.postMessage({ type: "dashboard-date-change", value }, window.location.origin);
  }

  function notifySoon() {
    setTimeout(notifyDateChange, 80);
  }

  function closeOtherPickers(activePicker) {
    pickers.forEach(picker => {
      if (picker !== activePicker) closePicker(picker);
    });
  }

  function pickerFromTarget(target, key) {
    return pickers.find(picker => picker[key] && target.closest(picker[key]));
  }

  document.addEventListener("pointerdown", event => {
    const target = event.target;
    const labelPicker = pickerFromTarget(target, "label");
    if (labelPicker) {
      closeOtherPickers(labelPicker);
      return;
    }

    const arrowPicker = pickers.find(picker =>
      (picker.prev && target.closest(picker.prev)) ||
      (picker.next && target.closest(picker.next))
    );
    if (arrowPicker) {
      requestAnimationFrame(() => closePicker(arrowPicker));
      notifySoon();
      return;
    }

    const insidePicker = pickers.some(picker =>
      (picker.control && target.closest(picker.control)) ||
      (picker.popover && target.closest(picker.popover))
    );
    if (!insidePicker) {
      pickers.forEach(closePicker);
    }
  }, true);

  document.addEventListener("click", event => {
    const clickedPickerOption = pickers.some(picker => picker.popover && event.target.closest(picker.popover));
    if (clickedPickerOption) notifySoon();
  }, true);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") pickers.forEach(closePicker);
  });
})();
