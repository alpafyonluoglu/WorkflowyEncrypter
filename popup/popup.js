// Open links in new tab [https://stackoverflow.com/a/17732667]
document.addEventListener('DOMContentLoaded', function () {
    var links = document.getElementsByTagName("a");
    for (var i = 0; i < links.length; i++) {
        (function () {
            var ln = links[i];
            var location = ln.href;
            ln.onclick = function () {
                chrome.tabs.create({active: true, url: location});
            };
        })();
    }
});

// Show version number
document.getElementById("version").innerText = chrome.runtime.getManifest().version;
