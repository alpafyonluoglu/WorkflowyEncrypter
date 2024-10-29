var action = null;
var actionArg = null;

// IMPROVE: add back/forward buttons
// IMPROVE: change URL on pgae path change

class BaseUtils {
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    setAttributes(element, attributes) {
        for (let key in attributes) {
            element.setAttributeNS(null, key, attributes[key]);
        }
    }

    getPathString(path) {
        return path.join(" > ");
    }

    bannerLink(text, link) {
        return "<a href=\"" + link + "\" class=\"banner-link\">" + text + "</a>";
    }

    bold(text) {
        return "<b>" + text + "</b>";
    }
}
const u = new BaseUtils();

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
            chrome.runtime.sendMessage({
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
    PAGES = {
        OPTIONS: ["Options"],
        SET_KEY: ["Options", "Set Key"],
        MOVE_KEY: ["Options", "Move Key"]
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
        const constantsToFetch = ["RELOAD_REASONS", "ACTIONS"];
        for (let key of constantsToFetch) {
            this[key] = await gateway.getConstant(key);
        }
    }
}
const c = new Constants();

class ContentManager {
    async getBannerContent() {
        const secretLoaded = await gateway.secretLoaded(true);
        const blocker = await gateway.getStorage("blocker", null);
        if (secretLoaded && blocker === null) {
            return null;
        }

        switch (blocker) {
            case c.ACTIONS.WELCOME:
                return {
                    title: "Let's Secure Your Data",
                    text: "Welcome to Workflowy Encrypter! To get started, visit " + u.bannerLink("workflowy.com", "https://workflowy.com/") + "."
                };
            case c.ACTIONS.MOVE_KEY:
                return {
                    title: "A Little Rearrangement",
                    text: "We are updating the location where your key is stored on your device to enhance its security. Visit " + u.bannerLink("workflowy.com", "https://workflowy.com/") + " to finish setting things up."
                };
            default: // setLockKey
                return {
                    title: "Encryption disabled",
                    text: "Workflowy Encrypter cannot access your key. Visit " + u.bannerLink("workflowy.com", "https://workflowy.com/") + " to set your key."
                };
        }
    }

    async loadOptionsContent(parent) {
        parent.appendChild(pageManager.createTextNode("Feel the comfort of privacy... Use the options given below to customize Workflowy Encrypter just the way you want."));
        parent.appendChild(pageManager.createTextNode("Set Key", "Set a key to be used to encrypt your data.", () => {
            pageManager.setPage(c.PAGES.SET_KEY);
        }));
        // TODO: Set #private tag
        // TODO: about & contact page (github page, rate us (on Chrome Webstore), contact developer, version number)
    }

    async loadSetKeyContent(parent, props = {}) {
        let text1 = props.moveText ? props.moveText : "Register your key that will be used to encrypt your data. If this is your first time here, just enter a new key and make sure to note it down.";
        let text2  = props.moveText ? null : u.bold("It will be impossible to recover your encrypted data if you forget your key.");

        parent.appendChild(pageManager.createTextNode(text1));
        if (text2) {
            parent.appendChild(pageManager.createTextNode(text2));
        }
        parent.appendChild(pageManager.createInputNode("Key", "secret", "key-input"));
        const lockSecret = await gateway.getStorage("lockSecret", null);
        document.getElementById("key-input").value = props.moveText ? props.secretToMove : lockSecret;

        parent.appendChild(pageManager.createButtonNode([
            {
                text: "Save",
                onclick: async () => {
                    const subtext = document.getElementById("key-input-subtext");
                    const key = document.getElementById("key-input").value;
                    if (!(await gateway.isValidSecret(key.replaceAll(" ", "")))) {
                        subtext.textContent = "Invalid key";
                        subtext.style.visibility = "visible";
                        return
                    }

                    if (!props.moveText) {
                        // TODO: show warning if an existing key is about to be overriden ("existing encrypted data will not be accessible.")
                    }

                    await gateway.broadcastReload(c.RELOAD_REASONS.KEY_CHANGE);
                    await gateway.clearCache(false);
                    await gateway.setStorage("lockSecret", key);
                    await gateway.loadSecret();
                    if (props.onsave) {
                        await props.onsave();
                    }
                    subtext.textContent = [c.ACTIONS.SET_KEY, c.ACTIONS.MOVE_KEY].includes(action) ? "Key saved! You can close this tab now." : "Key saved!";
                    subtext.style.visibility = "visible";
                }                
            }
        ]));

        // IMPROVE: warning subtext visibility
    }

    async loadMoveKeyContent(parent) {
        await this.loadSetKeyContent(parent, {
            moveText: "Confirm your key below to move it to its new location. From now on, you will be able to manage your key and customize the encryption options from the extension options page.",
            secretToMove: actionArg,            
            onsave: async () => {
                await gateway.setVar("keyMoved", true);
                await gateway.setStorage("blocker", null);
            }
        });
    }
}
const content = new ContentManager();

class PageManager {
    async setPage(path) {
        await this.updatePageContent(path, path.length === 1);
    }

    async updatePageContent(path, showBanner = false) {
        this.updateTopBar(path);
    
        const contentParent = document.getElementById("content");
        contentParent.innerHTML = "";
    
        contentParent.appendChild(this.createTitle(path[path.length - 1]));
        if (showBanner) {
            let banner = await this.createBanner();
            if (banner) {
                contentParent.appendChild(banner);
            }
        }

        // Load content
        switch (u.getPathString(path)) {
            case u.getPathString(c.PAGES.OPTIONS):
                await content.loadOptionsContent(contentParent);
                break;
            case u.getPathString(c.PAGES.SET_KEY):
                await content.loadSetKeyContent(contentParent);
                break;
            case u.getPathString(c.PAGES.MOVE_KEY):
                await content.loadMoveKeyContent(contentParent);
                break;
        }
    }

    createTitle(text) {
        const title = document.createElement("p");
        title.classList.add("content-title");
        title.textContent = text;
        return title;
    }

    async createBanner() {
        let bannerContent = await content.getBannerContent();
        if (bannerContent === null) {
            // TODO: return default banner (#private)
            return null;
        }

        const banner = document.createElement("div");
        banner.classList.add("banner");

        const title = document.createElement("p");
        title.classList.add("banner-title");
        title.textContent = bannerContent.title;
        banner.appendChild(title);

        const text = document.createElement("p");
        text.classList.add("banner-text");
        text.innerHTML = bannerContent.text;
        banner.appendChild(text);

        const img = document.createElement("img");
        img.classList.add("banner-image");
        img.src = "/src/logo_w_128.png";
        banner.appendChild(img);

        // IMPROVE: Add button to banner

        return banner;
    }

    createButtonNode(buttons) {
        // "<button type=\"button\" data-id=\"0\">Next</button></div>";
        const node = document.createElement("div");
        node.classList.add("node-buttons");
        node.classList.add("node");

        for (let button of buttons) {
            const buttonElement = document.createElement("button");
            buttonElement.classList.add("node-button");
            buttonElement.textContent = button.text;
            buttonElement.addEventListener('click', button.onclick);
            node.appendChild(buttonElement);
        }

        return node;
    }

    createInputNode(text, hintText, inputId) {
        const node = document.createElement("div");
        node.classList.add("node");
        node.classList.add("input-node");

        const textElement = document.createElement("p");
        textElement.classList.add("node-text");
        textElement.innerHTML = text;
        node.appendChild(textElement);
        
        const nodeInput = document.createElement("div");
        nodeInput.classList.add("node-input");
        node.appendChild(nodeInput);

        const input = document.createElement("input");
        input.classList.add("node-input-inner");
        input.type = "text";
        input.placeholder = hintText;
        input.id = inputId;
        nodeInput.appendChild(input);

        const breakElement = document.createElement("div");
        breakElement.classList.add("node-flex-break");
        node.appendChild(breakElement);

        const subtextElement = document.createElement("p");
        subtextElement.classList.add("node-input-subtext");
        subtextElement.textContent = ".";
        subtextElement.style.visibility = "hidden";
        subtextElement.id = inputId + "-subtext";
        node.appendChild(subtextElement);

        return node;
    }

    createTextNode(text, subtext = null, func = null) {
        const clickable = func !== null;
        const node = document.createElement("div");
        node.classList.add("node");
        if (clickable) {
            node.classList.add("clickable-node");
            node.addEventListener('click', func);
        }

        if (clickable) {
            const circle = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            u.setAttributes(circle, {
                "width": "100%",
                "height": "100%",
                "viewBox": "0 0 18 18",
                "fill": "currentColor",
                "class": "node-circle"
            });
            const circlePoint = document.createElementNS("http://www.w3.org/2000/svg", "circle");
            u.setAttributes(circlePoint, {
                "cx": "9",
                "cy": "9",
                "r": "3.5"
            });
            circle.appendChild(circlePoint);
            node.appendChild(circle);
        }

        const textElement = document.createElement("p");
        textElement.classList.add("node-text");
        if (!clickable) {
            textElement.classList.add("content-text");
        }
        textElement.innerHTML = text;
        node.appendChild(textElement);

        if (subtext) {
            const subtextElement = document.createElement("p");
            subtextElement.classList.add("node-subtext");
            subtextElement.textContent = subtext;
            node.appendChild(subtextElement);
        }

        return node;
    }
 
    updateTopBar(path) {
        const top = document.getElementById("top");
        top.innerHTML = "";
        
        const img = document.createElement("img");
        img.classList.add("top-logo");
        img.src = "/src/logo_outline_dark_32.png";
        img.alt = "Logo";
        top.appendChild(img);

        for (let i = 0; i < path.length; i++) {
            // IMPROVE: prevent innerHTML use
            top.innerHTML += "<svg width=\"5\" height=\"8\" viewBox=\"0 0 5 8\" fill=\"none\" class=\"top-separator " + (i === 0 ? "top-first-separator" : "") + "\"><path d=\"M0 0 L4 4 L0 8\" stroke=\"currentColor\" stroke-linecap=\"round\"></path></svg>";

            let p = document.createElement("p");
            p.id = "top-text-" + i;
            p.classList.add("top-text");
            if (i === path.length - 1) {
                p.classList.add("top-text-active");
            }
            p.textContent = path[i];
            top.appendChild(p);
        }

        // Moved onclick assignments to new loop due to innerHTML use
        for (let i = 0; i < path.length; i++) {
            document.getElementById("top-text-" + i).addEventListener('click', () => {
                this.setPage(path.slice(0, i + 1));
            });
        }
    }
}
const pageManager = new PageManager();

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

window.onload = async () => {
    await staller.waitUntilReady();
    [action, actionArg] = await gateway.getStorage("optionsAction", [null, null]);
    switch (action) {
        case c.ACTIONS.OPEN_WORKFLOWY:
            await gateway.setStorage("optionsAction", null);
            window.location.replace("https://workflowy.com/");
            return;
        case c.ACTIONS.SET_KEY:
            await pageManager.setPage(c.PAGES.SET_KEY);
            break;
        case c.ACTIONS.MOVE_KEY:
            await pageManager.setPage(c.PAGES.MOVE_KEY);
            break;
        default:
            await pageManager.setPage(c.PAGES.OPTIONS);
            break;
    }
    await gateway.setStorage("optionsAction", [null, null]);
}

(async () => {
    // Init
    await c.init();

    staller.ready();
})();