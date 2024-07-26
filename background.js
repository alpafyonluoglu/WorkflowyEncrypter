// FIXME: Init storage def values
// chrome.runtime.onInstalled.addListener(({ reason }) => {
//     if (reason === 'install') {
//         chrome.storage.local.set({
//             apiSuggestions: ['tabs', 'storage', 'scripting']
//         });
//     }
// });

function encrypt(data) {
    // TODO: Complete encryption here
    return null;
}

function decrypt(data) {
    // TODO: Complete decryption here
    return null;
}

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    let {func, params} = message;

    switch (func) {
        case "encrypt":
            sendResponse(encrypt(params));
            break;
        case "decrypt":
            sendResponse(decrypt(params));
            break;
        default:
            sendResponse("Function not found");
            break;
    }
});
