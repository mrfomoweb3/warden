# SPEC: Warden demo film, storyline A "The 2 a.m. loop"

GOAL:    a judge understands in under 2 minutes that Warden watches AI agents' payments on Sui, stops a looping agent on-chain by itself, and learns from the owner's replies; they remember "your agents can spend, Warden watches".
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps, MP4.
TIME:    104 s x 30 fps = 3120 frames. Narrated: the HeyGen voice (Lachie) is the clock; each beat lands on its anchor word (assets/voice/L01-L14.words.json).

LOOK:
  ground  the brand's own photograph: assets/img/sky.webp (blue sky) with assets/img/grass.webp (grass cut-out) across the bottom 22% of frame.
          Night variant for the 2 a.m. scenes: the same sky graded through media-treatment (exposure -1.7, temperature -0.4, saturation -0.35), never a black void.
  ink     #111111 on light; #FFFFFF on the night sky and on the terminal.
  accent  olive #5F6F2E (Warden, "allow", learned rule) and maroon #8C3B3B (the loop, "paused"); one accent per shot.
  display Instrument Serif 400 (assets/fonts/instrument-serif.woff2), titles 120-150 px, tracking -3%, leading 0.95.
  body    Inter 500, 34-44 px for read text; UI captions never under 28 px.
  mono    JetBrains Mono 500, 30 px, for the terminal and code (real output only).
  medium  real product material: the user's Telegram screenshots and screen recording, captured pages (landing, dashboard, Suiscan) at 2x, the real Move source.
          Cards are white #FFFFFF, radius 28 px, shadow 0 24px 60px rgba(30,50,70,0.22). The terminal is #141413, radius 24 px.
  light   no grain, no glow; 0% vignette on day scenes, 10% on night scenes via the grade.

OBJECTS:
  terminal  real `[rogue] paid http://localhost:4021/search?vendor=search&q=retry (tx …)` lines and `[rogue] vault blocked payment …` lines, a big tally counter beside it.
  phone     the user's real Telegram screenshots/recording inside a phone frame: black body, radius 64 px, 18 px bezel, 1080 px tall on screen.
  vault     the real `public fun pause_agent` source from packages/vault/sources/vault.move.
  chain tx  the Suiscan capture of FimJPaM3…pju8: "Success", call function "pause_agent", Warden's sender address.
  memory    the real incident record and the real Fly log line "restored 17 records from Walrus Memory".
  mark      the Warden mark from the site (assets/img/warden-mark.svg), four black shapes.

MOTION:
  enter   power3.out, 16-20 frames; exit power2.in, 10-12 frames; camera moves power2.inOut, 15-18 frames with 6-10 px blur at peak.
  punch-in to a detail: scale 1 -> 1.6-1.9 over 18 frames, then hold dead still while it is read.
  type    land then hold; no drift after landing. Terminal lines arrive one per 4 frames (looping), counter ticks with them.
  transitions (5 kinds, each caused): whip (hook -> tension), colour flood night -> day (reveal), zoom through the phone notification (reveal -> vault),
              object becomes the world (phone grows into the Telegram scenes), dip cut (back to 2 a.m.), blur swap on one stage (tatum <-> walrus).

SHOTS (scene start-end s, voice line):
  01 hook     0.0-8.4    L01  night sky; terminal fills 62% width, lines already flowing at frame 0; tally 21 -> 30 hits on "Again. And again."; phone buzz at frame edge.
  02 tension  8.4-20.2   L02-L03  whip in; "x402" type lands on its word; the old way: an alert card arrives late, AFTER the counter, maroon "after the money moved".
  03 reveal   20.2-26.4  L04  the buzzing phone fills frame; colour flood night -> day; WARDEN in Instrument Serif 150 px lands on "Warden"; tagline on "watchdog".
  04 vault    26.4-34.8  L05  zoom through the notification into the real Move source; punch-in on `s.paused = true;` on "pause on-chain".
  05 rule     34.8-42.2  L06  phone grows in; PLACEHOLDER (labelled) until the user's rule-reply screenshot arrives; caption "Block anything over $1/day -> on-chain cap".
  06 ask      42.2-47.8  L07  real screenshot tg-questions-full.png; punch-in on the 💬 explanation on "explains why".
  07 learn    47.8-54.2  L08  the real screen recording; the tap on Always allow and "Learned rule_002" land on "becomes a rule".
  08 pause    54.2-64.0  L09  dip cut back to night; terminal tally hits 30 on "Thirty"; PLACEHOLDER (labelled) pause alert until the user's screenshot arrives; "No human." holds.
  09 blocked  64.0-74.2  L10  "vault blocked payment" lines stack, tally 1 -> 69 on "sixty-nine"; cut to the Suiscan capture, punch-in on "pause_agent" + sender on "Warden's own key".
  10 tatum    74.2-80.4  L11  day; the real ListTransactions call (packages/shared/src/vault.ts) with the vault object id highlighted on "one query".
  11 walrus   80.4-90.0  L12  blur swap; the real incident memory card, then the Fly log line "restored 17 records from Walrus Memory" lands on "restored itself".
  12 payoff   90.0-96.4  L13  the dashboard capture; questions-per-day bars; label "Simulated 14-day run" unless the live curve is ready.
  13 end      96.4-104.0 L14  grass rises; the mark is carried in by its four shapes assembling, wordmark wipes in, CTA "usewarden.fly.dev" + "github.com/mrfomoweb3/warden" holds 3 s.

SOUND:   voice at 1.0; HeyGen catalog bed "minimal tense pulse into calm bright resolve" at 0.14 under voice, ducked to 0.10 on L09-L10;
         the pulse is the 2 a.m. world, it opens on the reveal; clicks only on real taps (learn scene); one riser into the end card mark.

BANNED:  dark navy void; glow, particles, lens flares; purple/blue gradients, glass cards; cream paper + serif + mono caps labels; everything centred;
         everything fading-and-sliding up; text that drifts after landing; three cards in a row; KPI grids; title over a dimmed screenshot;
         docked corner logo; invented UI or numbers; any Telegram screen not from the user.

QA:      0.0 (thumbnail: terminal + tally on night sky), 6.5 (tally 30), 22.5 (WARDEN title on day sky), 31.5 (pause_agent punch-in),
         45.0 (💬 explanation readable), 51.5 (Learned rule visible), 60.0 (pause), 70.0 (69 + Suiscan), 77.0, 86.0 (restored 17 records),
         93.0 (chart + simulated label), 101.0 (end card).
