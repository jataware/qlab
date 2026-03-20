(() => {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SAVE_DELAY_MS = 240;
  const MIN_SCALE = 0.08;
  const MAX_SCALE = 20;
  const MIN_DRAW_SIZE = 4;
  const HANDLE_ORDER = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  const state = {
    images: [],
    annotations: {},
    outputFile: "",
    currentIndex: 0,
    currentImage: null,
    imageSize: null,
    boxes: [],
    selectedBoxId: null,
    draftBox: null,
    transform: { scale: 1, tx: 0, ty: 0 },
    interaction: null,
    pendingSaveTimer: null,
    savePromise: Promise.resolve(true),
    isDirty: false,
    editRevision: 0,
    savedAt: null,
    isSpacePressed: false,
    boxCounter: 0,
    redactionBoxes: [],
    selectedRedactionBoxId: null,
    redactionBoxCounter: 0,
  };

  const el = {};

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function formatTimestamp(value) {
    if (!value) {
      return "not saved yet";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return "saved";
    }

    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(date);
  }

  function createElement(tagName, className, textContent) {
    const node = document.createElement(tagName);
    if (className) {
      node.className = className;
    }
    if (textContent !== undefined) {
      node.textContent = textContent;
    }
    return node;
  }

  function createSvgElement(tagName, className) {
    const node = document.createElementNS(SVG_NS, tagName);
    if (className) {
      node.setAttribute("class", className);
    }
    return node;
  }

  function createButton({ label, className = "", onClick, title }) {
    const button = createElement("button", `annotator-button ${className}`.trim(), label);
    button.type = "button";
    if (title) {
      button.title = title;
    }
    if (onClick) {
      button.addEventListener("click", onClick);
    }
    return button;
  }

  function installLayout() {
    const root = document.getElementById("app") || document.body;
    root.innerHTML = "";

    const shell = createElement("div", "annotator-shell");
    const topbar = createElement("header", "annotator-topbar");
    const identity = createElement("div", "annotator-identity");
    const kicker = createElement("div", "annotator-kicker", "Image Annotator");
    el.imageName = createElement("h1", "annotator-image-name", "Loading...");
    el.metaLine = createElement("div", "annotator-meta-line");
    identity.append(kicker, el.imageName, el.metaLine);

    const controls = createElement("div", "annotator-toolbar");
    el.prevButton = createButton({
      label: "Prev",
      title: "ArrowLeft",
      onClick: () => void navigateBy(-1),
    });
    el.nextButton = createButton({
      label: "Next",
      title: "ArrowRight",
      onClick: () => void navigateBy(1),
    });
    el.fitButton = createButton({
      label: "Fit",
      onClick: () => fitImage({ preserveCenter: false }),
    });
    el.resetZoomButton = createButton({
      label: "100%",
      onClick: () => resetZoom(),
    });
    el.deleteBoxButton = createButton({
      label: "Delete Box",
      className: "annotator-button-danger",
      onClick: () => deleteSelectedBox(),
    });
    el.saveButton = createButton({
      label: "Save",
      className: "annotator-button-primary",
      onClick: () => void flushSave({ force: true }),
    });
    controls.append(
      el.prevButton,
      el.nextButton,
      el.fitButton,
      el.resetZoomButton,
      el.deleteBoxButton,
      el.saveButton
    );
    topbar.append(identity, controls);

    const main = createElement("div", "annotator-main");
    const viewerPanel = createElement("section", "annotator-viewer-panel");
    el.viewport = createElement("div", "annotator-viewport");
    el.viewport.tabIndex = 0;
    el.stage = createElement("div", "annotator-stage");
    el.image = createElement("img", "annotator-image");
    el.image.alt = "";
    el.overlay = createSvgElement("svg", "annotator-overlay");
    el.emptyState = createElement(
      "div",
      "annotator-empty",
      "No images found for this session."
    );
    el.stage.append(el.image, el.overlay);
    el.viewport.append(el.stage, el.emptyState);
    viewerPanel.append(el.viewport);

    const sidebar = createElement("aside", "annotator-sidebar");

    el.annotationCard = createElement("section", "annotator-card");
    const annotationCard = el.annotationCard;
    const annotationHeader = createElement("div", "annotator-card-header");
    annotationHeader.append(
      createElement("div", "annotator-card-title", "Box Annotation"),
      (() => {
        el.clearAnnotationButton = createButton({
          label: "Clear",
          className: "annotator-button-ghost annotator-button-small",
          onClick: () => clearAnnotation(),
        });
        return el.clearAnnotationButton;
      })()
    );
    el.annotationInput = createElement("input", "annotator-input");
    el.annotationInput.type = "text";
    el.annotationInput.placeholder = "Select a box to annotate";
    annotationCard.append(
      annotationHeader,
      el.annotationInput,
      createElement(
        "div",
        "annotator-helper",
        "Annotations belong to the selected box. Draw on empty space to add boxes, then drag boxes or square handles to edit them."
      )
    );

    const boxesCard = createElement("section", "annotator-card");
    const boxesHeader = createElement("div", "annotator-card-header");
    boxesHeader.append(createElement("div", "annotator-card-title", "Boxes"));
    el.boxCount = createElement("div", "annotator-count");
    boxesHeader.append(el.boxCount);
    el.boxList = createElement("div", "annotator-box-list");
    el.selectionSummary = createElement("div", "annotator-selection-summary");
    boxesCard.append(boxesHeader, el.boxList, el.selectionSummary);

    const sessionCard = createElement("section", "annotator-card");
    sessionCard.append(createElement("div", "annotator-card-title", "Session"));
    el.outputPath = createElement("div", "annotator-output-path");
    el.zoomText = createElement("div", "annotator-helper");
    el.status = createElement("div", "annotator-status", "Loading…");
    const shortcuts = createElement("div", "annotator-shortcuts");
    shortcuts.innerHTML = [
      "<span>Left / Right: navigate</span>",
      "<span>Delete: remove selected box</span>",
      "<span>Ctrl + wheel or pinch: zoom</span>",
      "<span>Wheel or Space + drag: pan</span>",
      "<span>Shift + draw: redact</span>",
    ].join("");
    sessionCard.append(el.outputPath, el.zoomText, shortcuts, el.status);

    sidebar.append(annotationCard, boxesCard, sessionCard);
    main.append(viewerPanel, sidebar);
    shell.append(topbar, main);
    root.append(shell);

    bindEvents();
  }

  function bindEvents() {
    el.annotationInput.addEventListener("input", () => {
      const selected = getSelectedBox();
      if (!selected) {
        el.annotationInput.value = "";
        return;
      }

      selected.annotation = el.annotationInput.value;
      renderBoxList();
      updateSelectionSummary();
      updateNavState();
      registerEdit("Box annotation updated");
    });

    el.annotationInput.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void flushSave({ force: true });
      }
    });

    el.image.addEventListener("load", () => {
      state.imageSize = {
        width: el.image.naturalWidth,
        height: el.image.naturalHeight,
      };
      el.stage.style.width = `${state.imageSize.width}px`;
      el.stage.style.height = `${state.imageSize.height}px`;
      el.overlay.setAttribute("viewBox", `0 0 ${state.imageSize.width} ${state.imageSize.height}`);
      el.overlay.setAttribute("width", String(state.imageSize.width));
      el.overlay.setAttribute("height", String(state.imageSize.height));
      fitImage({ preserveCenter: false });
      renderOverlay();
      syncCursor();
    });

    el.image.addEventListener("error", () => {
      state.imageSize = null;
      el.emptyState.textContent = "This image could not be loaded by the browser.";
      el.emptyState.classList.add("is-visible");
      updateStatus("Image failed to load", { isError: true });
    });

    el.viewport.addEventListener(
      "wheel",
      (event) => {
        if (!state.imageSize) {
          return;
        }

        event.preventDefault();
        const rect = el.viewport.getBoundingClientRect();
        const cursorX = event.clientX - rect.left;
        const cursorY = event.clientY - rect.top;

        if (event.ctrlKey || event.metaKey) {
          zoomAt(cursorX, cursorY, Math.exp(-event.deltaY * 0.0022));
          return;
        }

        state.transform.tx -= event.deltaX;
        state.transform.ty -= event.deltaY;
        applyTransform();
      },
      { passive: false }
    );

    el.viewport.addEventListener("pointerdown", (event) => {
      if (!state.imageSize) {
        return;
      }

      el.viewport.focus({ preventScroll: true });

      if (event.button === 1 || state.isSpacePressed) {
        startPan(event);
        return;
      }

      if (event.button !== 0) {
        return;
      }

      event.preventDefault();
      const point = clientPointToImage(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      const handleHit = hitTestSelectedHandle(point);
      if (handleHit) {
        startResize(event, handleHit.box.id, handleHit.handle);
        return;
      }

      const boxHit = hitTestBox(point);
      if (boxHit) {
        setSelectedBox(boxHit.id);
        startMove(event, boxHit.id, point);
        return;
      }

      startDraw(event, point);
    });

    el.viewport.addEventListener("pointermove", (event) => {
      if (!state.interaction) {
        syncCursor(event.clientX, event.clientY);
        return;
      }

      if (state.interaction.pointerId !== event.pointerId) {
        return;
      }

      if (state.interaction.mode === "panning") {
        state.transform.tx = state.interaction.startTx + (event.clientX - state.interaction.startClientX);
        state.transform.ty = state.interaction.startTy + (event.clientY - state.interaction.startClientY);
        applyTransform();
        return;
      }

      const point = clientPointToImage(event.clientX, event.clientY);
      if (!point) {
        return;
      }

      if (state.interaction.mode === "drawing") {
        state.draftBox = normalizeRect(state.interaction.origin, point);
        renderOverlay();
        return;
      }

      if (state.interaction.mode === "moving") {
        const nextBox = moveBoxWithinImage(
          state.interaction.startBox,
          point.x - state.interaction.startPoint.x,
          point.y - state.interaction.startPoint.y
        );
        replaceBox(state.interaction.boxId, nextBox);
        renderOverlay();
        updateSelectionSummary();
        return;
      }

      if (state.interaction.mode === "resizing") {
        const nextBox = resizeBoxFromHandle(state.interaction.startBox, state.interaction.handle, point);
        replaceBox(state.interaction.boxId, nextBox);
        renderOverlay();
        updateSelectionSummary();
      }
    });

    el.viewport.addEventListener("pointerup", (event) => {
      finishInteraction(event);
    });

    el.viewport.addEventListener("pointercancel", (event) => {
      finishInteraction(event, { cancelled: true });
    });

    el.viewport.addEventListener("pointerleave", () => {
      if (!state.interaction) {
        syncCursor();
      }
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === " " && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (!state.isSpacePressed) {
          state.isSpacePressed = true;
          syncCursor();
        }
      }

      if (isTypingTarget(event.target)) {
        return;
      }

      if (event.key === "ArrowRight") {
        event.preventDefault();
        void navigateBy(1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void navigateBy(-1);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedBox();
      } else if (event.key === "0") {
        event.preventDefault();
        fitImage({ preserveCenter: false });
      } else if (event.key === "=" || event.key === "+") {
        event.preventDefault();
        zoomAtViewportCenter(1.15);
      } else if (event.key === "-") {
        event.preventDefault();
        zoomAtViewportCenter(1 / 1.15);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setSelectedBox(null);
      }
    });

    window.addEventListener("keyup", (event) => {
      if (event.key === " ") {
        state.isSpacePressed = false;
        syncCursor();
      }
    });

    window.addEventListener("resize", () => {
      if (state.imageSize) {
        fitImage({ preserveCenter: true });
      }
    });

    window.addEventListener("beforeunload", (event) => {
      if (!state.isDirty) {
        return;
      }
      event.preventDefault();
      event.returnValue = "";
    });
  }

  function isTypingTarget(target) {
    return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
  }

  function createBoxId() {
    state.boxCounter += 1;
    return `box-${state.boxCounter}`;
  }

  function getActiveBoxes() {
    return state.boxes;
  }

  function setActiveBoxes(boxes) {
    state.boxes = boxes;
  }

  function getActiveSelectedId() {
    return state.selectedBoxId;
  }

  function setActiveSelectedId(id) {
    state.selectedBoxId = id;
  }

  function roundBox(box) {
    return {
      x: Math.round(box.x),
      y: Math.round(box.y),
      width: Math.max(1, Math.round(box.width)),
      height: Math.max(1, Math.round(box.height)),
    };
  }

  function normalizeBox(box, defaultAnnotation = "") {
    return {
      ...roundBox(box),
      annotation: typeof box.annotation === "string" ? box.annotation : String(defaultAnnotation || ""),
    };
  }

  function normalizeRect(start, end) {
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }

  function normalizeSavedRecord(imageId, record) {
    const rawBoxes = Array.isArray(record && record.bboxes)
      ? record.bboxes
      : record && record.bbox
        ? [record.bbox]
        : [];
    const legacyAnnotation = record && typeof record.annotation === "string" ? record.annotation : "";
    const hasBoxAnnotation = rawBoxes.some(
      (box) => box && typeof box === "object" && typeof box.annotation === "string"
    );
    const bboxes = rawBoxes
      .filter((box) => box && typeof box === "object")
      .map((box) => normalizeBox(box, hasBoxAnnotation ? "" : legacyAnnotation));

    const rawRedactions = Array.isArray(record && record.redactions) ? record.redactions : [];
    const redactions = rawRedactions
      .filter((box) => box && typeof box === "object")
      .map((box) => roundBox(box));

    return {
      image: (record && record.image) || imageId,
      bboxes,
      redactions,
      image_size:
        record && record.image_size && typeof record.image_size === "object"
          ? {
              width: Number(record.image_size.width) || 0,
              height: Number(record.image_size.height) || 0,
            }
          : null,
      updated_at: (record && record.updated_at) || null,
    };
  }

  function loadBoxesForRecord(record) {
    return record.bboxes.map((box) => ({
      id: createBoxId(),
      ...normalizeBox(box),
    }));
  }

  function loadRedactionsForRecord(record) {
    return record.redactions.map((box) => {
      state.redactionBoxCounter += 1;
      return {
        id: `rbox-${state.redactionBoxCounter}`,
        ...roundBox(box),
        annotation: "",
      };
    });
  }

  function serializeBoxes() {
    return state.boxes.map((box) => normalizeBox(box));
  }

  function serializeRedactions() {
    return state.redactionBoxes.map((box) => roundBox(box));
  }

  function getSelectedBox() {
    const boxes = getActiveBoxes();
    const selectedId = getActiveSelectedId();
    return boxes.find((box) => box.id === selectedId) || null;
  }

  function setSelectedBox(boxId) {
    if (!boxId) {
      setActiveSelectedId(null);
      updateAnnotationEditor();
      renderOverlay();
      renderBoxList();
      updateSelectionSummary();
      updateNavState();
      syncCursor();
      return;
    }

    const boxes = getActiveBoxes();
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index === -1) {
      setActiveSelectedId(null);
    } else {
      setActiveSelectedId(boxes[index].id);
    }

    updateAnnotationEditor();
    renderOverlay();
    renderBoxList();
    updateSelectionSummary();
    updateNavState();
    syncCursor();
  }

  function replaceBox(boxId, nextBox) {
    const boxes = getActiveBoxes();
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index === -1) {
      return;
    }
    boxes[index] = {
      ...boxes[index],
      ...roundBox(nextBox),
    };
  }

  function clientPointToImage(clientX, clientY) {
    if (!state.imageSize) {
      return null;
    }

    const rect = el.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }

    return {
      x: clamp((clientX - rect.left - state.transform.tx) / state.transform.scale, 0, state.imageSize.width),
      y: clamp((clientY - rect.top - state.transform.ty) / state.transform.scale, 0, state.imageSize.height),
    };
  }

  function moveBoxWithinImage(startBox, dx, dy) {
    const maxX = Math.max(0, state.imageSize.width - startBox.width);
    const maxY = Math.max(0, state.imageSize.height - startBox.height);
    return {
      x: clamp(startBox.x + dx, 0, maxX),
      y: clamp(startBox.y + dy, 0, maxY),
      width: startBox.width,
      height: startBox.height,
    };
  }

  function resizeBoxFromHandle(startBox, handle, point) {
    const left = startBox.x;
    const top = startBox.y;
    const right = startBox.x + startBox.width;
    const bottom = startBox.y + startBox.height;

    let nextLeft = left;
    let nextTop = top;
    let nextRight = right;
    let nextBottom = bottom;

    if (handle.includes("w")) {
      nextLeft = point.x;
    }
    if (handle.includes("e")) {
      nextRight = point.x;
    }
    if (handle.includes("n")) {
      nextTop = point.y;
    }
    if (handle.includes("s")) {
      nextBottom = point.y;
    }

    return clampBoxToImage(
      normalizeRect(
        { x: nextLeft, y: nextTop },
        { x: nextRight, y: nextBottom }
      )
    );
  }

  function clampBoxToImage(box) {
    if (!state.imageSize) {
      return box;
    }

    const left = clamp(box.x, 0, state.imageSize.width);
    const top = clamp(box.y, 0, state.imageSize.height);
    const right = clamp(box.x + box.width, 0, state.imageSize.width);
    const bottom = clamp(box.y + box.height, 0, state.imageSize.height);

    return {
      x: Math.min(left, right),
      y: Math.min(top, bottom),
      width: Math.abs(right - left),
      height: Math.abs(bottom - top),
    };
  }

  function getHandleCenters(box) {
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    return {
      nw: { x: box.x, y: box.y },
      n: { x: centerX, y: box.y },
      ne: { x: box.x + box.width, y: box.y },
      e: { x: box.x + box.width, y: centerY },
      se: { x: box.x + box.width, y: box.y + box.height },
      s: { x: centerX, y: box.y + box.height },
      sw: { x: box.x, y: box.y + box.height },
      w: { x: box.x, y: centerY },
    };
  }

  function getHandleSize() {
    return Math.max(10 / state.transform.scale, 3);
  }

  function hitTestSelectedHandle(point) {
    const box = getSelectedBox();
    if (!box) {
      return null;
    }

    const half = getHandleSize() / 2;
    const handles = getHandleCenters(box);
    for (const handle of HANDLE_ORDER) {
      const center = handles[handle];
      if (Math.abs(point.x - center.x) <= half && Math.abs(point.y - center.y) <= half) {
        return { box, handle };
      }
    }

    return null;
  }

  function pointInsideBox(point, box) {
    return (
      point.x >= box.x &&
      point.x <= box.x + box.width &&
      point.y >= box.y &&
      point.y <= box.y + box.height
    );
  }

  function hitTestBox(point) {
    const boxes = getActiveBoxes();
    const selectedId = getActiveSelectedId();
    const selected = getSelectedBox();
    if (selected && pointInsideBox(point, selected)) {
      return selected;
    }

    for (let index = boxes.length - 1; index >= 0; index -= 1) {
      if (boxes[index].id === selectedId) {
        continue;
      }
      if (pointInsideBox(point, boxes[index])) {
        return boxes[index];
      }
    }
    return null;
  }

  function startPan(event) {
    state.interaction = {
      mode: "panning",
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTx: state.transform.tx,
      startTy: state.transform.ty,
    };
    el.viewport.classList.add("is-dragging");
    el.viewport.setPointerCapture(event.pointerId);
    syncCursor();
  }

  function startDraw(event, point) {
    const forceRedact = event.shiftKey;
    state.interaction = {
      mode: "drawing",
      pointerId: event.pointerId,
      origin: point,
      forceRedact,
    };
    state.draftBox = {
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
    };
    el.viewport.classList.add("is-dragging");
    el.viewport.setPointerCapture(event.pointerId);
    renderOverlay();
    syncCursor();
  }

  function startMove(event, boxId, point) {
    const box = getActiveBoxes().find((item) => item.id === boxId);
    if (!box) {
      return;
    }

    state.interaction = {
      mode: "moving",
      pointerId: event.pointerId,
      boxId,
      startPoint: point,
      startBox: { ...box },
    };
    el.viewport.classList.add("is-dragging");
    el.viewport.setPointerCapture(event.pointerId);
    syncCursor();
  }

  function startResize(event, boxId, handle) {
    const box = getActiveBoxes().find((item) => item.id === boxId);
    if (!box) {
      return;
    }

    state.interaction = {
      mode: "resizing",
      pointerId: event.pointerId,
      boxId,
      handle,
      startBox: { ...box },
    };
    el.viewport.classList.add("is-dragging");
    el.viewport.setPointerCapture(event.pointerId);
    syncCursor();
  }

  function finishInteraction(event, { cancelled = false } = {}) {
    if (!state.interaction || state.interaction.pointerId !== event.pointerId) {
      return;
    }

    const interaction = state.interaction;
    state.interaction = null;
    el.viewport.classList.remove("is-dragging");

    try {
      el.viewport.releasePointerCapture(event.pointerId);
    } catch (error) {
      // Pointer capture may already be released. No action needed.
    }

    if (interaction.mode === "drawing") {
      const point = cancelled
        ? interaction.origin
        : clientPointToImage(event.clientX, event.clientY) || interaction.origin;
      const normalized = normalizeRect(interaction.origin, point);
      state.draftBox = null;
      if (!cancelled && normalized.width >= MIN_DRAW_SIZE && normalized.height >= MIN_DRAW_SIZE) {
        if (interaction.forceRedact) {
          state.redactionBoxCounter += 1;
          const newBox = {
            id: `rbox-${state.redactionBoxCounter}`,
            ...roundBox(normalized),
            annotation: "",
          };
          state.redactionBoxes.push(newBox);
          updateAnnotationEditor();
          registerEdit("Redaction box added");
        } else {
          const newBox = {
            id: createBoxId(),
            ...roundBox(normalized),
            annotation: "",
          };
          getActiveBoxes().push(newBox);
          setActiveSelectedId(newBox.id);
          updateAnnotationEditor();
          registerEdit("Box added");
        }
      } else {
        renderOverlay();
        if (!cancelled) {
          updateStatus("Ignored tiny box");
        }
      }
      renderBoxList();
      updateSelectionSummary();
      updateNavState();
      syncCursor();
      return;
    }

    if (interaction.mode === "moving" || interaction.mode === "resizing") {
      if (cancelled) {
        replaceBox(interaction.boxId, interaction.startBox);
        renderOverlay();
        renderBoxList();
        updateSelectionSummary();
        updateNavState();
        syncCursor();
        updateStatus("Edit cancelled");
        return;
      }

      renderOverlay();
      renderBoxList();
      updateSelectionSummary();
      updateNavState();
      syncCursor();
      registerEdit(interaction.mode === "moving" ? "Box moved" : "Box resized");
      return;
    }

    syncCursor();
  }

  function cursorForHandle(handle) {
    switch (handle) {
      case "nw":
      case "se":
        return "nwse-resize";
      case "ne":
      case "sw":
        return "nesw-resize";
      case "n":
      case "s":
        return "ns-resize";
      case "e":
      case "w":
        return "ew-resize";
      default:
        return "crosshair";
    }
  }

  function syncCursor(clientX, clientY) {
    if (!state.imageSize) {
      el.viewport.style.cursor = "default";
      return;
    }

    if (state.interaction) {
      if (state.interaction.mode === "panning") {
        el.viewport.style.cursor = "grabbing";
      } else if (state.interaction.mode === "moving") {
        el.viewport.style.cursor = "move";
      } else if (state.interaction.mode === "resizing") {
        el.viewport.style.cursor = cursorForHandle(state.interaction.handle);
      } else {
        el.viewport.style.cursor = "crosshair";
      }
      return;
    }

    if (state.isSpacePressed) {
      el.viewport.style.cursor = "grab";
      return;
    }

    if (clientX === undefined || clientY === undefined) {
      el.viewport.style.cursor = "crosshair";
      return;
    }

    const point = clientPointToImage(clientX, clientY);
    if (!point) {
      el.viewport.style.cursor = "crosshair";
      return;
    }

    const handleHit = hitTestSelectedHandle(point);
    if (handleHit) {
      el.viewport.style.cursor = cursorForHandle(handleHit.handle);
      return;
    }

    el.viewport.style.cursor = hitTestBox(point) ? "move" : "crosshair";
  }

  function rectAttributes(node, box) {
    node.setAttribute("x", String(box.x));
    node.setAttribute("y", String(box.y));
    node.setAttribute("width", String(box.width));
    node.setAttribute("height", String(box.height));
  }

  function renderBoxGroup(fragment, boxes, selectedId, { classPrefix, labelPrefix, dimmed }) {
    const orderedBoxes = selectedId
      ? [
          ...boxes.filter((box) => box.id !== selectedId),
          ...boxes.filter((box) => box.id === selectedId),
        ]
      : boxes;

    const isRedaction = classPrefix === "redaction";

    orderedBoxes.forEach((box) => {
      const selected = box.id === selectedId;
      let groupClass = isRedaction ? "redaction-box" : "annotator-box";
      if (selected) groupClass += " is-selected";
      if (dimmed) groupClass += " is-dimmed";
      const group = createSvgElement("g", groupClass);

      if (isRedaction) {
        const fill = createSvgElement("rect", "redaction-box-fill");
        rectAttributes(fill, box);
        group.append(fill);
      }

      const rect = createSvgElement("rect", isRedaction ? "redaction-box-shape" : "annotator-box-shape");
      rectAttributes(rect, box);
      group.append(rect);

      const displayIndex = boxes.findIndex((item) => item.id === box.id) + 1;
      const labelContent = `${labelPrefix}${displayIndex}`;
      const labelRect = createSvgElement("rect", isRedaction ? "redaction-box-label-bg" : "annotator-box-label-bg");
      const labelText = createSvgElement("text", isRedaction ? "redaction-box-label" : "annotator-box-label");
      const labelWidth = Math.max(16, labelContent.length * 8 + 8);
      const labelY = box.y >= 20 ? box.y - 18 : box.y;
      labelRect.setAttribute("x", String(box.x));
      labelRect.setAttribute("y", String(labelY));
      labelRect.setAttribute("width", String(labelWidth));
      labelRect.setAttribute("height", "18");
      labelText.setAttribute("x", String(box.x + 5));
      labelText.setAttribute("y", String(labelY + 12));
      labelText.textContent = labelContent;
      group.append(labelRect, labelText);

      if (selected && !dimmed) {
        const handleSize = getHandleSize();
        const handles = getHandleCenters(box);
        HANDLE_ORDER.forEach((handle) => {
          const center = handles[handle];
          const handleNode = createSvgElement("rect", "annotator-box-handle");
          handleNode.setAttribute("x", String(center.x - handleSize / 2));
          handleNode.setAttribute("y", String(center.y - handleSize / 2));
          handleNode.setAttribute("width", String(handleSize));
          handleNode.setAttribute("height", String(handleSize));
          group.append(handleNode);
        });
      }

      fragment.append(group);
    });
  }

  function renderOverlay() {
    el.overlay.replaceChildren();

    const fragment = document.createDocumentFragment();

    renderBoxGroup(fragment, state.boxes, state.selectedBoxId, {
      classPrefix: "annotator",
      labelPrefix: "",
      dimmed: false,
    });

    renderBoxGroup(fragment, state.redactionBoxes, null, {
      classPrefix: "redaction",
      labelPrefix: "R",
      dimmed: false,
    });

    if (state.draftBox && state.draftBox.width && state.draftBox.height) {
      const isDraftRedact = state.interaction && state.interaction.forceRedact;
      const draftClass = isDraftRedact ? "redaction-draft-box" : "annotator-draft-box";
      const draft = createSvgElement("rect", draftClass);
      rectAttributes(draft, state.draftBox);
      fragment.append(draft);
    }

    el.overlay.append(fragment);
  }

  function renderBoxList() {
    const boxes = getActiveBoxes();
    const selectedId = getActiveSelectedId();

    el.boxList.replaceChildren();
    el.boxCount.textContent = `${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}`;

    if (!boxes.length) {
      el.boxList.append(createElement("div", "annotator-box-empty", "No boxes on this image."));
      return;
    }

    boxes.forEach((box, index) => {
      const row = createElement(
        "div",
        box.id === selectedId ? "annotator-box-row is-selected" : "annotator-box-row"
      );
      const pickButton = createButton({
        label: `Box ${index + 1}`,
        className: "annotator-box-row-main",
        onClick: () => setSelectedBox(box.id),
      });
      const label = createElement("div", "annotator-box-row-meta");
      label.textContent = `${box.x}, ${box.y} • ${box.width} × ${box.height}`;
      pickButton.append(label);
      if (box.annotation) {
        pickButton.append(createElement("div", "annotator-box-row-note", box.annotation));
      }

      const removeButton = createButton({
        label: "Remove",
        className: "annotator-button-ghost annotator-button-small",
        onClick: () => removeBox(box.id),
      });

      row.append(pickButton, removeButton);
      el.boxList.append(row);
    });
  }

  function updateSelectionSummary() {
    const boxes = getActiveBoxes();
    const selected = getSelectedBox();
    if (!selected) {
      el.selectionSummary.textContent = boxes.length
        ? "Select a box to move, resize, or annotate it."
        : "Draw the first box directly on the image.";
      return;
    }

    const summary = [`Selected: ${selected.x}, ${selected.y} • ${selected.width} × ${selected.height}`];
    if (selected.annotation) {
      summary.push(`Annotation: ${selected.annotation}`);
    } else {
      summary.push("Annotation: empty");
    }
    el.selectionSummary.textContent = summary.join(" · ");
  }

  function updateHeader() {
    if (!state.currentImage) {
      el.imageName.textContent = "No images";
      el.metaLine.textContent = "0 images";
      return;
    }

    el.imageName.textContent = state.currentImage.name;
    const boxes = getActiveBoxes();
    const pieces = [
      `${state.currentIndex + 1} / ${state.images.length}`,
      `${boxes.length} ${boxes.length === 1 ? "box" : "boxes"}`,
    ];

    if (state.isDirty) {
      pieces.push(
        state.savedAt ? `unsaved changes · last saved ${formatTimestamp(state.savedAt)}` : "unsaved changes"
      );
    } else {
      pieces.push(formatTimestamp(state.savedAt));
    }

    el.metaLine.textContent = pieces.join("  •  ");
  }

  function updateSessionCard() {
    el.outputPath.textContent = state.outputFile || "annotations.jsonl";
    el.zoomText.textContent = `Zoom ${Math.round(state.transform.scale * 100)}%`;
  }

  function updateAnnotationEditor() {
    const selected = getSelectedBox();
    const nextValue = selected && typeof selected.annotation === "string" ? selected.annotation : "";
    const nextPlaceholder = selected
      ? "Short note for selected box"
      : state.boxes.length
        ? "Select a box to annotate"
        : "Draw a box to annotate it";

    el.annotationInput.disabled = !selected;
    el.annotationInput.placeholder = nextPlaceholder;
    if (el.annotationInput.value !== nextValue) {
      el.annotationInput.value = nextValue;
    }
  }

  function updateNavState() {
    const hasImage = Boolean(state.currentImage);
    const selected = getSelectedBox();
    el.prevButton.disabled = !hasImage || state.currentIndex <= 0;
    el.nextButton.disabled = !hasImage || state.currentIndex >= state.images.length - 1;
    el.fitButton.disabled = !state.imageSize;
    el.resetZoomButton.disabled = !state.imageSize;
    el.deleteBoxButton.disabled = !selected;
    el.clearAnnotationButton.disabled = !selected || !selected.annotation;
    el.saveButton.disabled = !hasImage || !state.isDirty;
  }

  function updateStatus(message, { isError = false } = {}) {
    el.status.textContent = message;
    el.status.classList.toggle("is-error", isError);
  }

  function refreshStaticUi() {
    updateHeader();
    updateSessionCard();
    updateAnnotationEditor();
    updateNavState();
    renderOverlay();
    renderBoxList();
    updateSelectionSummary();
  }

  function registerEdit(message) {
    state.editRevision += 1;
    state.isDirty = true;
    updateHeader();
    updateNavState();
    scheduleSave();
    updateStatus(message);
  }

  function clearAnnotation() {
    const selected = getSelectedBox();
    if (!selected || !selected.annotation) {
      return;
    }

    selected.annotation = "";
    el.annotationInput.value = "";
    renderBoxList();
    updateSelectionSummary();
    registerEdit("Annotation cleared");
    updateNavState();
  }

  function removeBox(boxId) {
    const boxes = getActiveBoxes();
    const index = boxes.findIndex((box) => box.id === boxId);
    if (index === -1) {
      return;
    }

    boxes.splice(index, 1);
    if (getActiveSelectedId() === boxId) {
      setActiveSelectedId(boxes[Math.max(0, index - 1)]?.id || boxes[0]?.id || null);
    }
    refreshStaticUi();
    registerEdit("Box removed");
  }

  function deleteSelectedBox() {
    const selected = getSelectedBox();
    if (!selected) {
      return;
    }
    removeBox(selected.id);
  }

  function scheduleSave() {
    if (!state.currentImage) {
      return;
    }

    if (state.pendingSaveTimer) {
      window.clearTimeout(state.pendingSaveTimer);
    }

    state.pendingSaveTimer = window.setTimeout(() => {
      state.pendingSaveTimer = null;
      void flushSave();
    }, SAVE_DELAY_MS);
  }

  async function flushSave({ force = false } = {}) {
    if (!state.currentImage) {
      return true;
    }

    if (state.pendingSaveTimer) {
      window.clearTimeout(state.pendingSaveTimer);
      state.pendingSaveTimer = null;
    }

    if (!state.isDirty) {
      return true;
    }

    const snapshot = {
      imageId: state.currentImage.id,
      bboxes: serializeBoxes(),
      redactions: serializeRedactions(),
      imageSize: state.imageSize ? { ...state.imageSize } : null,
      revision: state.editRevision,
    };

    const performSave = async () => {
      updateStatus(force ? "Saving…" : "Autosaving…");

      try {
        const response = await fetch(`/api/annotations/${encodeURIComponent(snapshot.imageId)}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            bboxes: snapshot.bboxes,
            redactions: snapshot.redactions,
            image_size: snapshot.imageSize,
          }),
        });

        if (!response.ok) {
          throw new Error(`Save failed with status ${response.status}`);
        }

        let result = null;
        try {
          result = await response.json();
        } catch (error) {
          result = null;
        }

        const serverRecord = result && typeof result === "object" ? result.record : null;
        if (serverRecord) {
          state.annotations[snapshot.imageId] = normalizeSavedRecord(snapshot.imageId, serverRecord);
        } else {
          delete state.annotations[snapshot.imageId];
        }

        if (state.currentImage && state.currentImage.id === snapshot.imageId) {
          if (snapshot.revision === state.editRevision) {
            state.isDirty = false;
            state.savedAt = serverRecord && serverRecord.updated_at ? serverRecord.updated_at : null;
            updateHeader();
            updateNavState();
            updateStatus("Saved");
          } else {
            updateHeader();
            updateNavState();
          }
        }

        return true;
      } catch (error) {
        if (state.currentImage && state.currentImage.id === snapshot.imageId) {
          updateHeader();
          updateNavState();
          updateStatus(error instanceof Error ? error.message : "Save failed", { isError: true });
        }
        return false;
      }
    };

    state.savePromise = state.savePromise.then(performSave, performSave);
    return state.savePromise;
  }

  async function navigateBy(delta) {
    if (!state.images.length) {
      return;
    }

    const nextIndex = clamp(state.currentIndex + delta, 0, state.images.length - 1);
    if (nextIndex === state.currentIndex) {
      return;
    }

    const saved = await flushSave({ force: true });
    if (!saved || state.isDirty) {
      updateStatus("Fix the save error before moving to another image", { isError: true });
      return;
    }

    setActiveImage(nextIndex);
    updateStatus("Image loaded");
  }

  function fitImage({ preserveCenter }) {
    if (!state.imageSize) {
      return;
    }

    const rect = el.viewport.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return;
    }

    const fitScale = clamp(
      Math.min(rect.width / state.imageSize.width, rect.height / state.imageSize.height) * 0.96,
      MIN_SCALE,
      MAX_SCALE
    );

    if (preserveCenter) {
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const imageCenterX = (centerX - state.transform.tx) / state.transform.scale;
      const imageCenterY = (centerY - state.transform.ty) / state.transform.scale;
      state.transform.scale = fitScale;
      state.transform.tx = centerX - imageCenterX * fitScale;
      state.transform.ty = centerY - imageCenterY * fitScale;
    } else {
      state.transform.scale = fitScale;
      state.transform.tx = (rect.width - state.imageSize.width * fitScale) / 2;
      state.transform.ty = (rect.height - state.imageSize.height * fitScale) / 2;
    }

    applyTransform();
  }

  function resetZoom() {
    if (!state.imageSize) {
      return;
    }

    const rect = el.viewport.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    state.transform.scale = 1;
    state.transform.tx = centerX - state.imageSize.width / 2;
    state.transform.ty = centerY - state.imageSize.height / 2;
    applyTransform();
  }

  function zoomAtViewportCenter(factor) {
    const rect = el.viewport.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, factor);
  }

  function zoomAt(cursorX, cursorY, factor) {
    const previousScale = state.transform.scale;
    const nextScale = clamp(previousScale * factor, MIN_SCALE, MAX_SCALE);
    if (nextScale === previousScale) {
      return;
    }

    const imageX = (cursorX - state.transform.tx) / previousScale;
    const imageY = (cursorY - state.transform.ty) / previousScale;
    state.transform.scale = nextScale;
    state.transform.tx = cursorX - imageX * nextScale;
    state.transform.ty = cursorY - imageY * nextScale;
    applyTransform();
  }

  function applyTransform() {
    el.stage.style.transform = `translate(${state.transform.tx}px, ${state.transform.ty}px) scale(${state.transform.scale})`;
    updateSessionCard();
  }

  function setActiveImage(index) {
    state.currentIndex = index;
    state.currentImage = state.images[index] || null;
    state.imageSize = null;
    state.draftBox = null;
    state.interaction = null;
    state.transform = { scale: 1, tx: 0, ty: 0 };
    state.isDirty = false;
    state.editRevision = 0;
    state.redactionBoxCounter = 0;
    applyTransform();

    if (!state.currentImage) {
      state.boxes = [];
      state.selectedBoxId = null;
      state.redactionBoxes = [];
      state.selectedRedactionBoxId = null;
      state.savedAt = null;
      el.annotationInput.value = "";
      el.image.removeAttribute("src");
      el.emptyState.classList.add("is-visible");
      refreshStaticUi();
      return;
    }

    const record = normalizeSavedRecord(
      state.currentImage.id,
      state.annotations[state.currentImage.id] || {}
    );
    state.boxes = loadBoxesForRecord(record);
    state.selectedBoxId = state.boxes[0]?.id || null;
    state.redactionBoxes = loadRedactionsForRecord(record);
    state.selectedRedactionBoxId = null;
    state.savedAt = record.updated_at || null;
    el.emptyState.classList.remove("is-visible");
    el.image.src = state.currentImage.url;
    refreshStaticUi();
  }

  async function loadState() {
    updateStatus("Loading session…");

    const response = await fetch("/api/state", {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`State request failed with status ${response.status}`);
    }

    const payload = await response.json();
    state.images = Array.isArray(payload.images) ? payload.images : [];
    state.annotations = {};
    if (payload.annotations && typeof payload.annotations === "object") {
      Object.entries(payload.annotations).forEach(([imageId, record]) => {
        state.annotations[imageId] = normalizeSavedRecord(imageId, record);
      });
    }
    state.outputFile = payload.output_file || "";
    setActiveImage(0);
    updateStatus(state.images.length ? "Ready" : "No images found", {
      isError: !state.images.length,
    });
    if (!state.images.length) {
      el.emptyState.classList.add("is-visible");
    }
  }

  async function bootstrap() {
    installLayout();
    try {
      await loadState();
    } catch (error) {
      updateStatus(error instanceof Error ? error.message : "Failed to load session", {
        isError: true,
      });
      el.emptyState.classList.add("is-visible");
      el.emptyState.textContent = "The UI could not connect to the local annotation server.";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void bootstrap();
    });
  } else {
    void bootstrap();
  }
})();
