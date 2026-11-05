#!/usr/bin/env bash
# Generate a route-local TLS private key and CSR. The private key never leaves
# this VM. Only the CSR (public material) is sent to the research host for CA
# signing. Run as root after the route NIC has its final private IP.
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 || $# -ne 1 ]]; then
  echo 'Usage (as root): create-vm-agent-csr.sh PRIVATE_IPV4' >&2
  exit 2
fi
private_ip=$1
if [[ ! $private_ip =~ ^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})$ ]]; then
  echo 'A private IPv4 listener address is required' >&2
  exit 2
fi
IFS=. read -r a b c d <<< "$private_ip"
for octet in "$a" "$b" "$c" "$d"; do
  ((10#$octet <= 255)) || { echo 'Invalid IPv4 address' >&2; exit 2; }
done

tls_dir=/etc/thesis-agent/tls
install -d -o root -g root -m 0700 "$tls_dir"
key="$tls_dir/agent.key"
csr="$tls_dir/agent.csr"
if [[ -e $key || -e $csr ]]; then
  echo 'Existing route key or CSR found; refusing to overwrite' >&2
  exit 1
fi
openssl req -new -newkey rsa:3072 -nodes -sha256 \
  -keyout "$key" -out "$csr" -subj "/CN=$private_ip" \
  -addext "subjectAltName=IP:$private_ip" >/dev/null 2>&1
chmod 0600 "$key"
chmod 0644 "$csr"
chown root:root "$key" "$csr"
echo "Route CSR ready at $csr; private key remains in $tls_dir."
