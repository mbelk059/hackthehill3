# Bunny Buddy

Bunny Buddy is a screen-share study tutor. A Chrome extension shares the tab you are studying, listens while you talk, and answers in a pixel bunny's voice. A webcam check notices when you look away or seem stressed and changes how the bunny talks. A website logs those moments and charts them.

Screen frames and webcam images stay on your computer. The site only stores session times, focus changes, and question counts.

## What it does

Open a normal study site, click the Bunny Buddy icon, and press **Let's go!** in the side panel. The bunny can see that tab and hear you. Ask a question and it replies with one short hint, not the full solution, in the language you just spoke. The reply text shows up when the voice starts.

Three modes:

| Mode | When it turns on | How it sounds |
| --- | --- | --- |
| Bunny Buddy | Default | Warm and steady |
| Strict Bunny | Your face leaves the camera, or you ask to lock in | Faster, flatter, and blunt |
| Nice Bunny | A stress reading comes in, or you ask it to be nicer | Slower and gentler |

Say **stop** or **arrête** to cut the bunny off. Say **slow down** or **speed up** to change the pace. Say **lock in**, **be a little nicer**, or **bunny buddy** to switch modes yourself. **Stop** ends the session.

Looking away means the camera cannot find a face. A face that is still in frame, even if it is dark or turned, stays focused. Stress uses Presage's Baevsky heart-rate reading. The first reading usually needs about 30 seconds with your face in frame.

The website login and the extension login are separate. Sign in on the site for the dashboard, and sign in from the side panel before **Let's go!**.

## Architecture

```
study tab
    |
    |  click the toolbar icon, then Let's go
    v
Chrome extension (MV3)
    side panel     bunny, mic, and the voice you hear
    background     Auth0 login and tab-capture permission
    offscreen      Gemini Live, ElevenLabs speech, webcam frames
    |
    |  JPEG frames over WebSocket
    v
Presage sidecar (ws://127.0.0.1:8787)
    SmartSpectra focus + stress
    |
    |  session, attention, and question events
    v
Next.js site (http://localhost:3000)
    Auth0 for the website
    Gemini token and ElevenLabs config for the extension
    Tiger Data, or web/data/store.json when DATABASE_URL is empty
    dashboard chart
```

The extension is pinned to `http://localhost:3000` and `ws://localhost:8787` in `extension/config.js`.

Gemini Live receives tab frames and your microphone audio, and answers with audio plus a transcript. ElevenLabs speaks that transcript. The audible voice plays only in the side panel.

## Resources

- **Gemini Live** answers questions about the shared tab. The site mints a short-lived token. The model is `gemini-3.8-live`.
- **ElevenLabs** speaks the replies with the Jessica voice (`eleven_flash_v2_5`). Strict and Nice use the same voice with different pace settings.
- **Presage SmartSpectra** reads the webcam in the local sidecar and reports focus and stress.
- **Auth0** signs in the website and, separately, the extension. Both apps share one tenant and the API audience `https://studybunny.api`.
- **Tiger Data** stores sessions, attention events, and question counts. Without `DATABASE_URL`, the same records go to `web/data/store.json`.

## Run

From the repo root:

1. `npm install` in `web` and in `presage-sidecar`.
2. Copy `web/.env.example` to `web/.env.local`. Set `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and the Auth0 values. Leave `DEV_AUTH_BYPASS=1` only if Auth0 is not filled in yet. The audience must be `https://studybunny.api` with no trailing slash.
3. Copy `presage-sidecar/.env.example` to `presage-sidecar/.env` and set `PRESAGE_API_KEY`.
4. `npm run dev` for the site at http://localhost:3000.
5. `npm run sidecar` for Presage. You should see `Presage sidecar on ws://127.0.0.1:8787 (sdk ready)`.
6. Chrome → Extensions → Developer mode → Load unpacked → the `extension` folder.
7. In the extension's Auth0 app, allow the callback `https://<extension-id>.chromiumapp.org/`. The website uses a different Regular Web Application in the same tenant.

`npm test` runs the focus and mood-timing checks. `npm run rehearse` writes one practice session so the dashboard chart is not empty before a live study session.

Reload the extension at `chrome://extensions` after extension code changes. Click the icon while the study tab is active. Chrome's own pages cannot be shared.
