# Pilot review before independent acceptance

2026-10-18. Development seed `arena-v8-pilot-20261018-01`; excluded from acceptance. Source manifest `2dc0525544888a2ceb311fefd7c6a3bdfd90aa3d6b18a6208e87de4cd72fc506`. No source, prompt, seed list or threshold was changed after viewing this pilot.

| Arm | Lines | Points | Survival | End | Requests | Target / key | Latency median / P95 |
| --- | ---: | ---: | ---: | --- | ---: | --- | --- |
| A | 0 | 0 | 5.88s | TOP_OUT | 12 | 0 / 12 | 148 / 160.45ms |
| V8 | 4 | 400 | 120s | TIME_LIMIT | 76 | 20 / 56 | 1211 / 2513.5ms |

Both returned `startlux-decision-27b-autothink`, reported thinking unused on every response, and had zero failed/unknown calls. Each had one discarded late response after termination. All 76 V8 requests recorded one inline image. Input reconstruction matched all 18 baseline and 192 V8 checkpoints and their final scores; target choices never executed a native input. The UI was observed live with model-selected target, current pose, stage and native-key decisions.

This is one development pair, not evidence of a general improvement. The observed 88 requests / approximately 126 simulation seconds suggests roughly 616 requests and 15 minutes for the seven remaining pairs if behavior is similar. The original formal ceiling remains 4,200 requests / 28 simulation minutes plus settlement, with six distinct seeds and one separately reported repeat. Proceed with the preregistered schedule unchanged; V8 stays opt-in.
