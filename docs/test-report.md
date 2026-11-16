# 测试报告（最近 10 次）

> 由 `scripts/test-guard.ps1` 每次运行自动追加，不手改。只留最近 10 行，红了的用例在最后一列点名。
> 机器可读版（逐用例状态、跳过原因、各层耗时）：`tests/report/latest.json`。

| 时间 | 层 | 明细 | 结论 | 失败用例 |
|---|---|---|---|---|
| 2026-11-16T21:35:03+08:00 | all | L0 core-domain: ok 1.1s (34 passed, 0 failed)<br>L1 shell markers: ok 4.7s (3 passed, 0 failed) | PASS | - |
| 2026-11-16T21:35:32+08:00 | l0 | L0 core-domain: ok 0.2s (34 passed, 0 failed) | PASS | - |
| 2026-11-16T21:38:45+08:00 | l0 | L0 core-domain: ok 1.4s (40 passed, 0 failed) | PASS | - |
| 2026-11-16T21:46:18+08:00 | l0 | L0 core-domain: failed 0.6s (0 passed, 0 failed) | FAIL | - |
| 2026-11-16T21:46:53+08:00 | l0 | L0 core-domain: ok 1.4s (54 passed, 0 failed) | PASS | - |
| 2026-11-16T21:49:17+08:00 | all | L0 core-domain: ok 0.4s (54 passed, 0 failed)<br>L1 shell markers: ok 5.1s (3 passed, 0 failed)<br>L1 persistence: ok 0.8s (11 passed, 0 failed) | PASS | - |
| 2026-11-16T21:50:15+08:00 | all | L0 core-domain: ok 0.2s (54 passed, 0 failed)<br>L1 shell markers: ok 2.6s (3 passed, 0 failed)<br>L1 persistence: ok 0.7s (11 passed, 0 failed) | PASS | - |
