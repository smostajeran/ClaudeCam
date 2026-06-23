# ClaudeCad

Integrate Claude into Autodesk Fusion 360 to design parametric 3D models from a chat conversation.

You describe a part, Claude analyzes the requirement and asks clarifying questions, builds the model **sketch-first and parametric**, then asks you to approve before finishing — and can discard the session's work to start fresh.

The add-in lives in [`ClaudeCad/`](ClaudeCad/). See [`ClaudeCad/README.md`](ClaudeCad/README.md) for install, configuration, and architecture.

```
ClaudeCad/
├── ClaudeCad.manifest      # Fusion add-in manifest
├── ClaudeCad.py            # entry point (run/stop)
├── claudecad/              # add-in package (agent, tools, cad, ui, dispatcher)
└── resources/palette/      # chat UI (HTML/CSS/JS)
```
