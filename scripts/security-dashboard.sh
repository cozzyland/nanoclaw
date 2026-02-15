#!/bin/bash
# NanoClaw Security Dashboard
# Displays security events and metrics

set -e

SECURITY_LOG="${SECURITY_LOG_FILE:-./data/security-events.log}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Helper function to count events by field
count_by() {
  local field=$1
  local timeframe=${2:-24h}

  if [ ! -f "$SECURITY_LOG" ]; then
    echo "0"
    return
  fi

  # Simple time filter (last 24h)
  local cutoff=$(date -u -v-24H +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || echo "1970-01-01T00:00:00")

  grep "$field" "$SECURITY_LOG" 2>/dev/null | \
    awk -v cutoff="$cutoff" '{if ($0 > cutoff) print}' | \
    wc -l | tr -d ' '
}

# Display header
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         🔒 NanoClaw Security Dashboard                        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Check if security log exists
if [ ! -f "$SECURITY_LOG" ]; then
  echo "${YELLOW}⚠️  No security events logged yet${NC}"
  echo ""
  echo "Security log will be created at: $SECURITY_LOG"
  echo ""
  exit 0
fi

# Get total event count
TOTAL_EVENTS=$(wc -l < "$SECURITY_LOG" | tr -d ' ')
RECENT_24H=$(awk -v cutoff="$(date -u -v-24H +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || date -u -d '24 hours ago' +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || echo '1970-01-01T00:00:00')" '{if ($0 > cutoff) count++} END {print count+0}' "$SECURITY_LOG")

echo "📊 ${CYAN}Event Summary${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Total events logged: $TOTAL_EVENTS"
echo "  Events (last 24h):   $RECENT_24H"
echo ""

# Severity breakdown
echo "🚨 ${CYAN}Severity Breakdown (Last 24h)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

CRITICAL=$(grep -c '"severity":"critical"' "$SECURITY_LOG" 2>/dev/null || echo "0")
HIGH=$(grep -c '"severity":"high"' "$SECURITY_LOG" 2>/dev/null || echo "0")
MEDIUM=$(grep -c '"severity":"medium"' "$SECURITY_LOG" 2>/dev/null || echo "0")
LOW=$(grep -c '"severity":"low"' "$SECURITY_LOG" 2>/dev/null || echo "0")

echo "  ${RED}🔴 CRITICAL:${NC} $CRITICAL"
echo "  ${YELLOW}🟠 HIGH:${NC}     $HIGH"
echo "  ${BLUE}🟡 MEDIUM:${NC}   $MEDIUM"
echo "  ${GREEN}🟢 LOW:${NC}      $LOW"
echo ""

# Event type breakdown
echo "📋 ${CYAN}Event Types (Last 24h)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

EGRESS=$(grep -c '"type":"egress_blocked"' "$SECURITY_LOG" 2>/dev/null || echo "0")
DLP=$(grep -c '"type":"dlp_violation"' "$SECURITY_LOG" 2>/dev/null || echo "0")
RATE=$(grep -c '"type":"rate_limit_exceeded"' "$SECURITY_LOG" 2>/dev/null || echo "0")
PROMPT=$(grep -c '"type":"prompt_injection"' "$SECURITY_LOG" 2>/dev/null || echo "0")
MEDIA=$(grep -c '"type":"media_file_rejected"' "$SECURITY_LOG" 2>/dev/null || echo "0")
COMMAND=$(grep -c '"type":"high_risk_command"' "$SECURITY_LOG" 2>/dev/null || echo "0")

echo "  🚫 Egress blocked:        $EGRESS"
echo "  🔐 DLP violations:        $DLP"
echo "  ⏱️  Rate limit exceeded:   $RATE"
echo "  💉 Prompt injection:      $PROMPT"
echo "  📎 Media rejected:        $MEDIA"
echo "  ⚠️  High-risk commands:   $COMMAND"
echo ""

# Recent critical events
if [ "$CRITICAL" -gt 0 ]; then
  echo "${RED}⚠️  CRITICAL ALERTS${NC}"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  grep '"severity":"critical"' "$SECURITY_LOG" | tail -5 | while read -r line; do
    TIMESTAMP=$(echo "$line" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4)
    TYPE=$(echo "$line" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
    DESC=$(echo "$line" | grep -o '"description":"[^"]*"' | cut -d'"' -f4 | head -c 60)
    echo "  ${RED}[$TIMESTAMP]${NC} $TYPE: $DESC"
  done
  echo ""
fi

# Recent events (last 10)
echo "📝 ${CYAN}Recent Events (Last 10)${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
tail -10 "$SECURITY_LOG" | while read -r line; do
  TIMESTAMP=$(echo "$line" | grep -o '"timestamp":"[^"]*"' | cut -d'"' -f4 | cut -d'T' -f2 | cut -d'.' -f1)
  TYPE=$(echo "$line" | grep -o '"type":"[^"]*"' | cut -d'"' -f4)
  SEVERITY=$(echo "$line" | grep -o '"severity":"[^"]*"' | cut -d'"' -f4)
  DESC=$(echo "$line" | grep -o '"description":"[^"]*"' | cut -d'"' -f4 | head -c 50)

  # Color by severity
  case "$SEVERITY" in
    critical) COLOR=$RED ;;
    high)     COLOR=$YELLOW ;;
    medium)   COLOR=$BLUE ;;
    low)      COLOR=$GREEN ;;
    *)        COLOR=$NC ;;
  esac

  echo "  ${COLOR}[$TIMESTAMP]${NC} $TYPE: $DESC"
done
echo ""

# Anomaly detection
echo "🔍 ${CYAN}Anomaly Detection${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$RECENT_24H" -gt 100 ]; then
  echo "  ${YELLOW}⚠️  High event rate: $RECENT_24H events in 24h${NC}"
fi

if [ "$CRITICAL" -gt 0 ]; then
  echo "  ${RED}🚨 $CRITICAL critical events require immediate attention${NC}"
fi

if [ "$DLP" -gt 0 ]; then
  echo "  ${RED}🔐 $DLP data exfiltration attempts detected${NC}"
fi

if [ "$RECENT_24H" -eq 0 ]; then
  echo "  ${GREEN}✅ No security events in last 24 hours${NC}"
fi

if [ "$CRITICAL" -eq 0 ] && [ "$HIGH" -eq 0 ] && [ "$RECENT_24H" -lt 20 ]; then
  echo "  ${GREEN}✅ System security status: Normal${NC}"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Log file: $SECURITY_LOG"
echo "  View full log: ${CYAN}tail -f $SECURITY_LOG | jq${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
