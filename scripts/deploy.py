import os
import sys
import paramiko

sys.stdout.reconfigure(encoding='utf-8')

VPS_HOST = os.environ.get('VPS_HOST')
VPS_USER = os.environ.get('VPS_USER', 'repinkadmin')
VPS_SSH_KEY_PATH = os.environ.get('VPS_SSH_KEY_PATH')
VPS_PASSWORD = os.environ.get('VPS_PASSWORD')

if not VPS_HOST:
    print("Error: VPS_HOST environment variable is required.")
    print("Example: export VPS_HOST=51.79.250.191 VPS_USER=repinkadmin VPS_SSH_KEY_PATH=~/.ssh/id_rsa")
    sys.exit(1)

print(f"Connecting to {VPS_HOST} as {VPS_USER}...")
ssh = paramiko.SSHClient()
ssh.load_system_host_keys()
ssh.set_missing_host_key_policy(paramiko.RejectPolicy())

connect_kwargs = {
    'hostname': VPS_HOST,
    'username': VPS_USER,
    'timeout': 15,
}

if VPS_SSH_KEY_PATH and os.path.exists(VPS_SSH_KEY_PATH):
    connect_kwargs['key_filename'] = VPS_SSH_KEY_PATH
elif VPS_PASSWORD:
    connect_kwargs['password'] = VPS_PASSWORD
else:
    print("Warning: Neither VPS_SSH_KEY_PATH nor VPS_PASSWORD set. Attempting default SSH agent/key authentication...")

try:
    ssh.connect(**connect_kwargs)
except Exception as e:
    print(f"SSH connection failed: {e}")
    sys.exit(1)

print("SSH connection established successfully.")

# Setup remote directories
def run_cmd(cmd):
    stdin, stdout, stderr = ssh.exec_command(cmd)
    return stdout.read().decode(), stderr.read().decode()

out, err = run_cmd("mkdir -p /var/www/cloudipa-backend /var/www/cloudipa/builds /var/www/cloudipa/downloads")
print("Remote folders verified.")

# SFTP Deploy
print("Deploying files via SFTP...")
sftp = ssh.open_sftp()
sftp.put('server/package.json', '/var/www/cloudipa-backend/package.json')
sftp.put('server/server.js', '/var/www/cloudipa-backend/server.js')
sftp.put('web/index.html', '/var/www/cloudipa/index.html')
sftp.put('web/install.sh', '/var/www/cloudipa/install.sh')
if os.path.exists('dist-package/cloudipa-v1.0.0.zip'):
    sftp.put('dist-package/cloudipa-v1.0.0.zip', '/var/www/cloudipa/downloads/cloudipa-v1.0.0.zip')
if os.path.exists('dist-package/cloudipa-v1.0.0.tar.gz'):
    sftp.put('dist-package/cloudipa-v1.0.0.tar.gz', '/var/www/cloudipa/downloads/cloudipa-v1.0.0.tar.gz')
if os.path.exists('dist-package/CloudIPA-Demo.unsigned.ipa'):
    sftp.put('dist-package/CloudIPA-Demo.unsigned.ipa', '/var/www/cloudipa/downloads/CloudIPA-Demo.unsigned.ipa')
sftp.close()

# PM2 Restart
print("Restarting cloudipa-backend service via PM2...")
out, err = run_cmd("pm2 restart cloudipa-backend || pm2 start /var/www/cloudipa-backend/server.js --name cloudipa-backend")
print(out)

ssh.close()
print("Deployment completed successfully.")
