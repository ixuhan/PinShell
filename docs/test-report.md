# 测试报告（最近 10 次）

> 由 `scripts/test-guard.ps1` 每次运行自动追加，不手改。只留最近 10 行，红了的用例在最后一列点名。
> 机器可读版（逐用例状态、跳过原因、各层耗时）：`tests/report/latest.json`。

| 时间 | 层 | 明细 | 结论 | 失败用例 |
|---|---|---|---|---|
| 2026-11-17T11:37:58+08:00 | l0 | L0 core-domain: ok 1.3s (69 passed, 0 failed)<br>L0 frontend: ok 1.3s (11 passed, 0 failed) | PASS | - |
| 2026-11-17T11:38:26+08:00 | it | L1 shell markers: ok 6.2s (3 passed, 0 failed)<br>L1 persistence: ok 0.7s (27 passed, 0 failed) | PASS | - |
| 2026-11-17T11:42:51+08:00 | all | L0 core-domain: ok 0.4s (69 passed, 0 failed)<br>L0 frontend: ok 1.5s (20 passed, 0 failed)<br>L1 shell markers: ok 2.3s (3 passed, 0 failed)<br>L1 persistence: ok 0.8s (27 passed, 0 failed) | PASS | - |
| 2026-11-17T15:35:36+08:00 | l0 | L0 core-domain: ok 0.5s (78 passed, 0 failed)<br>L0 frontend: ok 1.6s (26 passed, 0 failed) | PASS | - |
| 2026-11-17T15:36:40+08:00 | all | L0 core-domain: ok 0.2s (78 passed, 0 failed)<br>L0 frontend: ok 1.5s (26 passed, 0 failed)<br>L1 shell markers: ok 2.5s (3 passed, 0 failed)<br>L1 persistence: ok 5.2s (29 passed, 0 failed) | PASS | - |
| 2026-11-17T15:41:28+08:00 | all | L0 core-domain: ok 0.5s (78 passed, 0 failed)<br>L0 frontend: ok 1.8s (26 passed, 0 failed)<br>L1 shell markers: skipped (pinshell.exe is running; target\debug\pinshell.exe is locked by a running app; tauri dev is running) | PASS | - |
| 2026-11-17T16:21:36+08:00 | l0 | L0 core-domain: ok 1.7s (82 passed, 0 failed)<br>L0 frontend: ok 1.6s (30 passed, 0 failed) | PASS | - |
| 2026-11-17T16:28:53+08:00 | l0 | L0 core-domain: ok 0.5s (82 passed, 0 failed)<br>L0 frontend: ok 1.8s (30 passed, 0 failed) | PASS | - |
| 2026-11-17T16:30:42+08:00 | l0 | L0 core-domain: ok 0.3s (82 passed, 0 failed)<br>L0 frontend: ok 1.6s (30 passed, 0 failed) | PASS | - |
| 2026-11-17T18:53:29+08:00 | l0 | L0 core-domain: ok 2.7s (87 passed, 0 failed)<br>L0 frontend: ok 1.7s (30 passed, 0 failed) | PASS | - |
