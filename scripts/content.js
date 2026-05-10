class DocumentHelper {
    injectScript(file_path) {
        return new Promise(resolve => {
            var script = document.createElement('script');
            script.setAttribute('type', 'text/javascript');
            script.setAttribute('src', file_path);
            script.onload = resolve;
            document.body.appendChild(script);
        });
    }

    injectStyle(file_path) {
        var link = document.createElement('link');
        link.setAttribute('rel', 'stylesheet');
        link.setAttribute('href', file_path);
        document.head.appendChild(link);
    }

    injectVar(key, value) {
        var variable = document.createElement('span');
        variable.id = "wfe-internal-" + key;
        variable.setAttribute('value', value);
        document.body.appendChild(variable);
    }
}
const documentHelper = new DocumentHelper();

// Inject lock script
(async () => {
    documentHelper.injectVar("extensionId", chrome.runtime.id);
    await documentHelper.injectScript(chrome.runtime.getURL('/scripts/popup.js'));
    await documentHelper.injectScript(chrome.runtime.getURL('/scripts/lock.js'));
    documentHelper.injectStyle(chrome.runtime.getURL('/styles/toast.css'));    
  })();
