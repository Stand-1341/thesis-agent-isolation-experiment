#!/usr/bin/env bash
# Stage one route VM's nginx TLS listener. Does not start/reload nginx or the
# workload service. The route installer controls activation after health checks.
set -euo pipefail
umask 077

if [[ $(id -u) -ne 0 || $# -ne 4 ]]; then
  echo 'Usage (as root): install-vm-agent-tls.sh PRIVATE_IPV4 CERT_FILE KEY_FILE NGINX_TEMPLATE' >&2
  exit 2
fi
private_ip=$1
cert_file=$2
key_file=$3
template=$4
if [[ ! $private_ip =~ ^(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3})$ ]]; then
  echo 'A private IPv4 listener address is required' >&2
  exit 2
fi
IFS=. read -r a b c d <<< "$private_ip"
for octet in "$a" "$b" "$c" "$d"; do
  ((10#$octet <= 255)) || { echo 'Invalid IPv4 address' >&2; exit 2; }
done
[[ -f $cert_file && -f $key_file && -f $template && ! -L $cert_file && ! -L $key_file && ! -L $template ]] || {
  echo 'Certificate, private key, and template must be regular files' >&2; exit 2;
}
[[ $(stat -c '%u:%a' "$key_file") == '0:600' ]] || {
  echo 'Route private key must be root-owned with mode 600' >&2; exit 1;
}
ca_cert=/opt/thesis-agent/certs/thesis-pilot-ca.pem
[[ -f $ca_cert && ! -L $ca_cert ]] || { echo 'Bundled public CA certificate is missing' >&2; exit 1; }
openssl verify -CAfile "$ca_cert" -verify_ip "$private_ip" "$cert_file" >/dev/null || {
  echo 'Route certificate chain or IP SAN does not match this VM' >&2; exit 1;
}
openssl x509 -in "$cert_file" -noout -checkend 2592000 >/dev/null || {
  echo 'Route certificate expires within 30 days' >&2; exit 1;
}
cert_pub=$(openssl x509 -in "$cert_file" -pubkey -noout | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum | cut -d ' ' -f 1)
key_pub=$(openssl pkey -in "$key_file" -pubout -outform DER 2>/dev/null | sha256sum | cut -d ' ' -f 1)
[[ -n $cert_pub && $cert_pub == "$key_pub" ]] || { echo 'Route certificate does not match private key' >&2; exit 1; }
command -v nginx >/dev/null 2>&1 || { echo 'nginx must be installed before staging TLS' >&2; exit 1; }
[[ -f /etc/systemd/system/thesis-agent.service ]] || { echo 'VM agent systemd unit is missing' >&2; exit 1; }
grep -Fq 'Environment=BIND_ADDRESS=127.0.0.1' /etc/systemd/system/thesis-agent.service || {
  echo 'VM agent must bind to loopback before TLS proxy installation' >&2; exit 1;
}
[[ $(grep -o '__VM_PRIVATE_IP__' "$template" | wc -l) -eq 2 ]] || {
  echo 'nginx template must contain exactly two listener IP placeholders' >&2; exit 1;
}

tls_dir=/etc/thesis-agent/tls
site=/etc/nginx/sites-available/thesis-agent
link=/etc/nginx/sites-enabled/thesis-agent
if [[ -e $site || -e $link ]]; then
  echo 'Existing VM agent TLS site found; refusing to overwrite' >&2
  exit 1
fi
install -d -o root -g root -m 0700 "$tls_dir"
[[ $key_file == "$tls_dir/agent.key" ]] || install -o root -g root -m 0600 "$key_file" "$tls_dir/agent.key"
[[ $cert_file == "$tls_dir/agent.crt" ]] || install -o root -g root -m 0600 "$cert_file" "$tls_dir/agent.crt"
sed "s/__VM_PRIVATE_IP__/$private_ip/g" "$template" > "$site"
chown root:root "$site"
chmod 0644 "$site"
ln -s "$site" "$link"
if ! nginx -t; then
  rm -f "$link" "$site"
  [[ $cert_file == "$tls_dir/agent.crt" ]] || rm -f "$tls_dir/agent.crt"
  [[ $key_file == "$tls_dir/agent.key" ]] || rm -f "$tls_dir/agent.key"
  echo 'nginx validation failed; staged TLS files were removed' >&2
  exit 1
fi
echo 'TLS listener staged and nginx syntax validated; no service was started or reloaded.'
