# Demo GIF

`demo.gif` at the top of the README is recorded by an automated Playwright
script — no ScreenToGif or manual timing needed.

## Regenerate

```bash
# One-time setup
npx playwright install chromium
npm install --no-save ffmpeg-static   # full ffmpeg with GIF muxer

# Build server + client (needed by the record script)
cd server && npx tsc && cd ..
cd client && npx vite build && cd ..

# Record
node docs/screens/demo-record.mjs
```

The script spins up an isolated exotick instance (throwaway temp data dir,
port 3999), Playwright records a WebM of the 15-second flow, then ffmpeg
converts it to a palette-optimized GIF (~1.5–2 MB, 900px wide, 15 fps).

## The demo flow

Roughly 15 seconds:

1. Land on empty Edit Mode → click **Load sample data**.
2. Click a case with 📄 — description previews on the right.
3. Navigate to **New Test Run**, fill Run + Runner, check Auth + Checkout.
4. **Save & Start** → mark 3 pass + 1 fail + 1 pass.
5. **Finish Run** → land on History Detail with the summary.

## Tweaking

Everything is scripted in `demo-record.mjs`. Slow down / speed up the sleeps
between actions, change which cases get marked, or resize the viewport —
one file, one re-run.

## Alternatives if you don't want the automation

**MP4 instead of GIF** — swap the ffmpeg call in `demo-record.mjs` to output
`.mp4` (drop the palette filter, add `-c:v libx264 -pix_fmt yuv420p`) and
reference `demo.mp4` in the readme via a `<video>` tag. GitHub renders it
inline. Better compression, better colors, but no auto-loop in some readers.

**Manual recording** — [ScreenToGif](https://www.screentogif.com/) (Windows),
LICEcap (cross-platform), Peek (Linux), Kap (macOS). Follow the same 5-scene
flow above at ~15 fps, save as `docs/screens/demo.gif`.
