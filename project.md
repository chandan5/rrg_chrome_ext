# Project: [RRG Chart] (Chrome Extension)

## 🎯 Overview
A Chrome Extension built with **Manifest V3** that displays rrg chart of the current stock user is interested in based on current open tab.

## 🛠️ Tech Stack

- **Manifest Version:** MV3 (Strict)
- **Node Context:** v24.13.0 
- **Frontend:** Vanilla JS / HTML / CSS (or React/Tailwind if applicable)
- **APIs used:** `chrome.storage.local`, `chrome.runtime`, `chrome.tabs`


## 🤖 AI Instructions & Rules

- **MV3 Compliance:** Always prioritize Service Workers over Background Pages. Never suggest `eval()` or remote code execution.
- **Async Patterns:** Use `async/await` for all `chrome.*` API calls rather than callbacks where possible.
- **DOM Safety:** When suggesting Content Script logic, prioritize `textContent` over `innerHTML` to prevent XSS.
- **Debugging:** If I report an error, suggest `console.log` placements specific to the relevant context (Popup vs. Background vs. Content Script).


## 📂 Project Structure Note

- `/icons`: Extension icons.
- `manifest.json`: Extension configuration.
- `background.js`: The Service Worker logic.
- `content.js`: Scripts running in the context of web pages.
- `popup.html/js`: The UI that appears when clicking the extension icon.


\## 📝 Recurring Tasks

- **"New Message"**: Help me write a `chrome.runtime.sendMessage` and its corresponding `onMessage` listener. 
- **"Help me document this"**: Generate comments for the code present (especially for why or reasoning).
- **"Check for bugs"**: Review code for any bugs you can find.
- **"Permissions check"**: Review my `manifest.json` and tell me if I've requested too many or too few permissions for my features.
- **"Content Script boilerplate"**: Generate a safe content script that waits for the DOM to load before executing.

