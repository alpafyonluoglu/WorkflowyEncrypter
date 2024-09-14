// chrome.runtime.onInstalled.addListener(({ reason }) => {
//     if (reason === 'install') {
//         // TODO: Open welcome page
//     }
// });

const PRE_ENC_CHAR = "_";

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

class Encrypter {
    SECRET = null;
    enc;
    dec;

    constructor() {
        this.enc = new TextEncoder();
        this.dec = new TextDecoder();
    }

    async loadSecret() {
        // TODO: Get secret from extension storage or show welcome page
        // let secret = window.localStorage.getItem("lockSecret");
        // if (!secret || secret === null | secret === "null" || secret === "") {
        //   await popupHelper.welcome();
        //   window.onbeforeunload = null;
        //   location.reload();
        // }
        // this.SECRET = secret;
        
        // FIXME: Temp dummy secret
        this.SECRET = "test";
    }

    async encrypt(data) {
        if (!this.secretLoaded()) {
            return data;
        }
        const encryptedData = await this.encryptData(data, this.SECRET);
        await cache.set(PRE_ENC_CHAR + encryptedData, data);
        return PRE_ENC_CHAR + encryptedData;
    }

    async decrypt(data) {
        if (
            (!data.startsWith(PRE_ENC_CHAR)) ||
            (!this.secretLoaded())
        ) {
            return data;
        }

        let cachedDecryptedData = await cache.get(data, null);
        if (cachedDecryptedData !== null && cachedDecryptedData !== undefined) {
            return cachedDecryptedData;
        }

        let origData = data;
        data = data.substring(PRE_ENC_CHAR.length);
        const decryptedData = await this.decryptData(data, this.SECRET);
        await cache.set(origData, decryptedData);
        return decryptedData || data;
    }

    secretLoaded() {
        return !(!this.SECRET || this.SECRET === null || this.SECRET === "null" || this.SECRET === "");
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
encrypter.loadSecret();

function funcMapper(func) {
    switch (func) {
        case "encrypt":
            return encrypter.encrypt.bind(encrypter);
        case "decrypt":
            return encrypter.decrypt.bind(encrypter);
        case "clearCache":
            return cache.clear.bind(cache);
        default:
            return null;
    }
}

async function funcCallHandler(func, params) {
    let callableFunc = funcMapper(func);
    if (callableFunc) {
        return await callableFunc(...params);
    }
    return "Function not found";
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    let {func, params} = message;
    funcCallHandler(func, params).then(sendResponse);
    return true;
});
