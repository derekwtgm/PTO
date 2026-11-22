# EightMax Test Workbench 0.36.2 — Milestone 1 (Windows compilation and executable verification)

Development branch for Milestone 1 only. Nothing here changes solver mathematics, strategy coverage, simulator features or
mouse-movement algorithms.

- `EightMax-Test-Workbench-0.36.1-Complete-Simulator.zip` (repository root): the unmodified 0.36.1 baseline,
  SHA-256 `2586ebf67103937bd6fadbfc2aa4d32a5787cf02693a8fb215876d4ea038e487`.
- `milestone-1/overlay/`: the complete set of files added or changed for 0.36.2 Milestone 1 (copied over the extracted baseline).
- `milestone-1/original-0.36.1/`: the unmodified 0.36.1 versions of every changed file.
- `milestone-1/changes-0.36.1-to-0.36.2.diff`: unified diff of the same change set.
- `.github/workflows/windows-0362-m1.yml`: genuine Windows build (`windows/Build-Executables.ps1`, .NET Framework csc, x64)
  followed by the focused Milestone 1 checks (`windows/Test-Milestone1-0362.ps1`), the existing input acceptance, a one-table
  host/capture/input communication smoke run and the existing Node regression suite with the bundled runtime.
