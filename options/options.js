var action = null;

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

    // IMPROVE: common function
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

    static error(code) {
        const error = new Error("The extension request could not be completed.");
        error.code = code;
        return error;
    }

    static call(func, ...params) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (error, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                if (error) reject(error);
                else resolve(value);
            };
            const timeout = setTimeout(() => {
                finish(ExtensionGateway.error("RPC_TIMEOUT"));
            }, 30000);
            try {
                chrome.runtime.sendMessage({func, params}, response => {
                    // Read lastError even for a late response, so Chrome consumes it.
                    const runtimeError = chrome.runtime.lastError;
                    if (runtimeError) {
                        finish(ExtensionGateway.error("RPC_UNAVAILABLE"));
                    } else if (!response || typeof response.ok !== "boolean") {
                        finish(ExtensionGateway.error("RPC_NO_RESPONSE"));
                    } else if (!response.ok) {
                        finish(ExtensionGateway.error(response.error?.code || "RPC_FAILED"));
                    } else {
                        finish(null, response.value);
                    }
                });
            } catch (_) {
                finish(ExtensionGateway.error("RPC_UNAVAILABLE"));
            }
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
        const constantsToFetch = ["ACTIONS"];
        for (let key of constantsToFetch) {
            this[key] = await gateway.getConstant(key);
        }
    }
}
const c = new Constants();

// Create shared Popup instance for the extension context (options page is always dark)
const popup = new Popup({
    resourceLoader: async (path) => {
        const res = await fetch(chrome.runtime.getURL(path));
        return res.text();
    },
    styleInjector: async (parent, paths) => {
        // Use <link> tags instead of inline <style> to satisfy extension CSP
        for (const path of paths) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = chrome.runtime.getURL(path);
            parent.appendChild(link);
        }
    },
    isDarkTheme: () => true
});
// Preloading is optional; opening a popup can load its resources again.
popup.preload().catch(() => {});

class ContentManager {
    async getKeyStatus() {
        const status = await gateway.getKeyStatus();
        if (!status || typeof status.ready !== "boolean" ||
            !(status.keyId === null || (typeof status.keyId === "string" && status.keyId.length > 0)) ||
            typeof status.hasPreviousKeys !== "boolean") {
            throw ExtensionGateway.error("RPC_NO_RESPONSE");
        }
        return status;
    }

    errorText(error) {
        switch (error?.code) {
            case "INVALID_KEY":
            case "INVALID_SECRET":
                return "Enter a valid, non-empty key. Your key has not been changed.";
            case "KEY_CHANGED":
            case "KEY_CONFLICT":
            case "CONFLICT":
                return "The saved key changed in another tab. Refresh key status, then review and confirm your choice again.";
            case "CONFIRM_REPLACEMENT":
            case "CONFIRMATION_REQUIRED":
            case "REPLACEMENT_CONFIRMATION_REQUIRED":
                return "Changing an existing key needs confirmation. Refresh key status and try again.";
            case "RPC_TIMEOUT":
                return "The extension did not respond in time. The save may have completed. Refresh key status before trying again.";
            case "RPC_UNAVAILABLE":
            case "RPC_NO_RESPONSE":
                return "Could not verify the extension's response. Refresh key status before trying again, or reopen this options page.";
            default:
                return "Could not verify the save. Keep your key safe, refresh key status, and try again. If this continues, reopen this options page.";
        }
    }

    async getBannerContent() {
        const status = await this.getKeyStatus();
        if (status.ready) return null;
        return {
            title: "Encryption key needed",
            text: "If you used Workflowy Encrypter before, reopen " + u.bannerLink("workflowy.com", "https://workflowy.com/") + " to retry automatic key recovery. For a new setup, choose Set Key below."
        };
    }

    async loadOptionsContent(parent, isCurrent = () => true) {
        parent.appendChild(pageManager.createTextNode("Feel the comfort of privacy... Use the options given below to customize Workflowy Encrypter just the way you want."));
        parent.appendChild(pageManager.createTextNode("Set Key", "Set a key to be used to encrypt your data.", () => {
            pageManager.setPage(c.PAGES.SET_KEY);
        }));
        const cacheStatus = pageManager.createTextNode("");
        cacheStatus.setAttribute("role", "status");
        let clearing = false;
        parent.appendChild(pageManager.createTextNode("Clear Cache", "Clear temporary encryption data held in memory.", async () => {
            if (clearing || !isCurrent()) return;
            clearing = true;
            try {
                const outcome = await popup.open(PopupTemplates.confirm(
                    "Clear Cache",
                    "This clears temporary encryption data held in memory. Your saved key and previous keys are kept. Encryption data will be derived again as needed.",
                    "Clear Cache"
                ));
                if (outcome !== Popup.OUTCOMES.COMPLETE || !isCurrent()) return;
                await gateway.clearCache(false);
                if (isCurrent()) cacheStatus.textContent = "Temporary encryption cache cleared.";
            } catch (_) {
                if (isCurrent()) cacheStatus.textContent = "Could not confirm the cache was cleared. Reopen this options page and try again.";
            } finally {
                clearing = false;
            }
        }));
        parent.appendChild(cacheStatus);
        parent.appendChild(pageManager.createTextNode("Finish legacy migration", "Review recovery and approve removal of the old website key only when you are ready.", () => {
            pageManager.setPage(c.PAGES.MOVE_KEY);
        }));
    }

    async loadSetKeyContent(parent, isCurrent = () => true) {
        let keyStatus = await this.getKeyStatus();
        parent.appendChild(pageManager.createTextNode("Enter the key you want this extension to use. Keep a safe copy of every key used to encrypt your data."));
        parent.appendChild(pageManager.createTextNode(u.bold("Encrypted nodes need the key that encrypted them. Losing that key can make recovery impossible.")));
        if (keyStatus.hasPreviousKeys) {
            parent.appendChild(pageManager.createTextNode("Previous keys are retained in this extension for recovery. Keep your own safe copies as well."));
        }
        const inputNode = pageManager.createInputNode("Key", "Enter a key", "key-input");
        const input = inputNode.querySelector("input");
        const subtext = inputNode.querySelector(".node-input-subtext");
        input.type = "password";
        input.autocomplete = "new-password";
        input.spellcheck = false;
        input.value = "";
        subtext.setAttribute("role", "status");
        parent.appendChild(inputNode);
        let saving = false;
        const showMessage = text => {
            subtext.textContent = text;
            subtext.style.visibility = "visible";
        };
        const buttons = pageManager.createButtonNode([{
            text: "Save",
            onclick: async () => {
                if (saving || !isCurrent()) return;
                saving = true;
                input.disabled = true;
                saveButton.disabled = true;
                try {
                    if (keyStatus === null) {
                        keyStatus = await this.getKeyStatus();
                        if (isCurrent()) {
                            saveButton.textContent = "Save";
                            showMessage("Key status refreshed. Review the key you entered, then choose Save again.");
                        }
                        return;
                    }
                    const key = input.value;
                    if (!key.trim() || key === "null") {
                        showMessage("Enter a valid, non-empty key.");
                        return;
                    }
                    const replacing = keyStatus.keyId !== null;
                    if (replacing) {
                        const outcome = await popup.open(PopupTemplates.confirm(
                            "Change Key?",
                            "Existing encrypted nodes still need their previous key. The previous key will be retained locally in this extension for recovery. Keep safe copies of your keys. Change to the key you entered?",
                            "Change Key"
                        ));
                        if (outcome !== Popup.OUTCOMES.COMPLETE || !isCurrent()) return;
                    }
                    // The background owns validation, conflict detection, durable storage,
                    // and only then any reload notification. Never send keys to the page.
                    const result = await gateway.saveKey(key, keyStatus.keyId, replacing);
                    if (!result || typeof result.keyId !== "string" || !result.keyId || typeof result.changed !== "boolean") {
                        throw ExtensionGateway.error("RPC_NO_RESPONSE");
                    }
                    keyStatus = {ready: true, keyId: result.keyId, hasPreviousKeys: keyStatus.hasPreviousKeys || (replacing && result.changed)};
                    input.value = "";
                    if (isCurrent()) {
                        showMessage("Key saved and verified in extension storage. Reload every open Workflowy tab before continuing.");
                    }
                } catch (error) {
                    // A failed/lost reply is not proof that no write occurred. Refresh
                    // status before another attempt, and never reuse old confirmation.
                    keyStatus = null;
                    if (isCurrent()) {
                        saveButton.textContent = "Refresh key status";
                        showMessage(this.errorText(error));
                    }
                } finally {
                    saving = false;
                    input.disabled = false;
                    saveButton.disabled = false;
                }
            }
        }]);
        const saveButton = buttons.querySelector("button");
        parent.appendChild(buttons);
    }

    async loadMoveKeyContent(parent, isCurrent = () => true) {
        parent.appendChild(pageManager.createTextNode("Reopening Workflowy copies your existing key into extension storage and verifies the save. The old website copy is kept until you explicitly approve cleanup here."));
        parent.appendChild(pageManager.createTextNode("Before finishing migration, close all other Workflowy tabs and reload the remaining Workflowy tab so an older tab cannot write the website key again. Keep your recovery key backed up. If you do not already have an independent saved copy of your recovery key, leave cleanup pending. Do not clear Workflowy's website data while recovery is pending."));
        const statusText = pageManager.createTextNode("");
        statusText.setAttribute("role", "status");
        parent.appendChild(statusText);
        let checking = false;
        const buttons = pageManager.createButtonNode([{
            text: "Check key status",
            onclick: async () => {
                if (checking || !isCurrent()) return;
                checking = true;
                try {
                    const status = await this.getKeyStatus();
                    if (isCurrent()) {
                        statusText.textContent = status.ready
                            ? "A key is ready in extension storage. Complete the precautions above before approving legacy cleanup."
                            : "No saved key is ready yet. Reopen Workflowy in this browser to retry recovery, then check again.";
                    }
                } catch (_) {
                    if (isCurrent()) statusText.textContent = "Could not check key status. Reopen this options page and try again. Keep your existing Workflowy website data.";
                } finally {
                    checking = false;
                }
            }
        }, {
            text: "Finish legacy migration",
            onclick: async () => {
                if (checking || !isCurrent()) return;
                checking = true;
                try {
                    const status = await this.getKeyStatus();
                    if (!isCurrent()) return;
                    if (!status.ready || status.keyId === null) {
                        statusText.textContent = "A verified key is needed first. Reopen Workflowy to copy your existing key, then return here. Keep the website copy for now.";
                        return;
                    }
                    const outcome = await popup.open(PopupTemplates.confirm(
                        "Finish legacy migration?",
                        "A key is saved and verified in extension storage. Approving cleanup allows the remaining Workflowy tab to remove its old website key. Close all other Workflowy tabs, reload the remaining tab before continuing, and keep your recovery key backed up. If you do not already have an independent saved copy of your recovery key, leave cleanup pending. Are you ready to approve cleanup?",
                        "Approve cleanup"
                    ));
                    if (outcome !== Popup.OUTCOMES.COMPLETE || !isCurrent()) return;
                    const result = await gateway.approveLegacyCleanup(status.keyId);
                    if (!result || result.approved !== true) throw ExtensionGateway.error("RPC_NO_RESPONSE");
                    if (isCurrent()) {
                        statusText.textContent = "Cleanup approved temporarily for the current Workflowy tab. Return to that tab and retry migration now. This approval alone does not remove the website copy.";
                    }
                } catch (error) {
                    if (!isCurrent()) return;
                    switch (error?.code) {
                        case "OTHER_TABS_OPEN":
                            statusText.textContent = "Keep exactly one Workflowy tab open. Close all others, reload the remaining tab, then return here and approve cleanup again.";
                            break;
                        case "MIGRATION_NOT_READY":
                            statusText.textContent = "The remaining Workflowy tab is not ready for cleanup. Return there to retry key recovery, then approve cleanup here again. Keep the website copy for now.";
                            break;
                        case "KEY_CHANGED":
                            statusText.textContent = "The saved key changed. Check the key status and review the recovery precautions before approving cleanup again.";
                            break;
                        default:
                            statusText.textContent = "Could not verify cleanup approval. Keep your recovery key backed up, check the key status, and try again. This page cannot confirm that the website copy was removed.";
                    }
                } finally {
                    checking = false;
                }
            }
        }]);
        parent.appendChild(buttons);
    }
}
const content = new ContentManager();

class PageManager {
    renderId = 0;

    async setPage(path) {
        const renderId = ++this.renderId;
        const isCurrent = () => renderId === this.renderId;
        try {
            await this.updatePageContent(path, path.length === 1, isCurrent);
        } catch (_) {
            if (isCurrent()) this.showError();
        }
    }

    showError() {
        const parent = document.getElementById("content");
        parent.replaceChildren(this.createTitle("Options unavailable"));
        parent.appendChild(this.createTextNode("Could not read the extension's key status. Keep your existing keys and Workflowy website data. Reopen this options page to try again."));
        parent.appendChild(this.createButtonNode([{
            text: "Retry",
            onclick: () => window.location.reload()
        }]));
    }

    async updatePageContent(path, showBanner = false, isCurrent = () => true) {
        this.updateTopBar(path);
        const contentParent = document.getElementById("content");
        contentParent.replaceChildren(this.createTextNode("Loading options..."));
        const pendingContent = document.createDocumentFragment();
        pendingContent.appendChild(this.createTitle(path[path.length - 1]));
        let animate = false;
        if (showBanner) {
            const result = await this.createBanner();
            if (!isCurrent()) return;
            const banner = result[0];
            animate = result[1];
            if (banner) pendingContent.appendChild(banner);
        }
        switch (u.getPathString(path)) {
            case u.getPathString(c.PAGES.OPTIONS):
                await content.loadOptionsContent(pendingContent, isCurrent);
                break;
            case u.getPathString(c.PAGES.SET_KEY):
                await content.loadSetKeyContent(pendingContent, isCurrent);
                break;
            case u.getPathString(c.PAGES.MOVE_KEY):
                await content.loadMoveKeyContent(pendingContent, isCurrent);
                break;
        }
        if (!isCurrent()) return;
        contentParent.replaceChildren(pendingContent);
        if (animate) animator.bannerAnim();
    }

    createTitle(text) {
        const title = document.createElement("p");
        title.classList.add("content-title");
        title.textContent = text;
        return title;
    }

    async createBanner() {
        const banner = document.createElement("div");
        banner.classList.add("banner");
        let animate = false;

        let bannerContent = await content.getBannerContent();
        if (bannerContent === null) {
            animate = true;
            banner.classList.add("animated-banner");

            const animatedBackground = document.createElement("p");
            animatedBackground.classList.add("banner-animated-background");
            animatedBackground.id = "bannerAnimatedBackground";
            banner.appendChild(animatedBackground);

            const foreground = document.createElement("div");
            foreground.classList.add("banner-foreground");
            foreground.textContent = "#private";
            banner.appendChild(foreground);

            const color = document.createElement("div");
            color.classList.add("banner-color");
            banner.appendChild(color);

            const subtext = document.createElement("p");
            subtext.classList.add("banner-anim-subtext");
            subtext.innerHTML = "with " + u.bold("Workflowy Encrypter");
            banner.appendChild(subtext);
        } else {
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
        }

        return [banner, animate];
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

window.onload = async () => {
    try {
        await c.init();
        const optionsAction = await gateway.takeOptionsAction();
        if (!Array.isArray(optionsAction)) throw ExtensionGateway.error("RPC_NO_RESPONSE");
        [action] = optionsAction;
        switch (action) {
            case c.ACTIONS.OPEN_WORKFLOWY:
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
    } catch (_) {
        pageManager.showError();
    }
};

class Animator {
    async bannerAnim() {
        const element = document.getElementById("bannerAnimatedBackground");
        if (!element) return;
        const height = element.clientHeight;
        const width = element.clientWidth;

        let rows = Math.ceil(height / 12);
        let cols = Math.floor(width / 12 * (5/3));
        let n = rows * cols;

        for (let i = 0; i < n; i++) {
            // Create span element
            let span = document.createElement("span");
            span.textContent = u.randomStr(1);
            span.id = "bannerAnimatedSpan" + i;
            element.appendChild(span);
        }

        while (element.isConnected) {
            for (let i = 0; i < cols + rows; i++) {
                // Uncomment for animation
                for (let j = 0; j < rows; j++) {
                    if (i - j < 0 || i - j > cols - 1) {
                        continue;
                    }
                    let id = (i - j) + j * cols;
                    const span = element.querySelector("#bannerAnimatedSpan" + id);
                    if (!element.isConnected) return;
                    if (!span) continue;
                    // element.classList.remove("transition");
                    // element.style.opacity = 0;
                    span.textContent = u.randomStr(1);
                }
                // await u.sleep(0);
                // for (let j = 0; j < rows; j++) {
                //     if (i - j < 0 || i - j > cols - 1) {
                //         continue;
                //     }
                //     let id = (i - j) + j * cols;
                //     let element = document.getElementById("bannerAnimatedSpan" + id);
                //     element.classList.add("transition");
                //     element.style.opacity = 1;
                // }
                await u.sleep(20);
            }

            await u.sleep(3200);
        }
    }
}
const animator = new Animator();
