# Grocery Ordering Setup - Quick Start

## For the User

### First-Time Setup (One Time)

1. **Export cookies from your browser:**
   - Read detailed instructions in `COOKIE_EXPORT_GUIDE.md`
   - Save cookies to: `~/Code/nanoclaw/nanoclaw/groups/main/instacart-cookies.json`

2. **Tell Raiden to inject cookies:**
   ```
   @Raiden inject Instacart cookies
   ```

3. **Done!** Raiden can now order groceries on your behalf.

### When Cookies Expire (~30 days)

Raiden will alert you:
> "🍪 Cookie refresh needed: Instacart session expired. Please re-export cookies using COOKIE_EXPORT_GUIDE.md"

Then repeat step 1 above.

## For Raiden (Container Context)

### Cookie Injection Workflow

When user asks to "inject cookies" or "set up grocery ordering":

```bash
# 1. Check for cookie file
ls -la /workspace/group/*-cookies.json

# 2. Inject cookies (example: Instacart)
node /app/scripts/inject-cookies.js groceries /workspace/group/instacart-cookies.json

# 3. Test the session
agent-browser --profile groceries open https://www.instacart.com
agent-browser snapshot

# 4. Verify logged-in state
# Look for user's name, account menu, cart icon, etc.
```

### Grocery Ordering Workflow

```bash
# 1. Open grocery site with saved profile
agent-browser --profile groceries open https://www.instacart.com

# 2. Navigate and add items
agent-browser snapshot -i  # See interactive elements
agent-browser type @e12 "organic milk"  # Search
agent-browser click @e15  # Add to cart

# 3. Checkout
agent-browser click @e20  # Go to cart
agent-browser click @e25  # Checkout
agent-browser click @e30  # Place order
```

### Session Expiry Detection

If you see:
- Login page when expecting dashboard
- "Please sign in" messages
- 401/403 errors

Alert the user:
```
🍪 Cookie refresh needed: {Site} session expired. Please re-export cookies using COOKIE_EXPORT_GUIDE.md
```

### Supported Sites

- **Instacart** - Profile: `groceries`, Cookies: `instacart-cookies.json`
- **Amazon Fresh** - Profile: `amazon-groceries`, Cookies: `amazonfresh-cookies.json`
- **Walmart Grocery** - Profile: `walmart-groceries`, Cookies: `walmart-cookies.json`

## Security Notes

✅ **Safe:**
- Cookies stored on local filesystem only
- Container has isolated profile directory
- Egress proxy filters network traffic

⚠️ **Important:**
- Cookie files contain authentication tokens
- Never share cookie files
- .gitignore excludes them from version control
