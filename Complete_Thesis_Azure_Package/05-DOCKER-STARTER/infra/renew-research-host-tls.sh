#!/usr/bin/env bash
# Run on the research host as root. Keeps the CA private key on that host,
# renews all three IP-SAN service certificates under the existing root, validates the chain,
# and reloads nginx only after all checks pass. Public CA output can then be
# copied to certs/thesis-pilot-ca.pem for clients to trust.
# The TLS directory must already contain research/collector/restricted CSRs,
# corresponding IP-SAN ext files, and private keys referenced by nginx. The
# restricted.ext SAN must match restrictedServicePrivateIp from the deployment.
set -euo pipefail
umask 077

tls_dir=${TLS_DIR:-/etc/thesis-research/tls}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$tls_dir/backup-$timestamp"
staging=$(mktemp -d)
mkdir -m 700 "$backup"
cp "$tls_dir/ca.crt" "$tls_dir/research.crt" "$tls_dir/collector.crt" "$tls_dir/restricted.crt" "$backup/"
changed=0
rollback() {
  cp "$backup/ca.crt" "$tls_dir/ca.crt"
  cp "$backup/research.crt" "$tls_dir/research.crt"
  cp "$backup/collector.crt" "$tls_dir/collector.crt"
  cp "$backup/restricted.crt" "$tls_dir/restricted.crt"
  nginx -t && systemctl reload nginx
}
cleanup() {
  status=$?
  if [[ $status -ne 0 && $changed -eq 1 ]]; then rollback || true; fi
  rm -f "$tls_dir/ca.crt.new" "$tls_dir/research.crt.new" "$tls_dir/collector.crt.new" "$tls_dir/restricted.crt.new"
  rm -rf "$staging"
  return "$status"
}
trap cleanup EXIT

openssl x509 -req -in "$tls_dir/research.csr" \
  -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" -CAcreateserial \
  -out "$staging/research.crt" -days 365 -sha256 \
  -extfile "$tls_dir/research.ext" >/dev/null
openssl x509 -req -in "$tls_dir/collector.csr" \
  -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" -CAserial "$staging/ca.srl" \
  -out "$staging/collector.crt" -days 365 -sha256 \
  -extfile "$tls_dir/collector.ext" >/dev/null
openssl x509 -req -in "$tls_dir/restricted.csr" \
  -CA "$tls_dir/ca.crt" -CAkey "$tls_dir/ca.key" -CAserial "$staging/ca.srl" \
  -out "$staging/restricted.crt" -days 365 -sha256 \
  -extfile "$tls_dir/restricted.ext" >/dev/null
openssl verify -CAfile "$tls_dir/ca.crt" \
  "$staging/research.crt" "$staging/collector.crt" "$staging/restricted.crt"
cmp <(openssl pkey -in "$tls_dir/ca.key" -pubout 2>/dev/null) \
  <(openssl x509 -in "$tls_dir/ca.crt" -pubkey -noout)

for name in research collector restricted; do
  install -m 0600 "$staging/$name.crt" "$tls_dir/$name.crt.new"
done
changed=1
for name in research collector restricted; do mv "$tls_dir/$name.crt.new" "$tls_dir/$name.crt"; done
nginx -t
systemctl reload nginx
changed=0

for cert in "$tls_dir/research.crt" "$tls_dir/collector.crt" "$tls_dir/restricted.crt"; do
  openssl x509 -in "$cert" -noout -dates -fingerprint -sha256
done
