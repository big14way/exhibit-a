# Exhibit A submission media

- `exhibit-a-deck.pdf` — 10-slide submission deck, exported from the editable PPTX.
- `exhibit-a-deck.pptx` — editable source deck (16:9).
- `exhibit-a-demo.mp4` — 3:59 narrated demo with burned-in captions (sidecar `exhibit-a-demo.srt`), 1920×1080, H.264/AAC. Every product scene is a real screen recording of the viewer served from this repository (`npm run web`) and of the CLI output (`npm run cli -- investigate / approve / writeback`), replayed from the committed `SAMPLE_MODE` cassette; the Zetaris writeback scene shows the recorded live close committed under `fixtures/cases/live`. Slides, narration and the brand background are generated; no stock footage or music.

The video is built from a config (`docs/video/` holds the Playwright scratch install); the reproducible path for a judge is `npm run eval` and `npm run web`.
