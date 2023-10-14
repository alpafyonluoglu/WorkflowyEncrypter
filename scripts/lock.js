const DOMAIN = "https://workflowy.com";
var SECRET;
loadSecret();

// Fetch wrapper [https://stackoverflow.com/a/64961272]
const {fetch: origFetch} = window;
window.fetch = async (...args) => {
  let url = args[0];
  let params = args[1];

  params = await onPreFetch(url, params);
  args[1] = params;

  const response = await origFetch(...args);

  return await onPostFetch(url, params, response);
};

// Modify request params
async function onPreFetch(url, params) {
  // Encrypt submitted push_and_poll data
  if (!endpointMatches("/push_and_poll", "POST", url, params)) {
    return params;
  }

  let body = await encodeBody(params.body);
  for (let pushPollDataNode of body.push_poll_data) {
    for (let operationNode of pushPollDataNode.operations) {
      const name = operationNode.data.name;
      const previousName= operationNode.undo_data.previous_name;

      if (name && isString(name) && name.length > 0) {
        operationNode.data.name = await encrypt(name);
      }
      if (previousName && isString(previousName) && previousName.length > 0) {
        operationNode.undo_data.previous_name = await encrypt(previousName);
      }
    } 
  }
  params.body = await decodeBody(body);

  return params;
}

// Modify response body
async function onPostFetch(url, params, response) {
  if (!endpointMatches("/get_tree_data", "GET", url, params)) {
    return response;
  }

  let responseData = await response.clone().json();
  for (let data of responseData.items) {
    if (!Array.isArray(data)) {
      data.nm = await decrypt(data.nm);
      continue;
    }

    for (let subData of data) {
      subData.nm = await decrypt(subData.nm);
    }
  }

  return new Response(JSON.stringify(responseData));
}

function endpointMatches(path, method, url, params) {
  return url.includes(DOMAIN + path) && method === params.method;
}

function isString(val) {
  return typeof val === 'string' || val instanceof String;
}

async function encodeBody(rawBody) {
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

async function decodeBody(body) {
  let list = [];
  for (const key in body) {
    if (!body.hasOwnProperty(key)) {
      continue;
    }

    let val = body[key];
    if (!isString(val)) {
      val = JSON.stringify(val);
    }
    val = encodeURIComponent(val).replaceAll("%20", "+");
    list.push(key + "=" + val);
  }
  return list.join("&");
}

function loadSecret() {
  let secret = window.localStorage.getItem("lockSecret");
  if (!secret || secret === null | secret === "null" || secret === "") {
    secret = window.prompt("Enter your key:");
    window.localStorage.setItem("lockSecret", secret);
  }
  SECRET = secret;
}

async function encrypt(data) {
  const encryptedData = await encryptData(data, SECRET);
  return encryptedData;
}

async function decrypt(data) {
  const decryptedData = await decryptData(data, SECRET);
  return decryptedData || data;
}


// Encryption helper functions [https://github.com/bradyjoslin/webcrypto-example]
const enc = new TextEncoder();
const dec = new TextDecoder();

const buff_to_base64 = (buff) => btoa(
  new Uint8Array(buff).reduce(
    (data, byte) => data + String.fromCharCode(byte), ''
  )
);

const base64_to_buf = (b64) =>
  Uint8Array.from(atob(b64), (c) => c.charCodeAt(null));

const getPasswordKey = (password) =>
  window.crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);

const deriveKey = (passwordKey, salt, keyUsage) =>
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

async function encryptData(secretData, password) {
  try {
    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const passwordKey = await getPasswordKey(password);
    const aesKey = await deriveKey(passwordKey, salt, ["encrypt"]);
    const encryptedContent = await window.crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      aesKey,
      enc.encode(secretData)
    );

    const encryptedContentArr = new Uint8Array(encryptedContent);
    let buff = new Uint8Array(
      salt.byteLength + iv.byteLength + encryptedContentArr.byteLength
    );
    buff.set(salt, 0);
    buff.set(iv, salt.byteLength);
    buff.set(encryptedContentArr, salt.byteLength + iv.byteLength);
    const base64Buff = buff_to_base64(buff);
    return base64Buff;
  } catch (e) {
    console.log(`Error - ${e}`);
    return "";
  }
}

async function decryptData(encryptedData, password) {
  try {
    const encryptedDataBuff = base64_to_buf(encryptedData);
    const salt = encryptedDataBuff.slice(0, 16);
    const iv = encryptedDataBuff.slice(16, 16 + 12);
    const data = encryptedDataBuff.slice(16 + 12);
    const passwordKey = await getPasswordKey(password);
    const aesKey = await deriveKey(passwordKey, salt, ["decrypt"]);
    const decryptedContent = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: iv,
      },
      aesKey,
      data
    );
    return dec.decode(decryptedContent);
  } catch (e) {
    console.log(`Error - ${e}`);
    return "";
  }
}
