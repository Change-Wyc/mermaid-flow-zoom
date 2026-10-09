const { Plugin, Notice } = require("obsidian");

const PLUGIN_ID = "mermaid-flow-zoom";
const MIN_SCALE = 0.05;
const MAX_SCALE = 12;
const ZOOM_STEP = 1.18;
const EDGE_SCROLL_ZONE = 46;

module.exports = class MermaidFlowZoomPlugin extends Plugin {
  async onload() {
    this.instances = new Set();

    this.registerMarkdownPostProcessor((el) => {
      window.setTimeout(() => this.enhanceMermaid(el), 0);
    });

    this.observeDynamicMermaid();

    this.addCommand({
      id: "reset-visible-mermaid-diagrams",
      name: "Reset visible Mermaid diagrams",
      callback: () => {
        let count = 0;
        for (const instance of this.instances) {
          if (document.body.contains(instance.container)) {
            instance.reset();
            count += 1;
          }
        }
        new Notice(`Reset ${count} Mermaid diagram${count === 1 ? "" : "s"}.`);
      },
    });
  }

  onunload() {
    document.body.classList.remove("mfz-fullscreen-open");
    for (const instance of this.instances) instance.destroy();
    this.instances.clear();
  }

  observeDynamicMermaid() {
    let queued = false;
    this.mutationObserver = new MutationObserver((mutations) => {
      if (queued) return;
      if (!mutations.some((mutation) => Array.from(mutation.addedNodes).some((node) => this.nodeMayContainMermaid(node)))) {
        return;
      }
      queued = true;
      window.requestAnimationFrame(() => {
        queued = false;
        this.enhanceMermaid(document.body);
      });
    });

    this.mutationObserver.observe(document.body, { childList: true, subtree: true });
    this.register(() => this.mutationObserver.disconnect());
  }

  nodeMayContainMermaid(node) {
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return false;
    if (node instanceof SVGElement) return (node.getAttribute("id") || "").toLowerCase().includes("mermaid");
    return Boolean(node.matches(".mermaid, .mermaid-rendered") || node.querySelector(".mermaid, .mermaid-rendered, svg[id^='mermaid']"));
  }

  enhanceMermaid(root) {
    const candidates = root.querySelectorAll(
      ".mermaid svg, .mermaid-rendered svg, .markdown-rendered svg[id^='mermaid'], svg[id^='mermaid']"
    );

    for (const svg of candidates) {
      if (svg.closest(".mfz-container") || svg.dataset.mfzEnhanced === "true") continue;
      if (!this.looksLikeMermaid(svg)) continue;

      const instance = new MermaidZoomInstance(svg, () => this.instances.delete(instance));
      this.instances.add(instance);
    }
  }

  looksLikeMermaid(svg) {
    const parent = svg.closest(".mermaid, .mermaid-rendered");
    if (parent) return true;
    const id = svg.getAttribute("id") || "";
    return id.toLowerCase().includes("mermaid");
  }
};

class MermaidZoomInstance {
  constructor(svg, onDestroy) {
    this.svg = svg;
    this.onDestroy = onDestroy;
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    this.activePointers = new Map();
    this.lastPinch = null;
    this.dragStart = null;
    this.fullscreenRestore = null;
    this.frame = null;

    this.originalParent = svg.parentElement;
    this.originalNextSibling = svg.nextSibling;
    this.originalInlineStyle = svg.getAttribute("style");
    this.originalWidth = svg.getAttribute("width");
    this.originalHeight = svg.getAttribute("height");
    this.diagramKind = this.detectDiagramKind();

    this.build();
    this.bind();
    this.autoSizeSoon();
    this.resetSoon();
  }

  build() {
    this.svg.dataset.mfzEnhanced = "true";
    this.svg.removeAttribute("width");
    this.svg.removeAttribute("height");

    this.container = document.createElement("div");
    this.container.className = `mfz-container mfz-kind-${this.diagramKind}`;
    this.container.tabIndex = 0;
    this.container.dataset.mfzKind = this.diagramKind;

    this.viewport = document.createElement("div");
    this.viewport.className = "mfz-viewport";

    this.content = document.createElement("div");
    this.content.className = "mfz-content";

    this.toolbar = document.createElement("div");
    this.toolbar.className = "mfz-toolbar";

    this.zoomOutButton = this.button("−", "缩小", () => this.zoomAtCenter(1 / ZOOM_STEP));
    this.zoomInButton = this.button("+", "放大", () => this.zoomAtCenter(ZOOM_STEP));
    this.resetButton = this.button("⟲", "重置并自适应", () => this.reset());
    this.fullscreenButton = this.button("⛶", "全屏查看", () => this.toggleFullscreen());

    this.toolbar.append(
      this.zoomOutButton,
      this.zoomInButton,
      this.resetButton,
      this.fullscreenButton
    );

    this.help = document.createElement("div");
    this.help.className = "mfz-help";
    this.help.textContent = "滚轮缩放，拖拽平移，Shift/横向滚轮左右移动，拖动右下角调整大小";

    this.originalParent.insertBefore(this.container, this.originalNextSibling);
    this.content.appendChild(this.svg);
    this.viewport.appendChild(this.content);
    this.container.append(this.viewport, this.toolbar, this.help);
  }

  detectDiagramKind() {
    const classText = Array.from(this.svg.classList || []).join(" ").toLowerCase();
    const ariaText = (this.svg.getAttribute("aria-roledescription") || "").toLowerCase();
    const labelText = (this.svg.getAttribute("aria-label") || "").toLowerCase();
    const text = `${classText} ${ariaText} ${labelText}`;

    if (text.includes("sequence") || text.includes("sequencediagram")) return "sequence";
    if (text.includes("flowchart") || text.includes("graph")) return "flowchart";
    if (text.includes("classdiagram")) return "class";
    if (text.includes("statediagram")) return "state";
    if (text.includes("gantt")) return "timeline";
    return "generic";
  }

  getProfile() {
    if (this.diagramKind === "sequence") {
      return {
        minHeight: this.container.clientWidth < 640 ? 320 : 300,
        maxHeightRatio: 0.78,
        maxHeight: 900,
        extraHeight: 104,
        fitMode: "width",
        padding: this.container.clientWidth < 640 ? 18 : 36,
      };
    }

    return {
      minHeight: this.container.clientWidth < 640 ? 260 : 220,
      maxHeightRatio: 0.72,
      maxHeight: 760,
      extraHeight: 72,
      fitMode: "contain",
      padding: this.container.clientWidth < 640 ? 18 : 32,
    };
  }

  button(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  bind() {
    this.abortController = new AbortController();
    const options = { signal: this.abortController.signal };
    const passiveFalse = { signal: this.abortController.signal, passive: false };

    this.viewport.addEventListener("wheel", (event) => this.onWheel(event), passiveFalse);
    this.viewport.addEventListener("pointerdown", (event) => this.onPointerDown(event), options);
    this.viewport.addEventListener("pointermove", (event) => this.onPointerMove(event), options);
    this.viewport.addEventListener("pointerup", (event) => this.onPointerUp(event), options);
    this.viewport.addEventListener("pointercancel", (event) => this.onPointerUp(event), options);
    this.viewport.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.zoomAt(event.clientX, event.clientY, ZOOM_STEP * ZOOM_STEP);
    }, options);
    this.container.addEventListener("click", () => this.focus(), options);
    this.container.addEventListener("keydown", (event) => this.onKeyDown(event), options);

    this.resizeObserver = new ResizeObserver(() => {
      if (!this.container.classList.contains("is-fullscreen")) this.autoSizeSoon();
      if (this.isNearInitialFit()) this.resetSoon();
    });
    this.resizeObserver.observe(this.container);
  }

  focus() {
    document.querySelectorAll(".mfz-container.is-focused").forEach((el) => {
      if (el !== this.container) el.classList.remove("is-focused");
    });
    this.container.classList.add("is-focused");
  }

  onKeyDown(event) {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomAtCenter(ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      this.zoomAtCenter(1 / ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      this.reset();
    } else if (event.key === "Escape" && this.container.classList.contains("is-fullscreen")) {
      event.preventDefault();
      this.toggleFullscreen(false);
    }
  }

  onWheel(event) {
    event.preventDefault();
    this.focus();

    const rect = this.viewport.getBoundingClientRect();
    const nearLeft = event.clientX - rect.left < EDGE_SCROLL_ZONE;
    const nearRight = rect.right - event.clientX < EDGE_SCROLL_ZONE;
    const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY) || event.shiftKey || nearLeft || nearRight;

    if (horizontalIntent && !event.ctrlKey && !event.metaKey) {
      const direction = event.deltaX || event.deltaY;
      this.x -= direction;
      this.apply();
      return;
    }

    const delta = event.deltaY || event.deltaX;
    const factor = Math.exp(-delta * 0.0015);
    this.zoomAt(event.clientX, event.clientY, factor);
  }

  onPointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    this.focus();
    this.viewport.setPointerCapture(event.pointerId);
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size === 1) {
      this.dragStart = {
        pointerId: event.pointerId,
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: this.x,
        y: this.y,
      };
    } else if (this.activePointers.size === 2) {
      this.dragStart = null;
      this.lastPinch = this.getPinchState();
    }
  }

  onPointerMove(event) {
    if (!this.activePointers.has(event.pointerId)) return;
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this.activePointers.size === 2) {
      const pinch = this.getPinchState();
      if (!pinch || !this.lastPinch) return;
      const factor = pinch.distance / Math.max(1, this.lastPinch.distance);
      this.zoomAt(pinch.centerX, pinch.centerY, factor);
      this.x += pinch.centerX - this.lastPinch.centerX;
      this.y += pinch.centerY - this.lastPinch.centerY;
      this.lastPinch = pinch;
      this.apply();
      return;
    }

    if (!this.dragStart || this.dragStart.pointerId !== event.pointerId) return;
    this.x = this.dragStart.x + event.clientX - this.dragStart.pointerX;
    this.y = this.dragStart.y + event.clientY - this.dragStart.pointerY;
    this.apply();
  }

  onPointerUp(event) {
    this.activePointers.delete(event.pointerId);
    this.lastPinch = this.activePointers.size === 2 ? this.getPinchState() : null;
    this.dragStart = null;
  }

  getPinchState() {
    const points = Array.from(this.activePointers.values());
    if (points.length < 2) return null;
    const [a, b] = points;
    return {
      centerX: (a.x + b.x) / 2,
      centerY: (a.y + b.y) / 2,
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  zoomAtCenter(factor) {
    const rect = this.viewport.getBoundingClientRect();
    this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, factor);
  }

  zoomAt(clientX, clientY, factor) {
    const rect = this.viewport.getBoundingClientRect();
    const oldScale = this.scale;
    const nextScale = clamp(oldScale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === oldScale) return;

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const contentX = (localX - this.x) / oldScale;
    const contentY = (localY - this.y) / oldScale;

    this.scale = nextScale;
    this.x = localX - contentX * nextScale;
    this.y = localY - contentY * nextScale;
    this.apply();
  }


  autoSizeSoon() {
    window.requestAnimationFrame(() => this.autoSizeContainer());
  }

  autoSizeContainer() {
    if (this.container.classList.contains("is-fullscreen")) return;
    if (this.container.style.height && !this.container.dataset.mfzAutoHeight) return;

    const bounds = this.getSvgBounds();
    const width = this.container.clientWidth || this.originalParent?.clientWidth || 800;
    if (!bounds.width || !bounds.height || !width) return;
    if (this.container.dataset.mfzAutoHeight && Math.abs(width - (this.lastAutoWidth || 0)) < 2) return;

    const profile = this.getProfile();
    const aspectHeight = width * (bounds.height / bounds.width);
    const maxHeight = Math.min(window.innerHeight * profile.maxHeightRatio, profile.maxHeight);
    const nextHeight = Math.round(clamp(aspectHeight + profile.extraHeight, profile.minHeight, maxHeight));

    this.container.style.height = `${nextHeight}px`;
    this.container.dataset.mfzAutoHeight = "true";
    this.lastAutoWidth = width;
  }

  resetSoon() {
    window.requestAnimationFrame(() => this.reset());
  }

  reset() {
    const viewport = this.viewport.getBoundingClientRect();
    const bounds = this.getSvgBounds();
    if (!viewport.width || !viewport.height || !bounds.width || !bounds.height) return;

    this.content.style.width = `${bounds.width}px`;
    this.content.style.height = `${bounds.height}px`;
    this.svg.style.width = `${bounds.width}px`;
    this.svg.style.height = `${bounds.height}px`;

    const profile = this.getProfile();
    const padding = profile.padding;
    const availableWidth = Math.max(1, viewport.width - padding * 2);
    const availableHeight = Math.max(1, viewport.height - padding * 2);
    const widthScale = availableWidth / bounds.width;
    const containScale = Math.min(widthScale, availableHeight / bounds.height, 1);
    const sequenceScale = Math.min(widthScale, 1);
    const scale = profile.fitMode === "width" ? sequenceScale : containScale;

    this.scale = clamp(scale, MIN_SCALE, MAX_SCALE);
    this.x = (viewport.width - bounds.width * this.scale) / 2 - bounds.x * this.scale;
    this.y = profile.fitMode === "width" ? padding - bounds.y * this.scale : (viewport.height - bounds.height * this.scale) / 2 - bounds.y * this.scale;
    this.initialFit = { scale: this.scale, x: this.x, y: this.y };
    this.apply();
  }

  getSvgBounds() {
    const viewBox = this.svg.viewBox && this.svg.viewBox.baseVal;
    if (viewBox && viewBox.width && viewBox.height) {
      return { x: viewBox.x, y: viewBox.y, width: viewBox.width, height: viewBox.height };
    }

    try {
      const box = this.svg.getBBox();
      if (box && box.width && box.height) {
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      }
    } catch (error) {
      // Some browsers throw if the SVG is detached or not fully painted yet.
    }

    const rect = this.svg.getBoundingClientRect();
    return { x: 0, y: 0, width: rect.width || 800, height: rect.height || 500 };
  }

  isNearInitialFit() {
    if (!this.initialFit) return true;
    return (
      Math.abs(this.scale - this.initialFit.scale) < 0.001 &&
      Math.abs(this.x - this.initialFit.x) < 1 &&
      Math.abs(this.y - this.initialFit.y) < 1
    );
  }

  apply() {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = null;
      this.content.style.transform = `translate(${this.x}px, ${this.y}px) scale(${this.scale})`;
    });
  }

  toggleFullscreen(force) {
    const shouldEnter = force === undefined ? !this.container.classList.contains("is-fullscreen") : force;
    if (shouldEnter) {
      this.fullscreenRestore = {
        parent: this.container.parentElement,
        nextSibling: this.container.nextSibling,
        width: this.container.style.width,
        height: this.container.style.height,
        autoHeight: this.container.dataset.mfzAutoHeight,
        lastAutoWidth: this.lastAutoWidth,
      };

      document.body.appendChild(this.container);
      this.container.classList.add("is-fullscreen");
      // Inline sizes set by auto-size / drag-resize would override the
      // `.is-fullscreen` CSS. Clear them so fullscreen can fill the window;
      // they are restored from `fullscreenRestore` on exit.
      this.container.style.width = "";
      this.container.style.height = "";
      this.fullscreenButton.textContent = "⤢";
      document.body.classList.add("mfz-fullscreen-open");
      this.resetSoon();
    } else {
      this.container.classList.remove("is-fullscreen");
      this.fullscreenButton.textContent = "⛶";
      document.body.classList.remove("mfz-fullscreen-open");
      if (this.fullscreenRestore) {
        const { parent, nextSibling } = this.fullscreenRestore;
        if (parent && document.body.contains(parent)) {
          parent.insertBefore(this.container, nextSibling && nextSibling.parentElement === parent ? nextSibling : null);
        }
        this.container.style.width = this.fullscreenRestore.width;
        this.container.style.height = this.fullscreenRestore.height;
        if (this.fullscreenRestore.autoHeight) this.container.dataset.mfzAutoHeight = this.fullscreenRestore.autoHeight;
        else delete this.container.dataset.mfzAutoHeight;
        this.lastAutoWidth = this.fullscreenRestore.lastAutoWidth;
        this.fullscreenRestore = null;
      }
      this.autoSizeSoon();
      this.resetSoon();
    }
  }

  destroy() {
    if (this.abortController) this.abortController.abort();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.frame) window.cancelAnimationFrame(this.frame);
    this.svg.dataset.mfzEnhanced = "false";

    if (this.originalWidth) this.svg.setAttribute("width", this.originalWidth);
    if (this.originalHeight) this.svg.setAttribute("height", this.originalHeight);
    if (this.originalInlineStyle === null) this.svg.removeAttribute("style");
    else this.svg.setAttribute("style", this.originalInlineStyle);

    if (this.originalParent && this.container.parentElement) {
      this.originalParent.insertBefore(this.svg, this.originalNextSibling);
      this.container.remove();
    }
    this.onDestroy();
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
