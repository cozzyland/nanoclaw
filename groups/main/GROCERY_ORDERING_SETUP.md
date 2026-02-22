# Grocery Ordering - Dunnes Stores

## How It Works

Dunnes is behind Cloudflare Turnstile. Playwright's automation flags get detected, so we launch Chromium directly (clean, no automation flags) and the agent controls it via CDP (`agent-browser --cdp 9222`).

When human interaction is needed (Cloudflare challenges, login, payment, 3D Secure), the user gets a **noVNC link** — a live view of the browser they can interact with from any device (phone, tablet, laptop).

## For Raiden

### Opening Dunnes (Cloudflare-Protected)

**IMPORTANT:** Do NOT use `agent-browser open` for Dunnes. Playwright adds automation flags that Cloudflare detects. Instead, launch Chromium directly:

```bash
# Kill any existing browser sessions
rm -f ~/.agent-browser/*.pid ~/.agent-browser/*.sock 2>/dev/null
pkill -f chromium 2>/dev/null
sleep 1

# Launch clean Chromium (no automation flags) in background
bash /app/scripts/launch-browser.sh https://www.dunnesstoresgrocery.com &
sleep 3

# Check if it's running
agent-browser --cdp 9222 snapshot
```

### If Cloudflare Challenge Appears

Check the snapshot for "Just a moment...", "Verify you are human", or a mostly-empty page:

1. Read the noVNC URL: `cat /workspace/ipc/vnc-url.txt`
2. Send the user: "Cloudflare challenge on Dunnes. Please open this link to solve it: [URL]. Let me know when done."
3. Wait for the user to respond
4. Verify: `agent-browser --cdp 9222 snapshot`
5. Continue with the task

### Session Persistence

Browser state (cookies, login, cart) persists in `/workspace/group/.chromium-data` across container restarts. This means:
- Once the user logs in, they stay logged in for future sessions
- Cart items persist between container runs
- Cloudflare clearance cookies are retained (challenge may not need re-solving)

If things go wrong (stale cache, broken state), reset with:
```bash
rm -rf /workspace/group/.chromium-data
```

### If Login Is Needed

If the snapshot shows a login page, "Sign In", or "Guest" account:

1. Read the noVNC URL: `cat /workspace/ipc/vnc-url.txt`
2. Send the user: "Dunnes needs you to log in. Please open this link and sign in: [URL]. Let me know when done."
3. Wait for the user to respond
4. Verify: `agent-browser --cdp 9222 snapshot`
5. Continue with the task (login will persist for future sessions)

### Checkout and Payment

When the user is ready to checkout:

1. Navigate to cart: `agent-browser --cdp 9222 open https://www.dunnesstoresgrocery.com/sm/delivery/rsid/207/cart`
2. Take a snapshot to confirm cart contents: `agent-browser --cdp 9222 snapshot -i`
3. Tell the user what's in the cart and the total
4. If the user confirms, proceed to checkout page
5. Read the noVNC URL: `cat /workspace/ipc/vnc-url.txt`
6. Send the user: "Ready for checkout. Please open this link to enter your card details and complete the order: [URL]. Let me know when done."
7. Wait for the user to respond (they may need to handle 3D Secure too)
8. Verify: `agent-browser --cdp 9222 snapshot`
9. Confirm the order was placed

### Browsing and Ordering

After Cloudflare is solved, use `--cdp 9222` for ALL agent-browser commands:

```bash
# Take interactive snapshot
agent-browser --cdp 9222 snapshot -i

# Search for items
agent-browser --cdp 9222 type @e12 "organic milk"
agent-browser --cdp 9222 click @e15

# Navigate
agent-browser --cdp 9222 open https://www.dunnesstoresgrocery.com/cart
agent-browser --cdp 9222 snapshot -i
```

### What NOT To Do

- **Do NOT use `agent-browser open`** for Dunnes (Playwright automation flags trigger Cloudflare)
- Do NOT inject cookies from the host Chrome (TLS fingerprint mismatch)
- Do NOT use curl or fetch (requires browser JS execution)
- Do NOT retry Cloudflare challenges automatically (only the user can solve them)
- Do NOT tell the user to open `chrome://inspect` — use the noVNC link instead

### For Non-Cloudflare Sites

For sites without Cloudflare protection, continue using `agent-browser` normally (without `--cdp`). The clean Chromium launch is only needed for Cloudflare-protected sites.
