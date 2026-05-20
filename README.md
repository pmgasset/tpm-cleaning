# Jordan View Cleaner Portal
**cleaning.240jordanview.com**

## What's been built

| Resource | Status |
|---|---|
| Cloudflare D1 database `jordanview-cleaning` | ✅ Created |
| Cloudflare R2 bucket `jordanview-cleaning-photos` | ✅ Created |
| Pages Functions (reservations, upload, reports) | ✅ Built |
| Frontend portal | ✅ Built |
| WordPress plugin | ✅ Built |

---

## Step 1 — Deploy to Cloudflare Pages

### Prerequisites
```bash
npm install -g wrangler
wrangler login   # opens browser, log in with your Cloudflare account
```

### Deploy
```bash
cd jordanview-cleaning
wrangler pages deploy public --project-name jordanview-cleaning
```

On first run it will create the Pages project. Subsequent deploys update it.

---

## Step 2 — Set secret environment variables

In your Cloudflare dashboard → Pages → jordanview-cleaning → Settings → Environment variables,
add these as **encrypted secrets** (or use the CLI):

```bash
wrangler pages secret put WP_API_URL
# Enter: https://240jordanview.com/wp-json/cleanerportal/v1

wrangler pages secret put WP_API_KEY
# Enter: (generate a random string, e.g. openssl rand -hex 32)
```

Copy the WP_API_KEY value — you'll need it in Step 4.

---

## Step 3 — Add the custom domain

1. Cloudflare dashboard → Pages → jordanview-cleaning → Custom domains
2. Click **Set up a custom domain**
3. Enter: `cleaning.240jordanview.com`
4. Cloudflare will auto-create the DNS CNAME record since 240jordanview.com is already in your account.

---

## Step 4 — Install the WordPress plugin

1. Copy `wordpress-plugin/jordanview-cleaner-api.php` to your WordPress site:
   `/wp-content/plugins/jordanview-cleaner-api/jordanview-cleaner-api.php`
2. Activate it in WordPress → Plugins.
3. In `wp-config.php`, add these two lines (before `/* That's all, stop editing! */`):

```php
define('JV_CLEANER_API_KEY', 'YOUR-SECRET-KEY-FROM-STEP-2');

// If using iCal (Airbnb/VRBO), also add:
// define('JV_ICAL_URL', 'https://www.airbnb.com/calendar/ical/YOUR_ID.ics');
```

4. Open the plugin file and **uncomment the adapter** that matches your booking system:
   - `jv_adapter_wpbs()`    — WP Booking System plugin
   - `jv_adapter_bookly()`  — Bookly plugin
   - `jv_adapter_cpt()`     — Custom post type reservations
   - `jv_adapter_ical()`    — Airbnb / VRBO iCal feed
   - `jv_adapter_placeholder()` — **default (shows test data)**

5. Test it with curl:
```bash
curl -H "X-Cleaner-API-Key: YOUR-SECRET-KEY" \
     https://240jordanview.com/wp-json/cleanerportal/v1/reservations
```
You should get back a JSON array of reservations.

---

## Step 5 — Set up Cloudflare Access (login wall)

This locks the portal to only your cleaner's email address.

1. Cloudflare dashboard → Zero Trust → Access → Applications → **Add an application**
2. Choose **Self-hosted**
3. App name: `Jordan View Cleaner Portal`
4. App domain: `cleaning.240jordanview.com`
5. Under **Policies**, add a policy:
   - Policy name: `Cleaners only`
   - Action: Allow
   - Rule: Emails → add your cleaner's email address (e.g. `cleaner@example.com`)
6. Save.

Your cleaner will now receive a one-time login link to their email when they visit the site —
no password needed.

To add yourself as owner (so you can view reports):
- Add a second policy or add your email to the same list.
- Or create a separate `/reports` Access policy for just your email.

---

## What to tell your cleaner

> "I've set up a private website just for you at **cleaning.240jordanview.com**.
> When you visit it, you'll get a login link sent to [their email].
> Click the link and you'll see all upcoming checkouts, how long you have before
> the next guest arrives, and any notes I've left. If you find any damage, use
> the 'File a report' tab — you can add photos and a description, and I'll get
> notified right away."

---

## File structure

```
jordanview-cleaning/
├── wrangler.toml                    — Cloudflare config (D1 + R2 bindings)
├── public/
│   └── index.html                   — The full portal UI
├── functions/
│   └── api/
│       ├── reservations.js          — GET  /api/reservations  (WP proxy)
│       ├── upload.js                — POST /api/upload        (photos → R2, metadata → D1)
│       └── reports.js               — GET/PATCH /api/reports  (owner dashboard)
└── wordpress-plugin/
    └── jordanview-cleaner-api.php   — WP REST endpoint exposing reservations
```

---

## Cloudflare resources created

| Resource | Name | ID |
|---|---|---|
| D1 Database | `jordanview-cleaning` | `e395268e-9896-4519-b88f-b0213a703c15` |
| R2 Bucket | `jordanview-cleaning-photos` | — |
| Account | PMG Asset Management | `e1ac21482b2f9684fcca4800ae153098` |
