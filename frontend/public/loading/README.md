# Loading-screen artwork

Drop `load-1.webp` … `load-8.webp` here. They rotate behind the mode loader (the bottom-left
counter you see after PLAY), crossfading every 7 s with a slow Ken Burns push.

**Nothing needs wiring.** `index.html` probes `load-1` through `load-8` and rotates only the ones
that actually load, so you can ship two now and six later. A slot with no file is skipped, never
shown as a black flash.

- **Size:** 1920 × 1080 (16:9). Full-bleed, `background-size: cover`.
- **Composition:** the facts sit **top-left** and the % counter **bottom-left**, both white over a
  scrim weighted to the top and bottom edges. Keep the **left third** calm; put the subject
  right-of-centre.
- **Budget:** UI art — NOT the 24 MB texture cap. ~150-250 KB each as WebP.

Prompts live in `docs/context/asset-requests.md` under R7.
