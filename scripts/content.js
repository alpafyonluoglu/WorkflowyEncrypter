// Inject variables
injectVar("logoUrl", chrome.runtime.getURL('/src/logo_128.png'));
injectVar("logoWUrl", chrome.runtime.getURL('/src/logo_w_128.png'));
injectVar("keyUrl", chrome.runtime.getURL('/src/key_128.png'));
injectVar("ss1Url", chrome.runtime.getURL('/src/ss1.png'));
injectVar("ss1DarkUrl", chrome.runtime.getURL('/src/ss1_dark.png'));
injectVar("htmlToastContainer", chrome.runtime.getURL('/layouts/toast_container.html'));
injectVar("htmlPopupContainer", chrome.runtime.getURL('/layouts/popup_container.html'));
injectVar("htmlPopupWelcome1", chrome.runtime.getURL('/layouts/popup_welcome_1.html'));
injectVar("htmlPopupWelcome2", chrome.runtime.getURL('/layouts/popup_welcome_2.html'));
injectVar("htmlPopupWelcome3", chrome.runtime.getURL('/layouts/popup_welcome_3.html'));
injectVar("htmlPopupWelcome4", chrome.runtime.getURL('/layouts/popup_welcome_4.html'));
injectVar("cssWelcome", chrome.runtime.getURL('/styles/welcome.css'));
injectVar("cssWelcomeDark", chrome.runtime.getURL('/styles/welcome_dark.css'));
injectVar("cssPopup", chrome.runtime.getURL('/styles/popup.css'));
injectVar("cssPopupDark", chrome.runtime.getURL('/styles/popup_dark.css'));
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