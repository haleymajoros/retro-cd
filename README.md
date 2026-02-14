# DiscSpin 95 - Retro 90s CD Player

A nostalgic, tactile CD-player style web app that plays music via Spotify with strict **album-only** playback.

## Features
- Retro 90s Discman-inspired UI with LCD display and physical-style controls.
- Spotify PKCE authentication + Spotify Web Playback SDK integration.
- Album search and "Insert CD" flow.
- Album-only playback enforcement (no track or playlist loading UI).
- CD transport controls: Play, Pause, Back, Skip, Stop, Eject.
- Track list with active-track highlighting.
- Optional local button/insert/eject/spin sounds, with Web Audio fallback tones.
- Responsive layout for desktop and mobile.

## Setup
1. Create a Spotify app in the Spotify Developer Dashboard.
2. Add this exact redirect URI in Spotify dashboard: `http://127.0.0.1:5500/`
3. Open `app.js` and set:
   - `SPOTIFY_CLIENT_ID = "<your-client-id>"`
4. Serve the folder with a local web server (not via `file://`).

Example quick server options:
- `python3 -m http.server 5500`
- `npx serve .`

Then open `http://127.0.0.1:5500/` in browser and click `Connect Spotify`.

## Important Notes
- Spotify Web Playback requires a Spotify Premium account.
- The app only exposes album search and album context playback (`context_uri` of album), enforcing album-only behavior in app flow.

## Troubleshooting Auth
- Open the app at `http://127.0.0.1:5500/` exactly (avoid `localhost` and avoid `/index.html`).
- In Spotify app settings, ensure only `http://127.0.0.1:5500/` is used for this local test.
- If Spotify login succeeds but playback fails, confirm you are on Spotify Premium and have an active playback device permission prompt accepted.

## Optional Sound Files
Place custom audio files in `assets/sfx/`:
- `click.mp3` or `click.wav`
- `insert.mp3` or `insert.wav`
- `eject.mp3` or `eject.wav`
- `spin.mp3` or `spin.wav`

If missing, synthesized tones are used automatically.
