# Mentimeter CSV API Scraper (Chrome Extension)

Chrome extension that reads Mentimeter presentation URLs from a CSV, fetches the corresponding Mentimeter API payloads, and exports a reduced JSON focused on behavioral, structural, and semantic content.

## What it does

- Parses a CSV in the popup UI.
- Detects likely URL columns and lets you choose one.
- Converts each presentation URL to:
  - `https://api.mentimeter.com/presentation/series/<presentationId>`
- Fetches API data using browser context with `credentials: "include"` (uses existing browser session/cookies when applicable).
- Reduces the API response to essential fields (no styling/layout/assets metadata).
- Supports throttled queue processing, retries with backoff, pause/resume, live progress, and partial download before completion.

## Current features

- **Throttling + anti-burst behavior**
  - Random delay between requests (`minDelayMs` / `maxDelayMs` in `background.js`)
  - Retry support for transient/restricted responses (`403`, `429`, `5xx`, etc.)
  - Exponential backoff with jitter
  - `Retry-After` header support
- **Progress UX**
  - Status badge (`Idle`, `Ready`, `Running`, `Paused`, `Completed`)
  - Progress bar
  - Done/success/failed/queued counters
  - Request rate and ETA
- **Execution controls**
  - Start
  - Pause / Resume
  - Download partial JSON while still running
  - Download final JSON when complete

## Output schema (reduced)

Each processed CSV row produces:

- `rowIndex`
- `url` (original CSV URL)
- `rowData` (original CSV row object)
- `apiUrl` (derived API endpoint)
- `presentation` (reduced payload)
- `error` (`null` on success, string on failure)

`presentation` contains:

- `slide_count`
- `question_slide_count`
- `slide_type_distribution`
- `total_question_count`
- `participation_mode`
- `participation_policy`
- `participation_identity_mode`
- `participation_authentication_mode`
- `qa_enabled`
- `live_chat_enabled`
- `collaboration_mode`
- `presentation_language`
- `slides[]`
  - `slide_type`
  - `slide_title`
  - `questions[]`
    - `question_title`
    - `question_description`
    - `question_type`
    - `response_policy`
    - `response_mode`
    - `choice_count`
    - `choices[].title`
    - `has_correct_answers`
    - `scoring_enabled`
    - `countdown_enabled`
    - `has_response_range`
    - `response_range.min`
    - `response_range.max`
    - `max_entries_defined`

## Install (unpacked extension)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this folder: `mentichromescrape`

## How to use

1. Open the extension popup.
2. Upload a CSV file containing Mentimeter presentation URLs.
3. Choose the URL column (auto-detection preselects a likely one).
4. Click **Start**.
5. Optionally click **Pause** / **Resume**.
6. Click **Download Partial** anytime during processing, or download final JSON when complete.

## URL conversion rule

Input example:

- `https://www.mentimeter.com/app/presentation/aldn1rs5zgb6cv3t99tbb1x6upiady9e`

Converted API URL:

- `https://api.mentimeter.com/presentation/series/aldn1rs5zgb6cv3t99tbb1x6upiady9e`

## Permissions

Defined in `manifest.json`:

- `downloads`
- Host permissions:
  - `https://www.mentimeter.com/*`
  - `https://mentimeter.com/*`
  - `https://api.mentimeter.com/*`

## Tuning

You can adjust queue behavior in `background.js`:

- `state.concurrency` (parallel workers)
- `state.throttle.minDelayMs`
- `state.throttle.maxDelayMs`
- `maxAttempts` in `fetchJsonWithRetry()`

For lower detection risk, prefer lower concurrency and higher delay.

## Troubleshooting

- **Manifest load error**
  - Reload extension in `chrome://extensions` and check the error details.
- **Many 403/429 responses**
  - Increase throttle delay and/or reduce concurrency.
  - Ensure you are logged in to Mentimeter in the same Chrome profile.
- **No rows processed**
  - Verify CSV has a valid URL column and rows are not empty.
- **Partial results only**
  - Some rows may fail due to unavailable/private/invalid presentations; check each row's `error`.

## Project files

- `manifest.json` - extension configuration
- `popup.html` - popup UI markup/styles
- `popup.js` - popup state, controls, progress, downloads
- `background.js` - queue, throttling, API fetch, reduction logic
- `csv.js` - CSV parser
- `url_detect.js` - URL column scoring
- `content.js` - legacy content-script scraper path (currently not used in API flow)

