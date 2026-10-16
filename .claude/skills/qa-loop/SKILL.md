---
name: qa-loop
description: End-to-end QA, review, re-evaluate and improve loop for any new feature or script. Use after building a feature, when asked to "QA", "test end to end", "review and improve", or before calling a feature done.
---

# QA loop: review → test → fix → re-evaluate

Run this loop on every new feature before calling it done. Stop only when the exit criteria pass.

## 1. Define "done" first
Write 3–6 checkable acceptance criteria from the user's request (inputs, outputs, edge cases, failure behaviour).
Example: "returns ≥5 priced results for 28 Oct, 2 adults, sorted, no duplicates, target hotel present".

## 2. Review (adversarial)
Read the code as a hostile reviewer. Look for:
- silent failures (errors swallowed, empty output treated as success, exit code 0 on failure)
- flaky external calls (timeouts, rate limits, bot blocks, changed markup) — probe them, don't guess
- unvalidated inputs, duplicates, null/NaN values, unsorted or inconsistent output
- dead or misleading output (columns that are always empty, wrong labels)
List each finding with the evidence (command + output) that shows it.

## 3. Test
- **Unit tests** (`node --test`, pytest, etc.) for pure logic: parsing, normalising, sorting, dedupe.
- **E2E test** that runs the real entry point (CLI/server/browser) the way a user would and asserts on
  its real output against the acceptance criteria. Live dependencies are fine; assert invariants
  (ranges, ordering, schema), not exact values that change.
- A test for bad input / failure path (non-zero exit code, clear error).
Wire them into `npm test` / `npm run test:e2e` (or the repo's equivalent).

## 4. Fix
Fix findings in order: correctness → failure handling → output quality. Keep each fix minimal.

## 5. Re-evaluate
Re-run all tests and the real command. Re-read your diff adversarially. Any new finding → back to step 2.
Cap at ~5 iterations; if still failing, report exactly what fails and why.

## Rules
- Never claim a pass without showing the test output.
- Never skip, disable or weaken a test to get green.
- External site blocks you (403, CAPTCHA, "robot" page, ToS notice): detect and report it, degrade
  gracefully to other sources. Do not add evasion (stealth plugins, proxy rotation, CAPTCHA solving).
- Retry only transient errors (timeouts), at most once; never retry a block.

## Report
End with a short table: finding → fix → verified by. Plus final test counts and any remaining risks.
