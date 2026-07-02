# Barcelona Drive — audio drop-in

Drop CC0 / royalty-free audio files here with these **exact names** and the game will use them
automatically (each is optional — if a file is missing, the game falls back to the synthesized sound,
so nothing breaks). `.ogg` is preferred, `.mp3` also works.

| File | What it is | Notes |
|---|---|---|
| `engine_idle.ogg` | Engine loop at **idle** (~800–1000 rpm) | short, seamless loop |
| `engine_mid.ogg`  | Engine loop at **mid** rev (~3000 rpm) | short, seamless loop |
| `engine_high.ogg` | Engine loop **high / redline** (~5000–6000 rpm) | short, seamless loop |
| `skid.ogg`        | Tire screech / skid loop | seamless loop |
| `ambience.ogg`    | City ambience bed (distant traffic hum) | long, seamless loop |
| `horn.ogg`        | Car horn (press **H**) | one-shot |

The three engine loops are crossfaded + pitch-shifted by RPM (the standard game technique). Even **one**
engine file works (it'll be pitched across the rev range) — three just sound best.

### Where to get CC0 clips (no attribution needed)
- Freesound — <https://freesound.org/search/?q=car+engine+loop&f=license:%22Creative+Commons+0%22>
- Freesound skid — <https://freesound.org/search/?q=tire+skid&f=license:%22Creative+Commons+0%22>
- Freesound city ambience — <https://freesound.org/search/?q=city+traffic+ambience&f=license:%22Creative+Commons+0%22>
- Pixabay (royalty-free) — <https://pixabay.com/sound-effects/search/car%20engine/>
- OpenGameArt CC0 — <https://opengameart.org/content/cc0-sound-effects>

Keep files small (a few seconds each) and loopable. Volume/mute are controlled in-game (Settings → Sound).
