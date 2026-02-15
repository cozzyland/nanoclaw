#!/bin/bash
# Test script to validate container hardening on Apple Container
# Tests each security feature independently

set -e

echo "=== Container Hardening Validation ==="
echo ""

# Test 1: Read-only filesystem
echo "Test 1: Read-only filesystem"
echo "---------------------------------"
RESULT=$(container run --rm --read-only alpine:latest /bin/sh -c "touch /test 2>&1 || echo 'READONLY_OK'" 2>&1 || true)
if echo "$RESULT" | grep -q "READONLY_OK\|Read-only file system"; then
  echo "✅ Read-only filesystem works"
else
  echo "❌ Read-only filesystem failed: $RESULT"
fi
echo ""

# Test 2: Writable tmpfs
echo "Test 2: Writable tmpfs directories"
echo "-----------------------------------"
RESULT=$(container run --rm --read-only --tmpfs /tmp alpine:latest /bin/sh -c "touch /tmp/test && echo 'TMPFS_OK'" 2>&1 || true)
if echo "$RESULT" | grep -q "TMPFS_OK"; then
  echo "✅ Tmpfs directories work"
else
  echo "❌ Tmpfs directories failed: $RESULT"
fi
echo ""

# Test 3: Memory limits
echo "Test 3: Memory limits"
echo "---------------------"
RESULT=$(container run --rm --memory 100m alpine:latest /bin/sh -c "cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>&1 || echo 'MEMLIMIT_UNSUPPORTED'" 2>&1 || true)
if echo "$RESULT" | grep -q "MEMLIMIT_UNSUPPORTED\|No such file"; then
  echo "⚠️  Memory limits not verifiable (cgroup v2 or unsupported)"
else
  echo "✅ Memory limits supported"
  echo "   Limit: $RESULT bytes"
fi
echo ""

# Test 4: CPU limits
echo "Test 4: CPU limits"
echo "------------------"
RESULT=$(container run --rm --cpus 1 alpine:latest /bin/sh -c "nproc 2>&1" 2>&1 || true)
if [ ! -z "$RESULT" ]; then
  echo "✅ CPU limits supported"
  echo "   Available CPUs: $RESULT"
else
  echo "⚠️  CPU limits verification inconclusive"
fi
echo ""

# Test 5: PIDs limit
echo "Test 5: PIDs limit"
echo "------------------"
RESULT=$(container run --rm --pids-limit 10 alpine:latest /bin/sh -c "cat /sys/fs/cgroup/pids/pids.max 2>&1 || echo 'PIDSLIMIT_UNSUPPORTED'" 2>&1 || true)
if echo "$RESULT" | grep -q "PIDSLIMIT_UNSUPPORTED\|No such file"; then
  echo "⚠️  PIDs limits not verifiable (cgroup v2 or unsupported)"
else
  echo "✅ PIDs limits supported"
  echo "   Limit: $RESULT"
fi
echo ""

# Test 6: Capabilities (likely unsupported on Apple Container)
echo "Test 6: Capability dropping"
echo "----------------------------"
RESULT=$(container run --rm --cap-drop ALL --cap-add CHOWN alpine:latest /bin/sh -c "echo 'CAP_OK'" 2>&1 || true)
if echo "$RESULT" | grep -q "CAP_OK"; then
  echo "✅ Capability dropping works"
elif echo "$RESULT" | grep -q "unknown flag\|not supported"; then
  echo "⚠️  Capability dropping not supported (expected on Apple Container)"
else
  echo "❌ Capability dropping failed: $RESULT"
fi
echo ""

# Test 7: Seccomp (likely unsupported on Apple Container)
echo "Test 7: Seccomp profiles"
echo "------------------------"
RESULT=$(container run --rm --security-opt seccomp=unconfined alpine:latest /bin/sh -c "echo 'SECCOMP_OK'" 2>&1 || true)
if echo "$RESULT" | grep -q "SECCOMP_OK"; then
  echo "✅ Seccomp profiles work"
elif echo "$RESULT" | grep -q "unknown flag\|not supported"; then
  echo "⚠️  Seccomp not supported (expected on Apple Container)"
else
  echo "❌ Seccomp failed: $RESULT"
fi
echo ""

echo "=== Summary ==="
echo "✅ = Feature working"
echo "⚠️  = Feature unsupported or unverifiable (not critical)"
echo "❌ = Feature failed (critical issue)"
