#!/usr/bin/env bash
# Sign one route VM's public CSR using the research-host CA. The CA key stays
# root-only on that host and is never printed or copied. Run as root there.
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 || $# -ne 3 ]]; then
  echo 'Usage (as root on research host): sign-vm-agent-csr.sh CSR_FILE PRIVATE_IPV4 OUTPUT_CERT' >&2
  exit 2
fi
csr=$1
private_ip=$2
output_cert=$3
if [[ ! -f $csr || -L $csr || -e $output_cert ]]; then
  echo 'CSR must be a regular file and output certificate must not exist' >&2
  exit 2
fi
if [[ ! $private_ip =~ ^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})$ ]]; then
  echo 'A private IPv4 listener address is required' >&2
  exit 2
fi
IFS=. read -r a b c d <<< "$private_ip"
for octet in "$a" "$b" "$c" "$d"; do
  ((10#$octet <= 255)) || { echo 'Invalid IPv4 address' >&2; exit 2; }
done

tls_dir=${TLS_DIR:-/etc/thesis-research/tls}
ca_cert="$tls_dir/ca.crt"
ca_key="$tls_dir/ca.key"
serial="$tls_dir/ca.srl"
[[ -f $ca_cert && -f $ca_key && ! -L $ca_cert && ! -L $ca_key ]] || {
  echo 'Research-host CA material is unavailable' >&2; exit 1;
}
[[ $(stat -c '%u:%a' "$ca_key") == '0:600' ]] || {
  echo 'CA private key must be root-owned with mode 600' >&2; exit 1;
}
openssl req -verify -in "$csr" -noout >/dev/null 2>&1 || {
  echo 'CSR signature is invalid' >&2; exit 1;
}
openssl x509 -in "$ca_cert" -noout -checkend 2592000 >/dev/null || {
  echo 'CA certificate expires too soon' >&2; exit 1;
}

lock="$tls_dir/.vm-agent-ca-sign.lock"
exec 9>"$lock"
flock -x 9
staging=$(mktemp -d "$tls_dir/.vm-agent-sign.XXXXXX")
cleanup() { rm -rf "$staging"; }
trap cleanup EXIT
cat > "$staging/agent.ext" <<EOF
[vm_agent_server]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:$private_ip
EOF
openssl x509 -req -in "$csr" -CA "$ca_cert" -CAkey "$ca_key" \
  -CAserial "$serial" -CAcreateserial -out "$staging/agent.crt" \
  -days 300 -sha256 -extfile "$staging/agent.ext" -extensions vm_agent_server >/dev/null 2>&1
openssl verify -CAfile "$ca_cert" -verify_ip "$private_ip" "$staging/agent.crt" >/dev/null || {
  echo 'Issued certificate failed chain or IP SAN verification' >&2; exit 1;
}
openssl x509 -in "$staging/agent.crt" -noout -checkend 2592000 >/dev/null || {
  echo 'Issued certificate expires too soon' >&2; exit 1;
}
install -o root -g root -m 0600 "$staging/agent.crt" "$output_cert"
echo 'Route certificate signed and validated; CA private key remains on this host.'
