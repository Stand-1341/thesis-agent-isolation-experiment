#!/usr/bin/env bash
# Run on the research host as root. Keeps the CA private key on that host,
# renews the root and both IP-SAN service certificates, validates the chain,
# and reloads nginx only after all checks pass. Public CA output can then be
# copied to certs/thesis-pilot-ca.pem for clients to trust.
set -euo pipefail
umask 077

tls_dir=${TLS_DIR:-/etc/thesis-research/tls}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$tls_dir/backup-$timestamp"
staging=$(mktemp -d)
mkdir -m 700 "$backup"
cp "$tls_dir/ca.crt" "$tls_dir/research.crt" "$tls_dir/collector.crt" "$backup/"
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT

openssl req -x509 -new -key "$tls_dir/ca.key" -sha256 -days 365 \
  -subj '/CN=Thesis pilot CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign' \
  -out "$staging/ca.crt"
openssl x509 -req -in "$tls_dir/research.csr" \
  -CA "$staging/ca.crt" -CAkey "$tls_dir/ca.key" -CAcreateserial \
  -out "$staging/research.crt" -days 365 -sha256 \
  -extfile "$tls_dir/research.ext" >/dev/null
openssl x509 -req -in "$tls_dir/collector.csr" \
  -CA "$staging/ca.crt" -CAkey "$tls_dir/ca.key" -CAserial "$staging/ca.srl" \
  -out "$staging/collector.crt" -days 365 -sha256 \
  -extfile "$tls_dir/collector.ext" >/dev/null
openssl verify -CAfile "$staging/ca.crt" \
  "$staging/research.crt" "$staging/collector.crt"
cmp <(openssl pkey -in "$tls_dir/ca.key" -pubout 2>/dev/null) \
  <(openssl x509 -in "$staging/ca.crt" -pubkey -noout)

for name in ca research collector; do
  install -m 0600 "$staging/$name.crt" "$tls_dir/$name.crt.new"
done
mv "$tls_dir/ca.crt.new" "$tls_dir/ca.crt"
mv "$tls_dir/research.crt.new" "$tls_dir/research.crt"
mv "$tls_dir/collector.crt.new" "$tls_dir/collector.crt"

rollback() {
  cp "$backup/ca.crt" "$tls_dir/ca.crt"
  cp "$backup/research.crt" "$tls_dir/research.crt"
  cp "$backup/collector.crt" "$tls_dir/collector.crt"
  nginx -t && systemctl reload nginx
}
if ! nginx -t; then rollback; exit 1; fi
if ! systemctl reload nginx; then rollback; exit 1; fi

for cert in "$tls_dir/ca.crt" "$tls_dir/research.crt" "$tls_dir/collector.crt"; do
  openssl x509 -in "$cert" -noout -dates -fingerprint -sha256
done
