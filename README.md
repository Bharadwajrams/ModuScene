# ModuScene

A browser-based 3D module-building tool with **hand-gesture control**: assemble imported GLB models in a Three.js viewport, transform them with your right hand (grab / open palm / scale pose), navigate with your left, and drive all UI through an index-finger pointer. Mouse and keyboard work too.

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000 — click "Enable CV", allow camera access
npm test           # 177 unit tests (vitest)
npm run build      # production build → dist/
npm run typecheck  # strict TypeScript, no emit
```

## Controls

|Input|Action|
|-|-|
|Right hand **grab**|MOVE mode (after \~1 s hold)|
|Right hand **open palm**|ROTATE mode (after \~1 s hold)|
|Right hand **scale pose** (thumb+index touching, three fingers open)|SCALE mode (after \~1 s hold); move hand UP/DOWN from the baseline to resize|
|Left hand **1/2/3 fingers**|control axis X / Y / Z (must hold steady \~0.3 s)|
|Left hand **open palm**|pause / re-anchor the active transformation|
|Left hand **index point**|UI pointer (hover tabs, hold module rows \~1 s to select)|
|Mouse|orbit/pan/zoom viewport, click to select, inspector inputs|

## Architecture

Composition-root wiring in `src/main.ts`; subsystems talk only through the typed
event bus and the plain-data contracts in `src/core/contracts.ts`.

```
src/
├── main.ts               app bootstrap + event wiring
├── core/                 contracts (types), event bus, command router, undo/redo
├── engine-3d/            Three.js scene, object registry, selection,
│                         transform service (single execution path), camera,
│                         display adapter, GLB import/export
├── engine-cv/            computer-vision pipeline
│   ├── tracking/         webcam, MediaPipe frames, gesture classification
│   ├── interaction/      interaction controller: ONE active mode (MOVE/ROTATE/SCALE),
│   │                     1-second confirmation, left-palm pause, per-axis deltas
│   ├── pointer/          index-finger UI pointer (hover/hold targeting)
│   └── cv-engine.ts      pipeline orchestration, axis detection, viewport gestures
├── engine-ui/            shell, CV workspace overlay, Module Selector grid,
│                         inspector, asset library, toolbar
└── styles/               single stylesheet (light theme)
```

Key boundaries: the CV layer emits per-frame `CVTransformDelta`s — it never
touches Three.js. The transform service is the only code that mutates object
transforms. UI reads scene state only through the display adapter. Camera and
object transforms are strictly separated (VIEWPORT context freezes object deltas).


## Workflow

`master` carries the stable line; architectural work happens on `refactor/\*`
branches. Behavior changes must keep `npm run typecheck` and the full
test suite green; the CV interaction suites in `tests/unit/cv-stability.test.ts`
pin the gesture/handedness/stability contracts.

