# Application Manual Fields Capture

This Chrome extension captures manually filled application fields from supported
job platforms and sends them to a configured master dashboard server.

Supported capture paths:

- Greenhouse embed POST requests.
- Lever apply POST requests and the visible `SUBMIT APPLICATION` button.
- Jobvite apply capture on `https://jobs.jobvite.com/*`.
- BambooHR careers capture on `https://*.bamboohr.com/careers/*`.
- Ashby submit-button capture on `https://jobs.ashbyhq.com/*`.
- Gusto applicant form capture on `https://*.gusto.com/*` and `https://*.gusto.io/*`.
- ApplyToJob/Resumator form capture on `https://applytojob.com/*` and `https://*.applytojob.com/*`.
- Workday review-page `Submit` button capture on `https://*.myworkdayjobs.com/*`.

The real application submission is not blocked. Greenhouse/Lever network
captures run when the page reaches a submission request. Lever/Ashby button
captures wait briefly and skip logging when visible validation errors appear.
Gusto and ApplyToJob captures use the visible form fields, including grouped
address and resume upload values when present.
Workday captures only on the Review step when a visible `Review` heading,
`.css-g7hkny` review container, and `Submit` button are present.

## Dashboard server

From the project root:

```powershell
npm install
npm run server
```

Open:

```text
http://localhost:3000
```

Master workflow:

1. Sign up as a master.
2. Open **Setting**.
3. Copy the Master User ID, such as `admin`.
4. Optionally set a `BIDDER_PASSWORD`.
5. Give the bidder the server URL, Master User ID, and optional `BIDDER_PASSWORD`.

The server stores masters and logs in SQLite at:

```text
server/data/bidder-dashboard.sqlite
```

Passwords are hashed with `crypto.scrypt`; plain text passwords are not stored.

## Extension options

After loading the extension:

1. Open the extension details in `chrome://extensions`.
2. Click **Extension options**.
3. Configure:
   - Dashboard Server URL
   - Master User ID
   - BIDDER_PASSWORD, if configured by the master
4. Click **Test Connection**.

The options page shows:

- green `Success` when the server accepts the credentials;
- red `Failure` when the connection or credentials fail.

## Capture result

On successful upload, the application page shows a green toast:

```text
✓ Capture uploaded
```

On failed upload, the page shows a red toast:

```text
✕ Capture upload failed
```

When upload fails, the extension downloads a local txt fallback. Local txt files
are no longer downloaded after successful uploads.

## Install locally

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project directory.
5. Configure the extension options.
6. Reload any already-open Greenhouse, Lever, or Ashby page before testing.

The extension must be loaded before the capture event occurs.
