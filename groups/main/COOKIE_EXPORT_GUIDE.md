# Cookie Export Guide for Grocery Ordering

This guide explains how to export cookies from your Mac's browser so Raiden can order groceries on your behalf while bypassing Cloudflare protection.

## Why This Works

- **Cloudflare Detection**: Cloudflare can detect automated browsers (headless Chrome) and blocks them
- **Cookie Reuse**: By logging in with your real browser and exporting the session cookies, Raiden can reuse your authenticated session
- **Session Persistence**: Grocery site sessions typically last 14-30 days, so you only need to do this occasionally

## One-Time Setup

### Step 1: Install Cookie Export Extension

**For Chrome/Brave:**
1. Install [Cookie-Editor](https://chrome.google.com/webstore/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm)
2. Or use [EditThisCookie](https://chrome.google.com/webstore/detail/editthiscookie/fngmhnnpilhplaeedifhccceomclgfbg)

**For Safari:**
1. Install [Web Inspector](https://developer.apple.com/safari/tools/) (built-in)
2. Or use [Cookie-Editor for Safari](https://apps.apple.com/app/cookie-editor/id1584476352)

**For Firefox:**
1. Install [Cookie-Editor](https://addons.mozilla.org/en-US/firefox/addon/cookie-editor/)

### Step 2: Log Into Grocery Site

1. Open your browser (Chrome, Safari, Firefox - whichever you prefer)
2. Navigate to the grocery site (e.g., https://www.instacart.com)
3. **Complete the full login flow:**
   - Enter username/password
   - Complete any 2FA/MFA if required
   - **Pass the Cloudflare human check** (if present)
   - Verify you see your account dashboard

### Step 3: Export Cookies

**Using Cookie-Editor (Chrome/Brave/Firefox):**
1. Click the Cookie-Editor extension icon (cookie icon in toolbar)
2. Click "Export" button at the bottom
3. Choose "JSON" format
4. Click "Copy to Clipboard" or "Save as File"
5. Save the file as `instacart-cookies.json` (or similar)

**Using Web Inspector (Safari):**
1. Right-click page → "Inspect Element"
2. Go to "Storage" tab
3. Click "Cookies" in sidebar
4. Select the site domain
5. Right-click cookie list → "Export Cookies"
6. Save as JSON file

**Manual Method (Any Browser):**
1. Open DevTools (F12 or Cmd+Option+I)
2. Go to "Application" tab (Chrome) or "Storage" tab (Firefox/Safari)
3. Click "Cookies" in sidebar
4. Select the site's domain
5. Copy all cookies manually to a JSON file with this format:

```json
[
  {
    "name": "session_token",
    "value": "abc123...",
    "domain": ".instacart.com",
    "path": "/",
    "secure": true,
    "httpOnly": true,
    "sameSite": "Lax"
  }
]
```

### Step 4: Save Cookie File to Raiden's Directory

1. Save the exported cookie file to:
   ```
   ~/Code/nanoclaw/nanoclaw/groups/main/{sitename}-cookies.json
   ```

2. Examples:
   ```
   ~/Code/nanoclaw/nanoclaw/groups/main/dunnes-cookies.json
   ~/Code/nanoclaw/nanoclaw/groups/main/instacart-cookies.json
   ```

## Using Cookies with Raiden

Once you've exported the cookies, tell Raiden:

> "@Raiden, inject the Instacart cookies and set up grocery ordering"

Raiden will:
1. Load the cookies from the JSON file
2. Inject them into the browser profile
3. Test the authenticated session
4. Set up automated ordering capabilities

## When to Re-Export Cookies

You'll need to re-export cookies when:

- **Session expires** (usually 14-30 days)
- **Password changed**
- **Logged out manually**
- **Security prompt** (e.g., "New device detected")

Raiden will alert you when cookies need refresh with a message like:
> "🍪 Cookie refresh needed: Instacart session expired. Please re-export cookies using COOKIE_EXPORT_GUIDE.md"

## Security Notes

⚠️ **Cookie files contain your authentication tokens**
- Never share cookie files with anyone
- Don't commit them to Git (already in .gitignore)
- Store only in `groups/main/` (protected directory)

✅ **This is safe because:**
- Cookies stay on your local machine
- Raiden runs in isolated containers
- Container has read-only access to most filesystem
- Network egress is filtered through proxy

## Troubleshooting

**"Cloudflare check appears again"**
- The site may be doing fingerprint checks beyond just cookies
- Try exporting cookies immediately after passing Cloudflare
- Make sure you're not in incognito/private mode when exporting

**"Session expired" error**
- Re-export fresh cookies after logging in again
- Some sites have shorter session timeouts

**"Invalid cookie format" error**
- Verify JSON format matches the example above
- Check that all required fields are present (name, value, domain)

## Example Workflow

```bash
# 1. User exports cookies (Mac browser → JSON file)
#    File saved: ~/Code/nanoclaw/nanoclaw/groups/main/instacart-cookies.json

# 2. Tell Raiden to set up ordering
#    WhatsApp: "@Raiden inject Instacart cookies"

# 3. Raiden confirms setup
#    "✅ Instacart cookies loaded. Browser profile ready. I can now order groceries!"

# 4. Place an order
#    WhatsApp: "@Raiden order groceries: milk, bread, eggs"

# 5. Raiden shops
#    "🛒 Ordering from Instacart... Added 3 items. Total: $15.47. Confirm?"

# 6. Confirm and checkout
#    WhatsApp: "yes"
#    Raiden: "✅ Order placed! Delivery scheduled for 2pm today."
```

## Supported Sites

Currently tested with:
- ✅ Dunnes Stores Grocery (dunnesstoresgrocery.com)

More sites can be added by following this same cookie export process.
