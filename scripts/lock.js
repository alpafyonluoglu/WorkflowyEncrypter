const DOMAIN = "https://workflowy.com";
const LOCK_TAG = "#private";
const PRE_ENC_CHAR = "_";
var crosscheckUserId = "";
var clientId = "";
var clientVersion = "";
var wfBuildDate = "";
var mostRecentOperationTransactionId = "";

class NodeTracker {
  NODES = {};

  updateNode(id, parent, locked) {
    if (!id) {
      return false;
    }
  
    let node = this.NODES[id] ?? {};
    if (parent !== undefined) {
      node.parent = parent;
    }
    if (locked !== undefined) {
      node.locked = locked;
    }
  
    this.NODES[id] = node;
    return true;
  }
  
  nodeHasChild(id) {
    for (let keyId in this.NODES) {
      if (this.NODES[keyId].parent === id) {
        return true;
      }
    }
    return false;
  }

  getChildren(id) {
    let childNodeIds = [];
    for (let keyId in this.NODES) {
      if (this.NODES[keyId].parent === id) {
        childNodeIds.push(keyId);
      }
    }
    return childNodeIds;
  }

  nodeLocked(id) {
    if (!id || id === null) {
      return false;
    }
  
    let node = this.NODES[id];
    if (node === undefined) {
      return false;
    }
    
    if (node.locked) {
      return true;
    } else if (!node.parent || node.parent === null) {
      return false;
    }
    return this.nodeLocked(node.parent);
  }
  
  parentNodeLocked(id) {
    let node = this.NODES[id];
    if (node === undefined) {
      return false;
    }
    let parentId = node.parent;

    return this.nodeLocked(parentId);
  }
}
const nodeTracker = new NodeTracker();

class Popup {
  show(title, text, success = false) {
    // For a native look, popup HTML and CSS are taken from the Workflowy's site
    document.body.insertAdjacentHTML("afterbegin",`
      <div class="_popup-container" id="_popup">
        <div class=" _popup">
          <div class="messageContent  _message">
            <span><b>` + title + `</b> ` + text + `</span>
          </div>
          <span style="cursor: pointer; padding: 4px 4px 4px 0px;">
        </div>
      </div>
  
      <style>
      ._popup-container {
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
  
      ._popup {
        transition: transform 300ms ease 0s;
        font-size: 15px;
        padding: 8px 12px;
        text-align: center;
        background-color: ` + (success ? "rgb(106, 206, 159)" : "rgb(42, 49, 53)") + `;
        color: ` + (success ? "rgb(42, 49, 53)" : "rgb(236, 236, 236)") + `;
        max-width: 60%;
        border-radius: 16px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
        display: flex;
        align-items: center;
        -webkit-box-align: center;
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

  hide() {
    document.getElementById("_popup").remove();
  }
}
const popup = new Popup();

class API {
  TREE = [];

  async loadTree() {
    const treeDataRaw = await origFetch(DOMAIN + "/get_tree_data/");
    const treeData = await treeDataRaw.json();
    let parsedData = {};

    for (let data of treeData.items) {
      if (!Array.isArray(data)) {
        await this.addNodeToParsedData(parsedData, data);
        continue;
      }

      for (let item of data) {
        await this.addNodeToParsedData(parsedData, item);
      }
    }
    
    this.TREE = parsedData;
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
    this.TREE = [];
  }
}
const api = new API();

class Encrypter {
  SECRET;
  enc;
  dec;

  constructor() {
    this.enc = new TextEncoder();
    this.dec = new TextDecoder();
  }

  loadSecret() {
    let secret = window.localStorage.getItem("lockSecret");
    if (!secret || secret === null | secret === "null" || secret === "") {
      secret = window.prompt("Enter your key:");
      if (secret) {
        window.localStorage.setItem("lockSecret", secret);
      }
    }
    this.SECRET = secret;
  }

  async encrypt(data) {
    const encryptedData = await this.encryptData(data, this.SECRET);
    return PRE_ENC_CHAR + encryptedData;
  }
  
  async decrypt(data) {
    if (!data.startsWith(PRE_ENC_CHAR)) {
      return data;
    }
    data = data.substring(PRE_ENC_CHAR.length);
    const decryptedData = await this.decryptData(data, this.SECRET);
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
      console.log(`Error: ${e}`);
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
      console.log(`Error: ${e}`);
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

  extractDataObjFromCreateBulkData(projects, parent) {
    let dataObj = [];
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
      dataObj.push(obj);
  
      if (project.ch && Array.isArray(project.ch)) {
        dataObj = dataObj.concat(this.extractDataObjFromCreateBulkData(project.ch, project.id));
      }
    }
    return dataObj;
  }

  async processNewTreeData(data) {
    if (data.nm !== undefined) {
      data.nm = await encrypter.decrypt(data.nm);
    }
    if (data.no !== undefined) {
      data.no = await encrypter.decrypt(data.no);
    }
    nodeTracker.updateNode(data.id, data.prnt, data.nm.includes(LOCK_TAG));
  }

  async updateChildNodeEncryption(parentId, encrypt, processParentNode, processingParent = true) {
    if (processingParent) {
      popup.show((encrypt ? "Encryption" : "Decryption") + " in progress...", "Keep the page open until this popup disappears.");
      await api.loadTree();
    }

    let operations = [];

    if (!processingParent || processParentNode) {
      let operation = {
        type: "edit",
        client_timestamp: null, // Find what to send
        data: {
          metadataPatches: [],
          metadataInversePatches: [],
          projectid: parentId
        },
        undo_data: {
          metadataPatches: [],
          previous_last_modified: null, // Find what to send
          previous_last_modified_by: null
        }
      };

      let data = api.TREE[parentId];
      if (data.name !== undefined) {
        operation.data.name = encrypt ? await encrypter.encrypt(data.name) : data.name;
        operation.undo_data.previous_name = "";
      }
      if (data.description !== undefined) {
        operation.data.description = encrypt ? await encrypter.encrypt(data.description) : data.description;
        operation.undo_data.previous_description = "";
      }

      operations.push(operation);
    }

    // Get children
    let ids = nodeTracker.getChildren(parentId);
    for (let id of ids) {
      operations = operations.concat(await this.updateChildNodeEncryption(id, encrypt, false, false));
    }

    if (processingParent) {
      let body = await util.decodeBody({
        client_id: clientId,
        client_version: clientVersion,
        crosscheck_user_id: crosscheckUserId,
        push_poll_data: [{
          most_recent_operation_transaction_id: mostRecentOperationTransactionId,
          operations: operations
        }],
        push_poll_id: null // Find what to send
      });

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
      // caches.delete("workflowy"); // FIXME:

      await api.removeTree();
      popup.hide();
    } else {
      return operations;
    }
  }

  decodeVal(val) {
    if (!this.isString(val)) {
      val = JSON.stringify(val);
    }
    val = encodeURIComponent(val).replaceAll("%20", "+");
    return val;
  }
}
const util = new Util();

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

      // Extract data nodes list
      if (operation.type === undefined) {
        continue;
      }
      switch (operation.type) {
        case "bulk_create":
          var parent = operation.data.parentid !== "None" ? operation.data.parentid : null;
          operation.data.project_trees = JSON.parse(operation.data.project_trees);
          stringifyJson.push({
            contentTag: "project_trees",
            node: operation.data
          });
          dataObj = dataObj.concat(util.extractDataObjFromCreateBulkData(operation.data.project_trees, parent));
          break;
        case "edit":
          if (operation.data.description !== undefined) {
            dataObj.push({
              id: operation.data.projectid,
              contentTag: "description",
              node: operation.data
            });
            dataObj.push({
              id: operation.data.projectid,
              contentTag: "previous_description",
              node: operation.undo_data
            });
          }
          if (operation.data.name !== undefined) {
            dataObj.push({
              id: operation.data.projectid,
              locked: operation.data.name.includes(LOCK_TAG),
              contentTag: "name",
              node: operation.data
            });
            dataObj.push({
              id: operation.data.projectid,
              contentTag: "previous_name",
              node: operation.undo_data
            });

            // Process child nodes if exists
            const name = operation.data.name;
            const id = operation.data.projectid;
            if (!nodeTracker.nodeLocked(id) && name.includes(LOCK_TAG) && nodeTracker.nodeHasChild(id)) { // Encryption added
              util.updateChildNodeEncryption(operation.data.projectid, true);
            } else if (nodeTracker.nodeLocked(id) && !nodeTracker.parentNodeLocked(id) && !name.includes(LOCK_TAG) && nodeTracker.nodeHasChild(id)) { // Encryption removed
              if (confirm('Are you sure you want to remove the ' + LOCK_TAG + ' and decrypt all child nodes? This will send decrypted content to Workflowy servers.')) {
                util.updateChildNodeEncryption(operation.data.projectid, false);
              } else {
                window.onbeforeunload = null;
                location.reload();
                return false;
              }
            }
          }
          break;
        case "bulk_move":
          var parent = operation.data.parentid !== "None" ? operation.data.parentid : null;
          let nodeIds = JSON.parse(operation.data.projectids_json);
          let decryptionAllowed = false;
          for (let nodeId of nodeIds) {
            dataObj.push({
              id: nodeId,
              parent: parent
            });

            // Process child nodes if exists
            const id = nodeId;
            if (nodeTracker.nodeLocked(parent) && !nodeTracker.nodeLocked(id)) { // Encryption added
              util.updateChildNodeEncryption(id, true, true);
            } else if (!nodeTracker.nodeLocked(parent) && nodeTracker.parentNodeLocked(id)) { // Encryption removed
              if (decryptionAllowed || confirm('Are you sure you want to move selected node(s) under a non-encrypted node and decrypt their data? This will send decrypted content to Workflowy servers.')) {
                decryptionAllowed = true;
                util.updateChildNodeEncryption(id, false, true);
              } else {
                window.onbeforeunload = null;
                location.reload();
                return false;
              }
            }
          }
          break;
        case "delete":
        default:
          break; 
      }

      for (let data of dataObj) {
        let id = data.id;

        // Update node
        if (data.parent !== undefined || data.locked !== undefined) {
          nodeTracker.updateNode(id, data.parent, data.locked);
        }

        // Encrypt node data if the parent is locked as well
        if (!nodeTracker.parentNodeLocked(id)) {
          continue;
        }

        let node = data.node;
        let contentTag = data.contentTag;
        if (node && contentTag && node[contentTag] && util.isString(node[contentTag]) && node[contentTag].length > 0) {
          node[contentTag] = await encrypter.encrypt(node[contentTag]);
        }
      }

      for (let item of stringifyJson) {
        let contentTag = item.contentTag;
        item.node[contentTag] = JSON.stringify(item.node[contentTag]);
      }
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
    for (let data of responseData.items) {
      if (!Array.isArray(data)) {
        await util.processNewTreeData(data);
        continue;
      }
  
      for (let subData of data) {
        await util.processNewTreeData(subData);
      }
    }
  
    return new Response(JSON.stringify(responseData));
  } else if (util.endpointMatches("/push_and_poll", "POST", url, params)) {
    for (let result of responseData.results) {
      if (result.server_run_operation_transaction_json === undefined) {
        continue;
      }

      let json = JSON.parse(result.server_run_operation_transaction_json);
      for (let op of json.ops) {
        if (op.data === undefined) {
          continue;
        }
        if (op.data.name) {
          op.data.name = await encrypter.decrypt(op.data.name);
        }
        if (op.data.description) {
          op.data.description = await encrypter.decrypt(op.data.description);
        }
      }

      result.server_run_operation_transaction_json = JSON.stringify(json);
    }
  
    return new Response(JSON.stringify(responseData));
  }
  return response;
}
