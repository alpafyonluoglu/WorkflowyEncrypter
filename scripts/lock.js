var shared = []; // Share IDs
var trackedChanges = [];
var quarantine = false;
var sessionKeyId = null;
var migrationState = { state: "pending" };
var cryptoFailure = false;
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
    try {
      const target = new URL(url, location.href);
      return target.origin === c.DOMAIN && target.pathname === path && method === (params?.method ?? 'GET').toUpperCase();
    } catch { return false; }
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

  sanitize(str) {
    // Escape a string so it is safe to embed inside HTML markup
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The extension did not respond. Retry without discarding unsaved edits.')), 30000);
      try {
        chrome.runtime.sendMessage(c.EXTENSION_ID, { func, params }, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !response || typeof response.ok !== 'boolean') {
            reject(new Error('The extension connection was lost. Reload only after preserving unsaved edits.'));
          } else if (!response.ok) {
            const error = new Error(response.error?.message || 'The extension could not complete this operation.');
            error.code = response.error?.code;
            reject(error);
          } else resolve(response.value);
        });
      } catch {
        clearTimeout(timer);
        reject(new Error('The extension connection is unavailable.'));
      }
    });
  }
}
const gateway = new ExtensionGateway();

class Constants {
  EXTENSION_ID = undefined;
  LOCK_TAG = "#private";
  PRE_ENC_CHAR = "_";
  THEMES = { LIGHT: "light", DARK: "dark" };
  ACTIONS = { SET_KEY: "setLockKey", MOVE_KEY: "migrateLockKey", WELCOME: "welcome" };
  RELOAD_REASONS = { UPDATE: "extensionUpdate", KEY_CHANGE: "keyChange", TAG_CHANGE: "tagChange" };
  DOMAIN = new URL(location.href).origin;
  DEFAULT_SHARE_ID = 'DEFAULT';
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
    const deadline = Date.now() + 30000;
    while (!document.getElementById('wfe-internal-extensionId')) {
      if (Date.now() >= deadline) throw new Error('The extension did not start.');
      await u.sleep(25);
    }
    this.EXTENSION_ID = u.getInternalVar('extensionId');
    // Constants are non-secret and local; only user-configured tag needs RPC.
    const tag = await gateway.getLockTag();
    if (typeof tag !== 'string' || !tag) throw new Error('Invalid encryption tag.');
    Object.defineProperty(this, 'LOCK_TAG', { value: tag });
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
      await popup.open({
        style: await components.getWelcomeCss(),
        cancellable: false,
        pages: [
          new PopupPage(popupTitle, popupText)
            .addButton(new PopupButton("Reload", Popup.OUTCOMES.COMPLETE))
            .addHtml("afterbegin", await components.getWelcomeHtml(2, {
              key_url: await gateway.getResUrl('/src/logo_128.png')
            }))
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

  assertKnownAncestry(id) {
    const seen = new Set();
    while (id !== null && id !== 'None') {
      if (typeof id !== 'string' || seen.has(id) || !Object.prototype.hasOwnProperty.call(this.NODES, id))
        throw new Error('The encryption ancestry is not fully loaded. Preserve unsaved edits and reload before editing this node.');
      seen.add(id);
      const node = this.NODES[id];
      if (node[c.PROPERTIES.SHARE_ID] !== undefined) return; // Explicit shared root.
      if (!Object.prototype.hasOwnProperty.call(node, c.PROPERTIES.PARENT))
        throw new Error('The encryption ancestry is not fully loaded. Preserve unsaved edits and reload.');
      id = node[c.PROPERTIES.PARENT];
    }
  }

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
  async getToastContainerHTML() {
    let path = await gateway.getResUrl('/layouts/toast_container.html');
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

  setMessage(title, text) {
    const container = document.getElementById("_message");
    container.replaceChildren();
    const span = document.createElement('span');
    const bold = document.createElement('b');
    bold.textContent = title;
    span.appendChild(bold);
    span.appendChild(document.createTextNode(' ' + text));
    container.appendChild(span);
  }

  async show(title, text, relatedNodeId) {
    if (!document.getElementById('_message')) return;
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
        toast.setMessage(title, text);

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
    if (!document.getElementById('_message')) return;
    delete Toast.PROCESSES[relatedNodeId];

    if (Object.values(Toast.PROCESSES).length > 0) {
      let process = Object.values(Toast.PROCESSES)[0];
      let title = process.title;
      let text = process.text;
      toast.setMessage(title, text);
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

class PopupHelper {
  async welcome() {
    await u.sleep(2000);
    return await popup.open({
      style: await components.getWelcomeCss(),
      cancellable: false,
      pages: [
        new PopupPage(
          "Let's Secure Your Data",
          "Welcome to Workflowy Encrypter! To enable seamless client-side encryption, follow this brief setup and let us help you secure your data."
        )
          .addHtml("afterbegin", await components.getWelcomeHtml(1, {
            logo_url: await gateway.getResUrl('/src/logo_128.png'),
            logo_w_url: await gateway.getResUrl('/src/logo_w_128.png')
          }))
          .setScript(() => {
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
          }),

        new PopupPage(
          "Craft Your Key",
          "Use the button below to open a secure area where you can safely register your key to be used for encryption. This will open a new tab."
        )
          .addButton(new PopupButton("Set key", Popup.OUTCOMES.CUSTOM).setOnClick(async function() {
            let button = document.getElementById("_popup-button0");
            let loader = document.getElementById("_loader");
            let text = document.getElementById("_popup-text");
            let buttonAction = button.getAttribute("data-action") ?? "registerKey";
            let checkSecretAction = async () => {
              // Ignore broadcasted actions
              broadcastCheckTime = new Date().getTime();

              if (await gateway.isSecretLoaded(true)) {
                focusTracker.clearAction();

                loader.style.display = "none";
                text.textContent = "Great, you have successfully registered your key.";
                button.textContent = "Next";
                button.setAttribute("data-action", "next");
              }
            };

            switch (buttonAction) {
              case "registerKey":
                await gateway.openOptionsPage(c.ACTIONS.SET_KEY);

                focusTracker.setAction(checkSecretAction);

                loader.style.display = "block";
                const fallbackLink = document.createElement('a');
                fallbackLink.style.cursor = 'pointer';
                fallbackLink.appendChild(Object.assign(document.createElement('b'), { textContent: 'click here' }));
                fallbackLink.addEventListener('click', () => gateway.openOptionsPage(c.ACTIONS.SET_KEY));
                text.replaceChildren(
                  document.createTextNode("The setup will continue once you have registered your key. If the tab didn't open, "),
                  fallbackLink,
                  document.createTextNode(" or navigate to the extension's options page.")
                );
                button.textContent = "Check key";
                button.setAttribute("data-action", "checkKey");

                return Popup.OUTCOMES.IGNORE;
              case "checkKey":
                if (await gateway.isSecretLoaded()) {
                  await checkSecretAction();
                  return Popup.OUTCOMES.IGNORE;
                } else {
                  toast.show("Key not set", "Register a key to continue", "KEY");
                  await u.sleep(3000);
                  toast.hide("KEY");
                  return Popup.OUTCOMES.IGNORE;
                }
              case "next":
                return Popup.OUTCOMES.NEXT;
            }
          }))
          .addHtml("afterbegin", await components.getWelcomeHtml(2, {
            key_url: await gateway.getResUrl('/src/key_128.png')
          }))
          .addHtml("beforebuttons", await components.getWelcomeHtml("2_loader")),

        new PopupPage(
          "Use Your Key",
          "Now that your key is ready, you can use it seamlessly just by adding a " + c.LOCK_TAG + " tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically."
        )
          .addHtml("afterbegin", await components.getWelcomeHtml(3, {
            ss1_url: theme === c.THEMES.LIGHT ? (await gateway.getResUrl('/src/ss1.png')) : (await gateway.getResUrl('/src/ss1_dark.png'))
          })),

        new PopupPage(
          "That's It!",
          "Encrypted nodes will be readable only from web browsers that have Workflowy Encrypter installed. Try to use a different device or disable the extension temporarily to see the magic!"
        )
          .addHtml("afterbegin", await components.getWelcomeHtml(4, {
            logo_url: await gateway.getResUrl('/src/logo_128.png'),
            logo_w_url: await gateway.getResUrl('/src/logo_w_128.png')
          }))
          .setScript(() => {
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
          })
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
    await encrypter.assertWritable();
    let response = await guardedFetch(c.DOMAIN + "/push_and_poll", {
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
    if (!response.ok) {
      cryptoFailure = true;
      encrypter.showStatus();
      throw new Error('The descendant update was not confirmed. Further writes are paused.');
    }
    return response;
  }
}
const api = new API();

class Encrypter {
  updateState() {
    try {
      const raw = document.getElementById('wfe-internal-extensionId')?.getAttribute('data-key-state');
      if (raw) migrationState = JSON.parse(raw);
      if (migrationState.state === 'ready') {
        if (sessionKeyId && sessionKeyId !== migrationState.keyId) cryptoFailure = true;
        if (!sessionKeyId) sessionKeyId = migrationState.keyId;
      }
    } catch { migrationState = { state: 'error' }; }
    this.showStatus();
  }

  showStatus() {
    if (!document.body) return;
    let banner = document.getElementById('wfe-key-status');
    if (migrationState.state === 'ready' && !migrationState.cleanupPending && !migrationState.recoveryPending && !cryptoFailure) {
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'wfe-key-status';
      banner.setAttribute('role', 'status');
      Object.assign(banner.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '2147483647', padding: '12px', background: '#302720', color: '#fff', font: '14px sans-serif' });
      document.body.appendChild(banner);
    }
    let message = cryptoFailure
      ? 'Encryption needs attention. Writes are paused because some text could not be decrypted or your key changed. Preserve unsaved edits, check your key, then reload.'
      : migrationState.recoveryPending
        ? 'Legacy recovery data remains in website storage without its original key. Keep it for recovery; automatic cleanup is paused. Check your saved recovery key before removing any website data.'
      : migrationState.state === 'ready' && migrationState.cleanupPending
        ? 'Your key was copied and verified in the extension. Cleanup is still pending: the old page key remains accessible until you finish migration in extension settings.'
        : 'Encryption is not ready. You can view Workflowy, but writes are paused to protect your data. Check extension settings, then retry.';
    banner.replaceChildren(document.createTextNode(message + ' '));
    const options = document.createElement('button');
    options.textContent = migrationState.cleanupPending ? 'Finish migration' : 'Extension settings';
    options.onclick = () => gateway.openOptionsPage(migrationState.cleanupPending ? c.ACTIONS.MOVE_KEY : c.ACTIONS.SET_KEY).catch(() => {});
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = () => window.dispatchEvent(new Event('wfe-retry-migration'));
    banner.append(options, retry);
  }

  async assertWritable() {
    this.updateState();
    if (cryptoFailure || migrationState.state !== 'ready' || !sessionKeyId)
      throw new Error('Writes are paused until your encryption key is available. Preserve unsaved edits and use the encryption status banner.');
    await gateway.assertSession(sessionKeyId);
  }

  async encrypt(data) {
    await this.assertWritable();
    const result = await gateway.encrypt(data, sessionKeyId);
    if (typeof result !== 'string' || !result.startsWith('_') || result.length < 61)
      throw new Error('Encryption did not return valid ciphertext. Nothing was sent.');
    return result;
  }

  async decrypt(data) {
    if (typeof data !== 'string' || !data.startsWith('_')) return data;
    try {
      if (migrationState.state !== 'ready' || !sessionKeyId) throw new Error('Key unavailable');
      const result = await gateway.decrypt(data, sessionKeyId);
      if (typeof result !== 'string') throw new Error('Invalid decrypted text');
      return result; // The empty string is a valid decrypted value.
    } catch {
      cryptoFailure = true;
      this.showStatus();
      return data; // Byte-for-byte preservation, including the encryption marker.
    }
  }

  async checkSecret() {
    const deadline = Date.now() + 30000;
    do {
      this.updateState();
      if (migrationState.state !== 'pending') return;
      await u.sleep(25);
    } while (Date.now() < deadline);
    migrationState = { state: 'error' };
    this.showStatus();
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
    if (!flags.includes(c.FLAGS.NO_FETCH)) {
      const textOperations = ['edit', 'bulk_create', 'bulk_move'];
      const simpleOperations = ['delete', 'complete', 'uncomplete', 'collapse', 'expand'];
      if (!textOperations.includes(operation.type) && !simpleOperations.includes(operation.type))
        throw new Error('An unsupported Workflowy operation was paused to protect your data.');
      if (operation.type === 'edit') nodes.assertKnownAncestry(operation.data.projectid);
      if (operation.type === 'bulk_create' || operation.type === 'bulk_move')
        nodes.assertKnownAncestry(operation.data.parentid === 'None' ? null : operation.data.parentid);
      if (operation.type === 'bulk_move')
        for (const id of JSON.parse(operation.data.projectids_json)) nodes.assertKnownAncestry(id);
      if (simpleOperations.includes(operation.type)) {
        const containsText = value => value && typeof value === 'object' && Object.entries(value).some(([key, child]) =>
          ['name', 'description', 'nm', 'no', 'previous_name', 'previous_description', 'project_trees'].includes(key) || containsText(child));
        if (containsText(operation)) throw new Error('Unexpected text in a Workflowy operation was paused to protect your data.');
      }
    }
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

      if (typeof project.nm === "string") {
        obj.process.push({
          node: project,
          contentTag: "nm"
        });
        obj.properties[c.PROPERTIES.NAME] = project.nm;
      }
      if (typeof project.no === "string") {
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
          || (await popup.open(PopupTemplates.confirm(
              "Confirm decryption",
              "Are you sure you want to remove the " + c.LOCK_TAG + " tag and decrypt all child nodes? This will send decrypted content to Workflowy servers.",
              "Decrypt"
            ))) === Popup.OUTCOMES.COMPLETE
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
          || (await popup.open(PopupTemplates.confirm(
              "Confirm decryption",
              "Are you sure you want to move selected node(s) under a non-encrypted node and decrypt their data? This will send decrypted content to Workflowy servers.",
              "Decrypt"
            ))) === Popup.OUTCOMES.COMPLETE
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
          } else if (nodes.isLocked(nodes.getParent(id)) && node && contentTag && u.isString(node[contentTag])) {
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
    wfBuildDate = params.headers.wf_build_date;
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
    if (attentionNeeded.length > 0 && (await gateway.isSecretLoaded())) {
      const safeNodeList =
        '<ul style="margin: 6px 0 0 16px; padding: 0; list-style: disc;">' +
        attentionNeeded.map(n => '<li>' + u.sanitize(n) + '</li>').join('') +
        '</ul>';
      await popup.open({
        type: Popup.TYPES.MINI,
        pages: [
          new PopupPage(
            "Heads Up!",
            c.LOCK_TAG + " tag is removed from the following node(s) via a remote session. Add the tag again to keep your data protected; otherwise, your decrypted data will be sent to Workflowy servers:"
          )
            .addHtml("beforebuttons", safeNodeList)
        ]
      });
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
    if (u.endpointMatches("/push_and_poll", "POST", url, params)) {
      const body = await util.encodeBody(params.body);
      const writes = body.push_poll_data.some(batch => Array.isArray(batch.operations) && batch.operations.length > 0);
      if (writes) await encrypter.assertWritable();
      return await routes.prePushAndPoll(params);
    }
    return params;
  }

  /**
   * Modify response body
   */
  async onPostFetch(url, params, response) {
    const intercepted = ['/get_tree_data', '/push_and_poll', '/get_initialization_data'].some(path => {
      try { return new URL(url, location.href).origin === c.DOMAIN && new URL(url, location.href).pathname === path; } catch { return false; }
    });
    if (!intercepted || !response.ok) return response;
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

// Serialize the relevant request + response lifecycle. Classifying a child while
// another request is changing its parent's lock state could otherwise leak plaintext.
let fetchTail = Promise.resolve();
function queueFetch(work) {
  const result = fetchTail.then(work);
  fetchTail = result.catch(() => {});
  return result;
}
async function guardedFetch(input, init) {
  const controller = new AbortController();
  const original = input instanceof Request ? input.signal : init?.signal;
  const abort = () => controller.abort(original.reason);
  if (original?.aborted) abort();
  else original?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('The request timed out. Preserve unsaved edits.')), 30000);
  try {
    const response = input instanceof Request
      ? await origFetch(new Request(input, { signal: controller.signal, referrer: input.referrer, referrerPolicy: input.referrerPolicy }))
      : await origFetch(input, { ...init, signal: controller.signal });
    // Bound response-body stalls as well as connection/header stalls. These endpoints
    // already require a complete JSON body before their contents can be processed.
    if (response.ok) await response.clone().arrayBuffer();
    return response;
  } finally {
    clearTimeout(timeout);
    // Keep the original abort link for consumers still reading the returned body.
    // The once-only listener and its controller are collected with the request signal.
  }
}

// Install synchronously at document_start, before Workflowy's own scripts capture fetch.
window.fetch = async (input, init) => {
  const request = input instanceof Request
    ? new Request(input.clone(), { referrer: input.referrer, referrerPolicy: input.referrerPolicy, ...init })
    : new Request(input, init);
  const url = request.url;
  const relevant = new URL(url).origin === c.DOMAIN &&
    ['/push_and_poll', '/get_tree_data', '/get_initialization_data'].includes(new URL(url).pathname);
  if (!relevant) return origFetch(input, init);
  return queueFetch(async () => {
    await staller.waitUntilReady();
    if (quarantine) throw new Error('Writes paused. Preserve unsaved edits before reloading.');
    const params = {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().text()
    };
    let processed;
    try {
      processed = await fetchWrapper.onPreFetch(url, params);
      if (processed === false || quarantine) throw new Error('The operation was cancelled.');
      if (u.endpointMatches('/push_and_poll', 'POST', url, params)) {
        const body = await util.encodeBody(params.body);
        if (body.push_poll_data.some(batch => Array.isArray(batch.operations) && batch.operations.length > 0))
          await encrypter.assertWritable(); // Whole-request barrier after all fields have been encrypted.
      }
    } catch (error) {
      cryptoFailure = true; // Node tracking may already have changed; reload a verified tree before retrying writes.
      encrypter.showStatus();
      throw error; // No native fetch, no plaintext fallback, and caller's original request remains intact.
    }
    const hasWrites = request.method !== 'GET' && request.method !== 'HEAD' &&
      (await util.encodeBody(params.body)).push_poll_data.some(batch => Array.isArray(batch.operations) && batch.operations.length > 0);
    let response;
    try {
      response = await guardedFetch(new Request(request, { referrer: request.referrer, referrerPolicy: request.referrerPolicy, ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: processed.body }) }));
      if (hasWrites && !response.ok) {
        cryptoFailure = true;
        encrypter.showStatus();
      }
    } catch (error) {
      if (hasWrites) { cryptoFailure = true; encrypter.showStatus(); }
      throw error;
    }
    try {
      const result = await fetchWrapper.onPostFetch(url, params, response);
      if (result === response) return response;
      const headers = new Headers(response.headers);
      headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(await result.text(), { status: response.status, statusText: response.statusText, headers });
    } catch {
      cryptoFailure = true;
      encrypter.showStatus();
      return response; // Keep the original server body and block writes if decoding failed.
    }
  });
};

// Popup instance is created here because it depends on gateway and theme (initialized in c.init)
var popup = null;

window.addEventListener('wfe-key-state', () => encrypter.updateState());
document.addEventListener('DOMContentLoaded', () => encrypter.showStatus());
function initializeUI() {
  u.updateTheme();
  popup = new Popup({
    resourceLoader: async path => (await origFetch(await gateway.getResUrl(path))).text(),
    isDarkTheme: () => theme === c.THEMES.DARK,
    onBeforeOpen: () => u.updateTheme()
  });
  popup.preload().catch(() => {});
  toast.init().catch(() => {});
  const style = document.createElement('link');
  style.rel = 'stylesheet';
  gateway.getResUrl('/styles/toast.css').then(url => { style.href = url; document.head.appendChild(style); }).catch(() => {});
  window.addEventListener('focus', () => focusTracker.onChange().catch(() => encrypter.showStatus()));
  encrypter.showStatus();
}
(async () => {
  try {
    await c.init();
    await encrypter.checkSecret();
    if (document.body) initializeUI();
    else document.addEventListener('DOMContentLoaded', initializeUI, { once: true });
  } catch {
    migrationState = { state: 'error' };
    encrypter.showStatus();
  } finally {
    // Do not wait for DOMContentLoaded: module scripts can themselves be awaiting fetch.
    staller.ready();
  }
})();
