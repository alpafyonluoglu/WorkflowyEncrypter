const DOMAIN = "https://workflowy.com";
const LOCK_TAG = "#private";
const PRE_ENC_CHAR = "_";
var shared = []; // Share IDs

var trackedChanges = [];
var cacheClearPerformed = false;
var quarantine = false;
var theme = null;

var crosscheckUserId = "";
var clientId = "";
var clientVersion = "";
var wfBuildDate = "";
var mostRecentOperationTransactionId = "";

const {fetch: origFetch} = window;

const DEFAULT_SHARE_ID = 'DEFAULT';

const THEMES = {
  LIGHT: "light",
  DARK: "dark"
};

const PROPERTIES = {
  NAME: "name",
  DESCRIPTION: "description",
  LOCKED: "locked",
  PARENT: "parent",
  SHARE_ID: "shareId",
  LOCAL_ID: "localId"
};

const SENSITIVE_PROPERTIES = [
  PROPERTIES.NAME,
  PROPERTIES.DESCRIPTION
];

const FLAGS = {
  FORCE_DECRYPT: 0,
  SUPPRESS_WARNINGS: 1,
  NO_FETCH: 2,
  TRACK_ENCRYPTION_CHANGES: 3,
  IGNORE_NULL_PARENT: 4
};

const OUTCOMES = {
  IGNORE: -1,
  CANCEL: 0,
  PREV: 1,
  NEXT: 2,
  COMPLETE: 3,
  CUSTOM: 4
}

class BaseUtil {
  updateTheme() {
    var body = document.getElementsByTagName("body")[0];
    var bodyBgColor = window.getComputedStyle(body, null).getPropertyValue("background-color");
    theme = bodyBgColor === "rgb(42, 49, 53)" ? THEMES.DARK : THEMES.LIGHT;
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getInternalVar(key) {
    return document.getElementById("wfe-internal-" + key).getAttribute('value');
  }

  endpointMatches(path, method, url, params) {
    return url.includes(DOMAIN + path) && method === params.method;
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
u.updateTheme();

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
    let isSharedRoot = node[PROPERTIES.SHARE_ID] !== undefined;

    for (let property in properties) {
      if (properties[property] === undefined && node[property] !== undefined) {
        delete properties[property];
      }
    }

    if (isSharedRoot && !enforce) {
      delete properties[PROPERTIES.PARENT];
    }

    let updatedNode = {...node, ...properties};
    updatedNode[PROPERTIES.LOCKED] = (updatedNode[PROPERTIES.NAME] ?? "").includes(LOCK_TAG);

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
      return this.get(node[PROPERTIES.PARENT], property, recursiveCheck, ignored);
    }
    return undefined;
  }

  getShareId(id) {
    return this.get(id, PROPERTIES.SHARE_ID, true);
  }
  
  getParent(id) {
    return this.get(id, PROPERTIES.PARENT, false);
  }

  /**
   * Direct param is used to check the property of the node itself
   * Setting direct to false will check the property of the node's parents
   */
  isLocked(id, direct = false) {
    return this.get(id, PROPERTIES.LOCKED, !direct, [false]) ?? false;
  }

  hasChild(id) {
    return this.find(PROPERTIES.PARENT, id, true).length > 0;
  }

  getChildren(id) {
    return this.find(PROPERTIES.PARENT, id);
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
    let path = u.getInternalVar("htmlPopupContainer")
    return await this.readFile(path);
  }

  async getToastContainerHTML() {
    let path = u.getInternalVar("htmlToastContainer")
    return await this.readFile(path);
  }

  async getWelcomeCss() {
    let path = u.getInternalVar("cssWelcome")
    return await this.readFile(path);
  }

  async getWelcomeHtml(id, properties = {}) {
    let path = u.getInternalVar("htmlPopupWelcome" + id)
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
  PROCESSES = {}
  processActive = false; // If there is a toast message being shown

  async init() {
    document.body.insertAdjacentHTML("afterbegin", await components.getToastContainerHTML());
  }

  async show(title, text, relatedNodeId) {
    this.PROCESSES[relatedNodeId] = {
      title: title,
      text: text
    };
    if (!this.processActive) {
      // Create toast message
      this.processActive = true;
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
    }
  }

  async hide(relatedNodeId) {
    delete this.PROCESSES[relatedNodeId];

    if (this.PROCESSES.length === 0) {
      let title = this.PROCESSES[0].title;
      let text = this.PROCESSES[0].text;
      document.getElementById("_message").innerHTML = "<span><b>" + title + "</b> " + text + "</span>";
      return;
    }

    this.processActive = false;
    let toastElement = document.getElementById("_toast2");
    let height = toastElement.offsetHeight;
    toastElement.style.marginBottom = "-" + height + "px";
    await u.sleep(300);
    toastElement.style.visibility = "hidden";
    toastElement.style.transition = "all 0s";
  }
}
const toast = new Toast();
toast.init();

/**
 * Can be called by a single process at a time
 * Async popup with multiple pages
 * Call with await to block the execution until the popup is closed
 * args: {
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

      // Apply custom styles
      if (args.style) {
        var element = document.createElement('style');
        element.innerHTML = args.style;
        document.body.appendChild(element);
      }

      // Create popup
      document.body.insertAdjacentHTML("afterbegin", await components.getPopupContainerHTML());
      Popup.args.pageCount = args.pages.length;
      Popup.args.currentPage = 0;
      this.setPage(0);
      this.show();

      if (cancellable) {
        document.getElementById("_popup").addEventListener('click', function(evt) {
          if ( evt.target != this ) return false;
          Popup.onClick(null, OUTCOMES.CANCEL);
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
  }

  async hide(outcome = OUTCOMES.CANCEL) {
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
    const page = Popup.args.pages[pageIndex];

    const title = page["title"] ?? "";
    const text = page["text"] ?? "";
    const input = page["input"] ?? null;
    const buttons = page["buttons"] ?? [];
    const htmlList = page["html"] ?? [];
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

    var buttonsElement = document.createElement('div');
    buttonsElement.classList.add("_popup-buttons");
    buttonsElement.id = "_popup-buttons";
    content.appendChild(buttonsElement);
    
    if (buttons.length === 0) {
      buttons.push({
        outcome: (endOfPages ? OUTCOMES.COMPLETE : OUTCOMES.NEXT),
        text: (endOfPages ? "Close" : "Next"),
        focus: true
      })
    }

    for (let i = 0; i < buttons.length; i++) {
      const buttonData = buttons[i];

      var buttonElement = document.createElement('button');
      buttonElement.classList.add("_popup-button");
      buttonElement.id = "_popup-button" + i;
      buttonElement.type = "button";
      buttonElement.setAttribute("data-id", i);
      buttonElement.innerHTML = buttonData.text;
      buttonElement.onclick = () => {
        Popup.onClick(i, buttonData.outcome);
      };
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
    if (outcome === OUTCOMES.CUSTOM) {
      outcome = (await Popup.args.pages[currentPage].buttons[id].onClick() ?? outcome);
    }

    switch (outcome) {
      case OUTCOMES.PREV:
        popup.setPage(currentPage - 1);
        break;
      case OUTCOMES.NEXT:
        popup.setPage(currentPage + 1);
        break;
      case OUTCOMES.CANCEL:
      case OUTCOMES.COMPLETE:
        popup.hide(outcome);
        break;
      default:
      case OUTCOMES.IGNORE:
        return;
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
              logo_url: u.getInternalVar("logoUrl"),
              logo_w_url: u.getInternalVar("logoWUrl")
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
              text2.textContent = PRE_ENC_CHAR + u.randomStr(15 - PRE_ENC_CHAR.length);
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
          text: "Register your key that will be used to encrypt your data. If this is your first time here, just enter a new key and make sure to note it down. <b>It will be impossible to recover your encrypted data if you forget your key.</b>",
          input: {
            label: "Key",
            placeholder: "secret"
          },
          buttons: [{
            outcome: OUTCOMES.CUSTOM,
            text: "Next",
            focus: true,
            onClick: async function() {
              let key = document.getElementById("_input-box").value;
              if (key.replaceAll(" ", "").length === 0) {
                toast.show("Key cannot be empty.", "Provide a valid key and try again.", "KEY");
                await u.sleep(3000);
                toast.hide("KEY");
                return OUTCOMES.IGNORE;
              } else {
                window.localStorage.setItem("lockSecret", key);
                return OUTCOMES.NEXT;
              }
            }
          }],
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(2, {
              key_url: u.getInternalVar("keyUrl")
            })
          }]
        },
        {
          title: "Use Your Key",
          text: "Now that your key is ready, you can use it seamlessly just by adding a " + LOCK_TAG + " tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically.",
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(3, {
              ss1_url: u.getInternalVar("ss1Url")
            })
          }]
        },
        {
          title: "That's It!",
          text: "Encrypted nodes will be readable only from web browsers that have Workflowy Encrypter installed. Try to use a different device or disable the extension temporarily to see the magic!",
          html: [{
            position: "afterbegin",
            content: await components.getWelcomeHtml(4, {
              logo_url: u.getInternalVar("logoUrl"),
              logo_w_url: u.getInternalVar("logoWUrl")
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
}
const popupHelper = new PopupHelper();

class API {
  // Tree-related part is for fetching the most up-to-date tree data, which is no longer
  // needed as a copy of the whole tree is always tracked and kept in the memory

  // TREE = {};

  // async loadTree() {
  //   this.removeTree();
    
  //   await this.loadSpecificTree("/get_tree_data/");
  //   for (let shareId of shared) {
  //     await this.loadSpecificTree("/get_tree_data/?share_id=" + shareId);
  //   }
  // }

  // async loadSpecificTree(path) {
  //   const treeDataRaw = await origFetch(DOMAIN + path);
  //   const treeData = await treeDataRaw.json();

  //   let notArray = false;
  //   for (let data of treeData.items) {
  //     if (notArray || !Array.isArray(data)) {
  //       notArray = true;
  //       await this.addNodeToParsedData(this.TREE, data);
  //       continue;
  //     }

  //     for (let subData of data) {
  //       await this.addNodeToParsedData(this.TREE, subData);
  //     }
  //   }
  // }

  // async addNodeToParsedData(parsedData, item) {
  //   let id = item.id;
  //   parsedData[id] = {};
  //     if (item.nm !== undefined) {
  //       parsedData[id].name = await encrypter.decrypt(item.nm);
  //     }
  //     if (item.no !== undefined) {
  //       parsedData[id].description = await encrypter.decrypt(item.no);
  //     }
  // }

  // async removeTree() {
  //   this.TREE = {};
  // }

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
      if (shareId !== DEFAULT_SHARE_ID) {
        pushPollDataInstance.share_id = shareId;
      }
      rawBody.push_poll_data.push(pushPollDataInstance);
      
      mostRecentOperationTransactionId++; // Find whether increment is needed
    }

    let body = await util.decodeBody(rawBody);
    let response = await origFetch(DOMAIN + "/push_and_poll", {
      method: 'POST',
      credentials: "same-origin",
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Wf_build_date': wfBuildDate
      },
      body: body,
      url: DOMAIN + "/push_and_poll"
    });
  }
}
const api = new API();

class Cache {
  get(key, defVal = null) {
    let cacheData = window.localStorage.getItem("lockCache");
    cacheData = cacheData ? JSON.parse(cacheData) : {};
    return cacheData[key] ? cacheData[key].val : defVal; 
  }

  set(key, val) {
    let cacheData = window.localStorage.getItem("lockCache");
    cacheData = (cacheData !== null && cacheData !== undefined) ? JSON.parse(cacheData) : {};
    cacheData[key] = {
      val: val,
      lastAccessed: Date.now()
    };
    window.localStorage.setItem("lockCache", JSON.stringify(cacheData));
  }

  clear(light = true) {
    if (!light) {
      window.localStorage.setItem("lockCache", undefined);
      return;
    }

    let cacheData = window.localStorage.getItem("lockCache");
    cacheData = (cacheData !== null && cacheData !== undefined) ? JSON.parse(cacheData) : {};

    let now = Date.now();
    let lifeDuration = 1000 * 60 * 60 * 24 * 7; // 1 week
    for (let key in cacheData) {
      if (now - cacheData[key].lastAccessed > lifeDuration) {
        delete cacheData[key];
      }
    }

    window.localStorage.setItem("lockCache", JSON.stringify(cacheData));
  }
}
const cache = new Cache();

class Encrypter {
  SECRET;
  enc;
  dec;

  constructor() {
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
  }

  async loadSecret() {
    let secret = window.localStorage.getItem("lockSecret");
    if (!secret || secret === null | secret === "null" || secret === "") {
      await popupHelper.welcome();
      window.onbeforeunload = null;
      location.reload();
    }
    this.SECRET = secret;
  }

  async encrypt(data) {
    if (!this.SECRET || this.SECRET === null | this.SECRET === "null" || this.SECRET === "") {
      return data;
    }
    const encryptedData = await this.encryptData(data, this.SECRET);
    cache.set(PRE_ENC_CHAR + encryptedData, data);
    return PRE_ENC_CHAR + encryptedData;
  }
  
  async decrypt(data) {
    if (!data.startsWith(PRE_ENC_CHAR)) {
      return data;
    } else if (!this.SECRET || this.SECRET === null | this.SECRET === "null" || this.SECRET === "") {
      return data;
    }

    let cachedDecryptedData = cache.get(data, null);
    if (cachedDecryptedData !== null) {
      return cachedDecryptedData;
    }

    let origData = data;
    data = data.substring(PRE_ENC_CHAR.length);
    const decryptedData = await this.decryptData(data, this.SECRET);
    cache.set(origData, decryptedData);
    return decryptedData || data;
  }

  // Encryption helper functions [https://github.com/bradyjoslin/webcrypto-example]
  buff_to_base64 = (buff) => btoa(
    new Uint8Array(buff).reduce(
      (data, byte) => data + String.fromCharCode(byte), ''
    )
  );

  base64_to_buf = (b64) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(null));

  getPasswordKey = (password) =>
    window.crypto.subtle.importKey("raw", this.enc.encode(password), "PBKDF2", false, [
      "deriveKey",
    ]);

  deriveKey = (passwordKey, salt, keyUsage) =>
    window.crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: salt,
        iterations: 250000,
        hash: "SHA-256",
      },
      passwordKey,
      { name: "AES-GCM", length: 256 },
      false,
      keyUsage
    );

  async encryptData(secretData, password) {
    try {
      const salt = window.crypto.getRandomValues(new Uint8Array(16));
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const passwordKey = await this.getPasswordKey(password);
      const aesKey = await this.deriveKey(passwordKey, salt, ["encrypt"]);
      const encryptedContent = await window.crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        aesKey,
        this.enc.encode(secretData)
      );

      const encryptedContentArr = new Uint8Array(encryptedContent);
      let buff = new Uint8Array(
        salt.byteLength + iv.byteLength + encryptedContentArr.byteLength
      );
      buff.set(salt, 0);
      buff.set(iv, salt.byteLength);
      buff.set(encryptedContentArr, salt.byteLength + iv.byteLength);
      const base64Buff = this.buff_to_base64(buff);
      return base64Buff;
    } catch (e) {
      console.warn(`[Workflowy Encrypter] Encryption error`, e);
      return "";
    }
  }

  async decryptData(encryptedData, password) {
    try {
      const encryptedDataBuff = this.base64_to_buf(encryptedData);
      const salt = encryptedDataBuff.slice(0, 16);
      const iv = encryptedDataBuff.slice(16, 16 + 12);
      const data = encryptedDataBuff.slice(16 + 12);
      const passwordKey = await this.getPasswordKey(password);
      const aesKey = await this.deriveKey(passwordKey, salt, ["decrypt"]);
      const decryptedContent = await window.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv,
        },
        aesKey,
        data
      );
      return this.dec.decode(decryptedContent);
    } catch (e) {
      console.warn(`[Workflowy Encrypter] Encryption error`, e);
      return "";
    }
  }
}
const encrypter = new Encrypter();
encrypter.loadSecret();

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
    properties[PROPERTIES.PARENT] = data.prnt;
    if (data.nm !== undefined) {
      data.nm = await encrypter.decrypt(data.nm);
      properties[PROPERTIES.NAME] = data.nm;
    }
    if (data.no !== undefined) {
      data.no = await encrypter.decrypt(data.no);
      properties[PROPERTIES.DESCRIPTION] = data.no;
    }

    if (data.as) {
      properties[PROPERTIES.LOCAL_ID] = data.id;
      id = nodes.find(PROPERTIES.SHARE_ID, data.as, true)[0] ?? id;
      enforce = true; // Enforce parent
    }

    nodes.update(id, properties, enforce);
  }

  // decodeVal(val) {
  //   if (!u.isString(val)) {
  //     val = JSON.stringify(val);
  //   }
  //   val = encodeURIComponent(val).replaceAll("%20", "+");
  //   return val;
  // }

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
      let flags = [FLAGS.SUPPRESS_WARNINGS, FLAGS.NO_FETCH, FLAGS.TRACK_ENCRYPTION_CHANGES];
      if (shareId !== null) {
        flags.push(FLAGS.IGNORE_NULL_PARENT);
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
      result = await util.processDataObjects(dataObj, [FLAGS.FORCE_DECRYPT]);
      result = await util.processDataToStringify(stringifyJson);

      for (let changed of trackedChanges) {
        let id = changed["id"];
        let data = trackedChangeData[id] ?? {};
        data["final"] = nodes.isLocked(id);
        data["name"] = nodes.get(id, PROPERTIES.NAME);
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
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : (flags.includes(FLAGS.IGNORE_NULL_PARENT) ? undefined : null);
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
      obj.properties[PROPERTIES.PARENT] = parent;

      if (project.nm) {
        obj.process.push({
          node: project,
          contentTag: "nm"
        });
        obj.properties[PROPERTIES.NAME] = project.nm;
      }
      if (project.no) {
        obj.process.push({
          node: project,
          contentTag: "no"
        });
        obj.properties[PROPERTIES.DESCRIPTION] = project.no;
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
      obj.properties[PROPERTIES.DESCRIPTION] = operation.data["description"];
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
      obj.properties[PROPERTIES.NAME] = operation.data["name"];
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
      if (!nodes.isLocked(id) && name.includes(LOCK_TAG) && nodes.hasChild(id)) { // Encryption added
        if (flags.includes(FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        await this.updateChildNodeEncryption(id, true, false, flags);
      } else if (nodes.isLocked(id, true) && !nodes.isLocked(nodes.getParent(id)) && !name.includes(LOCK_TAG) && nodes.hasChild(id)) { // Encryption removed
        if (flags.includes(FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        if (
          flags.includes(FLAGS.SUPPRESS_WARNINGS)
          || (await popup.create(
            "Confirm Decryption",
            "Are you sure you want to remove the " + LOCK_TAG + " tag and decrypt all child nodes? This will send decrypted content to Workflowy servers.",
            [
              {
                text: "Cancel",
                outcome: OUTCOMES.CANCEL
              },
              {
                text: "Decrypt",
                outcome: OUTCOMES.COMPLETE,
                focus: true
              }
            ], true)) === OUTCOMES.COMPLETE
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
      if (flags.includes(FLAGS.NO_FETCH)) {
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

      let name = nodes.get(id, PROPERTIES.NAME);
      if (name !== undefined) {
        operation.data.name = encrypt ? await encrypter.encrypt(name) : name;
        operation.undo_data.previous_name = encrypt ? await encrypter.encrypt(name) : name;
      }

      let description = nodes.get(id, PROPERTIES.DESCRIPTION);
      if (description !== undefined) {
        operation.data.description = encrypt ? await encrypter.encrypt(description) : description;
        operation.undo_data.previous_description = encrypt ? await encrypter.encrypt(description) : description;
      }

      let branch = nodes.getShareId(id) === undefined ? DEFAULT_SHARE_ID : nodes.getShareId(id);
      let operationsBranch = operations[branch] ?? [];
      operationsBranch.push(operation);
      operations[branch] = operationsBranch;
    }
  }

  async processMoveOperation(operation, dataObj, flags = []) {
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : (flags.includes(FLAGS.IGNORE_NULL_PARENT) ? undefined : null);
    let ids = JSON.parse(operation.data.projectids_json);
    let decryptionAllowed = false;
    for (let id of ids) {
      let obj = {
        id: id,
        properties: {}
      }
      obj.properties[PROPERTIES.PARENT] = parent;
      dataObj.push(obj);

      // Process child nodes if exists
      if (nodes.isLocked(parent) && !nodes.isLocked(id)) { // Encryption added
        if (flags.includes(FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        await this.updateChildNodeEncryption(id, true, true, flags);
      } else if (!nodes.isLocked(parent) && nodes.isLocked(nodes.getParent(id))) { // Encryption removed
        if (flags.includes(FLAGS.TRACK_ENCRYPTION_CHANGES)) {
          trackedChanges.push({
            id: id
          });
        }

        if (
          flags.includes(FLAGS.SUPPRESS_WARNINGS)
          || decryptionAllowed
          || (await popup.create(
            "Confirm Decryption",
            "Are you sure you want to move selected node(s) under a non-encrypted node and decrypt their data? This will send decrypted content to Workflowy servers.",
            [
              {
                text: "Cancel",
                outcome: OUTCOMES.CANCEL
              },
              {
                text: "Decrypt",
                outcome: OUTCOMES.COMPLETE,
                focus: true
              }
            ], true)) === OUTCOMES.COMPLETE
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
        if (flags.includes(FLAGS.FORCE_DECRYPT)) {
          for (let property in data["properties"]) {
            if (SENSITIVE_PROPERTIES.includes(property)) {
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

          if (flags.includes(FLAGS.FORCE_DECRYPT)) {
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
        name: nodes.get(nodeId, PROPERTIES.NAME),
        description: nodes.get(nodeId, PROPERTIES.DESCRIPTION),
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
      cache.clear();
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
    if (attentionNeeded.length > 0) {
      await popup.create("Heads Up!", LOCK_TAG + " tag is removed from the following node(s) via a remote session. Add the tag again to keep your data protected; otherwise, your decrypted data will be sent to Workflowy servers: <br>- " + attentionNeeded.join("<br>- "), [], true);
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
          [PROPERTIES.SHARE_ID]: info.shareId
        };

        if (info.rootProject.nm !== undefined) {
          info.rootProject.nm = await encrypter.decrypt(info.rootProject.nm);
          node[PROPERTIES.NAME] = info.rootProject.nm;
        }

        if (info.rootProject.no !== undefined) {
          info.rootProject.no = await encrypter.decrypt(info.rootProject.no);
          node[PROPERTIES.DESCRIPTION] = info.rootProject.no;
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
      return await routes.prePushAndPoll(params);
    }
    return params;
  }

  /**
   * Modify response body
   */
  async onPostFetch(url, params, response) {
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

// Fetch wrapper [https://stackoverflow.com/a/64961272]
window.fetch = async (...args) => {
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
