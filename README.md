# Stuyvesant Rod & Gun Club — website preview

A single-page site. Everything that changes week to week lives in **`data.json`**, so updates never touch the page code.

## How to update (from any browser, including a phone)
1. Open `data.json` in this repository and tap the pencil icon (Edit).
2. Make the change, then tap **Commit changes**. The live site updates in about a minute.

### Hours
Under `"hours"` → `"days"`, each day has `"closed": true`, or `"closed": false` with 24-hour times:
`{ "day": "Monday", "closed": false, "open": "19:00", "close": "22:00" }`
Keep the days in order Sunday → Saturday. Set `"confirmed": true` once they're final.

### Calendar events
Add an entry to `"events"`:
```json
{ "title": "General membership meeting", "category": "meeting", "date": "2026-11-10", "start": "19:30", "desc": "All members welcome." }
```
- `category`: `training`, `club`, `meeting` or `closure`
- `date` / `endDate` are `YYYY-MM-DD`; `endDate`, `start`, `end` and `desc` are optional
- A **closure** event automatically shows the range as closed on those dates.
- Separate entries with commas. No comma after the last one.

### Banner notice
`"banner": { "on": true, "text": "..." }` — set `"on": false` to hide it.

### Photos
1. Upload images into the `photos/` folder (Add file → Upload files).
2. List them in `data.json`:
```json
"photos": [
  { "src": "photos/firing-line.jpg", "caption": "The renovated firing line" }
],
"cover": "photos/firing-line.jpg"
```
`cover` (optional) becomes the big image at the top of the page.

Tip: if the page stops updating after an edit, the JSON probably has a typo (a missing comma or quote). Paste it into jsonlint.com to find it.
