# Headway

Compare commutes from several starting points to one destination at a time. Tap a destination and every
starting point is ranked by its round trip on transit for the shift you pick. Car times, walking, every
start time from 8 AM to 1 PM, trip details, Copy for Sheets and CSV export are built in.

Everything runs in your browser. Google Maps Platform does the routing with your own key, which you paste
into Settings. The key is never in this code, so the public GitHub page can't use it.

## Before you rely on it

- **Not yet tested against real Google.** It was tested end to end against a stand-in that copies Google's
  documented request rules. Your first run with a real key is the first real test.
- **Saved results:** results are kept on your device for 30 days, then delete themselves. Google's terms
  don't clearly allow keeping travel times, so this is your call (you chose it).
- **Times are estimates.** Transit times follow published schedules; car times for a future day are
  Google's traffic predictions.
- **Shared website address.** Every GitHub Pages project of yours lives at `audnovie.github.io`, and they
  all share browser storage and the key's website permission. Any other page you put there could read and
  use the key. Only put your own trusted apps there, or give Headway its own domain later.

## 1. Put it on GitHub Pages (about 5 minutes)

1. Unzip the download. In any PowerShell window (change the path if the zip saved somewhere else):

   ```powershell
   Expand-Archive -Path "$HOME\Downloads\headway.zip" -DestinationPath "$HOME\Downloads\headway" -Force
   explorer "$HOME\Downloads\headway"
   ```

2. On github.com, make a new repository named `headway`. Set it to **Public** (GitHub Pages needs a public
   repository on a free account) and create it.
3. On the new repository's page, choose **uploading an existing file**, drag in every file from the
   folder that opened (not the folder itself), and commit.
4. Go to **Settings → Pages**. Under **Build and deployment**, set Source to **Deploy from a branch**,
   Branch to **main** and folder **/ (root)**, then Save. After a minute or two the app is at
   `https://audnovie.github.io/headway/` (your GitHub username, lowercase).

## 2. Make your Google key (about 15 minutes)

1. Go to <https://console.cloud.google.com>, create a project (for example "Headway").
2. Turn on billing for the project and add a card. Google's free monthly amounts are used first.
3. In **APIs & Services → Library**, enable all three: **Maps JavaScript API**, **Routes API**,
   **Geocoding API**.
4. In **APIs & Services → Credentials**, create an **API key**, then edit it:
   - **Application restrictions:** Websites, and add `https://audnovie.github.io/*`
   - **API restrictions:** Restrict key, and tick the same three APIs.
   - Save. Changes can take a few minutes to start working.
5. Safety limits:
   - **Budget alert:** in Billing, create a budget (for example $5) with email alerts. A budget only emails
     you; it doesn't stop charges.
   - **Daily cap:** on each API's Quotas page, set a per-day limit if one is offered (for example 1,000).
     Google's labels change, so look for "per day".
   - The app also asks before going past a free amount, as counted on that device (Settings).
6. Open your app, go to **Settings**, paste the key and tap **Save key**.

If the map shows an error such as "RefererNotAllowedMapError", the key's website restriction doesn't
match. Check it's exactly `https://audnovie.github.io/*`, then wait a few minutes and reload.

## 3. On your iPhone

Open the app in Safari, then **Share → Add to Home Screen**. Open it from the new icon. The Home Screen
app keeps its own storage, separate from Safari, so it starts empty: paste your key in Settings again, and
use **Settings → Restore from backup** to bring in places you added elsewhere. Safari deletes a website's
saved data after 7 days without a visit, and Home Screen apps don't have that problem.

## Using it

- **Places:** paste one address per line. Add a nickname with a bar: `Home | 10 Peel Centre Dr, Brampton`.
  Check any "partial match" flags.
- **Compare:** tap a destination. Pick the day and when your shift starts. Each starting point shows the
  trip there (arriving 10 minutes early) and home (leaving when the 8-hour shift ends).
- **Car times** and **All start times** only run when you tap them. The button shows how many of
  Google's free amount it uses.
- **Trip details** shows the buses, stops, transfers, walking and fare, and opens the trip in Google Maps.
  Google Maps links can't carry a time, so Maps opens with "leave now": set "Arrive by" or "Depart at"
  there to match.
- **Copy for Sheets** copies the table to paste into Google Sheets. **Download CSV** saves a file you can
  bring in with File → Import.
- **Settings** holds your shift length, how early to arrive, shifts per week, the walking distance limit,
  the free-use meter, backups and saved results.

## Updating

Upload the changed files to the repository the same way (Add file → Upload files). They replace the old
ones. GitHub Pages can take about 10 minutes to show the new version; each update changes the `?v=`
number in `index.html` so phones don't mix old and new files.
