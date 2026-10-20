# Scoring 4 Cricket

Live club cricket scoring: https://scoring4cricket.github.io/

- **Scorers** sign in with Google, request access, and score once the owner approves them.
- **Spectators** open a match's live link (`#live=<match id>`). No sign-in is needed.
- **Data** is saved to the *S4C Data* Google Sheet through the Apps Script in `apps-script/Code.gs`.
- **Offline** scoring keeps working at the ground without signal, and the scores sync when the signal comes back.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The app |
| `cloud.js` | Google sign-in, roles, syncing to the Sheet, and the live viewer |
| `config.js` | The Apps Script URL and Google client ID (neither is secret) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app and offline support |
| `apps-script/Code.gs` | The server code that goes inside the S4C Data sheet |

When `config.js` is empty, the app runs in **local mode** and saves on the device only.

## Owners

The owner emails are set in `DEFAULT_OWNERS` in `Code.gs`. They can be overridden with the `OWNERS` script property.
