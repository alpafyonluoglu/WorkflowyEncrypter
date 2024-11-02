// Inject
injectVar("extensionId", chrome.runtime.id);
injectScript(chrome.runtime.getURL('/scripts/lock.js'));
injectStyle(chrome.runtime.getURL('/styles/toast.css'));

// Inject script to page [https://gist.github.com/devjin0617/3e8d72d94c1b9e69690717a219644c7a]
function injectScript(file_path) {
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', file_path);
    document.body.appendChild(script);
}

function injectStyle(file_path) {
    var link = document.createElement('link');
    link.setAttribute('rel', 'stylesheet');
    link.setAttribute('href', file_path);
    document.head.appendChild(link);
}

function injectVar(key, value) {
    var variable = document.createElement('span');
    variable.id = "wfe-internal-" + key;
    variable.setAttribute('value', value);
    document.body.appendChild(variable);
}
