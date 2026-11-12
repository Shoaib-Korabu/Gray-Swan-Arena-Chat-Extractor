# Chrome Web Store Listing — Gray Swan Arena Chat Extractor

> Last Updated: 2026-11-10

## Store Listing

**Extension Name** [REQUIRED]
Gray Swan Arena Chat Extractor

**Short Description** [REQUIRED]
Sync challenges, inspect conversation outcomes and registered breaks, and export Gray Swan Arena chats to JSON or ZIP.

**Detailed Description** [REQUIRED]
Gray Swan Arena Chat Extractor helps AI security researchers and red-teamers synchronize, inspect, and export their conversation records across any Gray Swan Arena challenge directly from the active browser session.

Features:
- Universal auto-detection across all Gray Swan Arena challenges, automatically loading challenge names, scenarios, models, and live registered break counts from your active session.
- Deduplicated scenario and model filter dropdowns synchronized with the live challenge roster so batch and single-turn chats group cleanly.
- Outcome classification across rejected attempts, accepted breaks (including appeals), pending autogrades, and submission errors.
- Per-challenge storage isolation so navigating between challenges keeps metrics and cached logs strictly scoped to the active challenge.
- Built-in conversation inspector displaying multi-turn messages, tool call summaries, reasoning traces, and classification signals.
- Unlimited pagination export (configure max pages or set `0` for unlimited): export a single conversation as `.json` or multi-chat selections as a `.zip` archive with a `manifest.json` index.

How to use:
1. Log in to Gray Swan Arena (`https://app.grayswan.ai`) and open any challenge page.
2. Click the toolbar icon or use the floating bottom-right widget to view live website break stats.
3. Click **Extract chats** to collect your conversations and submissions.
4. Filter by outcome, scenario, model, or keyword, then click **Download JSON**.

Privacy & Security:
This extension operates entirely locally in your browser. All requests run directly between your browser and Gray Swan Arena (`*.grayswan.ai`) using your existing session cookies. Conversation logs are stored locally via Chrome storage APIs and are never sent to external third-party servers.

**Category** [REQUIRED]
Developer Tools

**Single Purpose** [REQUIRED]
Synchronize challenge metadata and export user-owned conversation logs from Gray Swan Arena challenges to local JSON or ZIP files.

**Primary Language** [REQUIRED]
English

## Permissions Justification

| Permission | Type | Justification |
|---|---|---|
| `storage` | permissions | Stores extracted chats and challenge summaries scoped by challenge slug locally in the browser for quick reopening. |
| `unlimitedStorage` | permissions | Allows storing large multi-challenge chat archives locally without hitting the standard Chrome local storage cap. |
| `downloads` | permissions | Reserved for download workflow integration alongside user-initiated `.json` and `.zip` file exports. |
| `tabs` | permissions | Reads the active tab URL and title on `*.grayswan.ai` to auto-detect the current challenge slug. |
| `https://app.grayswan.ai/*` | host_permissions | Communicates with Gray Swan Arena endpoints using the active authenticated session. |
| `https://*.grayswan.ai/*` | host_permissions | Supports subdomains and challenge hosts under `grayswan.ai`. |

## Privacy & Data Use

**Does the extension collect user data?** No

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Version History

| Version | Date | Changes | Status |
|---|---|---|---|
| 2.1.0 | 2026-11-10 | Added live `__data.json` website break & roster sync, per-slug storage isolation across SPA navigation, `Td` model resolution, appeal/ungraded/abandoned precedence, `toolCallSummary` + `reasoning` preservation, and unlimited pagination. | Active |
| 2.0.0 | — | Universal rewrite with runtime roster detection and JSON/ZIP export. | Superseded |
| 1.0.0 | 2026-10-17 | Initial IPi-Black release. | Superseded |
