# AHEAD

> CPUs stopped waiting for instructions decades ago. Apps still wait for every tap.

AHEAD is a speculative execution runtime for mobile applications. It predicts a user's legal next action locally, stages safe/reversible work in shadow state, then atomically commits or discards the branch when the user acts.

## Demo

```bash
npm install
# terminal 1
npm run dev:api
# terminal 2
npm run dev
```

Open the local Vite URL. The demo deliberately starts on a **Terrible (5s)** network.

1. With AHEAD off, tap **Electricity** and observe baseline latency.
2. Turn AHEAD on and return home. Electricity is predicted and staged; the same tap commits instantly.
3. Press **Force wrong prediction**, then tap Electricity. The runtime rolls back its branch, reports aborted work and falls back to normal loading.
4. Proceed to the payment summary. **Pay** is `commit_only`, so it can never be speculated; only the human tap crosses the boundary.

## Architecture

```text
current screen + local history + network RTT
                 │
                 ▼
       Predictor (Gemma 4 / fallback)
                 │ ranks only declared actions
                 ▼
 Action graph ── Scheduler ── Shadow executor
                                      │
                       ┌──────────────┴──────────────┐
                       ▼                             ▼
              matching human tap                different tap
              atomic commit                     abort + discard
```

The UI is a faithful interactive simulation of the SDK boundary. Runtime telemetry drives the dashboard: prediction, speculative branch lifecycle, commit/rollback result, latency saved, and safety-boundary events.

## Safety model

Every action belongs to the static action graph. It is either:

- `speculatable`: a safe reversible read / render operation that may execute in a shadow branch.
- `commit_only`: an irreversible operation such as payment, OTP, or order creation. The executor blocks it until a human tap.

The model never invents an API call or a screen. It ranks only legal graph actions.

## Local model integration

The model-agnostic predictor automatically chooses `gemma4:*`, then `gemma3:*`, then the local heuristic. Ollama JSON mode is followed by strict action-ID validation, deduplication and confidence normalization. Any timeout or contract failure triggers the heuristic in the same request.

The current machine has `gemma3:4b` installed and benchmarked at roughly 0.8–1.6 seconds warm. Ollama's downloadable Gemma 4 E2B artifact is 7.2 GB on disk (distinct from Google's approximate 2.9 GB Q4 inference-memory figure), so the project intentionally does not exhaust the laptop's remaining disk space.

```bash
# Optional, after installing Ollama
ollama pull gemma4:e2b-it-qat
# The API detects it automatically; or pin explicitly:
AHEAD_MODEL=gemma4:e2b-it-qat npm run dev:api
```

The visual demo remains fully functional without Ollama or network access, which makes it safe to present under venue-Wi-Fi failure conditions.
