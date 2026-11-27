# Zero-Install Exam Proctor

A zero-install, static HTTPS web proctoring wrapper (`index.html` + `setup.html` + `apps-script/Code.gs`) for Google Forms. Works on Android Chrome, iPhone/iPad Safari, and Windows/macOS Chrome & Edge with no APK sideloading or build step.

## 3-Step Teacher Quickstart

1. **Host Static Files on HTTPS:** Serve this repository (for example, via GitHub Pages or any static HTTPS host) and open `setup.html`.
2. **Connect Google Sheet & Gmail Alerts (Optional, 1 Minute):**
   - Open your Google Form's **Responses -> View in Sheets** spreadsheet -> **Extensions -> Apps Script**.
   - Paste the script from `apps-script/Code.gs` (or click **Copy Apps Script** in `setup.html`).
   - Run `authorizeEmailAlerts()` once in the Apps Script editor to grant `MailApp` permission, then **Deploy -> New deployment -> Web app** (*Who has access: Anyone*) and paste the Web App URL into `setup.html`.
3. **Generate & Share Encrypted Exam Link:**
   - Enter your Exam Title, full `https://docs.google.com/forms/d/e/.../viewform` URL, Exam Access Key (announced at exam start), Teacher Unlock Key, Max Strikes, Violation Mode, and Allowed Devices.
   - Share the generated `index.html?exam=...` link with students. Use the **Forensic Stealth Watermark Decoder** in `setup.html` to amplify leaked screenshots if needed.

## Security & Proctoring Layers

- **AES-256-GCM Encrypted Exam Envelope:** Exam URL and webhook URL remain encrypted until the student enters the Exam Access Key.
- **Environment & Anti-AI Guards:** Blocks `navigator.webdriver` automation, in-app WebViews (`WhatsApp`, `Instagram`, `Claude`, `; wv`), external monitors (`screen.isExtended`), desktop side-panel/split-view squeezes, duplicate tabs (`BroadcastChannel`), and extension DOM injections (`MutationObserver`).
- **Webcam & Mic Liveness:** Rejects virtual cameras (`OBS`, `ManyCam`, `Snap Camera`, `fake_device`), flags covered lenses and sustained speech spikes, and attaches optional low-res JPEG snapshots to strike/lockout alerts.
- **3-Layer Click-Through Stealth Overlays:** Chromatic blue-channel candidate watermark (`#stealth-watermark-layer`), AI academic-integrity canary (`#ai-canary-layer`), and sub-pixel Moire shield (`#moire-shield-layer`) protected by a self-healing `MutationObserver`.
- **Answer-Preserving Lockout:** Hard lockout hides `#exam-iframe` strictly via CSS (`visibility: hidden; pointer-events: none`) so student answers inside Google Forms survive Teacher Unlock.

## Running Tests

Requires Node.js 24+ (zero npm dependencies):

```bash
npm test
```
