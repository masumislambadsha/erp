#!/usr/bin/env bash
# Compare hosting regions from where you sit (run it from Dhaka, on the network you will really use).
#   bash scripts/latency-test.sh                       # a built-in list of public test hosts (best effort, may change)
#   bash scripts/latency-test.sh -n 20 sgp=sgp-ping.vultr.com mum=speedtest.mumbai1.linode.com
#   bash scripts/latency-test.sh -p /health mine=erp.example.com   # your own server, a path that answers quickly
# For each host: ICMP ping (if it is allowed), then HTTPS timings from curl, N times: DNS, TCP connect, TLS, time to first
# byte, total. The table shows the median and the 95th percentile in milliseconds, lowest TTFB first.
# The number that matters for an ERP is TTFB: it is what a click feels like, TLS and all.
set -uo pipefail
n=10; path=/; scheme=https
while getopts "n:p:s:" o; do case $o in n) n=$OPTARG ;; p) path=$OPTARG ;; s) scheme=$OPTARG ;; *) exit 2 ;; esac; done
shift $((OPTIND - 1))
if [ $# -eq 0 ]; then
  set -- "singapore-vultr=sgp-ping.vultr.com" "singapore-linode=speedtest.singapore.linode.com" "singapore-do=speedtest-sgp1.digitalocean.com" \
         "mumbai-linode=speedtest.mumbai1.linode.com" "bangalore-do=speedtest-blr1.digitalocean.com" "delhi-vultr=del-in-ping.vultr.com" \
         "mumbai-vultr=bom-ping.vultr.com" "tokyo-vultr=hnd-jp-ping.vultr.com" "frankfurt-hetzner=fsn1-speed.hetzner.com"
fi
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
pct() { sort -n | awk -v p="$1" '{a[NR]=$1} END {if (NR==0) {print "-"; exit} i=int((p/100)*NR+0.999999); if (i<1) i=1; printf "%.0f", a[i]}'; }
printf '%-22s %-34s %8s %8s %8s %8s %8s %8s\n' "name" "host" "ping" "tcp" "tls" "ttfb" "ttfb95" "fails"
rows=()
for spec in "$@"; do
  name=${spec%%=*}; host=${spec#*=}; [ "$name" = "$spec" ] && name=$host
  ping_ms="-"
  if command -v ping >/dev/null; then
    ping_ms=$(ping -c 5 -W 2 "$host" 2>/dev/null | awk -F'/' '/^(rtt|round-trip)/ {printf "%.0f", $5}'); ping_ms=${ping_ms:--}
  fi
  tcp=(); tls=(); ttfb=(); fails=0
  for _ in $(seq 1 "$n"); do
    t=$(curl -s -o /dev/null -m 10 -w '%{time_connect} %{time_appconnect} %{time_starttransfer} %{http_code}' "$scheme://$host$path" 2>/dev/null) || { fails=$((fails + 1)); continue; }
    read -r c a s code <<<"$t"
    if [ "${code:-000}" = 000 ]; then fails=$((fails + 1)); continue; fi
    tcp+=("$(awk -v x="$c" 'BEGIN{printf "%.1f", x*1000}')"); tls+=("$(awk -v x="$a" -v c="$c" 'BEGIN{printf "%.1f", (x-c)*1000}')"); ttfb+=("$(awk -v x="$s" 'BEGIN{printf "%.1f", x*1000}')")
  done
  med() { printf '%s\n' "$@" | pct 50; }
  p95() { printf '%s\n' "$@" | pct 95; }
  if [ ${#ttfb[@]} -gt 0 ]; then
    rows+=("$(printf '%s|%-22s %-34s %8s %8s %8s %8s %8s %8s' "$(med "${ttfb[@]}")" "$name" "$host" "$ping_ms" "$(med "${tcp[@]}")" "$(med "${tls[@]}")" "$(med "${ttfb[@]}")" "$(p95 "${ttfb[@]}")" "$fails")")
  else
    rows+=("999999|$(printf '%-22s %-34s %8s %8s %8s %8s %8s %8s' "$name" "$host" "$ping_ms" "-" "-" "-" "-" "$fails")")
  fi
done
printf '%s\n' "${rows[@]}" | sort -t'|' -k1,1n | cut -d'|' -f2-
echo
echo "ms. 'tls' is the handshake alone. Lower ttfb is better; a high ttfb95 beside a low median means a jittery path."
