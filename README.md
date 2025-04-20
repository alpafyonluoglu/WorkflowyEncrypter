# Workflowy Encrypter

![Marquee Promo Tile](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/30f0dfa9-15ec-4ac3-b00d-b94f51ef8ced)

[![Chrome Web Store Version](https://img.shields.io/chrome-web-store/v/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Users](https://img.shields.io/chrome-web-store/users/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Rating](https://img.shields.io/chrome-web-store/rating/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)
[![Chrome Web Store Rating Users](https://img.shields.io/chrome-web-store/rating-count/fohbpcookddpmmhpmgoogodlanhikeib)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)

## About
Seamless client-side encryption for Workflowy

Workflowy Encrypter is an open-source, simple browser extension providing client-side encryption for Workflowy. It encrypts all data locally on your device, meaning no data is sent to
a remote server. To keep Workflowy's simplicity, the extension only provides minimal interfaces styled with Workflowy's native styling. While it is designed to be minimal and seamless from
the user's perspective, it ensures that all text-based content sent to Workflowy servers is encrypted with AES standards so that your sensitive content can **only be read by you**.

## Getting Started
After installing the extension via [Chrome Web Store](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib), follow the steps below to get started:
1. Visit [workflowy.com](https://workflowy.com/) and follow the on-screen instructions to set up your encryption key.
2. Add a `#private` tag to any node you want to secure. All sub-nodes of the selected node, including the ones you will add later, will be encrypted automatically.

And that's it! Encrypted nodes will be readable only from web browsers that have Workflowy Encrypter installed. Try to use a different device or disable the extension temporarily to see the magic!

[![Available in the Chrome Web Store](https://developer.chrome.com/static/docs/webstore/branding/image/UV4C4ybeBTsZt43U4xis.png)](https://chrome.google.com/webstore/detail/workflowy-encrypter/fohbpcookddpmmhpmgoogodlanhikeib)

## Screenshots
Here are some screenshots to better understand the extension's functionality and interfaces.
Extension interfaces are styled with Workflowy's native styling, as seen in the decryption confirmation popup below. (For further information, this popup appears when you delete a #private tag
to ensure it has not been deleted by mistake.)

![ConfirmDecryption](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/6888503e-42b2-4fa4-b572-4d2b53fa8634)


For a given sample data, the view seen from the client side is as given below:

![Client](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/c504b30a-b3f6-4cdc-9ee0-d857064c99e6)

For the same data, the following image shows what is seen from the server side:

![Server](https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/dfc503c9-f427-4317-bd19-4e0c0448e7df)

And here is a GIF showing how your data is encrypted in real-time:

<img src="https://github.com/alpafyonluoglu/WorkflowyEncrypter/assets/60400842/d1aa782e-4a00-4eb6-920b-994d87a42490" alt="Workflowy Encrypter Demo" width="640">

## Manual Installation
If you prefer to install from the source code instead of the Chrome Web Store, follow the steps below to perform a manual installation.
The extension is built for Chromium-based browsers; other browsers are not currently supported.
1. Download and extract the extension files.
2. Visit your browser's extensions page. ([chrome://extensions](chrome://extensions) for Google Chrome, [edge://extensions](edge://extensions) for Microsoft Edge)
3. Enable developer mode.
4. Click on "Load unpacked."
5. Select the folder containing extension files.  

## Data & Privacy
Workflowy Encrypter does not collect data from any user; there is not even a remote server dedicated to this extension. All processing is done locally on your device and shared with
neither the developer nor any third parties.

## Note
As this is a third-party extension, full compatibility of the extension with the Workflowy website is not the case, and bugs may still be encountered. In those cases, simply force-reload
the page by pressing Ctrl+Shift+R on Windows and Command+Shift+R on Mac. If the issue persists, do not hesitate to contact me, open an issue here on GitHub, or better yet, open a pull request
if you are a developer. Contributions are much appreciated!

## Roadmap
Known issues and feature ideas are tracked in the [Issues](https://github.com/alpafyonluoglu/WorkflowyEncrypter/issues) section. These items serve as a backlog to help guide future development efforts.

## Contributing
All collaborators are welcome to contribute to the project in any constructive way as long as they comply with the code of conduct.

## License
This project is licensed under the MIT License. See the [LICENSE](/LICENSE) for details.

## Contact
Have something on your mind? I would be happy to hear from you! Feel free to [shoot me an email](mailto:contact@alpafyonluoglu.dev) or [drop a message on social media](https://alpafyonluoglu.dev/) for any questions, suggestions, or just to say hi :)
