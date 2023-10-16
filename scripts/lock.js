const DOMAIN = "https://workflowy.com";
const LOCK_TAG = "#private";
const PRE_ENC_CHAR = "_";
var SECRET;
var NODES = {};
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
    if (pushPollDataNode.operations === undefined) {
      continue;
    }

    for (let operationNode of pushPollDataNode.operations) {
      let dataNodes = [];
      let stringifyJson = [];

      // Extract data nodes list
      try {
        if (operationNode.type === undefined) {
          continue;
        }
        switch (operationNode.type) {
          case "bulk_create":
            var parent = operationNode.data.parentid !== "None" ? operationNode.data.parentid : null;
            operationNode.data.project_trees = JSON.parse(operationNode.data.project_trees);
            stringifyJson.push({
              contentTag: "project_trees",
              node: operationNode.data
            });
            dataNodes = dataNodes.concat(extractDataNodesFromProjects(operationNode.data.project_trees, parent));
            break;
          case "edit":
            if (operationNode.data.description !== undefined) {
              dataNodes.push({
                id: operationNode.data.projectid,
                contentTag: "description",
                node: operationNode.data
              });
              dataNodes.push({
                id: operationNode.data.projectid,
                contentTag: "previous_description",
                node: operationNode.undo_data
              });
            }
            if (operationNode.data.name !== undefined) {
              dataNodes.push({
                id: operationNode.data.projectid,
                locked: operationNode.data.name.includes(LOCK_TAG),
                contentTag: "name",
                node: operationNode.data
              });
              dataNodes.push({
                id: operationNode.data.projectid,
                contentTag: "previous_name",
                node: operationNode.undo_data
              });

              // Warnings
              // TODO: Auto encrypt
              const name = operationNode.data.name;
              const id = operationNode.data.projectid;
              if (!nodeLocked(id) && name.includes(LOCK_TAG) && nodeHasChild(id)) { // Encryption added
                alert("New node is set as " + LOCK_TAG + ". While new child nodes will be encrypted, existing ones will be kept unencrypted.");
              } else if (nodeLocked(id) && !parentNodeLocked(id) && !name.includes(LOCK_TAG)) { // Encryption removed
                alert(LOCK_TAG + " tag is removed from a node. While new child nodes will be no longer be encrypted, existing ones will be kept encrypted.");
              }
            }
            break;
          case "bulk_move":
            var parent = operationNode.data.parentid !== "None" ? operationNode.data.parentid : null;
            let nodeIds = JSON.parse(operationNode.data.projectids_json);
            for (let nodeId of nodeIds) {
              dataNodes.push({
                id: nodeId,
                parent: parent
              });
            }

            // TODO: Auto encrypt
            break;
          case "delete":
          default:
            break;
          
        }
      } catch (error) {
        console.error("Error", error);
      }

      for (let dataNode of dataNodes) {
        let id = dataNode.id;

        // Update node
        if (dataNode.parent !== undefined || dataNode.locked !== undefined) {
          updateNode(id, dataNode.parent, dataNode.locked);
        }

        // Encrypt node data if the parent is locked as well
        if (!parentNodeLocked(id)) {
          continue;
        }

        let node = dataNode.node;
        let contentTag = dataNode.contentTag;
        if (node && contentTag && node[contentTag] && isString(node[contentTag]) && node[contentTag].length > 0) {
          node[contentTag] = await encrypt(node[contentTag]);
        }
      }

      for (let item of stringifyJson) {
        let contentTag = item.contentTag;
        item.node[contentTag] = JSON.stringify(item.node[contentTag]);
      }
    } 
  }
  params.body = await decodeBody(body);

  return params;
}

function extractDataNodesFromProjects(projects, parent) {
  let dataNodes = [];
  for (let project of projects) {
    let obj = {
      id: project.id,
      parent: parent,
      node: project
    };
    if (project.nm) {
      obj.locked = project.nm.includes(LOCK_TAG);
      obj.contentTag = "nm";
    }
    dataNodes.push(obj);

    if (project.ch && Array.isArray(project.ch)) {
      dataNodes = dataNodes.concat(extractDataNodesFromProjects(project.ch, project.id));
    }
  }
  return dataNodes;
}

// Modify response body
async function onPostFetch(url, params, response) {
  if (!endpointMatches("/get_tree_data", "GET", url, params)) {
    return response;
  }

  let responseData = await response.clone().json();
  for (let data of responseData.items) {
    if (!Array.isArray(data)) {
      await processTreeNode(data);
      continue;
    }

    for (let subData of data) {
      await processTreeNode(subData);
    }
  }

  return new Response(JSON.stringify(responseData));
}

async function processTreeNode(data) {
  if (data.nm !== undefined) {
    data.nm = await decrypt(data.nm);
  }
  if (data.no !== undefined) {
    data.no = await decrypt(data.no);
  }
  updateNode(data.id, data.prnt, data.nm.includes(LOCK_TAG));
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
    if (secret) {
      window.localStorage.setItem("lockSecret", secret);
    }
  }
  SECRET = secret;
}

async function encrypt(data) {
  const encryptedData = await encryptData(data, SECRET);
  return PRE_ENC_CHAR + encryptedData;
}

async function decrypt(data) {
  if (!data.startsWith(PRE_ENC_CHAR)) {
    return data;
  }
  data = data.substring(PRE_ENC_CHAR.length);
  const decryptedData = await decryptData(data, SECRET);
  return decryptedData || data;
}

function updateNode(id, parent, locked) {
  if (!id) {
    return false;
  }

  let node = NODES[id] ?? {};
  if (parent !== undefined) {
    node.parent = parent;
  }
  if (locked !== undefined) {
    node.locked = locked;
  }

  NODES[id] = node;

  return true;
}

function nodeHasChild(id) {
  for (let keyId in NODES) {
    if (NODES[keyId].parent === id) {
      return true;
    }
  }
  return false;
}

function nodeLocked(id) {
  if (!id || id === null) {
    return false;
  }

  let node = NODES[id];
  if (node === undefined) {
    return false;
  }
  
  if (node.locked) {
    return true;
  } else if (!node.parent || node.parent === null) {
    return false;
  }
  return nodeLocked(node.parent);
}

function parentNodeLocked(id) {
  let node = NODES[id];
  if (node === undefined) {
    return false;
  }
  let parentId = node.parent;

  return nodeLocked(parentId);
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
