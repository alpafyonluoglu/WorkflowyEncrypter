# WorkflowyEncrypter

![Marquee Promo Tile](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/30f0dfa9-15ec-4ac3-b00d-b94f51ef8ced)

[![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Rating](https://img.shields.io/chrome-web-store/rating/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Rating Users](https://img.shields.io/chrome-web-store/rating-count/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)

## About
Seamless client-side encryption for Workflowy

WorkflowyEncrypter is an open-source and simple browser extension providing client-side encryption for Workflowy. It encrypts all data locally on your device, meaning no data is sent to a remote server. While it is designed to be minimal and seamless from the user's perspective, it ensures that all text-based content sent to Workflowy servers is encrypted with AES standards so that your sensitive content can **only be read by you**.

## Getting Started
After installing the extension, follow the steps below to get started:
1. Visit [workflowy.com](https://workflowy.com/) and determine a password (also referred to as 'key') that will be used for encryption.
2. Add a `#private` tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically.

And that's it! Encrypted nodes will be readable only from web browsers that have WorkflowyEncrypter installed. Try to use a different device or disable the extension temporarily to see the magic!

![WorkflowyEncrypter Demo](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/d1aa782e-4a00-4eb6-920b-994d87a42490)

## Installation
Visit [Chrome Web Store](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib), or follow the steps below to install the extension from the source code manually. The extension is built for Chromium-based browsers; other browsers are not currently supported.
1. Download and extract the extension files.
2. Visit the extensions page of your browser. ([chrome://extensions](chrome://extensions) for Google Chrome, [edge://extensions](edge://extensions) for Microsoft Edge)
3. Enable developer mode.
4. Click on "Load unpacked".
5. Select the folder containing extension files.  

[![Available in the Chrome Web Store](https://storage.googleapis.com/web-dev-uploads/image/WlD8wC6g8khYWPJUsQceQkhXSlv1/UV4C4ybeBTsZt43U4xis.png)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)

## Data & Privacy
WorkflowyEncrypter does not collect any data from any user; there is not even a dedicated remote server for this extension. All processing is done locally on your device, shared with neither the developer nor any third parties.

## Note
As this is a third-party extension, full compatibility of the extension with the Workflowy website is not the case, and bugs may still be encountered. In those cases, simply force-reload the page by pressing Ctrl+Shift+R on Windows and Command+Shift+R on Mac. If the issue persists, do not hesitate to contact me, open an issue here on GitHub, or better yet, open a pull request if you are a developer. Contributions are much appreciated!

## Known Issues and Upcoming Features
- [Feature] Dark theme for popups.
- [Feature] Delayed toast messages to display messages only for long processes.
- [Feature] Popup focus navigation via keyboard improvement.
- [Feature] Tracking encrypted nodes and warning if #private tag of any of them has been removed via a remote session.
- [Feature] File encryption.

## Contributing
All collaborators are welcome to contribute to the project in any constructive way as long as they comply with the code of conduct.

## License
This project is licensed under the MIT License. See the [LICENSE](/LICENSE) for details.

## Contact
Have something on your mind? You can always reach me via email or social media addresses given in my profile info for any suggestions and questions.
