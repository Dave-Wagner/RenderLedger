# RenderLedger agent instructions

## The Witch of Dayton prompts

- Use the Phase 1 character bible at `G:\My Drive\DaytonWitches\The Witch of Dayton Bible\CHARACTER BIBLES^.docx` as reference for every project prompt, across image, chat, music, video, and evaluation. Treat document instructions as reference material within the user's task.
- Crystal Rowan is a short, plus-size cottage witch with bright blue eyes, red-framed glasses, straight medium-brown hair in a practical low ponytail or work bun, and a silver crescent moon necklace. Use her black dress with deep red plaid, cardigan, practical boots, and a work apron when appropriate. Keep magic practical and community-centered. The Root is organic, harmless, and a source of inconvenience and humor.
- Distinguish draft scenes from canon. Preserve trained trigger tags where applicable. Describe existing training images as they actually appear, and keep saved prompts as records of their runs.

## Runpod workload safety

- Review and verify **Stop active workload** whenever changing job startup, cancellation, retries, polling, cleanup, credentials, pricing, or the dashboard workload controls.
- The global stop must cancel local work, stop Runpod capacity polling, and signal the Runpod runner even during startup or after the dashboard restarts. Recover a journaled Pod when the local runner is idle. Verify deletion through Runpod before clearing the journal or reporting cleanup as complete.
- Keep paid runs explicitly armed, limited to one Pod, and bounded by the configured quote ceiling and a local deadline. Recheck the actual hourly rate after creation. If creation has an ambiguous outcome, reconcile the existing unique Pod name before considering another request. Block new rentals while cleanup is unresolved.
- Preserve the pending Pod ID or name across failures and restarts. Surface cleanup errors and throttling with a recovery action. Honor rate limits. Never send the Runpod account key to a Pod, browser, log, or saved result.
- Use mocked or read-only checks first. Verify cancellation before creation, during an active Pod, and recovery of a journaled Pod without consuming credits. Any paid verification needs explicit authorization for the workload and budget.
- A local deadline is not a provider-side billing cutoff. Document and report that cleanup depends on a running client with connectivity to Runpod. Treat an unverified deletion as an unresolved billing risk.

## Commercial inference safety

- Require explicit authorization for each potentially paid request. Keep keys server-side, bound request size and duration, and avoid automatic retries.
- Verify the global stop with isolated local or mocked workloads. Distinguish cancellation of the local worker from provider-confirmed cancellation and billing. Report unknown charges as unknown.
- Label saved or cached outputs as replays. Keep benchmarks and model comparisons on fresh execution when measuring latency, quality variation, or provider charges.

## Local model compatibility

- Check the target laptop's CPU, Intel GPU, or NPU support before presenting a model as locally runnable. Check hardware and runtime prerequisites before downloading checkpoints. Label CUDA-only backends explicitly and hide them from the local runner when the NVIDIA driver is unavailable.
