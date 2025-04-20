var shared = []; // Share IDs
var trackedChanges = [];
var cacheClearPerformed = false;
var quarantine = false;
var bypassLock = false;
var theme = null;
var broadcastCheckTime = new Date().getTime();
var pendingReload = false;

var crosscheckUserId = "";
var clientId = "";
var clientVersion = "";
var wfBuildDate = "";
var mostRecentOperationTransactionId = "";

const {fetch: origFetch} = window;

class BaseUtil {
  updateTheme() {
    var body = document.getElementsByTagName("body")[0];
    var bodyBgColor = window.getComputedStyle(body, null).getPropertyValue("background-color");
    theme = bodyBgColor === "rgb(42, 49, 53)" ? c.THEMES.DARK : c.THEMES.LIGHT;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getInternalVar(key) {
    return document.getElementById("wfe-internal-" + key).getAttribute('value');
  }

  endpointMatches(path, method, url, params) {
    return url.includes(c.DOMAIN + path) && method === params.method;
  }

  isString(val) {
    return typeof val === 'string' || val instanceof String;
  }

  randomStr(length) { // [https://stackoverflow.com/a/1349426]
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const charactersLength = characters.length;
    let counter = 0;
    while (counter < length) {
      result += characters.charAt(Math.floor(Math.random() * charactersLength));
      counter += 1;
    }
    return result;
  }
}
const u = new BaseUtil();

class ExtensionGateway {
  constructor() {
    return new Proxy({}, {
      get(target, key) {
        return (...args) => {
          return ExtensionGateway.call(key, ...args);
        };
      }
    });
  }

  static call(func, ...params) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(c.EXTENSION_ID,
        {
          func: func,
          params: params
        },
        (response) => {
          resolve(response);
        }
      );
    });
  }
}
const gateway = new ExtensionGateway();

class Constants {
  EXTENSION_ID = undefined;
  LOCK_TAG = undefined;
  DOMAIN = "https://workflowy.com";
  DEFAULT_SHARE_ID = 'DEFAULT';
  POPUP_TYPES = {
    DEFAULT: 0,
    MINI: 1
  };
  TOAST_STATES = {
    HIDDEN: 0,
    TRANSITIONING: 1,
    SHOWN: 2
  };
  PROPERTIES = {
    NAME: "name",
    DESCRIPTION: "description",
    LOCKED: "locked",
    PARENT: "parent",
    SHARE_ID: "shareId",
    LOCAL_ID: "localId"
  };
  SENSITIVE_PROPERTIES = [
    this.PROPERTIES.NAME,
    this.PROPERTIES.DESCRIPTION
  ];
  FLAGS = {
    FORCE_DECRYPT: 0,
    SUPPRESS_WARNINGS: 1,
    NO_FETCH: 2,
    TRACK_ENCRYPTION_CHANGES: 3,
    IGNORE_NULL_PARENT: 4
  };
  OUTCOMES = {
    IGNORE: -1,
    CANCEL: 0,
    PREV: 1,
    NEXT: 2,
    COMPLETE: 3,
    CUSTOM: 4
  };

  constructor() {
    return new Proxy(this, {
      set(target, key, value) {
        if (key in target && target[key] !== undefined) {
          return false;
        }
        return (target[key] = value);
      },
      deleteProperty(target, key) {
        return false;
      }
    });
  }

  async init() {
    this.EXTENSION_ID = u.getInternalVar("extensionId");
    this.LOCK_TAG = await gateway.getLockTag();

    const constantsToFetch = ["THEMES", "PRE_ENC_CHAR", "RELOAD_REASONS", "ACTIONS"];
    for (let key of constantsToFetch) {
      this[key] = await gateway.getConstant(key);
    }
  }
}
const c = new Constants();

class FocusTracker {
  action = null;

  async onChange() {
    if (this.action !== null) {
      return this.action();
    }

    const reloadBroadcast = await gateway.getVar("reloadBroadcast", null) ?? {};
    if ((reloadBroadcast.time !== undefined && reloadBroadcast.time > broadcastCheckTime) && !pendingReload) {
      let popupTitle = "Quick Refresh Needed"; 
      let popupText = "Some behind-the-scenes changes need a quick refresh to take effect. Reload the page to stay up to date.";
      switch (reloadBroadcast.reason) {
        case c.RELOAD_REASONS.UPDATE:
          popupTitle = "Update Ready";
          popupText = "We've updated Workflowy Encrypter with new features and improvements! Reload this page to enjoy the latest version.";
          break;
        case c.RELOAD_REASONS.KEY_CHANGE:
          popupTitle = "Key Updated";
          popupText = "Your key has been successfully updated. Reload this page to apply your changes.";
          break;
        case c.RELOAD_REASONS.TAG_CHANGE:
          popupTitle = "Tag Updated";
          popupText = "The encryption tag has been successfully updated. Reload this page to apply your changes.";
          break;
      }

      pendingReload = true;
      await popup.create(null, null, [], false, {
        style: await components.getWelcomeCss(),
        pages: [
          {
            title: popupTitle,
            text: popupText,
            buttons: [{
              outcome: c.OUTCOMES.COMPLETE,
              text: "Reload"
            }],
            html: [{
              position: "afterbegin",
              content: await components.getWelcomeHtml(2, {
                key_url: await gateway.getResUrl('/src/logo_128.png')
              })
            }]
          }
        ]
      });
      window.onbeforeunload = null;
      location.reload();
    } else {
      broadcastCheckTime = new Date().getTime();
    }
  }

  setAction(action) {
    this.action = action;
  }

  clearAction() {
    this.action = null;
  }
}
const focusTracker = new FocusTracker();

class NodeTracker {
  NODES = {};

  getAll() {
    return this.NODES;
  }

  /**
   * Delete property if set to undefined
   * Update LOCKED property based on NAME property
   * Enforce to update parent of shared node and bypass other checks
   * Properties set to undefined are ignored
   */
  update(id, properties, enforce = false) {
    if (id === undefined || id === null) {
      return false;
    }

    let node = this.NODES[id] ?? {};
    let isSharedRoot = node[c.PROPERTIES.SHARE_ID] !== undefined;

    for (let property in properties) {
      if (properties[property] === undefined && node[property] !== undefined) {
        delete properties[property];
      }
    }

    if (isSharedRoot && !enforce) {
      delete properties[c.PROPERTIES.PARENT];
    }

    let updatedNode = {...node, ...properties};
    updatedNode[c.PROPERTIES.LOCKED] = (updatedNode[c.PROPERTIES.NAME] ?? "").includes(c.LOCK_TAG);

    this.NODES[id] = updatedNode;
    return true;
  }

  delete(id) {
    delete this.NODES[id];
  }

  
  /**
   * Return node if no property is specified
   * Return node's property if property is specified
   * If recursive is true and node's property is undefined, return property of the node's parents
   * If node's value is included in the ignored list, handle node's value as undefined
   */
  get(id, property = null, recursiveCheck = false, ignored = []) {
    if (id === undefined || id === null) {
      return undefined;
    }

    let node = this.NODES[id] ?? {};
    if (property === null) {
      return node;
    } else if (node[property] !== undefined && !ignored.includes(node[property])) {
      return node[property];
    } else if (recursiveCheck) {
      return this.get(node[c.PROPERTIES.PARENT], property, recursiveCheck, ignored);
    }
    return undefined;
  }

  getShareId(id) {
    return this.get(id, c.PROPERTIES.SHARE_ID, true);
  }
  
  getParent(id) {
    return this.get(id, c.PROPERTIES.PARENT, false);
  }

  /**
   * Direct param is used to check the property of the node itself
   * Setting direct to false will check the property of the node's parents
   */
  isLocked(id, direct = false) {
    return this.get(id, c.PROPERTIES.LOCKED, !direct, [false]) ?? false;
  }

  hasChild(id) {
    return this.find(c.PROPERTIES.PARENT, id, true).length > 0;
  }

  getChildren(id) {
    return this.find(c.PROPERTIES.PARENT, id);
  }

  find(property, value, single = false) {
    let nodes = [];
    for (let nodeId in this.NODES) {
      if (this.NODES[nodeId][property] === value) {
        nodes.push(nodeId);
        if (single) {
          break;
        }
      }
    }
    return nodes;
  }
}
const nodes = new NodeTracker();

class ComponentLoader {
  // For a native look, HTML and CSS are taken from the Workflowy's site
  async getPopupContainerHTML() {
    let path = await gateway.getResUrl('/layouts/popup_container.html');
    return await this.readFile(path);
  }

  async getToastContainerHTML() {
    let path = await gateway.getResUrl('/layouts/toast_container.html');
    return await this.readFile(path);
  }

  async getPopupCloseHTML() {
    let path = await gateway.getResUrl('/layouts/popup_close.html');
    return await this.readFile(path);
  }

  async getWelcomeCss() {
    let path = await gateway.getResUrl('/styles/welcome.css');
    let css = await this.readFile(path);

    switch (theme) {
      case c.THEMES.DARK:
        let path = await gateway.getResUrl('/styles/welcome_dark.css');
        css += '\n' + await this.readFile(path);
        break;
      case c.THEMES.LIGHT:
      default:
        break;
    }

    return css;
  }

  async getPopupCss(type = c.POPUP_TYPES.DEFAULT) {
    let path = await gateway.getResUrl('/styles/popup.css');
    let css = await this.readFile(path);

    path = await gateway.getResUrl('/styles/popup_type' + type + '.css');
    css += '\n' + await this.readFile(path);

    switch (theme) {
      case c.THEMES.DARK:
        let path = await gateway.getResUrl('/styles/popup_dark.css');
        css += '\n' + await this.readFile(path);

        path = await gateway.getResUrl('/styles/popup_type' + type + '_dark.css');
        css += '\n' + await this.readFile(path);
        break;
      case c.THEMES.LIGHT:
      default:
        break;
    }

    return css;
  }

  async getWelcomeHtml(id, properties = {}) {
    let path = await gateway.getResUrl('/layouts/popup_welcome_' + id + '.html');
    return await this.parseProperties(await this.readFile(path), properties);
  }

  async parseProperties(content, properties) {
    for (let key in properties) {
      content = content.replaceAll("{{" + key + "}}", properties[key]);
    }
    return content;
  }

  async readFile(path) {
    let response = await origFetch(path);
    return await response.text();
  }
}
const components = new ComponentLoader();

/**
 * Can be called by multiple processes at the same time
 * For non-interactive messages
 */
class Toast {
  static PROCESSES = {}
  static state = c.TOAST_STATES.HIDDEN;
  static timeoutShow = null;
  static timeoutHide = null;
  delay = 100;

  async init() {
    document.body.insertAdjacentHTML("afterbegin", await components.getToastContainerHTML());
  }

  async show(title, text, relatedNodeId) {
    Toast.PROCESSES[relatedNodeId] = {
      title: title,
      text: text
    };

    if (Toast.state === c.TOAST_STATES.TRANSITIONING) {
      while (Toast.state === c.TOAST_STATES.TRANSITIONING) {
        await u.sleep(50);
      }
    }

    if (Toast.timeoutHide !== null) {
      clearTimeout(Toast.timeoutHide);
      Toast.timeoutHide = null;
    }

    if (Toast.state === c.TOAST_STATES.HIDDEN && Toast.timeoutShow === null) {
      Toast.timeoutShow = setTimeout(async function () {
        Toast.state = c.TOAST_STATES.TRANSITIONING;

        let process = Object.values(Toast.PROCESSES)[0];
        let title = process.title;
        let text = process.text;
        document.getElementById("_message").innerHTML = "<span><b>" + title + "</b> " + text + "</span>";

        let toastElement = document.getElementById("_toast2");
        let height = toastElement.offsetHeight;
        toastElement.style.marginBottom = "-" + height + "px";
        await u.sleep(50);
        toastElement.style.visibility = "visible";
        toastElement.style.transition = "all .3s ease-in-out";
        await u.sleep(50);
        toastElement.style.marginBottom = "0px";
        await u.sleep(300);

        Toast.timeoutShow = null;
        Toast.state = c.TOAST_STATES.SHOWN;
      }, this.delay);
    }
  }

  async hide(relatedNodeId) {
    delete Toast.PROCESSES[relatedNodeId];

    if (Object.values(Toast.PROCESSES).length > 0) {
      let process = Object.values(Toast.PROCESSES)[0];
      let title = process.title;
      let text = process.text;
      document.getElementById("_message").innerHTML = "<span><b>" + title + "</b> " + text + "</span>";
      return;
    }

    if (Toast.state === c.TOAST_STATES.TRANSITIONING) {
      while (Toast.state === c.TOAST_STATES.TRANSITIONING) {
        await u.sleep(50);
      }
    }

    if (Toast.timeoutShow !== null) {
      clearTimeout(Toast.timeoutShow);
      Toast.timeoutShow = null;
    }

    if (Toast.state === c.TOAST_STATES.SHOWN && Toast.timeoutHide === null) {
      Toast.timeoutHide = setTimeout(async function () {
        Toast.state = c.TOAST_STATES.TRANSITIONING;

        let toastElement = document.getElementById("_toast2");
        let height = toastElement.offsetHeight;
        toastElement.style.marginBottom = "-" + height + "px";
        await u.sleep(300);
        toastElement.style.visibility = "hidden";
        toastElement.style.transition = "all 0s";

        Toast.timeoutHide = null;
        Toast.state = c.TOAST_STATES.HIDDEN;
      }, this.delay);
    }
  }
}
const toast = new Toast();

/**
 * Can be called by a single process at a time
 * Async popup with multiple pages
 * Call with await to block the execution until the popup is closed
 * args: {
 *  type: int,
 *  style: string,
 *  pages: [{
 *   title: string,
 *   text: string,
 *   input: {
 *    label: string,
 *    placeholder: string
 *   }
 *   buttons: [{
 *    outcome: int,
 *    text: string,
 *    focus: bool,
 *    primary: bool,
 *    onClick: function
 *   }],
 *   html: [{
 *    position: string,
 *    content: string
 *   }],
 *   script: function
 *  }]
 * }
 */
class Popup {
  static resolve = null;
  static args = null;

  create(title, text, buttons = [], cancellable = true, args = {}) {
    return new Promise(async (resolve, reject) => {
      Popup.resolve = resolve;
      Popup.args = args;

      // Create page from function args
      if (!args.pages || !Array.isArray(args.pages) || args.pages.length === 0) {
        args.pages = [{
          title: title,
          text: text,
          buttons: buttons
        }];
      }

      // Create popup
      document.body.insertAdjacentHTML("afterbegin", await components.getPopupContainerHTML());
      u.updateTheme();
      var popupElement = document.getElementById("_popup");
      var element = document.createElement('style');
      element.innerHTML = await components.getPopupCss(args.type);
      popupElement.appendChild(element);
      if (args.style) {
        var element = document.createElement('style');
        element.innerHTML = args.style;
        popupElement.appendChild(element);
      }
      await u.sleep(300);

      Popup.args.pageCount = args.pages.length;
      Popup.args.currentPage = 0;
      Popup.args.cancellable = cancellable;
      Popup.args.type = Popup.args.type ?? c.POPUP_TYPES.DEFAULT;
      this.setPage(0);
      this.show();

      if (cancellable) {
        document.getElementById("_popup").addEventListener('click', function(evt) {
          if ( evt.target != this ) return false;
          Popup.onClick(null, c.OUTCOMES.CANCEL);
        });
      }
    });
  }

  async show() {
    let popupElement = document.getElementById("_popup");
    let popupBoxElement = document.getElementById("_popup-box");
    popupElement.style.visibility = "visible";
    popupElement.style.opacity = "0";
    popupElement.style.transition = "all .3s ease-in-out";
    popupBoxElement.style.marginTop = "6vh";
    popupBoxElement.style.transform = "scale(0.98)";
    popupBoxElement.style.transition = "all .3s ease-in-out";
    await u.sleep(300);
    popupBoxElement.style.marginTop = "10vh";
    popupBoxElement.style.transform = "scale(1)";
    popupElement.style.opacity = "1";
    await u.sleep(300);

    if (document.activeElement) {
      Popup.args.activeElement = document.activeElement;
      document.activeElement.blur();
    }
    if (Popup.args.type === c.POPUP_TYPES.MINI) {
      document.addEventListener('keydown', Popup.onKeyPress);
    }
  }

  async hide(outcome = c.OUTCOMES.CANCEL) {
    if (Popup.args.type === c.POPUP_TYPES.MINI) {
      document.removeEventListener('keydown', Popup.onKeyPress);
    }
    if (Popup.args.activeElement) {
      Popup.args.activeElement.focus();
    }

    let popupElement = document.getElementById("_popup");
    let popupBoxElement = document.getElementById("_popup-box");
    popupElement.style.opacity = "0";
    popupBoxElement.style.marginTop = "6vh";
    popupBoxElement.style.transform = "scale(0.98)";
    await u.sleep(300);
    document.getElementById("_popup").remove();

    let resolve = Popup.resolve;
    Popup.resolve = null;
    Popup.args = {};
    resolve(outcome);
  }

  async setPage(pageIndex) {
    const popupBoxElement = document.getElementById("_popup-box");
    const pageCount = Popup.args.pageCount;
    const endOfPages = pageIndex === pageCount - 1;
    const cancellable = Popup.args.cancellable;
    const type = Popup.args.type;
    const page = Popup.args.pages[pageIndex];

    const title = page["title"] ?? "";
    const text = page["text"] ?? "";
    const input = page["input"] ?? null;
    const buttons = page["buttons"] ?? [];
    let htmlList = page["html"] ?? [];
    const script = page["script"] ?? (() => {});

    // Remove current page
    let content = document.getElementById("_popup-content");
    if (content.children.length !== 0) {
      content.style.opacity = "0";
      await u.sleep(300);
      content.replaceChildren();
    }

    // Load new page
    var titleElement = document.createElement('p');
    titleElement.classList.add("_popup-title");
    titleElement.innerHTML = title;
    content.appendChild(titleElement);

    var textElement = document.createElement('p');
    textElement.classList.add("_popup-text");
    textElement.id = "_popup-text";
    textElement.innerHTML = text;
    content.appendChild(textElement);

    if (input !== null) {
      var divElement1 = document.createElement('div');
      divElement1.classList.add("_input");
      content.appendChild(divElement1);
      
      var textElement = document.createElement('p');
      textElement.classList.add("_input-text");
      textElement.innerHTML = input["label"];
      divElement1.appendChild(textElement);

      var divElement2 = document.createElement('div');
      divElement2.classList.add("_input-box-container");
      divElement1.appendChild(divElement2);

      var inputElement = document.createElement('input');
      inputElement.classList.add("_input");
      inputElement.type = 'text';
      inputElement.placeholder = input["placeholder"];
      inputElement.id = "_input-box";
      divElement2.appendChild(inputElement);
    }

    if (htmlList.length > 0) {
      htmlList = htmlList.filter((htmlItem) => {
        if (htmlItem.position === "beforebuttons") {
          content.insertAdjacentHTML("beforeend", htmlItem.content);
          return false;
        }
        return true;
      });
    }

    var buttonsElement = document.createElement('div');
    buttonsElement.classList.add("_popup-buttons");
    buttonsElement.id = "_popup-buttons";
    content.appendChild(buttonsElement);
    
    if (buttons.length === 0) {
      if (type === c.POPUP_TYPES.DEFAULT) {
        buttons.push({
          outcome: (endOfPages ? c.OUTCOMES.COMPLETE : c.OUTCOMES.NEXT),
          text: (endOfPages ? "Close" : "Next"),
        })
      } else {
        buttons.push({
          outcome: c.OUTCOMES.COMPLETE,
          text: "Close",
          primary: true
        })
      }
    }

    for (let i = 0; i < buttons.length; i++) {
      const buttonData = buttons[i];

      var buttonElement = document.createElement('button');
      buttonElement.classList.add(type === c.POPUP_TYPES.DEFAULT ? "_popup-button" : (buttonData.primary ? "_popup-button-primary" : "_popup-button-secondary"));
      buttonElement.id = "_popup-button" + i;
      buttonElement.type = "button";
      buttonElement.setAttribute("data-id", i);
      // Possibly change assigned keys for primary and secondary buttons in the future
      buttonElement.innerHTML = type === c.POPUP_TYPES.DEFAULT
        ? buttonData.text :
        ('<span>' + buttonData.text + '</span><span class="' + (buttonData.primary ? '_popup-button-hint-primary' : '_popup-button-hint-secondary') + '">' + (buttonData.primary ? '&nbsp;⏎' : '&nbsp;esc') + '</span>');
      
      let onClickFunc = () => {
        Popup.onClick(i, buttonData.outcome);
      }
      buttonElement.onclick = onClickFunc;
      if (type === c.POPUP_TYPES.MINI) {
        if (buttonData.primary) {
          Popup.args.primaryOnClick = onClickFunc;
        } else {
          Popup.args.secondaryOnClick = onClickFunc;
        }
      }
      buttonsElement.appendChild(buttonElement);

      if (buttonData.focus === true) {
        await u.sleep(100);
        buttonElement.focus();
      }
    }

    if (htmlList.length > 0) {
      for (let htmlItem of htmlList) {
        content.insertAdjacentHTML(htmlItem.position, htmlItem.content);
      }
    }

    if (cancellable && type === c.POPUP_TYPES.MINI) {
      content.insertAdjacentHTML('beforeend', await components.getPopupCloseHTML());
      document.getElementById("_popup-close").onclick = () => {
        Popup.onClick(null, c.OUTCOMES.CANCEL);
      };
    }

    await u.sleep(100);
    script();

    popupBoxElement.style.minHeight = "0";
    Popup.args.currentPage = pageIndex;
    content.style.opacity = "1";

    await u.sleep(300);
    let popupBoxHeight = popupBoxElement.offsetHeight;
    popupBoxElement.style.minHeight = popupBoxHeight + "px";
  }

  static async onClick(id, outcome) {
    const currentPage = Popup.args.currentPage;
    if (outcome === c.OUTCOMES.CUSTOM) {
      outcome = (await Popup.args.pages[currentPage].buttons[id].onClick() ?? outcome);
    }

    switch (outcome) {
      case c.OUTCOMES.PREV:
        popup.setPage(currentPage - 1);
        break;
      case c.OUTCOMES.NEXT:
        popup.setPage(currentPage + 1);
        break;
      case c.OUTCOMES.CANCEL:
      case c.OUTCOMES.COMPLETE:
        popup.hide(outcome);
        break;
      default:
      case c.OUTCOMES.IGNORE:
        return;
    }
  }

  static async onKeyPress(event) {
    event.stopPropagation();
    if (event.key === 'Enter' || event.keyCode === 13) {
      Popup.args.primaryOnClick();
    } else if (event.key === 'Escape' || event.keyCode === 27) {
      Popup.args.secondaryOnClick();
    }
  }
}
const popup = new Popup();

class PopupHelper {
  async welcome() {
    await u.sleep(2000);
    return await popup.create(null, null, [], false, {
      style: await components.getWelcomeCss(),
      pages: [
        {
          title: "Let's Secure Your Data",
          text: "Welcome to Workflowy Encrypter! To enable seamless client-side encryption, follow this brief setup and let us help you secure your data.",
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(1, {
              logo_url: await gateway.getResUrl('/src/logo_128.png'),
              logo_w_url: await gateway.getResUrl('/src/logo_w_128.png')
            })
          }],
          script: () => {
            const text1 = document.getElementById("we-text1");
            const text2 = document.getElementById("we-text2");
            const blue = document.getElementById("_blue");
            const blueContent = document.getElementById("_blue-content");
            const box = document.getElementById("_html1-box");
            const logo = document.getElementById("_html1-logo");
            var boxRect = box.getBoundingClientRect(),
              elemRect = logo.getBoundingClientRect(),
              offsetTop   = elemRect.top - boxRect.top,
              offsetLeft   = elemRect.left - boxRect.left;
    
            blue.style.left = offsetLeft + (64/2) - 1 + "px";
            blue.style.top = offsetTop + (64/2) + "px";
            blueContent.style.left = (-offsetLeft - (64/2) + 1) + "px";
            blueContent.style.top = (-offsetTop - (64/2)) + "px";
            text2.style.width = text1.offsetWidth + "px";
            
            let setRandomText = (text2) => {
              text2.textContent = c.PRE_ENC_CHAR + u.randomStr(15 - c.PRE_ENC_CHAR.length);
              setTimeout(() => {
                setRandomText(text2)
              }, 7 * 1000);
            }
            setTimeout(() => {
              setRandomText(text2)
            }, 6 * 1000);
          }
        },
        {
          title: "Craft Your Key",
          text: "Use the button below to open a secure area where you can safely register your key to be used for encryption. This will open a new tab.",
          buttons: [{
            outcome: c.OUTCOMES.CUSTOM,
            text: "Set key",
            onClick: async function() {
              let button = document.getElementById("_popup-button0");
              let loader = document.getElementById("_loader");
              let text = document.getElementById("_popup-text");
              let buttonAction = button.getAttribute("data-action") ?? "registerKey";
              let checkSecretAction = async () => {
                // Ignore broadcasted actions
                broadcastCheckTime = new Date().getTime();

                if (await gateway.secretLoaded(true)) {
                  focusTracker.clearAction();

                  loader.style.display = "none";
                  text.innerHTML = "Great, you have successfully registered your key.";
                  button.textContent = "Next";
                  button.setAttribute("data-action", "next");
                }
              };

              switch (buttonAction) {
                case "registerKey":
                  await gateway.openOptionsPage(c.ACTIONS.SET_KEY);

                  focusTracker.setAction(checkSecretAction);

                  loader.style.display = "block";
                  text.innerHTML = "The setup will continue once you have registered your key. If the tab didn't open, <a onclick='ExtensionGateway.call(\"openOptionsPage\", \"setLockKey\")'><b>click here</b></a> or navigate to the extension's options page.";
                  button.textContent = "Check key";
                  button.setAttribute("data-action", "checkKey");

                  return c.OUTCOMES.IGNORE;
                case "checkKey":
                  if (await gateway.secretLoaded()) {
                    await checkSecretAction();
                    return c.OUTCOMES.IGNORE;
                  } else {
                    toast.show("Key not set", "Register a key to continue", "KEY");
                    await u.sleep(3000);
                    toast.hide("KEY");
                    return c.OUTCOMES.IGNORE;
                  }
                case "next":
                  return c.OUTCOMES.NEXT;
              }
            }
          }],
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(2, {
              key_url: await gateway.getResUrl('/src/key_128.png')
            })
          },
          {
            position: "beforebuttons",
            content: await components.getWelcomeHtml("2_loader")
          }]
        },
        {
          title: "Use Your Key",
          text: "Now that your key is ready, you can use it seamlessly just by adding a " + c.LOCK_TAG + " tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically.",
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(3, {
              ss1_url: theme === c.THEMES.LIGHT ? (await gateway.getResUrl('/src/ss1.png')) : (await gateway.getResUrl('/src/ss1_dark.png'))
            })
          }]
        },
        {
          title: "That's It!",
          text: "Encrypted nodes will be readable only from web browsers that have Workflowy Encrypter installed. Try to use a different device or disable the extension temporarily to see the magic!",
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(4, {
              logo_url: await gateway.getResUrl('/src/logo_128.png'),
              logo_w_url: await gateway.getResUrl('/src/logo_w_128.png')
            })
          }],
          script: () => {
            const blue = document.getElementById("_blue");
            const blueContent = document.getElementById("_blue-content");
            const box = document.getElementById("_html1-box");
            const logo = document.getElementById("_html1-logo");
            var boxRect = box.getBoundingClientRect(),
              elemRect = logo.getBoundingClientRect(),
              offsetTop   = elemRect.top - boxRect.top,
              offsetLeft   = elemRect.left - boxRect.left;
    
            blue.style.left = offsetLeft + (64/2) - 1 + "px";
            blue.style.top = offsetTop + (64/2) + "px";
            blueContent.style.left = (-offsetLeft - (64/2) + 1) + "px";
            blueContent.style.top = (-offsetTop - (64/2)) + "px";
          }
        }
      ]
    });
  }

  async migrateLockKey() {
    await u.sleep(1000);
    await popup.create(null, null, [], false, {
      style: await components.getWelcomeCss(),
      pages: [
        {
          title: "A Little Rearrangement",
          text: "We are updating the location where your key is stored on your device to enhance its security. Use the button below to move your key to the new location. This will open a new tab.",
          buttons: [{
            outcome: c.OUTCOMES.CUSTOM,
            text: "Move key",
            onClick: async function() {
              let button = document.getElementById("_popup-button0");
              let loader = document.getElementById("_loader");
              let text = document.getElementById("_popup-text");
              let buttonAction = button.getAttribute("data-action") ?? "moveKey";
              
              let checkSecretAction = async () => {
                // Ignore broadcasted actions
                broadcastCheckTime = new Date().getTime();

                if (await gateway.getVar("keyMoved", false)) {
                  focusTracker.clearAction();

                  window.localStorage.removeItem("lockSecret");
                  window.localStorage.removeItem("lockCache");

                  loader.style.display = "none";
                  text.innerHTML = "You have successfully moved your key to its new secure location. <b>If you bave other Workflowy tabs, reload them to prevent encryption issues.</b>";
                  button.textContent = "Close";
                  button.setAttribute("data-action", "next");
                }
              };

              switch (buttonAction) {
                case "moveKey":
                  let secret = window.localStorage.getItem("lockSecret");
                  await gateway.setVar("keyMoved", false);
                  await gateway.openOptionsPage(c.ACTIONS.MOVE_KEY, secret);
                  focusTracker.setAction(checkSecretAction);

                  loader.style.display = "block";
                  text.innerHTML = "Waiting for you key to be moved to its new location. If the tab didn't open, <a onclick='ExtensionGateway.call(\"openOptionsPage\", \"migrateLockKey\", \"" + secret + "\")'><b>click here</b></a> or navigate to the extension's options page.";
                  button.textContent = "Check key";
                  button.setAttribute("data-action", "checkKey");

                  return c.OUTCOMES.IGNORE;
                case "checkKey":
                  if (await gateway.getVar("keyMoved", false)) {
                    await checkSecretAction();
                    return c.OUTCOMES.IGNORE;
                  } else {
                    toast.show("Key not set", "Confirm moving your key to continue", "KEY");
                    await u.sleep(3000);
                    toast.hide("KEY");
                    return c.OUTCOMES.IGNORE;
                  }
                case "next":
                  return c.OUTCOMES.COMPLETE;
              }
            }
          }],
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(2, {
              key_url: await gateway.getResUrl('/src/logo_128.png')
            })
          },
          {
            position: "beforebuttons",
            content: await components.getWelcomeHtml("2_loader")
          }]
        }
      ]
    }); 
  }
}
const popupHelper = new PopupHelper();

class API {
  async pushAndPoll(operations) {
    let rawBody = {
      client_id: clientId,
      client_version: clientVersion,
      crosscheck_user_id: crosscheckUserId,
      push_poll_data: [],
      push_poll_id: null // Find what to send
    };

    for (let shareId in operations) {
      let operationsInstance = operations[shareId];
      let pushPollDataInstance = {
        most_recent_operation_transaction_id: mostRecentOperationTransactionId,
        operations: operationsInstance
      };
      if (shareId !== c.DEFAULT_SHARE_ID) {
        pushPollDataInstance.share_id = shareId;
      }
      rawBody.push_poll_data.push(pushPollDataInstance);
      
      mostRecentOperationTransactionId++; // Find whether increment is needed
    }

    let body = await util.decodeBody(rawBody);
    let response = await origFetch(c.DOMAIN + "/push_and_poll", {
      method: 'POST',
      credentials: "same-origin",
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Wf_build_date': wfBuildDate
      },
      body: body,
      url: c.DOMAIN + "/push_and_poll"
    });
  }
}
const api = new API();

class Encrypter {
  async encrypt(data) {
    return await gateway.encrypt(data);
  }

  async decrypt(data) {
    return await gateway.decrypt(data);
  }

  async checkSecret() {
    if (await gateway.secretLoaded()) {
      return true;
    }

    // Secret is not loaded
    bypassLock = true;
    let reloadPage = true;
    staller.ready();

    let blocker = await gateway.getBlocker();
    switch (blocker) {
      case c.ACTIONS.MOVE_KEY:
        await popupHelper.migrateLockKey();
        break;
      case c.ACTIONS.WELCOME:
        await popupHelper.welcome();
        await gateway.setBlocker(null, true);
        break;
      default:
        await popup.create(
          "Encryption disabled",
          "Workflowy Encrypter cannot access your key. Use the button below to set your key, if you haven't already, or cancel to use Workflowy without encryption.", [
          {
            text: "Cancel",
            outcome: c.OUTCOMES.CANCEL
          },
          {
            text: "Set key",
            outcome: c.OUTCOMES.CUSTOM,
            primary: true,
            onClick: async function() {
              await gateway.openOptionsPage(c.ACTIONS.SET_KEY);
              return c.OUTCOMES.IGNORE;
            }
          }
        ], true, {type: c.POPUP_TYPES.MINI});
        reloadPage = false;
        break;
    }

    if (reloadPage) {
      window.onbeforeunload = null;
      location.reload();
    }
  }
}
const encrypter = new Encrypter();

class Util {
  async encodeBody(rawBody) {
    let body = {};
    let list = rawBody.split("&");
    for (let item of list) {
      let parts = item.split("=");
      let key = parts[0];
      let val = decodeURIComponent(parts[1].replaceAll("+", " "));
      if (["[", "{"].includes(val.charAt(0))) {
        val = JSON.parse(val);
      }
      body[key] = val;
    }
    return body;
  }
  
  async decodeBody(body) {
    let list = [];
    for (const key in body) {
      if (!body.hasOwnProperty(key)) {
        continue;
      }
  
      let val = body[key];
      if (!u.isString(val)) {
        val = JSON.stringify(val);
      }
      val = encodeURIComponent(val).replaceAll("%20", "+");
      list.push(key + "=" + val);
    }
    return list.join("&");
  }

  async processNewTreeData(data) {
    let enforce = false;
    let id = data.id;
    let properties = {};
    properties[c.PROPERTIES.PARENT] = data.prnt;
    if (data.nm !== undefined) {
      data.nm = await encrypter.decrypt(data.nm);
      properties[c.PROPERTIES.NAME] = data.nm;
    }
    if (data.no !== undefined) {
      data.no = await encrypter.decrypt(data.no);
      properties[c.PROPERTIES.DESCRIPTION] = data.no;
    }

    if (data.as) {
      properties[c.PROPERTIES.LOCAL_ID] = data.id;
      id = nodes.find(c.PROPERTIES.SHARE_ID, data.as, true)[0] ?? id;
      enforce = true; // Enforce parent
    }

    nodes.update(id, properties, enforce);
  }

  async decryptServerResponse(json, trackedChangeData, shareId = null) {
    // trackedChanges is global and holds temporary data
    // trackedChangeData holds the data that is currently being processed
    for (let op of json.ops) {
      if (op.data === undefined) {
        continue;
      }

      let dataObj = [];
      let stringifyJson = [];

      trackedChanges = [];
      let flags = [c.FLAGS.SUPPRESS_WARNINGS, c.FLAGS.NO_FETCH, c.FLAGS.TRACK_ENCRYPTION_CHANGES];
      if (shareId !== null) {
        flags.push(c.FLAGS.IGNORE_NULL_PARENT);
      }
      let result = await util.processOperation(op, dataObj, stringifyJson, flags);
      if (result === false) {
        return false;
      }

      for (let changed of trackedChanges) {
        let id = changed["id"];
        let data = trackedChangeData[id] ?? {};
        if (data["initial"] === undefined) {
          data["initial"] = nodes.isLocked(id);
        }
        trackedChangeData[id] = data;
      }

      // Process data objects
      result = await util.processDataObjects(dataObj, [c.FLAGS.FORCE_DECRYPT]);
      result = await util.processDataToStringify(stringifyJson);

      for (let changed of trackedChanges) {
        let id = changed["id"];
        let data = trackedChangeData[id] ?? {};
        data["final"] = nodes.isLocked(id);
        data["name"] = nodes.get(id, c.PROPERTIES.NAME);
        trackedChangeData[id] = data;
      }
    }
  }

  async processOperation(operation, dataObj, stringifyJson, flags = []) {
    if (operation.type === undefined) {
      return false;
    }
    switch (operation.type) {
      case "bulk_create":
        return await this.processCreateOperation(operation, dataObj, stringifyJson, flags);
      case "edit":
        return await this.processEditOperation(operation, dataObj, flags);
      case "bulk_move":
        return await this.processMoveOperation(operation, dataObj, flags);
      case "delete":
        return await this.processDeleteOperation(operation, dataObj, flags);
      default:
        return true;
    }
  }

  async processCreateOperation(operation, dataObj, stringifyJson, flags = []) {
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : (flags.includes(c.FLAGS.IGNORE_NULL_PARENT) ? undefined : null);
    operation.data.project_trees = JSON.parse(operation.data.project_trees);
    stringifyJson.push({
      contentTag: "project_trees",
      node: operation.data
    });
    dataObj = dataObj.concat(this.processCreateBulkDataRecursively(operation.data.project_trees, parent, dataObj));
  }

  processCreateBulkDataRecursively(projects, parent, dataObj) {
    for (let project of projects) {
      let obj = {
        id: project.id,
        process: [],
        properties: {}
      };
      obj.properties[c.PROPERTIES.PARENT] = parent;

      if (project.nm) {
        obj.process.push({
          node: project,
          contentTag: "nm"
        });
        obj.properties[c.PROPERTIES.NAME] = project.nm;
      }
      if (project.no) {
        obj.process.push({
          node: project,
          contentTag: "no"
        });
        obj.properties[c.PROPERTIES.DESCRIPTION] = project.no;
      }
      dataObj.push(obj);
  
      if (project.ch && Array.isArray(project.ch)) {
        this.processCreateBulkDataRecursively(project.ch, project.id, dataObj);
      }
    }
  }

  async processEditOperation(operation, dataObj, flags = []) {
    if (operation.data.name === undefined && operation.data.description === undefined) {
      return true;
    }

    let obj = {
      id: operation.data.projectid,
      process: [],
      properties: {}
    };
    
    if (operation.data.description !== undefined) {
      obj.properties[c.PROPERTIES.DESCRIPTION] = operation.data["description"];
      obj.process.push({
        node: operation.data,
        contentTag: "description"
      });
      obj.process.push({
        node: operation.undo_data,
        contentTag: "previous_description"
      });
    }
    if (operation.data.name !== undefined) {
      obj.properties[c.PROPERTIES.NAME] = operation.data["name"];
      obj.process.push({
        node: operation.data,
        contentTag: "name"
      });
      obj.process.push({
        node: operation.undo_data,
        contentTag: "previous_name"
      });

      // Process child nodes if exists
      const name = operation.data.name;
      const id = operation.data.projectid;
      if (!nodes.isLocked(id) && name.includes(c.LOCK_TAG) && nodes.hasChild(id)) { // Encryption added
        if (flags.includes(c.FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        await this.updateChildNodeEncryption(id, true, false, flags);
      } else if (nodes.isLocked(id, true) && !nodes.isLocked(nodes.getParent(id)) && !name.includes(c.LOCK_TAG) && nodes.hasChild(id)) { // Encryption removed
        if (flags.includes(c.FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        if (
          flags.includes(c.FLAGS.SUPPRESS_WARNINGS)
          || (await popup.create(
            "Confirm decryption",
            "Are you sure you want to remove the " + c.LOCK_TAG + " tag and decrypt all child nodes? This will send decrypted content to Workflowy servers.",
            [
              {
                text: "Cancel",
                outcome: c.OUTCOMES.CANCEL
              },
              {
                text: "Decrypt",
                outcome: c.OUTCOMES.COMPLETE,
                primary: true
              }
            ], true, {type: c.POPUP_TYPES.MINI})) === c.OUTCOMES.COMPLETE
        ) {
          await this.updateChildNodeEncryption(id, false, false, flags);
        } else {
          window.onbeforeunload = null;
          location.reload();
          quarantine = true;
          return false;
        }
      }
    }

    dataObj.push(obj);
  }

  async updateChildNodeEncryption(id, encrypt, processParentNode, flags = [], processingParent = true, rootId = null, operations = null) {
    if (processingParent) {
      if (flags.includes(c.FLAGS.NO_FETCH)) {
        return true;
      }
      await toast.show((encrypt ? "Encryption" : "Decryption") + " in progress...", "Keep the page open until this message disappears.", id);
      rootId = id;
      operations = {};
    }

    await this.createEncryptionOperationForNode(id, encrypt, processParentNode, processingParent, rootId, operations);

    let parent = nodes.getParent(id);
    if (processingParent || parent === rootId || (parent !== rootId && !nodes.isLocked(parent, true))) {
      // Get children
      let ids = nodes.getChildren(id);
      for (let id of ids) {
        await this.updateChildNodeEncryption(id, encrypt, false, flags, false, rootId, operations);
      }
    }

    if (processingParent) {
      await api.pushAndPoll(operations);
      await toast.hide(id);
    }
    return true;
  }

  async createEncryptionOperationForNode(id, encrypt, processParentNode, processingParent, rootId, operations) {
    let parent = nodes.getParent(id);
    if (
      (!processingParent || processParentNode) &&
      (processingParent || parent === rootId || (parent !== rootId && !nodes.isLocked(parent, true)))
      ) {
      let operation = {
        type: "edit",
        client_timestamp: null, // Find what to send
        data: {
          metadataPatches: [],
          metadataInversePatches: [],
          projectid: id
        },
        undo_data: {
          metadataPatches: [],
          previous_last_modified: null, // Find what to send
          previous_last_modified_by: null
        }
      };

      let name = nodes.get(id, c.PROPERTIES.NAME);
      if (name !== undefined) {
        operation.data.name = encrypt ? await encrypter.encrypt(name) : name;
        operation.undo_data.previous_name = encrypt ? await encrypter.encrypt(name) : name;
      }

      let description = nodes.get(id, c.PROPERTIES.DESCRIPTION);
      if (description !== undefined) {
        operation.data.description = encrypt ? await encrypter.encrypt(description) : description;
        operation.undo_data.previous_description = encrypt ? await encrypter.encrypt(description) : description;
      }

      let branch = nodes.getShareId(id) === undefined ? c.DEFAULT_SHARE_ID : nodes.getShareId(id);
      let operationsBranch = operations[branch] ?? [];
      operationsBranch.push(operation);
      operations[branch] = operationsBranch;
    }
  }

  async processMoveOperation(operation, dataObj, flags = []) {
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : (flags.includes(c.FLAGS.IGNORE_NULL_PARENT) ? undefined : null);
    let ids = JSON.parse(operation.data.projectids_json);
    let decryptionAllowed = false;
    for (let id of ids) {
      let obj = {
        id: id,
        properties: {}
      }
      obj.properties[c.PROPERTIES.PARENT] = parent;
      dataObj.push(obj);

      // Process child nodes if exists
      if (nodes.isLocked(parent) && !nodes.isLocked(id)) { // Encryption added
        if (flags.includes(c.FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        await this.updateChildNodeEncryption(id, true, true, flags);
      } else if (!nodes.isLocked(parent) && nodes.isLocked(nodes.getParent(id))) { // Encryption removed
        if (flags.includes(c.FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        if (
          flags.includes(c.FLAGS.SUPPRESS_WARNINGS)
          || decryptionAllowed
          || (await popup.create(
            "Confirm decryption",
            "Are you sure you want to move selected node(s) under a non-encrypted node and decrypt their data? This will send decrypted content to Workflowy servers.",
            [
              {
                text: "Cancel",
                outcome: c.OUTCOMES.CANCEL
              },
              {
                text: "Decrypt",
                outcome: c.OUTCOMES.COMPLETE,
                primary: true
              }
            ], true, {type: c.POPUP_TYPES.MINI})) === c.OUTCOMES.COMPLETE
        ) {
          decryptionAllowed = true;
          await this.updateChildNodeEncryption(id, false, true, flags);
        } else {
          window.onbeforeunload = null;
          location.reload();
          quarantine = true;
          return false;
        }
      }
    }
  }

  async processDeleteOperation(operation, dataObj, flags = []) {
    let id = operation.data.projectid;
    nodes.delete(id);
  }

  /**
   * If FORCE_DECRYPT flag is set, decrypt
   * Otherwise, encrypt if given node id's parent is locked
   * dataObj: [{
   *  id: string,
   *  delete: boolean,
   *  properties: {
   *   name: string,
   *   description: string
   *  },
   *  process: [{
   *   node: object,
   *   contentTag: string
   *  }]
   * }]
   */
  async processDataObjects(dataObj, flags = []) {
    for (let data of dataObj) {
      let id = data["id"];

      // Update node
      if (data["delete"] === true) {
        nodes.delete(id);
      } else if (data["properties"]) {
        if (flags.includes(c.FLAGS.FORCE_DECRYPT)) {
          for (let property in data["properties"]) {
            if (c.SENSITIVE_PROPERTIES.includes(property)) {
              data["properties"][property] = await encrypter.decrypt(data["properties"][property]);
            }
          }
        }

        nodes.update(id, data["properties"]);
      }

      // Process flags or encrypt node data if the parent is locked as well
      if (data["process"]) {
        for (let item of data["process"]) {
          let node = item["node"];
          let contentTag = item["contentTag"];
          if (node === undefined || node[contentTag] === undefined) {
            continue;
          }

          if (flags.includes(c.FLAGS.FORCE_DECRYPT)) {
            node[contentTag] = await encrypter.decrypt(node[contentTag]);
          } else if (nodes.isLocked(nodes.getParent(id)) && node && contentTag && node[contentTag] && u.isString(node[contentTag]) && node[contentTag].length > 0) {
            node[contentTag] = await encrypter.encrypt(node[contentTag]);
          }
        }
      }
    }
  }

  async processDataToStringify(stringifyJson) {
    for (let item of stringifyJson) {
      let contentTag = item.contentTag;
      item.node[contentTag] = JSON.stringify(item.node[contentTag]);
    }
  }

  // For debugging
  async getTree(targetParent = null) {
    let tree = [];
    let nodeIds = nodes.getChildren(targetParent)
    for (let nodeId of nodeIds) {
      let node = nodes.get(nodeId);
      
      let treeNode = {
        share_id: nodes.getShareId(nodeId),
        id: nodeId,
        name: nodes.get(nodeId, c.PROPERTIES.NAME),
        description: nodes.get(nodeId, c.PROPERTIES.DESCRIPTION),
        locked: nodes.isLocked(nodeId),
        data: node,
        children: await this.getTree(nodeId)
      };
      tree.push(treeNode);
    }
    return tree;
  }
}
const util = new Util();

class RouteHandler {
  async prePushAndPoll(params) {
    // Encrypt submitted push_and_poll data
    let body = await util.encodeBody(params.body);
    crosscheckUserId = body.crosscheck_user_id;
    clientId = body.client_id;
    clientVersion = body.client_version;
    wfBuildDate = params.headers.WF_BUILD_DATE;
    for (let pushPollData of body.push_poll_data) {
      if (pushPollData.operations === undefined) {
        continue;
      }

      for (let operation of pushPollData.operations) {
        let dataObj = [];
        let stringifyJson = [];

        // Extract data object list
        let result = await util.processOperation(operation, dataObj, stringifyJson);
        if (quarantine) {
          return false;
        } else if (result === false) {
          continue;
        }

        // Process data objects
        result = await util.processDataObjects(dataObj);
        result = await util.processDataToStringify(stringifyJson);
      }
    }
    params.body = await util.decodeBody(body);

    return params;
  }

  async postPushAndPoll(responseData) {
    // Find another point to clear cache later
    if (!cacheClearPerformed) {
      await gateway.clearCache();
      cacheClearPerformed = true;
    }

    // Track encryption changes
    let trackedChangeData = {};

    for (let result of responseData.results) {
      if (result.server_run_operation_transaction_json !== undefined) {
        let json = JSON.parse(result.server_run_operation_transaction_json);
        await util.decryptServerResponse(json, trackedChangeData, (result.share_id ?? null));
        result.server_run_operation_transaction_json = JSON.stringify(json);
      }
      if (result.concurrent_remote_operation_transactions !== undefined) {
        for (let i = 0; i < result.concurrent_remote_operation_transactions.length; i++) {
          let json = JSON.parse(result.concurrent_remote_operation_transactions[i]);
          await util.decryptServerResponse(json, trackedChangeData, (result.share_id ?? null));
          result.concurrent_remote_operation_transactions[i] = JSON.stringify(json);
        }
      }
    }

    let attentionNeeded = [];
    for (let id in trackedChangeData) {
      if (trackedChangeData[id]["initial"] === true && trackedChangeData[id]["final"] === false) {
        attentionNeeded.push(trackedChangeData[id]["name"]);
      }
    }
    if (attentionNeeded.length > 0 && (await gateway.secretLoaded())) {
      await popup.create("Heads Up!", c.LOCK_TAG + " tag is removed from the following node(s) via a remote session. Add the tag again to keep your data protected; otherwise, your decrypted data will be sent to Workflowy servers: <br>- " + attentionNeeded.join("<br>- "), [], true, {type: c.POPUP_TYPES.MINI});
    }

    return new Response(JSON.stringify(responseData));
  }

  async postGetTreeData(url, responseData) {
    await toast.show("Loading...", "Decrypting nodes", url);
    let notArray = false;
    for (let data of responseData.items) {
      if (notArray || !Array.isArray(data)) {
        notArray = true;
        await util.processNewTreeData(data);
        continue;
      }

      for (let subData of data) {
        await util.processNewTreeData(subData);
      }
    }

    await toast.hide(url);
    return new Response(JSON.stringify(responseData));
  }

  async postGetInitializationData(responseData) {
    shared = [];
    for (let info of responseData.projectTreeData.auxiliaryProjectTreeInfos) {
      if (info.rootProject.id !== undefined) {
        let node = {
          [c.PROPERTIES.SHARE_ID]: info.shareId
        };

        if (info.rootProject.nm !== undefined) {
          info.rootProject.nm = await encrypter.decrypt(info.rootProject.nm);
          node[c.PROPERTIES.NAME] = info.rootProject.nm;
        }

        if (info.rootProject.no !== undefined) {
          info.rootProject.no = await encrypter.decrypt(info.rootProject.no);
          node[c.PROPERTIES.DESCRIPTION] = info.rootProject.no;
        }
        
        nodes.update(info.rootProject.id, node);
      }
      shared.push(info.shareId);
    }
    return new Response(JSON.stringify(responseData));
  }
}
const routes = new RouteHandler();

class FetchWrapper {
  /**
   * Modify and return request params
   */
  async onPreFetch(url, params) {
    if (bypassLock && !quarantine) {
      return params;
    }

    if (u.endpointMatches("/push_and_poll", "POST", url, params)) {
      return await routes.prePushAndPoll(params);
    }
    return params;
  }

  /**
   * Modify response body
   */
  async onPostFetch(url, params, response) {
    if (bypassLock && !quarantine) {
      return response;
    }

    let responseData = await response.clone().json();
    if (responseData.results && Array.isArray(responseData.results) && responseData.results.length > 0 && responseData.results[0].new_most_recent_operation_transaction_id) {
      mostRecentOperationTransactionId = responseData.results[0].new_most_recent_operation_transaction_id;
    }

    if (u.endpointMatches("/get_tree_data", "GET", url, params)) {
      return await routes.postGetTreeData(url, responseData);
    } else if (u.endpointMatches("/push_and_poll", "POST", url, params)) {
      return await routes.postPushAndPoll(responseData);
    } else if (u.endpointMatches("/get_initialization_data", "GET", url, params)) {
      return await routes.postGetInitializationData(responseData);
    }
    return response;
  }
}
const fetchWrapper = new FetchWrapper();

class Staller {
  static items = [];
  static ready = false;

  static addItem(resolve) {
    Staller.items.push(resolve);
  }

  waitUntilReady() {
    return new Promise(resolve => {
      if (Staller.ready) {
        return resolve();
      }
      Staller.addItem(resolve);
    });
  }

  ready() {
    Staller.ready = true;
    for (let resolve of Staller.items) {
      resolve();
    }
    Staller.items = [];
  }
}
const staller = new Staller();

// Fetch wrapper [https://stackoverflow.com/a/64961272]
window.fetch = async (...args) => {
  await staller.waitUntilReady();
  if (quarantine) {
    return;
  }
  
  let url = args[0];
  let params = args[1];

  params = await fetchWrapper.onPreFetch(url, params);
  if (quarantine) {
    return;
  }
  args[1] = params;
  
  const response = await origFetch(...args);

  return await fetchWrapper.onPostFetch(url, params, response);
};

(async () => {
  // Init
  await c.init();
  u.updateTheme();
  await gateway.setVar("theme", theme);
  toast.init();
  window.onfocus = focusTracker.onChange.bind(focusTracker);

  await encrypter.checkSecret();
  staller.ready();
})();