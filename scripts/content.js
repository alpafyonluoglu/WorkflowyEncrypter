injectScript(chrome.runtime.getURL('/scripts/lock.js'), 'body');

// Inject script to page [https://gist.github.com/devjin0617/3e8d72d94c1b9e69690717a219644c7a]
function injectScript(file_path, tag) {
    var node = document.getElementsByTagName(tag)[0];
    var script = document.createElement('script');
    script.setAttribute('type', 'text/javascript');
    script.setAttribute('src', file_path);
    node.appendChild(script);
}