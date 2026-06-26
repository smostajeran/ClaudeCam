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

## USM Configurator

A **separate, standalone** Fusion add-in that builds parametric **USM Haller**
modular furniture (chrome ball connectors + tubes + colour panels) from a
configuration dialog — no chat, no API key. It is independent of ClaudeCad, but
its builder **reuses ClaudeCad's CAD engine** when present for design plumbing
and materials. Lives in [`UsmConfigurator/`](UsmConfigurator/); see
[`UsmConfigurator/README.md`](UsmConfigurator/README.md).

```
UsmConfigurator/
├── UsmConfigurator.manifest  # Fusion add-in manifest
├── UsmConfigurator.py        # entry point (run/stop)
├── usm/                      # package (geometry, presets, builder, ui, addin)
└── resources/presets/        # bundled USM configurations
```
