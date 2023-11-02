// Inject variables
injectVar("logoUrl", chrome.runtime.getURL('/src/logo_128.png'));
injectScript(chrome.runtime.getURL('/scripts/lock.js'), 'body');

// Inject script to page [https://gist.github.com/devjin0617/3e8d72d94c1b9e69690717a219644c7a]
function injectScript(file_path, tag) {
    var node = document.getElementsByTagName(tag)[0];
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', file_path);
    node.appendChild(script);
}

function injectVar(key, value) {
    var node = document.getElementsByTagName('body')[0];
    var variable = document.createElement('span');
    variable.id = "we-internal-" + key;
    variable.setAttribute('value', value);
    node.appendChild(variable);
}