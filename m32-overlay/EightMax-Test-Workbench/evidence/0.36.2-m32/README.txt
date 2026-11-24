EightMax Test Workbench 0.36.2 Milestone 3.2 - development evidence (evidence/0.36.2-m32)

stage1-baseline-verification-M31.json   the Milestone 3.1 ZIP (SHA-256, CRCs, every SHA256SUMS.txt entry), its executables and the
                                        EightMax 5.1 engine, and which operator files were (and were not) available
baseline-M31-linux-node-tests.tap       complete Node suite of the UNMODIFIED Milestone 3.1 tree on the Linux development machine
operator-T5-timeline.json               T5 of the operator's Milestone 3.1 run reconstructed from the host request log of the operator PC:
                                        facts read from the log, inferences labelled as such
operator-T5-requests-excerpt.txt        the T5 lines of that log, unchanged, with seconds since the start of T5
repro-T5-paused-M31-before.json         tools/repro-paused-target-lost-0362m32.cjs on the Milestone 3.1 tree: DEFECT REPRODUCED
                                        (paused table, closed window -> lifecycle ACTIVE, scheduler unavailable [] - the operator's message)
repro-T5-paused-M32-after.json          the same tool on the Milestone 3.2 tree: REPAIRED (TARGET_LOST by the health monitor, [2])
ci-click-analysis-M3-M31.json           every button press of the Milestone 3 / 3.1 Windows CI runs paired with the test table's verdict
m32-linux-full-suite.tap                complete Node suite of the final Milestone 3.2 tree (Linux)
windows-ci-*.json                       Windows CI runs of Milestone 3.2 (development and final), summarised
The fake-host runs are logic evidence only; Windows evidence comes from the Windows CI runs and, pending, from the operator PC.
