const DOMAIN = "https://workflowy.com";
const LOCK_TAG = "#private";
const PRE_ENC_CHAR = "_";
var shared = [];
var crosscheckUserId = "";
var clientId = "";
var clientVersion = "";
var wfBuildDate = "";
var mostRecentOperationTransactionId = "";
var cacheClearPerformed = false;
var trackedChanges = [];
var quarantine = false;

// TODO: Store ids of encrypted nodes and warn user if lock tag is removed from them while the user was offline

const PROPERTIES = {
  NAME: "name",
  DESCRIPTION: "description",
  LOCKED: "locked",
  PARENT: "parent",
  SHARE_ID: "shareId"
};

const SENSITIVE_PROPERTIES = [
  PROPERTIES.NAME,
  PROPERTIES.DESCRIPTION
];

const FLAGS = {
  FORCE_DECRYPT: 0,
  SUPPRESS_WARNINGS: 1,
  NO_FETCH: 2,
  TRACK_ENCRYPTION_CHANGES: 3
};

const OUTCOMES = {
  IGNORE: -1,
  CANCEL: 0,
  PREV: 1,
  NEXT: 2,
  COMPLETE: 3,
  CUSTOM: 4
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getInternalVar(key) {
  return document.getElementById("we-internal-" + key).getAttribute('value');
}

function randomStr(length) { // [https://stackoverflow.com/a/1349426]
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

class NodeTracker {
  NODES = {};

  getAll() {
    return this.NODES;
  }

  update(id, properties) {
    if (id === undefined || id === null) {
      return false;
    }

    let node = this.NODES[id] ?? {};

    for (let property in properties) {
      if (properties[property] === undefined && node[property] !== undefined) {
        delete properties[property];
      }
    }

    let updatedNode = {...node, ...properties};
    updatedNode[PROPERTIES.LOCKED] = (updatedNode[PROPERTIES.NAME] ?? "").includes(LOCK_TAG);

    this.NODES[id] = updatedNode;
    return true;
  }

  delete(id) {
    delete this.NODES[id];
  }

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

  isLocked(id, direct = false) {
    return this.get(id, PROPERTIES.LOCKED, !direct, [false]) ?? false;
  }

  hasChild(id) {
    for (let nodeId in this.NODES) {
      if (this.NODES[nodeId][PROPERTIES.PARENT] === id) {
        return true;
      }
    }
    return false;
  }

  getChildren(id) {
    let childIds = [];
    for (let nodeId in this.NODES) {
      if (this.NODES[nodeId][PROPERTIES.PARENT] === id) {
        childIds.push(nodeId);
      }
    }
    return childIds;
  }
}
const nodes = new NodeTracker();

class Toast {
  PROCESS = {};
  processActive = false;

  init(title = "", text = "", success = false) {
    // For a native look, toast HTML and CSS are taken from the Workflowy's site
    document.body.insertAdjacentHTML("afterbegin",`
    <div class="_toast-container" id="_toast">
      <div class="_toast" id="_toast2">
        <div class="messageContent  _message" id="_message">
          <span><b>` + title + `</b> ` + text + `</span>
        </div>
        <span style="cursor: pointer; padding: 4px 4px 4px 0px;">
      </div>
    </div>

    <style>
    ._toast-container {
      overflow: hidden;
      position: fixed;
      left: 0px;
      right: 0px;
      bottom: 45px;
      overflow: hidden;
      z-index: 1002;
      transition: left 0.25s ease 0s;
      display: flex;
      justify-content: center;
      -webkit-box-pack: center;
    }

    ._toast {
      transition: transform 300ms ease 0s;
      font-size: 15px;
      padding: 8px 12px;
      text-align: center;
      background-color: ` + (success ? "rgb(106, 206, 159)" : "rgb(131, 162, 206)") + `;
      color: ` + (success ? "rgb(42, 49, 53)" : "rgb(44, 53, 49)") + `;
      max-width: 60%;
      border-radius: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
      display: flex;
      align-items: center;
      -webkit-box-align: center;
      visibility: hidden;
    }

    ._message {
      flex-grow: 1;
      -webkit-box-flex: 1;
      flex-shrink: 1;
      line-height: 1.4;
      padding: 0px 8px;
      border-color: initial;
      outline-color: initial;
      background-image: initial;
      background-color: transparent;
      margin: 0;
      border: 0;
      outline: 0;
      font-size: 100%;
      vertical-align: baseline;
      background: transparent;
    }  
    </style>
    `);
  }

  async show(title, text, relatedNodeId) {
    this.PROCESS[relatedNodeId] = {
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
      await sleep(50);
      toastElement.style.visibility = "visible";
      toastElement.style.transition = "all .3s ease-in-out";
      await sleep(50);
      toastElement.style.marginBottom = "0px";
      await sleep(300);
    }
  }

  async hide(relatedNodeId) {
    delete this.PROCESS[relatedNodeId];

    for (let id in this.PROCESS) {
      let title = this.PROCESS[id].title;
      let text = this.PROCESS[id].text;
      document.getElementById("_message").innerHTML = "<span><b>" + title + "</b> " + text + "</span>";
      return;
    }

    // document.getElementById("_toast").remove();
    let toastElement = document.getElementById("_toast2");
    let height = toastElement.offsetHeight;
    toastElement.style.marginBottom = "-" + height + "px";
    await sleep(300);
    toastElement.style.visibility = "hidden";
    toastElement.style.transition = "all 0s";
    
    this.processActive = false;
  }
}
const toast = new Toast();
toast.init();

class Popup {
  static resolve = null;
  static args = null;
  
  init() {
    // TODO: Input box style is not same as the native input boxes
    document.body.insertAdjacentHTML("afterbegin",`
      <style>
      ._popup-container {
        visibility: hidden;
        position: fixed;
        width: 100%;
        height: 100%;
        left: 0px;
        right: 0px;
        top: 0px;
        bottom: 0px;
        overflow: hidden;
        z-index: 1003;
        display: flex;
        justify-content: center;
        -webkit-box-pack: center;
        background-color: rgba(0, 0, 0, 0.2);
      }
  
      ._popup {
        font-size: 15px;

        position: absolute;
        margin-top: 10vh;
        max-height: calc(100% - 20vh);
        width: calc((100% - 36px) - 36px);
        flex-shrink: 0;
        padding: 36px;
        box-sizing: border-box;
        max-width: 576px;
        overflow: auto;
        border-radius: 6px;
        box-shadow: rgba(0, 0, 0, 0.12) 0px 2px 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        transition: transform 300ms ease 0s, opacity 300ms ease 0s, height 1s ease-in-out 0s;

        background: rgb(255, 255, 255);
        color: rgb(42, 49, 53);
        border: 1px solid rgb(220, 224, 226);
      }

      ._popup-content {
        transition: all .3s ease-in-out;
        opacity: 1;
      }

      ._popup-title {
        margin-top: 0px;
        margin-bottom: 0px;
        font-size: 26px;
        font-weight: bold;
        line-height: normal;
        white-space: nowrap;
        text-overflow: ellipsis;
        overflow: hidden;
        margin-right: 40px;
        position: relative;
        top: -4px;
      }
  
      ._popup-text {
        margin: 0;
        padding: 0;
        border: 0;
        outline: 0;
        font-size: 100%;
        vertical-align: baseline;
        background: transparent;
        margin-top: 12px;
        line-height: 20px;
        margin-bottom: 24px;
      }

      ._input {
        display: flex;
        margin-top: 12px;
        margin: 0;
        padding: 0;
        border: 0;
        outline: 0;
        font-size: 100%;
        vertical-align: baseline;
        background: transparent;
      }

      ._input-text {
        min-width: 96px;
        font-size: 15px;
        line-height: 30px;
      }

      ._input-box-container {
        display: flex;
        flex-direction: column;
        border: 1px solid rgb(220, 224, 226);
        box-sizing: border-box;
        display: flex;
        justify-content: center;
        align-items: center;
      }

      ._input-box {
        text-transform: none;
        text-indent: 0px;
        text-shadow: none;
        text-align: start;
        -webkit-rtl-ordering: logical;
        cursor: text;
        user-select: text;

        text-rendering: auto;
        letter-spacing: normal;
        word-spacing: normal;
        line-height: normal;
        text-transform: none;
        text-indent: 0px;
        text-shadow: none;
        display: inline-block;
        text-align: start;
        appearance: auto;
        -webkit-rtl-ordering: logical;
        cursor: text;
        background-color: field;
        margin: 0em;
        padding: 1px 0px;
        border-width: 2px;
        border-style: inset;
        border-color: -internal-light-dark(rgb(118, 118, 118), rgb(133, 133, 133));
        border-image: initial;
        padding-block: 1px;
        padding-inline: 2px;

        writing-mode: horizontal-tb !important;
        padding-block: 1px;
        padding-inline: 2px;

        display: block;
        width: 100%;
        box-sizing: border-box;
        appearance: none;
        border-radius: 4px;
        border: 1px solid rgb(220, 224, 226);
        outline: none;
        background: rgb(255, 255, 255);
        color: rgb(42, 49, 53);
        margin: 0px;
        padding: 8px;
        font-family: inherit;
        font-size: 12px;
        line-height: 15px;
        -webkit-tap-highlight-color: transparent;

        
      }

      ._popup-buttons {
        text-align: center;
        margin-top: 24px;
      }

      ._popup-button {
        text-rendering: auto;
        letter-spacing: normal;
        word-spacing: normal;
        text-transform: none;
        text-indent: 0px;
        text-shadow: none;
        align-items: flex-start;
        margin: 0em;
        padding-block: 1px;
        padding-inline: 6px;
        
        display: inline-block;
        position: relative;
        appearance: none;
        border: none;
        outline: none;
        border-radius: 12px;
        box-sizing: border-box;
        line-height: 16px;
        padding: 4px 12px;
        background: rgb(236, 238, 240);
        color: rgb(42, 49, 53);
        font-family: inherit;
        font-weight: 500;
        font-size: 12px;
        text-align: center;
        text-decoration: none;
        cursor: default;
        -webkit-tap-highlight-color: transparent;
      }
      ._popup-button:hover {
        background: rgb(221, 224, 226);
      }
      </style>
      `);
  }

  create(title, text, buttons = [], cancellable = true, args = {}) {
    return new Promise((resolve, reject) => {
      Popup.resolve = resolve;
      Popup.args = args;

      // For a native look, popup HTML and CSS are taken from the Workflowy's site
      // Create popup
      document.body.insertAdjacentHTML("afterbegin",`
      <div class="_popup-container" id="_popup">
        <div class="_popup">
          <div class="_popup-content" id="_popup-content"></div>
        </div>
      </div>
      `);

      // Create page from function args
      if (!args.pages || !Array.isArray(args.pages) || args.pages.length === 0) {
        args.pages = [{
          title: title,
          text: text,
          buttons: buttons
        }];
      }

      if (args.style) {
        document.body.insertAdjacentHTML("afterbegin",`
        <style>` + args.style + `</style>
        `); 
      }

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
    popupElement.style.visibility = "visible";
    popupElement.style.opacity = "0";
    popupElement.style.transition = "all .3s ease-in-out";
    await sleep(300);
    popupElement.style.opacity = "1";
    await sleep(300);
  }

  async setPage(pageIndex) {
    const pageCount = Popup.args.pageCount;
    const endOfPages = pageIndex === pageCount - 1;
    const page = Popup.args.pages[pageIndex];

    let content = document.getElementById("_popup-content");
    if (content.children.length !== 0) {
      content.style.opacity = "0";
      await sleep(300);
      content.replaceChildren();
    }

    // Load page content
    const title = page["title"] ?? "";
    const text = page["text"] ?? "";
    const input = page["input"] ?? null;
    const buttons = page["buttons"] ?? [];
    const htmlList = page["html"] ?? [];
    const script = page["script"] ?? (() => {});

    // Title, text
    content.insertAdjacentHTML("afterbegin", `
    <p class="_popup-title">` + title + `</p>
    <p class="_popup-text">` + text + `</p>
    `);

    // Input
    if (input !== null) {
      content.insertAdjacentHTML("beforeend", `
      <div class="_input">
        <p class="_input-text">` + input["label"] + `</p>
        <div class="_input-box-container">
          <input class="_input" type="text" id="_input-box" placeholder="` + input["placeholder"] + `">
        </div>
      </dib>
      `);
    }

    // Buttons
    content.insertAdjacentHTML("beforeend", `
    <div class="_popup-buttons" id="_popup-buttons"></div>
    `);
    let buttonsElement = document.getElementById("_popup-buttons");
    if (buttons.length === 0) {
      buttons.push({
        operation: (endOfPages ? OUTCOMES.COMPLETE : OUTCOMES.NEXT),
        text: (endOfPages ? "Close" : "Next")
      })
    }
    
    for (let i = 0; i < buttons.length; i++) {
      const button = buttons[i];
      buttonsElement.insertAdjacentHTML("beforeend", `
      <button class="_popup-button" type="button" data-id="` + i + `" onClick="onPopupClick(this, ` + button.operation + `)">` + button.text + `</button>
      `);
    }

    // Custom HTML
    if (htmlList.length > 0) {
      for (let htmlItem of htmlList) {
        content.insertAdjacentHTML(htmlItem.position, htmlItem.content);
      }
    }

    await sleep(100);
    script();


    Popup.args.currentPage = pageIndex;
    content.style.opacity = "1";
    await sleep(300);
  }

  static async onClick(element, outcome) {
    const currentPage = Popup.args.currentPage;
    if (outcome === OUTCOMES.CUSTOM) {
      let id = element.getAttribute("data-id");
      outcome = (await Popup.args.pages[currentPage].buttons[id].onClick() ?? outcome);
    }

    switch (outcome) {
      case OUTCOMES.IGNORE:
        return;
      case OUTCOMES.PREV:
        popup.setPage(currentPage - 1);
        break;
      case OUTCOMES.NEXT:
        popup.setPage(currentPage + 1);
        break;
      case OUTCOMES.CANCEL:
      case OUTCOMES.COMPLETE:
      default:
        popup.hide(outcome);
        break;
    }
  }

  async hide(outcome = OUTCOMES.CANCEL) {
    let popupElement = document.getElementById("_popup");
    popupElement.style.opacity = "0";
    await sleep(300);
    document.getElementById("_popup").remove();

    let resolve = Popup.resolve;
    Popup.resolve = null;
    Popup.args = null;
    resolve(outcome);
  }
}
const popup = new Popup();
popup.init();

function onPopupClick(element, outcome) {
  Popup.onClick(element, outcome);
}

class PopupHelper {
  async welcome() {
    await sleep(2000);
    return await popup.create(null, null, [], false, {
      style: `
      ._html1-box {
        position: relative;
        margin: 0 auto;
        align-items: center;
        text-align: center;
        border-radius: 6px;
        padding: 48px 0;
        margin-bottom: 24px;
        overflow: hidden;
      }
    
      ._html3-box {
        padding: 0;
      }
    
      ._html1-logo {
          width: 64px;
          box-sizing: border-box;
          padding: 8px;
      }
    
      ._html2-logo {
        padding: 0;
      }
    
      ._html3-logo {
        height: 160px;
        width: auto;
        padding: 32px;
      }
    
      ._html3-logo-w {
        visibility: visible;
        animation: anim-logo 2s forwards ease-out;
        animation-delay: .7s;
      }
    
      @keyframes anim-logo {
        0%   {
          transform: scale(1);
        }
        100% {
          transform: scale(1.5);
        }
      }
    
      .inline {
          display: inline-block;
          vertical-align: middle;
      }
    
      ._html1-workflowy-title {
          color: #333;
          font-family: Open Sans, sans-serif;
          font-size: 24px;
          font-weight: 700;
          
          line-height: 64px;
          -webkit-text-size-adjust: 100%;
      }
    
      ._html1-title {
          color: #333;
          font-family: Open Sans, sans-serif;
          font-size: 28px;
          line-height: 64px;
          font-weight: 400;
          cursor: default;
      }
    
      ._html1-title-white {
        color: #fafafa;
        text-align: left;
        opacity: 0.8;
    }
    
      .marginLeft {
        margin-left: 8px;
      }
    
      ._html1-blue-content {
        position: relative;
        align-items: center;
        text-align: center;
        width: 500px;
        height: 500px;
        padding: 48px 0;
        
        margin-left: 0;
        margin-top: 0;
        transition: 0s;
        animation: anim-blue-content 7s infinite ease;
      }
    
      @keyframes anim-blue-content {
        0%   {
          margin-left: 0px;
          margin-top: 0px;
        }
        20%   {
          margin-left: 0px;
          margin-top: 0px;
        }
        30% {
          margin-left: 500px;
          margin-top: 500px;
        }
        40% {
          margin-left: 500px;
          margin-top: 500px;
        }
        45%   {
          margin-left: 0px;
          margin-top: 0px;
        }
        100%   {
          margin-left: 0px;
          margin-top: 0px;
        }
      }
    
      ._html3-blue-content {
        visibility: visible;
        animation: anim-blue-content3 1s forwards ease;
        animation-delay: .7s;
      }
    
      @keyframes anim-blue-content3 {
        0%   {
          margin-left: 0px;
          margin-top: 0px;
        }
        100% {
          margin-left: 500px;
          margin-top: 500px;
        }
      }
    
      ._html1-blue {
        position: absolute;
        background-color: rgb(171, 190, 209);
        border-radius: 50%;
        width: 1000px;
        height: 1000px;
        padding: 0;
        margin: 0;
        left: 0;
        top: 0;
        margin-left: 0;
        margin-top: 0;
        display: block;
        animation: anim-blue 7s infinite ease;
        overflow: hidden;
      }
    
      @keyframes anim-blue {
        0%   {
          max-width: 0px;
          max-height: 0px;
          margin-left: 0px;
          margin-top: 0px;
        }
        20%   {
          max-width: 0px;
          max-height: 0px;
          margin-left: 0px;
          margin-top: 0px;
        }
        30% {
          max-width: 1000px;
          max-height: 1000px;
          margin-left: -500px;
          margin-top: -500px;
        }
        40% {
          max-width: 1000px;
          max-height: 1000px;
          margin-left: -500px;
          margin-top: -500px;
        }
        45%   {
          max-width: 0px;
          max-height: 0px;
          margin-left: 0px;
          margin-top: 0px;
        }
        100%   {
          max-width: 0px;
          max-height: 0px;
          margin-left: 0px;
          margin-top: 0px;
        }
      }
    
      ._html3-blue {
        visibility: hidden;
        animation: anim-blue2 1s forwards ease;
        animation-delay: .7s;
      }
    
      @keyframes anim-blue2 {
        0%   {
          visibility: visible;
          max-width: 0px;
          max-height: 0px;
          margin-left: 0px;
          margin-top: 0px;
        }
        100% {
          visibility: visible;
          max-width: 1000px;
          max-height: 1000px;
          margin-left: -500px;
          margin-top: -500px;
        }
      }
      `,
      pages: [
        {
          title: "Let's Secure Your Data",
          text: "Welcome to WorkflowyEncrypter! To enable seamless client-side encryption, follow this brief setup and let us help you secure your data.",
          html: [{
            position: "afterbegin",
            content: `
            <div class="_html1-box" id="_html1-box">
              <img class="_html1-logo inline" id="_html1-logo" src="` + getInternalVar("logoUrl") + `" alt="logo">
              <p class="_html1-title inline" id="we-text1"><span class="_html1-workflowy-title">Workflowy</span> Encrypter</p>
              <div class="_html1-blue" id="_blue">
                <div class="_html1-blue-content" id="_blue-content">
                  <img class="_html1-logo inline absolute" src="` + getInternalVar("logoWUrl") + `" alt="logo">
                  <p class="_html1-title _html1-title-white inline" id="we-text2">ciSw6deyI9hOthlspe</p>
                </div>
              </div>
            </div>
            `
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
              text2.textContent = PRE_ENC_CHAR + randomStr(15 - PRE_ENC_CHAR.length);
              setTimeout(() => {
                setRandomText(text2)
              }, 7 * 1000);
            }
            setRandomText(text2);
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
            operation: OUTCOMES.CUSTOM,
            text: "Next",
            onClick: async function() {
              let key = document.getElementById("_input-box").value;
              if (key.length === 0) {
                toast.show("Key cannot be empty.", "Provide a valid key and try again.", "KEY");
                await sleep(3000);
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
            content: `
            <div class="_html1-box" id="_html1-box">
              <img class="_html1-logo _html2-logo inline" src="` + getInternalVar("keyUrl") + `" alt="key icon">
            </div>
            `
          }]
        },
        {
          title: "Use Your Key",
          text: "Now that your key is ready, you can use it seamlessly just by adding a " + LOCK_TAG + " tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically.",
          html: [{
            position: "afterbegin",
            content: `
            <div class="_html1-box _html3-box" id="_html1-box">
              <img class="_html1-logo _html3-logo inline" src="` + getInternalVar("ss1Url") + `" alt="screenshot">
            </div>
            `
          }]
        },
        {
          title: "That's It!",
          text: "Encrypted nodes will be readable only from web browsers that have WorkflowyEncrypter installed. Try to use a different device or disable the extension temporarily to see the magic!",
          html: [{
            position: "afterbegin",
            content: `
            <div class="_html1-box" id="_html1-box">
              <img class="_html1-logo inline" id="_html1-logo" src="` + getInternalVar("logoUrl") + `" alt="logo">
              <div class="_html1-blue _html3-blue" id="_blue">
                <div class="_html1-blue-content _html3-blue-content" id="_blue-content">
                  <img class="_html1-logo _html3-logo-w inline absolute" src="` + getInternalVar("logoWUrl") + `" alt="logo">
                </div>
              </div>
            </div>
            `
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
  TREE = {};

  async loadTree() {
    this.removeTree();
    
    await this.loadSpecificTree("/get_tree_data/");
    for (let shareId of shared) {
      await this.loadSpecificTree("/get_tree_data/?share_id=" + shareId);
    }
  }

  async loadSpecificTree(path) {
    const treeDataRaw = await origFetch(DOMAIN + path);
    const treeData = await treeDataRaw.json();

    let notArray = false;
    for (let data of treeData.items) {
      if (notArray || !Array.isArray(data)) {
        notArray = true;
        await this.addNodeToParsedData(this.TREE, data);
        continue;
      }

      for (let subData of data) {
        await this.addNodeToParsedData(this.TREE, subData);
      }
    }
  }

  async addNodeToParsedData(parsedData, item) {
    let id = item.id;
    parsedData[id] = {};
      if (item.nm !== undefined) {
        parsedData[id].name = await encrypter.decrypt(item.nm);
      }
      if (item.no !== undefined) {
        parsedData[id].description = await encrypter.decrypt(item.no);
      }
  }

  async removeTree() {
    this.TREE = {};
  }

  async pushAndPoll(id, operations) {
    let rawBody = {
      client_id: clientId,
      client_version: clientVersion,
      crosscheck_user_id: crosscheckUserId,
      push_poll_data: [{
        most_recent_operation_transaction_id: mostRecentOperationTransactionId,
        operations: operations
      }],
      push_poll_id: null // Find what to send
    };
    let shareId = nodes.getShareId(id);
    if (shareId !== undefined) {
      rawBody.push_poll_data[0].share_id = shareId;
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
      console.warn(`Encryption error`, e);
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
      console.warn(`Encryption error`, e);
      return "";
    }
  }
}
const encrypter = new Encrypter();
encrypter.loadSecret();

class Util {
  endpointMatches(path, method, url, params) {
    return url.includes(DOMAIN + path) && method === params.method;
  }
  
  isString(val) {
    return typeof val === 'string' || val instanceof String;
  }
  
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
      if (!this.isString(val)) {
        val = JSON.stringify(val);
      }
      val = encodeURIComponent(val).replaceAll("%20", "+");
      list.push(key + "=" + val);
    }
    return list.join("&");
  }

  async processNewTreeData(data) {
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

    nodes.update(data.id, properties);
  }

  decodeVal(val) {
    if (!this.isString(val)) {
      val = JSON.stringify(val);
    }
    val = encodeURIComponent(val).replaceAll("%20", "+");
    return val;
  }

  async decryptServerResponse(json, trackedChangeData) {
    for (let op of json.ops) {
      if (op.data === undefined) {
        continue;
      }

      let dataObj = [];
      let stringifyJson = [];

      trackedChanges = [];
      let result = await util.processOperation(op, dataObj, stringifyJson, [FLAGS.SUPPRESS_WARNINGS, FLAGS.NO_FETCH, FLAGS.TRACK_ENCRYPTION_CHANGES]);
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
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : undefined;
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
      return;
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

        if (flags.includes(FLAGS.SUPPRESS_WARNINGS) || confirm('Are you sure you want to remove the ' + LOCK_TAG + ' tag and decrypt all child nodes? This will send decrypted content to Workflowy servers.')) {
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

  async updateChildNodeEncryption(id, encrypt, processParentNode, flags = [], processingParent = true, rootId = null) {
    if (processingParent) {
      if (flags.includes(FLAGS.NO_FETCH)) {
        return true;
      }
      await toast.show((encrypt ? "Encryption" : "Decryption") + " in progress...", "Keep the page open until this message disappears.", id);
      rootId = id;
    }

    let operations = [];
    await this.createEncryptionOperationForNode(id, encrypt, processParentNode, processingParent, rootId, operations);

    let parent = nodes.getParent(id);
    if (processingParent || parent === rootId || (parent !== rootId && !nodes.isLocked(parent, true))) {
      // Get children
      let ids = nodes.getChildren(id);
      for (let id of ids) {
        operations = operations.concat(await this.updateChildNodeEncryption(id, encrypt, false, flags, false, rootId));
      }
    }

    if (processingParent) {
      await api.pushAndPoll(id, operations);
      await toast.hide(id);
    } else {
      return operations;
    }
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
        operation.undo_data.previous_name = "";
      }

      let description = nodes.get(id, PROPERTIES.DESCRIPTION);
      if (description !== undefined) {
        operation.data.description = encrypt ? await encrypter.encrypt(description) : description;
        operation.undo_data.previous_description = "";
      }

      operations.push(operation);
    }
  }

  async processMoveOperation(operation, dataObj, flags = []) {
    var parent = operation.data.parentid !== "None" ? operation.data.parentid : undefined;
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

        if (flags.includes(FLAGS.SUPPRESS_WARNINGS) || decryptionAllowed || confirm('Are you sure you want to move selected node(s) under a non-encrypted node and decrypt their data? This will send decrypted content to Workflowy servers.')) {
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
          } else if (nodes.isLocked(nodes.getParent(id)) && node && contentTag && node[contentTag] && util.isString(node[contentTag]) && node[contentTag].length > 0) {
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
}
const util = new Util();

// Fetch wrapper [https://stackoverflow.com/a/64961272]
const {fetch: origFetch} = window;
window.fetch = async (...args) => {
  if (quarantine) {
    return;
  }
  
  let url = args[0];
  let params = args[1];

  params = await onPreFetch(url, params);
  if (quarantine) {
    return;
  }
  args[1] = params;
  
  const response = await origFetch(...args);

  return await onPostFetch(url, params, response);
};

// Modify request params
async function onPreFetch(url, params) {
  // Encrypt submitted push_and_poll data
  if (!util.endpointMatches("/push_and_poll", "POST", url, params)) {
    return params;
  }

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

// Modify response body
async function onPostFetch(url, params, response) {
  // Update mostRecentOperationTransactionId
  let responseData = await response.clone().json();
  if (responseData.results && Array.isArray(responseData.results) && responseData.results > 0 && responseData.results[0].new_most_recent_operation_transaction_id) {
    mostRecentOperationTransactionId = responseData.results[0].new_most_recent_operation_transaction_id;
  }

  if (util.endpointMatches("/get_tree_data", "GET", url, params)) {
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
  } else if (util.endpointMatches("/push_and_poll", "POST", url, params)) {
    // TODO: Find another point to clear cache later
    if (!cacheClearPerformed) {
      cache.clear();
      cacheClearPerformed = true;
    }

    // Track encryption changes
    let trackedChangeData = {};

    for (let result of responseData.results) {
      if (result.server_run_operation_transaction_json !== undefined) {
        let json = JSON.parse(result.server_run_operation_transaction_json);
        await util.decryptServerResponse(json, trackedChangeData);
        result.server_run_operation_transaction_json = JSON.stringify(json);
      }
      if (result.concurrent_remote_operation_transactions !== undefined) {
        for (let i = 0; i < result.concurrent_remote_operation_transactions.length; i++) {
          let json = JSON.parse(result.concurrent_remote_operation_transactions[i]);
          await util.decryptServerResponse(json, trackedChangeData);
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
  } else if (util.endpointMatches("/get_initialization_data", "GET", url, params)) {
    shared = [];
    for (let info of responseData.projectTreeData.auxiliaryProjectTreeInfos) {
      if (info.rootProject.id !== undefined) {
        nodes.update(info.rootProject.id, {
          [PROPERTIES.SHARE_ID]: info.shareId
        });
      }
      shared.push(info.shareId);
    }
    return response;
  }

  return response;
}
