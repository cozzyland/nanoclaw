# DCG (Destructive Command Guard) Update Procedure

## Overview

DCG is installed from a remote script, which creates a supply chain security risk. This document outlines the safe procedure for updating dcg.

## Current Installation

**Location:** `container/Dockerfile` (line ~30-40)
**Method:** Download and execute install script from GitHub
**Security:** Pinned to specific commit hash, with checksum verification pending

## Security Risks

1. **Remote Code Execution:** Installing from a script fetched from the internet
2. **Supply Chain Attack:** If the GitHub repo or account is compromised
3. **Man-in-the-Middle:** Network interception could replace the script

## Safe Update Procedure

### Step 1: Review Changes

Before updating, manually review what changed in dcg:

```bash
# See commits since last update
git log [OLD_COMMIT]..[NEW_COMMIT] --oneline

# View diff of install script
git diff [OLD_COMMIT] [NEW_COMMIT] -- install.sh
```

**What to look for:**
- Unexpected system commands
- Network requests to unknown domains
- File modifications outside expected paths
- Binary downloads without verification

### Step 2: Calculate Checksum

```bash
# Download the new install script
DCG_COMMIT="[NEW_COMMIT_HASH]"
curl -fsSL "https://raw.githubusercontent.com/Dicklesworthstone/destructive_command_guard/${DCG_COMMIT}/install.sh" -o /tmp/dcg-install.sh

# Calculate SHA256 checksum
sha256sum /tmp/dcg-install.sh

# Example output:
# a1b2c3d4e5f6... /tmp/dcg-install.sh
```

Save this checksum - you'll add it to the Dockerfile.

### Step 3: Update Dockerfile

```dockerfile
# In container/Dockerfile
ARG DCG_COMMIT=<NEW_COMMIT_HASH>
ARG DCG_EXPECTED_SHA256=<CHECKSUM_FROM_STEP_2>

RUN set -e && \
    curl -fsSL "${DCG_INSTALL_URL}" -o /tmp/dcg-install.sh && \
    echo "${DCG_EXPECTED_SHA256}  /tmp/dcg-install.sh" | sha256sum -c - && \
    chmod +x /tmp/dcg-install.sh && \
    /tmp/dcg-install.sh --easy-mode --system && \
    rm /tmp/dcg-install.sh
```

### Step 4: Test Locally

```bash
# Rebuild container with new dcg version
cd container
./build.sh

# Test that dcg works
container run -i --rm nanoclaw-agent:latest dcg --version

# Test a blocked command
container run -i --rm nanoclaw-agent:latest dcg --stdin <<< "git reset --hard"
# Should output: BLOCKED
```

### Step 5: Commit Changes

```bash
git add container/Dockerfile
git commit -m "security: update dcg to commit ${DCG_COMMIT}

- Verified install script changes
- Updated SHA256 checksum: ${DCG_EXPECTED_SHA256}
- Tested container build and dcg functionality"
```

## Alternative: Compile from Source

For maximum security, compile dcg from source instead of using the installer:

```dockerfile
# In container/Dockerfile
ARG DCG_COMMIT=<COMMIT_HASH>

RUN set -e && \
    git clone https://github.com/Dicklesworthstone/destructive_command_guard.git /tmp/dcg && \
    cd /tmp/dcg && \
    git checkout ${DCG_COMMIT} && \
    cargo build --release && \
    cp target/release/dcg /usr/local/bin/ && \
    rm -rf /tmp/dcg
```

**Pros:**
- No remote script execution
- Full visibility into what's being built
- Can verify source code before compiling

**Cons:**
- Requires 4-8GB RAM (causes OOM in constrained builds)
- Longer build time (~5-10 minutes)
- Requires Rust toolchain in container

## Monitoring for Supply Chain Compromises

**GitHub Watch:** Enable notifications for the dcg repository
- Settings → Watch → Custom → Releases only

**Dependabot:** (TODO) Set up Dependabot to alert on dcg updates
- Would require moving dcg to package.json as a binary dependency

**Manual Checks:** Periodically review dcg repository
- Check for suspicious commits
- Verify maintainer account hasn't changed
- Look for unusual contributor activity

## Current Status

- ✅ Using pinned commit instead of "master"
- ⚠️ Checksum verification pending (placeholder in Dockerfile)
- ❌ Automated supply chain monitoring not set up

## TODO

1. Add actual SHA256 checksum verification to Dockerfile
2. Document current dcg commit hash and checksum
3. Set up automated alerts for dcg updates
4. Consider hosting a verified copy of install.sh in this repo
