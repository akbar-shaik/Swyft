import paramiko

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect('51.79.250.191', username='repinkadmin', password='Akbar@1997')

new_conf = """server {
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

    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/ios.akbr.in/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ios.akbr.in/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}

server {
    listen 80;
    server_name ios.akbr.in 51.79.250.191;
    return 301 https://ios.akbr.in$request_uri;
}
"""

stdin, stdout, stderr = ssh.exec_command("cat > /tmp/cloudipa.conf")
stdin.write(new_conf)
stdin.close()
stdout.read()

stdin, stdout, stderr = ssh.exec_command("echo 'Akbar@1997' | sudo -S bash -c 'mv /tmp/cloudipa.conf /etc/nginx/sites-available/cloudipa && systemctl reload nginx'")
print(stdout.read().decode())
print(stderr.read().decode())
ssh.close()
print("Unified redirect applied!")
