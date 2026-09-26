# Study Mascot

Screen-share study tutor. The Chrome extension watches the current tab, the mascot answers with an ElevenLabs voice, Presage switches that voice between calm and strict, and the website charts focus in Tiger Data.

## Run

1. `cd web && npm install`, then copy `.env.example` to `.env.local` if you do not already have one.
2. Put `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, and Auth0 values in `web/.env.local`. Leave `DEV_AUTH_BYPASS=1` until Auth0 is ready.
3. For Tiger Data, set `DATABASE_URL`. Without it, events sit in `web/data/store.json`.
4. `npm run dev` from `web` (http://localhost:3000).
5. `cd presage-sidecar && npm install`, put `PRESAGE_API_KEY` in `presage-sidecar/.env`, then `npm start`.
6. Chrome → Extensions → Load unpacked → the `extension` folder.
7. If you use Auth0, add the callback printed in the popup (`https://<id>.chromiumapp.org/`) to the extension's Auth0 app. The website uses a separate Regular Web Application in the same tenant and API audience.

`npm run rehearse` from `web` writes one practice session through the same database code the API uses, so the chart is not empty before the first live study session.

Screen frames and webcam pictures are not stored.
