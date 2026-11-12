# Gray Swan Arena Chat Extractor

A Chrome (Manifest V3) extension that synchronizes live challenge state from **any** Gray Swan Arena challenge and exports your conversations to canonical JSON or ZIP.

## What's new in v2.1.0

- **Live Website Sync (`__data.json` + `/panels/*`):** Syncs challenge name, full scenario roster, full model roster (`model_id` / `classifier_id` / `wave` resolution), appeals, and exact **registered unique `(scenario, model)` break counts** directly from Gray Swan Arena — even before clicking Extract.
- **Deduplicated Scenario & Model Filters:** Merges batch and direct chats using authoritative `behaviorIdToBehaviorMap` + `/panels/filter-options` + `/panels/batches` mappings so batch and unbatched chats collapse into the exact challenge scenario list (no split slug/name duplicates).
- **Per-Challenge Storage Isolation & SPA Tracking:** Stores cached extractions per challenge slug (`extractionsBySlug`) and updates dynamically as you navigate between challenges in the Gray Swan Arena SPA.
- **Accurate Verdict & Appeal Handling:** Distinguishes `grade_status: 'ungraded'` / `'maybe_success'` (`pending`), `'abandoned'` (`error`), `successful: false` (`rejected`), and appeal-won breaks (`accepted`); picks the winning or newest submission instead of overwriting newer submissions with older ones; avoids false rejections when multi-turn chats recover and call tools on a later turn.
- **Full Tool Telemetry:** Preserves `toolCalled`, `toolCallSummary`, `toolCalls[]`, `reasoning`, and `attachments` in exported JSON and the popup inspector.
- **No Cap Pagination:** `Max pages` defaults to `250` and supports `0` for unlimited scanning. One selected chat exports as `.json`; multiple export as a `.zip` containing one JSON per chat plus `manifest.json`.

## Install (unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (`gsa-ipi-extractor`).
3. Log in to Gray Swan Arena (`https://app.grayswan.ai`) in the same browser.

## Use

1. Open any challenge page on `*.grayswan.ai` (e.g., `/arena/challenge/lucky-break-payday` or `/arena/challenge/ipi-black-2026`).
2. The in-page floating widget (`🦢 Extractor`) and toolbar popup immediately sync the challenge name, registered website breaks (unique `scenario × model` breaks and solved scenarios), and roster filters.
3. Click **Extract chats** to paginate all chats and submissions, classify every conversation, and build filterable cards.
4. Filter by outcome (`All` / `Rejected` / `Accepted` / `Errors` / `Pending`), scenario, model, or keyword; inspect full dialogue, tool summaries, reasoning traces, and classification signals in the modal.
5. Click **Download JSON** to save one `.json` file (single chat) or a `.zip` bundle (multiple chats + `manifest.json`).

## Output schema

Exported records follow canonical `formatVersion: 1` `arena-chat` JSON (`challenge`, `chatId`, `behaviorId`, `scenario`, `title`, `messages[]`, `model`, `submissionMeta`, `rejectionDetails`). See `AGENT_GUIDE.md` for the full schema reference and Python ingestion helper.

## Files

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (`2.1.0`, matches `*.grayswan.ai`). |
| `background/service-worker.js` | Tab detection, live summary sync, per-slug extraction storage, badge management. |
| `lib/api-client.js` | SvelteKit `__data.json` devalue decoder, website break calculator, roster discovery, paginated extraction. |
| `lib/normalizer.js` | Dynamic model (`Td`), scenario, challenge, message, and telemetry normalization. |
| `lib/heuristics.js` | Submission/appeal verdict precedence and multi-turn refusal heuristics. |
| `lib/zip-writer.js` | Dependency-free STORE ZIP writer with filename deduplication. |
| `popup/*` | Popup UI: live break summary, roster-synced filters, inspector modal, JSON/ZIP download. |
| `content/*` | In-page floating widget with live SPA route syncing. |
| `tests/test-suite.js` | Node verification suite (`node tests/test-suite.js`). |
