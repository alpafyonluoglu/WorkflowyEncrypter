/**
 * Shared popup component
 *
 * Classes:
 *   PopupButton    — Builder for a single button
 *   PopupPage      — Builder for a single page (title, text, buttons, html, input, script)
 *   PopupRenderer  — Internal: owns DOM, animations, and page rendering
 *   PopupTemplates — Reusable popup configurations (confirm, etc.)
 *   Popup          — Public API: constructor takes config, open() shows a popup
 */

const _sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- PopupButton ---

class PopupButton {
  constructor(text, outcome) {
    this.text = text;
    this.outcome = outcome;
    this.primary = false;
    this.focus = false;
    this.onClick = null;
  }

  setPrimary() {
    this.primary = true;
    return this;
  }

  setFocus() {
    this.focus = true;
    return this;
  }

  setOnClick(fn) {
    this.onClick = fn;
    return this;
  }
}

// --- PopupPage ---

class PopupPage {
  constructor(title, text) {
    this.title = title ?? "";
    this.text = text ?? "";
    this.buttons = [];
    this.html = [];
    this.input = null;
    this.script = null;
  }

  addButton(button) {
    this.buttons.push(button);
    return this;
  }

  addHtml(position, content) {
    this.html.push({ position, content });
    return this;
  }

  setInput(label, placeholder) {
    this.input = { label, placeholder };
    return this;
  }

  setScript(fn) {
    this.script = fn;
    return this;
  }
}

// --- PopupRenderer ---

class PopupRenderer {
  constructor(popup, config) {
    this.popup = popup;
    this.config = config;
    this.type = Popup.TYPES.DEFAULT;
    this.cancellable = true;
    this.pages = [];
    this.currentPage = 0;
    this.activeElement = null;
    this.primaryOnClick = null;
    this.secondaryOnClick = null;
    this._boundOnKeyPress = this._onKeyPress.bind(this);
  }

  async inject(options) {
    this.type = options.type ?? Popup.TYPES.DEFAULT;
    this.cancellable = options.cancellable ?? true;
    this.pages = options.pages ?? [];

    // Inject container HTML
    const containerHTML = await this.config.resourceLoader('/layouts/popup_container.html');
    document.body.insertAdjacentHTML("afterbegin", containerHTML);

    // Inject CSS
    const popupEl = document.getElementById("_popup");
    await this._injectStyles(popupEl, this.type);
    if (options.style) {
      const el = document.createElement('style');
      el.textContent = options.style;
      popupEl.appendChild(el);
    }

    // Wait for freshly-injected styles to apply; skipped when preload() handled it already
    if (!this.popup._stylesPreloaded) {
      await _sleep(300);
    }

    // Render first page
    await this.renderPage(0);
    await this._show();

    // Click outside to cancel
    if (this.cancellable) {
      popupEl.addEventListener('click', (evt) => {
        if (evt.target === popupEl) {
          this._handleOutcome(null, Popup.OUTCOMES.CANCEL);
        }
      });
    }
  }

  async _injectStyles(parent, type) {
    // All CSS is already in <head> from preload()
    if (this.popup._stylesPreloaded) return;

    const paths = [
      '/styles/popup.css',
      '/styles/popup_type' + type + '.css'
    ];
    if (this.config.isDarkTheme()) {
      paths.push('/styles/popup_dark.css');
      paths.push('/styles/popup_type' + type + '_dark.css');
    }

    if (this.config.styleInjector) {
      await this.config.styleInjector(parent, paths);
    } else {
      // Default: inline <style> (works in page context without CSP)
      let css = '';
      for (const path of paths) {
        css += '\n' + await this.config.resourceLoader(path);
      }
      const el = document.createElement('style');
      el.textContent = css;
      parent.appendChild(el);
    }
  }

  async _show() {
    const popupEl = document.getElementById("_popup");
    const boxEl = document.getElementById("_popup-box");
    popupEl.style.visibility = "visible";
    popupEl.style.opacity = "0";
    popupEl.style.transition = "all .3s ease-in-out";
    boxEl.style.marginTop = "6vh";
    boxEl.style.transform = "scale(0.98)";
    boxEl.style.transition = "all .3s ease-in-out";
    await _sleep(300);
    boxEl.style.marginTop = "10vh";
    boxEl.style.transform = "scale(1)";
    popupEl.style.opacity = "1";
    await _sleep(300);

    if (document.activeElement) {
      this.activeElement = document.activeElement;
      document.activeElement.blur();
    }
    if (this.type === Popup.TYPES.MINI) {
      document.addEventListener('keydown', this._boundOnKeyPress);
    }
  }

  async hide(outcome = Popup.OUTCOMES.CANCEL) {
    if (this.type === Popup.TYPES.MINI) {
      document.removeEventListener('keydown', this._boundOnKeyPress);
    }
    if (this.activeElement) {
      this.activeElement.focus();
    }

    const popupEl = document.getElementById("_popup");
    const boxEl = document.getElementById("_popup-box");
    popupEl.style.opacity = "0";
    boxEl.style.marginTop = "6vh";
    boxEl.style.transform = "scale(0.98)";
    await _sleep(300);
    popupEl.remove();

    this.popup._resolve(outcome);
  }

  async renderPage(pageIndex) {
    const boxEl = document.getElementById("_popup-box");
    const page = this.pages[pageIndex];
    const endOfPages = pageIndex === this.pages.length - 1;

    // Remove current page content
    const content = document.getElementById("_popup-content");
    const isFirstRender = content.children.length === 0;
    if (!isFirstRender) {
      content.style.opacity = "0";
      await _sleep(300);
      content.replaceChildren();
    }

    // Title
    const titleEl = document.createElement('p');
    titleEl.classList.add("_popup-title");
    titleEl.textContent = page.title;
    content.appendChild(titleEl);

    // Text
    const textEl = document.createElement('p');
    textEl.classList.add("_popup-text");
    textEl.id = "_popup-text";
    textEl.textContent = page.text;
    content.appendChild(textEl);

    // Input
    if (page.input !== null) {
      const inputContainer = document.createElement('div');
      inputContainer.classList.add("_input");
      content.appendChild(inputContainer);

      const inputLabel = document.createElement('p');
      inputLabel.classList.add("_input-text");
      inputLabel.textContent = page.input.label;
      inputContainer.appendChild(inputLabel);

      const inputBoxContainer = document.createElement('div');
      inputBoxContainer.classList.add("_input-box-container");
      inputContainer.appendChild(inputBoxContainer);

      const inputEl = document.createElement('input');
      inputEl.classList.add("_input");
      inputEl.type = 'text';
      inputEl.placeholder = page.input.placeholder;
      inputEl.id = "_input-box";
      inputBoxContainer.appendChild(inputEl);
    }

    // HTML injections (beforebuttons first)
    let deferredHtml = [];
    for (const htmlItem of page.html) {
      if (htmlItem.position === "beforebuttons") {
        content.insertAdjacentHTML("beforeend", htmlItem.content);
      } else {
        deferredHtml.push(htmlItem);
      }
    }

    // Buttons
    const buttonsEl = document.createElement('div');
    buttonsEl.classList.add("_popup-buttons");
    buttonsEl.id = "_popup-buttons";
    content.appendChild(buttonsEl);

    let buttons = page.buttons;
    if (buttons.length === 0) {
      if (this.type === Popup.TYPES.DEFAULT) {
        buttons = [new PopupButton(
          endOfPages ? "Close" : "Next",
          endOfPages ? Popup.OUTCOMES.COMPLETE : Popup.OUTCOMES.NEXT
        )];
      } else {
        buttons = [new PopupButton("Close", Popup.OUTCOMES.COMPLETE).setPrimary()];
      }
    }

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];

      const btnEl = document.createElement('button');
      btnEl.classList.add(this.type === Popup.TYPES.DEFAULT
        ? "_popup-button"
        : (btn.primary ? "_popup-button-primary" : "_popup-button-secondary"));
      btnEl.id = "_popup-button" + i;
      btnEl.type = "button";
      btnEl.setAttribute("data-id", i);

      if (this.type === Popup.TYPES.DEFAULT) {
        btnEl.textContent = btn.text;
      } else {
        const textSpan = document.createElement('span');
        textSpan.textContent = btn.text;
        const hintSpan = document.createElement('span');
        hintSpan.classList.add(btn.primary ? '_popup-button-hint-primary' : '_popup-button-hint-secondary');
        hintSpan.textContent = ' ' + (btn.primary ? '⏎' : 'esc');
        btnEl.append(textSpan, hintSpan);
      }

      const onClickFunc = () => this._handleOutcome(i, btn.outcome);
      btnEl.onclick = onClickFunc;
      if (this.type === Popup.TYPES.MINI) {
        if (btn.primary) {
          this.primaryOnClick = onClickFunc;
        } else {
          this.secondaryOnClick = onClickFunc;
        }
      }
      buttonsEl.appendChild(btnEl);

      if (btn.focus) {
        await _sleep(100);
        btnEl.focus();
      }
    }

    // Remaining HTML injections (afterbegin, etc.)
    for (const htmlItem of deferredHtml) {
      content.insertAdjacentHTML(htmlItem.position, htmlItem.content);
    }

    // Close button for cancellable MINI popups
    if (this.cancellable && this.type === Popup.TYPES.MINI) {
      const closeHTML = await this.config.resourceLoader('/layouts/popup_close.html');
      content.insertAdjacentHTML('beforeend', closeHTML);
      document.getElementById("_popup-close").onclick = () => {
        this._handleOutcome(null, Popup.OUTCOMES.CANCEL);
      };
    }

    // Run page script
    await _sleep(100);
    if (page.script) {
      page.script();
    }

    boxEl.style.minHeight = "0";
    this.currentPage = pageIndex;
    content.style.opacity = "1";

    // On first render there is no outgoing opacity transition to wait for
    if (!isFirstRender) {
      await _sleep(300);
    }
    boxEl.style.minHeight = boxEl.offsetHeight + "px";
  }

  async _handleOutcome(buttonIndex, outcome) {
    if (outcome === Popup.OUTCOMES.CUSTOM) {
      const page = this.pages[this.currentPage];
      outcome = (await page.buttons[buttonIndex].onClick() ?? outcome);
    }

    switch (outcome) {
      case Popup.OUTCOMES.PREV:
        this.renderPage(this.currentPage - 1);
        break;
      case Popup.OUTCOMES.NEXT:
        this.renderPage(this.currentPage + 1);
        break;
      case Popup.OUTCOMES.CANCEL:
      case Popup.OUTCOMES.COMPLETE:
        this.hide(outcome);
        break;
      default:
      case Popup.OUTCOMES.IGNORE:
        return;
    }
  }

  _onKeyPress(event) {
    event.stopPropagation();
    if (event.key === 'Enter' || event.keyCode === 13) {
      if (this.primaryOnClick) this.primaryOnClick();
    } else if (event.key === 'Escape' || event.keyCode === 27) {
      if (this.secondaryOnClick) this.secondaryOnClick();
    }
  }
}

// --- PopupTemplates ---

class PopupTemplates {
  static confirm(title, text, confirmText = "Confirm") {
    return {
      type: Popup.TYPES.MINI,
      pages: [
        new PopupPage(title, text)
          .addButton(new PopupButton("Cancel", Popup.OUTCOMES.CANCEL))
          .addButton(new PopupButton(confirmText, Popup.OUTCOMES.COMPLETE).setPrimary())
      ]
    };
  }
}

// --- Popup ---

class Popup {
  static TYPES = {
    DEFAULT: 0,
    MINI: 1
  };

  static OUTCOMES = {
    IGNORE: -1,
    CANCEL: 0,
    PREV: 1,
    NEXT: 2,
    COMPLETE: 3,
    CUSTOM: 4
  };

  static RESOURCE_PATHS = [
    '/layouts/popup_container.html',
    '/layouts/popup_close.html',
    '/styles/popup.css',
    '/styles/popup_dark.css',
    '/styles/popup_type0.css',
    '/styles/popup_type0_dark.css',
    '/styles/popup_type1.css',
    '/styles/popup_type1_dark.css'
  ];

  /**
   * @param {Object} config
   * @param {Function} config.resourceLoader  — async (path) => string
   * @param {Function} [config.styleInjector] — async (parent, paths) => void
   * @param {Function} [config.isDarkTheme]   — () => boolean
   * @param {Function} [config.onBeforeOpen]  — () => void, called before each open()
   */
  constructor(config) {
    this._cache = {};
    this._stylesPreloaded = false;
    const rawLoader = config.resourceLoader;
    this.config = {
      resourceLoader: async (path) => {
        if (this._cache[path] !== undefined) return this._cache[path];
        const content = await rawLoader(path);
        this._cache[path] = content;
        return content;
      },
      styleInjector: config.styleInjector ?? null,
      isDarkTheme: config.isDarkTheme ?? (() => false),
      onBeforeOpen: config.onBeforeOpen ?? null
    };
    this._resolvePromise = null;
    this._renderer = null;
  }

  /**
   * Pre-fetch all popup resources into the cache and inject all CSS
   * into <head> so that open() has zero fetch or style-injection delay.
   */
  async preload() {
    // Fetch all HTML and CSS resources into the cache
    await Promise.all(
      Popup.RESOURCE_PATHS.map(path => this.config.resourceLoader(path))
    );

    // Inject all CSS into <head> now so _injectStyles can skip at open() time
    const cssPaths = Popup.RESOURCE_PATHS.filter(p => p.endsWith('.css'));
    if (this.config.styleInjector) {
      await this.config.styleInjector(document.head, cssPaths);
    } else {
      let css = '';
      for (const path of cssPaths) {
        css += '\n' + this._cache[path];
      }
      const el = document.createElement('style');
      el.textContent = css;
      document.head.appendChild(el);
    }

    this._stylesPreloaded = true;
  }

  /**
   * Show a popup and wait for the user to act.
   *
   * @param {Object}      options
   * @param {PopupPage[]} options.pages       — one or more pages
   * @param {number}      [options.type]      — Popup.TYPES.DEFAULT or Popup.TYPES.MINI
   * @param {string}      [options.style]     — extra CSS to inject
   * @param {boolean}     [options.cancellable] — whether clicking outside / esc closes (default true)
   * @returns {Promise<number>} outcome (Popup.OUTCOMES.*)
   */
  open(options) {
    return new Promise(async (resolve) => {
      if (this.config.onBeforeOpen) {
        this.config.onBeforeOpen();
      }

      this._resolvePromise = resolve;
      this._renderer = new PopupRenderer(this, this.config);
      await this._renderer.inject(options);
    });
  }

  /** Called by PopupRenderer when the popup closes. */
  _resolve(outcome) {
    const resolve = this._resolvePromise;
    this._resolvePromise = null;
    this._renderer = null;
    resolve(outcome);
  }
}
