# Mapping the USM engine to the iOS (RealityKit) app

**Core idea:** the engine is the single source of truth for *where every part goes and how it is
oriented*. The iOS app should **consume the engine's transforms** and stop hand-deriving
quaternions per part — that hand-derivation is exactly what produced the glass-fitting orientation
bug. The engine's placement is validated **100% against P'X5** (position 0.000 cm; glass fittings
0.000°), so if the app applies those transforms with one consistent coordinate bridge, the fittings
are correct by construction.

```
P'X5 cartridge ──► usm-engine (solve) ──► placement.json ──► iOS app ──► RealityKit scene
   (.snx)            dock-frame solver      (transforms)       load .usdc + apply transform
```

---

## 1. What the engine gives you

`out/placement.json` — one record per placed part:

```json
{ "id":"387", "type":"glasscharnier_vorne_oben_l",
  "pos":[-49.48,-18.96,184.75],            // centimetres, P'X5 frame (Z-up, right-handed)
  "quat":[0,0,1,0],                         // x,y,z,w  world orientation
  "panelKind":"glass", "quad":[[..],[..],[..],[..]],   // panels only: 4 world corners (cm)
  "e":"live", "artNo":"10736", "name":"USM Haller, tube, 350 mm", "price":11.37, "weight":0.17 }
```

You do **not** have to do the coordinate math on device — the engine emits a RealityKit-ready
variant (metres, **Y-up**, quaternion conjugated):

- **File:** `node src/engine/export_ios.ts` → `out/placement.ios.json`
- **HTTP:** `GET http://<host>:5152/api/placement?coords=realitykit`

```json
{ "frame":"RealityKit", "units":"m", "up":"Y",
  "parts":[ { "id":"387", "type":"glasscharnier_vorne_oben_l",
              "pos":[-0.49484,1.8475,0.18957], "quat":[0,1,0,0], ... } ] }
```

The conversion is a single basis change `RotX(-90°)` for **every** part:
`pos(x,y,z)cm → (x, z, -y) m` and `quat' = qR · quat · qR*` with `qR = (-√½,0,0,√½)`. (See
`src/engine/export_ios.ts`.)

---

## 2. Integration architecture — pick one

| Option | How | When |
|---|---|---|
| **A. Batch export (simplest)** | Run `solve.ts` for a config, bundle/fetch `placement.ios.json`, app applies it. | Fixed / pre-defined configurations. **Start here.** |
| **B. Placement service** | Run `server.ts` as an HTTP service; app POSTs a config and fetches `/api/placement?coords=realitykit`. | Live/interactive configuration. |
| **C. Port solver to Swift** | Re-implement `solve.ts` in Swift. | Only if fully offline + interactive is required. Highest cost; the TS engine stays the oracle to test against. |

Recommended: **A now, B when you need live configuration.** Never re-derive transforms in Swift —
consume the engine's.

---

## 3. Applying a part in RealityKit

```swift
struct PlacedPart: Decodable { let id, type: String; let pos, quat: [Float]; let name: String? }

let s = 0.01  // (already metres in placement.ios.json; keep =1.0 there)
for p in placement.parts {
    guard let mesh = meshURL(for: p.type) else { continue }      // type → .usdc (see §4)
    let entity = try ModelEntity.load(contentsOf: mesh)

    entity.position    = SIMD3<Float>(p.pos[0], p.pos[1], p.pos[2])
    let world = simd_quatf(ix: p.quat[0], iy: p.quat[1], iz: p.quat[2], r: p.quat[3])

    // Per-MESH authored-frame correction (constant per .usdc — see §5):
    entity.orientation = world * meshCorrection(for: p.type)
    anchor.addChild(entity)
}
```

If you fetch the **raw** `placement.json` (P'X5 cm/Z-up) instead, do the basis change yourself:

```swift
let qR = simd_quatf(angle: -.pi/2, axis: [1,0,0])
entity.position    = SIMD3(p.pos[0]*0.01, p.pos[2]*0.01, -p.pos[1]*0.01)
let world = qR * simd_quatf(ix:p.quat[0],iy:p.quat[1],iz:p.quat[2],r:p.quat[3]) * qR.conjugate
```

---

## 4. type → mesh mapping

The engine emits the part `type` (e.g. `glasscharnier_vorne_oben_l`, `rohr350`). Maintain a small
manifest mapping type → `.usdc` asset. Tips:
- Many types share one mesh scaled by a dimension (`rohr350/500/750` = one tube mesh, different
  length). Parse the trailing number, or keep one asset per length.
- L/R variants (`..._l` / `..._r`) are mirror meshes — keep both assets; the engine's quat already
  encodes which way each instance faces.
- `glossary.json` (served at `/api/glossary`) gives a human label per type for debugging/QA overlays.

---

## 5. The one thing still to calibrate: per-mesh authored frame

The engine's quaternion orients the part's **dock-origin frame** (the frame P'X5 uses). Your `.usdc`
was authored in **some** local frame. If that authored frame ≠ the dock-origin frame, there is a
**fixed rotation per mesh** (`meshCorrection`) — *constant per `.usdc`, NOT per instance*. This is
the real residue of the old bug: it was being guessed per instance; it's actually one constant per
mesh.

**Calibrate once per mesh:**
1. Place one instance with `meshCorrection = identity`.
2. Compare to the same part in P'X5 (or the validated `placement.json` orientation).
3. The constant rotation that aligns them is that mesh's `meshCorrection`. Bake it into the `.usdc`
   (preferred) or store it in the manifest.
4. It then holds for **every** instance and both L/R — verify on a second instance.

Sanity check from this project (RealityKit frame): `glasscharnier_vorne_oben_l` →
`quat [0,1,0,0]` (180° about Y), `glasscharnier_vorne_oben_r` → `quat [0,0,0,1]` (identity). Front
hinges differ L↔R by 180°; **rear** hinges share one frame (mirroring is in the mesh). If your app
reproduces that, the fittings are right.

---

## 6. Checklist
- [ ] Decide A or B (start with A).
- [ ] Load `placement.ios.json` (or fetch `?coords=realitykit`).
- [ ] Build the type → `.usdc` manifest.
- [ ] Apply `position` + `orientation` from the engine; **delete** any per-part quaternion derivation.
- [ ] Calibrate `meshCorrection` once per mesh; verify L/R and a second instance.
- [ ] (Optional) panels: use `quad` corners to validate panel size/orientation; `bom` for a price overlay.
