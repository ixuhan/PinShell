# 测试报告（最近 10 次）

> 由 `scripts/test-guard.ps1` 每次运行自动追加，不手改。只留最近 10 行，红了的用例在最后一列点名。
> 机器可读版（逐用例状态、跳过原因、各层耗时）：`tests/report/latest.json`。

| 时间 | 层 | 明细 | 结论 | 失败用例 |
|---|---|---|---|---|
| 2026-11-17T21:40:58+08:00 | l0 | L0 core-domain: ok 0.5s (103 passed, 0 failed)<br>L0 frontend: failed 1.8s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:45:13+08:00 | l0 | L0 core-domain: ok 0.3s (103 passed, 0 failed)<br>L0 frontend: ok 1.8s (69 passed, 0 failed) | PASS | - |
| 2026-11-17T21:57:37+08:00 | l0 | L0 core-domain: ok 0.5s (103 passed, 0 failed)<br>L0 frontend: ok 1.8s (77 passed, 0 failed) | PASS | - |
| 2026-11-17T21:59:06+08:00 | l0 | L0 core-domain: ok 0.2s (103 passed, 0 failed)<br>L0 frontend: ok 1.8s (77 passed, 0 failed) | PASS | - |
| 2026-11-17T22:09:32+08:00 | l0 | L0 core-domain: ok 0.3s (103 passed, 0 failed)<br>L0 frontend: ok 2s (77 passed, 0 failed) | PASS | - |
| 2026-11-18T09:09:39+08:00 | l0 | L0 core-domain: ok 18.5s (103 passed, 0 failed)<br>L0 frontend: ok 4.2s (77 passed, 0 failed) | PASS | - |
| 2026-11-18T09:10:50+08:00 | it | L1 shell markers: ok 16.3s (3 passed, 0 failed)<br>L1 persistence: ok 43.8s (33 passed, 0 failed) | PASS | - |
| 2026-11-18T09:14:10+08:00 | it | L1 shell markers: ok 2.4s (3 passed, 0 failed)<br>L1 persistence: ok 5.3s (36 passed, 0 failed) | PASS | - |
| 2026-11-18T09:22:19+08:00 | all | L0 core-domain: ok 0.6s (103 passed, 0 failed)<br>L0 frontend: ok 1.7s (77 passed, 0 failed)<br>L1 shell markers: ok 2.5s (3 passed, 0 failed)<br>L1 persistence: ok 14.7s (36 passed, 0 failed) | PASS | - |
| 2026-11-18T10:48:39+08:00 | l0 | L0 core-domain: ok 0.5s (103 passed, 0 failed)<br>L0 frontend: ok 1.6s (88 passed, 0 failed) | PASS | - |
