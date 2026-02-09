# Exchange Rate Calculator

Simple static web app for real-time exchange conversion using `frankfurter.app` (ECB data).

## Features

- Real-time exchange rate conversion
- Currency swap
- Instant update when amount/currency changes
- Mobile-friendly layout
- No API key required

## Local Run

Because this is a static site, any simple static server works.

PowerShell example:

```powershell
cd c:\Users\sophie\Desktop\CODEX_3
python -m http.server 5173
```

Open `http://localhost:5173`.

## Deploy (Vercel)

1. Install Vercel CLI:

```powershell
npm i -g vercel
```

2. From project folder:

```powershell
cd c:\Users\sophie\Desktop\CODEX_3
vercel
```

3. For production deploy:

```powershell
vercel --prod
```

## Data Sources

- Live rates: `https://open.er-api.com/v6/latest/{BASE}` (frequent updates, no API key)
- Currency names: `https://api.frankfurter.app/currencies`

## Tech

- HTML / CSS / Vanilla JavaScript
