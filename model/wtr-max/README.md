# AOOSTAR WTR MAX point-cloud model

`build.py` builds WTR (Oren's AOOSTAR WTR MAX, Ryzen 7 PRO 8845HS) in Blender at real size, samples it into the
point cloud described in `client/src/viz/machine/types.ts`, and writes `client/public/wtr-max/{model.json,points.bin}`.

```sh
blender -b --factory-startup --python model/wtr-max/build.py -- \
  --out client/public/wtr-max --points 400000 --blend <scratch>/wtr-max.blend   # ~45 s
node model/wtr-max/check.mjs                                                    # contract checks + per-part table
python3 model/wtr-max/preview_points.py --dir client/public/wtr-max --out p.png [--view rear] [--xray|--exploded] [--parts]
blender -b <scratch>/wtr-max.blend --python model/wtr-max/preview_solid.py -- --out <dir> --views cam,rear,cutaway
```

Blender frame while modelling: Z up, front faces -Y. Export frame (the contract): `x = bx, y = bz, z = -by`, origin at
the centre of the footprint on the floor. Every number in `build.py` is millimetres in the *Blender* frame.

## Research: what the real machine looks like

Photos were downloaded to a scratch folder and read as images; nothing was executed. "Verified" means seen in a photo or
read from the machine on 2026-10-22; "inferred" means a judgement call, listed so it can be corrected.
Note on process: in the first pass only the three AOOSTAR marketing renders loaded in my image viewer; the NASCompares
review photos were refused, so the first version of this table rested on the review's text plus the renders. I re-read the
photos afterwards and checked the table against p/32, p/42, p/61, p/69, p/74, p/78, p/86, p/88, p/98 and p/105: they agree
with it (corrections are folded in below). Not re-read: p/43-47, p/50, p/51, p/55, p/60, p/106.

Sources (all NASCompares photos are in the pages below; "p/NN" = `.../2025/06/Aoostar-WTR-Max-NAS-Review-NN-scaled.webp`):

- NASCompares review: https://nascompares.com/2025/06/27/aoostar-wtr-max-nas-review/ (front p/32, p/60, p/55, p/105 with LEDs lit;
  sled p/61, p/98; empty cage p/69; rear with the fan plate open p/74; bottom/board p/86, p/88; label p/78; rear p/42; ports p/43-47; vents p/50, p/51)
- NASCompares launch article (photos + AOOSTAR marketing renders of the sled, base fan and cooler):
  https://nascompares.com/2025/04/21/aoostar-wtr-max-powerhouse-nas-big-update/ (`2025/04/AOOSTAR-WTR-Max-11-Bay-NAS-{1,2,3,4,5}-scaled`, `-News-5`, `-News-9`)
- Liliputing: https://liliputing.com/aoostar-launches-a-cheaper-wtr-max-11-disk-nas-with-an-intel-alder-lake-u-processor/ (249 x 245 x 195 mm)
- Notebookcheck launch coverage (7 bays: six 3.5" + a bay with four M.2 + one internal slot):
  https://www.notebookcheck.it/Aoostar-WTR-Max-lancia-un-nuovo-NAS-a-11-alloggiamenti-con-APU-AMD-Ryzen-e-porta-OCuLink.991236.0.html (via search summary, not opened)
- Owners' thread (bottom cover = four hex screws; board photo): https://forums.overclockers.co.uk/threads/the-official-aoostar-wtr-max-nas-thread.19004608/
- AOOSTAR Intel variant page (280 W PSU in the box, 4 fans, VC heat sink): https://aoostar.com/products/aoostar-wtr-max-intel-1235u
- The machine itself over ssh (read-only `lspci`, `dmesg`, `/sys`, `dmidecode`).
- Not found / not reachable: the AOOSTAR AMD product page (404), the official manual and teardown video, starryhope.com (no results), YouTube thumbnails (not fetched).

### Findings

| Topic | Finding | Status |
|---|---|---|
| Size | 249 x 245 x 195 mm (Liliputing; an earlier article said 250 x 242 x 190). Which number is which axis: width 249 (front aspect ~1.3), depth 245 (underside is almost square), height 195 incl. 8 mm feet | sizes verified, axis assignment inferred from photos |
| Front | Seven vertical (portrait) trays in a row, 31 mm pitch, 27 mm wide, recessed ~6 mm behind a rounded dark bezel. **The M.2 sled (the "4SSD bracket") is the leftmost tray seen from the front**; bay 1..6 run left to right after it. Its front carries an orange "prohibited" sticker (p/32, p/61, p/105). Oren's own unit (photo, 2026-10-22, relayed by the coordinator) shows the sticker text: "Do not insert this tray (4SSD bracket) into any other position. This position does not support hot-swapping", with the six HDD trays to its right all populated | verified |
| Tray design | Light-grey anodised plate (79 mm) above a black latch housing (25 mm) with a recessed push button; in p/61 the sled's plate is held open on a hinge. 3.5" drives stand on edge; the sled is a tray carrying a PCB with four M.2 sockets side by side, all four populated in the reviewer's photo (Phison, Kingston KC3000 with heatsink, a bare stick, an Acer with a green pad), and a PCIe-style edge connector at the back (p/98). The backplane's leftmost connector is a wider PCIe-style one, the six to its right are SATA (p/69), so that position cannot take a plain SATA drive | verified |
| **Bay LEDs** | **Yes: two small LED windows under every latch (7 trays, 14 total)**, the left one lit green and the right one dim/unlit on most trays in p/105, both dark in the other shots. Meaning (power/presence + activity) is inferred. The ASM1166 AHCI controller reports the activity-LED capability (`dmesg`: `flags: ... led ...`) but Linux exposes **no** LED or enclosure device for them (`/sys/class/leds` only has the `igc` NIC LEDs, no `/sys/class/enclosure`), so a physical "identify" blink is not something the OS can do. An on-screen identify (pulse the bay) is the realistic version | LEDs verified, control path verified absent |
| Front panel | Lower strip (p/32, p/69): black glass secondary LCD (~92 x 40 mm, left), full-size SD slot, USB-A (blue, 3.x), USB-C, round power button with blue ring, gold "AOOSTAR" + "WTR MAX" plate (right). No front status LEDs besides the tray LEDs and the button ring | verified |
| Rear | Upper plate: black, two louvred 92 mm fan fields, 8 bosses, two thumbscrews. Lower strip (black) I/O, seen from behind left to right: 3.5 mm audio, HDMI over DisplayPort, 2x USB-A (blue), OCuLink, USB4 (Type-C, vertical), RJ45 "2", RJ45 "1", SFP+ "10G" x2 (with "ACT/Link" LED dots), DC jack. Seen from the front that is: audio on the right, DC on the left | verified (p/42-47) |
| Power | **External brick**, 19 V 14.7 A (~280 W) per the underside label (p/78) and the review. No internal PSU, so there is no `psu` part | verified |
| Fans | Two **92 x 92 x 25 mm** rear exhaust fans on a hinged plate (82.5 mm hole spacing measured from p/42; fan frame photographed in p/74). One slim ~80 mm intake fan on the bottom cover behind the slot grid (photo in launch article, image -5). One CPU blower (review text; AOOSTAR cutaway). The sizes of the base fan and blower are inferred | rear fans verified, base fan seen but sized by eye, blower inferred |
| Vents | Both side walls: two rows of triangular perforations, rear two thirds of the lower band, fading to dots at the ends (p/50, p/51). Bottom cover: 4 columns x 18 rounded slots. Rear: the two louvre fields. Nothing on the bezel, top or I/O strip | verified |
| Layout | Two tiers. Upper ~129 mm: drive cage (7 trays, perforated side walls, ceiling grommets) and a vertical backplane with 6 SATA receptacles + one PCIe receptacle and large airflow windows (p/69), then the two fans. Lower ~60 mm: the board (silkscreen `HCAR7000-NR V0.2`), reached by removing the bottom cover (4 hex screws); its underside carries the two stacked DDR5 SO-DIMMs (front right), the internal M.2 slot (rear edge, beside the SFP+ cages, a Crucial P3 Plus fitted in p/86), a row of five VRM chokes and capacitors just in front of it, the coin cell, and, silk-screened `M2_SSD2`, a pair of fine-pitch board-to-board connectors (p/86, p/88; p/78 label reads `CPU: PRO 8845HS`, so this is the AMD board). The model has the right parts but not exact positions for the coin cell and the `M2_SSD2` connectors (it carries two placeholder sockets instead) | verified for the underside, backplane, cage; small hidden parts approximate |
| CPU / cooler | The CPU is on the top side of the board (not visible in any photo). AOOSTAR calls the cooler "Glacier Pro 1.0: VC heat spreader + 4 fans"; the review says "copper plate + low-profile active cooler". Modelled as a copper VC plate + fin stack + blower toward the left side vents. **No heat pipes are evidenced, none are modelled.** Position of the package, X710, I226-Vs and ASM1166 on the board is inferred | inferred |
| M.2 | **Five slots: four on the sled (leftmost tray, the 4SSD bracket) + one on the board underside.** AOOSTAR's cutaway labels the sled sticks `PCIe4.0x2, x2, x1, x1` and the board slot `x2` (3 x PCIe 4.0 x2 + 2 x x1 in the spec). From the machine: the three installed NVMe drives are on root ports `00:01.2` (SPCC 256 GB), `00:01.3` (SN850X) and `00:02.6` (SN850X HS), all negotiated x2; `00:01.1` (x4, nothing attached) is the OCuLink port. **Oren's recollection (2026-10-22, corrected from an earlier version the same day): the boot SPCC is on the motherboard; the two SN850X are probably in the left 4-SSD bracket.** That matches the lane evidence (the sled's two x2 slots plus the board's one x2 slot) but is not physically verified (`lspci` cannot say which slot a drive is in). Only one populated underside socket appears in any photo (p/86) | slot count/location verified; **which stick is in which slot is Oren's recollection plus lane evidence, not seen** |
| Finish | Anodised aluminium: gunmetal grey shell and base, darker front plate, lighter grey tray plates, black rear plates and I/O strip, gold lettering, four round aluminium feet (~42 mm, 8 mm tall) with rubber pads | verified |

### Slot / device map used by the model

| key | place | lanes | holds | basis |
|---|---|---|---|---|
| m2s1 | sled | x1 | empty | AOOSTAR cutaway order (x2, x2, x1, x1) and no NVMe device on a spare root port |
| m2s2 | sled | x1 | empty | same |
| m2s3 | sled | x2 | WD_BLACK SN850X HS 2TB (heatsink) | Oren, probable (2026-10-22); x2 link |
| m2s4 | sled | x2 | WD_BLACK SN850X 2TB | Oren, probable (2026-10-22); x2 link |
| m2s5 | board underside, rear edge | x2 | SPCC 256GB (boot) | Oren, recalled (2026-10-22); x2 link; one populated socket seen in p/86 |

Which drive is on which PCIe root port is real (see above); which physical slot it is in is Oren's recollection, so the
dashboard should not rely on it. Pulling the sled and seeing which `nvme` device disappears would settle it.
Which of the sled's two x2 slots holds which SN850X, and which sled position is x2 versus x1, is not known at all; the
model puts the HS stick in `m2s3` and the plain one in `m2s4`.

## Model

| part keys | what is in them |
|---|---|
| `shell` | bezel (rim + dark front plate with the tray opening), top shell, base with side vents, bottom slots, rear I/O panel with port cut-outs, rear fan plate with louvres, drive cage (side-wall ovals, ceiling grommets, floor rail slots), chassis plate, feet, front LCD glass border (the dark frame around the screen), SD/USB/USB-C slots, power button, gold logo text |
| `bay1`..`bay6` | tray front plate, latch housing + button, **the two LED windows**, rails, the WD Red Plus drive (label, PCB side, SATA plug) |
| `m2sled` | tray front + latch + LED windows, label, carrier plate with holes, carrier PCB, edge connector |
| `m2s1`..`m2s4`, `m2s5` | M.2 socket + standoff, plus a stick (PCB, packages, label; heatsink on the HS one) where populated |
| `backplane` | PCB with airflow windows, 6 SATA + 1 PCIe receptacle, electrolytics, ICs |
| `board` | PCB, X710 + heatsink, I226-V x2, ASM1166, SPI, MLCC scatter, standoffs, VRM chokes + caps, coin cell, spare M.2 sockets |
| `cpu` | FP7 package + die, copper VC plate with spring screws, fin stack |
| `ram1`, `ram2` | DDR5 SO-DIMMs: PCB, 8 packages, label, stacked socket |
| `fan1`, `fan2`, `fan3`, `fan4` | rear fan right/left (frame, hub, 9 swept blades), base fan, CPU blower |
| `lan1`, `lan2`, `sfp1`, `sfp2`, `io` | RJ45 jacks, SFP+ cages with open mouths (+ their LEDs), and audio / HDMI / DP / USB-A x2 / OCuLink / USB4 / DC |
| `led` | the power button's LED ring |
| `lcd` (kind `screen`) | the front screen's active area as an exact 240 x 94 dot grid, see below |

Sampling (default `--points 400000`): every part's final triangles (after booleans, so perforations are gaps) are bisected
to <= 6 mm and each piece is classified Exterior or Interior with BVH rays (Exterior = at least a third of the
outward-facing directions escape the closed machine; sharp-edge pieces are classified the same way). Dart-throwing
Poisson-disk then runs separately on each class, so the budget is explicit:

- Interior points are held at fixed absolute counts per part (`INT_BASE`, about 150k at 400k: hidden drive bodies, board,
  backplane, cooler, DIMMs, fans, ports ~128k, plus the shell's inner skin thinned to ~21k = 5 %). They scale only if `--points` changes.
- Everything else (~250k, 62 % of the cloud) is Exterior: shell outer faces, bezel, tray fronts + latches + LED windows,
  front panel, logo, power ring, rear plates, port mouths. It is split by Exterior area (weighted by each object's
  `dens`, square-rooted), so logos, LEDs and tray fronts are still denser than flat panels.
- About 12 % of each class sits on sharp edges (dihedral > 30 degrees, flagged `Edge`), so silhouettes and cut-outs stay crisp.

`tone` = material albedo x (0.28 + 0.72 x ambient occlusion^1.2), AO from 12 BVH rays up to 4 cm. Points are shuffled
inside each part. The manifest camera is fitted to the Exterior points and centred on their projected extent: the case
spans about 90 % of a 16:9 frame's limiting axis (fov 32 deg vertical).

### Front LCD (`lcd`, `manifest.screen`)

- **Resolution:** the panel is 960 x 376 pixels (RGB565) according to the community protocol tool for this screen, `aoostar-rs` /
  `asterctl` (https://github.com/zehnm/aoostar-rs; the figure appears in its FreeBSD port description
  https://reviews-dev.freebsd.org/R11:fef6a773980fdd4da85c453aac2af69f5acea9a8). Not an AOOSTAR spec, and not measured by me.
  The model uses a clean quarter of it: **240 cols x 94 rows = 22,560 dots**, which keeps the dot pitch square at the panel's 2.553 aspect
  (pitch 0.3583 mm).
- **Physical size:** the glass (dark rounded rectangle) is 91.5 x 40 mm, measured against the 249 mm case width in p/32 and p/69 and
  centred 69.5 mm left of the case centre, 40.1 mm up from the base of the bezel plate. The active area, 86.0 x 33.68 mm, is that
  aspect fitted inside the glass (~2.7 mm side and ~3.2 mm top/bottom border): **the border width is inferred**, the photos show only a
  black glass face. The border stays in `shell`; the active area is its own part.
- **Grid:** `manifest.screen = { part: "lcd", origin: [-0.1125, 0.0569417, 0.12195], u: [0.086, 0, 0], v: [0, -0.0336833, 0], cols: 240, rows: 94 }`.
  Dot (c, r) is at `origin + (c + 0.5) / cols * u + (r + 0.5) / rows * v`, in the plane of the glass's front face (z = +0.12195 m), normal +z,
  flags Exterior only (no Edge), tone 0.9. The points are in row-major order and unshuffled: point k of the part is dot c = k % 240, r = floor(k / 240).
  `check.mjs` verifies every dot against the grid (within half a 16-bit quantisation step, about 2 micrometres) and that each of the 22,560 dots appears once.
- `lcd` has `center` / `size` from its glass slab (86 x 33.7 x 0.95 mm), `socket` at the centre of the glass, no `slide`, and the same `explode` as `shell`.
  Its points come on top of the `--points` budget, so the default export is 400k sampled points + 22.6k dots.
  The Edge share (11.5 % overall) counts the dots; among the sampled points it is still 12.2 %.

Things worth knowing when drawing it:

- Cull back-facing points (normal away from the eye) and depth-test against a tangent-plane splat; the shell is a thin
  sheet so its inner skin would otherwise show through.
- Only `Exterior` points make up the closed-case look (~64 % of the cloud, ~272k including the 22.6k LCD dots). The default build takes ~45 s;
  `--points` scales both budgets linearly if you want more or less.
- `explode` offsets are in the contract frame, metres: shell +26 cm up, trays fan out forward, board drops, cooler and blower lift
  off the board, DIMMs and the board's M.2 hang below it, rear fans move back, backplane moves back, ports follow the board.
  `check.mjs` asserts no two part boxes overlap once exploded.
- Flow anchors (spread 4-7 cm apart along the physical route, not bunched): `sata` (ASM1166, right-rear of the board, closest
  to the backplane), `bus` (partway toward the front edge), `cpu` (package), `nicbus` (between the X710 heatsink and the two
  I226-Vs near the rear I/O). Also `led1..led6`, `ledsled` (centre of each tray's LED pair), `power`, `dcin`, `backplane`,
  `sledconn`, `ram`, `m2board`. The six drive sockets are the SATA plugs at the backs of the drives, 3.1 cm apart (the tray pitch).

## What did not fit the contract

- `shell` is one part, so "shell panels lift and spread" is one lift vector for the whole case (the bottom cover, rear plates, bezel and feet all go with it).
- There is no per-LED addressing. The bay LEDs are in the bay parts (so they slide with the tray); `led` is only the power ring. Use the `led1..6`/`ledsled` anchors for a marker.
- `m2s1`..`m2s4` also carry `slide` (same as the sled) so the sticks travel with the carrier.
- No `psu` part (external brick). No field says whether an M.2 slot is populated; empty slots just have fewer points.
- `io` is a composite spread across the rear, so its box is wide and overlaps the box of `lan`/`sfp` at rest.
