# Interstitial Journal — Cloudflare Deployment Guide

A voice-first personal journal designed for interstitial journaling between tasks. It combines an editorial React frontend, edge-accelerated speech-to-text and text cleanup powered by Google Gemini Flash-Lite, Cloudflare D1 (database), Cloudflare R2 (audio storage), and Firebase Authentication.

---

## 📋 Architecture Overview

- **Frontend:** React 19, Vite, Tailwind CSS, Lucide icons, built to `/dist`.
- **Backend:** Hono-based Cloudflare Worker at `src/worker/index.ts` and `src/worker/app.ts` serving `/api/*` endpoints.
- **AI Models:** Gemini 3.5 Flash-Lite (`gemini-3.5-flash-lite`) for fast voice transcription and editorial cleanup.
- **Persistence:** 
  - **Cloudflare D1:** Server-side journal entries and settings (`interstitial-journal-db`).
  - **Cloudflare R2:** High-fidelity audio recording storage (`interstitial-journal-audio`).
  - **Firebase Firestore:** Multi-device user sync & Google authentication.
  - **IndexedDB:** Resilient browser offline draft cache.

---

## 🚀 Deployment Options

You can deploy Interstitial Journal from GitHub using either:
1. **Cloudflare Workers with Static Assets (Recommended):** The current standard that unifies the Worker API and the Vite static build in a single project via `wrangler.toml`.
2. **Cloudflare Pages:** The classic git-connected Pages workflow.

---

## Option 1: Cloudflare Workers + Static Assets (Recommended)

Since this repository already includes a pre-configured `wrangler.toml` pointing to `src/worker/index.ts` and `dist/`, this is the cleanest deployment path.

### Step 1: Push Your Code to GitHub
Ensure all code and configurations are committed and pushed to your GitHub repository:
```bash
git add .
git commit -m "Prepare Interstitial Journal for Cloudflare deployment"
git push origin main
```

### Step 2: Create Cloudflare D1 Database & R2 Bucket
Install Wrangler locally (or use the Cloudflare Web Dashboard):
```bash
# 1. Login to Cloudflare
npx wrangler login

# 2. Create the D1 database
npx wrangler d1 create interstitial-journal-db
```

Wrangler will output something like:
```text
database_id = "xxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Open `wrangler.toml` in your repository and update `database_id` under `[[d1_databases]]`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "interstitial-journal-db"
database_id = "your-actual-d1-database-id-here"
migrations_dir = "migrations"
```

Apply the database schema migration:
```bash
npx wrangler d1 migrations apply interstitial-journal-db --remote
```

Create the R2 audio storage bucket:
```bash
npx wrangler r2 bucket create interstitial-journal-audio
```

Commit and push your updated `wrangler.toml`:
```bash
git add wrangler.toml
git commit -m "Configure D1 database ID"
git push origin main
```

### Step 3: Connect to Cloudflare in the Dashboard
1. Go to the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Navigate to **Workers & Pages** > **Create application** > **Workers**.
3. Select **Connect to Git** (Workers Builds).
4. Authorize Cloudflare with your GitHub account and choose your `interstitial-journal` repository.
5. Set your build configuration:
   - **Framework preset:** `Vite`
   - **Build command:** `npm run build`
   - **Deploy command:** `wrangler deploy`
   - **Root directory:** `/`

### Step 4: Configure Secrets & Environment Variables
In the Cloudflare Dashboard under **Workers & Pages** > **interstitial-journal** > **Settings** > **Variables and Secrets**:
1. Click **Add**:
   - **Variable name:** `GEMINI_API_KEY`
   - **Value:** Your Google Gemini API Key from [Google AI Studio](https://aistudio.google.com/)
   - **Type:** Secret (Encrypted)
2. Add optional environment variables:
   - `GEMINI_FLASH_LITE_MODEL`: `gemini-3.5-flash-lite`

Click **Save and Deploy**. Cloudflare will run `npm run build` and deploy your Worker with Static Assets.

---

## Option 2: Deploying via Cloudflare Pages

If you prefer using the Cloudflare Pages interface:

### Step 1: Connect Repository to Cloudflare Pages
1. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), go to **Workers & Pages** > **Create application** > **Pages**.
2. Click **Connect to Git**.
3. Select your GitHub repository (`interstitial-journal`) and click **Begin setup**.

### Step 2: Configure Build Settings
Fill out the setup form:
- **Project name:** `interstitial-journal`
- **Production branch:** `main`
- **Framework preset:** `Vite`
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- **Root directory:** `/` (leave default)

In **Environment variables (advanced)**, add:
- `NODE_VERSION`: `20`
- `GEMINI_FLASH_LITE_MODEL`: `gemini-3.5-flash-lite`

Click **Save and Deploy**.

### Step 3: Add the Gemini API Key Secret
1. Once initial setup finishes, go to **Settings** > **Environment variables**.
2. Under **Production**, click **Add variables**:
   - **Variable name:** `GEMINI_API_KEY`
   - **Value:** Your Google Gemini API Key
   - **Type:** Secret
3. Click **Save**.

### Step 4: Attach Cloudflare D1 & R2 Bindings in Pages
1. In Pages, navigate to **Settings** > **Functions**.
2. Scroll to **D1 database bindings**:
   - Click **Add binding**.
   - **Variable name:** `DB`
   - **D1 database:** Select `interstitial-journal-db` (created via Step 2 of Option 1).
3. Scroll to **R2 bucket bindings**:
   - Click **Add binding**.
   - **Variable name:** `AUDIO_BUCKET`
   - **R2 bucket:** Select `interstitial-journal-audio`.
4. Trigger a new deployment under **Deployments** > **Retry deployment** to activate the bindings.

---

## 🔑 Firebase Authentication Configuration

If using Firebase authentication (Google Sign-In), you must authorize your Cloudflare domain:

1. Copy your deployment domain (e.g., `https://interstitial-journal.pages.dev` or `https://interstitial-journal.<your-subdomain>.workers.dev`).
2. Open the [Firebase Console](https://console.firebase.google.com/).
3. Select your project: `ai-studio-cadencevoicefirs-f149153d-6a8d-4696-9cea-a117cf860df4`.
4. Go to **Authentication** > **Settings** > **Authorized domains**.
5. Click **Add domain** and enter your Cloudflare domain (e.g. `interstitial-journal.pages.dev`).
6. Save. Google Sign-In popup authentication will now authenticate securely.

---

## 🛠️ Verification & Health Check

After deployment completes, verify that your service is healthy:

| Endpoint | Method | Expected Output | Purpose |
|---|---|---|---|
| `/` | `GET` | HTML application | Loads the voice journal app |
| `/api/providers` | `GET` | `{"status":"ok", "geminiConfigured": true}` | Checks model status and bindings |
| `/api/settings` | `GET` | `{"settings": { ... }}` | Verifies settings persistence |
| `/api/transcribe` | `POST` | `{"rawTranscription": "..."}` | Verifies speech-to-text processing |
| `/api/cleanup` | `POST` | `{"cleanedTranscription": "..."}` | Verifies Flash-Lite text refinement |

---

## 💻 Local Development

To run the application locally on your machine:

```bash
# 1. Install dependencies
npm install

# 2. Provide Gemini API Key
cp .env.example .env
# Edit .env and set GEMINI_API_KEY=your_gemini_api_key

# 3. Start development server
npm run dev
```

The app will be available at `http://localhost:3000`.

---

## 📦 Project Directory Structure

```text
├── dist/                          # Compiled Vite production build
├── migrations/                    # Cloudflare D1 SQL migrations
│   └── 0001_initial_schema.sql
├── public/                        # PWA icons, manifest, and audio assets
├── src/
│   ├── components/                # React UI components (Record studio, settings, timeline)
│   ├── hooks/                     # Custom React hooks
│   ├── lib/                       # Firebase & draft storage helpers
│   ├── types/                     # TypeScript definitions (entries, settings)
│   ├── worker/
│   │   ├── app.ts                 # Hono API router (/api/transcribe, /api/cleanup, etc.)
│   │   ├── index.ts               # Cloudflare Worker fetch handler & assets fallback
│   │   ├── localAdapter.ts        # In-memory D1 & R2 local development emulator
│   │   └── types.ts               # Worker environment bindings
│   ├── App.tsx                    # Main journal application view
│   ├── index.css                  # Editorial typography & theme tokens
│   └── main.tsx                   # React client entry point
├── firebase-applet-config.json    # Firebase client credentials
├── package.json                   # Scripts and project dependencies
├── server.ts                      # Express local dev bridge running on port 3000
└── wrangler.toml                  # Cloudflare Workers + Static Assets deployment config
```

---

## ❓ Troubleshooting

- **Gemini Quota Exceeded (429):** The application automatically catches quota exceptions and preserves your local recording in IndexedDB so no spoken reflection is lost.
- **Firebase `auth/unauthorized-domain`:** Ensure your Cloudflare `*.pages.dev` or `*.workers.dev` domain is added to Firebase Console under Authorized Domains.
- **D1 Table Not Found:** Run `npx wrangler d1 migrations apply interstitial-journal-db --remote` to ensure tables and indexes are initialized.
