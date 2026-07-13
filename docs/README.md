# Candor documentation

The complete documentation set. If you read one thing, read the trust layer; it is the
reason this project exists. Suggested order:

| # | Chapter | What it answers |
|---|---|---|
| 1 | [The trust layer](trust-layer.md) | How the record is made unfakeable: every on-chain artifact, its exact bytes, the win-condition compiler, the verifier, and the threat model. |
| 2 | [How Candor trades](how-candor-trades.md) | The strategy: how a stream tick becomes a position — the fair-price engine, both signal families, the gates, and sizing. |
| 3 | [Parameter tuning](params-tuning.md) | Where the frozen numbers came from: the noise floor, the failed first sweep and its forensics, the freeze. Dead ends included. |
| 4 | [TxLINE integration](txline-integration.md) | Every endpoint and stream, measured operational behavior, validation payload anatomy, and the corrected period-band table. |
| 5 | [Architecture](architecture.md) | The system: one-writer topology, bootstrap order, runtime loops, the engine pipeline, the data model, and the failure-mode table. |

Live surfaces the documentation refers to:

- Dashboard: [candor.website](https://candor.website)
- Machine-readable record: [candor.website/api/record](https://candor.website/api/record)
- The audit procedure: [candor.website/verify](https://candor.website/verify)
- Agent wallet: [`DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE`](https://solscan.io/account/DKdqzAhvYMB3TZFZSM7M6JA3nQqmsjk5W9Smo6vq7xrE)

Brand and design assets (logo kit, design tokens, the visual system) live in
[`branding/`](../branding/). The repository overview is the
[main README](../README.md).
