# EightMax Test Workbench 0.36.2

Integration and Windows validation in progress, not yet a completed release.

The full source and preserved EightMax 5.1 native solver are transferred in base64 ZIP chunks under build-input. Windows CI restores them, compiles the Windows components, and uploads the full application tree with test evidence. The Node runtime and capture helper are built/restored by CI. See the workflow for exact steps.
