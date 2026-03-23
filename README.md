# remoteStorage Browser Extension

A browser extension prototype that brokers remoteStorage authentication and request transport on behalf of web apps.

The goal is simple:

- authenticate remoteStorage identities in the extension itself
- keep one or more accounts available there
- let compatible apps reuse those accounts instead of launching their own auth flow

This repository also includes a tiny demo app for local end-to-end testing.

## Repository layout

- `packages/extension/`
  Unpacked Manifest V3 extension source.

- `packages/demo-app/`
  Minimal browser app that exercises `RemoteStorage` connect/get/put/delete flows.

- `scripts/sync-rs-bundle.mjs`
  Copies the current `release/remotestorage.js` bundle from the sibling `remotestorage.js` checkout into the demo app.

- `scripts/serve-demo.mjs`
  Serves the demo app locally on `http://127.0.0.1:5173`.

- `scripts/generate-icons.mjs`
  Generates PNG extension icons from the official remoteStorage SVG logo.

## Current status

This is a working prototype, not a finished product.

What works now:

- extension-owned account authentication and storage
- active-account selection in the popup UI
- browser-side bridge exposed to web pages
- brokered `connect`, `get`, `put`, and `delete`
- real remoteStorage HTTP requests through the extension
- local demo flow using the patched `remotestorage.js` client

What is still rough:

- per-origin consent UX is still minimal
- compatibility with arbitrary third-party remoteStorage apps needs more validation
- automated end-to-end browser coverage still needs to be added
- protocol and packaging need polishing before broader distribution

## Local development

This repository currently expects to live next to a working checkout of `remotestorage.js` while the extension-aware library support is still being developed there.

### 1. Build the library bundle

From the sibling `remotestorage.js` checkout:

```bash
npm run build:release
```

### 2. Sync the demo app bundle

From this repository:

```bash
node scripts/sync-rs-bundle.mjs
```

### 3. Serve the demo app

```bash
node scripts/serve-demo.mjs
```

### 4. Load the extension

In Chromium or Chrome:

1. open `chrome://extensions`
2. enable Developer Mode
3. choose `Load unpacked`
4. select `packages/extension/`

### 5. Authenticate an account

1. click the extension icon
2. add a remoteStorage account
3. complete the auth flow
4. choose the active account

### 6. Verify the demo app

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and exercise:

- `Connect`
- `PUT`
- `GET`
- `DELETE`

## Relationship to `remotestorage.js`

The long-term path is not to rely on brittle runtime patching.

The intended production model is:

- `remotestorage.js` gains first-class support for detecting and using the extension
- apps keep using the library normally
- the extension provides the authenticated broker/session layer

This repository exists to develop and validate the extension side of that model.
