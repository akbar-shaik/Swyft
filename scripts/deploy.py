import os
import paramiko

VPS_HOST = '51.79.250.191'
VPS_USER = 'repinkadmin'
VPS_PASS = 'Akbar@1997'

print(f"Connecting to {VPS_HOST} as {VPS_USER}...")
ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(VPS_HOST, username=VPS_USER, password=VPS_PASS, timeout=15)

def run_sudo(cmd):
    full_cmd = f"echo '{VPS_PASS}' | sudo -S bash -c \"{cmd}\""
    stdin, stdout, stderr = ssh.exec_command(full_cmd)
    out = stdout.read().decode()
    err = stderr.read().decode()
    return out, err

# 1. Create target directories
print("Setting up /var/www/cloudipa...")
out, err = run_sudo("mkdir -p /var/www/cloudipa/downloads && chown -R repinkadmin:repinkadmin /var/www/cloudipa && chmod -R 775 /var/www/cloudipa")
print("Setup out:", out, "err:", err)

# 2. Upload files using SFTP
print("Uploading web assets and download packages...")
sftp = ssh.open_sftp()

files_to_upload = [
    ('web/index.html', '/var/www/cloudipa/index.html'),
    ('web/install.sh', '/var/www/cloudipa/install.sh'),
    ('dist-package/cloudipa-v1.0.0.zip', '/var/www/cloudipa/downloads/cloudipa-v1.0.0.zip'),
    ('dist-package/cloudipa-v1.0.0.tar.gz', '/var/www/cloudipa/downloads/cloudipa-v1.0.0.tar.gz'),
    ('dist-package/CloudIPA-Demo.unsigned.ipa', '/var/www/cloudipa/downloads/CloudIPA-Demo.unsigned.ipa'),
]

for local_path, remote_path in files_to_upload:
    print(f"Uploading {local_path} -> {remote_path} ({os.path.getsize(local_path)} bytes)...")
    sftp.put(local_path, remote_path)

sftp.close()

# 3. Create Nginx Configuration
print("Configuring Nginx for ios.akbr.in and 51.79.250.191...")
nginx_config = """server {
    listen 80;
    server_name ios.akbr.in 51.79.250.191;

    root /var/www/cloudipa;
    index index.html;

    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/zip;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location /downloads/ {
        alias /var/www/cloudipa/downloads/;
        autoindex off;
        add_header Content-Disposition 'attachment';
    }
}
"""

# Write to temp file on server then move with sudo
stdin, stdout, stderr = ssh.exec_command("cat > /tmp/cloudipa.conf")
stdin.write(nginx_config)
stdin.close()
stdout.read()

out, err = run_sudo("mv /tmp/cloudipa.conf /etc/nginx/sites-available/cloudipa")
out, err = run_sudo("ln -sf /etc/nginx/sites-available/cloudipa /etc/nginx/sites-enabled/cloudipa")

# 4. Test Nginx Configuration
print("Testing Nginx configuration...")
out, err = run_sudo("nginx -t")
print(out, err)

# 5. Reload Nginx
print("Reloading Nginx...")
out, err = run_sudo("systemctl reload nginx")
print(out, err)

# 6. Request Certbot SSL for ios.akbr.in
print("Requesting SSL Certificate from Let's Encrypt for ios.akbr.in...")
out, err = run_sudo("certbot --nginx -d ios.akbr.in --non-interactive --agree-tos --register-unsafely-without-email --redirect")
print(out)
print(err)

# 7. Reload Nginx once more to ensure SSL config is active
run_sudo("systemctl reload nginx")

ssh.close()
print("Deployment completed successfully!")
