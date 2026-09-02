# Dez — Local Podcast Recorder

A single-page, fully local audio recorder for two people recording a
podcast remotely. No server, no account, no signaling service, no
network requests of any kind at runtime — everything happens in your
browser and stays there.

## How it works

Each person runs this page independently, on their own device. There
is no connection between the two — instead:

1. Get on a call together first, however you normally would (phone,
   Zoom, Discord, WhatsApp, whatever).
2. Once you're both ready, either of you clicks **3-2-1 Countdown** —
   it plays a beep and flashes on screen.
3. You both click **Start Recording** on the "GO" beep, by eye/ear.
4. Talk your episode.
5. Each of you clicks **Stop & Download** — you each get your own
   clean local `.wav` file.
6. Sync the two tracks up in your editor afterward (most editors can
   auto-align on the beep, or you can trim by eye — it's one shared,
   distinctive sound in both files).

## Why no live connection?

An earlier version of this used PeerJS/WebRTC for a live P2P voice
call and synced recording. It turned out to be unreliable in
practice (signaling server flakiness, connection races) and, since
this is hosted publicly, it also meant relying on and trusting a
third-party signaling server. This version removes all of that:
nothing is sent over the network, ever, which is both simpler and
inherently private — there's no data path to secure because there
isn't one.

## Deploy

No build step, no server, no database — it's two static files.

**GitHub Pages:** push this repo, then in the repo's Settings → Pages,
set the source to the `main` branch / root, and GitHub gives you a
`https://<username>.github.io/<repo>/` link.

**Vercel:** `vercel deploy` from this folder, or drag the folder into
vercel.com.

HTTPS is required for microphone access — both options give you that
by default.

## Files

- `index.html` — structure
- `styles.css` — the retro reel-to-reel skeuomorphic styling
- `app.js` — Web Audio VU meter, countdown/beep sync helper, WAV
  recording/export, IndexedDB crash recovery
