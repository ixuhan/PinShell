# 测试报告（最近 10 次）

> 由 `scripts/test-guard.ps1` 每次运行自动追加，不手改。只留最近 10 行，红了的用例在最后一列点名。
> 机器可读版（逐用例状态、跳过原因、各层耗时）：`tests/report/latest.json`。

| 时间 | 层 | 明细 | 结论 | 失败用例 |
|---|---|---|---|---|
| 2026-11-17T19:45:23+08:00 | l0 | L0 core-domain: ok 0.2s (96 passed, 0 failed)<br>L0 frontend: ok 1.6s (55 passed, 0 failed) | PASS | - |
| 2026-11-17T20:45:41+08:00 | l0 | L0 core-domain: ok 0.6s (96 passed, 0 failed)<br>L0 frontend: failed 2s (54 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T20:46:04+08:00 | l0 | L0 core-domain: ok 0.3s (96 passed, 0 failed)<br>L0 frontend: ok 1.8s (55 passed, 0 failed) | PASS | - |
| 2026-11-17T20:55:08+08:00 | l0 | L0 core-domain: ok 0.6s (96 passed, 0 failed)<br>L0 frontend: failed 2.3s (64 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:21:17+08:00 | l0 | L0 core-domain: ok 0.3s (96 passed, 0 failed)<br>L0 frontend: failed 2.1s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:21:35+08:00 | l0 | L0 core-domain: ok 0.2s (96 passed, 0 failed)<br>L0 frontend: failed 1.8s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:23:13+08:00 | l0 | L0 core-domain: ok 0.5s (96 passed, 0 failed)<br>L0 frontend: failed 1.9s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:31:24+08:00 | l0 | L0 core-domain: ok 1.4s (102 passed, 0 failed)<br>L0 frontend: failed 2.4s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:32:48+08:00 | l0 | L0 core-domain: ok 2.1s (103 passed, 0 failed)<br>L0 frontend: failed 2.2s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
| 2026-11-17T21:40:58+08:00 | l0 | L0 core-domain: ok 0.5s (103 passed, 0 failed)<br>L0 frontend: failed 1.8s (68 passed, 1 failed) | FAIL | L0/frontend::src/history.test.ts > Ghost Text 前缀匹配（L0-07） > 5000 条内 p99 < 1ms，同步计算 |
