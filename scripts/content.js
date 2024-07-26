const EVENT_TO_SCRIPT = "WfeEventToScript";
const EVENT_TO_CONTENT = "WfeEventToContent";

// Inject variables
injectVar("eventToScript", EVENT_TO_SCRIPT);
injectVar("eventToContent", EVENT_TO_CONTENT);
injectVar("logoUrl", chrome.runtime.getURL('/src/logo_128.png'));
injectVar("logoWUrl", chrome.runtime.getURL('/src/logo_w_128.png'));
injectVar("keyUrl", chrome.runtime.getURL('/src/key_128.png'));
injectVar("ss1Url", chrome.runtime.getURL('/src/ss1.png'));
injectVar("ss1DarkUrl", chrome.runtime.getURL('/src/ss1_dark.png'));
injectVar("htmlToastContainer", chrome.runtime.getURL('/layouts/toast_container.html'));
injectVar("htmlPopupContainer", chrome.runtime.getURL('/layouts/popup_container.html'));
injectVar("htmlPopupClose", chrome.runtime.getURL('/layouts/popup_close.html'));
injectVar("htmlPopupWelcome1", chrome.runtime.getURL('/layouts/popup_welcome_1.html'));
injectVar("htmlPopupWelcome2", chrome.runtime.getURL('/layouts/popup_welcome_2.html'));
injectVar("htmlPopupWelcome3", chrome.runtime.getURL('/layouts/popup_welcome_3.html'));
injectVar("htmlPopupWelcome4", chrome.runtime.getURL('/layouts/popup_welcome_4.html'));
injectVar("cssWelcome", chrome.runtime.getURL('/styles/welcome.css'));
injectVar("cssWelcomeDark", chrome.runtime.getURL('/styles/welcome_dark.css'));
injectVar("cssPopup", chrome.runtime.getURL('/styles/popup.css'));
injectVar("cssPopupDark", chrome.runtime.getURL('/styles/popup_dark.css'));
injectVar("cssPopupType0", chrome.runtime.getURL('/styles/popup_type0.css'));
injectVar("cssPopupType0Dark", chrome.runtime.getURL('/styles/popup_type0_dark.css'));
injectVar("cssPopupType1", chrome.runtime.getURL('/styles/popup_type1.css'));
injectVar("cssPopupType1Dark", chrome.runtime.getURL('/styles/popup_type1_dark.css'));
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

window.addEventListener(EVENT_TO_CONTENT, function(message) {
    let {func, params, id} = message.detail;
    
    // chrome.runtime.sendMessage();
    callParams = {
        response: "Called " + func + " with params: " + params,
        id: id
    }

    window.dispatchEvent(new CustomEvent(EVENT_TO_SCRIPT, {detail: callParams}));
}, false);