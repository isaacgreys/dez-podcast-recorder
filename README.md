# Dez — Double-Ended Podcast Recorder

A single-page, no-backend podcast recorder for two people recording remotely.
Each side records its own clean local WAV track; a live P2P voice call
(via WebRTC/PeerJS) lets you talk while you record.

## Usage

1. Open the page (see Deploy below for a shareable link).
2. Type a room code you and your co-host agree on.
3. Click **Join Room**. First person in becomes the host; whoever joins
   the same code second connects automatically.
4. Click **Share Link** to copy a link that auto-fills the room code —
   send it to your co-host so they don't have to type anything.
5. Once the status light turns green, click **Start Sync Record**.
   Both sides start recording locally at the same moment.
6. Click **Stop & Download** — each side saves its own `.wav` file.

## Deploy

No build step, no server, no database — it's three static files.

**GitHub Pages:** push this repo, then in the repo's Settings → Pages,
set the source to the `main` branch / root, and GitHub gives you a
`https://<username>.github.io/<repo>/` link.

**Vercel:** `vercel deploy` from this folder, or drag the folder into
vercel.com — either way you get an HTTPS link immediately (HTTPS is
required for microphone access).

## Files

- `index.html` — structure
- `styles.css` — the retro reel-to-reel skeuomorphic styling
- `app.js` — PeerJS connection, Web Audio VU meter, WAV recording/export
