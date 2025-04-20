class Constants {
    // All constants added here are accessible externally
    // If needed, restrict access for certain constants
    THEMES = {
        LIGHT: "light",
        DARK: "dark"
    };
    VAR_PREFIX = "var_";
    PRE_ENC_CHAR = "_";
    DEFAULT_LOCK_TAG = "#private";
    RELOAD_REASONS = {
        UPDATE: "extensionUpdate",
        KEY_CHANGE: "keyChange",
        TAG_CHANGE: "tagChange"
    };
    ACTIONS = {
        SET_KEY: "setLockKey",
        MOVE_KEY: "migrateLockKey",
        OPEN_WORKFLOWY: "openWorkflowy",
        WELCOME: "welcome"
    };

    get(key) {
        return this[key];
    }
}
const c = new Constants();

class ExtensionStorage {
    async get(key, defVal = null) {
        return new Promise(resolve => {
            chrome.storage.local.get(key, function(data) {
                resolve(data[key] || defVal);
            });
        });
    }

    async set(key, val) {
        return new Promise(resolve => {
            chrome.storage.local.set({[key]: val}, function() {
                resolve();
            });
        });
    }

    async setVar(key, val) {
        return await this.set(c.VAR_PREFIX + key, val);
    }

    async getVar(key, defVal = null) {
        return await this.get(c.VAR_PREFIX + key, defVal);
    }
}
const storage = new ExtensionStorage();

class Cache {
    async get(key, defVal = null) {
        let cacheData = await storage.get("lockCache", undefined);
        cacheData = (cacheData !== null && cacheData !== undefined) ? JSON.parse(cacheData) : {};
        if (cacheData[key]) {
            cacheData[key].lastAccessed = Date.now();
            await storage.set("lockCache", JSON.stringify(cacheData));
            return cacheData[key].val;
        }
        return defVal;
    }

    async set(key, val) {
        let cacheData = await storage.get("lockCache", undefined);
        cacheData = (cacheData !== null && cacheData !== undefined) ? JSON.parse(cacheData) : {};
        cacheData[key] = {
            val: val,
            lastAccessed: Date.now()
        };
        await storage.set("lockCache", JSON.stringify(cacheData));
    }

    async clear(light = true) {
        if (!light) {
            await storage.set("lockCache", undefined);
            return;
        }

        let cacheData = await storage.get("lockCache", undefined);
        cacheData = (cacheData !== null && cacheData !== undefined) ? JSON.parse(cacheData) : {};

        let now = Date.now();
        let lifeDuration = 1000 * 60 * 60 * 24 * 7; // 1 week
        for (let key in cacheData) {
            if (now > lifeDuration + cacheData[key].lastAccessed) {
                delete cacheData[key];
            }
        }

        await storage.set("lockCache", JSON.stringify(cacheData));
    }
}
const cache = new Cache();

class Utils {
    async getLockTag() {
        return await storage.get("lockTag", c.DEFAULT_LOCK_TAG);
    }

    async broadcastReload(reason = null) {
        await storage.setVar("reloadBroadcast", {
            reason: reason,
            time: new Date().getTime()
        });
    }

    async getResUrl(path) {
        return chrome.runtime.getURL(path);
    }
}
const utils = new Utils();

class Encrypter {
    SECRET = null;
    enc;
    dec;

    constructor() {
        this.enc = new TextEncoder();
        this.dec = new TextDecoder();
    }

    async loadSecret() {
        this.SECRET = await storage.get("lockSecret", null);
    }

    async secretLoaded(bypassBlockerCheck = false) {
        if (!bypassBlockerCheck && (await this.getBlocker()) !== null) {
            return false;
        }

        await this.loadSecret();
        return await this.isValidSecret(this.SECRET);
    }

    async isValidSecret(secret) {
        return secret !== null && secret !== "null" && secret !== "";
    }

    async getBlocker() {
        return await storage.get("blocker", null);
    }

    async setBlocker(blocker, bypassCheck = false) {
        if (bypassCheck || (await this.getBlocker()) === null) {
            await storage.set("blocker", blocker);
        }
    }

    async encrypt(data) {
        if (!(await this.secretLoaded())) {
            return data;
        }
        const encryptedData = await this.encryptData(data, this.SECRET);
        await cache.set(c.PRE_ENC_CHAR + encryptedData, data);
        return c.PRE_ENC_CHAR + encryptedData;
    }

    async decrypt(data) {
        if (
            (!data.startsWith(c.PRE_ENC_CHAR)) ||
            (!(await this.secretLoaded()))
        ) {
            return data;
        }

        let cachedDecryptedData = await cache.get(data, null);
        if (cachedDecryptedData !== null && cachedDecryptedData !== undefined) {
            return cachedDecryptedData;
        }

        let origData = data;
        data = data.substring(c.PRE_ENC_CHAR.length);
        const decryptedData = await this.decryptData(data, this.SECRET);
        await cache.set(origData, decryptedData);
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
        crypto.subtle.importKey("raw", this.enc.encode(password), "PBKDF2", false, [
        "deriveKey",
        ]);

    deriveKey = (passwordKey, salt, keyUsage) =>
        crypto.subtle.deriveKey(
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
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const passwordKey = await this.getPasswordKey(password);
        const aesKey = await this.deriveKey(passwordKey, salt, ["encrypt"]);
        const encryptedContent = await crypto.subtle.encrypt(
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
        const decryptedContent = await crypto.subtle.decrypt(
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

class InstallHandler {
    async onInstall(welcome = true) {
        if (welcome) {
            // Open Workflowy to set lock key
            await encrypter.setBlocker(c.ACTIONS.WELCOME);
            await this.openOptionsPage(c.ACTIONS.OPEN_WORKFLOWY);
        }
    }

    async onUpdate() {
        // Handle backward compatibility related actions
        let prevVersionId = await storage.get("versionId", 0);
        if (prevVersionId === 0) {
            if (!(await encrypter.secretLoaded())) {
                // TODO: Inject script to reload open workflowy pages
                await encrypter.setBlocker(c.ACTIONS.MOVE_KEY);
            }
            return await this.onInstall(false);
        }
    }

    async onListenerAction(reason) {
        await staller.waitUntilReady();
        switch (reason) {
            case 'install':
                await this.onInstall();
                break;
            case 'update':
                await this.onUpdate();
                break;
        }
        await storage.set("versionId", this.getVersionId());
    }

    async openOptionsPage(action = null, arg = null) {
        await storage.set("optionsAction", [action, arg]);
        chrome.runtime.openOptionsPage();
    }

    getVersionId() {
        // Workflowy Enxcrypter uses semantic versioning (MAJOR.MINOR.PATCH)
        // Each version component is assumed to be max 2 digits long
        const currentVersion = chrome.runtime.getManifest().version;
        let versionId = "";
        for (let versionComponent of currentVersion.split(".")) {
            versionId += versionComponent.padStart(2, "0");
        }
        return parseInt(versionId);
    }
}
const installHandler = new InstallHandler();

class ExtensionGatewayHandler {
    funcMapper(func, internal) {
        // Define externally accessible functions
        const publicFunctions = ["encrypt", "decrypt", "secretLoaded", "getBlocker", "setBlocker", "clearCache", "openOptionsPage", "setVar", "getVar", "getConstant", "getLockTag", "getResUrl"];
        if (internal === false && !publicFunctions.includes(func)) {
            return null;
        }

        // All functions need to be async
        switch (func) {
            // Public
            case "encrypt":
                return encrypter.encrypt.bind(encrypter);
            case "decrypt":
                return encrypter.decrypt.bind(encrypter);
            case "secretLoaded":
                return encrypter.secretLoaded.bind(encrypter);
            case "getBlocker":
                return encrypter.getBlocker.bind(encrypter);
            case "setBlocker":
                return encrypter.setBlocker.bind(encrypter);
            case "clearCache":
                return cache.clear.bind(cache);
            case "openOptionsPage":
                return installHandler.openOptionsPage.bind(installHandler);
            case "setVar":
                return storage.setVar.bind(storage);
            case "getVar":
                return storage.getVar.bind(storage);
            case "getConstant":
                return c.get.bind(c);
            case "getLockTag":
                return utils.getLockTag.bind(utils);
            case "getResUrl":
                return utils.getResUrl.bind(utils);

            // Private
            case "setStorage":
                return storage.set.bind(storage);
            case "getStorage":
                return storage.get.bind(storage);
            case "loadSecret":
                return encrypter.loadSecret.bind(encrypter);
            case "isValidSecret":
                return encrypter.isValidSecret.bind(encrypter);
            case "broadcastReload":
                return utils.broadcastReload.bind(utils);

            default:
                return null;
        }
    }

    async funcCallHandler(func, params, internal) {
        await staller.waitUntilReady();
        let callableFunc = this.funcMapper(func, internal);
        if (callableFunc) {
            return await callableFunc(...params);
        }
        return {result: "error", message: "Function not found"};
    }

    initialFuncCallHandler(request, sender, sendResponse, internal = false) {
        if (!request.func || !request.params) {
            sendResponse({result: "error", message: "Invalid request"});
            return;
        }

        this.funcCallHandler(request.func, request.params, internal).then(sendResponse);
        return true;
    }
}
const gateway = new ExtensionGatewayHandler();

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

chrome.runtime.onInstalled.addListener(({ reason }) => installHandler.onListenerAction(reason));
chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => gateway.initialFuncCallHandler(request, sender, sendResponse));
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => gateway.initialFuncCallHandler(request, sender, sendResponse, true));

(async () => {
    // Init
    await encrypter.loadSecret();

    staller.ready();
})();