# TextSim Conversation Recorder

Tool for creating realistic SMS conversation videos and downloading them as MP4.

## 1. Download The Tool To Your Computer
1. Download the `sms-convo-generator` folder (or a `.zip` of it) from the shared team location.
2. Move it anywhere on your machine (Desktop, Documents, etc.).
3. Unzip it if needed.

You should see these files:
- `index.html`
- `styles.css`
- `app.js`

## 2. Start The App
Open Terminal and run:

```bash
cd "/path/to/sms-convo-generator"
python3 -m http.server 8080
```

Then open this in your browser:
- `http://localhost:8080`

## 3. Use The App
1. Upload a conversation `.txt` file.
2. Upload a mascot image.
3. Enter sender name.
4. Click `Play` to preview.
5. Click `Record & Download` to export MP4.

## 4. Conversation File Format
Preferred format:
- `student: <message>`
- `bot: <message>`

Also supported:
- multiline messages
- option lists like `[1]`, `[2]`, `[3]`
- common label variants (`user`, `chatbot`, etc.)

Example:

```text
bot: Hey there! Welcome to Campus Connect.
student: Hi! I had a quick question about registration.
bot: Of course. What would you like to know?
student: When does spring registration open?
```

## 5. Browser Requirement
- Use latest Chrome or Edge for MP4 export.
- If export fails, update browser and retry.

## 6. Quick Troubleshooting
- If changes are not showing: hard refresh with `Cmd+Shift+R` (Mac) or `Ctrl+F5` (Windows).
- If app page does not open: confirm Terminal is still running `python3 -m http.server 8080`.
- If export fails: use Chrome/Edge and try a shorter script to test.

## Automatic deploy to Netlify

This project now includes a GitHub Action workflow at `.github/workflows/netlify-deploy.yml`.

How it works:
- Every push to the `main` branch triggers a deploy to Netlify.
- The deploy publishes this folder (`.`), which is correct for this static app.

One-time setup in GitHub (required):
1. Open this repository in GitHub.
2. Go to **Settings > Secrets and variables > Actions**.
3. Add these two repository secrets:
   - `NETLIFY_AUTH_TOKEN` (from Netlify user settings)
   - `NETLIFY_SITE_ID` (from your Netlify site settings)

After that, your update flow is:
1. Make code changes.
2. Commit and push to `main`.
3. GitHub Action deploys automatically to Netlify.
