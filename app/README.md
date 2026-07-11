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

Open the local Vite URL. The demo deliberately starts on a deterministic **Terrible (3s)** network.

1. Select **Lunch Break** and wait for Food to say **PRELOADED**.
2. Tap Food. The branch commits atomically, the phone flashes green, and roughly 3 seconds is added to time saved with no new Food data request.
3. Inside Food, wait for Biryani to preload, then tap it to demonstrate deep prediction and decoded image promotion.
4. Reset, enable **Force wrong branch**, and choose the natural path. The speculative request is aborted immediately, the phone flashes red, discarded bytes are reported, and the baseline request runs normally.
5. Use **Bill Due**, continue to the summary, and point out that **Confirm payment** is `commit_only`: it has no speculative API path and fires only after the human tap.

The on-screen controls make every beat deterministic and re-runnable: AHEAD on/off, five contexts, three network presets, forced miss, and full session reset.

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

The UI is a faithful interactive simulation of the SDK boundary. Runtime telemetry drives the dashboard: prediction, speculative branch lifecycle, measured latency saved, bytes discarded, and safety-boundary events. Speculative reads carry `X-Speculative: 1` and an AHEAD branch identifier so a production backend could shed that low-priority traffic first.

## Safety model

Every action belongs to the static action graph. It is either:

- `speculatable`: a safe reversible read / render operation that may execute in a shadow branch.
- `commit_only`: an irreversible operation such as payment, OTP, or order creation. The executor blocks it until a human tap.

The model never invents an API call or a screen. It ranks only legal graph actions.

## Local model integration

The model-agnostic predictor automatically chooses `gemma4:*`, then `gemma3:*`, then the local heuristic. Ollama JSON mode is followed by strict action-ID validation, deduplication and confidence normalization. Any timeout or contract failure triggers the heuristic in the same request.

The runtime prefers the locally installed `gemma4:e2b-it-qat`, then Gemma 3, and falls back to a deterministic on-device heuristic within a bounded timeout. The dashboard always labels the tier that actually produced the ranking.

```bash
# Optional, after installing Ollama
ollama pull gemma4:e2b-it-qat
# The API detects it automatically; or pin explicitly:
AHEAD_MODEL=gemma4:e2b-it-qat npm run dev:api
```

The visual demo remains fully functional without Ollama or internet access, which makes it safe to present under venue-Wi-Fi failure conditions.

## Verification

```bash
npm test
npm run build
curl http://127.0.0.1:8787/api/health
```

The automated suite gates matching ready commits, early-tap request adoption, wrong-branch rollback, AHEAD-off baseline behavior, honest saved-time math, deterministic latency, speculative traffic marking, and the absolute commit-only wall around payment and transfer.
