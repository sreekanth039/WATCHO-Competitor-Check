# WATCHO Competitor Price Comparison

This project includes a Manifest V3 Chrome extension and a Node.js + Express backend for UK watch price comparison. The extension accepts a watch reference number, calls the deployed Render backend, and renders WATCHO plus competitor matches in a comparison table.

## Project Structure

```text
backend/
  .env
  .env.example
  cache.js
  competitors.js
  matcher.js
  package.json
  serpApiClient.js
  server.js
extension/
  manifest.json
  popup.css
  popup.html
  popup.js
README.md
```

## UK SerpApi Settings Used

The backend keeps all SerpApi traffic server-side and uses UK-focused defaults:

- `engine=google` for primary site searches
- `engine=google_shopping` for shopping fallback
- `google_domain=google.co.uk`
- `gl=uk`
- `hl=en`
- `location=United Kingdom`

Primary queries:

- WATCHO: `"REF_NUMBER" site:watcho.co.uk`
- Competitors: `"REF_NUMBER" site:competitor-domain`

Shopping fallback query:

- `"REF_NUMBER" watch UK`

## Matching and Filtering

- Exact normalized reference match in title scores `100`
- Exact normalized reference match in snippet scores `95`
- Exact normalized reference match in URL scores `90`
- Brand/model-only signals score `60`, but are rejected from final results unless you are inspecting debug output
- Results are rejected if they include `pre-owned`, `used`, `second hand`, `refurbished`, `replica`, `strap only`, `bracelet only`, `replacement strap`, or `parts`
- Non-GBP results are rejected from final UK matches
- Only the best result per competitor is returned

The backend normalizes candidates from:

- `organic_results`
- `shopping_results`
- `inline_shopping_results`
- `immersive_products`

## Cache Behaviour

- Cache file: `backend/.cache/watch-search-cache.json`
- Cache key shape: `ref + competitor domain + search type`
- Default TTL: `6` hours
- Configurable with `CACHE_TTL_HOURS`
- TTL is clamped to `6-24` hours

## Environment Setup

The SerpApi key must only live in `backend/.env`.

Example `.env.example`:

```env
SERPAPI_KEY=your_primary_key_here
SERPAPI_FALLBACK_KEY=your_optional_fallback_key_here
PORT=3000
CACHE_TTL_HOURS=6
```

Important:

- Never hardcode the SerpApi key in backend source, extension code, logs meant for users, or README examples
- Never expose the key in browser responses
- Keep `backend/.env` out of version control
- The backend uses `SERPAPI_KEY` first and retries once with `SERPAPI_FALLBACK_KEY` only if SerpApi reports quota or key errors

## Local Run

### 1. Install backend dependencies

```bash
cd backend
npm install
```

### 2. Start the backend

```bash
npm run dev
```

The API runs at [http://localhost:3000](http://localhost:3000).

Health check:

```bash
curl "http://localhost:3000/health"
```

Compare endpoint examples:

```bash
curl "http://localhost:3000/api/compare-watch?ref=010-03198-40"
```

```bash
curl "http://localhost:3000/api/compare-watch?ref=010-03198-40&debug=true"
```

## Chrome Extension Setup

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select `/Users/sreekanthreddy/Documents/Codex/2026-04-26/build-a-chrome-extension-backend-from/extension`
5. Open the extension popup and search a reference

The extension calls:

- `https://watcho-price-compare-api.onrender.com/api/compare-watch?ref=...`

Optional local backend development:

- The backend can still be run locally at `http://localhost:3000` for backend testing, but the extension is configured to use the deployed Render API.

## API Response Shape

Example response:

```json
{
  "ref": "010-03198-40",
  "searchedAt": "2026-04-26T12:00:00.000Z",
  "watcho": {
    "found": false,
    "title": null,
    "price": null,
    "currency": "GBP",
    "url": null,
    "confidence": 0
  },
  "competitors": [
    {
      "name": "Goldsmiths",
      "domain": "goldsmiths.co.uk",
      "found": false,
      "title": null,
      "price": null,
      "currency": "GBP",
      "url": null,
      "confidence": 0,
      "source": null,
      "reason": "No exact reference match found"
    }
  ]
}
```

With `debug=true`, the response also includes:

- Query used per competitor
- Count of normalized raw results found
- Up to three rejected results with rejection reason
- Raw section type such as `organic_results` or `immersive_products`

The debug payload never includes `SERPAPI_KEY`.

## Sample Test References

- `010-03198-40`
- `T137.410.11.041.00`
- `CAZ1010.BA0842`
- `210.30.42.20.01.001`

Actual results depend on current Google indexing and what SerpApi returns for UK search.
